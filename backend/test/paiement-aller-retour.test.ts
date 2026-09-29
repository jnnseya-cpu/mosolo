/**
 * Aller-retour de paiement par page hébergée (29/09/2026) : MOSOLO → page de paiement du prestataire → retour sur la
 * page MOSOLO « /paiement/retour », aux formes RÉELLES de la documentation publique de BitriPay et KODA (simulateur local).
 * Chaîne vérifiée : intention créée (clé sk_ côté serveur, Idempotency-Key) → checkout_url → payeur sur la page du
 * prestataire → webhook SIGNÉ → vérification serveur à serveur (état + BitriPay GET /payment_resolution) → quittance
 * provisoire → état réel lu par la page de retour (jamais les paramètres de l'URL). Cas : attente ambiguë (revue
 * manuelle, aucune quittance), HTTP 429 + Retry-After, KODA TEST-REPLAY / TEST-SUFFIX / TEST-LATE-90, BitriPay /status
 * dégradé, délai puis succès, prestataire indisponible, refus, annulation.
 */
import { generateKeyPairSync, randomUUID, sign as edSign } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { signBitriPayWebhook } from '../src/modules/payments/connectors/bitripay.js';
import { signKodaWebhook } from '../src/modules/payments/connectors/koda.js';
import { DEMO } from '../src/seed.js';
import { ProviderSimulator } from './simulateur-prestataires.js';

const sim = new ProviderSimulator();
beforeAll(async () => { await sim.start(); });
afterAll(async () => { await sim.stop(); });
beforeEach(() => sim.reset());

// Secrets de test (jamais des valeurs réelles, jamais les secrets publics de démonstration).
const BITRI_KEY = 'sk_test_ALLER_RETOUR_BITRIPAY_0001';
const BITRI_WHSEC = 'whsec_test_aller_retour_bitripay_0001';
const KODA_KEY = 'sk_test_ALLER_RETOUR_KODA_0001';
const KODA_WHSEC = 'whsec_test_aller_retour_koda_0001';
const PUBLIC = 'https://mosolo.kinshasa.cd';

function env(extra: Record<string, string> = {}) {
  return {
    MOSOLO_PUBLIC_URL: PUBLIC,
    BITRIPAY_API_KEY: BITRI_KEY, BITRIPAY_WEBHOOK_SECRET: BITRI_WHSEC, BITRIPAY_BASE_URL: `${sim.base}/bitripay/v1`, BITRIPAY_RETURN_URL_FIELD: 'return_url',
    KODA_API_KEY: KODA_KEY, KODA_WEBHOOK_SECRET: KODA_WHSEC, KODA_BASE_URL: `${sim.base}/koda/v1`,
    ...extra,
  };
}

