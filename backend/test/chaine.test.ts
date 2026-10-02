/**
 * Sept questions et chaîne opératoire (Cahier v2.9 § 3) : réponses sourcées par objet et par obligation, treize
 * maillons horodatés et référencés dans le journal chaîné, habilitations (territoire, accès minimal, dossier propre),
 * refus de chaque saut de maillon par l'API publique et détection d'enregistrements forgés directement en dépôt.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import type { Receipt } from '../src/modules/receipts/service.js';
import { scanRuptures } from '../src/plugins/chaine/invariants.js';
import { callbackBody, DEMO, PROVIDER_SECRET, publishCertifiedRule, signedCallback, type TestEnv, postStatement } from './helpers.js';

async function full(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} } });
  await app.ready();
  const req: TestEnv['req'] = (method, url, user, body, headers = {}) =>
    app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  return { app, clock, req };
}

const parcelObligation = (env: TestEnv) => env.app.ctx.assessment.obligations.find((o) => o.objectId === DEMO.parcelId && !o.supersededBy)[0]!;
type Link = { code: string; status: string; at: string | null; auditEventId: string | null; chainHash: string | null; reason?: string; rupture?: boolean };
const link = (body: { chaine: { maillons: Link[] } }, code: string) => body.chaine.maillons.find((m) => m.code === code)!;
const question = (body: { questions: { code: string; status: string; sources: Record<string, unknown> }[] }, code: string) => body.questions.find((q) => q.code === code)!;

/** Référence de paiement émise par l'API publique ; renvoie l'ordre enregistré. */
async function newOrder(env: TestEnv, obligationId: string) {
  const r = await env.req('POST', `/v1/obligations/${obligationId}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() });
  expect(r.statusCode).toBe(201);
  return env.app.ctx.payments.byReference(r.json().paymentReference)!;
}

async function pay(env: TestEnv) {
  const ob = parcelObligation(env);
  const order = await newOrder(env, ob.id);
  const cb = await signedCallback(env, callbackBody(env, order.paymentReference, ob.amount));
  expect(cb.statusCode).toBe(200);
  return { ob, order };
}

async function reconcile(env: TestEnv, paymentReference: string, amount: { amount: string; currency: string }) {
  const r = await postStatement(env, 'u-tresor', {
    statementId: `REL-${randomUUID().slice(0, 8)}`,
    lines: [{ accountAlias: DEMO.dgipkAlias, amount, valueDate: '2026-09-26', paymentReference }],
  });
  expect(r.statusCode).toBeLessThan(300);
  return r.json();
}

describe('Sept questions : réponses sourcées pour chaque objet et chaque obligation', () => {
  it('le contribuable voit ses sept réponses et les treize maillons, chacun lié au journal chaîné', async () => {
    const env = await full();
    const r = await env.req('GET', `/v1/objects/${DEMO.parcelId}/sept-questions`, 'u-contribuable');
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.access).toBe('full');
    expect(b.questions.map((q: { code: string }) => q.code)).toEqual(['QUI', 'QUOI', 'OU', 'REGLE', 'COMBIEN', 'PAYE', 'COMPTE_PUBLIC']);
    expect(b.chaine.maillons.map((m: Link) => m.code)).toEqual([
      'RECENSER', 'IDENTIFIER', 'GEOLOCALISER', 'QUALIFIER', 'CALCULER', 'NOTIFIER', 'PAYER', 'RAPPROCHER', 'QUITTANCER', 'CONTROLER', 'RECOUVRER', 'AUDITER', 'PLANIFIER',
    ]);
    // Sources : compte unique, IGF, précision, règle + version + texte, décomposition du montant.
    expect(question(b, 'QUI').sources.taxpayerId).toBe(DEMO.taxpayerId);
    expect(question(b, 'QUOI').sources.igfCode).toMatch(/^KIN-/);
    expect(question(b, 'OU').sources).toMatchObject({ commune: 'Limete' });
    expect((question(b, 'OU').sources.precision as { source: string }).source).toMatch(/CONSTAT_TERRAIN|DECLARATION/);
    const rules = question(b, 'REGLE').sources.rules as { code: string; version: number; legalReferences: { id: string }[]; textInForce: boolean }[];
    expect(rules[0]).toMatchObject({ code: DEMO.demoRuleCode, version: 1, textInForce: true });
    expect(rules[0]!.legalReferences.length).toBeGreaterThan(0);
    expect((question(b, 'COMBIEN').sources.breakdown as unknown[]).length).toBe(1);
    expect(question(b, 'PAYE').sources.status).toBe('NON_PAYE');
    // Maillons accomplis : horodatés, événement d'audit et empreinte de chaîne.
    for (const code of ['RECENSER', 'QUALIFIER', 'CALCULER']) {
      const m = link(b, code);
      expect(m.status, code).toBe('FAIT');
      expect(m.at).toBeTruthy();
      expect(m.auditEventId).toMatch(/^AUD-/);
      expect(m.chainHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(link(b, 'PAYER').status).toBe('EN_ATTENTE');
    expect(link(b, 'QUITTANCER').status).toBe('EN_ATTENTE');
    expect(link(b, 'AUDITER').status).toBe('FAIT');
    expect(b.chaine.ruptures).toBe(0);
    // La consultation est journalisée, hors chronologie métier du dossier.
    expect(env.app.ctx.audit.list({ action: 'chaine.sept_questions.viewed' }).total).toBe(1);
  });

  it('paiement confirmé puis rapproché : PAYER, RAPPROCHER, QUITTANCER (définitive), PLANIFIER accomplis ; fonds arrivés et comptabilisés', async () => {
    const env = await full();
    const { ob, order } = await pay(env);
    let b = (await env.req('GET', `/v1/obligations/${ob.id}/chaine`, 'u-contribuable')).json();
    expect(link(b, 'PAYER').status).toBe('FAIT');
    expect(link(b, 'RAPPROCHER').status).toBe('EN_ATTENTE');
    expect(link(b, 'QUITTANCER').status).toBe('EN_ATTENTE');
    const pending = question(b, 'COMPTE_PUBLIC').sources.payments as { receipt: { level: string } }[];
    expect(pending[0]!.receipt.level).toBe('PROVISOIRE');

    await reconcile(env, order.paymentReference, ob.amount);
    b = (await env.req('GET', `/v1/obligations/${ob.id}/chaine`, 'u-contribuable')).json();
    for (const code of ['PAYER', 'RAPPROCHER', 'QUITTANCER', 'PLANIFIER', 'AUDITER']) expect(link(b, code).status, code).toBe('FAIT');
    expect(link(b, 'RECOUVRER').status).toBe('SANS_OBJET');
    expect(question(b, 'PAYE').sources.status).toBe('PAYE');
    const cp = question(b, 'COMPTE_PUBLIC');
    expect(cp.status).toBe('REPONDU');
    expect(cp.sources.status).toBe('ARRIVE_ET_COMPTABILISE');
    const settled = (cp.sources.payments as { reconciled: boolean; postedToLedger: boolean; receipt: { level: string }; ledger: { eventType: string; hash: string }[] }[])[0]!;
    expect(settled).toMatchObject({ reconciled: true, postedToLedger: true, receipt: { level: 'DEFINITIVE' } });
    expect(settled.ledger.some((e) => e.eventType === 'SETTLEMENT_CREDITED' && /^[0-9a-f]{64}$/.test(e.hash))).toBe(true);
    expect(b.chaine.complete).toBe(true);
  });

  it('habilitations : agent de terrain en accès minimal (ni nom ni montant), hors secteur et tiers refusés', async () => {
    const env = await full();
    await pay(env);
    const m = await env.req('GET', `/v1/objects/${DEMO.parcelId}/sept-questions`, 'u-agent-terrain');
    expect(m.statusCode).toBe(200);
    const b = m.json();
    expect(b.access).toBe('minimal');
    expect(question(b, 'QUI').status).toBe('MASQUE');
    expect(question(b, 'QUI').sources.name).toBeNull();
    expect(question(b, 'COMBIEN').status).toBe('MASQUE');
    expect(question(b, 'COMBIEN').sources.breakdown).toEqual([]);
    expect(JSON.stringify(b)).not.toContain('Mbuyi');
    expect(JSON.stringify(b)).not.toMatch(/"amount":"150/);
    for (const [user, url] of [
      ['u-agent-gombe', `/v1/objects/${DEMO.parcelId}/sept-questions`],
      ['u-locataire', `/v1/objects/${DEMO.parcelId}/sept-questions`],
      ['u-locataire', `/v1/obligations/${parcelObligation(env).id}/chaine`],
    ] as const) {
      expect((await env.req('GET', url, user)).statusCode, `${user} ${url}`).toBe(403);
    }
    expect((await env.req('GET', `/v1/objects/${DEMO.parcelId}/sept-questions`)).statusCode).toBe(401);
  });
});

describe('Aucun maillon ne peut être sauté : refus par l’API publique', () => {
  it('pas de quittance sans paiement confirmé : rappel non signé refusé, relevé sans confirmation non apparié', async () => {
    const env = await full();
    const ob = parcelObligation(env);
    const order = await newOrder(env, ob.id);
    const forged = await signedCallback(env, callbackBody(env, order.paymentReference, ob.amount), { secret: 'mauvais-secret-de-test' });
    expect(forged.statusCode).toBeGreaterThanOrEqual(400);
    await postStatement(env, 'u-tresor', {
      statementId: 'REL-SANS-CONFIRMATION', lines: [{ accountAlias: DEMO.dgipkAlias, amount: ob.amount, valueDate: '2026-09-26', paymentReference: order.paymentReference }],
    });
    expect(env.app.ctx.receipts.byPaymentOrder(order.id)).toBeUndefined();
    expect(env.app.ctx.payments.orders.get(order.id)!.status).toBe('INITIE');
    const b = (await env.req('GET', `/v1/obligations/${ob.id}/chaine`, 'u-contribuable')).json();
    expect(link(b, 'QUITTANCER').status).toBe('EN_ATTENTE');
    expect(link(b, 'RAPPROCHER').status).toBe('EN_ATTENTE');
  });

  it('pas de paiement sans obligation liquidée : obligation inconnue, simulation sans effet, obligation soldée', async () => {
    const env = await full();
    expect((await env.req('POST', '/v1/obligations/OBL-INEXISTANTE/payment-orders', 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).statusCode).toBe(404);
    const sim = await env.req('POST', '/v1/assessments/calculate', 'u-controleur', {
      ruleId: parcelObligation(env).ruleId, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: {}, simulate: true,
    });
    expect(sim.json().obligation ?? null).toBeNull();
    const { ob, order } = await pay(env);
    await reconcile(env, order.paymentReference, ob.amount);
    const again = await env.req('POST', `/v1/obligations/${ob.id}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() });
    expect(again.statusCode).toBe(422);
  });

  it('pas d’obligation sans règle validée : liquidation sur une règle non ACTIVE refusée (journalisée)', async () => {
    const env = await full();
    const { id } = await publishCertifiedRule(env, { code: 'TEST-CHAINE' }, 2);
    expect(env.app.ctx.rules.rules.get(id)!.status).not.toBe('ACTIVE');
    const r = await env.req('POST', '/v1/assessments/calculate', 'u-controleur', {
      ruleId: id, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: { superficie_m2: '100' }, simulate: false,
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('RULE_NOT_EXECUTABLE');
    expect(env.app.ctx.assessment.obligations.find((o) => o.ruleId === id)).toHaveLength(0);
  });

  it('pas de règle sans texte en vigueur : fiche sans référence ou citant un texte inconnu refusée', async () => {
    const env = await full();
    expect((await publishCertifiedRule(env, { code: 'TEST-SANS-TEXTE', legalInstrumentIds: [] }, 0)).create.statusCode).toBe(400);
    const unknown = (await publishCertifiedRule(env, { code: 'TEST-TEXTE-INCONNU', legalInstrumentIds: ['texte-inexistant'] }, 0)).create;
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().code).toBe('UNKNOWN_LEGAL_INSTRUMENT');
    // Après toutes ces tentatives, aucun maillon sauté dans les dépôts.
    expect(scanRuptures(env.app.ctx)).toEqual([]);
  });
});

