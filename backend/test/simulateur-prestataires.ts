/**
 * Simulateur HTTP LOCAL (127.0.0.1, jamais Internet) des API BitriPay et KODA, aux formes de leur documentation publique
 * fournie par le maître d'ouvrage le 29/09/2026 — y compris la page de paiement hébergée (« checkout ») et les numéros /
 * références magiques des bacs à sable :
 *  - BitriPay : +243000000501 réussit, +243000000404 échoue, +243000000408 ambigu, +243000000500 délai puis succès,
 *    +243000000503 prestataire indisponible, numéros finissant par 0000 refusés ; GET /status, GET /payment_resolution ;
 *  - KODA : TEST-OK-25000 (vérifié aussitôt), TEST-LATE-90 (vérifié après 90 s, payment.verified.late), TEST-REPLAY
 *    (code_already_used), TEST-SUFFIX (msisdn_suffix_mismatch ⇒ défi) ; GET /ping ; HTTP 429 + Retry-After.
 * Utilisé par les tests de l'aller-retour de paiement et de la console « Clés et raccordements ».
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

export interface SimIntent {
  id: string;
  provider: 'bitripay' | 'koda';
  amount: number;
  currency: string;
  status: string;
  metadata: Record<string, string>;
  body: Record<string, unknown>;
  /** Verdict forcé de GET /payment_resolution. */
  resolution?: string;
  /** Statuts successifs renvoyés par GET (délai puis succès). */
  statusQueue?: string[];
  /** Horodatage (ms) à partir duquel une vérification tardive KODA aboutit. */
  lateAt?: number;
  /** Prestataire indisponible pour cette intention (GET en 503). */
  unavailable?: boolean;
}

export interface SimCall { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }

export class ProviderSimulator {
  calls: SimCall[] = [];
  intents = new Map<string, SimIntent>();
  bitriState = 'operational';
  /** Limitation de débit : les `count` prochains appels dont le chemin contient `match` reçoivent 429 + Retry-After. */
  rateLimit: null | { match: string; method?: string; count: number; retryAfter: string } = null;
  /** Erreur injectée (forme OpenAPI BitriPay {error:{code, bp, message}}) sur les `count` prochains appels correspondants. */
  inject: null | { match: string; method?: string; count: number; status: number; code: string; bp?: string } = null;
  /** Clés acceptées par l'authentification du simulateur (GET /ping, et toutes les routes si non vide). */
  acceptedKeys = new Set<string>();
  private server?: Server;
  base = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  reset(): void {
    this.calls = []; this.intents.clear(); this.bitriState = 'operational'; this.rateLimit = null; this.acceptedKeys.clear(); this.inject = null;
  }

