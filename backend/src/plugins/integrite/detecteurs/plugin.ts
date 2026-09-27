/**
 * Module d'extension « Intégrité — détecteurs complémentaires » (§ 25) : écart constats / paiements par zone, baisse
 * inexpliquée des recettes d'une zone, proximité récurrente agent–objet, rotation des zones dépassée, et exécution
 * planifiée du contrôle des ruptures de la chaîne opératoire. Alertes seulement ; aucun module surveillé n'est modifié.
 */
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../../../core/auth.js';
import { definePolicy, GRANTS } from '../../../core/policy.js';
import { definePlugin } from '../../types.js';
import { DetecteursService, detecteursSchedulerEnabled } from './service.js';

const { always } = GRANTS;
definePolicy('integrite:detecteurs.read', { R22: always, R23: always, R24: always, R28: always, R06: always });
definePolicy('integrite:detecteurs.run', { R22: always, R24: always, R28: always });

export const integriteDetecteursPlugin = definePlugin<DetecteursService>({
  name: 'integrite-detecteurs',
  create: (ctx) => {
    const svc = new DetecteursService(ctx);
    if (detecteursSchedulerEnabled(process.env)) {
      const tick = Number.parseInt(process.env.MOSOLO_DETECTEURS_TICK_MS ?? '', 10);
      svc.startScheduler(Number.isFinite(tick) && tick >= 1000 ? tick : 300_000);
    }
    return svc;
  },
  routes: (app: FastifyInstance, _ctx, svc) => {
    app.get('/v1/integrite/detecteurs', async (req) => svc.overview(requireUser(req)));
    app.post('/v1/integrite/detecteurs/executions', async (req) => svc.run(requireUser(req)));
    app.addHook('onClose', async () => svc.stopScheduler());
  },
});

export { DetecteursService } from './service.js';
