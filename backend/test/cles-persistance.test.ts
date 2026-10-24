/**
 * Clés saisies dans le compte d'administration et CONSERVÉES après redémarrage (24/10/2026) : fichier chiffré
 * (MOSOLO_CONSOLE_FILE) + clé maîtresse stable (MOSOLO_CONFIG_MASTER_KEY). Le fichier ne contient aucune valeur en
 * clair ; une autre clé maîtresse ne relit rien ; sans fichier, la console avertit que les valeurs seront perdues.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { DEFAULT_PLUGINS } from '../src/plugins/index.js';

const TOUCHED = ['MOSOLO_CONSOLE_FILE', 'MOSOLO_CONFIG_MASTER_KEY'];
const saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of TOUCHED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

async function demarrer() {
  const app = buildApp({ clock: new ManualClock('2026-10-24T09:00:00.000Z'), seed: true, plugins: DEFAULT_PLUGINS, secrets: { auditHmacKey: 'k', providerSecrets: {}, commsProviderKeys: {} } });
  await app.ready();
  const req = (method: 'GET' | 'POST', url: string, body?: unknown) => app.inject({ method, url, headers: { 'x-demo-user': 'u-superadmin', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { payload: JSON.stringify(body) } : {}) });
  const definir = (name: string, value: string) => req('POST', `/v1/integrations/keys/${name}/proposals`, { kind: 'DEFINIR', value, motif: 'Saisie par l’administration' });
  const source = async (name: string) => ((await req('GET', '/v1/integrations/keys')).json().groups as { variables: { name: string; activeSource: string }[] }[]).flatMap((g) => g.variables).find((v) => v.name === name)!.activeSource;
  return { app, req, definir, source };
}

describe('Clés de la console conservées après redémarrage', () => {
  it('saisie → redémarrage → valeurs toujours actives (connecteurs reconstruits) ; fichier sans valeur en clair', async () => {
    const fichier = join(mkdtempSync(join(tmpdir(), 'mosolo-cles-')), 'cles.json');
    process.env.MOSOLO_CONSOLE_FILE = fichier;
    process.env.MOSOLO_CONFIG_MASTER_KEY = 'a'.repeat(64);
    const s1 = await demarrer();
    expect((await s1.req('GET', '/v1/integrations/keys')).json().persistance.active).toBe(true);
    for (const [n, v] of [['MOSOLO_PUBLIC_URL', 'https://mosolo.exemple.cd'], ['KODA_WEBHOOK_SECRET', 'secret-koda-0123456789abcdef'], ['KODA_API_KEY', 'sk_test_abcdefABCDEF0123456789'], ['ANTHROPIC_API_KEY', 'sk-ant-api03-abcdefABCDEF0123456789']] as const) {
      expect((await s1.definir(n, v)).statusCode).toBe(201);
    }
    await s1.app.close();
    const brut = readFileSync(fichier, 'utf8');
    for (const secret of ['secret-koda-0123456789abcdef', 'sk_test_abcdefABCDEF0123456789', 'sk-ant-api03-abcdefABCDEF0123456789']) expect(brut).not.toContain(secret);

    const s2 = await demarrer();
    expect(await s2.source('KODA_API_KEY')).toBe('CONSOLE');
    expect(await s2.source('ANTHROPIC_API_KEY')).toBe('CONSOLE');
    expect(s2.app.ctx.connectors.get('koda')?.mode).not.toBe('SANDBOX_LOCAL');
    await s2.app.close();

    // Autre clé maîtresse : rien n'est relu, et la console le dit.
    process.env.MOSOLO_CONFIG_MASTER_KEY = 'b'.repeat(64);
    const s3 = await demarrer();
    expect(await s3.source('KODA_API_KEY')).toBe('ABSENTE');
    expect((await s3.req('GET', '/v1/integrations/keys')).json().persistance).toMatchObject({ active: false, detail: expect.stringMatching(/autre clé maîtresse/) });
    await s3.app.close();
  });

  it('démonstration sans fichier : la console avertit que les valeurs seront perdues', async () => {
    delete process.env.MOSOLO_CONSOLE_FILE;
    const s = await demarrer();
    expect((await s.req('GET', '/v1/integrations/keys')).json().persistance).toMatchObject({ active: false, detail: expect.stringMatching(/PERDUES/) });
    await s.app.close();
  });
});
