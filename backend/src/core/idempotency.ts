/**
 * Stockage des clés d'idempotence (§ 30.3) :
 * même clé + même contenu → même réponse ; même clé + contenu différent → 409.
 */
import { canonicalJson, sha256Hex } from './crypto.js';
import { badRequest, conflict } from './errors.js';

interface StoredResponse {
  fingerprint: string;
  statusCode: number;
  body: unknown;
}

export class IdempotencyStore {
  private readonly store = new Map<string, StoredResponse>();
  /** Exécutions asynchrones en cours (appel sortant à un prestataire) : une seule par (portée, clé). */
  private readonly inflight = new Map<string, { fingerprint: string; promise: Promise<{ statusCode: number; body: unknown }> }>();

  static requireKey(header: string | string[] | undefined): string {
    const key = Array.isArray(header) ? header[0] : header;
    if (!key || key.trim().length < 8 || key.length > 200) {
      throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'En-tête Idempotency-Key obligatoire (8 à 200 caractères) pour toute création financière.');
    }
    return key.trim();
  }

  /**
   * Exécute `fn` une seule fois par (portée, clé). Rejoue la réponse mémorisée si le contenu est identique.
   */
  execute<T>(scope: string, key: string, payload: unknown, fn: () => { statusCode: number; body: T }): { statusCode: number; body: T; replayed: boolean } {
    const id = `${scope}::${key}`;
    const fingerprint = sha256Hex(canonicalJson(payload));
    const existing = this.store.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw conflict('IDEMPOTENCY_KEY_REUSED', 'Cette clé d’idempotence a déjà été utilisée avec un contenu différent.');
      }
      return { statusCode: existing.statusCode, body: structuredClone(existing.body) as T, replayed: true };
    }
    const res = fn();
    this.store.set(id, { fingerprint, statusCode: res.statusCode, body: structuredClone(res.body) });
    return { ...res, replayed: false };
  }

  /**
   * Variante asynchrone : une requête concurrente avec la même clé et le même contenu attend le résultat de la
   * première (aucun second appel sortant) ; un échec n'est pas mémorisé (le client peut réessayer).
   */
  async executeAsync<T>(
    scope: string,
    key: string,
    payload: unknown,
    fn: () => Promise<{ statusCode: number; body: T }>,
  ): Promise<{ statusCode: number; body: T; replayed: boolean }> {
    const id = `${scope}::${key}`;
    const fingerprint = sha256Hex(canonicalJson(payload));
    const existing = this.store.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw conflict('IDEMPOTENCY_KEY_REUSED', 'Cette clé d’idempotence a déjà été utilisée avec un contenu différent.');
      }
      return { statusCode: existing.statusCode, body: structuredClone(existing.body) as T, replayed: true };
    }
    const running = this.inflight.get(id);
    if (running) {
      if (running.fingerprint !== fingerprint) {
        throw conflict('IDEMPOTENCY_KEY_REUSED', 'Cette clé d’idempotence a déjà été utilisée avec un contenu différent.');
      }
      const res = await running.promise;
      return { statusCode: res.statusCode, body: structuredClone(res.body) as T, replayed: true };
    }
    const promise = fn();
    this.inflight.set(id, { fingerprint, promise });
    try {
      const res = await promise;
      this.store.set(id, { fingerprint, statusCode: res.statusCode, body: structuredClone(res.body) });
      return { ...res, replayed: false };
    } finally {
      this.inflight.delete(id);
    }
  }
}
