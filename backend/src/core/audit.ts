/**
 * Journal d'audit chaîné en ajout seul (§ 25.2).
 * Chaque enregistrement contient l'empreinte du précédent :
 *   hash = sha256(prevHash + JSON canonique du contenu)
 * et une signature HMAC-SHA256 du hash par une clé serveur (en production : HSM).
 * L'empreinte de tête est conservée à part (ancrage), ce qui détecte aussi une troncature.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
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
  /** Motif explicite (sinon repris de details.motif / details.reason / details.justification). */
  reason?: string;
  /** Chaîne d'approbation explicite (sinon reconstituée de details.proposedBy / details.requestedBy). */
  approvalChain?: ApprovalStep[];
  /** État avant / après : seule leur empreinte est scellée dans l'enregistrement (jamais les données). */
  before?: unknown;
  after?: unknown;
  /** Attributs de contexte explicites (prioritaires sur le contexte de la requête). */
  trace?: AuditTrace;
}

/** Étape d'une chaîne d'approbation (proposition, visa, décision) — § 29.1 « approval chain ». */
export interface ApprovalStep {
  by: string;
  step: string;
  role?: string;
  at?: string;
  decision?: string;
}

/**
 * Attributs structurés d'un événement d'audit (§ 29.1, § 30.1, § 36.1) : identifiant de corrélation (X-Request-Id),
 * session, appareil, motif, chaîne d'approbation, empreintes avant/après, élévation privilégiée active.
 * Présents seulement s'ils sont connus : un enregistrement sans ces attributs garde exactement l'empreinte historique.
 */
export interface AuditTrace {
  correlationId?: string;
  sessionId?: string;
  deviceId?: string;
  deviceFingerprint?: string;
  reason?: string;
  approvalChain?: ApprovalStep[];
  /** Empreinte SHA-256 (JSON canonique) de l'état avant / après. */
  beforeHash?: string;
  afterHash?: string;
  /** Élévation d'accès privilégié juste-à-temps active pendant l'action (session enregistrée, § 12.1). */
  elevationId?: string;
}

/** Contexte de requête propagé à tout enregistrement d'audit émis pendant son traitement (AsyncLocalStorage). */
export interface AuditRequestContext {
  correlationId: string;
  /** Résolu au moment de l'écriture (l'utilisateur et la session ne sont connus qu'après l'authentification). */
  resolve?: () => Partial<AuditTrace>;
  elevationId?: string;
}

export const auditContext = new AsyncLocalStorage<AuditRequestContext>();

/** Exécute `fn` sous un identifiant de corrélation (tâches planifiées, traitements par lots). */
export function withCorrelation<T>(correlationId: string, fn: () => T): T {
  return auditContext.run({ correlationId }, fn);
}

/** Identifiant de corrélation de la requête en cours (undefined hors requête). */
export function currentCorrelationId(): string | undefined {
  return auditContext.getStore()?.correlationId;
}

/**
 * Signature des enregistrements (§ 25.1 « signature serveur protégée par module matériel ») : interface commune au
 * logiciel (HMAC, défaut, rétrocompatible) et au module matériel (HSM : PKCS#11 / KMS — adaptateur à raccorder).
 */
export interface AuditSigner {
  /** Identifiant public de la clé (empreinte courte, jamais la clé). */
  readonly keyId: string;
  readonly kind: 'LOGICIEL' | 'HSM';
  sign(hashHex: string): string;
  verify(hashHex: string, signature: string): boolean;
}

/** Signataire logiciel HMAC-SHA256 : exactement la signature historique du journal. */
export class SoftwareHmacSigner implements AuditSigner {
  readonly kind = 'LOGICIEL' as const;
  readonly keyId: string;
  constructor(private readonly key: string) {
    this.keyId = sha256Hex(`mosolo-audit-signer:${hmacSha256Hex(key, 'key-id')}`).slice(0, 16);
  }
  sign(hashHex: string): string {
    return hmacSha256Hex(this.key, hashHex);
  }
  verify(hashHex: string, signature: string): boolean {
    return safeEqualHex(hmacSha256Hex(this.key, hashHex), signature);
  }
}

/** Client minimal d'un module matériel (PKCS#11, KMS) : la clé ne quitte jamais le module. */
export interface HsmClient {
  label: string;
  hmacSign(keyLabel: string, data: Buffer): Buffer;
}

/** Adaptateur HSM : HMAC calculé DANS le module (clé non exportable). [À RACCORDER] au module matériel retenu. */
export class HsmAuditSigner implements AuditSigner {
  readonly kind = 'HSM' as const;
  readonly keyId: string;
  constructor(private readonly client: HsmClient, private readonly keyLabel: string) {
    this.keyId = sha256Hex(`mosolo-audit-hsm:${client.label}:${keyLabel}`).slice(0, 16);
  }
  sign(hashHex: string): string {
    return this.client.hmacSign(this.keyLabel, Buffer.from(hashHex, 'utf8')).toString('hex');
  }
  verify(hashHex: string, signature: string): boolean {
    return safeEqualHex(this.sign(hashHex), signature);
  }
}

