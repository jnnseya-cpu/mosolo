#!/usr/bin/env bash
# =====================================================================================================================
# KINSHASA MOSOLO — déploiement Google Cloud (Cloud Run + Cloud SQL PostgreSQL + Secret Manager), idempotent :
# relancer le script ne recrée rien d'existant, ne remplace aucun secret, et publie une nouvelle révision.
#
#   PROJECT_ID=<projet> [REGION=africa-south1] [DOMAIN=mosolo.exemple.cd] ./infra/gcp/deploy.sh
#   PROJECT_ID=<projet> DEMO=true ./infra/gcp/deploy.sh          # service de DÉMONSTRATION séparé (--demo, mémoire)
#   DRY_RUN=1 PROJECT_ID=<projet> ./infra/gcp/deploy.sh          # affiche toutes les commandes, n'exécute rien
#
# Production : jamais --demo ; NODE_ENV=production ; PostgreSQL (IP privée) ; secrets dans Secret Manager ;
# une seule instance (min = max = 1 : état en mémoire, tâches planifiées internes) avec CPU toujours alloué.
# Voir infra/gcp/README.md (commandes exactes, coûts estimés, note de souveraineté).
# =====================================================================================================================
set -euo pipefail
# shellcheck source=infra/gcp/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

# ---------------------------------------------------------------------------------------------------------------------
# Paramètres (valeurs chiffrées : PAR DÉFAUT — À CONFIRMER PAR LE MAÎTRE D'OUVRAGE)
# ---------------------------------------------------------------------------------------------------------------------
PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-africa-south1}"
DOMAIN="${DOMAIN:-}"
DOMAIN_MODE="${DOMAIN_MODE:-lb}"                 # lb : équilibreur HTTPS global + certificat géré ; mapping : domain-mappings
DEMO="${DEMO:-false}"
SERVICE="${SERVICE:-mosolo}"
DEMO_SERVICE="${DEMO_SERVICE:-mosolo-demo}"
AR_REPO="${AR_REPO:-mosolo}"
IMAGE_TAG="${IMAGE_TAG:-}"
SKIP_BUILD="${SKIP_BUILD:-0}"
BUILD_REGION="${BUILD_REGION:-$REGION}"         # « global » si Cloud Build régional indisponible dans la région
BUILD_MACHINE="${BUILD_MACHINE:-e2-highcpu-8}"  # 8 vCPU / 8 Go : la construction du frontend demande ~700 Mo de tas
BUILD_HEAP_MB="${BUILD_HEAP_MB:-3072}"
NETWORK="${NETWORK:-default}"
SUBNET="${SUBNET:-default}"
SQL_INSTANCE="${SQL_INSTANCE:-mosolo-pg}"
SQL_TIER="${SQL_TIER:-db-custom-1-3840}"        # 1 vCPU / 3,75 Go
SQL_AVAILABILITY="${SQL_AVAILABILITY:-ZONAL}"    # REGIONAL : haute disponibilité (coût ×2)
SQL_STORAGE_GB="${SQL_STORAGE_GB:-20}"
SQL_BACKUP_START="${SQL_BACKUP_START:-00:00}"    # UTC (01:00 à Kinshasa)
SQL_BACKUPS_KEPT="${SQL_BACKUPS_KEPT:-14}"
SQL_LOG_DAYS="${SQL_LOG_DAYS:-7}"                # restauration à un instant donné (PITR)
DB_NAME="${DB_NAME:-mosolo}"
DB_MIGRATION_USER="mosolo_migration"
DB_APP_ROLE="mosolo_app"
CPU="${CPU:-2}"
MEMORY="${MEMORY:-2Gi}"
CONCURRENCY="${CONCURRENCY:-80}"
INGRESS="${INGRESS:-all}"                        # internal-and-cloud-load-balancing : seulement via l'équilibreur
TRUST_PROXY="${TRUST_PROXY:-1}"
DEMO_MIN_INSTANCES="${DEMO_MIN_INSTANCES:-0}"
# Accès à la DÉMONSTRATION (troisième passe, D3-06) : « mot-de-passe » (défaut) = mot de passe d'accès commun généré dans
# Secret Manager (mosolo-demo-access-password), exigé par le navigateur avant tout écran — en démonstration, l'en-tête
# x-demo-user permet sinon à tout visiteur d'agir sous n'importe quel rôle ; « public » = comportement antérieur
# (ouvert à tous), conservé et disponible. Choix à confirmer par le maître d'ouvrage.
DEMO_ACCESS="${DEMO_ACCESS:-mot-de-passe}"
DEMO_ACCESS_SECRET="${DEMO_ACCESS_SECRET:-mosolo-demo-access-password}"
SCHEDULER_REGION="${SCHEDULER_REGION:-$REGION}"
BACKUP_SCHEDULE="${BACKUP_SCHEDULE:-15 2 * * *}" # tous les jours à 02:15, heure de Kinshasa
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
SECRET_LOCATIONS="${SECRET_LOCATIONS:-$REGION}"
BOOTSTRAP_FILE="${BOOTSTRAP_FILE:-}"             # fichier local mosolo-amorcage/1 (facultatif)
EXTRA_SECRETS="${EXTRA_SECRETS:-}"               # « VARIABLE=nom-du-secret,… » (clés fournisseurs ajoutées plus tard)
# Prestataires de paiement BitriPay / KODA (docs/prestataires-paiement.md) : « auto » raccorde au service chaque secret
# mosolo-bitripay-* / mosolo-koda-* qui possède une version (saisie : ./infra/gcp/secrets-prestataires.sh <prestataire>) ;
# « non » n'en raccorde aucun. Variables non secrètes (URL, opérateurs, alias du coffre) : PRESTATAIRES_ENV_FILE.
PRESTATAIRES_SECRETS="${PRESTATAIRES_SECRETS:-auto}"
PRESTATAIRES_ENV_FILE="${PRESTATAIRES_ENV_FILE:-${LIB_DIR}/prestataires.env}"
PRESTATAIRES_ENV=()                              # « VARIABLE=valeur » non secrètes, validées (voir lire_prestataires_env)

