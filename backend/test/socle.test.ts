import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { newDb } from 'pg-mem';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../src/core/repository.js';
import { createBackup, restoreStore, verifyBackup } from '../src/persistence/backup.js';
import { decodeDoc, encodeDoc } from '../src/persistence/codec.js';
import { AUDIT_REPO, collectRows, discover } from '../src/persistence/registry.js';
import { PersistenceRuntime } from '../src/persistence/runtime.js';
import { MemorySnapshotStore, PgSnapshotStore, type PgPoolLike } from '../src/persistence/store.js';
import { createSoclePlugin, type SocleService } from '../src/plugins/socle/plugin.js';
import { DEFAULT_RATE_LIMITS, SlidingWindowLimiter, type RateLimitConfig } from '../src/plugins/socle/rate-limit.js';
import { DEMO_PASSWORD, demoTotpSecret } from '../src/plugins/socle/service.js';
import { JwtSigner, base32Decode, base32Encode, hotp, totp } from '../src/plugins/socle/tokens.js';
import { DEMO } from '../src/seed.js';

const SECRETS = { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} };
const BACKUP_KEY = 'cle-de-sauvegarde-de-test-0123456789';

interface Env {
  app: FastifyInstance;
  clock: ManualClock;
  svc: SocleService;
  req: (method: string, url: string, opts?: { user?: string; token?: string; body?: unknown; headers?: Record<string, string> }) => Promise<LightMyRequestResponse>;
}

async function setupSocle(opts: { rateLimit?: RateLimitConfig; persistence?: PersistenceRuntime | null; clock?: ManualClock; demoCredentials?: boolean } = {}): Promise<Env> {
  const clock = opts.clock ?? new ManualClock('2026-09-26T09:00:00.000Z');
  const plugin = createSoclePlugin({
    rateLimit: opts.rateLimit ?? { ...DEFAULT_RATE_LIMITS, enabled: false },
    persistence: opts.persistence ?? null,
    ...(opts.demoCredentials !== undefined ? { idp: { demoCredentials: opts.demoCredentials } } : {}),
  });
  const app = buildApp({ clock, secrets: SECRETS, plugins: [plugin] });
  await app.ready();
  const req: Env['req'] = (method, url, o = {}) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: {
        ...(o.user ? { 'x-demo-user': o.user } : {}),
        ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
        ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...o.headers,
      },
      ...(o.body !== undefined ? { payload: JSON.stringify(o.body) } : {}),
    });
  return { app, clock, svc: app.ctx.ext.socle as SocleService, req };
}

async function phoneLogin(env: Env, phone = '+243810000001', extra: Record<string, unknown> = {}) {
  const r1 = await env.req('POST', '/v1/auth/login', { body: { method: 'phone', phone } });
  expect(r1.statusCode).toBe(200);
  const ch = r1.json() as { challengeId: string; demoCode: string };
  const r2 = await env.req('POST', '/v1/auth/otp', { body: { challengeId: ch.challengeId, code: ch.demoCode, ...extra } });
  expect(r2.statusCode).toBe(200);
  return r2.json() as { accessToken: string; session: { id: string; expiresAt: string }; acr: string; user: { id: string } };
}

