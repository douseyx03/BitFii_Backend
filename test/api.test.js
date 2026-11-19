// Tests d'intégration contre le serveur lancé (npm start) et le réseau Polar.
// Usage: npm test   (API_URL pour cibler un autre serveur)
const { test } = require('node:test');
const assert = require('node:assert/strict');

const API = process.env.API_URL || 'http://localhost:5003';

async function call(method, path, body) {
    const res = await fetch(API + path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
}

test('GET /health liste boutique et client', async () => {
    const { status, json } = await call('GET', '/health');
    assert.equal(status, 200);
    assert.deepEqual(json.nodes.map((n) => n.id).sort(), ['boutique', 'client']);
});

test('route inconnue -> 404', async () => {
    assert.equal((await call('GET', '/api/nope')).status, 404);
});

test('nœud inconnu -> 404 avec la liste des nœuds', async () => {
    const { status, json } = await call('GET', '/api/nodes/inconnu/getinfo');
    assert.equal(status, 404);
    assert.ok(json.availableNodes.includes('boutique'));
});

test('facture: sats invalide -> 400', async () => {
    for (const sats of [0, -5, 1.5, '100', undefined]) {
        const { status } = await call('POST', '/api/nodes/boutique/invoice', { sats });
        assert.equal(status, 400, `sats=${sats}`);
    }
});

test('facture: fcfa invalide ou sats+fcfa -> 400', async () => {
    for (const body of [{ fcfa: 0 }, { fcfa: '500' }, { fcfa: 500, sats: 10 }]) {
        const { status } = await call('POST', '/api/nodes/boutique/invoice', body);
        assert.equal(status, 400, JSON.stringify(body));
    }
});

test('facture au-dessus du plafond -> 400', async () => {
    assert.equal((await call('POST', '/api/nodes/boutique/invoice', { sats: 1_000_001 })).status, 400);
});

test('rôles: la boutique ne paie pas, le client ne facture pas -> 403', async () => {
    assert.equal((await call('POST', '/api/nodes/boutique/pay', { request: 'lnbcrt1bad' })).status, 403);
    assert.equal((await call('POST', '/api/pay', { request: 'lnbcrt1bad' })).status, 403, 'route legacy = boutique');
    assert.equal((await call('POST', '/api/nodes/client/invoice', { sats: 10 })).status, 403);
});

test('statut: id mal formé -> 400', async () => {
    assert.equal((await call('GET', '/api/nodes/boutique/invoices/abc')).status, 400);
});

test('statut: facture inconnue -> 404', async () => {
    assert.equal((await call('GET', `/api/nodes/boutique/invoices/${'0'.repeat(64)}`)).status, 404);
});

test('décodage sans request -> 400', async () => {
    assert.equal((await call('POST', '/api/nodes/client/decode', {})).status, 400);
});

test('paiement sans request -> 400', async () => {
    assert.equal((await call('POST', '/api/nodes/client/pay', {})).status, 400);
});

test('facture BOLT11 mal formée -> 400 sans faire tomber le serveur', async () => {
    assert.equal((await call('POST', '/api/nodes/client/pay', { request: 'lnbcrt1bad' })).status, 400);
    assert.equal((await call('POST', '/api/nodes/client/decode', { request: 'lnbcrt1bad' })).status, 400);
    assert.equal((await call('GET', '/health')).status, 200);
});

test('JSON invalide -> 400', async () => {
    assert.equal((await call('POST', '/api/nodes/client/pay', '{oops')).status, 400);
});

test('flux complet: boutique facture, client paie', async (t) => {
    const health = (await call('GET', '/health')).json;
    if (!health.nodes.every((n) => n.reachable)) {
        t.skip('nœuds LND injoignables: démarrer le réseau Polar puis relancer le serveur');
        return;
    }

    const info = await call('GET', '/api/nodes/boutique/getinfo');
    assert.equal(info.status, 200);
    assert.match(info.json.public_key, /^0[23][0-9a-f]{64}$/);

    // 600 FCFA au taux de test 60 000 000 FCFA/BTC = 1000 sats
    const invoice = await call('POST', '/api/nodes/boutique/invoice', { fcfa: 600, description: 'test Bitfii' });
    assert.equal(invoice.status, 200, JSON.stringify(invoice.json));
    assert.match(invoice.json.request, /^lnbcrt/);
    assert.equal(invoice.json.fcfa, 600);
    assert.equal(invoice.json.status, 'pending');
    assert.equal(invoice.json.tokens, invoice.json.sats);

    const decoded = await call('POST', '/api/nodes/client/decode', { request: invoice.json.request });
    assert.equal(decoded.status, 200);
    assert.equal(decoded.json.tokens, invoice.json.sats);
    assert.equal(decoded.json.description, 'test Bitfii · 600 FCFA');
    assert.equal(decoded.json.fcfa, 600);

    const pending = await call('GET', `/api/nodes/boutique/invoices/${invoice.json.id}`);
    assert.equal(pending.json.status, 'pending');

    const payment = await call('POST', '/api/nodes/client/pay', { request: invoice.json.request });
    assert.equal(payment.status, 200, JSON.stringify(payment.json));
    assert.equal(payment.json.success, true);

    // pas de comparaison de channel_balance: les frais de commitment du canal la font varier
    const paid = await call('GET', `/api/nodes/boutique/invoices/${invoice.json.id}`);
    assert.equal(paid.json.status, 'paid');
    assert.equal(paid.json.received, invoice.json.sats);

    const history = (await call('GET', '/api/nodes/boutique/invoices?limit=5')).json.invoices;
    const sale = history.find((i) => i.id === invoice.json.id);
    assert.equal(sale.status, 'paid');
    assert.equal(sale.fcfa, 600);

    const again = await call('POST', '/api/nodes/client/pay', { request: invoice.json.request });
    assert.equal(again.status, 409, 'une facture déjà payée doit être refusée');
});
