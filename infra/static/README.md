# KINSHASA MOSOLO — application web seule sur Vercel ou Firebase Hosting

Ces hébergeurs servent **uniquement l'application web construite** (`frontend/dist`, PWA). L'API reste sur Cloud Run
(`infra/gcp/`) ou sur le VPS (`infra/vps/`). Kit **non exécuté** (aucun compte Vercel ni Firebase) : fichiers validés
(JSON strict, simulation `DRY_RUN=1`) ; publication réelle **EXTERNE / NON TESTÉE**.

## Pourquoi le backend ne peut pas tourner sur Vercel / Firebase Functions

- **Tâches planifiées internes** (détection de la collusion, liquidation automatique sur règle ACTIVE, répartition,
  tarification ParkSmart, AVIA, réserve des agents, échéanciers d'accès…) : elles tournent **entre** les requêtes dans
  un processus permanent ; une fonction s'arrête après chaque requête.
- **Chaîne d'audit** : le journal chaîné (HMAC) et le grand livre sont tenus **en mémoire** et écrits par lots dans
  PostgreSQL, avec une **ancre externe** sur disque ; des instances éphémères et parallèles casseraient l'ordre de la
  chaîne (le bail de l'instance active n'en autorise qu'une).
- **Processus de longue durée** : démarrage de plusieurs secondes (contrôle des clés, rechargement et vérification de
  l'instantané), connexions PostgreSQL persistantes, état partagé entre requêtes — incompatibles avec des fonctions
  sans état, à durée et mémoire limitées.

## Fonctionnement

- L'application est construite en « même origine » (`VITE_API_URL` vide) : le navigateur appelle `/v1/…` sur le domaine
  Vercel / Firebase, qui **réécrit** (mandataire) vers le backend : `/v1/*`, `/l`, `/l/*` (pages légères, QR des
  quittances), `/.well-known/*` (OIDC) et `/health`. Aucun CORS n'est nécessaire.
- Tout autre chemin sans fichier retombe sur `index.html` (routage côté client).
- En-têtes : `sw.js` et `index.html` **jamais mis en cache** (`no-cache, no-store`) — sinon une version périmée de
  l'application resterait installée ; `Service-Worker-Allowed: /` ; fichiers `/assets/*` immuables (Vercel) ; mêmes
  en-têtes de sécurité que le backend (CSP identique à `APP_CSP`, HSTS, COOP, X-Frame-Options, Permissions-Policy).
- Firebase : `Cache-Control: no-cache` sur tout (revalidation systématique) faute de pouvoir exclure `/assets` sans
  conflit de règles ; le service worker pré-cache l'application, l'effet sur la vitesse reste faible.

## Commandes exactes

```bash
# Vercel (backend Cloud Run OU VPS) — compte Vercel requis
BACKEND_URL=https://mosolo-<numéro>.africa-south1.run.app ./infra/static/preparer.sh vercel
npx vercel deploy --prod infra/static/.rendu/vercel

# Firebase Hosting (backend Cloud Run du MÊME projet Google Cloud uniquement)
SERVICE=mosolo REGION=africa-south1 ./infra/static/preparer.sh firebase
cd infra/static/.rendu/firebase && npx firebase-tools deploy --only hosting --project <PROJECT_ID>
```

`preparer.sh` construit l'application si `frontend/dist` est absent (`BUILD=1` pour forcer ; tas Node 3 Go), copie
le résultat et y écrit `vercel.json` (URL du backend) ou `firebase.json` (service Cloud Run). `DRY_RUN=1` : simulation.

## Limites à connaître

- **Firebase** ne réécrit que vers Cloud Run (ou Functions) **du même projet** : pas vers un VPS. Vérifier que la
  région du service (`africa-south1`) est acceptée par les réécritures Firebase ; sinon, utiliser Vercel ou servir
  l'application depuis le backend (option par défaut, un seul service).
- **Vercel** : les réécritures externes ajoutent un saut ; régler `MOSOLO_TRUST_PROXY` du backend en conséquence (sinon
  la limitation de débit par adresse voit l'adresse de Vercel) ; limites de taille et de durée des requêtes
  mandatées (téléversements de pièces) à vérifier. Le domaine Vercel doit figurer dans `MOSOLO_PUBLIC_URL` si c'est
  l'adresse officielle.
- Option la plus simple et la plus sûre : **ne pas séparer** — le backend sert déjà l'application
  (`MOSOLO_STATIC_DIR=frontend/dist`, activé par les deux kits).

## Simulations (`DRY_RUN=1`)

<!-- SIMULATION:static-vercel.txt -->
```text
==> Application web (construction « même origine », tas Node 3 Go)
    + npm --prefix <dépôt> ci --no-audit --no-fund
    + env VITE_API_URL= NODE_OPTIONS=--max-old-space-size=3072 npm --prefix <dépôt> run build -w frontend

==> Dossier de publication infra/static/.rendu/vercel
    + rm -rf <dépôt>/infra/static/.rendu/vercel
    + mkdir -p <dépôt>/infra/static/.rendu/vercel
    + cp -R <dépôt>/frontend/dist/. <dépôt>/infra/static/.rendu/vercel/
    + vercel.json : URL-DU-BACKEND → mosolo-000000000000.africa-south1.run.app

==> Publication (à lancer par l'exploitant, compte Vercel requis)
    npx vercel deploy --prod infra/static/.rendu/vercel
```

<!-- SIMULATION:static-firebase.txt -->
```text
==> Application web (construction « même origine », tas Node 3 Go)
    + npm --prefix <dépôt> ci --no-audit --no-fund
    + env VITE_API_URL= NODE_OPTIONS=--max-old-space-size=3072 npm --prefix <dépôt> run build -w frontend

==> Dossier de publication infra/static/.rendu/firebase
    + rm -rf <dépôt>/infra/static/.rendu/firebase
    + mkdir -p <dépôt>/infra/static/.rendu/firebase
    + mkdir -p <dépôt>/infra/static/.rendu/firebase/public
    + cp -R <dépôt>/frontend/dist/. <dépôt>/infra/static/.rendu/firebase/public/
    + firebase.json : service Cloud Run mosolo (africa-south1)

==> Publication (à lancer par l'exploitant, projet Firebase = projet Google Cloud du backend)
    cd infra/static/.rendu/firebase && npx firebase-tools deploy --only hosting --project <PROJECT_ID>
```
