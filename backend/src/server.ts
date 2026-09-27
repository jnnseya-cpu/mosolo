/**
 * Point d'entrée : `npm run dev -w backend` (port PORT ou 8080). Le script de développement passe `--demo`, qui active
 * explicitement le mode démonstration (x-demo-user, CORS ouvert, secrets publics) ; sans lui, le serveur démarre en
 * mode sûr, exige les secrets réels (voir README) et démarre SANS aucune donnée de démonstration.
 */
import { enableDemoFromArgv } from './core/demo-flag.js';
enableDemoFromArgv();
const { buildApp } = await import('./app.js');
const { assertBootSecrets, assertMemoryEntryAllowed } = await import('./persistence/boot.js');
// Production : ce point d'entrée (mémoire seule) est refusé ; voir src/persistence/server.ts.
assertMemoryEntryAllowed();
// Hors démonstration : clés de signature stables exigées (quittances, clôtures) — sinon refus de démarrer.
assertBootSecrets();

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const host = process.env.HOST ?? '0.0.0.0';
const app = buildApp({ logger: true });
const { assertKeyHealthAtBoot } = await import('./plugins/integrite/gouvernance/cles.js');
// Hors démonstration : santé des clés contrôlée au démarrage — refus sur avertissement critique (clé absente, éphémère,
// de démonstration, réutilisée pour deux usages…) ; les autres avertissements (âge) sont journalisés et alertés.
try {
  assertKeyHealthAtBoot(app.ctx);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

app.listen({ port, host }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
