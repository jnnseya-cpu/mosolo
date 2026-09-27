# Démonstration de KINSHASA MOSOLO en un seul conteneur (API + application web), données de démonstration non contractuelles.
# docker build -t mosolo-demo . && docker run -p 8080:8080 mosolo-demo  →  http://localhost:8080
# Même commande de démarrage, même Node (22, voir .nvmrc) et même construction que render.yaml (source unique :
# `npm ci` puis `npm run build -w frontend`). Production : ne PAS utiliser --demo ; voir docs/production-readiness.md.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --no-audit --no-fund
COPY . .
RUN VITE_API_URL= npm run build -w frontend
ENV MOSOLO_DEMO_MODE=true MOSOLO_STATIC_DIR=frontend/dist PORT=8080
# Processus sans privilèges (utilisateur « node » de l'image officielle) : lecture seule du code, rien n'est écrit
# dans /app en démonstration (stockage en mémoire).
USER node
EXPOSE 8080
# Sonde de vie identique à celle de Render (healthCheckPath: /health).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "node_modules/.bin/tsx", "backend/src/server.ts", "--demo"]
