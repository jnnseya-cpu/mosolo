import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ApiError } from '../src/core/errors.js';
import { ManualClock } from '../src/core/clock.js';
import { signBitriPayWebhook, BITRIPAY_DEMO_WEBHOOK_SECRET } from '../src/modules/payments/connectors/bitripay.js';
import type { FetchLike, HttpLogEntry } from '../src/modules/payments/connectors/http-client.js';
import { KODA_DEMO_WEBHOOK_SECRET, KODA_EXPONENTS, signKodaWebhook } from '../src/modules/payments/connectors/koda.js';
import { fromMinorUnits, toMinorUnits } from '../src/modules/payments/connectors/minor-units.js';
import { ConnectorConfigError } from '../src/modules/payments/connectors/types.js';
import { DEMO } from '../src/seed.js';
import { callbackBody, signedCallback, type TestEnv } from './helpers.js';
import { BITRI_ED_PUBLIC, bitriEdHeader } from './signature-ed25519-test.js';

interface FetchCall { url: string; method: string; headers: Record<string, string>; body?: string }

function mockFetch(responder: (call: FetchCall) => { status: number; body: unknown }) {
  const calls: FetchCall[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) };
    calls.push(call);
    const r = responder(call);
    return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => JSON.stringify(r.body) };
  };
  return { fetch, calls };
}

async function setupConnectors(connectorEnv: Record<string, string | undefined> = {}, fetch?: FetchLike, logs: HttpLogEntry[] = []) {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    plugins: [],
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} },
    connectorEnv,
    connectorRuntime: { ...(fetch ? { fetch } : {}), logger: (e) => logs.push(e), sleep: async () => {} },
  });
  await app.ready();
  const env: TestEnv = {
    app, clock,
    req: (method, url, user, body, headers = {}) =>
      app.inject({
        method: method as 'GET', url,
        headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
      }),
  };
  return env;
}

const obligationId = (env: TestEnv) => env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;

function createProviderOrder(env: TestEnv, provider: 'koda' | 'bitripay', channel = 'MOBILE_MONEY', key = randomUUID()) {
  return env.req('POST', `/v1/obligations/${obligationId(env)}/payment-orders`, 'u-contribuable', { channel, provider }, { 'idempotency-key': key });
}

function kodaWebhook(env: TestEnv, payload: Record<string, unknown>, secret = KODA_DEMO_WEBHOOK_SECRET) {
  const raw = JSON.stringify(payload);
  return env.app.inject({
    method: 'POST', url: '/v1/providers/koda/webhooks', payload: raw,
    headers: { 'content-type': 'application/json', 'x-koda-signature': signKodaWebhook(secret, raw) },
  });
}

function bitripayWebhook(env: TestEnv, payload: Record<string, unknown>, opts: { secret?: string; t?: number; extra?: Record<string, string> } = {}) {
  const raw = JSON.stringify(payload);
  const t = opts.t ?? Math.floor(env.clock.now().getTime() / 1000);
  return env.app.inject({
    method: 'POST', url: '/v1/providers/bitripay/webhooks', payload: raw,
    headers: { 'content-type': 'application/json', 'bitripay-signature': signBitriPayWebhook(opts.secret ?? BITRIPAY_DEMO_WEBHOOK_SECRET, raw, t), 'bitripay-signature-ed25519': bitriEdHeader(raw, t), ...opts.extra },
  });
}

const kodaVerified = (order: { providerIntentId: string; paymentReference: string }, over: Record<string, unknown> = {}) => ({
  id: `evt_${randomUUID()}`, type: 'payment.verified',
  data: { intent_id: order.providerIntentId, amount: 15000, currency: 'USD', receipt_id: 'KR-0001', metadata: { payment_reference: order.paymentReference } },
  ...over,
});

const bitripayEvent = (type: string, order: { providerIntentId: string; paymentReference: string }, obj: Record<string, unknown> = {}) => ({
  id: `evt_${randomUUID()}`, type, created: 1790413200,
  data: { object: { id: order.providerIntentId, amount_minor: 15000, currency: 'usd', metadata: { payment_reference: order.paymentReference }, ...obj } },
});

