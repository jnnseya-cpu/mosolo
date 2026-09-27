import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { callbackHeaders } from './helpers.js';
import { rakapayPlugin, type RakaPayService } from '../src/plugins/rakapay/plugin.js';
import { RK_DEMO } from '../src/plugins/rakapay/seed.js';
import { titresPlugin, type TitresService } from '../src/plugins/titres/plugin.js';
import type { TestEnv } from './helpers.js';

const PROVIDER_SECRET = 'test-secret-mm-operator-a';
const KALAMU = { commune: 'Kalamu', label: 'Rond-point Victoire', lat: -4.3389, lon: 15.3106 };

async function setup() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} },
    plugins: [titresPlugin, rakapayPlugin],
  });
  await app.ready();
  const env: TestEnv = {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    }),
  };
  return { env, clock, ctx: app.ctx, rk: app.ctx.ext.rakapay as RakaPayService, titres: app.ctx.ext.titres as TitresService };
}

async function pay(env: TestEnv, reference: string) {
  const order = env.app.ctx.payments.byReference(reference)!;
  const raw = JSON.stringify({ providerTxnId: `TXN-${randomUUID()}`, paymentReference: reference, amount: order.amount, status: 'SUCCESS', completedAt: env.clock.now().toISOString() });
  return env.app.inject({
    method: 'POST', url: '/v1/providers/mm-operator-a/callbacks', payload: raw,
    headers: { 'content-type': 'application/json', ...callbackHeaders(PROVIDER_SECRET, raw, env.clock.now()) },
  });
}

const motoByPlate = (rk: RakaPayService, plate: string) => rk.motos.findOne((m) => m.plate === plate)!;

describe('RakaPay — démonstration semée par le circuit réel', () => {
  it('règles FICTIVES publiées par quatre visas, marquées démonstration ; tarifs issus de la règle', async () => {
    const s = await setup();
    const rule = s.ctx.rules.rules.find((r) => r.code === 'DEMO-WEWA-PASS')[0]!;
    expect(rule.status).toBe('ACTIVE');
    expect(rule.demo).toBe(true);
    expect(new Set(rule.approvals.map((a) => a.userId)).size).toBe(4);
    const me = (await s.env.req('GET', '/v1/rakapay/wewa/moi', RK_DEMO.driverUser)).json();
    expect(me.prices.map((p: { amount: { amount: string } }) => p.amount.amount)).toEqual(['500.00', '3500.00', '15000.00']);
    expect(me.prices.every((p: { demo: boolean }) => p.demo)).toBe(true);
    // Le conducteur semé a payé sa semaine : statut VERT, rien à payer.
    expect(me.status).toMatchObject({ color: 'VERT', nothingToPay: true });
    expect(me.currentPass.receiptNumbers).toHaveLength(1);
    const cat = (await s.env.req('GET', '/v1/rakapay/catalogue')).json();
    expect(cat.find((p: { id: string }) => p.id === 'PRD-BUS-7J').type.price.amount).toEqual({ amount: '9000.00', currency: 'CDF' });
  });
});

