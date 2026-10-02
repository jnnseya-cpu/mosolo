/**
 * Module 59 (grand livre public) et module 60 (coffre des comptes bénéficiaires) — compléments vérifiés :
 * scellement recalculé et rupture signalée (jamais corrigée), écart grand livre / relevés, délai de clôture,
 * comptes Mobile Money publics au registre verrouillé, date d'effet future, indicateurs des changements.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import type { InMemoryAppendOnlyRepository } from '../src/core/repository.js';
import type { LedgerEntry } from '../src/modules/treasury/ledger.js';
import { tresorPlugin } from '../src/plugins/tresor/plugin.js';
import { DEMO } from '../src/seed.js';
import { postStatement, callbackBody, PROVIDER_SECRET, setup, signedCallback, type TestEnv } from './helpers.js';

async function setupTresor(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} }, plugins: [tresorPlugin] });
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

async function payAndReconcile(env: TestEnv, extraLine = false) {
  const ob = env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;
  const order = (await env.req('POST', `/v1/obligations/${ob}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).json();
  await signedCallback(env, callbackBody(env, order.paymentReference));
  const lines = [{ accountAlias: DEMO.dgipkAlias, amount: { amount: '150.00', currency: 'USD' }, valueDate: '2026-09-26', paymentReference: order.paymentReference }];
  // Ligne orpheline (crédit sans référence connue) : reste en exception, explique l'écart grand livre / relevés.
  if (extraLine) lines.push({ accountAlias: DEMO.dgipkAlias, amount: { amount: '20.00', currency: 'USD' }, valueDate: '2026-09-26', paymentReference: 'PR-ZZZZ-ZZZZ' });
  const st = await postStatement(env, 'u-tresor', { statementId: `REL-${randomUUID().slice(0, 8)}`, lines });
  expect(st.statusCode, st.body).toBeLessThan(300);
}

describe('Module 59 — grand livre public : scellement, écart aux relevés, délai de clôture', () => {
  it('indicateurs calculés sur les données réelles ; clôture signée ; délai mesuré', async () => {
    const env = await setupTresor();
    let ind = (await env.req('GET', '/v1/tresor/grand-livre/indicateurs', 'u-tresor')).json();
    expect(ind.delaiCloture.note).toMatch(/non mesuré/);
    type Row = { currency: string; statements: { amount: string }; ledger: { amount: string }; gap: { amount: string }; pendingStatementLines: number; pendingAmount: { amount: string } };
    const usdOf = (x: { ecartReleves: { byCurrency: Row[] } }) => x.ecartReleves.byCurrency.find((r) => r.currency === 'USD');
    const n = (v: { amount: string } | undefined) => Number(v?.amount ?? '0');
    const before = usdOf(ind);
    await payAndReconcile(env, true);
    ind = (await env.req('GET', '/v1/tresor/grand-livre/indicateurs', 'u-tresor')).json();
    expect(ind.balanced).toBe(true);
    expect(ind.chain.valid).toBe(true);
    const usd = usdOf(ind)!;
    // Relevé importé : +170,00 ; inscrit au compte public : +150,00 ; écart +20,00 expliqué par la ligne orpheline.
    expect(n(usd.statements) - n(before?.statements)).toBeCloseTo(170, 2);
    expect(n(usd.ledger) - n(before?.ledger)).toBeCloseTo(150, 2);
    expect(n(usd.gap) - n(before?.gap)).toBeCloseTo(20, 2);
    expect(usd.gap.amount).toBe((n(usd.statements) - n(usd.ledger)).toFixed(2));
    expect(usd.pendingStatementLines - (before?.pendingStatementLines ?? 0)).toBe(1);
    expect(n(usd.pendingAmount) - n(before?.pendingAmount)).toBeCloseTo(20, 2);
    expect(ind.delaiCloture.backlog.oldestUnclosedDate).toBe('2026-09-26');
    // Clôture le lendemain à 10 h (Kinshasa) : délai = 10 h après la fin de la journée.
    env.clock.set('2026-09-27T09:00:00.000Z');
    const waiver = await env.req('POST', '/v1/tresor/closures/daily', 'u-tresor', { date: '2026-09-26' });
    if (waiver.statusCode === 409 && waiver.json().code === 'CLOSURE_APPROVAL_REQUIRED') {
      const w = (await env.req('POST', '/v1/tresor/closures/daily/waivers', 'u-tresor', { date: '2026-09-26', motif: 'Ligne orpheline en cours d’identification (test).' })).json();
      await env.req('POST', `/v1/tresor/closures/daily/waivers/${w.id}/approve`, 'tresor-chef-comptable');
      expect((await env.req('POST', '/v1/tresor/closures/daily', 'u-tresor', { date: '2026-09-26' })).statusCode).toBe(201);
    } else {
      expect(waiver.statusCode).toBe(201);
    }
    ind = (await env.req('GET', '/v1/tresor/grand-livre/indicateurs', 'u-tresor')).json();
    expect(ind.delaiCloture.daily[0]).toMatchObject({ date: '2026-09-26', delayHours: 10 });
    expect(ind.delaiCloture.medianDelayHours).toBe(10);
    expect(ind.delaiCloture.backlog.oldestUnclosedDate).toBeNull();
    expect((await env.req('GET', '/v1/tresor/grand-livre/indicateurs', 'u-contribuable')).statusCode).toBe(403);
  });

  it('écritures scellées et chaînées : une altération du stockage est détectée, signalée à l’audit, jamais corrigée', async () => {
    const env = await setupTresor();
    await payAndReconcile(env);
    let v = (await env.req('GET', '/v1/tresor/grand-livre/verification', 'u-tresor')).json();
    expect(v).toMatchObject({ valid: true, closures: { valid: true } });
    // Altération hors application (ex. base de données modifiée) : description d'une écriture changée.
    const repo = (env.app.ctx.ledger as unknown as { entries: InMemoryAppendOnlyRepository<LedgerEntry> }).entries;
    const tampered = repo.all().map((e, i) => (i === 0 ? { ...e, description: `${e.description} (modifiée)` } : e));
    repo.restoreSnapshot(tampered);
    v = (await env.req('GET', '/v1/tresor/grand-livre/verification', 'u-tresor')).json();
    expect(v).toMatchObject({ valid: false, reason: 'EMPREINTE_INVALIDE', brokenAt: tampered[0]!.id });
    expect(env.app.ctx.alerts.list().filter((a) => a.type === 'LEDGER_CHAIN_BROKEN')).toHaveLength(1);
    // Une seconde vérification ne réalerte pas (même rupture) ; rien n'a été « réparé ».
    await env.req('GET', '/v1/tresor/grand-livre/verification', 'u-auditeur');
    expect(env.app.ctx.alerts.list().filter((a) => a.type === 'LEDGER_CHAIN_BROKEN')).toHaveLength(1);
    expect(env.app.ctx.ledger.verifyChain().valid).toBe(false);
    // Séquence rompue (écriture supprimée du stockage).
    repo.restoreSnapshot(repo.all().slice(1));
    expect(env.app.ctx.ledger.verifyChain()).toMatchObject({ valid: false, reason: 'SEQUENCE_ROMPUE' });
    expect(env.app.ctx.audit.list({ action: 'ledger.chain.verified' }).total).toBeGreaterThanOrEqual(3);
  });
});

describe('Module 60 — coffre : Mobile Money public, date d’effet future, indicateurs', () => {
  const proposal = { alias: DEMO.dgipkAlias, bankName: 'Banque de recettes C (démo)', accountNumber: 'CD00 1111 2222 3333 4444 5555', holderName: 'DGIPK — nouveau compte (démo)', reason: 'Migration bancaire (test)' };

  it('registre verrouillé : comptes bancaires et Mobile Money publics, numéros masqués ; indicateurs réels', async () => {
    const env = await setup();
    const v = (await env.req('GET', '/v1/beneficiary-accounts', 'u-tresor')).json();
    const mm = v.accounts.find((a: { alias: string }) => a.alias === 'KIN-DGRK-MM-01');
    expect(mm).toMatchObject({ kind: 'MOBILE_MONEY', currency: 'CDF' });
    expect(mm.accountNumber).toMatch(/^•••• /);
    expect(v.accounts.find((a: { alias: string }) => a.alias === DEMO.dgipkAlias).kind).toBe('BANCAIRE');
    expect(v.indicators).toMatchObject({ requested: 0, approved: 0, refused: 0, accounts: { mobileMoney: 1 } });
    // Proposition, approbation, veto : indicateurs à jour.
    const a = (await env.req('POST', '/v1/beneficiary-accounts/change-requests', 'u-tresor', proposal)).json();
    const b = (await env.req('POST', '/v1/beneficiary-accounts/change-requests', 'u-tresor', { ...proposal, alias: 'KIN-DGRK-MM-01', bankName: 'Opérateur B (démo)', accountNumber: 'MM 243 0000 0000 02' })).json();
    await env.req('POST', `/v1/beneficiary-accounts/change-requests/${a.id}/approve`, 'u-coffre-1', { outOfBandVerified: true });
    await env.req('POST', `/v1/beneficiary-accounts/change-requests/${a.id}/approve`, 'u-coffre-2', { outOfBandVerified: true });
    expect((await env.req('POST', `/v1/beneficiary-accounts/change-requests/${b.id}/veto`, 'u-auditeur', { motif: 'Changement non annoncé au comité (test).' })).statusCode).toBe(200);
    const after = (await env.req('GET', '/v1/beneficiary-accounts', 'u-auditeur')).json();
    expect(after.indicators).toMatchObject({ requested: 2, approved: 1, coolingOff: 1, refused: 1, pending: 0 });
    // Le compte Mobile Money en vigueur n'a pas changé (veto).
    expect(env.app.ctx.vault.current('KIN-DGRK-MM-01')!.version).toBe(1);
  });

  it('date d’effet future : refusée avant la fin du refroidissement ; le changement attend cette date', async () => {
    const env = await setup();
    const early = await env.req('POST', '/v1/beneficiary-accounts/change-requests', 'u-tresor', { ...proposal, effectiveFrom: '2026-09-27T09:00:00.000Z' });
    expect(early.json().code).toBe('EFFECTIVE_DATE_TOO_EARLY');
    const r = await env.req('POST', '/v1/beneficiary-accounts/change-requests', 'u-tresor', { ...proposal, effectiveFrom: '2026-10-05T08:00:00.000Z' });
    expect(r.statusCode).toBe(201);
    const id = r.json().id;
    await env.req('POST', `/v1/beneficiary-accounts/change-requests/${id}/approve`, 'u-coffre-1', { outOfBandVerified: true });
    await env.req('POST', `/v1/beneficiary-accounts/change-requests/${id}/approve`, 'u-coffre-2', { outOfBandVerified: true });
    const before = env.app.ctx.vault.current(DEMO.dgipkAlias)!.accountNumber;
    env.clock.advanceHours(80); // refroidissement terminé, date d'effet non atteinte
    expect(env.app.ctx.vault.getRequest(id).status).toBe('EN_REFROIDISSEMENT');
    expect(env.app.ctx.vault.current(DEMO.dgipkAlias)!.accountNumber).toBe(before);
    env.clock.set('2026-10-05T08:00:01.000Z');
    expect(env.app.ctx.vault.getRequest(id).status).toBe('EFFECTIF');
    expect(env.app.ctx.vault.current(DEMO.dgipkAlias)!.accountNumber).toBe(proposal.accountNumber);
  });
});
