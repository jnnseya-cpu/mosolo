/**
 * Module d'extension « Intégrité — risques résiduels » (après `integrite`) : collusion sous quatre yeux et rotation
 * obligatoire (alertes ; blocage facultatif, désactivé par défaut), registre des seuils anti-fraude avec confirmation
 * à deux personnes, santé des clés de signature et HMAC (contrôle au démarrage hors démonstration), détection planifiée
 * de la collusion (journalisée, alertes seulement). Aucune modification des modules surveillés.
 */
import { definePlugin } from '../../types.js';
import { declareGouvernancePolicies } from './policy.js';
import { registerGouvernanceRoutes } from './routes.js';
import { GouvernanceService } from './service.js';

export const integriteGouvernancePlugin = definePlugin<GouvernanceService>({
  name: 'integrite-gouvernance',
  create: (ctx) => {
    declareGouvernancePolicies();
    const svc = new GouvernanceService(ctx);
    if (collusionSchedulerEnabled(process.env)) {
      const tick = Number.parseInt(process.env.MOSOLO_COLLUSION_TICK_MS ?? '', 10);
      svc.startScheduler(Number.isFinite(tick) && tick >= 1000 ? tick : 300_000);
    }
    return svc;
  },
  routes: (app, _ctx, svc) => {
    registerGouvernanceRoutes(app, svc);
    app.addHook('onClose', async () => svc.stopScheduler());
  },
});

/**
 * Détection planifiée de la collusion : active par défaut (intervalle du registre, 24 h par défaut), désactivée sous
 * les tests (VITEST) ; MOSOLO_COLLUSION_SCHEDULER=off la désactive, =on la force.
 */
export function collusionSchedulerEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = (env.MOSOLO_COLLUSION_SCHEDULER ?? '').trim().toLowerCase();
  if (flag === 'off') return false;
  if (flag === 'on') return true;
  return !env.VITEST;
}

export { GouvernanceService } from './service.js';
