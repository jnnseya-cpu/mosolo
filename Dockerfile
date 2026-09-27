# Démonstration de KINSHASA MOSOLO en un seul conteneur (API + application web), données de démonstration non contractuelles.
# docker build -t mosolo-demo . && docker run -p 8080:8080 mosolo-demo  →  http://localhost:8080
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
EXPOSE 8080
CMD ["node", "node_modules/.bin/tsx", "backend/src/server.ts", "--demo"]
