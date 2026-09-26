import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { hmacSha256Hex } from '../src/core/crypto.js';
import { canauxPlugin } from '../src/plugins/canaux/plugin.js';
import type { CanauxService } from '../src/plugins/canaux/service.js';
import { integerToFrenchWords, moneyToFrenchWords } from '../src/plugins/canaux/words.js';
import { normalizeReference } from '../src/plugins/canaux/points.js';
import type { TestEnv } from './helpers.js';

const DEMO_CARD = '48217730159'; // préfixe de la carte de démonstration (chiffre de contrôle calculé par le service)

async function setupCanaux() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} },
    plugins: [canauxPlugin],
  });
  await app.ready();
  const env: TestEnv = {
    app, clock,
    req: (method, url, user, body, headers = {}) =>
      app.inject({
        method: method as 'GET', url,
        headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { payload: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
      }),
  };
  const svc = app.ctx.ext.canaux as CanauxService;
  return { env, svc, clock };
}

type Ctx = Awaited<ReturnType<typeof setupCanaux>>;

/** Carte de la personne N0-A de démonstration (Mama Nsimba Kiese). */
function demoCard(c: Ctx): string {
  const card = c.svc.cards.cards.findOne((x) => x.number.startsWith(DEMO_CARD));
  if (!card) throw new Error('carte de démonstration absente');
  return card.number;
}

async function ussd(c: Ctx, msisdn: string, inputs: string[], channel: 'ussd' | 'ivr' = 'ussd') {
  const start = await c.env.req('POST', `/v1/${channel}/sessions`, undefined, { msisdn });
  expect(start.statusCode).toBe(201);
  const screens = [start.json()];
  for (const input of inputs) {
    const r = await c.env.req('POST', `/v1/${channel}/sessions/${start.json().sessionId}/input`, undefined, { input });
    expect(r.statusCode).toBe(200);
    screens.push(r.json());
  }
  return screens;
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    localId: `LOC-${randomUUID()}`, channel: 'DOMICILE', missionId: 'MISSION-T-01', capturedAt: '2026-09-26T08:30:00.000Z',
    gps: { lat: -4.37, lon: 15.35, accuracyM: 8 }, commune: 'Limete', quartier: 'Mombele', landmark: 'Près du marché (test)',
    person: { fullName: 'Personne Test Unique', sex: 'F', birthYear: 1970, language: 'ln' },
    declaredObjects: [{ type: 'COMMERCE', description: 'Étal (déclaré)' }],
    consent: { method: 'VOIX', summaryLanguage: 'ln', summaryAudioVersion: 'resume-ln-v0', summaryReadAt: '2026-09-26T08:25:00.000Z', givenAt: '2026-09-26T08:27:00.000Z', voiceRecordingSha256: 'a'.repeat(64) },
    noPaymentAttested: true,
    ...overrides,
  };
}

async function syncBatch(c: Ctx, records: unknown[], opts: { user?: string; deviceId?: string; key?: string; batchId?: string } = {}) {
  const raw = JSON.stringify({ batchId: opts.batchId ?? `LOT-${randomUUID()}`, deviceId: opts.deviceId ?? 'dev-canaux-enrol-01', createdAt: '2026-09-26T08:59:00.000Z', records });
  return c.env.req('POST', '/v1/assisted-enrolments/batches', opts.user ?? 'canaux-agent-enrol', raw, {
    'x-device-signature': hmacSha256Hex(opts.key ?? 'demo-device-key-canaux-01', raw),
  });
}

/** Référence du circuit commun pour l'obligation restante de la personne N0-A, générée sur présentation de la carte. */
async function cardReference(c: Ctx, point = 'PA-LIMETE-MM01', op = 'canaux-op-limete') {
  const sit = await c.env.req('GET', `/v1/payment-points/${point}/cards/${demoCard(c)}`, op);
  expect(sit.statusCode).toBe(200);
  const ob = sit.json().obligations[0];
  const r = await c.env.req('POST', `/v1/payment-points/${point}/card-references`, op, { cardNumber: demoCard(c), obligationId: ob.obligationId }, { 'idempotency-key': randomUUID() });
  expect(r.statusCode).toBe(201);
  return r.json() as { paymentReference: string; amount: { amount: string; currency: string } };
}

