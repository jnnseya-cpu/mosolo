/**
 * Accès aux montants sur autorisation préalable (décision du maître d'ouvrage du 29/09/2026) : Trésor, audit,
 * anti-fraude… voient les montants nécessaires à leur travail après l'approbation d'un membre de la direction,
 * distinct du demandeur, sur motif, pour une durée limitée ; chaque utilisation est journalisée.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { PROVIDER_SECRET, type TestEnv } from './helpers.js';

async function fullApp() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
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
const A = '/v1/acces-montants';
const motif = 'Paie de la réserve des agents du mois (test).';

describe('Accès aux montants sur autorisation préalable de la direction', () => {
  it('Trésor : demande → approbation par la direction → montants visibles, journalisés → expiration', async () => {
    const env = await fullApp();
    expect((await env.req('GET', '/v1/agents/earnings', 'u-tresor')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/pilotage/repartition', 'u-tresor')).json().montantsMasques).toBe(true);
    // Motif obligatoire ; seuls les demandeurs habilités.
    expect((await env.req('POST', A, 'u-tresor', { portees: ['AGENTS'], motif: 'court' })).statusCode).toBe(400);
    expect((await env.req('POST', A, 'u-contribuable', { portees: ['AGENTS'], motif })).statusCode).toBe(403);
    const d = await env.req('POST', A, 'u-tresor', { portees: ['AGENTS', 'REPARTITION'], motif, mission: 'Paie septembre' });
    expect(d.statusCode).toBe(201);
    expect(d.json()).toMatchObject({ status: 'DEMANDEE', dureeJours: 7 });
    const id = d.json().id;
    expect((await env.req('POST', A, 'u-tresor', { portees: ['MOTEUR'], motif })).statusCode).toBe(409);
    // Pas encore approuvée : toujours refusé.
    expect((await env.req('GET', '/v1/agents/earnings', 'u-tresor')).statusCode).toBe(403);
    // Ni le demandeur, ni Groupe Nseya (bénéficiaire), ni un auditeur n'approuvent.
    for (const u of ['u-tresor', 'u-superadmin', 'u-auditeur']) {
      expect((await env.req('POST', `${A}/${id}/decision`, u, { approve: true, motif: 'Tentative non autorisée.' })).statusCode, u).toBe(403);
    }
    const ok = await env.req('POST', `${A}/${id}/decision`, 'u-ministre-finances', { approve: true, motif: 'Paie de la réserve autorisée pour la semaine.' });
    expect(ok.json()).toMatchObject({ status: 'APPROUVEE', decision: { by: 'u-ministre-finances', approve: true } });
    expect((await env.req('GET', '/v1/agents/earnings', 'u-tresor')).statusCode).toBe(200);
    expect((await env.req('GET', '/v1/pilotage/repartition', 'u-tresor')).json().montantsMasques).toBe(false);
    expect((await env.req('GET', '/v1/agents/reserve', 'u-tresor')).json().perimetre).toBe('COMPLET');
    // Portée non accordée : le moteur reste fermé.
    expect((await env.req('GET', '/v1/pilotage/moteur-repartition/tableau/executif', 'u-tresor')).statusCode).toBe(403);
    const uses = env.app.ctx.audit.list({ action: 'montants.autorisation.utilisee' }).items;
    expect(uses.length).toBeGreaterThan(0);
    expect(uses.every((u) => u.actor.id === 'u-tresor')).toBe(true);
    const mine = (await env.req('GET', A, 'u-tresor')).json();
    expect(mine.mesPorteesActives.sort()).toEqual(['AGENTS', 'REPARTITION']);
    // Échue après la durée accordée.
    env.clock.advance(7 * 86_400_000 + 1000);
    expect((await env.req('GET', '/v1/agents/earnings', 'u-tresor')).statusCode).toBe(403);
    expect((await env.req('GET', A, 'u-tresor')).json().items[0].etat).toBe('EXPIREE');
  });

  it('Audit : motif journalisé, moteur ouvert après approbation, révocation par la direction', async () => {
    const env = await fullApp();
    const B = '/v1/pilotage/moteur-repartition';
    expect((await env.req('GET', `${B}/tableau/executif`, 'u-auditeur')).statusCode).toBe(403);
    const id = (await env.req('POST', A, 'u-auditeur', { portees: ['MOTEUR'], motif: 'Mission d’audit des répartitions du trimestre.', dureeJours: 3 })).json().id;
    // La direction voit la demande en attente.
    expect((await env.req('GET', A, 'u-gouverneur')).json().items.some((a: { id: string; etat: string }) => a.id === id && a.etat === 'DEMANDEE')).toBe(true);
    await env.req('POST', `${A}/${id}/decision`, 'u-gouverneur', { approve: true, motif: 'Mission d’audit approuvée.' });
    expect((await env.req('GET', `${B}/tableau/executif`, 'u-auditeur')).statusCode).toBe(200);
    expect((await env.req('GET', `${B}/export`, 'u-auditeur')).statusCode).toBe(200);
    const trace = env.app.ctx.audit.list({ action: 'montants.autorisation.utilisee' }).items.find((x) => x.actor.id === 'u-auditeur');
    expect(JSON.stringify(trace?.details)).toContain('Mission d’audit');
    expect((await env.req('POST', `${A}/${id}/revocation`, 'u-gouverneur', { motif: 'Fin de la mission d’audit.' })).json().status).toBe('REVOQUEE');
    expect((await env.req('GET', `${B}/tableau/executif`, 'u-auditeur')).statusCode).toBe(403);
    // Un refus n'ouvre rien.
    const id2 = (await env.req('POST', A, 'u-enqueteur', { portees: ['AGENTS'], motif: 'Enquête sur des points suspects (test).' })).json().id;
    expect((await env.req('POST', `${A}/${id2}/decision`, 'u-dircab', { approve: false, motif: 'Motif insuffisant pour ouvrir les montants.' })).json().status).toBe('REFUSEE');
    expect((await env.req('GET', '/v1/agents/earnings', 'u-enqueteur')).statusCode).toBe(403);
  });
});