describe('Conversion des unités mineures (exacte, sans flottant)', () => {
  it('KODA : CDF à zéro décimale, USD à deux décimales ; aller-retour exact', () => {
    expect(fromMinorUnits(25000n, 'CDF', KODA_EXPONENTS)).toEqual({ amount: '25000.00', currency: 'CDF' });
    expect(fromMinorUnits(589n, 'USD', KODA_EXPONENTS)).toEqual({ amount: '5.89', currency: 'USD' });
    expect(toMinorUnits({ amount: '25000.00', currency: 'CDF' }, KODA_EXPONENTS)).toBe(25000n);
    expect(toMinorUnits({ amount: '5.89', currency: 'USD' }, KODA_EXPONENTS)).toBe(589n);
    // Exposant ISO 4217 (BitriPay par défaut) : CDF à deux décimales.
    expect(toMinorUnits({ amount: '1250.50', currency: 'CDF' }, { CDF: 2 })).toBe(125050n);
    expect(fromMinorUnits(125050n, 'CDF', { CDF: 2 })).toEqual({ amount: '1250.50', currency: 'CDF' });
  });

  it('montant non représentable chez le prestataire → 422 AMOUNT_NOT_REPRESENTABLE (aucun arrondi)', () => {
    const attempt = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e;
      }
      return undefined;
    };
    const e = attempt(() => toMinorUnits({ amount: '1250.50', currency: 'CDF' }, KODA_EXPONENTS));
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 422, code: 'AMOUNT_NOT_REPRESENTABLE' });
    expect(attempt(() => toMinorUnits({ amount: '1.005', currency: 'USD' }, KODA_EXPONENTS))).toMatchObject({ code: 'AMOUNT_NOT_REPRESENTABLE' });
    expect(attempt(() => toMinorUnits({ amount: '10', currency: 'EUR' }, KODA_EXPONENTS))).toMatchObject({ code: 'CURRENCY_NOT_SUPPORTED_BY_PROVIDER' });
    // Zéros non significatifs acceptés.
    expect(toMinorUnits({ amount: '25000.000', currency: 'CDF' }, KODA_EXPONENTS)).toBe(25000n);
  });
});