async function collect(c: Ctx, ref: string, point = 'PA-LIMETE-MM01', op = 'canaux-op-limete', key = randomUUID(), body: Record<string, unknown> = { paymentReference: ref }) {
  return c.env.req('POST', `/v1/payment-points/${point}/collections`, op, body, { 'idempotency-key': key });
}

describe('canaux — montants énoncés (SVI)', () => {
  it('énonce les montants en toutes lettres, sans flottant', () => {
    expect(integerToFrenchWords(80n)).toBe('quatre-vingts');
    expect(integerToFrenchWords(71n)).toBe('soixante et onze');
    expect(integerToFrenchWords(200n)).toBe('deux cents');
    expect(integerToFrenchWords(80_000n)).toBe('quatre-vingt mille');
    expect(integerToFrenchWords(1_250_000n)).toBe('un million deux cent cinquante mille');
    expect(moneyToFrenchWords({ amount: '150.00', currency: 'USD' })).toBe('cent cinquante dollars américains');
    expect(moneyToFrenchWords({ amount: '12.50', currency: 'USD' })).toBe('douze dollars américains et cinquante cents');
    expect(moneyToFrenchWords({ amount: '1.00', currency: 'CDF' })).toBe('un franc congolais');
  });

  it('contrôle le caractère de contrôle des références saisies', () => {
    expect(() => normalizeReference('PR-ABCD-EFGH')).toThrow();
  });
});

describe('canaux — USSD et SVI', () => {
  let c: Ctx;
  beforeEach(async () => { c = await setupCanaux(); });

  it('consulte le solde après code secret, sans donnée sensible, et journalise sans jamais le code en clair', async () => {
    const s = await ussd(c, '+243810000001', ['1', '0000', '1234']);
    expect(s[0].text).toContain('1. Mon solde');
    expect(s[0].text).not.toMatch(/Mbuyi|Kalala/);
    expect(s[1].text).toContain('code secret');
    expect(s[2].text).toContain('Code incorrect');
    expect(s[3].text).toContain('obligation(s) à payer');
    expect(s[3].text).toContain('USD 150.00');
    expect(s[3].text).not.toMatch(/Mbuyi|Kalala|KIN-/);
    for (const x of s) expect(x.text.length).toBeLessThanOrEqual(182);
    const journal = await c.env.req('GET', '/v1/channel-sessions', 'u-auditeur');
    expect(journal.statusCode).toBe(200);
    const raw = JSON.stringify(journal.json());
    expect(raw).not.toContain('"1234"');
    expect(raw).not.toContain('"0000"');
    expect(raw).toContain('••••');
    expect(raw).not.toContain('+243810000001');
    expect((await c.env.req('GET', '/v1/channel-sessions', 'u-contribuable')).statusCode).toBe(403);
  });

  it('paie : génère la référence du circuit commun (idempotente pour la même obligation)', async () => {
    const before = c.env.app.ctx.payments.orders.count();
    const s = await ussd(c, '+243810000001', ['2', '1234', '1', '1']);
    const done = s[4];
    expect(done.end).toBe(true);
    const ref = /Référence (PR-[0-9A-Z]{4}-[0-9A-Z]{4})/.exec(done.text)?.[1];
    expect(ref).toBeDefined();
    const order = c.env.app.ctx.payments.byReference(ref!)!;
    expect(order.channel).toBe('USSD');
    expect(order.status).toBe('INITIE');
    expect(order.amount).toEqual(c.env.app.ctx.assessment.get(order.obligationId).amount);
    expect(c.env.app.ctx.payments.orders.count()).toBe(before + 1);
    const again = await ussd(c, '+243810000001', ['2', '1234', '1', '1']);
    expect(again[4].text).toContain(ref!);
    expect(c.env.app.ctx.payments.orders.count()).toBe(before + 1);
    expect(done.text).toContain('Aucun agent ne demande');
    const fromBalance = await ussd(c, '+243810000001', ['1', '1234', '2']);
    expect(fromBalance[3].text).toContain('Choisissez l’obligation');
  });

  it('verrouille le canal après trois codes erronés et lève une alerte (sans sanction)', async () => {
    const s = await ussd(c, '+243810000001', ['1', '1111', '2222', '3333']);
    expect(s[4].end).toBe(true);
    expect(s[4].text).toContain('bloqué 15 minutes');
    expect(c.env.app.ctx.alerts.alerts.find((a) => a.type === 'CHANNEL_PIN_LOCKED').length).toBe(1);
    const locked = await ussd(c, '+243810000001', ['1', '1234']);
    expect(locked[2].text).toContain('bloqué');
    c.clock.advance(16 * 60_000);
    const ok = await ussd(c, '+243810000001', ['1', '1234']);
    expect(ok[2].text).toContain('obligation(s)');
  });

  it('SVI : une personne sans téléphone consulte avec sa carte depuis le téléphone d’un proche ; montants lus en lettres', async () => {
    const s = await ussd(c, '+243899999999', ['1', demoCard(c), '2468'], 'ivr');
    expect(s[0].prompts.join(' ')).toContain('tapez 1');
    expect(s[1].prompts.join(' ')).toContain('douze chiffres');
    const last = s[3];
    expect(last.prompts.join(' ')).toContain('dollars américains');
    expect(last.channel).toBe('SVI');
  });

  it('bloque une carte perdue par le SVI ; la carte devient BLOQUÉE', async () => {
    const s = await ussd(c, '+243899999998', ['7', demoCard(c), '2468', '1'], 'ivr');
    expect(s[4].text).toContain('Carte bloquée');
    expect(c.svc.cards.byNumber(demoCard(c))!.status).toBe('BLOQUEE');
  });

  it('vérifie une quittance par USSD et change de langue (traduction signalée à valider)', async () => {
    const code = c.svc.points.collections.all()[0]!.shortCode;
    const s = await ussd(c, '+243811111111', ['3', code]);
    expect(s[2].text).toMatch(/EN ATTENTE|VALIDE/);
    expect(s[2].text).not.toMatch(/Nsimba|Kiese/);
    const l = await ussd(c, '+243811111111', ['6', '2']);
    expect(l[2].lang).toBe('ln');
    expect(l[2].translationPending).toBe(true);
  });

  it('expire une session inactive', async () => {
    const start = await c.env.req('POST', '/v1/ussd/sessions', undefined, { msisdn: '+243810000001' });
    c.clock.advance(4 * 60_000);
    const r = await c.env.req('POST', `/v1/ussd/sessions/${start.json().sessionId}/input`, undefined, { input: '1' });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('SESSION_EXPIRED');
  });

  it('liste les points agréés par commune', async () => {
    const s = await ussd(c, '+243811111112', ['5', '2']);
    expect(s[2].text).toContain('Points agréés Limete');
  });
});

