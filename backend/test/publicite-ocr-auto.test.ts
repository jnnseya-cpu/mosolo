/**
 * Module 77 — KIN PUB CONTROL : recherche AUTOMATIQUE de l'autorisation correspondante à partir du texte lu par OCR
 * (sans désignation du support), et indicateur « constats validés » (vérification confirmée par le superviseur).
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/core/crypto.js';
import { parkingPlugin } from '../src/plugins/parking/plugin.js';
import { publicitePlugin } from '../src/plugins/publicite/plugin.js';
import { setupApp } from './partie5-helpers.js';

describe('KIN PUB CONTROL — OCR et constats validés (module 77)', () => {
  it('le texte lu par OCR retrouve seul le support et son autorisation ; le constat validé est compté', async () => {
    const env = await setupApp([parkingPlugin, publicitePlugin]);
    const h = (s: string) => sha256Hex(s);
    const d = (await env.req('POST', '/v1/publicite/devices', 'pb-annonceur', { type: 'PANNEAU', widthM: '2.00', heightM: '1.00', faces: 1, lighting: 'NON_ECLAIRE', commune: 'Gombe', quartier: 'Commerce', address: 'Avenue d’exemple 9', localityRank: 1, lat: -4.305, lon: 15.305, photos: [h('ocr')] })).json();
    const before = (await env.req('GET', '/v1/publicite/indicators', 'pb-autorite')).json().totals.casesValidated;
    const insp = await env.req('POST', '/v1/publicite/inspections', 'pb-inspecteur', { finding: 'NON_CONFORME', photos: [h('ocr-2')], lat: -4.305, lon: 15.305, observations: 'Dimensions supérieures à la déclaration (démonstration).', ocrText: `PLAQUE ${d.reference} VILLE DE KINSHASA` });
    expect(insp.statusCode, insp.body).toBe(201);
    expect(insp.json().autoMatched).toBe(d.reference);
    expect(insp.json().inspection.deviceId).toBe(d.id);
    expect(insp.json().inspection.ocrMatches).toContain(d.reference);
    await env.req('POST', `/v1/publicite/cases/${insp.json().case.id}/verify`, 'pb-superviseur', { confirm: true, note: 'Mesures confirmées sur photo.' });
    expect((await env.req('GET', '/v1/publicite/indicators', 'pb-autorite')).json().totals.casesValidated).toBe(before + 1);
    // Texte illisible : aucune correspondance, aucun constat sans désignation du support (ni lieu).
    const none = await env.req('POST', '/v1/publicite/inspections', 'pb-inspecteur', { finding: 'NON_CONFORME', photos: [h('ocr-3')], lat: -4.305, lon: 15.305, observations: 'Illisible.', ocrText: 'ILLISIBLE' });
    expect([400, 403]).toContain(none.statusCode);
  });
});
