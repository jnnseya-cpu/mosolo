/**
 * Module « tresor » : cycle complet de la quittance (annulation, remplacement, contrepassation, remboursement,
 * duplicata) et Trésor avancé (files d'exception, suspens, double validation, clôtures signées, imputation, export).
 * Dépend du socle seulement (reçus, trésorerie, grand livre, paiements, coffre).
 */
import { definePolicy, GRANTS } from '../../core/policy.js';
import { definePlugin } from '../types.js';
import { MatchingService } from './appariement.js';
import { PointContractsService } from './points-contrats.js';
import { registerTresorComplementRoutes } from './routes-complements.js';
import { registerTresorRoutes } from './routes.js';
import { TresorService } from './service.js';

const { always, ownTaxpayer, mandant } = GRANTS;

definePolicy('tresor:overview', { R17: always, R18: always, R22: always, R23: always, R05: always });
definePolicy('tresor:exception.read', { R17: always, R18: always, R22: always });
definePolicy('tresor:exception.assign', { R17: always, R18: always });
definePolicy('tresor:exception.work', { R17: always, R18: always });
definePolicy('tresor:exception.approve', { R17: always });
// Quittances : proposition par le Trésor, l'analyste, le contentieux (litige fondé) ou le guichet ; validation par le Trésor.
definePolicy('tresor:receipt.propose', { R17: always, R18: always, R20: always, R12: always });
definePolicy('tresor:finance.propose', { R17: always, R18: always });
definePolicy('tresor:operation.approve', { R17: always });
definePolicy('tresor:operation.read', { R17: always, R18: always, R20: always, R12: always, R22: always, R23: always });
definePolicy('tresor:suspense.read', { R17: always, R18: always, R22: always, R23: always });
definePolicy('tresor:closure.read', { R17: always, R18: always, R22: always, R23: always, R05: always });
definePolicy('tresor:closure.write', { R17: always });
definePolicy('tresor:receivables.read', { R17: always, R18: always, R22: always, R23: always, R05: always });
definePolicy('tresor:nomenclature.read', { R17: always, R18: always, R22: always, R23: always });
definePolicy('tresor:imputation.run', { R17: always });
definePolicy('tresor:export', { R17: always, R22: always, R23: always });
definePolicy('tresor:receipt.read', { R30: ownTaxpayer, R31: mandant, R12: always, R17: always, R18: always, R20: always, R22: always });
definePolicy('tresor:receipt.duplicate', { R30: ownTaxpayer, R31: mandant, R12: always, R17: always });
definePolicy('tresor:verification.journal', { R17: always, R22: always, R24: always, R28: always });

export const tresorPlugin = definePlugin<TresorService>({
  name: 'tresor',
  create: (ctx) => {
    const svc = new TresorService(ctx);
    // Rapprochement proposé et crédits groupés (§ 20.1) ; clauses des points de paiement agréés (§ 37).
    svc.matching = new MatchingService(ctx);
    svc.pointContracts = new PointContractsService(ctx);
    return svc;
  },
  seed: (_ctx, svc) => svc.seedDemo(),
  routes: (app, ctx, svc) => {
    registerTresorRoutes(app, ctx, svc);
    registerTresorComplementRoutes(app, ctx, svc);
  },
});