async function agentLogin(env: Env, login: string, password = DEMO_PASSWORD) {
  const r1 = await env.req('POST', '/v1/auth/login', { body: { method: 'password', login, password } });
  expect(r1.statusCode).toBe(200);
  const { challengeId } = r1.json() as { challengeId: string };
  const code = totp(demoTotpSecret(login), env.clock.now());
  const r2 = await env.req('POST', '/v1/auth/otp', { body: { challengeId, code } });
  return { res: r2, code };
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  return fn().finally(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

function pgMemPool(): PgPoolLike {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  return new Pool() as unknown as PgPoolLike;
}

// =================================================================================================================
describe('Persistance — sérialiseur, dépôts observables, magasins', () => {
  it('encode / décode sans perte BigInt, dates, Map, Set, octets et objets portant « $t »', () => {
    const doc = {
      id: 'X-000001', amount: 123456789012345678901234567890n, at: new Date('2026-09-26T09:00:00.000Z'),
      map: new Map<string, unknown>([['a', 1n]]), set: new Set(['x', 'y']), bytes: new Uint8Array([1, 2, 255]),
      nested: { $t: 'piège', list: [1, undefined, { deep: -5n }] }, absent: undefined,
    };
    const encoded = encodeDoc(doc);
    const text = JSON.stringify(encoded);
    expect(text).not.toMatch(/e\+|1\.2345/); // aucun flottant introduit
    const back = decodeDoc(JSON.parse(text)) as typeof doc;
    expect(back.amount).toBe(123456789012345678901234567890n);
    expect(back.at).toBeInstanceOf(Date);
    expect(back.at.toISOString()).toBe('2026-09-26T09:00:00.000Z');
    expect(back.map.get('a')).toBe(1n);
    expect([...back.set]).toEqual(['x', 'y']);
    expect([...back.bytes]).toEqual([1, 2, 255]);
    expect(back.nested.$t).toBe('piège');
    expect(back.nested.list).toEqual([1, undefined, { deep: -5n }]);
    expect('absent' in back).toBe(false);
  });

  it('dépôts : abonnement aux écritures, restauration d’instantané, avance des générateurs (interface inchangée)', () => {
    const repo = new InMemoryRepository<{ id: string; v: number }>();
    const log: string[] = [];
    const off = repo.onWrite((it, op) => log.push(`${op}:${it.id}:${it.v}`));
    repo.insert({ id: 'a', v: 1 });
    repo.update({ id: 'a', v: 2 });
    off();
    repo.insert({ id: 'b', v: 3 });
    expect(log).toEqual(['insert:a:1', 'update:a:2']);
    repo.restoreSnapshot([{ id: 'z', v: 9 }]);
    expect(repo.all()).toEqual([{ id: 'z', v: 9 }]);

    const journal = new InMemoryAppendOnlyRepository<{ id: string }>();
    const appended: string[] = [];
    journal.onWrite((it, op) => appended.push(`${op}:${it.id}`));
    journal.append({ id: 'j1' });
    expect(appended).toEqual(['append:j1']);
    journal.restoreSnapshot([{ id: 'k1' }, { id: 'k2' }]);
    expect(journal.all().map((x) => x.id)).toEqual(['k1', 'k2']);
    expect(() => journal.append({ id: 'k2' })).toThrow();
    expect(() => journal.restoreSnapshot([{ id: 'd' }, { id: 'd' }])).toThrow();

    const ids = new IdGenerator();
    ids.advanceTo('OBL', 41);
    expect(ids.next('OBL')).toBe('OBL-000042');
    ids.advanceTo('OBL', 3); // jamais de recul
    expect(ids.next('OBL')).toBe('OBL-000043');
  });

  it('découvre les dépôts du socle et des modules par chemin stable', async () => {
    const env = await setupSocle();
    const d = discover(env.app.ctx);
    expect(d.repos.has('payments.orders')).toBe(true);
    expect(d.repos.has('assessment.obligations')).toBe(true);
    expect(d.repos.has('ledger.entries')).toBe(true);
    expect(d.repos.has('ext.socle.idp.sessions')).toBe(true);
    expect(d.idGenerators.length).toBeGreaterThan(5);
    const rows = collectRows(env.app.ctx);
    expect(rows.some((r) => r.repo === AUDIT_REPO && r.kind === 'append')).toBe(true);
    await env.app.close();
  });

  it('PostgreSQL (pg-mem) : migrations versionnées, redémarrage, restauration fidèle, audit vérifié, identifiants sans collision', async () => {
    const pool = pgMemPool();
    const store = new PgSnapshotStore(pool, { dialect: 'pg-mem' });
    const rt1 = await PersistenceRuntime.open(store);
    const env1 = await setupSocle({ persistence: rt1 });
    expect(rt1.status().report?.newlyPersisted).toBeGreaterThan(0);
    const obligationId = env1.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;
    const o1 = await env1.req('POST', `/v1/obligations/${obligationId}/payment-orders`, {
      user: 'u-contribuable', body: { channel: 'MOBILE_MONEY' }, headers: { 'idempotency-key': randomUUID() },
    });
    expect(o1.statusCode).toBe(201);
    const order1 = { id: (o1.json() as { paymentOrderId: string }).paymentOrderId };
    const reg1 = await env1.req('POST', '/v1/registrations', { body: { phone: '+243812345678', fullName: 'Inscrit Persistant', language: 'fr', situation: 'tenant' } });
    expect(reg1.statusCode).toBe(201);
    const tp1 = (reg1.json() as { taxpayerId: string }).taxpayerId;
    const auditLen1 = env1.app.ctx.audit.length;
    await env1.app.close();
    await rt1.flush();
    expect(rt1.status().lastError).toBeNull();

    // Les migrations ne sont appliquées qu'une fois.
    expect(await store.migrate()).toEqual([]);

    // Redémarrage : nouvelle application, même base.
    const rt2 = await PersistenceRuntime.open(new PgSnapshotStore(pool, { dialect: 'pg-mem' }));
    const env2 = await setupSocle({ persistence: rt2 });
    const report = rt2.status().report!;
    expect(report.restoredDocuments).toBeGreaterThan(0);
    expect(report.audit?.ok).toBe(true);
    expect(report.warnings).toEqual([]);
    const restored = env2.app.ctx.payments.orders.get(order1.id);
    expect(restored).toBeDefined();
    expect(env2.app.ctx.audit.length).toBe(auditLen1);
    expect(env2.app.ctx.audit.verify().ok).toBe(true);
    // Nouvelle écriture : identifiant nouveau (générateurs avancés), chaîne d'audit prolongée.
    const o2 = await env2.req('POST', `/v1/obligations/${obligationId}/payment-orders`, {
      user: 'u-contribuable', body: { channel: 'CARD' }, headers: { 'idempotency-key': randomUUID() },
    });
    // Règle métier restaurée : l'obligation a déjà une référence active (l'ordre persistant est bien pris en compte).
    expect(o2.statusCode).toBe(409);
    // Générateurs avancés : un nouvel inscrit ne réutilise pas l'identifiant restauré.
    const reg2 = await env2.req('POST', '/v1/registrations', { body: { phone: '+243812345679', fullName: 'Second Inscrit', language: 'fr', situation: 'tenant' } });
    expect(reg2.statusCode).toBe(201);
    expect((reg2.json() as { taxpayerId: string }).taxpayerId).not.toBe(tp1);
    // L'inscrit restauré se connecte par téléphone (compte d'accès R30 recréé à la volée).
    const t = await phoneLogin(env2, '+243812345678');
    expect(t.user.id).toBe(`u-tp-${tp1}`);
    expect((await env2.req('GET', `/v1/obligations?taxpayerId=${tp1}`, { token: t.accessToken })).statusCode).toBe(200);
    expect(env2.app.ctx.audit.verify().ok).toBe(true);
    await env2.app.close();
    await rt2.flush();

    // Le journal en ajout seul ne réécrit jamais un enregistrement déjà présent.
    const all = await store.loadAll();
    const first = all.find((r) => r.repo === AUDIT_REPO && r.seq === 1)!;
    await store.write([{ ...first, doc: { altere: true } }], new Date());
    const again = (await store.loadAll()).find((r) => r.repo === AUDIT_REPO && r.seq === 1)!;
    expect(again.doc).toEqual(first.doc);
  });

  it('une clé d’audit différente au redémarrage est signalée (chaîne non vérifiée), sans blocage silencieux', async () => {
    const store = new MemorySnapshotStore();
    const rt1 = await PersistenceRuntime.open(store);
    const env1 = await setupSocle({ persistence: rt1 });
    await env1.app.close();
    await rt1.flush();
    const rt2 = await PersistenceRuntime.open(store);
    const clock = new ManualClock('2026-09-26T09:00:00.000Z');
    const app = buildApp({ clock, secrets: { ...SECRETS, auditHmacKey: 'autre-cle' }, plugins: [createSoclePlugin({ persistence: rt2, rateLimit: { ...DEFAULT_RATE_LIMITS, enabled: false } })] });
    await app.ready();
    expect(rt2.status().report!.warnings.join(' ')).toMatch(/NON VÉRIFIÉE/);
    await app.close();
  });

  it('sauvegarde signée : vérification, refus si altérée ou mauvaise clé, restauration puis vérification de la chaîne d’audit', async () => {
    const env = await setupSocle();
    const rows = collectRows(env.app.ctx);
    const backup = createBackup(rows, BACKUP_KEY, { source: 'test', now: env.clock.now() });
    expect(backup.manifest.rows).toBe(rows.length);
    expect(verifyBackup(backup, BACKUP_KEY, 'test-audit-key')).toMatchObject({ ok: true, audit: { ok: true } });
    expect(verifyBackup(backup, 'une-autre-cle-de-sauvegarde-000').ok).toBe(false);
    const tampered = structuredClone(backup);
    (tampered.rows[0]!.doc as Record<string, unknown>).falsifie = 'oui';
    const v = verifyBackup(tampered, BACKUP_KEY);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/altérée/);
    await expect(restoreStore(new MemorySnapshotStore(), tampered, BACKUP_KEY)).rejects.toThrow(/Restauration refusée/);
    expect(() => createBackup(rows, 'courte', { source: 'x' })).toThrow();

    const target = new MemorySnapshotStore();
    await restoreStore(target, backup, BACKUP_KEY, 'test-audit-key');
    expect((await target.loadAll()).length).toBe(rows.length);
    // Démarrage sur la base restaurée : l'état et la chaîne sont intacts.
    const rt = await PersistenceRuntime.open(target);
    const env2 = await setupSocle({ persistence: rt });
    expect(rt.status().report!.audit!.ok).toBe(true);
    expect(env2.app.ctx.payments.orders.count()).toBe(env.app.ctx.payments.orders.count());
    await env.app.close();
    await env2.app.close();
  });

  it('écriture en échec : rien n’est perdu, le lot est rejoué', async () => {
    const store = new MemorySnapshotStore();
    let fail = true;
    const original = store.write.bind(store);
    store.write = async (rows, at) => {
      if (fail) throw new Error('base indisponible');
      return original(rows, at);
    };
    const rt = await PersistenceRuntime.open(store);
    const env = await setupSocle({ persistence: rt });
    await expect(rt.flush()).rejects.toThrow('base indisponible');
    expect(rt.status().pendingWrites).toBeGreaterThan(0);
    expect(rt.status().lastError).toBe('base indisponible');
    fail = false;
    await rt.flush();
    expect(rt.status().pendingWrites).toBe(0);
    expect((await store.loadAll()).length).toBeGreaterThan(0);
    await env.app.close();
  });
});

// =================================================================================================================
describe('Authentification — fournisseur local compatible OIDC', () => {
  afterEach(() => {
    process.env.MOSOLO_DEMO_MODE = 'true';
  });

  it('primitives : Base32, HOTP (vecteurs RFC 4226), JWT EdDSA', () => {
    const secret = Buffer.from('12345678901234567890');
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
    expect(hotp(secret, 0)).toBe('755224');
    expect(hotp(secret, 1)).toBe('287082');
    expect(hotp(secret, 9)).toBe('520489');
    const s = new JwtSigner();
    const tok = s.sign({ iss: 'i', aud: 'a', sub: 's', sid: 'x', jti: 'j', iat: 1, exp: 2, auth_time: 1, acr: 'a', amr: [] });
    expect(s.verify(tok)?.sub).toBe('s');
    expect(new JwtSigner().verify(tok)).toBeNull();
    const [h, p] = tok.split('.');
    expect(s.verify(`${h}.${p}.`)).toBeNull();
    const none = Buffer.from(JSON.stringify({ alg: 'none', kid: s.kid })).toString('base64url');
    expect(s.verify(`${none}.${p}.`)).toBeNull();
  });

  it('découverte OIDC et JWKS', async () => {
    const env = await setupSocle();
    const d = await env.req('GET', '/.well-known/openid-configuration');
    expect(d.statusCode).toBe(200);
    expect(d.json()).toMatchObject({ issuer: 'urn:mosolo:idp:local', jwks_uri: '/.well-known/jwks.json', id_token_signing_alg_values_supported: ['EdDSA'] });
    const j = await env.req('GET', '/.well-known/jwks.json');
    expect((j.json() as { keys: { kty: string; crv: string; kid: string }[] }).keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', kid: env.svc.idp.signer.kid });
    await env.app.close();
  });

  it('contribuable : téléphone + OTP → jeton Bearer accepté, accès à son propre dossier, déconnexion = révocation', async () => {
    const env = await setupSocle();
    const t = await phoneLogin(env);
    expect(t.acr).toBe('urn:mosolo:acr:otp');
    expect(t.user.id).toBe('u-contribuable');
    // Le code a été envoyé par l'événement du catalogue (bac à sable).
    expect(env.app.ctx.comms.deliveries.find((d) => d.eventCode === 'auth.otp_code' && d.recipientId === DEMO.taxpayerId).length).toBeGreaterThan(0);

    const me = await env.req('GET', '/v1/auth/me', { token: t.accessToken });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ sub: 'u-contribuable', mode: 'session', auth: { method: 'bearer', acr: 'urn:mosolo:acr:otp' } });
    const own = await env.req('GET', `/v1/obligations?taxpayerId=${DEMO.taxpayerId}`, { token: t.accessToken });
    expect(own.statusCode).toBe(200);
    const other = await env.req('GET', `/v1/obligations?taxpayerId=${DEMO.tenantTaxpayerId}`, { token: t.accessToken });
    expect(other.statusCode).toBe(403);

    const out = await env.req('POST', '/v1/auth/logout', { token: t.accessToken });
    expect(out.statusCode).toBe(200);
    const after = await env.req('GET', '/v1/auth/me', { token: t.accessToken });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toMatchObject({ code: 'SESSION_REVOKED' });
    expect(env.app.ctx.audit.list({ action: 'auth.login.success' }).total).toBe(1);
    expect(env.app.ctx.audit.list({ action: 'auth.session.revoked' }).total).toBe(1);
    await env.app.close();
  });

  it('OTP : code faux, épuisement après 5 essais, expiration, défi à usage unique ; numéro inconnu indiscernable', async () => {
    const env = await setupSocle();
    const r = await env.req('POST', '/v1/auth/login', { body: { method: 'phone', phone: '+243810000001' } });
    const ch = r.json() as { challengeId: string; demoCode: string; destination: string };
    expect(ch.destination).not.toContain('810000');
    const wrong = ch.demoCode === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) {
      const bad = await env.req('POST', '/v1/auth/otp', { body: { challengeId: ch.challengeId, code: wrong } });
      expect(bad.json()).toMatchObject({ code: 'INVALID_CODE' });
    }
    const fifth = await env.req('POST', '/v1/auth/otp', { body: { challengeId: ch.challengeId, code: wrong } });
    expect(fifth.json()).toMatchObject({ code: 'CHALLENGE_EXHAUSTED' });
    const late = await env.req('POST', '/v1/auth/otp', { body: { challengeId: ch.challengeId, code: ch.demoCode } });
    expect(late.statusCode).toBe(401);

    const r2 = (await env.req('POST', '/v1/auth/login', { body: { method: 'phone', phone: '+243810000001' } })).json() as { challengeId: string; demoCode: string };
    env.clock.advance(6 * 60_000);
    const expired = await env.req('POST', '/v1/auth/otp', { body: { challengeId: r2.challengeId, code: r2.demoCode } });
    expect(expired.json()).toMatchObject({ code: 'CHALLENGE_EXPIRED' });

    const r3 = (await env.req('POST', '/v1/auth/login', { body: { method: 'phone', phone: '+243810000001' } })).json() as { challengeId: string; demoCode: string };
    expect((await env.req('POST', '/v1/auth/otp', { body: { challengeId: r3.challengeId, code: r3.demoCode } })).statusCode).toBe(200);
    expect((await env.req('POST', '/v1/auth/otp', { body: { challengeId: r3.challengeId, code: r3.demoCode } })).json()).toMatchObject({ code: 'CHALLENGE_INVALID' });

    const unknown = await env.req('POST', '/v1/auth/login', { body: { method: 'phone', phone: '+243899999999' } });
    expect(unknown.statusCode).toBe(200);
    const u = unknown.json() as { challengeId: string; demoCode: string };
    expect(Object.keys(u).sort()).toEqual(Object.keys(ch).sort());
    expect((await env.req('POST', '/v1/auth/otp', { body: { challengeId: u.challengeId, code: u.demoCode } })).statusCode).toBe(401);
    expect((await env.req('POST', '/v1/auth/login', { body: { method: 'phone', phone: 'abc' } })).statusCode).toBe(400);
    await env.app.close();
  });

  it('agent : mot de passe + TOTP → niveau MFA ; rejeu du même code TOTP refusé ; exigence passkey signalée [À RACCORDER]', async () => {
    const env = await setupSocle();
    const { res, code } = await agentLogin(env, 'u-tresor');
    expect(res.statusCode).toBe(200);
    const tok = res.json() as { accessToken: string; acr: string; passkeyRequired: boolean };
    expect(tok.acr).toBe('urn:mosolo:acr:mfa');
    expect(tok.passkeyRequired).toBe(true);
    const claims = env.svc.idp.signer.verify(tok.accessToken)!;
    expect(claims).toMatchObject({ sub: 'u-tresor', roles: ['R17'], entity: 'TRESOR', amr: ['pwd', 'otp', 'mfa'], passkey_required: true });
    expect(claims.exp - claims.iat).toBe(900);
    // Rejeu du même pas TOTP sur un nouveau défi.
    const r1 = await env.req('POST', '/v1/auth/login', { body: { method: 'password', login: 'u-tresor', password: DEMO_PASSWORD } });
    const replay = await env.req('POST', '/v1/auth/otp', { body: { challengeId: (r1.json() as { challengeId: string }).challengeId, code } });
    expect(replay.statusCode).toBe(401);
    // Le jeton agent ouvre les routes de son rôle.
    expect((await env.req('GET', '/v1/ledger/entries', { token: tok.accessToken })).statusCode).not.toBe(401);
    const pk = await env.req('POST', '/v1/auth/passkeys/registration', { token: tok.accessToken, body: {} });
    expect(pk.statusCode).toBe(501);
    expect(pk.json()).toMatchObject({ code: 'PASSKEY_NOT_WIRED' });
    expect(((await env.req('GET', '/v1/auth/passkeys', { token: tok.accessToken })).json() as { status: string }).status).toBe('A_RACCORDER');
    await env.app.close();
  });

  it('mot de passe faux : message indistinct ; verrouillage temporaire après 5 échecs, journalisé et notifié', async () => {
    const env = await setupSocle();
    const unknown = await env.req('POST', '/v1/auth/login', { body: { method: 'password', login: 'personne', password: 'x' } });
    const bad = await env.req('POST', '/v1/auth/login', { body: { method: 'password', login: 'u-guichet', password: 'x' } });
    expect(unknown.statusCode).toBe(401);
    expect((unknown.json() as { detail: string }).detail).toBe((bad.json() as { detail: string }).detail);
    for (let i = 0; i < 4; i++) await env.req('POST', '/v1/auth/login', { body: { method: 'password', login: 'u-guichet', password: 'x' } });
    const locked = await env.req('POST', '/v1/auth/login', { body: { method: 'password', login: 'u-guichet', password: DEMO_PASSWORD } });
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toMatchObject({ code: 'LOGIN_TEMPORARILY_LOCKED' });
    expect(env.app.ctx.audit.list({ action: 'auth.login.locked' }).total).toBe(1);
    expect(env.app.ctx.comms.deliveries.find((d) => d.eventCode === 'auth.login.suspicious').length).toBeGreaterThan(0);
    env.clock.advance(16 * 60_000);
    const { res } = await agentLogin(env, 'u-guichet');
    expect(res.statusCode).toBe(200);
    await env.app.close();
  });

  it('jeton : expiration (horloge serveur), falsification, renouvellement ; appareil partagé non prolongé', async () => {
    const env = await setupSocle();
    const t = await phoneLogin(env);
    const [h, p, s] = t.accessToken.split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), roles: ['R26'] })).toString('base64url');
    expect((await env.req('GET', '/v1/auth/me', { token: `${h}.${forged}.${s}` })).json()).toMatchObject({ code: 'TOKEN_INVALID' });
    expect((await env.req('GET', '/v1/auth/me', { headers: { authorization: 'Basic abc' } })).json()).toMatchObject({ code: 'INVALID_AUTHORIZATION' });

    env.clock.advance(10 * 60_000);
    const refreshed = await env.req('POST', '/v1/auth/refresh', { token: t.accessToken });
    expect(refreshed.statusCode).toBe(200);
    const t2 = refreshed.json() as { accessToken: string };
    env.clock.advance(6 * 60_000);
    expect((await env.req('GET', '/v1/auth/me', { token: t.accessToken })).json()).toMatchObject({ code: 'TOKEN_EXPIRED' });
    expect((await env.req('GET', '/v1/auth/me', { token: t2.accessToken })).statusCode).toBe(200);

    const shared = await phoneLogin(env, '+243820000002', { sharedDevice: true });
    expect(new Date(shared.session.expiresAt).getTime() - env.clock.now().getTime()).toBe(30 * 60_000);
    expect((await env.req('POST', '/v1/auth/refresh', { token: shared.accessToken })).json()).toMatchObject({ code: 'SHARED_DEVICE_NO_REFRESH' });
    await env.app.close();
  });

  it('révocation d’une session d’autrui : responsable sécurité (R28) avec motif ; tout autre rôle refusé', async () => {
    const env = await setupSocle();
    const victim = await phoneLogin(env);
    const deny = await env.req('POST', `/v1/auth/sessions/${victim.session.id}/revoke`, { user: 'u-guichet', body: { reason: 'Appareil perdu signalé' } });
    expect(deny.statusCode).toBe(403);
    const noReason = await env.req('POST', `/v1/auth/sessions/${victim.session.id}/revoke`, { user: 'u-rssi', body: { reason: '' } });
    expect(noReason.statusCode).toBe(400);
    const ok = await env.req('POST', `/v1/auth/sessions/${victim.session.id}/revoke`, { user: 'u-rssi', body: { reason: 'Appareil perdu signalé' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ revokedBy: 'u-rssi', active: false });
    expect((await env.req('GET', '/v1/auth/me', { token: victim.accessToken })).statusCode).toBe(401);
    const list = await env.req('GET', '/v1/auth/sessions', { user: 'u-contribuable' });
    expect((list.json() as { items: { ip?: string }[] }).items[0]!.ip).toBeUndefined();
    await env.app.close();
  });

  it('mode démonstration désactivé : x-demo-user refusé, aucun code affiché, comptes de démonstration indisponibles', async () => {
    const env = await setupSocle({ demoCredentials: true });
    await withEnv({ MOSOLO_DEMO_MODE: 'false' }, async () => {
      const r = await env.req('GET', '/v1/auth/me', { user: 'u-contribuable' });
      expect(r.statusCode).toBe(401);
      expect(r.json()).toMatchObject({ code: 'DEMO_AUTH_DISABLED' });
      const login = await env.req('POST', '/v1/auth/login', { body: { method: 'phone', phone: '+243810000001' } });
      expect(login.json()).not.toHaveProperty('demoCode');
      expect((await env.req('GET', '/v1/auth/demo-accounts')).statusCode).toBe(404);
      // Le jeton reste accepté.
      const { res } = await agentLogin(env, 'u-auditeur');
      const tok = (res.json() as { accessToken: string }).accessToken;
      expect((await env.req('GET', '/v1/auth/me', { token: tok })).statusCode).toBe(200);
      expect((await env.req('GET', '/v1/auth/me')).json()).toMatchObject({ code: 'AUTH_REQUIRED' });
    });
    // Mode démonstration (défaut) : en-tête accepté, comptes listés.
    expect((await env.req('GET', '/v1/auth/me', { user: 'u-contribuable' })).json()).toMatchObject({ mode: 'demonstration', auth: null });
    const demo = (await env.req('GET', '/v1/auth/demo-accounts')).json() as { agents: { login: string; currentCode: string }[]; taxpayers: unknown[] };
    expect(demo.agents.find((a) => a.login === 'u-tresor')!.currentCode).toBe(totp(demoTotpSecret('u-tresor'), env.clock.now()));
    expect(demo.taxpayers.length).toBeGreaterThan(0);
    await env.app.close();
  });

  it('hors démonstration, aucun identifiant de démonstration n’est semé par défaut', async () => {
    await withEnv({ MOSOLO_DEMO_MODE: 'false', MOSOLO_DEMO_CREDENTIALS: undefined }, async () => {
      const env = await setupSocle();
      expect(env.svc.idp.credentials.count()).toBe(0);
      const r = await env.req('POST', '/v1/auth/login', { body: { method: 'password', login: 'u-tresor', password: DEMO_PASSWORD } });
      expect(r.statusCode).toBe(401);
      await env.app.close();
    });
  });
});

