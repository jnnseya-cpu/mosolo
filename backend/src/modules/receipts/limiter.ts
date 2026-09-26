/**
 * Limitation de débit des vérifications publiques (§ 18A.6, § 19.2, H.10.7) : empêche l'énumération des codes
 * de quittance. Deux fenêtres glissantes par client : volume total, et échecs (code inconnu ou chiffre de contrôle
 * erroné), plus sévère. Le client n'est connu que par une empreinte tronquée salée (aucune adresse conservée).
 */
import { randomBytes } from 'node:crypto';
import type { Clock } from '../../core/clock.js';
import { sha256Hex } from '../../core/crypto.js';

export interface GateLimits {
  /** Vérifications permises par client dans `windowMs`. */
  maxPerWindow: number;
  windowMs: number;
  /** Échecs (code inconnu) permis par client dans `missWindowMs`. */
  maxMisses: number;
  missWindowMs: number;
}

export interface GateDecision {
  allowed: boolean;
  /** Secondes avant nouvelle tentative (en-tête Retry-After). */
  retryAfter?: number;
  reason?: 'VOLUME' | 'ECHECS';
}

export const DEFAULT_GATE_LIMITS: GateLimits = { maxPerWindow: 30, windowMs: 60_000, maxMisses: 10, missWindowMs: 15 * 60_000 };

const SALT = randomBytes(16).toString('hex');

export class VerificationGate {
  private readonly hits = new Map<string, number[]>();
  private readonly misses = new Map<string, number[]>();

  constructor(
    private readonly clock: Clock,
    readonly limits: GateLimits = { ...DEFAULT_GATE_LIMITS },
  ) {}

  /** Empreinte non réversible du client (journal agrégé, jamais l'adresse elle-même). */
  static fingerprint(clientKey: string): string {
    return sha256Hex(SALT + clientKey).slice(0, 16);
  }

  private prune(map: Map<string, number[]>, key: string, windowMs: number, now: number): number[] {
    const list = (map.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length) map.set(key, list);
    else map.delete(key);
    return list;
  }

  /** Admet (et compte) une vérification, ou la refuse avec un délai d'attente. */
  admit(clientKey: string): GateDecision {
    const key = VerificationGate.fingerprint(clientKey);
    const now = this.clock.now().getTime();
    const missed = this.prune(this.misses, key, this.limits.missWindowMs, now);
    if (missed.length >= this.limits.maxMisses) {
      return { allowed: false, reason: 'ECHECS', retryAfter: Math.max(1, Math.ceil((missed[0]! + this.limits.missWindowMs - now) / 1000)) };
    }
    const hits = this.prune(this.hits, key, this.limits.windowMs, now);
    if (hits.length >= this.limits.maxPerWindow) {
      return { allowed: false, reason: 'VOLUME', retryAfter: Math.max(1, Math.ceil((hits[0]! + this.limits.windowMs - now) / 1000)) };
    }
    hits.push(now);
    this.hits.set(key, hits);
    return { allowed: true };
  }

  /** Enregistre un échec (code inconnu ou invalide) pour ce client. */
  recordMiss(clientKey: string): void {
    const key = VerificationGate.fingerprint(clientKey);
    const now = this.clock.now().getTime();
    const list = this.prune(this.misses, key, this.limits.missWindowMs, now);
    list.push(now);
    this.misses.set(key, list);
  }
}
