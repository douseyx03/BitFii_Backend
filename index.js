// index.js

const crypto = require('crypto');
const express = require('express');
const {
    authenticatedLndGrpc,
    getWalletInfo,
    getChainBalance,
    getChannelBalance,
    getChannels,
    createInvoice,
    decodePaymentRequest,
    getInvoice,
    getInvoices,
    parsePaymentRequest,
    pay,
    signMessage,
    verifyMessage,
} = require('ln-service');
const dotenv = require('dotenv');
const cors = require('cors');

dotenv.config({ quiet: true });

const app = express();
const MAX_NODES = 3;
const MAX_INVOICE_LIMIT = 1000;
const DEFAULT_PORT = 5003;

/** @type {Map<string, { lnd: object, socket: string, reachable: boolean|null }>} */
const lndNodes = new Map();

app.disable('x-powered-by');

function parseCorsOrigin() {
    const raw = process.env.CORS_ORIGIN;
    if (!raw) {
        return {};
    }

    const origins = raw
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);

    return origins.length > 0 ? { origin: origins } : {};
}

app.use(cors(parseCorsOrigin()));
app.use(express.json({ limit: '1mb' }));

function parsePort(value) {
    if (value === undefined || value === '') {
        return DEFAULT_PORT;
    }

    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error(`Invalid PORT "${value}". Expected an integer between 1 and 65535.`);
        process.exit(1);
    }

    return port;
}

function getNodeEnv(index, legacy = false) {
    if (legacy) {
        return {
            id: process.env.LND_NODE_ID || '1',
            socket: process.env.LND_GRPC_HOST,
            macaroon: process.env.LND_MACAROON_BASE64,
            cert: process.env.LND_TLS_CERT_BASE64,
        };
    }

    return {
        id: process.env[`LND_NODE_ID_${index}`] || String(index),
        socket: process.env[`LND_GRPC_HOST_${index}`],
        macaroon: process.env[`LND_MACAROON_BASE64_${index}`],
        cert: process.env[`LND_TLS_CERT_BASE64_${index}`],
    };
}

function loadNodeConfigs() {
    const configs = [];
    const seenIds = new Set();

    const addConfig = (config) => {
        if (seenIds.has(config.id)) {
            console.error(`Duplicate LND node id "${config.id}". Each node must have a unique LND_NODE_ID_N value.`);
            process.exit(1);
        }

        seenIds.add(config.id);
        configs.push(config);
    };

    const hasNumberedNode1 = Boolean(process.env.LND_GRPC_HOST_1);
    if (!hasNumberedNode1 && process.env.LND_GRPC_HOST) {
        const legacy = getNodeEnv(1, true);
        if (!legacy.macaroon || !legacy.cert) {
            console.error('Incomplete legacy LND config.');
            console.error('Provide LND_GRPC_HOST, LND_MACAROON_BASE64, and LND_TLS_CERT_BASE64.');
            process.exit(1);
        }

        addConfig(legacy);
    }

    for (let index = 1; index <= MAX_NODES; index += 1) {
        const { id, socket, macaroon, cert } = getNodeEnv(index);
        const hasAny = Boolean(socket || macaroon || cert);
        if (!hasAny) {
            continue;
        }

        if (!socket || !macaroon || !cert) {
            console.error(`Incomplete LND config for node slot ${index}.`);
            console.error(`Provide LND_GRPC_HOST_${index}, LND_MACAROON_BASE64_${index}, and LND_TLS_CERT_BASE64_${index}.`);
            process.exit(1);
        }

        addConfig({ id, socket, macaroon, cert });
    }

    if (configs.length === 0) {
        console.error('No LND nodes configured.');
        console.error('Provide node 1 credentials via LND_GRPC_HOST / LND_MACAROON_BASE64 / LND_TLS_CERT_BASE64');
        console.error('or via LND_GRPC_HOST_1 / LND_MACAROON_BASE64_1 / LND_TLS_CERT_BASE64_1 (up to 3 nodes).');
        process.exit(1);
    }

    return configs;
}

