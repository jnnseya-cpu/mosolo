#!/usr/bin/env bash
# =====================================================================================================================
# KINSHASA MOSOLO — déploiement VPS (Docker Compose). À lancer depuis infra/vps/ sur le serveur.
#
#   ./deploy.sh secrets          génère une fois les secrets vides de .env (rien n'est affiché ; .env en 600)
#   ./deploy.sh [deploy]         tirer (git pull), construire, migrer, redémarrer, contrôler la santé ;
#                                retour AUTOMATIQUE à l'image précédente si la santé échoue
#   ./deploy.sh rollback [tag]   revenir à l'image précédente (ou à <tag>)
#   ./deploy.sh status           état des conteneurs, santé, image en service
#   ./deploy.sh backup-now       sauvegarde signée immédiate (outil existant backup-cli)
#   ./deploy.sh verify <fichier>                 vérifie une sauvegarde (signature, chaîne d'audit)
#   ./deploy.sh restore <fichier> <opérateur>    RESTAURATION : arrêt de l'application, restauration par le rôle de
#                                                migration (opérateur de restauration), redémarrage, contrôle de santé
#
# Variables : DRY_RUN=1 (affiche les commandes sans rien exécuter), SKIP_PULL=1, HEALTH_TIMEOUT=240 (secondes),
#             SKIP_BUILD=1 TAG=<étiquette> (image déjà construite ou importée : mosolo:<étiquette>).
# =====================================================================================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
VPS_DIR="$(pwd)"
REPO_ROOT="$(cd ../.. && pwd)"
ETAT_DIR="${VPS_DIR}/.etat"
DRY_RUN="${DRY_RUN:-0}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-240}"
ENV_FILE="${VPS_DIR}/.env"

etape() { printf '\n==> [%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
info() { printf '    %s\n' "$*"; }
erreur() { printf 'ERREUR : %s\n' "$*" >&2; }

# Exécute une commande, ou l'affiche seulement en DRY_RUN=1.
run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    local c="$*"; printf '    + %s\n' "${c//"$REPO_ROOT"/<dépôt>}"
  else
    "$@"
  fi
}

compose() { run docker compose --project-directory "$VPS_DIR" -f "$VPS_DIR/docker-compose.yml" "$@"; }

charger_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    if [[ "$DRY_RUN" == "1" ]]; then
      info "(DRY_RUN) .env absent : lecture de .env.example à titre d'illustration"
      ENV_FILE="${VPS_DIR}/.env.example"
    else
      erreur ".env absent : cp .env.example .env && chmod 600 .env && ./deploy.sh secrets"
      exit 1
    fi
  fi
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
}

# ---------------------------------------------------------------------------------------------------------------------
# Secrets : chaque variable « générée » vide reçoit une valeur forte ; une valeur déjà présente n'est JAMAIS remplacée.
# ---------------------------------------------------------------------------------------------------------------------
ED25519_VARS=(MOSOLO_RECEIPT_SIGNING_KEY MOSOLO_CLOSURE_SIGNING_KEY MOSOLO_JWT_PRIVATE_KEY)
RANDOM_VARS=(POSTGRES_PASSWORD MOSOLO_DB_APP_PASSWORD MOSOLO_AUDIT_HMAC_KEY MOSOLO_BACKUP_KEY
  MOSOLO_PROVIDER_SECRET_MM_OPERATOR_A MOSOLO_PROVIDER_SECRET_BANK_A MOSOLO_PROVIDER_SECRET_CARD_GATEWAY
  MOSOLO_INTEGRITE_KEY MOSOLO_PAYMENT_POINT_MASTER_KEY MOSOLO_METRICS_TOKEN)

valeur_actuelle() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | sed "s/^'\(.*\)'$/\1/"; }

# Remplace la ligne NOM= par NOM='valeur' (valeur transmise par l'environnement, jamais par la ligne de commande).
poser() {
  local name="$1"
  NOM="$name" VALEUR="$2" awk 'BEGIN { n = ENVIRON["NOM"]; v = ENVIRON["VALEUR"] }
    index($0, n "=") == 1 && !done { print n "='"'"'" v "'"'"'"; done = 1; next } { print }
    END { if (!done) print n "='"'"'" v "'"'"'" }' "$ENV_FILE" > "$ENV_FILE.tmp"
  chmod 600 "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
}

