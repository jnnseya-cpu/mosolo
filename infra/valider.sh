#!/usr/bin/env bash
# shellcheck disable=SC2015  # « A && ok || ko » : ok() ne peut pas échouer.
# =====================================================================================================================
# KINSHASA MOSOLO — validation HORS LIGNE du kit de déploiement (aucun compte cloud, rien n'est déployé) :
#   1. syntaxe (bash -n) et analyse statique (shellcheck, si installé) de tous les scripts ;
#   2. Dockerfile : hadolint (si installé) ;
#   3. simulations DRY_RUN=1 de chaque script (Google Cloud production et démonstration, retour arrière, état ; VPS
#      installation, secrets, déploiement ; statique Vercel et Firebase) — sorties dans infra/.validation/ ;
#   4. YAML / JSON : chargement strict (python3 yaml.safe_load / json) de tous les fichiers, y compris les descriptions
#      Cloud Run rendues par la simulation ;
#   5. docker compose config (si Docker est installé).
#   6. fond de carte OpenStreetMap de Kinshasa : l'étape de l'image ne fait jamais échouer la construction (étape
#      sautée, échec simulé → avertissement, code 0), le Dockerfile copie le fond, l'attribution ODbL est présente.
#   ./infra/valider.sh
# =====================================================================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
RACINE="$(pwd)"
SORTIES="$RACINE/infra/.validation"
rm -rf "$SORTIES"
mkdir -p "$SORTIES"
ECHECS=0
ok() { printf '  [OK] %s\n' "$*"; }
ko() { printf '  [ÉCHEC] %s\n' "$*"; ECHECS=$((ECHECS + 1)); }
absent() { printf '  [NON EXÉCUTÉ] %s\n' "$*"; }

mapfile -t SCRIPTS < <(find infra tools/maps -name '*.sh' -not -path '*/.rendu/*' -not -path '*/.validation/*' | sort)

echo "1. Syntaxe et analyse statique des scripts (${#SCRIPTS[@]})"
for s in "${SCRIPTS[@]}"; do
  if [[ "$(head -n 1 "$s")" == "#!/bin/sh" ]]; then sh -n "$s" && ok "sh -n $s" || ko "sh -n $s"; else bash -n "$s" && ok "bash -n $s" || ko "bash -n $s"; fi
done
if command -v shellcheck >/dev/null; then
  shellcheck -x "${SCRIPTS[@]}" && ok "shellcheck ($(shellcheck --version | sed -n 's/^version: //p'))" || ko "shellcheck"
else
  absent "shellcheck (non installé)"
fi

echo "2. Dockerfile"
if command -v hadolint >/dev/null; then
  hadolint --failure-threshold warning Dockerfile && ok "hadolint Dockerfile" || ko "hadolint Dockerfile"
else
  absent "hadolint (non installé)"
fi