function connectToLndNodes() {
    const configs = loadNodeConfigs();

    for (const config of configs) {
        try {
            const { lnd } = authenticatedLndGrpc({
                socket: config.socket,
                macaroon: config.macaroon,
                cert: config.cert,
            });

            lndNodes.set(config.id, { lnd, socket: config.socket, reachable: null });
            console.log(`Configured LND node "${config.id}" at ${config.socket}`);
        } catch (error) {
            console.error(`Failed to connect to LND node "${config.id}":`, error.message);
            process.exit(1);
        }
    }
}

// authenticatedLndGrpc only builds the client, so probe each node once it is up.
async function probeNodes() {
    await Promise.all([...lndNodes.entries()].map(async ([id, node]) => {
        try {
            await getWalletInfo({ lnd: node.lnd });
            node.reachable = true;
            console.log(`Verified LND node "${id}".`);
        } catch (error) {
            node.reachable = false;
            console.error(`LND node "${id}" is not reachable:`, error.message || error);
        }
    }));
}

/**
 * ln-service rejects with `[status, name, details]` arrays. Map those to an
 * HTTP status instead of always answering 500, and never forward the raw
 * error object (it contains internal gRPC details).
 */
function normalizeLndError(error) {
    const grpcCode = Array.isArray(error) && error[2] && error[2].err ? error[2].err.code : undefined;

    // gRPC ALREADY_EXISTS on pay = this invoice was already settled
    if (grpcCode === 6) {
        return { status: 409, message: 'Invoice is already paid.' };
    }

    if (grpcCode === 5) {
        return { status: 404, message: 'Invoice not found.' };
    }

    if (Array.isArray(error) && typeof error[0] === 'number') {
        const [code, name] = error;
        const status = code >= 400 && code <= 599 ? code : 500;

        return {
            status,
            message: typeof name === 'string' && name ? name : 'LND request failed.',
        };
    }

    if (error && typeof error.message === 'string' && error.message) {
        return { status: 500, message: error.message };
    }

    return { status: 500, message: 'Internal server error.' };
}

function fail(req, res, context, error) {
    const { status, message } = normalizeLndError(error);

    console.error(`[${req.nodeId || 'unknown'}] ${context}:`, error);

    return res.status(status).json({
        error: status >= 500 && !Array.isArray(error) ? 'Internal server error.' : message,
        nodeId: req.nodeId,
    });
}

function safeEqual(a, b) {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));

    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Auth is opt-in: set API_KEY to require `x-api-key` (or a Bearer token) on /api.
function requireApiKey(req, res, next) {
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
        return next();
    }

    const header = req.get('x-api-key') || '';
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const provided = header || bearer;

    if (!provided || !safeEqual(provided, apiKey)) {
        return res.status(401).json({ error: 'Invalid or missing API key.' });
    }

    return next();
}

const resolveLndNode = (req, res, next) => {
    const node = lndNodes.get(req.params.nodeId);
    if (!node) {
        return res.status(404).json({
            error: `Unknown LND node "${req.params.nodeId}".`,
            availableNodes: [...lndNodes.keys()],
        });
    }

    req.lnd = node.lnd;
    req.nodeId = req.params.nodeId;
    return next();
};

const attachDefaultLnd = (req, res, next) => {
    const defaultNodeId = [...lndNodes.keys()][0];
    const node = lndNodes.get(defaultNodeId);

    if (!node) {
        return res.status(503).json({ error: 'No LND node is configured.' });
    }

    req.lnd = node.lnd;
    req.nodeId = defaultNodeId;
    return next();
};

async function handleGetInfo(req, res) {
    try {
        const info = await getWalletInfo({ lnd: req.lnd });
        res.json({ ...info, nodeId: req.nodeId });
    } catch (error) {
        fail(req, res, 'Error getting node info', error);
    }
}

async function handleGetBalance(req, res) {
    try {
        const onChainBalance = await getChainBalance({ lnd: req.lnd });
        const offChainBalance = await getChannelBalance({ lnd: req.lnd });
        res.json({ nodeId: req.nodeId, onChainBalance, offChainBalance });
    } catch (error) {
        fail(req, res, 'Error getting balance', error);
    }
}

