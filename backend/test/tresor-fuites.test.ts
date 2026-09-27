/**
 * Fuites financières rejouées (attaques vérifiées) : chaque test REJOUE l'attaque et montre qu'elle est désormais
 * bloquée ou détectée (exception, alerte, écart de cohérence).
 *  1. doublon remboursé deux fois (suspens du non-affecté + suspens de la ligne de relevé) ;
 *  2. annulation d'une quittance provisoire puis import à moitié passé ;
 *  3. exception portant de l'argent classée sans pièce ni action ;
 *  4. créances prestataires non réglées (balance âgée, alerte, clôture) ;
 *  5. contre-écriture d'une écriture métier masquant une recette ;
 *  6. restitution sans destination vérifiable ; seuil de seconde validation ;
 *  7. changement de compte bénéficiaire sans veto ; crédit sous une autre version du compte ;
 *  8. montants arrondis avant comparaison (« 149.995 ») ;
 *  9. clé de signature des clôtures éphémère.
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { sha256Hex } from '../src/core/crypto.js';
import { tresorPlugin } from '../src/plugins/tresor/plugin.js';
import { loadClosureSigningKey, type TresorService } from '../src/plugins/tresor/service.js';
import { DEMO } from '../src/seed.js';
import { callbackBody, PROVIDER_SECRET, signedCallback, type TestEnv, postStatement } from './helpers.js';

async function setupFuites() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} },
    plugins: [tresorPlugin],
  });
  await app.ready();
  const env: TestEnv & { svc: TresorService } = {
    app, clock, svc: app.ctx.ext.tresor as TresorService,
    req: (method, url, user, body, headers = {}) =>
      app.inject({
        method: method as 'GET', url,
        headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
      }),
  };
  return env;
}

type Env = Awaited<ReturnType<typeof setupFuites>>;

const PAYER = sha256Hex('msisdn-payeur-test');
const PROOF = { refundReference: 'RMB-MM-0001', evidenceSha256: sha256Hex('avis-remboursement') };
const obligationId = (env: Env) => env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;

async function order(env: Env) {
  return (await env.req('POST', `/v1/obligations/${obligationId(env)}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).json();
}

async function callback(env: Env, ref: string, amount = '150.00', payer = PAYER) {
  return signedCallback(env, { ...callbackBody(env, ref, { amount, currency: 'USD' }), payerMsisdnHash: payer });
}

function line(paymentReference: string, amount = '150.00', extra: Record<string, unknown> = {}) {
  return { accountAlias: DEMO.dgipkAlias, amount: { amount, currency: 'USD' }, valueDate: '2026-09-26', paymentReference, ...extra };
}

async function statement(env: Env, lines: unknown[], id = `REL-${randomUUID().slice(0, 8)}`) {
  return postStatement(env, 'u-tresor', { statementId: id, lines });
}

async function op(env: Env, body: Record<string, unknown>, proposer = 'u-tresor') {
  return env.req('POST', '/v1/tresor/operations', proposer, body);
}

async function approve(env: Env, id: string, user = 'tresor-chef-comptable', body: Record<string, unknown> = {}) {
  return env.req('POST', `/v1/tresor/operations/${id}/approve`, user, body);
}

/** Affectation par u-tresor, traitement par l'analyste (justificatif avec empreinte), proposition. */
async function work(env: Env, exId: string, proposal: Record<string, unknown>) {
  await env.req('POST', `/v1/tresor/exceptions/${exId}/assign`, 'u-tresor', { assignee: 'u-analyste-rappro' });
  await env.req('POST', `/v1/tresor/exceptions/${exId}/start`, 'u-analyste-rappro');
  await env.req('POST', `/v1/tresor/exceptions/${exId}/evidence`, 'u-analyste-rappro', { label: 'Pièce prestataire (test)', sha256: sha256Hex(`piece-${exId}`) });
  return env.req('POST', `/v1/tresor/exceptions/${exId}/resolution`, 'u-analyste-rappro', proposal);
}

const balance = (env: Env, account: string) => env.app.ctx.ledger.balance().accounts.find((a) => a.account === account && a.currency === 'USD')?.balance.amount ?? '0.00';

