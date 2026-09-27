import { createPublicKey, randomUUID, verify } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { canonicalJson, sha256Hex } from '../src/core/crypto.js';
import { authorize } from '../src/core/policy.js';
import { tresorPlugin } from '../src/plugins/tresor/plugin.js';
import type { TresorService } from '../src/plugins/tresor/service.js';
import { DEMO } from '../src/seed.js';
import { callbackBody, PROVIDER_SECRET, signedCallback, type TestEnv } from './helpers.js';

async function setupTresor() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} },
    plugins: [tresorPlugin],
  });
  await app.ready();
  const env: TestEnv & { svc: TresorService; ip: (method: string, url: string, ip: string) => Promise<LightMyRequestResponse> } = {
    app, clock,
    svc: app.ctx.ext.tresor as TresorService,
    req: (method, url, user, body, headers = {}) =>
      app.inject({
        method: method as 'GET', url,
        headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
      }),
    ip: (method, url, ip) => app.inject({ method: method as 'GET', url, remoteAddress: ip }),
  };
  return env;
}

type Env = Awaited<ReturnType<typeof setupTresor>>;

const obligationId = (env: Env) => env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;

/** Empreinte (fictive) de l'instrument du payeur transmise par le prestataire : seule destination d'un remboursement. */
const PAYER = sha256Hex('msisdn-payeur-test');

