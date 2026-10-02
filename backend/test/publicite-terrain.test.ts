import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { sha256Hex } from '../src/core/crypto.js';
import { PROVIDER_SECRET, type TestEnv } from './helpers.js';

async function env(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-27T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} } });
  await app.ready();
  const req: TestEnv['req'] = (method, url, user, body, headers = {}) => app.inject({
    method: method as 'GET', url,
    headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { app, clock, req };
}
const BD30 = { lat: -4.3036, lon: 15.3070 };
const near = (p: { lat: number; lon: number }, acc = 6, r = 500) => `/v1/publicite/nearby?lat=${p.lat}&lon=${p.lon}&accuracyM=${acc}&radiusM=${r}`;
type Item = { type: string; placement: string; color: string; status: string; rights: string; payable: boolean; objectId: string | null; lat: number; lon: number; distanceM: number; businessName: string | null };

describe('KIN PUB CONTROL sur le terrain — Autour de moi, commerces, publicité mobile', () => {
  it('inspecteur sur place : supports proches colorés, commerces sans enseigne à vérifier, véhicules exclus', async () => {
    const e = await env();
    const r = await e.req('GET', near(BD30), 'pb-inspecteur');
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b).toMatchObject({ inArea: true, commune: 'Gombe' });
    const items = b.items as Item[];
    const by = (t: string) => items.find((i) => i.type === t)!;
    expect(by('BANDEROLE')).toMatchObject({ color: 'red', status: 'NON_DECLARE' });
    expect(by('PANNEAU')).toMatchObject({ color: 'green', rights: 'A_JOUR' });
    expect(by('CHEVALET')).toMatchObject({ color: 'red', rights: 'IMPAYE', payable: true, placement: 'DEVANT_COMMERCE', businessName: 'Pharmacie du Fleuve (fictive)' });
    expect(items.find((i) => i.type === 'ENSEIGNE' && i.placement === 'FACADE_COMMERCE' && i.color === 'green')).toBeTruthy();
    expect(items.some((i) => i.placement === 'VEHICULE')).toBe(false);
    const ds = items.map((i) => i.distanceM);
    expect(ds).toEqual([...ds].sort((x, y) => x - y));
    // Le commerce avec enseigne déclarée n'est pas « à vérifier » ; l'autre l'est.
    // Accès minimal de l'inspectrice : type du commerce seulement, jamais son nom.
    const toCheck = b.businessesToCheck as { label: string; objectId: string }[];
    expect(toCheck.length).toBeGreaterThan(0);
    expect(toCheck.map((x) => x.label).join(' | ')).not.toMatch(/Boutique Mode 243|Pharmacie du Fleuve/);
    expect(e.app.ctx.audit.list({ action: 'publicite.nearby.viewed' }).total).toBe(1);
    // Régie (R07, R06) : habilitée par son entité (DGTK) ; accès complet, nom du commerce visible.
    for (const regie of ['pb-instructeur', 'pb-autorite']) {
      const rr = await e.req('GET', near(BD30), regie);
      expect(rr.statusCode, rr.body).toBe(200);
      const labels = (rr.json().businessesToCheck as { label: string }[]).map((x) => x.label).join(' | ');
      expect(labels).toMatch(/Boutique Mode 243/);
      expect(labels).not.toMatch(/Pharmacie du Fleuve/);
    }
    expect((await e.req('GET', '/v1/publicite/vehicles/KN-4521-BB', 'pb-instructeur')).statusCode).toBe(200);
  });

  it('hors secteur, position imprécise, usager : refusé ou rien montré', async () => {
    const e = await env();
    expect((await e.req('GET', near({ lat: -4.3712, lon: 15.3441 }), 'pb-inspecteur')).json()).toMatchObject({ inArea: false, items: [] });
    expect((await e.req('GET', near(BD30, 200), 'pb-inspecteur')).json().code).toBe('GPS_TOO_IMPRECISE');
    expect((await e.req('GET', near(BD30), 'pb-annonceur')).statusCode).toBe(403);
  });

  it('publicité mobile : contrôle par plaque, constat « non déclaré » d’un véhicule, barème du véhicule non publié', async () => {
    const e = await env();
    const known = (await e.req('GET', '/v1/publicite/vehicles/kn%204521-bb', 'pb-inspecteur')).json();
    expect(known.items).toHaveLength(1);
    expect(known.items[0]).toMatchObject({ placement: 'VEHICULE', vehicleKind: 'BUS', status: 'AUTORISE', rights: 'ACTE_REQUIS', color: 'amber' });
    const unknown = (await e.req('GET', '/v1/publicite/vehicles/KN-7788-ZZ', 'pb-inspecteur')).json();
    expect(unknown.items).toEqual([]);
    expect(unknown.notice).toMatch(/non déclaré/);
    // L'inspecteur constate une publicité sur un véhicule non déclaré : support mobile recensé, lié à la plaque.
    const insp = await e.req('POST', '/v1/publicite/inspections', 'pb-inspecteur', {
      finding: 'NON_DECLARE', photos: [sha256Hex('photo-taxi')], lat: BD30.lat, lon: BD30.lon, gpsAccuracyM: 5,
      newDevice: { type: 'HABILLAGE_VEHICULE', widthM: '2.00', heightM: '1.00', faces: 2, lighting: 'NON_ECLAIRE', commune: 'Gombe', quartier: 'Boulevard du 30 Juin', address: 'Taxi en circulation', localityRank: 1, placement: 'VEHICULE', vehiclePlate: 'KN-7788-ZZ', vehicleKind: 'TAXI' },
      observations: 'Taxi portant une publicité sans plaque QR.',
    });
    expect(insp.statusCode).toBe(201);
    expect(insp.json().case).toBeTruthy();
    expect((await e.req('GET', '/v1/publicite/vehicles/KN7788ZZ', 'pb-inspecteur')).json().items[0]).toMatchObject({ color: 'red', status: 'NON_DECLARE', vehicleKind: 'TAXI' });
    // Déclaration incomplète : plaque ou commerce manquants.
    const spec = { widthM: '1.00', heightM: '1.00', faces: 1, lighting: 'NON_ECLAIRE', commune: 'Gombe', quartier: 'Centre', address: 'Adresse fictive', localityRank: 1, lat: BD30.lat, lon: BD30.lon, photos: [sha256Hex('x')] };
    expect((await e.req('POST', '/v1/publicite/devices', 'pb-annonceur', { ...spec, type: 'HABILLAGE_VEHICULE' })).json().code).toBe('VEHICLE_PLATE_REQUIRED');
    expect((await e.req('POST', '/v1/publicite/devices', 'pb-annonceur', { ...spec, type: 'ENSEIGNE', placement: 'FACADE_COMMERCE' })).json().code).toBe('BUSINESS_REQUIRED');
  });

  it('publicité mobile : l’inspection relève de la commune où se trouve l’inspecteur, pas de la commune déclarée', async () => {
    const e = await env();
    const bus = (await e.req('GET', '/v1/publicite/vehicles/KN-4521-BB', 'pb-inspecteur')).json().items[0];
    expect(bus.commune).toBe('Gombe');
    const body = { deviceId: bus.id, finding: 'NON_CONFORME', photos: [sha256Hex('photo-bus')], gpsAccuracyM: 5, observations: 'Habillage différent du visuel autorisé.' };
    // Bus déclaré à Gombe mais contrôlé à Limete (hors accréditation de l'inspectrice) : refusé.
    const out = await e.req('POST', '/v1/publicite/inspections', 'pb-inspecteur', { ...body, lat: -4.3721, lon: 15.3462 });
    expect(out.statusCode).toBe(403);
    // Contrôlé dans son périmètre : le dossier porte la commune du lieu de l'inspection.
    const here = { lat: -4.3100, lon: 15.3250 };
    const { adCommuneAt } = await import('../src/plugins/publicite/service.js');
    const expected = adCommuneAt(e.app.ctx, e.app.ctx.ext.publicite as never, here).commune;
    const ok = await e.req('POST', '/v1/publicite/inspections', 'pb-inspecteur', { ...body, ...here });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().case.commune).toBe(expected);
  });

  it('droits impayés d’un chevalet devant un commerce : paiement numérique assisté sur place, jamais d’espèces', async () => {
    const e = await env();
    const chevalet = ((await e.req('GET', near(BD30), 'pb-inspecteur')).json().items as Item[]).find((i) => i.type === 'CHEVALET')!;
    const p = (await e.req('GET', `/v1/agents/assist/payables?objectId=${chevalet.objectId}`, 'pb-inspecteur')).json();
    expect(p.items).toHaveLength(1);
    const body = { obligationId: p.items[0].obligationId, lat: chevalet.lat, lon: chevalet.lon, accuracyM: 6 };
    expect((await e.req('POST', '/v1/agents/assist/payment-orders', 'pb-inspecteur', { ...body, channel: 'AGENT_POINT' }, { 'idempotency-key': randomUUID() })).json().code).toBe('CASH_NOT_ALLOWED_FOR_AGENT');
    const r = await e.req('POST', '/v1/agents/assist/payment-orders', 'pb-inspecteur', { ...body, channel: 'USSD' }, { 'idempotency-key': randomUUID() });
    expect(r.statusCode).toBe(201);
    expect(r.json().order).toMatchObject({ status: 'INITIE', amount: { amount: '18000.00', currency: 'CDF' } });
  });
});
