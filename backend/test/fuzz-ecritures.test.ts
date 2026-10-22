/**
 * Deuxième passe adverse (27/09/2026), phase « faux succès et entrées hostiles » : TOUTES les routes d'écriture du
 * catalogue (specs/routes-api.md : POST, PUT, DELETE) reçoivent des corps hostiles — JSON mal formé, corps non objet
 * (null, tableau, chaîne, nombre), affectation de masse (status, amount, role, entity, createdBy, approvedBy,
 * __proto__), corps surdimensionné, type de contenu inattendu. Pour chaque route, l'utilisateur de démonstration
 * retenu est le premier qui n'est pas refusé par le contrôle d'accès (le corps est alors réellement validé).
 *
 * Attendus : jamais de 5xx ; toute erreur au format RFC 9457 (application/problem+json, type, title, status, detail,
 * code), en français, sans pile d'appels ni chemin interne ; aucune réponse 2xx à un corps d'affectation de masse
 * qui aurait appliqué un champ interdit.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const USERS = [
  'u-contribuable', 'u-gouverneur', 'u-tresor', 'u-dg-dgipk', 'u-superviseur', 'u-agent-terrain', 'u-auditeur', 'u-admin-entite',
  'u-juriste-redacteur', 'u-ministre-finances', 'vc-u-direction-rfck', 'terrain-st-resp', 'u-controleur', 'u-analyste-rappro', 'u-dircab',
];
const MASS = {
  status: 'VALIDE', statut: 'VALIDE', amount: { amount: '999999999.99', currency: 'USD' }, montant: '999999999', role: 'R01', roles: ['R01'],
  entity: 'GOUVERNORAT', createdBy: 'u-gouverneur', approvedBy: 'u-gouverneur', decidedBy: 'u-gouverneur', validatedBy: 'u-gouverneur', id: 'FORCE-1',
};
const LEAK = /\n\s+at |node_modules|\/home\/|\/src\/|\.ts:\d+|TypeError|ReferenceError|Cannot read properties|undefined is not/;

function isProblem(res: { statusCode: number; headers: Record<string, unknown>; body: string }): string | null {
  if (!String(res.headers['content-type'] ?? '').includes('application/problem+json')) return `type de contenu ${String(res.headers['content-type'])}`;
  let j: Record<string, unknown>;
  try { j = JSON.parse(res.body) as Record<string, unknown>; } catch { return 'corps non JSON'; }
  for (const k of ['type', 'title', 'status', 'detail', 'code']) if (j[k] === undefined) return `champ ${k} absent`;
  if (j.status !== res.statusCode) return 'status incohérent';
  if (LEAK.test(res.body)) return `fuite interne : ${res.body.slice(0, 160)}`;
  return null;
}

describe('Routes d’écriture : corps hostiles', () => {
  it('aucune 5xx, erreurs RFC 9457 sans fuite, aucun faux succès par affectation de masse', async () => {
    const routes = readFileSync(join(ROOT, 'specs/routes-api.md'), 'utf8').split('\n')
      .map((l) => /^\| (POST|PUT|PATCH|DELETE) \| `([^`]+)` \|/.exec(l)).filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ method: m[1] as 'POST', path: m[2]! }))
      // Pages légères /l : formulaires HTML (hors API JSON), couvertes par leurs propres tests.
      .filter((r) => !r.path.startsWith('/l/'));
    expect(routes.length).toBeGreaterThan(800);
    const app = buildApp({ clock: new ManualClock('2026-09-27T09:00:00.000Z'), secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
    await app.ready();
    const server5xx: string[] = [];
    const badProblem: string[] = [];
    const massAccepted: string[] = [];
    let exercised = 0;
    let injected = 0;
    const statuses: Record<string, number> = {};
    const count = (k: string) => { statuses[k] = (statuses[k] ?? 0) + 1; };
    const send = async (method: string, url: string, user: string | undefined, payload: string | undefined, contentType = 'application/json') => {
      injected++;
      const res = await app.inject({
        method: method as 'POST', url,
        headers: { ...(user ? { 'x-demo-user': user } : {}), ...(payload !== undefined ? { 'content-type': contentType } : {}), 'idempotency-key': `fuzz-${injected}-cle` },
        ...(payload !== undefined ? { payload } : {}),
      });
      if (res.statusCode >= 500) server5xx.push(`${method} ${url} [${user ?? 'anonyme'}] → ${res.statusCode} ${res.body.slice(0, 160)}`);
      else if (res.statusCode >= 400) {
        const p = isProblem(res);
        if (p) badProblem.push(`${method} ${url} → ${res.statusCode} : ${p}`);
      }
      return res;
    };
    for (const r of routes) {
      const url = r.path.replace(/:[a-zA-Z]+/g, 'X');
      // 1. Utilisateur retenu : le premier non refusé par l'autorisation sur le corps d'affectation de masse.
      let user: string | undefined;
      let mass;
      for (const u of USERS) {
        mass = await send(r.method, url, u, JSON.stringify(MASS));
        if (mass.statusCode !== 401 && mass.statusCode !== 403) { user = u; break; }
      }
      count(`masse:${mass!.statusCode}`);
      if (!user) continue;
      exercised++;
      if (mass!.statusCode < 300) massAccepted.push(`${r.method} ${r.path} [${user}] → ${mass!.statusCode} ${mass!.body.slice(0, 200)}`);
      // 2. Corps hostiles.
      for (const p of ['{"a":', 'null', '[]', '"texte"', '123', '{"__proto__":{"admin":true},"constructor":{"prototype":{"x":1}}}']) {
        const res = await send(r.method, url, user, p);
        count(`${p.slice(0, 6)}:${res.statusCode}`);
      }
      await send(r.method, url, user, 'x=1', 'text/plain');
    }
    // Corps surdimensionné (limite 1 Mo) sur un échantillon : 413 RFC 9457.
    for (const r of routes.slice(0, 40)) {
      const res = await send(r.method, r.path.replace(/:[a-zA-Z]+/g, 'X'), 'u-contribuable', JSON.stringify({ x: 'a'.repeat(1_100_000) }));
      count(`surdim:${res.statusCode}`);
      expect(res.statusCode, r.path).toBe(413);
    }
    console.log(JSON.stringify({ rapport: 'routes d’écriture — corps hostiles', routes: routes.length, routesExercees: exercised, requetes: injected, statuts: statuses, affectationDeMasseAcceptee: massAccepted }, null, 1));
    expect(server5xx).toEqual([]);
    expect(badProblem).toEqual([]);
    expect(exercised).toBeGreaterThanOrEqual(40);
    // Routes qui acceptent le corps d'affectation de masse (2xx) : toutes sont des déclenchements SANS corps (passages
    // de détection, échéanciers, rappels, balayage IA, défi MFA, effacement de sa mémoire IA) qui IGNORENT le corps ;
    // aucun champ interdit n'est appliqué ni renvoyé (identifiant forcé, montant, rôle).
    expect(massAccepted.length).toBeLessThan(40);
    expect(massAccepted.filter((m) => /FORCE-1|999999999|"role":"R01"|"roles":\["R01"\]/.test(m))).toEqual([]);
    // Corps surdimensionné et type de contenu non JSON : messages en français, codes stables.
    const big = await send('POST', '/v1/registrations', undefined, JSON.stringify({ x: 'a'.repeat(1_100_000) }));
    expect(big.json()).toMatchObject({ status: 413, code: 'CORPS_TROP_VOLUMINEUX', title: 'Corps trop volumineux' });
    const plain = await send('POST', '/v1/registrations', undefined, 'x=1', 'text/plain');
    // Texte brut : lu comme chaîne par le cadriciel, puis refusé par la validation (jamais interprété).
    expect(plain.statusCode).toBe(400);
    const xml = await send('POST', '/v1/registrations', undefined, '<a/>', 'application/xml');
    expect(xml.statusCode).toBe(415);
    expect(xml.json()).toMatchObject({ code: 'TYPE_CONTENU_NON_PRIS_EN_CHARGE', title: 'Type de contenu non pris en charge' });
  }, 600_000);
});
