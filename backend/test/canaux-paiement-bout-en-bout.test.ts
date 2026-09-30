/**
 * Canaux de paiement de bout en bout (30/09/2026, demande du maître d'ouvrage : « tous ces canaux doivent fonctionner ») :
 * référence → paiement → confirmation (rappel signé de l'opérateur, ou relevé bancaire validé par deux personnes) →
 * quittance provisoire → rapprochement → quittance définitive. Les passerelles BitriPay et KODA et le versement des
 * points agréés sont couverts de bout en bout par paiement-aller-retour, connectors et canaux-releve.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { DEMO } from '../src/seed.js';
import { PROVIDER_SECRET, postStatement, type TestEnv } from './helpers.js';

let saved: string | undefined;
beforeEach(() => { saved = process.env.MOSOLO_DEMO_MODE; process.env.MOSOLO_DEMO_MODE = '1'; });
afterEach(() => { if (saved === undefined) delete process.env.MOSOLO_DEMO_MODE; else process.env.MOSOLO_DEMO_MODE = saved; });

async function setup(secret = 'demo-secret-mm-operator-a', complet = false) {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, ...(complet ? {} : { plugins: [] }), secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': secret, 'bank-a': 'demo-secret-bank-a', 'card-gateway': 'demo-secret-card-gateway' }, commsProviderKeys: {} } });
  await app.ready();
  const env: TestEnv = {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
  return env;
}
const obligation = (env: TestEnv) => env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId).find((o) => ['EMISE', 'EXIGIBLE', 'EN_RETARD'].includes(o.status))!.id;
const reference = async (env: TestEnv, channel: string) => {
  const r = await env.req('POST', `/v1/obligations/${obligation(env)}/payment-orders`, 'u-contribuable', { channel }, { 'idempotency-key': randomUUID() });
  expect(r.statusCode, JSON.stringify(r.json())).toBe(201);
  return r.json() as { paymentReference: string; amount: { amount: string; currency: string }; status: string; beneficiaryAlias: string; ussdInstructions?: string };
};
const receiptOf = (env: TestEnv, ref: string) => {
  const o = env.app.ctx.payments.byReference(ref)!;
  return { order: o, receipt: env.app.ctx.receipts.byPaymentOrder(o.id) };
};

describe('Canaux de paiement du contribuable, de bout en bout', () => {
  for (const channel of ['MOBILE_MONEY', 'QR', 'USSD']) {
    it(`${channel} (opérateur direct) : référence → rappel signé de l'opérateur → quittance provisoire → relevé → définitive`, async () => {
      const env = await setup();
      const o = await reference(env, channel);
      expect(o.status).toBe('INITIE');
      if (channel === 'USSD') expect(o.ussdInstructions ?? '').toMatch(/référence/);
      const c = await env.req('POST', '/v1/providers/mm-operator-a/demo-operator-confirmation', 'u-tresor', { paymentReference: o.paymentReference });
      expect(c.statusCode, JSON.stringify(c.json())).toBe(200);
      let r = receiptOf(env, o.paymentReference);
      expect(r.order.status).toBe('CONFIRME');
      expect(r.receipt?.status).toBe('PROVISOIRE');
      const s = await postStatement(env, 'u-analyste-rappro', { statementId: `REL-${channel}`, lines: [{ accountAlias: o.beneficiaryAlias, amount: o.amount, valueDate: '2026-09-26', paymentReference: o.paymentReference }] });
      expect(s.statusCode, JSON.stringify(s.json())).toBe(201);
      r = receiptOf(env, o.paymentReference);
      expect(r.order.status).toBe('RAPPROCHE');
      expect(r.receipt?.status).toBe('DEFINITIVE');
    });
  }

  for (const [channel, provider] of [['BANK', 'bank-a'], ['CARD', 'card-gateway']] as const) {
    it(`${channel} : référence → notification SIGNÉE de ${provider} → quittance provisoire → relevé validé par deux personnes → définitive`, async () => {
      const env = await setup();
      const o = await reference(env, channel);
      // Sans notification signée, un crédit au relevé reste une exception « crédit sans confirmation » (contrôle anti-fraude).
      const c = await env.req('POST', `/v1/providers/${provider}/demo-operator-confirmation`, 'u-tresor', { paymentReference: o.paymentReference });
      expect(c.statusCode, JSON.stringify(c.json())).toBe(200);
      expect(receiptOf(env, o.paymentReference).receipt?.status).toBe('PROVISOIRE');
      const s = await postStatement(env, 'u-analyste-rappro', { statementId: `REL-${channel}`, lines: [{ accountAlias: o.beneficiaryAlias, amount: o.amount, valueDate: '2026-09-26', paymentReference: o.paymentReference }] });
      expect(s.statusCode, JSON.stringify(s.json())).toBe(201);
      const r = receiptOf(env, o.paymentReference);
      expect(r.order.status).toBe('RAPPROCHE');
      expect(r.receipt?.status).toBe('DEFINITIVE');
    });
  }

  it('crédit au relevé SANS notification signée : exception, jamais de quittance (contrôle conservé)', async () => {
    const env = await setup();
    const o = await reference(env, 'BANK');
    await postStatement(env, 'u-analyste-rappro', { statementId: 'REL-SANS', lines: [{ accountAlias: o.beneficiaryAlias, amount: o.amount, valueDate: '2026-09-26', paymentReference: o.paymentReference }] });
    expect(receiptOf(env, o.paymentReference).receipt).toBeFalsy();
    expect(env.app.ctx.treasury.rawExceptions().some((e) => e.type === 'CREDIT_WITHOUT_CONFIRMATION')).toBe(true);
  });

  it('Point de paiement agréé : la référence est émise pour le canal AGENT_POINT (encaissement au point, jamais par un agent)', async () => {
    const env = await setup();
    const o = await reference(env, 'AGENT_POINT');
    expect(o.status).toBe('INITIE');
  });

  it('passerelles par canal : BitriPay pour la carte, KODA pour l’USSD (tous les opérateurs congolais) ; combinaison non proposée refusée', async () => {
    const env = await setup('demo-secret-mm-operator-a', true);
    const obls = env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)
      .filter((o) => ['EMISE', 'EXIGIBLE', 'EN_RETARD'].includes(o.status) && env.app.ctx.payments.paidOn(o.id).isZero() && !env.app.ctx.payments.byObligation(o.id).some((p) => p.status === 'INITIE'))
      .map((o) => o.id);
    const pay = (i: number, channel: string, provider: string) => env.req('POST', `/v1/obligations/${obls[i]}/payment-orders`, 'u-contribuable', { channel, provider }, { 'idempotency-key': randomUUID() });
    const carte = await pay(0, 'CARD', 'bitripay');
    expect(carte.statusCode, JSON.stringify(carte.json())).toBe(201);
    expect(carte.json()).toMatchObject({ provider: 'bitripay' });
    const ussd = await pay(1, 'USSD', 'koda');
    expect(ussd.statusCode, JSON.stringify(ussd.json())).toBe(201);
    expect(ussd.json()).toMatchObject({ provider: 'koda' });
    expect((await pay(2, 'USSD', 'bitripay')).json().code).toBe('PROVIDER_CHANNEL_UNSUPPORTED');
    expect((await pay(2, 'BANK', 'koda')).json().code).toBe('PROVIDER_CHANNEL_UNSUPPORTED');
    // KODA : les quatre opérateurs congolais par défaut.
    expect((env.app.ctx.connectors.get('koda') as unknown as { operators: readonly string[] }).operators).toEqual(['orange_cd', 'mpesa_cd', 'airtel_cd', 'africell_cd']);
  });

  it('simulation de l’opérateur : refusée hors démonstration, avec un vrai secret, ou pour un rôle non habilité', async () => {
    const env = await setup();
    const o = await reference(env, 'MOBILE_MONEY');
    expect((await env.req('POST', '/v1/providers/mm-operator-a/demo-operator-confirmation', 'u-contribuable', { paymentReference: o.paymentReference })).statusCode).toBe(403);
    const real = await setup(PROVIDER_SECRET.replace(/^/, 'reel-'));
    const o2 = await reference(real, 'MOBILE_MONEY');
    expect((await real.req('POST', '/v1/providers/mm-operator-a/demo-operator-confirmation', 'u-tresor', { paymentReference: o2.paymentReference })).json().code).toBe('SIMULATION_FORBIDDEN');
    delete process.env.MOSOLO_DEMO_MODE;
    expect((await env.req('POST', '/v1/providers/mm-operator-a/demo-operator-confirmation', 'u-tresor', { paymentReference: o.paymentReference })).statusCode).not.toBe(200);
  });
  it('page de paiement SIMULÉE BitriPay / KODA (démonstration) : MOSOLO → page → paiement → webhook signé sur la route réelle → retour → quittance provisoire', async () => {
    const env = await setup('demo-secret-mm-operator-a', true);
    const obls = env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)
      .filter((o) => ['EMISE', 'EXIGIBLE', 'EN_RETARD'].includes(o.status) && env.app.ctx.payments.paidOn(o.id).isZero() && !env.app.ctx.payments.byObligation(o.id).some((p) => p.status === 'INITIE'))
      .map((o) => o.id);
    for (const [i, channel, provider, operateur] of [[0, 'MOBILE_MONEY', 'bitripay', 'mpesa_cd'], [1, 'USSD', 'koda', 'africell_cd']] as const) {
      const c = await env.req('POST', `/v1/obligations/${obls[i]}/payment-orders`, 'u-contribuable', { channel, provider }, { 'idempotency-key': randomUUID() });
      expect(c.statusCode, JSON.stringify(c.json())).toBe(201);
      const o = c.json() as { paymentReference: string; checkoutUrl: string; sandbox: boolean };
      expect(o.sandbox).toBe(true);
      expect(o.checkoutUrl).toBe(`/demo/passerelle/${provider}?ref=${encodeURIComponent(o.paymentReference)}`);
      const page = await env.req('GET', `/v1/demo/passerelle/${provider}?ref=${encodeURIComponent(o.paymentReference)}`, 'u-contribuable');
      expect(page.statusCode, JSON.stringify(page.json())).toBe(200);
      expect(page.json().operateurs).toContain(operateur);
      // Un autre usager ne voit ni ne paie la référence d'autrui.
      expect((await env.req('GET', `/v1/demo/passerelle/${provider}?ref=${encodeURIComponent(o.paymentReference)}`, 'u-locataire')).statusCode).toBe(403);
      expect((await env.req('POST', `/v1/demo/passerelle/${provider}/payer`, 'u-locataire', { paymentReference: o.paymentReference, operateur })).statusCode).toBe(403);
      const p = await env.req('POST', `/v1/demo/passerelle/${provider}/payer`, 'u-contribuable', { paymentReference: o.paymentReference, operateur });
      expect(p.statusCode, JSON.stringify(p.json())).toBe(200);
      expect(p.json().retour).toBe(`/paiement/retour?ref=${encodeURIComponent(o.paymentReference)}`);
      const r = receiptOf(env, o.paymentReference);
      expect(r.order.status).toBe('CONFIRME');
      expect(r.receipt?.status).toBe('PROVISOIRE');
      const st = await env.req('GET', `/v1/payment-orders/${encodeURIComponent(o.paymentReference)}/status`, 'u-contribuable');
      expect(st.json()).toMatchObject({ state: 'CONFIRME' });
    }
    // Hors mode démonstration : page refusée.
    delete process.env.MOSOLO_DEMO_MODE;
    expect((await env.req('GET', '/v1/demo/passerelle/koda?ref=X-1', 'u-contribuable')).statusCode).not.toBe(200);
  });
});
