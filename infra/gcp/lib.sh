#!/usr/bin/env bash
# KINSHASA MOSOLO — fonctions communes des scripts Google Cloud (deploy.sh, rollback.sh, status.sh).
# DRY_RUN=1 : chaque commande gcloud / docker / curl est AFFICHÉE et jamais exécutée ; les existences sont supposées
# absentes (toutes les créations sont montrées) ; aucune valeur secrète n'est générée ni affichée.
# shellcheck shell=bash

DRY_RUN="${DRY_RUN:-0}"
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC2034  # utilisé par deploy.sh (racine envoyée à Cloud Build)
REPO_ROOT="$(cd "$LIB_DIR/../.." && pwd)"
NUMERO_ETAPE=0

etape() { NUMERO_ETAPE=$((NUMERO_ETAPE + 1)); printf '\n==> [%02d] %s\n' "$NUMERO_ETAPE" "$*"; }
info() { printf '    %s\n' "$*"; }
avertir() { printf '    ATTENTION : %s\n' "$*"; }
erreur() { printf 'ERREUR : %s\n' "$*" >&2; }
est_simulation() { [[ "$DRY_RUN" == "1" ]]; }

# Affichage d'une commande : mots de passe masqués.
montrer() {
  local out="" a
  for a in "$@"; do
    case "$a" in
      --password=*) a="--password=***" ;;
    esac
    if [[ "$a" =~ [[:space:]] ]]; then out+="'$a' "; else out+="$a "; fi
  done
  out="${out//"$REPO_ROOT"/<dépôt>}"   # racine du dépôt abrégée
  printf '    + %s\n' "${out% }"
}

# Exécute (ou montre seulement, en DRY_RUN) une commande ; la commande est toujours journalisée.
run() {
  montrer "$@"
  est_simulation || "$@"
}

# Idem, sortie standard de la commande écartée (liaisons IAM : politique complète inutile au journal).
runq() {
  montrer "$@"
  est_simulation || "$@" >/dev/null
}

# Vrai si la commande de description réussit (ressource existante). En DRY_RUN : toujours faux (création montrée).
existe() {
  est_simulation && return 1
  "$@" >/dev/null 2>&1
}

exiger_outil() {
  local o
  for o in "$@"; do
    if ! command -v "$o" >/dev/null 2>&1; then
      if est_simulation; then avertir "$o absent (sans effet en DRY_RUN)"; else erreur "$o introuvable"; exit 1; fi
    fi
  done
}

exiger_projet() {
  if [[ -z "${PROJECT_ID:-}" ]]; then
    erreur "PROJECT_ID obligatoire (ex. PROJECT_ID=mosolo-kinshasa REGION=africa-south1 $0)"
    exit 2
  fi
}

# Générateurs de secrets (jamais affichés) : chaîne aléatoire forte, clé privée Ed25519 PKCS#8 (PEM).
gen_aleatoire() { openssl rand -base64 48 | tr -d '\n=' | tr '+/' '-_'; }
gen_ed25519() { openssl genpkey -algorithm ed25519; }

# ---------------------------------------------------------------------------------------------------------------------
# Prestataires de paiement BitriPay et KODA (voir docs/prestataires-paiement.md) : variable de l'application ← secret.
# Secrets saisis par ./infra/gcp/secrets-prestataires.sh <bitripay|koda> (jamais affichés) ; raccordés automatiquement
# au service Cloud Run par deploy.sh (EXTRA_SECRETS) dès qu'ils ont une version.
# ---------------------------------------------------------------------------------------------------------------------
# shellcheck disable=SC2034  # utilisées par deploy.sh et secrets-prestataires.sh
SECRETS_BITRIPAY=(
  "BITRIPAY_API_KEY=mosolo-bitripay-api-key"
  "BITRIPAY_WEBHOOK_SECRET=mosolo-bitripay-webhook-secret"
  "BITRIPAY_ED25519_PUBLIC_KEY=mosolo-bitripay-ed25519-public-key"
)
# shellcheck disable=SC2034
SECRETS_KODA=(
  "KODA_API_KEY=mosolo-koda-api-key"
  "KODA_WEBHOOK_SECRET=mosolo-koda-webhook-secret"
)
# Variables NON secrètes admises dans le fichier prestataires.env (URL, opérateurs, alias du coffre, options).
# shellcheck disable=SC2034
VARIABLES_PRESTATAIRES_PUBLIQUES=(
  BITRIPAY_BASE_URL BITRIPAY_SETTLEMENT_ACCOUNT_ALIAS BITRIPAY_ALLOWED_OPERATORS BITRIPAY_ACCOUNT_ID BITRIPAY_CDF_EXPONENT
  BITRIPAY_HMAC_REQUIRED BITRIPAY_ED25519_REQUIRED
  KODA_BASE_URL KODA_SETTLEMENT_ACCOUNT_ALIAS KODA_OPERATORS KODA_SUCCESS_URL
)
