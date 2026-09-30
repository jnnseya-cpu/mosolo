/**
 * Projets publics — projet annoncé sans coût (30/09/2026) : le programme routier du Gouvernorat (160 km livrés, plus de
 * 600 km en cours — chiffres annoncés, à confirmer) figure parmi les projets proposés à l'agent d'allocation (IA) ; tant
 * que son coût n'est pas confirmé, l'IA le cite sans le classer ; une personne habilitée saisit le coût, puis il est classé.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { DEFAULT_PLUGINS } from '../src/plugins/index.js';

async function env() {
  const app = buildApp({ clock: new ManualClock('2026-09-30T09:00:00.000Z'), seed: true, plugins: DEFAULT_PLUGINS, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
  await app.ready();
  const req = (method: string, url: string, user: string, body?: unknown) => app.inject({
    method: method as 'GET', url, headers: { 'x-demo-user': user, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { app, req };
}

describe('Projets publics : programme routier annoncé, coût à confirmer', () => {
  it('listé avec ses chiffres annoncés ; non classé par l’IA avant le coût ; classable après confirmation motivée et journalisée', async () => {
    const { app, req } = await env();
    const list = (await req('GET', '/v1/pilotage/projets', 'u-gouverneur')).json();
    const routes = list.items.find((p: { code: string }) => p.code === 'GOUV-ROUTES');
    expect(routes.costToConfirm).toBe(true);
    expect(routes.domain).toBe('VOIRIE');
    expect(routes.announcement.figures.map((f: { value: string }) => f.value)).toEqual(['160 km', 'plus de 600 km']);
    expect(routes.announcement.status).toMatch(/à confirmer/);

    const recommend = () => req('POST', '/v1/pilotage/projets/recommandations', 'u-ministre-finances', { period: '2026-T3', currency: 'USD', legalFundSource: 'Recettes propres rapprochées (test)' });
    const avant = (await recommend()).json();
    for (const s of avant.scenarios) {
      expect(s.items.some((i: { code: string }) => i.code === 'GOUV-ROUTES')).toBe(false);
      expect(s.notice).toMatch(/Non classés faute de coût confirmé : GOUV-ROUTES/);
    }

    expect((await req('POST', `/v1/pilotage/projets/${routes.id}/cout`, 'u-contribuable', { cost: { amount: '0.01', currency: 'USD' }, recurringCost: { amount: '0.00', currency: 'USD' }, motif: 'Coût communiqué (test)' })).statusCode).toBe(403);
    const ok = await req('POST', `/v1/pilotage/projets/${routes.id}/cout`, 'u-ministre-finances', { cost: { amount: '0.01', currency: 'USD' }, recurringCost: { amount: '0.00', currency: 'USD' }, motif: 'Coût communiqué par le Gouvernorat (test)' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().costToConfirm).toBe(false);
    expect(app.ctx.audit.list({ action: 'pilotage.project.cost_confirmed' }).items).toHaveLength(1);
    const apres = (await recommend()).json();
    expect(apres.scenarios[0].notice).not.toMatch(/Non classés/);
  });
});
