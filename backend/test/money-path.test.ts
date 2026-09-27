/**
 * Chemin de l'argent : références expirées et fermées, paiements non affectés (doublon, retard, obligation couverte
 * ou rectifiée) mis en attente pour remboursement, solde restant payable, rectification qui reprend les paiements,
 * remboursement et rejet de réclamation qui rétablissent l'état de l'obligation, contre-écriture à quatre yeux,
 * clôtures quotidiennes dans l'ordre, numérotation et clé de signature des quittances.
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { sha256Hex } from '../src/core/crypto.js';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { defaultSecrets } from '../src/context.js';
import { ManualClock } from '../src/core/clock.js';
import type { User } from '../src/core/auth.js';
import { loadReceiptSigningKey } from '../src/modules/receipts/service.js';
import { tresorPlugin } from '../src/plugins/tresor/plugin.js';
import type { TresorService } from '../src/plugins/tresor/service.js';
import { DEMO } from '../src/seed.js';
import { callbackBody, PROVIDER_SECRET, signedCallback, type TestEnv } from './helpers.js';

async function setupMoney() {
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

type Env = Awaited<ReturnType<typeof setupMoney>>;

const obligationId = (env: Env) => env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;

async function order(env: Env, obl = obligationId(env)) {
  return env.req('POST', `/v1/obligations/${obl}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() });
}

const PAYER = sha256Hex('msisdn-payeur-test');

async function succeed(env: Env, ref: string, amount = '150.00') {
  return (await signedCallback(env, { ...callbackBody(env, ref, { amount, currency: 'USD' }), payerMsisdnHash: PAYER })).json();
}

/** Simulation : un paiement confirmé partiel déjà enregistré (échéance payée, par exemple). */
function confirmedFixture(env: Env, obl: string, amount: string) {
  return env.app.ctx.payments.orders.insert({
    id: `PO-FIXTURE-${randomUUID().slice(0, 6)}`, paymentReference: `PR-FIX-${randomUUID().slice(0, 4)}`, obligationId: obl, taxpayerId: DEMO.taxpayerId,
    channel: 'MOBILE_MONEY', amount: { amount, currency: 'USD' }, indicativeAmount: null, beneficiaryAlias: DEMO.dgipkAlias, expiresAt: '2026-09-28T09:00:00.000Z',
    status: 'CONFIRME', createdBy: 'test', createdAt: env.clock.now().toISOString(), confirmedAt: env.clock.now().toISOString(), ledgerEntryIds: [],
  });
}

async function reconcile(env: Env, paymentReference: string, amount = '150.00') {
  return (await env.req('POST', '/v1/settlements/statements', 'u-tresor', {
    statementId: `REL-${randomUUID().slice(0, 8)}`,
    lines: [{ accountAlias: DEMO.dgipkAlias, amount: { amount, currency: 'USD' }, valueDate: '2026-09-26', paymentReference }],
  })).json();
}

async function approveOp(env: Env, body: Record<string, unknown>, approval: Record<string, unknown> = {}) {
  const op = await env.req('POST', '/v1/tresor/operations', 'u-tresor', body);
  expect(op.statusCode).toBe(201);
  const done = await env.req('POST', `/v1/tresor/operations/${op.json().id}/approve`, 'tresor-chef-comptable', approval);
  expect(done.statusCode).toBe(200);
  return done.json();
}

const REFUND_PROOF = { refundReference: 'RMB-TEST-0001', evidenceSha256: sha256Hex('avis-de-remboursement') };

const attente = (env: Env) => env.app.ctx.ledger.balance().accounts.find((a) => a.account === 'COMPTE_ATTENTE' && a.currency === 'USD')?.balance.amount ?? '0.00';