G=(--project="$PROJECT_ID" --quiet)
IMAGE_BASE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/mosolo"
DATA_BUCKET="${PROJECT_ID}-mosolo-donnees"
BACKUP_BUCKET="${PROJECT_ID}-mosolo-sauvegardes"
BUILD_BUCKET="${PROJECT_ID}-mosolo-construction"
RENDU="${LIB_DIR}/.rendu"
sa() { printf '%s@%s.iam.gserviceaccount.com' "$1" "$PROJECT_ID"; }
SA_RUN="$(sa mosolo-run)"; SA_MIGRATION="$(sa mosolo-migration)"; SA_SAUVEGARDE="$(sa mosolo-sauvegarde)"
SA_PLANIF="$(sa mosolo-planificateur)"; SA_BUILD="$(sa mosolo-build)"; SA_DEMO="$(sa mosolo-demo)"

# Variables de l'application ← secrets (Secret Manager). Obligatoires au démarrage de production : les onze premières
# (liste contrôlée par backend/test/deploiement.test.ts) ; les suivantes sont recommandées.
SECRETS_APP=(
  "DATABASE_URL=mosolo-database-url"
  "MOSOLO_RECEIPT_SIGNING_KEY=mosolo-receipt-signing-key"
  "MOSOLO_CLOSURE_SIGNING_KEY=mosolo-closure-signing-key"
  "MOSOLO_JWT_PRIVATE_KEY=mosolo-jwt-private-key"
  "MOSOLO_AUDIT_HMAC_KEY=mosolo-audit-hmac-key"
  "MOSOLO_BACKUP_KEY=mosolo-backup-key"
  "MOSOLO_PROVIDER_SECRET_MM_OPERATOR_A=mosolo-provider-secret-mm-operator-a"
  "MOSOLO_PROVIDER_SECRET_BANK_A=mosolo-provider-secret-bank-a"
  "MOSOLO_PROVIDER_SECRET_CARD_GATEWAY=mosolo-provider-secret-card-gateway"
  "MOSOLO_INTEGRITE_KEY=mosolo-integrite-key"
  "MOSOLO_PAYMENT_POINT_MASTER_KEY=mosolo-payment-point-master-key"
  "MOSOLO_METRICS_TOKEN=mosolo-metrics-token"
)
# Variables non secrètes du service (NODE_ENV=production, MOSOLO_AUDIT_ANCHOR_PATH… : voir rendre_service).

# ---------------------------------------------------------------------------------------------------------------------
# Secret Manager : création si absent, première version générée localement et transmise par l'entrée standard.
# ---------------------------------------------------------------------------------------------------------------------
secret_a_une_version() {
  est_simulation && return 1
  [[ -n "$(gcloud secrets versions list "$1" "${G[@]}" --filter='state=ENABLED' --limit=1 --format='value(name)' 2>/dev/null)" ]]
}

secret_lire() { gcloud secrets versions access latest --secret="$1" "${G[@]}"; }

# secret_assurer <nom> <générateur> : NOUVEAU=1 si une version vient d'être créée.
secret_assurer() {
  local nom="$1" generateur="$2"
  NOUVEAU=0
  if secret_a_une_version "$nom"; then
    info "secret ${nom} : présent (conservé, jamais remplacé)"
    return 0
  fi
  if ! existe gcloud secrets describe "$nom" "${G[@]}"; then
    run gcloud secrets create "$nom" "${G[@]}" --replication-policy=user-managed --locations="$SECRET_LOCATIONS" --labels=app=mosolo
  fi
  montrer "<${generateur} : valeur générée localement, jamais affichée>" "|" gcloud secrets versions add "$nom" "${G[@]}" --data-file=-
  if ! est_simulation; then
    "$generateur" | gcloud secrets versions add "$nom" "${G[@]}" --data-file=- >/dev/null
  fi
  NOUVEAU=1
}

secret_acces() { # <secret> <compte de service>
  runq gcloud secrets add-iam-policy-binding "$1" "${G[@]}" --member="serviceAccount:$2" --role=roles/secretmanager.secretAccessor --condition=None
}

compte_service() { # <nom court> <description>
  if existe gcloud iam service-accounts describe "$(sa "$1")" "${G[@]}"; then
    info "compte de service $1 : présent"
  else
    run gcloud iam service-accounts create "$1" "${G[@]}" --display-name="$2"
  fi
}

bucket() { # <nom> <description>
  if existe gcloud storage buckets describe "gs://$1" "${G[@]}"; then
    info "bucket gs://$1 : présent ($2)"
  else
    run gcloud storage buckets create "gs://$1" "${G[@]}" --location="$REGION" --uniform-bucket-level-access --public-access-prevention
  fi
}

# ---------------------------------------------------------------------------------------------------------------------
# Rendu des descriptions Cloud Run (YAML déclaratif : `gcloud run services|jobs replace`) dans infra/gcp/.rendu/
# ---------------------------------------------------------------------------------------------------------------------
env_yaml() { printf '        - name: %s\n          value: "%s"\n' "$1" "$2"; }
secret_yaml() { printf '        - name: %s\n          valueFrom:\n            secretKeyRef:\n              name: %s\n              key: latest\n' "$1" "$2"; }
reseau_annotations() {
  printf '        run.googleapis.com/execution-environment: gen2\n'
  printf "        run.googleapis.com/network-interfaces: '[{\"network\":\"%s\",\"subnetwork\":\"%s\"}]'\n" "$NETWORK" "$SUBNET"
  printf '        run.googleapis.com/vpc-access-egress: private-ranges-only\n'
}
volume_bucket_yaml() { # <nom du volume> <bucket>
  printf '      - name: %s\n        csi:\n          driver: gcsfuse.run.googleapis.com\n          readOnly: false\n          volumeAttributes:\n            bucketName: %s\n            mountOptions: "uid=1000,gid=1000,file-mode=600,dir-mode=700,implicit-dirs"\n' "$1" "$2"
}

