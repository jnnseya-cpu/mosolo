/**
 * Intégrité au niveau plateforme :
 *   1. hors démonstration, AUCUNE donnée de démonstration n'est semée (ordres, quittances, écritures, suspens,
 *      utilisateurs, comptes du coffre, points d'encaissement) ; amorçage réel par fichier (MOSOLO_BOOTSTRAP_FILE) ;
 *   2. ancre EXTERNE de la tête du journal d'audit : troncature, réécriture ou retour à une ancienne sauvegarde détectés
 *      au démarrage et à la restauration (`--confirm-rollback`, événement `audit.restored`) ;
 *   3. démarrage hors démonstration refusé sans clés de signature stables (quittances, clôtures, audit, ancre).
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ConfigurationError } from '../src/core/auth.js';
import { ManualClock } from '../src/core/clock.js';
import type { AuditRecord } from '../src/core/audit.js';
import { AnchorError, FileAuditAnchor, MemoryAuditAnchor, compareWithAnchor, chainOf } from '../src/persistence/anchor.js';
import { createBackup, restoreStore } from '../src/persistence/backup.js';
import { assertBootSecrets, preparePersistence } from '../src/persistence/boot.js';
import { applyBootstrap, loadBootstrapFile, parseBootstrap, BOOTSTRAP_FORMAT } from '../src/persistence/bootstrap.js';
import { decodeDoc } from '../src/persistence/codec.js';
import { AUDIT_REPO, collectRows } from '../src/persistence/registry.js';
import { PersistenceRuntime } from '../src/persistence/runtime.js';
import { MemorySnapshotStore } from '../src/persistence/store.js';
import { createSoclePlugin, type SocleService } from '../src/plugins/socle/plugin.js';
import { DEFAULT_RATE_LIMITS } from '../src/plugins/socle/rate-limit.js';
import { DEMO_USERS } from '../src/seed.js';

const AUDIT_KEY = 'cle-audit-reelle-de-test-0123456789abcdef';
const BACKUP_KEY = 'cle-de-sauvegarde-de-test-0123456789';
/** Secrets « réels » (aucune valeur publique de démonstration) : exigés hors démonstration. */
const REAL_SECRETS = {
  auditHmacKey: AUDIT_KEY,
  providerSecrets: {
    'mm-operator-a': 'secret-reel-operateur-a-0123456789',
    'bank-a': 'secret-reel-banque-a-0123456789',
    'card-gateway': 'secret-reel-passerelle-carte-0123456789',
  },
  commsProviderKeys: {},
};
const TOUCHED = ['MOSOLO_DEMO_MODE', 'MOSOLO_AUDIT_ACCEPT_UNVERIFIED', 'MOSOLO_BOOTSTRAP_FILE', 'MOSOLO_BOOTSTRAP_CREDENTIALS_OUT'];
const saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
afterEach(() => setEnv(saved));
const nonDemo = (extra: Record<string, string | undefined> = {}) => setEnv({ MOSOLO_DEMO_MODE: 'false', ...extra });
const clock = () => new ManualClock('2026-09-26T09:00:00.000Z');
const tmp = () => mkdtempSync(join(tmpdir(), 'mosolo-integrite-'));

/** Dépôts « d'argent » et d'habilitation : doivent être vides au démarrage d'une plateforme réelle. */
const MONEY_REPOS = /(order|receipt|ledger|entr|suspens|account|cash|point|caisse|device|credential|obligation|taxpayer|contribuable|session|bordereau|closure|clotur)/i;

function moneyRows(app: ReturnType<typeof buildApp>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of collectRows(app.ctx)) if (r.repo !== AUDIT_REPO && MONEY_REPOS.test(r.repo)) out[r.repo] = (out[r.repo] ?? 0) + 1;
  return out;
}