describe('Pass wewa — achat individuel', () => {
  it('conducteur : référence de paiement (idempotente) puis VERT après le rappel signé ; recette attribuée à la commune de la station', async () => {
    const s = await setup();
    const m2 = motoByPlate(s.rk, 'KN-M 20418');
    expect(s.rk.motoStatus(m2).color).toBe('ROUGE');
    const key = 'pass-achat-0001';
    const r = await s.env.req('POST', '/v1/rakapay/wewa/passes', RK_DEMO.driver2User, { motoId: m2.id, duration: 'JOUR', channel: 'USSD' }, { 'idempotency-key': key });
    expect(r.statusCode).toBe(201);
    const iss = r.json();
    expect(iss.payments[0].amount).toEqual({ amount: '500.00', currency: 'CDF' });
    const again = await s.env.req('POST', '/v1/rakapay/wewa/passes', RK_DEMO.driver2User, { motoId: m2.id, duration: 'JOUR', channel: 'USSD' }, { 'idempotency-key': key });
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json().id).toBe(iss.id);
    const ob = s.ctx.assessment.get(iss.payments[0].obligationId);
    expect(ob.attribution.commune).toBe('Kalamu');
    expect(ob.beneficiaryAccountAlias).toBe('KIN-DGTK-RECETTES-01');
    expect(s.rk.motoStatus(m2).color).toBe('ROUGE');
    await pay(s.env, iss.payments[0].paymentReference);
    const st = (await s.env.req('GET', `/v1/rakapay/wewa/motos/${m2.id}/statut`, RK_DEMO.driver2User)).json();
    expect(st).toMatchObject({ color: 'VERT', nothingToPay: true });
    const c = s.titres.credential(st.credentialId);
    expect(c.attribution).toMatchObject({ commune: 'Kalamu', basis: 'STATION_DEPART', sourceId: 'ST-KAL-VICTOIRE' });
    expect(c.subject.driverId).toBeDefined();
    expect(c.holderTaxpayerId).toBe(RK_DEMO.driver2Taxpayer);
    // Règle 50 % / 1 % (heure serveur) : sous 1 % le pass s'affiche rouge mais reste en règle ; échu, rien n'est valable.
    const total = Date.parse(c.validUntil) - Date.parse(c.validFrom);
    s.clock.set(new Date(Date.parse(c.validUntil) - total * 0.3).toISOString());
    expect(s.rk.motoStatus(m2)).toMatchObject({ color: 'AMBRE', nothingToPay: true, displayStatus: 'BIENTOT_EXPIRE' });
    s.clock.set(new Date(Date.parse(c.validUntil) - total * 0.005).toISOString());
    expect(s.rk.motoStatus(m2)).toMatchObject({ color: 'ROUGE', nothingToPay: true, displayStatus: 'CRITIQUE' });
    s.clock.set(new Date(Date.parse(c.validUntil) + 2 * 3_600_000).toISOString());
    expect(s.rk.motoStatus(m2)).toMatchObject({ color: 'ROUGE', nothingToPay: false });
  });

  it('non transférable : un autre contribuable ne paie pas le pass d’un conducteur ; renouvellement en continuité', async () => {
    const s = await setup();
    const m1 = motoByPlate(s.rk, 'KN-M 20417');
    expect((await s.env.req('POST', '/v1/rakapay/wewa/passes', RK_DEMO.driver2User, { motoId: m1.id, duration: 'JOUR', channel: 'USSD' }, { 'idempotency-key': 'pass-autre-0001' })).statusCode).toBe(403);
    const current = s.titres.credential(s.rk.motoStatus(m1).credentialId!);
    const r = (await s.env.req('POST', '/v1/rakapay/wewa/passes', RK_DEMO.driverUser, { motoId: m1.id, duration: 'MOIS', channel: 'MOBILE_MONEY' }, { 'idempotency-key': 'pass-renouv-0001' })).json();
    await pay(s.env, r.payments[0].paymentReference);
    s.titres.sync();
    const next = s.titres.credential(s.titres.issuance(r.id).items[0]!.credentialId!);
    expect(next.renewsId).toBe(current.id);
    expect(new Date(next.validFrom).getTime()).toBe(new Date(current.validUntil).getTime() + 1);
  });
});

