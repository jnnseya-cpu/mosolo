#!/usr/bin/env bash
# =====================================================================================================================
# KINSHASA MOSOLO — saisie des secrets d'un prestataire de paiement (BitriPay ou KODA) dans Google Secret Manager.
#
#   PROJECT_ID=<projet> ./infra/gcp/secrets-prestataires.sh bitripay
#   PROJECT_ID=<projet> ./infra/gcp/secrets-prestataires.sh koda
#   DRY_RUN=1 PROJECT_ID=<projet> ./infra/gcp/secrets-prestataires.sh bitripay   # montre les commandes, ne demande rien
#
# Chaque valeur est demandée SANS ÉCHO (read -s), transmise à gcloud par l'entrée standard (--data-file=-) et n'est
# jamais affichée, journalisée, ni écrite sur disque. Une réponse vide conserve la version existante (aucun
# remplacement). Le secret est créé s'il est absent (réplication ${SECRET_LOCATIONS:-REGION}), puis une nouvelle version
# est ajoutée : l'ancienne reste désactivable ou réactivable (retour arrière : docs/prestataires-paiement.md).
# Ensuite : relancer ./infra/gcp/deploy.sh — les secrets présents sont raccordés au service Cloud Run (EXTRA_SECRETS),
# et le compte de service d'exécution reçoit le droit de les lire. Variables NON secrètes (URL, opérateurs, alias) :
# infra/gcp/prestataires.env (modèle : prestataires.env.example).
# =====================================================================================================================
set -euo pipefail
# shellcheck source=infra/gcp/lib.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

PROJECT_ID="${PROJECT_ID:-}"
REGION="${REGION:-africa-south1}"
SECRET_LOCATIONS="${SECRET_LOCATIONS:-$REGION}"
PRESTATAIRE="${1:-}"

exiger_projet
G=(--project="$PROJECT_ID" --quiet)

case "$PRESTATAIRE" in
  bitripay) PAIRES=("${SECRETS_BITRIPAY[@]}"); NOM="BitriPay" ;;
  koda) PAIRES=("${SECRETS_KODA[@]}"); NOM="KODA" ;;
  *) erreur "usage : PROJECT_ID=<projet> $0 <bitripay|koda>"; exit 2 ;;
esac

exiger_outil gcloud

# Description de chaque saisie (jamais la valeur).
aide() {
  case "$1" in
    *_API_KEY) printf 'clé secrète côté serveur (sk_test_… pour le bac à sable, sk_live_… pour le réel)' ;;
    *_WEBHOOK_SECRET) printf 'secret de signature des webhooks fourni par le prestataire (whsec_… ou équivalent)' ;;
    *_ED25519_PUBLIC_KEY) printf 'clé publique Ed25519 de la plateforme (GET /v1/keys) — facultative, PEM sur une ligne ou 32 octets base64' ;;
    *) printf 'valeur' ;;
  esac
}

etape "Secrets ${NOM} dans Secret Manager (projet ${PROJECT_ID}) — saisie sans écho, jamais affichée"
AJOUTES=()
for pair in "${PAIRES[@]}"; do
  variable="${pair%%=*}"
  secret="${pair#*=}"
  if est_simulation; then
    montrer gcloud secrets describe "$secret" "${G[@]}"
    montrer gcloud secrets create "$secret" "${G[@]}" --replication-policy=user-managed --locations="$SECRET_LOCATIONS" --labels=app=mosolo,prestataire="$PRESTATAIRE"
    montrer "<${variable} : saisie sans écho, jamais affichée>" "|" gcloud secrets versions add "$secret" "${G[@]}" --data-file=-
    continue
  fi
  printf '\n    %s — %s\n' "$variable" "$(aide "$variable")"
  valeur=""
  # -s : aucun écho ; -r : aucune interprétation des barres obliques inverses.
  IFS= read -r -s -p "    Valeur (vide = conserver l'existant) : " valeur || true
  printf '\n'
  if [[ -z "$valeur" ]]; then
    info "${variable} : inchangé"
    continue
  fi
  if [[ "$valeur" == demo-* ]]; then
    unset valeur
    erreur "${variable} : valeur de démonstration refusée (secret public)."
    exit 1
  fi
  if [[ "$variable" == *_API_KEY && "$valeur" == pk_* ]]; then
    unset valeur
    erreur "${variable} : clé PUBLIABLE (pk_…) refusée — seule une clé secrète sk_… est admise côté serveur."
    exit 1
  fi
  if ! existe gcloud secrets describe "$secret" "${G[@]}"; then
    run gcloud secrets create "$secret" "${G[@]}" --replication-policy=user-managed --locations="$SECRET_LOCATIONS" --labels=app=mosolo,prestataire="$PRESTATAIRE"
  fi
  montrer "<${variable} : valeur saisie, jamais affichée>" "|" gcloud secrets versions add "$secret" "${G[@]}" --data-file=-
  printf '%s' "$valeur" | gcloud secrets versions add "$secret" "${G[@]}" --data-file=- >/dev/null
  unset valeur
  AJOUTES+=("$variable")
done

etape "Suite"
if ((${#AJOUTES[@]})); then info "nouvelles versions : ${AJOUTES[*]}"; else info "aucune nouvelle version"; fi
info "raccordement au service : PROJECT_ID=${PROJECT_ID} SKIP_BUILD=1 IMAGE_TAG=<image en service> ./infra/gcp/deploy.sh"
info "   (deploy.sh ajoute automatiquement à EXTRA_SECRETS : $(IFS=,; printf '%s' "${PAIRES[*]}"))"
info "variables non secrètes : infra/gcp/prestataires.env (URL de l'API, opérateurs, alias du compte de règlement du coffre)"
info "adresse du webhook à communiquer à ${NOM} : <MOSOLO_PUBLIC_URL>/v1/providers/${PRESTATAIRE}/webhooks"
info "vérification : écran « Prestataires connectés » → « Prestataires de paiement — état de raccordement » → Tester la connexion"