# Variables non secrètes des prestataires : seuls les noms de VARIABLES_PRESTATAIRES_PUBLIQUES sont admis ; un nom de
# secret (clé API, secret de webhook) est REFUSÉ (il doit passer par Secret Manager). Aucune valeur n'est affichée.
lire_prestataires_env() {
  local f="$1" ligne nom valeur admis n
  [[ -f "$f" ]] || { info "prestataires : ${f#"$REPO_ROOT"/} absent (valeurs par défaut des connecteurs)"; return 0; }
  while IFS= read -r ligne || [[ -n "$ligne" ]]; do
    [[ -z "${ligne// }" || "$ligne" == \#* ]] && continue
    nom="${ligne%%=*}"; valeur="${ligne#*=}"
    if [[ "$nom" == *_API_KEY || "$nom" == *_WEBHOOK_SECRET || "$nom" == *_ED25519_PUBLIC_KEY ]]; then
      erreur "${f} : ${nom} est un secret — le saisir par ./infra/gcp/secrets-prestataires.sh, jamais dans ce fichier."; exit 1
    fi
    admis=0
    for n in "${VARIABLES_PRESTATAIRES_PUBLIQUES[@]}"; do [[ "$n" == "$nom" ]] && admis=1; done
    if [[ "$admis" != 1 ]]; then erreur "${f} : variable non admise « ${nom} »."; exit 1; fi
    if [[ "$valeur" == *\"* || "$valeur" == *\\* ]]; then erreur "${f} : ${nom} contient un caractère interdit (guillemet, barre oblique inverse)."; exit 1; fi
    PRESTATAIRES_ENV+=("${nom}=${valeur}")
  done < "$f"
  info "prestataires : ${#PRESTATAIRES_ENV[@]} variable(s) non secrète(s) lue(s) dans ${f#"$REPO_ROOT"/} (noms : $(for x in "${PRESTATAIRES_ENV[@]}"; do printf '%s ' "${x%%=*}"; done))"
}

rendre_service() { # <fichier>
  local public_url="$1" f="$2" pair
  {
    cat <<EOF
# Rendu par infra/gcp/deploy.sh — service de PRODUCTION (jamais --demo). Aucune valeur secrète : références Secret Manager.
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: ${SERVICE}
  labels:
    cloud.googleapis.com/location: ${REGION}
    app: mosolo
  annotations:
    run.googleapis.com/ingress: ${INGRESS}
    run.googleapis.com/launch-stage: BETA
spec:
  template:
    metadata:
      labels:
        app: mosolo
        # Horodatage de publication : chaque exécution crée une révision (relit les secrets « latest »).
        deploiement: "${DEPLOIEMENT}"
      annotations:
        # Une seule instance : état applicatif en mémoire (instantané PostgreSQL) et tâches planifiées internes.
        autoscaling.knative.dev/minScale: "1"
        autoscaling.knative.dev/maxScale: "1"
        # CPU toujours alloué (tâches planifiées entre deux requêtes) et accéléré au démarrage.
        run.googleapis.com/cpu-throttling: "false"
        run.googleapis.com/startup-cpu-boost: "true"
$(reseau_annotations)
    spec:
      serviceAccountName: ${SA_RUN}
      containerConcurrency: ${CONCURRENCY}
      timeoutSeconds: 300
      containers:
      - image: ${IMAGE}
        args: ["production"]
        ports:
        - name: http1
          containerPort: 8080
        resources:
          limits:
            cpu: "${CPU}"
            memory: ${MEMORY}
        startupProbe:
          httpGet:
            path: /health
            port: 8080
          periodSeconds: 5
          timeoutSeconds: 4
          failureThreshold: 48
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          periodSeconds: 30
          timeoutSeconds: 5
          failureThreshold: 3
        env:
EOF
    env_yaml NODE_ENV production
    env_yaml MOSOLO_STATIC_DIR frontend/dist
    env_yaml MOSOLO_AUDIT_ANCHOR_PATH /var/lib/mosolo/ancre/ancre-audit.json
    env_yaml MOSOLO_AUDIT_WORM_DIR /var/lib/mosolo/worm
    env_yaml MOSOLO_AUDIT_ROOT_PUBLISH_PATH /var/lib/mosolo/publication/racines-audit.jsonl
    env_yaml MOSOLO_TRUST_PROXY "$TRUST_PROXY"
    env_yaml MOSOLO_PUBLIC_URL "$public_url"
    env_yaml MOSOLO_CORS_ORIGINS "$public_url"
    env_yaml MOSOLO_WEBAUTHN_RP_ID "${public_url#https://}"
    env_yaml MOSOLO_WEBAUTHN_ORIGINS "$public_url"
    if [[ -n "$BOOTSTRAP_FILE" ]]; then
      env_yaml MOSOLO_BOOTSTRAP_FILE /amorcage/amorcage.json
      env_yaml MOSOLO_BOOTSTRAP_CREDENTIALS_OUT /var/lib/mosolo/identifiants-initiaux.json
    fi
    for pair in "${SECRETS_APP[@]}" $(tr ',' ' ' <<<"$EXTRA_SECRETS"); do secret_yaml "${pair%%=*}" "${pair#*=}"; done
    # Prestataires de paiement : variables non secrètes (MOSOLO_PUBLIC_URL ci-dessus sert à l'adresse des webhooks).
    for pair in "${PRESTATAIRES_ENV[@]}"; do env_yaml "${pair%%=*}" "${pair#*=}"; done
    printf '        volumeMounts:\n        - name: donnees\n          mountPath: /var/lib/mosolo\n'
    [[ -n "$BOOTSTRAP_FILE" ]] && printf '        - name: amorcage\n          mountPath: /amorcage\n          readOnly: true\n'
    printf '      volumes:\n'
    volume_bucket_yaml donnees "$DATA_BUCKET"
    [[ -n "$BOOTSTRAP_FILE" ]] && printf '      - name: amorcage\n        secret:\n          secretName: mosolo-bootstrap\n          items:\n          - key: latest\n            path: amorcage.json\n'
    printf '  traffic:\n  - percent: 100\n    latestRevision: true\n'
  } > "$f"
}

rendre_service_demo() { # <fichier>
  local f="$1"
  cat > "$f" <<EOF
# Rendu par infra/gcp/deploy.sh — DÉMONSTRATION (--demo, stockage en mémoire, données NON CONTRACTUELLES).
# Remplace Render (plan gratuit trop petit). Ne jamais y saisir de données réelles.
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: ${DEMO_SERVICE}
  labels:
    cloud.googleapis.com/location: ${REGION}
    app: mosolo-demo
  annotations:
    run.googleapis.com/ingress: all
spec:
  template:
    metadata:
      labels:
        app: mosolo-demo
        deploiement: "${DEPLOIEMENT}"
      annotations:
        # Une instance au plus : la démonstration vit en mémoire (0 = mise en veille hors visite, données réinitialisées).
        autoscaling.knative.dev/minScale: "${DEMO_MIN_INSTANCES}"
        autoscaling.knative.dev/maxScale: "1"
        run.googleapis.com/startup-cpu-boost: "true"
    spec:
      serviceAccountName: ${SA_DEMO}
      containerConcurrency: ${CONCURRENCY}
      timeoutSeconds: 300
      containers:
      - image: ${IMAGE}
        args: ["demo"]
        ports:
        - name: http1
          containerPort: 8080
        resources:
          limits:
            cpu: "1"
            memory: 1Gi
        startupProbe:
          httpGet:
            path: /health
            port: 8080
          periodSeconds: 5
          timeoutSeconds: 4
          failureThreshold: 48
        livenessProbe:
          httpGet:
            path: /health
            port: 8080
          periodSeconds: 30
          timeoutSeconds: 5
          failureThreshold: 3
        env:
        - name: MOSOLO_STATIC_DIR
          value: "frontend/dist"
EOF
  [[ "$DEMO_ACCESS" == "public" ]] || secret_yaml MOSOLO_DEMO_ACCESS_PASSWORD "$DEMO_ACCESS_SECRET" >> "$f"
  printf '  traffic:\n  - percent: 100\n    latestRevision: true\n' >> "$f"
}

rendre_job() { # <nom> <compte> <arguments> <fichier> <volume: oui|non> puis paires VAR=valeur / VAR=@secret
  local nom="$1" compte="$2" args="$3" f="$4" vol="$5" pair
  shift 5
  {
    cat <<EOF
# Rendu par infra/gcp/deploy.sh — tâche Cloud Run ${nom}. Aucune valeur secrète : références Secret Manager.
apiVersion: run.googleapis.com/v1
kind: Job
metadata:
  name: ${nom}
  labels:
    cloud.googleapis.com/location: ${REGION}
    app: mosolo
  annotations:
    run.googleapis.com/launch-stage: BETA
spec:
  template:
    metadata:
      annotations:
$(reseau_annotations)
    spec:
      taskCount: 1
      parallelism: 1
      template:
        spec:
          serviceAccountName: ${compte}
          maxRetries: 0
          timeoutSeconds: 1800
          containers:
          - image: ${IMAGE}
            args: ["${args}"]
            resources:
              limits:
                cpu: "1"
                memory: 1Gi
            env:
EOF
    for pair in "$@"; do
      if [[ "${pair#*=}" == @* ]]; then
        secret_yaml "${pair%%=*}" "${pair#*=@}" | sed 's/^/    /'
      else
        env_yaml "${pair%%=*}" "${pair#*=}" | sed 's/^/    /'
      fi
    done
    if [[ "$vol" == "oui" ]]; then
      printf '            volumeMounts:\n            - name: sauvegardes\n              mountPath: /sauvegardes\n          volumes:\n'
      volume_bucket_yaml sauvegardes "$BACKUP_BUCKET" | sed 's/^/    /'
    fi
  } > "$f"
}

# =====================================================================================================================
exiger_projet
exiger_outil gcloud openssl
mkdir -p "$RENDU"
[[ -n "$IMAGE_TAG" ]] || IMAGE_TAG="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo local)-$(date -u +%Y%m%d%H%M%S)"
IMAGE="${IMAGE_BASE}:${IMAGE_TAG}"
DEPLOIEMENT="$(date -u +%Y%m%d-%H%M%S)"
est_simulation && info "MODE SIMULATION (DRY_RUN=1) : aucune commande n'est exécutée, aucun secret n'est généré."
info "Projet ${PROJECT_ID}, région ${REGION}, image ${IMAGE}, mode $([[ "$DEMO" == "true" ]] && echo "DÉMONSTRATION (${DEMO_SERVICE})" || echo "PRODUCTION (${SERVICE})")"
est_simulation || gcloud --version | head -n 1 | sed 's/^/    /'

# ---------------------------------------------------------------------------------------------------------------------
etape "Activation des API"
API=(run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com iam.googleapis.com storage.googleapis.com)
[[ "$DEMO" == "true" && "$DEMO_ACCESS" != "public" ]] && API+=(secretmanager.googleapis.com)
[[ "$DEMO" == "true" ]] || API+=(sqladmin.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com compute.googleapis.com servicenetworking.googleapis.com)
run gcloud services enable "${API[@]}" "${G[@]}"

# ---------------------------------------------------------------------------------------------------------------------
etape "Dépôt Artifact Registry ${AR_REPO} (${REGION})"
if existe gcloud artifacts repositories describe "$AR_REPO" --location="$REGION" "${G[@]}"; then
  info "dépôt présent"
else
  run gcloud artifacts repositories create "$AR_REPO" "${G[@]}" --location="$REGION" --repository-format=docker --description="Images KINSHASA MOSOLO"
fi

# ---------------------------------------------------------------------------------------------------------------------
etape "Comptes de service (moindre privilège)"
compte_service mosolo-build "MOSOLO — construction (Cloud Build)"
if [[ "$DEMO" == "true" ]]; then
  compte_service mosolo-demo "MOSOLO — démonstration (aucun droit)"
else
  compte_service mosolo-run "MOSOLO — service de production"
  compte_service mosolo-migration "MOSOLO — tâche de migration"
  compte_service mosolo-sauvegarde "MOSOLO — tâche de sauvegarde"
  compte_service mosolo-planificateur "MOSOLO — Cloud Scheduler"
fi
bucket "$BUILD_BUCKET" "sources de construction"
runq gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" "${G[@]}" --location="$REGION" --member="serviceAccount:${SA_BUILD}" --role=roles/artifactregistry.writer
runq gcloud storage buckets add-iam-policy-binding "gs://${BUILD_BUCKET}" "${G[@]}" --member="serviceAccount:${SA_BUILD}" --role=roles/storage.objectViewer
runq gcloud projects add-iam-policy-binding "$PROJECT_ID" --quiet --member="serviceAccount:${SA_BUILD}" --role=roles/logging.logWriter --condition=None

# ---------------------------------------------------------------------------------------------------------------------
etape "Construction de l'image par Cloud Build (${BUILD_MACHINE}, NODE_OPTIONS=--max-old-space-size=${BUILD_HEAP_MB})"
if [[ "$SKIP_BUILD" == "1" ]]; then
  info "construction ignorée (SKIP_BUILD=1) : image ${IMAGE} supposée présente"
else
  REG=()
  [[ "$BUILD_REGION" == "global" ]] || REG=(--region="$BUILD_REGION")
  # Depuis la racine du dépôt (source « . » ; fichier d'exclusion relatif à la source).
  cd "$REPO_ROOT"
  run gcloud builds submit . "${G[@]}" "${REG[@]}" \
    --config=infra/gcp/cloudbuild.yaml --ignore-file=infra/gcp/.gcloudignore \
    --substitutions="_IMAGE=${IMAGE},_HEAP_MB=${BUILD_HEAP_MB}" --machine-type="$BUILD_MACHINE" \
    --service-account="projects/${PROJECT_ID}/serviceAccounts/${SA_BUILD}" \
    --gcs-source-staging-dir="gs://${BUILD_BUCKET}/sources"
fi

# =====================================================================================================================
# Variante DÉMONSTRATION : service séparé, --demo, mémoire, sans base ni secret (remplace Render).
# =====================================================================================================================
if [[ "$DEMO" == "true" ]]; then
  case "$DEMO_ACCESS" in public|mot-de-passe) ;; *) echo "DEMO_ACCESS : « mot-de-passe » ou « public »" >&2; exit 2 ;; esac
  if [[ "$DEMO_ACCESS" != "public" ]]; then
    etape "Mot de passe d'accès à la démonstration (Secret Manager ${DEMO_ACCESS_SECRET}, jamais affiché)"
    secret_assurer "$DEMO_ACCESS_SECRET" gen_aleatoire
    secret_acces "$DEMO_ACCESS_SECRET" "$SA_DEMO"
    info "à communiquer à l'équipe du Gouverneur par un canal sûr : gcloud secrets versions access latest --secret=${DEMO_ACCESS_SECRET} --project=${PROJECT_ID}"
  else
    info "ATTENTION : DEMO_ACCESS=public — démonstration ouverte à tout visiteur, qui peut agir sous n'importe quel rôle fictif."
  fi
  etape "Service de démonstration ${DEMO_SERVICE} (--demo, données non contractuelles)"
  rendre_service_demo "$RENDU/service-demo.yaml"
  info "description rendue : infra/gcp/.rendu/service-demo.yaml"
  run gcloud run services replace "$RENDU/service-demo.yaml" "${G[@]}" --region="$REGION"
  runq gcloud run services add-iam-policy-binding "$DEMO_SERVICE" "${G[@]}" --region="$REGION" --member=allUsers --role=roles/run.invoker
  etape "Contrôle de santé"
  if est_simulation; then
    montrer curl -fsS "https://${DEMO_SERVICE}-<numéro de projet>.${REGION}.run.app/health"
  else
    URL="$(gcloud run services describe "$DEMO_SERVICE" "${G[@]}" --region="$REGION" --format='value(status.url)')"
    curl -fsS --retry 10 --retry-delay 6 --retry-all-errors "${URL}/health" | sed 's/^/    /'
    echo
    info "Démonstration en ligne : ${URL}"
  fi
  exit 0
fi

# =====================================================================================================================
# PRODUCTION
# =====================================================================================================================
etape "Réseau privé : accès privé aux services Google (Cloud SQL sans IP publique)"
if existe gcloud compute networks describe "$NETWORK" "${G[@]}"; then
  info "réseau ${NETWORK} : présent"
else
  run gcloud compute networks create "$NETWORK" "${G[@]}" --subnet-mode=auto
fi
if existe gcloud compute addresses describe mosolo-services-prives --global "${G[@]}"; then
  info "plage d'adresses réservée : présente"
else
  run gcloud compute addresses create mosolo-services-prives "${G[@]}" --global --purpose=VPC_PEERING --prefix-length=16 --network="$NETWORK"
fi
if ! est_simulation && gcloud services vpc-peerings list --network="$NETWORK" "${G[@]}" --format='value(service)' 2>/dev/null | grep -q servicenetworking; then
  info "appairage servicenetworking : présent"
else
  run gcloud services vpc-peerings connect "${G[@]}" --service=servicenetworking.googleapis.com --ranges=mosolo-services-prives --network="$NETWORK"
fi

# ---------------------------------------------------------------------------------------------------------------------
etape "Cloud SQL PostgreSQL 16 ${SQL_INSTANCE} (IP privée, sauvegardes automatiques, restauration à un instant donné)"
if existe gcloud sql instances describe "$SQL_INSTANCE" "${G[@]}"; then
  info "instance présente (paramètres inchangés ; modification volontaire : gcloud sql instances patch)"
else
  run gcloud sql instances create "$SQL_INSTANCE" "${G[@]}" --database-version=POSTGRES_16 --edition=ENTERPRISE \
    --tier="$SQL_TIER" --region="$REGION" --availability-type="$SQL_AVAILABILITY" \
    --storage-type=SSD --storage-size="${SQL_STORAGE_GB}GB" --storage-auto-increase \
    --network="projects/${PROJECT_ID}/global/networks/${NETWORK}" --no-assign-ip \
    --backup-start-time="$SQL_BACKUP_START" --retained-backups-count="$SQL_BACKUPS_KEPT" \
    --enable-point-in-time-recovery --retained-transaction-log-days="$SQL_LOG_DAYS" \
    --deletion-protection --labels=app=mosolo
fi
if existe gcloud sql databases describe "$DB_NAME" --instance="$SQL_INSTANCE" "${G[@]}"; then
  info "base ${DB_NAME} : présente"
else
  run gcloud sql databases create "$DB_NAME" "${G[@]}" --instance="$SQL_INSTANCE"
fi
SQL_IP="10.0.0.0"
if ! est_simulation; then
  SQL_IP="$(gcloud sql instances describe "$SQL_INSTANCE" "${G[@]}" --format='value(ipAddresses[0].ipAddress)')"
fi
info "adresse privée de la base : ${SQL_IP}"

# ---------------------------------------------------------------------------------------------------------------------
etape "Secrets (Secret Manager, réplication ${SECRET_LOCATIONS}) — générés localement, jamais affichés ni remplacés"
exiger_outil openssl
secret_assurer mosolo-db-migration-password gen_aleatoire
MIGRATION_PW_NOUVEAU="$NOUVEAU"
secret_assurer mosolo-db-app-password gen_aleatoire
url_migration() { printf 'postgres://%s:%s@%s:5432/%s' "$DB_MIGRATION_USER" "$(secret_lire mosolo-db-migration-password)" "$SQL_IP" "$DB_NAME"; }
url_app() { printf 'postgres://%s:%s@%s:5432/%s' "$DB_APP_ROLE" "$(secret_lire mosolo-db-app-password)" "$SQL_IP" "$DB_NAME"; }
secret_assurer mosolo-database-url-migration url_migration
secret_assurer mosolo-database-url url_app
for c in mosolo-receipt-signing-key mosolo-closure-signing-key mosolo-jwt-private-key; do secret_assurer "$c" gen_ed25519; done
for c in mosolo-audit-hmac-key mosolo-backup-key mosolo-provider-secret-mm-operator-a mosolo-provider-secret-bank-a \
  mosolo-provider-secret-card-gateway mosolo-integrite-key mosolo-payment-point-master-key mosolo-metrics-token; do
  secret_assurer "$c" gen_aleatoire
done
if [[ -n "$BOOTSTRAP_FILE" ]]; then
  [[ -r "$BOOTSTRAP_FILE" ]] || est_simulation || { erreur "BOOTSTRAP_FILE illisible : $BOOTSTRAP_FILE"; exit 1; }
  lire_amorcage() { cat "$BOOTSTRAP_FILE"; }
  secret_assurer mosolo-bootstrap lire_amorcage
  info "amorçage : une nouvelle version s'ajoute par « gcloud secrets versions add mosolo-bootstrap --data-file=<fichier> »"
fi
avertir "secrets des prestataires (mosolo-provider-secret-*) : valeurs aléatoires provisoires, à REMPLACER par celles convenues avec chaque prestataire (gcloud secrets versions add … --data-file=-)."

etape "Prestataires de paiement BitriPay / KODA : secrets saisis → raccordés au service (EXTRA_SECRETS), jamais affichés"
if [[ "$PRESTATAIRES_SECRETS" == "auto" ]]; then
  for pair in "${SECRETS_BITRIPAY[@]}" "${SECRETS_KODA[@]}"; do
    prest="${pair%%_*}"
    if secret_a_une_version "${pair#*=}"; then
      case ",${EXTRA_SECRETS}," in *",${pair},"*) ;; *) EXTRA_SECRETS="${EXTRA_SECRETS:+${EXTRA_SECRETS},}${pair}" ;; esac
      info "${pair%%=*} ← secret ${pair#*=} : raccordé"
    else
      info "${pair%%=*} : secret ${pair#*=} absent ou sans version (saisie : ./infra/gcp/secrets-prestataires.sh ${prest,,})"
    fi
  done