describe('Connecteur KODA', () => {
  it('bac à sable : intention simulée sans appel réseau ; canal non mobile refusé', async () => {
    const { fetch, calls } = mockFetch(() => ({ status: 500, body: {} }));
    const env = await setupConnectors({}, fetch);
    const card = await createProviderOrder(env, 'koda', 'CARD');
    expect(card.statusCode).toBe(422);
    expect(card.json().code).toBe('PROVIDER_CHANNEL_UNSUPPORTED');
    const res = await createProviderOrder(env, 'koda');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ provider: 'koda', checkoutUrl: null, qrPayload: null, sandbox: true, status: 'INITIE' });
    expect(res.json().providerIntentId).toMatch(/^sbx_koda_/);
    expect(calls).toHaveLength(0);
  });

  it('webhook signé valide → CONFIRME + quittance provisoire ; rejeu → 200 sans double effet', async () => {
    const env = await setupConnectors();
    const order = (await createProviderOrder(env, 'koda')).json();
    const payload = kodaVerified(order);
    const res = await kodaWebhook(env, payload);
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0]).toMatchObject({ outcome: 'PROCESSED', status: 'CONFIRME', receiptStatus: 'PROVISOIRE', paymentReference: order.paymentReference });
    const stored = env.app.ctx.payments.byReference(order.paymentReference)!;
    expect(stored).toMatchObject({ status: 'CONFIRME', provider: 'koda', confirmationMethod: 'KODA_OPERATOR_LEDGER', providerTxnId: 'KR-0001' });
    expect(env.app.ctx.receipts.byPaymentOrder(stored.id)).toMatchObject({ status: 'PROVISOIRE', confirmationMethod: 'KODA_OPERATOR_LEDGER' });

    const entries = env.app.ctx.ledger.list().length;
    const replay = await kodaWebhook(env, payload);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().results[0]).toMatchObject({ replayed: true, status: 'CONFIRME' });
    // Même reçu KODA sous un autre identifiant d'événement (« .late ») : rejeu de transaction, pas de 2e quittance.
    const late = await kodaWebhook(env, kodaVerified(order, { type: 'payment.verified.late' }));
    expect(late.json().results[0]).toMatchObject({ replayed: true });
    expect(env.app.ctx.receipts.receipts.count()).toBe(1);
    expect(env.app.ctx.ledger.list().length).toBe(entries);
    expect(env.app.ctx.audit.list({ action: 'payment.webhook.replayed' }).total).toBe(1);
  });

  it('signature invalide → 401 + alerte de sécurité ; aucun changement d’état', async () => {
    const env = await setupConnectors();
    const order = (await createProviderOrder(env, 'koda')).json();
    const alerts = env.app.ctx.alerts.alerts.count();
    const bad = await kodaWebhook(env, kodaVerified(order), 'mauvais-secret');
    expect(bad.statusCode).toBe(401);
    expect(bad.json().code).toBe('INVALID_SIGNATURE');
    const missing = await env.app.inject({ method: 'POST', url: '/v1/providers/koda/webhooks', payload: JSON.stringify(kodaVerified(order)), headers: { 'content-type': 'application/json' } });
    expect(missing.statusCode).toBe(401);
    expect(env.app.ctx.alerts.alerts.count()).toBe(alerts + 2);
    expect(env.app.ctx.alerts.alerts.all().at(-2)).toMatchObject({ type: 'INVALID_SIGNATURE', severity: 'CRITICAL', source: 'prestataire:koda' });
    expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('INITIE');
  });

  it('montant différent → 422 AMOUNT_MISMATCH + alerte ; confirmation générique d’un ordre lié à KODA refusée', async () => {
    const env = await setupConnectors();
    const order = (await createProviderOrder(env, 'koda')).json();
    const res = await kodaWebhook(env, kodaVerified(order, { data: { intent_id: order.providerIntentId, amount: 14999, currency: 'USD', receipt_id: 'KR-9', metadata: { payment_reference: order.paymentReference } } }));
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('AMOUNT_MISMATCH');
    expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('INITIE');
    const generic = await signedCallback(env, callbackBody(env, order.paymentReference));
    expect(generic.statusCode).toBe(422);
    expect(generic.json().code).toBe('PROVIDER_ORDER_MISMATCH');
    // Événement inconnu : 200 ignoré + audit.
    const other = await kodaWebhook(env, { id: 'evt_x', type: 'intent.created', intent_id: order.providerIntentId });
    expect(other.statusCode).toBe(200);
    expect(other.json().results[0]).toMatchObject({ outcome: 'IGNORED', reason: 'UNKNOWN_TYPE' });
    expect(env.app.ctx.audit.list({ action: 'payment.webhook.ignored' }).total).toBe(1);
  });

  it('mode réel : Bearer + Idempotency-Key, métadonnées minimales, secret jamais journalisé ; échec → 502 sans ordre', async () => {
    const logs: HttpLogEntry[] = [];
    const { fetch, calls } = mockFetch(() => ({ status: 200, body: { intent_id: 'int_live_1', client_secret: 'cs_secret', checkout_url: 'https://kodajnn.com/c/int_live_1' } }));
    const env = await setupConnectors({ KODA_API_KEY: 'sk_test_SUPERSECRETKODA1234', KODA_WEBHOOK_SECRET: 'whsec_koda_test', KODA_SUCCESS_URL: 'https://portail.exemple/retour' }, fetch, logs);
    const res = await createProviderOrder(env, 'koda');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ providerIntentId: 'int_live_1', checkoutUrl: 'https://kodajnn.com/c/int_live_1', sandbox: true });
    expect(JSON.stringify(res.json())).not.toContain('cs_secret');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://kodajnn.com/v1/intents');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk_test_SUPERSECRETKODA1234');
    expect(calls[0]!.headers['idempotency-key']).toBe(res.json().paymentReference);
    const sent = JSON.parse(calls[0]!.body!);
    expect(sent).toMatchObject({ amount: 15000, currency: 'USD', metadata: { payment_reference: res.json().paymentReference, obligation_id: obligationId(env) } });
    expect(JSON.stringify(sent)).not.toMatch(/Mbuyi|TP-DEMO|iuc/i);
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain('SUPERSECRET');
    expect(JSON.stringify(env.app.ctx.connectors.describe())).not.toContain('SUPERSECRET');

    // Prestataire en panne : 502, aucun ordre à moitié créé ; POST KODA jamais rejoué (idempotence non documentée).
    const down = mockFetch(() => ({ status: 503, body: {} }));
    const env2 = await setupConnectors({ KODA_API_KEY: 'sk_test_SUPERSECRETKODA1234', KODA_WEBHOOK_SECRET: 'whsec_koda_test', KODA_SUCCESS_URL: 'https://portail.exemple/retour' }, down.fetch);
    const fail = await createProviderOrder(env2, 'koda');
    expect(fail.statusCode).toBe(502);
    expect(fail.json().code).toBe('PROVIDER_UNAVAILABLE');
    expect(down.calls).toHaveLength(1);
    expect(env2.app.ctx.payments.orders.count()).toBe(0);
  });
});

