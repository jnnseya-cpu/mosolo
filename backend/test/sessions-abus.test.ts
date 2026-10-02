/**
 * Deuxième passe adverse (27/09/2026), phase « abus de session et d'authentification » : force brute et rejeu des
 * codes à usage unique, prévisibilité, jeton après déconnexion, fixation de session, jeton altéré / expiré / « alg
 * none », énumération de comptes, cookies et CSRF, compte révoqué encore actif.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { DEMO_PASSWORD, demoTotpSecret } from '../src/plugins/socle/service.js';
import { randomDigits, totp } from '../src/plugins/socle/tokens.js';

async function full() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
  await app.ready();
  const post = (url: string, body: unknown, token?: string, extra: Record<string, string> = {}) => app.inject({
    method: 'POST', url, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, payload: JSON.stringify(body),
  });
  const get = (url: string, token?: string, extra: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra } });
  return { app, clock, post, get };
}
type Env = Awaited<ReturnType<typeof full>>;

async function phoneLogin(e: Env, phone = '+243810000001') {
  const c = (await e.post('/v1/auth/login', { method: 'phone', phone })).json();
  const r = await e.post('/v1/auth/otp', { challengeId: c.challengeId, code: c.demoCode });
  expect(r.statusCode, r.body).toBe(200);
  return { ...r.json(), challenge: c } as { accessToken: string; session: { id: string }; challenge: { challengeId: string; demoCode: string } };
}
async function agentLogin(e: Env, login: string) {
  const c = (await e.post('/v1/auth/login', { method: 'password', login, password: DEMO_PASSWORD })).json();
  const r = await e.post('/v1/auth/otp', { challengeId: c.challengeId, code: totp(demoTotpSecret(login), e.clock.now()) });
  expect(r.statusCode, r.body).toBe(200);
  return r.json() as { accessToken: string; session: { id: string } };
}

describe('Codes à usage unique', () => {
  it('force brute : 5 essais au plus par défi, le bon code est ensuite refusé ; rejeu d’un code utilisé refusé', async () => {
    const e = await full();
    const c = (await e.post('/v1/auth/login', { method: 'phone', phone: '+243810000001' })).json();
    const wrong = c.demoCode === '000000' ? '111111' : '000000';
    const codes: string[] = [];
    for (let i = 0; i < 5; i++) codes.push((await e.post('/v1/auth/otp', { challengeId: c.challengeId, code: wrong })).json().code);
    expect(codes).toEqual(['INVALID_CODE', 'INVALID_CODE', 'INVALID_CODE', 'INVALID_CODE', 'CHALLENGE_EXHAUSTED']);
    expect((await e.post('/v1/auth/otp', { challengeId: c.challengeId, code: c.demoCode })).statusCode).toBe(401);
    const ok = await phoneLogin(e);
    const replay = await e.post('/v1/auth/otp', { challengeId: ok.challenge.challengeId, code: ok.challenge.demoCode });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe('CHALLENGE_INVALID');
  });

  it('demandes de code bornées par numéro (connu ou non : même réponse) ; codes issus d’un générateur cryptographique', async () => {
    const e = await full();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await e.post('/v1/auth/login', { method: 'phone', phone: '+243899999999' })).statusCode);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
    // Générateur : crypto.randomInt (jamais Math.random) ; répartition des chiffres sans biais grossier.
    expect(readFileSync(new URL('../src/plugins/socle/tokens.ts', import.meta.url), 'utf8')).toMatch(/randomInt\(0, 10\)/);
    const counts = Array(10).fill(0) as number[];
    for (let i = 0; i < 3000; i++) for (const d of randomDigits(6)) counts[Number(d)]!++;
    for (const n of counts) expect(Math.abs(n - 1800)).toBeLessThan(250);
  });

  it('énumération : numéro connu ou inconnu → même statut, mêmes champs ; récupération de compte identique', async () => {
    const e = await full();
    const known = await e.post('/v1/auth/login', { method: 'phone', phone: '+243810000001' });
    const unknown = await e.post('/v1/auth/login', { method: 'phone', phone: '+243810009999' });
    expect(known.statusCode).toBe(unknown.statusCode);
    expect(Object.keys(known.json()).sort()).toEqual(Object.keys(unknown.json()).sort());
    const pw1 = await e.post('/v1/auth/login', { method: 'password', login: 'u-tresor', password: 'mauvais-mot-de-passe' });
    const pw2 = await e.post('/v1/auth/login', { method: 'password', login: 'compte-inexistant', password: 'mauvais-mot-de-passe' });
    expect([pw1.statusCode, pw1.json().code]).toEqual([pw2.statusCode, pw2.json().code]);
    const r1 = await e.post('/v1/public/enrolement/recuperations', { iuc: 'IUC-INEXISTANT-1', newPhone: '+243811111111', idDocumentRef: 'CNI-TEST-1' });
    expect(r1.statusCode).toBeLessThan(300);
    expect(Object.keys(r1.json()).sort()).toEqual(['notice', 'reference']);
  });
});

describe('Jetons et sessions', () => {
  it('déconnexion : le jeton n’est plus accepté, ni pour lire ni pour renouveler', async () => {
    const e = await full();
    const s = await phoneLogin(e);
    expect((await e.get('/v1/auth/me', s.accessToken)).statusCode).toBe(200);
    expect((await e.post('/v1/auth/logout', {}, s.accessToken)).statusCode).toBe(200);
    const after = await e.get('/v1/auth/me', s.accessToken);
    expect(after.statusCode).toBe(401);
    expect(after.json().code).toBe('SESSION_REVOKED');
    expect((await e.post('/v1/auth/refresh', {}, s.accessToken)).statusCode).toBe(401);
  });

  it('jeton altéré, « alg none », expiré : refusés ; fixation impossible (session créée par le serveur à chaque connexion)', async () => {
    const e = await full();
    const s = await phoneLogin(e);
    const [h, p, sig] = s.accessToken.split('.');
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, roles: ['R01'], sub: 'u-gouverneur' })).toString('base64url');
    expect((await e.get('/v1/auth/me', `${h}.${forged}.${sig}`)).statusCode).toBe(401);
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    expect((await e.get('/v1/auth/me', `${none}.${forged}.`)).statusCode).toBe(401);
    expect((await e.get('/v1/auth/me', 'nimporte.quoi.ici')).statusCode).toBe(401);
    e.clock.set(new Date(e.clock.now().getTime() + 16 * 60_000).toISOString());
    const exp = await e.get('/v1/auth/me', s.accessToken);
    expect(exp.statusCode).toBe(401);
    expect(exp.json().code).toBe('TOKEN_EXPIRED');
    const s2 = await phoneLogin(e);
    expect(s2.session.id).not.toBe(s.session.id);
  });

  it('aucun cookie émis ; un cookie seul ne vaut pas authentification (CSRF sans objet)', async () => {
    const e = await full();
    const c = await e.post('/v1/auth/login', { method: 'phone', phone: '+243810000001' });
    const o = await e.post('/v1/auth/otp', { challengeId: c.json().challengeId, code: c.json().demoCode });
    expect(c.headers['set-cookie']).toBeUndefined();
    expect(o.headers['set-cookie']).toBeUndefined();
    const token = o.json().accessToken as string;
    const viaCookie = await e.post('/v1/auth/logout', {}, undefined, { cookie: `access_token=${token}; mosolo=${token}`, origin: 'https://site-malveillant.example' });
    expect(viaCookie.statusCode).toBe(401);
    expect((await e.get('/v1/auth/me', token)).statusCode).toBe(200);
  });

  it('compte de travail révoqué : ses sessions ouvertes sont immédiatement refusées (lecture, renouvellement, action)', async () => {
    const e = await full();
    const agent = await agentLogin(e, 'u-agent-terrain');
    expect((await e.get('/v1/auth/me', agent.accessToken)).statusCode).toBe(200);
    const rssi = await agentLogin(e, 'u-rssi');
    const rev = await e.post('/v1/acces/accounts/u-agent-terrain/revoke', { motif: 'Départ de l’agent (test de révocation)' }, rssi.accessToken);
    expect(rev.statusCode, rev.body).toBe(200);
    const me = await e.get('/v1/auth/me', agent.accessToken);
    expect(me.statusCode).toBe(401);
    expect(me.json().code).toBe('ACCOUNT_REVOKED');
    expect((await e.post('/v1/auth/refresh', {}, agent.accessToken)).statusCode).toBe(401);
    expect((await e.post('/v1/auth/passkeys/registration', {}, agent.accessToken)).statusCode).toBe(401);
    // Nouvelle connexion refusée elle aussi.
    const again = await e.post('/v1/auth/login', { method: 'password', login: 'u-agent-terrain', password: DEMO_PASSWORD });
    expect(again.statusCode).toBeGreaterThanOrEqual(400);
  });
});