async function handleGetChannels(req, res) {
    try {
        const { channels } = await getChannels({ lnd: req.lnd });

        const liquidity = channels.map((ch) => ({
            channel_id: ch.id,
            partner: ch.partner_public_key,
            capacity: ch.capacity,
            outbound_capacity: ch.local_balance,
            inbound_capacity: ch.remote_balance,
            unsettled_balance: ch.unsettled_balance,
            sent: ch.sent,
            received: ch.received,
            is_active: ch.is_active,
            is_private: ch.is_private,
            is_closing: ch.is_closing,
            is_opening: ch.is_opening,
            transaction_id: ch.transaction_id,
            transaction_vout: ch.transaction_vout,
        }));

        res.json({
            nodeId: req.nodeId,
            count: liquidity.length,
            channels: liquidity,
        });
    } catch (error) {
        fail(req, res, 'Error getting channels', error);
    }
}

// shortcut: fixed rate from .env (FCFA_PER_BTC), switch to a price API if live rates are needed.
function fcfaToSats(fcfa) {
    const fcfaPerBtc = Number(process.env.FCFA_PER_BTC);
    if (!Number.isFinite(fcfaPerBtc) || fcfaPerBtc <= 0) {
        return null;
    }

    return Math.round((fcfa * 100_000_000) / fcfaPerBtc);
}

// shortcut: the FCFA amount lives at the end of the LND description ("Café · 600 FCFA"), use a DB if invoices need more fields.
function fcfaFromDescription(description) {
    const match = /(?:^| · )(\d+(?:\.\d+)?) FCFA$/.exec(description || '');
    return match ? Number(match[1]) : null;
}

function withStatus(invoice) {
    let status = 'pending';
    if (invoice.is_confirmed) {
        status = 'paid';
    } else if (invoice.is_canceled || Date.parse(invoice.expires_at) <= Date.now()) {
        status = 'expired';
    }

    return { ...invoice, fcfa: fcfaFromDescription(invoice.description), status };
}

// Role lists from .env (e.g. INVOICE_NODES=boutique, PAY_NODES=client); unset = every node allowed.
function nodeAllowed(envName, nodeId) {
    const raw = process.env[envName];
    return !raw || raw.split(',').map((id) => id.trim()).includes(nodeId);
}

async function handleCreateInvoice(req, res) {
    try {
        if (!nodeAllowed('INVOICE_NODES', req.nodeId)) {
            return res.status(403).json({ error: `Node "${req.nodeId}" is not allowed to create invoices.`, nodeId: req.nodeId });
        }

        const { fcfa, description } = req.body || {};
        let { sats } = req.body || {};

        if (fcfa !== undefined) {
            if (sats !== undefined) {
                return res.status(400).json({ error: 'Send either `sats` or `fcfa`, not both.' });
            }

            if (typeof fcfa !== 'number' || !Number.isFinite(fcfa) || fcfa <= 0) {
                return res.status(400).json({ error: 'A positive `fcfa` value is required.' });
            }

            sats = fcfaToSats(fcfa);
            if (sats === null) {
                return res.status(503).json({ error: 'FCFA_PER_BTC is not configured on the server.' });
            }
        }

        if (!Number.isInteger(sats) || sats <= 0) {
            return res.status(400).json({ error: 'A positive integer `sats` value is required.' });
        }

        const maxSats = Number(process.env.MAX_INVOICE_SATS) || 1_000_000;
        if (sats > maxSats) {
            return res.status(400).json({ error: `Invoice amount ${sats} sats is above the ${maxSats} sats limit.` });
        }

        if (description !== undefined && typeof description !== 'string') {
            return res.status(400).json({ error: '`description` must be a string when provided.' });
        }

        const label = fcfa === undefined
            ? description || ''
            : [description, `${fcfa} FCFA`].filter(Boolean).join(' · ');

        const invoice = await createInvoice({
            lnd: req.lnd,
            tokens: sats,
            description: label,
        });

        return res.json({ nodeId: req.nodeId, sats, ...withStatus(invoice) });
    } catch (error) {
        return fail(req, res, 'Error creating invoice', error);
    }
}