gen_random() { openssl rand -base64 48 | tr -d '\n=' | tr '+/' '-_'; }
gen_ed25519() { openssl genpkey -algorithm ed25519 | awk '{ printf "%s\\n", $0 }'; }

cmd_secrets() {
  etape "Secrets de .env (générés localement, jamais affichés)"
  if [[ ! -f "$ENV_FILE" ]]; then
    run cp "$VPS_DIR/.env.example" "$ENV_FILE"
    run chmod 600 "$ENV_FILE"
    [[ "$DRY_RUN" == "1" ]] && ENV_FILE="${VPS_DIR}/.env.example"
  fi
  command -v openssl >/dev/null || { erreur "openssl absent (apt-get install openssl)"; exit 1; }
  local v generated=0
  for v in "${ED25519_VARS[@]}" "${RANDOM_VARS[@]}"; do
    if [[ -n "$(valeur_actuelle "$v")" ]]; then
      info "$v : déjà présente (conservée)"
      continue
    fi
    if [[ "$DRY_RUN" == "1" ]]; then
      info "+ $v <- (valeur générée localement, non affichée)"
      continue
    fi
    if [[ " ${ED25519_VARS[*]} " == *" $v "* ]]; then poser "$v" "$(gen_ed25519)"; else poser "$v" "$(gen_random)"; fi
    generated=$((generated + 1))
    info "$v : générée"
  done
  # DATABASE_URL du rôle APPLICATIF (hôte « postgres » du réseau interne).
  if [[ -z "$(valeur_actuelle DATABASE_URL)" ]]; then
    if [[ "$DRY_RUN" == "1" ]]; then
      info "+ DATABASE_URL <- postgres://<MOSOLO_DB_APP_ROLE>:***@postgres:5432/<POSTGRES_DB>"
    else
      local role db pw
      role="$(valeur_actuelle MOSOLO_DB_APP_ROLE)"; db="$(valeur_actuelle POSTGRES_DB)"; pw="$(valeur_actuelle MOSOLO_DB_APP_PASSWORD)"
      poser DATABASE_URL "postgres://${role:-mosolo_app}:${pw}@postgres:5432/${db:-mosolo}"
      info "DATABASE_URL : construite (rôle applicatif)"
    fi
  fi
  [[ "$DRY_RUN" == "1" ]] || chmod 600 "$ENV_FILE"
  info "$generated secret(s) généré(s). Les secrets des prestataires sont à REMPLACER par les valeurs convenues avec eux."
  info "Renseigner aussi : MOSOLO_DOMAIN, MOSOLO_ACME_EMAIL, MOSOLO_PUBLIC_URL, MOSOLO_CORS_ORIGINS, MOSOLO_WEBAUTHN_*."
}

