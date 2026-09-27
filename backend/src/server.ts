/**
 * Point d'entrée : `npm run dev -w backend` (port PORT ou 8080). Le script de développement passe `--demo`, qui active
 * explicitement le mode démonstration (x-demo-user, CORS ouvert, secrets publics) ; sans lui, le serveur démarre en
 * mode sûr, exige les secrets réels (voir README) et démarre SANS aucune donnée de démonstration.
 */
import { enableDemoFromArgv } from './core/demo-flag.js';
enableDemoFromArgv();
const { buildApp } = await import('./app.js');
const { assertBootSecrets } = await import('./persistence/boot.js');
// Hors démonstration : clés de signature stables exigées (quittances, clôtures) — sinon refus de démarrer.
assertBootSecrets();

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const host = process.env.HOST ?? '0.0.0.0';
const app = buildApp({ logger: true });

app.listen({ port, host }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
