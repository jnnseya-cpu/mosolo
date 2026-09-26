/**
 * Module d'extension « verticales » : catalogue serveur des verticales, espaces de l'usager branchés sur le socle,
 * démarches en ligne, plaques NFIU, marchés sans espèces, événements, construction, télécom, AVIA et CALCU.
 */
import { definePlugin } from '../types.js';
import { registerVerticalPolicies } from './policies.js';
import { registerVerticalRoutes } from './routes.js';
import { seedVerticales } from './seed.js';
import { VerticalesService } from './service.js';

export const verticalesPlugin = definePlugin<VerticalesService>({
  name: 'verticales',
  create: (ctx) => {
    registerVerticalPolicies();
    return new VerticalesService(ctx);
  },
  seed: (ctx, svc) => seedVerticales(ctx, svc),
  routes: (app, ctx, svc) => registerVerticalRoutes(app, ctx, svc),
});

export { VerticalesService };