// =================================================================================================================
describe('Limitation de débit et exploitation', () => {
  it('fenêtre glissante : décroissance progressive du compteur précédent', () => {
    const l = new SlidingWindowLimiter({ limit: 10, windowMs: 60_000 });
    for (let i = 0; i < 10; i++) expect(l.hit('k', 0).allowed).toBe(true);
    expect(l.hit('k', 1000).allowed).toBe(false);
    // À mi-fenêtre suivante, la moitié du compteur précédent pèse encore : 5 places.
    let allowed = 0;
    for (let i = 0; i < 10; i++) if (l.hit('k', 90_000).allowed) allowed++;
    expect(allowed).toBe(5);
    expect(l.hit('autre', 90_000).allowed).toBe(true);
  });

  it('429 RFC 9457 avec Retry-After, journalisé une fois par fenêtre ; palier d’authentification par IP ; sonde exemptée', async () => {
    const env = await setupSocle({
      rateLimit: { enabled: true, global: { limit: 5, windowMs: 60_000 }, public: { limit: 3, windowMs: 60_000 }, auth: { limit: 2, windowMs: 60_000 }, exempt: ['/health'] },
    });
    for (let i = 0; i < 5; i++) {
      const ok = await env.req('GET', '/v1/auth/me', { user: 'u-guichet' });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['ratelimit-limit']).toBe('5');
    }
    const limited = await env.req('GET', '/v1/auth/me', { user: 'u-guichet' });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['content-type']).toContain('application/problem+json');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.json()).toMatchObject({ status: 429, code: 'RATE_LIMITED', title: 'Trop de requêtes' });
    await env.req('GET', '/v1/auth/me', { user: 'u-guichet' });
    expect(env.app.ctx.audit.list({ action: 'security.rate_limited' }).total).toBe(1);
    // Un autre utilisateur n'est pas affecté ; la sonde de vie non plus.
    expect((await env.req('GET', '/v1/auth/me', { user: 'u-controleur' })).statusCode).toBe(200);
    for (let i = 0; i < 8; i++) expect((await env.req('GET', '/health')).statusCode).toBe(200);
    // Connexion : 2 tentatives par minute et par IP.
    const body = { method: 'password', login: 'u-tresor', password: 'faux' };
    expect((await env.req('POST', '/v1/auth/login', { body })).statusCode).toBe(401);
    expect((await env.req('POST', '/v1/auth/login', { body })).statusCode).toBe(401);
    expect((await env.req('POST', '/v1/auth/login', { body })).statusCode).toBe(429);
    // Après deux fenêtres, tout est rétabli (aucun blocage durable).
    env.clock.advance(120_000);
    expect((await env.req('GET', '/v1/auth/me', { user: 'u-guichet' })).statusCode).toBe(200);
    await env.app.close();
  });

  it('état du socle et export signé : rôles d’exploitation seulement, motif obligatoire, export vérifiable', async () => {
    const env = await setupSocle();
    expect((await env.req('GET', '/v1/socle/status', { user: 'u-contribuable' })).statusCode).toBe(403);
    const st = await env.req('GET', '/v1/socle/status', { user: 'u-rssi' });
    expect(st.statusCode).toBe(200);
    expect(st.json()).toMatchObject({ demoMode: true, persistence: { store: 'memoire' } });
    expect((await env.req('POST', '/v1/socle/exports', { user: 'u-tresor', body: { reason: 'Exercice de restauration' } })).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/socle/exports', { user: 'u-superadmin', body: {} })).statusCode).toBe(400);
    const ex = await env.req('POST', '/v1/socle/exports', { user: 'u-superadmin', body: { reason: 'Exercice de restauration trimestriel' } });
    expect(ex.statusCode).toBe(200);
    const doc = ex.json() as Parameters<typeof verifyBackup>[0] & { demoKey: boolean };
    expect(doc.demoKey).toBe(true);
    const { demoKey: _d, ...backup } = doc;
    expect(verifyBackup(backup, 'demo-backup-key-NON-PRODUCTION', 'test-audit-key')).toMatchObject({ ok: true, audit: { ok: true } });
    expect(env.app.ctx.audit.list({ action: 'socle.export.created' }).total).toBe(1);
    await env.app.close();
  });
});