// =================================================================================================================
describe('1. Démarrage hors démonstration : plateforme vide, amorçage réel', () => {
  it('hors démonstration (par défaut), aucun ordre, quittance, écriture, suspens, utilisateur ni compte fictif', async () => {
    nonDemo();
    const app = buildApp({ clock: clock(), secrets: REAL_SECRETS, connectorEnv: {} });
    await app.ready();
    expect(app.ctx.users.all()).toEqual([]);
    for (const u of DEMO_USERS) expect(app.ctx.users.get(u.id)).toBeUndefined();
    expect(app.ctx.payments.orders.count()).toBe(0);
    expect(app.ctx.vault.accounts.count()).toBe(0);
    expect(moneyRows(app)).toEqual({});
    // Aucune écriture comptable ni ordre dans la chaîne d'audit.
    const actions = app.ctx.audit.list({ limit: 10_000 }).items.map((r) => r.action);
    expect(actions.filter((a) => /^(payment|receipt|ledger|treasury|tresor|vault)\./.test(a))).toEqual([]);
    await app.close();
  });

  it('en démonstration, les mêmes dépôts sont semés (le contrôle précédent n’est pas vide de sens)', async () => {
    setEnv({ MOSOLO_DEMO_MODE: 'true' });
    const app = buildApp({ clock: clock(), secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} } });
    await app.ready();
    expect(app.ctx.users.all().length).toBeGreaterThan(20);
    expect(app.ctx.payments.orders.count()).toBeGreaterThan(0);
    expect(Object.keys(moneyRows(app)).length).toBeGreaterThan(3);
    await app.close();
  });

  it('`seed: true` explicite (tests) sème même hors démonstration ; `seed: false` ne sème jamais', async () => {
    nonDemo();
    const a = buildApp({ clock: clock(), secrets: REAL_SECRETS, connectorEnv: {}, plugins: [], seed: true });
    expect(a.ctx.users.all().length).toBeGreaterThan(0);
    setEnv({ MOSOLO_DEMO_MODE: 'true' });
    const b = buildApp({ clock: clock(), secrets: { auditHmacKey: 'k', commsProviderKeys: {} }, plugins: [], seed: false });
    expect(b.ctx.users.all()).toEqual([]);
  });

  const bootstrapDoc = () => ({
    format: BOOTSTRAP_FORMAT,
    users: [
      { id: 'admin.plateforme', name: 'Administratrice plateforme', roles: ['R26'], entity: 'PLATEFORME', enrol: true },
      { id: 'coffre.a', name: 'Gestionnaire du coffre A', roles: ['R19'], entity: 'TRESOR' },
      { id: 'coffre.b', name: 'Gestionnaire du coffre B', roles: ['R19'], entity: 'TRESOR' },
    ],
    vaultAccounts: [
      { alias: 'KIN-DGIPK-RECETTES-01', entity: 'DGIPK', bankName: 'Banque réelle', accountNumber: 'CD11 2222 3333 4444 5555 6666', holderName: 'DGIPK — Recettes', currency: 'USD' },
    ],
  });

  it('amorçage par fichier : comptes de travail, compte du coffre, enrôlement initial exclusif (0600), tracés', async () => {
    const dir = tmp();
    const file = join(dir, 'amorcage.json');
    writeFileSync(file, JSON.stringify(bootstrapDoc()));
    const out = join(dir, 'identifiants.json');
    nonDemo({ MOSOLO_BOOTSTRAP_FILE: file, MOSOLO_BOOTSTRAP_CREDENTIALS_OUT: out });
    const app = buildApp({ clock: clock(), secrets: REAL_SECRETS, connectorEnv: {}, plugins: [createSoclePlugin({ persistence: null, rateLimit: { ...DEFAULT_RATE_LIMITS, enabled: false } })] });
    await app.ready();
    expect(app.bootstrapReport).toMatchObject({ users: ['admin.plateforme', 'coffre.a', 'coffre.b'], vaultCreated: ['KIN-DGIPK-RECETTES-01'], enrolled: ['admin.plateforme'], credentialsFile: out });
    expect(app.ctx.vault.aliasExists('KIN-DGIPK-RECETTES-01')).toBe(true);
    expect(app.ctx.users.get('u-gouverneur')).toBeUndefined();
    const creds = JSON.parse(readFileSync(out, 'utf8')) as { issued: { login: string; password: string }[] };
    expect(creds.issued[0]!.login).toBe('admin.plateforme');
    expect(creds.issued[0]!.password.length).toBeGreaterThanOrEqual(20);
    expect(statSync(out).mode & 0o077).toBe(0);
    expect((app.ctx.ext.socle as SocleService).idp.credentials.get('admin.plateforme')).toBeDefined();
    const actions = app.ctx.audit.list({ limit: 1000 }).items.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['vault.account.bootstrapped', 'bootstrap.applied']));
    expect(JSON.stringify(app.ctx.audit.list({ limit: 1000 }).items)).not.toContain('3333 4444');

    // Réapplication : le compte existant n'est JAMAIS écrasé (double validation du coffre), pas de réenrôlement.
    const changed = bootstrapDoc();
    changed.vaultAccounts[0]!.accountNumber = 'CD99 9999 9999 9999 9999 9999';
    const again = applyBootstrap(app.ctx, parseBootstrap(changed));
    expect(again).toMatchObject({ vaultCreated: [], vaultKept: ['KIN-DGIPK-RECETTES-01'], enrolled: [] });
    expect(app.ctx.vault.accounts.get('KIN-DGIPK-RECETTES-01')!.accountNumber).toBe('CD11 2222 3333 4444 5555 6666');
    await app.close();

    // Fichier d'identifiants non détruit : aucun écrasement (création exclusive).
    const app2 = () => buildApp({ clock: clock(), secrets: REAL_SECRETS, connectorEnv: {}, plugins: [createSoclePlugin({ persistence: null, rateLimit: { ...DEFAULT_RATE_LIMITS, enabled: false } })] });
    expect(app2).toThrow(ConfigurationError);
  });

  it('fichier d’amorçage invalide ou dangereux refusé ; amorçage refusé en démonstration', () => {
    expect(() => parseBootstrap({ format: BOOTSTRAP_FORMAT, users: [{ id: 'x.y', name: 'X', roles: ['R99'], entity: 'E' }] })).toThrow(ConfigurationError);
    expect(() => parseBootstrap({ format: 'autre', users: [] })).toThrow(/amorçage invalide/);
    expect(() => parseBootstrap({ format: BOOTSTRAP_FORMAT, vaultAccounts: [bootstrapDoc().vaultAccounts[0], bootstrapDoc().vaultAccounts[0]] })).toThrow(/double/);
    expect(() => loadBootstrapFile(join(tmp(), 'absent.json'))).toThrow(/MOSOLO_BOOTSTRAP_FILE illisible/);
    nonDemo();
    const app = buildApp({ clock: clock(), secrets: REAL_SECRETS, connectorEnv: {}, plugins: [] });
    // Cumul de rôles incompatibles : refusé par l'annuaire (§ 12.5).
    expect(() => applyBootstrap(app.ctx, parseBootstrap({ format: BOOTSTRAP_FORMAT, users: [{ id: 'cumul.x', name: 'Cumul', roles: ['R13', 'R16'], entity: 'MINFIN' }] }))).toThrow(/Cumul interdit/);
    setEnv({ MOSOLO_DEMO_MODE: 'true' });
    expect(() => applyBootstrap(app.ctx, parseBootstrap(bootstrapDoc()))).toThrow(/démonstration/);
  });
});

