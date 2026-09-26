/**
 * Module d'extension « recouvrement » : avis légaux numérotés, arriérés (balance âgée, segmentation, prescription),
 * parcours gradué rappel → avis → mise en demeure → mesure proposée → décision humaine motivée, échéanciers,
 * reprise d'arriérés historiques, pénalités et remises sur règle ACTIVE (ch. 21, § 6.3, § 6.7).
 * S'appuie sur le socle : registre des règles, obligations, paiements (circuit commun), réclamations, communications.
 */
import { definePlugin } from '../types.js';
import { registerRecoveryRoutes } from './routes.js';
import { RecoveryService } from './service.js';

export const recouvrementPlugin = definePlugin({
  name: 'recouvrement',
  create: (ctx) => new RecoveryService(ctx),
  seed: (_ctx, svc) => svc.seedDemo(),
  routes: (app, ctx, svc) => registerRecoveryRoutes(app, ctx, svc),
});

export { RecoveryService } from './service.js';
