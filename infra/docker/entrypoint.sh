#!/bin/sh
# =====================================================================================================================
# KINSHASA MOSOLO — point d'entrée de l'image (Dockerfile). Un seul argument choisit le mode ; sans argument :
# MOSOLO_MODE, sinon « demo » (comportement historique de l'image : démonstration en mémoire).
#
#   demo            démonstration en mémoire (--demo) — données de démonstration NON CONTRACTUELLES
#   production      production : NODE_ENV=production, PostgreSQL obligatoire, jamais --demo (persistence/server.ts)
#   migrate [...]   tâche de migration rejouable (npm run db:migrate), rôles et droits minimaux si configurés
#   backup-once     sauvegarde signée + vérification dans MOSOLO_BACKUP_DIR (défaut /sauvegardes), rotation locale
#   backup-cron     backup-once chaque jour à MOSOLO_BACKUP_HOUR (heure de Kinshasa, UTC+1, sans heure d'été)
#   verify <f> / restore <f> --confirm [...]   outil existant backup-cli (restauration : serveur ARRÊTÉ)
#   bootstrap-check <f>                        contrôle d'un fichier d'amorçage
#   toute autre commande                       exécutée telle quelle (ex. node node_modules/.bin/tsx backend/src/server.ts --demo)
# =====================================================================================================================
set -eu

TSX="node /app/node_modules/.bin/tsx"

# Variables vides (fichier .env avec « NOM= ») : retirées, pour qu'une valeur vide ne soit jamais prise pour une valeur.
for v in $(env | sed -n 's/^\(\(MOSOLO\|KODA\|BITRIPAY\|SMS\|SVI\|WHATSAPP\|POSTGRES\)_[A-Z0-9_]*\)=$/\1/p'); do
  unset "$v"
done

mode="${1:-${MOSOLO_MODE:-demo}}"
[ "$#" -gt 0 ] && shift

journal() { echo "[mosolo] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

backup_once() {
  dir="${MOSOLO_BACKUP_DIR:-/sauvegardes}"
  mkdir -p "$dir"
  f="$dir/mosolo-$(date -u +%Y%m%dT%H%M%SZ).json"
  journal "Sauvegarde signée vers $f"
  $TSX /app/backend/src/persistence/backup-cli.ts backup "$f"
  $TSX /app/backend/src/persistence/backup-cli.ts verify "$f"
  chmod 600 "$f" 2>/dev/null || true
  if [ -n "${MOSOLO_BACKUP_RETENTION_DAYS:-}" ]; then
    # Rotation locale uniquement (dossier monté) ; les copies hors site suivent leur propre politique.
    find "$dir" -maxdepth 1 -name 'mosolo-*.json' -type f -mtime "+${MOSOLO_BACKUP_RETENTION_DAYS}" -print -delete || true
  fi
}

case "$mode" in
  demo)
    export MOSOLO_DEMO_MODE=true
    export MOSOLO_STATIC_DIR="${MOSOLO_STATIC_DIR:-frontend/dist}"
    exec $TSX backend/src/server.ts --demo "$@"
    ;;
  production)
    if [ "${MOSOLO_DEMO_MODE:-}" = "true" ] || [ "${MOSOLO_DEMO_CREDENTIALS:-}" = "true" ]; then
      echo "Refus : MOSOLO_DEMO_MODE / MOSOLO_DEMO_CREDENTIALS interdits en production." >&2
      exit 1
    fi
    export NODE_ENV=production
    exec $TSX backend/src/persistence/server.ts "$@"
    ;;
  migrate)
    exec $TSX backend/src/persistence/migrate-cli.ts "$@"
    ;;
  backup-once)
    backup_once
    ;;
  backup-cron)
    hour="${MOSOLO_BACKUP_HOUR:-2}"
    journal "Sauvegarde quotidienne à ${hour} h (heure de Kinshasa), rétention ${MOSOLO_BACKUP_RETENTION_DAYS:-illimitée} jour(s)."
    while :; do
      # Kinshasa = UTC+1 toute l'année : heure cible en UTC.
      target=$(( (hour + 23) % 24 ))
      now=$(( $(date -u +%H | sed 's/^0//') * 3600 + $(date -u +%M | sed 's/^0//') * 60 + $(date -u +%S | sed 's/^0//') ))
      wait=$(( (target * 3600 - now + 86400) % 86400 ))
      [ "$wait" -eq 0 ] && wait=86400
      journal "Prochaine sauvegarde dans ${wait} s."
      sleep "$wait"
      backup_once || journal "ÉCHEC de la sauvegarde (voir ci-dessus) ; nouvelle tentative au prochain créneau."
    done
    ;;
  verify|restore)
    exec $TSX backend/src/persistence/backup-cli.ts "$mode" "$@"
    ;;
  bootstrap-check)
    exec $TSX backend/src/persistence/bootstrap-cli.ts check "$@"
    ;;
  *)
    exec "$mode" "$@"
    ;;
esac
