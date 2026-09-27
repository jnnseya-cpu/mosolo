import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { sha256Hex } from '../src/core/crypto.js';
import { parkingPlugin } from '../src/plugins/parking/plugin.js';
import { PARKING_DEMO } from '../src/plugins/parking/seed.js';
import { callbackBody, PROVIDER_SECRET, signedCallback, type TestEnv } from './helpers.js';

async function env(plugins?: 'parking'): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} },
    ...(plugins === 'parking' ? { plugins: [parkingPlugin] } : {}),
  });
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

/** Image JPEG minimale (en-tête SOI + données + EOI). */
function jpeg(): { imageBase64: string; sha256: string } {
  const buf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(400), Buffer.from([0xff, 0xd9])]);
  return { imageBase64: buf.toString('base64'), sha256: sha256Hex(buf) };
}

async function pay(e: TestEnv, user: string, obligationId: string) {
  const order = await e.req('POST', `/v1/obligations/${obligationId}/payment-orders`, user, { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() });
  expect(order.statusCode).toBe(201);
  const o = order.json();
  const cb = await signedCallback(e, callbackBody(e, o.paymentReference, o.amount));
  expect(cb.json().status).toBe('CONFIRME');
}

function reconcile(e: TestEnv, obligationId: string) {
  for (const o of e.app.ctx.payments.byObligation(obligationId)) if (o.status === 'CONFIRME') e.app.ctx.payments.orders.update({ ...o, status: 'RAPPROCHE' });
}

const GPS = { lat: -4.3035, lon: 15.3108, accuracyM: 6, gpsSource: 'GPS' as const, place: 'Bd du 30 Juin, face à la poste' };

