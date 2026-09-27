/**
 * Journal d'audit chaîné en ajout seul (§ 25.2).
 * Chaque enregistrement contient l'empreinte du précédent :
 *   hash = sha256(prevHash + JSON canonique du contenu)
 * et une signature HMAC-SHA256 du hash par une clé serveur (en production : HSM).
 * L'empreinte de tête est conservée à part (ancrage), ce qui détecte aussi une troncature.
 */
import type { User } from './auth.js';
import type { Clock } from './clock.js';
import { canonicalJson, hmacSha256Hex, safeEqualHex, sha256Hex } from './crypto.js';

export type ActorKind = 'user' | 'system' | 'provider' | 'device' | 'ai' | 'public';
export type AuditOutcome = 'SUCCESS' | 'DENIED' | 'FAILURE';

export interface AuditActor {
  kind: ActorKind;
  id: string;
  roles?: string[];
}

/** Acteur d'audit d'une personne authentifiée (source unique ; les modules l'importent ou le réexportent). */
export function actorOf(u: User): AuditActor {
  return { kind: 'user', id: u.id, roles: u.roles };
}

export interface AuditInput {
  actor: AuditActor;
  action: string;
  resourceType: string;
  resourceId?: string;
  outcome?: AuditOutcome;
  details?: Record<string, unknown>;
}

export interface AuditRecord {
  id: string;
  seq: number;
  at: string;
  actor: AuditActor;
  action: string;
  resourceType: string;
  resourceId: string | null;
  outcome: AuditOutcome;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
  signature: string;
}

export interface AuditVerification {
  ok: boolean;
  length: number;
  brokenAt?: number;
  reason?: string;
  headHash: string;
  verifiedAt: string;
}

export const GENESIS_HASH = '0'.repeat(64);

function contentOf(r: Omit<AuditRecord, 'hash' | 'signature'>): string {
  return canonicalJson({
    id: r.id, seq: r.seq, at: r.at, actor: r.actor, action: r.action, resourceType: r.resourceType,
    resourceId: r.resourceId, outcome: r.outcome, details: r.details, prevHash: r.prevHash,
  });
}

export class AuditLog {
  /** Stockage (en production : table en ajout seul + copie WORM). */
  private readonly records: AuditRecord[] = [];
  /** Ancrage de l'empreinte de tête (en production : horodatage tiers). */
  private anchoredHead = GENESIS_HASH;

  constructor(
    private readonly clock: Clock,
    private readonly hmacKey: string,
  ) {}

  append(input: AuditInput): AuditRecord {
    const prevHash = this.records.at(-1)?.hash ?? GENESIS_HASH;
    const seq = this.records.length + 1;
    const base = {
      id: `AUD-${String(seq).padStart(8, '0')}`,
      seq,
      at: this.clock.now().toISOString(),
      actor: input.actor,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      outcome: input.outcome ?? 'SUCCESS',
      details: JSON.parse(JSON.stringify(input.details ?? {})) as Record<string, unknown>,
      prevHash,
    };
    const hash = sha256Hex(prevHash + contentOf(base));
    const record: AuditRecord = { ...base, hash, signature: hmacSha256Hex(this.hmacKey, hash) };
    this.records.push(record);
    this.anchoredHead = hash;
    return structuredClone(record);
  }

  list(filter: { action?: string; resourceId?: string; limit?: number; offset?: number } = {}): { total: number; items: AuditRecord[] } {
    let items = this.records;
    if (filter.action) items = items.filter((r) => r.action.startsWith(filter.action!));
    if (filter.resourceId) items = items.filter((r) => r.resourceId === filter.resourceId);
    const total = items.length;
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 100;
    return { total, items: items.slice(offset, offset + limit).map((r) => structuredClone(r)) };
  }

  get length(): number {
    return this.records.length;
  }

  /** Tête de la chaîne (rang et empreinte du dernier enregistrement) — base de l'ancrage externe (persistence/anchor.ts). */
  head(): { seq: number; hash: string } {
    const last = this.records.at(-1);
    return { seq: last?.seq ?? 0, hash: last?.hash ?? GENESIS_HASH };
  }

  /** Empreinte de l'enregistrement de rang `seq` (1…length), sinon undefined. */
  hashAt(seq: number): string | undefined {
    return this.records[seq - 1]?.hash;
  }

  verify(): AuditVerification {
    const verifiedAt = this.clock.now().toISOString();
    let prev = GENESIS_HASH;
    for (let i = 0; i < this.records.length; i++) {
      const r = this.records[i]!;
      const fail = (reason: string): AuditVerification => ({
        ok: false, length: this.records.length, brokenAt: i + 1, reason, headHash: this.anchoredHead, verifiedAt,
      });
      if (r.seq !== i + 1) return fail('Séquence rompue (suppression ou insertion)');
      if (r.prevHash !== prev) return fail('Empreinte précédente incohérente');
      const { hash: _h, signature: _s, ...rest } = r;
      const expected = sha256Hex(prev + contentOf(rest));
      if (!safeEqualHex(expected, r.hash)) return fail('Contenu altéré (empreinte invalide)');
      if (!safeEqualHex(hmacSha256Hex(this.hmacKey, r.hash), r.signature)) return fail('Signature invalide');
      prev = r.hash;
    }
    if (prev !== this.anchoredHead) {
      return { ok: false, length: this.records.length, brokenAt: this.records.length + 1, reason: 'Troncature : tête différente de l’ancrage', headHash: this.anchoredHead, verifiedAt };
    }
    return { ok: true, length: this.records.length, headHash: prev, verifiedAt };
  }

  /**
   * Accès brut au stockage — n'existe que pour simuler, dans les tests,
   * une altération directe « en base » par un initié technique (AC-AUD-01).
   * Aucune route HTTP n'y donne accès.
   */
  /**
   * Rechargement depuis le stockage persistant (redémarrage) : remplace le contenu par les enregistrements lus
   * et fixe l'ancrage de tête sur le dernier. ATTENTION : une chaîne tronquée reste alors cohérente — la troncature
   * ou le retour arrière ne sont détectés que par l'ancre EXTERNE (persistence/anchor.ts, MOSOLO_AUDIT_ANCHOR_PATH). N'est appelé qu'au démarrage, avant toute écriture ; la chaîne est
   * ensuite contrôlée par `verify()` (une chaîne altérée est détectée, jamais « réparée »).
   */
  restore(records: AuditRecord[]): void {
    this.records.splice(0, this.records.length, ...records.map((r) => structuredClone(r)));
    this.anchoredHead = records.at(-1)?.hash ?? GENESIS_HASH;
  }

  unsafeRawStorageForTamperTests(): AuditRecord[] {
    return this.records;
  }
}