describe('Références expirées et paiements non affectés', () => {
  it('une nouvelle référence ferme les références expirées ; un paiement tardif n’est jamais confirmé et part en remboursement', async () => {
    const env = await setupMoney();
    const first = (await order(env)).json();
    env.clock.advanceHours(49);
    const second = (await order(env)).json();
    expect(env.app.ctx.payments.orders.get(first.paymentOrderId)).toMatchObject({ status: 'ECHOUE', closedReason: 'REFERENCE_EXPIREE' });
    const late = await succeed(env, first.paymentReference);
    expect(late).toMatchObject({ status: 'NON_AFFECTE', reason: 'REFERENCE_EXPIREE' });
    expect(env.app.ctx.receipts.receipts.count()).toBe(0);
    expect((await succeed(env, second.paymentReference)).status).toBe('CONFIRME');
    expect(env.app.ctx.receipts.receipts.count()).toBe(1);
    // Fonds en attente, exception ouverte dans la file « paiement sans obligation », suspens au Trésor.
    const [u] = env.app.ctx.payments.unappliedPayments.all();
    expect(u).toMatchObject({ reason: 'REFERENCE_EXPIREE', paymentReference: first.paymentReference });
    const ex = (await env.req('GET', '/v1/tresor/exceptions?queue=PAIEMENT_SANS_OBLIGATION', 'u-tresor')).json().items;
    expect(ex.some((e: { id: string; type: string }) => e.id === `EXC-NAFF-${u!.id}` && e.type === 'UNAPPLIED_PAYMENT')).toBe(true);
    expect(env.svc.suspense.findOne((s) => s.unappliedId === u!.id)).toMatchObject({ status: 'OUVERT', ledgerEntryId: u!.ledgerEntryId });
    expect(env.app.ctx.alerts.alerts.find((a) => a.type === 'PAYMENT_UNAPPLIED').length).toBe(1);
    expect(env.app.ctx.ledger.balance().balanced).toBe(true);
  });

  it('référence encore INITIE mais payée après son échéance : aucune confirmation', async () => {
    const env = await setupMoney();
    const o = (await order(env)).json();
    env.clock.advanceHours(49);
    expect(await succeed(env, o.paymentReference)).toMatchObject({ status: 'NON_AFFECTE', reason: 'REFERENCE_EXPIREE' });
    expect(env.app.ctx.payments.orders.get(o.paymentOrderId)!.status).toBe('ECHOUE');
    expect(env.app.ctx.receipts.receipts.count()).toBe(0);
  });

  it('échec du rappel générique non terminal : un succès ultérieur (nouvelle transaction) est confirmé', async () => {
    const env = await setupMoney();
    const o = (await order(env)).json();
    const failed = await signedCallback(env, { ...callbackBody(env, o.paymentReference), status: 'FAILED' });
    expect(failed.json().status).toBe('ECHOUE');
    expect(env.app.ctx.payments.orders.get(o.paymentOrderId)!.status).toBe('INITIE');
    expect((await succeed(env, o.paymentReference)).status).toBe('CONFIRME');
    expect(env.app.ctx.receipts.receipts.count()).toBe(1);
  });

  it('doublon : fonds en compte d’attente, exception, restitution à quatre yeux sans toucher au paiement légitime', async () => {
    const env = await setupMoney();
    const o = (await order(env)).json();
    await succeed(env, o.paymentReference);
    const before = attente(env);
    const dup = await succeed(env, o.paymentReference);
    expect(dup.status).toBe('DOUBLON');
    expect(env.app.ctx.receipts.receipts.count()).toBe(1);
    expect(env.app.ctx.payments.orders.get(o.paymentOrderId)!.status).toBe('CONFIRME');
    const u = env.app.ctx.payments.unappliedPayments.all()[0]!;
    expect(u.reason).toBe('DOUBLON');
    expect(Number(attente(env))).toBe(Number(before) - 150);
    const s = env.svc.suspense.findOne((x) => x.unappliedId === u.id)!;
    // Jamais affecté à un autre paiement : seule la restitution à l'instrument d'origine est possible.
    const aff = await env.req('POST', '/v1/tresor/operations', 'u-tresor', { kind: 'APUREMENT_SUSPENS', suspenseId: s.id, mode: 'AFFECTATION', paymentReference: o.paymentReference, reason: 'Tentative d’affectation (test)' });
    expect(aff.json().code).toBe('UNAPPLIED_PAYMENT_REFUND_ONLY');
    await approveOp(env, { kind: 'APUREMENT_SUSPENS', suspenseId: s.id, mode: 'RESTITUTION', destination: PAYER, reason: 'Doublon restitué au payeur (test)' }, REFUND_PROOF);
    expect(env.svc.suspense.get(s.id)!.status).toBe('APURE');
    expect(attente(env)).toBe(before);
    const ex = (await env.req('GET', '/v1/tresor/exceptions', 'u-tresor')).json().items.find((e: { id: string }) => e.id === `EXC-NAFF-${u.id}`);
    expect(ex.status).toBe('RESOLUE');
    expect(env.app.ctx.payments.orders.get(o.paymentOrderId)!.status).toBe('CONFIRME');
    expect(env.app.ctx.ledger.balance().balanced).toBe(true);
  });
});

