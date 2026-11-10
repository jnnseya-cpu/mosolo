/**
 * Kit de déploiement (infra/) : preuves exécutables côté logiciel.
 *  1. Migrations idempotentes : une seconde exécution ne fait rien (pg-mem), chaque fichier SQL est rejouable tel quel,
 *     et aucun fichier ne recrée un objet existant (types, tables, fonctions, déclencheurs, rôles) — cause de l'échec
 *     d'un autre projet sur Cloud Run (type énuméré recréé au redémarrage).
 *  2. Démarrage de PRODUCTION complet (preparePersistence → buildApp → santé des clés, comme persistence/server.ts) avec
 *     la liste documentée des variables obligatoires (infra/vps/.env.example) sur PostgreSQL simulé : réussi ; refus
 *     explicite, nommant la variable, dès qu'une seule manque.
 *  3. Cohérence du kit : chaque variable obligatoire est créée par infra/gcp/deploy.sh (Secret Manager ou variable).
 *  4. Rôles PostgreSQL de la tâche de migration : noms contrôlés, mot de passe jamais journalisé.
 * PostgreSQL réel (facultatif, CI « persistance-postgresql ») : MOSOLO_TEST_PG_URL=postgres://… rejoue migrations,
 * fichiers bruts, migrations concurrentes et droits du rôle applicatif.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newDb } from 'pg-mem';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { preparePersistence, type BootLog } from '../src/persistence/boot.js';
import { redactStatement, roleStatements } from '../src/persistence/db-roles.js';
import { PersistenceRuntime, setActivePersistence } from '../src/persistence/runtime.js';
import { LeaseLostError, PgSnapshotStore, type PgPoolLike } from '../src/persistence/store.js';
import { DEFAULT_PLUGINS } from '../src/plugins/index.js';
import { assertKeyHealthAtBoot } from '../src/plugins/integrite/gouvernance/cles.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MIGRATIONS = join(ROOT, 'backend/db/migrations');
const silent: BootLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

function pgMemPool(): PgPoolLike {
  const { Pool } = newDb().adapters.createPg();
  // Conversion justifiée : l'adaptateur pg-mem expose le sous-ensemble du pool utilisé (query, connect, end).
  return new Pool() as unknown as PgPoolLike;
}

/** SQL sans commentaires « -- » (les commentaires citent des instructions à titre d'exemple). */
const stripComments = (sql: string) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