describe('ParkSmart — caméra de preuve (plaque rouge) : 5 photos des abords, horodatées, géolocalisées, empreinte vérifiée', () => {
  it('contrôle rouge → photos versées, empreintes contrôlées, reprise conservée, constat lié, lecture restreinte', async () => {
    const e = await env('parking');
    const plate = 'KN-0888-DM';
    const red = (await e.req('GET', `/v1/parking/control/${plate}?zoneId=${PARKING_DEMO.zoneGombe}`, 'pk-controleur')).json();
    expect(red.light).toBe('ROUGE');
    const stampedAt = e.clock.now().toISOString();
    const up = (slot: string, img = jpeg(), user = 'pk-controleur', checkId = red.checkId) =>
      e.req('POST', '/v1/parking/evidence-photos', user, { checkId, slot, ...img, ...GPS, stampedAt });

    // Refus : empreinte fausse, format non JPEG, autre agent, contrôle vert.
    const img = jpeg();
    expect((await up('ABORDS_AVANT', { ...img, sha256: sha256Hex('autre') })).json().code).toBe('PHOTO_HASH_MISMATCH');
    const png = Buffer.from('89504e470d0a1a0a' + '00'.repeat(200), 'hex');
    expect((await up('ABORDS_AVANT', { imageBase64: png.toString('base64'), sha256: sha256Hex(png) })).json().code).toBe('PHOTO_FORMAT');
    expect((await up('ABORDS_AVANT', jpeg(), 'pk-superviseur')).statusCode).toBe(403);
    const green = (await e.req('GET', `/v1/parking/control/${PARKING_DEMO.plateOwner}?zoneId=${PARKING_DEMO.zoneGombe}`, 'pk-controleur')).json();
    expect((await up('ABORDS_AVANT', jpeg(), 'pk-controleur', green.checkId)).json().code).toBe('CHECK_NOT_RED');

    // Cinq vues des abords du véhicule (pas la plaque) : devant, derrière, à droite, à gauche, une autre.
    const ids: string[] = [];
    for (const slot of ['ABORDS_AVANT', 'ABORDS_ARRIERE', 'ABORDS_DROITE', 'ABORDS_GAUCHE', 'AUTRE']) {
      const r = await up(slot);
      expect(r.statusCode, slot).toBe(201);
      expect(r.json()).not.toHaveProperty('dataBase64');
      expect(r.json()).toMatchObject({ slot, gpsSource: 'GPS', place: GPS.place, agentId: 'pk-controleur', clockWarning: false, lowAccuracy: false });
      expect(typeof r.json().distanceFromZoneM).toBe('number');
      ids.push(r.json().id);
    }
    // Reprise de la vue avant : l'ancienne photo est conservée, marquée remplacée.
    const retake = (await up('ABORDS_AVANT')).json();
    const field = (e.app.ctx.ext.parking as { field: { photos: { get(id: string): { supersededBy: string | null } } } }).field;
    expect(field.photos.get(ids[0]!)!.supersededBy).toBe(retake.id);
    ids[0] = retake.id;
    // Une photo déjà versée ne peut pas être réutilisée ; une heure incrustée éloignée est signalée, de même qu'un point
    // ajusté à la main sur la carte (source MANUEL : position imprécise, à vérifier).
    expect((await up('ABORDS_ARRIERE', img)).statusCode).toBe(201);
    const late = await e.req('POST', '/v1/parking/evidence-photos', 'pk-controleur', { checkId: red.checkId, slot: 'AUTRE', ...jpeg(), ...GPS, gpsSource: 'MANUEL', stampedAt: '2026-09-26T07:00:00.000Z' });
    expect(late.json()).toMatchObject({ clockWarning: true, gpsSource: 'MANUEL', lowAccuracy: true });
    ids[4] = late.json().id;
    ids[1] = (e.app.ctx.ext.parking as { field: { activeForCheck(c: string): { id: string; slot: string }[] } }).field.activeForCheck(red.checkId).find((p) => p.slot === 'ABORDS_ARRIERE')!.id;

    const v = await e.req('POST', '/v1/parking/violations', 'pk-controleur', {
      zoneId: PARKING_DEMO.zoneGombe, plate, nature: 'NON_PAIEMENT', checkId: red.checkId, photoIds: ids, place: GPS.place,
      lat: GPS.lat, lon: GPS.lon, gpsAccuracyM: 6, observations: 'Véhicule sans titre, photographié sous cinq angles.',
    });
    expect(v.statusCode).toBe(201);
    expect(v.json().photos).toHaveLength(5);
    expect(v.json().evidence).toMatchObject({ place: GPS.place });
    expect(v.json().evidence.photoIds).toEqual(expect.arrayContaining(ids));
    // Un seul constat par contrôle ; photo déjà jointe : ni réutilisable ni remplaçable.
    expect((await e.req('POST', '/v1/parking/violations', 'pk-controleur', { zoneId: PARKING_DEMO.zoneGombe, plate, nature: 'NON_PAIEMENT', checkId: red.checkId, photoIds: [ids[0]], lat: 0, lon: 0, observations: 'double' })).json().code).toBe('CHECK_ALREADY_USED');
    const red2 = (await e.req('GET', `/v1/parking/control/${plate}?zoneId=${PARKING_DEMO.zoneGombe}`, 'pk-controleur')).json();
    expect((await e.req('POST', '/v1/parking/violations', 'pk-controleur', { zoneId: PARKING_DEMO.zoneGombe, plate, nature: 'NON_PAIEMENT', checkId: red2.checkId, photoIds: [ids[0]], lat: 0, lon: 0, observations: 'double' })).json().code).toBe('PHOTO_MISMATCH');
    expect((await up('ABORDS_AVANT')).json().code).toBe('PHOTO_LOCKED');

    const raw = await e.req('GET', `/v1/parking/evidence-photos/${ids[0]}`, 'pk-superviseur');
    expect(raw.statusCode).toBe(200);
    expect(raw.headers['content-type']).toBe('image/jpeg');
    expect(sha256Hex(raw.rawPayload)).toBe(raw.headers['x-mosolo-sha256']);
    expect((await e.req('GET', `/v1/parking/evidence-photos/${ids[0]}`, 'u-contribuable')).statusCode).toBe(403);
    expect(e.app.ctx.audit.list({ action: 'parking.evidence.photo.received', limit: 1000 }).items.filter((a) => (a.details as { checkId?: string }).checkId === red.checkId)).toHaveLength(8);
  });

  it('photos à prendre dans les 30 minutes du contrôle', async () => {
    const e = await env('parking');
    const red = (await e.req('GET', `/v1/parking/control/KN-0999-DM?zoneId=${PARKING_DEMO.zoneGombe}`, 'pk-controleur')).json();
    e.clock.advanceHours(1);
    const r = await e.req('POST', '/v1/parking/evidence-photos', 'pk-controleur', { checkId: red.checkId, slot: 'ABORDS_AVANT', ...jpeg(), ...GPS, stampedAt: e.clock.now().toISOString() });
    expect(r.json().code).toBe('CHECK_TOO_OLD');
  });
});

