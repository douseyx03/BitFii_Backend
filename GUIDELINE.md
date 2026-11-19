# Lancer le backend Bitfii en local

Ce guide part d'une machine vide et va jusqu'à un paiement Lightning réel entre deux nœuds. Comptez environ 30 minutes la première fois.

À la fin, vous aurez :

- un réseau Polar **Bitfii** avec deux nœuds LND : `boutique` (encaisse) et `client` (paie), reliés par un canal ;
- l'API Bitfii qui tourne sur `http://localhost:5003` ;
- les 14 tests au vert.

---

## Étape 0 — Prérequis

| Outil | Version | Vérifier avec | Où le trouver |
| --- | --- | --- | --- |
| Node.js | **22 ou plus** | `node -v` | https://nodejs.org (prendre la version LTS) |
| npm | fourni avec Node | `npm -v` | — |
| Docker Desktop | récent, **démarré** | `docker ps` (doit répondre sans erreur) | https://www.docker.com/products/docker-desktop |
| Polar | récent | — | https://lightningpolar.com |

Polar lance les nœuds Bitcoin et Lightning dans Docker : **Docker doit tourner avant d'ouvrir Polar.**

---

## Étape 1 — Créer le réseau Polar

Chaque collaborateur crée son propre réseau sur sa machine : les identifiants ne se partagent pas.

1. Ouvrir Polar → **Create a Lightning Network** (ou le bouton **+**).
2. Nom du réseau : `Bitfii`.
3. Nœuds : **2 LND**, **0 Core Lightning**, **0 Eclair**, **1 Bitcoin Core**. Cliquer sur **Create Network**.
4. Renommer les deux nœuds LND : cliquer sur un nœud, puis sur son nom dans le panneau de droite. Les noms doivent être **exactement** :
   - `boutique`
   - `client`
5. Cliquer sur **Start** en haut à droite. Attendre que tous les nœuds passent au vert (statut *Started*).

### Donner des bitcoins au nœud client

Le client a besoin de sats on-chain pour ouvrir un canal.

1. Cliquer sur le nœud `client` → onglet **Actions** → **Deposit**.
2. Montant : `5000000` sats → **Deposit**. Polar mine les blocs tout seul.

### Ouvrir le canal client → boutique

On ouvre le canal **depuis le client**, pour que ce soit lui qui ait les sats à dépenser. Sinon, il ne pourra rien payer.

1. Nœud `client` → **Actions** → **Open Channel** (*Outgoing*).
2. Destination : `boutique`. Capacité : `3000000` sats.
3. **Open Channel**. Polar mine les confirmations automatiquement.
4. Sur le schéma, un trait relie maintenant `client` et `boutique`.

> Si le canal a été ouvert dans l'autre sens (de la boutique vers le client), le client ne peut pas payer. Pour rééquilibrer :
> nœud `client` → **Actions** → **Create Invoice** (par exemple `1500000` sats) → copier la facture ;
> puis nœud `boutique` → **Actions** → **Pay Invoice** → coller la facture → **Pay**.

---

## Étape 2 — Récupérer les identifiants des nœuds dans Polar

Pour **chacun** des deux nœuds (`boutique` puis `client`), il faut 3 informations :

| Information | Variable dans `.env` | Exemple |
| --- | --- | --- |
| Adresse gRPC | `LND_GRPC_HOST_n` | `127.0.0.1:10001` |
| Admin Macaroon, en Base64 | `LND_MACAROON_BASE64_n` | `AgEDbG5kAvgB...` (longue chaîne) |
| TLS Cert, en Base64 | `LND_TLS_CERT_BASE64_n` | `LS0tLS1CRUdJTi...` (longue chaîne) |

`n` vaut `1` pour la boutique et `2` pour le client.

### Méthode A — depuis l'interface de Polar (recommandée)

1. Cliquer sur le nœud `boutique` sur le schéma.
2. Dans le panneau de droite, ouvrir l'onglet **Connect**.
3. En haut de l'onglet, choisir le format **Base64** (les autres choix sont *File Paths* et *HEX* : ne pas les prendre).
4. Copier avec l'icône de copie à côté de chaque champ :
   - **GRPC Host** : il s'affiche sous la forme `127.0.0.1:10001`. Copier exactement ce qui est affiché, **sans** `https://` ;
   - **TLS Cert** ;
   - **Admin Macaroon** (et non *Read-only* ou *Invoice*).
