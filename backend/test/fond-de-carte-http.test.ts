/**
 * Fond de carte OpenStreetMap de Kinshasa servi par l'API (démonstration en un seul service, Cloud Run) :
 * /tiles/kinshasa.pmtiles lu par plages d'octets (206, Content-Range, Accept-Ranges), type, cache et ETag ;
 * fichier absent → 404 (jamais index.html), pour que l'application affiche « non encore installé ».
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { parseRange, TILES_CACHE_CONTROL } from '../src/core/static-site.js';

const SECRETS = { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} };
const saved = process.env.MOSOLO_STATIC_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.MOSOLO_STATIC_DIR;
  else process.env.MOSOLO_STATIC_DIR = saved;
});

function site(avecTuiles: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'mosolo-tuiles-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>MOSOLO</title>');
  if (avecTuiles) {
    mkdirSync(join(dir, 'tiles'));
    // Faux fichier PMTiles : signature puis 1 000 octets numérotés.
    writeFileSync(join(dir, 'tiles', 'kinshasa.pmtiles'), Buffer.concat([Buffer.from('PMTiles\u0003'), Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256))]));
  }
  return dir;
}

async function app(avecTuiles: boolean) {
  process.env.MOSOLO_STATIC_DIR = site(avecTuiles);
  const a = buildApp({ clock: new ManualClock('2026-09-29T09:00:00.000Z'), secrets: SECRETS, plugins: [] });
  await a.ready();
  return a;
}

describe('Fond de carte : service de /tiles/kinshasa.pmtiles', () => {
  it('plage d’octets : 206, Content-Range, Accept-Ranges, type, cache d’une heure, ETag', async () => {
    const a = await app(true);
    const r = await a.inject({ method: 'GET', url: '/tiles/kinshasa.pmtiles', headers: { range: 'bytes=0-15' } });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 0-15/1008');
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.headers['content-type']).toBe('application/octet-stream');
    expect(r.headers['cache-control']).toBe(TILES_CACHE_CONTROL);
    expect(r.headers.etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(r.rawPayload.length).toBe(16);
    expect(r.rawPayload.subarray(0, 7).toString()).toBe('PMTiles');
    // Plage au milieu du fichier : seuls les octets demandés.
    const m = await a.inject({ method: 'GET', url: '/tiles/kinshasa.pmtiles', headers: { range: 'bytes=108-111' } });
    expect(m.statusCode).toBe(206);
    expect([...m.rawPayload]).toEqual([100, 101, 102, 103]);
    // Revalidation : 304 ; plage hors du fichier : 416 ; sans plage : fichier entier.
    const n = await a.inject({ method: 'GET', url: '/tiles/kinshasa.pmtiles', headers: { 'if-none-match': r.headers.etag as string } });
    expect(n.statusCode).toBe(304);
    const hors = await a.inject({ method: 'GET', url: '/tiles/kinshasa.pmtiles', headers: { range: 'bytes=5000-6000' } });
    expect(hors.statusCode).toBe(416);
    expect(hors.headers['content-range']).toBe('bytes */1008');
    const tout = await a.inject({ method: 'GET', url: '/tiles/kinshasa.pmtiles' });
    expect(tout.statusCode).toBe(200);
    expect(tout.rawPayload.length).toBe(1008);
    await a.close();
  });

  it('fichier absent : 404 (jamais la page index.html) — l’application affiche « non encore installé »', async () => {
    const a = await app(false);
    const r = await a.inject({ method: 'GET', url: '/tiles/kinshasa.pmtiles', headers: { range: 'bytes=0-15' } });
    expect(r.statusCode).toBe(404);
    // Les routes de l'application restent servies par index.html.
    const page = await a.inject({ method: 'GET', url: '/carte' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    await a.close();
  });

  it('analyse des plages (RFC 9110)', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('invalide');
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('lignes=0-1', 100)).toBeNull();
  });
});