else
  info "PRESTATAIRES_SECRETS=${PRESTATAIRES_SECRETS} : aucun raccordement automatique (EXTRA_SECRETS seulement)"
fi
lire_prestataires_env "$PRESTATAIRES_ENV_FILE"

etape "Utilisateur de MIGRATION de la base (le rôle APPLICATIF est créé par la tâche de migration, sans privilège)"
if ! est_simulation && gcloud sql users list --instance="$SQL_INSTANCE" "${G[@]}" --format='value(name)' | grep -qx "$DB_MIGRATION_USER"; then
  if [[ "$MIGRATION_PW_NOUVEAU" == "1" ]]; then
    run gcloud sql users set-password "$DB_MIGRATION_USER" "${G[@]}" --instance="$SQL_INSTANCE" --password="$(secret_lire mosolo-db-migration-password)"
  else
    info "utilisateur ${DB_MIGRATION_USER} : présent"
  fi
else
  PW="********"
  est_simulation || PW="$(secret_lire mosolo-db-migration-password)"
  run gcloud sql users create "$DB_MIGRATION_USER" "${G[@]}" --instance="$SQL_INSTANCE" --password="$PW"
  unset PW
fi

# ---------------------------------------------------------------------------------------------------------------------
etape "Buckets : données hors base (ancre d'audit, copie WORM, publication) et sauvegardes signées"
bucket "$DATA_BUCKET" "ancre et copie WORM de la chaîne d'audit"
run gcloud storage buckets update "gs://${DATA_BUCKET}" "${G[@]}" --versioning
bucket "$BACKUP_BUCKET" "sauvegardes signées quotidiennes"
cat > "$RENDU/cycle-de-vie-sauvegardes.json" <<EOF
{ "rule": [ { "action": { "type": "Delete" }, "condition": { "age": ${BACKUP_RETENTION_DAYS} } } ] }
EOF
run gcloud storage buckets update "gs://${BACKUP_BUCKET}" "${G[@]}" --lifecycle-file="$RENDU/cycle-de-vie-sauvegardes.json"