  private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  private statusOf(i: SimIntent): string {
    if (i.statusQueue && i.statusQueue.length > 0) {
      const s = i.statusQueue.shift()!;
      if (i.statusQueue.length === 0) i.status = s;
      return s;
    }
    return i.status;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    let body = '';
    for await (const chunk of req) body += chunk;
    const path = req.url ?? '/';
    const method = req.method ?? 'GET';
    this.calls.push({ method, path, headers: req.headers, body });
    if (this.rateLimit && this.rateLimit.count > 0 && path.includes(this.rateLimit.match) && (!this.rateLimit.method || this.rateLimit.method === method)) {
      this.rateLimit.count -= 1;
      return this.send(res, 429, { error: { code: 'rate_limited' } }, { 'retry-after': this.rateLimit.retryAfter });
    }
    if (this.inject && this.inject.count > 0 && path.includes(this.inject.match) && (!this.inject.method || this.inject.method === method)) {
      this.inject.count -= 1;
      return this.send(res, this.inject.status, { error: { code: this.inject.code, ...(this.inject.bp ? { bp: this.inject.bp } : {}), message: 'erreur simulée', details: {} } });
    }
    if (this.acceptedKeys.size > 0) {
      const auth = String(req.headers.authorization ?? '');
      if (!this.acceptedKeys.has(auth.replace(/^Bearer /, ''))) return this.send(res, 401, { error: { code: 'invalid_api_key' } });
    }
    // ------------------------------------------------------------------ BitriPay
    if (method === 'POST' && path === '/bitripay/v1/payment_intents') {
      const b = JSON.parse(body) as { amount_minor: number; currency: string; metadata: Record<string, string> };
      const id = `pi_${randomUUID().slice(0, 12)}`;
      this.intents.set(id, { id, provider: 'bitripay', amount: b.amount_minor, currency: b.currency, status: 'requires_payment_method', metadata: b.metadata, body: b as unknown as Record<string, unknown> });
      return this.send(res, 200, { id, object: 'payment_intent', checkout_url: `https://pay.bitripay.test/c/${id}`, qr_payload: `BTRP|${id}`, client_secret: `${id}_secret_ne_doit_pas_fuiter` });
    }
    let m = /^\/bitripay\/v1\/payment_intents\/([^/]+)$/.exec(path);
    if (method === 'GET' && m) {
      const i = this.intents.get(decodeURIComponent(m[1]!));
      if (!i) return this.send(res, 404, { error: { code: 'resource_missing' } });
      if (i.unavailable) return this.send(res, 503, { error: { code: 'provider_unavailable' } });
      return this.send(res, 200, { id: i.id, object: 'payment_intent', status: this.statusOf(i), amount_minor: i.amount, currency: i.currency.toLowerCase(), metadata: i.metadata });
    }
    if (method === 'GET' && path === '/bitripay/v1/status') {
      return this.send(res, 200, { operating_state: this.bitriState, guardian: this.bitriState === 'guardian', degraded: this.bitriState === 'degraded', message: this.bitriState === 'operational' ? null : 'Opérateur mpesa_cd ralenti' });
    }
    if (method === 'GET' && path.startsWith('/bitripay/v1/payment_resolution')) {
      const q = new URL(path, 'http://x').searchParams;
      // OpenAPI 2026-09-01 : recherche par référence (et montant / devise s'ils sont fournis).
      const ref = q.get('reference');
      const i = [...this.intents.values()].find((x) => x.provider === 'bitripay' && (x.body.reference === ref || x.metadata.payment_reference === ref)
        && (!q.get('amount_minor') || String(x.amount) === q.get('amount_minor')) && (!q.get('currency') || x.currency === q.get('currency')));
      const resolution = !i ? 'NOT_FOUND' : i.resolution ?? (i.status === 'succeeded' ? 'CONFIRMED' : 'PENDING');
      return this.send(res, 200, { object: 'payment_resolution', reference: ref, payment_intent: i?.id ?? null, resolution });
    }
    if (method === 'GET' && path === '/bitripay/v1/keys') return this.send(res, 200, { keys: [{ kid: 'k1', alg: 'Ed25519', public_key: 'AAAA' }] }, { etag: '"k1"' });
    // ------------------------------------------------------------------ KODA
    if (method === 'GET' && path === '/koda/v1/ping') return this.send(res, 200, { ok: true, livemode: false });
    if (method === 'POST' && path === '/koda/v1/intents') {
      const b = JSON.parse(body) as { amount: number; currency: string; metadata: Record<string, string> };
      const id = `int_${randomUUID().slice(0, 12)}`;
      this.intents.set(id, { id, provider: 'koda', amount: b.amount, currency: b.currency, status: 'pending', metadata: b.metadata, body: b as unknown as Record<string, unknown> });
      return this.send(res, 200, { intent_id: id, client_secret: `cs_${id}_ne_doit_pas_fuiter`, checkout_url: `https://kodajnn.test/checkout/${id}` });
    }
    m = /^\/koda\/v1\/intents\/([^/]+)$/.exec(path);
    if (method === 'GET' && m) {
      const i = this.intents.get(decodeURIComponent(m[1]!));
      return i ? this.send(res, 200, { intent_id: i.id, status: this.statusOf(i), amount: i.amount, currency: i.currency, metadata: i.metadata }) : this.send(res, 404, { error: { code: 'not_found' } });
    }
    m = /^\/koda\/v1\/intents\/([^/]+)\/verify$/.exec(path);
    if (method === 'POST' && m) {
      const i = this.intents.get(decodeURIComponent(m[1]!));
      if (!i) return this.send(res, 404, { error: { code: 'not_found' } });
      const ref = (JSON.parse(body || '{}') as { reference?: string }).reference;
      if (ref === 'TEST-OK-25000') return this.send(res, 200, { status: 'verified' });
      if (ref === 'TEST-LATE-90') return this.send(res, 200, { status: 'pending', verify_after_seconds: 90 });
      if (ref === 'TEST-REPLAY') return this.send(res, 409, { error: { code: 'code_already_used' } });
      if (ref === 'TEST-SUFFIX') return this.send(res, 200, { status: 'challenge', reason: 'msisdn_suffix_mismatch' });
      return this.send(res, 422, { error: { code: 'reference_unknown' } });
    }
    return this.send(res, 404, { error: 'route inconnue du simulateur' });
  }

  // ------------------------------------------------------------------ page de paiement hébergée (le payeur)
  /**
   * Le payeur saisit son numéro sur la page BitriPay : issue du bac à sable, et TYPE d'événement que BitriPay enverra
   * (null : aucun webhook).
   */
  bitripayCheckout(intentId: string, msisdn: string): string | null {
    const i = this.intents.get(intentId)!;
    if (msisdn.endsWith('0000')) return 'payment_intent.payment_failed';
    switch (msisdn) {
      case '+243000000501': i.status = 'succeeded'; return 'payment_intent.succeeded';
      case '+243000000404': return 'payment_intent.payment_failed';
      case '+243000000408': i.status = 'processing'; i.resolution = 'AMBIGUOUS'; return 'payment_intent.ambiguous_hold';
      case '+243000000500': i.statusQueue = ['processing', 'succeeded']; i.status = 'processing'; return 'payment_intent.succeeded';
      case '+243000000503': i.unavailable = true; return 'payment_intent.succeeded';
      default: return null;
    }
  }

  /** Le payeur saisit la référence de l'opérateur sur la page KODA ; événement envoyé aussitôt (ou null). */
  kodaCheckout(intentId: string, reference: string, nowMs: number): string | null {
    const i = this.intents.get(intentId)!;
    if (reference === 'TEST-OK-25000') { i.status = 'verified'; return 'payment.verified'; }
    if (reference === 'TEST-LATE-90') { i.lateAt = nowMs + 90_000; return null; }
    return null; // TEST-REPLAY (code_already_used), TEST-SUFFIX (défi) : aucun paiement vérifié
  }

  /** Vérifications tardives KODA arrivées à échéance : intentions passées « verified » (événement .late). */
  kodaLateDue(nowMs: number): SimIntent[] {
    const due = [...this.intents.values()].filter((i) => i.lateAt !== undefined && i.lateAt <= nowMs && i.status !== 'verified');
    for (const i of due) i.status = 'verified';
    return due;
  }
}