echo "3. Simulations DRY_RUN=1 (sorties : infra/.validation/)"
simuler() { # <fichier de sortie> <commande…>
  local sortie="$SORTIES/$1" script="" a; shift
  for a in "$@"; do [[ "$a" == *.sh ]] && script="$a"; done
  if env DRY_RUN=1 "$@" > "$sortie" 2>&1; then ok "${script} → $(basename "$sortie") ($(grep -c '^    + ' "$sortie") commande(s))"; else ko "$* (voir $sortie)"; tail -n 5 "$sortie"; fi
}
simuler gcp-production.txt env PROJECT_ID=projet-exemple REGION=africa-south1 DOMAIN=mosolo.exemple.cd IMAGE_TAG=exemple infra/gcp/deploy.sh
cp infra/gcp/.rendu/service.yaml infra/gcp/.rendu/job-migration.yaml infra/gcp/.rendu/job-sauvegarde.yaml "$SORTIES/" 2>/dev/null || true
simuler gcp-demonstration.txt env PROJECT_ID=projet-exemple DEMO=true IMAGE_TAG=exemple infra/gcp/deploy.sh
cp infra/gcp/.rendu/service-demo.yaml "$SORTIES/" 2>/dev/null || true
simuler gcp-rollback.txt env PROJECT_ID=projet-exemple infra/gcp/rollback.sh
simuler gcp-status.txt env PROJECT_ID=projet-exemple infra/gcp/status.sh
simuler gcp-restauration.txt env PROJECT_ID=projet-exemple FICHIER=mosolo-20261001T011500Z.json OPERATEUR=exploitant.a infra/gcp/restaurer.sh
simuler vps-install.txt infra/vps/install.sh
simuler vps-secrets.txt infra/vps/deploy.sh secrets
simuler vps-deploy.txt env SKIP_PULL=1 infra/vps/deploy.sh
simuler vps-rollback.txt infra/vps/deploy.sh rollback exemple-precedent
simuler static-vercel.txt env BACKEND_URL=https://mosolo-000000000000.africa-south1.run.app infra/static/preparer.sh vercel
simuler static-firebase.txt infra/static/preparer.sh firebase
# Aucune valeur secrète dans les sorties : ni clé PEM, ni mot de passe en clair.
if grep -lE 'BEGIN PRIVATE KEY|--password=[^*]' "$SORTIES"/*.txt; then ko "une sortie de simulation contient une valeur secrète"; else ok "aucune valeur secrète dans les sorties de simulation"; fi

echo "4. YAML et JSON"
mapfile -t YAMLS < <(find infra .github render.yaml \( -name '*.yml' -o -name '*.yaml' \) -not -path '*/.validation/*' | sort)
python3 - "${YAMLS[@]}" "$SORTIES"/*.yaml <<'EOF' && ok "YAML : chargement strict" || ko "YAML"
import sys, yaml
for f in sys.argv[1:]:
    with open(f, encoding="utf-8") as h:
        docs = list(yaml.safe_load_all(h))
    assert docs and docs[0] is not None, f + " : vide"
    print("    yaml.safe_load", f)
EOF
python3 - infra/static/vercel.json infra/static/firebase.json <<'EOF' && ok "JSON : chargement strict" || ko "JSON"
import json, sys
for f in sys.argv[1:]:
    with open(f, encoding="utf-8") as h:
        json.load(h)
    print("    json.load", f)
EOF
python3 - "$SORTIES/service.yaml" "$SORTIES/service-demo.yaml" <<'EOF' && ok "Cloud Run : production min = max = 1, CPU toujours alloué, sondes /health, jamais --demo ; démonstration --demo" || ko "descriptions Cloud Run"
import sys, yaml
prod = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
t = prod["spec"]["template"]; a = t["metadata"]["annotations"]; c = t["spec"]["containers"][0]
assert a["autoscaling.knative.dev/minScale"] == "1" and a["autoscaling.knative.dev/maxScale"] == "1"
assert a["run.googleapis.com/cpu-throttling"] == "false"
assert c["args"] == ["production"] and "--demo" not in str(c)
assert c["startupProbe"]["httpGet"]["path"] == "/health" and c["livenessProbe"]["httpGet"]["path"] == "/health"
mem = c["resources"]["limits"]["memory"]; assert mem.endswith("Gi") and float(mem[:-2]) >= 1
env = {e["name"]: e for e in c["env"]}
assert env["NODE_ENV"]["value"] == "production" and "MOSOLO_DEMO_MODE" not in env
for s in ["DATABASE_URL", "MOSOLO_RECEIPT_SIGNING_KEY", "MOSOLO_CLOSURE_SIGNING_KEY", "MOSOLO_JWT_PRIVATE_KEY", "MOSOLO_AUDIT_HMAC_KEY", "MOSOLO_BACKUP_KEY"]:
    assert "secretKeyRef" in env[s]["valueFrom"], s
demo = yaml.safe_load(open(sys.argv[2], encoding="utf-8"))
dc = demo["spec"]["template"]["spec"]["containers"][0]
assert dc["args"] == ["demo"] and demo["metadata"]["name"] != prod["metadata"]["name"]
# Troisième passe (D3-06) : par défaut, la démonstration exige un mot de passe d'accès tiré de Secret Manager.
denv = {e["name"]: e for e in dc["env"]}
assert "secretKeyRef" in denv["MOSOLO_DEMO_ACCESS_PASSWORD"]["valueFrom"], "MOSOLO_DEMO_ACCESS_PASSWORD"
EOF

echo "5. Docker Compose"
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  # Copie jetable avec .env = .env.example (le vrai .env n'est jamais lu ici).
  cp -R infra/vps "$SORTIES/vps-copie"
  sed -e 's/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=valeur-de-validation/' infra/vps/.env.example > "$SORTIES/vps-copie/.env"
  docker compose --project-directory "$SORTIES/vps-copie" -f "$SORTIES/vps-copie/docker-compose.yml" --profile outils config -q 2>"$SORTIES/compose.txt" \
    && ok "docker compose config (profil outils compris, avec .env.example)" || { ko "docker compose config"; cat "$SORTIES/compose.txt"; }
  rm -rf "$SORTIES/vps-copie"
else
  absent "docker compose (non installé)"
fi

echo "6. Fond de carte OpenStreetMap de Kinshasa (sans réseau)"
# Étape sautée volontairement : code 0, aucun fichier.
T6="$SORTIES/tuiles-sautees"
if MOSOLO_FOND_DE_CARTE=0 bash tools/maps/fond-de-carte-image.sh "$T6" > "$SORTIES/fond-de-carte-saute.txt" 2>&1 && [ -z "$(ls -A "$T6")" ]; then
  ok "étape « fond-de-carte » sautée (MOSOLO_FOND_DE_CARTE=0) : code 0, image sans fond"
else ko "étape « fond-de-carte » sautée (voir $SORTIES/fond-de-carte-saute.txt)"; fi
# Échec simulé (architecture inconnue, aucun téléchargement) : AVERTISSEMENT et code 0 — la construction continue.
T6="$SORTIES/tuiles-echec"
if TARGETARCH=inconnue bash tools/maps/fond-de-carte-image.sh "$T6" > "$SORTIES/fond-de-carte-echec.txt" 2>&1 \
  && grep -q "AVERTISSEMENT — fond de carte" "$SORTIES/fond-de-carte-echec.txt" && [ -z "$(ls -A "$T6")" ]; then
  ok "échec du fond de carte : avertissement clair, code 0 (la construction de l'image n'échoue pas)"
else ko "échec du fond de carte (voir $SORTIES/fond-de-carte-echec.txt)"; fi
grep -q '^COPY --from=fond-de-carte /tuiles/ frontend/dist/tiles/' Dockerfile && grep -q '^FROM node:22-bookworm-slim AS fond-de-carte' Dockerfile \
  && ok "Dockerfile : étape « fond-de-carte » et copie vers frontend/dist/tiles" || ko "Dockerfile : étape « fond-de-carte » absente"
grep -q "OSM_ATTRIBUTION = '© contributeurs OpenStreetMap'" frontend/src/components/GeoMap.tsx && grep -q 'attribution.*openstreetmap' tools/maps/construire-tuiles-kinshasa.sh \
  && ok "attribution ODbL « © contributeurs OpenStreetMap » affichée et contrôlée à la fabrication" || ko "attribution OpenStreetMap"

echo
if ((ECHECS)); then echo "Validation : ${ECHECS} échec(s)."; exit 1; fi
echo "Validation : tout est conforme (aucun déploiement effectué)."