5. Recommencer avec le nœud `client`.

Le port gRPC dépend de l'ordre de création des nœuds : `10001`, `10002`, etc. Prenez toujours celui que Polar affiche, pas celui de l'exemple.

### Méthode B — depuis les fichiers (si la copie ne marche pas)

Polar range les fichiers de chaque nœud ici, où `<id>` est le numéro du réseau (1, 2, 3…) :

| Fichier | Chemin |
| --- | --- |
| TLS Cert | `~/.polar/networks/<id>/volumes/lnd/<nœud>/tls.cert` |
| Admin Macaroon | `~/.polar/networks/<id>/volumes/lnd/<nœud>/data/chain/bitcoin/regtest/admin.macaroon` |

Sous Windows, `~` correspond à `C:\Users\<vous>`. Pour trouver le numéro du réseau, ouvrir `~/.polar/networks/networks.json` et chercher `"name": "Bitfii"`.

Convertir en Base64 (exemple pour la boutique du réseau 3) :

**Linux**

```bash
base64 -w 0 ~/.polar/networks/3/volumes/lnd/boutique/tls.cert
base64 -w 0 ~/.polar/networks/3/volumes/lnd/boutique/data/chain/bitcoin/regtest/admin.macaroon
```

**macOS**

```bash
base64 -i ~/.polar/networks/3/volumes/lnd/boutique/tls.cert
base64 -i ~/.polar/networks/3/volumes/lnd/boutique/data/chain/bitcoin/regtest/admin.macaroon
```