async function boot(opts: { extra?: Record<string, string>; sleeps?: number[] } = {}) {
  const clock = new ManualClock('2026-09-29T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} },
    plugins: [],
    connectorEnv: env(opts.extra),
    connectorRuntime: {
      timeoutMs: 2_000, sleep: async (ms) => { opts.sleeps?.push(ms); }, circuit: { failureThreshold: 5, cooldownMs: 30_000 }, now: () => clock.now().getTime(),
    },
  });
  await app.ready();
  const req = (method: string, url: string, user?: string, body?: unknown, headers: Record<string, string> = {}) => app.inject({
    method: method as 'GET', url,
    headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { app, clock, req };
}
type Env = Awaited<ReturnType<typeof boot>>;

const obligationId = (e: Env) => e.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;
const createOrder = (e: Env, provider: 'bitripay' | 'koda') => e.req('POST', `/v1/obligations/${obligationId(e)}/payment-orders`, 'u-contribuable',
  { channel: provider === 'bitripay' ? 'QR' : 'MOBILE_MONEY', provider }, { 'idempotency-key': randomUUID() });
const statusOf = (e: Env, ref: string, user = 'u-contribuable', query = '') => e.req('GET', `/v1/payment-orders/${encodeURIComponent(ref)}/status${query}`, user);

/** Webhook BitriPay signé, forme documentée (événement avec data.object). */
function bitripayWebhook(e: Env, order: { providerIntentId: string; paymentReference: string }, type: string, id = `evt_${randomUUID().slice(0, 16)}`) {
  const t = Math.floor(e.clock.now().getTime() / 1000);
  const raw = JSON.stringify({
    id, object: 'event', type, created: t, livemode: false,
    data: { object: { id: order.providerIntentId, object: 'payment_intent', amount_minor: 15000, currency: 'usd', metadata: { payment_reference: order.paymentReference } } },
  });
  return e.app.inject({ method: 'POST', url: '/v1/providers/bitripay/webhooks', payload: raw, headers: { 'content-type': 'application/json', 'bitripay-signature': signBitriPayWebhook(BITRI_WHSEC, raw, t) } });
}

function kodaWebhook(e: Env, order: { providerIntentId: string; paymentReference: string }, type: 'payment.verified' | 'payment.verified.late') {
  const raw = JSON.stringify({
    id: `evt_${randomUUID().slice(0, 16)}`, type, created_at: e.clock.now().toISOString(),
    data: { intent_id: order.providerIntentId, amount: 15000, currency: 'USD', receipt_id: `KR-${randomUUID().slice(0, 8)}`, metadata: { payment_reference: order.paymentReference } },
  });
  return e.app.inject({ method: 'POST', url: '/v1/providers/koda/webhooks', payload: raw, headers: { 'content-type': 'application/json', 'x-koda-signature': signKodaWebhook(KODA_WHSEC, raw) } });
}

// ---------------------------------------------------------------------------------------------------------------------
describe('BitriPay — aller-retour par page hébergée', () => {
  it('intention (amount_minor, Idempotency-Key, return_url) → checkout_url → payeur +243000000501 → webhook signé → serveur à serveur (état + résolution) → quittance provisoire → page de retour', async () => {
    const e = await boot();
    const res = await createOrder(e, 'bitripay');
    expect(res.statusCode).toBe(201);
    const order = res.json();
    // La page de paiement du prestataire : l'URL est renvoyée au navigateur, la clé sk_ et le client_secret jamais.
    expect(order.checkoutUrl).toBe(`https://pay.bitripay.test/c/${order.providerIntentId}`);
    expect(JSON.stringify(order)).not.toMatch(/secret_ne_doit_pas_fuiter|sk_test_/);
    const create = sim.calls.find((c) => c.method === 'POST' && c.path === '/bitripay/v1/payment_intents')!;
    expect(create.headers.authorization).toBe(`Bearer ${BITRI_KEY}`);
    expect(create.headers['idempotency-key']).toBe(order.paymentReference);
    // Corps aux formes de l'OpenAPI BitriPay 2026-09-01.
    const back = `${PUBLIC}/paiement/retour?ref=${encodeURIComponent(order.paymentReference)}`;
    const sent = JSON.parse(create.body) as Record<string, unknown>;
    expect(sent).toMatchObject({
      amount_minor: 15000, currency: 'USD', rails: ['orange_cd', 'mpesa_cd', 'airtel_cd', 'africell_cd'], capture_method: 'automatic',
      reference: order.paymentReference, purpose_code: 'TAX', qr: true, success_url: back, cancel_url: `${back}&annule=1`,
      metadata: { payment_reference: order.paymentReference, obligation_id: obligationId(e) },
      return_url: back, // ancien paramétrage BITRIPAY_RETURN_URL_FIELD conservé
    });
    expect(sent.expires_in_minutes).toBeGreaterThan(0);
    for (const k of ['application_fee_minor', 'splits', 'allowed_operators']) expect(sent).not.toHaveProperty(k);

    // Retour « prématuré » du navigateur, paramètres forgés : la page lit l'état RÉEL — toujours en attente.
    const early = await statusOf(e, order.paymentReference, 'u-contribuable', '?status=succeeded&paid=1');
    expect(early.statusCode).toBe(200);
    expect(early.json()).toMatchObject({ state: 'EN_ATTENTE', stateLabel: 'En attente de confirmation', status: 'INITIE', receipt: null, final: false, source: 'MOSOLO' });
    expect(early.headers['cache-control']).toBe('no-store');

    // Le payeur valide sur la page BitriPay ; BitriPay envoie le webhook signé (livraison « au moins une fois »).
    const type = sim.bitripayCheckout(order.providerIntentId, '+243000000501')!;
    const w = await bitripayWebhook(e, order, type, 'evt_retour_0001');
    expect(w.statusCode).toBe(200);
    expect(w.json().results[0]).toMatchObject({ status: 'CONFIRME', receiptStatus: 'PROVISOIRE' });
    const gets = sim.calls.filter((c) => c.method === 'GET').map((c) => c.path.split('?')[0]);
    expect(gets).toEqual([`/bitripay/v1/payment_intents/${order.providerIntentId}`, '/bitripay/v1/payment_resolution']);
    const resolution = sim.calls.find((c) => c.path.startsWith('/bitripay/v1/payment_resolution'))!;
    expect(Object.fromEntries(new URL(resolution.path, 'http://x').searchParams)).toEqual({ reference: order.paymentReference, amount_minor: '15000', currency: 'USD' });
    // Seconde livraison du même événement : dédoublonnée par identifiant, aucun appel ni effet supplémentaire.
    const calls = sim.calls.length;
    expect((await bitripayWebhook(e, order, type, 'evt_retour_0001')).json().results[0]).toMatchObject({ replayed: true });
    expect(sim.calls.length).toBe(calls);
    expect(e.app.ctx.receipts.receipts.count()).toBe(1);

    // Retour sur MOSOLO : état confirmé, quittance provisoire, liens vers l'obligation.
    const retour = (await statusOf(e, order.paymentReference)).json();
    expect(retour).toMatchObject({ state: 'CONFIRME', stateLabel: 'Confirmé — quittance provisoire', status: 'CONFIRME', final: true, obligationId: obligationId(e), receipt: { status: 'PROVISOIRE' } });
    expect(retour.receipt.number).toMatch(/^Q-/);
    await e.app.close();
  });

  it('page de retour : réservée à qui peut lire l’obligation ; référence inconnue → 404', async () => {
    const e = await boot();
    const order = (await createOrder(e, 'bitripay')).json();
    expect((await statusOf(e, order.paymentReference, 'u-locataire')).statusCode).toBe(403);
    expect((await e.req('GET', `/v1/payment-orders/${order.paymentReference}/status`)).statusCode).toBe(401);
    expect((await statusOf(e, order.paymentReference, 'u-mandataire')).statusCode).toBe(200);
    expect((await statusOf(e, 'PR-INCO-NNUEX')).statusCode).toBe(404);
    await e.app.close();
  });

  it('+243000000408 : attente ambiguë → aucune quittance, exception de rapprochement (revue manuelle), page « vérification manuelle »', async () => {
    const e = await boot();
    const order = (await createOrder(e, 'bitripay')).json();
    const type = sim.bitripayCheckout(order.providerIntentId, '+243000000408')!;
    expect(type).toBe('payment_intent.ambiguous_hold');
    const w = await bitripayWebhook(e, order, type);
    expect(w.statusCode).toBe(200);
    expect(w.json().results[0]).toMatchObject({ outcome: 'HELD', reason: 'PROVIDER_AMBIGUOUS' });
    expect(e.app.ctx.receipts.receipts.count()).toBe(0);
    const ex = (await e.req('GET', '/v1/reconciliation/exceptions', 'u-analyste-rappro')).json();
    const list = (Array.isArray(ex) ? ex : ex.items ?? ex.exceptions) as { type: string; paymentReference?: string }[];
    expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'PROVIDER_AMBIGUOUS', paymentReference: order.paymentReference })]));
    expect((await statusOf(e, order.paymentReference)).json()).toMatchObject({ state: 'VERIFICATION_MANUELLE', final: false, receipt: null });

    // Un webhook « payé » arrive alors que GET /payment_resolution répond AMBIGUOUS : 409, jamais de quittance.
    sim.intents.get(order.providerIntentId)!.status = 'succeeded';
    const paid = await bitripayWebhook(e, order, 'payment_intent.succeeded');
    expect(paid.statusCode).toBe(409);
    expect(paid.json().code).toBe('PROVIDER_STATUS_AMBIGUOUS');
    expect(e.app.ctx.receipts.receipts.count()).toBe(0);
    expect(e.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('INITIE');

    // Résolution levée par le prestataire (CONFIRMED) : le même type d'événement renvoyé est confirmé.
    sim.intents.get(order.providerIntentId)!.resolution = 'CONFIRMED';
    const ok = await bitripayWebhook(e, order, 'payment_intent.succeeded');
    expect(ok.json().results[0]).toMatchObject({ status: 'CONFIRME', receiptStatus: 'PROVISOIRE' });
    expect(e.app.ctx.payments.unresolvedHolds()).toHaveLength(0);
    await e.app.close();
  });

  it('+243000000500 : délai puis succès — 409 tant que l’état n’est pas final, puis confirmé au renvoi', async () => {
    const e = await boot();
    const order = (await createOrder(e, 'bitripay')).json();
    const type = sim.bitripayCheckout(order.providerIntentId, '+243000000500')!;
    const first = await bitripayWebhook(e, order, type, 'evt_delai_0001');
    expect(first.statusCode).toBe(409);
    expect(first.json().code).toBe('PROVIDER_STATUS_NOT_FINAL');
    const again = await bitripayWebhook(e, order, type, 'evt_delai_0001');
    expect(again.json().results[0]).toMatchObject({ status: 'CONFIRME' });
    await e.app.close();
  });

  it('+243000000503 : prestataire indisponible → 503 + Retry-After, rien de mémorisé ; refus (…0000) et échec (404) : tentative journalisée, référence toujours payable', async () => {
    const e = await boot();
    const order = (await createOrder(e, 'bitripay')).json();
    const type = sim.bitripayCheckout(order.providerIntentId, '+243000000503')!;
    const w = await bitripayWebhook(e, order, type);
    expect(w.statusCode).toBe(503);
    expect(w.json().code).toBe('PROVIDER_STATUS_UNAVAILABLE');
    expect(w.headers['retry-after']).toBeDefined();
    sim.intents.get(order.providerIntentId)!.unavailable = false;
    for (const msisdn of ['+243812340000', '+243000000404']) {
      const t = sim.bitripayCheckout(order.providerIntentId, msisdn)!;
      expect(t).toBe('payment_intent.payment_failed');
      const f = await bitripayWebhook(e, order, t);
      expect(f.json().results[0]).toMatchObject({ outcome: 'IGNORED', reason: 'NON_TERMINAL_ATTEMPT_FAILURE' });
    }
    expect((await statusOf(e, order.paymentReference)).json()).toMatchObject({ state: 'EN_ATTENTE' });
    // Annulation définitive : la page de retour affiche « échec / annulé ».
    const c = await bitripayWebhook(e, order, 'payment_intent.canceled');
    expect(c.statusCode).toBe(200);
    expect((await statusOf(e, order.paymentReference)).json()).toMatchObject({ state: 'ECHEC', stateLabel: 'Échec / annulé', final: true });
    await e.app.close();
  });

  it('GET /status dégradé : « Tester la connexion » en échec explicite, état affiché avec le disjoncteur', async () => {
    const e = await boot();
    sim.bitriState = 'degraded';
    const t = (await e.req('POST', '/v1/providers/bitripay/test-connection', 'u-superadmin', {})).json();
    expect(t).toMatchObject({ kind: 'APPEL_REEL', endpoint: 'GET /status', ok: false });
    expect(t.detail).toMatch(/mode dégradé/);
    expect(t.checks).toEqual(expect.arrayContaining([expect.objectContaining({ label: expect.stringMatching(/fonctionnement normal/), ok: false })]));
    const r = (await e.req('GET', '/v1/providers/readiness', 'u-tresor')).json();
    const b = r.providers.find((p: { id: string }) => p.id === 'bitripay');
    expect(b.platformStatus).toMatchObject({ level: 'DEGRADE', state: 'degraded' });
    expect(b.returnUrl).toBe(`${PUBLIC}/paiement/retour`);
    expect(b.resolutionCheck).toBe(true);
    expect(b.confirmed.length).toBeGreaterThan(5);
    // Rétabli : l'essai redevient concluant.
    sim.bitriState = 'operational';
    expect((await e.req('POST', '/v1/providers/bitripay/test-connection', 'u-superadmin', {})).json()).toMatchObject({ ok: true });
    await e.app.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('KODA — aller-retour par page hébergée', () => {
  it('intention (amount en unités mineures, success_url vers /paiement/retour) → TEST-OK-25000 → payment.verified → quittance provisoire → page de retour', async () => {
    const e = await boot();
    const order = (await createOrder(e, 'koda')).json();
    expect(order.checkoutUrl).toBe(`https://kodajnn.test/checkout/${order.providerIntentId}`);
    expect(JSON.stringify(order)).not.toMatch(/ne_doit_pas_fuiter|sk_test_/);
    const create = sim.calls.find((c) => c.method === 'POST' && c.path === '/koda/v1/intents')!;
    expect(create.headers.authorization).toBe(`Bearer ${KODA_KEY}`);
    expect(JSON.parse(create.body)).toMatchObject({
      amount: 15000, currency: 'USD', operators: ['orange_cd', 'mpesa_cd'], metadata: { order_id: expect.any(String), payment_reference: order.paymentReference },
      success_url: `${PUBLIC}/paiement/retour?ref=${encodeURIComponent(order.paymentReference)}`,
    });
    expect((await statusOf(e, order.paymentReference)).json()).toMatchObject({ state: 'EN_ATTENTE' });
    const type = sim.kodaCheckout(order.providerIntentId, 'TEST-OK-25000', e.clock.now().getTime())!;
    const w = await kodaWebhook(e, order, type as 'payment.verified');
    expect(w.json().results[0]).toMatchObject({ status: 'CONFIRME', receiptStatus: 'PROVISOIRE' });
    expect((await statusOf(e, order.paymentReference)).json()).toMatchObject({ state: 'CONFIRME', stateLabel: 'Confirmé — quittance provisoire' });
    await e.app.close();
  });

  it('TEST-LATE-90 : aucun webhook avant 90 s (page « en attente »), puis payment.verified.late → confirmé', async () => {
    const e = await boot();
    const order = (await createOrder(e, 'koda')).json();
    expect(sim.kodaCheckout(order.providerIntentId, 'TEST-LATE-90', e.clock.now().getTime())).toBeNull();
    e.clock.advance(60_000);
    expect(sim.kodaLateDue(e.clock.now().getTime())).toHaveLength(0);
    expect((await statusOf(e, order.paymentReference)).json()).toMatchObject({ state: 'EN_ATTENTE' });
    e.clock.advance(31_000);
    expect(sim.kodaLateDue(e.clock.now().getTime()).map((i) => i.id)).toEqual([order.providerIntentId]);
    const w = await kodaWebhook(e, order, 'payment.verified.late');
    expect(w.statusCode).toBe(200);
    expect(w.json().results[0]).toMatchObject({ eventType: 'payment.verified.late', status: 'CONFIRME', receiptStatus: 'PROVISOIRE' });
    await e.app.close();
  });

  it('TEST-REPLAY (code_already_used) et TEST-SUFFIX (défi) : pièces de dossier seulement — aucune quittance, référence inchangée', async () => {
    const e = await boot();
    const order = (await createOrder(e, 'koda')).json();
    expect(sim.kodaCheckout(order.providerIntentId, 'TEST-REPLAY', e.clock.now().getTime())).toBeNull();
    const replay = await e.req('POST', `/v1/payment-orders/${order.paymentReference}/provider-verification-evidence`, 'u-tresor', { caseRef: 'LIT-2026-001', smsCode: 'TEST-REPLAY' });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toMatchObject({ legalEffect: 'AUCUN', providerResult: { refused: true, httpStatus: 409, code: 'code_already_used' } });
    expect(replay.json().providerResult.meaning).toMatch(/déjà utilisée/);
    const verifyCall = sim.calls.find((c) => c.path.endsWith('/verify'))!;
    expect(JSON.parse(verifyCall.body)).toMatchObject({ reference: 'TEST-REPLAY' });
    const suffix = await e.req('POST', `/v1/payment-orders/${order.paymentReference}/provider-verification-evidence`, 'u-tresor', { caseRef: 'LIT-2026-002', smsCode: 'TEST-SUFFIX' });
    expect(suffix.json()).toMatchObject({ providerResult: { status: 'challenge', reason: 'msisdn_suffix_mismatch' } });
    expect(e.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('INITIE');
    expect(e.app.ctx.receipts.receipts.count()).toBe(0);
    expect((await statusOf(e, order.paymentReference)).json()).toMatchObject({ state: 'EN_ATTENTE' });
    await e.app.close();
  });

  it('HTTP 429 + Retry-After : interrogation d’état rejouée après le délai demandé ; création refusée en 503 + Retry-After sans nouvelle tentative', async () => {
    const sleeps: number[] = [];
    const e = await boot({ sleeps });
    const order = (await createOrder(e, 'koda')).json();
    sim.kodaCheckout(order.providerIntentId, 'TEST-OK-25000', e.clock.now().getTime());
    sim.rateLimit = { match: `/koda/v1/intents/${order.providerIntentId}`, method: 'GET', count: 1, retryAfter: '2' };
    const w = await kodaWebhook(e, order, 'payment.verified');
    expect(w.statusCode).toBe(200);
    expect(w.json().results[0]).toMatchObject({ status: 'CONFIRME' });
    expect(sleeps).toEqual([2000]); // délai du prestataire respecté (et non le recul exponentiel)

    // Création d'intention limitée pour 30 s : au-delà de l'attente admise ⇒ 503 immédiat, délai transmis, aucun ordre.
    const e2 = await boot();
    sim.rateLimit = { match: '/koda/v1/intents', method: 'POST', count: 5, retryAfter: '30' };
    const before = sim.calls.filter((c) => c.method === 'POST').length;
    const r = await createOrder(e2, 'koda');
    expect(r.statusCode).toBe(503);
    expect(r.json().code).toBe('PROVIDER_RATE_LIMITED');
    expect(r.headers['retry-after']).toBe('30');
    expect(sim.calls.filter((c) => c.method === 'POST').length - before).toBe(1);
    expect(e2.app.ctx.payments.orders.count()).toBe(0);
    await e.app.close();
    await e2.app.close();
  });

  it('Tester la connexion : GET /ping (validité de la clé prouvée) ; clé refusée → échec explicite', async () => {
    const e = await boot();
    const ok = (await e.req('POST', '/v1/providers/koda/test-connection', 'u-rssi', {})).json();
    expect(ok).toMatchObject({ kind: 'APPEL_REEL', endpoint: 'GET /ping', ok: true });
    sim.acceptedKeys.add('sk_test_UNE_AUTRE_CLE_0000000');
    const ko = (await e.req('POST', '/v1/providers/koda/test-connection', 'u-rssi', {})).json();
    expect(ko).toMatchObject({ ok: false, httpStatus: 401 });
    expect(ko.proves).toMatch(/clé refusée/);
    await e.app.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('BitriPay — OpenAPI 2026-09-01 : événements, erreurs, clés restreintes, signature Ed25519', () => {
  it('failed / cancelled / expired ferment l’ordre ; disputed alerte le Trésor ; ping et étapes intermédiaires : 200 sans effet', async () => {
    const e = await boot();
    for (const type of ['payment_intent.failed', 'payment_intent.cancelled', 'payment_intent.expired']) {
      const order = (await createOrder(e, 'bitripay')).json();
      for (const info of ['payment_intent.created', 'payment_intent.processing', 'payment_intent.authorised']) {
        expect((await bitripayWebhook(e, order, info)).json().results[0]).toMatchObject({ outcome: 'IGNORED', reason: 'INFORMATIF' });
      }
      const r = await bitripayWebhook(e, order, type);
      expect(r.statusCode, type).toBe(200);
      expect(e.app.ctx.payments.byReference(order.paymentReference)!.status, type).toBe('ECHOUE');
      expect((await statusOf(e, order.paymentReference)).json()).toMatchObject({ state: 'ECHEC' });
    }
    const order = (await createOrder(e, 'bitripay')).json();
    sim.bitripayCheckout(order.providerIntentId, '+243000000501');
    await bitripayWebhook(e, order, 'payment_intent.succeeded');
    const d = await bitripayWebhook(e, order, 'payment_intent.disputed');
    expect(d.json().results[0]).toMatchObject({ outcome: 'IGNORED', reason: 'LITIGE' });
    expect(e.app.ctx.alerts.alerts.find((a) => a.type === 'PROVIDER_PAYMENT_DISPUTED')).toHaveLength(1);
    expect(e.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('CONFIRME'); // aucune mesure automatique
    const ping = await bitripayWebhook(e, order, 'ping');
    expect(ping.statusCode).toBe(200);
    expect(ping.json().results[0]).toMatchObject({ reason: 'PING' });
    await e.app.close();
  });

  it('erreurs {error:{code, bp}} : guardian_halt / degraded_mode ⇒ 503 + Retry-After et disjoncteur ; scope_denied ⇒ erreur de configuration affichée', async () => {
    const e = await boot();
    sim.inject = { match: '/bitripay/v1/payment_intents', method: 'POST', count: 1, status: 409, code: 'guardian_halt', bp: 'BP-3006' };
    const r = await createOrder(e, 'bitripay');
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', providerErrorCode: 'guardian_halt', providerBp: 'BP-3006' });
    expect(r.headers['retry-after']).toBe('60');
    expect(sim.calls.filter((c) => c.method === 'POST')).toHaveLength(1); // aucune nouvelle tentative
    const readiness = (await e.req('GET', '/v1/providers/readiness', 'u-tresor')).json();
    expect(readiness.providers.find((p: { id: string }) => p.id === 'bitripay').circuit.consecutiveFailures).toBe(1);

    const order = (await createOrder(e, 'bitripay')).json();
    sim.bitripayCheckout(order.providerIntentId, '+243000000501');
    sim.inject = { match: '/bitripay/v1/payment_resolution', method: 'GET', count: 1, status: 403, code: 'scope_denied', bp: 'BP-1004' };
    const w = await bitripayWebhook(e, order, 'payment_intent.succeeded');
    expect(w.statusCode).toBe(503); // confirmation impossible ⇒ aucune quittance, le prestataire renverra
    expect(e.app.ctx.receipts.receipts.count()).toBe(0);
    const v = (await e.req('GET', '/v1/providers/readiness', 'u-superadmin')).json();
    expect(v.providers.find((p: { id: string }) => p.id === 'bitripay').configurationIssue).toMatchObject({ code: 'scope_denied', bp: 'BP-1004', path: '/payment_resolution' });
    await e.app.close();
  });

  it('clé restreinte rk_test_… admise pour BitriPay (portées), refusée pour KODA ; purpose_code GOVERNMENT_FEE pour un droit administratif', async () => {
    const e = await boot({ extra: { BITRIPAY_API_KEY: 'rk_test_RESTREINTE_ALLER_RETOUR_01' } });
    expect(e.app.ctx.connectors.get('bitripay')!.mode).toBe('TEST');
    await e.app.close();
    expect(() => buildApp({ plugins: [], connectorEnv: env({ KODA_API_KEY: 'rk_test_LECTURE_SEULE_KODA_0001' }) })).toThrow(/rk_… refusée/);
    const { purposeCodeFor } = await import('../src/modules/payments/connectors/bitripay.js');
    expect(purposeCodeFor('DROIT_ADMINISTRATIF')).toBe('GOVERNMENT_FEE');
    expect(purposeCodeFor('IMPOT_PROVINCIAL')).toBe('TAX');
    expect(purposeCodeFor(undefined)).toBe('TAX');
  });

  it('production déclarée + clé réelle : les DEUX signatures sont exigées par défaut (clé Ed25519 épinglée obligatoire)', async () => {
    const { buildConnectorRegistry } = await import('../src/modules/payments/connectors/registry.js');
    const live = { BITRIPAY_API_KEY: 'sk_live_PRODUCTION_ALLER_RETOUR_01', BITRIPAY_WEBHOOK_SECRET: BITRI_WHSEC, MOSOLO_PUBLIC_URL: PUBLIC };
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => buildConnectorRegistry(live, {}, false)).toThrow(/BITRIPAY_ED25519_PUBLIC_KEY/);
      expect(buildConnectorRegistry({ ...live, BITRIPAY_ED25519_REQUIRED: 'false' }, {}, false).get('bitripay')!.mode).toBe('LIVE');
    } finally {
      process.env.NODE_ENV = saved;
    }
    // Hors production : vérifiée si présente (comportement antérieur conservé) ; URL par défaut de la page développeur.
    const reg = buildConnectorRegistry(live, {}, false);
    expect(reg.get('bitripay')!.describe().baseUrl).toBe('https://api.bitripay.com/v1');
  });

  it('signature Ed25519 « keyId,t,sig » (clé de la plateforme épinglée) : valide acceptée, altérée refusée', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw32 = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
    const e = await boot({ extra: { BITRIPAY_ED25519_PUBLIC_KEY: raw32, BITRIPAY_ED25519_REQUIRED: 'true' } });
    const order = (await createOrder(e, 'bitripay')).json();
    sim.bitripayCheckout(order.providerIntentId, '+243000000501');
    const t = Math.floor(e.clock.now().getTime() / 1000);
    const raw = JSON.stringify({ id: `evt_${randomUUID().slice(0, 12)}`, type: 'payment_intent.succeeded', created: t,
      data: { object: { id: order.providerIntentId, amount_minor: 15000, currency: 'usd', metadata: { payment_reference: order.paymentReference } } } });
    const { signBitriPayWebhook } = await import('../src/modules/payments/connectors/bitripay.js');
    const post = (edHeader: string) => e.app.inject({ method: 'POST', url: '/v1/providers/bitripay/webhooks', payload: raw, headers: {
      'content-type': 'application/json', 'bitripay-signature': signBitriPayWebhook(BITRI_WHSEC, raw, t), 'bitripay-signature-ed25519': edHeader } });
    const good = edSign(null, Buffer.from(`${t}.${raw}`), privateKey).toString('base64');
    const bad = edSign(null, Buffer.from(`${t}.${raw}x`), privateKey).toString('base64');
    expect((await post(`k1,${t},${bad}`)).statusCode).toBe(401);
    const ok = await post(`keyId=k1,t=${t},sig=${good}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().results[0]).toMatchObject({ status: 'CONFIRME' });
    await e.app.close();
  });
});
