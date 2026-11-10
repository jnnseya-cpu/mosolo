#!/usr/bin/env bash
# =====================================================================================================================
# KINSHASA MOSOLO — clés saisies dans le compte d'administration et CONSERVÉES (24/10/2026). À lancer une fois dans
# Google Cloud Shell. Idempotent. Aucune valeur de clé ne passe par ce script.
#
#   bash infra/gcp/cles-console.sh            (projet « mosolo », service « mosolo-demo », région africa-south1)
#   DRY_RUN=1 bash infra/gcp/cles-console.sh  (affiche les commandes sans rien exécuter)
#   ACCES=public bash infra/gcp/cles-console.sh   (démonstration sans mot de passe — DÉCONSEILLÉ : n'importe quel
#                                                  visiteur peut alors agir en super-administrateur et remplacer les clés)
#
# Ce qu'il met en place :
#   1. un compartiment Cloud Storage privé où la console écrit ses valeurs, CHIFFRÉES (AES-256-GCM) ;
#   2. une clé maîtresse stable dans Secret Manager (générée ici, jamais affichée) : sans elle, les valeurs saisies sont
#      illisibles après chaque redémarrage ;
#   3. un mot de passe d'accès à la démonstration (affiché UNE fois, à transmettre avec le lien) : sans lui, tout
#      visiteur pourrait se présenter comme super-administrateur ;
#   4. le raccordement du service Cloud Run (volume, variables, secrets).
# Ensuite : se connecter comme « Super-administrateur », écran « Clés et raccordements », saisir les clés ; le bandeau
# vert « Valeurs conservées après redémarrage » confirme la conservation.
# =====================================================================================================================
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-mosolo}"
REGION="${REGION:-africa-south1}"
SERVICE="${SERVICE:-mosolo-demo}"
BUCKET="${BUCKET:-${PROJECT_ID}-mosolo-console}"
SECRET_CLE="${SECRET_CLE:-mosolo-config-master-key}"
SECRET_ACCES="${SECRET_ACCES:-mosolo-demo-access-password}"
ACCES="${ACCES:-mot-de-passe}"
MONTAGE="/mnt/mosolo-console"
DRY_RUN="${DRY_RUN:-0}"
G=(--project "$PROJECT_ID" --quiet)

etape() { printf '\n==> %s\n' "$*"; }
run() { if [[ "$DRY_RUN" == "1" ]]; then printf '    + %s\n' "$*"; else "$@"; fi; }
existe() { "$@" >/dev/null 2>&1; }

etape "Services Google nécessaires"
run gcloud services enable secretmanager.googleapis.com storage.googleapis.com run.googleapis.com "${G[@]}"

etape "Compte de service du service Cloud Run ${SERVICE}"
SA="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT_ID" --format='value(spec.template.spec.serviceAccountName)' 2>/dev/null || true)"
if [[ -z "$SA" ]]; then
  NUM="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
  SA="${NUM}-compute@developer.gserviceaccount.com"
fi
echo "    $SA"

etape "Compartiment privé gs://${BUCKET} (valeurs chiffrées de la console)"
if ! existe gcloud storage buckets describe "gs://${BUCKET}" "${G[@]}"; then
  run gcloud storage buckets create "gs://${BUCKET}" --location "$REGION" --uniform-bucket-level-access --public-access-prevention "${G[@]}"
fi
run gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --member "serviceAccount:${SA}" --role roles/storage.objectAdmin "${G[@]}"

etape "Clé maîtresse ${SECRET_CLE} (générée ici, jamais affichée)"
if ! existe gcloud secrets describe "$SECRET_CLE" "${G[@]}"; then
  if [[ "$DRY_RUN" == "1" ]]; then echo "    + (génération de 32 octets aléatoires) | gcloud secrets create $SECRET_CLE --data-file=-"
  else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' | gcloud secrets create "$SECRET_CLE" --replication-policy=automatic --data-file=- "${G[@]}"; fi
fi
run gcloud secrets add-iam-policy-binding "$SECRET_CLE" --member "serviceAccount:${SA}" --role roles/secretmanager.secretAccessor "${G[@]}"

SECRETS="MOSOLO_CONFIG_MASTER_KEY=${SECRET_CLE}:latest"
if [[ "$ACCES" != "public" ]]; then
  etape "Mot de passe d'accès à la démonstration (${SECRET_ACCES})"
  if ! existe gcloud secrets describe "$SECRET_ACCES" "${G[@]}"; then
    MDP="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
    if [[ "$DRY_RUN" == "1" ]]; then echo "    + gcloud secrets create $SECRET_ACCES --data-file=-"
    else printf '%s' "$MDP" | gcloud secrets create "$SECRET_ACCES" --replication-policy=automatic --data-file=- "${G[@]}"; fi
    echo "    MOT DE PASSE D'ACCÈS (à noter et à transmettre avec le lien ; identifiant : n'importe lequel) : ${MDP}"
  else
    echo "    Déjà créé. Le relire : gcloud secrets versions access latest --secret=${SECRET_ACCES} --project ${PROJECT_ID}"
  fi
  run gcloud secrets add-iam-policy-binding "$SECRET_ACCES" --member "serviceAccount:${SA}" --role roles/secretmanager.secretAccessor "${G[@]}"
  SECRETS="${SECRETS},MOSOLO_DEMO_ACCESS_PASSWORD=${SECRET_ACCES}:latest"
fi

etape "Raccordement du service ${SERVICE}"
VOLUME=()
if ! gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT_ID" --format=json 2>/dev/null | grep -q '"name": "console"'; then
  # Propriétaire du montage : utilisateur « node » de l'image (uid / gid 1000), qui écrit le fichier.
  VOLUME=(--add-volume "name=console,type=cloud-storage,bucket=${BUCKET},mount-options=uid=1000;gid=1000" --add-volume-mount "volume=console,mount-path=${MONTAGE}")
fi
run gcloud run services update "$SERVICE" --region "$REGION" "${G[@]}" --execution-environment gen2 "${VOLUME[@]}" \
  --update-env-vars "MOSOLO_CONSOLE_FILE=${MONTAGE}/cles.json" --update-secrets "$SECRETS"

etape "Terminé"
echo "    Ouvrir la démonstration, se connecter comme « Super-administrateur », écran « Clés et raccordements »."
echo "    Bandeau vert « Valeurs conservées après redémarrage » : tout est en place. Bandeau rouge : envoyer son texte."