describe('canaux — enrôlement assisté hors ligne', () => {
  let c: Ctx;
  beforeEach(async () => { c = await setupCanaux(); });

  it('AC-INC-02 : compte N0-A, consentement horodaté lié à la mission, carte émise, aucun paiement', async () => {
    const orders = c.env.app.ctx.payments.orders.count();
    const r = await syncBatch(c, [record()]);
    expect(r.statusCode).toBe(200);
    const res = r.json().results[0];
    expect(res.outcome).toBe('CREE');
    const tp = c.env.app.ctx.taxpayers.get(res.taxpayerId);
    expect(tp.verificationLevel).toBe('N0A');
    const card = c.svc.cards.byNumber(res.cardNumber)!;
    expect(card.status).toBe('ACTIVE');
    expect(card.qrToken).not.toContain('Personne');
    const e = c.svc.enrolment.get(res.enrolmentId);
    expect(e.consent.missionId).toBe('MISSION-T-01');
    expect(e.noPaymentAttested).toBe(true);
    expect(c.env.app.ctx.payments.orders.count()).toBe(orders);
    const audit = c.env.app.ctx.audit.list({ limit: 100000 }).items.filter((a) => a.action === 'canaux.enrolment.consent_recorded' && a.resourceId === res.enrolmentId);
    expect(audit.length).toBe(1);
  });

  it('refuse et journalise tout enrôlement sans lecture du résumé, sans consentement, par empreinte non certifiée, hors zone ou hors horaire', async () => {
    const r = await syncBatch(c, [
      record({ consent: { method: 'VOIX', givenAt: '2026-09-26T08:27:00.000Z', voiceRecordingSha256: 'a'.repeat(64) } }),
      record({ consent: { summaryLanguage: 'ln', summaryAudioVersion: 'v0', summaryReadAt: '2026-09-26T08:25:00.000Z' } }),
      record({ consent: { method: 'EMPREINTE', summaryLanguage: 'ln', summaryAudioVersion: 'v0', summaryReadAt: '2026-09-26T08:25:00.000Z', givenAt: '2026-09-26T08:27:00.000Z' } }),
      record({ commune: 'Gombe' }),
      record({ capturedAt: '2026-09-25T20:30:00.000Z' }),
      record({ noPaymentAttested: false }),
      record({ consent: { method: 'TEMOIN', summaryLanguage: 'ln', summaryAudioVersion: 'v0', summaryReadAt: '2026-09-26T08:25:00.000Z', givenAt: '2026-09-26T08:27:00.000Z' } }),
    ]);
    const reasons = r.json().results.map((x: { reason: string }) => x.reason);
    expect(reasons).toEqual(['SUMMARY_NOT_READ', 'CONSENT_REQUIRED', 'CONSENT_METHOD_NOT_CERTIFIED', 'OUT_OF_TERRITORY', 'OUT_OF_HOURS', 'NO_PAYMENT_ATTESTATION_MISSING', 'WITNESS_MISSING']);
    const denied = c.env.app.ctx.audit.list({ limit: 100000 }).items.filter((a) => a.action === 'canaux.enrolment.attempt_rejected' && a.outcome === 'DENIED');
    expect(denied.length).toBe(7);
  });

  it('exige un terminal enrôlé, affecté à l’agent, et une signature valide ; rejeu idempotent', async () => {
    const bad = await syncBatch(c, [record()], { key: 'mauvaise-cle' });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe('INVALID_DEVICE_SIGNATURE');
    const other = await syncBatch(c, [record()], { deviceId: 'dev-terrain-001', key: 'demo-device-key-001' });
    expect(other.statusCode).toBe(403);
    expect(other.json().code).toBe('DEVICE_USER_MISMATCH');
    const revoked = await syncBatch(c, [record()], { user: 'u-agent-terrain', deviceId: 'dev-terrain-perdu', key: 'demo-device-key-perdu' });
    expect(revoked.json().code).toBe('DEVICE_REVOKED');
    const forbiddenRole = await syncBatch(c, [record()], { user: 'canaux-op-limete' });
    expect(forbiddenRole.statusCode).toBe(403);
    const batchId = `LOT-${randomUUID()}`;
    const rec = record();
    const first = await syncBatch(c, [rec], { batchId });
    const replay = await syncBatch(c, [rec], { batchId });
    expect(replay.json().replayed).toBe(true);
    expect(replay.json().results[0].taxpayerId).toBe(first.json().results[0].taxpayerId);
    const reused = await syncBatch(c, [rec]);
    expect(reused.json().results[0].replayed).toBe(true);
    expect(c.svc.enrolment.enrolments.find((e) => e.localId === rec.localId).length).toBe(1);
  });

  it('doublon possible : dossier à revoir, décidé par un superviseur distinct (jamais de fusion automatique)', async () => {
    const pending = c.svc.enrolment.enrolments.findOne((e) => e.status === 'A_REVOIR')!;
    expect(pending.duplicateCandidates[0]!.taxpayerId).toBe('TP-DEMO-0001');
    expect(pending.taxpayerId).toBeUndefined();
    const byAgent = await c.env.req('POST', `/v1/assisted-enrolments/${pending.id}/review`, 'canaux-agent-enrol', { decision: 'DISTINCT', motif: 'Personnes différentes, vérifié' });
    expect(byAgent.statusCode).toBe(403);
    const ok = await c.env.req('POST', `/v1/assisted-enrolments/${pending.id}/review`, 'u-superviseur', { decision: 'DISTINCT', motif: 'Homonyme : date de naissance et quartier différents.' });
    expect(ok.statusCode).toBe(200);
    expect(c.svc.enrolment.get(pending.id).status).toBe('CREE');
    expect(c.svc.enrolment.get(pending.id).cardNumber).toBeDefined();
  });

  it('avis à pictogrammes : dû, échéance, lieux de paiement, actions, mentions de doctrine', async () => {
    const tpId = c.svc.cards.byNumber(demoCard(c))!.taxpayerId;
    const r = await c.env.req('GET', `/v1/pictogram-notices/${tpId}`, 'canaux-agent-enrol');
    expect(r.statusCode).toBe(200);
    const n = r.json();
    expect(n.dues.length).toBe(1);
    expect(n.dues[0].pictogram).toBe('PARCELLE');
    expect(n.paymentPlaces.some((p: { kind: string }) => p.kind === 'GUICHET_MOSOLO')).toBe(true);
    expect(n.actions.map((a: { pictogram: string }) => a.pictogram)).toEqual(['PAYER', 'CONTESTER', 'VERIFIER']);
    expect(n.warnings[0].pictogram).toBe('ZERO_ESPECES_AGENT');
    expect(JSON.stringify(n)).not.toContain('Nsimba Kiese');
    expect((await c.env.req('GET', `/v1/pictogram-notices/${tpId}`, 'u-contribuable')).statusCode).toBe(403);
  });
});