describe('Solde restant et initiation concurrente', () => {
  it('le solde restant se paie hors échéancier ; l’ordre porte le solde ; obligation couverte ⇒ refus puis paiement non affecté', async () => {
    const env = await setupMoney();
    const obl = obligationId(env);
    confirmedFixture(env, obl, '50.00');
    const rest = await order(env);
    expect(rest.statusCode).toBe(201);
    expect(rest.json().amount).toEqual({ amount: '100.00', currency: 'USD' });
    // Pendant que la référence du solde est active, un autre paiement couvre l'obligation.
    confirmedFixture(env, obl, '100.00');
    expect(await succeed(env, rest.json().paymentReference, '100.00')).toMatchObject({ status: 'NON_AFFECTE', reason: 'OBLIGATION_SOLDEE' });
    expect((await order(env)).json().code).toBe('OBLIGATION_ALREADY_PAID');
  });

  it('aucune référence tant qu’une intention prestataire est en cours ; jamais deux références actives', async () => {
    const env = await setupMoney();
    const obl = obligationId(env);
    const user = env.app.ctx.users.get('u-contribuable') as User;
    const pending = env.app.ctx.payments.createOrderWithProvider(user, obl, { channel: 'MOBILE_MONEY', provider: 'bitripay' });
    expect(() => env.app.ctx.payments.createOrder(user, obl, { channel: 'MOBILE_MONEY' })).toThrow(/initiation de paiement est déjà en cours/);
    const created = await pending;
    expect(created.providerIntentId).toBeDefined();
    expect(() => env.app.ctx.payments.createOrder(user, obl, { channel: 'MOBILE_MONEY' })).toThrow(/référence active/);
    expect(env.app.ctx.payments.byObligation(obl).filter((o) => o.status === 'INITIE')).toHaveLength(1);
  });
});

