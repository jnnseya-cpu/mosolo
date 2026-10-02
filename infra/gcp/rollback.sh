#!/usr/bin/env bash
# =====================================================================================================================
# KINSHASA MOSOLO — retour arrière Cloud Run : tout le trafic vers la révision PRÉCÉDENTE (ou vers celle indiquée).
#   PROJECT_ID=<projet> [REGION=africa-south1] [SERVICE=mosolo] ./infra/gcp/rollback.sh [révision]
#   DRY_RUN=1 … : affiche les commandes sans rien exécuter.
# Les migrations sont additives (jamais défaites) : l'ancienne révision relit la même base. Le prochain deploy.sh
# rendra le trafic à la nouvelle révision (--to-latest). Démonstration : SERVICE=mosolo-demo.
# =====================================================================================================================
set -euo pipefail
# shellcheck source=infra/gcp/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-africa-south1}"
SERVICE="${SERVICE:-mosolo}"
exiger_projet
exiger_outil gcloud
G=(--project="$PROJECT_ID" --quiet --region="$REGION")
CIBLE="${1:-}"

etape "Révisions du service ${SERVICE} (${REGION})"
if est_simulation; then
  montrer gcloud run services describe "$SERVICE" "${G[@]}" --format='value(status.traffic[0].revisionName)'
  montrer gcloud run revisions list --service="$SERVICE" "${G[@]}" --sort-by=~metadata.creationTimestamp --format='value(metadata.name)'
  ACTUELLE="${SERVICE}-00002-abc"
  CIBLE="${CIBLE:-${SERVICE}-00001-xyz}"
  info "(simulation) révision servie : ${ACTUELLE} ; précédente : ${CIBLE}"
else
  ACTUELLE="$(gcloud run services describe "$SERVICE" "${G[@]}" --format='value(status.traffic[0].revisionName)')"
  [[ -n "$ACTUELLE" ]] || ACTUELLE="$(gcloud run services describe "$SERVICE" "${G[@]}" --format='value(status.latestReadyRevisionName)')"
  mapfile -t REVS < <(gcloud run revisions list --service="$SERVICE" "${G[@]}" --sort-by=~metadata.creationTimestamp --format='value(metadata.name)')
  printf '    %s\n' "${REVS[@]}"
  if [[ -z "$CIBLE" ]]; then
    for i in "${!REVS[@]}"; do
      if [[ "${REVS[$i]}" == "$ACTUELLE" ]]; then CIBLE="${REVS[$((i + 1))]:-}"; break; fi
    done
  fi
  [[ -n "$CIBLE" ]] || { erreur "aucune révision antérieure à ${ACTUELLE}"; exit 1; }
  info "révision servie : ${ACTUELLE} → retour vers : ${CIBLE}"
fi

etape "Trafic : 100 % vers ${CIBLE}"
run gcloud run services update-traffic "$SERVICE" "${G[@]}" --to-revisions="${CIBLE}=100"

etape "Contrôle de santé"
if est_simulation; then
  montrer curl -fsS "https://${SERVICE}-<numéro de projet>.${REGION}.run.app/health"
else
  URL="$(gcloud run services describe "$SERVICE" "${G[@]}" --format='value(status.url)')"
  curl -fsS --retry 10 --retry-delay 6 --retry-all-errors "${URL}/health" | sed 's/^/    /'
  echo
fi
info "Revenir à la dernière révision : gcloud run services update-traffic ${SERVICE} --region=${REGION} --to-latest"
