import { describe, expect, it } from 'vitest';
import { callbackBody, createOrder, demoObligationId, setup, signedCallback } from './helpers.js';

describe('Références actives fermées quand l’obligation cesse d’être payable', () => {
  for (const status of ['ADMISE_EN_NON_VALEUR', 'ANNULEE'] as const) {
    it(`${status} : la référence active est fermée et auditée ; un paiement ultérieur part en non-affecté, jamais crédité`, async () => {
      const env = await setup();
      const ctx = env.app.ctx;
      const order = (await createOrder(env)).json();
      const obligationId = demoObligationId(env);
      ctx.assessment.setStatus(obligationId, status);
      expect(ctx.payments.byReference(order.paymentReference)).toMatchObject({ status: 'ECHOUE', closedReason: 'OBLIGATION_NON_PAYABLE' });
      const closed = ctx.audit.list({ action: 'payment.reference.closed', resourceId: order.id }).items;
      expect(closed).toHaveLength(1);
      expect(closed[0]!.details).toMatchObject({ reason: 'OBLIGATION_NON_PAYABLE', cause: `Obligation ${status}`, obligationId });
      // Idempotent : plus rien à fermer.
      expect(ctx.payments.closeOrdersForObligation(obligationId, 'relance')).toEqual([]);

      const ledgerBefore = ctx.ledger.list().length;
      const res = await signedCallback(env, callbackBody(env, order.paymentReference));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'NON_AFFECTE', reason: 'OBLIGATION_NON_PAYABLE' });
      expect(ctx.receipts.receipts.count()).toBe(0);
      expect(ctx.payments.unappliedPayments.all()).toHaveLength(1);
      expect(ctx.payments.paidOn(obligationId).isZero()).toBe(true);
      // Aucune écriture de confirmation (créance du contribuable jamais créditée) : seulement le compte d'attente.
      const posted = ctx.ledger.list().slice(ledgerBefore);
      expect(posted.some((e) => e.eventType === 'PAYMENT_CONFIRMED')).toBe(false);
      expect(ctx.assessment.get(obligationId).status).toBe(status);
    });
  }

  it('réduction à zéro (rectification) : la référence de l’originale est fermée, le paiement tardif n’est pas crédité', async () => {
    const env = await setup();
    const ctx = env.app.ctx;
    const order = (await createOrder(env)).json();
    const obligationId = demoObligationId(env);
    const rectified = ctx.assessment.rectify(obligationId, { amount: '0.00', currency: 'USD' }, { appealId: 'REC-TEST', reason: 'Dégrèvement total', decidedBy: ctx.users.get('u-controleur')! });
    expect(rectified.status).toBe('ANNULEE');
    expect(ctx.payments.byReference(order.paymentReference)!.status).toBe('ECHOUE');
    const res = await signedCallback(env, callbackBody(env, order.paymentReference));
    expect(res.json().status).toBe('NON_AFFECTE');
    expect(ctx.receipts.receipts.count()).toBe(0);
  });

  it('statut encore payable (EN_RETARD) : la référence reste active', async () => {
    const env = await setup();
    const ctx = env.app.ctx;
    const order = (await createOrder(env)).json();
    ctx.assessment.setStatus(demoObligationId(env), 'EN_RETARD');
    expect(ctx.payments.byReference(order.paymentReference)!.status).toBe('INITIE');
    const res = await signedCallback(env, callbackBody(env, order.paymentReference));
    expect(res.json().status).toBe('CONFIRME');
  });
});