describe('1. Doublon : une seule restitution par unité monétaire', () => {
  it('le relevé qui règle le doublon apparie le paiement non affecté : aucun second suspens, une seule restitution', async () => {
    const env = await setupFuites();
    const o = await order(env);
    expect((await callback(env, o.paymentReference)).json().status).toBe('CONFIRME');
    expect((await callback(env, o.paymentReference)).json().status).toBe('DOUBLON');
    const [u] = env.app.ctx.payments.unappliedPayments.all();
    // Le prestataire règle les DEUX paiements : l'original et le doublon.
    const st = (await statement(env, [line(o.paymentReference), line(o.paymentReference)])).json();
    expect(st.matched).toHaveLength(1);
    expect(st.settledUnapplied).toEqual([expect.objectContaining({ unappliedId: u!.id })]);
    // Attaque d'origine : la 2e ligne ouvrait DUPLICATE_CREDIT, mis en suspens puis restitué une seconde fois.
    expect(st.exceptions).toHaveLength(0);
    const open = env.svc.suspense.find((s) => s.status === 'OUVERT' && !s.demo);
    expect(open).toHaveLength(1);
    const r = (await op(env, { kind: 'APUREMENT_SUSPENS', suspenseId: open[0]!.id, mode: 'RESTITUTION', destination: PAYER, reason: 'Doublon restitué au payeur (test)' })).json();
    const done = (await approve(env, r.id, 'tresor-chef-comptable', PROOF)).json();
    expect(done.status).toBe('EXECUTEE');
    // Fonds déjà sur le compte public : la restitution sort du compte public, la créance prestataire est soldée.
    expect(env.app.ctx.ledger.get(done.result.ledgerEntryId)!.lines.find((l) => l.side === 'CREDIT')!.account).toBe('COMPTE_PUBLIC_RECETTES');
    expect(balance(env, 'FONDS_A_RECEVOIR_PRESTATAIRES')).toBe('0.00');
    expect((await op(env, { kind: 'APUREMENT_SUSPENS', suspenseId: open[0]!.id, mode: 'RESTITUTION', destination: PAYER, reason: 'Seconde restitution (attaque)' })).json().code).toBe('SUSPENSE_CLEARED');
    expect(env.svc.ledgerConsistency().consistent).toBe(true);
  });

  it('exception DUPLICATE_CREDIT déjà ouverte puis doublon annoncé : suspens refusé, rapprochement ; suspens déjà ouvert : fusion', async () => {
    const env = await setupFuites();
    const o = await order(env);
    await callback(env, o.paymentReference);
    await statement(env, [line(o.paymentReference)]);
    // Le relevé montre un second crédit AVANT le rappel de doublon.
    const exId = (await statement(env, [line(o.paymentReference)])).json().exceptions[0].id as string;
    await callback(env, o.paymentReference); // doublon annoncé ensuite : suspens du non-affecté
    const refused = await work(env, exId, { outcome: 'RESOLUE', motif: 'Second crédit porté en suspens (attaque)', action: 'MISE_EN_SUSPENS' });
    expect(refused.json().code).toBe('SUSPENSE_COVERED_BY_UNAPPLIED');
    await env.req('POST', `/v1/tresor/exceptions/${exId}/resolution`, 'u-analyste-rappro', { outcome: 'RESOLUE', motif: 'Ligne de relevé du doublon déjà en attente', action: 'RAPPROCHEMENT' });
    const ok = (await env.req('POST', `/v1/tresor/exceptions/${exId}/resolution/approve`, 'tresor-chef-comptable')).json();
    expect(ok.status).toBe('RESOLUE');
    expect(env.svc.suspense.find((s) => s.status === 'OUVERT' && !s.demo)).toHaveLength(1);
    expect(env.svc.ledgerConsistency().consistent).toBe(true);

    // Variante : le second crédit a déjà été mis en suspens quand le doublon est annoncé ⇒ fusion, un seul restituable.
    const env2 = await setupFuites();
    const o2 = await order(env2);
    await callback(env2, o2.paymentReference);
    await statement(env2, [line(o2.paymentReference, '150.00', { counterparty: PAYER })]);
    const ex2 = (await statement(env2, [line(o2.paymentReference, '150.00', { counterparty: PAYER })])).json().exceptions[0].id as string;
    await work(env2, ex2, { outcome: 'RESOLUE', motif: 'Second crédit porté en suspens (test)', action: 'MISE_EN_SUSPENS' });
    await env2.req('POST', `/v1/tresor/exceptions/${ex2}/resolution/approve`, 'tresor-chef-comptable');
    await callback(env2, o2.paymentReference);
    const open = env2.svc.suspense.find((s) => s.status === 'OUVERT' && !s.demo);
    expect(open).toHaveLength(1);
    expect(open[0]!.unappliedId).toBeDefined();
    expect(env2.svc.suspense.findOne((s) => s.exceptionId === ex2)!.clearing).toMatchObject({ mode: 'FUSION' });
    expect(env2.app.ctx.alerts.alerts.find((a) => a.type === 'SUSPENSE_MERGED')).toHaveLength(1);
    expect(env2.svc.ledgerConsistency().consistent).toBe(true);
  });
});

