/**
 * Magasins d'instantanés : PostgreSQL (pilote `pg`, ou `pg-mem` en test) et magasin en mémoire (tests, outils).
 * Deux tables (backend/db/migrations) : `repository_snapshot` (documents modifiables, UPSERT)
 * et `append_only_journal` (insertion seule, conflit ignoré : un enregistrement déjà écrit n'est jamais réécrit).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type RowKind = 'mutable' | 'append';

export interface SnapshotRow {
  repo: string;
  id: string;
  kind: RowKind;
  /** Rang d'insertion dans le dépôt (ordre de rechargement) ; ignoré lors de la mise à jour d'un document existant. */
  seq: number;
  /** Document encodé (voir codec.ts), sérialisable en JSON. */
  doc: unknown;
}

export interface SnapshotStore {
  readonly kind: string;
  migrate(): Promise<string[]>;
  loadAll(): Promise<SnapshotRow[]>;
  /**
   * Écrit un lot : UPSERT des documents modifiables, INSERT … DO NOTHING des enregistrements en ajout seul.
   * `leaseGeneration` (moteur de persistance du serveur) : le lot échoue par LeaseLostError si une instance plus
   * récente a pris le bail ; sans elle (outils d'exploitation, tests), aucune vérification.
   */
  write(rows: SnapshotRow[], at: Date, leaseGeneration?: number): Promise<void>;
  /** Remplace tout le contenu (restauration d'une sauvegarde vérifiée), dans une transaction. */
  replaceAll(rows: SnapshotRow[], at: Date): Promise<void>;
  close(): Promise<void>;
  /** Bail de l'instance active (migration 004, facultatif) : incrémente et renvoie la génération (chevauchement de révisions). */
  acquireLease?(holder: string, at: Date): Promise<number>;
}

