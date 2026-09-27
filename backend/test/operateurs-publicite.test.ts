/**
 * RakaPay multi-opérateurs (§ 11D, AC-TKT-01, ARB-08) et compléments KIN PUB CONTROL (§ 11B.2, § 11B.5).
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { sha256Hex } from '../src/core/crypto.js';
import { integritePlugin } from '../src/plugins/integrite/plugin.js';
import { publicitePlugin } from '../src/plugins/publicite/plugin.js';
import type { PubliciteService } from '../src/plugins/publicite/service.js';
import { rakapayPlugin, type RakaPayService } from '../src/plugins/rakapay/plugin.js';
import { RK_DEMO } from '../src/plugins/rakapay/seed.js';
import { titresPlugin } from '../src/plugins/titres/plugin.js';
import { ALL_PARAMETERS } from '../src/plugins/integrite/gouvernance/parametres.js';
import { CIRCUITS } from '../src/plugins/integrite/gouvernance/circuits.js';
import type { MosoloPlugin } from '../src/plugins/types.js';
import { PROVIDER_SECRET, type TestEnv } from './helpers.js';

async function setup(plugins: MosoloPlugin<any>[]): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} }, plugins });
  await app.ready();
  return {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
}

const PLACE = { commune: 'Gombe', label: 'Parking privé [EXEMPLE]', lat: -4.305, lon: 15.3 };

/** Exploitant privé accrédité par le circuit complet (candidature → proposition → décision d'une autre personne). */
async function privateOperator(env: TestEnv) {
  const ctx = env.app.ctx;
  ctx.taxpayers.register({ phone: '+243899300001', fullName: 'Parking privé fictif SARL', language: 'fr', situation: 'other' }, 'TP-OP-PRIVE-01');
  ctx.users.add({ id: 'op-prive-admin', name: 'Exploitant privé (démo)', roles: ['R30'], entity: 'PUBLIC', taxpayerId: 'TP-OP-PRIVE-01' });
  ctx.users.add({ id: 'rk-dg', name: 'DG DGTK (démo)', roles: ['R06'], entity: 'DGTK' });
  ctx.users.add({ id: 'op-agent-1', name: 'Agent opérateur 1 (démo)', roles: ['R35'], entity: 'OP-PRIVE' });
  ctx.users.add({ id: 'op-agent-2', name: 'Agent opérateur 2 (démo)', roles: ['R35'], entity: 'OP-PRIVE' });
  const op = (await env.req('POST', '/v1/rakapay/operateurs/candidatures', 'op-prive-admin', { name: 'Parking privé fictif', kind: 'PRIVE', commune: 'Gombe' })).json();
  expect(op.status).toBe('CANDIDAT');
  await env.req('POST', `/v1/rakapay/operateurs/${op.id}/agrement/proposition`, RK_DEMO.managerUser, { outcome: 'ACCREDITER', motif: 'Dossier complet (démonstration)' });
  const same = await env.req('POST', `/v1/rakapay/operateurs/${op.id}/agrement/decision`, RK_DEMO.managerUser, { approve: true, motif: 'Décision par la même personne' });
  expect(same.json().code).toBe('SEPARATION_OF_DUTIES');
  const ok = await env.req('POST', `/v1/rakapay/operateurs/${op.id}/agrement/decision`, 'rk-dg', { approve: true, motif: 'Agrément accordé (démonstration)' });
  expect(ok.json().status).toBe('ACCREDITE');
  return op.id as string;
}

