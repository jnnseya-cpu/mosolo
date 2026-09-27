/**
 * Durcissement HTTP (audit de préparation à la production) : en-têtes de sécurité (CSP, HSTS, nosniff, cadres,
 * référent, permissions), service de l'application web sans traversée de chemin ni erreur interne sur un encodage
 * invalide, limitation de débit sur l'inscription libre.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { API_CSP, APP_CSP } from '../src/core/security-headers.js';
import { staticSiteFromEnv } from '../src/core/static-site.js';
import { createSoclePlugin } from '../src/plugins/socle/plugin.js';
import { DEFAULT_RATE_LIMITS } from '../src/plugins/socle/rate-limit.js';

const SECRETS = { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} };
const clock = () => new ManualClock('2026-09-27T09:00:00.000Z');
const saved = process.env.MOSOLO_STATIC_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.MOSOLO_STATIC_DIR;
  else process.env.MOSOLO_STATIC_DIR = saved;
});

function site(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mosolo-site-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>MOSOLO</title>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  return dir;
}

describe('En-têtes de sécurité', () => {
  it('API JSON : nosniff, cadres interdits, aucun référent, HSTS, COOP, permissions, CSP fermée', async () => {
    const app = buildApp({ clock: clock(), secrets: SECRETS, plugins: [] });
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['strict-transport-security']).toMatch(/max-age=\d{7,}/);
    expect(r.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(r.headers['permissions-policy']).toContain('microphone=()');
    expect(r.headers['content-security-policy']).toBe(API_CSP);
    // Erreurs (problem+json) : mêmes en-têtes.
    const nf = await app.inject({ method: 'GET', url: '/v1/inexistante' });
    expect(nf.statusCode).toBe(404);
    expect(nf.headers['content-security-policy']).toBe(API_CSP);
    await app.close();
  });

  it('application web servie par l’API : CSP de l’application (aucun script tiers, cadres interdits)', async () => {
    process.env.MOSOLO_STATIC_DIR = site();
    const app = buildApp({ clock: clock(), secrets: SECRETS, plugins: [] });
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/tableau-de-bord' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    expect(r.headers['content-security-policy']).toBe(APP_CSP);
    expect(APP_CSP).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(APP_CSP).toContain("frame-ancestors 'none'");
    expect(APP_CSP).not.toMatch(/https?:|'unsafe-eval'|\*/);
    // Scripts statiques : pas de CSP propre (sinon elle s'appliquerait aux travailleurs de la carte).
    const js = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(js.headers['content-security-policy']).toBeUndefined();
    expect(js.headers['cache-control']).toContain('immutable');
    await app.close();
  });

  it('une CSP propre à la route (pages légères /l) n’est pas écrasée', async () => {
    const app = buildApp({ clock: clock(), secrets: SECRETS });
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/l' });
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['content-security-policy']).not.toBe(APP_CSP);
    await app.close();
  });
});

describe('Service de l’application web : traversée de chemin et encodages invalides', () => {
  it('« ../ », encodé ou non, et octet nul : jamais un fichier hors du dossier publié', () => {
    const serve = staticSiteFromEnv({ MOSOLO_STATIC_DIR: site() })!;
    for (const url of ['/../../etc/passwd', '/..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd', '/assets/../../package.json']) {
      const f = serve(url);
      expect(f?.type).toMatch(/^text\/html/); // repli sur index.html (routage côté client), jamais le fichier visé
      expect(f?.body.toString()).toContain('<title>MOSOLO</title>');
    }
    expect(serve('/index.html%00.js')).toBeNull();
    expect(serve('/%E0%A4%A')).toBeNull();
    expect(serve('/v1/audit')).toBeNull();
  });

  it('encodage invalide : refus 4xx (routeur : 400), jamais 500', async () => {
    process.env.MOSOLO_STATIC_DIR = site();
    const app = buildApp({ clock: clock(), secrets: SECRETS, plugins: [] });
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/%E0%A4%A' });
    expect([400, 404]).toContain(r.statusCode);
    expect(r.headers['content-type']).toMatch(/json/);
    await app.close();
  });
});

describe('Limitation de débit : inscription libre', () => {
  it('POST /v1/registrations au palier public (par adresse) : 429 au-delà de la limite', async () => {
    const app = buildApp({
      clock: clock(), secrets: SECRETS,
      plugins: [createSoclePlugin({ rateLimit: { ...DEFAULT_RATE_LIMITS, enabled: true, public: { limit: 3, windowMs: 60_000 } } })],
    });
    await app.ready();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: 'POST', url: '/v1/registrations', payload: {} });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 3).every((c) => c !== 429)).toBe(true);
    expect(codes.slice(3)).toEqual([429, 429]);
    await app.close();
  });
});