describe('Rectification, réclamation et remboursement', () => {
  async function decideAppeal(env: Env, obl: string, decision: 'PARTIELLEMENT_ACCEPTEE' | 'REJETEE', amount?: string) {
    const id = (await env.req('POST', '/v1/appeals', 'u-contribuable', { obligationId: obl, grounds: 'Surface contestée (test).' })).json().id;
    await env.req('POST', `/v1/appeals/${id}/instruct`, 'u-contentieux', { proposal: decision, analysis: 'Analyse (test).', ...(amount ? { proposedAmount: { amount, currency: 'USD' } } : {}) });
    const d = await env.req('POST', `/v1/appeals/${id}/decide`, 'u-decideur', { decision, reason: 'Décision (test)', ...(amount ? { rectifiedAmount: { amount, currency: 'USD' } } : {}) });
    expect(d.statusCode).toBe(200);
    return d.json();
  }

  it('rectification : références de l’originale fermées, paiement tardif non affecté, solde payé sur la rectificative', async () => {
    const env = await setupMoney();
    const obl = obligationId(env);
    const o = (await order(env)).json();
    const d = await decideAppeal(env, obl, 'PARTIELLEMENT_ACCEPTEE', '100.00');
    expect(env.app.ctx.payments.orders.get(o.paymentOrderId)).toMatchObject({ status: 'ECHOUE', closedReason: 'OBLIGATION_REMPLACEE' });
    expect(await succeed(env, o.paymentReference)).toMatchObject({ status: 'NON_AFFECTE', reason: 'OBLIGATION_REMPLACEE' });
    const next = (await order(env, d.rectifyingObligationId)).json();
    expect(next.amount).toEqual({ amount: '100.00', currency: 'USD' });
  });

  it('rectification après paiement : le paiement compte pour la rectificative ; l’originale ANNULEE ne bouge jamais au rapprochement', async () => {
    const env = await setupMoney();
    const obl = obligationId(env);
    const o = (await order(env)).json();
    await succeed(env, o.paymentReference);
    const d = await decideAppeal(env, obl, 'PARTIELLEMENT_ACCEPTEE', '100.00');
    expect(env.app.ctx.assessment.get(d.rectifyingObligationId).status).toBe('SOLDEE');
    expect(env.app.ctx.alerts.alerts.find((a) => a.type === 'OVERPAYMENT_AFTER_RECTIFICATION').length).toBe(1);
    const res = await reconcile(env, o.paymentReference);
    expect(res.matched).toHaveLength(1);
    expect(env.app.ctx.assessment.get(obl).status).toBe('ANNULEE');
    expect(env.app.ctx.assessment.get(d.rectifyingObligationId).status).toBe('SOLDEE');
  });

  it('rejet d’une réclamation : l’obligation payée redevient SOLDEE (jamais EMISE d’office)', async () => {
    const env = await setupMoney();
    const obl = obligationId(env);
    const o = (await order(env)).json();
    await succeed(env, o.paymentReference);
    await decideAppeal(env, obl, 'REJETEE');
    expect(env.app.ctx.assessment.get(obl).status).toBe('SOLDEE');
  });

  it('remboursement approuvé : l’obligation redevient exigible', async () => {
    const env = await setupMoney();
    const obl = obligationId(env);
    const o = (await order(env)).json();
    await succeed(env, o.paymentReference);
    await reconcile(env, o.paymentReference);
    expect(env.app.ctx.assessment.get(obl).status).toBe('SOLDEE');
    await approveOp(env, { kind: 'REMBOURSEMENT', paymentReference: o.paymentReference, destination: PAYER, reason: 'Paiement indu constaté (test)' }, REFUND_PROOF);
    expect(env.app.ctx.assessment.get(obl).status).toBe('EXIGIBLE');
  });
});

describe('Grand livre et clôtures', () => {
  it('contre-écriture par la route : simple proposition, passée seulement après validation par une autre personne', async () => {
    const env = await setupMoney();
    const o = (await order(env)).json();
    await succeed(env, o.paymentReference);
    // L'écriture du paiement appartient à son objet : refus (contrepassation du paiement seulement).
    const owned = env.app.ctx.ledger.list().at(-1)!;
    expect((await env.req('POST', `/v1/ledger/entries/${owned.id}/reversals`, 'u-tresor', { reason: 'Écriture sur une mauvaise pièce (test)' })).json().code).toBe('ENTRY_OWNED_BY_BUSINESS_OBJECT');
    const target = env.app.ctx.ledger.post({
      eventType: 'MANUAL', description: 'Écriture manuelle (test)', sourceType: 'manuel', sourceId: 'MAN-1',
      lines: [{ account: 'COMPTE_PUBLIC_RECETTES', side: 'DEBIT', amount: { amount: '1.00', currency: 'USD' } }, { account: 'RECETTES_CONSTATEES', side: 'CREDIT', amount: { amount: '1.00', currency: 'USD' } }],
    });
    const prop = await env.req('POST', `/v1/ledger/entries/${target.id}/reversals`, 'u-tresor', { reason: 'Écriture sur une mauvaise pièce (test)' });
    expect(prop.statusCode).toBe(202);
    expect(prop.json().operation).toMatchObject({ kind: 'CONTRE_ECRITURE', status: 'PROPOSEE' });
    expect(env.app.ctx.ledger.isReversed(target.id)).toBe(false);
    expect((await env.req('POST', `/v1/tresor/operations/${prop.json().operation.id}/approve`, 'u-tresor', {})).statusCode).toBe(403);
    const done = await env.req('POST', `/v1/tresor/operations/${prop.json().operation.id}/approve`, 'tresor-chef-comptable', {});
    expect(done.json().status).toBe('EXECUTEE');
    expect(env.app.ctx.ledger.isReversed(target.id)).toBe(true);
  });

  it('clôture quotidienne refusée tant qu’une journée antérieure avec écritures reste ouverte', async () => {
    const env = await setupMoney();
    env.clock.advanceHours(24);
    const refused = await env.req('POST', '/v1/tresor/closures/daily', 'u-tresor', { date: '2026-09-27' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'EARLIER_DAY_NOT_CLOSED', date: '2026-09-26' });
    expect((await env.req('POST', '/v1/tresor/closures/daily', 'u-tresor', { date: '2026-09-26' })).statusCode).toBe(201);
    const o = (await order(env)).json();
    await succeed(env, o.paymentReference);
    const d27 = await env.req('POST', '/v1/tresor/closures/daily', 'u-tresor', { date: '2026-09-27' });
    expect(d27.statusCode).toBe(201);
    expect(d27.json().entries).toBeGreaterThan(0);
  });
});