describe('2. Quittance annulée et import tout-ou-rien', () => {
  it('annulation refusée sur paiement confirmé ; quittance non finalisable ⇒ exception sans écriture ; relevé invalide ⇒ rien', async () => {
    const env = await setupFuites();
    const o = await order(env);
    const cb = (await callback(env, o.paymentReference)).json();
    expect((await op(env, { kind: 'ANNULATION_QUITTANCE', receipt: cb.receiptNumber, reason: 'Annulation de la quittance provisoire (attaque)' })).json().code).toBe('PAYMENT_CONFIRMED_USE_REVERSAL');
    // Défense en profondeur : quittance rendue non finalisable hors circuit (état hérité).
    const r = env.app.ctx.receipts.byPaymentOrder(o.paymentOrderId)!;
    env.app.ctx.receipts.receipts.update({ ...r, status: 'ANNULEE' });
    const ledgerBefore = env.app.ctx.ledger.list().length;
    expect(() => env.app.ctx.treasury.completeMatch(o.paymentOrderId, { debit: 'COMPTE_PUBLIC_RECETTES', description: 'x', actor: { kind: 'system', id: 't' } })).toThrow(/ne peut devenir définitive/);
    expect(env.app.ctx.ledger.list().length).toBe(ledgerBefore);
    const st = (await statement(env, [line(o.paymentReference)])).json();
    expect(st.exceptions.map((e: { type: string }) => e.type)).toEqual(['RECEIPT_NOT_FINALIZABLE']);
    expect(env.app.ctx.payments.orders.get(o.paymentOrderId)!.status).toBe('CONFIRME');
    expect(env.app.ctx.ledger.list().length).toBe(ledgerBefore);

    // Relevé contenant une ligne invalide : aucune ligne n'est passée, le relevé peut être réimporté corrigé.
    const env2 = await setupFuites();
    const o2 = await order(env2);
    await callback(env2, o2.paymentReference);
    const bad = await statement(env2, [line(o2.paymentReference), line('PR-INCONNUE', '149.995')], 'REL-TOUT-OU-RIEN');
    expect(bad.statusCode).toBe(422);
    expect(bad.json().code).toBe('AMOUNT_PRECISION');
    expect(env2.app.ctx.payments.orders.get(o2.paymentOrderId)!.status).toBe('CONFIRME');
    expect(env2.app.ctx.treasury.exceptions.count()).toBe(0);
    expect((await statement(env2, [line(o2.paymentReference)], 'REL-TOUT-OU-RIEN')).json().matched).toHaveLength(1);
  });
});

