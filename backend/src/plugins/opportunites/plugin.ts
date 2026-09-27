/**
 * Module d'extension « opportunités » (Cahier v2.9, chapitre 8) : registre des gisements et grille d'évaluation,
 * pipeline du moteur de découverte (l'agent IA « Découverte des recettes » fournit des signaux, des personnes
 * instruisent et l'autorité décide), moteur de recoupement sous protocole, douze leviers, moteur de maximisation.
 * Aucune opportunité ne devient une taxe par simple décision algorithmique ; aucun encaissement.
 */
import { definePlugin } from '../types.js';
import { declareOpportunitesPolicies } from './policy.js';
import { registerOpportunitesRoutes } from './routes.js';
import { OpportunitesService } from './service.js';

export const opportunitesPlugin = definePlugin<OpportunitesService>({
  name: 'opportunites',
  create: (ctx) => {
    declareOpportunitesPolicies();
    return new OpportunitesService(ctx);
  },
  seed: (_ctx, svc) => svc.seedDemo(),
  routes: (app, ctx, svc) => registerOpportunitesRoutes(app, ctx, svc),
});

export { OpportunitesService } from './service.js';
