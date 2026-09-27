#!/usr/bin/env bash
# =====================================================================================================================
# KINSHASA MOSOLO — état du déploiement Google Cloud (lecture seule, aucune valeur secrète affichée).
#   PROJECT_ID=<projet> [REGION=africa-south1] [SERVICE=mosolo] ./infra/gcp/status.sh
#   DRY_RUN=1 … : affiche les commandes sans rien exécuter.
# =====================================================================================================================
set -euo pipefail
# shellcheck source=infra/gcp/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-africa-south1}"
SERVICE="${SERVICE:-mosolo}"
SQL_INSTANCE="${SQL_INSTANCE:-mosolo-pg}"
SCHEDULER_REGION="${SCHEDULER_REGION:-$REGION}"
exiger_projet
exiger_outil gcloud
G=(--project="$PROJECT_ID" --quiet)
# Les commandes de lecture continuent même si une ressource n'existe pas (variante démonstration, domaine absent…).
lire() { montrer "$@"; est_simulation || "$@" 2>&1 | sed 's/^/      /' || true; }

etape "Service ${SERVICE} : adresse, révision prête, trafic"
lire gcloud run services describe "$SERVICE" "${G[@]}" --region="$REGION" \
  --format='table[box](status.url,status.latestReadyRevisionName,status.traffic[].revisionName.list(),status.traffic[].percent.list())'
etape "Dernières révisions"
lire gcloud run revisions list --service="$SERVICE" "${G[@]}" --region="$REGION" --limit=5 --sort-by=~metadata.creationTimestamp
etape "Base Cloud SQL ${SQL_INSTANCE} : état, sauvegardes automatiques, PITR"
lire gcloud sql instances describe "$SQL_INSTANCE" "${G[@]}" \
  --format='table[box](state,databaseVersion,settings.tier,settings.availabilityType,settings.backupConfiguration.enabled,settings.backupConfiguration.pointInTimeRecoveryEnabled)'
lire gcloud sql backups list --instance="$SQL_INSTANCE" "${G[@]}" --limit=5
etape "Tâches : migrations et sauvegardes signées (dernières exécutions)"
lire gcloud run jobs executions list --job=mosolo-migrate "${G[@]}" --region="$REGION" --limit=3
lire gcloud run jobs executions list --job=mosolo-sauvegarde "${G[@]}" --region="$REGION" --limit=5
lire gcloud scheduler jobs describe mosolo-sauvegarde-quotidienne --location="$SCHEDULER_REGION" "${G[@]}" --format='table[box](state,schedule,timeZone,lastAttemptTime,status.code)'
etape "Secrets (noms et nombre de versions seulement)"
lire gcloud secrets list "${G[@]}" --filter='labels.app=mosolo' --format='table(name.basename(),createTime.date())'
etape "Santé /health"
if est_simulation; then
  montrer curl -fsS "https://${SERVICE}-<numéro de projet>.${REGION}.run.app/health"
else
  URL="$(gcloud run services describe "$SERVICE" "${G[@]}" --region="$REGION" --format='value(status.url)' 2>/dev/null || true)"
  if [[ -n "$URL" ]]; then curl -fsS "${URL}/health" | sed 's/^/    /' || avertir "sonde /health en échec"; echo; else avertir "service ${SERVICE} introuvable"; fi
fi
