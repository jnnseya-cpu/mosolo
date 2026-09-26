import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { callbackBody, createOrder, DEMO, demoObligationId, payDemoObligation, setup, signedCallback } from './helpers.js';

describe('Ordres de paiement', () => {
  it('AC-PAY-01 : même clé + même contenu → même réponse ; contenu différent → 409', async () => {
    const env = await setup();
    const key = randomUUID();
    const a = await createOrder(env, key);
    const b = await createOrder(env, key);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.json()).toEqual(a.json());
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(env.app.ctx.payments.orders.count()).toBe(1);
    const c = await createOrder(env, key, { channel: 'CARD' });
    expect(c.statusCode).toBe(409);
    expect(c.json().code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(env.app.ctx.payments.orders.count()).toBe(1);
  });

  it('clé d’idempotence obligatoire ; bénéficiaire jamais fourni par le client', async () => {
    const env = await setup();
    const url = `/v1/obligations/${demoObligationId(env)}/payment-orders`;
    const noKey = await env.req('POST', url, 'u-contribuable', { channel: 'MOBILE_MONEY' });
    expect(noKey.json().code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const injected = await env.req('POST', url, 'u-contribuable', { channel: 'MOBILE_MONEY', beneficiaryAlias: 'COMPTE-PIRATE' }, { 'idempotency-key': randomUUID() });
    expect(injected.statusCode).toBe(400);
    const ok = (await createOrder(env)).json();
    expect(ok.beneficiaryAlias).toBe(DEMO.dgipkAlias);
    expect(ok.paymentReference).toMatch(/^PR-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(ok.ussdInstructions).toContain(ok.paymentReference.replace(/-/g, ''));
    // Une seconde référence active pour la même obligation est refusée.
    const dup = await createOrder(env);
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ code: 'ACTIVE_PAYMENT_REFERENCE_EXISTS', paymentReference: ok.paymentReference });
  });

  it('un autre contribuable ne peut pas payer (ni voir) l’obligation d’autrui', async () => {
    const env = await setup();
    const res = await env.req('POST', `/v1/obligations/${demoObligationId(env)}/payment-orders`, 'u-locataire', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() });
    expect(res.statusCode).toBe(403);
    expect((await env.req('GET', `/v1/obligations/${demoObligationId(env)}`, 'u-locataire')).statusCode).toBe(403);
    // Le mandataire habilité peut initier.
    const m = await env.req('POST', `/v1/obligations/${demoObligationId(env)}/payment-orders`, 'u-mandataire', { channel: 'BANK' }, { 'idempotency-key': randomUUID() });
    expect(m.statusCode).toBe(201);
  });

  it('AC-CUR-01 : obligation USD → contre-valeur indicative CDF avec taux et source, reportée sur la quittance', async () => {
    const env = await setup();
    const order = (await createOrder(env)).json();
    expect(order.amount).toEqual({ amount: '150.00', currency: 'USD' });
    expect(order.indicativeAmount).toMatchObject({
      amount: { amount: '427500.00', currency: 'CDF' }, rate: '2850', rateDate: '2026-09-26', source: 'BCC (démo)', indicative: true,
    });
    const cb = await signedCallback(env, { ...callbackBody(env, order.paymentReference), payerAmount: { amount: '139.50', currency: 'EUR' } });
    expect(cb.statusCode).toBe(200);
    const receipt = env.app.ctx.receipts.byPaymentOrder(order.paymentOrderId)!;
    expect(receipt.amount).toEqual({ amount: '150.00', currency: 'USD' });
    expect(receipt.payerAmount).toEqual({ amount: '139.50', currency: 'EUR' });
    expect(receipt.indicativeAmount).toMatchObject({ amount: { currency: 'CDF', amount: '427500.00' }, rate: '2850', source: 'BCC (démo)' });
    // Devise d'affichage au choix (taux croisé exact).
    const env2 = await setup();
    const eur = (await createOrder(env2, randomUUID(), { channel: 'CARD', displayCurrency: 'EUR' })).json();
    expect(eur.indicativeAmount.amount).toEqual({ amount: '137.90', currency: 'EUR' });
  });
});

