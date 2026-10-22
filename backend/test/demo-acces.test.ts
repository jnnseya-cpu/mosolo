/**
 * Troisième passe GO / NO-GO (28/09/2026), défaut D3-06 : une démonstration hébergée publiquement (Cloud Run
 * `allUsers`) accepte l'en-tête `x-demo-user` de n'importe quel visiteur. Garde AJOUTÉ : mot de passe d'accès commun
 * (MOSOLO_DEMO_ACCESS_PASSWORD, authentification HTTP Basic, puis témoin HttpOnly). Sans la variable : inchangé.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DEMO_ACCESS_COOKIE, demoAccessPassword } from '../src/core/demo-gate.js';

const PASSWORD = 'essai-demo-acces-0001';
const basic = (p: string) => `Basic ${Buffer.from(`gouvernorat:${p}`).toString('base64')}`;

afterEach(() => {
  delete process.env.MOSOLO_DEMO_ACCESS_PASSWORD;
  process.env.MOSOLO_DEMO_MODE = 'true';
});

async function app() {
  const a = buildApp({ plugins: [], secrets: { auditHmacKey: 'test-audit-key', providerSecrets: {}, commsProviderKeys: {} } });
  await a.ready();
  return a;
}

describe('Démonstration hébergée : mot de passe d’accès (D3-06)', () => {
  it('sans MOSOLO_DEMO_ACCESS_PASSWORD : comportement inchangé (x-demo-user admis sans autre formalité)', async () => {
    const a = await app();
    const r = await a.inject({ method: 'GET', url: '/v1/obligations', headers: { 'x-demo-user': 'u-contribuable' } });
    expect(r.statusCode).toBe(200);
    await a.close();
  });

  it('avec le mot de passe : 401 + WWW-Authenticate sans lui (même avec x-demo-user) ; /health exempté ; accès puis témoin HttpOnly', async () => {
    process.env.MOSOLO_DEMO_ACCESS_PASSWORD = PASSWORD;
    const a = await app();
    const denied = await a.inject({ method: 'GET', url: '/v1/obligations', headers: { 'x-demo-user': 'u-gouverneur' } });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['www-authenticate']).toMatch(/^Basic realm=/);
    expect(denied.body).not.toContain(PASSWORD);
    expect((await a.inject({ method: 'GET', url: '/v1/obligations', headers: { 'x-demo-user': 'u-gouverneur', authorization: basic('mauvais-mot-de-passe') } })).statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const ok = await a.inject({ method: 'GET', url: '/v1/obligations', headers: { 'x-demo-user': 'u-contribuable', authorization: basic(PASSWORD) } });
    expect(ok.statusCode).toBe(200);
    const cookie = String(ok.headers['set-cookie']);
    expect(cookie).toMatch(new RegExp(`^${DEMO_ACCESS_COOKIE}=[0-9a-f]{64}; Path=/; HttpOnly; SameSite=Strict`));
    expect(cookie).not.toContain(PASSWORD);
    // Le témoin suffit ensuite, y compris pour une requête portant son propre jeton Bearer (connexion par code).
    const withCookie = await a.inject({ method: 'GET', url: '/v1/obligations', headers: { 'x-demo-user': 'u-contribuable', cookie: cookie.split(';')[0]! } });
    expect(withCookie.statusCode).toBe(200);
    const forged = await a.inject({ method: 'GET', url: '/v1/obligations', headers: { 'x-demo-user': 'u-contribuable', cookie: `${DEMO_ACCESS_COOKIE}=${'0'.repeat(64)}` } });
    expect(forged.statusCode).toBe(401);
    await a.close();
  });

  it('fichiers statiques de l’application exemptés (la page se charge dans tout navigateur) ; pages et API /v1 protégées', async () => {
    process.env.MOSOLO_DEMO_ACCESS_PASSWORD = PASSWORD;
    const a = await app();
    for (const url of ['/assets/index-abc123.js', '/assets/index-abc123.css', '/media/couverture-ville-de-kinshasa.webp', '/icons/icon-192.png', '/manifest.webmanifest', '/sw.js', '/workbox-868b6a08.js']) {
      expect((await a.inject({ method: 'GET', url })).statusCode, url).not.toBe(401);
    }
    for (const url of ['/', '/gouverneur', '/v1/obligations', '/v1/assets/x.js', '/v1/media/x.png']) {
      expect((await a.inject({ method: 'GET', url, headers: { 'x-demo-user': 'u-gouverneur' } })).statusCode, url).toBe(401);
    }
    expect((await a.inject({ method: 'POST', url: '/assets/x.js' })).statusCode).toBe(401);
    await a.close();
  });

  it('mot de passe trop court : refus de démarrer ; hors démonstration : variable sans effet', () => {
    expect(() => demoAccessPassword({ MOSOLO_DEMO_MODE: 'true', MOSOLO_DEMO_ACCESS_PASSWORD: 'court' })).toThrow(/12 caractères/);
    expect(demoAccessPassword({ MOSOLO_DEMO_MODE: 'false', MOSOLO_DEMO_ACCESS_PASSWORD: PASSWORD })).toBeNull();
    expect(demoAccessPassword({ MOSOLO_DEMO_MODE: 'true', MOSOLO_DEMO_ACCESS_PASSWORD: PASSWORD })).toBe(PASSWORD);
  });
});
