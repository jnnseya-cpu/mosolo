#!/usr/bin/env bash
# =====================================================================================================================
# KINSHASA MOSOLO — RESTAURATION d'une sauvegarde signée sur Google Cloud (outil existant backup-cli, « restore »).
#   PROJECT_ID=<projet> FICHIER=mosolo-AAAAMMJJTHHMMSSZ.json OPERATEUR=<nom> ./infra/gcp/restaurer.sh
#   [CONFIRM_ROLLBACK=1]  retour à une sauvegarde plus ANCIENNE que la chaîne en place (décision écrite préalable)
#   DRY_RUN=1 …           affiche les commandes sans rien exécuter
#
# Déroulé : tâche Cloud Run « mosolo-restauration » (rôle de MIGRATION = opérateur de restauration, migration 003),
# qui vérifie la sauvegarde (signature, chaîne d'audit, ancre externe) puis prend le BAIL de l'instance active
# (migration 004) : le service en cours cesse aussitôt d'écrire (503 en écriture). La base est restaurée
# (événement audit.restored ajouté), puis une nouvelle révision du service est créée : elle relit la base restaurée.
# Alternative sans fichier : restauration à un instant donné de Cloud SQL (PITR), voir infra/gcp/README.md.
# =====================================================================================================================
set -euo pipefail
# shellcheck source=infra/gcp/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-africa-south1}"
SERVICE="${SERVICE:-mosolo}"
AR_REPO="${AR_REPO:-mosolo}"
FICHIER="${FICHIER:-}"
OPERATEUR="${OPERATEUR:-}"
NETWORK="${NETWORK:-default}"
SUBNET="${SUBNET:-default}"
exiger_projet
exiger_outil gcloud
if [[ -z "$FICHIER" || -z "$OPERATEUR" ]]; then
  erreur "FICHIER=<nom dans gs://${PROJECT_ID}-mosolo-sauvegardes> et OPERATEUR=<nom de la personne> obligatoires"
  exit 2
fi
G=(--project="$PROJECT_ID" --quiet --region="$REGION")
SA="mosolo-migration@${PROJECT_ID}.iam.gserviceaccount.com"

etape "Image en service et contrôle de la présence de la sauvegarde"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/mosolo:<image en service>"
if ! est_simulation; then
  IMAGE="$(gcloud run services describe "$SERVICE" "${G[@]}" --format='value(spec.template.spec.containers[0].image)')"
fi
info "image : ${IMAGE}"
run gcloud storage ls "gs://${PROJECT_ID}-mosolo-sauvegardes/$(basename "$FICHIER")" --project="$PROJECT_ID"

etape "Droits de la tâche : clés de sauvegarde et d'audit, lecture des sauvegardes, ancre d'audit"
for c in mosolo-backup-key mosolo-audit-hmac-key; do
  runq gcloud secrets add-iam-policy-binding "$c" --project="$PROJECT_ID" --quiet --member="serviceAccount:${SA}" --role=roles/secretmanager.secretAccessor --condition=None
done
runq gcloud storage buckets add-iam-policy-binding "gs://${PROJECT_ID}-mosolo-sauvegardes" --project="$PROJECT_ID" --quiet --member="serviceAccount:${SA}" --role=roles/storage.objectViewer
runq gcloud storage buckets add-iam-policy-binding "gs://${PROJECT_ID}-mosolo-donnees" --project="$PROJECT_ID" --quiet --member="serviceAccount:${SA}" --role=roles/storage.objectUser

etape "Tâche mosolo-restauration (recréée à chaque restauration)"
existe gcloud run jobs describe mosolo-restauration "${G[@]}" && run gcloud run jobs delete mosolo-restauration "${G[@]}"
ARGS="restore,/sauvegardes/$(basename "$FICHIER"),--confirm,--operator=${OPERATEUR}"
[[ "${CONFIRM_ROLLBACK:-0}" == "1" ]] && ARGS+=",--confirm-rollback"
run gcloud run jobs create mosolo-restauration "${G[@]}" --image="$IMAGE" --service-account="$SA" \
  --args="$ARGS" --max-retries=0 --task-timeout=3600s --cpu=1 --memory=2Gi \
  --network="$NETWORK" --subnet="$SUBNET" --vpc-egress=private-ranges-only \
  --set-secrets="DATABASE_URL=mosolo-database-url-migration:latest,MOSOLO_BACKUP_KEY=mosolo-backup-key:latest,MOSOLO_AUDIT_HMAC_KEY=mosolo-audit-hmac-key:latest" \
  --set-env-vars="MOSOLO_AUDIT_ANCHOR_PATH=/var/lib/mosolo/ancre/ancre-audit.json" \
  --add-volume="name=sauvegardes,type=cloud-storage,bucket=${PROJECT_ID}-mosolo-sauvegardes,readonly=true" \
  --add-volume-mount="volume=sauvegardes,mount-path=/sauvegardes" \
  --add-volume="name=donnees,type=cloud-storage,bucket=${PROJECT_ID}-mosolo-donnees,mount-options=uid=1000;gid=1000;implicit-dirs" \
  --add-volume-mount="volume=donnees,mount-path=/var/lib/mosolo"

etape "Exécution (vérification, prise du bail, restauration) — le service cesse d'écrire dès la prise du bail"
run gcloud run jobs execute mosolo-restauration "${G[@]}" --wait

etape "Nouvelle révision du service : elle relit la base restaurée"
run gcloud run services update "$SERVICE" "${G[@]}" --update-labels="restauration=$(date -u +%Y%m%d%H%M%S)"
run gcloud run services update-traffic "$SERVICE" "${G[@]}" --to-latest
info "Contrôle : ./infra/gcp/status.sh ; journal du service : « Chaîne d'audit conforme à l'ancre externe »."