**Windows (PowerShell)**

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\.polar\networks\3\volumes\lnd\boutique\tls.cert"))
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\.polar\networks\3\volumes\lnd\boutique\data\chain\bitcoin\regtest\admin.macaroon"))
```

Chaque commande affiche une seule longue ligne : c'est la valeur à coller dans le `.env`.

---

## Étape 3 — Configurer le backend

1. Dézipper le projet, puis ouvrir un terminal **dans le dossier du backend** (celui qui contient `package.json`).
2. Créer le fichier `.env` à partir du modèle :

   **Linux / macOS**

   ```bash
   cp .env.example .env
   ```

   **Windows (PowerShell)**

   ```powershell
   Copy-Item .env.example .env
   ```

3. Ouvrir `.env` dans un éditeur et remplacer les 6 valeurs par celles de l'étape 2 :

   ```env
   LND_NODE_ID_1=boutique
   LND_GRPC_HOST_1=127.0.0.1:10001
   LND_MACAROON_BASE64_1=AgEDbG5kAvgB...
   LND_TLS_CERT_BASE64_1=LS0tLS1CRUdJTi...

   LND_NODE_ID_2=client
   LND_GRPC_HOST_2=127.0.0.1:10002
   LND_MACAROON_BASE64_2=AgEDbG5kAvgB...
   LND_TLS_CERT_BASE64_2=LS0tLS1CRUdJTi...
   ```

   - Chaque valeur tient sur **une seule ligne**, sans guillemets ni espace autour du `=`.
   - Laisser `LND_NODE_ID_1=boutique` et `LND_NODE_ID_2=client` tels quels : les rôles (`INVOICE_NODES`, `PAY_NODES`) et le frontend utilisent ces noms.
   - Les autres variables (`PORT`, `CORS_ORIGIN`, `FCFA_PER_BTC`, `MAX_INVOICE_SATS`…) peuvent rester comme dans le modèle.

> **Le `.env` est personnel et secret.** Il donne le contrôle total de vos nœuds. Ne l'envoyez à personne, ne le mettez pas dans un zip ni dans Git (le `.gitignore` l'exclut déjà).

---

## Étape 4 — Installer et lancer

```bash
npm install
npm run dev
```

`npm run dev` redémarre le serveur à chaque modification du code. `npm start` le lance sans rechargement.

Dans le terminal, vous devez voir :

```
Configured LND node "boutique" at 127.0.0.1:10001
Configured LND node "client" at 127.0.0.1:10002
API Server using 'ln-service' is running on http://localhost:5003
...
Verified LND node "boutique".
Verified LND node "client".
```

Les deux lignes `Verified` sont les plus importantes : elles confirment que la connexion à Polar marche. Un avertissement `DeprecationWarning: Setting the TLS ServerName to an IP address` peut s'afficher : il est sans conséquence.

Laisser ce terminal ouvert : le serveur s'arrête si on le ferme (`Ctrl + C` pour l'arrêter).

---

## Étape 5 — Vérifier que tout marche

Dans un **deuxième** terminal, toujours dans le dossier du backend.

1. **Les nœuds répondent**. Ouvrir http://localhost:5003/health dans le navigateur. On doit obtenir :

   ```json
   {"status":"ok","nodes":[{"id":"boutique","reachable":true},{"id":"client","reachable":true}]}
   ```

2. **Le client peut payer**. Ouvrir http://localhost:5003/api/nodes/client/channels : `outbound_capacity` doit être bien au-dessus de 0 (environ 3 000 000 si le canal a été ouvert depuis le client).

3. **Lancer les tests** :

   ```bash
   npm test
   ```

   Résultat attendu : `ℹ pass 14` et `ℹ fail 0`. Le dernier test fait un vrai paiement de 600 FCFA (1000 sats) du client vers la boutique : sur Polar, les soldes des nœuds bougent.

C'est prêt. Pour utiliser l'API depuis le frontend, voir [docs/API.md](docs/API.md).

---

## Dépannage

| Symptôme | Cause probable | Solution |
| --- | --- | --- |
| `No LND nodes configured.` au démarrage | Pas de fichier `.env`, ou lancé depuis un autre dossier | Refaire l'étape 3, lancer `npm run dev` dans le dossier qui contient `package.json` |
| `Incomplete LND config for node slot 1.` | Une des 3 valeurs du nœud est vide | Vérifier `LND_GRPC_HOST_1`, `LND_MACAROON_BASE64_1`, `LND_TLS_CERT_BASE64_1` (idem pour `_2`) |
| `LND node "boutique" is not reachable: FailedToConnectToDaemon`, ou `/health` affiche `reachable: false` | Réseau Polar arrêté, Docker arrêté, mauvais port, ou identifiants périmés | Démarrer Docker puis le réseau dans Polar ; vérifier le port dans l'onglet Connect ; recopier TLS Cert et Macaroon, puis relancer le serveur |
| Ça marchait, plus rien ne marche après un redémarrage de Polar | Polar a régénéré les certificats | Recopier les 4 valeurs Base64 (étape 2), relancer le serveur |
| `Error: listen EADDRINUSE :::5003` | Un autre serveur occupe déjà le port 5003 | Fermer l'autre terminal, ou mettre `PORT=5004` dans `.env` |
| `npm install` échoue, ou `ln-service` se plaint de la version de Node | Node.js plus ancien que 22 | Installer Node 22 LTS ou plus récent |
| Le test « flux complet » échoue avec une erreur 503 au paiement | Le client n'a pas de liquidité dans le canal | Vérifier `/api/nodes/client/channels` ; rééquilibrer (encadré de l'étape 1) |
| Le test « flux complet » est marqué *skipped* | Les nœuds sont injoignables | Voir la ligne `FailedToConnectToDaemon` |
| Le frontend reçoit une erreur CORS | Le front ne tourne pas sur `http://localhost:5173` | Mettre la bonne adresse dans `CORS_ORIGIN`, puis relancer le serveur |
| Erreur `403 ... is not allowed` | Mauvais nœud pour l'action : facture créée sur le `client`, ou paiement depuis la `boutique` | Créer les factures sur `/api/nodes/boutique/...`, payer depuis `/api/nodes/client/...` |

---

## Récapitulatif

```bash
# une seule fois
cp .env.example .env      # puis remplir les 6 valeurs Polar
npm install

# à chaque session
# 1. démarrer Docker, puis le réseau Bitfii dans Polar
npm run dev               # terminal 1
npm test                  # terminal 2 (optionnel)
```

Team BitFii