describe('Coopérative — paiement groupé et décisions humaines', () => {
  it('une référence pour le groupe, activation individuelle de chaque pass (plaque + conducteur)', async () => {
    const s = await setup();
    const m1 = motoByPlate(s.rk, 'KN-M 20417');
    const m2 = motoByPlate(s.rk, 'KN-M 20418');
    const res = await s.env.req('POST', '/v1/rakapay/cooperatives/COOP-KALAMU/paiements-groupes', RK_DEMO.coopUser,
      { items: [{ motoId: m1.id, duration: 'SEMAINE' }, { motoId: m2.id, duration: 'JOUR' }], channel: 'MOBILE_MONEY' }, { 'idempotency-key': 'groupe-0001' });
    expect(res.statusCode).toBe(201);
    const iss = res.json();
    expect(iss.payments).toHaveLength(1);
    expect(iss.payments[0].amount).toEqual({ amount: '4000.00', currency: 'CDF' });
    expect(iss.groupPayer.id).toBe('COOP-KALAMU');
    await pay(s.env, iss.payments[0].paymentReference);
    s.titres.sync();
    const done = s.titres.issuance(iss.id);
    expect(done.status).toBe('EMISE');
    const creds = done.items.map((it) => s.titres.credential(it.credentialId!));
    expect(creds).toHaveLength(2);
    expect(creds.map((c) => c.subject.plate)).toEqual(['KN-M 20417', 'KN-M 20418']);
    expect(creds.every((c) => c.payerTaxpayerId === RK_DEMO.coopTaxpayer && c.receiptIds.length === 1)).toBe(true);
    expect(creds[1]!.holderTaxpayerId).toBe(RK_DEMO.driver2Taxpayer);
    const view = (await s.env.req('GET', '/v1/rakapay/cooperatives/COOP-KALAMU', RK_DEMO.coopUser)).json();
    expect(view.compliance.members).toBe(3);
    expect(view.compliance.green).toBe(3);
    expect(view.limits).toMatch(/ne valide aucun contrôle/);
  });

  it('la coopérative ne contrôle pas, ne décide pas ; suspension humaine motivée bloque le paiement groupé', async () => {
    const s = await setup();
    const m1 = motoByPlate(s.rk, 'KN-M 20417');
    expect((await s.env.req('POST', '/v1/rakapay/wewa/controles', RK_DEMO.coopUser, { plate: m1.plate, place: KALAMU })).statusCode).toBe(403);
    expect((await s.env.req('POST', '/v1/rakapay/cooperatives/COOP-KALAMU/decisions', RK_DEMO.coopUser, { decision: 'SUSPENDRE', motif: 'Auto-suspension' })).statusCode).toBe(403);
    expect((await s.env.req('GET', '/v1/rakapay/cooperatives/COOP-KALAMU', RK_DEMO.driverUser)).statusCode).toBe(403);
    expect((await s.env.req('POST', '/v1/rakapay/cooperatives/COOP-KALAMU/decisions', RK_DEMO.managerUser, { decision: 'SUSPENDRE', motif: 'x' })).statusCode).toBe(400);
    const d = await s.env.req('POST', '/v1/rakapay/cooperatives/COOP-KALAMU/decisions', RK_DEMO.managerUser, { decision: 'SUSPENDRE', motif: 'Prélèvements en espèces constatés sur la route (dossier SIG)' });
    expect(d.json().status).toBe('SUSPENDU');
    const blocked = await s.env.req('POST', '/v1/rakapay/cooperatives/COOP-KALAMU/paiements-groupes', RK_DEMO.coopUser, { items: [{ motoId: m1.id, duration: 'JOUR' }], channel: 'USSD' }, { 'idempotency-key': 'groupe-0002' });
    expect(blocked.statusCode).toBe(403);
    expect((await s.env.req('POST', '/v1/rakapay/cooperatives/COOP-KALAMU/decisions', RK_DEMO.managerUser, { decision: 'REACTIVER', motif: 'Mesures correctives vérifiées' })).json().status).toBe('ACCREDITE');
    expect((await s.env.req('POST', '/v1/rakapay/cooperatives/COOP-LIMETE/decisions', RK_DEMO.managerUser, { decision: 'ACCREDITER', motif: 'Dossier complet (démo)' })).json().status).toBe('ACCREDITE');
    expect(s.ctx.audit.list({ action: 'rakapay.cooperative.suspendre' }).total).toBe(1);
  });
});