describe('RakaPay multi-opérateurs (§ 11D)', () => {
  it('agrément à quatre yeux, offre privée approuvée, agents exclusifs ; un agent public ne peut pas être agent d’opérateur', async () => {
    const env = await setup([titresPlugin, rakapayPlugin]);
    const opId = await privateOperator(env);
    expect((await env.req('POST', `/v1/rakapay/operateurs/${opId}/offres`, 'op-prive-admin', { family: 'STATIONNEMENT', commercialName: 'Parking 2 h', duration: { unit: 'HEURE', value: 2 }, place: PLACE, price: { amount: '1000', currency: 'CDF' } })).json().code).toBe('DURATION_NOT_ALLOWED');
    expect((await env.req('POST', `/v1/rakapay/operateurs/${opId}/offres`, 'op-prive-admin', { family: 'STATIONNEMENT', commercialName: 'Parking 3 h', duration: { unit: 'HEURE', value: 3 }, place: PLACE, typeCode: 'RKP-BUS-1J' })).json().code).toBe('PRIVATE_NO_PUBLIC_TYPE');
    const offer = (await env.req('POST', `/v1/rakapay/operateurs/${opId}/offres`, 'op-prive-admin', { family: 'STATIONNEMENT', commercialName: 'Parking 3 h', duration: { unit: 'HEURE', value: 3 }, place: PLACE, price: { amount: '1500', currency: 'CDF' } })).json();
    expect(offer).toMatchObject({ status: 'PROPOSEE', publicRevenue: false });
    expect((await env.req('POST', `/v1/rakapay/offres/${offer.id}/decision`, 'op-prive-admin', { approve: true, motif: 'Auto-approbation' })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/rakapay/offres/${offer.id}/decision`, RK_DEMO.managerUser, { approve: true, motif: 'Offre conforme' })).json().status).toBe('APPROUVEE');
    expect((await env.req('POST', `/v1/rakapay/operateurs/${opId}/agents`, 'op-prive-admin', { userId: 'op-agent-1' })).statusCode).toBe(201);
    expect((await env.req('POST', `/v1/rakapay/operateurs/${opId}/agents`, 'op-prive-admin', { userId: RK_DEMO.controllerUser })).json().code).toBe('PUBLIC_AGENT_NOT_ALLOWED');
    // Exclusivité : l'agent d'un opérateur ne peut pas être rattaché à un autre.
    env.app.ctx.taxpayers.register({ phone: '+243899300002', fullName: 'Second exploitant fictif', language: 'fr', situation: 'other' }, 'TP-OP-PRIVE-02');
    env.app.ctx.users.add({ id: 'op-prive-admin-2', name: 'Second exploitant (démo)', roles: ['R30'], entity: 'PUBLIC', taxpayerId: 'TP-OP-PRIVE-02' });
    const op2 = (await env.req('POST', '/v1/rakapay/operateurs/candidatures', 'op-prive-admin-2', { name: 'Second parking', kind: 'PRIVE', commune: 'Gombe' })).json();
    await env.req('POST', `/v1/rakapay/operateurs/${op2.id}/agrement/proposition`, RK_DEMO.managerUser, { outcome: 'ACCREDITER', motif: 'Dossier complet' });
    await env.req('POST', `/v1/rakapay/operateurs/${op2.id}/agrement/decision`, 'rk-dg', { approve: true, motif: 'Agrément accordé' });
    expect((await env.req('POST', `/v1/rakapay/operateurs/${op2.id}/agents`, 'op-prive-admin-2', { userId: 'op-agent-1' })).json().code).toBe('AGENT_EXCLUSIVE');
    // Aucune visibilité croisée : le second exploitant ne voit pas le tableau du premier.
    expect((await env.req('GET', `/v1/rakapay/operateurs/${opId}/tableau`, 'op-prive-admin-2')).json().code).toBe('NO_CROSS_VISIBILITY');
    const rk = env.app.ctx.ext.rakapay as RakaPayService;
    expect(env.app.ctx.audit.list({ limit: 1e6 }).items.filter((a) => a.action === 'rakapay.operator.approved')).toHaveLength(2);
    expect(rk.operateurs.approvals.get(opId)?.decision?.by).toBe('rk-dg');
  });

  it('AC-TKT-01 : vente privée dans un circuit comptable séparé — ni ordre de paiement, ni grand livre public ; aucune espèce ; circuits jamais additionnés', async () => {
    const env = await setup([titresPlugin, rakapayPlugin]);
    const ctx = env.app.ctx;
    const opId = await privateOperator(env);
    const offer = (await env.req('POST', `/v1/rakapay/operateurs/${opId}/offres`, 'op-prive-admin', { family: 'STATIONNEMENT', commercialName: 'Parking 24 h', duration: { unit: 'HEURE', value: 24 }, place: PLACE, price: { amount: '3000', currency: 'CDF' } })).json();
    await env.req('POST', `/v1/rakapay/offres/${offer.id}/decision`, RK_DEMO.managerUser, { approve: true, motif: 'Offre conforme' });
    await env.req('POST', `/v1/rakapay/operateurs/${opId}/agents`, 'op-prive-admin', { userId: 'op-agent-1' });
    const orders = ctx.payments.orders.count();
    const ledger = ctx.ledger.list().length;
    expect((await env.req('POST', '/v1/rakapay/ventes-privees', 'op-agent-1', { offerId: offer.id, channel: 'ESPECES' })).json().code).toBe('CASH_NOT_ALLOWED');
    expect((await env.req('POST', '/v1/rakapay/ventes-privees', 'op-agent-2', { offerId: offer.id, channel: 'MOBILE_MONEY' })).json().code).toBe('NOT_OPERATOR_AGENT');
    const sale = (await env.req('POST', '/v1/rakapay/ventes-privees', 'op-agent-1', { offerId: offer.id, channel: 'MOBILE_MONEY' })).json();
    expect(sale).toMatchObject({ circuit: 'PRIVE', settlement: 'REGLEMENT_DIRECT_OPERATEUR', amount: { amount: '3000', currency: 'CDF' } });
    expect(ctx.payments.orders.count()).toBe(orders);
    expect(ctx.ledger.list().length).toBe(ledger);
    const circuits = (await env.req('GET', '/v1/rakapay/circuits', RK_DEMO.managerUser)).json();
    expect(circuits.separated).toBe(true);
    expect(circuits.private.amounts).toEqual([{ amount: '3000.00', currency: 'CDF' }]);
    expect(circuits.public.amounts.every((m: { amount: string }) => m.amount !== '3000.00')).toBe(true);
    expect(circuits.platformFee).toMatchObject({ status: 'ACTE_REQUIS', value: null });
    // Tableau : l'agent ne voit que ses ventes ; l'exploitant voit tout, par zone, heure et agent.
    const dash = (await env.req('GET', `/v1/rakapay/operateurs/${opId}/tableau`, 'op-prive-admin')).json();
    expect(dash.privateCircuit).toMatchObject({ circuit: 'PRIVE', sales: 1 });
    expect(dash.privateCircuit.byAgent[0].key).toBe('op-agent-1');
    expect(dash.publicCircuit).toBeNull();
    expect((await env.req('GET', `/v1/rakapay/operateurs/${opId}/tableau`, 'op-agent-1')).json().viewer).toBe('AGENT');
    // ARB-08 : simulation seulement, sur un taux hypothétique saisi (jamais de valeur par défaut).
    expect((await env.req('GET', '/v1/rakapay/redevance-plateforme/simulation', RK_DEMO.managerUser)).json().code).toBe('HYPOTHESIS_REQUIRED');
    const sim = (await env.req('GET', '/v1/rakapay/redevance-plateforme/simulation?tauxHypothetique=2', RK_DEMO.managerUser)).json();
    expect(sim).toMatchObject({ simulation: true, activable: false, simulated: [{ amount: '60.00', currency: 'CDF' }] });
    // Un ticket d'opérateur privé ne peut pas passer par le circuit public.
    const rk = env.app.ctx.ext.rakapay as RakaPayService;
    rk.products.insert({ id: 'PRD-PRIVE-TEST', operatorId: opId, commercialName: 'x', typeCode: 'RKP-BUS-1J', serviceType: 'BUS', publicRevenue: false, status: 'ACTIF' });
    expect(() => rk.buyTicket(ctx.users.get('u-contribuable')!, { productId: 'PRD-PRIVE-TEST', departureStationId: 'ST-GOM-GARE', channel: 'MOBILE_MONEY' })).toThrow(/circuit privé/);
  });

  it('offre publique : le prix vient d’une règle ACTIVE du registre (jamais saisi) ; approuvée → produit du catalogue', async () => {
    const env = await setup([titresPlugin, rakapayPlugin]);
    env.app.ctx.users.add({ id: 'transco-admin', name: 'Exploitant public (démo)', roles: ['R30'], entity: 'PUBLIC', taxpayerId: RK_DEMO.coopTaxpayer });
    const rk = env.app.ctx.ext.rakapay as RakaPayService;
    rk.operators.update({ ...rk.operator('OP-TRANSCO'), taxpayerId: RK_DEMO.coopTaxpayer });
    expect((await env.req('POST', '/v1/rakapay/operateurs/OP-TRANSCO/offres', 'transco-admin', { family: 'ACCES', commercialName: 'Pass 7 jours Ligne 2', duration: { unit: 'JOUR', value: 7 }, place: PLACE, typeCode: 'RKP-BUS-7J', price: { amount: '1', currency: 'CDF' } })).json().code).toBe('PRICE_FROM_RULE');
    const o = (await env.req('POST', '/v1/rakapay/operateurs/OP-TRANSCO/offres', 'transco-admin', { family: 'ACCES', commercialName: 'Pass 7 jours Ligne 2', duration: { unit: 'JOUR', value: 7 }, place: PLACE, typeCode: 'RKP-BUS-7J' })).json();
    expect(o.publicRevenue).toBe(true);
    const d = (await env.req('POST', `/v1/rakapay/offres/${o.id}/decision`, RK_DEMO.managerUser, { approve: true, motif: 'Tarif de la règle publiée' })).json();
    expect(d).toMatchObject({ status: 'APPROUVEE', productId: `PRD-${o.id}` });
    expect((await env.req('GET', '/v1/rakapay/catalogue')).json().some((p: { id: string }) => p.id === `PRD-${o.id}`)).toBe(true);
  });

  it('revue des ventes atypiques : signal explicable, examiné par une personne (jamais l’agent lui-même) ; paramètres au registre des seuils', async () => {
    const env = await setup([titresPlugin, rakapayPlugin]);
    const opId = await privateOperator(env);
    const offer = (await env.req('POST', `/v1/rakapay/operateurs/${opId}/offres`, 'op-prive-admin', { family: 'ACCES', commercialName: 'Accès 1 jour', duration: { unit: 'JOUR', value: 1 }, place: PLACE, price: { amount: '500', currency: 'CDF' } })).json();
    await env.req('POST', `/v1/rakapay/offres/${offer.id}/decision`, RK_DEMO.managerUser, { approve: true, motif: 'Offre conforme' });
    await env.req('POST', `/v1/rakapay/operateurs/${opId}/agents`, 'op-prive-admin', { userId: 'op-agent-1' });
    await env.req('POST', `/v1/rakapay/operateurs/${opId}/agents`, 'op-prive-admin', { userId: 'op-agent-2' });
    const rk = env.app.ctx.ext.rakapay as RakaPayService;
    const a1 = env.app.ctx.users.get('op-agent-1')!;
    const a2 = env.app.ctx.users.get('op-agent-2')!;
    rk.operateurs.recordPrivateSale(a2, { offerId: offer.id, channel: 'QR' });
    for (let i = 0; i < 12; i++) rk.operateurs.recordPrivateSale(a1, { offerId: offer.id, channel: 'MOBILE_MONEY' });
    const det = (await env.req('POST', '/v1/rakapay/revues-ventes/detection', 'u-enqueteur')).json();
    expect(det.raised).toHaveLength(1);
    expect(det.raised[0]).toMatchObject({ agentId: 'op-agent-1', signal: 'VOLUME_ATYPIQUE', status: 'A_EXAMINER' });
    expect(det.parameters.status).toMatch(/PAR_DEFAUT/);
    const done = (await env.req('POST', `/v1/rakapay/revues-ventes/${det.raised[0].id}/decision`, 'u-enqueteur', { outcome: 'CLASSER', motif: 'Jour de match : affluence justifiée' })).json();
    expect(done.status).toBe('CLASSEE');
    expect(ALL_PARAMETERS.some((p) => p.id === 'rakapay.ventes_atypiques_facteur')).toBe(true);
    expect(CIRCUITS.some((c) => c.code === 'RAKAPAY_AGREMENT_OPERATEUR')).toBe(true);
  });
});

const jpeg = () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(400), Buffer.from([0xff, 0xd9])]);
  return { imageBase64: buf.toString('base64'), sha256: sha256Hex(buf) };
};

describe('KIN PUB CONTROL — compléments § 11B.2 et § 11B.5', () => {
  it('couches de carte : zones saturées décidées, zones à contrôler par faits cumulés, espaces disponibles, interventions', async () => {
    const env = await setup([publicitePlugin]);
    expect((await env.req('POST', '/v1/publicite/zones', 'pb-inspecteur', { kind: 'SATUREE', label: 'Boulevard [EXEMPLE]', commune: 'Gombe', lat: -4.31, lon: 15.3, radiusM: 300, motif: 'Densité excessive constatée' })).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/publicite/zones', 'pb-autorite', { kind: 'SATUREE', label: 'Boulevard [EXEMPLE]', commune: 'Gombe', lat: -4.31, lon: 15.3, radiusM: 300, motif: 'Densité excessive constatée' })).statusCode).toBe(201);
    await env.req('POST', '/v1/publicite/espaces', 'pb-instructeur', { label: 'Mur disponible [EXEMPLE]', commune: 'Lingwala', lat: -4.32, lon: 15.3, widthM: '4.00', heightM: '3.00', notes: '' });
    const l = (await env.req('GET', '/v1/publicite/carte/couches', 'pb-instructeur')).json();
    expect(l.saturatedZones).toHaveLength(1);
    expect(l.availableSpaces).toHaveLength(1);
    expect(l.supports.length).toBeGreaterThan(0);
    expect(Array.isArray(l.interventions)).toBe(true);
    expect(l.zonesToControl.computed.every((z: { total: number }) => z.total > 0)).toBe(true);
  });

  it('renouvellement en ligne : reprise de la fiche et des pièces, nouvelle instruction ; contrats et échéances de l’exploitant', async () => {
    const env = await setup([publicitePlugin]);
    const pub = env.app.ctx.ext.publicite as PubliciteService;
    const granted = pub.requests.find((r) => r.status === 'ACCORDEE' && r.taxpayerId === 'TP-PUB-0001' && !pub.requests.findOne((x) => x.deviceId === r.deviceId && ['DEPOSEE', 'COMPLEMENT_DEMANDE', 'PROPOSEE'].includes(x.status)))[0]!;
    expect((await env.req('POST', `/v1/publicite/authorizations/${granted.id}/renewal`, 'u-contribuable', { periodTo: '2027-12-31' })).statusCode).toBe(403);
    const r = await env.req('POST', `/v1/publicite/authorizations/${granted.id}/renewal`, 'pb-annonceur', { periodTo: '2027-12-31' });
    expect(r.statusCode).toBe(201);
    const created = pub.requests.get(r.json().id)!;
    expect(created).toMatchObject({ status: 'DEPOSEE', renewsId: granted.id, deviceId: granted.deviceId });
    expect(created.pieces.length).toBe(granted.pieces.length);
    const c = await env.req('POST', '/v1/publicite/contrats', 'pb-annonceur', { deviceId: granted.deviceId, advertiser: 'Annonceur fictif', reference: 'CT-001', from: '2026-09-01', to: '2028-06-30', sha256: 'c'.repeat(64) });
    expect(c.statusCode).toBe(201);
    const ex = (await env.req('GET', '/v1/publicite/echeances', 'pb-annonceur')).json();
    expect(ex.noticeDays).toBe(30);
    expect(ex.items.find((i: { kind: string; reference: string }) => i.kind === 'CONTRAT' && i.reference === 'CT-001').beyondAuthorization).toBe(true);
    expect(ex.items.find((i: { id: string }) => i.id === granted.id).renewalPending).toBe(true);
  });

  it('portail citoyen : signalement public reçu pour l’inspecteur ; demande d’espèces transmise à la ligne d’intégrité avec code de suivi', async () => {
    const env = await setup([publicitePlugin, integritePlugin]);
    const r = await env.req('POST', '/v1/public/publicite/signalements', undefined, { kind: 'SUPPORT_SANS_PLAQUE', description: 'Grand panneau sans plaque QR au carrefour', lat: -4.31, lon: 15.3, commune: 'Gombe' });
    expect(r.statusCode).toBe(201);
    expect(r.json().status).toBe('RECU');
    const cash = (await env.req('POST', '/v1/public/publicite/signalements', undefined, { kind: 'DEMANDE_ESPECES', description: 'Un contrôleur a demandé de l’argent liquide', lat: -4.31, lon: 15.3, commune: 'Gombe' })).json();
    expect(cash.status).toBe('TRANSMIS_INTEGRITE');
    expect(cash.integrity.trackingCode).toBeTruthy();
    expect((await env.req('POST', '/v1/public/integrite/reports/track', undefined, { code: cash.integrity.trackingCode })).statusCode).toBe(200);
    const list = (await env.req('GET', '/v1/publicite/signalements', 'pb-instructeur')).json().items;
    expect(list).toHaveLength(2);
    const tri = await env.req('POST', `/v1/publicite/signalements/${r.json().reference}/tri`, 'pb-superviseur', { outcome: 'A_INSPECTER', motif: 'À vérifier lors de la tournée' });
    expect(tri.json().status).toBe('A_INSPECTER');
  });

  it('pilote en sept étapes suivi par l’autorité ; analyse d’image : proposition seulement, vérifiée par une personne', async () => {
    const env = await setup([publicitePlugin]);
    const steps = (await env.req('GET', '/v1/publicite/pilote', 'pb-autorite')).json().steps;
    expect(steps).toHaveLength(7);
    expect(steps[1].measure).toMatch(/support/);
    expect((await env.req('POST', '/v1/publicite/pilote/1', 'pb-inspecteur', { status: 'EN_COURS', note: 'Communes retenues' })).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/publicite/pilote/1', 'pb-autorite', { status: 'TERMINEE', note: 'Gombe et Lingwala retenues' })).json().status).toBe('TERMINEE');
    const photo = (await env.req('POST', '/v1/publicite/evidence-photos', 'pb-inspecteur', { ...jpeg(), lat: -4.2, lon: 15.2, accuracyM: 8, gpsSource: 'GPS', stampedAt: env.clock.now().toISOString() })).json();
    const p = await env.req('POST', `/v1/publicite/ia/analyses/${photo.id}`, 'pb-inspecteur');
    expect(p.statusCode).toBe(201);
    expect(p.json()).toMatchObject({ status: 'A_VERIFIER', kind: 'SUPPORT_NON_ENREGISTRE_PROBABLE' });
    expect(p.json().explanation).toMatch(/ni dossier, ni sanction/);
    const pub = env.app.ctx.ext.publicite as PubliciteService;
    const cases = pub.cases.count();
    const v = await env.req('POST', `/v1/publicite/ia/propositions/${p.json().id}/verification`, 'pb-superviseur', { confirm: true, motif: 'Support vu sur place, non enregistré' });
    expect(v.json().status).toBe('CONFIRMEE');
    expect(pub.cases.count()).toBe(cases);
  });
});
