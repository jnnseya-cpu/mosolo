#!/usr/bin/env bash
# =====================================================================================================================
# KINSHASA MOSOLO — démonstration sur un VPS (Hostinger ou tout Ubuntu 22.04 / 24.04). À lancer depuis infra/vps/demo/.
#
#   ./demo.sh            première mise en service ou mise à jour : git pull, construction, démarrage, contrôle de santé
#   ./demo.sh status     état des conteneurs et adresse du site
#   ./demo.sh logs       derniers messages de l'application (aucune clé n'y figure)
#   ./demo.sh stop       arrêt (les données de démonstration, en mémoire, repartent à zéro au prochain démarrage)
#
# Les clés des prestataires se placent dans .env (droits 600) ; elles survivent aux redémarrages. Aucune valeur n'est
# jamais affichée par ce script. Variables : SKIP_PULL=1 (pas de git pull), HEALTH_TIMEOUT=300 (secondes).
# =====================================================================================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
DEMO_DIR="$(pwd)"
REPO_ROOT="$(cd ../../.. && pwd)"
ENV_FILE="${DEMO_DIR}/.env"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-300}"

etape() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
erreur() { printf 'ERREUR : %s\n' "$*" >&2; }
compose() { docker compose --project-directory "$DEMO_DIR" -f "$DEMO_DIR/docker-compose.yml" "$@"; }

# Lit une variable de .env sans l'afficher.
lire() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
# Écrit (ou remplace) une variable NON secrète dans .env.
ecrire() {
  if grep -q "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; fi
}

preparer_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$DEMO_DIR/.env.example" "$ENV_FILE"
    info ".env créé à partir de .env.example"
  fi
  chmod 600 "$ENV_FILE"

  local domaine; domaine="$(lire MOSOLO_DOMAIN)"
  if [[ -z "$domaine" ]]; then
    # Sans nom de domaine : <IP>.sslip.io pointe vers l'adresse du VPS, ce qui permet un certificat HTTPS valide.
    local ip; ip="$(curl -fsS4 --max-time 10 https://api.ipify.org || true)"
    if [[ -z "$ip" ]]; then erreur "adresse IP publique introuvable : renseigner MOSOLO_DOMAIN dans .env"; exit 1; fi
    domaine="${ip//./-}.sslip.io"
    ecrire MOSOLO_DOMAIN "$domaine"
    info "Aucun domaine : adresse ${domaine} (HTTPS automatique, sans achat de domaine)"
  fi
  ecrire MOSOLO_PUBLIC_URL "https://${domaine}"

  if [[ -z "$(lire MOSOLO_ACME_EMAIL)" ]]; then
    local email=""
    read -r -p "    Adresse e-mail pour le certificat HTTPS (Let's Encrypt) : " email
    if [[ -z "$email" ]]; then erreur "adresse e-mail requise pour le certificat"; exit 1; fi
    ecrire MOSOLO_ACME_EMAIL "$email"
  fi

  # Jeux de clés incomplets : l'application refuserait de démarrer. On le dit AVANT (noms seulement, jamais de valeur).
  local manque=0
  verifier_jeu() {
    local nom="$1"; shift
    local presentes=0 absentes=()
    for v in "$@"; do if [[ -n "$(lire "$v")" ]]; then presentes=$((presentes + 1)); else absentes+=("$v"); fi; done
    if (( presentes == 0 )); then info "${nom} : aucune clé — paiement simulé (démonstration)"
    elif (( ${#absentes[@]} == 0 )); then info "${nom} : clés présentes — mode réel (essai)"
    else erreur "${nom} : jeu incomplet, il manque ${absentes[*]} (renseigner toutes ses clés ou aucune)"; manque=1; fi
  }
  verifier_jeu "BitriPay" BITRIPAY_API_KEY BITRIPAY_WEBHOOK_SECRET BITRIPAY_ED25519_PUBLIC_KEY
  verifier_jeu "KODA" KODA_API_KEY KODA_WEBHOOK_SECRET
  local ia=0; for v in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY; do [[ -n "$(lire "$v")" ]] && ia=$((ia + 1)); done
  info "IA : ${ia} fournisseur(s) configuré(s)$( (( ia == 0 )) && printf ' — règles internes, aucun appel externe')"
  if (( manque )); then erreur "corriger .env (nano .env) puis relancer ./demo.sh"; exit 1; fi
}

adresse() { printf 'https://%s' "$(lire MOSOLO_DOMAIN)"; }

deployer() {
  command -v docker >/dev/null || { erreur "Docker absent : lancer d'abord « sudo ../install.sh »"; exit 1; }
  etape "Configuration (.env)"
  preparer_env
  if [[ "${SKIP_PULL:-0}" != "1" ]]; then
    etape "Mise à jour du code (git pull)"
    git -C "$REPO_ROOT" pull --ff-only
  fi
  etape "Construction de l'image mosolo:demo (plusieurs minutes la première fois)"
  docker build --pull -t mosolo:demo -f "$REPO_ROOT/Dockerfile" "$REPO_ROOT"
  etape "Démarrage"
  compose up -d --remove-orphans
  etape "Contrôle de santé (jusqu'à ${HEALTH_TIMEOUT} s)"
  local t=0
  until [[ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q app)" 2>/dev/null)" == "healthy" ]]; do
    if (( t >= HEALTH_TIMEOUT )); then
      erreur "l'application n'a pas démarré. Derniers messages (aucune clé n'y figure) :"
      compose logs --tail 40 app >&2
      exit 1
    fi
    sleep 5; t=$((t + 5))
  done
  etape "En service : $(adresse)"
  info "Premier accès : le certificat HTTPS peut prendre une minute."
  info "Webhooks à communiquer : $(adresse)/v1/providers/bitripay/webhooks et $(adresse)/v1/providers/koda/webhooks"
}

case "${1:-deploy}" in
  deploy) deployer ;;
  status) compose ps; [[ -f "$ENV_FILE" ]] && info "Adresse : $(adresse)" ;;
  logs) compose logs --tail "${2:-100}" app ;;
  stop) compose down ;;
  *) erreur "commande inconnue : $1 (deploy | status | logs | stop)"; exit 1 ;;
esac