describe('Connecteur BitriPay', () => {
  it('payment_intent.succeeded signé → CONFIRME ; payment_intent.settled → annonce seulement (reste CONFIRME)', async () => {
    const env = await setupConnectors();
    const order = (await createProviderOrder(env, 'bitripay', 'QR')).json();
    expect(order.providerIntentId).toMatch(/^sbx_bitripay_/);
    const ok = await bitripayWebhook(env, bitripayEvent('payment_intent.succeeded', order));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().results[0]).toMatchObject({ status: 'CONFIRME', receiptStatus: 'PROVISOIRE' });
    expect(env.app.ctx.payments.byReference(order.paymentReference)).toMatchObject({ status: 'CONFIRME', confirmationMethod: 'BITRIPAY_RAIL' });

    const settled = await bitripayWebhook(env, bitripayEvent('payment_intent.settled', order, { settlement_id: 'st_001' }));
    expect(settled.statusCode).toBe(200);
    expect(settled.json().results[0]).toMatchObject({ outcome: 'SETTLEMENT_ANNOUNCED', paymentReference: order.paymentReference });
    const after = env.app.ctx.payments.byReference(order.paymentReference)!;
    expect(after.status).toBe('CONFIRME');
    expect(after.settledAt).toBeUndefined();
    expect(env.app.ctx.receipts.byPaymentOrder(after.id)!.status).toBe('PROVISOIRE');
    expect(env.app.ctx.payments.settlementAnnouncements.all()).toEqual([expect.objectContaining({ settlementId: 'st_001', amountMatchesOrder: true })]);
    expect(env.app.ctx.audit.list({ action: 'payment.settlement_announced' }).total).toBe(1);
  });

  it('horodatage signé hors fenêtre ou HMAC invalide → 401 ; Ed25519 vérifiée si configurée', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw32 = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
    const env = await setupConnectors({ BITRIPAY_ED25519_PUBLIC_KEY: raw32 });
    const order = (await createProviderOrder(env, 'bitripay')).json();
    const payload = bitripayEvent('payment_intent.succeeded', order);
    const old = await bitripayWebhook(env, payload, { t: Math.floor(env.clock.now().getTime() / 1000) - 301 });
    expect(old.json().code).toBe('TIMESTAMP_OUT_OF_WINDOW');
    const wrong = await bitripayWebhook(env, payload, { secret: 'whsec_autre' });
    expect(wrong.statusCode).toBe(401);
    const forgedEd = await bitripayWebhook(env, payload, { extra: { 'bitripay-signature-ed25519': sign(null, Buffer.from('autre'), privateKey).toString('base64') } });
    expect(forgedEd.json().code).toBe('INVALID_SIGNATURE');
    const goodEd = await bitripayWebhook(env, payload, { extra: { 'bitripay-signature-ed25519': sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64') } });
    expect(goodEd.statusCode).toBe(200);
    expect(env.app.ctx.alerts.alerts.find((a) => a.source === 'prestataire:bitripay')).toHaveLength(3);
  });

  it('mode réel : POST /payment_intents avec Idempotency-Key, rejoué sur erreur 5xx avec la même clé', async () => {
    let n = 0;
    const { fetch, calls } = mockFetch(() => (++n < 3 ? { status: 503, body: {} } : { status: 200, body: { id: 'pi_1', checkout_url: 'https://pay.bitripay.com/pi_1', qr_payload: 'BTRP|pi_1', client_secret: 'x' } }));
    const env = await setupConnectors({ BITRIPAY_ED25519_PUBLIC_KEY: BITRI_ED_PUBLIC, BITRIPAY_API_KEY: 'sk_live_BITRISECRET99887766', BITRIPAY_WEBHOOK_SECRET: 'whsec_live' }, fetch);
    const res = await createProviderOrder(env, 'bitripay', 'QR');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ providerIntentId: 'pi_1', qrPayload: 'BTRP|pi_1', sandbox: false });
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.headers['idempotency-key']))).toEqual(new Set([res.json().paymentReference]));
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ amount_minor: 15000, currency: 'USD', description: `KINSHASA MOSOLO ${res.json().paymentReference}` });
  });
});