describe('canaux — carte MOSOLO', () => {
  let c: Ctx;
  beforeEach(async () => { c = await setupCanaux(); });

  it('vérification minimale du QR, réémission en double validation, ancien QR « carte révoquée »', async () => {
    const card = c.svc.cards.byNumber(demoCard(c))!;
    const v = await c.env.req('GET', `/v1/public/mosolo-cards/verify?t=${encodeURIComponent(card.qrToken)}`);
    expect(v.json().status).toBe('CARTE_VALIDE');
    expect(JSON.stringify(v.json())).not.toMatch(/Nsimba|Kiese|TP-|KIN-/);
    const forged = await c.env.req('GET', `/v1/public/mosolo-cards/verify?t=${encodeURIComponent(card.qrToken.slice(0, -3) + 'AAA')}`);
    expect(forged.json().status).toBe('INVALIDE');
    const req = await c.env.req('POST', `/v1/mosolo-cards/${card.number}/reissue-requests`, 'canaux-guichetier', { motif: 'Carte perdue, déclarée au guichet' });
    expect(req.statusCode).toBe(201);
    const self = await c.env.req('POST', `/v1/mosolo-cards/reissue-requests/${req.json().id}/approve`, 'canaux-guichetier');
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe('SEPARATION_OF_DUTIES');
    const ok = await c.env.req('POST', `/v1/mosolo-cards/reissue-requests/${req.json().id}/approve`, 'canaux-guichetier-2');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().card.number).not.toBe(card.number);
    const old = await c.env.req('GET', `/v1/public/mosolo-cards/verify?t=${encodeURIComponent(card.qrToken)}`);
    expect(old.json().status).toBe('CARTE_REVOQUEE');
  });

  it('blocage au guichet ; le titulaire d’une autre carte ne peut pas la bloquer', async () => {
    const n = demoCard(c);
    expect((await c.env.req('POST', `/v1/mosolo-cards/${n}/block`, 'u-contribuable', { reason: 'test' })).statusCode).toBe(403);
    const r = await c.env.req('POST', `/v1/mosolo-cards/${n}/block`, 'canaux-guichetier', { reason: 'Perte déclarée au guichet' });
    expect(r.json().status).toBe('BLOQUEE');
  });

  it('code secret : 4 chiffres non triviaux, stocké haché', async () => {
    const n = demoCard(c);
    expect((await c.env.req('POST', `/v1/mosolo-cards/${n}/pin`, 'canaux-guichetier', { pin: '1111' })).json().code).toBe('WEAK_PIN');
    const ok = await c.env.req('POST', `/v1/mosolo-cards/${n}/pin`, 'canaux-guichetier', { pin: '8531' });
    expect(ok.json().pinSet).toBe(true);
    expect(JSON.stringify(c.env.app.ctx.audit.list({ limit: 100000 }).items)).not.toContain('"8531"');
  });
});

