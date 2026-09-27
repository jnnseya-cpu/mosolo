/**
 * Données de DÉMONSTRATION du pilotage, produites par le CIRCUIT RÉEL (aucun chiffre saisi à la main) :
 * contribuables et parcelles FICTIFS → liquidation sur la règle FICTIVE « DEMO-IF-BATI » (publiée par le circuit
 * à quatre visas) → référence de paiement → rappel prestataire signé → quittance provisoire → relevé du compte
 * public importé par le Trésor → rapprochement et quittance définitive. Tout est non opposable.
 */
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../../context.js';
import { signedCallbackHeaders } from '../../modules/payments/callback-signing.js';
import type { PaymentChannel } from '../../modules/payments/service.js';
import { kinshasaDate } from '../../core/clock.js';

const PLAN: { commune: string; quartier: string; rank: 1 | 2 | 3 | 4; count: number; reconcile: number; lat: number; lon: number }[] = [
  { commune: 'Gombe', quartier: 'Batetela', rank: 1, count: 7, reconcile: 6, lat: -4.305, lon: 15.305 },
  { commune: 'Limete', quartier: 'Industriel', rank: 2, count: 6, reconcile: 5, lat: -4.37, lon: 15.345 },
  { commune: 'Ngaliema', quartier: 'Binza Ma Campagne', rank: 1, count: 6, reconcile: 5, lat: -4.36, lon: 15.25 },
  { commune: 'Kalamu', quartier: 'Matonge', rank: 3, count: 4, reconcile: 2, lat: -4.34, lon: 15.315 },
  { commune: 'Masina', quartier: 'Sans Fil', rank: 3, count: 3, reconcile: 1, lat: -4.385, lon: 15.39 },
  { commune: 'Lemba', quartier: 'Salongo', rank: 3, count: 2, reconcile: 1, lat: -4.4, lon: 15.32 },
];
const CHANNELS: PaymentChannel[] = ['MOBILE_MONEY', 'MOBILE_MONEY', 'CARD', 'USSD', 'MOBILE_MONEY', 'AGENT_POINT', 'BANK', 'QR'];

export function runDemoFlow(ctx: AppContext, provider = 'mm-operator-a'): { obligations: number; confirmed: number; reconciled: number } {
  const secret = ctx.secrets.providerSecrets[provider];
  const guichet = ctx.users.get('u-guichet');
  const controleur = ctx.users.get('u-controleur');
  const tresor = ctx.users.get('u-tresor');
  const rule = ctx.rules.rules.find((r) => r.code === 'DEMO-IF-BATI' && r.status === 'ACTIVE')[0];
  if (!secret || !guichet || !controleur || !tresor || !rule) return { obligations: 0, confirmed: 0, reconciled: 0 };

  let n = 0; let confirmed = 0;
  const toReconcile: { alias: string; amount: { amount: string; currency: 'USD' }; ref: string }[] = [];
  PLAN.forEach((p, pi) => {
    for (let i = 0; i < p.count; i++) {
      n++;
      const tp = ctx.taxpayers.register({
        phone: `+2439900${String(pi).padStart(2, '0')}${String(i).padStart(3, '0')}`,
        fullName: `Contribuable fictif ${p.commune} ${i + 1}`, language: 'fr', situation: 'landlord',
      });
      const obj = ctx.objects.create(guichet, {
        taxpayerId: tp.id, category: 'PARCELLE', commune: p.commune, quartier: p.quartier, localityRank: p.rank,
        lat: p.lat + i * 0.001, lon: p.lon + i * 0.001, attributes: { usage: 'residentiel', demo: true },
      });
      const { obligation } = ctx.assessment.calculate(controleur, { ruleId: rule.id, taxpayerId: tp.id, objectId: obj.id, inputs: {}, simulate: false });
      if (!obligation) continue;
      // Le dernier contribuable de chaque commune n'a pas encore payé (référence initiée seulement).
      const channel = CHANNELS[(n - 1) % CHANNELS.length]!;
      const order = ctx.payments.createOrder(guichet, obligation.id, { channel });
      if (i === p.count - 1 && p.count > 2) continue;
      const raw = JSON.stringify({
        providerTxnId: `DEMO-TXN-${randomUUID()}`, paymentReference: order.paymentReference, amount: order.amount, status: 'SUCCESS',
        completedAt: ctx.clock.now().toISOString(),
      });
      const res = ctx.payments.handleCallback(provider, signedCallbackHeaders(secret, raw, ctx.clock.now()), raw);
      if (res.status !== 'CONFIRME') continue;
      confirmed++;
      if (i < p.reconcile) toReconcile.push({ alias: order.beneficiaryAlias, amount: order.amount as { amount: string; currency: 'USD' }, ref: order.paymentReference });
    }
  });
  // Import du relevé en double validation (module 29) : proposé par l'analyste de rapprochement, validé par le Trésor.
  const statementId = `REL-DEMO-PILOTAGE-${kinshasaDate(ctx.clock.now())}`;
  const lines = toReconcile.map((l) => ({ accountAlias: l.alias, amount: l.amount, valueDate: kinshasaDate(ctx.clock.now()), paymentReference: l.ref }));
  const analyst = ctx.users.get('u-analyste-rappro');
  if (!analyst) return { obligations: n, confirmed, reconciled: ctx.treasury.importStatement(tresor, { statementId, lines }).result.matched.length };
  const proposed = ctx.treasury.proposeImport(analyst, { statementId, lines });
  const matched = proposed.replayed ? proposed.result.matched.length
    : ctx.treasury.validateImport(tresor, statementId, { approve: true, motif: 'Relevé de démonstration vérifié (non opposable).' }).result?.matched.length ?? 0;
  return { obligations: n, confirmed, reconciled: matched };
}
