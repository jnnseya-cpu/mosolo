import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { sha256Hex } from '../src/core/crypto.js';
import { parkingPlugin } from '../src/plugins/parking/plugin.js';
import { publicitePlugin } from '../src/plugins/publicite/plugin.js';
import { PUB_DEMO } from '../src/plugins/publicite/seed.js';
import { callbackBody, PROVIDER_SECRET, signedCallback, type TestEnv } from './helpers.js';

async function setupPub(plugins = [publicitePlugin]): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} },
    plugins,
  });
  await app.ready();
  return {
    app, clock,
    req: (method, url, user, body, headers = {}) =>
      app.inject({
        method: method as 'GET', url,
        headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
      }),
  };
}

const h = (s: string) => sha256Hex(s);
const newPanel = {
  type: 'PANNEAU', widthM: '3.00', heightM: '2.50', faces: 2, lighting: 'NON_ECLAIRE', commune: 'Gombe', quartier: 'Kintambo Magasin',
  address: 'Avenue fictive 7', localityRank: 1, lat: -4.31, lon: 15.30, photos: [h('p')],
};

describe('KIN PUB CONTROL — inventaire et vérification publique', () => {
  it('l’annonceur déclare un dispositif : surface calculée exactement, objet PANNEAU du compte unique, plaque QR', async () => {
    const env = await setupPub();
    const res = await env.req('POST', '/v1/publicite/devices', 'pb-annonceur', newPanel);
    expect(res.statusCode).toBe(201);
    const d = res.json();
    expect(d).toMatchObject({ surfaceM2: '7.5', status: 'DECLARE', ownerIdentified: true, origin: 'DECLARATION' });
    expect(d.reference).toMatch(/^PUB-GOM-\d{6}$/);
    const obj = env.app.ctx.objects.get(d.objectId);
    expect(obj).toMatchObject({ category: 'PANNEAU', commune: 'Gombe', taxpayerId: PUB_DEMO.advertiserTaxpayerId });
    // Un autre usager ne déclare pas pour ce compte.
    expect((await env.req('POST', '/v1/publicite/devices', 'u-contribuable', { ...newPanel, taxpayerId: PUB_DEMO.advertiserTaxpayerId })).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/publicite/devices', 'pb-annonceur', { ...newPanel, widthM: '0' })).json().code).toBe('INVALID_DIMENSIONS');

    const pub = await env.req('GET', `/v1/publicite/public/devices/${d.qrToken}`);
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).toMatchObject({ reference: d.reference, authorized: false, status: 'DECLARE' });
    expect(JSON.stringify(pub.json())).not.toContain('Affiches du Fleuve');
    expect((await env.req('GET', '/v1/publicite/public/devices/inconnu')).json().code).toBe('AD_PLATE_UNKNOWN');
  });

  it('inventaire réservé aux agents ; recherche par référence et par lecture optique', async () => {
    const env = await setupPub();
    expect((await env.req('GET', '/v1/publicite/inventory', 'pb-annonceur')).statusCode).toBe(403);
    const inv = (await env.req('GET', '/v1/publicite/inventory', 'pb-inspecteur')).json().items;
    expect(inv.length).toBe(4);
    const statuses = inv.map((d: { status: string }) => d.status).sort();
    expect(statuses).toEqual(['AUTORISE', 'AUTORISE', 'DECLARE', 'NON_DECLARE']);
    const d1 = inv.find((d: { type: string }) => d.type === 'PANNEAU');
    expect(d1.rights).toBe('A_JOUR');
    const d3 = inv.find((d: { type: string }) => d.type === 'ECRAN_NUMERIQUE');
    expect(d3).toMatchObject({ rights: 'IMPAYE', expiringSoon: true });
    const lk = (await env.req('GET', `/v1/publicite/lookup?q=${encodeURIComponent(`lu sur le panneau : ${d1.reference} / ${d1.authorization.reference}`)}`, 'pb-inspecteur')).json();
    expect(lk.detected.deviceReferences).toEqual([d1.reference]);
    expect(lk.matches[0]).toMatchObject({ id: d1.id, status: 'AUTORISE' });
    const map = (await env.req('GET', '/v1/publicite/map', 'pb-superviseur')).json().items;
    expect(map).toHaveLength(4);
  });
});