etape "Droits : chaque compte n'accède qu'à ses propres secrets et buckets"
for pair in "${SECRETS_APP[@]}"; do secret_acces "${pair#*=}" "$SA_RUN"; done
[[ -n "$BOOTSTRAP_FILE" ]] && secret_acces mosolo-bootstrap "$SA_RUN"
for pair in $(tr ',' ' ' <<<"$EXTRA_SECRETS"); do secret_acces "${pair#*=}" "$SA_RUN"; done
secret_acces mosolo-database-url-migration "$SA_MIGRATION"
secret_acces mosolo-db-app-password "$SA_MIGRATION"
for c in mosolo-database-url mosolo-backup-key mosolo-audit-hmac-key; do secret_acces "$c" "$SA_SAUVEGARDE"; done
runq gcloud storage buckets add-iam-policy-binding "gs://${DATA_BUCKET}" "${G[@]}" --member="serviceAccount:${SA_RUN}" --role=roles/storage.objectUser
runq gcloud storage buckets add-iam-policy-binding "gs://${BACKUP_BUCKET}" "${G[@]}" --member="serviceAccount:${SA_SAUVEGARDE}" --role=roles/storage.objectUser

# ---------------------------------------------------------------------------------------------------------------------
etape "Migrations : tâche Cloud Run mosolo-migrate (rejouable, verrou consultatif, rôle applicatif à droits minimaux)"
rendre_job mosolo-migrate "$SA_MIGRATION" migrate "$RENDU/job-migration.yaml" non \
  "DATABASE_URL=@mosolo-database-url-migration" "MOSOLO_DB_APP_ROLE=${DB_APP_ROLE}" \
  "MOSOLO_DB_APP_PASSWORD=@mosolo-db-app-password" "MOSOLO_DB_RESTORE_ROLE=${DB_MIGRATION_USER}"
