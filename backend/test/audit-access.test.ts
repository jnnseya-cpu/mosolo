import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEMO, demoObligationId, payDemoObligation, setup } from './helpers.js';

describe('Journal d’audit chaîné', () => {
  it('AC-AUD-01 : chaîne intègre, puis altération « en base » détectée par /v1/audit/verify', async () => {
    const env = await setup();
    await payDemoObligation(env);
    const ok = await env.req('GET', '/v1/audit/verify', 'u-auditeur');
    expect(ok.json()).toMatchObject({ ok: true });
    expect(ok.json().length).toBeGreaterThan(10);

    const raw = env.app.ctx.audit.unsafeRawStorageForTamperTests();
    const victim = raw[4]!;
    victim.details = { ...victim.details, falsifie: true };
    const broken = (await env.req('GET', '/v1/audit/verify', 'u-auditeur')).json();
    expect(broken.ok).toBe(false);
    expect(broken.brokenAt).toBe(5);
  });

  it('suppression d’un enregistrement ou troncature détectée ; aucune route de modification', async () => {
    const env = await setup();
    const raw = env.app.ctx.audit.unsafeRawStorageForTamperTests();
    raw.splice(2, 1);
    expect(env.app.ctx.audit.verify()).toMatchObject({ ok: false, brokenAt: 3 });

    const env2 = await setup();
    env2.app.ctx.audit.unsafeRawStorageForTamperTests().pop();
    expect(env2.app.ctx.audit.verify().ok).toBe(false);

    const env3 = await setup();
    const del = await env3.req('DELETE', '/v1/audit/events/AUD-00000001', 'u-auditeur');
    expect(del.statusCode).toBe(405);
    expect(del.json().code).toBe('AUDIT_APPEND_ONLY');
    expect(env3.app.ctx.audit.verify().ok).toBe(true);
  });

  it('seuls les auditeurs lisent le journal', async () => {
    const env = await setup();
    expect((await env.req('GET', '/v1/audit/events?limit=5', 'u-auditeur')).json().items).toHaveLength(5);
    for (const u of ['u-superadmin', 'u-gouverneur', 'u-tresor', 'u-contribuable']) {
      expect((await env.req('GET', '/v1/audit/events', u)).statusCode).toBe(403);
    }
    expect((await env.req('GET', '/v1/audit/events')).statusCode).toBe(401);
    expect((await env.req('GET', '/v1/audit/events', 'u-inconnu')).json().code).toBe('UNKNOWN_DEMO_USER');
  });
});

describe('Contrôle d’accès', () => {
  it('AC-ACC-01 : le super-administrateur ne lit aucun montant nominatif et ne modifie rien de financier', async () => {
    const env = await setup();
    const u = 'u-superadmin';
    const obl = demoObligationId(env);
    const { order } = await payDemoObligation(env);
    const checks = await Promise.all([
      env.req('GET', `/v1/taxpayers/${DEMO.taxpayerId}`, u),
      env.req('GET', `/v1/obligations?taxpayerId=${DEMO.taxpayerId}`, u),
      env.req('GET', `/v1/obligations/${obl}`, u),
      env.req('GET', '/v1/ledger/entries', u),
      env.req('GET', '/v1/ledger/balance', u),
      env.req('POST', `/v1/obligations/${obl}/payment-orders`, u, { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() }),
      env.req('POST', '/v1/assessments/calculate', u, { ruleId: 'rule-demo-if-bati-v1', taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: {}, simulate: false }),
      env.req('POST', '/v1/settlements/statements', u, { statementId: 'X', lines: [{ accountAlias: DEMO.dgipkAlias, amount: { amount: '150.00', currency: 'USD' }, valueDate: '2026-09-26', paymentReference: order.paymentReference }] }),
      env.req('POST', '/v1/beneficiary-accounts/change-requests', u, { alias: DEMO.dgipkAlias, bankName: 'Banque X', accountNumber: 'CD00 9999 9999 9999', holderName: 'Pirate', reason: 'Tentative interdite' }),
      env.req('POST', '/v1/ledger/entries/GL-00000001/reversals', u, { reason: 'Tentative interdite' }),
      env.req('GET', '/v1/audit/events', u),
      env.req('DELETE', '/v1/audit/events/AUD-00000001', u),
    ]);
    expect(checks.map((c) => c.statusCode)).toEqual([403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 403, 405]);
    for (const c of checks) expect(c.body).not.toContain('"150.00"');
    expect(env.app.ctx.audit.list({ action: 'access.denied' }).total).toBeGreaterThanOrEqual(11);
    expect(() => env.app.ctx.users.add({ id: 'u-sa-tresor', name: 'x', roles: ['R26', 'R17'], entity: 'PLATEFORME' })).toThrow();
  });

  it('AC-ACC-02 : le Gouverneur voit les agrégats et ne peut modifier aucune donnée financière', async () => {
    const env = await setup();
    const u = 'u-gouverneur';
    const dash = await env.req('GET', '/v1/dashboards/governor', u);
    expect(dash.statusCode).toBe(200);
    expect(dash.json().example).toBe(true);
    expect(JSON.stringify(dash.json())).not.toContain('Mbuyi');
    const obl = demoObligationId(env);
    const denied = await Promise.all([
      env.req('GET', `/v1/taxpayers/${DEMO.taxpayerId}`, u),
      env.req('GET', `/v1/obligations/${obl}`, u),
      env.req('GET', '/v1/obligations', u),
      env.req('POST', `/v1/obligations/${obl}/payment-orders`, u, { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() }),
      env.req('POST', '/v1/settlements/statements', u, { statementId: 'G', lines: [{ accountAlias: DEMO.dgipkAlias, amount: { amount: '1.00', currency: 'USD' }, valueDate: '2026-09-26', paymentReference: 'PR-X' }] }),
      env.req('POST', '/v1/beneficiary-accounts/change-requests', u, { alias: DEMO.dgipkAlias, bankName: 'Banque X', accountNumber: 'CD00 9999 9999 9999', holderName: 'X', reason: 'Tentative interdite' }),
      env.req('POST', '/v1/ledger/entries/GL-00000001/reversals', u, { reason: 'Tentative interdite' }),
      env.req('POST', '/v1/assessments/calculate', u, { ruleId: 'rule-demo-if-bati-v1', taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: {}, simulate: false }),
    ]);
    expect(denied.map((d) => d.statusCode)).toEqual(Array(8).fill(403));
    // Les autres rôles n'accèdent pas au tableau du Gouverneur.
    expect((await env.req('GET', '/v1/dashboards/governor', 'u-contribuable')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/dashboards/governor', 'u-ministre-finances')).statusCode).toBe(200);
  });

  it('ABAC : agent de terrain limité à son territoire, accès minimal sans montant', async () => {
    const env = await setup();
    const inZone = await env.req('GET', `/v1/taxpayers/${DEMO.taxpayerId}`, 'u-agent-terrain');
    expect(inZone.statusCode).toBe(200);
    expect(inZone.json().access).toBe('minimal');
    expect(inZone.json().obligations[0].amount).toBeNull();
    expect(inZone.json().receipts).toBeNull();
    expect((await env.req('GET', `/v1/taxpayers/${DEMO.taxpayerId}`, 'u-agent-gombe')).statusCode).toBe(403);
    const self = await env.req('GET', `/v1/taxpayers/${DEMO.taxpayerId}`, 'u-contribuable');
    expect(self.json().access).toBe('full');
    expect(self.json().obligations[0].amount).toEqual({ amount: '150.00', currency: 'USD' });
  });
});
