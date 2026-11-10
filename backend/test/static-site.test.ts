import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { staticSiteFromEnv } from '../src/core/static-site.js';

describe('application web servie par l’API (démonstration en un seul service)', () => {
  const root = mkdtempSync(join(tmpdir(), 'mosolo-site-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<html>index</html>');
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(tmpdir(), 'secret-hors-site.txt'), 'secret');

  it('inactive sans MOSOLO_STATIC_DIR', () => expect(staticSiteFromEnv({})).toBeNull());
  it('sert les fichiers, index.html pour les routes du client, jamais /v1 ni hors du dossier', () => {
    const site = staticSiteFromEnv({ MOSOLO_STATIC_DIR: root })!;
    const js = site('/assets/app.js')!;
    expect(js.type).toContain('javascript'); expect(js.immutable).toBe(true);
    expect(site('/pilotage/reductions?x=1')!.body.toString()).toContain('index');
    expect(site('/v1/inconnue')).toBeNull();
    expect(site('/../secret-hors-site.txt')!.body.toString()).toContain('index');
    expect(site('/%2e%2e/secret-hors-site.txt')!.body.toString()).toContain('index');
  });
  it('refuse un dossier sans index.html', () => expect(() => staticSiteFromEnv({ MOSOLO_STATIC_DIR: join(root, 'assets') })).toThrow(/index\.html/));
});