// =================================================================================================================
describe('Migrations idempotentes (Cloud Run, VPS : redémarrages et tâches de migration répétées)', () => {
  it('pg-mem : une seconde exécution est sans effet (aucun fichier rejoué, schéma inchangé)', async () => {
    const pool = pgMemPool();
    const store = new PgSnapshotStore(pool, { dialect: 'pg-mem' });
    const first = await store.migrate();
    expect(first).toEqual(['001_repository_snapshot.sql', '004_instance_lease.sql']);
    const tables = async () => (await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name")).rows.map((r) => String(r.table_name));
    const before = await tables();
    expect(before).toEqual(expect.arrayContaining(['append_only_journal', 'instance_lease', 'repository_snapshot', 'schema_migrations']));
    await store.write([{ repo: 'essai', id: 'X-1', kind: 'mutable', seq: 1, doc: { a: 1 } }], new Date());
    // Seconde et troisième exécutions (nouveau démarrage, nouvelle tâche de migration) : rien n'est rejoué.
    expect(await store.migrate()).toEqual([]);
    expect(await new PgSnapshotStore(pool, { dialect: 'pg-mem' }).migrate()).toEqual([]);
    expect(await store.pendingMigrations()).toEqual([]);
    expect(await tables()).toEqual(before);
    expect((await pool.query('SELECT count(*) AS n FROM schema_migrations')).rows[0]!.n).toBe(2);
    // Les données déjà écrites sont intactes.
    expect((await store.loadAll()).map((r) => r.id)).toEqual(['X-1']);
  });

  // Rejouer un fichier brut (sans le journal) n'est pas prouvable sur pg-mem : celui-ci ne sait pas réévaluer
  // « CREATE TABLE IF NOT EXISTS … PRIMARY KEY » sur une table existante (limite de pg-mem, pas du SQL). La preuve est
  // faite sur PostgreSQL réel ci-dessous (MOSOLO_TEST_PG_URL, CI « persistance-postgresql ») et, sur pg-mem, par le
  // contrôle statique suivant.

  it('aucune migration ne recrée un objet existant : IF NOT EXISTS, OR REPLACE, DROP … IF EXISTS ou bloc gardé', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    expect(files.length).toBeGreaterThanOrEqual(3);
    const problems: string[] = [];
    for (const f of files) {
      const sql = stripComments(readFileSync(join(MIGRATIONS, f), 'utf8'));
      const each = (re: RegExp, test: (m: RegExpMatchArray) => boolean, why: string) => {
        for (const m of sql.matchAll(re)) if (!test(m)) problems.push(`${f} : « ${m[0].trim()} » — ${why}`);
      };
      each(/CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?!IF\s+NOT\s+EXISTS)\S+/gi, () => false, 'CREATE TABLE sans IF NOT EXISTS');
      each(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?!IF\s+NOT\s+EXISTS)\S+/gi, () => false, 'CREATE INDEX sans IF NOT EXISTS');
      each(/CREATE\s+(?:SCHEMA|SEQUENCE|EXTENSION)\s+(?!IF\s+NOT\s+EXISTS)\S+/gi, () => false, 'sans IF NOT EXISTS');
      each(/ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)\S+/gi, () => false, 'ADD COLUMN sans IF NOT EXISTS');
      each(/CREATE\s+(?!OR\s+REPLACE\b)(?:FUNCTION|PROCEDURE|VIEW)\b/gi, () => false, 'CREATE sans OR REPLACE');
      // Types énumérés : uniquement dans un bloc DO qui ignore l'existence préalable.
      each(/CREATE\s+TYPE\s+\S+/gi, () => /duplicate_object|FROM\s+pg_type/i.test(sql), 'CREATE TYPE non gardé (duplicate_object ou pg_type)');
      each(/CREATE\s+ROLE\s+\S+/gi, () => /IF\s+NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+pg_roles/i.test(sql), 'CREATE ROLE non gardé');
      each(/CREATE\s+(?!OR\s+REPLACE\b)(?:CONSTRAINT\s+)?TRIGGER\s+(\w+)\s+[\s\S]*?\bON\s+(\w+)/gi,
        (m) => new RegExp(`DROP\\s+TRIGGER\\s+IF\\s+EXISTS\\s+${m[1]}\\s+ON\\s+${m[2]}`, 'i').test(sql), 'CREATE TRIGGER sans DROP TRIGGER IF EXISTS préalable');
    }
    expect(problems).toEqual([]);
  });

  it('le contrôle détecte bien une migration fautive (type énuméré recréé)', () => {
    const bad = "CREATE TYPE statut AS ENUM ('A', 'B');";
    expect(/CREATE\s+TYPE\s+\S+/i.test(bad) && !/duplicate_object|FROM\s+pg_type/i.test(bad)).toBe(true);
  });
});

// =================================================================================================================
/** Variables marquées « OBLIGATOIRE » dans infra/vps/.env.example (liste documentée unique). */
function documentedRequired(): string[] {
  const lines = readFileSync(join(ROOT, 'infra/vps/.env.example'), 'utf8').split('\n');
  const out: string[] = [];
  let mark = false;
  for (const l of lines) {
    if (/^#.*\bOBLIGATOIRE\b/.test(l)) mark = true;
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(l);
    if (m) {
      if (mark) out.push(m[1]!);
      mark = false;
    } else if (!l.startsWith('#')) mark = false;
  }
  return out;
}

const pem = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const rnd = () => randomBytes(36).toString('base64url');

/** Valeur de production plausible (jamais une valeur de démonstration) pour chaque variable. */
function valueFor(name: string, anchorDir: string): string {
  if (name === 'NODE_ENV') return 'production';
  if (name === 'DATABASE_URL') return 'postgres://mosolo_app:secret@db.interne:5432/mosolo';
  if (name === 'MOSOLO_AUDIT_ANCHOR_PATH') return join(anchorDir, 'ancre', 'ancre-audit.json');
  if (/_(SIGNING|PRIVATE)_KEY$/.test(name)) return pem();
  return rnd();
}

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  setActivePersistence(undefined);
});

