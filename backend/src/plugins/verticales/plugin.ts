/**
 * Module d'extension « verticales » : catalogue serveur des verticales, espaces de l'usager branchés sur le socle,
 * démarches en ligne, plaques NFIU, marchés sans espèces, événements, construction, télécom, AVIA et CALCU.
 */
import { definePlugin } from '../types.js';
import { CalcuControlService } from './calcu-controle.js';
import { registerCalcuControlRoutes } from './calcu-routes.js';
import { registerVerticalPolicies } from './policies.js';
import { registerVerticalRoutes } from './routes.js';
import { seedVerticales } from './seed.js';
import { VerticalesService } from './service.js';

export const verticalesPlugin = definePlugin<VerticalesService>({
  name: 'verticales',
  create: (ctx) => {
    registerVerticalPolicies();
    const svc = new VerticalesService(ctx);
    // CALCU — compléments du § 27A (registre des fournisseurs, conformité budgétaire, organe de contrôle).
    svc.calcu.controle = new CalcuControlService(ctx, svc.calcu);
    return svc;
  },
  seed: (ctx, svc) => seedVerticales(ctx, svc),
  routes: (app, ctx, svc) => {
    registerVerticalRoutes(app, ctx, svc);
    registerCalcuControlRoutes(app, svc.calcu.controle!);
  },
});

export { VerticalesService };