describe('Pénalités visibles : module stationnement, puis tous modules après 30 jours d’impayé', () => {
  it('au contrôle de la plaque, les agents du module voient les pénalités ; après 30 jours, tout agent qui contrôle les voit, avec le montant', async () => {
    const e = await env();
    const v = (await e.req('GET', '/v1/parking/violations?status=VERIFIE', 'pk-regie')).json().items.find((x: { plate: string }) => x.plate === PARKING_DEMO.plateTenant);
    const d = (await e.req('POST', `/v1/parking/violations/${v.id}/decide`, 'pk-autorite', { outcome: 'RETENUE', reason: 'Photographies probantes.' })).json();
    const obId = d.obligation.id;

    const ctl = (await e.req('GET', `/v1/parking/control/${PARKING_DEMO.plateTenant}?zoneId=${PARKING_DEMO.zoneGombe}`, 'pk-controleur')).json();
    expect(ctl.penaltiesUnpaid).toBe(1);
    expect(ctl.penalties[0]).toMatchObject({ reference: v.reference, unpaid: true, amount: { amount: '20000.00', currency: 'CDF' }, module: 'STATIONNEMENT' });
    // Liste des pénalités : seulement à la suite d'un contrôle réel, récent, de l'agent lui-même sur cette plaque.
    const penalties = (user: string, q: string) => e.req('GET', `/v1/parking/penalties?plate=${PARKING_DEMO.plateTenant}${q}`, user);
    const list = (await penalties('pk-controleur', `&checkId=${ctl.checkId}`)).json().items;
    expect(list).toHaveLength(1);
    expect((await penalties('pk-controleur', '')).json().code).toBe('CHECK_REQUIRED');
    expect((await penalties('pk-superviseur', `&checkId=${ctl.checkId}`)).json().code).toBe('NOT_CHECK_AGENT');
    expect((await e.req('GET', `/v1/parking/penalties?plate=KN-0999-ZZ&checkId=${ctl.checkId}`, 'pk-controleur')).json().code).toBe('CHECK_MISMATCH');
    expect((await penalties('u-contribuable', `&checkId=${ctl.checkId}`)).statusCode).toBe(403);

    // Même module (stationnement) : visible dès la décision, avec le montant ; autre module : seulement après 30 jours.
    const sanctions = e.app.ctx.ext.sanctions as { afterControl(u: unknown, s: unknown, m: string, r: string): { lines: { sameModule: boolean; amount: unknown }[] } | null };
    const same = sanctions.afterControl(e.app.ctx.users.get('pk-superviseur'), { plate: PARKING_DEMO.plateTenant }, 'STATIONNEMENT', 'test');
    expect(same?.lines[0]).toMatchObject({ sameModule: true, amount: { amount: '20000.00', currency: 'CDF' } });
    const place = { commune: 'Gombe', label: 'Boulevard du 30 Juin' };
    const titresControl = () => e.req('POST', '/v1/titres/controles', 'rk-controleur', { plate: PARKING_DEMO.plateTenant, place });
    // Avant 30 jours : rien hors du module.
    expect((await titresControl()).json().penalitesImpayees).toBeUndefined();
    e.clock.advance(31 * 86_400_000);
    const after = (await titresControl()).json();
    expect(after.penalitesImpayees).toMatchObject({ count: 1, thresholdDays: 30 });
    expect(after.penalitesImpayees.lines[0]).toMatchObject({ module: 'STATIONNEMENT', reference: v.reference });
    expect(after.penalitesImpayees.lines[0].overdueDays).toBeGreaterThanOrEqual(31);
    expect(after.penalitesImpayees.lines[0].amount).toEqual({ amount: '20000.00', currency: 'CDF' });
    expect(after.penalitesImpayees.guidance).toMatch(/ne se négocie pas/);
    expect(e.app.ctx.audit.list({ action: 'penalties.overdue.disclosed' }).items.some((a) => (a.details as { module?: string })?.module === 'TITRES')).toBe(true);

    // Contrôle moto-taxi (wewa) d'une plaque non enregistrée comme moto : la pénalité reste visible.
    const wewa = (await e.req('POST', '/v1/rakapay/wewa/controles', 'rk-controleur', { plate: PARKING_DEMO.plateTenant, place })).json();
    expect(wewa.penalitesImpayees?.count).toBe(1);
    // Un usager (non-agent) ne voit jamais ce registre.
    expect((e.app.ctx.ext.sanctions as { afterControl(u: unknown, s: unknown, m: string, r: string): unknown }).afterControl(e.app.ctx.users.get('u-contribuable'), { plate: PARKING_DEMO.plateTenant }, 'X', 'Y')).toBeNull();

    // Une fois payée, elle disparaît du registre transversal.
    await pay(e, 'u-locataire', obId);
    expect((await titresControl()).json().penalitesImpayees).toBeUndefined();
  });
});

