#!/usr/bin/env bash
# =====================================================================================================================
# KINSHASA MOSOLO — application web SEULE sur Vercel ou Firebase Hosting ; l'API reste sur Cloud Run ou le VPS.
# Prépare un dossier prêt à publier dans infra/static/.rendu/<cible>/ (application construite + configuration) :
#
#   BACKEND_URL=https://mosolo-XXXX.africa-south1.run.app ./infra/static/preparer.sh vercel
#       puis : npx vercel deploy --prod infra/static/.rendu/vercel
#   SERVICE=mosolo REGION=africa-south1 ./infra/static/preparer.sh firebase      (backend Cloud Run du MÊME projet)
#       puis : cd infra/static/.rendu/firebase && npx firebase-tools deploy --only hosting --project <PROJECT_ID>
#
# L'application est construite en « même origine » (VITE_API_URL vide) : /v1/*, /l, /l/*, /.well-known/* et /health
# sont réécrits vers le backend ; tout le reste retombe sur index.html (routage côté client). sw.js et index.html
# ne sont jamais mis en cache. Variables : BUILD=1 (reconstruire même si frontend/dist existe), DRY_RUN=1.
# Le backend ne peut PAS tourner sur Vercel / Firebase Functions : voir infra/static/README.md.
# =====================================================================================================================
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
STATIC_DIR="$(pwd)"
REPO_ROOT="$(cd ../.. && pwd)"
DRY_RUN="${DRY_RUN:-0}"
CIBLE="${1:-}"
DIST="$REPO_ROOT/frontend/dist"
OUT="$STATIC_DIR/.rendu/$CIBLE"

etape() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
run() { local c="$*"; printf '    + %s\n' "${c//"$REPO_ROOT"/<dépôt>}"; [[ "$DRY_RUN" == "1" ]] || "$@"; }

case "$CIBLE" in
  vercel)
    BACKEND_URL="${BACKEND_URL:-}"
    if [[ ! "$BACKEND_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
      echo "ERREUR : BACKEND_URL=https://<hôte du backend> attendu (sans chemin ni barre finale)." >&2
      exit 2
    fi
    ;;
  firebase)
    SERVICE="${SERVICE:-mosolo}"
    REGION="${REGION:-africa-south1}"
    ;;
  *)
    echo "Usage : BACKEND_URL=https://… $0 vercel | SERVICE=mosolo REGION=africa-south1 $0 firebase" >&2
    exit 2
    ;;
esac

etape "Application web (construction « même origine », tas Node 3 Go)"
if [[ "${BUILD:-0}" == "1" || ! -f "$DIST/index.html" ]]; then
  run npm --prefix "$REPO_ROOT" ci --no-audit --no-fund
  run env VITE_API_URL= NODE_OPTIONS=--max-old-space-size=3072 npm --prefix "$REPO_ROOT" run build -w frontend
else
  info "frontend/dist présent (BUILD=1 pour reconstruire)"
fi

etape "Dossier de publication infra/static/.rendu/${CIBLE}"
run rm -rf "$OUT"
run mkdir -p "$OUT"
if [[ "$CIBLE" == "vercel" ]]; then
  run cp -R "$DIST/." "$OUT/"
  info "+ vercel.json : URL-DU-BACKEND → ${BACKEND_URL#https://}"
  [[ "$DRY_RUN" == "1" ]] || sed "s#https://URL-DU-BACKEND#${BACKEND_URL}#g" "$STATIC_DIR/vercel.json" > "$OUT/vercel.json"
  etape "Publication (à lancer par l'exploitant, compte Vercel requis)"
  info "npx vercel deploy --prod infra/static/.rendu/vercel"
else
  run mkdir -p "$OUT/public"
  run cp -R "$DIST/." "$OUT/public/"
  info "+ firebase.json : service Cloud Run ${SERVICE} (${REGION})"
  [[ "$DRY_RUN" == "1" ]] || sed -e "s#SERVICE-CLOUD-RUN#${SERVICE}#g" -e "s#REGION-CLOUD-RUN#${REGION}#g" "$STATIC_DIR/firebase.json" > "$OUT/firebase.json"
  etape "Publication (à lancer par l'exploitant, projet Firebase = projet Google Cloud du backend)"
  info "cd infra/static/.rendu/firebase && npx firebase-tools deploy --only hosting --project <PROJECT_ID>"
fi