describe('Configuration et pièces de dossier', () => {
  it('alias de règlement absent du coffre, clé publiable ou secret de webhook manquant → erreur de configuration', () => {
    expect(() => buildApp({ connectorEnv: { KODA_SETTLEMENT_ACCOUNT_ALIAS: 'COMPTE-PRIVE-OPERATEUR' } })).toThrow(ConnectorConfigError);
    expect(() => buildApp({ connectorEnv: { BITRIPAY_SETTLEMENT_ACCOUNT_ALIAS: 'INCONNU' } })).toThrow(/coffre/);
    expect(() => buildApp({ connectorEnv: { KODA_API_KEY: 'pk_live_publishable', KODA_WEBHOOK_SECRET: 'x', KODA_SUCCESS_URL: 'https://portail.exemple/retour' } })).toThrow(/publiable/);
    expect(() => buildApp({ connectorEnv: { KODA_API_KEY: 'sk_live_abc', KODA_WEBHOOK_SECRET: 'x' } })).toThrow(/KODA_SUCCESS_URL/);
    expect(() => buildApp({ connectorEnv: { BITRIPAY_ED25519_PUBLIC_KEY: BITRI_ED_PUBLIC, BITRIPAY_API_KEY: 'sk_live_abc' } })).toThrow(/secret de webhook/);
    expect(() => buildApp({ connectorEnv: { KODA_SETTLEMENT_ACCOUNT_ALIAS: DEMO.dgtkAlias } })).not.toThrow();
  });

  it('vérification capture/SMS : pièce de dossier pour R18/R20, sans effet sur l’ordre ; interdite au contribuable', async () => {
    const env = await setupConnectors();
    const order = (await createProviderOrder(env, 'koda')).json();
    const url = `/v1/payment-orders/${order.paymentReference}/provider-verification-evidence`;
    const body = { caseRef: 'LIT-2026-0001', smsCode: 'KODA-123456', screenshotSha256: 'a'.repeat(64) };
    const taxpayer = await env.req('POST', url, 'u-contribuable', body);
    expect(taxpayer.statusCode).toBe(403);
    const ok = await env.req('POST', url, 'u-analyste-rappro', body);
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ kind: 'PROVIDER_VERIFICATION_EVIDENCE', legalEffect: 'AUCUN', orderStatusAtRequest: 'INITIE', sandbox: true });
    expect(JSON.stringify(ok.json())).not.toContain('KODA-123456');
    expect((await env.req('POST', url, 'u-contentieux', body)).statusCode).toBe(201);
    expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('INITIE');
    expect(env.app.ctx.receipts.receipts.count()).toBe(0);
  });
});

