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

describe('ParkSmart — caméra de preuve (plaque rouge) : 5 photos horodatées, géolocalisées, empreinte vérifiée', () => {
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
    expect((await up('AVANT', { ...img, sha256: sha256Hex('autre') })).json().code).toBe('PHOTO_HASH_MISMATCH');
    const png = Buffer.from('89504e470d0a1a0a' + '00'.repeat(200), 'hex');
    expect((await up('AVANT', { imageBase64: png.toString('base64'), sha256: sha256Hex(png) })).json().code).toBe('PHOTO_FORMAT');
    expect((await up('AVANT', jpeg(), 'pk-superviseur')).statusCode).toBe(403);
    const green = (await e.req('GET', `/v1/parking/control/${PARKING_DEMO.plateOwner}?zoneId=${PARKING_DEMO.zoneGombe}`, 'pk-controleur')).json();
    expect((await up('AVANT', jpeg(), 'pk-controleur', green.checkId)).json().code).toBe('CHECK_NOT_RED');

    // Cinq vues : avant, arrière, côté droit, côté gauche avec les abords, une autre.
    const ids: string[] = [];
    for (const slot of ['AVANT', 'ARRIERE', 'COTE_DROIT', 'COTE_GAUCHE_ABORDS', 'AUTRE']) {
      const r = await up(slot);
      expect(r.statusCode, slot).toBe(201);
      expect(r.json()).not.toHaveProperty('dataBase64');
      expect(r.json()).toMatchObject({ slot, gpsSource: 'GPS', place: GPS.place, agentId: 'pk-controleur', clockWarning: false });
      ids.push(r.json().id);
    }
    // Reprise de la vue avant : l'ancienne photo est conservée, marquée remplacée.
    const retake = (await up('AVANT')).json();
    const field = (e.app.ctx.ext.parking as { field: { photos: { get(id: string): { supersededBy: string | null } } } }).field;
    expect(field.photos.get(ids[0]!)!.supersededBy).toBe(retake.id);
    ids[0] = retake.id;
    // Une photo déjà versée ne peut pas être réutilisée ; une heure incrustée éloignée est signalée.
    expect((await up('ARRIERE', img)).statusCode).toBe(201);
    const late = await e.req('POST', '/v1/parking/evidence-photos', 'pk-controleur', { checkId: red.checkId, slot: 'AUTRE', ...jpeg(), ...GPS, stampedAt: '2026-09-26T07:00:00.000Z' });
    expect(late.json().clockWarning).toBe(true);
    ids[4] = late.json().id;
    ids[1] = (e.app.ctx.ext.parking as { field: { activeForCheck(c: string): { id: string; slot: string }[] } }).field.activeForCheck(red.checkId).find((p) => p.slot === 'ARRIERE')!.id;

    const v = await e.req('POST', '/v1/parking/violations', 'pk-controleur', {
      zoneId: PARKING_DEMO.zoneGombe, plate, nature: 'NON_PAIEMENT', checkId: red.checkId, photoIds: ids, place: GPS.place,
      lat: GPS.lat, lon: GPS.lon, gpsAccuracyM: 6, observations: 'Véhicule sans titre, photographié sous cinq angles.',
    });
    expect(v.statusCode).toBe(201);
    expect(v.json().photos).toHaveLength(5);
    expect(v.json().evidence).toMatchObject({ place: GPS.place });
    expect(v.json().evidence.photoIds).toEqual(expect.arrayContaining(ids));
    // Photo déjà jointe : ni réutilisable ni remplaçable.
    expect((await e.req('POST', '/v1/parking/violations', 'pk-controleur', { zoneId: PARKING_DEMO.zoneGombe, plate, nature: 'NON_PAIEMENT', checkId: red.checkId, photoIds: [ids[0]], lat: 0, lon: 0, observations: 'double' })).json().code).toBe('PHOTO_ALREADY_USED');
    expect((await up('AVANT')).json().code).toBe('PHOTO_LOCKED');

    const raw = await e.req('GET', `/v1/parking/evidence-photos/${ids[0]}`, 'pk-superviseur');
    expect(raw.statusCode).toBe(200);
    expect(raw.headers['content-type']).toBe('image/jpeg');
    expect(sha256Hex(raw.rawPayload)).toBe(raw.headers['x-mosolo-sha256']);
    expect((await e.req('GET', `/v1/parking/evidence-photos/${ids[0]}`, 'u-contribuable')).statusCode).toBe(403);
    expect(e.app.ctx.audit.list({ action: 'parking.evidence.photo.received' }).total).toBe(8);
  });

  it('photos à prendre dans les 30 minutes du contrôle', async () => {
    const e = await env('parking');
    const red = (await e.req('GET', `/v1/parking/control/KN-0999-DM?zoneId=${PARKING_DEMO.zoneGombe}`, 'pk-controleur')).json();
    e.clock.advanceHours(1);
    const r = await e.req('POST', '/v1/parking/evidence-photos', 'pk-controleur', { checkId: red.checkId, slot: 'AVANT', ...jpeg(), ...GPS, stampedAt: e.clock.now().toISOString() });
    expect(r.json().code).toBe('CHECK_TOO_OLD');
  });
});