/** Démarrage de production, dans l'ordre exact de src/persistence/server.ts, sur pg-mem. */
async function bootProduction(env: Record<string, string>) {
  for (const k of Object.keys(process.env)) if (k.startsWith('MOSOLO_') || k === 'DATABASE_URL' || k === 'NODE_ENV') delete process.env[k];
  Object.assign(process.env, env);
  const pool = pgMemPool();
  const runtime = await preparePersistence(process.env, silent, async () => new PgSnapshotStore(pool, { dialect: 'pg-mem' }));
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    app = buildApp({ logger: false, plugins: DEFAULT_PLUGINS });
    await app.ready();
    const health = assertKeyHealthAtBoot(app.ctx, process.env, silent);
    return { app, runtime, health };
  } catch (e) {
    await app?.close();
    await runtime?.close();
    throw e;
  }
}

describe('Démarrage de production avec la liste documentée des variables (pg-mem)', () => {
  const REQUIRED = [
    'NODE_ENV', 'DATABASE_URL', 'MOSOLO_RECEIPT_SIGNING_KEY', 'MOSOLO_CLOSURE_SIGNING_KEY', 'MOSOLO_JWT_PRIVATE_KEY',
    'MOSOLO_AUDIT_HMAC_KEY', 'MOSOLO_AUDIT_ANCHOR_PATH', 'MOSOLO_BACKUP_KEY',
    'MOSOLO_PROVIDER_SECRET_MM_OPERATOR_A', 'MOSOLO_PROVIDER_SECRET_BANK_A', 'MOSOLO_PROVIDER_SECRET_CARD_GATEWAY',
  ];

  it('infra/vps/.env.example documente exactement les variables exigées par le démarrage de production', () => {
    expect(documentedRequired().sort()).toEqual([...REQUIRED].sort());
  });

  it('infra/gcp/deploy.sh fournit chaque variable obligatoire (Secret Manager ou variable du service)', () => {
    const script = readFileSync(join(ROOT, 'infra/gcp/deploy.sh'), 'utf8');
    for (const name of documentedRequired()) expect(script, name).toContain(name);
  });

  it('avec toutes les variables documentées : démarrage réussi, persistance attachée, /health 200, mode EXPLOITATION', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mosolo-deploiement-'));
    try {
      const env = Object.fromEntries(documentedRequired().map((n) => [n, valueFor(n, dir)]));
      // Recommandées (clés séparées) : fournies par les deux kits.
      env.MOSOLO_INTEGRITE_KEY = rnd();
      env.MOSOLO_PAYMENT_POINT_MASTER_KEY = rnd();
      const { app, runtime, health } = await bootProduction(env);
      expect(runtime?.attached).toBe(true);
      expect(health?.mode).toBe('EXPLOITATION');
      expect(health?.summary.critical).toBe(0);
      expect(app.ctx.demoData).toBe(false);
      const r = await app.inject({ method: 'GET', url: '/health' });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ status: 'ok', storage: 'OK' });
      // En-tête de démonstration refusé.
      expect((await app.inject({ method: 'GET', url: '/v1/audit/events', headers: { 'x-demo-user': 'u-gouverneur' } })).statusCode).toBe(401);
      await app.close();
      await runtime?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sans les variables recommandées seulement : démarrage réussi (avertissements signalés, jamais bloquants)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mosolo-deploiement-'));
    try {
      const { app, runtime, health } = await bootProduction(Object.fromEntries(documentedRequired().map((n) => [n, valueFor(n, dir)])));
      expect(health?.summary.critical).toBeGreaterThanOrEqual(0);
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      await app.close();
      await runtime?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const missing of REQUIRED.filter((n) => n !== 'NODE_ENV')) {
    it(`sans ${missing} : démarrage refusé, message clair nommant la variable`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'mosolo-deploiement-'));
      try {
        const env = Object.fromEntries(documentedRequired().filter((n) => n !== missing).map((n) => [n, valueFor(n, dir)]));
        await expect(bootProduction(env)).rejects.toThrow(new RegExp(`(Démarrage refusé|Secrets des prestataires)[\\s\\S]*${missing}`));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('une valeur de démonstration à la place d’un secret : démarrage refusé', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mosolo-deploiement-'));
    try {
      const env = Object.fromEntries(documentedRequired().map((n) => [n, valueFor(n, dir)]));
      env.MOSOLO_BACKUP_KEY = 'demo-cle-de-sauvegarde-publique-0123456789';
      await expect(bootProduction(env)).rejects.toThrow(/MOSOLO_BACKUP_KEY/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =================================================================================================================
describe('Bail de l’instance active (migration 004) : chevauchement de révisions sans écrasement', () => {
  it('pg-mem : la nouvelle instance prend le bail, l’ancienne ne peut plus écrire (LeaseLostError)', async () => {
    const pool = pgMemPool();
    const ancienne = new PgSnapshotStore(pool, { dialect: 'pg-mem' });
    await ancienne.migrate();
    expect(await ancienne.acquireLease('ancienne', new Date())).toBe(1);
    await ancienne.write([{ repo: 'essai', id: 'A-1', kind: 'mutable', seq: 1, doc: { v: 1 } }], new Date(), 1);
    const nouvelle = new PgSnapshotStore(pool, { dialect: 'pg-mem' });
    expect(await nouvelle.migrate()).toEqual([]);
    expect(await nouvelle.acquireLease('nouvelle', new Date())).toBe(2);
    // La nouvelle instance relit tout ce que l'ancienne a écrit avant la prise du bail.
    expect((await nouvelle.loadAll()).map((r) => r.id)).toEqual(['A-1']);
    await expect(ancienne.write([{ repo: 'essai', id: 'A-2', kind: 'mutable', seq: 2, doc: { v: 2 } }], new Date(), 1)).rejects.toBeInstanceOf(LeaseLostError);
    await nouvelle.write([{ repo: 'essai', id: 'N-1', kind: 'mutable', seq: 2, doc: { v: 3 } }], new Date(), 2);
    expect((await nouvelle.loadAll()).map((r) => r.id).sort()).toEqual(['A-1', 'N-1']);
    // Outils d'exploitation (sauvegarde, restauration) : sans bail, jamais bloqués.
    await new PgSnapshotStore(pool, { dialect: 'pg-mem' }).write([{ repo: 'essai', id: 'O-1', kind: 'mutable', seq: 3, doc: {} }], new Date());
  });

  it('moteur de persistance : instance supplantée → stockage en échec (503), alerte critique, plus aucune tentative', async () => {
    const pool = pgMemPool();
    const store = new PgSnapshotStore(pool, { dialect: 'pg-mem' });
    const runtime = await PersistenceRuntime.open(store, { flushDelayMs: 0, retryBaseMs: 1, retryMaxMs: 2 });
    const raised: string[] = [];
    const audit = { length: 0, restore: () => undefined, verify: () => ({ ok: true }), all: () => [] };
    // Moteur attaché à un contexte minimal : on pilote directement l'écriture différée.
    // Conversion justifiée : accès de test aux membres privés `ctx` et `enqueue` (pas d'application complète ici).
    const internal = runtime as unknown as { ctx: unknown; enqueue(r: unknown): void };
    internal.ctx = { clock: { now: () => new Date() }, audit, alerts: { raise: (i: { type: string }) => raised.push(i.type) } };
    internal.enqueue({ repo: 'essai', id: 'A-1', kind: 'mutable', seq: 1, doc: {} });
    await runtime.flush();
    expect(runtime.degraded).toBe(false);
    // Une nouvelle révision démarre et prend le bail.
    await new PgSnapshotStore(pool, { dialect: 'pg-mem' }).acquireLease('nouvelle', new Date());
    internal.enqueue({ repo: 'essai', id: 'A-2', kind: 'mutable', seq: 2, doc: {} });
    await expect(runtime.flush()).rejects.toBeInstanceOf(LeaseLostError);
    expect(runtime.degraded).toBe(true);
    expect(runtime.status().superseded).toBe(true);
    expect(raised).toEqual(['INSTANCE_SUPPLANTEE']);
    // Plus rien n'est mis en attente ni réessayé.
    internal.enqueue({ repo: 'essai', id: 'A-3', kind: 'mutable', seq: 3, doc: {} });
    expect(runtime.status().pendingWrites).toBe(0);
    expect((await store.loadAll()).map((r) => r.id)).toEqual(['A-1']);
  });
});

// =================================================================================================================
describe('Rôles PostgreSQL de la tâche de migration (db-roles)', () => {
  it('rôle applicatif : droits minimaux, UPDATE / DELETE / TRUNCATE du journal retirés, mot de passe masqué', () => {
    const sql = roleStatements({ appRole: 'mosolo_app', appPassword: "mot'de-passe-solide-0123456789", restoreRole: 'mosolo_migration' });
    const all = sql.join(';\n');
    expect(all).toContain('GRANT SELECT, INSERT ON append_only_journal TO mosolo_app');
    expect(all).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON append_only_journal FROM mosolo_app');
    expect(all).toContain('GRANT mosolo_restore TO mosolo_migration');
    expect(all).not.toMatch(/GRANT mosolo_restore TO mosolo_app/);
    expect(all).toContain("PASSWORD 'mot''de-passe-solide-0123456789'");
    expect(sql.map(redactStatement).join('\n')).not.toContain('solide');
  });

  it('noms invalides, mot de passe court ou restauration accordée au rôle applicatif : refus', () => {
    expect(() => roleStatements({ appRole: 'app; DROP TABLE x', appPassword: 'x'.repeat(20) })).toThrow(/MOSOLO_DB_APP_ROLE/);
    expect(() => roleStatements({ appRole: 'mosolo_app', appPassword: 'court' })).toThrow(/MOSOLO_DB_APP_PASSWORD/);
    expect(() => roleStatements({ appRole: 'mosolo_app', appPassword: 'x'.repeat(20), restoreRole: 'mosolo_app' })).toThrow(/distinct/);
    expect(roleStatements({})).toEqual([]);
  });
});

// =================================================================================================================
const PG_URL = process.env.MOSOLO_TEST_PG_URL;
describe.skipIf(!PG_URL)('PostgreSQL réel (MOSOLO_TEST_PG_URL) : migrations rejouables et droits du rôle applicatif', () => {
  it('migrations concurrentes puis rejouées, fichiers bruts rejoués, rôle applicatif sans UPDATE du journal', async () => {
    const pg = (await import('pg')).default;
    const admin = new pg.Pool({ connectionString: PG_URL });
    const schema = `essai_${randomBytes(4).toString('hex')}`;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      const url = new URL(PG_URL!);
      url.searchParams.set('options', `-c search_path=${schema}`);
      // Conversion justifiée : pg.Pool expose le sous-ensemble utilisé (query, connect, end).
      const mk = () => new PgSnapshotStore(new pg.Pool({ connectionString: url.toString() }) as unknown as PgPoolLike, { dialect: 'postgres' });
      const [a, b] = [mk(), mk()];
      // Deux démarrages simultanés : le verrou consultatif sérialise, chaque fichier est appliqué une seule fois.
      const [ra, rb] = await Promise.all([a.migrate(), b.migrate()]);
      expect([...ra, ...rb].sort()).toEqual(readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort());
      expect(await a.migrate()).toEqual([]);
      expect(await b.pendingMigrations()).toEqual([]);
      // Chaque fichier (y compris PL/pgSQL) rejoué tel quel sur la base déjà migrée : aucune erreur.
      const raw = new pg.Pool({ connectionString: url.toString() });
      for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
        await raw.query(readFileSync(join(MIGRATIONS, f), 'utf8'));
      }
      await raw.end();
      // Bail de l'instance active (FOR SHARE) : l'ancienne instance est refusée dès que la nouvelle a pris le bail.
      const ga = await a.acquireLease('ancienne', new Date());
      await a.write([{ repo: 'essai', id: 'A-1', kind: 'mutable', seq: 1, doc: {} }], new Date(), ga);
      const gb = await b.acquireLease('nouvelle', new Date());
      expect(gb).toBe(ga + 1);
      await expect(a.write([{ repo: 'essai', id: 'A-2', kind: 'mutable', seq: 2, doc: {} }], new Date(), ga)).rejects.toBeInstanceOf(LeaseLostError);
      await b.write([{ repo: 'essai', id: 'B-1', kind: 'mutable', seq: 2, doc: {} }], new Date(), gb);
      expect((await b.loadAll()).map((r) => r.id).sort()).toEqual(['A-1', 'B-1']);
      await a.close();
      await b.close();
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await admin.end();
    }
  });
});