/** Paiement de l'obligation de démonstration par le circuit commun (ordre → rappel signé → quittance provisoire). */
async function pay(env: Env) {
  const order = (await env.req('POST', `/v1/obligations/${obligationId(env)}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).json();
  const cb = (await signedCallback(env, { ...callbackBody(env, order.paymentReference), payerMsisdnHash: PAYER })).json();
  return { order, receiptCode: cb.receiptCode as string, receiptNumber: cb.receiptNumber as string };
}

async function reconcile(env: Env, paymentReference: string, amount = '150.00') {
  const res = await env.req('POST', '/v1/settlements/statements', 'u-tresor', {
    statementId: `REL-${randomUUID().slice(0, 8)}`,
    lines: [{ accountAlias: DEMO.dgipkAlias, amount: { amount, currency: 'USD' }, valueDate: '2026-09-26', paymentReference }],
  });
  return res.json();
}

async function propose(env: Env, user: string, body: Record<string, unknown>) {
  return env.req('POST', '/v1/tresor/operations', user, body);
}

describe('Quittances : annulation, remplacement, duplicata (quatre yeux)', () => {
  it('annulation d’une quittance provisoire : proposition, validation par une autre personne, statut public « annulée »', async () => {
    const env = await setupTresor();
    const { order, receiptCode, receiptNumber } = await pay(env);
    // Paiement CONFIRMÉ : sa quittance ne s'annule pas (il compte comme payé) ; seule la contrepassation est admise.
    const confirmed = await propose(env, 'u-guichet', { kind: 'ANNULATION_QUITTANCE', receipt: receiptNumber, reason: 'Paiement déclaré échoué par le prestataire après émission (test)' });
    expect(confirmed.json().code).toBe('PAYMENT_CONFIRMED_USE_REVERSAL');
    // État hérité (paiement déclaré échoué hors circuit) : la quittance provisoire orpheline s'annule à quatre yeux.
    const po = env.app.ctx.payments.orders.get(order.paymentOrderId)!;
    env.app.ctx.payments.orders.update({ ...po, status: 'ECHOUE' });
    // Le contribuable ne propose rien ; le motif est obligatoire.
    expect((await propose(env, 'u-contribuable', { kind: 'ANNULATION_QUITTANCE', receipt: receiptNumber, reason: 'Tentative du contribuable' })).statusCode).toBe(403);
    expect((await propose(env, 'u-guichet', { kind: 'ANNULATION_QUITTANCE', receipt: receiptNumber, reason: 'court' })).statusCode).toBe(400);
    const op = await propose(env, 'u-guichet', { kind: 'ANNULATION_QUITTANCE', receipt: receiptNumber, reason: 'Paiement déclaré échoué par le prestataire après émission (test)' });
    expect(op.statusCode).toBe(201);
    expect(op.json()).toMatchObject({ status: 'PROPOSEE', kind: 'ANNULATION_QUITTANCE' });
    // Deuxième proposition sur la même cible : refusée.
    expect((await propose(env, 'u-tresor', { kind: 'ANNULATION_QUITTANCE', receipt: receiptNumber, reason: 'Proposition concurrente (test)' })).json().code).toBe('OPERATION_ALREADY_PENDING');
    // Le guichet ne valide pas ; l'auteur ne se valide pas lui-même.
    expect((await env.req('POST', `/v1/tresor/operations/${op.json().id}/approve`, 'u-guichet', {})).statusCode).toBe(403);
    const ok = await env.req('POST', `/v1/tresor/operations/${op.json().id}/approve`, 'u-tresor', {});
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'EXECUTEE', decidedBy: 'u-tresor', result: { receiptStatus: 'ANNULEE' } });
    const pub = (await env.req('GET', `/v1/public/receipts/${receiptCode}`)).json();
    expect(pub).toMatchObject({ status: 'CANCELLED', reason: 'Annulée par décision motivée de la régie.' });
    expect(pub.amount).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain('Mbuyi');
    expect((await env.req('POST', `/v1/tresor/operations/${op.json().id}/approve`, 'tresor-chef-comptable', {})).json().code).toBe('OPERATION_ALREADY_DECIDED');
    expect(env.app.ctx.audit.list({ action: 'receipt.cancelled' }).total).toBe(1);
  });

  it('auteur = valideur → refus (séparation des tâches) ; rejet motivé par une autre personne', async () => {
    const env = await setupTresor();
    const { order, receiptNumber } = await pay(env);
    const op = (await propose(env, 'u-tresor', { kind: 'CONTREPASSATION', paymentReference: order.paymentReference, reason: 'Erreur d’émission présumée (test)' })).json();
    const self = await env.req('POST', `/v1/tresor/operations/${op.id}/approve`, 'u-tresor', {});
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe('SEPARATION_OF_DUTIES');
    const rej = await env.req('POST', `/v1/tresor/operations/${op.id}/reject`, 'tresor-chef-comptable', { motif: 'Aucune pièce ne justifie l’annulation.' });
    expect(rej.json()).toMatchObject({ status: 'REJETEE', decisionNote: 'Aucune pièce ne justifie l’annulation.' });
    expect(env.app.ctx.receipts.find(receiptNumber)!.status).toBe('PROVISOIRE');
  });

  it('quittance définitive : pas d’annulation ; remplacement (nouveau numéro, renvoi public) ; duplicata horodaté', async () => {
    const env = await setupTresor();
    const { order, receiptCode, receiptNumber } = await pay(env);
    expect((await reconcile(env, order.paymentReference)).matched).toHaveLength(1);
    const cancel = await propose(env, 'u-tresor', { kind: 'ANNULATION_QUITTANCE', receipt: receiptNumber, reason: 'Tentative d’annuler une définitive (test)' });
    expect(cancel.json().code).toBe('RECEIPT_DEFINITIVE');

    const op = (await propose(env, 'u-tresor', { kind: 'REMPLACEMENT_QUITTANCE', receipt: receiptCode, reason: 'Référence contribuable rectifiée après fusion d’identité (test)' })).json();
    const done = (await env.req('POST', `/v1/tresor/operations/${op.id}/approve`, 'tresor-chef-comptable', { note: 'Pièce de fusion vue' })).json();
    const newNumber = done.result.replacedBy as string;
    expect(newNumber).not.toBe(receiptNumber);
    const old = (await env.req('GET', `/v1/public/receipts/${receiptCode}`)).json();
    expect(old).toMatchObject({ status: 'REPLACED', replacedBy: newNumber });
    const fresh = (await env.req('GET', `/v1/public/receipts/${done.result.replacementCode}`)).json();
    expect(fresh).toMatchObject({ status: 'VALID', replaces: receiptNumber, settlementStatus: 'RECONCILED' });
    // Une seule quittance en vigueur par paiement.
    expect(env.app.ctx.receipts.byPaymentOrder(order.paymentOrderId)!.number).toBe(newNumber);

    // Duplicata : même numéro, mention DUPLICATA, compteur audité ; refusé sur la quittance remplacée.
    expect((await env.req('POST', `/v1/receipts/${receiptNumber}/duplicates`, 'u-contribuable')).json().code).toBe('RECEIPT_NOT_IN_FORCE');
    expect((await env.req('POST', `/v1/receipts/${newNumber}/duplicates`, 'u-locataire')).statusCode).toBe(403);
    const dup = await env.req('POST', `/v1/receipts/${newNumber}/duplicates`, 'u-contribuable');
    expect(dup.statusCode).toBe(201);
    expect(dup.json()).toMatchObject({ duplicateNo: 1, receipt: { number: newNumber, duplicates: 1 } });
    expect(dup.json().mention).toMatch(/^DUPLICATA n° 1/);
    expect(dup.json().qrPayload).toMatch(/\|DUPLICATA-1$/);
    expect((await env.req('GET', `/v1/public/receipts/${done.result.replacementCode}?duplicata=1`)).json()).toMatchObject({ status: 'VALID', duplicate: { duplicateNo: 1, issued: true } });
    // Duplicata jamais délivré → suspect.
    expect((await env.req('GET', `/v1/public/receipts/${done.result.replacementCode}?duplicata=4`)).json().status).toBe('FRAUD_SUSPECTED');
    const view = (await env.req('GET', `/v1/tresor/receipts/${newNumber}`, 'u-tresor')).json();
    expect(view).toMatchObject({ replaces: receiptNumber, duplicates: 1, previous: [{ number: receiptNumber, status: 'REMPLACEE' }] });
  });
});

describe('Contrepassation et remboursement (double validation)', () => {
  it('contrepassation d’un paiement confirmé : contre-écriture liée, paiement CONTREPASSE, quittance « contrepassée », liste de révocation signée', async () => {
    const env = await setupTresor();
    const { order, receiptCode } = await pay(env);
    const op = (await propose(env, 'u-analyste-rappro', { kind: 'CONTREPASSATION', paymentReference: order.paymentReference, reason: 'Opération inversée par le prestataire (fraude carte) — test' })).json();
    expect(op.status).toBe('PROPOSEE');
    const done = await env.req('POST', `/v1/tresor/operations/${op.id}/approve`, 'u-tresor', {});
    expect(done.statusCode).toBe(200);
    expect(done.json().result.reversalEntries).toHaveLength(1);
    expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('CONTREPASSE');
    expect(env.app.ctx.ledger.balance().balanced).toBe(true);
    const pub = (await env.req('GET', `/v1/public/receipts/${receiptCode}`)).json();
    expect(pub).toMatchObject({ status: 'REVERSED', message: 'Quittance non valable (contrepassée).', reason: 'Paiement contrepassé.' });
    // Une seconde contrepassation est refusée.
    expect((await propose(env, 'u-tresor', { kind: 'CONTREPASSATION', paymentReference: order.paymentReference, reason: 'Deuxième tentative de contrepassation' })).json().code).toBe('ALREADY_REVERSED');
    // Liste de révocation pour la vérification hors ligne : signée Ed25519, codes seulement.
    const list = (await env.req('GET', '/v1/public/receipts/revocations')).json();
    expect(list.entries).toEqual([expect.objectContaining({ code: receiptCode, status: 'REVERSED' })]);
    const ok = verify(null, Buffer.from(canonicalJson({ issuedAt: list.issuedAt, entries: list.entries })), createPublicKey(list.publicKeyPem), Buffer.from(list.signature, 'base64url'));
    expect(ok).toBe(true);
    expect(JSON.stringify(list)).not.toContain('Mbuyi');
  });

  it('remboursement : seulement après rapprochement, vers l’instrument d’origine, quittance « remboursée »', async () => {
    const env = await setupTresor();
    const { order, receiptCode } = await pay(env);
    const early = await propose(env, 'u-tresor', { kind: 'REMBOURSEMENT', paymentReference: order.paymentReference, reason: 'Trop-perçu signalé (test)' });
    expect(early.json().code).toBe('INVALID_PAYMENT_TRANSITION');
    await reconcile(env, order.paymentReference);
    // Aucune destination libre : un compte saisi est rejeté par le schéma.
    const withAccount = await propose(env, 'u-tresor', { kind: 'REMBOURSEMENT', paymentReference: order.paymentReference, reason: 'Trop-perçu signalé (test)', destinationAccount: 'CD00 9999' });
    expect(withAccount.statusCode).toBe(400);
    // Destination obligatoire et égale à l'instrument d'origine (empreinte transmise par le prestataire).
    expect((await propose(env, 'u-tresor', { kind: 'REMBOURSEMENT', paymentReference: order.paymentReference, reason: 'Dégrèvement décidé sur réclamation (test)' })).json().code).toBe('DESTINATION_REQUIRED');
    expect((await propose(env, 'u-tresor', { kind: 'REMBOURSEMENT', paymentReference: order.paymentReference, destination: sha256Hex('autre-numero'), reason: 'Dégrèvement décidé sur réclamation (test)' })).json().code).toBe('DESTINATION_NOT_ORIGINAL_INSTRUMENT');
    const op = (await propose(env, 'u-tresor', { kind: 'REMBOURSEMENT', paymentReference: order.paymentReference, destination: PAYER, reason: 'Dégrèvement décidé sur réclamation (test)' })).json();
    // Exécution : référence de remboursement du prestataire et empreinte de la pièce exigées.
    expect((await env.req('POST', `/v1/tresor/operations/${op.id}/approve`, 'tresor-chef-comptable', {})).json().code).toBe('REFUND_EXECUTION_PROOF_REQUIRED');
    const done = (await env.req('POST', `/v1/tresor/operations/${op.id}/approve`, 'tresor-chef-comptable', { refundReference: 'RMB-MM-0001', evidenceSha256: sha256Hex('avis-remboursement') })).json();
    expect(done.result).toMatchObject({ destination: 'INSTRUMENT_ORIGINE', refundReference: 'RMB-MM-0001' });
    expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('REMBOURSE');
    expect(env.app.ctx.ledger.get(done.result.ledgerEntryId)!.eventType).toBe('REFUND');
    expect((await env.req('GET', `/v1/public/receipts/${receiptCode}`)).json().status).toBe('REFUNDED');
    expect(env.app.ctx.ledger.balance().balanced).toBe(true);
  });

  it('contre-écriture en double validation ; l’IA ne peut ni proposer ni valider', async () => {
    const env = await setupTresor();
    await pay(env);
    // L'écriture de confirmation appartient au paiement : jamais contre-passée « à nu ».
    const owned = env.app.ctx.ledger.list().at(-1)!;
    expect((await propose(env, 'u-tresor', { kind: 'CONTRE_ECRITURE', ledgerEntryId: owned.id, reason: 'Écriture passée sur une mauvaise pièce (test)' })).json().code).toBe('ENTRY_OWNED_BY_BUSINESS_OBJECT');
    // Écriture sans objet métier (saisie manuelle) : contre-écriture à quatre yeux.
    const target = env.app.ctx.ledger.post({
      eventType: 'MANUAL', description: 'Écriture manuelle (test)', sourceType: 'manuel', sourceId: 'MAN-1',
      lines: [{ account: 'COMPTE_PUBLIC_RECETTES', side: 'DEBIT', amount: { amount: '1.00', currency: 'USD' } }, { account: 'RECETTES_CONSTATEES', side: 'CREDIT', amount: { amount: '1.00', currency: 'USD' } }],
    });
    const op = (await propose(env, 'u-tresor', { kind: 'CONTRE_ECRITURE', ledgerEntryId: target.id, reason: 'Écriture passée sur une mauvaise pièce (test)' })).json();
    expect(env.app.ctx.ledger.isReversed(target.id)).toBe(false);
    const done = (await env.req('POST', `/v1/tresor/operations/${op.id}/approve`, 'tresor-chef-comptable', {})).json();
    expect(env.app.ctx.ledger.get(done.result.reversalId)!.reversalOf).toBe(target.id);
    for (const action of ['tresor:operation.approve', 'tresor:finance.propose', 'tresor:closure.write'] as const) {
      expect(() => authorize({ kind: 'ai', id: 'ia-rappro', agent: 'Rapprochement' }, action)).toThrow(/IA/);
    }
  });
});

describe('Files d’exception et compte d’attente', () => {
  it('parcours complet : affectation → en cours → justificatif → résolution avec mise en suspens → validation à quatre yeux', async () => {
    const env = await setupTresor();
    const st = await env.req('POST', '/v1/settlements/statements', 'u-tresor', {
      statementId: 'REL-ORPH-01',
      lines: [{ accountAlias: DEMO.dgipkAlias, amount: { amount: '150.00', currency: 'USD' }, valueDate: '2026-09-26', paymentReference: 'PR-INCONNUE-01' }],
    });
    const exId = st.json().exceptions[0].id as string;
    const list = (await env.req('GET', '/v1/tresor/exceptions?queue=REGLEMENT_SANS_PAIEMENT', 'u-analyste-rappro')).json();
    expect(list.items).toEqual([expect.objectContaining({ id: exId, status: 'OUVERTE', queue: 'REGLEMENT_SANS_PAIEMENT', overdue: false })]);
    expect(list.queues).toHaveLength(4);
    expect((await env.req('GET', '/v1/tresor/exceptions', 'u-contribuable')).statusCode).toBe(403);

    expect((await env.req('POST', `/v1/tresor/exceptions/${exId}/assign`, 'u-tresor', { assignee: 'u-contribuable' })).json().code).toBe('ASSIGNEE_NOT_ELIGIBLE');
    expect((await env.req('POST', `/v1/tresor/exceptions/${exId}/assign`, 'u-tresor', { assignee: 'u-analyste-rappro' })).json()).toMatchObject({ assignee: 'u-analyste-rappro' });
    expect((await env.req('POST', `/v1/tresor/exceptions/${exId}/start`, 'tresor-analyste-2')).json().code).toBe('NOT_ASSIGNEE');
    expect((await env.req('POST', `/v1/tresor/exceptions/${exId}/start`, 'u-analyste-rappro')).json().status).toBe('EN_COURS');
    const noEvidence = await env.req('POST', `/v1/tresor/exceptions/${exId}/resolution`, 'u-analyste-rappro', { outcome: 'RESOLUE', motif: 'Crédit non identifié à porter en suspens', action: 'MISE_EN_SUSPENS' });
    expect(noEvidence.json().code).toBe('EVIDENCE_REQUIRED');
    await env.req('POST', `/v1/tresor/exceptions/${exId}/evidence`, 'u-analyste-rappro', { label: 'Réponse du prestataire : aucune transaction (démo)', sha256: sha256Hex('piece') });
    // Crédit constaté : ni classement, ni résolution sans action financière.
    expect((await env.req('POST', `/v1/tresor/exceptions/${exId}/resolution`, 'u-analyste-rappro', { outcome: 'CLASSEE', motif: 'Crédit sans suite (tentative de classement)', action: 'AUCUNE' })).json().code).toBe('MONEY_EXCEPTION_NEEDS_FINANCIAL_ACTION');
    await env.req('POST', `/v1/tresor/exceptions/${exId}/resolution`, 'u-analyste-rappro', { outcome: 'RESOLUE', motif: 'Crédit non identifié à porter en suspens', action: 'MISE_EN_SUSPENS' });
    expect((await env.req('POST', `/v1/tresor/exceptions/${exId}/resolution/approve`, 'u-analyste-rappro')).statusCode).toBe(403);
    // Qui a affecté l'exception ne valide pas sa résolution.
    expect((await env.req('POST', `/v1/tresor/exceptions/${exId}/resolution/approve`, 'u-tresor')).json().code).toBe('SEPARATION_OF_DUTIES');
    const ok = (await env.req('POST', `/v1/tresor/exceptions/${exId}/resolution/approve`, 'tresor-chef-comptable')).json();
    expect(ok).toMatchObject({ status: 'RESOLUE', decision: { approvedBy: 'tresor-chef-comptable' } });
    // La file publique du socle reflète le traitement.
    const core = (await env.req('GET', '/v1/reconciliation/exceptions', 'u-analyste-rappro')).json();
    expect(core.find((e: { id: string }) => e.id === exId).status).toBe('RESOLUE');
    const susp = (await env.req('GET', '/v1/tresor/suspense', 'u-tresor')).json();
    const item = susp.items.find((s: { exceptionId?: string }) => s.exceptionId === exId);
    expect(item).toMatchObject({ status: 'OUVERT', justification: 'Crédit non identifié à porter en suspens', ageDays: 0, bucket: '0-2 j' });
    // Suspens de démonstration daté de 4 jours : ancienneté visible.
    expect(susp.items.find((s: { demo?: boolean }) => s.demo)).toMatchObject({ ageDays: 4, overSla: false });

    // Apurement par affectation à un paiement confirmé du même montant : rapprochement, quittance définitive.
    const { order, receiptCode } = await pay(env);
    const bad = await propose(env, 'u-analyste-rappro', { kind: 'APUREMENT_SUSPENS', suspenseId: susp.items.find((s: { demo?: boolean }) => s.demo).id, mode: 'AFFECTATION', paymentReference: order.paymentReference, reason: 'Affectation au mauvais montant (test)' });
    expect(bad.json().code).toBe('AMOUNT_MISMATCH');
    const op = (await propose(env, 'u-analyste-rappro', { kind: 'APUREMENT_SUSPENS', suspenseId: item.id, mode: 'AFFECTATION', paymentReference: order.paymentReference, reason: 'Le prestataire a identifié la référence du crédit (test)' })).json();
    await env.req('POST', `/v1/tresor/operations/${op.id}/approve`, 'u-tresor', {});
    expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('RAPPROCHE');
    expect((await env.req('GET', `/v1/public/receipts/${receiptCode}`)).json().status).toBe('VALID');
    expect(env.svc.suspense.get(item.id)!.status).toBe('APURE');
    const attente = env.app.ctx.ledger.balance().accounts.find((a) => a.account === 'COMPTE_ATTENTE' && a.currency === 'USD')!;
    expect(attente.balance.amount).toBe('-75.00'); // seul le suspens de démonstration reste
    expect(env.app.ctx.ledger.balance().balanced).toBe(true);
  });

  it('délai de 48 h : exception en retard signalée ; rejet d’une résolution la remet en cours', async () => {
    const env = await setupTresor();
    const st = await env.req('POST', '/v1/settlements/statements', 'u-tresor', {
      statementId: 'REL-ORPH-02',
      lines: [{ accountAlias: DEMO.dgipkAlias, amount: { amount: '10.00', currency: 'USD' }, valueDate: '2026-09-26', paymentReference: 'PR-INCONNUE-02' }],
    });
    const exId = st.json().exceptions[0].id as string;
    env.clock.advanceHours(49);
    const list = (await env.req('GET', '/v1/tresor/exceptions', 'u-tresor')).json();
    expect(list.items.find((e: { id: string }) => e.id === exId)).toMatchObject({ overdue: true, ageHours: 49 });
    expect(env.app.ctx.comms.deliveries.find((d) => d.eventCode === 'reconciliation.exception.aged').length).toBeGreaterThan(0);
    await env.req('POST', `/v1/tresor/exceptions/${exId}/assign`, 'u-analyste-rappro', { assignee: 'u-tresor' });
    await env.req('POST', `/v1/tresor/exceptions/${exId}/start`, 'u-tresor');
    // Un crédit « négligeable » ne se classe pas : il porte de l'argent.
    expect((await env.req('POST', `/v1/tresor/exceptions/${exId}/resolution`, 'u-tresor', { outcome: 'CLASSEE', motif: 'Montant négligeable restitué hors système (test)', action: 'AUCUNE' })).json().code).toBe('MONEY_EXCEPTION_NEEDS_FINANCIAL_ACTION');
    await env.req('POST', `/v1/tresor/exceptions/${exId}/evidence`, 'u-tresor', { label: 'Relevé bancaire (démo)', sha256: sha256Hex('releve') });
    await env.req('POST', `/v1/tresor/exceptions/${exId}/resolution`, 'u-tresor', { outcome: 'RESOLUE', motif: 'Crédit non identifié à porter en suspens (test)', action: 'MISE_EN_SUSPENS' });
    const rej = await env.req('POST', `/v1/tresor/exceptions/${exId}/resolution/reject`, 'tresor-chef-comptable', { motif: 'Le classement exige une pièce de restitution.' });
    expect(rej.json().status).toBe('EN_COURS');
    expect(rej.json().proposal).toBeUndefined();
  });
});

describe('Imputation, clôtures signées et export', () => {
  it('imputation selon la nomenclature (codes DÉMO), clôture quotidienne chaînée, clôture mensuelle, export signé', async () => {
    const env = await setupTresor();
    const { order } = await pay(env);
    await reconcile(env, order.paymentReference);
    // Clôture mensuelle impossible avant clôture des journées et imputation.
    expect((await env.req('POST', '/v1/tresor/closures/monthly', 'u-tresor', { month: '2026-09' })).json().code).toBe('DAYS_NOT_CLOSED');
    const acc0 = (await env.req('GET', '/v1/tresor/accounting', 'u-tresor')).json();
    expect(acc0.rows[0]).toMatchObject({ paymentReference: order.paymentReference, state: 'RAPPROCHE', dayClosed: false });
    const run = (await env.req('POST', '/v1/tresor/imputations/run', 'u-tresor')).json();
    expect(run.imputed[0]).toMatchObject({ code: 'DEMO-IMP-701', demo: true });
    expect((await env.req('POST', '/v1/tresor/imputations/run', 'u-analyste-rappro')).statusCode).toBe(403);

    expect((await env.req('POST', '/v1/tresor/closures/daily', 'u-tresor', { date: '2026-09-28' })).json().code).toBe('CLOSURE_IN_FUTURE');
    const d1 = await env.req('POST', '/v1/tresor/closures/daily', 'u-tresor', { date: '2026-09-26' });
    expect(d1.statusCode).toBe(201);
    expect(d1.json()).toMatchObject({ id: 'CLJ-2026-09-26', balanced: true, prevHash: '0'.repeat(64) });
    expect((await env.req('POST', '/v1/tresor/closures/daily', 'u-tresor', { date: '2026-09-26' })).json().code).toBe('DAY_ALREADY_CLOSED');
    env.clock.advanceHours(24);
    const d2 = (await env.req('POST', '/v1/tresor/closures/daily', 'u-tresor', { date: '2026-09-27' })).json();
    expect(d2.prevHash).toBe(d1.json().hash);
    expect(d2.entries).toBe(0);
    const acc = (await env.req('GET', '/v1/tresor/accounting', 'u-auditeur')).json();
    expect(acc.rows[0]).toMatchObject({ state: 'COMPTABILISE', code: 'DEMO-IMP-701', dayClosed: true });
    const m = await env.req('POST', '/v1/tresor/closures/monthly', 'u-tresor', { month: '2026-09' });
    expect(m.statusCode).toBe(201);
    expect(m.json().dailyClosures).toEqual(['CLJ-2026-09-26', 'CLJ-2026-09-27']);
    const closures = (await env.req('GET', '/v1/tresor/closures', 'u-auditeur')).json();
    expect(closures.chain).toEqual({ valid: true });
    const sigOk = verify(null, Buffer.from(d1.json().hash), createPublicKey(closures.publicKeyPem), Buffer.from(d1.json().signature, 'base64url'));
    expect(sigOk).toBe(true);

    const csv = await env.req('GET', '/v1/tresor/exports?format=csv&from=2026-09-01&to=2026-09-30', 'u-tresor');
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[0]).toMatch(/^date;piece;reference_paiement/);
    expect(csv.body).toContain('DEMO-IMP-701');
    expect(csv.body).not.toContain('Mbuyi');
    expect(csv.headers['x-mosolo-sha256']).toBe(sha256Hex(csv.body));
    const json = (await env.req('GET', '/v1/tresor/exports?format=json', 'u-auditeur')).json();
    expect(json).toMatchObject({ count: 1, demo: true, algorithm: 'Ed25519' });
    expect(json.sha256).toBe(sha256Hex(canonicalJson(json.rows)));
    expect(verify(null, Buffer.from(json.sha256), createPublicKey(json.publicKeyPem), Buffer.from(json.signature, 'base64url'))).toBe(true);
    expect((await env.req('GET', '/v1/tresor/exports', 'u-analyste-rappro')).statusCode).toBe(403);
    expect(env.app.ctx.audit.list({ action: 'treasury.export' }).total).toBe(2);
  });

  it('nomenclature paramétrable par double validation (acte officiel ⇒ code non démo)', async () => {
    const env = await setupTresor();
    const op = (await propose(env, 'u-tresor', {
      kind: 'PARAMETRE_NOMENCLATURE', reason: 'Code transmis par la division de la comptabilité (test)',
      nomenclature: { revenueCategory: 'IMPOT_PROVINCIAL', code: 'TEST-7011', label: 'Impôt foncier (test)', officialAct: 'Arrêté fictif de test n° 1' },
    })).json();
    await env.req('POST', `/v1/tresor/operations/${op.id}/approve`, 'tresor-chef-comptable', {});
    const n = (await env.req('GET', '/v1/tresor/nomenclature', 'u-auditeur')).json();
    expect(n.entries.find((e: { revenueCategory: string }) => e.revenueCategory === 'IMPOT_PROVINCIAL')).toMatchObject({ code: 'TEST-7011', demo: false, approvedBy: 'tresor-chef-comptable' });
    expect(n.entries.filter((e: { demo: boolean }) => e.demo).length).toBeGreaterThan(0);
  });
});

describe('Vérification publique : limitation de débit et journal agrégé', () => {
  it('anti-énumération : codes inconnus limités par client ; chiffre de contrôle ; journal sans identité', async () => {
    const env = await setupTresor();
    const { receiptCode } = await pay(env);
    const bad = receiptCode.slice(0, -1) + String((Number(receiptCode.at(-1)) + 1) % 10);
    expect((await env.ip('GET', `/v1/public/receipts/${bad}`, '10.0.0.9')).json()).toMatchObject({ status: 'UNKNOWN', message: expect.stringContaining('chiffre de contrôle') });
    for (let i = 0; i < 9; i++) await env.ip('GET', `/v1/public/receipts/Q26KIN${String(900000000 + i)}0`, '10.0.0.9');
    const blocked = await env.ip('GET', `/v1/public/receipts/${receiptCode}`, '10.0.0.9');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().code).toBe('VERIFICATION_RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // Un autre client n'est pas affecté.
    expect((await env.ip('GET', `/v1/public/receipts/${receiptCode}`, '10.0.0.10')).json().status).toBe('PENDING');
    env.clock.advanceHours(1);
    expect((await env.ip('GET', `/v1/public/receipts/${receiptCode}`, '10.0.0.9')).statusCode).toBe(200);

    const journal = await env.req('GET', '/v1/tresor/verification-journal', 'u-auditeur');
    expect(journal.statusCode).toBe(200);
    const day = journal.json().days.find((d: { date: string }) => d.date === '2026-09-26');
    expect(day.byStatus).toMatchObject({ THROTTLED: 1, PENDING: 2 });
    expect((day.byStatus.INVALID_CHECK_DIGIT ?? 0) + (day.byStatus.UNKNOWN ?? 0)).toBe(10);
    expect(day.distinctClients).toBe(2);
    expect(journal.body).not.toContain('10.0.0.');
    expect((await env.req('GET', '/v1/tresor/verification-journal', 'u-contribuable')).statusCode).toBe(403);
  });
});