describe('Pénalités visibles : module stationnement, puis tous modules après 30 jours d’impayé', () => {
  it('au contrôle de la plaque, les agents du module voient les pénalités ; après 30 jours, tout agent qui contrôle les voit (sans montant)', async () => {
    const e = await env();
    const v = (await e.req('GET', '/v1/parking/violations?status=VERIFIE', 'pk-regie')).json().items.find((x: { plate: string }) => x.plate === PARKING_DEMO.plateTenant);
    const d = (await e.req('POST', `/v1/parking/violations/${v.id}/decide`, 'pk-autorite', { outcome: 'RETENUE', reason: 'Photographies probantes.' })).json();
    const obId = d.obligation.id;

    const ctl = (await e.req('GET', `/v1/parking/control/${PARKING_DEMO.plateTenant}?zoneId=${PARKING_DEMO.zoneGombe}`, 'pk-controleur')).json();
    expect(ctl.penaltiesUnpaid).toBe(1);
    expect(ctl.penalties[0]).toMatchObject({ reference: v.reference, unpaid: true, amount: { amount: '20000.00', currency: 'CDF' }, module: 'STATIONNEMENT' });
    const list = (await e.req('GET', `/v1/parking/penalties?plate=${PARKING_DEMO.plateTenant}`, 'pk-superviseur')).json().items;
    expect(list).toHaveLength(1);
    expect((await e.req('GET', `/v1/parking/penalties?plate=${PARKING_DEMO.plateTenant}`, 'u-contribuable')).statusCode).toBe(403);

    const place = { commune: 'Gombe', label: 'Boulevard du 30 Juin' };
    const titresControl = () => e.req('POST', '/v1/titres/controles', 'rk-controleur', { plate: PARKING_DEMO.plateTenant, place });
    // Avant 30 jours : rien hors du module.
    expect((await titresControl()).json().penalitesImpayees).toBeUndefined();
    e.clock.advance(31 * 86_400_000);
    const after = (await titresControl()).json();
    expect(after.penalitesImpayees).toMatchObject({ count: 1, thresholdDays: 30 });
    expect(after.penalitesImpayees.lines[0]).toMatchObject({ module: 'STATIONNEMENT', reference: v.reference });
    expect(after.penalitesImpayees.lines[0].overdueDays).toBeGreaterThanOrEqual(31);
    expect(JSON.stringify(after.penalitesImpayees)).not.toMatch(/20000|amount/);
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

    // Paiement généré : session ouverte dans l'heure qui suit le contrôle rouge de l'agent.
    const plate = 'KN-0661-TS';
    await e.req('POST', '/v1/parking/vehicles', 'u-contribuable', { plate });
    expect((await e.req('GET', `/v1/parking/control/${plate}?zoneId=${PARKING_DEMO.zoneGombe}`, 'pk-controleur')).json().light).toBe('ROUGE');
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