describe('canaux — points de paiement agréés (R32)', () => {
  let c: Ctx;
  beforeEach(async () => { c = await setupCanaux(); });

  it('liste publique sans opérateur ni plafond ; points suspendus signalés', async () => {
    const r = await c.env.req('GET', '/v1/public/payment-points');
    const pts = r.json().points as Record<string, unknown>[];
    expect(pts.length).toBeGreaterThanOrEqual(6);
    expect(pts.some((p) => p.status === 'SUSPENDU')).toBe(true);
    expect(pts.some((p) => p.id === 'PA-NGALIEMA-TPE01')).toBe(false);
    expect(JSON.stringify(pts)).not.toMatch(/operatorUserIds|limits|canaux-op/);
    expect(r.json().guichets.length).toBe(4);
  });

  it('encaissement : montant lu (non modifiable), confirmation signée du circuit commun, quittance provisoire, reçu imprimable', async () => {
    const ref = await cardReference(c);
    const look = await c.env.req('GET', `/v1/payment-points/PA-LIMETE-MM01/references/${ref.paymentReference}`, 'canaux-op-limete');
    expect(look.json().amountEditable).toBe(false);
    expect(look.json().amount).toEqual(ref.amount);
    expect(JSON.stringify(look.json())).not.toContain('Nsimba');
    // Aucun montant ne peut être transmis par le point.
    const withAmount = await collect(c, ref.paymentReference, undefined, undefined, undefined, { paymentReference: ref.paymentReference, amount: { amount: '1.00', currency: 'USD' } });
    expect(withAmount.statusCode).toBe(400);
    const key = randomUUID();
    const r = await collect(c, ref.paymentReference, undefined, undefined, key);
    expect(r.statusCode).toBe(201);
    const { collection, receipt } = r.json();
    expect(receipt.receiptStatus).toBe('PROVISOIRE');
    expect(receipt.amount).toEqual(ref.amount);
    expect(collection.shortCode).toMatch(/^[0-9A-Z]{6}$/);
    const order = c.env.app.ctx.payments.byReference(ref.paymentReference)!;
    expect(order.status).toBe('CONFIRME');
    expect(order.provider).toBe('point-agree-pa-limete-mm01');
    expect(order.confirmationMethod).toBe('HMAC_CALLBACK');
    const replay = await collect(c, ref.paymentReference, undefined, undefined, key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json().collection.id).toBe(collection.id);
    const twice = await collect(c, ref.paymentReference);
    expect(twice.statusCode).toBe(409);
    expect(twice.json().code).toBe('REFERENCE_NOT_PAYABLE');
    expect(c.env.app.ctx.receipts.receipts.find((x) => x.paymentReference === ref.paymentReference).length).toBe(1);
    const p1 = await c.env.req('POST', `/v1/payment-points/PA-LIMETE-MM01/collections/${collection.id}/print`, 'canaux-op-limete');
    expect(p1.json().duplicata).toBe(false);
    const p2 = await c.env.req('POST', `/v1/payment-points/PA-LIMETE-MM01/collections/${collection.id}/print`, 'canaux-op-limete');
    expect(p2.json().duplicata).toBe(true);
    expect(p2.json().receiptNumber).toBe(receipt.receiptNumber);
  });

  it('refuse l’encaissement par un agent public, par l’opérateur d’un autre point, et par un point suspendu', async () => {
    const ref = await cardReference(c);
    const agent = await collect(c, ref.paymentReference, 'PA-LIMETE-MM01', 'u-agent-terrain');
    expect(agent.statusCode).toBe(403);
    const guichet = await collect(c, ref.paymentReference, 'PA-LIMETE-MM01', 'u-guichet');
    expect(guichet.statusCode).toBe(403);
    const other = await collect(c, ref.paymentReference, 'PA-LIMETE-MM01', 'canaux-op-gombe');
    expect(other.json().code).toBe('NOT_POINT_OPERATOR');
    const suspended = await collect(c, ref.paymentReference, 'PA-KALAMU-MM01', 'canaux-op-kalamu');
    expect(suspended.statusCode).toBe(403);
    expect(suspended.json().code).toBe('POINT_NOT_ACTIVE');
    // Même par un rappel signé direct, un point suspendu n'a plus d'habilitation.
    expect(c.env.app.ctx.secrets.providerSecrets['point-agree-pa-kalamu-mm01']).toBeUndefined();
    expect(c.env.app.ctx.payments.byReference(ref.paymentReference)!.status).toBe('INITIE');
  });

  it('vérification par code court (minimale) et limitation anti-énumération', async () => {
    const code = c.svc.points.collections.all()[0]!.shortCode;
    const ok = await c.env.req('GET', `/v1/public/short-codes/${code}`, undefined, undefined, { 'x-forwarded-for': '10.0.0.1' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('EN ATTENTE');
    expect(JSON.stringify(ok.json())).not.toMatch(/Nsimba|Kiese/);
    const hdr = { 'x-forwarded-for': '10.0.0.66' };
    for (const bad of ['AAAAAA', 'ZZZZZZ', '123456', 'QWERTY', 'BCDEFG']) {
      expect((await c.env.req('GET', `/v1/public/short-codes/${bad}`, undefined, undefined, hdr)).statusCode).toBe(200);
    }
    const blocked = await c.env.req('GET', `/v1/public/short-codes/${code}`, undefined, undefined, hdr);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().code).toBe('TOO_MANY_VERIFICATIONS');
    expect(c.env.app.ctx.alerts.alerts.find((a) => a.type === 'SHORT_CODE_ENUMERATION_SUSPECTED').length).toBe(1);
    // Une autre source n'est pas pénalisée.
    expect((await c.env.req('GET', `/v1/public/short-codes/${code}`, undefined, undefined, { 'x-forwarded-for': '10.0.0.2' })).statusCode).toBe(200);
  });

  it('clôture de caisse, versement bancaire au compte public, rapprochement ; écart ⇒ exception et proposition, suspension décidée par le Trésor', async () => {
    const day = '2026-09-26';
    const view = await c.env.req('GET', `/v1/payment-points/PA-LIMETE-MM01/cash-days/${day}`, 'canaux-op-limete');
    const expected = view.json().expected;
    expect(expected.length).toBe(1);
    const close = await c.env.req('POST', `/v1/payment-points/PA-LIMETE-MM01/cash-days/${day}/close`, 'canaux-op-limete', { counted: expected });
    expect(close.json().status).toBe('CLOTUREE');
    // Caisse clôturée : aucun nouvel encaissement ce jour.
    const ref = await cardReference(c);
    expect((await collect(c, ref.paymentReference)).json().code).toBe('CASH_DAY_CLOSED');
    const privateAcc = await c.env.req('POST', `/v1/payment-points/PA-LIMETE-MM01/cash-days/${day}/deposit`, 'canaux-op-limete', {
      bankSlipRef: 'BORD-001', depositedAt: '2026-09-26T15:00:00.000Z', lines: [{ accountAlias: 'COMPTE-PRIVE-X', amount: expected[0] }],
    });
    expect(privateAcc.json().code).toBe('NOT_A_PUBLIC_ACCOUNT');
    const alias = view.json().expectedByAccount[0].accountAlias;
    const short = await c.env.req('POST', `/v1/payment-points/PA-LIMETE-MM01/cash-days/${day}/deposit`, 'canaux-op-limete', {
      bankSlipRef: 'BORD-002', depositedAt: '2026-09-26T15:00:00.000Z', lines: [{ accountAlias: alias, amount: { amount: '1.00', currency: 'USD' } }],
    });
    expect(short.json().status).toBe('ECART');
    expect(short.json().exceptions[0].type).toBe('ECART_VERSEMENT');
    const sup = await c.env.req('GET', '/v1/payment-points', 'u-tresor');
    const prop = sup.json().proposals.find((p: { pointId: string; status: string }) => p.pointId === 'PA-LIMETE-MM01' && p.status === 'PROPOSEE');
    expect(prop).toBeDefined();
    // Jamais de suspension automatique.
    expect(c.svc.points.get('PA-LIMETE-MM01').status).toBe('ACTIF');
    expect((await c.env.req('POST', '/v1/payment-points/PA-LIMETE-MM01/suspend', 'canaux-op-limete', { motif: 'tentative par le point lui-même' })).statusCode).toBe(403);
    expect((await c.env.req('POST', '/v1/payment-points/PA-LIMETE-MM01/suspend', 'u-tresor', { motif: 'court' })).statusCode).toBe(400);
    const decided = await c.env.req('POST', '/v1/payment-points/PA-LIMETE-MM01/suspend', 'u-tresor', { motif: 'Écart de versement non justifié après contact du point.', proposalId: prop.id });
    expect(decided.json().status).toBe('SUSPENDU');
    expect(c.svc.points.proposals.get(prop.id)!.status).toBe('DECIDEE_SUSPENSION');
    expect(c.env.app.ctx.audit.list({ limit: 100000 }).items.some((a) => a.action === 'canaux.point.suspended' && a.actor.id === 'u-tresor')).toBe(true);
  });

  it('versement concordant puis relevé du compte public : encaissement rapproché, quittance définitive', async () => {
    const day = '2026-09-26';
    const view = (await c.env.req('GET', `/v1/payment-points/PA-LIMETE-MM01/cash-days/${day}`, 'canaux-op-limete')).json();
    await c.env.req('POST', `/v1/payment-points/PA-LIMETE-MM01/cash-days/${day}/close`, 'canaux-op-limete', { counted: view.expected });
    const dep = await c.env.req('POST', `/v1/payment-points/PA-LIMETE-MM01/cash-days/${day}/deposit`, 'canaux-op-limete', {
      bankSlipRef: 'BORD-003', depositedAt: '2026-09-26T15:00:00.000Z', lines: view.expectedByAccount,
    });
    expect(dep.json().status).toBe('VERSEE');
    const col = view.collections[0];
    const order = c.env.app.ctx.payments.byReference(col.paymentReference)!;
    c.env.app.ctx.treasury.importStatement(c.env.app.ctx.users.get('u-tresor')!, {
      statementId: 'REL-TEST-001', lines: [{ accountAlias: order.beneficiaryAlias, amount: order.amount, valueDate: day, paymentReference: order.paymentReference }],
    });
    const after = (await c.env.req('GET', `/v1/payment-points/PA-LIMETE-MM01/cash-days/${day}`, 'u-analyste-rappro')).json();
    expect(after.reconciledCount).toBe(1);
    expect(after.collections[0].receiptStatus).toBe('DEFINITIVE');
  });

  it('versement manquant au-delà du délai : exception et proposition, point toujours actif', async () => {
    c.clock.advanceHours(72);
    const sup = await c.env.req('GET', '/v1/payment-points', 'u-tresor');
    expect(sup.json().exceptions.some((e: { type: string; pointId: string }) => e.type === 'VERSEMENT_EN_RETARD' && e.pointId === 'PA-LIMETE-MM01')).toBe(true);
    expect(c.svc.points.get('PA-LIMETE-MM01').status).toBe('ACTIF');
  });

  it('registre : référencement avec agrément, activation par une seconde personne du Trésor', async () => {
    const body = {
      name: 'Agent monnaie mobile — test', type: 'AGENT_MONNAIE_MOBILE', operator: 'Opérateur A (démo)',
      approval: { authority: 'Opérateur A', reference: 'AGR-T-1', grantedOn: '2026-09-01' }, commune: 'Kalamu', quartier: 'Matonge',
      address: 'Avenue test', lat: -4.33, lon: 15.31, hours: '8 h–18 h',
      limits: { perTransaction: [{ amount: '100.00', currency: 'USD' }], perDay: [{ amount: '1000.00', currency: 'USD' }] },
      settlementDelayHours: 24, operatorUserIds: ['canaux-op-kalamu'],
    };
    expect((await c.env.req('POST', '/v1/payment-points', 'canaux-op-kalamu', body)).statusCode).toBe(403);
    expect((await c.env.req('POST', '/v1/payment-points', 'u-tresor', { ...body, operatorUserIds: ['u-agent-terrain'] })).json().code).toBe('OPERATOR_NOT_R32');
    const created = await c.env.req('POST', '/v1/payment-points', 'u-tresor', body);
    expect(created.json().status).toBe('REFERENCE');
    const id = created.json().id;
    expect((await c.env.req('POST', `/v1/payment-points/${id}/activate`, 'u-tresor')).json().code).toBe('SEPARATION_OF_DUTIES');
    expect((await c.env.req('POST', `/v1/payment-points/${id}/activate`, 'canaux-tresor-2')).json().status).toBe('ACTIF');
  });

  it('indicateurs d’inclusion agrégés', async () => {
    const r = await c.env.req('GET', '/v1/channels/indicators', 'u-gouverneur');
    expect(r.statusCode).toBe(200);
    expect(r.json().points.pilotCommunesWithBankDesk).toBe(4);
    expect(r.json().cards.active).toBeGreaterThanOrEqual(1);
    expect((await c.env.req('GET', '/v1/channels/indicators', 'u-contribuable')).statusCode).toBe(403);
  });
});
