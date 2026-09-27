/**
 * Module d'extension « verticales » : catalogue serveur des verticales, espaces de l'usager branchés sur le socle,
 * démarches en ligne, plaques NFIU, marchés sans espèces, événements, construction, télécom, AVIA et CALCU.
 */
import { definePlugin } from '../types.js';
import { CalcuControlService } from './calcu-controle.js';
import { AUTO_RUN_DEFAULT_MS, FichesService } from './fiches.js';
import { registerFichesRoutes } from './fiches-routes.js';
import { PlastiqueService } from './plastique.js';
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
    // Fiches sectorielles 13 à 25 : registres, départs, péage, boissons, liquidations automatiques sur règle ACTIVE.
    svc.fiches = new FichesService(ctx, svc);
    svc.plastique = new PlastiqueService(ctx, svc.fiches);
    svc.fiches.plastique = svc.plastique;
    // Passage planifié des liquidations automatiques (idempotentes, règle ACTIVE seulement) : toutes les heures par
    // défaut (paramètre technique à confirmer), MOSOLO_FICHES_LIQUIDATION_MS pour l'ajuster (1 minute au moins), 0 pour l'arrêter.
    const raw = process.env.MOSOLO_FICHES_LIQUIDATION_MS;
    const every = raw === undefined || raw === '' ? AUTO_RUN_DEFAULT_MS : Number.parseInt(raw, 10);
    if (Number.isFinite(every) && every >= 60_000) svc.fiches.startScheduler(every);
    return svc;
  },
  seed: (ctx, svc) => seedVerticales(ctx, svc),
  routes: (app, ctx, svc) => {
    registerVerticalRoutes(app, ctx, svc);
    registerCalcuControlRoutes(app, svc.calcu.controle!);
    registerFichesRoutes(app, svc);
  },
});

export { VerticalesService };