describe('Rappels prestataires', () => {
  it('AC-PAY-04 : confirmation vérifiée → CONFIRME + quittance provisoire ; définitive au rapprochement', async () => {
    const env = await setup();
    const { order, callback, status } = await payDemoObligation(env);
    expect(status).toBe(200);
    expect(callback).toMatchObject({ status: 'CONFIRME', receiptStatus: 'PROVISOIRE' });
    const pending = await env.req('GET', `/v1/public/receipts/${callback.receiptCode}`);
    expect(pending.json()).toMatchObject({ status: 'PENDING', settlementStatus: 'PENDING_SETTLEMENT' });

    const st = await env.req('POST', '/v1/settlements/statements', 'u-tresor', {
      statementId: 'REL-2026-09-26-A',
      lines: [{ accountAlias: DEMO.dgipkAlias, amount: { amount: '150.00', currency: 'USD' }, valueDate: '2026-09-26', paymentReference: order.paymentReference }],
    });
    expect(st.statusCode).toBe(201);
    expect(st.json().matched).toHaveLength(1);
    expect(st.json().exceptions).toHaveLength(0);
    expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('RAPPROCHE');
    expect(env.app.ctx.assessment.get(order.obligationId).status).toBe('SOLDEE');
    const valid = await env.req('GET', `/v1/public/receipts/${callback.receiptCode}`);
    expect(valid.json()).toMatchObject({ status: 'VALID', settlementStatus: 'RECONCILED' });
    // Relevé rejoué à l'identique : idempotent, aucun double effet.
    const replay = await env.req('POST', '/v1/settlements/statements', 'u-tresor', {
      statementId: 'REL-2026-09-26-A',
      lines: [{ accountAlias: DEMO.dgipkAlias, amount: { amount: '150.00', currency: 'USD' }, valueDate: '2026-09-26', paymentReference: order.paymentReference }],
    });
    expect(replay.statusCode).toBe(200);
    expect(env.app.ctx.ledger.balance().balanced).toBe(true);
  });

  it('AC-PAY-02 : signature invalide rejetée + alerte', async () => {
    const env = await setup();
    const order = (await createOrder(env)).json();
    const res = await signedCallback(env, callbackBody(env, order.paymentReference), { secret: 'mauvais-secret' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_SIGNATURE');
    expect(env.app.ctx.alerts.list().some((a) => a.type === 'INVALID_SIGNATURE')).toBe(true);
    expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('INITIE');
    expect(env.app.ctx.receipts.receipts.count()).toBe(0);
  });

  it('AC-PAY-02 : nonce rejoué rejeté + alerte ; horodatage hors fenêtre rejeté', async () => {
    const env = await setup();
    const order = (await createOrder(env)).json();
    const nonce = randomUUID();
    const first = await signedCallback(env, callbackBody(env, order.paymentReference), { nonce });
    expect(first.statusCode).toBe(200);
    const replay = await signedCallback(env, callbackBody(env, order.paymentReference), { nonce });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().code).toBe('NONCE_REPLAYED');
    expect(env.app.ctx.alerts.list().some((a) => a.type === 'NONCE_REPLAYED')).toBe(true);
    const stale = await signedCallback(env, callbackBody(env, order.paymentReference), { timestamp: new Date(env.clock.now().getTime() - 6 * 60_000).toISOString() });
    expect(stale.json().code).toBe('TIMESTAMP_OUT_OF_WINDOW');
    expect(env.app.ctx.receipts.receipts.count()).toBe(1);
  });

  it('rejeu du même providerTxnId (nouveau nonce) → 200 sans double effet', async () => {
    const env = await setup();
    const order = (await createOrder(env)).json();
    const body = callbackBody(env, order.paymentReference);
    const a = await signedCallback(env, body);
    const entries = env.app.ctx.ledger.list().length;
    const b = await signedCallback(env, body);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ status: 'CONFIRME', receiptNumber: a.json().receiptNumber, replayed: true });
    expect(env.app.ctx.receipts.receipts.count()).toBe(1);
    expect(env.app.ctx.ledger.list().length).toBe(entries);
  });

  it('montant ou référence incohérents → rejet + alerte, aucune quittance ; second paiement → DOUBLON', async () => {
    const env = await setup();
    const order = (await createOrder(env)).json();
    const bad = await signedCallback(env, callbackBody(env, order.paymentReference, { amount: '15.00', currency: 'USD' }));
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe('AMOUNT_MISMATCH');
    const unknown = await signedCallback(env, callbackBody(env, 'PR-XXXX-XXXX'));
    expect(unknown.json().code).toBe('UNKNOWN_PAYMENT_REFERENCE');
    expect(env.app.ctx.receipts.receipts.count()).toBe(0);
    await signedCallback(env, callbackBody(env, order.paymentReference));
    const second = await signedCallback(env, callbackBody(env, order.paymentReference));
    expect(second.json().status).toBe('DOUBLON');
    expect(env.app.ctx.receipts.receipts.count()).toBe(1);
  });

  it('AC-RCP-01 : la vérification publique ne renvoie que des données minimales', async () => {
    const env = await setup();
    const { callback } = await payDemoObligation(env);
    const res = await env.req('GET', `/v1/public/receipts/${callback.receiptCode}`);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(
      ['amount', 'beneficiaryAdministration', 'message', 'paidOn', 'revenueCategory', 'settlementStatus', 'status', 'taxpayerRefSuffix', 'verifiedAt'].sort(),
    );
    const iuc = env.app.ctx.taxpayers.get(DEMO.taxpayerId).iuc;
    expect(body.taxpayerRefSuffix).toBe('…' + iuc.replace(/-/g, '').slice(-4));
    expect(body.taxpayerRefSuffix).toMatch(/^…[0-9A-Z]{4}$/);
    const text = JSON.stringify(body);
    expect(text).not.toContain('Mbuyi');
    expect(text).not.toContain(iuc);
    expect(text).not.toContain('+243');
    expect((await env.req('GET', '/v1/public/receipts/Q26KIN0000000000')).json()).toMatchObject({ status: 'UNKNOWN' });
  });

  it('quittance altérée → FRAUDE SUSPECTÉE + alerte', async () => {
    const env = await setup();
    const { callback } = await payDemoObligation(env);
    const r = env.app.ctx.receipts.receipts.findOne((x) => x.code === callback.receiptCode)!;
    env.app.ctx.receipts.receipts.update({ ...r, amount: { amount: '1.00', currency: 'USD' } });
    const res = await env.req('GET', `/v1/public/receipts/${callback.receiptCode}`);
    expect(res.json().status).toBe('FRAUD_SUSPECTED');
    expect(res.json().amount).toBeUndefined();
    expect(env.app.ctx.alerts.list()[0]!.type).toBe('RECEIPT_SIGNATURE_INVALID');
  });
});