describe('BitriPay : comptes connectés, attente prestataire, résolution', () => {
  const ACCT = 'acct_VilleKinshasaDGIPK01';

  it('compte connecté : en-tête BitriPay-Account sur chaque requête, jamais de frais d’application ; résolution = pièce de dossier', async () => {
    const { fetch, calls } = mockFetch((c) => (c.method === 'GET'
      ? { status: 200, body: { status: 'CONFIRMED', matches: [] } }
      : { status: 200, body: { id: 'pi_9', checkout_url: 'https://pay.bitripay.com/pi_9', qr_payload: 'BTRP|pi_9' } }));
    const env = await setupConnectors({ BITRIPAY_ED25519_PUBLIC_KEY: BITRI_ED_PUBLIC, BITRIPAY_API_KEY: 'sk_live_INTEGRATEUR0001', BITRIPAY_WEBHOOK_SECRET: 'whsec_live', BITRIPAY_ACCOUNT_ID: ACCT }, fetch);
    const order = (await createProviderOrder(env, 'bitripay', 'QR')).json();
    const body = JSON.parse(calls[0]!.body!);
    expect(calls[0]!.headers['bitripay-account']).toBe(ACCT);
    expect(body).not.toHaveProperty('application_fee_minor');
    expect(env.app.ctx.connectors.get('bitripay')!.describe()).toMatchObject({ connectedAccountId: ACCT, applicationFee: 'INTERDIT' });

    const url = `/v1/payment-orders/${order.paymentReference}/provider-resolution`;
    expect((await env.req('POST', url, 'u-contribuable')).statusCode).toBe(403);
    const res = await env.req('POST', url, 'u-analyste-rappro');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ kind: 'PROVIDER_PAYMENT_RESOLUTION', legalEffect: 'AUCUN', orderStatusAtRequest: 'INITIE', providerResult: { status: 'CONFIRMED' } });
    expect(calls[1]).toMatchObject({ method: 'GET' });
    // OpenAPI BitriPay 2026-09-01 : recherche par référence MOSOLO, montant et devise (et non plus par intention).
    expect(calls[1]!.url).toMatch(/\/payment_resolution\?reference=PR-[A-Z0-9-]+&amount_minor=\d+&currency=[A-Z]{3}$/);
    expect(calls[1]!.headers['bitripay-account']).toBe(ACCT);
    // « CONFIRMED » chez le prestataire ne vaut ni confirmation signée, ni quittance.
    expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('INITIE');
    expect(env.app.ctx.receipts.receipts.count()).toBe(0);
  });

  it('événement d’un autre compte → 422 + alerte, sans effet ; compte de la Ville → CONFIRME', async () => {
    const env = await setupConnectors({ BITRIPAY_ACCOUNT_ID: ACCT });
    const order = (await createProviderOrder(env, 'bitripay')).json();
    const other = await bitripayWebhook(env, { ...bitripayEvent('payment_intent.succeeded', order), account: 'acct_AutreMarchand' });
    expect(other.statusCode).toBe(422);
    expect(other.json().code).toBe('CONNECTED_ACCOUNT_MISMATCH');
    const missing = await bitripayWebhook(env, bitripayEvent('payment_intent.succeeded', order));
    expect(missing.json().code).toBe('CONNECTED_ACCOUNT_MISMATCH');
    expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('INITIE');
    const ok = await bitripayWebhook(env, { ...bitripayEvent('payment_intent.succeeded', order), account: ACCT });
    expect(ok.json().results[0]).toMatchObject({ status: 'CONFIRME' });

    const plain = await setupConnectors();
    const o2 = (await createProviderOrder(plain, 'bitripay')).json();
    const unexpected = await bitripayWebhook(plain, { ...bitripayEvent('payment_intent.succeeded', o2), account: ACCT });
    expect(unexpected.json().code).toBe('UNEXPECTED_CONNECTED_ACCOUNT');
  });

  it('payment_intent.ambiguous_hold → aucune quittance, exception PROVIDER_AMBIGUOUS jusqu’à la confirmation signée', async () => {
    const env = await setupConnectors();
    const order = (await createProviderOrder(env, 'bitripay')).json();
    const held = await bitripayWebhook(env, bitripayEvent('payment_intent.ambiguous_hold', order));
    expect(held.statusCode).toBe(200);
    expect(held.json().results[0]).toMatchObject({ outcome: 'HELD', reason: 'PROVIDER_AMBIGUOUS', paymentReference: order.paymentReference });
    expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('INITIE');
    expect(env.app.ctx.receipts.receipts.count()).toBe(0);
    const ex = (await env.req('GET', '/v1/reconciliation/exceptions', 'u-analyste-rappro')).json();
    const list = Array.isArray(ex) ? ex : ex.items ?? ex.exceptions;
    expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'PROVIDER_AMBIGUOUS', paymentReference: order.paymentReference })]));

    await bitripayWebhook(env, bitripayEvent('payment_intent.succeeded', order));
    const after = (await env.req('GET', '/v1/reconciliation/exceptions', 'u-analyste-rappro')).json();
    const list2 = Array.isArray(after) ? after : after.items ?? after.exceptions;
    expect(list2.filter((e: { type: string }) => e.type === 'PROVIDER_AMBIGUOUS')).toHaveLength(0);
  });

  it('frais d’application retenu sur l’intention → quittance due au payeur, alerte critique', async () => {
    const env = await setupConnectors();
    const order = (await createProviderOrder(env, 'bitripay')).json();
    const res = await bitripayWebhook(env, bitripayEvent('payment_intent.succeeded', order, { application_fee_minor: 225 }));
    expect(res.json().results[0]).toMatchObject({ status: 'CONFIRME', receiptStatus: 'PROVISOIRE' });
    expect(env.app.ctx.alerts.alerts.find((a) => a.type === 'APPLICATION_FEE_ON_PUBLIC_REVENUE')).toEqual([
      expect.objectContaining({ severity: 'CRITICAL' }),
    ]);
  });

  it('identifiant de compte connecté mal formé → erreur de configuration', () => {
    expect(() => buildApp({ connectorEnv: { BITRIPAY_ACCOUNT_ID: 'compte-ville' } })).toThrow(/BITRIPAY_ACCOUNT_ID/);
  });
});

