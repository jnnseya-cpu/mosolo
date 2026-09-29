# KINSHASA MOSOLO — déploiement Google Cloud (Cloud Run + Cloud SQL)

Kit **prêt, non exécuté** : aucun déploiement n'a été fait depuis ce dépôt (aucun compte Google Cloud disponible).
Tout ce qui pouvait être vérifié hors ligne l'a été (voir « Validation » plus bas) ; l'exécution réelle reste
**EXTERNE / NON TESTÉE**.

## Architecture déployée

| Élément | Choix | Pourquoi |
|---|---|---|
| Application | **Cloud Run** `mosolo`, image unique (API + application web), argument `production` | Jamais `--demo` ; `NODE_ENV=production` |
| Instances | **min = max = 1**, CPU **toujours alloué**, 2 vCPU / 2 Gio | État applicatif en mémoire rechargé depuis PostgreSQL ; tâches planifiées internes (collusion, liquidation, ParkSmart, AVIA…) qui tournent entre les requêtes |
| Sondes | démarrage et vie sur `/health` | Même sonde que Render, Docker et le VPS |
| Base | **Cloud SQL PostgreSQL 16**, IP **privée** seulement, sauvegardes automatiques (14), **restauration à un instant donné** (7 jours de journaux), protection contre la suppression | Données fiscales : jamais d'IP publique |
| Secrets | **Secret Manager**, réplication dans la région, un accès par compte de service et par secret | Aucune valeur dans le dépôt, les journaux ou l'image |
| Migrations | **tâche Cloud Run `mosolo-migrate`** exécutée AVANT chaque nouvelle révision | Rejouables (journal `schema_migrations` + `IF NOT EXISTS` + verrou consultatif) ; si elles échouent, la révision en service n'est pas touchée |
| Données hors base | bucket `<projet>-mosolo-donnees` monté sur `/var/lib/mosolo` (ancre de la chaîne d'audit, copie WORM, publication des racines), versionné | L'ancre doit survivre aux redémarrages et rester hors de la base |
| Sauvegardes signées | tâche `mosolo-sauvegarde` (outil existant `backup-cli`) chaque jour à 02:15 (heure de Kinshasa) par **Cloud Scheduler**, bucket `<projet>-mosolo-sauvegardes` (rétention 30 jours) | En plus des sauvegardes Cloud SQL : sauvegarde **portable** et **vérifiable** (signature + chaîne d'audit), restaurable ailleurs (VPS, hébergement national) |
| Domaine | équilibreur HTTPS global + certificat géré (défaut) ou correspondance de domaine Cloud Run | Les correspondances de domaine ne sont pas proposées dans toutes les régions |
| Démonstration | service **séparé** `mosolo-demo`, argument `demo`, mémoire, sans base ni secret | Remplace Render (plan gratuit trop petit : la construction demande ~700 Mo de tas) |

Comptes de service (moindre privilège) : `mosolo-run` (ses secrets + bucket de données), `mosolo-migration`
(URL de migration + mot de passe du rôle applicatif), `mosolo-sauvegarde` (URL applicative, clés de sauvegarde et
d'audit, bucket de sauvegardes), `mosolo-planificateur` (droit d'exécuter la seule tâche de sauvegarde),
`mosolo-build` (écriture dans le seul dépôt d'images), `mosolo-demo` (aucun droit).

Base de données : deux rôles. `mosolo_migration` (créé par gcloud, propriétaire des tables, opérateur de restauration
— membre de `mosolo_restore`) et `mosolo_app` (créé par la tâche de migration, **sans** `UPDATE`/`DELETE`/`TRUNCATE`
sur le journal en ajout seul, sans droit de création) : c'est lui que le service utilise.

## Prérequis (poste de l'exploitant)

- `gcloud` récent (description Cloud Run déclarative, volumes Cloud Storage, tâches), `openssl`, `git`, `curl`.
- Un projet Google Cloud avec facturation, et un compte **propriétaire** du projet :
  `gcloud auth login && gcloud config set project <PROJECT_ID>`.

## Commandes exactes

```bash
# 1. Simulation (n'exécute rien, ne génère aucun secret) : relire toutes les commandes
DRY_RUN=1 PROJECT_ID=<PROJECT_ID> REGION=africa-south1 DOMAIN=mosolo.<domaine>.cd ./infra/gcp/deploy.sh

# 2. Production (idempotent : relancer = nouvelle révision, rien d'existant n'est recréé ni remplacé)
PROJECT_ID=<PROJECT_ID> REGION=africa-south1 ./infra/gcp/deploy.sh
#    avec nom de domaine (équilibreur + certificat géré ; créer ensuite l'enregistrement DNS A affiché)
PROJECT_ID=<PROJECT_ID> REGION=africa-south1 DOMAIN=mosolo.<domaine>.cd ./infra/gcp/deploy.sh
#    avec amorçage des comptes de travail et du coffre (contrôler d'abord : npm run bootstrap:check -w backend -- amorcage.json)
PROJECT_ID=<PROJECT_ID> BOOTSTRAP_FILE=./amorcage.json ./infra/gcp/deploy.sh

# 3. Remplacer les secrets provisoires des prestataires par les valeurs convenues avec eux, puis nouvelle révision
printf '%s' '<secret convenu>' | gcloud secrets versions add mosolo-provider-secret-mm-operator-a --data-file=- --project=<PROJECT_ID>
PROJECT_ID=<PROJECT_ID> SKIP_BUILD=1 IMAGE_TAG=<étiquette en service> ./infra/gcp/deploy.sh

# 4. État, retour arrière, restauration
PROJECT_ID=<PROJECT_ID> ./infra/gcp/status.sh
PROJECT_ID=<PROJECT_ID> ./infra/gcp/rollback.sh                 # révision précédente
PROJECT_ID=<PROJECT_ID> ./infra/gcp/rollback.sh mosolo-00007-abc  # révision précise
PROJECT_ID=<PROJECT_ID> FICHIER=mosolo-20261001T011500Z.json OPERATEUR=<nom> ./infra/gcp/restaurer.sh

# 5. Démonstration séparée (remplace Render) — données NON CONTRACTUELLES, jamais de données réelles
PROJECT_ID=<PROJECT_ID> DEMO=true ./infra/gcp/deploy.sh
```

Paramètres (tous facultatifs sauf `PROJECT_ID`) — valeurs chiffrées **par défaut, à confirmer par le maître d'ouvrage** :

| Variable | Défaut | Rôle |
|---|---|---|
| `REGION` | `africa-south1` (Johannesburg) | Région de tous les services |
| `DOMAIN`, `DOMAIN_MODE` | —, `lb` | Nom de domaine ; `lb` (équilibreur global + certificat géré) ou `mapping` (correspondance Cloud Run, si la région la propose) |
| `DEMO` | `false` | `true` : service de démonstration séparé `mosolo-demo` uniquement |
| `CPU`, `MEMORY`, `CONCURRENCY` | `2`, `2Gi`, `80` | Ressources de l'instance unique |
| `SQL_TIER`, `SQL_AVAILABILITY`, `SQL_STORAGE_GB` | `db-custom-1-3840`, `ZONAL`, `20` | `REGIONAL` = haute disponibilité (coût × 2) |
| `SQL_BACKUPS_KEPT`, `SQL_LOG_DAYS`, `SQL_BACKUP_START` | `14`, `7`, `00:00` (UTC) | Sauvegardes Cloud SQL et PITR |
| `BACKUP_SCHEDULE`, `BACKUP_RETENTION_DAYS` | `15 2 * * *` (Africa/Kinshasa), `30` | Sauvegarde signée quotidienne |
| `BUILD_MACHINE`, `BUILD_HEAP_MB`, `BUILD_REGION` | `e2-highcpu-8`, `3072`, `REGION` | Construction ; `BUILD_REGION=global` si Cloud Build régional est indisponible |
| `SCHEDULER_REGION`, `SECRET_LOCATIONS` | `REGION` | Si Cloud Scheduler / Secret Manager n'est pas proposé dans la région |
| `INGRESS`, `TRUST_PROXY` | `all`, `1` | Avec domaine : `INGRESS=internal-and-cloud-load-balancing` ferme l'adresse `*.run.app` |
| `SKIP_BUILD`, `IMAGE_TAG` | `0`, `<commit>-<horodatage>` | Republier une image existante (changement de secret, de paramètre) |
| `EXTRA_SECRETS` | — | `MOSOLO_SMS_PROVIDER_KEY=mosolo-sms-provider-key,…` : secrets ajoutés plus tard (créer le secret d'abord) |
| `PRESTATAIRES_SECRETS` | `auto` | Raccorde au service les secrets `mosolo-bitripay-*` / `mosolo-koda-*` qui ont une version (saisie : `./infra/gcp/secrets-prestataires.sh <bitripay\|koda>`, sans écho) ; `non` : aucun |
| `PRESTATAIRES_ENV_FILE` | `infra/gcp/prestataires.env` | Variables NON secrètes des prestataires (URL, opérateurs, alias du coffre, `KODA_SUCCESS_URL`) ; modèle `prestataires.env.example` ; tout nom de secret y est refusé. Voir `docs/prestataires-paiement.md` |
| `DEMO_MIN_INSTANCES` | `0` | Démonstration : 0 = mise en veille hors visite (données réinitialisées) |
| `DEMO_ACCESS` | `mot-de-passe` | Démonstration (ajout du 28/09/2026, troisième passe, D3-06) : mot de passe d'accès commun généré dans Secret Manager (`DEMO_ACCESS_SECRET`, défaut `mosolo-demo-access-password`), exigé par le navigateur (HTTP Basic, puis témoin HttpOnly) — sans lui, tout visiteur pourrait agir sous n'importe quel rôle fictif par l'en-tête `x-demo-user`. Lecture : `gcloud secrets versions access latest --secret=mosolo-demo-access-password`. `public` : comportement antérieur (ouvert à tous), conservé. Variable applicative : `MOSOLO_DEMO_ACCESS_PASSWORD` (≥ 12 caractères, démonstration seulement) |

## Variables de l'application

Obligatoires (démarrage refusé sinon — liste contrôlée par `backend/test/deploiement.test.ts`) : `NODE_ENV=production`,
`DATABASE_URL`, `MOSOLO_RECEIPT_SIGNING_KEY`, `MOSOLO_CLOSURE_SIGNING_KEY`, `MOSOLO_JWT_PRIVATE_KEY` (Ed25519 PKCS#8,
générées par `openssl genpkey`), `MOSOLO_AUDIT_HMAC_KEY`, `MOSOLO_AUDIT_ANCHOR_PATH`, `MOSOLO_BACKUP_KEY`,
`MOSOLO_PROVIDER_SECRET_MM_OPERATOR_A`, `…_BANK_A`, `…_CARD_GATEWAY`. Recommandées et fournies : `MOSOLO_INTEGRITE_KEY`,
`MOSOLO_PAYMENT_POINT_MASTER_KEY`, `MOSOLO_METRICS_TOKEN`, `MOSOLO_PUBLIC_URL`, `MOSOLO_CORS_ORIGINS`,
`MOSOLO_WEBAUTHN_RP_ID`, `MOSOLO_WEBAUTHN_ORIGINS`, `MOSOLO_TRUST_PROXY`, `MOSOLO_STATIC_DIR`,
`MOSOLO_AUDIT_WORM_DIR`, `MOSOLO_AUDIT_ROOT_PUBLISH_PATH`. Référence complète : `infra/vps/.env.example` et
`backend/README.md`. Les secrets sont **générés une fois** et **jamais remplacés** par le script ; une rotation se fait
par `gcloud secrets versions add` suivie d'une nouvelle révision (voir `MOSOLO_RECEIPT_VERIFY_KEYS` pour les quittances).

## Migrations : pourquoi elles ne peuvent pas « recréer un type existant »

- Journal `schema_migrations` : un fichier appliqué ne l'est plus jamais ; deuxième exécution = aucun effet (prouvé
  sur pg-mem et sur PostgreSQL 16 réel).
- Chaque fichier est lui-même rejouable : `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`,
  `DROP TRIGGER IF EXISTS` avant `CREATE TRIGGER`, `CREATE ROLE` dans un bloc gardé ; **aucun type énuméré**. Un test
  (`deploiement.test.ts`) refuse toute nouvelle migration qui ne respecterait pas ces règles (y compris `CREATE TYPE`
  non gardé).
- Verrou consultatif PostgreSQL pendant la migration : la tâche et le service peuvent démarrer en même temps sans
  jouer deux fois un fichier.
- Le rôle applicatif n'a pas le droit de créer : si une migration n'a pas été jouée par la tâche, le service refuse
  de démarrer (la révision précédente reste en service).

## Chevauchement de révisions : bail de l'instance active

Cloud Run garde l'ancienne révision en service le temps que la nouvelle démarre. Pour qu'elles n'écrivent jamais
toutes les deux : la nouvelle instance prend le **bail** (migration 004, génération + 1) **avant** de relire la base ;
chaque lot d'écriture vérifie dans sa transaction que sa génération est la dernière. L'ancienne instance cesse
d'écrire (écritures refusées en 503, `/health` « degraded », alerte critique `INSTANCE_SUPPLANTEE`) jusqu'à son arrêt.
Résidu connu : le dernier lot différé de l'ancienne instance (25 ms) peut avoir été acquitté sans être persisté —
**mettre à jour en heure creuse**. Prouvé sur pg-mem, PostgreSQL réel et deux conteneurs réels (voir
`docs/production-readiness.md`, § 19).

## Sauvegardes et restauration

1. **Cloud SQL** : sauvegardes automatiques quotidiennes + restauration à un instant donné (console ou
   `gcloud sql instances clone mosolo-pg mosolo-pg-restauree --point-in-time=<AAAA-MM-JJTHH:MM:SSZ>`, puis nouvelle
   version du secret `mosolo-database-url` vers la nouvelle instance et nouvelle révision). L'ancre d'audit détecte un
   retour arrière : démarrage refusé tant que `MOSOLO_AUDIT_ACCEPT_UNVERIFIED=true` n'est pas posé après décision écrite.
2. **Sauvegarde signée** (portable, vérifiable) : `restaurer.sh` — vérification, prise du bail (le service cesse
   d'écrire), restauration par le rôle de migration (événement `audit.restored`), nouvelle révision. Une sauvegarde plus
   ancienne que la chaîne en place exige `CONFIRM_ROLLBACK=1` (décision écrite, tracée dans la chaîne d'audit).
3. **Hors Google Cloud** : copier régulièrement `gs://<projet>-mosolo-sauvegardes` vers un stockage **national** ; la
   même sauvegarde se restaure sur le kit VPS (`infra/vps/deploy.sh restore`).

## Coûts — ESTIMATION indicative (USD / mois, non contractuelle)

Ordres de grandeur d'après les tarifs publics Google Cloud connus en 2026, région africa-south1 (tarifs de niveau 2,
plus élevés que les régions américaines). **À recalculer avec le simulateur officiel
(cloud.google.com/products/calculator) avant toute décision ; les tarifs changent.**

| Poste | Hypothèse | Estimation |
|---|---|---|
| Cloud Run (production) | 1 instance 24 h/24, 2 vCPU, 2 Gio, CPU toujours alloué | 100 – 190 |
| Cloud SQL | `db-custom-1-3840` zonal, 20 Go SSD, sauvegardes, PITR | 55 – 95 (× 2 en haute disponibilité) |
| Équilibreur HTTPS (si domaine) | 1 règle de transfert + trafic traité | 20 – 35 |
| Trafic sortant Internet | 50 à 300 Go / mois | 6 – 45 |
| Artifact Registry, Cloud Storage, Secret Manager, Scheduler, Logging | quelques Go, ~20 secrets, 1 tâche planifiée | 5 – 20 |
| Cloud Build | ~10 min en `e2-highcpu-8` par version | < 1 par version |
| **Total production** | zonal / haute disponibilité | **≈ 190 – 390 / ≈ 250 – 480** |
| Démonstration `mosolo-demo` | 0 instance hors visite (1 vCPU, 1 Gio) | 0 – 15 (≈ 40 – 70 avec `DEMO_MIN_INSTANCES=1`) |

## Souveraineté

Le Cahier des exigences **privilégie un hébergement national** (bloqueur B4 de `docs/production-readiness.md`).
`africa-south1` est situé en Afrique du Sud : les données fiscales seraient **hors de la RDC**. Google Cloud est donc
une solution **transitoire**, soumise à l'avis juridique sur la protection des données et à la décision du maître
d'ouvrage. Le kit limite l'enfermement : image conteneur standard, PostgreSQL standard, sauvegardes signées portables,
clés générées et gardées par la Ville (à migrer vers un HSM), même image et même procédure sur un VPS ou un centre de
données national (`infra/vps/`). Plan de sortie : sauvegarde signée → `infra/vps/deploy.sh restore` → bascule DNS.

## Fond de carte OpenStreetMap de Kinshasa (29/09/2026)

Décision de la plateforme : fond **OpenStreetMap AUTO-HÉBERGÉ** — aucun serveur de tuiles tiers à l'exécution. Le fichier
`kinshasa.pmtiles` (tuiles vectorielles, emprise 15,05 / -4,75 — 15,70 / -4,15, zooms 0 à 15, **~24 Mo**) est servi
par MOSOLO sous `/tiles/kinshasa.pmtiles`, lu par plages d'octets (206, `Accept-Ranges`, `ETag`,
`cache-control: public, max-age=3600`) ; absent, il répond 404 et les cartes affichent « Fond OpenStreetMap de
Kinshasa non encore installé sur ce serveur… » avec les seules couches MOSOLO.

**Fabriqué automatiquement dans l'image** — même Dockerfile pour les trois chemins : `gcloud run deploy mosolo-demo
--source .`, `infra/gcp/deploy.sh` (→ `infra/gcp/cloudbuild.yaml`) et `infra/vps`. L'étape « fond-de-carte » du
Dockerfile exécute `tools/maps/fond-de-carte-image.sh` :

| Point | Détail |
|---|---|
| Outil | `pmtiles` **1.31.2** (go-pmtiles), empreintes SHA-256 épinglées (amd64, arm64) vérifiées avant exécution |
| Source | copie publique stable de la carte mondiale Protomaps (Source Cooperative, S3 `us-west-2`, objet `protomaps/openstreetmap/v4.pmtiles`) — seules les plages de Kinshasa sont lues (~25 Mo transférés) ; ETag de la source et SHA-256 du fichier produit **journalisés** (même source = même fichier) |
| Contrôles | signature `PMTiles`, mention « OpenStreetMap » dans l'attribution des métadonnées (sinon fichier refusé), fiche `tiles/kinshasa.pmtiles.txt` (source, date, empreinte, licence ODbL) |
| Sans réseau / échec | **la construction n'échoue pas** : bandeau `AVERTISSEMENT — fond de carte OpenStreetMap de Kinshasa NON fabriqué` dans le journal, image sans fond (comportement antérieur) |
| Taille | **+24 Mo** dans l'image d'exécution (l'outil et les fichiers de travail restent dans l'étape de construction) |

Options de construction : `--build-arg MOSOLO_FOND_DE_CARTE=0` (sauter l'étape ; `FOND_DE_CARTE=0 ./infra/gcp/deploy.sh`),
`--build-arg MOSOLO_TUILES_SOURCE=https://…/planete.pmtiles` (autre carte mondiale PMTiles, schéma Protomaps v4),
`--build-arg MOSOLO_TUILES_JETON=$(date +%Y%m)` (forcer le rafraîchissement d'un cache Docker local ; Cloud Build
repart sans cache et passe `BUILD_ID`).

**Vérifier après déploiement** : journal de construction (`Tuiles Kinshasa : … SHA-256 …` puis `Fond de carte installé
dans l'image`), `curl -sI -H 'Range: bytes=0-15' https://<service>/tiles/kinshasa.pmtiles` → `206`, puis une carte (ex.
« Où payer ? », `/points-de-paiement`) : fond de rues visible et mention « © contributeurs OpenStreetMap » affichée
sous la carte et dans le coin (licence ODbL : cette attribution ne doit jamais être retirée).

**Reconstruire le fond** (mise à jour OSM, chaque mois) : nouvelle construction de l'image ; ou, hors Docker,
`tools/maps/construire-tuiles-kinshasa.sh` (option A : carte du jour puis copie stable ; option B : Planetiler depuis
l'extrait Geofabrik de la RDC, entièrement souveraine) qui écrit `frontend/public/tiles/kinshasa.pmtiles` (non versionné,
`.gitignore`), puis `npm run build -w frontend`. Un fichier présent localement lors d'une construction Docker est conservé
si l'étape « fond-de-carte » ne produit rien. Les kits statiques (`infra/static`, Vercel / Firebase) ne fabriquent pas
le fond : y déposer le fichier produit par l'outil.

## Points à vérifier au premier déploiement (non vérifiables sans compte)

- Disponibilité dans `africa-south1` de Cloud Build régional (sinon `BUILD_REGION=global`), de Cloud Scheduler
  (sinon `SCHEDULER_REGION=europe-west1`), de la réplication Secret Manager (sinon `SECRET_LOCATIONS`).
- Options de montage Cloud Storage (`uid=1000,gid=1000,…`) et écriture de l'ancre d'audit sur ce volume.
- Politiques d'organisation : un partage restreint au domaine interdit `allUsers` (service public) ; une contrainte
  sur les IP externes ou les régions peut bloquer l'équilibreur ou Cloud SQL.
- Derrière l'équilibreur, le nombre de mandataires (`TRUST_PROXY`) pour la limitation de débit par adresse.
- Durées de démarrage réelles (sonde de démarrage : 4 min au plus) avec un gros instantané.

## Validation effectuée hors ligne

`./infra/valider.sh` (aussi exécuté en intégration continue, tâche « kit-deploiement ») : `bash -n` et shellcheck de
tous les scripts, hadolint du Dockerfile, simulations `DRY_RUN=1`, chargement strict des YAML/JSON (dont les
descriptions Cloud Run rendues : min = max = 1, CPU toujours alloué, sondes `/health`, jamais `--demo`),
`docker compose config`. Résultat de la simulation de production (`DRY_RUN=1 PROJECT_ID=projet-exemple
DOMAIN=mosolo.exemple.cd IMAGE_TAG=exemple ./infra/gcp/deploy.sh`) :

<!-- SIMULATION:gcp-production.txt -->
```text
    MODE SIMULATION (DRY_RUN=1) : aucune commande n'est exécutée, aucun secret n'est généré.
    Projet projet-exemple, région africa-south1, image africa-south1-docker.pkg.dev/projet-exemple/mosolo/mosolo:exemple, mode PRODUCTION (mosolo)

==> [01] Activation des API
    + gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com iam.googleapis.com storage.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com compute.googleapis.com servicenetworking.googleapis.com --project=projet-exemple --quiet

==> [02] Dépôt Artifact Registry mosolo (africa-south1)
    + gcloud artifacts repositories create mosolo --project=projet-exemple --quiet --location=africa-south1 --repository-format=docker '--description=Images KINSHASA MOSOLO'

==> [03] Comptes de service (moindre privilège)
    + gcloud iam service-accounts create mosolo-build --project=projet-exemple --quiet '--display-name=MOSOLO — construction (Cloud Build)'
    + gcloud iam service-accounts create mosolo-run --project=projet-exemple --quiet '--display-name=MOSOLO — service de production'
    + gcloud iam service-accounts create mosolo-migration --project=projet-exemple --quiet '--display-name=MOSOLO — tâche de migration'
    + gcloud iam service-accounts create mosolo-sauvegarde --project=projet-exemple --quiet '--display-name=MOSOLO — tâche de sauvegarde'
    + gcloud iam service-accounts create mosolo-planificateur --project=projet-exemple --quiet '--display-name=MOSOLO — Cloud Scheduler'
    + gcloud storage buckets create gs://projet-exemple-mosolo-construction --project=projet-exemple --quiet --location=africa-south1 --uniform-bucket-level-access --public-access-prevention
    + gcloud artifacts repositories add-iam-policy-binding mosolo --project=projet-exemple --quiet --location=africa-south1 --member=serviceAccount:mosolo-build@projet-exemple.iam.gserviceaccount.com --role=roles/artifactregistry.writer
    + gcloud storage buckets add-iam-policy-binding gs://projet-exemple-mosolo-construction --project=projet-exemple --quiet --member=serviceAccount:mosolo-build@projet-exemple.iam.gserviceaccount.com --role=roles/storage.objectViewer
    + gcloud projects add-iam-policy-binding projet-exemple --quiet --member=serviceAccount:mosolo-build@projet-exemple.iam.gserviceaccount.com --role=roles/logging.logWriter --condition=None

==> [04] Construction de l'image par Cloud Build (e2-highcpu-8, NODE_OPTIONS=--max-old-space-size=3072)
    + gcloud builds submit . --project=projet-exemple --quiet --region=africa-south1 --config=infra/gcp/cloudbuild.yaml --ignore-file=infra/gcp/.gcloudignore --substitutions=_IMAGE=africa-south1-docker.pkg.dev/projet-exemple/mosolo/mosolo:exemple,_HEAP_MB=3072,_FOND_DE_CARTE=1 --machine-type=e2-highcpu-8 --service-account=projects/projet-exemple/serviceAccounts/mosolo-build@projet-exemple.iam.gserviceaccount.com --gcs-source-staging-dir=gs://projet-exemple-mosolo-construction/sources

==> [05] Réseau privé : accès privé aux services Google (Cloud SQL sans IP publique)
    + gcloud compute networks create default --project=projet-exemple --quiet --subnet-mode=auto
    + gcloud compute addresses create mosolo-services-prives --project=projet-exemple --quiet --global --purpose=VPC_PEERING --prefix-length=16 --network=default
    + gcloud services vpc-peerings connect --project=projet-exemple --quiet --service=servicenetworking.googleapis.com --ranges=mosolo-services-prives --network=default

==> [06] Cloud SQL PostgreSQL 16 mosolo-pg (IP privée, sauvegardes automatiques, restauration à un instant donné)
    + gcloud sql instances create mosolo-pg --project=projet-exemple --quiet --database-version=POSTGRES_16 --edition=ENTERPRISE --tier=db-custom-1-3840 --region=africa-south1 --availability-type=ZONAL --storage-type=SSD --storage-size=20GB --storage-auto-increase --network=projects/projet-exemple/global/networks/default --no-assign-ip --backup-start-time=00:00 --retained-backups-count=14 --enable-point-in-time-recovery --retained-transaction-log-days=7 --deletion-protection --labels=app=mosolo
    + gcloud sql databases create mosolo --project=projet-exemple --quiet --instance=mosolo-pg
    adresse privée de la base : 10.0.0.0

==> [07] Secrets (Secret Manager, réplication africa-south1) — générés localement, jamais affichés ni remplacés
    + gcloud secrets create mosolo-db-migration-password --project=projet-exemple --quiet --replication-policy=user-managed --locations=africa-south1 --labels=app=mosolo
    + '<gen_aleatoire : valeur générée localement, jamais affichée>' | gcloud secrets versions add mosolo-db-migration-password --project=projet-exemple --quiet --data-file=-
    + gcloud secrets create mosolo-db-app-password --project=projet-exemple --quiet --replication-policy=user-managed --locations=africa-south1 --labels=app=mosolo
    + '<gen_aleatoire : valeur générée localement, jamais affichée>' | gcloud secrets versions add mosolo-db-app-password --project=projet-exemple --quiet --data-file=-
    + gcloud secrets create mosolo-database-url-migration --project=projet-exemple --quiet --replication-policy=user-managed --locations=africa-south1 --labels=app=mosolo
    + '<url_migration : valeur générée localement, jamais affichée>' | gcloud secrets versions add mosolo-database-url-migration --project=projet-exemple --quiet --data-file=-
    + gcloud secrets create mosolo-database-url --project=projet-exemple --quiet --replication-policy=user-managed --locations=africa-south1 --labels=app=mosolo
    + '<url_app : valeur générée localement, jamais affichée>' | gcloud secrets versions add mosolo-database-url --project=projet-exemple --quiet --data-file=-
    + gcloud secrets create mosolo-receipt-signing-key --project=projet-exemple --quiet --replication-policy=user-managed --locations=africa-south1 --labels=app=mosolo
    + '<gen_ed25519 : valeur générée localement, jamais affichée>' | gcloud secrets versions add mosolo-receipt-signing-key --project=projet-exemple --quiet --data-file=-
    + gcloud secrets create mosolo-closure-signing-key --project=projet-exemple --quiet --replication-policy=user-managed --locations=africa-south1 --labels=app=mosolo
    + '<gen_ed25519 : valeur générée localement, jamais affichée>' | gcloud secrets versions add mosolo-closure-signing-key --project=projet-exemple --quiet --data-file=-
    + gcloud secrets create mosolo-jwt-private-key --project=projet-exemple --quiet --replication-policy=user-managed --locations=africa-south1 --labels=app=mosolo
    + '<gen_ed25519 : valeur générée localement, jamais affichée>' | gcloud secrets versions add mosolo-jwt-private-key --project=projet-exemple --quiet --data-file=-
    + gcloud secrets create mosolo-audit-hmac-key --project=projet-exemple --quiet --replication-policy=user-managed --locations=africa-south1 --labels=app=mosolo
    + '<gen_aleatoire : valeur générée localement, jamais affichée>' | gcloud secrets versions add mosolo-audit-hmac-key --project=projet-exemple --quiet --data-file=-
    + gcloud secrets create mosolo-backup-key --project=projet-exemple --quiet --replication-policy=user-managed --locations=africa-south1 --labels=app=mosolo
    + '<gen_aleatoire : valeur générée localement, jamais affichée>' | gcloud secrets versions add mosolo-backup-key --project=projet-exemple --quiet --data-file=-
    + gcloud secrets create mosolo-provider-secret-mm-operator-a --project=projet-exemple --quiet --replication-policy=user-managed --locations=africa-south1 --labels=app=mosolo
    + '<gen_aleatoire : valeur générée localement, jamais affichée>' | gcloud secrets versions add mosolo-provider-secret-mm-operator-a --project=projet-exemple --quiet --data-file=-
    + gcloud secrets create mosolo-provider-secret-bank-a --project=projet-exemple --quiet --replication-policy=user-managed --locations=africa-south1 --labels=app=mosolo
    + '<gen_aleatoire : valeur générée localement, jamais affichée>' | gcloud secrets versions add mosolo-provider-secret-bank-a --project=projet-exemple --quiet --data-file=-
    + gcloud secrets create mosolo-provider-secret-card-gateway --project=projet-exemple --quiet --replication-policy=user-managed --locations=africa-south1 --labels=app=mosolo
    + '<gen_aleatoire : valeur générée localement, jamais affichée>' | gcloud secrets versions add mosolo-provider-secret-card-gateway --project=projet-exemple --quiet --data-file=-
    + gcloud secrets create mosolo-integrite-key --project=projet-exemple --quiet --replication-policy=user-managed --locations=africa-south1 --labels=app=mosolo
    + '<gen_aleatoire : valeur générée localement, jamais affichée>' | gcloud secrets versions add mosolo-integrite-key --project=projet-exemple --quiet --data-file=-
    + gcloud secrets create mosolo-payment-point-master-key --project=projet-exemple --quiet --replication-policy=user-managed --locations=africa-south1 --labels=app=mosolo
    + '<gen_aleatoire : valeur générée localement, jamais affichée>' | gcloud secrets versions add mosolo-payment-point-master-key --project=projet-exemple --quiet --data-file=-
    + gcloud secrets create mosolo-metrics-token --project=projet-exemple --quiet --replication-policy=user-managed --locations=africa-south1 --labels=app=mosolo
    + '<gen_aleatoire : valeur générée localement, jamais affichée>' | gcloud secrets versions add mosolo-metrics-token --project=projet-exemple --quiet --data-file=-
    ATTENTION : secrets des prestataires (mosolo-provider-secret-*) : valeurs aléatoires provisoires, à REMPLACER par celles convenues avec chaque prestataire (gcloud secrets versions add … --data-file=-).

==> [08] Utilisateur de MIGRATION de la base (le rôle APPLICATIF est créé par la tâche de migration, sans privilège)
    + gcloud sql users create mosolo_migration --project=projet-exemple --quiet --instance=mosolo-pg --password=***

==> [09] Buckets : données hors base (ancre d'audit, copie WORM, publication) et sauvegardes signées
    + gcloud storage buckets create gs://projet-exemple-mosolo-donnees --project=projet-exemple --quiet --location=africa-south1 --uniform-bucket-level-access --public-access-prevention
    + gcloud storage buckets update gs://projet-exemple-mosolo-donnees --project=projet-exemple --quiet --versioning
    + gcloud storage buckets create gs://projet-exemple-mosolo-sauvegardes --project=projet-exemple --quiet --location=africa-south1 --uniform-bucket-level-access --public-access-prevention
    + gcloud storage buckets update gs://projet-exemple-mosolo-sauvegardes --project=projet-exemple --quiet --lifecycle-file=<dépôt>/infra/gcp/.rendu/cycle-de-vie-sauvegardes.json

==> [10] Droits : chaque compte n'accède qu'à ses propres secrets et buckets
    + gcloud secrets add-iam-policy-binding mosolo-database-url --project=projet-exemple --quiet --member=serviceAccount:mosolo-run@projet-exemple.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor --condition=None
    + gcloud secrets add-iam-policy-binding mosolo-receipt-signing-key --project=projet-exemple --quiet --member=serviceAccount:mosolo-run@projet-exemple.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor --condition=None
    + gcloud secrets add-iam-policy-binding mosolo-closure-signing-key --project=projet-exemple --quiet --member=serviceAccount:mosolo-run@projet-exemple.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor --condition=None
    + gcloud secrets add-iam-policy-binding mosolo-jwt-private-key --project=projet-exemple --quiet --member=serviceAccount:mosolo-run@projet-exemple.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor --condition=None
    + gcloud secrets add-iam-policy-binding mosolo-audit-hmac-key --project=projet-exemple --quiet --member=serviceAccount:mosolo-run@projet-exemple.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor --condition=None
    + gcloud secrets add-iam-policy-binding mosolo-backup-key --project=projet-exemple --quiet --member=serviceAccount:mosolo-run@projet-exemple.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor --condition=None
    + gcloud secrets add-iam-policy-binding mosolo-provider-secret-mm-operator-a --project=projet-exemple --quiet --member=serviceAccount:mosolo-run@projet-exemple.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor --condition=None
    + gcloud secrets add-iam-policy-binding mosolo-provider-secret-bank-a --project=projet-exemple --quiet --member=serviceAccount:mosolo-run@projet-exemple.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor --condition=None
    + gcloud secrets add-iam-policy-binding mosolo-provider-secret-card-gateway --project=projet-exemple --quiet --member=serviceAccount:mosolo-run@projet-exemple.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor --condition=None
    + gcloud secrets add-iam-policy-binding mosolo-integrite-key --project=projet-exemple --quiet --member=serviceAccount:mosolo-run@projet-exemple.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor --condition=None
    + gcloud secrets add-iam-policy-binding mosolo-payment-point-master-key --project=projet-exemple --quiet --member=serviceAccount:mosolo-run@projet-exemple.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor --condition=None
    + gcloud secrets add-iam-policy-binding mosolo-metrics-token --project=projet-exemple --quiet --member=serviceAccount:mosolo-run@projet-exemple.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor --condition=None
    + gcloud secrets add-iam-policy-binding mosolo-database-url-migration --project=projet-exemple --quiet --member=serviceAccount:mosolo-migration@projet-exemple.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor --condition=None
    + gcloud secrets add-iam-policy-binding mosolo-db-app-password --project=projet-exemple --quiet --member=serviceAccount:mosolo-migration@projet-exemple.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor --condition=None
    + gcloud secrets add-iam-policy-binding mosolo-database-url --project=projet-exemple --quiet --member=serviceAccount:mosolo-sauvegarde@projet-exemple.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor --condition=None
    + gcloud secrets add-iam-policy-binding mosolo-backup-key --project=projet-exemple --quiet --member=serviceAccount:mosolo-sauvegarde@projet-exemple.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor --condition=None
    + gcloud secrets add-iam-policy-binding mosolo-audit-hmac-key --project=projet-exemple --quiet --member=serviceAccount:mosolo-sauvegarde@projet-exemple.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor --condition=None
    + gcloud storage buckets add-iam-policy-binding gs://projet-exemple-mosolo-donnees --project=projet-exemple --quiet --member=serviceAccount:mosolo-run@projet-exemple.iam.gserviceaccount.com --role=roles/storage.objectUser
    + gcloud storage buckets add-iam-policy-binding gs://projet-exemple-mosolo-sauvegardes --project=projet-exemple --quiet --member=serviceAccount:mosolo-sauvegarde@projet-exemple.iam.gserviceaccount.com --role=roles/storage.objectUser

==> [11] Migrations : tâche Cloud Run mosolo-migrate (rejouable, verrou consultatif, rôle applicatif à droits minimaux)
    + gcloud run jobs replace <dépôt>/infra/gcp/.rendu/job-migration.yaml --project=projet-exemple --quiet --region=africa-south1
    + gcloud run jobs execute mosolo-migrate --project=projet-exemple --quiet --region=africa-south1 --wait

==> [12] Service Cloud Run mosolo (production, min = max = 1 instance, CPU toujours alloué, sondes /health)
    description rendue : infra/gcp/.rendu/service.yaml (adresse publique https://mosolo.exemple.cd)
    + gcloud run services replace <dépôt>/infra/gcp/.rendu/service.yaml --project=projet-exemple --quiet --region=africa-south1
    + gcloud run services add-iam-policy-binding mosolo --project=projet-exemple --quiet --region=africa-south1 --member=allUsers --role=roles/run.invoker
    + gcloud run services update-traffic mosolo --project=projet-exemple --quiet --region=africa-south1 --to-latest

==> [13] Sauvegarde quotidienne signée : tâche mosolo-sauvegarde + Cloud Scheduler (15 2 * * *, Africa/Kinshasa)
    + gcloud run jobs replace <dépôt>/infra/gcp/.rendu/job-sauvegarde.yaml --project=projet-exemple --quiet --region=africa-south1
    + gcloud run jobs add-iam-policy-binding mosolo-sauvegarde --project=projet-exemple --quiet --region=africa-south1 --member=serviceAccount:mosolo-planificateur@projet-exemple.iam.gserviceaccount.com --role=roles/run.invoker
    + gcloud scheduler jobs create http mosolo-sauvegarde-quotidienne --project=projet-exemple --quiet --location=africa-south1 '--schedule=15 2 * * *' --time-zone=Africa/Kinshasa --http-method=POST --uri=https://run.googleapis.com/v2/projects/projet-exemple/locations/africa-south1/jobs/mosolo-sauvegarde:run --oauth-service-account-email=mosolo-planificateur@projet-exemple.iam.gserviceaccount.com --attempt-deadline=900s
    Cloud SQL conserve en plus 14 sauvegardes automatiques et 7 jours de journaux (PITR).

==> [14] Nom de domaine mosolo.exemple.cd (lb)
    + gcloud compute addresses create mosolo-ip --global --project=projet-exemple --quiet
    + gcloud compute network-endpoint-groups create mosolo-neg --region=africa-south1 --project=projet-exemple --quiet --network-endpoint-type=serverless --cloud-run-service=mosolo
    + gcloud compute backend-services create mosolo-backend --global --project=projet-exemple --quiet --load-balancing-scheme=EXTERNAL_MANAGED
    + gcloud compute backend-services add-backend mosolo-backend --global --project=projet-exemple --quiet --network-endpoint-group=mosolo-neg --network-endpoint-group-region=africa-south1
    + gcloud compute url-maps create mosolo-urlmap --global --project=projet-exemple --quiet --default-service=mosolo-backend
    + gcloud compute ssl-certificates create mosolo-cert --global --project=projet-exemple --quiet --domains=mosolo.exemple.cd
    + gcloud compute target-https-proxies create mosolo-https --global --project=projet-exemple --quiet --url-map=mosolo-urlmap --ssl-certificates=mosolo-cert
    + gcloud compute forwarding-rules create mosolo-https-443 --global --project=projet-exemple --quiet --load-balancing-scheme=EXTERNAL_MANAGED --address=mosolo-ip --target-https-proxy=mosolo-https --ports=443
    + gcloud compute url-maps import mosolo-redirection-http --global --project=projet-exemple --quiet --source=<dépôt>/infra/gcp/.rendu/redirection-http.yaml
    + gcloud compute target-http-proxies create mosolo-http --global --project=projet-exemple --quiet --url-map=mosolo-redirection-http
    + gcloud compute forwarding-rules create mosolo-http-80 --global --project=projet-exemple --quiet --load-balancing-scheme=EXTERNAL_MANAGED --address=mosolo-ip --target-http-proxy=mosolo-http --ports=80
    Certificat géré : actif 15 à 60 min après la propagation DNS. Ensuite, INGRESS=internal-and-cloud-load-balancing
    ferme l'adresse *.run.app (relancer ce script) ; vérifier alors MOSOLO_TRUST_PROXY (TRUST_PROXY) derrière l'équilibreur.

==> [15] Contrôle de santé
    + curl -fsS https://mosolo-000000000000.africa-south1.run.app/health

==> [16] Terminé — état : ./infra/gcp/status.sh ; retour arrière : ./infra/gcp/rollback.sh
```

Simulation de la démonstration (`DRY_RUN=1 PROJECT_ID=projet-exemple DEMO=true IMAGE_TAG=exemple ./infra/gcp/deploy.sh`) :

<!-- SIMULATION:gcp-demonstration.txt -->
```text
    MODE SIMULATION (DRY_RUN=1) : aucune commande n'est exécutée, aucun secret n'est généré.
    Projet projet-exemple, région africa-south1, image africa-south1-docker.pkg.dev/projet-exemple/mosolo/mosolo:exemple, mode DÉMONSTRATION (mosolo-demo)

==> [01] Activation des API
    + gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com iam.googleapis.com storage.googleapis.com --project=projet-exemple --quiet

==> [02] Dépôt Artifact Registry mosolo (africa-south1)
    + gcloud artifacts repositories create mosolo --project=projet-exemple --quiet --location=africa-south1 --repository-format=docker '--description=Images KINSHASA MOSOLO'

==> [03] Comptes de service (moindre privilège)
    + gcloud iam service-accounts create mosolo-build --project=projet-exemple --quiet '--display-name=MOSOLO — construction (Cloud Build)'
    + gcloud iam service-accounts create mosolo-demo --project=projet-exemple --quiet '--display-name=MOSOLO — démonstration (aucun droit)'
    + gcloud storage buckets create gs://projet-exemple-mosolo-construction --project=projet-exemple --quiet --location=africa-south1 --uniform-bucket-level-access --public-access-prevention
    + gcloud artifacts repositories add-iam-policy-binding mosolo --project=projet-exemple --quiet --location=africa-south1 --member=serviceAccount:mosolo-build@projet-exemple.iam.gserviceaccount.com --role=roles/artifactregistry.writer
    + gcloud storage buckets add-iam-policy-binding gs://projet-exemple-mosolo-construction --project=projet-exemple --quiet --member=serviceAccount:mosolo-build@projet-exemple.iam.gserviceaccount.com --role=roles/storage.objectViewer
    + gcloud projects add-iam-policy-binding projet-exemple --quiet --member=serviceAccount:mosolo-build@projet-exemple.iam.gserviceaccount.com --role=roles/logging.logWriter --condition=None

==> [04] Construction de l'image par Cloud Build (e2-highcpu-8, NODE_OPTIONS=--max-old-space-size=3072)
    + gcloud builds submit . --project=projet-exemple --quiet --region=africa-south1 --config=infra/gcp/cloudbuild.yaml --ignore-file=infra/gcp/.gcloudignore --substitutions=_IMAGE=africa-south1-docker.pkg.dev/projet-exemple/mosolo/mosolo:exemple,_HEAP_MB=3072,_FOND_DE_CARTE=1 --machine-type=e2-highcpu-8 --service-account=projects/projet-exemple/serviceAccounts/mosolo-build@projet-exemple.iam.gserviceaccount.com --gcs-source-staging-dir=gs://projet-exemple-mosolo-construction/sources

==> [05] Service de démonstration mosolo-demo (--demo, données non contractuelles)
    description rendue : infra/gcp/.rendu/service-demo.yaml
    + gcloud run services replace <dépôt>/infra/gcp/.rendu/service-demo.yaml --project=projet-exemple --quiet --region=africa-south1
    + gcloud run services add-iam-policy-binding mosolo-demo --project=projet-exemple --quiet --region=africa-south1 --member=allUsers --role=roles/run.invoker

==> [06] Contrôle de santé
    + curl -fsS 'https://mosolo-demo-<numéro de projet>.africa-south1.run.app/health'
```

Simulation du retour arrière (`DRY_RUN=1 PROJECT_ID=projet-exemple ./infra/gcp/rollback.sh`) :

<!-- SIMULATION:gcp-rollback.txt -->
```text
==> [01] Révisions du service mosolo (africa-south1)
    + gcloud run services describe mosolo --project=projet-exemple --quiet --region=africa-south1 --format=value(status.traffic[0].revisionName)
    + gcloud run revisions list --service=mosolo --project=projet-exemple --quiet --region=africa-south1 --sort-by=~metadata.creationTimestamp --format=value(metadata.name)
    (simulation) révision servie : mosolo-00002-abc ; précédente : mosolo-00001-xyz

==> [02] Trafic : 100 % vers mosolo-00001-xyz
    + gcloud run services update-traffic mosolo --project=projet-exemple --quiet --region=africa-south1 --to-revisions=mosolo-00001-xyz=100

==> [03] Contrôle de santé
    + curl -fsS 'https://mosolo-<numéro de projet>.africa-south1.run.app/health'
    Revenir à la dernière révision : gcloud run services update-traffic mosolo --region=africa-south1 --to-latest
```