// =================================================================================================================
describe('2. Ancre externe de la chaîne d’audit', () => {
  async function bootOn(store: MemorySnapshotStore, anchor: MemoryAuditAnchor | FileAuditAnchor, opts: { accept?: boolean; auditKey?: string } = {}) {
    const rt = await PersistenceRuntime.open(store, { anchor, ...(opts.accept !== undefined ? { acceptUnverifiedAudit: opts.accept } : {}) });
    const app = buildApp({
      clock: clock(), connectorEnv: {}, seed: true,
      secrets: { ...REAL_SECRETS, auditHmacKey: opts.auditKey ?? AUDIT_KEY },
      plugins: [createSoclePlugin({ persistence: rt, rateLimit: { ...DEFAULT_RATE_LIMITS, enabled: false } })],
    });
    await app.ready();
    await rt.flush();
    return { rt, app };
  }
  const auditRows = async (store: MemorySnapshotStore) => (await store.loadAll()).filter((r) => r.repo === AUDIT_REPO).sort((a, b) => a.seq - b.seq);

  it('l’ancre suit la tête PERSISTÉE ; un redémarrage conforme est accepté', async () => {
    nonDemo();
    const store = new MemorySnapshotStore();
    const anchor = new MemoryAuditAnchor(AUDIT_KEY);
    const { rt, app } = await bootOn(store, anchor);
    const rows = await auditRows(store);
    expect(anchor.read()).toMatchObject({ seq: rows.length, hash: (decodeDoc(rows.at(-1)!.doc) as AuditRecord).hash });
    app.ctx.audit.append({ actor: { kind: 'system', id: 't' }, action: 'test.event', resourceType: 't' });
    await rt.flush();
    expect(anchor.read()!.seq).toBe(rows.length + 1);
    await app.close();
    const second = await bootOn(store, anchor);
    expect(second.rt.status().report).toMatchObject({ audit: { ok: true }, anchor: { seq: rows.length + 1 } });
    await second.app.close();
  });

  it('chaîne tronquée en base (cohérente en elle-même) : démarrage REFUSÉ hors démonstration', async () => {
    nonDemo();
    const store = new MemorySnapshotStore();
    const anchor = new MemoryAuditAnchor(AUDIT_KEY);
    const { app } = await bootOn(store, anchor);
    await app.close();
    const all = await store.loadAll();
    const lastAudit = (await auditRows(store)).at(-1)!;
    // Troncature par un initié : la dernière ligne d'audit disparaît (la chaîne restante reste vérifiable seule).
    await store.replaceAll(all.filter((r) => !(r.repo === AUDIT_REPO && r.id === lastAudit.id)), new Date());
    await expect(bootOn(store, anchor)).rejects.toThrow(/ancre externe.*plus courte/);

    // Acceptation explicite après enquête : démarrage, et la rupture est TRACÉE dans la chaîne.
    const accepted = await bootOn(store, anchor, { accept: true });
    const ev = accepted.app.ctx.audit.list({ action: 'audit.anchor.mismatch' }).items;
    expect(ev).toHaveLength(1);
    expect(ev[0]!.details).toMatchObject({ accepted: 'MOSOLO_AUDIT_ACCEPT_UNVERIFIED', anchor: { seq: lastAudit.seq } });
    await accepted.app.close();
  });

  it('chaîne substituée (même longueur, autre contenu) ou ancre falsifiée : refus ; en démonstration, avertissement tracé', async () => {
    nonDemo();
    const storeA = new MemorySnapshotStore();
    const anchorA = new MemoryAuditAnchor(AUDIT_KEY);
    const a = await bootOn(storeA, anchorA);
    for (let i = 0; i < 3; i++) a.app.ctx.audit.append({ actor: { kind: 'system', id: 't' }, action: 'test.a', resourceType: 't' });
    await a.rt.flush();
    await a.app.close();
    const storeB = new MemorySnapshotStore();
    const b = await bootOn(storeB, new MemoryAuditAnchor(AUDIT_KEY));
    for (let i = 0; i < 6; i++) b.app.ctx.audit.append({ actor: { kind: 'system', id: 't' }, action: 'test.b', resourceType: 't' });
    await b.rt.flush();
    await b.app.close();
    // La base B (plus longue, autre histoire) est présentée face à l'ancre de A.
    await expect(bootOn(storeB, anchorA)).rejects.toThrow(/empreinte différente de l’ancre/);

    // Ancre falsifiée (rang abaissé sans la clé) : signature invalide.
    (anchorA.current as { seq: number }).seq = 1;
    await expect(bootOn(storeA, anchorA)).rejects.toThrow(/signature invalide/);

    setEnv({ MOSOLO_DEMO_MODE: 'true' });
    const demo = await bootOn(storeA, anchorA);
    expect(demo.rt.status().report!.warnings.join(' ')).toMatch(/NON CONFORME/);
    expect(demo.app.ctx.audit.list({ action: 'audit.anchor.mismatch' }).items[0]!.details).toMatchObject({ accepted: 'demonstration' });
    await demo.app.close();
  });

  it('ancre en fichier : écriture atomique 0600, relue et vérifiée ; altération détectée', () => {
    const path = join(tmp(), 'sous-dossier', 'ancre.json');
    const anchor = new FileAuditAnchor(path, AUDIT_KEY);
    expect(anchor.read()).toBeNull();
    anchor.write({ seq: 3, hash: 'a'.repeat(64) }, new Date('2026-09-26T10:00:00Z'));
    expect(anchor.read()).toMatchObject({ seq: 3, hash: 'a'.repeat(64), at: '2026-09-26T10:00:00.000Z' });
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(() => new FileAuditAnchor(path, 'autre-cle-audit-0123456789abcdef').read()).toThrow(AnchorError);
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...doc, seq: 2 }));
    expect(() => anchor.read()).toThrow(/signature invalide/);
    const h1 = '1'.repeat(64);
    const h2 = '2'.repeat(64);
    expect(compareWithAnchor({ seq: 2, hash: h2 }, chainOf([{ seq: 2, hash: h2 }, { seq: 1, hash: h1 }, { seq: 3, hash: h1 }]))).toMatchObject({ ok: true });
    expect(compareWithAnchor({ seq: 2, hash: h2 }, chainOf([{ seq: 1, hash: h1 }]))).toMatchObject({ ok: false, shorter: true });
    expect(compareWithAnchor({ seq: 1, hash: h2 }, chainOf([{ seq: 1, hash: h1 }]))).toMatchObject({ ok: false, shorter: false });
  });

  it('restauration : ancienne sauvegarde = RETOUR ARRIÈRE refusé sans --confirm-rollback ; confirmé, il est tracé et l’ancre suit', async () => {
    nonDemo();
    const store = new MemorySnapshotStore();
    const anchor = new MemoryAuditAnchor(AUDIT_KEY);
    const first = await bootOn(store, anchor);
    const old = createBackup(await store.loadAll(), BACKUP_KEY, { source: 'test' });
    const oldHead = (await auditRows(store)).length;
    for (let i = 0; i < 4; i++) first.app.ctx.audit.append({ actor: { kind: 'system', id: 't' }, action: 'test.apres', resourceType: 't' });
    await first.rt.flush();
    await first.app.close();
    const liveHead = anchor.read()!.seq;
    expect(liveHead).toBe(oldHead + 4);

    await expect(restoreStore(store, old, BACKUP_KEY, AUDIT_KEY, new Date(), { anchor })).rejects.toThrow(/RETOUR ARRIÈRE.*--confirm-rollback/);
    // Même sur une base vidée (disparue), l'ancre externe révèle le retour arrière.
    await expect(restoreStore(new MemorySnapshotStore(), old, BACKUP_KEY, AUDIT_KEY, new Date(), { anchor })).rejects.toThrow(/ancre externe/);
    expect(anchor.read()!.seq).toBe(liveHead);

    const r = await restoreStore(store, old, BACKUP_KEY, AUDIT_KEY, new Date(), { anchor, confirmRollback: true, operator: 'exploitant-1' });
    expect(r).toMatchObject({ rollback: true, previousHead: { seq: liveHead }, restoredHead: { seq: oldHead }, newHead: { seq: oldHead + 1 } });
    expect(anchor.read()).toMatchObject({ seq: oldHead + 1, hash: r.newHead.hash });
    const rows = await auditRows(store);
    const ev = decodeDoc(rows.at(-1)!.doc) as AuditRecord;
    expect(ev).toMatchObject({ action: 'audit.restored', actor: { id: 'db:restore:exploitant-1' }, details: { rollback: true, lostRecords: 4, previousHead: { seq: liveHead } } });

    // Redémarrage sur la base restaurée : chaîne intègre, conforme à l'ancre réécrite.
    const again = await bootOn(store, anchor);
    expect(again.rt.status().report).toMatchObject({ audit: { ok: true }, anchor: { seq: oldHead + 1 } });
    expect(again.app.ctx.audit.list({ action: 'audit.restored' }).items).toHaveLength(1);
    await again.app.close();
  });

  it('restauration qui prolonge la chaîne : acceptée sans confirmation, `audit.restored` ajouté', async () => {
    nonDemo();
    const store = new MemorySnapshotStore();
    const anchor = new MemoryAuditAnchor(AUDIT_KEY);
    const { app } = await bootOn(store, anchor);
    await app.close();
    const backup = createBackup(await store.loadAll(), BACKUP_KEY, { source: 'test' });
    const r = await restoreStore(store, backup, BACKUP_KEY, AUDIT_KEY, new Date(), { anchor });
    expect(r.rollback).toBe(false);
    expect(r.newHead.seq).toBe(r.restoredHead.seq + 1);
    const again = await bootOn(store, anchor);
    expect(again.rt.status().report!.audit!.ok).toBe(true);
    await again.app.close();
  });
});

