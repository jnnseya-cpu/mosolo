/**
 * Prestataires de paiement BitriPay et KODA — prêts à recevoir les clés et le webhook (28/09/2026).
 * Parcours de bout en bout contre un SIMULATEUR HTTP LOCAL (127.0.0.1, jamais Internet) avec des charges utiles
 * signées réalistes : ordre → intention chez le prestataire → webhook signé → confirmation serveur à serveur →
 * quittance provisoire → rapprochement avec un relevé → quittance définitive. Cas négatifs : mauvaise signature,
 * horodatage ancien, rejeu (y compris après redémarrage), référence inconnue, montant ou devise différents (suspens),
 * doublon, événement hors ordre, prestataire en délai dépassé (503 clair, disjoncteur), configuration partielle.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { PersistenceRuntime } from '../src/persistence/runtime.js';
import { MemorySnapshotStore } from '../src/persistence/store.js';
import { createSoclePlugin } from '../src/plugins/socle/plugin.js';
import { DEFAULT_RATE_LIMITS } from '../src/plugins/socle/rate-limit.js';
import { BITRIPAY_DEMO_WEBHOOK_SECRET, signBitriPayWebhook } from '../src/modules/payments/connectors/bitripay.js';
import { KODA_DEMO_WEBHOOK_SECRET, signKodaWebhook } from '../src/modules/payments/connectors/koda.js';
import { buildConnectorRegistry } from '../src/modules/payments/connectors/registry.js';
import { ConnectorConfigError } from '../src/modules/payments/connectors/types.js';
import { publicBaseUrl, webhookUrlFor } from '../src/modules/payments/readiness.js';
import { DEMO } from '../src/seed.js';
import { postStatement } from './helpers.js';

// ---------------------------------------------------------------------------------------------------------------------
// Simulateur HTTP local des deux prestataires (formes documentées ; hypothèses « à confirmer » isolées ici).
// ---------------------------------------------------------------------------------------------------------------------
interface Intent { id: string; amount: number; currency: string; status: string; metadata: Record<string, string> }
interface Call { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }

const mock = {
  calls: [] as Call[],
  intents: new Map<string, Intent>(),
  /** Délai de réponse imposé (simulation d'un prestataire lent : délai dépassé côté MOSOLO). */
  delayMs: 0,
  /** Statut HTTP imposé (panne). */
  forceStatus: 0,
  /** Statut d'intention renvoyé par GET (sinon celui de l'intention). */
  statusOverride: '' as string,
  amountOverride: 0,
  reset() {
    this.calls = []; this.intents.clear(); this.delayMs = 0; this.forceStatus = 0; this.statusOverride = ''; this.amountOverride = 0;
  },
};
let server: Server;
let base = '';

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  let body = '';
  for await (const chunk of req) body += chunk;
  const path = req.url ?? '/';
  mock.calls.push({ method: req.method ?? 'GET', path, headers: req.headers, body });
  if (mock.delayMs) await new Promise((r) => setTimeout(r, mock.delayMs));
  if (mock.forceStatus) return send(res, mock.forceStatus, { error: { code: 'unavailable' } });
  const view = (i: Intent, provider: 'bitripay' | 'koda') => {
    const status = mock.statusOverride || i.status;
    const amount = mock.amountOverride || i.amount;
    return provider === 'bitripay'
      ? { id: i.id, object: 'payment_intent', status, amount_minor: amount, currency: i.currency.toLowerCase(), metadata: i.metadata }
      : { intent_id: i.id, status, amount, currency: i.currency, metadata: i.metadata };
  };
  // --- BitriPay ---
  if (req.method === 'POST' && path === '/bitripay/v1/payment_intents') {
    const b = JSON.parse(body) as { amount_minor: number; currency: string; metadata: Record<string, string> };
    const id = `pi_${randomUUID().slice(0, 12)}`;
    mock.intents.set(id, { id, amount: b.amount_minor, currency: b.currency, status: 'requires_payment_method', metadata: b.metadata });
    return send(res, 200, { id, checkout_url: `https://pay.bitripay.test/${id}`, qr_payload: `BTRP|${id}`, client_secret: 'cs_ne_doit_pas_fuiter' });
  }
  let m = /^\/bitripay\/v1\/payment_intents\/([^/]+)$/.exec(path);
  if (req.method === 'GET' && m) {
    const i = mock.intents.get(decodeURIComponent(m[1]!));
    return i ? send(res, 200, view(i, 'bitripay')) : send(res, 404, { error: { code: 'resource_missing' } });
  }
  if (req.method === 'GET' && path === '/bitripay/v1/keys') return send(res, 200, { keys: [{ kid: 'k1', alg: 'Ed25519', public_key: 'AAAA' }] });
  // --- KODA ---
  if (req.method === 'POST' && path === '/koda/v1/intents') {
    const b = JSON.parse(body) as { amount: number; currency: string; metadata: Record<string, string> };
    const id = `int_${randomUUID().slice(0, 12)}`;
    mock.intents.set(id, { id, amount: b.amount, currency: b.currency, status: 'pending', metadata: b.metadata });
    return send(res, 200, { intent_id: id, client_secret: 'cs_ne_doit_pas_fuiter', checkout_url: `https://kodajnn.test/c/${id}` });
  }
  m = /^\/koda\/v1\/intents\/([^/]+)$/.exec(path);
  if (req.method === 'GET' && m) {
    const i = mock.intents.get(decodeURIComponent(m[1]!));
    return i ? send(res, 200, view(i, 'koda')) : send(res, 404, { error: 'not_found' });
  }
  if (req.method === 'GET' && path === '/koda/v1/openapi.json') return send(res, 200, { openapi: '3.1.0', info: { title: 'KODA (simulateur)' } });
  return send(res, 404, { error: 'route inconnue du simulateur' });
}

beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => mock.reset());

// Secrets de test (jamais des valeurs réelles, jamais les secrets publics de démonstration).
const BITRI_KEY = 'sk_test_BITRIPAY_RACCORDEMENT_0001';
const BITRI_WHSEC = 'whsec_test_bitripay_raccordement_0001';
const KODA_KEY = 'sk_test_KODA_RACCORDEMENT_0001';
const KODA_WHSEC = 'whsec_test_koda_raccordement_0001';

const realEnv = () => ({
  BITRIPAY_API_KEY: BITRI_KEY, BITRIPAY_WEBHOOK_SECRET: BITRI_WHSEC, BITRIPAY_BASE_URL: `${base}/bitripay/v1`,
  KODA_API_KEY: KODA_KEY, KODA_WEBHOOK_SECRET: KODA_WHSEC, KODA_BASE_URL: `${base}/koda/v1`, KODA_SUCCESS_URL: 'https://portail.exemple.cd/espace',
});

async function boot(opts: { store?: MemorySnapshotStore; clock?: ManualClock; timeoutMs?: number; env?: Record<string, string> } = {}) {
  const clock = opts.clock ?? new ManualClock('2026-09-28T09:00:00.000Z');
  const rt = opts.store ? await PersistenceRuntime.open(opts.store) : undefined;
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} },
    ...(rt ? { plugins: [createSoclePlugin({ rateLimit: { ...DEFAULT_RATE_LIMITS, enabled: false }, persistence: rt })] } : { plugins: [] }),
    connectorEnv: opts.env ?? realEnv(),
    connectorRuntime: { timeoutMs: opts.timeoutMs ?? 2_000, sleep: async () => {}, circuit: { failureThreshold: 3, cooldownMs: 30_000 }, now: () => clock.now().getTime() },
  });
  await app.ready();
  const req = (method: string, url: string, user?: string, body?: unknown, headers: Record<string, string> = {}) => app.inject({
    method: method as 'GET', url,
    headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { app, clock, rt, req };
}
type Env = Awaited<ReturnType<typeof boot>>;

const obligationId = (env: Env) => env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;

async function createOrder(env: Env, provider: 'bitripay' | 'koda') {
  return env.req('POST', `/v1/obligations/${obligationId(env)}/payment-orders`, 'u-contribuable',
    { channel: provider === 'bitripay' ? 'QR' : 'MOBILE_MONEY', provider }, { 'idempotency-key': randomUUID() });
}

/** Marque l'intention payée chez le simulateur (l'opérateur a débité le payeur). */
function payAtProvider(intentId: string, provider: 'bitripay' | 'koda') {
  const i = mock.intents.get(intentId)!;
  i.status = provider === 'bitripay' ? 'succeeded' : 'verified';
}

function bitripayPayload(order: { providerIntentId: string; paymentReference: string }, over: { amount?: number; currency?: string; type?: string; id?: string; extra?: Record<string, unknown> } = {}) {
  return {
    id: over.id ?? `evt_${randomUUID().slice(0, 16)}`, object: 'event', type: over.type ?? 'payment_intent.succeeded', created: 1790586000, livemode: false,
    data: { object: {
      id: order.providerIntentId, object: 'payment_intent', status: 'succeeded', amount_minor: over.amount ?? 15000, currency: over.currency ?? 'usd',
      succeeded_at: '2026-09-28T09:00:00Z', metadata: { payment_reference: order.paymentReference }, ...(over.extra ?? {}),
    } },
  };
}

function kodaPayload(order: { providerIntentId: string; paymentReference: string }, over: { amount?: number; currency?: string; receipt?: string; id?: string; type?: string } = {}) {
  return {
    id: over.id ?? `evt_${randomUUID().slice(0, 16)}`, type: over.type ?? 'payment.verified', created_at: '2026-09-28T09:00:00Z',
    data: { intent_id: order.providerIntentId, amount: over.amount ?? 15000, currency: over.currency ?? 'USD', receipt_id: over.receipt ?? `KR-${randomUUID().slice(0, 8)}`,
      verified_at: '2026-09-28T09:00:00Z', metadata: { payment_reference: order.paymentReference } },
  };
}

function postBitripay(env: Env, payload: unknown, opts: { secret?: string; t?: number; raw?: string } = {}) {
  const raw = opts.raw ?? JSON.stringify(payload);
  const t = opts.t ?? Math.floor(env.clock.now().getTime() / 1000);
  return env.app.inject({
    method: 'POST', url: '/v1/providers/bitripay/webhooks', payload: raw,
    headers: { 'content-type': 'application/json', 'bitripay-signature': signBitriPayWebhook(opts.secret ?? BITRI_WHSEC, raw, t) },
  });
}

function postKoda(env: Env, payload: unknown, opts: { secret?: string; raw?: string; signedRaw?: string } = {}) {
  const raw = opts.raw ?? JSON.stringify(payload);
  return env.app.inject({
    method: 'POST', url: '/v1/providers/koda/webhooks', payload: raw,
    headers: { 'content-type': 'application/json', 'x-koda-signature': signKodaWebhook(opts.secret ?? KODA_WHSEC, opts.signedRaw ?? raw) },
  });
}

async function reconcile(env: Env, paymentReference: string) {
  return postStatement(env, 'u-tresor', {
    statementId: `REL-${randomUUID().slice(0, 8)}`,
    lines: [{ accountAlias: DEMO.dgipkAlias, amount: { amount: '150.00', currency: 'USD' }, valueDate: '2026-09-28', paymentReference }],
  });
}

// ---------------------------------------------------------------------------------------------------------------------
describe('Configuration réelle et démarrage (mode démonstration désactivé)', () => {
  it('clés réelles présentes, démonstration désactivée : connecteurs réels enregistrés (mode TEST / LIVE)', () => {
    const reg = buildConnectorRegistry(realEnv(), {}, false);
    expect(reg.list().map((c) => [c.id, c.mode]).sort()).toEqual([['bitripay', 'TEST'], ['koda', 'TEST']]);
    expect(reg.demoMode).toBe(false);
    expect(reg.setup.map((s) => [s.id, s.configuration, s.registered])).toEqual([['bitripay', 'COMPLETE', true], ['koda', 'COMPLETE', true]]);
    // Aucune valeur secrète dans l'état de raccordement : seulement des noms et des présences.
    const json = JSON.stringify(reg.setup);
    for (const secret of [BITRI_KEY, BITRI_WHSEC, KODA_KEY, KODA_WHSEC]) expect(json).not.toContain(secret);
    expect(reg.setup[0]!.variables.find((v) => v.name === 'BITRIPAY_API_KEY')).toMatchObject({ present: true, secret: true });
    const live = buildConnectorRegistry({ ...realEnv(), BITRIPAY_API_KEY: 'sk_live_X', BITRIPAY_BASE_URL: 'https://api.bitripay.com/v1' }, {}, false);
    expect(live.get('bitripay')!.mode).toBe('LIVE');
  });

  it('secrets de démonstration refusés avec une clé réelle (même en démonstration) et hors démonstration', () => {
    expect(() => buildConnectorRegistry({ ...realEnv(), BITRIPAY_WEBHOOK_SECRET: BITRIPAY_DEMO_WEBHOOK_SECRET }, {}, false)).toThrow(/démonstration/);
    expect(() => buildConnectorRegistry({ ...realEnv(), KODA_WEBHOOK_SECRET: KODA_DEMO_WEBHOOK_SECRET }, {}, true)).toThrow(/clé API réelle/);
    expect(() => buildConnectorRegistry({ KODA_WEBHOOK_SECRET: KODA_DEMO_WEBHOOK_SECRET }, {}, false)).toThrow(ConnectorConfigError);
  });

  it('configuration partielle : démarrage refusé avec un message clair nommant la variable', () => {
    const env = realEnv();
    const without = (k: keyof ReturnType<typeof realEnv>) => Object.fromEntries(Object.entries(env).filter(([n]) => n !== k));
    expect(() => buildConnectorRegistry(without('BITRIPAY_WEBHOOK_SECRET'), {}, false)).toThrow(/BitriPay : secret de webhook obligatoire/);
    expect(() => buildConnectorRegistry(without('KODA_WEBHOOK_SECRET'), {}, false)).toThrow(/KODA : secret de webhook obligatoire/);
    expect(() => buildConnectorRegistry(without('KODA_SUCCESS_URL'), {}, false)).toThrow(/KODA_SUCCESS_URL est obligatoire/);
    expect(() => buildConnectorRegistry({ BITRIPAY_ACCOUNT_ID: 'acct_VilleKinshasa01', BITRIPAY_WEBHOOK_SECRET: BITRI_WHSEC }, {}, false)).toThrow(/BITRIPAY_ACCOUNT_ID fourni sans BITRIPAY_API_KEY/);
    expect(() => buildConnectorRegistry({ ...env, BITRIPAY_ED25519_REQUIRED: 'true' }, {}, false)).toThrow(/BITRIPAY_ED25519_PUBLIC_KEY/);
    // Réel : https exigé (URL de l'API et URL de retour) ; http admis seulement vers la boucle locale en clé de test.
    expect(() => buildConnectorRegistry({ ...env, KODA_API_KEY: 'sk_live_K', KODA_BASE_URL: `${base}/koda/v1` }, {}, false)).toThrow(/KODA_BASE_URL doit être en https/);
    expect(() => buildConnectorRegistry({ ...env, KODA_SUCCESS_URL: 'http://portail.exemple.cd/retour' }, {}, false)).toThrow(/KODA_SUCCESS_URL doit être en https/);
    expect(() => buildConnectorRegistry({ ...env, BITRIPAY_BASE_URL: 'http://api.bitripay.com/v1' }, {}, false)).toThrow(/BITRIPAY_BASE_URL/);
    expect(() => buildConnectorRegistry({ ...env, KODA_BASE_URL: 'pas une url' }, {}, false)).toThrow(/URL valide/);
  });

  it('secret de webhook sans clé API hors démonstration : configuration PARTIELLE — aucune intention simulée, aucune quittance', async () => {
    const reg = buildConnectorRegistry({ KODA_WEBHOOK_SECRET: KODA_WHSEC }, {}, false);
    expect(reg.setup.find((s) => s.id === 'koda')).toMatchObject({ configuration: 'PARTIELLE', registered: true });
    const env = await boot({ env: { KODA_WEBHOOK_SECRET: KODA_WHSEC } });
    env.app.ctx.connectors.demoMode = false; // hors démonstration (le reste de l'application reste en démonstration pour le test)
    const res = await createOrder(env, 'koda');
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'PROVIDER_NOT_CONFIGURED' });
    await env.app.close();
  });

  it('URL des webhooks construite depuis MOSOLO_PUBLIC_URL (https exigé)', () => {
    expect(publicBaseUrl({ MOSOLO_PUBLIC_URL: 'https://mosolo.kinshasa.cd/' })).toMatchObject({ value: 'https://mosolo.kinshasa.cd', valid: true });
    expect(webhookUrlFor('https://mosolo.kinshasa.cd', 'bitripay')).toBe('https://mosolo.kinshasa.cd/v1/providers/bitripay/webhooks');
    expect(webhookUrlFor('https://mosolo.kinshasa.cd', 'koda')).toBe('https://mosolo.kinshasa.cd/v1/providers/koda/webhooks');
    expect(publicBaseUrl({ MOSOLO_PUBLIC_URL: 'http://mosolo.kinshasa.cd' }).valid).toBe(false);
    expect(publicBaseUrl({})).toMatchObject({ value: null, valid: false });
    expect(webhookUrlFor(null, 'koda')).toBe('https://<domaine>/v1/providers/koda/webhooks');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
for (const provider of ['bitripay', 'koda'] as const) {
  const label = provider === 'bitripay' ? 'BitriPay' : 'KODA';
  const post = (env: Env, payload: unknown, opts: { secret?: string; t?: number } = {}) => (provider === 'bitripay' ? postBitripay(env, payload, opts) : postKoda(env, payload, opts));
  const payload = (order: { providerIntentId: string; paymentReference: string }, over: { amount?: number; currency?: string; id?: string } = {}) =>
    (provider === 'bitripay' ? bitripayPayload(order, over) : kodaPayload(order, over));

  describe(`${label} — parcours de bout en bout (simulateur HTTP local)`, () => {
    it('ordre → intention → webhook signé → confirmation serveur à serveur → quittance → rapprochement avec un relevé', async () => {
      const env = await boot();
      const res = await createOrder(env, provider);
      expect(res.statusCode).toBe(201);
      const order = res.json();
      expect(order).toMatchObject({ provider, sandbox: true, status: 'INITIE' });
      expect(JSON.stringify(order)).not.toContain('cs_ne_doit_pas_fuiter');
      const init = mock.calls.find((c) => c.method === 'POST')!;
      expect(init.headers.authorization).toBe(`Bearer ${provider === 'bitripay' ? BITRI_KEY : KODA_KEY}`);
      expect(init.headers['idempotency-key']).toBe(order.paymentReference);
      // Unités mineures : 150,00 USD = 15000 chez les deux prestataires.
      expect(JSON.parse(init.body)).toMatchObject(provider === 'bitripay' ? { amount_minor: 15000, currency: 'USD' } : { amount: 15000, currency: 'USD' });

      // Webhook arrivé AVANT que l'état soit final chez le prestataire : 409, rien n'est mémorisé ni quittancé.
      const early = payload(order);
      const tooEarly = await post(env, early);
      expect(tooEarly.statusCode).toBe(409);
      expect(tooEarly.json().code).toBe('PROVIDER_STATUS_NOT_FINAL');
      expect(env.app.ctx.receipts.receipts.count()).toBe(0);

      payAtProvider(order.providerIntentId, provider);
      const ok = await post(env, early); // le prestataire renvoie le même événement
      expect(ok.statusCode).toBe(200);
      expect(ok.json().results[0]).toMatchObject({ outcome: 'PROCESSED', status: 'CONFIRME', receiptStatus: 'PROVISOIRE' });
      const gets = mock.calls.filter((c) => c.method === 'GET' && c.path.includes(order.providerIntentId));
      expect(gets.length).toBe(2); // une interrogation serveur à serveur par présentation
      const stored = env.app.ctx.payments.byReference(order.paymentReference)!;
      expect(stored).toMatchObject({ status: 'CONFIRME', serverToServerCheck: { method: 'INTERROGATION_STATUT' }, beneficiaryAlias: DEMO.dgipkAlias });
      expect(env.app.ctx.payments.statusQueries.all().map((q) => q.outcome)).toEqual(['EN_ATTENTE', 'CONFIRME']);
      expect(env.app.ctx.audit.list({ action: 'payment.s2s_status.confirmed' }).total).toBe(1);

      // Rapprochement avec le relevé du compte public : RAPPROCHE et quittance définitive.
      const st = await reconcile(env, order.paymentReference);
      expect(st.statusCode).toBeLessThan(300);
      expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('RAPPROCHE');
      expect(env.app.ctx.receipts.byPaymentOrder(stored.id)!.status).toBe('DEFINITIVE');
      expect(env.app.ctx.ledger.balance().balanced).toBe(true);

      // Vue de raccordement : dernier webhook valide, dernière interrogation confirmée, aucun secret.
      const view = await env.req('GET', '/v1/providers/readiness', 'u-rssi');
      expect(view.statusCode).toBe(200);
      const p = view.json().providers.find((x: { id: string }) => x.id === provider);
      expect(p).toMatchObject({ registered: true, mode: 'TEST', configuration: 'COMPLETE', lastWebhook: { verification: 'VALIDE', httpStatus: 200 }, lastStatusQuery: { outcome: 'CONFIRME' } });
      expect(p.webhookUrl).toMatch(new RegExp(`/v1/providers/${provider}/webhooks$`));
      for (const secret of [BITRI_KEY, BITRI_WHSEC, KODA_KEY, KODA_WHSEC]) expect(JSON.stringify(view.json())).not.toContain(secret);
      await env.app.close();
    });

    it('mauvaise signature → 401 + alerte ; réception journalisée « signature invalide » ; aucun appel au prestataire', async () => {
      const env = await boot();
      const order = (await createOrder(env, provider)).json();
      payAtProvider(order.providerIntentId, provider);
      const before = mock.calls.length;
      const bad = await post(env, payload(order), { secret: 'whsec_autre' });
      expect(bad.statusCode).toBe(401);
      expect(bad.json().code).toBe('INVALID_SIGNATURE');
      expect(mock.calls.length).toBe(before);
      expect(env.app.ctx.payments.webhookReceptions.all().at(-1)).toMatchObject({ provider, verification: 'INVALID_SIGNATURE', httpStatus: 401 });
      // Corps modifié après signature (signature calculée sur le corps brut d'origine).
      const raw = JSON.stringify(payload(order));
      const tampered = provider === 'koda'
        ? await postKoda(env, null, { raw: raw.replace('15000', '15001'), signedRaw: raw })
        : await env.app.inject({ method: 'POST', url: '/v1/providers/bitripay/webhooks', payload: raw.replace('15000', '15001'),
          headers: { 'content-type': 'application/json', 'bitripay-signature': signBitriPayWebhook(BITRI_WHSEC, raw, Math.floor(env.clock.now().getTime() / 1000)) } });
      expect(tampered.statusCode).toBe(401);
      expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('INITIE');
      expect(env.app.ctx.alerts.alerts.find((a) => a.type === 'INVALID_SIGNATURE' && a.source === `prestataire:${provider}`).length).toBe(2);
      await env.app.close();
    });

    it('rejeu : 200 sans double effet, y compris APRÈS REDÉMARRAGE (mémoire des événements persistée)', async () => {
      const store = new MemorySnapshotStore();
      const clock = new ManualClock('2026-09-28T09:00:00.000Z');
      const env1 = await boot({ store, clock });
      const order = (await createOrder(env1, provider)).json();
      payAtProvider(order.providerIntentId, provider);
      const ev = payload(order);
      expect((await post(env1, ev)).json().results[0].status).toBe('CONFIRME');
      const dup = await post(env1, ev);
      expect(dup.statusCode).toBe(200);
      expect(dup.json().results[0]).toMatchObject({ replayed: true });
      await env1.app.close();
      await env1.rt!.flush();
      expect((await store.loadAll()).some((r) => r.repo === 'payments.webhookEvents')).toBe(true);

      clock.advance(60_000);
      const env2 = await boot({ store, clock });
      const entries = env2.app.ctx.ledger.list().length;
      const receipts = env2.app.ctx.receipts.receipts.count();
      const calls = mock.calls.length;
      const replay = await post(env2, ev);
      expect(replay.statusCode).toBe(200);
      expect(replay.json().results[0]).toMatchObject({ replayed: true, status: 'CONFIRME' });
      expect(env2.app.ctx.receipts.receipts.count()).toBe(receipts);
      expect(env2.app.ctx.ledger.list().length).toBe(entries);
      expect(mock.calls.length).toBe(calls); // aucun appel au prestataire pour un rejeu
      await env2.app.close();
    });

    it('référence inconnue → 422 + mise en suspens (une seule fois), jamais portée sur une obligation', async () => {
      const env = await boot();
      const order = (await createOrder(env, provider)).json();
      payAtProvider(order.providerIntentId, provider);
      // Événement signé d'une intention payée chez le prestataire mais dont la référence MOSOLO n'existe pas.
      const ghost = { providerIntentId: order.providerIntentId, paymentReference: 'PR-INCO-NNUEX' };
      const intentId = `${provider === 'bitripay' ? 'pi' : 'int'}_fantome`;
      mock.intents.set(intentId, { id: intentId, amount: 15000, currency: 'USD', status: provider === 'bitripay' ? 'succeeded' : 'verified', metadata: {} });
      const ev = payload({ ...ghost, providerIntentId: intentId });
      const r1 = await post(env, ev);
      expect(r1.statusCode).toBe(422);
      expect(r1.json().code).toBe('UNKNOWN_PAYMENT_REFERENCE');
      await post(env, ev); // renvoi par le prestataire
      expect(env.app.ctx.payments.providerSuspense.all()).toEqual([expect.objectContaining({ provider, reason: 'REFERENCE_INCONNUE', paymentReference: 'PR-INCO-NNUEX' })]);
      expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('INITIE');
      expect(env.app.ctx.receipts.receipts.count()).toBe(0);
      const ex = (await env.req('GET', '/v1/reconciliation/exceptions', 'u-analyste-rappro')).json();
      const list = Array.isArray(ex) ? ex : ex.items ?? ex.exceptions;
      expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'PROVIDER_EVENT_UNKNOWN_REFERENCE', queue: 'PAIEMENT_SANS_OBLIGATION' })]));
      await env.app.close();
    });

    it('montant ou devise différents → 422 + suspens (ECART_MONTANT / ECART_DEVISE), ordre intact', async () => {
      const env = await boot();
      const order = (await createOrder(env, provider)).json();
      payAtProvider(order.providerIntentId, provider);
      mock.amountOverride = 14999;
      const r = await post(env, payload(order, { amount: 14999 }));
      expect(r.statusCode).toBe(422);
      expect(r.json().code).toBe('AMOUNT_MISMATCH');
      mock.amountOverride = 0;
      mock.intents.get(order.providerIntentId)!.currency = 'CDF';
      const cur = await post(env, payload(order, { currency: 'CDF' }));
      expect(cur.statusCode).toBe(422);
      expect(env.app.ctx.payments.providerSuspense.all().map((x) => x.reason)).toEqual(['ECART_MONTANT', 'ECART_DEVISE']);
      expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('INITIE');
      expect(env.app.ctx.receipts.receipts.count()).toBe(0);
      expect(env.app.ctx.alerts.alerts.find((a) => a.type === 'AMOUNT_MISMATCH').length).toBe(2);
      await env.app.close();
    });

    it('webhook « payé » contredit par l’interrogation serveur à serveur → 422, alerte critique, suspens, aucune quittance', async () => {
      const env = await boot();
      const order = (await createOrder(env, provider)).json();
      mock.intents.get(order.providerIntentId)!.status = 'failed';
      const r = await post(env, payload(order));
      expect(r.statusCode).toBe(422);
      expect(r.json().code).toBe('PROVIDER_STATUS_CONTRADICTION');
      expect(env.app.ctx.alerts.alerts.find((a) => a.type === 'PROVIDER_STATUS_CONTRADICTION')).toEqual([expect.objectContaining({ severity: 'CRITICAL' })]);
      expect(env.app.ctx.payments.providerSuspense.all()).toEqual([expect.objectContaining({ reason: 'ETAT_CONTREDIT' })]);
      expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('INITIE');
      expect(env.app.ctx.receipts.receipts.count()).toBe(0);
      await env.app.close();
    });

    it('doublon (second paiement sur une référence déjà payée) → DOUBLON, fonds en compte d’attente, aucune 2e quittance', async () => {
      const env = await boot();
      const order = (await createOrder(env, provider)).json();
      payAtProvider(order.providerIntentId, provider);
      expect((await post(env, payload(order))).json().results[0].status).toBe('CONFIRME');
      // Second paiement distinct (autre reçu KODA / même intention BitriPay rejouée sous un autre événement).
      const second = await post(env, payload(order));
      expect(second.statusCode).toBe(200);
      const r = second.json().results[0];
      if (provider === 'koda') expect(r).toMatchObject({ status: 'DOUBLON' });
      else expect(r).toMatchObject({ status: 'CONFIRME', replayed: true });
      expect(env.app.ctx.receipts.receipts.count()).toBe(1);
      await env.app.close();
    });

    it('prestataire en délai dépassé : 502 sans ordre, tentatives bornées, puis disjoncteur ouvert → 503 clair avec Retry-After ; webhook sans confirmation serveur → 503 non mémorisé', async () => {
      const env = await boot({ timeoutMs: 150 });
      mock.delayMs = 600;
      const codes: number[] = [];
      let open;
      for (let i = 0; i < 5 && !open; i++) {
        const r = await createOrder(env, provider);
        codes.push(r.statusCode);
        if (r.statusCode === 503) open = r;
        else expect(r.json().code).toBe('PROVIDER_UNAVAILABLE');
      }
      // Trois échecs consécutifs (seuil de test) ⇒ disjoncteur ouvert : 503 immédiat, explicite, sans appel.
      expect(codes).toEqual([502, 502, 502, 503]);
      expect(open!.json().code).toBe('PROVIDER_CIRCUIT_OPEN');
      expect(open!.json().detail).toMatch(/momentanément indisponible/);
      expect(Number(open!.headers['retry-after'])).toBeGreaterThan(0);
      // BitriPay rejoue ses POST (idempotence documentée) : 3 essais par ordre ; KODA jamais (idempotence non confirmée).
      const posts = mock.calls.filter((c) => c.method === 'POST').length;
      expect(posts).toBe(provider === 'bitripay' ? 9 : 3);
      expect(env.app.ctx.payments.orders.count()).toBe(0);
      const view = (await env.req('GET', '/v1/providers/readiness', 'u-superadmin')).json();
      expect(view.providers.find((x: { id: string }) => x.id === provider).circuit.state).toBe('OUVERT');

      // Refroidissement écoulé, prestataire rétabli : l'appel d'essai passe et referme le disjoncteur.
      mock.delayMs = 0;
      env.clock.advance(31_000);
      const order = (await createOrder(env, provider)).json();
      expect(order.status).toBe('INITIE');
      payAtProvider(order.providerIntentId, provider);

      // Webhook pendant une nouvelle panne : confirmation serveur à serveur impossible ⇒ 503, rien de mémorisé.
      mock.delayMs = 600;
      const ev = payload(order);
      const w = await post(env, ev);
      expect(w.statusCode).toBe(503);
      expect(w.json().code).toBe('PROVIDER_STATUS_UNAVAILABLE');
      expect(w.headers['retry-after']).toBe('60');
      expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('INITIE');
      expect(env.app.ctx.receipts.receipts.count()).toBe(0);
      expect(env.app.ctx.payments.statusQueries.all().at(-1)).toMatchObject({ outcome: 'ECHEC_APPEL' });
      // Le prestataire renvoie l'événement une fois rétabli : confirmé.
      mock.delayMs = 0;
      const again = await post(env, ev);
      expect(again.statusCode).toBe(200);
      expect(again.json().results[0]).toMatchObject({ status: 'CONFIRME', receiptStatus: 'PROVISOIRE' });
      await env.app.close();
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
describe('Sécurité propre à chaque prestataire', () => {
  it('BitriPay : horodatage signé trop ancien → 401 TIMESTAMP_OUT_OF_WINDOW, sans appel au prestataire', async () => {
    const env = await boot();
    const order = (await createOrder(env, 'bitripay')).json();
    payAtProvider(order.providerIntentId, 'bitripay');
    const calls = mock.calls.length;
    const old = await postBitripay(env, bitripayPayload(order), { t: Math.floor(env.clock.now().getTime() / 1000) - 301 });
    expect(old.statusCode).toBe(401);
    expect(old.json().code).toBe('TIMESTAMP_OUT_OF_WINDOW');
    expect(mock.calls.length).toBe(calls);
    expect(env.app.ctx.payments.webhookReceptions.all().at(-1)).toMatchObject({ verification: 'TIMESTAMP_OUT_OF_WINDOW' });
    await env.app.close();
  });

  it('KODA : aucun horodatage signé — un rejeu tardif est arrêté par l’identifiant d’événement persistant', async () => {
    const env = await boot();
    const order = (await createOrder(env, 'koda')).json();
    payAtProvider(order.providerIntentId, 'koda');
    const ev = kodaPayload(order);
    expect((await postKoda(env, ev)).json().results[0].status).toBe('CONFIRME');
    env.clock.advanceHours(24);
    const late = await postKoda(env, ev);
    expect(late.statusCode).toBe(200);
    expect(late.json().results[0]).toMatchObject({ replayed: true });
    expect(env.app.ctx.receipts.receipts.count()).toBe(1);
    await env.app.close();
  });

  it('BitriPay : événement FAILED (canceled) après SUCCESS → ignoré et journalisé, ordre inchangé', async () => {
    const env = await boot();
    const order = (await createOrder(env, 'bitripay')).json();
    payAtProvider(order.providerIntentId, 'bitripay');
    expect((await postBitripay(env, bitripayPayload(order))).json().results[0].status).toBe('CONFIRME');
    const canceled = await postBitripay(env, bitripayPayload(order, { type: 'payment_intent.canceled' }));
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json().results[0]).toMatchObject({ status: 'ECHOUE', ignored: { orderStatus: 'CONFIRME' } });
    expect(env.app.ctx.payments.byReference(order.paymentReference)!.status).toBe('CONFIRME');
    expect(env.app.ctx.audit.list({ action: 'payment.failure_ignored' }).total).toBe(1);
    await env.app.close();
  });

  it('compte de règlement : toujours l’alias verrouillé du coffre, jamais un compte lu dans le webhook', async () => {
    const env = await boot();
    const order = (await createOrder(env, 'bitripay')).json();
    payAtProvider(order.providerIntentId, 'bitripay');
    const ev = bitripayPayload(order, { extra: { destination_account: 'CD00-COMPTE-PIRATE', settlement_account: 'COMPTE-PRIVE', beneficiary: { account_number: '0000' } } });
    const r = await postBitripay(env, ev);
    expect(r.json().results[0].status).toBe('CONFIRME');
    const o = env.app.ctx.payments.byReference(order.paymentReference)!;
    expect(o.beneficiaryAlias).toBe(DEMO.dgipkAlias);
    expect(env.app.ctx.receipts.byPaymentOrder(o.id)!.beneficiaryAlias).toBe(DEMO.dgipkAlias);
    expect(JSON.stringify(env.app.ctx.ledger.list())).not.toMatch(/PIRATE|COMPTE-PRIVE/);
    await env.app.close();
  });

  it('voie synchrone (simulation) refusée pour un connecteur réel : la confirmation serveur à serveur est exigée', async () => {
    const env = await boot();
    const order = (await createOrder(env, 'koda')).json();
    const raw = JSON.stringify(kodaPayload(order));
    expect(() => env.app.ctx.payments.handleConnectorWebhook('koda', { 'x-koda-signature': signKodaWebhook(KODA_WHSEC, raw) }, raw)).toThrow(/serveur à serveur/);
    expect(env.app.ctx.receipts.receipts.count()).toBe(0);
    await env.app.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('Vue « Prestataires de paiement — état de raccordement » et « Tester la connexion »', () => {
  it('réservée à R17, R26, R28 ; noms de variables et présence seulement ; URL du webhook ; schéma de signature', async () => {
    const env = await boot();
    for (const u of ['u-contribuable', 'u-analyste-rappro', 'u-agent-terrain']) expect((await env.req('GET', '/v1/providers/readiness', u)).statusCode).toBe(403);
    for (const u of ['u-tresor', 'u-superadmin', 'u-rssi']) expect((await env.req('GET', '/v1/providers/readiness', u)).statusCode).toBe(200);
    const v = (await env.req('GET', '/v1/providers/readiness', 'u-tresor')).json();
    expect(v.providers.map((p: { id: string }) => p.id)).toEqual(['bitripay', 'koda']);
    const b = v.providers[0];
    expect(b.variables.find((x: { name: string }) => x.name === 'BITRIPAY_WEBHOOK_SECRET')).toMatchObject({ present: true, secret: true });
    expect(b.variables.find((x: { name: string }) => x.name === 'BITRIPAY_ED25519_PUBLIC_KEY')).toMatchObject({ present: false });
    expect(b.signatureScheme).toMatch(/BitriPay-Signature/);
    expect(v.providers[1].signatureScheme).toMatch(/x-koda-signature/);
    expect(b.settlementAccount).toMatchObject({ alias: DEMO.dgipkAlias, inVault: true, locked: true });
    expect(b.operators).toEqual(['orange_cd', 'mpesa_cd', 'airtel_cd', 'africell_cd']);
    expect(b.assumptions.length).toBeGreaterThan(5);
    const s = JSON.stringify(v);
    for (const secret of [BITRI_KEY, BITRI_WHSEC, KODA_KEY, KODA_WHSEC]) expect(s).not.toContain(secret);
    expect(s).not.toMatch(/…[A-Za-z0-9]{4}"/); // pas même une valeur masquée (« sk_test_…a1b2 »)
    await env.app.close();
  });

  it('Tester la connexion : appel réel inoffensif (BitriPay GET /v1/keys, KODA GET /v1/openapi.json), explicite ; validation à blanc sinon', async () => {
    const env = await boot();
    expect((await env.req('POST', '/v1/providers/bitripay/test-connection', 'u-contribuable', {})).statusCode).toBe(403);
    const b = (await env.req('POST', '/v1/providers/bitripay/test-connection', 'u-superadmin', {})).json();
    expect(b).toMatchObject({ kind: 'APPEL_REEL', ok: true, endpoint: 'GET /keys', provider: 'bitripay' });
    const k = (await env.req('POST', '/v1/providers/koda/test-connection', 'u-rssi', {})).json();
    expect(k).toMatchObject({ kind: 'APPEL_REEL', ok: true, endpoint: 'GET /openapi.json' });
    expect(k.proves).toMatch(/Ne prouve PAS la validité de la clé/);
    expect(mock.calls.filter((c) => c.method === 'POST')).toHaveLength(0); // aucun appel engageant de l'argent
    mock.forceStatus = 503;
    const down = (await env.req('POST', '/v1/providers/koda/test-connection', 'u-tresor', {})).json();
    expect(down).toMatchObject({ kind: 'APPEL_REEL', ok: false });
    const v = (await env.req('GET', '/v1/providers/readiness', 'u-tresor')).json();
    expect(v.providers[1].lastConnectionTest).toMatchObject({ ok: false, by: 'u-tresor' });
    expect(env.app.ctx.audit.list({ action: 'provider.connection.tested' }).total).toBe(3);
    await env.app.close();

    // Bac à sable local (aucune clé) : validation à blanc, aucun appel.
    const sbx = await boot({ env: {} });
    const calls = mock.calls.length;
    const r = (await sbx.req('POST', '/v1/providers/koda/test-connection', 'u-tresor', {})).json();
    expect(r).toMatchObject({ kind: 'VALIDATION_A_BLANC' });
    expect(r.proves).toMatch(/Aucun appel/);
    expect(mock.calls.length).toBe(calls);
    await sbx.app.close();
  });
});