run gcloud run jobs replace "$RENDU/job-migration.yaml" "${G[@]}" --region="$REGION"
run gcloud run jobs execute mosolo-migrate "${G[@]}" --region="$REGION" --wait

# ---------------------------------------------------------------------------------------------------------------------
etape "Service Cloud Run ${SERVICE} (production, min = max = 1 instance, CPU toujours alloué, sondes /health)"
NUMERO="000000000000"
est_simulation || NUMERO="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
if [[ -n "$DOMAIN" ]]; then PUBLIC_URL="https://${DOMAIN}"; else PUBLIC_URL="https://${SERVICE}-${NUMERO}.${REGION}.run.app"; fi
rendre_service "$PUBLIC_URL" "$RENDU/service.yaml"
info "description rendue : infra/gcp/.rendu/service.yaml (adresse publique ${PUBLIC_URL})"
run gcloud run services replace "$RENDU/service.yaml" "${G[@]}" --region="$REGION"
runq gcloud run services add-iam-policy-binding "$SERVICE" "${G[@]}" --region="$REGION" --member=allUsers --role=roles/run.invoker
# Après un retour arrière (rollback.sh), le trafic était épinglé : la nouvelle révision reprend tout le trafic.
run gcloud run services update-traffic "$SERVICE" "${G[@]}" --region="$REGION" --to-latest

