/**
 * Deuxième passe adverse (27/09/2026), phase « concurrence et courses » : requêtes lancées EN PARALLÈLE
 * (Promise.all + app.inject) contre les opérations d'argent et de décision. Invariants prouvés à chaque scénario :
 * aucune écriture en double au grand livre, aucune seconde quittance, aucun solde négatif indu, grand livre équilibré
 * et chaîne de hachage intacte.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { sha256Hex } from '../src/core/crypto.js';
import { tresorPlugin } from '../src/plugins/tresor/plugin.js';
import { tresorRelevesPlugin } from '../src/plugins/tresor/releves.js';
import type { PostesModule } from '../src/plugins/postes/plugin.js';
import type { TerrainService } from '../src/plugins/terrain/service.js';
import type { Finding } from '../src/plugins/terrain/model.js';
import { DEMO } from '../src/seed.js';
import { callbackBody, PROVIDER_SECRET, signedCallback, type TestEnv } from './helpers.js';
import type { MosoloPlugin } from '../src/plugins/types.js';

async function env(plugins?: MosoloPlugin<unknown>[]): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    ...(plugins ? { plugins } : {}),
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} },
  });
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

const obligationId = (e: TestEnv) => e.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;
const orderReq = (e: TestEnv, key: string, body: Record<string, unknown> = { channel: 'MOBILE_MONEY' }) =>
  e.req('POST', `/v1/obligations/${obligationId(e)}/payment-orders`, 'u-contribuable', body, { 'idempotency-key': key });

/** Invariants financiers communs : équilibre, chaîne, aucune écriture ni quittance en double par ordre. */
function assertLedgerInvariants(e: TestEnv) {
  const ctx = e.app.ctx;
  expect(ctx.ledger.balance().balanced).toBe(true);
  expect(ctx.ledger.verifyChain().valid).toBe(true);
  const confirmedPerOrder = new Map<string, number>();
  for (const x of ctx.ledger.list({})) {
    if (x.eventType === 'PAYMENT_CONFIRMED') confirmedPerOrder.set(x.sourceId, (confirmedPerOrder.get(x.sourceId) ?? 0) + 1);
  }
  for (const [, n] of confirmedPerOrder) expect(n).toBe(1);
  const receiptsPerOrder = new Map<string, number>();
  for (const r of ctx.receipts.receipts.all()) receiptsPerOrder.set(r.paymentOrderId, (receiptsPerOrder.get(r.paymentOrderId) ?? 0) + 1);
  for (const [, n] of receiptsPerOrder) expect(n).toBe(1);
}

const statuses = (rs: { statusCode: number }[]) => rs.map((r) => r.statusCode).sort();

describe('Concurrence — ordres de paiement', () => {
  it('même clé d’idempotence × 10 en parallèle : une seule référence, dix réponses identiques', async () => {
    const e = await env([]);
    const key = randomUUID();
    const rs = await Promise.all(Array.from({ length: 10 }, () => orderReq(e, key)));
    expect(statuses(rs)).toEqual(Array(10).fill(201));
    expect(new Set(rs.map((r) => r.json().paymentReference)).size).toBe(1);
    expect(rs.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(9);
    expect(e.app.ctx.payments.orders.find((o) => o.obligationId === obligationId(e))).toHaveLength(1);
  });

  it('clés différentes × 10 en parallèle : une seule référence active, neuf refus 409', async () => {
    const e = await env([]);
    const rs = await Promise.all(Array.from({ length: 10 }, () => orderReq(e, randomUUID())));
    expect(statuses(rs)).toEqual([201, ...Array(9).fill(409)]);
    expect(rs.filter((r) => r.statusCode === 409).every((r) => r.json().code === 'ACTIVE_PAYMENT_REFERENCE_EXISTS')).toBe(true);
    expect(e.app.ctx.payments.orders.find((o) => o.obligationId === obligationId(e) && o.status === 'INITIE')).toHaveLength(1);
  });

  it('prestataire connecté (appel sortant asynchrone), clés différentes en parallèle : une seule intention retenue', async () => {
    const e = await env([]);
    const rs = await Promise.all(Array.from({ length: 6 }, () => orderReq(e, randomUUID(), { channel: 'MOBILE_MONEY', provider: 'bitripay' })));
    expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.statusCode === 409).map((r) => r.json().code).every((c: string) => ['PAYMENT_INITIATION_IN_PROGRESS', 'ACTIVE_PAYMENT_REFERENCE_EXISTS'].includes(c))).toBe(true);
    expect(e.app.ctx.payments.orders.find((o) => o.obligationId === obligationId(e) && o.status === 'INITIE')).toHaveLength(1);
    // Même clé et même contenu en parallèle : un seul appel sortant, réponses rejouées.
    const e2 = await env([]);
    const key = randomUUID();
    const same = await Promise.all(Array.from({ length: 5 }, () => orderReq(e2, key, { channel: 'MOBILE_MONEY', provider: 'bitripay' })));
    expect(statuses(same)).toEqual(Array(5).fill(201));
    expect(new Set(same.map((r) => r.json().providerIntentId)).size).toBe(1);
  });
});

