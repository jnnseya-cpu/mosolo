/**
 * Scellement du journal d'audit (§ 25.1 « preuve inviolable en pratique ») : par-dessus la chaîne signée existante
 * (core/audit.ts) et son ancre externe (persistence/anchor.ts), sans jamais réécrire l'historique :
 *  1. copie WORM par segments (worm.ts) ;
 *  2. racine quotidienne (empreinte de tête + racine de Merkle des enregistrements du jour, heure de Kinshasa), signée
 *     par le signataire du journal (logiciel ou HSM), horodatée (horodatage.ts) et publiée sur une cible externe ;
 *  3. contrôle d'intégrité périodique (horaire par défaut) : chaîne vivante ↔ copie WORM ↔ racines publiées ; toute
 *     divergence lève une alerte critique (examen humain, aucun effet automatique).
 */
import type { AppContext } from '../../../context.js';
import { computeRecordHash, type AuditRecord } from '../../../core/audit.js';
import type { User } from '../../../core/auth.js';
import { kinshasaDate } from '../../../core/clock.js';
import { canonicalJson, sha256Hex } from '../../../core/crypto.js';
import { conflict, unprocessable } from '../../../core/errors.js';
import { authorize } from '../../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../../core/repository.js';
import { merkleRoot, type PublicationTarget, type TimestampAuthority, type TimestampToken } from './horodatage.js';
import type { WormStore } from './worm.js';

export interface DailyRoot {
  id: string;
  day: string;
  /** Racine d'une journée en cours (publication anticipée, démonstration) : sera suivie de la racine complète. */
  partial: boolean;
  fromSeq: number;
  toSeq: number;
  count: number;
  headHash: string;
  merkleRoot: string;
  signerKind: string;
  signerKeyId: string;
  signature: string;
  timestamp: TimestampToken | null;
  timestampError?: string;
  publication: { kind: string; location: string; ref: string } | null;
  publicationError?: string;
  createdAt: string;
  createdBy: string;
}

export type CheckFinding = { code: string; severity: 'CRITIQUE' | 'ATTENTION'; detail: string; seq?: number; day?: string };

export interface IntegrityCheck {
  id: string;
  at: string;
  trigger: 'MANUEL' | 'PLANIFIE';
  by: string;
  ok: boolean;
  live: { ok: boolean; length: number; reason?: string; brokenAt?: number };
  copy: { length: number; compared: number; ok: boolean };
  roots: { total: number; compared: number; ok: boolean };
  findings: CheckFinding[];
  alertIds: string[];
}

export class ScellementService {
  readonly roots = new InMemoryRepository<DailyRoot>();
  readonly checks = new InMemoryRepository<IntegrityCheck>();
  private readonly ids = new IdGenerator();

  constructor(
    private readonly ctx: AppContext,
    readonly worm: WormStore,
    readonly tsa: TimestampAuthority,
    readonly target: PublicationTarget,
  ) {}

  private now(): Date {
    return this.ctx.clock.now();
  }

  private records(offset = 0): AuditRecord[] {
    return this.ctx.audit.list({ offset, limit: Number.MAX_SAFE_INTEGER }).items;
  }

  private actorOf(by: User | 'system') {
    return by === 'system' ? { kind: 'system' as const, id: 'integrite:scellement' } : { kind: 'user' as const, id: by.id, roles: by.roles };
  }

  /* ---------------- Copie WORM ---------------- */

  /** Copie les enregistrements non encore copiés dans un nouveau segment (aucun segment réécrit). */
  copy(by: User | 'system'): { copied: number; segment: string | null; lastSeq: number } {
    if (by !== 'system') authorize(by, 'integrite:scellement.run');
    const last = this.worm.lastSeq();
    if (last > this.ctx.audit.length) {
      // La copie est plus longue que la chaîne vivante : troncature de la chaîne — rien n'est copié, le contrôle alerte.
      return { copied: 0, segment: null, lastSeq: last };
    }
    const fresh = this.records(last);
    if (!fresh.length) return { copied: 0, segment: null, lastSeq: last };
    const seg = this.worm.appendSegment(fresh);
    this.ctx.audit.append({ actor: this.actorOf(by), action: 'integrite.scellement.copied', resourceType: 'audit_worm', resourceId: seg.name, details: { fromSeq: seg.fromSeq, toSeq: seg.toSeq, store: this.worm.kind } });
    return { copied: seg.count, segment: seg.name, lastSeq: seg.toSeq };
  }

