/**
 * Rattachement des agents de terrain aux modules (30/09/2026, consigne du maître d'ouvrage : « un agent de terrain n'est
 * rattaché qu'aux modules qu'il peut vérifier ») : contrôle par le serveur sur chaque scan, contrôle ou vérification ;
 * rattachement modifié par l'administrateur de l'entité de l'agent, journalisé.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';

let saved: string | undefined;
beforeEach(() => { saved = process.env.MOSOLO_DEMO_MODE; process.env.MOSOLO_DEMO_MODE = '1'; });
afterEach(() => { if (saved === undefined) delete process.env.MOSOLO_DEMO_MODE; else process.env.MOSOLO_DEMO_MODE = saved; });

describe('Agents de terrain : contrôles dans leurs seuls modules', () => {
  it('contrôleur du stationnement : stationnement oui ; scan véhicule (RFCK) non ; le contrôleur RFCK : l’inverse', async () => {
    const app = buildApp({ clock: new ManualClock('2026-09-26T09:00:00.000Z'), secrets: { auditHmacKey: 'k', providerSecrets: {}, commsProviderKeys: {} } });
    await app.ready();
    const req = (method: string, url: string, user: string, body?: unknown) => app.inject({ method: method as 'GET', url, headers: { 'x-demo-user': user, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
    const park = await req('GET', '/v1/parking/control/KN-1234-AB?zoneId=x', 'pk-controleur');
    expect(park.json().code).not.toBe('MODULE_NON_RATTACHE');
    const scan = await req('POST', '/v1/vehicules/scan', 'pk-controleur', { saisie: 'KN-2026-CT', place: { lat: -4.3, lon: 15.3 } });
    expect(scan.statusCode).toBe(403);
    expect(scan.json().code).toBe('MODULE_NON_RATTACHE');
    expect((await req('GET', '/v1/parking/control/KN-1234-AB', 'vc-u-controleur-rfck')).json().code).toBe('MODULE_NON_RATTACHE');
    expect((await req('POST', '/v1/vehicules/scan', 'vc-u-controleur-rfck', { saisie: 'KN-2026-CT', place: { lat: -4.3, lon: 15.3 } })).json().code).not.toBe('MODULE_NON_RATTACHE');
    // L'inspectrice publicité ne contrôle pas les titres.
    expect((await req('POST', '/v1/titres/controles', 'pb-inspecteur', { module: 'STATIONNEMENT', plate: 'KN-1234-AB' })).json().code).toBe('MODULE_NON_RATTACHE');
    await app.close();
  });

  it('rattachement modifié par l’administrateur de l’entité, journalisé ; jamais par l’agent lui-même', async () => {
    const app = buildApp({ clock: new ManualClock('2026-09-26T09:00:00.000Z'), secrets: { auditHmacKey: 'k', providerSecrets: {}, commsProviderKeys: {} } });
    await app.ready();
    const post = (user: string, body: unknown) => app.inject({ method: 'POST', url: '/v1/acces/agents/vc-u-controleur-rfck/modules', headers: { 'x-demo-user': user, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    expect((await post('vc-u-controleur-rfck', { modules: ['STATIONNEMENT'], motif: 'auto-rattachement' })).statusCode).toBe(403);
    // Administrateur d'une autre entité : refusé.
    expect((await post('u-admin-entite', { modules: ['STATIONNEMENT'], motif: 'autre entité' })).statusCode).toBe(403);
    const r = await post('vc-u-admin-rfck', { modules: ['VEHICULES', 'STATIONNEMENT'], motif: 'Renfort du contrôle du stationnement' });
    expect(r.statusCode, r.body).toBe(200);
    expect(app.ctx.users.get('vc-u-controleur-rfck')!.modules).toEqual(['VEHICULES', 'STATIONNEMENT']);
    expect(app.ctx.audit.list({ action: 'acces.agent.modules' }).items.at(-1)).toMatchObject({ resourceId: 'vc-u-controleur-rfck' });
    await app.close();
  });
});