describe('3. Exceptions portant de l’argent', () => {
  it('ni classement, ni « aucune action », ni affectant = proposant = valideur ; opération exécutée liée exigée', async () => {
    const env = await setupFuites();
    const exId = (await statement(env, [line('PR-INCONNUE-9', '500.00')])).json().exceptions[0].id as string;
    await env.req('POST', `/v1/tresor/exceptions/${exId}/assign`, 'u-tresor', { assignee: 'u-tresor' });
    await env.req('POST', `/v1/tresor/exceptions/${exId}/start`, 'u-tresor');
    await env.req('POST', `/v1/tresor/exceptions/${exId}/evidence`, 'u-tresor', { label: 'Note interne sans pièce' });
    for (const p of [{ outcome: 'CLASSEE', action: 'AUCUNE' }, { outcome: 'RESOLUE', action: 'AUCUNE' }, { outcome: 'CLASSEE', action: 'MISE_EN_SUSPENS' }]) {
      // Auto-affectation : l'affectant ne propose pas lui-même.
      const res = await env.req('POST', `/v1/tresor/exceptions/${exId}/resolution`, 'u-tresor', { ...p, motif: 'Classement sans suite (attaque)' });
      expect(res.json().code).toBe('SEPARATION_OF_DUTIES');
    }
    // Réaffectation par une autre personne : l'affectant ne propose pas, une pièce sans empreinte ne suffit pas.
    await env.req('POST', `/v1/tresor/exceptions/${exId}/assign`, 'tresor-chef-comptable', { assignee: 'u-analyste-rappro' });
    await env.req('POST', `/v1/tresor/exceptions/${exId}/evidence`, 'u-analyste-rappro', { label: 'Courriel sans pièce' });
    expect((await env.req('POST', `/v1/tresor/exceptions/${exId}/resolution`, 'u-analyste-rappro', { outcome: 'CLASSEE', action: 'AUCUNE', motif: 'Classement sans suite (attaque)' })).json().code).toBe('MONEY_EXCEPTION_NEEDS_FINANCIAL_ACTION');
    expect((await env.req('POST', `/v1/tresor/exceptions/${exId}/resolution`, 'u-analyste-rappro', { outcome: 'RESOLUE', action: 'MISE_EN_SUSPENS', motif: 'Crédit non identifié (test)' })).json().code).toBe('EVIDENCE_REQUIRED');
    expect((await env.req('POST', `/v1/tresor/exceptions/${exId}/resolution`, 'u-analyste-rappro', { outcome: 'RESOLUE', action: 'OPERATION', motif: 'Opération inexistante (attaque)' })).json().code).toBe('EVIDENCE_REQUIRED');
    await env.req('POST', `/v1/tresor/exceptions/${exId}/evidence`, 'u-analyste-rappro', { label: 'Relevé', sha256: sha256Hex('releve') });
    expect((await env.req('POST', `/v1/tresor/exceptions/${exId}/resolution`, 'u-analyste-rappro', { outcome: 'RESOLUE', action: 'OPERATION', motif: 'Opération inexistante (attaque)' })).json().code).toBe('OPERATION_REQUIRED');
    const nomen = (await op(env, { kind: 'PARAMETRE_NOMENCLATURE', reason: 'Opération sans rapport (test)', nomenclature: { revenueCategory: 'PENALITE', code: 'X-1', label: 'Test' } })).json();
    await approve(env, nomen.id);
    expect((await env.req('POST', `/v1/tresor/exceptions/${exId}/resolution`, 'u-analyste-rappro', { outcome: 'RESOLUE', action: 'OPERATION', operationId: nomen.id, motif: 'Opération sans rapport (attaque)' })).json().code).toBe('OPERATION_UNRELATED');
    const prop = await env.req('POST', `/v1/tresor/exceptions/${exId}/resolution`, 'u-analyste-rappro', { outcome: 'RESOLUE', action: 'MISE_EN_SUSPENS', motif: 'Crédit non identifié (test)' });
    expect(prop.json().proposal).toMatchObject({ action: 'MISE_EN_SUSPENS' });
    expect((await env.req('POST', `/v1/tresor/exceptions/${exId}/resolution/approve`, 'tresor-chef-comptable')).json().code).toBe('SEPARATION_OF_DUTIES');
    expect((await env.req('POST', `/v1/tresor/exceptions/${exId}/resolution/approve`, 'u-tresor')).json()).toMatchObject({ status: 'RESOLUE' });
    expect(env.svc.suspense.findOne((s) => s.exceptionId === exId)).toMatchObject({ status: 'OUVERT', amount: { amount: '500.00' } });
  });
});