describe('Quittances : numérotation et clé de signature', () => {
  it('le compteur repart au-delà du plus grand numéro restauré ; un numéro n’est jamais réémis', async () => {
    const env = await setupMoney();
    const o = (await order(env)).json();
    const first = await succeed(env, o.paymentReference);
    const r = env.app.ctx.receipts.receipts.all()[0]!;
    // Simulation d'un redémarrage avec persistance : quittance restaurée portant un numéro élevé.
    env.app.ctx.receipts.receipts.restoreSnapshot([r, { ...r, id: 'RCP-RESTAURE', paymentOrderId: 'PO-RESTAURE', number: 'Q-2026-KIN-000000041-0', code: 'Q26KIN0000000410' }]);
    // Nouvelle quittance (remplacement à quatre yeux) : numéro 42.
    const done = await approveOp(env, { kind: 'REMPLACEMENT_QUITTANCE', receipt: first.receiptNumber, reason: 'Mention d’identification à corriger (test)' });
    expect(done.result.replacedBy).toMatch(/^Q-2026-KIN-000000042-\d$/);
    const numbers = env.app.ctx.receipts.receipts.all().map((x) => x.number);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('clé Ed25519 chargée depuis l’environnement (PEM ou base64 PKCS#8) ; clé invalide refusée', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const b64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    const spki = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    for (const raw of [pem, b64, pem.replace(/\n/g, '\\n')]) {
      const k = loadReceiptSigningKey(raw)!;
      expect(k.asymmetricKeyType).toBe('ed25519');
    }
    expect(loadReceiptSigningKey(undefined)).toBeUndefined();
    expect(loadReceiptSigningKey('  ')).toBeUndefined();
    expect(() => loadReceiptSigningKey('pas-une-cle')).toThrow(/MOSOLO_RECEIPT_SIGNING_KEY/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => loadReceiptSigningKey(rsa)).toThrow(/Ed25519/);
    // Même clé ⇒ même clé publique de vérification après redémarrage.
    const secrets = defaultSecrets({ MOSOLO_DEMO_MODE: 'true', MOSOLO_RECEIPT_SIGNING_KEY: pem } as NodeJS.ProcessEnv);
    const app = buildApp({ clock: new ManualClock('2026-09-26T09:00:00.000Z'), plugins: [], secrets });
    expect(app.ctx.receipts.publicKeyPem()).toBe(spki);
    expect(defaultSecrets({ MOSOLO_DEMO_MODE: 'true' } as NodeJS.ProcessEnv).receiptSigningKey).toBeUndefined();
  });
});