/** Empreinte d'un état (avant / après) : SHA-256 du JSON canonique. */
export function stateHash(value: unknown): string {
  return sha256Hex(canonicalJson(value ?? null));
}

export type AuditListener = (record: AuditRecord) => void;

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
  /** Attributs structurés (§ 29.1) ; absents des enregistrements antérieurs (empreinte inchangée). */
  trace?: AuditTrace;
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

/** Contenu scellé ; `trace` n'y figure que s'il est présent (les enregistrements historiques gardent leur empreinte). */
function contentOf(r: Omit<AuditRecord, 'hash' | 'signature'>): string {
  return canonicalJson({
    id: r.id, seq: r.seq, at: r.at, actor: r.actor, action: r.action, resourceType: r.resourceType,
    resourceId: r.resourceId, outcome: r.outcome, details: r.details, prevHash: r.prevHash,
    ...(r.trace ? { trace: r.trace } : {}),
  });
}

/** Empreinte recalculée d'un enregistrement (contrôle d'une copie : WORM, sauvegarde). */
export function computeRecordHash(r: AuditRecord): string {
  const { hash: _h, signature: _s, ...rest } = r;
  return sha256Hex(r.prevHash + contentOf(rest));
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : undefined);

/** Attributs structurés : saisie explicite, puis contexte de la requête, puis détails historiques (motif, proposant). */
function buildTrace(input: AuditInput, at: string): AuditTrace | undefined {
  const store = auditContext.getStore();
  let fromReq: Partial<AuditTrace>;
  try { fromReq = store?.resolve?.() ?? {}; } catch { fromReq = {}; }
  const d = input.details ?? {};
  const reason = input.reason ?? input.trace?.reason ?? str(d.motif) ?? str(d.reason) ?? str(d.justification);
  let chain = input.approvalChain ?? input.trace?.approvalChain;
  if (!chain) {
    const proposer = str(d.proposedBy) ?? str(d.requestedBy);
    if (proposer && proposer !== input.actor.id) {
      const decision = str(d.decision);
      chain = [{ by: proposer, step: 'PROPOSITION' }, { by: input.actor.id, step: 'DECISION', at, ...(decision ? { decision } : {}) }];
    }
  }
  const t: AuditTrace = {
    ...(store?.correlationId ? { correlationId: store.correlationId } : {}),
    ...fromReq,
    ...(store?.elevationId ? { elevationId: store.elevationId } : {}),
    ...(input.trace ?? {}),
    ...(reason ? { reason } : {}),
    ...(chain && chain.length ? { approvalChain: chain } : {}),
    ...(input.before !== undefined ? { beforeHash: stateHash(input.before) } : {}),
    ...(input.after !== undefined ? { afterHash: stateHash(input.after) } : {}),
  };
  const clean = JSON.parse(JSON.stringify(t)) as AuditTrace;
  return Object.keys(clean).length ? clean : undefined;
}

export class AuditLog {
  /** Stockage (en production : table en ajout seul + copie WORM). */
  private readonly records: AuditRecord[] = [];
  /** Ancrage de l'empreinte de tête (en production : horodatage tiers). */
  private anchoredHead = GENESIS_HASH;
  /** Signataire (logiciel HMAC par défaut ; module matériel via `HsmAuditSigner`). */
  readonly signer: AuditSigner;
  private readonly listeners: AuditListener[] = [];

  constructor(
    private readonly clock: Clock,
    key: string | AuditSigner,
  ) {
    this.signer = typeof key === 'string' ? new SoftwareHmacSigner(key) : key;
  }

  /**
   * Abonnement aux nouveaux enregistrements (détections : fuite de données, plausibilité GPS, plafonds, mandats).
   * Un abonné en échec n'empêche jamais l'écriture du journal ; renvoie la fonction de désabonnement.
   */
  onAppend(listener: AuditListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

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
    const trace = buildTrace(input, base.at);
    const content = trace ? { ...base, trace } : base;
    const hash = sha256Hex(prevHash + contentOf(content));
    const record: AuditRecord = { ...content, hash, signature: this.signer.sign(hash) };
    this.records.push(record);
    this.anchoredHead = hash;
    for (const l of [...this.listeners]) {
      try { l(structuredClone(record)); } catch { /* un abonné n'empêche jamais l'écriture */ }
    }
    return structuredClone(record);
  }

  list(filter: { action?: string; resourceId?: string; correlationId?: string; elevationId?: string; limit?: number; offset?: number } = {}): { total: number; items: AuditRecord[] } {
    let items = this.records;
    if (filter.action) items = items.filter((r) => r.action.startsWith(filter.action!));
    if (filter.resourceId) items = items.filter((r) => r.resourceId === filter.resourceId);
    if (filter.correlationId) items = items.filter((r) => r.trace?.correlationId === filter.correlationId);
    if (filter.elevationId) items = items.filter((r) => r.trace?.elevationId === filter.elevationId);
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
      if (!this.signer.verify(r.hash, r.signature)) return fail('Signature invalide');
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
