# Bitfii — API backend

API REST (Node.js + Express + `ln-service`) qui relie le frontend React aux deux nœuds LND du réseau Polar **Bitfii** :

| Nœud | Rôle | gRPC |
| --- | --- | --- |
| `boutique` | reçoit les paiements : crée les factures | `127.0.0.1:10001` |
| `client` | paie les factures | `127.0.0.1:10002` |

Base URL : `http://localhost:5003`. Toutes les réponses sont en JSON. Le frontend ne parle **qu'à cette API**, jamais à LND.

## Démarrage

Le pas à pas complet (création du réseau Polar, récupération des identifiants, dépannage) est dans [GUIDELINE.md](../GUIDELINE.md). En résumé :

1. Dans Polar, démarrer le réseau **Bitfii** (Docker doit tourner).
2. Créer le `.env` à partir de `.env.example`. Pour chaque nœud, copier depuis l'onglet *Connect* de Polar, format **Base64** : l'hôte gRPC, l'`admin.macaroon` et le `tls.cert`.
   Ces valeurs changent quand Polar recrée le réseau : il faut alors les recopier.
3. Installer et lancer :

```bash
npm install
npm run dev
```

4. Vérifier : `GET /health` doit répondre `reachable: true` pour `boutique` et `client`.
5. Si le client ne peut pas payer (`outbound_capacity` à 0 dans `GET /api/nodes/client/channels`), rééquilibrer le canal **dans Polar**, puisque l'API interdit à la boutique de payer :
   nœud `client` → *Actions* → *Create Invoice* (par exemple 1 500 000 sats), puis nœud `boutique` → *Actions* → *Pay Invoice* avec cette facture.

## Configuration

| Variable | Rôle |
| --- | --- |
| `PORT` | port HTTP (défaut `5003`) |
| `CORS_ORIGIN` | origine du frontend autorisée (`http://localhost:5173`) |
| `LND_NODE_ID_n`, `LND_GRPC_HOST_n`, `LND_MACAROON_BASE64_n`, `LND_TLS_CERT_BASE64_n` | identifiant et accès du nœud n (1 = boutique, 2 = client) |
| `FCFA_PER_BTC` | taux fixe de conversion : 1 BTC = N FCFA |
| `MAX_INVOICE_SATS` | plafond par facture en sats (défaut `1000000`) |
| `INVOICE_NODES` | nœuds autorisés à créer des factures (`boutique`) ; vide = tous |
| `PAY_NODES` | nœuds autorisés à payer (`client`) ; vide = tous |
| `API_KEY` | optionnel : exige `x-api-key` sur `/api` |

## Parcours de paiement

1. Le boutiquier saisit un montant en FCFA → `POST /api/nodes/boutique/invoice` → le front affiche `request` en QR code.
2. Le front boutique interroge `GET /api/nodes/boutique/invoices/:id` toutes les 2 s tant que `status` vaut `pending`.
3. Le client colle (ou scanne) la facture → `POST /api/nodes/client/decode` → le front affiche le montant et la description.
4. Le client confirme → `POST /api/nodes/client/pay`.
5. Le front boutique voit `status: "paid"` et affiche « Payé » (ou « Expirée » sur `expired`).

## Endpoints

Toutes les routes par nœud sont de la forme `/api/nodes/:nodeId/...`, avec `:nodeId` = `boutique` ou `client`.

Rôles : seule la `boutique` crée des factures, seul le `client` paie (`INVOICE_NODES`, `PAY_NODES`). Les autres combinaisons répondent 403, y compris les routes legacy `/api/invoice` et `/api/pay`, qui visent la boutique.

Toute facture renvoyée (création, statut, historique) porte deux champs ajoutés par Bitfii :

| Champ | Valeurs |
| --- | --- |
| `status` | `pending` (en attente), `paid` (payée), `expired` (expirée ou annulée) |
| `fcfa` | montant FCFA saisi à la création, ou `null` si la facture a été créée en `sats` |

### `GET /health`

État des nœuds, sans authentification.

```json
{ "status": "ok", "nodes": [ { "id": "boutique", "reachable": true }, { "id": "client", "reachable": true } ] }
```

### `GET /api/nodes/:nodeId/balance`

```json
{
  "nodeId": "boutique",
  "onChainBalance": { "chain_balance": 1909990 },
  "offChainBalance": { "channel_balance": 1497530, "inbound": 1499000, "pending_balance": 0, "unsettled_balance": 0 }
}
```

- `chain_balance` : sats on-chain (hors Lightning).
- `channel_balance` : sats que le nœud peut **envoyer** dans ses canaux.
- `inbound` : sats que le nœud peut **recevoir**.