describe('4. Créances sur prestataires non réglées', () => {
  it('balance âgée par prestataire, alerte au-delà de 3 jours, clôture bloquée sans dérogation d’un second comptable', async () => {
    const env = await setupFuites();
    const o = await order(env);
    await callback(env, o.paymentReference);
    const fresh = (await env.req('GET', '/v1/tresor/provider-receivables', 'u-analyste-rappro')).json();
    expect(fresh).toMatchObject({ delayDays: 3, overdue: 0, providers: [expect.objectContaining({ provider: 'mm-operator-a', count: 1 })] });
    env.clock.advanceHours(4 * 24);
    const aged = (await env.req('GET', '/v1/tresor/provider-receivables', 'u-auditeur')).json();
    expect(aged.overdue).toBe(1);
    expect(aged.providers[0].buckets.find((b: { bucket: string }) => b.bucket === '> 3 j')).toMatchObject({ count: 1, amounts: [{ amount: '150.00', currency: 'USD' }] });
    await env.req('GET', '/v1/tresor/provider-receivables', 'u-auditeur');
    expect(env.app.ctx.alerts.alerts.find((a) => a.type === 'PROVIDER_SETTLEMENT_OVERDUE')).toHaveLength(1);
    expect((await env.req('GET', '/v1/tresor/provider-receivables', 'u-contribuable')).statusCode).toBe(403);

    const blocked = await env.req('POST', '/v1/tresor/closures/daily', 'u-tresor', { date: '2026-09-26' });
    expect(blocked.json()).toMatchObject({ code: 'CLOSURE_APPROVAL_REQUIRED', blockers: { overdueProviderReceivables: 1, openMoneyExceptions: 1 } });
    const w = (await env.req('POST', '/v1/tresor/closures/daily/waivers', 'u-tresor', { date: '2026-09-26', motif: 'Relance prestataire en cours, règlement annoncé (test)' })).json();
    expect(w.status).toBe('DEMANDEE');
    expect((await env.req('POST', '/v1/tresor/closures/daily', 'u-tresor', { date: '2026-09-26' })).json().code).toBe('CLOSURE_APPROVAL_REQUIRED');
    expect((await env.req('POST', `/v1/tresor/closures/daily/waivers/${w.id}/approve`, 'u-tresor')).json().code).toBe('SEPARATION_OF_DUTIES');
    expect((await env.req('POST', `/v1/tresor/closures/daily/waivers/${w.id}/approve`, 'tresor-chef-comptable')).json().status).toBe('APPROUVEE');
    const closed = await env.req('POST', '/v1/tresor/closures/daily', 'u-tresor', { date: '2026-09-26' });
    expect(closed.statusCode).toBe(201);
    expect(closed.json().waiver).toMatchObject({ requestedBy: 'u-tresor', approvedBy: 'tresor-chef-comptable', blockers: { overdueProviderReceivables: 1 } });
    expect(env.svc.waivers.get(w.id)).toMatchObject({ status: 'UTILISEE', closureId: 'CLJ-2026-09-26' });
    expect(env.svc.verifyClosures().valid).toBe(true);
    // Dérogation consommée : la journée suivante exige une nouvelle dérogation.
    expect((await env.req('POST', '/v1/tresor/closures/daily', 'u-tresor', { date: '2026-09-27' })).json().code).toBe('CLOSURE_APPROVAL_REQUIRED');
  });
});