/** Une instance plus récente a pris le bail : cette instance ne doit plus jamais écrire. */
export class LeaseLostError extends Error {
  constructor(readonly mine: number, readonly current: number | null) {
    super(`Instance supplantée : bail de génération ${mine}, génération en base ${current ?? 'absente'} — écritures refusées (une instance plus récente est active).`);
    this.name = 'LeaseLostError';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Magasin en mémoire (tests et adaptateur factice)
// ---------------------------------------------------------------------------------------------------------------

export class MemorySnapshotStore implements SnapshotStore {
  readonly kind = 'memoire';
  private readonly rows = new Map<string, SnapshotRow & { at: string }>();
  writes = 0;

  async migrate(): Promise<string[]> {
    return [];
  }
  async loadAll(): Promise<SnapshotRow[]> {
    return sortRows([...this.rows.values()].map(({ at: _at, ...r }) => structuredClone(r)));
  }
  async write(rows: SnapshotRow[], at: Date): Promise<void> {
    this.writes++;
    for (const r of rows) {
      const key = `${r.repo}\u0000${r.id}`;
      const prev = this.rows.get(key);
      if (r.kind === 'append' && prev) continue;
      this.rows.set(key, { ...structuredClone(r), seq: prev ? prev.seq : r.seq, at: at.toISOString() });
    }
  }
  async replaceAll(rows: SnapshotRow[], at: Date): Promise<void> {
    this.rows.clear();
    await this.write(rows, at);
  }
  async close(): Promise<void> {}
}

export function sortRows(rows: SnapshotRow[]): SnapshotRow[] {
  return rows.sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
}

// ---------------------------------------------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------------------------------------------

/** Sous-ensemble commun à `pg.Pool` et à l'adaptateur `pg-mem`. */
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface PgClient extends PgQueryable {
  release(): void;
}
export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

export interface PgStoreOptions {
  /** `postgres` (défaut) applique aussi les migrations `*.pg.sql` (déclencheurs PL/pgSQL). */
  dialect?: 'postgres' | 'pg-mem';
  migrationsDir?: string;
}

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const CHUNK = 200;
/** Clé fixe du verrou consultatif PostgreSQL des migrations (« MOSOLO » en hexadécimal). */
export const MIGRATION_LOCK_KEY = 0x4d4f534f4c4f;
/** Identifiant unique de la ligne du bail de l'instance active (migration 004). */
const LEASE_ID = 'principal';

export class PgSnapshotStore implements SnapshotStore {
  readonly kind = 'postgresql';
  private readonly dialect: 'postgres' | 'pg-mem';
  private readonly migrationsDir: string;

  constructor(private readonly pool: PgPoolLike, opts: PgStoreOptions = {}) {
    this.dialect = opts.dialect ?? 'postgres';
    this.migrationsDir = opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  }

  /**
   * Migrations versionnées (fichiers `NNN_nom.sql`, `NNN_nom.pg.sql` pour PostgreSQL seul), appliquées une fois
   * (journal `schema_migrations`). Idempotentes : une seconde exécution ne rejoue aucun fichier, et chaque fichier est
   * lui-même rejouable (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP … IF EXISTS`, blocs `DO` gardés — contrôlé par
   * test/deploiement.test.ts). PostgreSQL : verrou consultatif de session pendant toute la migration, pour que deux
   * démarrages simultanés (deux instances, ou la tâche de migration et le service) ne jouent jamais un fichier deux fois.
   */
  async migrate(): Promise<string[]> {
    if (this.dialect !== 'postgres') return this.migrateWith(this.pool, (fn) => this.tx(fn));
    const lock = await this.pool.connect();
    try {
      await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      // Transactions sur la connexion qui détient le verrou (un verrou de session suit sa connexion).
      return await this.migrateWith(lock, (fn) => this.txOn(lock, fn));
    } finally {
      await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
      lock.release();
    }
  }

  private async migrateWith(q: PgQueryable, tx: <T>(fn: (c: PgQueryable) => Promise<T>) => Promise<T>): Promise<string[]> {
    // Contrôle d'existence d'abord : un rôle applicatif sans droit CREATE lit le journal sans jamais tenter de créer.
    const exists = await q.query("SELECT table_name FROM information_schema.tables WHERE table_name = 'schema_migrations' AND table_schema = current_schema()");
    if (exists.rows.length === 0) {
      await q.query('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (version))');
    }
    const done = new Set((await q.query('SELECT version FROM schema_migrations')).rows.map((r) => String(r.version)));
    const applied: string[] = [];
    for (const f of this.migrationFiles()) {
      if (done.has(f)) continue;
      const sql = readFileSync(`${this.migrationsDir}/${f}`, 'utf8');
      await tx(async (c) => {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [f, new Date().toISOString()]);
      });
      applied.push(f);
    }
    return applied;
  }

  /** Fichiers de migration applicables à ce dialecte, dans l'ordre. */
  private migrationFiles(): string[] {
    return readdirSync(this.migrationsDir)
      .filter((f) => /^\d{3}_.+\.sql$/.test(f) && (this.dialect === 'postgres' || !f.endsWith('.pg.sql')))
      .sort();
  }

  /** Migrations en attente, sans rien appliquer (contrôle d'exploitation, tâche de migration). */
  async pendingMigrations(): Promise<string[]> {
    const exists = await this.pool.query("SELECT table_name FROM information_schema.tables WHERE table_name = 'schema_migrations' AND table_schema = current_schema()");
    const done = exists.rows.length ? new Set((await this.pool.query('SELECT version FROM schema_migrations')).rows.map((r) => String(r.version))) : new Set<string>();
    return this.migrationFiles().filter((f) => !done.has(f));
  }

  /** Instruction d'exploitation (rôles et droits, par la tâche de migration) ; jamais utilisée par le serveur. */
  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async loadAll(): Promise<SnapshotRow[]> {
    const mutable = await this.pool.query('SELECT repo, id, seq, doc FROM repository_snapshot');
    const journal = await this.pool.query('SELECT repo, id, seq, doc FROM append_only_journal');
    const rows: SnapshotRow[] = [
      ...mutable.rows.map((r) => ({ repo: String(r.repo), id: String(r.id), kind: 'mutable' as const, seq: Number(r.seq), doc: parseDoc(r.doc) })),
      ...journal.rows.map((r) => ({ repo: String(r.repo), id: String(r.id), kind: 'append' as const, seq: Number(r.seq), doc: parseDoc(r.doc) })),
    ];
    return sortRows(rows);
  }

  async write(rows: SnapshotRow[], at: Date, leaseGeneration?: number): Promise<void> {
    if (rows.length === 0) return;
    await this.tx(async (c) => {
      if (leaseGeneration !== undefined) await this.checkLease(c, leaseGeneration);
      await this.insertRows(c, rows, at);
    });
  }

  /** Prend le bail de l'instance active (génération + 1), AVANT le chargement de l'instantané. */
  async acquireLease(holder: string, at: Date): Promise<number> {
    const r = await this.pool.query(
      `INSERT INTO instance_lease (id, generation, holder, acquired_at) VALUES ($1, 1, $2, $3::timestamptz)
       ON CONFLICT (id) DO UPDATE SET generation = instance_lease.generation + 1, holder = EXCLUDED.holder, acquired_at = EXCLUDED.acquired_at
       RETURNING generation`,
      [LEASE_ID, holder.slice(0, 200), at.toISOString()],
    );
    return Number(r.rows[0]!.generation);
  }

  /**
   * Dans la transaction d'écriture : la génération en base doit être la nôtre. PostgreSQL : verrou partagé sur la
   * ligne du bail, de sorte qu'une prise de bail concurrente attend la fin des lots en cours (aucun lot après elle).
   */
  private async checkLease(c: PgQueryable, mine: number): Promise<void> {
    const r = await c.query(`SELECT generation FROM instance_lease WHERE id = $1${this.dialect === 'postgres' ? ' FOR SHARE' : ''}`, [LEASE_ID]);
    const current = r.rows.length ? Number(r.rows[0]!.generation) : null;
    if (current !== mine) throw new LeaseLostError(mine, current);
  }

  async replaceAll(rows: SnapshotRow[], at: Date): Promise<void> {
    await this.tx(async (c) => {
      if (this.dialect === 'postgres') {
        // Migration 003 : purge réservée aux opérateurs de restauration (rôle mosolo_restore), fonction SECURITY DEFINER.
        await c.query('SELECT mosolo_restore_purge()');
      } else {
        await c.query('DELETE FROM repository_snapshot');
        await c.query('DELETE FROM append_only_journal');
      }
      await this.insertRows(c, rows, at);
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async insertRows(c: PgQueryable, rows: SnapshotRow[], at: Date): Promise<void> {
    const iso = at.toISOString();
    // Dédoublonnage dans le lot (dernière version d'un document modifiable).
    const byKey = new Map<string, SnapshotRow>();
    for (const r of rows) byKey.set(`${r.kind}\u0000${r.repo}\u0000${r.id}`, r);
    const unique = [...byKey.values()];
    const mutable = unique.filter((r) => r.kind === 'mutable');
    const journal = unique.filter((r) => r.kind === 'append');
    for (let i = 0; i < mutable.length; i += CHUNK) {
      const part = mutable.slice(i, i + CHUNK);
      const params: unknown[] = [];
      const values = part.map((r) => {
        params.push(r.repo, r.id, r.seq, JSON.stringify(r.doc), iso);
        const n = params.length;
        return `($${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}::jsonb, $${n}::timestamptz)`;
      });
      await c.query(
        `INSERT INTO repository_snapshot (repo, id, seq, doc, updated_at) VALUES ${values.join(', ')}
         ON CONFLICT (repo, id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = EXCLUDED.updated_at`,
        params,
      );
    }
    for (let i = 0; i < journal.length; i += CHUNK) {
      const part = journal.slice(i, i + CHUNK);
      const params: unknown[] = [];
      const values = part.map((r) => {
        params.push(r.repo, r.id, r.seq, JSON.stringify(r.doc), iso);
        const n = params.length;
        return `($${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}::jsonb, $${n}::timestamptz)`;
      });
      await c.query(
        `INSERT INTO append_only_journal (repo, id, seq, doc, appended_at) VALUES ${values.join(', ')}
         ON CONFLICT (repo, id) DO NOTHING`,
        params,
      );
    }
  }

  private async tx<T>(fn: (c: PgQueryable) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      return await this.txOn(c, fn);
    } finally {
      c.release();
    }
  }

  /** Transaction sur une connexion déjà ouverte (celle qui détient le verrou de migration). */
  private async txOn<T>(c: PgQueryable, fn: (c: PgQueryable) => Promise<T>): Promise<T> {
    try {
      await c.query('BEGIN');
      const res = await fn(c);
      await c.query('COMMIT');
      return res;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
  }
}

function parseDoc(v: unknown): unknown {
  return typeof v === 'string' ? JSON.parse(v) : v;
}

/** Ouvre un pool `pg` sur DATABASE_URL (import dynamique : le pilote n'est chargé que si la persistance est active). */
export async function openPgStore(databaseUrl: string): Promise<PgSnapshotStore> {
  const pg = await import('pg');
  // Conversion justifiée : interopérabilité CommonJS/ESM du pilote `pg` ; PgPoolLike = sous-ensemble du pool réellement utilisé.
  const Pool = pg.default?.Pool ?? (pg as unknown as { Pool: typeof pg.default.Pool }).Pool;
  const pool = new Pool({ connectionString: databaseUrl, max: 5, application_name: 'kinshasa-mosolo' });
  // Conversion justifiée : interopérabilité CommonJS/ESM du pilote `pg` ; PgPoolLike = sous-ensemble du pool réellement utilisé.
  return new PgSnapshotStore(pool as unknown as PgPoolLike, { dialect: 'postgres' });
}