verifier_env() {
  etape "Contrôle de .env"
  if [[ "$DRY_RUN" != "1" ]]; then
    local mode
    mode="$(stat -c '%a' "$ENV_FILE")"
    [[ "$mode" == "600" || "$mode" == "400" ]] || { erreur ".env doit être en 600 (actuel : $mode) : chmod 600 .env"; exit 1; }
  fi
  local manque=() v
  for v in NODE_ENV DATABASE_URL MOSOLO_RECEIPT_SIGNING_KEY MOSOLO_CLOSURE_SIGNING_KEY MOSOLO_JWT_PRIVATE_KEY \
    MOSOLO_AUDIT_HMAC_KEY MOSOLO_AUDIT_ANCHOR_PATH MOSOLO_BACKUP_KEY MOSOLO_PROVIDER_SECRET_MM_OPERATOR_A \
    MOSOLO_PROVIDER_SECRET_BANK_A MOSOLO_PROVIDER_SECRET_CARD_GATEWAY POSTGRES_PASSWORD MOSOLO_DB_APP_PASSWORD MOSOLO_DOMAIN; do
    [[ -n "${!v:-}" ]] || manque+=("$v")
  done
  if ((${#manque[@]})); then
    if [[ "$DRY_RUN" == "1" ]]; then info "(DRY_RUN) variables encore vides : ${manque[*]}"; else erreur "variables obligatoires vides : ${manque[*]} (./deploy.sh secrets)"; exit 1; fi
  fi
  if [[ "${MOSOLO_DEMO_MODE:-}" == "true" || "${MOSOLO_DEMO_CREDENTIALS:-}" == "true" ]]; then
    erreur "MOSOLO_DEMO_MODE / MOSOLO_DEMO_CREDENTIALS interdits en production"; exit 1
  fi
  ((${#manque[@]})) || info "variables obligatoires présentes (valeurs non affichées)"
}

image_courante() { cat "$ETAT_DIR/image-courante" 2>/dev/null || true; }

# Image en service : notée dans .etat/ et dans .env (MOSOLO_IMAGE_TAG), pour que `docker compose …` l'utilise aussi.
memoriser() {
  echo "$1" > "$ETAT_DIR/image-courante"
  poser MOSOLO_IMAGE_TAG "$1"
}

sante() {
  # Attend l'état « healthy » du conteneur applicatif (HEALTHCHECK de l'image sur /health).
  local id status t=0
  if [[ "$DRY_RUN" == "1" ]]; then
    info "+ attente de l'état healthy du conteneur app (sonde /health, ${HEALTH_TIMEOUT} s au plus)"
    return 0
  fi
  while ((t < HEALTH_TIMEOUT)); do
    id="$(docker compose --project-directory "$VPS_DIR" ps -q app)"
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo absent)"
    if [[ "$status" == "healthy" ]]; then
      info "app : healthy après ${t} s"
      docker compose --project-directory "$VPS_DIR" exec -T app node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.text()).then(t=>{console.log('    /health : '+t)})"
      return 0
    fi
    if [[ "$status" == "exited" || "$status" == "dead" || "$status" == "unhealthy" ]]; then break; fi
    sleep 5
    t=$((t + 5))
  done
  erreur "app non saine (${status}) — dernières lignes du journal :"
  docker compose --project-directory "$VPS_DIR" logs --tail 40 app >&2 || true
  return 1
}

demarrer() {
  local tag="$1"
  MOSOLO_IMAGE_TAG="$tag" compose up -d --remove-orphans postgres app sauvegarde caddy
}

cmd_deploy() {
  charger_env
  verifier_env
  mkdir -p "$ETAT_DIR"
  local precedent tag
  precedent="$(image_courante)"

  etape "Mise à jour du code source"
  if [[ "${SKIP_PULL:-0}" != "1" && -d "$REPO_ROOT/.git" ]]; then
    run git -C "$REPO_ROOT" pull --ff-only
  else
    info "git pull ignoré (SKIP_PULL=1 ou dépôt absent)"
  fi
  local rev
  rev="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo local)"
  tag="${TAG:-${rev}-$(date -u +%Y%m%d%H%M%S)}"

  if [[ "${SKIP_BUILD:-0}" == "1" ]]; then
    etape "Construction ignorée (SKIP_BUILD=1) : image existante mosolo:${tag}"
    [[ "$DRY_RUN" == "1" ]] || docker image inspect "mosolo:${tag}" >/dev/null || { erreur "image mosolo:${tag} introuvable"; exit 1; }
  else
    etape "Construction de l'image mosolo:${tag} (tas Node ${MOSOLO_BUILD_HEAP_MB:-3072} Mo pour le frontend)"
    run docker build --pull --build-arg "MOSOLO_BUILD_HEAP_MB=${MOSOLO_BUILD_HEAP_MB:-3072}" -t "mosolo:${tag}" -f "$REPO_ROOT/Dockerfile" "$REPO_ROOT"
  fi

  etape "Dossiers hôte (sauvegardes, amorçage) : propriétaire uid 1000 (utilisateur node de l'image)"
  run mkdir -p "$VPS_DIR/sauvegardes" "$VPS_DIR/amorcage"
  run chown 1000:1000 "$VPS_DIR/sauvegardes"
  run chmod 700 "$VPS_DIR/sauvegardes"

  etape "Base de données"
  MOSOLO_IMAGE_TAG="$tag" compose up -d --wait postgres

  etape "Migrations (tâche rejouable ; rôle applicatif et droits minimaux)"
  MOSOLO_IMAGE_TAG="$tag" compose --profile outils run --rm migration

  etape "Redémarrage sur mosolo:${tag} (précédente : ${precedent:-aucune})"
  # Un échec ici (dépendance « app » non saine pour Caddy) ne doit pas empêcher le retour automatique ci-dessous.
  demarrer "$tag" || info "docker compose up a signalé un échec : contrôle de santé puis retour éventuel"

  etape "Contrôle de santé"
  if sante; then
    [[ "$DRY_RUN" == "1" ]] || { memoriser "$tag"; echo "$(date -u +%FT%TZ) $tag" >> "$ETAT_DIR/historique"; }
    etape "Déploiement réussi : mosolo:${tag} — https://${MOSOLO_DOMAIN:-<domaine>}"
    return 0
  fi
  if [[ -n "$precedent" ]]; then
    etape "RETOUR AUTOMATIQUE à mosolo:${precedent}"
    demarrer "$precedent" || true
    sante || erreur "l'image précédente n'est pas saine non plus : intervention requise"
    echo "$(date -u +%FT%TZ) ECHEC ${tag} -> retour ${precedent}" >> "$ETAT_DIR/historique"
  else
    erreur "premier déploiement en échec : aucune image précédente vers laquelle revenir"
  fi
  exit 1
}

cmd_rollback() {
  charger_env
  local cible="${1:-}"
  if [[ -z "$cible" ]]; then
    cible="$(grep -v ECHEC "$ETAT_DIR/historique" 2>/dev/null | awk '{print $2}' | tail -n 2 | head -n 1 || true)"
  fi
  [[ -n "$cible" ]] || { erreur "aucune image précédente connue (.etat/historique) : ./deploy.sh rollback <tag>"; exit 1; }
  etape "Retour à mosolo:${cible} (les migrations sont additives : aucune n'est défaite)"
  demarrer "$cible"
  sante
  [[ "$DRY_RUN" == "1" ]] || { memoriser "$cible"; echo "$(date -u +%FT%TZ) $cible (retour)" >> "$ETAT_DIR/historique"; }
}

cmd_status() {
  charger_env
  etape "Image en service : mosolo:$(image_courante)"
  compose ps
  [[ "$DRY_RUN" == "1" ]] || tail -n 5 "$ETAT_DIR/historique" 2>/dev/null || true
}

cmd_backup_now() {
  charger_env
  etape "Sauvegarde signée immédiate"
  MOSOLO_IMAGE_TAG="$(image_courante)" compose run --rm sauvegarde backup-once
}

cmd_verify() {
  charger_env
  [[ -n "${1:-}" ]] || { erreur "usage : ./deploy.sh verify <fichier dans ./sauvegardes>"; exit 2; }
  etape "Vérification de la sauvegarde $1"
  MOSOLO_IMAGE_TAG="$(image_courante)" compose --profile outils run --rm outils verify "/sauvegardes/$(basename "$1")"
}

cmd_restore() {
  charger_env
  local f="${1:-}" op="${2:-}" tag
  [[ -n "$f" && -n "$op" ]] || { erreur "usage : ./deploy.sh restore <fichier dans ./sauvegardes> <nom de l'opérateur>"; exit 2; }
  tag="$(image_courante)"
  local extra=()
  [[ "${CONFIRM_ROLLBACK:-0}" == "1" ]] && extra+=(--confirm-rollback)
  etape "RESTAURATION de $(basename "$f") par ${op} (application arrêtée ; événement audit.restored ajouté)"
  MOSOLO_IMAGE_TAG="$tag" compose stop app sauvegarde
  if ! MOSOLO_IMAGE_TAG="$tag" compose --profile outils run --rm outils restore "/sauvegardes/$(basename "$f")" --confirm "--operator=${op}" "${extra[@]}"; then
    erreur "restauration refusée ou en échec (sauvegarde plus ancienne : CONFIRM_ROLLBACK=1 après décision écrite)"
    etape "Redémarrage de l'application sur la base inchangée"
    demarrer "$tag" || true
    sante || true
    exit 1
  fi
  etape "Redémarrage sur la base restaurée"
  demarrer "$tag" || true
  sante
}

case "${1:-deploy}" in
  secrets) cmd_secrets ;;
  deploy) cmd_deploy ;;
  rollback) shift; cmd_rollback "${1:-}" ;;
  status) cmd_status ;;
  backup-now) cmd_backup_now ;;
  verify) shift; cmd_verify "${1:-}" ;;
  restore) shift; cmd_restore "${1:-}" "${2:-}" ;;
  *) erreur "commande inconnue : $1 (secrets | deploy | rollback [tag] | status | backup-now | verify | restore)"; exit 2 ;;
esac
