/**
 * Point d'entrée avec persistance : `npm run start:persistent -w backend` (DATABASE_URL obligatoire pour persister ;
 * sans elle, comportement identique à src/server.ts, plus le module « socle »). `--demo` : mode démonstration explicite.
 */
import { enableDemoFromArgv } from '../core/demo-flag.js';
enableDemoFromArgv();
const { buildApp } = await import('../app.js');
import { DEFAULT_PLUGINS } from '../plugins/index.js';
import { soclePlugin } from '../plugins/socle/plugin.js';
import { preparePersistence } from './boot.js';

const port = Number.parseInt(process.env.PORT ?? '8080', 10);
const host = process.env.HOST ?? '0.0.0.0';

const runtime = await preparePersistence();
// Le plugin « socle » (qui attache la persistance) est ajouté s'il ne figure pas déjà dans DEFAULT_PLUGINS.
const plugins = DEFAULT_PLUGINS.some((p) => p.name === 'socle') ? DEFAULT_PLUGINS : [...DEFAULT_PLUGINS, soclePlugin];
// Exemples complémentaires de démonstration (modules sectoriels) : semés seulement si les données de démonstration le sont.
const app = buildApp({ logger: true, plugins, demoExamples: true });
const { assertKeyHealthAtBoot } = await import('../plugins/integrite/gouvernance/cles.js');
// Hors démonstration : santé des clés contrôlée au démarrage — refus sur avertissement critique (clé absente, éphémère,
// de démonstration, réutilisée pour deux usages…) ; les autres avertissements (âge) sont journalisés et alertés.
try {
  assertKeyHealthAtBoot(app.ctx);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  await runtime?.close();
  process.exit(1);
}
if (runtime && !runtime.attached) {
  app.log.warn('Persistance préparée mais non attachée.');
}

// Gardes du processus : rejet non géré journalisé et alerté (le processus continue) ; exception non capturée → arrêt
// propre (les écritures persistantes en attente sont vidées avant la sortie).
const { installProcessGuards } = await import('../core/process-guards.js');
installProcessGuards(process, {
  ctx: app.ctx, log: (m) => app.log.error(m), exit: (c) => process.exit(c),
  shutdown: async () => { await app.close(); await runtime?.close(); },
});

app.listen({ port, host }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(async () => {
      await runtime?.close();
      process.exit(0);
    });
  });
}
