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
import { AUTO_RUN_DEFAULT_MS, FichesService } from './fiches.js';
import { registerFichesRoutes } from './fiches-routes.js';
import { PlastiqueService } from './plastique.js';
import { registerCalcuControlRoutes } from './calcu-routes.js';
import { EntreprisesService, registerEntreprisesPolicies } from './entreprises.js';
import { EnvironnementService, registerEnvironnementPolicies } from './environnement.js';
import { registerPartie5Routes } from './partie5-routes.js';
import { NfiuService, nfiuReportSchedulerEnabled, registerNfiuPolicies } from './nfiu.js';
import { registerNfiuRoutes } from './nfiu-routes.js';
import { registerVerticalPolicies } from './policies.js';
import { registerVerticalRoutes } from './routes.js';
import { seedActifs, seedVerticales } from './seed.js';
import { VerticalesService } from './service.js';
import { contribuerCompteUnique } from './compte-unique.js';

export const verticalesPlugin = definePlugin<VerticalesService>({
  name: 'verticales',
  create: (ctx) => {
    registerVerticalPolicies();
    registerActifsPolicies();
    registerEnvironnementPolicies();
    registerEntreprisesPolicies();
    registerNfiuPolicies();
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
    svc.actifs = new ActifsService(ctx, svc);
    svc.environnement = new EnvironnementService(ctx, svc);
    svc.entreprises = new EntreprisesService(ctx, svc);
    // AVIA (modules 62, 78) : facturation ou compensation automatique des écarts mensuels APRÈS l'arrêté (décision du
    // maître d'ouvrage) ; avant l'arrêté, proposition seulement. Planificateur mensuel (vérification horaire).
    svc.aviaAuto = new AviaAutoService(ctx, svc.avia, svc.aviaRrh, svc.aviaCadre);
    if (aviaAutoSchedulerEnabled(process.env)) svc.aviaAuto.startScheduler();
    // Module 79 : habilitation NFIU, situation complète pour l'agent habilité, rapports journaliers automatiques.
    svc.nfiu = new NfiuService(ctx, svc);
    if (nfiuReportSchedulerEnabled(process.env)) svc.nfiu.startScheduler();
    // Module 16 (parcours Telecom) : avis annuel automatique sur règle ACTIVE (même garde de planificateur).
    if (aviaAutoSchedulerEnabled(process.env)) svc.secteurs.startAntennesScheduler();
    // Compte unique (ch. 9) : démarches, certificats, étals, déclarations sectorielles et AVIA.
    contribuerCompteUnique(ctx, svc);
    return svc;
  },
  seed: (ctx, svc) => {
    seedVerticales(ctx, svc);
    seedActifs(ctx, svc);
  },
  routes: (app, ctx, svc) => {
    registerVerticalRoutes(app, ctx, svc);
    registerCalcuControlRoutes(app, svc.calcu.controle!);
    registerFichesRoutes(app, svc);
    registerPartie5Routes(app, { actifs: svc.actifs!, environnement: svc.environnement!, entreprises: svc.entreprises! });
    registerAviaAutoRoutes(app, svc.aviaAuto!);
    registerNfiuRoutes(app, svc);
    app.addHook('onClose', async () => { svc.aviaAuto?.stopScheduler(); svc.nfiu?.stopScheduler(); svc.secteurs.stopAntennesScheduler(); });
  },
});

export { VerticalesService };
