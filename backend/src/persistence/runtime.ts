/**
 * Persistance opt-in (DATABASE_URL) : instantané JSONB des dépôts, chargé au démarrage et tenu à jour à chaque
 * écriture (insert / update / append) par abonnement aux dépôts en mémoire. Les lectures restent en mémoire :
 * aucune interface de dépôt ne change et le fonctionnement par défaut (tests, démonstration) est inchangé.
 *
 * Séquence : les données de démonstration sont semées (en démonstration seulement), puis `attach(ctx)` :
 *   1. fusionne l'instantané chargé (il prévaut) avec l'état semé (les nouveautés semées sont conservées) ;
 *   2. recharge le journal d'audit chaîné et vérifie la chaîne ;
 *   3. avance les générateurs d'identifiants au-delà des numéros restaurés (aucune collision) ;
 *   4. s'abonne aux écritures et écrit par lots (écriture différée courte, `flush()` à l'arrêt).
 * Ancre externe (option `anchor`, MOSOLO_AUDIT_ANCHOR_PATH) : la chaîne rechargée doit prolonger la dernière ancre
 * (sinon troncature / retour arrière : démarrage refusé hors démonstration) ; l'ancre est réécrite après chaque lot
 * d'audit effectivement persisté.
 */
import type { AuditLog, AuditRecord, AuditVerification } from '../core/audit.js';
import { ConfigurationError, isDemoMode } from '../core/auth.js';
import type { Entity } from '../core/repository.js';
import { anchorLogLine, compareWithAnchor, AnchorError, type AuditAnchorRecord, type AuditAnchorStore } from './anchor.js';
import { decodeDoc, encodeDoc, stableText } from './codec.js';
import { AUDIT_REPO, collectRows, discover, isAppendOnly, readableIds, type Discovery } from './registry.js';
import type { SnapshotRow, SnapshotStore } from './store.js';

export interface AttachReport {
  repositories: number;
  restoredDocuments: number;
  restoredAuditRecords: number;
  newlyPersisted: number;
  audit: AuditVerification | null;
  warnings: string[];
  /** Ancre externe lue au démarrage (null : aucune ancre configurée ou encore écrite). */
  anchor: AuditAnchorRecord | null;
}

export interface PersistenceStats {
  store: string;
  attached: boolean;
  repositories: string[];
  pendingWrites: number;
  writtenRows: number;
  flushes: number;
  lastFlushAt: string | null;
  lastError: string | null;
  report: AttachReport | null;
  lastAnchor: AuditAnchorRecord | null;
}

interface AttachableContext {
  clock: { now(): Date };
  audit: AuditLog;
}

export interface RuntimeOptions {
  /** Délai d'écriture différée (ms) ; 0 = écriture à la prochaine micro-tâche. */
  flushDelayMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /**
   * Chaîne d'audit restaurée NON vérifiée (altération, troncature, autre clé) : hors démonstration, le démarrage est
   * refusé sauf acceptation explicite et tracée (défaut : MOSOLO_AUDIT_ACCEPT_UNVERIFIED=true). Dans tous les cas,
   * l'événement `audit.chain.restored_unverified` est ajouté à la chaîne : jamais de restauration silencieuse.
   */
  acceptUnverifiedAudit?: boolean;
  /** Ancre externe de la tête du journal d'audit (hors base). Obligatoire hors démonstration (voir boot.ts). */
  anchor?: AuditAnchorStore;
}

export class PersistenceRuntime {
  private readonly pending = new Map<string, SnapshotRow>();
  private seqByRepo = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private discovery: Discovery | null = null;
  private ctx: AttachableContext | null = null;
  private stats: Omit<PersistenceStats, 'store' | 'attached' | 'repositories' | 'pendingWrites'> = {
    writtenRows: 0, flushes: 0, lastFlushAt: null, lastError: null, report: null, lastAnchor: null,
  };

  constructor(
    readonly store: SnapshotStore,
    private readonly loaded: SnapshotRow[],
    private readonly opts: RuntimeOptions = {},
  ) {}

  /** Charge l'instantané (migrations appliquées) et construit le moteur. */
  static async open(store: SnapshotStore, opts: RuntimeOptions = {}): Promise<PersistenceRuntime> {
    const applied = await store.migrate();
    if (applied.length) opts.log?.('info', `Migrations appliquées : ${applied.join(', ')}`);
    const rows = await store.loadAll();
    opts.log?.('info', `Instantané chargé : ${rows.length} document(s).`);
    return new PersistenceRuntime(store, rows, opts);
  }