  /* ---------------- Racine quotidienne ---------------- */

  private dayRecords(day: string, all = this.records()): AuditRecord[] {
    return all.filter((r) => kinshasaDate(new Date(r.at)) === day);
  }

  private rootPayload(r: Pick<DailyRoot, 'day' | 'partial' | 'fromSeq' | 'toSeq' | 'count' | 'headHash' | 'merkleRoot'>): string {
    return sha256Hex(canonicalJson({ format: 'mosolo-racine-audit/1', day: r.day, partial: r.partial, fromSeq: r.fromSeq, toSeq: r.toSeq, count: r.count, headHash: r.headHash, merkleRoot: r.merkleRoot }));
  }

  /**
   * Publie la racine du jour `day` (défaut : la veille, heure de Kinshasa). Un jour révolu n'a qu'une racine complète ;
   * le jour courant peut recevoir une racine partielle (publication anticipée). Horodatage et publication en échec :
   * racine conservée avec le motif, alerte levée — jamais de jeton ni de publication simulés.
   */
  publishRoot(by: User | 'system', day?: string): DailyRoot {
    if (by !== 'system') authorize(by, 'integrite:scellement.run');
    const today = kinshasaDate(this.now());
    const d = day ?? kinshasaDate(new Date(this.now().getTime() - 86_400_000));
    if (d > today) throw unprocessable('ROOT_FUTURE_DAY', 'Aucune racine pour un jour à venir.');
    const partial = d === today;
    if (!partial && this.roots.findOne((r) => r.day === d && !r.partial)) throw conflict('ROOT_ALREADY_PUBLISHED', `La racine du ${d} est déjà publiée.`);
    const recs = this.dayRecords(d);
    const base = {
      day: d, partial, fromSeq: recs[0]?.seq ?? 0, toSeq: recs.at(-1)?.seq ?? 0, count: recs.length,
      headHash: recs.at(-1)?.hash ?? '0'.repeat(64), merkleRoot: merkleRoot(recs.map((r) => r.hash)),
    };
    const imprint = this.rootPayload(base);
    let timestamp: TimestampToken | null = null;
    let timestampError: string | undefined;
    try { timestamp = this.tsa.stamp(imprint, this.now()); } catch (e) { timestampError = e instanceof Error ? e.message : String(e); }
    const signature = this.ctx.audit.signer.sign(imprint);
    let publication: DailyRoot['publication'] = null;
    let publicationError: string | undefined;
    try {
      const ref = this.target.publish({ day: d, toSeq: base.toSeq, headHash: base.headHash, merkleRoot: base.merkleRoot, signature, timestamp, publishedAt: this.now().toISOString() });
      publication = { kind: this.target.kind, location: this.target.location, ref };
    } catch (e) { publicationError = e instanceof Error ? e.message : String(e); }
    const root = this.roots.insert({
      id: partial ? this.ids.next(`RAC-${d}-P`, 3) : `RAC-${d}`, ...base, signerKind: this.ctx.audit.signer.kind, signerKeyId: this.ctx.audit.signer.keyId, signature,
      timestamp, ...(timestampError ? { timestampError } : {}), publication, ...(publicationError ? { publicationError } : {}),
      createdAt: this.now().toISOString(), createdBy: by === 'system' ? 'système' : by.id,
    });
    this.ctx.audit.append({
      actor: this.actorOf(by), action: 'integrite.scellement.root_published', resourceType: 'audit_root', resourceId: root.id,
      details: { day: d, partial, toSeq: base.toSeq, merkleRoot: base.merkleRoot, timestamped: !!timestamp, published: !!publication },
    });
    if (timestampError || publicationError) {
      this.ctx.alerts.raiseOnce(`SCELLEMENT:PUBLICATION:${root.id}`, {
        type: 'SCELLEMENT_PUBLICATION_ECHEC', severity: 'HIGH', source: 'integrite:scellement',
        detail: `Racine ${root.id} : ${[timestampError && `horodatage — ${timestampError}`, publicationError && `publication — ${publicationError}`].filter(Boolean).join(' ; ')}`,
        context: { rootId: root.id, automaticEffect: 'AUCUN' }, notifyRoles: ['R22'],
      });
    }
    return root;
  }