describe('Commission des agents : 10 % des pénalités et des paiements générés, sur recettes confirmées', () => {
  it('pénalité de l’agent : en attente → payée → acquise après rapprochement ; paiement dans l’heure d’un contrôle rouge attribué', async () => {
    const e = await env();
    const v = (await e.req('GET', '/v1/parking/violations?status=VERIFIE', 'pk-regie')).json().items.find((x: { plate: string }) => x.plate === PARKING_DEMO.plateTenant);
    expect(v.agentId).toBe('pk-controleur');
    const d = (await e.req('POST', `/v1/parking/violations/${v.id}/decide`, 'pk-autorite', { outcome: 'RETENUE', reason: 'Photographies probantes.' })).json();
    const mine = () => e.req('GET', '/v1/parking/agents/me/earnings', 'pk-controleur').then((r) => r.json());
    let s = await mine();
    expect(s.ratePct).toBe(10);
    const pen = s.lines.find((l: { source: string }) => l.source === 'PENALITE');
    expect(pen).toMatchObject({ state: 'EN_ATTENTE', base: { amount: '20000.00', currency: 'CDF' }, commission: { amount: '2000.00', currency: 'CDF' } });
    await pay(e, 'u-locataire', d.obligation.id);
    expect((await mine()).lines.find((l: { source: string }) => l.source === 'PENALITE').state).toBe('CONFIRMEE');
    reconcile(e, d.obligation.id);
    s = await mine();
    expect(s.lines.find((l: { source: string }) => l.source === 'PENALITE').state).toBe('ACQUISE');
    expect(s.totals.acquise).toEqual([{ amount: '2000.00', currency: 'CDF' }]);

    // Paiement généré : session ouverte dans l'heure qui suit le contrôle rouge de l'agent — contrôle à présence
    // attestée (GPS dans la zone) et session au-delà du délai de grâce (10 min après la première observation).
    const plate = 'KN-0661-TS';
    await e.req('POST', '/v1/parking/vehicles', 'u-contribuable', { plate });
    const redCtl = (await e.req('GET', `/v1/parking/control/${plate}?zoneId=${PARKING_DEMO.zoneGombe}&lat=${GPS.lat}&lon=${GPS.lon}&accuracyM=${GPS.accuracyM}`, 'pk-controleur')).json();
    expect(redCtl).toMatchObject({ light: 'ROUGE', presenceVerified: true });
    e.clock.advance(10 * 60_000);
    const sesR = await e.req('POST', '/v1/parking/sessions', 'u-contribuable', { zoneId: PARKING_DEMO.zoneGombe, plate, durationMinutes: 60 }, { 'idempotency-key': randomUUID() });
    expect(sesR.statusCode, sesR.body).toBe(201);
    const ses = sesR.json();
    await pay(e, 'u-contribuable', ses.obligation.id);
    s = await mine();
    const payLine = s.lines.find((l: { source: string; plate: string }) => l.source === 'PAIEMENT' && l.plate === plate);
    expect(payLine.state).toBe('CONFIRMEE');
    expect(Number(payLine.commission.amount)).toBeCloseTo(Number(payLine.base.amount) * 0.1, 2);
    // Un autre agent ne se voit rien attribuer ; la régie voit le récapitulatif de tous les agents ; un agent ne voit pas celui des autres.
    expect((await e.req('GET', '/v1/parking/agents/earnings', 'pk-regie')).json().items.some((a: { agentId: string }) => a.agentId === 'pk-controleur')).toBe(true);
    expect((await e.req('GET', '/v1/parking/agents/earnings', 'pk-controleur')).statusCode).toBe(403);
    expect((await e.req('GET', '/v1/parking/agents/me/earnings', 'u-contribuable')).statusCode).toBe(403);
  });
});

