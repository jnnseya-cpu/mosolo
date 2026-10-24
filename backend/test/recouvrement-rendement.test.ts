import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { CIRCUITS } from '../src/plugins/integrite/gouvernance/circuits.js';
import { recouvrementPlugin, type RecoveryService } from '../src/plugins/recouvrement/plugin.js';
import { callbackBody, DEMO, PROVIDER_SECRET, signedCallback, type TestEnv } from './helpers.js';

const HASH = 'c'.repeat(64);

async function setup(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} }, plugins: [recouvrementPlugin] });
  await app.ready();
  return {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
}
const svcOf = (env: TestEnv) => env.app.ctx.ext.recouvrement as RecoveryService;
const tenantObligation = (env: TestEnv) => env.app.ctx.assessment.byTaxpayer(DEMO.tenantTaxpayerId)[0]!;

describe('Rendement du recouvrement (§ 21.1, § 21.2)', () => {
  it('récupération brute mesurée ; nette NON_MESURE sans coût, puis calculée après saisie des coûts avec pièce', async () => {
    const env = await setup();
    const ob = tenantObligation(env);
    const caseId = svcOf(env).caseFor(ob.id)!.id;
    const ind0 = (await env.req('GET', '/v1/recouvrement/indicateurs', 'u-contentieux')).json();
    expect(ind0.recoveryCost.status).toBe('NON_MESURE');

    // Paiement de l'arriéré par la contribuable : récupération brute.
    const order = (await env.req('POST', `/v1/obligations/${ob.id}/payment-orders`, 'u-locataire', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).json();
    expect(order.paymentReference).toBeTruthy();
    await signedCallback(env, callbackBody(env, order.paymentReference, order.amount));
    const y0 = (await env.req('GET', `/v1/recouvrement/dossiers/${caseId}/rendement`, 'u-decideur')).json();
    expect(y0.gross).toEqual({ [order.amount.currency]: order.amount.amount });
    expect(y0.net).toBe('NON_MESURE');

    // Saisie d'un coût : habilitations, pièce obligatoire.
    expect((await env.req('POST', '/v1/recouvrement/couts', 'u-locataire', { caseId, kind: 'SMS', quantity: 3, amount: { amount: '0.30', currency: order.amount.currency }, evidenceSha256: HASH, note: 'Facture SMS (test)' })).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/recouvrement/couts', 'u-contentieux', { caseId, kind: 'SMS', quantity: 3, amount: { amount: '0.30', currency: order.amount.currency }, note: 'Sans pièce' })).statusCode).toBe(400);
    const c = await env.req('POST', '/v1/recouvrement/couts', 'u-contentieux', { caseId, kind: 'VISITE', quantity: 1, amount: { amount: '10.00', currency: order.amount.currency }, evidenceSha256: HASH, note: 'Note de frais de la visite (test)' });
    expect(c.statusCode).toBe(201);
    const y1 = (await env.req('GET', `/v1/recouvrement/dossiers/${caseId}/rendement`, 'u-decideur')).json();
    const expected = (Number(order.amount.amount) - 10).toFixed(2);
    expect(y1.net).toEqual({ [order.amount.currency]: expected });
    const ind1 = (await env.req('GET', '/v1/recouvrement/indicateurs', 'u-contentieux')).json();
    expect(ind1.recoveryCost).toMatchObject({ status: 'MESURE', costedCases: 1 });
  });

  it('priorisation par rendement net estimé : observé ou NON_MESURE, jamais une décision', async () => {
    const env = await setup();
    const p = (await env.req('GET', '/v1/recouvrement/priorites', 'u-contentieux')).json();
    expect(p.automaticDecision).toBe(false);
    expect(p.items.length).toBeGreaterThan(0);
    expect(p.items[0]).toMatchObject({ rank: 1, observedRecoveryRate: expect.any(String) });
    expect((await env.req('GET', '/v1/recouvrement/priorites', 'u-locataire')).statusCode).toBe(403);
  });

  it('campagne mesurée par identifiant : coût ≥ récupération ⇒ arrêt à examiner (jamais automatique)', async () => {
    const env = await setup();
    const ob = tenantObligation(env);
    await env.req('POST', '/v1/recouvrement/couts', 'u-contentieux', { campaignId: 'CAMP-TEST-1', kind: 'SMS', quantity: 500, amount: { amount: '50.00', currency: ob.amount.currency }, evidenceSha256: HASH, note: 'Campagne SMS (test)' });
    const y = svcOf(env).rendement!.campaignYield('CAMP-TEST-1', { obligationIds: [ob.id], since: '2026-09-01T00:00:00.000Z' });
    expect(y).toMatchObject({ campaignId: 'CAMP-TEST-1', costMeasured: true, stopRecommended: true, automaticStop: false });
    const r = (await env.req('GET', `/v1/recouvrement/campagnes/CAMP-TEST-1/rendement?obligationIds=${ob.id}&since=2026-09-01`, 'u-decideur')).json();
    expect(r.stopSignals[0].code).toBe('COUT_DISPROPORTIONNE');
  });

  it('garanties d’un grand débiteur : proposées par R20, décidées par R21 distinct ; refusées hors segment', async () => {
    const env = await setup();
    const ob = tenantObligation(env);
    const caseId = svcOf(env).caseFor(ob.id)!.id;
    const body = { caseId, nature: 'CAUTION_BANCAIRE', amount: { amount: '6000.00', currency: 'USD' }, description: 'Caution bancaire à première demande (test)', evidenceSha256: HASH };
    expect((await env.req('POST', '/v1/recouvrement/garanties', 'u-contentieux', body)).json().code).toBe('NOT_LARGE_DEBTOR');
    env.app.ctx.assessment.obligations.update({ ...ob, amount: { amount: '6000.00', currency: 'USD' } });
    const g = await env.req('POST', '/v1/recouvrement/garanties', 'u-contentieux', body);
    expect(g.statusCode).toBe(201);
    expect((await env.req('POST', `/v1/recouvrement/garanties/${g.json().id}/decision`, 'u-contentieux', { decision: 'VALIDEE', motivation: 'Auto-validation (refusée).' })).statusCode).toBe(403);
    const d = await env.req('POST', `/v1/recouvrement/garanties/${g.json().id}/decision`, 'u-decideur', { decision: 'VALIDEE', motivation: 'Caution vérifiée auprès de la banque (test).' });
    expect(d.json().status).toBe('VALIDEE');
    const board = (await env.req('GET', '/v1/recouvrement/rendement', 'u-decideur')).json();
    expect(board.largeDebtors[0]).toMatchObject({ caseId, guarantees: 1, covered: { USD: '6000.00' } });
    expect((await env.req('POST', `/v1/recouvrement/garanties/${g.json().id}/mainlevee`, 'u-decideur', { motivation: 'Créance soldée, mainlevée (test).' })).json().status).toBe('LEVEE');
    expect(CIRCUITS.find((c) => c.code === 'RECOUVREMENT_GARANTIE')).toBeTruthy();
  });
});