describe('5. Contre-écriture d’écritures métier', () => {
  it('refusée sur une écriture de règlement ; un contournement est détecté (écart de cohérence, alerte, plus d’imputation)', async () => {
    const env = await setupFuites();
    const o = await order(env);
    await callback(env, o.paymentReference);
    await statement(env, [line(o.paymentReference)]);
    const settlement = env.app.ctx.ledger.list({ sourceId: o.paymentOrderId }).find((e) => e.eventType === 'SETTLEMENT_CREDITED')!;
    expect((await op(env, { kind: 'CONTRE_ECRITURE', ledgerEntryId: settlement.id, reason: 'Masquer la recette (attaque)' })).json().code).toBe('ENTRY_OWNED_BY_BUSINESS_OBJECT');
    for (const e of env.app.ctx.ledger.list().filter((x) => ['obligation', 'suspense'].includes(x.sourceType)).slice(0, 2)) {
      expect((await op(env, { kind: 'CONTRE_ECRITURE', ledgerEntryId: e.id, reason: 'Écriture métier (attaque)' })).json().code).toBe('ENTRY_OWNED_BY_BUSINESS_OBJECT');
    }
    expect((await env.req('GET', '/v1/tresor/overview', 'u-tresor')).json().consistency).toMatchObject({ consistent: true });
    // Contournement simulé (écriture contrepassée hors circuit) : détecté.
    env.app.ctx.ledger.reverse(settlement.id, 'contournement', { kind: 'system', id: 'test' });
    const ov = (await env.req('GET', '/v1/tresor/overview', 'u-tresor')).json();
    expect(ov.consistency.consistent).toBe(false);
    expect(ov.consistency.gaps.map((g: { check: string }) => g.check)).toEqual(expect.arrayContaining(['RAPPROCHE_SANS_ECRITURE_REGLEMENT', 'CREANCES_PRESTATAIRES_VS_PAIEMENTS']));
    expect(env.app.ctx.alerts.alerts.find((a) => a.type === 'LEDGER_DOMAIN_GAP').length).toBeGreaterThanOrEqual(2);
    // L'écriture contrepassée ne justifie plus d'imputation.
    const run = (await env.req('POST', '/v1/tresor/imputations/run', 'u-tresor')).json();
    expect(run.imputed).toHaveLength(0);
    expect(run.unmapped).toEqual([expect.objectContaining({ paymentReference: o.paymentReference })]);
  });
});

describe('6. Restitution vers l’instrument d’origine seulement', () => {
  it('origine inconnue ⇒ refus ; au-delà du seuil (paramètre démo) : trois personnes distinctes, preuve d’exécution', async () => {
    const env = await setupFuites();
    // Crédit orphelin sans contrepartie : aucune restitution possible (destination invérifiable).
    const ex1 = (await statement(env, [line('PR-INCONNUE-1', '20.00')])).json().exceptions[0].id as string;
    await work(env, ex1, { outcome: 'RESOLUE', motif: 'Crédit non identifié (test)', action: 'MISE_EN_SUSPENS' });
    await env.req('POST', `/v1/tresor/exceptions/${ex1}/resolution/approve`, 'tresor-chef-comptable');
    const s1 = env.svc.suspense.findOne((s) => s.exceptionId === ex1)!;
    expect((await op(env, { kind: 'APUREMENT_SUSPENS', suspenseId: s1.id, mode: 'RESTITUTION', destination: sha256Hex('compte-complice'), reason: 'Restitution vers un compte saisi (attaque)' })).json().code).toBe('ORIGINAL_INSTRUMENT_UNKNOWN');

    // Crédit de 1 500 USD avec contrepartie : seuil de 1 000 USD atteint.
    const origin = sha256Hex('donneur-ordre-banque');
    const ex2 = (await statement(env, [line('PR-INCONNUE-2', '1500.00', { counterparty: origin })])).json().exceptions[0].id as string;
    await work(env, ex2, { outcome: 'RESOLUE', motif: 'Crédit non identifié (test)', action: 'MISE_EN_SUSPENS' });
    await env.req('POST', `/v1/tresor/exceptions/${ex2}/resolution/approve`, 'tresor-chef-comptable');
    const s2 = env.svc.suspense.findOne((s) => s.exceptionId === ex2)!;
    expect(s2.sourceInstrument).toBe(origin);
    expect((await op(env, { kind: 'APUREMENT_SUSPENS', suspenseId: s2.id, mode: 'RESTITUTION', destination: sha256Hex('compte-complice'), reason: 'Restitution détournée (attaque)' }, 'u-analyste-rappro')).json().code).toBe('DESTINATION_NOT_ORIGINAL_INSTRUMENT');
    const p = (await op(env, { kind: 'APUREMENT_SUSPENS', suspenseId: s2.id, mode: 'RESTITUTION', destination: origin, reason: 'Restitution au donneur d’ordre (test)' }, 'u-analyste-rappro')).json();
    expect(p.requiredApprovals).toBe(2);
    const first = (await approve(env, p.id, 'u-tresor')).json();
    expect(first).toMatchObject({ status: 'PROPOSEE', approvals: [expect.objectContaining({ by: 'u-tresor' })] });
    expect(env.svc.suspense.get(s2.id)!.status).toBe('OUVERT');
    expect((await approve(env, p.id, 'u-tresor', PROOF)).json().code).toBe('SEPARATION_OF_DUTIES');
    expect((await approve(env, p.id, 'tresor-chef-comptable')).json().code).toBe('REFUND_EXECUTION_PROOF_REQUIRED');
    const done = (await approve(env, p.id, 'tresor-chef-comptable', PROOF)).json();
    expect(done).toMatchObject({ status: 'EXECUTEE', result: { approvedBy: ['u-tresor', 'tresor-chef-comptable'], refundReference: PROOF.refundReference } });
    expect(env.svc.suspense.get(s2.id)!.clearing).toMatchObject({ destination: origin, refundReference: PROOF.refundReference, evidenceSha256: PROOF.evidenceSha256 });
  });
});

