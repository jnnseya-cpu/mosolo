/**
 * Module d'extension « verticales » : catalogue serveur des verticales, espaces de l'usager branchés sur le socle,
 * démarches en ligne, plaques NFIU, marchés sans espèces, événements, construction, télécom, AVIA et CALCU.
 * Partie V (parcours de bout en bout) : patrimoine provincial, environnement (registre, simulation), entreprises
 * (détermination des obligations).
 */
import { definePlugin } from '../types.js';
import { ActifsService, registerActifsPolicies } from './actifs.js';
import { AviaAutoService } from './avia-auto.js';
import { aviaAutoSchedulerEnabled, registerAviaAutoRoutes } from './avia-auto-routes.js';
import { CalcuControlService } from './calcu-controle.js';
import { registerCalcuControlRoutes } from './calcu-routes.js';
import { EntreprisesService, registerEntreprisesPolicies } from './entreprises.js';
import { EnvironnementService, registerEnvironnementPolicies } from './environnement.js';
import { registerPartie5Routes } from './partie5-routes.js';
import { registerVerticalPolicies } from './policies.js';
import { registerVerticalRoutes } from './routes.js';
import { seedActifs, seedVerticales } from './seed.js';
import { VerticalesService } from './service.js';

export const verticalesPlugin = definePlugin<VerticalesService>({
  name: 'verticales',
  create: (ctx) => {
    registerVerticalPolicies();
    registerActifsPolicies();
    registerEnvironnementPolicies();
    registerEntreprisesPolicies();
    const svc = new VerticalesService(ctx);
    // CALCU — compléments du § 27A (registre des fournisseurs, conformité budgétaire, organe de contrôle).
    svc.calcu.controle = new CalcuControlService(ctx, svc.calcu);
    svc.actifs = new ActifsService(ctx, svc);
    svc.environnement = new EnvironnementService(ctx, svc);
    svc.entreprises = new EntreprisesService(ctx, svc);
    // AVIA (modules 62, 78) : facturation ou compensation automatique des écarts mensuels APRÈS l'arrêté (décision du
    // maître d'ouvrage) ; avant l'arrêté, proposition seulement. Planificateur mensuel (vérification horaire).
    svc.aviaAuto = new AviaAutoService(ctx, svc.avia, svc.aviaRrh, svc.aviaCadre);
    if (aviaAutoSchedulerEnabled(process.env)) svc.aviaAuto.startScheduler();
    return svc;
  },
  seed: (ctx, svc) => {
    seedVerticales(ctx, svc);
    seedActifs(ctx, svc);
  },
  routes: (app, ctx, svc) => {
    registerVerticalRoutes(app, ctx, svc);
    registerCalcuControlRoutes(app, svc.calcu.controle!);
    registerPartie5Routes(app, { actifs: svc.actifs!, environnement: svc.environnement!, entreprises: svc.entreprises! });
    registerAviaAutoRoutes(app, svc.aviaAuto!);
    app.addHook('onClose', async () => svc.aviaAuto?.stopScheduler());
  },
});

export { VerticalesService };