describe('Contrôle protecteur et vérification passager', () => {
  it('wewa en vert : rien à payer, aucun constat ; conducteur vérifié par le gilet ; contrôle journalisé', async () => {
    const s = await setup();
    const d1 = s.rk.drivers.findOne((d) => d.taxpayerId === RK_DEMO.driverTaxpayer)!;
    const before = s.titres.controls.count();
    const r = await s.env.req('POST', '/v1/rakapay/wewa/controles', RK_DEMO.controllerUser, { vest: d1.vestToken, place: KALAMU });
    expect(r.statusCode).toBe(201);
    const v = r.json();
    expect(v).toMatchObject({ result: 'VALIDE', color: 'vert', nothingToPay: true, driverVerified: true });
    expect(v.constat).toBeUndefined();
    expect(JSON.stringify(v)).not.toMatch(/Kabeya|TP-RK/);
    expect(s.titres.controls.count()).toBe(before + 1);
    const ev = s.titres.controls.all().at(-1)!;
    expect(ev).toMatchObject({ controllerId: RK_DEMO.controllerUser, place: { commune: 'Kalamu' } });
    // Autocollant : même résultat.
    const m1 = motoByPlate(s.rk, 'KN-M 20417');
    expect((await s.env.req('POST', '/v1/rakapay/wewa/controles', RK_DEMO.controllerUser, { sticker: m1.stickerToken, place: KALAMU })).json().result).toBe('VALIDE');
  });

  it('pass absent : constat à instruire, jamais une amende ni une obligation ; hors périmètre refusé', async () => {
    const s = await setup();
    const obligations = s.ctx.assessment.obligations.count();
    const v = (await s.env.req('POST', '/v1/rakapay/wewa/controles', RK_DEMO.controllerUser, { plate: 'KN-M 20418', place: KALAMU })).json();
    expect(v).toMatchObject({ result: 'INVALIDE', nothingToPay: false });
    expect(v.constat.notice).toMatch(/aucune amende/);
    const k = s.titres.constats.get(v.constat.id)!;
    expect(k).toMatchObject({ legalEffect: 'AUCUN_MONTANT', status: 'OUVERT', duringGrace: true });
    expect(s.ctx.assessment.obligations.count()).toBe(obligations);
    expect((await s.env.req('POST', '/v1/rakapay/wewa/controles', RK_DEMO.controllerUser, { plate: 'KN-M 20418', place: { ...KALAMU, commune: 'Ngaliema' } })).statusCode).toBe(403);
    expect((await s.env.req('POST', '/v1/rakapay/wewa/controles', RK_DEMO.controllerUser, { vest: 'MT1.inconnu.faux', place: KALAMU })).json().result).toBe('INVALIDE');
  });

  it('QR dynamique du téléphone du conducteur accepté ; capture refusée après 30 s', async () => {
    const s = await setup();
    const me = (await s.env.req('GET', '/v1/rakapay/wewa/moi', RK_DEMO.driverUser)).json();
    const qr = (await s.env.req('GET', `/v1/titres/${me.currentPass.id}/qr`, RK_DEMO.driverUser)).json();
    const ok = (await s.env.req('POST', '/v1/rakapay/wewa/controles', RK_DEMO.controllerUser, { qr: qr.token, place: KALAMU })).json();
    expect(ok).toMatchObject({ result: 'VALIDE', driverVerified: true });
    s.clock.advance(40_000);
    expect((await s.env.req('POST', '/v1/rakapay/wewa/controles', RK_DEMO.controllerUser, { qr: qr.token, place: KALAMU })).json().result).toBe('INVALIDE');
  });

  it('passager : vérification publique minimale du gilet (aucun nom)', async () => {
    const s = await setup();
    const d1 = s.rk.drivers.findOne((d) => d.taxpayerId === RK_DEMO.driverTaxpayer)!;
    const r = (await s.env.req('GET', `/v1/public/wewa/${encodeURIComponent(d1.vestNumber)}`)).json();
    expect(r).toMatchObject({ registered: true, driverVerified: true, pass: { color: 'VERT' } });
    expect(JSON.stringify(r)).not.toMatch(/Kabeya|displayName|licence|phone/i);
    expect((await s.env.req('GET', '/v1/public/wewa/W-XXX-9999')).json().registered).toBe(false);
  });
});