// =================================================================================================================
describe('3. Clés de signature obligatoires hors démonstration', () => {
  const pem = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const base = () => ({ MOSOLO_DEMO_MODE: 'false', MOSOLO_RECEIPT_SIGNING_KEY: pem(), MOSOLO_CLOSURE_SIGNING_KEY: pem() }) as NodeJS.ProcessEnv;

  it('absentes, illisibles, identiques ou trop courtes : démarrage refusé ; en démonstration : aucun contrôle', () => {
    expect(() => assertBootSecrets(base())).not.toThrow();
    expect(() => assertBootSecrets({ ...base(), MOSOLO_RECEIPT_SIGNING_KEY: undefined })).toThrow(/MOSOLO_RECEIPT_SIGNING_KEY/);
    expect(() => assertBootSecrets({ ...base(), MOSOLO_CLOSURE_SIGNING_KEY: '' })).toThrow(/MOSOLO_CLOSURE_SIGNING_KEY/);
    expect(() => assertBootSecrets({ ...base(), MOSOLO_RECEIPT_SIGNING_KEY: 'pas-une-cle' })).toThrow(ConfigurationError);
    expect(() => assertBootSecrets({ ...base(), MOSOLO_CLOSURE_SIGNING_KEY: 'courte' })).toThrow(/trop courte/);
    const same = pem();
    expect(() => assertBootSecrets({ ...base(), MOSOLO_RECEIPT_SIGNING_KEY: same, MOSOLO_CLOSURE_SIGNING_KEY: same })).toThrow(/distincte/);
    // Persistance : clé d'audit et ancre externe exigées.
    expect(() => assertBootSecrets({ ...base(), DATABASE_URL: 'postgres://x' })).toThrow(/MOSOLO_AUDIT_HMAC_KEY, MOSOLO_AUDIT_ANCHOR_PATH/);
    expect(() => assertBootSecrets({ ...base(), DATABASE_URL: 'postgres://x', MOSOLO_AUDIT_HMAC_KEY: AUDIT_KEY, MOSOLO_AUDIT_ANCHOR_PATH: '/var/lib/mosolo/ancre.json' })).not.toThrow();
    expect(() => assertBootSecrets({ MOSOLO_DEMO_MODE: 'true' } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('preparePersistence refuse avant toute connexion à la base', async () => {
    const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
    await expect(preparePersistence({ MOSOLO_DEMO_MODE: 'false', DATABASE_URL: 'postgres://inaccessible' } as NodeJS.ProcessEnv, silent)).rejects.toThrow(ConfigurationError);
    await expect(preparePersistence({ ...base() }, silent)).resolves.toBeUndefined();
  });
});