  /* ---------------- Contrôle d'intégrité ---------------- */

  /** Chaîne vivante ↔ copie WORM ↔ racines publiées ; alerte critique à la moindre divergence. */
  check(by: User | 'system', trigger: IntegrityCheck['trigger'] = 'MANUEL'): IntegrityCheck {
    if (by !== 'system') authorize(by, 'integrite:scellement.run');
    const findings: CheckFinding[] = [];
    const live = this.ctx.audit.verify();
    if (!live.ok) findings.push({ code: 'CHAINE_ROMPUE', severity: 'CRITIQUE', detail: `Chaîne vivante rompue : ${live.reason ?? 'inconnu'} (rang ${live.brokenAt ?? '?'})`, ...(live.brokenAt ? { seq: live.brokenAt } : {}) });
    const all = this.records();
    // Copie WORM : chaque enregistrement copié doit être identique (empreinte recalculée comprise) à la chaîne vivante.
    const copy = this.worm.readAll();
    let compared = 0;
    if (copy.length > all.length) findings.push({ code: 'TRONCATURE', severity: 'CRITIQUE', detail: `La copie WORM compte ${copy.length} enregistrement(s), la chaîne vivante ${all.length} : troncature ou retour arrière.` });
    let prev = '0'.repeat(64);
    for (const c of copy) {
      if (c.prevHash !== prev) { findings.push({ code: 'COPIE_ROMPUE', severity: 'CRITIQUE', detail: `Copie WORM rompue au rang ${c.seq}.`, seq: c.seq }); break; }
      if (computeRecordHash(c) !== c.hash) { findings.push({ code: 'COPIE_ALTEREE', severity: 'CRITIQUE', detail: `Copie WORM altérée au rang ${c.seq} (empreinte invalide).`, seq: c.seq }); break; }
      const l = all[c.seq - 1];
      if (l) {
        compared++;
        if (l.hash !== c.hash || canonicalJson(l) !== canonicalJson(c)) {
          findings.push({ code: 'COPIE_DIVERGENTE', severity: 'CRITIQUE', detail: `Rang ${c.seq} : la chaîne vivante diffère de la copie WORM (réécriture ?).`, seq: c.seq });
          break;
        }
      }
      prev = c.hash;
    }
    // Racines : recalcul depuis la chaîne vivante, signature, horodatage, présence identique sur la cible externe.
    const published = this.target.readAll();
    let rootsCompared = 0;
    for (const r of this.roots.all()) {
      rootsCompared++;
      const recs = all.filter((x) => x.seq >= r.fromSeq && x.seq <= r.toSeq);
      const expected = { day: r.day, partial: r.partial, fromSeq: r.fromSeq, toSeq: r.toSeq, count: r.count, headHash: r.headHash, merkleRoot: r.merkleRoot };
      const imprint = this.rootPayload(expected);
      if (r.count > 0 && (recs.length !== r.count || recs.at(-1)?.hash !== r.headHash || merkleRoot(recs.map((x) => x.hash)) !== r.merkleRoot)) {
        findings.push({ code: 'RACINE_DIVERGENTE', severity: 'CRITIQUE', detail: `Racine ${r.id} : la chaîne vivante ne redonne pas la racine publiée.`, day: r.day });
      }
      if (!this.ctx.audit.signer.verify(imprint, r.signature)) findings.push({ code: 'RACINE_SIGNATURE', severity: 'CRITIQUE', detail: `Racine ${r.id} : signature invalide.`, day: r.day });
      if (r.timestamp && !this.tsa.verify(r.timestamp, imprint)) findings.push({ code: 'RACINE_HORODATAGE', severity: 'ATTENTION', detail: `Racine ${r.id} : jeton d’horodatage non vérifiable par l’autorité courante (clé changée ?).`, day: r.day });
      if (r.publication) {
        const p = published.find((x) => x.day === r.day && x.toSeq === r.toSeq);
        if (!p || p.headHash !== r.headHash || p.merkleRoot !== r.merkleRoot || p.signature !== r.signature) {
          findings.push({ code: 'PUBLICATION_DIVERGENTE', severity: 'CRITIQUE', detail: `Racine ${r.id} : absente ou différente sur la cible de publication externe.`, day: r.day });
        }
      }
    }
    const ok = findings.length === 0;
    const hour = this.now().toISOString().slice(0, 13);
    const alertIds = findings.filter((f) => f.severity === 'CRITIQUE').map((f) => this.ctx.alerts.raiseOnce(`SCELLEMENT:${f.code}:${f.seq ?? f.day ?? '*'}:${hour}`, {
      type: `SCELLEMENT_${f.code}`, severity: 'CRITICAL', source: 'integrite:scellement', detail: f.detail,
      context: { finding: f, automaticEffect: 'AUCUN' }, notifyRoles: ['R22', 'R23'],
    })).filter((a) => a !== null).map((a) => a!.id);
    const c = this.checks.insert({
      id: this.ids.next('CTL-SCEL'), at: this.now().toISOString(), trigger, by: by === 'system' ? 'système' : by.id, ok,
      live: { ok: live.ok, length: live.length, ...(live.reason ? { reason: live.reason } : {}), ...(live.brokenAt ? { brokenAt: live.brokenAt } : {}) },
      copy: { length: copy.length, compared, ok: !findings.some((f) => f.code.startsWith('COPIE') || f.code === 'TRONCATURE') },
      roots: { total: this.roots.count(), compared: rootsCompared, ok: !findings.some((f) => f.code.startsWith('RACINE') || f.code === 'PUBLICATION_DIVERGENTE') },
      findings, alertIds,
    });
    this.ctx.audit.append({ actor: this.actorOf(by), action: 'integrite.scellement.checked', resourceType: 'audit_integrity_check', resourceId: c.id, outcome: ok ? 'SUCCESS' : 'FAILURE', details: { trigger, findings: findings.length, alerts: alertIds.length } });
    return c;
  }

  status(user: User) {
    authorize(user, 'integrite:scellement.read');
    const last = this.checks.all().at(-1) ?? null;
    return {
      signer: { kind: this.ctx.audit.signer.kind, keyId: this.ctx.audit.signer.keyId, note: this.ctx.audit.signer.kind === 'LOGICIEL' ? 'Signature logicielle (HMAC) : module matériel (HSM) [À RACCORDER] via l’adaptateur HsmAuditSigner.' : 'Signature par module matériel.' },
      chain: { length: this.ctx.audit.length, head: this.ctx.audit.head() },
      worm: { kind: this.worm.kind, location: this.worm.location, lastSeq: this.worm.lastSeq(), segments: this.worm.segments().slice(-20) },
      timestampAuthority: { name: this.tsa.name, external: this.tsa.external, note: this.tsa.external ? 'Autorité tierce.' : 'Adaptateur local non qualifié : autorité d’horodatage tierce (RFC 3161) [À RACCORDER].' },
      publication: { kind: this.target.kind, location: this.target.location, published: this.target.readAll().length },
      roots: this.roots.all().slice(-30).reverse(),
      lastCheck: last,
      checks: this.checks.all().slice(-20).reverse(),
      automaticEffect: 'AUCUN' as const,
    };
  }
}
