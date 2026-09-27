import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { canauxPlugin } from '../src/plugins/canaux/plugin.js';
import { AUTO_MATCH_ACTOR } from '../src/plugins/canaux/points.js';
import type { CanauxService } from '../src/plugins/canaux/service.js';
import type { StatementLine } from '../src/modules/treasury/service.js';

// Import d'un relevé au Trésor ⇒ appariement automatique des versements déclarés des points agréés (bordereau).
const DAY = '2026-09-26';
const POINT = 'PA-LIMETE-MM01';

async function setup() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} },
    plugins: [canauxPlugin],
  });
  await app.ready();
  const req = (method: string, url: string, user: string, body?: unknown) =>
    app.inject({ method: method as 'GET', url, headers: { 'x-demo-user': user, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
  const svc = app.ctx.ext.canaux as CanauxService;
  // Caisse du jour clôturée puis versement déclaré (bordereau BORD-AUTO-1), exactement l'attendu par compte.
  const view = (await req('GET', `/v1/payment-points/${POINT}/cash-days/${DAY}`, 'canaux-op-limete')).json();
  await req('POST', `/v1/payment-points/${POINT}/cash-days/${DAY}/close`, 'canaux-op-limete', { counted: view.expected });
  clock.advanceHours(1);
  const dep = await req('POST', `/v1/payment-points/${POINT}/cash-days/${DAY}/deposit`, 'canaux-op-limete', {
    bankSlipRef: 'BORD-AUTO-1', depositedAt: clock.now().toISOString(), lines: view.expectedByAccount,
  });
  expect(dep.json().status).toBe('DECLAREE');
  const expectedByAccount = view.expectedByAccount as { accountAlias: string; amount: { amount: string; currency: 'USD' | 'CDF' } }[];
  const tresor = app.ctx.users.get('u-tresor')!;
  const importLines = (statementId: string, lines: StatementLine[]) => app.ctx.treasury.importStatement(tresor, { statementId, lines });
  const slipLines = (ref = 'BORD-AUTO-1'): StatementLine[] => expectedByAccount.map((l) => ({ accountAlias: l.accountAlias, amount: l.amount, valueDate: DAY, paymentReference: ref }));
  const cashDay = () => svc.points.cashDays.get(`${POINT}:${DAY}`)!;
  return { app, req, svc, clock, expectedByAccount, importLines, slipLines, cashDay };
}

describe('canaux — versement de point agréé apparié à l’import du relevé', () => {
  let c: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { c = await setup(); });

  it('bordereau et montants identiques ⇒ rapproché automatiquement (VERSEE, quittances définitives), journalisé, sans crédit orphelin', async () => {
    expect(c.expectedByAccount.length).toBeGreaterThan(0);
    const { replayed, result } = c.importLines('REL-AUTO-1', c.slipLines(' bord-auto-1 '));
    expect(replayed).toBe(false);
    expect(result.exceptions).toHaveLength(0);
    expect(result.claimed).toEqual([expect.objectContaining({ kind: 'VERSEMENT_POINT_AGREE', pointId: POINT, day: DAY, status: 'VERSEE' })]);
    const cd = c.cashDay();
    expect(cd.status).toBe('VERSEE');
    expect(cd.deposit!.bankMatch).toMatchObject({ statementId: 'REL-AUTO-1', auto: true, approvedBy: AUTO_MATCH_ACTOR, proposedBy: 'u-tresor' });
    const view = (await c.req('GET', `/v1/payment-points/${POINT}/cash-days/${DAY}`, 'u-tresor')).json();
    expect(view.reconciledCount).toBe(view.collections.length);
    expect(view.collections.every((x: { receiptStatus: string }) => x.receiptStatus === 'DEFINITIVE')).toBe(true);
    const audit = c.app.ctx.audit.list({ action: 'canaux.point.deposit_auto_matched' }).items;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatchObject({ statementId: 'REL-AUTO-1', bankSlipRef: 'BORD-AUTO-1', status: 'VERSEE' });
    expect(c.app.ctx.treasury.rawExceptions().some((e) => e.statementId === 'REL-AUTO-1')).toBe(false);
    // Le circuit manuel à quatre yeux reste disponible, mais ne constate pas deux fois.
    const again = await c.req('POST', `/v1/payment-points/${POINT}/cash-days/${DAY}/bank-match`, 'u-tresor', { statementId: 'REL-AUTO-1' });
    expect(again.json().code).toBe('BANK_MATCH_ALREADY_PROPOSED');
  });

  it('montant différent ⇒ exception « écart de montant » dans la file du Trésor, caisse toujours DECLAREE', () => {
    const lines = c.slipLines().map((l, i) => (i === 0 ? { ...l, amount: { amount: '1.00', currency: l.amount.currency } } : l));
    const { result } = c.importLines('REL-AUTO-ECART', lines);
    expect(result.claimed).toBeUndefined();
    expect(result.exceptions.map((e) => e.type)).toContain('AMOUNT_MISMATCH');
    const ex = c.app.ctx.treasury.rawExceptions().find((e) => e.statementId === 'REL-AUTO-ECART' && e.type === 'AMOUNT_MISMATCH')!;
    expect(ex.queue).toBe('ECART_MONTANT');
    expect(ex.detail).toMatch(/BORD-AUTO-1/);
    expect(c.cashDay().status).toBe('DECLAREE');
    expect(c.cashDay().deposit!.bankMatch).toBeUndefined();
  });

  it('compte crédité différent (même total) ⇒ exception « mauvais compte », jamais de constatation', () => {
    const lines = c.slipLines().map((l) => ({ ...l, accountAlias: l.accountAlias === 'KIN-DGTK-RECETTES-01' ? 'KIN-DGIPK-RECETTES-01' : 'KIN-DGTK-RECETTES-01' }));
    const { result } = c.importLines('REL-AUTO-COMPTE', lines);
    expect(result.exceptions.every((e) => e.type === 'WRONG_ACCOUNT')).toBe(true);
    expect(result.exceptions.length).toBe(lines.length);
    expect(c.cashDay().status).toBe('DECLAREE');
  });

  it('bordereau inconnu ⇒ crédit orphelin inchangé (exception), aucune caisse touchée', () => {
    const { result } = c.importLines('REL-AUTO-INCONNU', c.slipLines('BORD-INCONNU-9'));
    expect(result.claimed).toBeUndefined();
    expect(result.exceptions.every((e) => e.type === 'ORPHAN_CREDIT' && e.detail.startsWith('Crédit sans référence'))).toBe(true);
    expect(c.cashDay().status).toBe('DECLAREE');
  });

  it('ré-import idempotent du même relevé ; même bordereau sur un autre relevé ⇒ crédit en double', () => {
    const first = c.importLines('REL-AUTO-2', c.slipLines());
    const ledgerBefore = c.app.ctx.ledger.list({}).length;
    const replay = c.importLines('REL-AUTO-2', c.slipLines());
    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(first.result);
    expect(c.app.ctx.ledger.list({}).length).toBe(ledgerBefore);
    expect(c.app.ctx.audit.list({ action: 'canaux.point.deposit_auto_matched' }).items).toHaveLength(1);
    const dup = c.importLines('REL-AUTO-3', c.slipLines());
    expect(dup.result.exceptions.every((e) => e.type === 'DUPLICATE_CREDIT' && /déjà constaté/.test(e.detail))).toBe(true);
    expect(c.cashDay().deposit!.bankMatch!.statementId).toBe('REL-AUTO-2');
  });
});