describe('Registre, billetterie, signalements, pilotage', () => {
  it('enregistrement gratuit (aucune obligation), doublon refusé, coopérative non accréditée refusée', async () => {
    const s = await setup();
    const obligations = s.ctx.assessment.obligations.count();
    const m = await s.env.req('POST', '/v1/rakapay/wewa/motos', RK_DEMO.controllerUser, { plate: 'KN-M 40001', orderNumber: 'KAL-9001', make: 'TVS (démo)', ownerLabel: 'Propriétaire fictif', stationId: 'ST-KAL-KIMBANGU' });
    expect(m.statusCode).toBe(201);
    expect(m.json().stickerToken).toMatch(/^MT1\./);
    const d = await s.env.req('POST', '/v1/rakapay/wewa/conducteurs', RK_DEMO.controllerUser, { displayName: 'Conducteur fictif', licenceNo: 'PC-TEST-1', phone: '+243810000999', motoId: m.json().id });
    expect(d.statusCode).toBe(201);
    expect(d.json().phone).toBeUndefined();
    expect(s.ctx.assessment.obligations.count()).toBe(obligations);
    expect((await s.env.req('POST', '/v1/rakapay/wewa/motos', RK_DEMO.controllerUser, { plate: 'KN M 40001', orderNumber: 'KAL-9002', make: 'XY', ownerLabel: 'YZ', stationId: 'ST-KAL-KIMBANGU' })).statusCode).toBe(409);
    expect((await s.env.req('POST', '/v1/rakapay/wewa/motos', 'u-contribuable', { plate: 'KN-M 40002', orderNumber: 'KAL-9003', make: 'XY', ownerLabel: 'YZ', stationId: 'ST-KAL-KIMBANGU', cooperativeId: 'COOP-LIMETE' })).statusCode).toBe(403);
    const reg = (await s.env.req('GET', '/v1/rakapay/wewa/registre?commune=Kalamu', RK_DEMO.controllerUser)).json();
    expect(reg.length).toBeGreaterThanOrEqual(4);
    expect(reg[0].driver.displayName).toBeUndefined(); // accès minimal de l'agent de terrain
  });

  it('ticket de bus : station hors ligne refusée ; achat, paiement, trajet consommé au contrôle', async () => {
    const s = await setup();
    expect((await s.env.req('POST', '/v1/rakapay/tickets', 'u-locataire', { productId: 'PRD-BUS-TRAJET-L1', departureStationId: 'ST-LMB-UNIKIN', channel: 'MOBILE_MONEY' }, { 'idempotency-key': 'ticket-0001' })).statusCode).toBe(422);
    const r = await s.env.req('POST', '/v1/rakapay/tickets', 'u-locataire', { productId: 'PRD-BUS-TRAJET-L1', departureStationId: 'ST-GOM-GARE', channel: 'MOBILE_MONEY' }, { 'idempotency-key': 'ticket-0002' });
    expect(r.statusCode).toBe(201);
    expect(s.ctx.assessment.get(r.json().payments[0].obligationId).attribution.commune).toBe('Gombe');
    await pay(s.env, r.json().payments[0].paymentReference);
    const mine = (await s.env.req('GET', '/v1/rakapay/tickets', 'u-locataire')).json();
    expect(mine).toHaveLength(1);
    expect(mine[0].attribution).toMatchObject({ commune: 'Gombe', basis: 'STATION_DEPART' });
    const first = (await s.env.req('POST', '/v1/titres/controles', RK_DEMO.controllerUser, { qr: mine[0].staticToken, place: { commune: 'Gombe', label: 'Bus L1' } })).json();
    expect(first.result).toBe('VALIDE');
    expect((await s.env.req('POST', '/v1/titres/controles', RK_DEMO.controllerUser, { qr: mine[0].staticToken, place: { commune: 'Gombe', label: 'Bus L1' } })).json().text).toBe('DÉJÀ UTILISÉ');
  });

  it('signalement anonyme sans compte ; traitement par l’enquêteur ; indicateurs agrégés réservés au pilotage', async () => {
    const s = await setup();
    const r = await s.env.req('POST', '/v1/rakapay/signalements', undefined, { category: 'PRELEVEMENT_IRREGULIER', commune: 'Kalamu', occurredAt: '2026-09-26', description: 'Péage informel réclamé à l’entrée de la station.', anonymous: true });
    expect(r.statusCode, r.body).toBe(201);
    expect((await s.env.req('GET', '/v1/rakapay/signalements', RK_DEMO.driverUser)).statusCode).toBe(403);
    expect((await s.env.req('POST', `/v1/rakapay/signalements/${r.json().id}/traitement`, RK_DEMO.controllerUser, { status: 'CLOS', motif: 'Traité' })).statusCode).toBe(403);
    s.clock.advanceHours(6);
    const closed = await s.env.req('POST', `/v1/rakapay/signalements/${r.json().id}/traitement`, 'u-enqueteur', { status: 'CLOS', motif: 'Faits confirmés, transmis à la hiérarchie', confirmed: true });
    expect(closed.json().status).toBe('CLOS');
    expect((await s.env.req('GET', '/v1/rakapay/indicateurs', RK_DEMO.coopUser)).statusCode).toBe(403);
    const ind = (await s.env.req('GET', '/v1/rakapay/indicateurs', 'u-gouverneur')).json();
    expect(ind.coverage.registeredMotos).toBe(4);
    expect(ind.coverage.byStation.find((x: { code: string }) => x.code === 'KAL-001')).toMatchObject({ registered: 2, estimated: 180, estimatedIsExample: true });
    expect(ind.compliance.controlled).toBe(2);
    expect(ind.compliance.rate).toBe('0.5000');
    expect(ind.digitalPayment).toMatchObject({ passesIssued: 2, rate: '1.0000', cashOnRoad: 0, groupPaid: 1 });
    expect(ind.complaints).toMatchObject({ total: 2, closed: 1, confirmedShare: '1.0000', averageHandlingHours: '6.0' });
    expect(ind.revenueByCommune.find((x: { commune: string }) => x.commune === 'Kalamu').amounts).toEqual([{ amount: '13000.00', currency: 'CDF' }]); // pass semaine 3 500 + pass jour 500 + accès bus 7 j 9 000 (station Victoire)
    expect(ind.tickets.sold).toBe(1);
  });
});