  get attached(): boolean {
    return this.ctx !== null;
  }

  attach(ctx: AttachableContext): AttachReport {
    if (this.ctx) throw new Error('Persistance déjà attachée à un contexte.');
    const discovery = discover(ctx);
    const warnings: string[] = [];
    const byRepo = new Map<string, SnapshotRow[]>();
    for (const r of this.loaded) {
      const list = byRepo.get(r.repo) ?? [];
      list.push(r);
      byRepo.set(r.repo, list);
    }
    const persistedText = new Map<string, string>();
    for (const r of this.loaded) persistedText.set(`${r.repo}\u0000${r.id}`, stableText(r.doc));

    // 1. Fusion des dépôts : l'instantané prévaut ; les documents semés absents de l'instantané sont conservés.
    let restored = 0;
    for (const [name, repo] of discovery.repos) {
      const rows = byRepo.get(name);
      if (!rows || rows.length === 0) continue;
      const fromSnapshot = rows.slice().sort((a, b) => a.seq - b.seq).map((r) => decodeDoc(r.doc) as Entity);
      const ids = new Set(fromSnapshot.map((d) => d.id));
      const extras = repo.all().filter((d) => !ids.has(d.id));
      repo.restoreSnapshot([...fromSnapshot, ...extras]);
      restored += fromSnapshot.length;
    }
    for (const name of byRepo.keys()) {
      if (name !== AUDIT_REPO && !discovery.repos.has(name)) warnings.push(`Dépôt persistant sans équivalent chargé (module absent ?) : ${name}`);
    }

    // 2. Journal d'audit chaîné : remplacé intégralement par le journal persistant (la chaîne ne se fusionne pas).
    let auditRestored = 0;
    let auditCheck: AuditVerification | null = null;
    const auditRows = byRepo.get(AUDIT_REPO);
    const accepted = this.opts.acceptUnverifiedAudit ?? ['1', 'true', 'oui', 'yes'].includes((process.env.MOSOLO_AUDIT_ACCEPT_UNVERIFIED ?? '').trim().toLowerCase());
    if (auditRows && auditRows.length > 0) {
      const records = auditRows.slice().sort((a, b) => a.seq - b.seq).map((r) => decodeDoc(r.doc) as AuditRecord);
      restoreAuditLog(ctx.audit, records);
      auditRestored = records.length;
      auditCheck = ctx.audit.verify();
      if (!auditCheck.ok) {
        if (!isDemoMode() && !accepted) {
          throw new ConfigurationError(
            `Chaîne d'audit restaurée NON VÉRIFIÉE (${auditCheck.reason ?? 'inconnu'}, enregistrement ${auditCheck.brokenAt ?? '?'}) : démarrage refusé. ` +
              'Vérifiez MOSOLO_AUDIT_HMAC_KEY et l’intégrité de la base ; pour démarrer malgré tout après enquête, MOSOLO_AUDIT_ACCEPT_UNVERIFIED=true (tracé dans le journal).',
          );
        }
        warnings.push(`Chaîne d'audit restaurée NON VÉRIFIÉE (${auditCheck.reason ?? 'inconnu'}) — clé MOSOLO_AUDIT_HMAC_KEY différente ou altération.`);
        // Trace dans la chaîne elle-même : la rupture reste détectable par /v1/audit/verify et n'est jamais « réparée ».
        ctx.audit.append({
          actor: { kind: 'system', id: 'persistance' }, action: 'audit.chain.restored_unverified', resourceType: 'audit_chain', outcome: 'FAILURE',
          details: { reason: auditCheck.reason ?? 'inconnu', brokenAt: auditCheck.brokenAt ?? null, length: auditCheck.length, accepted: accepted || isDemoMode() ? (accepted ? 'MOSOLO_AUDIT_ACCEPT_UNVERIFIED' : 'demonstration') : null },
        });
      }
    }

    // 2 bis. Ancre externe : la chaîne PERSISTÉE doit prolonger la dernière tête ancrée hors base (sinon troncature,
    // suppression de la base ou réinjection d'une ancienne sauvegarde). Jamais « réparé » : refus ou trace explicite.
    let anchorRead: AuditAnchorRecord | null = null;
    if (this.opts.anchor) {
      const persisted = (auditRows ?? []).map((r) => decodeDoc(r.doc) as AuditRecord).sort((a, b) => a.seq - b.seq);
      let problem: string | null = null;
      try {
        anchorRead = this.opts.anchor.read();
        if (anchorRead) {
          const cmp = compareWithAnchor(anchorRead, { length: persisted.length, hashAt: (seq) => persisted[seq - 1]?.hash });
          if (!cmp.ok) problem = cmp.reason ?? 'inconnu';
        }
      } catch (e) {
        if (!(e instanceof AnchorError)) throw e;
        problem = e.message;
      }
      if (problem) {
        if (!isDemoMode() && !accepted) {
          throw new ConfigurationError(
            `Chaîne d'audit NON CONFORME à l'ancre externe ${this.opts.anchor.location} (${problem}) : démarrage refusé. ` +
              'Restaurez la dernière sauvegarde qui prolonge l’ancre, ou — après enquête — MOSOLO_AUDIT_ACCEPT_UNVERIFIED=true (tracé dans le journal).',
          );
        }
        warnings.push(`Chaîne d'audit NON CONFORME à l'ancre externe (${problem}).`);
        ctx.audit.append({
          actor: { kind: 'system', id: 'persistance' }, action: 'audit.anchor.mismatch', resourceType: 'audit_chain', outcome: 'FAILURE',
          details: {
            reason: problem, anchor: anchorRead ? { seq: anchorRead.seq, hash: anchorRead.hash, at: anchorRead.at } : null,
            persistedLength: persisted.length, accepted: accepted ? 'MOSOLO_AUDIT_ACCEPT_UNVERIFIED' : 'demonstration',
          },
        });
      } else if (anchorRead) {
        this.opts.log?.('info', `Chaîne d'audit conforme à l'ancre externe (rang ${anchorRead.seq}).`);
      } else {
        this.opts.log?.('warn', `Aucune ancre d'audit dans ${this.opts.anchor.location} : première mise en service (elle sera écrite au premier lot).`);
      }
    }

    // 3. Générateurs d'identifiants : au-delà du plus grand numéro connu, par préfixe.
    const maxByPrefix = new Map<string, number>();
    for (const repo of discovery.repos.values()) {
      for (const item of repo.all()) {
        for (const [p, n] of readableIds(item as unknown as Record<string, unknown>)) maxByPrefix.set(p, Math.max(n, maxByPrefix.get(p) ?? 0));
      }
    }
    for (const g of discovery.idGenerators) for (const [p, n] of maxByPrefix) g.advanceTo(p, n);

    // 4. Abonnements + synchronisation initiale de ce qui n'est pas encore (ou pas identiquement) persisté.
    this.discovery = discovery;
    this.ctx = ctx;
    let newly = 0;
    for (const row of collectRows(ctx, discovery)) {
      this.seqByRepo.set(row.repo, Math.max(row.seq, this.seqByRepo.get(row.repo) ?? 0));
      const prev = persistedText.get(`${row.repo}\u0000${row.id}`);
      if (prev === undefined || (row.kind === 'mutable' && prev !== stableText(row.doc))) {
        this.enqueue(row);
        newly++;
      }
    }
    for (const [name, repo] of discovery.repos) {
      const kind = isAppendOnly(repo) ? 'append' : 'mutable';
      repo.onWrite((item, op) => {
        // Rang : nouveau pour une insertion ou un ajout ; ignoré par le magasin pour une mise à jour.
        const seq = op === 'update' ? 0 : this.nextSeq(name);
        this.enqueue({ repo: name, id: item.id, kind, seq, doc: encodeDoc(item) });
      });
    }
    const audit = ctx.audit;
    const originalAppend = audit.append.bind(audit);
    audit.append = (input) => {
      const rec = originalAppend(input);
      this.enqueue({ repo: AUDIT_REPO, id: rec.id, kind: 'append', seq: rec.seq, doc: encodeDoc(rec) });
      return rec;
    };

    const report: AttachReport = {
      repositories: discovery.repos.size, restoredDocuments: restored, restoredAuditRecords: auditRestored,
      newlyPersisted: newly, audit: auditCheck, warnings, anchor: anchorRead,
    };
    this.stats.report = report;
    for (const w of warnings) this.opts.log?.('warn', w);
    this.opts.log?.('info', `Persistance attachée : ${report.repositories} dépôts, ${restored} documents et ${auditRestored} enregistrements d'audit restaurés.`);
    return report;
  }