# ---------------------------------------------------------------------------------------------------------------------
etape "Sauvegarde quotidienne signée : tâche mosolo-sauvegarde + Cloud Scheduler (${BACKUP_SCHEDULE}, Africa/Kinshasa)"
rendre_job mosolo-sauvegarde "$SA_SAUVEGARDE" backup-once "$RENDU/job-sauvegarde.yaml" oui \
  "DATABASE_URL=@mosolo-database-url" "MOSOLO_BACKUP_KEY=@mosolo-backup-key" "MOSOLO_AUDIT_HMAC_KEY=@mosolo-audit-hmac-key" \
  "MOSOLO_BACKUP_DIR=/sauvegardes"
run gcloud run jobs replace "$RENDU/job-sauvegarde.yaml" "${G[@]}" --region="$REGION"
runq gcloud run jobs add-iam-policy-binding mosolo-sauvegarde "${G[@]}" --region="$REGION" --member="serviceAccount:${SA_PLANIF}" --role=roles/run.invoker
PLANIF=(--location="$SCHEDULER_REGION" --schedule="$BACKUP_SCHEDULE" --time-zone=Africa/Kinshasa --http-method=POST
  --uri="https://run.googleapis.com/v2/projects/${PROJECT_ID}/locations/${REGION}/jobs/mosolo-sauvegarde:run"
  --oauth-service-account-email="$SA_PLANIF" --attempt-deadline=900s)
