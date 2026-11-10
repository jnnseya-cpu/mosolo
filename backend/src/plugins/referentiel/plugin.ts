/**
 * Module d'extension « référentiel des recettes » (Cahier ch. 7, § 6.2, § 6.3) : lignes de recettes, inventaire de
 * référence, recettes administratives, registre des codes stables et base de référence (§ 38.1).
 */
import { definePlugin } from '../types.js';
import { registerReferentielRoutes } from './routes.js';
import { ReferentielService, registerReferentielPolicies } from './service.js';

export const referentielPlugin = definePlugin<ReferentielService>({
  name: 'referentiel',
  create: (ctx) => {
    registerReferentielPolicies();
    return new ReferentielService(ctx);
  },
  routes: (app, _ctx, svc) => registerReferentielRoutes(app, svc),
});

export { ReferentielService };