describe('Commission de 10 % : tous les agents, quel que soit leur module', () => {
  it('titres (pass wewa, ticket) : titre acheté dans l’heure d’un contrôle non valide → paiement généré pour le contrôleur', async () => {
    const e = await env();
    const titres = e.app.ctx.ext.titres as {
      credentials: { all(): { id: string; shortCode: string; typeCode: string; holderTaxpayerId?: string; subject: Record<string, string>; place: Record<string, unknown>; validUntil: string; state: string }[] };
      purchase(u: unknown, i: unknown): { payments: { paymentReference: string }[] };
      sync(): void;
    };
    const c = titres.credentials.all().find((x) => x.holderTaxpayerId && x.state === 'EMIS')!;
    expect(c).toBeDefined();
    // Titre échu : le contrôle est non valide.
    e.clock.set(new Date(Date.parse(c.validUntil) + 3_600_000).toISOString());
    const place = { commune: 'Kalamu', label: 'Rond-point Victoire' };
    const ctl = (await e.req('POST', '/v1/titres/controles', 'rk-controleur', { code: c.shortCode, place })).json();
    expect(ctl.result).not.toBe('VALIDE');
    // Le titulaire rachète un titre du même type dans l'heure : paiement généré par le contrôle.
    e.clock.advance(20 * 60_000);
    const holder = e.app.ctx.users.all().find((u) => u.taxpayerId === c.holderTaxpayerId)!;
    const iss = titres.purchase(holder, { payerTaxpayerId: c.holderTaxpayerId, channel: 'MOBILE_MONEY', items: [{ typeCode: c.typeCode, holderTaxpayerId: c.holderTaxpayerId, subject: c.subject, place: c.place }] });
    const order = e.app.ctx.payments.byReference(iss.payments[0]!.paymentReference)!;
    const cb = await signedCallback(e, callbackBody(e, order.paymentReference, order.amount));
    expect(cb.json().status).toBe('CONFIRME');
    titres.sync();
    const s = (await e.req('GET', '/v1/agents/me/earnings', 'rk-controleur')).json();
    const line = s.lines.find((l: { module: string }) => l.module === 'TITRES');
    expect(line).toMatchObject({ source: 'PAIEMENT', state: 'CONFIRMEE', agentId: 'rk-controleur' });
    expect(Number(line.commission.amount)).toBeCloseTo(Number(line.base.amount) * 0.1, 2);
    // Récapitulatif global (pilotage, régie, Trésor) ; usager refusé.
    expect((await e.req('GET', '/v1/agents/me/earnings', 'u-contribuable')).statusCode).toBe(403);
    const all = (await e.req('GET', '/v1/agents/earnings', 'u-tresor')).json();
    expect(all.items.some((a: { agentId: string }) => a.agentId === 'rk-controleur')).toBe(true);
  });

  it('verticales : dette d’un objet payée dans les 72 h qui suivent le scan de l’agent ; la pénalité reste à l’auteur du constat', async () => {
    const e = await env();
    const vx = e.app.ctx.ext.verticales as { plates: { all(): { code: string; objectId: string; commune: string }[] } };
    const obligations = e.app.ctx.assessment.obligations;
    const agents = e.app.ctx.users.all().filter((u) => u.roles.some((r) => r === 'R10' || r === 'R11') && u.territory?.length);
    const open = (objectId: string) => obligations.find((o) => o.objectId === objectId && o.status !== 'SOLDEE' && o.status !== 'ANNULEE' && e.app.ctx.payments.byObligation(o.id).length === 0);
    const plate = vx.plates.all().find((p) => agents.some((a) => a.territory!.includes(p.commune)) && open(p.objectId).length > 0)!;
    expect(plate).toBeDefined();
    const scanner = agents.find((a) => a.territory!.includes(plate.commune))!.id;
    const ob = open(plate.objectId)[0]!;
    const svc = (e.app.ctx.ext.sanctions as { commissions: { lines(a?: string): { obligationId: string; agentId: string }[] } }).commissions;
    // Scan avant l'échéance (situation non rouge) : aucun défaut révélé, rien d'attribuable à ce scan.
    // Scan à présence attestée : position du terminal à l'objet (sans elle, le scan ne fonde aucune commission).
    const obj = e.app.ctx.objects.objects.get(plate.objectId)!;
    const here = `lat=${obj.lat}&lon=${obj.lon}&accuracyM=10`;
    const dueMs = Date.parse(`${ob.dueDate}T00:00:00.000Z`);
    if (e.clock.now().getTime() < dueMs) {
      const early = (await e.req('GET', `/v1/verticales/plates/${plate.code}/scan?${here}`, scanner)).json();
      expect(early.situation.color).not.toBe('red');
      e.clock.set(new Date(dueMs + 86_400_000).toISOString());
    }
    // Scan après l'échéance : situation ROUGE conservée sur le scan.
    const scan = await e.req('GET', `/v1/verticales/plates/${plate.code}/scan?${here}`, scanner);
    expect(scan.statusCode, scan.body).toBe(200);
    expect(scan.json().situation.color).toBe('red');
    e.clock.advance(2 * 3_600_000);
    const owner = e.app.ctx.users.all().find((u: { taxpayerId?: string }) => u.taxpayerId === ob.taxpayerId);
    await pay(e, owner!.id, ob.id);
    const s = (await e.req('GET', '/v1/agents/me/earnings', scanner)).json();
    const line = s.lines.find((l: { obligationId: string }) => l.obligationId === ob.id);
    expect(line).toMatchObject({ module: 'VERTICALES', source: 'PAIEMENT', state: 'CONFIRMEE' });
    expect(s.modules.some((m: { module: string }) => m.module === 'VERTICALES')).toBe(true);
    // Une seule attribution, au scan rouge (pas au scan antérieur non rouge).
    expect(svc.lines().filter((l) => l.obligationId === ob.id)).toHaveLength(1);
    const scans = (e.app.ctx.ext.verticales as { scans: { all(): { situation?: string; at: string }[] } }).scans.all();
    expect(scans.at(-1)!.situation).toBe('red');
  });
});