// ln-service throws uncaught (and kills the process) on a malformed BOLT11, so parse it offline first.
function readPaymentRequest(req, res) {
    const { request } = req.body || {};

    if (typeof request !== 'string' || !request.trim()) {
        res.status(400).json({ error: 'A `request` string (BOLT11 invoice) is required.' });
        return null;
    }

    try {
        parsePaymentRequest({ request: request.trim() });
    } catch (error) {
        res.status(400).json({ error: 'Invalid BOLT11 payment request.' });
        return null;
    }

    return request.trim();
}

async function handleGetInvoice(req, res) {
    try {
        if (!/^[0-9a-f]{64}$/i.test(req.params.id)) {
            return res.status(400).json({ error: 'Invoice `id` must be a 64-char hex payment hash.' });
        }

        const invoice = await getInvoice({ lnd: req.lnd, id: req.params.id });
        return res.json({ nodeId: req.nodeId, ...withStatus(invoice) });
    } catch (error) {
        return fail(req, res, 'Error getting invoice', error);
    }
}

async function handleDecode(req, res) {
    try {
        const request = readPaymentRequest(req, res);
        if (!request) {
            return undefined;
        }

        const details = await decodePaymentRequest({ lnd: req.lnd, request });
        return res.json({ nodeId: req.nodeId, ...details, fcfa: fcfaFromDescription(details.description) });
    } catch (error) {
        return fail(req, res, 'Error decoding invoice', error);
    }
}

async function handleListInvoices(req, res) {
    try {
        const params = { lnd: req.lnd };

        if (req.query.limit !== undefined) {
            const limit = Number(req.query.limit);
            if (!Number.isInteger(limit) || limit < 1 || limit > MAX_INVOICE_LIMIT) {
                return res.status(400).json({
                    error: `\`limit\` must be an integer between 1 and ${MAX_INVOICE_LIMIT}.`,
                });
            }

            params.limit = limit;
        }

        if (req.query.token !== undefined) {
            if (typeof req.query.token !== 'string') {
                return res.status(400).json({ error: '`token` must be a string.' });
            }

            params.token = req.query.token;
        }

        const { invoices, next } = await getInvoices(params);

        return res.json({ nodeId: req.nodeId, invoices: invoices.map(withStatus), next: next || null });
    } catch (error) {
        return fail(req, res, 'Error listing invoices', error);
    }
}

async function handlePay(req, res) {
    try {
        if (!nodeAllowed('PAY_NODES', req.nodeId)) {
            return res.status(403).json({ error: `Node "${req.nodeId}" is not allowed to pay invoices.`, nodeId: req.nodeId });
        }

        const request = readPaymentRequest(req, res);
        if (!request) {
            return undefined;
        }

        const paymentResult = await pay({ lnd: req.lnd, request });
        return res.json({ success: true, nodeId: req.nodeId, payment_info: paymentResult });
    } catch (error) {
        return fail(req, res, 'Error paying invoice', error);
    }
}

async function handleSignMessage(req, res) {
    try {
        const { message } = req.body || {};

        if (typeof message !== 'string' || !message) {
            return res.status(400).json({ error: 'A `message` string is required.' });
        }

        const { signature } = await signMessage({ lnd: req.lnd, message });

        return res.json({ nodeId: req.nodeId, message, signature });
    } catch (error) {
        return fail(req, res, 'Error signing message', error);
    }
}

async function handleVerifyMessage(req, res) {
    try {
        const { message, signature, pubkey } = req.body || {};

        if (typeof message !== 'string' || !message ||
            typeof signature !== 'string' || !signature ||
            typeof pubkey !== 'string' || !pubkey) {
            return res.status(400).json({ error: 'All three params are required.' });
        }

        // ln-service returns `{ signed_by }`; it does not validate a pubkey for us.
        const { signed_by: signedBy } = await verifyMessage({
            lnd: req.lnd,
            message,
            signature,
        });

        const isValid = signedBy.toLowerCase() === pubkey.toLowerCase();

        return res.json({ nodeId: req.nodeId, isValid, signedBy });
    } catch (error) {
        return fail(req, res, 'Error verifying message', error);
    }
}