if existe gcloud scheduler jobs describe mosolo-sauvegarde-quotidienne --location="$SCHEDULER_REGION" "${G[@]}"; then
  run gcloud scheduler jobs update http mosolo-sauvegarde-quotidienne "${G[@]}" "${PLANIF[@]}"
else
  run gcloud scheduler jobs create http mosolo-sauvegarde-quotidienne "${G[@]}" "${PLANIF[@]}"
fi
info "Cloud SQL conserve en plus ${SQL_BACKUPS_KEPT} sauvegardes automatiques et ${SQL_LOG_DAYS} jours de journaux (PITR)."

# ---------------------------------------------------------------------------------------------------------------------
if [[ -n "$DOMAIN" ]]; then
  etape "Nom de domaine ${DOMAIN} (${DOMAIN_MODE})"
  if [[ "$DOMAIN_MODE" == "mapping" ]]; then
    if existe gcloud beta run domain-mappings describe --domain="$DOMAIN" --region="$REGION" "${G[@]}"; then
      info "correspondance présente"
    else
      run gcloud beta run domain-mappings create --service="$SERVICE" --domain="$DOMAIN" --region="$REGION" "${G[@]}"
    fi
    info "Enregistrements DNS à créer : gcloud beta run domain-mappings describe --domain=${DOMAIN} --region=${REGION}"
  else
    existe gcloud compute addresses describe mosolo-ip --global "${G[@]}" || run gcloud compute addresses create mosolo-ip --global "${G[@]}"
    existe gcloud compute network-endpoint-groups describe mosolo-neg --region="$REGION" "${G[@]}" || \
      run gcloud compute network-endpoint-groups create mosolo-neg --region="$REGION" "${G[@]}" --network-endpoint-type=serverless --cloud-run-service="$SERVICE"
    if existe gcloud compute backend-services describe mosolo-backend --global "${G[@]}"; then
      info "service de backend présent"
    else
      run gcloud compute backend-services create mosolo-backend --global "${G[@]}" --load-balancing-scheme=EXTERNAL_MANAGED
      run gcloud compute backend-services add-backend mosolo-backend --global "${G[@]}" --network-endpoint-group=mosolo-neg --network-endpoint-group-region="$REGION"
    fi
    existe gcloud compute url-maps describe mosolo-urlmap --global "${G[@]}" || run gcloud compute url-maps create mosolo-urlmap --global "${G[@]}" --default-service=mosolo-backend
    existe gcloud compute ssl-certificates describe mosolo-cert --global "${G[@]}" || run gcloud compute ssl-certificates create mosolo-cert --global "${G[@]}" --domains="$DOMAIN"
    existe gcloud compute target-https-proxies describe mosolo-https --global "${G[@]}" || run gcloud compute target-https-proxies create mosolo-https --global "${G[@]}" --url-map=mosolo-urlmap --ssl-certificates=mosolo-cert
    existe gcloud compute forwarding-rules describe mosolo-https-443 --global "${G[@]}" || run gcloud compute forwarding-rules create mosolo-https-443 --global "${G[@]}" --load-balancing-scheme=EXTERNAL_MANAGED --address=mosolo-ip --target-https-proxy=mosolo-https --ports=443
    # Redirection HTTP → HTTPS.
    cat > "$RENDU/redirection-http.yaml" <<EOF
name: mosolo-redirection-http
defaultUrlRedirect:
  redirectResponseCode: MOVED_PERMANENTLY_DEFAULT
  httpsRedirect: true
EOF
    existe gcloud compute url-maps describe mosolo-redirection-http --global "${G[@]}" || run gcloud compute url-maps import mosolo-redirection-http --global "${G[@]}" --source="$RENDU/redirection-http.yaml"
    existe gcloud compute target-http-proxies describe mosolo-http --global "${G[@]}" || run gcloud compute target-http-proxies create mosolo-http --global "${G[@]}" --url-map=mosolo-redirection-http
    existe gcloud compute forwarding-rules describe mosolo-http-80 --global "${G[@]}" || run gcloud compute forwarding-rules create mosolo-http-80 --global "${G[@]}" --load-balancing-scheme=EXTERNAL_MANAGED --address=mosolo-ip --target-http-proxy=mosolo-http --ports=80
    if ! est_simulation; then
      info "Enregistrement DNS A : ${DOMAIN} → $(gcloud compute addresses describe mosolo-ip --global "${G[@]}" --format='value(address)')"
    fi
    info "Certificat géré : actif 15 à 60 min après la propagation DNS. Ensuite, INGRESS=internal-and-cloud-load-balancing"
    info "ferme l'adresse *.run.app (relancer ce script) ; vérifier alors MOSOLO_TRUST_PROXY (TRUST_PROXY) derrière l'équilibreur."
  fi
fi

# ---------------------------------------------------------------------------------------------------------------------
etape "Contrôle de santé"
if est_simulation; then
  montrer curl -fsS "https://${SERVICE}-${NUMERO}.${REGION}.run.app/health"
else
  URL="$(gcloud run services describe "$SERVICE" "${G[@]}" --region="$REGION" --format='value(status.url)')"
  curl -fsS --retry 10 --retry-delay 6 --retry-all-errors "${URL}/health" | sed 's/^/    /'
  echo
  info "Service : ${URL}   Adresse publique : ${PUBLIC_URL}"
fi
etape "Terminé — état : ./infra/gcp/status.sh ; retour arrière : ./infra/gcp/rollback.sh"
