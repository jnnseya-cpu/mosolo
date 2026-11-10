#!/usr/bin/env bash
# =====================================================================================================================
# KINSHASA MOSOLO — préparation d'un VPS Ubuntu 22.04 / 24.04 (une seule fois, en root) :
#   Docker Engine + Compose (dépôt officiel Docker), pare-feu ufw (22, 80, 443), fail2ban (SSH), mises à jour de
#   sécurité automatiques (unattended-upgrades), rotation des journaux Docker, espace d'échange si la mémoire est faible.
# Rejouable sans effet (idempotent). DRY_RUN=1 affiche les commandes sans rien exécuter.
# Variables : SSH_PORT (défaut 22), SWAP_GB (défaut 4, créé seulement si aucune mémoire d'échange et < 8 Go de RAM).
# =====================================================================================================================
set -euo pipefail

DRY_RUN="${DRY_RUN:-0}"
SSH_PORT="${SSH_PORT:-22}"
SWAP_GB="${SWAP_GB:-4}"

etape() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
run() {
  if [[ "$DRY_RUN" == "1" ]]; then printf '    + %s\n' "$*"; else "$@"; fi
}
# Écrit un fichier (contenu sur l'entrée standard) ; en DRY_RUN, l'affiche.
ecrire() {
  local dest="$1" contenu
  contenu="$(cat)"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '    + écrire %s :\n' "$dest"
    printf '%s\n' "$contenu" | sed 's/^/        /'
  else
    printf '%s\n' "$contenu" > "$dest"
  fi
}

etape "Contrôles préalables"
if [[ "$DRY_RUN" != "1" && "$(id -u)" -ne 0 ]]; then
  echo "ERREUR : à lancer en root (sudo ./install.sh)" >&2
  exit 1
fi
CODENAME="jammy"
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  CODENAME="${VERSION_CODENAME:-jammy}"
  if [[ "${ID:-}" != "ubuntu" || ! "${VERSION_ID:-}" =~ ^(22\.04|24\.04)$ ]]; then
    info "ATTENTION : système ${PRETTY_NAME:-inconnu} — kit validé pour Ubuntu 22.04 / 24.04 uniquement."
  fi
fi
info "Distribution ${ID:-inconnue} ${CODENAME}, port SSH ${SSH_PORT}"
ARCH="amd64"
command -v dpkg >/dev/null 2>&1 && ARCH="$(dpkg --print-architecture)"
export DEBIAN_FRONTEND=noninteractive

etape "Paquets de base (certificats, pare-feu, fail2ban, mises à jour automatiques, openssl, git)"
run apt-get update -q
run apt-get install -y -q ca-certificates curl gnupg ufw fail2ban unattended-upgrades apt-listchanges openssl git

etape "Docker Engine et Compose (dépôt officiel download.docker.com)"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  info "Docker et Compose déjà installés : $(docker --version)"
else
  run install -m 0755 -d /etc/apt/keyrings
  run curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  run chmod a+r /etc/apt/keyrings/docker.asc
  ecrire /etc/apt/sources.list.d/docker.list <<EOF
deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${CODENAME} stable
EOF
  run apt-get update -q
  run apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
if [[ ! -f /etc/docker/daemon.json ]]; then
  run install -m 0755 -d /etc/docker
  ecrire /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "live-restore": true
}
EOF
else
  info "/etc/docker/daemon.json existant : conservé"
fi
run systemctl enable --now docker

etape "Pare-feu ufw : entrées refusées sauf SSH (${SSH_PORT}), HTTP (80), HTTPS (443 TCP et UDP/HTTP3)"
run ufw default deny incoming
run ufw default allow outgoing
run ufw allow "${SSH_PORT}/tcp"
run ufw allow 80/tcp
run ufw allow 443/tcp
run ufw allow 443/udp
run ufw --force enable
info "Docker publie seulement 80/443 (Caddy) ; PostgreSQL et l'application ne sont jamais publiés sur l'hôte."

etape "fail2ban : protection SSH (5 échecs → bannissement 1 h)"
ecrire /etc/fail2ban/jail.d/mosolo-sshd.local <<EOF
[sshd]
enabled = true
port = ${SSH_PORT}
maxretry = 5
findtime = 10m
bantime = 1h
EOF
run systemctl enable --now fail2ban
run systemctl restart fail2ban

etape "Mises à jour de sécurité automatiques (unattended-upgrades ; pas de redémarrage automatique)"
ecrire /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
ecrire /etc/apt/apt.conf.d/52mosolo-unattended <<'EOF'
// KINSHASA MOSOLO : redémarrage décidé par l'exploitant (fenêtre de maintenance), jamais automatique.
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
run systemctl enable --now unattended-upgrades

etape "Mémoire d'échange (construction du frontend : ~700 Mo de tas Node, 3 Go réservés par défaut)"
MEM_GB=0
[[ -r /proc/meminfo ]] && MEM_GB=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 / 1024 ))
if [[ -n "$(swapon --show 2>/dev/null || true)" ]]; then
  info "mémoire d'échange déjà présente"
elif (( MEM_GB >= 8 )); then
  info "${MEM_GB} Go de RAM : pas de mémoire d'échange ajoutée"
else
  run fallocate -l "${SWAP_GB}G" /swapfile
  run chmod 600 /swapfile
  run mkswap /swapfile
  run swapon /swapfile
  if ! grep -q '^/swapfile' /etc/fstab 2>/dev/null; then
    if [[ "$DRY_RUN" == "1" ]]; then info "+ ajout de /swapfile à /etc/fstab"; else echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi
  fi
fi

etape "Terminé"
info "Suite : cd infra/vps && cp .env.example .env && chmod 600 .env && ./deploy.sh secrets"
info "puis renseigner MOSOLO_DOMAIN (DNS A/AAAA vers ce serveur), MOSOLO_ACME_EMAIL, MOSOLO_PUBLIC_URL… et ./deploy.sh"
