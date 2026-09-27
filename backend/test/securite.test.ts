/**
 * Durcissement « sûr par défaut » : hors démonstration (MOSOLO_DEMO_MODE absent ou false, NODE_ENV=production),
 * aucun secret public de démonstration, aucune usurpation par en-tête, aucune boîte d'envoi exposée, CORS fermé,
 * limitation non contournable par en-tête client, chaîne d'audit jamais restaurée en silence.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, corsOrigins } from '../src/app.js';
import { ACR, assertSafeDeployment, ConfigurationError, isDemoMode, type User } from '../src/core/auth.js';
import { ManualClock } from '../src/core/clock.js';
import { hmacSha256Hex } from '../src/core/crypto.js';
import { deviceKeysFromEnv, providerSecretsFromEnv } from '../src/context.js';
import { restoreStore, createBackup } from '../src/persistence/backup.js';
import { collectRows } from '../src/persistence/registry.js';
import { PersistenceRuntime } from '../src/persistence/runtime.js';
import { MemorySnapshotStore } from '../src/persistence/store.js';
import { signBitriPayWebhook, BITRIPAY_DEMO_WEBHOOK_SECRET } from '../src/modules/payments/connectors/bitripay.js';
import { buildConnectorRegistry } from '../src/modules/payments/connectors/registry.js';
import { accesPlugin, type AccesService } from '../src/plugins/acces/plugin.js';
import { createSoclePlugin, type SocleService } from '../src/plugins/socle/plugin.js';
import { DEFAULT_RATE_LIMITS, tierOf } from '../src/plugins/socle/rate-limit.js';
import { MAX_PHONE_CHALLENGES } from '../src/plugins/socle/service.js';

const SECRETS = { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} };
const REAL_PROVIDER_ENV = {
  MOSOLO_PROVIDER_SECRET_MM_OPERATOR_A: 'secret-reel-operateur-a-0123456789',
  MOSOLO_PROVIDER_SECRET_BANK_A: 'secret-reel-banque-a-0123456789',
  MOSOLO_PROVIDER_SECRET_CARD_GATEWAY: 'secret-reel-passerelle-carte-0123456789',
};
const TOUCHED = [
  'MOSOLO_DEMO_MODE', 'NODE_ENV', 'MOSOLO_DEMO_CREDENTIALS', 'MOSOLO_CORS_ORIGINS', 'MOSOLO_DEVICE_KEYS', 'MOSOLO_PUBLIC_URL', 'SMS_GATEWAY_SECRET',
  'SVI_GATEWAY_SECRET', 'MOSOLO_AUDIT_ACCEPT_UNVERIFIED', ...Object.keys(REAL_PROVIDER_ENV),
];
const saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));

function setEnv(vars: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

afterEach(() => setEnv(saved));

const clock = () => new ManualClock('2026-09-26T09:00:00.000Z');
const nonDemo = (extra: Record<string, string | undefined> = {}) => setEnv({ MOSOLO_DEMO_MODE: 'false', ...extra });

// =================================================================================================================
describe('Mode démonstration : explicite, jamais en production', () => {
  it('actif seulement si MOSOLO_DEMO_MODE=true, et jamais lorsque NODE_ENV=production', () => {
    expect(isDemoMode({})).toBe(false);
    expect(isDemoMode({ MOSOLO_DEMO_MODE: 'false' })).toBe(false);
    expect(isDemoMode({ MOSOLO_DEMO_MODE: 'n’importe quoi' })).toBe(false);
    expect(isDemoMode({ MOSOLO_DEMO_MODE: 'true' })).toBe(true);
    expect(isDemoMode({ MOSOLO_DEMO_MODE: 'true', NODE_ENV: 'production' })).toBe(false);
  });

  it('démarrage refusé en production avec la démonstration ou ses identifiants', () => {
    expect(() => assertSafeDeployment({ NODE_ENV: 'production', MOSOLO_DEMO_MODE: 'true' })).toThrow(ConfigurationError);
    expect(() => assertSafeDeployment({ NODE_ENV: 'production', MOSOLO_DEMO_CREDENTIALS: 'true' })).toThrow(/MOSOLO_DEMO_CREDENTIALS/);
    expect(() => assertSafeDeployment({ NODE_ENV: 'production' })).not.toThrow();
    // Hors production, identifiants de démonstration sans mode démo (préproduction) : toléré.
    expect(() => assertSafeDeployment({ MOSOLO_DEMO_CREDENTIALS: 'true' })).not.toThrow();
    setEnv({ NODE_ENV: 'production', MOSOLO_DEMO_MODE: 'true' });
    expect(() => buildApp({ clock: clock(), secrets: SECRETS, plugins: [] })).toThrow(/NODE_ENV=production/);
    setEnv({ MOSOLO_DEMO_MODE: undefined, MOSOLO_DEMO_CREDENTIALS: 'true' });
    expect(() => buildApp({ clock: clock(), secrets: SECRETS, plugins: [createSoclePlugin()] })).toThrow(/MOSOLO_DEMO_CREDENTIALS/);
  });

  it('hors démonstration : x-demo-user refusé, /v1/demo/users introuvable ; en démonstration, disponible', async () => {
    const app = buildApp({ clock: clock(), secrets: SECRETS, plugins: [] });
    await app.ready();
    expect((await app.inject({ method: 'GET', url: '/v1/demo/users' })).statusCode).toBe(200);
    nonDemo();
    expect((await app.inject({ method: 'GET', url: '/v1/demo/users' })).statusCode).toBe(404);
    const r = await app.inject({ method: 'GET', url: '/v1/audit/events', headers: { 'x-demo-user': 'u-auditeur' } });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ code: 'DEMO_AUTH_DISABLED' });
    await app.close();
  });
});

// =================================================================================================================
describe('Secrets des prestataires et des terminaux', () => {
  it('hors démonstration : secret absent, public ou trop court ⇒ démarrage refusé (message explicite)', () => {
    expect(() => providerSecretsFromEnv({}, false)).toThrow(/MOSOLO_PROVIDER_SECRET_MM_OPERATOR_A absente/);
    expect(() => providerSecretsFromEnv({ ...REAL_PROVIDER_ENV, MOSOLO_PROVIDER_SECRET_BANK_A: 'demo-secret-bank-a' }, false)).toThrow(/MOSOLO_PROVIDER_SECRET_BANK_A invalide/);
    expect(() => providerSecretsFromEnv({ ...REAL_PROVIDER_ENV, MOSOLO_PROVIDER_SECRET_CARD_GATEWAY: 'court' }, false)).toThrow(/CARD_GATEWAY invalide/);
    expect(providerSecretsFromEnv(REAL_PROVIDER_ENV, false)).toEqual({
      'mm-operator-a': REAL_PROVIDER_ENV.MOSOLO_PROVIDER_SECRET_MM_OPERATOR_A, 'bank-a': REAL_PROVIDER_ENV.MOSOLO_PROVIDER_SECRET_BANK_A,
      'card-gateway': REAL_PROVIDER_ENV.MOSOLO_PROVIDER_SECRET_CARD_GATEWAY,
    });
    // Démonstration : valeurs publiques par défaut (parcours locaux et tests).
    expect(providerSecretsFromEnv({}, true)['mm-operator-a']).toBe('demo-secret-mm-operator-a');

    nonDemo();
    expect(() => buildApp({ clock: clock(), secrets: { auditHmacKey: 'k', commsProviderKeys: {} }, plugins: [] })).toThrow(ConfigurationError);
    // Secret injecté égal à une valeur publique : refusé aussi.
    expect(() => buildApp({ clock: clock(), secrets: { ...SECRETS, providerSecrets: { 'mm-operator-a': 'demo-secret-mm-operator-a' } }, plugins: [] })).toThrow(/prestataire mm-operator-a/);
  });

  it('hors démonstration : un rappel signé avec le secret public de démonstration est rejeté', async () => {
    nonDemo(REAL_PROVIDER_ENV);
    const c = clock();
    const app = buildApp({ clock: c, secrets: { auditHmacKey: 'k', commsProviderKeys: {} }, plugins: [], connectorEnv: {} });
    await app.ready();
    const raw = JSON.stringify({ providerTxnId: 'TXN-FORGE', paymentReference: 'KIN-INCONNUE', amount: { amount: '150.00', currency: 'USD' }, status: 'SUCCESS', completedAt: c.now().toISOString() });
    const send = (secret: string) => app.inject({
      method: 'POST', url: '/v1/providers/mm-operator-a/callbacks', payload: raw,
      headers: { 'content-type': 'application/json', 'x-signature': hmacSha256Hex(secret, raw), 'x-nonce': randomUUID(), 'x-timestamp': c.now().toISOString() },
    });
    const forged = await send('demo-secret-mm-operator-a');
    expect(forged.statusCode).toBe(401);
    expect(forged.json()).toMatchObject({ code: 'INVALID_SIGNATURE' });
    // Le vrai secret passe la signature (la référence inconnue est refusée ensuite, pour une autre raison).
    const genuine = await send(REAL_PROVIDER_ENV.MOSOLO_PROVIDER_SECRET_MM_OPERATOR_A);
    expect(genuine.json().code).not.toBe('INVALID_SIGNATURE');
    await app.close();
  });

  it('connecteurs BitriPay / KODA : sans secret réel, non enregistrés hors démonstration ; secret public refusé', async () => {
    expect(buildConnectorRegistry({}, {}, true).list().map((c) => c.id).sort()).toEqual(['bitripay', 'koda']);
    expect(buildConnectorRegistry({}, {}, false).list()).toEqual([]);
    expect(() => buildConnectorRegistry({ BITRIPAY_WEBHOOK_SECRET: BITRIPAY_DEMO_WEBHOOK_SECRET }, {}, false)).toThrow(/public/);
    expect(buildConnectorRegistry({ KODA_WEBHOOK_SECRET: 'whsec-reel-koda-0123456789' }, {}, false).list().map((c) => c.id)).toEqual(['koda']);

    nonDemo();
    const c = clock();
    const app = buildApp({ clock: c, secrets: SECRETS, plugins: [], connectorEnv: {} });
    await app.ready();
    const raw = JSON.stringify({ id: 'evt_forge', type: 'payment_intent.succeeded', data: {} });
    const t = Math.floor(c.now().getTime() / 1000);
    const r = await app.inject({
      method: 'POST', url: '/v1/providers/bitripay/webhooks', payload: raw,
      headers: { 'content-type': 'application/json', 'bitripay-signature': signBitriPayWebhook(BITRIPAY_DEMO_WEBHOOK_SECRET, raw, t) },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ code: 'UNKNOWN_PROVIDER' });
    await app.close();
  });

  it('clés des terminaux : jamais les clés publiques hors démonstration ; MOSOLO_DEVICE_KEYS lu et contrôlé', async () => {
    expect(deviceKeysFromEnv({}, true)['dev-terrain-001']).toBe('demo-device-key-001');
    const prod = deviceKeysFromEnv({ MOSOLO_DEVICE_KEYS: 'dev-terrain-002=cle-reelle-terminal-002-abcdef, dev-neuf=cle-reelle-terminal-neuf-01' }, false);
    expect(prod['dev-terrain-002']).toBe('cle-reelle-terminal-002-abcdef');
    expect(prod['dev-neuf']).toBe('cle-reelle-terminal-neuf-01');
    expect(prod['dev-terrain-001']).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.values(prod).some((k) => k.startsWith('demo-'))).toBe(false);
    expect(() => deviceKeysFromEnv({ MOSOLO_DEVICE_KEYS: 'dev-terrain-001=demo-device-key-001' }, false)).toThrow(/dev-terrain-001/);
    expect(() => deviceKeysFromEnv({ MOSOLO_DEVICE_KEYS: 'sans-egal' }, false)).toThrow(/format/);

    nonDemo();
    // Données semées explicitement (hors démonstration, elles ne le sont jamais par défaut) : clés substituées.
    const app = buildApp({ clock: clock(), secrets: SECRETS, connectorEnv: {}, seed: true });
    await app.ready();
    const keys = app.ctx.field.devices.all().map((d) => d.key);
    expect(keys.length).toBeGreaterThan(3);
    for (const k of ['demo-device-key-001', 'demo-device-key-002', 'demo-device-key-perdu', 'demo-device-key-canaux-01', 'demo-device-key-canaux-02', 'demo-device-key-rakapay-01']) {
      expect(keys).not.toContain(k);
    }
    await app.close();
  });
});

// =================================================================================================================
describe('CORS', () => {
  const preflight = (app: ReturnType<typeof buildApp>, origin: string) =>
    app.inject({ method: 'OPTIONS', url: '/v1/meta', headers: { origin, 'access-control-request-method': 'GET' } });

  it('ouvert en démonstration ; fermé hors démonstration sans liste ; liste MOSOLO_CORS_ORIGINS respectée', async () => {
    expect(corsOrigins({ MOSOLO_DEMO_MODE: 'true' })).toBe(true);
    expect(corsOrigins({})).toBe(false);
    expect(corsOrigins({ MOSOLO_CORS_ORIGINS: 'https://mosolo.example/, https://agents.mosolo.example' })).toEqual(['https://mosolo.example', 'https://agents.mosolo.example']);
    expect(() => corsOrigins({ MOSOLO_CORS_ORIGINS: '*' })).toThrow(ConfigurationError);

    const demo = buildApp({ clock: clock(), secrets: SECRETS, plugins: [] });
    expect((await preflight(demo, 'https://nimporte.example')).headers['access-control-allow-origin']).toBe('https://nimporte.example');
    await demo.close();

    nonDemo();
    const closed = buildApp({ clock: clock(), secrets: SECRETS, plugins: [], connectorEnv: {} });
    expect((await preflight(closed, 'https://malveillant.example')).headers['access-control-allow-origin']).toBeUndefined();
    await closed.close();

    setEnv({ MOSOLO_CORS_ORIGINS: 'https://mosolo.example' });
    const listed = buildApp({ clock: clock(), secrets: SECRETS, plugins: [], connectorEnv: {} });
    expect((await preflight(listed, 'https://mosolo.example')).headers['access-control-allow-origin']).toBe('https://mosolo.example');
    expect((await preflight(listed, 'https://malveillant.example')).headers['access-control-allow-origin']).toBeUndefined();
    const meta = await listed.inject({ method: 'GET', url: '/v1/meta' });
    expect(meta.headers['x-content-type-options']).toBe('nosniff');
    expect(meta.headers['x-frame-options']).toBe('DENY');
    await listed.close();
  });
});

// =================================================================================================================
describe('Module « acces » : boîte d’envoi du bac à sable et second facteur', () => {
  it('hors démonstration : boîte d’envoi introuvable et plus rien n’y est journalisé', async () => {
    const app = buildApp({ clock: clock(), secrets: SECRETS, plugins: [accesPlugin] });
    await app.ready();
    const svc = app.ctx.ext.acces as AccesService;
    const inv = await app.inject({
      method: 'POST', url: '/v1/acces/invitations', headers: { 'x-demo-user': 'u-admin-entite', 'content-type': 'application/json' },
      payload: JSON.stringify({ motif: 'Affectation au service', fullName: 'Kasongo Ilunga', phone: '+243811000001', entity: 'DGIPK', accessLevel: 'OPERATEUR', roles: ['R11'] }),
    });
    expect(inv.statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: '/v1/acces/sandbox/outbox?to=%2B243811000001' })).statusCode).toBe(200);

    nonDemo();
    const out = await app.inject({ method: 'GET', url: '/v1/acces/sandbox/outbox?to=%2B243811000001' });
    expect(out.statusCode).toBe(404);
    expect(JSON.stringify(out.json())).not.toMatch(/jeton=|Code d’invitation/);
    expect((await app.inject({ method: 'GET', url: '/v1/acces/sandbox/outbox?to=app%3Au-superadmin' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/acces/levels' })).json().sandbox).toBe(false);
    const before = svc.outbox.count();
    svc.createInvitation(app.ctx.users.get('u-admin-entite')!, {
      fullName: 'Mbuyi Tshala', phone: '+243811000077', entity: 'DGIPK', accessLevel: 'OPERATEUR', roles: ['R11'], motif: 'Affectation au service',
    });
    expect(svc.outbox.count()).toBe(before);
    await app.close();
  });

  it('une session ouverte par mot de passe + TOTP (acr MFA) satisfait l’exigence de second facteur', async () => {
    const app = buildApp({ clock: clock(), secrets: SECRETS, plugins: [accesPlugin] });
    await app.ready();
    const svc = app.ctx.ext.acces as AccesService;
    const admin = app.ctx.users.get('u-superadmin')!;
    expect(() => svc.requireMfa(admin, true)).toThrow(/Second facteur/);
    const now = app.ctx.clock.now().toISOString();
    const withSession: User = { ...admin, auth: { method: 'bearer', sessionId: 'SES-x', acr: ACR.MFA, amr: ['pwd', 'otp', 'mfa'], authTime: now, expiresAt: now } };
    expect(() => svc.requireMfa(withSession, true)).not.toThrow();
    const smsOnly: User = { ...admin, auth: { ...withSession.auth!, acr: ACR.OTP } };
    expect(() => svc.requireMfa(smsOnly, true)).toThrow(/Second facteur/);
    await app.close();
  });
});

// =================================================================================================================
describe('Socle : connexion par téléphone, export minimisé, chaîne d’audit', () => {
  async function socle() {
    const c = clock();
    const app = buildApp({ clock: c, secrets: SECRETS, plugins: [createSoclePlugin({ rateLimit: { ...DEFAULT_RATE_LIMITS, enabled: false }, persistence: null })] });
    await app.ready();
    const post = (url: string, body: unknown, user?: string) => app.inject({
      method: 'POST', url, payload: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(user ? { 'x-demo-user': user } : {}) },
    });
    return { app, clock: c, post, svc: app.ctx.ext.socle as SocleService };
  }

  it('codes SMS limités par numéro (connu ou inconnu, réponse identique) ; un nouveau code remplace le précédent', async () => {
    const { app, post } = await socle();
    const first = (await post('/v1/auth/login', { method: 'phone', phone: '+243810000001' })).json();
    const second = (await post('/v1/auth/login', { method: 'phone', phone: '+243810000001' })).json();
    const stale = await post('/v1/auth/otp', { challengeId: first.challengeId, code: first.demoCode });
    expect(stale.statusCode).toBe(401);
    expect(stale.json()).toMatchObject({ code: 'CHALLENGE_INVALID' });
    expect((await post('/v1/auth/otp', { challengeId: second.challengeId, code: second.demoCode })).statusCode).toBe(200);
    for (const phone of ['+243810000001', '+243899999999']) {
      const codes: number[] = [];
      for (let i = 0; i < MAX_PHONE_CHALLENGES + 1; i++) codes.push((await post('/v1/auth/login', { method: 'phone', phone })).statusCode);
      expect(codes.at(-1)).toBe(429);
      expect(codes.filter((s) => s === 200).length).toBe(phone === '+243810000001' ? MAX_PHONE_CHALLENGES - 2 : MAX_PHONE_CHALLENGES);
    }
    await app.close();
  });

  it('identifiant inconnu : même refus que mauvais mot de passe (le calcul scrypt est toujours fait)', async () => {
    const { app, post } = await socle();
    const unknown = await post('/v1/auth/login', { method: 'password', login: 'personne-inconnue', password: 'mot-de-passe-quelconque' });
    const wrong = await post('/v1/auth/login', { method: 'password', login: 'u-tresor', password: 'mot-de-passe-quelconque' });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().code).toBe(wrong.json().code);
    await app.close();
  });

  it('export signé : aucun secret d’authentification (mot de passe, TOTP, clés de terminal)', async () => {
    const { app, post, svc } = await socle();
    expect(svc.idp.credentials.count()).toBeGreaterThan(0);
    const ex = await post('/v1/socle/exports', { reason: 'Exercice de réversibilité' }, 'u-superadmin');
    expect(ex.statusCode).toBe(200);
    const doc = ex.json() as { rows: { repo: string; doc: Record<string, unknown> }[]; redacted: string[] };
    const creds = doc.rows.filter((r) => r.repo === 'ext.socle.idp.credentials');
    expect(creds.length).toBeGreaterThan(0);
    for (const r of creds) {
      expect(r.doc).not.toHaveProperty('passwordHash');
      expect(r.doc).not.toHaveProperty('totpSecret');
    }
    for (const r of doc.rows.filter((x) => x.repo === 'field.devices')) expect(r.doc).not.toHaveProperty('key');
    expect(doc.redacted).toEqual(expect.arrayContaining(['ext.socle.idp.credentials.passwordHash', 'ext.socle.idp.credentials.totpSecret', 'field.devices.key']));
    expect(JSON.stringify(doc)).not.toContain('demo-device-key-001');
    await app.close();
  });

  it('chaîne d’audit restaurée non vérifiée : démarrage refusé hors démonstration, sauf acceptation tracée dans la chaîne', async () => {
    const store = new MemorySnapshotStore();
    const rt1 = await PersistenceRuntime.open(store);
    const app1 = buildApp({ clock: clock(), secrets: SECRETS, plugins: [createSoclePlugin({ persistence: rt1, rateLimit: { ...DEFAULT_RATE_LIMITS, enabled: false } })] });
    await app1.ready();
    await app1.close();
    await rt1.flush();

    nonDemo();
    const other = { ...SECRETS, auditHmacKey: 'autre-cle-d-audit' };
    const rt2 = await PersistenceRuntime.open(store);
    expect(() => buildApp({ clock: clock(), secrets: other, connectorEnv: {}, plugins: [createSoclePlugin({ persistence: rt2, rateLimit: { ...DEFAULT_RATE_LIMITS, enabled: false } })] }))
      .toThrow(/NON VÉRIFIÉE.*démarrage refusé/);

    setEnv({ MOSOLO_AUDIT_ACCEPT_UNVERIFIED: 'true' });
    const rt3 = await PersistenceRuntime.open(store);
    const app3 = buildApp({ clock: clock(), secrets: other, connectorEnv: {}, plugins: [createSoclePlugin({ persistence: rt3, rateLimit: { ...DEFAULT_RATE_LIMITS, enabled: false } })] });
    await app3.ready();
    expect(app3.ctx.audit.list({ action: 'audit.chain.restored_unverified' }).total).toBe(1);
    expect(app3.ctx.audit.verify().ok).toBe(false);
    await app3.close();
  });

  it('restauration d’une sauvegarde refusée sans clé d’audit (chaîne non contrôlée)', async () => {
    const app = buildApp({ clock: clock(), secrets: SECRETS, plugins: [] });
    await app.ready();
    const doc = createBackup(collectRows(app.ctx), 'cle-de-sauvegarde-de-test-0123456789', { source: 'application' });
    await expect(restoreStore(new MemorySnapshotStore(), doc, 'cle-de-sauvegarde-de-test-0123456789')).rejects.toThrow(/MOSOLO_AUDIT_HMAC_KEY/);
    await expect(restoreStore(new MemorySnapshotStore(), doc, 'cle-de-sauvegarde-de-test-0123456789', 'test-audit-key')).resolves.toMatchObject({ ok: true });
    await app.close();
  });

  it('pages légères (/l) : palier de limitation public', () => {
    expect(tierOf('/l')).toBe('public');
    expect(tierOf('/l/v?c=ABC')).toBe('public');
    expect(tierOf('/l/signaler')).toBe('public');
    expect(tierOf('/login')).toBe('global');
  });
});

// =================================================================================================================
describe('Preuves publiques et signalements', () => {
  async function full() {
    const app = buildApp({ clock: clock(), secrets: SECRETS, connectorEnv: {} });
    await app.ready();
    return app;
  }

  it('limiteur anti-énumération : X-Forwarded-For du client ignoré (clé = adresse réelle)', async () => {
    const app = await full();
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await app.inject({ method: 'GET', url: `/v1/public/preuves/ZZZZZZ${i}9`, headers: { 'x-forwarded-for': `10.0.0.${i}` } });
      statuses.push(r.statusCode);
    }
    expect(statuses).toContain(429);
    await app.close();
  });

  it('pages légères : politique de sécurité du contenu ; impression sans Host du client hors démonstration', async () => {
    const app = await full();
    const home = await app.inject({ method: 'GET', url: '/l' });
    expect(home.headers['content-security-policy']).toContain("default-src 'none'");
    nonDemo();
    const noUrl = await app.inject({ method: 'GET', url: '/l/imprimer?c=INCONNU1', headers: { host: 'hameconnage.example' } });
    expect(noUrl.statusCode).toBe(503);
    setEnv({ MOSOLO_PUBLIC_URL: 'https://mosolo.example/' });
    const ok = await app.inject({ method: 'GET', url: '/l/imprimer?c=INCONNU1', headers: { host: 'hameconnage.example' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('https://mosolo.example/l/v?c=');
    expect(ok.body).not.toContain('hameconnage.example');
    await app.close();
  });

  it('signalements par SMS / SVI : signature de la passerelle exigée hors démonstration', async () => {
    const app = await full();
    const sms = { from: '+243830000000', text: 'SIGNAL ESPECES agent au marché central' };
    expect((await app.inject({ method: 'POST', url: '/v1/public/integrite/reports/sms', payload: sms })).statusCode).toBe(201);
    nonDemo();
    expect((await app.inject({ method: 'POST', url: '/v1/public/integrite/reports/sms', payload: sms })).statusCode).toBe(403);
    const svi = { callerNumber: '+243840000000', digits: ['3', '2'], transcript: 'Quittance papier suspecte remise au marché central.' };
    expect((await app.inject({ method: 'POST', url: '/v1/public/integrite/reports/svi', payload: svi })).statusCode).toBe(403);
    setEnv({ SMS_GATEWAY_SECRET: 'secret-passerelle-sms' });
    const raw = JSON.stringify(sms);
    const bad = await app.inject({ method: 'POST', url: '/v1/public/integrite/reports/sms', payload: raw, headers: { 'content-type': 'application/json', 'x-mosolo-signature': '00'.repeat(32) } });
    expect(bad.statusCode).toBe(403);
    const sig = createHmac('sha256', 'secret-passerelle-sms').update(raw).digest('hex');
    const good = await app.inject({ method: 'POST', url: '/v1/public/integrite/reports/sms', payload: raw, headers: { 'content-type': 'application/json', 'x-mosolo-signature': sig } });
    expect(good.statusCode).toBe(201);
    await app.close();
  });
});