describe('KIN PUB CONTROL — autorisation en ligne, liquidation et avis', () => {
  it('dépôt → complément → instruction → décision par une personne distincte → obligation liquidée par la règle → paiement', async () => {
    const env = await setupPub();
    const d = (await env.req('POST', '/v1/publicite/devices', 'pb-annonceur', { ...newPanel, lighting: 'ECLAIRE' })).json();
    const pieces = [{ kind: 'PLAN_SITUATION', name: 'plan.pdf', sha256: h('plan') }];
    expect((await env.req('POST', '/v1/publicite/authorizations', 'pb-annonceur', { deviceId: d.id, periodFrom: '2026-10-01', periodTo: '2026-09-30', pieces })).json().code).toBe('INVALID_PERIOD');
    expect((await env.req('POST', '/v1/publicite/authorizations', 'pb-annonceur', { deviceId: d.id, periodFrom: '2026-10-01', periodTo: '2027-09-30', pieces: [] })).statusCode).toBe(400);
    const r = await env.req('POST', '/v1/publicite/authorizations', 'pb-annonceur', { deviceId: d.id, periodFrom: '2026-10-01', periodTo: '2027-09-30', pieces });
    expect(r.statusCode).toBe(201);
    const id = r.json().id;
    expect((await env.req('POST', '/v1/publicite/authorizations', 'pb-annonceur', { deviceId: d.id, periodFrom: '2026-10-01', periodTo: '2027-09-30', pieces })).json().code).toBe('REQUEST_ALREADY_OPEN');
    // L'annonceur n'instruit pas ; l'autorité ne décide pas avant l'instruction.
    expect((await env.req('POST', `/v1/publicite/authorizations/${id}/instruct`, 'pb-annonceur', { action: 'PROPOSER', proposal: 'ACCORDER', analysis: 'auto-instruction' })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/publicite/authorizations/${id}/decide`, 'pb-autorite', { outcome: 'ACCORDEE', reason: 'Trop tôt' })).json().code).toBe('REQUEST_NOT_PROPOSED');
    await env.req('POST', `/v1/publicite/authorizations/${id}/instruct`, 'pb-instructeur', { action: 'COMPLEMENT', analysis: 'Photo-montage manquant.' });
    const comp = await env.req('POST', `/v1/publicite/authorizations/${id}/pieces`, 'pb-annonceur', { pieces: [{ kind: 'PHOTO_MONTAGE', name: 'montage.jpg', sha256: h('montage') }], message: 'Photo-montage joint.' });
    expect(comp.json().status).toBe('DEPOSEE');
    await env.req('POST', `/v1/publicite/authorizations/${id}/instruct`, 'pb-instructeur', { action: 'PROPOSER', proposal: 'ACCORDER', analysis: 'Dossier complet.' });
    // L'instructeur ne décide pas de son propre dossier (séparation des tâches).
    const self = await env.req('POST', `/v1/publicite/authorizations/${id}/decide`, 'pb-instructeur', { outcome: 'ACCORDEE', reason: 'Je décide moi-même' });
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe('SEPARATION_OF_DUTIES');
    const dec = await env.req('POST', `/v1/publicite/authorizations/${id}/decide`, 'pb-autorite', { outcome: 'ACCORDEE', reason: 'Conforme au règlement fictif.' });
    expect(dec.statusCode).toBe(200);
    const g = dec.json();
    // 7,5 m² × 2 faces × (15 000 + 5 000) CDF — barème FICTIF de démonstration.
    expect(g.liquidation.status).toBe('EMISE');
    expect(g.obligation).toMatchObject({ amount: { amount: '300000.00', currency: 'CDF' }, commune: 'Gombe', payment: 'AUCUNE_REFERENCE', ruleCode: 'DEMO-PUB-SURFACE' });
    expect(g.obligation.base).toMatchObject({ surface_m2: '7.5', faces: '2', eclaire: '1' });
    expect(env.app.ctx.assessment.get(g.obligation.obligationId).createdBy).toBe('pb-autorite');
    expect(env.app.ctx.comms.deliveries.all().some((x) => x.eventCode === 'permit.issued')).toBe(true);

    const order = await env.req('POST', `/v1/obligations/${g.obligation.obligationId}/payment-orders`, 'pb-annonceur', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() });
    expect(order.statusCode).toBe(201);
    // L'inspecteur n'encaisse jamais.
    expect((await env.req('POST', `/v1/obligations/${g.obligation.obligationId}/payment-orders`, 'pb-inspecteur', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).statusCode).toBe(403);
    const cb = await signedCallback(env, callbackBody(env, order.json().paymentReference, order.json().amount));
    expect(cb.json().status).toBe('CONFIRME');
    const obs = (await env.req('GET', '/v1/publicite/obligations/mine', 'pb-annonceur')).json().items;
    expect(obs.find((o: { obligationId: string }) => o.obligationId === g.obligation.obligationId).payment).toBe('PAYE');
  });

  it('sans règle ACTIVE, l’autorisation est tracée « acte requis » sans aucun montant', async () => {
    const env = await setupPub();
    const rule = env.app.ctx.rules.rules.find((r) => r.code === 'DEMO-PUB-SURFACE')[0]!;
    env.app.ctx.rules.rules.update({ ...rule, status: 'SUSPENDUE' as never });
    const d = (await env.req('POST', '/v1/publicite/devices', 'pb-annonceur', newPanel)).json();
    const r = (await env.req('POST', '/v1/publicite/authorizations', 'pb-annonceur', { deviceId: d.id, periodFrom: '2026-10-01', periodTo: '2027-09-30', pieces: [{ kind: 'AUTRE', name: 'x.pdf', sha256: h('x') }] })).json();
    await env.req('POST', `/v1/publicite/authorizations/${r.id}/instruct`, 'pb-instructeur', { action: 'PROPOSER', proposal: 'ACCORDER', analysis: 'Complet.' });
    const before = env.app.ctx.assessment.obligations.count();
    const g = (await env.req('POST', `/v1/publicite/authorizations/${r.id}/decide`, 'pb-autorite', { outcome: 'ACCORDEE', reason: 'Accordée.' })).json();
    expect(g.liquidation).toMatchObject({ status: 'ACTE_REQUIS', obligationId: null });
    expect(g.obligation).toBeNull();
    expect(env.app.ctx.assessment.obligations.count()).toBe(before);
  });

  it('échéances : préavis puis expiration notifiés une seule fois', async () => {
    const env = await setupPub();
    const count = (code: string) => env.app.ctx.comms.deliveries.all().filter((d) => d.eventCode === code).length;
    await env.req('GET', '/v1/publicite/devices/mine', 'pb-annonceur');
    const expiring = count('permit.expiring');
    expect(expiring).toBeGreaterThan(0);
    await env.req('POST', '/v1/publicite/reminders/run', 'pb-instructeur');
    expect(count('permit.expiring')).toBe(expiring);
    env.clock.advance(25 * 86_400_000);
    const res = (await env.req('POST', '/v1/publicite/reminders/run', 'pb-instructeur')).json();
    expect(res.expired).toBe(1);
    const mine = (await env.req('GET', '/v1/publicite/devices/mine', 'pb-annonceur')).json().items;
    expect(mine.find((d: { type: string }) => d.type === 'ECRAN_NUMERIQUE').status).toBe('EXPIRE');
    expect((await env.req('POST', '/v1/publicite/reminders/run', 'pb-annonceur')).statusCode).toBe(403);
  });
});

describe('KIN PUB CONTROL — inspection, constat et décision (RW1)', () => {
  it('seul un inspecteur accrédité constate ; la révocation est immédiate ; badge vérifiable publiquement', async () => {
    const env = await setupPub();
    const insp = {
      finding: 'NON_DECLARE', photos: [h('np')], lat: -4.3, lon: 15.31, observations: 'Support sans plaque',
      newDevice: { type: 'KAKEMONO', widthM: '1.00', heightM: '2.00', faces: 1, lighting: 'NON_ECLAIRE', commune: 'Gombe', quartier: 'Centre', address: 'Rue fictive', localityRank: 1 },
    };
    const refused = await env.req('POST', '/v1/publicite/inspections', 'pb-inspecteur-2', insp);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('NOT_ACCREDITED');
    expect((await env.req('GET', '/v1/publicite/public/badges/pb-inspecteur-2')).json().accredited).toBe(false);
    expect((await env.req('GET', '/v1/publicite/public/badges/pb-inspecteur')).json().accredited).toBe(true);
    expect((await env.req('POST', '/v1/publicite/inspections', 'pb-inspecteur', { ...insp, photos: [] })).statusCode).toBe(400);
    const ok = await env.req('POST', '/v1/publicite/inspections', 'pb-inspecteur', insp);
    expect(ok.statusCode).toBe(201);
    expect(ok.json().case.status).toBe('CONSTATE');
    expect(ok.json().device).toMatchObject({ status: 'NON_DECLARE', origin: 'RECENSEMENT', ownerIdentified: false });
    await env.req('POST', '/v1/publicite/accreditations/pb-inspecteur/revoke', 'pb-autorite', { reason: 'Faux signalement établi (test).' });
    expect((await env.req('POST', '/v1/publicite/inspections', 'pb-inspecteur', insp)).json().code).toBe('NOT_ACCREDITED');
    expect((await env.req('GET', '/v1/publicite/public/badges/pb-inspecteur')).json()).toMatchObject({ accredited: false, status: 'REVOQUEE' });
    // Hors périmètre d'accréditation (commune non couverte).
    await env.req('POST', '/v1/publicite/accreditations', 'pb-autorite', { userId: 'pb-inspecteur', communes: ['Gombe'], validFrom: '2026-01-01', validUntil: '2026-12-31' });
    const out = await env.req('POST', '/v1/publicite/inspections', 'pb-inspecteur', { ...insp, newDevice: { ...insp.newDevice, commune: 'Lingwala' } });
    expect(out.json().code).toBe('NOT_ACCREDITED');
  });

  it('le constat est en ajout seul, la décision n’émet aucune pénalité ; rattachement de l’exploitant et liquidation des droits sur décision', async () => {
    const env = await setupPub();
    const cases = (await env.req('GET', '/v1/publicite/cases?status=CONSTATE', 'pb-superviseur')).json().items;
    const c = cases.find((x: { finding: string }) => x.finding === 'NON_DECLARE');
    expect(c.inspection.presumedOperator).toContain('Régie Horizon');
    // L'inspecteur ne vérifie ni ne décide.
    expect((await env.req('POST', `/v1/publicite/cases/${c.id}/verify`, 'pb-inspecteur', { confirm: true, note: 'auto-vérification' })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/publicite/cases/${c.id}/decide`, 'pb-autorite', { outcome: 'RETENU', reason: 'Trop tôt pour décider' })).json().code).toBe('CASE_NOT_VERIFIED');
    await env.req('POST', `/v1/publicite/cases/${c.id}/verify`, 'pb-superviseur', { confirm: true, note: 'Photographies probantes.' });
    // L'exploitant ne voit un dossier qu'une fois vérifié, et seulement s'il est identifié.
    const before = env.app.ctx.assessment.obligations.count();
    const dec = await env.req('POST', `/v1/publicite/cases/${c.id}/decide`, 'pb-autorite', {
      outcome: 'RETENU', reason: 'Support non déclaré établi ; exploitant identifié par l’enquête.', ownerTaxpayerId: PUB_DEMO.advertiserTaxpayerId, liquidateDues: true,
    });
    expect(dec.statusCode).toBe(200);
    const d = dec.json();
    expect(d.status).toBe('RETENU');
    expect(d.decision.effect).toContain('Aucune pénalité');
    // 8 × 4 = 32 m² × 1 face × 10 000 (rang 2, non éclairé) — barème FICTIF.
    expect(d.obligation).toMatchObject({ amount: { amount: '320000.00', currency: 'CDF' }, commune: 'Barumbu' });
    expect(env.app.ctx.assessment.obligations.count()).toBe(before + 1);
    expect(d.notifiedAt).toBeTruthy();
    expect(env.app.ctx.comms.deliveries.all().some((x) => x.eventCode === 'inspection.report.issued')).toBe(true);

    const mine = (await env.req('GET', '/v1/publicite/cases/mine', 'pb-annonceur')).json().items;
    expect(mine.some((x: { id: string }) => x.id === c.id)).toBe(true);
    expect((await env.req('POST', `/v1/publicite/cases/${c.id}/contest`, 'u-contribuable', { grounds: 'Ce support ne m’appartient pas du tout.' })).statusCode).toBe(403);
    const ct = await env.req('POST', `/v1/publicite/cases/${c.id}/contest`, 'pb-annonceur', { grounds: 'La bâche appartient à un autre exploitant.' });
    expect(ct.statusCode).toBe(201);
    expect(env.app.ctx.appeals.get(ct.json().contests[0].appealId).obligationId).toBe(d.obligation.obligationId);

    // Aucune route de modification ou de suppression d'un constat.
    const inspId = env.app.ctx.ext['publicite'] ? (env.app.ctx.ext['publicite'] as { inspections: { all(): { id: string }[] } }).inspections.all()[0]!.id : '';
    expect((await env.req('POST', `/v1/publicite/inspections/${inspId}/edit`, 'pb-inspecteur', {})).statusCode).toBe(404);
    expect((await env.req('DELETE', `/v1/publicite/inspections/${inspId}`, 'pb-inspecteur')).statusCode).toBe(404);
  });

  it('dossier « non conforme » vérifié : l’autorité distincte classe avec motif ; séparation vérificateur / décideur', async () => {
    const env = await setupPub();
    const c = (await env.req('GET', '/v1/publicite/cases?status=VERIFIE', 'pb-autorite')).json().items[0];
    expect(c.finding).toBe('NON_CONFORME');
    const d = await env.req('POST', `/v1/publicite/cases/${c.id}/decide`, 'pb-instructeur', { outcome: 'CLASSE', reason: 'Écart de mesure non significatif.' });
    expect(d.json()).toMatchObject({ status: 'CLASSE', decision: { outcome: 'CLASSE', obligationId: null } });
    expect((await env.req('POST', `/v1/publicite/cases/${c.id}/contest`, 'pb-annonceur', { grounds: 'Contestation sans objet après classement.' })).json().code).toBe('CASE_CLOSED');
  });

  it('indicateurs agrégés : taux d’autorisation, recettes par m², qualité des inspecteurs (jamais le nombre de sanctions)', async () => {
    const env = await setupPub([parkingPlugin, publicitePlugin]);
    expect((await env.req('GET', '/v1/publicite/indicators', 'pb-annonceur')).statusCode).toBe(403);
    const ind = (await env.req('GET', '/v1/publicite/indicators', 'pb-autorite')).json();
    expect(ind.totals).toMatchObject({ devices: 4, authorized: 2, undeclared: 1, declaredPending: 1, authorizedRate: '50.0', inspections: 3, casesOpen: 2, expiringSoon: 1 });
    expect(ind.totals.revenue).toEqual([{ amount: '480000.00', currency: 'CDF' }]);
    // Surface autorisée : 12 × 2 + 18 × 1 = 42 m² ; 480 000 / 42 = 11 428,57 CDF/m².
    expect(ind.totals.authorizedSurfaceM2).toBe('42');
    expect(ind.totals.revenuePerM2).toEqual([{ amount: '11428.57', currency: 'CDF' }]);
    expect(ind.taxRule).toMatchObject({ code: 'DEMO-PUB-SURFACE', status: 'ACTIVE', demo: true });
    expect(ind.inspectors[0]).toMatchObject({ inspectorId: 'pb-inspecteur', inspections: 3, casesVerified: 1, casesConfirmed: 1, accuracyRate: '100.0' });
    expect(JSON.stringify(ind)).not.toContain('Affiches du Fleuve');
    expect(env.app.ctx.audit.verify().ok).toBe(true);
  });
});