`channel_balance` varie un peu à chaque paiement à cause des frais de commitment du canal (payés par le nœud qui l'a ouvert) : ne pas l'utiliser pour vérifier un montant reçu.

### `GET /api/nodes/:nodeId/channels`

Liquidité par canal : `capacity` (3 000 000 sur Bitfii), `outbound_capacity` (envoyable), `inbound_capacity` (recevable), `is_active`.

### `POST /api/nodes/boutique/invoice` — créer une facture

Body, au choix :

```json
{ "fcfa": 600, "description": "Café" }
```
```json
{ "sats": 1000, "description": "Café" }
```

- `fcfa` : nombre > 0, converti en sats : `round(fcfa × 100 000 000 / FCFA_PER_BTC)`.
- `sats` : entier > 0. Envoyer `sats` **ou** `fcfa`, pas les deux.
- Le montant en sats ne doit pas dépasser `MAX_INVOICE_SATS` (1 000 000 par défaut).
- Avec `fcfa`, le montant est ajouté à la fin de la description (`Café · 600 FCFA`) : c'est là que l'historique le retrouve, car LND n'a pas d'autre champ pour le garder.

Réponse :

```json
{
  "nodeId": "boutique",
  "sats": 1000,
  "id": "0eea67ed55b12c59d09f746b42b1d5fa8f3cdb64846cceeb007c931fde792464",
  "request": "lnbcrt10u1p407ffupp5...",
  "description": "Café · 600 FCFA",
  "tokens": 1000,
  "created_at": "2026-11-19T16:35:08.000Z",
  "fcfa": 600,
  "status": "pending"
}
```

- `request` : la facture BOLT11 à afficher en QR code.
- `id` : le hash de paiement, à garder pour suivre le statut.

### `GET /api/nodes/boutique/invoices/:id` — statut d'une facture

```json
{
  "nodeId": "boutique",
  "id": "0eea67ed...",
  "tokens": 1000,
  "received": 1000,
  "is_confirmed": true,
  "confirmed_at": "2026-11-19T16:35:11.000Z",
  "description": "Café · 600 FCFA",
  "expires_at": "2026-11-19T19:35:08.000Z",
  "fcfa": 600,
  "status": "paid"
}
```

- Une facture non payée passe à `expired` à `expires_at` (validité : 3 h).

### `GET /api/nodes/boutique/invoices` — historique

Query : `limit` (1 à 1000), `token` (curseur `next` de la page précédente). Réponse : `{ nodeId, invoices, next }`, chaque facture avec `status` et `fcfa` : de quoi afficher la liste des ventes (date, montant FCFA et sats, description, statut).

### `POST /api/nodes/client/decode` — lire une facture avant de payer

Body : `{ "request": "lnbcrt10u1p..." }`

```json
{
  "nodeId": "client",
  "id": "0eea67ed...",
  "tokens": 1000,
  "description": "Café · 600 FCFA",
  "expires_at": "2026-11-19T19:35:08.000Z",
  "is_expired": false,
  "destination": "02af7797e68d153e3b6da3454689a5ee6c2fb92b624c419c75224622dbf5086764",
  "fcfa": 600
}
```

`tokens` = montant en sats ; `fcfa` = montant FCFA (ou `null`) ; `destination` = clé publique du nœud boutique.

### `POST /api/nodes/client/pay` — payer

Body : `{ "request": "lnbcrt10u1p..." }`

```json
{
  "success": true,
  "nodeId": "client",
  "payment_info": {
    "id": "0eea67ed...",
    "tokens": 1000,
    "fee": 0,
    "secret": "c43cc9927c84194a4bb5abcf69acfaf91bb7b006369ddfdd5c1ce30a6a888373",
    "is_confirmed": true,
    "confirmed_at": "2026-11-19T16:35:12.200Z"
  }
}
```

`secret` est la preimage : c'est la preuve du paiement.

### Autres routes

`GET /api/nodes`, `GET /api/nodes/:nodeId/getinfo`, `POST /api/nodes/:nodeId/signmessage`, `POST /api/nodes/:nodeId/verifymessage` : voir le [README](../README.md).

## Erreurs

Format : `{ "error": "message", "nodeId": "client" }`.

| Code | Cas |
| --- | --- |
| 400 | body invalide : `sats`/`fcfa` absent ou ≤ 0, `sats` et `fcfa` ensemble, montant au-dessus de `MAX_INVOICE_SATS`, `request` absent ou BOLT11 mal formé, `id` qui n'est pas un hash hex de 64 caractères, JSON invalide |
| 401 | `API_KEY` défini mais clé absente ou fausse |
| 403 | rôle interdit : facture créée sur le `client`, ou paiement depuis la `boutique` |
| 404 | route inconnue, nœud inconnu (la réponse liste `availableNodes`), facture introuvable |
| 409 | facture déjà payée (`Invoice is already paid.`) |
| 413 | body > 1 Mo |
| 503 | LND injoignable (`FailedToConnectToDaemon`), paiement impossible (liquidité, route), ou `FCFA_PER_BTC` non configuré |

## Exemple côté React

```js
const API = 'http://localhost:5003/api/nodes';

async function api(path, body) {
  const res = await fetch(`${API}${path}`, body && {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json;
}

// Boutique : créer la facture puis attendre le paiement
const invoice = await api('/boutique/invoice', { fcfa: 600, description: 'Café' });
const timer = setInterval(async () => {
  const status = await api(`/boutique/invoices/${invoice.id}`);
  if (status.status !== 'pending') { clearInterval(timer); /* « Payé » si 'paid', « Expirée » si 'expired' */ }
}, 2000);

// Client : décoder puis payer
const details = await api('/client/decode', { request });
const { payment_info } = await api('/client/pay', { request });
```

## Tests

Avec le serveur lancé et le réseau Bitfii démarré :

```bash
npm test
```

14 tests : validation des entrées, plafond, rôles (403), erreurs 404/409, et un paiement réel de 600 FCFA (1000 sats) du client vers la boutique. Le test de paiement est sauté si les nœuds sont injoignables. Chaque lancement dépense 1000 sats de liquidité du client.