  private nextSeq(repo: string): number {
    const n = (this.seqByRepo.get(repo) ?? 0) + 1;
    this.seqByRepo.set(repo, n);
    return n;
  }

  private enqueue(row: SnapshotRow): void {
    this.pending.set(`${row.kind}\u0000${row.repo}\u0000${row.id}`, row);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.opts.flushDelayMs ?? 25);
    this.timer.unref?.();
  }

  /** Écrit les écritures en attente (sérialisées). Toujours appelé à l'arrêt du serveur. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.chain = this.chain.then(async () => {
      if (this.pending.size === 0) return;
      const batch = [...this.pending.values()];
      this.pending.clear();
      try {
        await this.store.write(batch, this.ctx?.clock.now() ?? new Date());
        this.stats.writtenRows += batch.length;
        this.stats.flushes++;
        this.stats.lastFlushAt = new Date().toISOString();
        this.stats.lastError = null;
        this.writeAnchor(batch);
      } catch (e) {
        // Rien n'est perdu : le lot est remis en attente (sans écraser une version plus récente).
        for (const r of batch) {
          const k = `${r.kind}\u0000${r.repo}\u0000${r.id}`;
          if (!this.pending.has(k)) this.pending.set(k, r);
        }
        this.stats.lastError = e instanceof Error ? e.message : String(e);
        this.opts.log?.('error', `Écriture de persistance en échec : ${this.stats.lastError}`);
        throw e;
      }
    });
    const p = this.chain;
    this.chain = this.chain.catch(() => undefined);
    return p;
  }

  /** Après un lot PERSISTÉ contenant des enregistrements d'audit : la tête persistée est ancrée hors base. */
  private writeAnchor(batch: SnapshotRow[]): void {
    if (!this.opts.anchor) return;
    let top: SnapshotRow | undefined;
    for (const r of batch) if (r.repo === AUDIT_REPO && (!top || r.seq > top.seq)) top = r;
    if (!top) return;
    const rec = decodeDoc(top.doc) as AuditRecord;
    if (this.stats.lastAnchor && this.stats.lastAnchor.seq >= rec.seq) return;
    try {
      this.stats.lastAnchor = this.opts.anchor.write({ seq: rec.seq, hash: rec.hash }, new Date());
    } catch (e) {
      // La base est à jour ; seule l'ancre est en retard (elle reste un préfixe valide) : erreur signalée, pas de perte.
      this.stats.lastError = `Ancre d'audit non écrite : ${e instanceof Error ? e.message : String(e)}`;
      this.opts.log?.('error', this.stats.lastError);
    }
  }

  status(): PersistenceStats {
    return {
      store: this.store.kind,
      attached: this.attached,
      repositories: [...(this.discovery?.repos.keys() ?? [])].sort(),
      pendingWrites: this.pending.size,
      ...structuredClone(this.stats),
    };
  }

  async close(): Promise<void> {
    await this.flush().catch(() => undefined);
    if (this.stats.lastAnchor) this.opts.log?.('info', anchorLogLine(this.stats.lastAnchor));
    await this.store.close();
  }
}

/**
 * Recharge le journal d'audit en place. Le journal (core/audit.ts, chemin partagé) n'expose pas encore de
 * méthode de restauration : on remplace le contenu de son stockage et l'ancrage de tête. Changement partagé
 * demandé : `AuditLog.restore(records)` (voir rapport du lot « socle »).
 */
export function restoreAuditLog(audit: AuditLog, records: AuditRecord[]): void {
  audit.restore(records);
}

// ---------------------------------------------------------------------------------------------------------------
// Moteur actif du processus (préparé de façon asynchrone par boot.ts avant buildApp)
// ---------------------------------------------------------------------------------------------------------------

let active: PersistenceRuntime | undefined;

export function setActivePersistence(rt: PersistenceRuntime | undefined): void {
  active = rt;
}

export function getActivePersistence(): PersistenceRuntime | undefined {
  return active;
}