describe('Contrôle des invariants : enregistrements forgés directement en dépôt', () => {
  it('détecte chaque saut, lève une alerte par rupture (une seule fois), sans effet automatique', async () => {
    const env = await full();
    const ctx = env.app.ctx;
    // Données de démonstration intègres : aucune rupture.
    const clean = await env.req('GET', '/v1/integrite/chaine/ruptures', 'u-auditeur');
    expect(clean.statusCode).toBe(200);
    expect(clean.json().total).toBe(0);

    const ob = parcelObligation(env);
    const order = await newOrder(env, ob.id);
    // 1. Quittance forgée sur un paiement jamais confirmé.
    ctx.receipts.receipts.insert({
      id: 'RCP-FORGEE', number: 'Q-FORGEE-0001', code: 'FORGEE', status: 'PROVISOIRE', paymentOrderId: order.id, paymentReference: order.paymentReference,
      obligationId: ob.id, taxpayerId: ob.taxpayerId, taxpayerRef: 'x', revenueCategory: ob.revenueCategory, administration: ob.entity, beneficiaryAlias: DEMO.dgipkAlias,
      amount: ob.amount, channel: 'MOBILE_MONEY', provider: DEMO.provider, providerTxnId: 'TXN-FORGE', paidAt: ctx.clock.now().toISOString(), issuedAt: ctx.clock.now().toISOString(),
      mention: 'forgée', signature: 'x', signatureAlgorithm: 'Ed25519', qrPayload: 'x', verificationPath: '/x',
    } as Receipt);
    // 2. Paiement confirmé sur une obligation jamais liquidée.
    ctx.payments.orders.insert({
      id: 'PO-FORGE', paymentReference: 'PR-FORGE-0001', obligationId: 'OBL-JAMAIS-LIQUIDEE', taxpayerId: DEMO.taxpayerId, channel: 'MOBILE_MONEY', amount: ob.amount,
      indicativeAmount: null, beneficiaryAlias: DEMO.dgipkAlias, expiresAt: '2026-09-28T09:00:00.000Z', status: 'CONFIRME', createdBy: 'inconnu',
      createdAt: ctx.clock.now().toISOString(), confirmedAt: ctx.clock.now().toISOString(), ledgerEntryIds: [],
    });
    // 3. Obligation forgée sur une règle en brouillon.
    const { id: draftRule } = await publishCertifiedRule(env, { code: 'TEST-BROUILLON' }, 0);
    ctx.assessment.obligations.insert({ ...ob, id: 'OBL-FORGEE-0001', ruleId: draftRule, ruleCode: 'TEST-BROUILLON', trace: { ...ob.trace, ruleStatus: 'BROUILLON', executable: false } });
    // 4. Règle rendue ACTIVE sans texte juridique.
    const demoRule = ctx.rules.rules.get(ob.ruleId)!;
    ctx.rules.rules.insert({ ...demoRule, id: 'rule-forgee-sans-texte', code: 'FORGEE-SANS-TEXTE', legalInstrumentIds: [] });

    const r = await env.req('GET', '/v1/integrite/chaine/ruptures', 'u-auditeur');
    const b = r.json();
    expect(b.automaticEffect).toBe('AUCUN');
    expect(b.counts).toMatchObject({
      QUITTANCE_SANS_PAIEMENT_CONFIRME: 1, PAIEMENT_SANS_OBLIGATION_LIQUIDEE: 1, OBLIGATION_SANS_REGLE_VALIDEE: 1, REGLE_ACTIVE_SANS_TEXTE_EN_VIGUEUR: 1,
    });
    const ids = b.ruptures.map((x: { resourceId: string }) => x.resourceId);
    expect(ids).toEqual(expect.arrayContaining(['RCP-FORGEE', 'PO-FORGE', 'OBL-FORGEE-0001', 'rule-forgee-sans-texte']));
    expect(b.alertsRaised).toBe(4);
    const alerts = ctx.alerts.list().filter((a) => a.type === 'CHAINE_MAILLON_SAUTE');
    expect(alerts).toHaveLength(4);
    expect(alerts.every((a) => a.source === 'chaine-operatoire')).toBe(true);
    // Rejeu : pas de nouvelle alerte ; aucune annulation ni sanction automatique.
    expect((await env.req('GET', '/v1/integrite/chaine/ruptures', 'u-auditeur')).json().alertsRaised).toBe(0);
    expect(ctx.receipts.receipts.get('RCP-FORGEE')).toBeDefined();
    expect(ctx.assessment.obligations.get(ob.id)!.status).toBe(ob.status);

    // La chaîne du dossier signale le maillon bloqué.
    const chain = (await env.req('GET', `/v1/obligations/${ob.id}/chaine`, 'u-contribuable')).json();
    expect(link(chain, 'QUITTANCER').status).toBe('BLOQUE');
    expect(link(chain, 'QUITTANCER').reason).toMatch(/sans paiement confirmé/);
    const forgedOb = (await env.req('GET', '/v1/obligations/OBL-FORGEE-0001/chaine', 'u-contribuable')).json();
    expect(link(forgedOb, 'QUALIFIER').status).toBe('BLOQUE');
    expect(link(forgedOb, 'CALCULER').status).toBe('BLOQUE');
    expect(link(forgedOb, 'AUDITER').status).toBe('BLOQUE');

    // Contrôle réservé à l'audit, à l'anti-fraude et à la sécurité.
    expect((await env.req('GET', '/v1/integrite/chaine/ruptures', 'u-contribuable')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/integrite/chaine/ruptures', 'u-agent-terrain')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/integrite/chaine/ruptures', 'u-enqueteur')).statusCode).toBe(200);
  });
});
