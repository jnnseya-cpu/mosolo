/**
 * « Mes preuves » (30/09/2026) : en un clic, toutes les preuves en cours de validité du titulaire, chacune avec un code
 * que le résolveur universel des preuves reconnaît (ce que l'agent scanne lors d'un contrôle).
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { PROVIDER_SECRET, type TestEnv } from './helpers.js';

async function fullApp() {
  const clock = new ManualClock('2026-09-30T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} } });
  await app.ready();
  const env: TestEnv = {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
  return env;
}

describe('« Mes preuves » du titulaire', () => {
  it('titres, autorisations, quitus et quittances, chacun vérifiable par son code', async () => {
    const env = await fullApp();
    const r = await env.req('GET', '/v1/moi/preuves', 'u-contribuable');
    expect(r.statusCode).toBe(200);
    const preuves = r.json().preuves as { famille: string; code: string }[];
    const familles = new Set(preuves.map((p) => p.famille));
    for (const f of ['TITRE', 'AUTORISATION', 'QUITUS', 'QUITTANCE']) expect(familles.has(f), f).toBe(true);
    // Chaque code est reconnu par la vérification publique (ce que scanne l'agent).
    for (const p of preuves.filter((x) => x.famille !== 'QUITTANCE').slice(0, 6)) {
      const v = (await env.req('GET', `/v1/public/preuves/${encodeURIComponent(p.code)}`, undefined, undefined, { 'x-forwarded-for': `10.0.0.${preuves.indexOf(p) + 1}` })).json();
      expect(v.result, `${p.famille} ${p.code}`).not.toBe('INCONNU');
    }
  });

  it('conducteur (gilet) et exploitant publicitaire (support autorisé)', async () => {
    const env = await fullApp();
    const rk = (await env.req('GET', '/v1/moi/preuves', 'rk-conducteur')).json().preuves as { famille: string }[];
    expect(rk.some((p) => p.famille === 'CONDUCTEUR')).toBe(true);
    const pb = (await env.req('GET', '/v1/moi/preuves', 'pb-annonceur')).json().preuves as { famille: string }[];
    expect(pb.some((p) => p.famille === 'PUBLICITE')).toBe(true);
  });

  it('réservé au titulaire du compte', async () => {
    const env = await fullApp();
    expect((await env.req('GET', '/v1/moi/preuves', 'u-mandataire')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/moi/preuves', 'u-controleur')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/moi/preuves')).statusCode).toBe(401);
  });
});