describe('Console des prestataires et simulation du bac à sable', () => {
  it('console : configuration masquée, statistiques, webhooks ; réservée au Trésor et à l’exploitation', async () => {
    const env = await setupConnectors();
    const order = (await createProviderOrder(env, 'bitripay', 'QR')).json();
    expect((await env.req('GET', '/v1/providers/connectors', 'u-contribuable')).statusCode).toBe(403);
    const sim = await env.req('POST', '/v1/providers/bitripay/sandbox-simulate', 'u-tresor', { paymentReference: order.paymentReference, event: 'succeeded' });
    expect(sim.statusCode).toBe(200);
    expect(sim.json().results[0]).toMatchObject({ status: 'CONFIRME', receiptStatus: 'PROVISOIRE' });
    const settled = await env.req('POST', '/v1/providers/bitripay/sandbox-simulate', 'u-tresor', { paymentReference: order.paymentReference, event: 'settled' });
    expect(settled.json().results[0].outcome).toBe('SETTLEMENT_ANNOUNCED');
    expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('CONFIRME');
    const c = (await env.req('GET', '/v1/providers/connectors', 'u-tresor')).json();
    expect(c.connectors.map((x: { id: string }) => x.id).sort()).toEqual(['bitripay', 'koda']);
    expect(JSON.stringify(c.connectors)).not.toContain(BITRIPAY_DEMO_WEBHOOK_SECRET);
    expect(c.stats.find((s: { id: string }) => s.id === 'bitripay')).toMatchObject({ orders: 1, confirmed: 1, webhooks: 2 });
    expect(c.events[0]).toMatchObject({ provider: 'bitripay', outcome: 'SETTLEMENT_ANNOUNCED' });
    expect(c.settlementAnnouncements).toHaveLength(1);
  });

  it('simulation refusée hors bac à sable local, et à un rôle non habilité', async () => {
    const { fetch } = mockFetch(() => ({ status: 200, body: { id: 'pi_live', checkout_url: 'https://pay.bitripay.com/pi_live', qr_payload: 'BTRP|pi_live' } }));
    const env = await setupConnectors({ BITRIPAY_ED25519_PUBLIC_KEY: BITRI_ED_PUBLIC, BITRIPAY_API_KEY: 'sk_live_SECRET00112233', BITRIPAY_WEBHOOK_SECRET: 'whsec_live' }, fetch);
    const order = (await createProviderOrder(env, 'bitripay', 'QR')).json();
    const res = await env.req('POST', '/v1/providers/bitripay/sandbox-simulate', 'u-tresor', { paymentReference: order.paymentReference, event: 'succeeded' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('SIMULATION_FORBIDDEN');
    expect((await env.req('POST', '/v1/providers/koda/sandbox-simulate', 'u-contribuable', { paymentReference: order.paymentReference, event: 'succeeded' })).statusCode).toBe(403);
    const k = await setupConnectors();
    const ko = (await createProviderOrder(k, 'koda')).json();
    const kr = await k.req('POST', '/v1/providers/koda/sandbox-simulate', 'u-tresor', { paymentReference: ko.paymentReference, event: 'succeeded' });
    expect(kr.json().results[0]).toMatchObject({ status: 'CONFIRME' });
  });
});
