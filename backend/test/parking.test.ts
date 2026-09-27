import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { sha256Hex } from '../src/core/crypto.js';
import { parkingPlugin } from '../src/plugins/parking/plugin.js';
import { PARKING_DEMO } from '../src/plugins/parking/seed.js';
import { callbackBody, PROVIDER_SECRET, signedCallback, type TestEnv } from './helpers.js';

async function setupParking(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} },
    plugins: [parkingPlugin],
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

/** Paiement par le circuit commun : ordre de paiement (usager) puis rappel signé du prestataire. */
async function pay(env: TestEnv, user: string, obligationId: string) {
  const order = await env.req('POST', `/v1/obligations/${obligationId}/payment-orders`, user, { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() });
  expect(order.statusCode).toBe(201);
  const o = order.json();
  const cb = await signedCallback(env, callbackBody(env, o.paymentReference, o.amount));
  expect(cb.json().status).toBe('CONFIRME');
  return cb.json();
}


describe('ParkSmart — zones et statut d’acte', () => {
  it('les zones proposées restent ACTE_REQUIS ; seules les zones liées à une règle ACTIVE sont ouvertes', async () => {
    const env = await setupParking();
    const res = await env.req('GET', '/v1/parking/zones', 'u-contribuable');
    expect(res.statusCode).toBe(200);
    const zones = res.json().items as { id: string; legalStatus: string; demo: boolean }[];
    expect(zones.find((z) => z.id === PARKING_DEMO.zoneGombeReal)!.legalStatus).toBe('ACTE_REQUIS');
    expect(zones.find((z) => z.id === PARKING_DEMO.zone30Juin)!.legalStatus).toBe('ACTE_REQUIS');
    expect(zones.find((z) => z.id === PARKING_DEMO.zoneGombe)).toMatchObject({ legalStatus: 'OUVERTE', demo: true });
    expect(res.json().overbookingEnabled).toBe(false);

    const refused = await env.req('POST', '/v1/parking/sessions', 'u-contribuable', { zoneId: PARKING_DEMO.zoneGombeReal, plate: 'KN-0009-DM', durationMinutes: 60 }, { 'idempotency-key': randomUUID() });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe('ZONE_ACT_REQUIRED');
  });

  it('la régie crée une zone (ACTE_REQUIS), y rattache la grille publiée, puis la suspend avec motif', async () => {
    const env = await setupParking();
    const body = {
      code: 'TEST-KALAMU', name: 'Secteur test Kalamu', commune: 'Kalamu', quartier: 'Matonge', kind: 'SECTEUR',
      geometry: { type: 'Polygon', coordinates: [[15.31, -4.33], [15.32, -4.33], [15.32, -4.34]] }, localityRank: 2,
      capacity: { standard: 10, livraison: 1, pmr: 1 },
    };
    expect((await env.req('POST', '/v1/parking/zones', 'u-contribuable', body)).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/parking/zones', 'pk-regie', { ...body, commune: 'Atlantis' })).json().code).toBe('UNKNOWN_COMMUNE');
    const created = await env.req('POST', '/v1/parking/zones', 'pk-regie', body);
    expect(created.statusCode).toBe(201);
    expect(created.json().legalStatus).toBe('ACTE_REQUIS');
    const id = created.json().id;
    expect((await env.req('POST', `/v1/parking/zones/${id}/tariff`, 'pk-regie', { tariffRuleCode: 'INCONNUE-X', actReference: 'Acte test' })).json().code).toBe('UNKNOWN_RULE');
    const linked = await env.req('POST', `/v1/parking/zones/${id}/tariff`, 'pk-regie', { tariffRuleCode: PARKING_DEMO.tariffRule, actReference: 'Acte FICTIF test' });
    expect(linked.json().legalStatus).toBe('OUVERTE');
    const susp = await env.req('POST', `/v1/parking/zones/${id}/suspension`, 'pk-regie', { suspended: true, reason: 'Chantier de voirie (test)' });
    expect(susp.json().legalStatus).toBe('SUSPENDUE');
    const s = await env.req('POST', '/v1/parking/sessions', 'u-contribuable', { zoneId: id, plate: 'KN-0009-DM', durationMinutes: 60 }, { 'idempotency-key': randomUUID() });
    expect(s.json().code).toBe('ZONE_SUSPENDED');
    expect(env.app.ctx.audit.list({ limit: 100000 }).items.some((r) => r.action === 'parking.zone.suspended' && r.details.reason === 'Chantier de voirie (test)')).toBe(true);
  });
});

describe('ParkSmart — session payée au temps', () => {
  it('démarrer (idempotent) → payer par le circuit commun → ACTIVE, attribuée à la commune de la zone', async () => {
    const env = await setupParking();
    const key = randomUUID();
    const body = { zoneId: PARKING_DEMO.zoneLimete, plate: 'kn 0009 dm', durationMinutes: 60 };
    const before = env.app.ctx.assessment.obligations.count();
    const r1 = await env.req('POST', '/v1/parking/sessions', 'u-contribuable', body, { 'idempotency-key': key });
    expect(r1.statusCode).toBe(201);
    const { session, obligation } = r1.json();
    expect(session).toMatchObject({ plate: 'KN-0009-DM', status: 'EN_ATTENTE_PAIEMENT', light: 'ROUGE' });
    // Grille fictive rang 2 : 1000 CDF l'heure.
    expect(obligation.amount).toEqual({ amount: '1000.00', currency: 'CDF' });
    expect(obligation.commune).toBe('Limete');
    const r2 = await env.req('POST', '/v1/parking/sessions', 'u-contribuable', body, { 'idempotency-key': key });
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(r2.json().session.id).toBe(session.id);
    expect(env.app.ctx.assessment.obligations.count()).toBe(before + 1);
    expect((await env.req('POST', '/v1/parking/sessions', 'u-contribuable', body)).json().code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    await pay(env, 'u-contribuable', obligation.id);
    const after = (await env.req('GET', `/v1/parking/sessions/${session.id}`, 'u-contribuable')).json();
    expect(after).toMatchObject({ status: 'ACTIVE', light: 'VERT', remainingMinutes: 60 });
    expect(after.paidUntil).toBe('2026-09-26T10:00:00.000Z');
    const ob = env.app.ctx.assessment.get(obligation.id);
    expect(ob.attribution).toMatchObject({ commune: 'Limete', basis: 'LIEU_OBJET' });
    expect(ob.beneficiaryAccountAlias).toBe('KIN-DGTK-RECETTES-01');
    // Un autre usager ne lit pas la session.
    expect((await env.req('GET', `/v1/parking/sessions/${session.id}`, 'u-locataire')).statusCode).toBe(403);
  });

  it('prolongation, rappel ambre avant expiration (une seule fois), expiration, fin de session', async () => {
    const env = await setupParking();
    const start = await env.req('POST', '/v1/parking/sessions', 'u-contribuable', { zoneId: PARKING_DEMO.zoneLimete, plate: 'KN-0009-DM', durationMinutes: 30 }, { 'idempotency-key': randomUUID() });
    const { session, obligation } = start.json();
    await pay(env, 'u-contribuable', obligation.id);
    const ext = await env.req('POST', `/v1/parking/sessions/${session.id}/extend`, 'u-contribuable', { durationMinutes: 30 }, { 'idempotency-key': randomUUID() });
    expect(ext.statusCode).toBe(201);
    expect(ext.json().session.pendingPayment).toBe(ext.json().obligation.id);
    expect((await env.req('POST', `/v1/parking/sessions/${session.id}/extend`, 'u-contribuable', { durationMinutes: 15 }, { 'idempotency-key': randomUUID() })).json().code).toBe('EXTENSION_PENDING');
    await pay(env, 'u-contribuable', ext.json().obligation.id);
    let s = (await env.req('GET', `/v1/parking/sessions/${session.id}`, 'u-contribuable')).json();
    expect(s.paidUntil).toBe('2026-09-26T10:00:00.000Z');

    env.clock.advance(52 * 60_000);
    const mine = (await env.req('GET', '/v1/parking/sessions/mine', 'u-contribuable')).json().items;
    s = mine.find((x: { id: string }) => x.id === session.id);
    expect(s.light).toBe('AMBRE');
    const reminders = () => env.app.ctx.comms.deliveries.all().filter((d) => d.eventCode === 'ticket.expiring').length;
    const n = reminders();
    expect(n).toBeGreaterThan(0);
    await env.req('GET', '/v1/parking/sessions/mine', 'u-contribuable');
    expect(reminders()).toBe(n);

    env.clock.advance(10 * 60_000);
    s = (await env.req('GET', `/v1/parking/sessions/${session.id}`, 'u-contribuable')).json();
    expect(s.status).toBe('EXPIREE');
    expect((await env.req('POST', `/v1/parking/sessions/${session.id}/extend`, 'u-contribuable', { durationMinutes: 15 }, { 'idempotency-key': randomUUID() })).json().code).toBe('SESSION_NOT_ACTIVE');
    const ctl = (await env.req('GET', `/v1/parking/control/KN-0009-DM?zoneId=${PARKING_DEMO.zoneLimete}`, 'pk-controleur')).json();
    expect(ctl.light).toBe('ROUGE');

    const other = await env.req('POST', '/v1/parking/sessions', 'u-contribuable', { zoneId: PARKING_DEMO.zoneLimete, plate: 'KN-0010-DM', durationMinutes: 60 }, { 'idempotency-key': randomUUID() });
    await pay(env, 'u-contribuable', other.json().obligation.id);
    const ended = await env.req('POST', `/v1/parking/sessions/${other.json().session.id}/end`, 'u-contribuable');
    expect(ended.json().status).toBe('TERMINEE');
  });

  it('durées invalides, durée maximale de la zone et session déjà en cours', async () => {
    const env = await setupParking();
    const post = (b: unknown) => env.req('POST', '/v1/parking/sessions', 'u-contribuable', b, { 'idempotency-key': randomUUID() });
    expect((await post({ zoneId: PARKING_DEMO.zoneGombe, plate: 'KN-0011-DM', durationMinutes: 20 })).json().code).toBe('INVALID_DURATION');
    expect((await post({ zoneId: PARKING_DEMO.zoneGombe, plate: 'KN-0011-DM', durationMinutes: 300 })).json().code).toBe('MAX_DURATION_EXCEEDED');
    expect((await post({ zoneId: PARKING_DEMO.zoneGombe, plate: '??', durationMinutes: 60 })).statusCode).toBe(400);
    expect((await post({ zoneId: PARKING_DEMO.zoneGombe, plate: PARKING_DEMO.plateOwner, durationMinutes: 60 })).json().code).toBe('SESSION_ALREADY_RUNNING');
    // Un agent ne peut ni acheter ni encaisser.
    expect((await env.req('POST', '/v1/parking/sessions', 'pk-controleur', { zoneId: PARKING_DEMO.zoneGombe, plate: 'KN-0011-DM', durationMinutes: 60 }, { 'idempotency-key': randomUUID() })).statusCode).toBe(403);
  });
});

describe('ParkSmart — contrôle par plaque et constat humain (RW1)', () => {
  it('contrôle : résultat minimal sans donnée nominative, journalisé ; refusé hors habilitation', async () => {
    const env = await setupParking();
    const res = await env.req('GET', `/v1/parking/control/${PARKING_DEMO.plateOwner}?zoneId=${PARKING_DEMO.zoneGombe}`, 'pk-controleur');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ plate: PARKING_DEMO.plateOwner, light: 'VERT', title: 'SESSION' });
    const text = JSON.stringify(body);
    expect(text).not.toContain('Mbuyi');
    expect(text).not.toContain('TP-DEMO');
    expect(env.app.ctx.audit.list({ limit: 100000 }).items.some((r) => r.action === 'parking.control.checked' && r.resourceId === PARKING_DEMO.plateOwner)).toBe(true);
    expect((await env.req('GET', `/v1/parking/control/${PARKING_DEMO.plateOwner}`, 'u-contribuable')).statusCode).toBe(403);
    expect((await env.req('GET', `/v1/parking/control/${PARKING_DEMO.plateOwner}?zoneId=${PARKING_DEMO.zoneGombe}`, 'u-agent-terrain')).statusCode).toBe(403);
  });

  it('un rouge au contrôle ne crée AUCUNE obligation ; le constat exige une photographie et ne vise pas un titre valide', async () => {
    const env = await setupParking();
    const obligations = env.app.ctx.assessment.obligations.count();
    const red = (await env.req('GET', `/v1/parking/control/KN-0888-DM?zoneId=${PARKING_DEMO.zoneGombe}`, 'pk-controleur')).json();
    expect(red.light).toBe('ROUGE');
    expect(env.app.ctx.assessment.obligations.count()).toBe(obligations);
    // Photo prise par la caméra de preuve, rattachée au contrôle rouge (image conservée au serveur).
    const img = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from('photo-test-abords'), Buffer.from([0xff, 0xd9])]);
    const photo = sha256Hex(img);
    const up = await env.req('POST', '/v1/parking/evidence-photos', 'pk-controleur', {
      checkId: red.checkId, slot: 'ABORDS_AVANT', imageBase64: img.toString('base64'), sha256: photo,
      lat: -4.3, lon: 15.3, accuracyM: 6, gpsSource: 'GPS', place: 'Secteur de test', stampedAt: env.clock.now().toISOString(),
    });
    expect(up.statusCode, up.body).toBe(201);
    const base = { zoneId: PARKING_DEMO.zoneGombe, plate: 'KN-0888-DM', nature: 'NON_PAIEMENT', checkId: red.checkId, lat: -4.3, lon: 15.3, observations: 'Test de constat' };
    // Sans photo de la caméra, sans contrôle, ou avec de simples empreintes déclarées : refusé.
    expect((await env.req('POST', '/v1/parking/violations', 'pk-controleur', { ...base, photoIds: [] })).statusCode).toBe(400);
    expect((await env.req('POST', '/v1/parking/violations', 'pk-controleur', { ...base, checkId: undefined, photoIds: [up.json().id] })).statusCode).toBe(400);
    expect((await env.req('POST', '/v1/parking/violations', 'pk-controleur', { ...base, photoSha256: [photo] })).statusCode).toBe(400);
    // Contrôle vert (titre valide) : aucun constat possible.
    const green = (await env.req('GET', `/v1/parking/control/${PARKING_DEMO.plateOwner}?zoneId=${PARKING_DEMO.zoneGombe}`, 'pk-controleur')).json();
    expect((await env.req('POST', '/v1/parking/violations', 'pk-controleur', { ...base, plate: PARKING_DEMO.plateOwner, checkId: green.checkId, photoIds: [up.json().id] })).json().code).toBe('CHECK_NOT_RED');
    // Contrôle d'un autre agent, autre zone, contrôle trop ancien : refusés.
    expect((await env.req('POST', '/v1/parking/violations', 'u-agent-terrain', { ...base, photoIds: [up.json().id] })).statusCode).toBe(403);
    env.app.ctx.users.add({ id: 'pk-controleur-2', name: 'Second contrôleur (test)', roles: ['R11'], entity: 'DGTK', territory: ['Gombe'] });
    expect((await env.req('POST', '/v1/parking/violations', 'pk-controleur-2', { ...base, photoIds: [up.json().id] })).json().code).toBe('NOT_CHECK_AGENT');
    expect((await env.req('POST', '/v1/parking/violations', 'pk-controleur', { ...base, zoneId: PARKING_DEMO.zoneLimete, photoIds: [up.json().id] })).json().code).toBe('CHECK_ZONE_MISMATCH');
    const ok = await env.req('POST', '/v1/parking/violations', 'pk-controleur', { ...base, photoIds: [up.json().id] });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ status: 'CONSTATE', lightAtCheck: 'ROUGE', holderIdentified: false, checkId: red.checkId });
    expect(ok.json().evidence.photoSha256).toEqual([photo]);
    // Un seul constat par contrôle.
    expect((await env.req('POST', '/v1/parking/violations', 'pk-controleur', { ...base, photoIds: [up.json().id] })).json().code).toBe('CHECK_ALREADY_USED');
    const late = (await env.req('GET', `/v1/parking/control/KN-0889-DM?zoneId=${PARKING_DEMO.zoneGombe}`, 'pk-controleur')).json();
    env.clock.advance(31 * 60_000);
    expect((await env.req('POST', '/v1/parking/violations', 'pk-controleur', { ...base, plate: 'KN-0889-DM', checkId: late.checkId, photoIds: ['PKP-X'] })).json().code).toBe('CHECK_TOO_OLD');
    expect(env.app.ctx.assessment.obligations.count()).toBe(obligations);
    // Aucune route de fourrière, de blocage ni de modification d'un constat.
    expect((await env.req('POST', `/v1/parking/violations/${ok.json().id}/impound`, 'pk-autorite', {})).statusCode).toBe(404);
    expect((await env.req('POST', '/v1/parking/clamps', 'pk-autorite', {})).statusCode).toBe(404);
    // Un agent ne crée jamais d'ordre de paiement (aucun encaissement).
    const anyOb = env.app.ctx.assessment.obligations.all()[0]!;
    expect((await env.req('POST', `/v1/obligations/${anyOb.id}/payment-orders`, 'pk-controleur', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).statusCode).toBe(403);
  });

  it('vérification puis décision motivée par des personnes distinctes ; pénalité selon le barème actif ; recours par le circuit commun', async () => {
    const env = await setupParking();
    const list = (await env.req('GET', '/v1/parking/violations?status=VERIFIE', 'pk-regie')).json().items;
    const v = list.find((x: { plate: string }) => x.plate === PARKING_DEMO.plateTenant);
    expect(v.proposal).toMatchObject({ status: 'PROPOSEE', amount: { amount: '20000.00', currency: 'CDF' } });
    expect(v.obligation).toBeNull();
    // Le contrôleur ne décide pas.
    expect((await env.req('POST', `/v1/parking/violations/${v.id}/decide`, 'pk-controleur', { outcome: 'RETENUE', reason: 'Décision test' })).statusCode).toBe(403);
    // Contestation avant décision par le titulaire déclaré ; un tiers est refusé.
    expect((await env.req('POST', `/v1/parking/violations/${v.id}/contest`, 'u-contribuable', { grounds: 'Je ne suis pas concerné par ce constat.' })).statusCode).toBe(403);
    const c1 = await env.req('POST', `/v1/parking/violations/${v.id}/contest`, 'u-locataire', { grounds: 'Je livrais un colis, arrêt de deux minutes.' });
    expect(c1.statusCode).toBe(201);
    expect(c1.json().contests[0].stage).toBe('AVANT_DECISION');

    const decided = await env.req('POST', `/v1/parking/violations/${v.id}/decide`, 'pk-autorite', { outcome: 'RETENUE', reason: 'Photographies probantes ; observations examinées.' });
    expect(decided.statusCode).toBe(200);
    const d = decided.json();
    expect(d.status).toBe('RETENU');
    expect(d.decision.by).toBe('pk-autorite');
    expect(d.obligation).toMatchObject({ amount: { amount: '20000.00', currency: 'CDF' }, commune: 'Gombe' });
    const ob = env.app.ctx.assessment.get(d.obligation.id);
    expect(ob.createdBy).toBe('pk-autorite');
    expect(env.app.ctx.comms.deliveries.all().some((x) => x.eventCode === 'inspection.report.issued')).toBe(true);

    const mine = (await env.req('GET', '/v1/parking/violations/mine', 'u-locataire')).json().items;
    expect(mine.some((x: { id: string }) => x.id === v.id)).toBe(true);
    const c2 = await env.req('POST', `/v1/parking/violations/${v.id}/contest`, 'u-locataire', { grounds: 'Je conteste la pénalité : arrêt pour livraison.' });
    expect(c2.statusCode).toBe(201);
    const appealId = c2.json().contests[1].appealId;
    expect(env.app.ctx.appeals.get(appealId).obligationId).toBe(d.obligation.id);
  });

  it('constat sans titulaire identifié : décision tracée sans obligation ; décision avant vérification refusée', async () => {
    const env = await setupParking();
    const pending = (await env.req('GET', '/v1/parking/violations?status=CONSTATE', 'pk-superviseur')).json().items[0];
    expect((await env.req('POST', `/v1/parking/violations/${pending.id}/decide`, 'pk-regie', { outcome: 'RETENUE', reason: 'Trop tôt pour décider' })).json().code).toBe('VIOLATION_NOT_VERIFIED');
    await env.req('POST', `/v1/parking/violations/${pending.id}/verify`, 'pk-superviseur', { confirm: true, note: 'Photographie nette.' });
    const before = env.app.ctx.assessment.obligations.count();
    const d = (await env.req('POST', `/v1/parking/violations/${pending.id}/decide`, 'pk-regie', { outcome: 'RETENUE', reason: 'Constat probant.' })).json();
    expect(d.decision.obligationId).toBeNull();
    expect(d.decision.effect).toContain('non identifié');
    expect(env.app.ctx.assessment.obligations.count()).toBe(before);
  });
});

