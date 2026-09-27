# KINSHASA MOSOLO en un seul conteneur (API + application web).
# Démonstration (défaut historique, inchangé) — données de démonstration non contractuelles :
#   docker build -t mosolo-demo . && docker run -p 8080:8080 mosolo-demo  →  http://localhost:8080
# Production (jamais --demo ; PostgreSQL et secrets obligatoires, voir infra/ et docs/production-readiness.md) :
#   docker run -p 8080:8080 --env-file .env mosolo production
# Autres modes (infra/docker/entrypoint.sh) : migrate, backup-once, backup-cron, verify, restore, bootstrap-check.
# Même Node (22, voir .nvmrc) et même construction que render.yaml (source unique : `npm ci` puis
# `npm run build -w frontend`). Kits de déploiement : infra/gcp (Cloud Run), infra/vps (Docker Compose), infra/static.

# ---------------------------------------------------------------------------------------------------------------------
# Étape 1 — construction de l'application web (Vite a besoin d'environ 700 Mo de tas : 3 Go par défaut)
# ---------------------------------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS construction
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --no-audit --no-fund
COPY . .
ARG MOSOLO_BUILD_HEAP_MB=3072
RUN NODE_OPTIONS="--max-old-space-size=${MOSOLO_BUILD_HEAP_MB}" VITE_API_URL='' npm run build -w frontend

# ---------------------------------------------------------------------------------------------------------------------
# Étape 2 — exécution : dépendances de production seulement, utilisateur non privilégié
# ---------------------------------------------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS execution
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
# Dépendances d'exécution du backend et du paquet partagé (tsx est une dépendance d'exécution du backend).
RUN npm ci --omit=dev --no-audit --no-fund --workspace=backend --workspace=shared \
  && npm cache clean --force
COPY shared/tsconfig.json shared/
COPY shared/src shared/src
COPY backend/tsconfig.json backend/
COPY backend/src backend/src
COPY backend/db backend/db
COPY --from=construction /app/frontend/dist frontend/dist
COPY infra/docker/entrypoint.sh /usr/local/bin/mosolo-entrypoint
# Dossiers inscriptibles hors du code : ancre d'audit, copie WORM, publication (volume) et sauvegardes (volume).
RUN chmod 0755 /usr/local/bin/mosolo-entrypoint \
  && mkdir -p /var/lib/mosolo /sauvegardes \
  && chown node:node /var/lib/mosolo /sauvegardes
ENV MOSOLO_STATIC_DIR=frontend/dist PORT=8080
# Processus sans privilèges (utilisateur « node » de l'image officielle) : lecture seule du code ; en démonstration,
# rien n'est écrit dans /app (stockage en mémoire).
USER node
EXPOSE 8080
# Sonde de vie identique à celle de Render (healthCheckPath: /health) et de Cloud Run (sondes de démarrage et de vie).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# Mode : premier argument (« production », « migrate »…), sinon MOSOLO_MODE, sinon « demo » (défaut historique).
ENTRYPOINT ["/usr/local/bin/mosolo-entrypoint"]
