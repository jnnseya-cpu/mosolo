/**
 * Mode production (NODE_ENV=production, sans --demo) : aucune donnée de démonstration (utilisateurs, dossiers, types de
 * titres « DÉMONSTRATION »), en-tête x-demo-user refusé, option --demo refusée, base de données obligatoire.
 * Le mode démonstration lui-même est inchangé (données conservées sur instruction du maître d'ouvrage, 27/09/2026).
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ConfigurationError } from '../src/core/auth.js';
import { ManualClock } from '../src/core/clock.js';
import { enableDemoFromArgv } from '../src/core/demo-flag.js';
import { assertBootSecrets, assertMemoryEntryAllowed } from '../src/persistence/boot.js';
import { AUDIT_REPO, collectRows } from '../src/persistence/registry.js';
import { DEMO_USERS } from '../src/seed.js';

const REAL_SECRETS = {
  auditHmacKey: 'cle-audit-reelle-de-test-0123456789abcdef',
  providerSecrets: {
    'mm-operator-a': 'secret-reel-operateur-a-0123456789',
    'bank-a': 'secret-reel-banque-a-0123456789',
    'card-gateway': 'secret-reel-passerelle-carte-0123456789',
  },
  commsProviderKeys: {},
};
const TOUCHED = ['MOSOLO_DEMO_MODE', 'NODE_ENV', 'MOSOLO_DEMO_CREDENTIALS'];
const saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
afterEach(() => setEnv(saved));
const clock = () => new ManualClock('2026-09-27T09:00:00.000Z');
const production = () => setEnv({ NODE_ENV: 'production', MOSOLO_DEMO_MODE: undefined, MOSOLO_DEMO_CREDENTIALS: undefined });

/** Identifiants ou codes marqués « démonstration » (DEMO-…, demo-…, u-… des comptes semés). */
const DEMO_MARK = /^(demo[-_]|ctype-demo-)/i;

describe('Mode production : aucune donnée de démonstration', () => {
  it('tous les modules chargés : aucun utilisateur, aucun enregistrement ni type de titre marqué démonstration', async () => {
    production();
    const app = buildApp({ clock: clock(), secrets: REAL_SECRETS, connectorEnv: {} });
    await app.ready();
    expect(app.ctx.demoData).toBe(false);
    expect(app.ctx.users.all()).toEqual([]);
    for (const u of DEMO_USERS) expect(app.ctx.users.get(u.id)).toBeUndefined();
    const marked: string[] = [];
    for (const r of collectRows(app.ctx)) {
      if (r.repo === AUDIT_REPO) continue;
      const doc = r.doc as { code?: unknown; label?: unknown };
      if (DEMO_MARK.test(r.id) || (typeof doc.code === 'string' && DEMO_MARK.test(doc.code))) marked.push(`${r.repo}:${r.id}`);
      if (typeof doc.label === 'string' && /^D[ÉE]MONSTRATION\b/i.test(doc.label)) marked.push(`${r.repo}:${r.id}`);
    }
    expect(marked).toEqual([]);
    // Aucun dossier contribuable, objet, ordre de paiement, quittance ni compte du coffre.
    expect(app.ctx.taxpayers.taxpayers.count()).toBe(0);
    expect(app.ctx.payments.orders.count()).toBe(0);
    expect(app.ctx.vault.accounts.count()).toBe(0);
    await app.close();
  });

  it('en-tête x-demo-user refusé (401 DEMO_AUTH_DISABLED) et liste des comptes de démonstration introuvable', async () => {
    production();
    const app = buildApp({ clock: clock(), secrets: REAL_SECRETS, connectorEnv: {} });
    await app.ready();
    for (const id of ['u-gouverneur', 'u-auditeur', DEMO_USERS[0]!.id]) {
      const r = await app.inject({ method: 'GET', url: '/v1/audit/events', headers: { 'x-demo-user': id } });
      expect(r.statusCode).toBe(401);
      expect(r.json()).toMatchObject({ code: 'DEMO_AUTH_DISABLED' });
    }
    expect((await app.inject({ method: 'GET', url: '/v1/demo/users' })).statusCode).toBe(404);
    await app.close();
  });

  it('option --demo en production : le mode démonstration ne s’active pas et le démarrage est refusé', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
    enableDemoFromArgv(['node', 'server.ts', '--demo'], env);
    production();
    setEnv({ MOSOLO_DEMO_MODE: env.MOSOLO_DEMO_MODE });
    expect(() => buildApp({ clock: clock(), secrets: REAL_SECRETS, connectorEnv: {}, plugins: [] })).toThrow(/NODE_ENV=production/);
  });

  it('en démonstration, les types de titres « DÉMONSTRATION » restent présents (démonstration inchangée)', async () => {
    setEnv({ MOSOLO_DEMO_MODE: 'true', NODE_ENV: undefined });
    const app = buildApp({ clock: clock(), secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
    await app.ready();
    expect(app.ctx.demoData).toBe(true);
    expect(app.ctx.users.all().length).toBeGreaterThan(20);
    const codes = collectRows(app.ctx).filter((r) => r.repo === 'ext.titres.types').map((r) => (r.doc as { code: string }).code);
    expect(codes).toEqual(expect.arrayContaining(['DEMO-PKS-RESIDENTIEL', 'PKS-RESIDENTIEL']));
    await app.close();
  });
});

describe('Mode production : démarrage refusé sans base de données ni secrets', () => {
  const pem = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const keys = () => ({ MOSOLO_RECEIPT_SIGNING_KEY: pem(), MOSOLO_CLOSURE_SIGNING_KEY: pem() });

  it('NODE_ENV=production sans DATABASE_URL : refus ; avec base, clé d’audit et ancre : accepté', () => {
    expect(() => assertBootSecrets({ NODE_ENV: 'production', ...keys() })).toThrow(/DATABASE_URL/);
    expect(() => assertBootSecrets({ NODE_ENV: 'production' })).toThrow(/MOSOLO_RECEIPT_SIGNING_KEY, MOSOLO_CLOSURE_SIGNING_KEY, DATABASE_URL/);
    expect(() => assertBootSecrets({
      NODE_ENV: 'production', ...keys(), DATABASE_URL: 'postgres://mosolo@db/mosolo',
      MOSOLO_AUDIT_HMAC_KEY: 'cle-audit-reelle-de-test-0123456789abcdef', MOSOLO_AUDIT_ANCHOR_PATH: '/var/lib/mosolo/ancre.json',
    })).not.toThrow();
    // --demo ne lève pas le contrôle en production (le mode démonstration y est toujours inactif).
    expect(() => assertBootSecrets({ NODE_ENV: 'production', MOSOLO_DEMO_MODE: 'true', ...keys() })).toThrow(ConfigurationError);
    // Hors production (préproduction sans NODE_ENV) : stockage mémoire toléré, comportement historique conservé.
    expect(() => assertBootSecrets({ MOSOLO_DEMO_MODE: 'false', ...keys() })).not.toThrow();
  });

  it('point d’entrée sans persistance (src/server.ts) refusé en production, permis ailleurs', () => {
    expect(() => assertMemoryEntryAllowed({ NODE_ENV: 'production' })).toThrow(/persistence\/server\.ts/);
    expect(() => assertMemoryEntryAllowed({ MOSOLO_DEMO_MODE: 'true' })).not.toThrow();
    expect(() => assertMemoryEntryAllowed({})).not.toThrow();
  });
});
