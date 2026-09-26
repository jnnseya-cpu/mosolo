/**
 * Module d'extension « recouvrement » : avis légaux numérotés, arriérés (balance âgée, segmentation, prescription),
 * parcours gradué rappel → avis → mise en demeure → mesure proposée → décision humaine motivée, échéanciers,
 * reprise d'arriérés historiques, pénalités et remises sur règle ACTIVE (ch. 21, § 6.3, § 6.7).
 * S'appuie sur le socle : registre des règles, obligations, paiements (circuit commun), réclamations, communications.
 */
import { Money } from '@mosolo/shared';
import { conflict, notFound, unprocessable } from '../../core/errors.js';
import { definePlugin } from '../types.js';
import { registerRecoveryRoutes } from './routes.js';
import { RecoveryService } from './service.js';

export const recouvrementPlugin = definePlugin({
  name: 'recouvrement',
  create: (ctx) => {
    const svc = new RecoveryService(ctx);
    // Paiement par échéance : montant de la prochaine échéance non couverte d'un échéancier ACCORDÉ (jamais saisi).
    ctx.payments.setInstallmentResolver((obligationId, planId) => {
      const plan = svc.plans.get(planId);
      if (!plan || plan.obligationId !== obligationId) throw notFound('INSTALLMENT_PLAN_NOT_FOUND', `Échéancier inconnu pour cette obligation : ${planId}`);
      if (plan.status !== 'ACCORDE') throw unprocessable('INSTALLMENT_PLAN_NOT_ACTIVE', `Échéancier au statut ${plan.status} : paiement par échéance impossible.`);
      const paid = ctx.payments.paidOn(obligationId);
      let cumul = Money.zero(paid.currency);
      for (const i of plan.installments) {
        cumul = cumul.add(Money.fromJSON(i.amount));
        if (cumul.compare(paid) > 0) return cumul.subtract(paid).toJSON();
      }
      throw conflict('INSTALLMENT_PLAN_SETTLED', 'Toutes les échéances sont déjà couvertes.');
    });
    return svc;
  },
  seed: (_ctx, svc) => svc.seedDemo(),
  routes: (app, ctx, svc) => registerRecoveryRoutes(app, ctx, svc),
});

export { RecoveryService } from './service.js';
