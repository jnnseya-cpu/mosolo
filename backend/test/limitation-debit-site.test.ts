/**
 * Deuxième passe adverse (27/09/2026) : les fichiers de l'application web (servie par le même service) ne consomment
 * pas le palier de limitation de l'API. Défaut reproduit lors de l'audit d'accessibilité : après quelques chargements
 * de pages depuis une même adresse, un script recevait un JSON 429 et l'application cessait de fonctionner.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { createSoclePlugin } from '../src/plugins/socle/plugin.js';
import { DEFAULT_RATE_LIMITS } from '../src/plugins/socle/rate-limit.js';

const saved = process.env.MOSOLO_STATIC_DIR;
afterEach(() => { if (saved === undefined) delete process.env.MOSOLO_STATIC_DIR; else process.env.MOSOLO_STATIC_DIR = saved; });

describe('Limitation de débit et application web servie', () => {
  it('scripts et pages du client jamais limités ; l’API reste limitée (429 RFC 9457)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mosolo-site-rl-'));
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'index.html'), '<html>index</html>');
    writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');
    process.env.MOSOLO_STATIC_DIR = root;
    const app = buildApp({
      clock: new ManualClock('2026-09-27T09:00:00.000Z'), secrets: { auditHmacKey: 'k', providerSecrets: {}, commsProviderKeys: {} },
      plugins: [createSoclePlugin({ persistence: null, rateLimit: { ...DEFAULT_RATE_LIMITS, enabled: true, global: { limit: 5, windowMs: 60_000 } } })],
    });
    await app.ready();
    for (let i = 0; i < 30; i++) {
      const js = await app.inject({ method: 'GET', url: '/assets/app.js' });
      expect(js.statusCode).toBe(200);
      expect(js.headers['content-type']).toMatch(/javascript/);
      expect((await app.inject({ method: 'GET', url: '/stationnement/tableau-de-bord' })).statusCode).toBe(200);
    }
    const api = [];
    for (let i = 0; i < 8; i++) api.push((await app.inject({ method: 'GET', url: '/v1/meta' })).statusCode);
    expect(api.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(api.slice(5)).toEqual([429, 429, 429]);
    const limited = await app.inject({ method: 'GET', url: '/v1/meta' });
    expect(limited.headers['content-type']).toMatch(/problem\+json/);
    // Écriture sur un chemin hors API : toujours limitée (seules les lectures de fichiers sont exemptées).
    expect((await app.inject({ method: 'POST', url: '/assets/app.js' })).statusCode).toBe(429);
  });
});