describe('ParkSmart — réservations, partenaires, indicateurs', () => {
  it('réservation de voirie : demande, décision motivée, liquidation, aucune surréservation', async () => {
    const env = await setupParking();
    const mk = (places: number) => env.req('POST', '/v1/parking/reservations', 'pk-marchand', {
      zoneId: PARKING_DEMO.zoneGombe, purpose: 'DEMENAGEMENT', places, startAt: '2026-09-28T08:00:00.000Z', endAt: '2026-09-28T10:00:00.000Z', plate: 'KN-0100-DM',
    });
    const r1 = await mk(30);
    expect(r1.statusCode).toBe(201);
    expect((await env.req('POST', `/v1/parking/reservations/${r1.json().id}/decide`, 'pk-marchand', { approve: true, reason: 'auto-approbation' })).statusCode).toBe(403);
    const ok = await env.req('POST', `/v1/parking/reservations/${r1.json().id}/decide`, 'pk-regie', { approve: true, reason: 'Déménagement justifié.' });
    expect(ok.json()).toMatchObject({ status: 'APPROUVEE', state: 'EN_ATTENTE_PAIEMENT' });
    // 120 min × 30 places × 2000 CDF / h
    expect(ok.json().amount).toEqual({ amount: '120000.00', currency: 'CDF' });
    const r2 = await mk(20);
    const refused = await env.req('POST', `/v1/parking/reservations/${r2.json().id}/decide`, 'pk-regie', { approve: true, reason: 'Tentative au-delà de la capacité' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('CAPACITY_EXCEEDED');
    await pay(env, 'pk-marchand', ok.json().obligationId);
    const mine = (await env.req('GET', '/v1/parking/reservations/mine', 'pk-marchand')).json().items;
    expect(mine.find((x: { id: string }) => x.id === r1.json().id).state).toBe('CONFIRMEE');
    expect((await env.req('POST', '/v1/parking/reservations', 'pk-marchand', { zoneId: PARKING_DEMO.zoneGombe, purpose: 'CHANTIER', places: 1, startAt: '2026-09-20T08:00:00.000Z', endAt: '2026-09-20T09:00:00.000Z' })).json().code).toBe('RESERVATION_IN_PAST');
  });

  it('partenaires : places libres déclarées par l’exploitant seulement', async () => {
    const env = await setupParking();
    const p = (await env.req('GET', '/v1/parking/partners', 'u-contribuable')).json().items.find((x: { kind: string }) => x.kind === 'PARKING_PRIVE');
    expect(p.declaredFree.places).toBe(34);
    expect(p.operatorTaxpayerId).toBeUndefined();
    expect((await env.req('POST', `/v1/parking/partners/${p.id}/occupancy`, 'u-contribuable', { freePlaces: 3 })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/parking/partners/${p.id}/occupancy`, 'pk-marchand', { freePlaces: 10 })).json().declaredFree.places).toBe(10);
  });

  it('indicateurs agrégés : occupation, rotation, recettes par zone, conformité ; aucune donnée nominative', async () => {
    const env = await setupParking();
    expect((await env.req('GET', '/v1/parking/indicators', 'u-contribuable')).statusCode).toBe(403);
    const res = await env.req('GET', '/v1/parking/indicators', 'pk-regie');
    expect(res.statusCode).toBe(200);
    const ind = res.json();
    const gombe = ind.zones.find((z: { zoneId: string }) => z.zoneId === PARKING_DEMO.zoneGombe);
    expect(gombe.activeSessions).toBe(1);
    expect(gombe.occupancyRate).toBe('2.5');
    expect(gombe.freeTarget).toBe('SOUS_UTILISE');
    expect(gombe.revenue).toEqual([{ amount: '4000.00', currency: 'CDF' }]);
    expect(gombe.revenuePerPlace).toEqual([{ amount: '100.00', currency: 'CDF' }]);
    expect(gombe.checks).toBe(3);
    expect(gombe.complianceRate).toBe('33.3');
    const limete = ind.zones.find((z: { zoneId: string }) => z.zoneId === PARKING_DEMO.zoneLimete);
    expect(limete.revenue).toEqual([{ amount: '4000.00', currency: 'CDF' }]);
    expect(ind.totals.actRequiredZones).toBe(2);
    expect(ind.safeguards).toEqual({ overbookingEnabled: false, automaticPenalty: false, automaticImpoundOrClamp: false, cashCollectionByAgents: false });
    expect(ind.byCommune.map((c: { commune: string }) => c.commune)).toEqual(['Gombe', 'Limete']);
    const text = JSON.stringify(ind);
    expect(text).not.toMatch(/KN-\d{4}-DM/);
    expect(text).not.toContain('Mbuyi');
    expect((await env.req('GET', '/v1/parking/indicators', 'u-gouverneur')).statusCode).toBe(200);
  });

  it('le journal d’audit reste intègre après tout le parcours', async () => {
    const env = await setupParking();
    expect(env.app.ctx.audit.verify().ok).toBe(true);
  });
});
