/**
 * Persistance opt-in (DATABASE_URL) : instantané JSONB des dépôts, chargé au démarrage et tenu à jour à chaque
 * écriture (insert / update / append) par abonnement aux dépôts en mémoire. Les lectures restent en mémoire :
 * aucune interface de dépôt ne change et le fonctionnement par défaut (tests, démonstration) est inchangé.
 *
 * Séquence : les données de démonstration sont semées normalement, puis `attach(ctx)` :
 *   1. fusionne l'instantané chargé (il prévaut) avec l'état semé (les nouveautés semées sont conservées) ;
 *   2. recharge le journal d'audit chaîné et vérifie la chaîne ;
 *   3. avance les générateurs d'identifiants au-delà des numéros restaurés (aucune collision) ;
 *   4. s'abonne aux écritures et écrit par lots (écriture différée courte, `flush()` à l'arrêt).
 */
import type { AuditLog, AuditRecord, AuditVerification } from '../core/audit.js';
import type { Entity } from '../core/repository.js';
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
}

interface AttachableContext {
  clock: { now(): Date };
  audit: AuditLog;
}

export interface RuntimeOptions {
  /** Délai d'écriture différée (ms) ; 0 = écriture à la prochaine micro-tâche. */
  flushDelayMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export class PersistenceRuntime {
  private readonly pending = new Map<string, SnapshotRow>();
  private seqByRepo = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private discovery: Discovery | null = null;
  private ctx: AttachableContext | null = null;
  private stats: Omit<PersistenceStats, 'store' | 'attached' | 'repositories' | 'pendingWrites'> = {
    writtenRows: 0, flushes: 0, lastFlushAt: null, lastError: null, report: null,
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
    if (auditRows && auditRows.length > 0) {
      const records = auditRows.slice().sort((a, b) => a.seq - b.seq).map((r) => decodeDoc(r.doc) as AuditRecord);
      restoreAuditLog(ctx.audit, records);
      auditRestored = records.length;
      auditCheck = ctx.audit.verify();
      if (!auditCheck.ok) {
        warnings.push(`Chaîne d'audit restaurée NON VÉRIFIÉE (${auditCheck.reason ?? 'inconnu'}) — clé MOSOLO_AUDIT_HMAC_KEY différente ou altération.`);
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
      newlyPersisted: newly, audit: auditCheck, warnings,
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
