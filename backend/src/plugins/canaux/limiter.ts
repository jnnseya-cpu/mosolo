/**
 * Limitation de fréquence des vérifications publiques (module 68, § 18A.6) : fenêtre glissante par clé
 * (adresse, numéro appelant haché). Trop de requêtes ⇒ 429 ; trop d'échecs ⇒ suspicion d'énumération (alerte).
 */
import type { AlertService } from '../../modules/alerts/service.js';
import type { AuditLog } from '../../core/audit.js';
import type { Clock } from '../../core/clock.js';
import { sha256Hex } from '../../core/crypto.js';
import { ApiError } from '../../core/errors.js';
import { IdGenerator, InMemoryAppendOnlyRepository } from '../../core/repository.js';
import { VERIFY_MAX_FAILURES_PER_WINDOW, VERIFY_MAX_PER_WINDOW, VERIFY_WINDOW_MS } from './model.js';

interface Bucket {
  windowStart: number;
  count: number;
  failures: number;
  alerted: boolean;
}

export interface VerificationLog {
  id: string;
  at: string;
  channel: string;
  keyHash: string;
  codeHash: string;
  kind: string;
  result: string;
}

export class VerificationLimiter {
  private readonly buckets = new Map<string, Bucket>();
  readonly logs = new InMemoryAppendOnlyRepository<VerificationLog>();
  private readonly ids = new IdGenerator();
  suspectedAttempts = 0;

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly alerts: AlertService,
  ) {}

  private bucket(key: string): Bucket {
    const now = this.clock.now().getTime();
    const b = this.buckets.get(key);
    if (!b || now - b.windowStart >= VERIFY_WINDOW_MS) {
      const fresh = { windowStart: now, count: 0, failures: 0, alerted: false };
      this.buckets.set(key, fresh);
      return fresh;
    }
    return b;
  }

  /** À appeler AVANT toute recherche : lève 429 si la clé a épuisé sa fenêtre. */
  admit(key: string, channel: string): void {
    const b = this.bucket(key);
    if (b.count >= VERIFY_MAX_PER_WINDOW || b.failures >= VERIFY_MAX_FAILURES_PER_WINDOW) {
      this.audit.append({
        actor: { kind: 'public', id: 'verification-code-court' }, action: 'canaux.verification.throttled', resourceType: 'verification', outcome: 'DENIED',
        details: { channel, keyHash: sha256Hex(key).slice(0, 16), count: b.count, failures: b.failures },
      });
      const retryAfter = Math.ceil((b.windowStart + VERIFY_WINDOW_MS - this.clock.now().getTime()) / 1000);
      throw new ApiError(429, 'TOO_MANY_VERIFICATIONS', 'Trop de vérifications en peu de temps. Réessayez plus tard.', { retryAfterSeconds: retryAfter });
    }
    b.count += 1;
  }

  record(key: string, channel: string, code: string, kind: string, result: string, failure: boolean): void {
    const b = this.bucket(key);
    this.logs.append({
      id: this.ids.next('VERIF'), at: this.clock.now().toISOString(), channel, keyHash: sha256Hex(key).slice(0, 16),
      codeHash: sha256Hex(code.toUpperCase()).slice(0, 16), kind, result,
    });
    if (!failure) return;
    b.failures += 1;
    if (b.failures >= VERIFY_MAX_FAILURES_PER_WINDOW && !b.alerted) {
      b.alerted = true;
      this.suspectedAttempts += 1;
      this.alerts.raise({
        type: 'SHORT_CODE_ENUMERATION_SUSPECTED', severity: 'HIGH', source: 'canaux:verification',
        detail: `Vérifications infructueuses répétées depuis une même source (${channel}) : énumération possible, source ralentie.`,
        context: { channel, keyHash: sha256Hex(key).slice(0, 16), failures: b.failures },
        actor: { kind: 'public', id: 'verification-code-court' },
      });
    }
  }
}
