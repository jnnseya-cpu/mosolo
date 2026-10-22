/**
 * Module « ia » : couche d'intelligence complète (« AI Operating System », § 23.5) — agents métier, niveaux
 * d'autonomie A/B/C, mémoire à quatre niveaux, journal IA. Aucune dépendance d'ordre : il ne lit que le socle.
 * Balayage proactif périodique facultatif : variable MOSOLO_IA_SWEEP_MS (millisecondes).
 */
import { definePlugin } from '../types.js';
import { registerIaPolicies } from './policy.js';
import { registerIaRoutes } from './routes.js';
import { IaService } from './service.js';

export const iaPlugin = definePlugin<IaService>({
  name: 'ia',
  create: (ctx) => {
    registerIaPolicies();
    const svc = new IaService(ctx);
    const every = Number.parseInt(process.env.MOSOLO_IA_SWEEP_MS ?? '', 10);
    if (Number.isFinite(every) && every >= 60_000) svc.startScheduler(every);
    return svc;
  },
  seed: (_ctx, svc) => svc.seedDemo(),
  routes: (app, ctx, svc) => registerIaRoutes(app, ctx, svc),
});