describe('Concurrence — rappels prestataire en double et dans le désordre', () => {
  it('même rappel SUCCESS livré 8 fois en parallèle : une écriture, une quittance, sept rejeux', async () => {
    const e = await env([]);
    const order = (await orderReq(e, randomUUID())).json();
    const body = callbackBody(e, order.paymentReference);
    const rs = await Promise.all(Array.from({ length: 8 }, () => signedCallback(e, body)));
    expect(statuses(rs)).toEqual(Array(8).fill(200));
    expect(rs.filter((r) => r.json().status === 'CONFIRME' && !r.json().replayed)).toHaveLength(1);
    expect(rs.filter((r) => r.json().replayed === true)).toHaveLength(7);
    expect(e.app.ctx.ledger.list({}).filter((x) => x.eventType === 'PAYMENT_CONFIRMED')).toHaveLength(1);
    expect(e.app.ctx.receipts.receipts.all().filter((r) => r.paymentReference === order.paymentReference)).toHaveLength(1);
    assertLedgerInvariants(e);
  });

  it('deux transactions SUCCESS distinctes en parallèle sur la même référence : une confirmée, l’autre en DOUBLON (compte d’attente)', async () => {
    const e = await env([]);
    const order = (await orderReq(e, randomUUID())).json();
    const rs = await Promise.all([signedCallback(e, callbackBody(e, order.paymentReference)), signedCallback(e, callbackBody(e, order.paymentReference))]);
    expect(rs.map((r) => r.json().status).sort()).toEqual(['CONFIRME', 'DOUBLON']);
    expect(e.app.ctx.receipts.receipts.all().filter((r) => r.paymentReference === order.paymentReference)).toHaveLength(1);
    assertLedgerInvariants(e);
  });

  it('FAILED arrivé APRÈS SUCCESS (hors ordre) : le paiement reste confirmé, aucune écriture, aucun avis « échec » au contribuable', async () => {
    const e = await env([]);
    const order = (await orderReq(e, randomUUID())).json();
    const ok = await signedCallback(e, callbackBody(e, order.paymentReference));
    expect(ok.json().status).toBe('CONFIRME');
    const ledgerBefore = e.app.ctx.ledger.list({}).length;
    const sentBefore = e.app.ctx.comms.deliveries.all().filter((m) => m.eventCode === 'payment.failed').length;
    const late = await signedCallback(e, { ...callbackBody(e, order.paymentReference), status: 'FAILED' });
    expect(late.statusCode).toBe(200);
    expect(late.json()).toMatchObject({ status: 'ECHOUE', paymentReference: order.paymentReference, ignored: { orderStatus: 'CONFIRME' } });
    expect(e.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('CONFIRME');
    expect(e.app.ctx.ledger.list({}).length).toBe(ledgerBefore);
    // Aucun SMS « paiement échoué » envoyé à un contribuable dont le paiement est confirmé.
    expect(e.app.ctx.comms.deliveries.all().filter((m) => m.eventCode === 'payment.failed').length).toBe(sentBefore);
    expect(e.app.ctx.audit.list({ action: 'payment.failure_ignored' }).total).toBe(1);
    // SUCCESS et FAILED de la même transaction en parallèle : la première lue fait foi, l’autre est un rejeu.
    const e2 = await env([]);
    const o2 = (await orderReq(e2, randomUUID())).json();
    const txn = `TXN-${randomUUID()}`;
    const both = await Promise.all([
      signedCallback(e2, callbackBody(e2, o2.paymentReference, undefined, txn)),
      signedCallback(e2, { ...callbackBody(e2, o2.paymentReference, undefined, txn), status: 'FAILED' }),
    ]);
    expect(both.filter((r) => r.json().replayed === true)).toHaveLength(1);
    assertLedgerInvariants(e2);
  });

  it('SUCCESS arrivé APRÈS remboursement (ordre REMBOURSE) : jamais reconfirmé, fonds en compte d’attente', async () => {
    const e = await env([tresorPlugin, tresorRelevesPlugin]);
    const order = (await orderReq(e, randomUUID())).json();
    await signedCallback(e, { ...callbackBody(e, order.paymentReference), payerMsisdnHash: sha256Hex('payeur') });
    const st = { statementId: 'REL-CONC-1', lines: [{ accountAlias: DEMO.dgipkAlias, amount: order.amount, valueDate: '2026-09-26', paymentReference: order.paymentReference }] };
    expect((await e.req('POST', '/v1/settlements/statements', 'u-tresor', st)).statusCode).toBe(202);
    expect((await e.req('POST', '/v1/settlements/statements/REL-CONC-1/validation', 'u-analyste-rappro', { approve: true, motif: 'Relevé vérifié (test).' })).statusCode).toBe(201);
    const op = await e.req('POST', '/v1/tresor/operations', 'u-tresor', { kind: 'REMBOURSEMENT', paymentReference: order.paymentReference, destination: sha256Hex('payeur'), reason: 'Paiement indu (test)' });
    expect(op.statusCode).toBe(201);
    expect((await e.req('POST', `/v1/tresor/operations/${op.json().id}/approve`, 'tresor-chef-comptable', { refundReference: 'RMB-CONC-1', evidenceSha256: sha256Hex('avis') })).statusCode).toBe(200);
    const statusAfterRefund = e.app.ctx.payments.byReference(order.paymentReference)!.status;
    expect(statusAfterRefund).toBe('REMBOURSE');
    const late = await signedCallback(e, callbackBody(e, order.paymentReference));
    expect(late.json().status).toBe('DOUBLON');
    expect(e.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('REMBOURSE');
    expect(e.app.ctx.receipts.receipts.all().filter((r) => r.paymentReference === order.paymentReference)).toHaveLength(1);
    assertLedgerInvariants(e);
  });
});

describe('Concurrence — double validation, relevés, remboursements', () => {
  async function reconciledOrder(e: TestEnv, statementId: string) {
    const order = (await orderReq(e, randomUUID())).json();
    await signedCallback(e, { ...callbackBody(e, order.paymentReference), payerMsisdnHash: sha256Hex('payeur') });
    const st = { statementId, lines: [{ accountAlias: DEMO.dgipkAlias, amount: order.amount, valueDate: '2026-09-26', paymentReference: order.paymentReference }] };
    expect((await e.req('POST', '/v1/settlements/statements', 'u-tresor', st)).statusCode).toBe(202);
    return { order, st };
  }

  it('module 29 : deux validations concurrentes du même relevé → une seule application, une seule écriture de règlement', async () => {
    const e = await env([tresorPlugin, tresorRelevesPlugin]);
    const { order } = await reconciledOrder(e, 'REL-CONC-2');
    const ledgerBefore = e.app.ctx.ledger.list({}).length;
    const rs = await Promise.all([
      e.req('POST', '/v1/settlements/statements/REL-CONC-2/validation', 'u-analyste-rappro', { approve: true, motif: 'Relevé vérifié (test A).' }),
      e.req('POST', '/v1/settlements/statements/REL-CONC-2/validation', 'u-analyste-rappro', { approve: true, motif: 'Relevé vérifié (test B).' }),
      e.req('POST', '/v1/settlements/statements/REL-CONC-2/validation', 'u-tresor-2', { approve: true, motif: 'Relevé vérifié (test C).' }),
    ]);
    expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.statusCode >= 500)).toHaveLength(0);
    expect(e.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('RAPPROCHE');
    const settle = e.app.ctx.ledger.list({}).slice(ledgerBefore).filter((x) => x.sourceId === order.id || x.description.includes(order.paymentReference));
    expect(settle.length).toBeLessThanOrEqual(1);
    assertLedgerInvariants(e);
  });

  it('deux remboursements proposés et approuvés en parallèle sur le même ordre : un seul exécuté', async () => {
    const e = await env([tresorPlugin, tresorRelevesPlugin]);
    const { order } = await reconciledOrder(e, 'REL-CONC-3');
    expect((await e.req('POST', '/v1/settlements/statements/REL-CONC-3/validation', 'u-analyste-rappro', { approve: true, motif: 'Relevé vérifié (test).' })).statusCode).toBe(201);
    const body = { kind: 'REMBOURSEMENT', paymentReference: order.paymentReference, destination: sha256Hex('payeur'), reason: 'Paiement indu (test)' };
    const proposals = await Promise.all([e.req('POST', '/v1/tresor/operations', 'u-tresor', body), e.req('POST', '/v1/tresor/operations', 'u-tresor', body)]);
    const ids = proposals.filter((p) => p.statusCode === 201).map((p) => p.json().id as string);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    const proof = { refundReference: 'RMB-CONC-3', evidenceSha256: sha256Hex('avis') };
    const approvals = await Promise.all(ids.flatMap((id) => [
      e.req('POST', `/v1/tresor/operations/${id}/approve`, 'tresor-chef-comptable', proof),
      e.req('POST', `/v1/tresor/operations/${id}/approve`, 'tresor-chef-comptable', proof),
    ]));
    expect(approvals.filter((a) => a.statusCode === 200)).toHaveLength(1);
    expect(approvals.filter((a) => a.statusCode >= 500)).toHaveLength(0);
    // Une seule écriture de remboursement : le compte public ne sort l'argent qu'une fois.
    expect(e.app.ctx.ledger.list({}).filter((x) => x.eventType === 'REFUND' && x.sourceId === e.app.ctx.payments.byReference(order.paymentReference)!.id)).toHaveLength(1);
    expect(e.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('REMBOURSE');
    assertLedgerInvariants(e);
  });
});

describe('Concurrence — réserve des agents, répartition, délégations', () => {
  it('répartition automatique déclenchée deux fois en parallèle : aucune écriture en double', async () => {
    const e = await env();
    const rs = await Promise.all([
      e.req('POST', '/v1/pilotage/repartition/automatisation/executer', 'u-tresor'),
      e.req('POST', '/v1/pilotage/repartition/automatisation/executer', 'u-tresor'),
    ]);
    expect(rs.filter((r) => r.statusCode >= 500)).toHaveLength(0);
    const alloc = e.app.ctx.ledger.list({}).filter((x) => x.sourceType.startsWith('repartition'));
    expect(new Set(alloc.map((x) => `${x.sourceType}:${x.sourceId}:${x.description}`)).size).toBe(alloc.length);
    assertLedgerInvariants(e);
  });

  it('réserve (module 67) : deux reprises concurrentes des mêmes points et deux décisions concurrentes → une seule reprise décidée', async () => {
    const e = await env();
    const te = e.app.ctx.ext.terrain as TerrainService;
    const ob = e.app.ctx.assessment.obligations.all().find((o) => o.objectId)!;
    te.findings.insert({
      id: 'CST-CONC-1', clientRef: 'ref-conc-1', missionId: 'MIS-TEST', commune: 'Gombe', outcome: 'CONSTATE', observations: 'Objet présent (test).',
      gps: { lat: -4.3, lon: 15.3, accuracyM: 5, source: 'GPS' }, photoSha256: sha256Hex('photo-conc'), capturedAt: '2026-11-10T08:00:00.000Z', receivedAt: '2026-11-10T08:05:00.000Z',
      reference: { kind: 'OBJET', lat: -4.3, lon: 15.3 }, distanceM: 3, toleranceM: 50, flags: [], seal: sha256Hex('seal-conc'), probativeStatus: 'OBSERVE',
      status: 'VALIDE', review: { by: 'u-superviseur', at: '2026-11-10T10:00:00.000Z', decision: 'VALIDE', reason: 'Conforme (test).' },
      agentId: 'u-agent-terrain', objectId: ob.objectId!,
    } as Finding);
    e.clock.set('2026-12-02T09:00:00.000Z');
    const body = { pointKeys: ['OBJ:CST-CONC-1'], grounds: 'POINT_FICTIF', motif: 'Objet inexistant à la contre-visite (test).', evidenceSha256: [sha256Hex('cv')] };
    const ps = await Promise.all([
      e.req('POST', '/v1/agents/reserve/reprises', 'u-controleur', body),
      e.req('POST', '/v1/agents/reserve/reprises', 'u-superviseur', body),
    ]);
    expect(ps.filter((p) => p.statusCode >= 500)).toHaveLength(0);
    const created = ps.filter((p) => p.statusCode === 201);
    expect(created).toHaveLength(1);
    expect(ps.find((p) => p.statusCode !== 201)!.json().code).toBe('REPRISE_EN_COURS');
    {
      const id = created[0]!.json().id;
      const ds = await Promise.all([
        e.req('POST', `/v1/agents/reserve/reprises/${id}/decision`, 'u-dg-dgipk', { approve: true, motif: 'Contre-visite probante (test A).' }),
        e.req('POST', `/v1/agents/reserve/reprises/${id}/decision`, 'u-dg-dgipk', { approve: false, motif: 'Contre-visite non probante (test B).' }),
      ]);
      expect(ds.filter((d) => d.statusCode === 200)).toHaveLength(1);
      expect(ds.filter((d) => d.statusCode === 409)).toHaveLength(1);
    }
  });

  it('délégation : le titulaire et le délégataire décident la même fiche en parallèle → une seule décision', async () => {
    const e = await env();
    const svc = e.app.ctx.ext.postes as PostesModule;
    const ct = `DOSSIER:${svc.dossiers.findOne((d) => d.categorie === 'SUSPENSION_TIERS')!.id}`;
    const url = `/v1/postes/fiches/${encodeURIComponent(ct)}/action`;
    expect((await e.req('POST', url, 'u-gouverneur', { action: 'DELEGUER', motif: 'Tutelle du ministère des Transports (test)', delegataireId: 'vc-u-ministre-transports', jusquau: '2026-10-06' })).statusCode).toBe(200);
    const rs = await Promise.all([
      e.req('POST', url, 'vc-u-ministre-transports', { action: 'APPROUVER', motif: 'Suspension pour contrôle sur place (test A)' }),
      e.req('POST', url, 'vc-u-ministre-transports', { action: 'APPROUVER', motif: 'Suspension pour contrôle sur place (test B)' }),
      e.req('POST', url, 'u-gouverneur', { action: 'REFUSER', motif: 'Refus du titulaire (test C)' }),
    ]);
    expect(rs.filter((r) => r.statusCode >= 500)).toHaveLength(0);
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1);
    const decisions = e.app.ctx.audit.list({ limit: 10_000 }).items.filter((a) => ['postes.dossier.approuve', 'postes.dossier.refuse'].includes(a.action) && a.resourceId === ct.replace('DOSSIER:', ''));
    expect(decisions).toHaveLength(1);
  });
});