describe('Surveillance des constats par agent', () => {
  it('compteurs par agent et par module ; signal « à examiner » sans mesure automatique ; accès restreint', async () => {
    const e = await env();
    const pk = e.app.ctx.ext.parking as { checks: { append(c: unknown): unknown }; violations: { insert(v: unknown): unknown } };
    // Un agent qui constate beaucoup plus que ses pairs (données de test).
    const now = e.clock.now().toISOString();
    for (let i = 0; i < 10; i++) pk.checks.append({ id: `T-CHK-A-${i}`, plate: `KN-10${i}0-TS`, zoneId: PARKING_DEMO.zoneGombe, commune: 'Gombe', light: 'VERT', title: 'SESSION', agentId: 'pk-pair', at: now });
    pk.checks.append({ id: 'T-CHK-A-R', plate: 'KN-1999-TS', zoneId: PARKING_DEMO.zoneGombe, commune: 'Gombe', light: 'ROUGE', title: null, agentId: 'pk-pair', at: now });
    pk.violations.insert({ id: 'T-V-A', reference: 'T-CST-A', zoneId: PARKING_DEMO.zoneGombe, commune: 'Gombe', plate: 'KN-1999-TS', nature: 'NON_PAIEMENT', lightAtCheck: 'ROUGE', checkId: null, evidenceId: 'x', agentId: 'pk-pair', createdAt: now, holderTaxpayerId: null, status: 'CONSTATE', contests: [] });
    for (let i = 0; i < 10; i++) {
      pk.checks.append({ id: `T-CHK-B-${i}`, plate: `KN-20${i}0-TS`, zoneId: PARKING_DEMO.zoneGombe, commune: 'Gombe', light: 'ROUGE', title: null, agentId: 'pk-zele', at: now });
      pk.violations.insert({ id: `T-V-B-${i}`, reference: `T-CST-B-${i}`, zoneId: PARKING_DEMO.zoneGombe, commune: 'Gombe', plate: `KN-20${i}0-TS`, nature: 'NON_PAIEMENT', lightAtCheck: 'ROUGE', checkId: null, evidenceId: 'x', agentId: 'pk-zele', createdAt: now, holderTaxpayerId: null, status: i < 4 ? 'REJETE' : 'CONSTATE', contests: [] });
    }
    const r = await e.req('GET', '/v1/agents/monitoring', 'pk-superviseur');
    expect(r.statusCode).toBe(200);
    const rows = r.json().rows as { agentId: string; totals: { constats: number; rejected: number }; signals: { code: string; level: string }[] }[];
    const zele = rows.find((x) => x.agentId === 'pk-zele')!;
    expect(zele.totals).toMatchObject({ constats: 10, rejected: 4 });
    expect(zele.signals.map((s) => s.code)).toEqual(expect.arrayContaining(['TAUX_CONSTATS_ELEVE', 'PREUVES_ECARTEES']));
    expect(rows[0]!.agentId).toBe('pk-zele'); // les agents à examiner d'abord
    expect(r.json().notice).toMatch(/aucune mesure automatique/);
    expect((await e.req('GET', '/v1/agents/monitoring', 'pk-controleur')).statusCode).toBe(403);
    expect((await e.req('GET', '/v1/agents/monitoring', 'u-contribuable')).statusCode).toBe(403);
  });
});
