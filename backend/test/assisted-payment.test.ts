import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { callbackBody, PROVIDER_SECRET, signedCallback, type TestEnv } from './helpers.js';

async function env(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-27T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} } });
  await app.ready();
  const req: TestEnv['req'] = (method, url, user, body, headers = {}) => app.inject({
    method: method as 'GET', url,
    headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { app, clock, req };
}
const idem = () => ({ 'idempotency-key': randomUUID() });
const AGENT = 'u-agent-terrain';

/** Un bien de Limete avec une obligation payable, et la position de l'agent posté devant. */
async function payableObject(e: TestEnv) {
  const near = (await e.req('GET', '/v1/fiscal/nearby?lat=-4.3712&lon=15.3441&accuracyM=8&radiusM=1000', AGENT)).json();
  for (const it of near.items as { id: string; lat: number; lon: number }[]) {
    const p = (await e.req('GET', `/v1/agents/assist/payables?objectId=${it.id}`, AGENT)).json();
    if (p.items?.length) return { obj: it, payables: p };
  }
  throw new Error('aucun bien payable dans la démonstration');
}

describe('Paiement numérique assisté par l’agent — jamais d’espèces', () => {
  it('l’agent sur place émet la référence au nom du titulaire ; l’usager paie depuis son téléphone ; quittance', async () => {
    const e = await env();
    const { obj, payables } = await payableObject(e);
    expect(payables.channels).toEqual(['MOBILE_MONEY', 'USSD', 'QR', 'CARD']);
    expect(payables.cash).toMatch(/jamais à l’agent/);
    const ob = payables.items[0];
    const body = { obligationId: ob.obligationId, lat: obj.lat, lon: obj.lon, accuracyM: 8 };

    // Espèces : refusées pour un agent, renvoi vers un point agréé.
    const cash = await e.req('POST', '/v1/agents/assist/payment-orders', AGENT, { ...body, channel: 'AGENT_POINT' }, idem());
    expect(cash.statusCode).toBe(422);
    expect(cash.json().code).toBe('CASH_NOT_ALLOWED_FOR_AGENT');
    expect(cash.json().detail).toMatch(/point de paiement agréé/);
    // Loin du bien : refusé ; position imprécise : refusée.
    expect((await e.req('POST', '/v1/agents/assist/payment-orders', AGENT, { ...body, channel: 'MOBILE_MONEY', lat: obj.lat - 0.02 }, idem())).json().code).toBe('NOT_ON_SITE');
    expect((await e.req('POST', '/v1/agents/assist/payment-orders', AGENT, { ...body, channel: 'MOBILE_MONEY', accuracyM: 250 }, idem())).json().code).toBe('GPS_TOO_IMPRECISE');

    const r = await e.req('POST', '/v1/agents/assist/payment-orders', AGENT, { ...body, channel: 'MOBILE_MONEY' }, idem());
    expect(r.statusCode).toBe(201);
    const { order, record, guidance } = r.json();
    expect(order).toMatchObject({ obligationId: ob.obligationId, status: 'INITIE', channel: 'MOBILE_MONEY', amount: ob.amount });
    expect(record).toMatchObject({ agentId: AGENT, reused: false });
    expect(guidance.join(' ')).toMatch(/SON téléphone/);
    // L'ordre appartient au titulaire, pas à l'agent (aucun compte de l'agent).
    const stored = e.app.ctx.payments.byReference(order.paymentReference)!;
    expect(stored.createdBy).not.toBe(AGENT);
    expect(stored.beneficiaryAlias).toBe(order.beneficiaryAlias);
    // Une seconde demande ré-affiche la même référence (jamais deux références actives).
    const again = (await e.req('POST', '/v1/agents/assist/payment-orders', AGENT, { ...body, channel: 'USSD' }, idem())).json();
    expect(again.order.paymentReference).toBe(order.paymentReference);
    expect(again.record.reused).toBe(true);

    expect((await e.req('GET', `/v1/agents/assist/payment-orders/${order.paymentReference}`, AGENT)).json()).toMatchObject({ paid: false, status: 'INITIE' });
    // L'usager paie depuis son téléphone : confirmation signée du prestataire → payée.
    expect((await signedCallback(e, callbackBody(e, order.paymentReference, order.amount))).statusCode).toBe(200);
    expect((await e.req('GET', `/v1/agents/assist/payment-orders/${order.paymentReference}`, AGENT)).json()).toMatchObject({ paid: true, status: 'CONFIRME' });
    expect(e.app.ctx.audit.list({ action: 'payment.assisted.reference' }).total).toBe(2);
  });

  it('hors secteur, usager ou agent d’un autre secteur : refusé', async () => {
    const e = await env();
    const { obj, payables } = await payableObject(e);
    const body = { obligationId: payables.items[0].obligationId, channel: 'MOBILE_MONEY', lat: obj.lat, lon: obj.lon, accuracyM: 8 };
    expect((await e.req('POST', '/v1/agents/assist/payment-orders', 'u-agent-gombe', body, idem())).statusCode).toBe(403);
    expect((await e.req('POST', '/v1/agents/assist/payment-orders', 'u-contribuable', body, idem())).statusCode).toBe(403);
    expect((await e.req('GET', `/v1/agents/assist/payables?objectId=${obj.id}`, 'u-agent-gombe')).json().items).toEqual([]);
    expect((await e.req('POST', '/v1/agents/assist/payment-orders', AGENT, body)).statusCode).toBe(400);
  });
});