describe('7. Coffre : veto pendant le refroidissement ; version du compte', () => {
  const proposal = { alias: DEMO.dgipkAlias, bankName: 'Banque Nouvelle', accountNumber: 'CD00 1111 2222 3333', holderName: 'Ville de Kinshasa', reason: 'Changement de banque (test)' };

  it('veto par l’audit pendant les 72 h : le compte ne change jamais ; le proposant ne peut pas « vetoer »', async () => {
    const env = await setupFuites();
    const id = (await env.req('POST', '/v1/beneficiary-accounts/change-requests', 'u-tresor', proposal)).json().id;
    await env.req('POST', `/v1/beneficiary-accounts/change-requests/${id}/approve`, 'u-coffre-1', { outOfBandVerified: true });
    expect((await env.req('POST', `/v1/beneficiary-accounts/change-requests/${id}/approve`, 'u-coffre-2', { outOfBandVerified: true })).json().status).toBe('EN_REFROIDISSEMENT');
    expect((await env.req('POST', `/v1/beneficiary-accounts/change-requests/${id}/veto`, 'u-tresor', { motif: 'Veto par le proposant (refusé)' })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/beneficiary-accounts/change-requests/${id}/veto`, 'u-contribuable', { motif: 'Veto non habilité (refusé)' })).statusCode).toBe(403);
    const v = await env.req('POST', `/v1/beneficiary-accounts/change-requests/${id}/veto`, 'u-auditeur', { motif: 'Rappel hors bande : la banque ne confirme pas.' });
    expect(v.json()).toMatchObject({ status: 'ANNULEE', veto: { by: 'u-auditeur' } });
    env.clock.advanceHours(73);
    expect(env.app.ctx.vault.current(DEMO.dgipkAlias)!.version).toBe(1);
    expect((await env.req('POST', `/v1/beneficiary-accounts/change-requests/${id}/veto`, 'u-coffre-3', { motif: 'Deuxième veto (refusé)' })).json().code).toBe('INVALID_CHANGE_REQUEST_STATE');
    // Un gestionnaire du coffre (autre que le proposant) peut aussi opposer son veto.
    const id2 = (await env.req('POST', '/v1/beneficiary-accounts/change-requests', 'u-tresor', proposal)).json().id;
    expect((await env.req('POST', `/v1/beneficiary-accounts/change-requests/${id2}/veto`, 'u-coffre-3', { motif: 'Demande non documentée par le Trésor.' })).json().status).toBe('ANNULEE');
    expect(env.app.ctx.audit.list({ action: 'beneficiary.change.vetoed' }).total).toBe(2);
  });

  it('crédit reçu après un changement de compte : exception ACCOUNT_VERSION_MISMATCH, rien n’est rapproché', async () => {
    const env = await setupFuites();
    const o = await order(env);
    expect(env.app.ctx.payments.orders.get(o.paymentOrderId)!.beneficiaryAccountVersion).toBe(1);
    await callback(env, o.paymentReference);
    const id = (await env.req('POST', '/v1/beneficiary-accounts/change-requests', 'u-tresor', proposal)).json().id;
    await env.req('POST', `/v1/beneficiary-accounts/change-requests/${id}/approve`, 'u-coffre-1', { outOfBandVerified: true });
    await env.req('POST', `/v1/beneficiary-accounts/change-requests/${id}/approve`, 'u-coffre-2', { outOfBandVerified: true });
    env.clock.advanceHours(73);
    const st = (await statement(env, [line(o.paymentReference)])).json();
    expect(st.matched).toHaveLength(0);
    expect(st.exceptions[0]).toMatchObject({ type: 'ACCOUNT_VERSION_MISMATCH', line: { accountVersion: 2 } });
    expect(env.app.ctx.payments.orders.get(o.paymentOrderId)!.status).toBe('CONFIRME');
  });
});

describe('8. Montants : aucun arrondi aux frontières', () => {
  it('« 149.995 » n’est plus confirmé comme 150.00 (rappel) ni apparié (relevé)', async () => {
    const env = await setupFuites();
    const o = await order(env);
    const cb = await callback(env, o.paymentReference, '149.995');
    expect(cb.statusCode).toBe(422);
    expect(cb.json().code).toBe('AMOUNT_PRECISION');
    expect(env.app.ctx.payments.orders.get(o.paymentOrderId)!.status).toBe('INITIE');
    expect(env.app.ctx.alerts.alerts.find((a) => a.type === 'AMOUNT_PRECISION')).toHaveLength(1);
    expect((await callback(env, o.paymentReference, '150.00')).json().status).toBe('CONFIRME');
    const st = await statement(env, [line(o.paymentReference, '149.995')]);
    expect(st.json().code).toBe('AMOUNT_PRECISION');
    expect(env.app.ctx.payments.orders.get(o.paymentOrderId)!.status).toBe('CONFIRME');
  });
});

describe('9. Clé de signature des clôtures', () => {
  it('MOSOLO_CLOSURE_SIGNING_KEY : les clôtures persistées se vérifient après redémarrage ; clé invalide refusée', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const b64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    expect(loadClosureSigningKey(pem)!.asymmetricKeyType).toBe('ed25519');
    expect(loadClosureSigningKey(b64)!.asymmetricKeyType).toBe('ed25519');
    expect(loadClosureSigningKey(pem.replace(/\n/g, '\\n'))!.asymmetricKeyType).toBe('ed25519');
    expect(loadClosureSigningKey(undefined)).toBeUndefined();
    expect(() => loadClosureSigningKey('pas-une-cle')).toThrow(/MOSOLO_CLOSURE_SIGNING_KEY/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => loadClosureSigningKey(rsa)).toThrow(/Ed25519/);

    const saved = process.env.MOSOLO_CLOSURE_SIGNING_KEY;
    try {
      process.env.MOSOLO_CLOSURE_SIGNING_KEY = pem;
      const a = await setupFuites();
      await a.req('POST', '/v1/tresor/closures/daily', 'u-tresor', { date: '2026-09-26' });
      const persisted = a.svc.daily.all();
      expect(persisted).toHaveLength(1);
      // « Redémarrage » : nouvelle instance, même clé, clôtures restaurées.
      const b = await setupFuites();
      b.svc.daily.restoreSnapshot(persisted);
      expect(b.svc.publicKeyPem()).toBe(a.svc.publicKeyPem());
      expect(b.svc.verifyClosures()).toEqual({ valid: true });
      // Sans clé stable (éphémère), la même restauration ne se vérifie plus.
      delete process.env.MOSOLO_CLOSURE_SIGNING_KEY;
      const c = await setupFuites();
      c.svc.daily.restoreSnapshot(persisted);
      expect(c.svc.verifyClosures().valid).toBe(false);
      process.env.MOSOLO_CLOSURE_SIGNING_KEY = 'pas-une-cle';
      await expect(setupFuites()).rejects.toThrow(/MOSOLO_CLOSURE_SIGNING_KEY/);
    } finally {
      if (saved === undefined) delete process.env.MOSOLO_CLOSURE_SIGNING_KEY;
      else process.env.MOSOLO_CLOSURE_SIGNING_KEY = saved;
    }
  });
});
