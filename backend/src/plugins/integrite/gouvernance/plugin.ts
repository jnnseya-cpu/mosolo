/**
 * Module d'extension « Intégrité — risques résiduels » (après `integrite`) : collusion sous quatre yeux et rotation
 * obligatoire (alertes ; blocage facultatif, désactivé par défaut), registre des seuils anti-fraude avec confirmation
 * à deux personnes, santé des clés de signature et HMAC. Aucune modification des modules surveillés.
 */
import { definePlugin } from '../../types.js';
import { declareGouvernancePolicies } from './policy.js';
import { registerGouvernanceRoutes } from './routes.js';
import { GouvernanceService } from './service.js';

export const integriteGouvernancePlugin = definePlugin<GouvernanceService>({
  name: 'integrite-gouvernance',
  create: (ctx) => {
    declareGouvernancePolicies();
    return new GouvernanceService(ctx);
  },
  routes: (app, _ctx, svc) => registerGouvernanceRoutes(app, svc),
});

export { GouvernanceService } from './service.js';