function registerNodeRoutes(middleware) {
    app.get('/api/nodes/:nodeId/getinfo', middleware, handleGetInfo);
    app.get('/api/nodes/:nodeId/balance', middleware, handleGetBalance);
    app.get('/api/nodes/:nodeId/channels', middleware, handleGetChannels);
    app.get('/api/nodes/:nodeId/invoices', middleware, handleListInvoices);
    app.get('/api/nodes/:nodeId/invoices/:id', middleware, handleGetInvoice);
    app.post('/api/nodes/:nodeId/invoice', middleware, handleCreateInvoice);
    app.post('/api/nodes/:nodeId/decode', middleware, handleDecode);
    app.post('/api/nodes/:nodeId/pay', middleware, handlePay);
    app.post('/api/nodes/:nodeId/signmessage', middleware, handleSignMessage);
    app.post('/api/nodes/:nodeId/verifymessage', middleware, handleVerifyMessage);
}

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        nodes: [...lndNodes.entries()].map(([id, node]) => ({ id, reachable: node.reachable })),
    });
});

app.use('/api', requireApiKey);

app.get('/api/nodes', (req, res) => {
    res.json({
        maxNodes: MAX_NODES,
        connectedNodes: [...lndNodes.entries()].map(([id, node]) => ({
            id,
            grpcHost: node.socket,
            reachable: node.reachable,
        })),
    });
});

registerNodeRoutes(resolveLndNode);

// Legacy routes (first configured node) for backward compatibility
app.get('/api/getinfo', attachDefaultLnd, handleGetInfo);
app.get('/api/balance', attachDefaultLnd, handleGetBalance);
app.get('/api/channels', attachDefaultLnd, handleGetChannels);
app.get('/api/invoices', attachDefaultLnd, handleListInvoices);
app.post('/api/invoice', attachDefaultLnd, handleCreateInvoice);
app.post('/api/pay', attachDefaultLnd, handlePay);
app.post('/api/signmessage', attachDefaultLnd, handleSignMessage);
app.post('/api/verifymessage', attachDefaultLnd, handleVerifyMessage);

app.use((req, res) => {
    res.status(404).json({ error: 'Route not found.' });
});

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
    if (error && error.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Invalid JSON body.' });
    }

    if (error && error.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Request body too large.' });
    }

    console.error('Unhandled error:', error);
    return res.status(500).json({ error: 'Internal server error.' });
});

function logEndpoints(port, nodeIds) {
    console.log(`API Server using 'ln-service' is running on http://localhost:${port}`);
    console.log(`Connected nodes (${nodeIds.length}/${MAX_NODES}): ${nodeIds.join(', ')}`);
    if (process.env.API_KEY) {
        console.log('API key required: send `x-api-key` or `Authorization: Bearer <key>`.');
    }
    console.log('----------------------------------------------------');
    console.log('Discovery:');
    console.log('- GET    /health');
    console.log('- GET    /api/nodes');
    console.log('Node-scoped endpoints (replace :nodeId with one of the ids above):');
    console.log('- GET    /api/nodes/:nodeId/getinfo');
    console.log('- GET    /api/nodes/:nodeId/balance');
    console.log('- GET    /api/nodes/:nodeId/channels');
    console.log('- GET    /api/nodes/:nodeId/invoices');
    console.log('- GET    /api/nodes/:nodeId/invoices/:id');
    console.log('- POST   /api/nodes/:nodeId/invoice');
    console.log('- POST   /api/nodes/:nodeId/decode');
    console.log('- POST   /api/nodes/:nodeId/pay');
    console.log('- POST   /api/nodes/:nodeId/signmessage');
    console.log('- POST   /api/nodes/:nodeId/verifymessage');
    console.log('Legacy endpoints (first configured node only):');
    console.log('- GET    /api/getinfo');
    console.log('- GET    /api/balance');
    console.log('- GET    /api/channels');
    console.log('- GET    /api/invoices');
    console.log('- POST   /api/invoice');
    console.log('- POST   /api/pay');
    console.log('- POST   /api/signmessage');
    console.log('- POST   /api/verifymessage');
    console.log('----------------------------------------------------');
}

const PORT = parsePort(process.env.PORT);

connectToLndNodes();

const server = app.listen(PORT, () => {
    logEndpoints(PORT, [...lndNodes.keys()]);
});

probeNodes();

// Close the HTTP server cleanly so restarts do not leave the port bound.
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        server.close(() => process.exit(0));
    });
}
