/**
 * Fraude des agents autour de la commission de 10 % : chaque test rejoue une attaque vérifiée et constate qu'elle
 * échoue (publicité rejetée, constat terrain rejeté, contrôles « de loin », premier contrôle à heure déclarée,
 * signaux sans suite, conflit d'intérêts, droits jamais liquidés, clé de terminal prévisible).
 */
import { agentRattache } from '@mosolo/shared';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { sha256Hex } from '../src/core/crypto.js';
import type { ParkingService } from '../src/plugins/parking/service.js';
import { PARKING_DEMO } from '../src/plugins/parking/seed.js';
import { publishDemoRule, DEMO_INSTRUMENT, DGTK, DGTK_ALIAS } from '../src/plugins/parking/support.js';
import { AD_MOBILE_TAX_RULE, type PubliciteService } from '../src/plugins/publicite/service.js';
import { PUB_DEMO } from '../src/plugins/publicite/seed.js';
import type { SanctionsService } from '../src/plugins/sanctions/service.js';
import type { CommissionLine } from '../src/plugins/sanctions/commissions.js';
import type { TerrainService } from '../src/plugins/terrain/service.js';
import { seedDeviceKey } from '../src/plugins/terrain/service.js';
import type { TitresService } from '../src/plugins/titres/service.js';
import type { VerticalesService } from '../src/plugins/verticales/service.js';
import { callbackBody, PROVIDER_SECRET, signedCallback, type TestEnv } from './helpers.js';

async function env(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} } });
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

async function pay(e: TestEnv, user: string, obligationId: string) {
  const order = await e.req('POST', `/v1/obligations/${obligationId}/payment-orders`, user, { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() });
  expect(order.statusCode, order.body).toBe(201);
  const o = order.json();
  const cb = await signedCallback(e, callbackBody(e, o.paymentReference, o.amount));
  expect(cb.json().status).toBe('CONFIRME');
  return o as { id: string; paymentReference: string };
}

const sanctions = (e: TestEnv) => e.app.ctx.ext.sanctions as SanctionsService;
const lines = (e: TestEnv, obligationId: string): CommissionLine[] => sanctions(e).commissions.lines().filter((l) => l.obligationId === obligationId);
const jpeg = () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(400), Buffer.from([0xff, 0xd9])]);
  return { imageBase64: buf.toString('base64'), sha256: sha256Hex(buf) };
};
/** Point à l'intérieur de la zone de démonstration de Gombe. */
const IN_GOMBE = { lat: -4.3055, lon: 15.309 };

describe('1. Publicité : commission seulement sur un dossier RETENU ; photos conservées au serveur', () => {
  it('constat rejeté par le vérificateur, empreintes inventées : le paiement des droits ne rapporte rien', async () => {
    const e = await env();
    const pub = e.app.ctx.ext.publicite as PubliciteService;
    // Chevalet autorisé, droits impayés : l'inspecteur « constate » un défaut avec une empreinte inventée.
    const chevalet = pub.devices.all().find((d) => d.type === 'CHEVALET')!;
    const obId = pub.currentAuthorization(chevalet)!.liquidation!.obligationId!;
    const r = await e.req('POST', '/v1/publicite/inspections', 'pb-inspecteur', {
      deviceId: chevalet.id, finding: 'NON_CONFORME', photos: [sha256Hex('fausse-photo')], lat: chevalet.lat, lon: chevalet.lon, gpsAccuracyM: 5, observations: 'Chevalet débordant (attaque).',
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().inspection).toMatchObject({ serverPhotoIds: [], weakEvidence: true });
    expect(r.json().case.inspection).toMatchObject({ serverPhotos: [], weakEvidence: true });
    const rej = await e.req('POST', `/v1/publicite/cases/${r.json().case.id}/verify`, 'pb-superviseur', { confirm: false, note: 'Aucune image : preuve insuffisante.' });
    expect(rej.json().status).toBe('REJETE_QA');
    e.clock.advance(3_600_000);
    await pay(e, 'pb-annonceur', obId);
    expect(lines(e, obId)).toHaveLength(0);
  });

  it('photo versée au serveur (JPEG, empreinte vérifiée) : preuve forte ; empreinte altérée refusée ; image relue par le vérificateur', async () => {
    const e = await env();
    const pub = e.app.ctx.ext.publicite as PubliciteService;
    const img = jpeg();
    const bad = await e.req('POST', '/v1/publicite/evidence-photos', 'pb-inspecteur', { ...img, sha256: sha256Hex('autre'), lat: -4.3, lon: 15.3, accuracyM: 5, gpsSource: 'GPS', stampedAt: e.clock.now().toISOString() });
    expect(bad.json().code).toBe('PHOTO_HASH_MISMATCH');
    expect((await e.req('POST', '/v1/publicite/evidence-photos', 'pb-inspecteur-2', { ...img, lat: -4.3, lon: 15.3, accuracyM: 5, gpsSource: 'GPS', stampedAt: e.clock.now().toISOString() })).json().code).toBe('NOT_ACCREDITED');
    const up = await e.req('POST', '/v1/publicite/evidence-photos', 'pb-inspecteur', { ...img, lat: -4.3, lon: 15.3, accuracyM: 5, gpsSource: 'GPS', stampedAt: e.clock.now().toISOString() });
    expect(up.statusCode, up.body).toBe(201);
    const chevalet = pub.devices.all().find((d) => d.type === 'CHEVALET')!;
    const r = (await e.req('POST', '/v1/publicite/inspections', 'pb-inspecteur', {
      deviceId: chevalet.id, finding: 'NON_CONFORME', photos: [img.sha256], lat: chevalet.lat, lon: chevalet.lon, gpsAccuracyM: 5, gpsSource: 'GPS', observations: 'Chevalet débordant.',
    })).json();
    expect(r.inspection).toMatchObject({ serverPhotoIds: [up.json().id], weakEvidence: false });
    expect(r.case.inspection.serverPhotos).toHaveLength(1);
    const img2 = await e.req('GET', r.case.inspection.serverPhotos[0].url, 'pb-superviseur');
    expect(img2.statusCode).toBe(200);
    expect(img2.headers['x-mosolo-sha256']).toBe(img.sha256);
    // Une même image ne sert pas deux fois.
    expect((await e.req('POST', '/v1/publicite/evidence-photos', 'pb-inspecteur', { ...img, lat: -4.3, lon: 15.3, accuracyM: 5, gpsSource: 'GPS', stampedAt: e.clock.now().toISOString() })).json().code).toBe('PHOTO_DUPLICATE');
  });
});

describe('2. Terrain : constat VALIDÉ, avec photo, sur une dette échue et impayée à la capture', () => {
  const setupFinding = async (overdue: boolean) => {
    const e = await env();
    const te = e.app.ctx.ext.terrain as TerrainService;
    const ob = e.app.ctx.assessment.obligations.find((o) => o.objectId === 'OBJ-DEMO-PARCELLE-01')[0]!;
    if (overdue) e.app.ctx.assessment.obligations.update({ ...ob, dueDate: '2026-09-20' });
    const base = te.findings.all().find((f) => f.objectId === 'OBJ-DEMO-PARCELLE-01')!;
    const now = e.clock.now().toISOString();
    const variant = (id: string, agentId: string, status: 'VALIDE' | 'REJETE', photo: boolean) => {
      const { photoSha256: _p, ...rest } = base;
      te.findings.insert({ ...rest, id, clientRef: id, agentId, status, capturedAt: now, receivedAt: now, ...(photo ? { photoSha256: sha256Hex(id) } : {}) });
    };
    return { e, ob, variant };
  };

  it('constat rejeté et sans photo sur une dette non échue : rien ; seul le constat validé, photographié, sur dette échue est payé', async () => {
    const a = await setupFinding(false);
    a.variant('T-F-REJ', 'test-agent-rejete', 'REJETE', false);
    a.variant('T-F-OK-NOT-DUE', 'test-agent-non-echue', 'VALIDE', true);
    a.e.clock.advance(3_600_000);
    await pay(a.e, 'u-contribuable', a.ob.id);
    expect(lines(a.e, a.ob.id).filter((l) => l.module === 'TERRAIN')).toHaveLength(0);

    const b = await setupFinding(true);
    b.variant('T-F-REJ', 'test-agent-rejete', 'REJETE', true);
    b.variant('T-F-NOPHOTO', 'test-agent-sans-photo', 'VALIDE', false);
    b.variant('T-F-OK', 'test-agent-valide', 'VALIDE', true);
    b.e.clock.advance(3_600_000);
    await pay(b.e, 'u-contribuable', b.ob.id);
    expect(lines(b.e, b.ob.id).filter((l) => l.module === 'TERRAIN').map((l) => l.agentId)).toEqual(['test-agent-valide']);
  });
});

describe('3. Contrôles « de loin » et paiements spontanés : présence GPS, délai de grâce, dettes échues seulement', () => {
  it('stationnement : sans GPS, loin de la zone, ou payé dans le délai de grâce → aucune commission ; présent et au-delà du délai → commission', async () => {
    const e = await env();
    const ctl = (plate: string, gps?: { lat: number; lon: number; accuracyM: number }) =>
      e.req('GET', `/v1/parking/control/${plate}?zoneId=${PARKING_DEMO.zoneGombe}${gps ? `&lat=${gps.lat}&lon=${gps.lon}&accuracyM=${gps.accuracyM}` : ''}`, 'pk-controleur').then((r) => r.json());
    const cases = {
      'KN-0701-TS': { gps: undefined, delay: 15 },
      'KN-0702-TS': { gps: { lat: -4.372, lon: 15.346, accuracyM: 5 }, delay: 15 }, // Limete : à des kilomètres
      'KN-0703-TS': { gps: { ...IN_GOMBE, accuracyM: 500 }, delay: 15 }, // précision insuffisante
      'KN-0704-TS': { gps: { ...IN_GOMBE, accuracyM: 8 }, delay: 5 }, // paiement à l'arrivée (délai de grâce)
      'KN-0705-TS': { gps: { ...IN_GOMBE, accuracyM: 8 }, delay: 12 },
    } as const;
    const t0 = e.clock.now().getTime();
    for (const [plate, c] of Object.entries(cases)) {
      const r = await ctl(plate, c.gps);
      expect(r.light).toBe('ROUGE');
      expect(r.presenceVerified).toBe(plate === 'KN-0704-TS' || plate === 'KN-0705-TS');
    }
    const obs: Record<string, string> = {};
    for (const [plate, c] of Object.entries(cases).sort((a, b) => a[1].delay - b[1].delay)) {
      e.clock.set(new Date(t0 + c.delay * 60_000).toISOString());
      const s = await e.req('POST', '/v1/parking/sessions', 'u-contribuable', { zoneId: PARKING_DEMO.zoneGombe, plate, durationMinutes: 60 }, { 'idempotency-key': randomUUID() });
      expect(s.statusCode, s.body).toBe(201);
      obs[plate] = s.json().obligation.id;
      await pay(e, 'u-contribuable', obs[plate]!);
    }
    const paid = (plate: string) => lines(e, obs[plate]!).filter((l) => l.source === 'PAIEMENT');
    for (const p of ['KN-0701-TS', 'KN-0702-TS', 'KN-0703-TS', 'KN-0704-TS']) expect(paid(p), p).toHaveLength(0);
    expect(paid('KN-0705-TS')).toHaveLength(1);
    expect(paid('KN-0705-TS')[0]!.agentId).toBe('pk-controleur');
  });

  it('verticales : une obligation non échue n’est pas « due » au scan ; un scan sans GPS ne rapporte rien', async () => {
    const e = await env();
    const vx = e.app.ctx.ext.verticales as VerticalesService;
    const obligations = e.app.ctx.assessment.obligations;
    // Agents rattachés au module des services de la Ville (rattachement des agents, 30/09/2026).
    const agents = e.app.ctx.users.all().filter((u) => u.roles.some((r) => r === 'R10' || r === 'R11') && u.territory?.length && agentRattache(u, 'VERTICALES'));
    const open = (objectId: string) => obligations.find((o) => o.objectId === objectId && o.status !== 'SOLDEE' && o.status !== 'ANNULEE' && o.status !== 'CONTESTEE' && e.app.ctx.payments.byObligation(o.id).length === 0);
    const plate = vx.plates.all().find((p) => p.status === 'POSEE' && agents.some((a) => a.territory!.includes(p.commune)) && open(p.objectId).length > 0)!;
    const scanner = agents.find((a) => a.territory!.includes(plate.commune))!.id;
    const late = open(plate.objectId)[0]!;
    // Une obligation échue ET une obligation à échoir sur le même objet.
    obligations.update({ ...late, dueDate: '2026-09-01' });
    const soon = open(plate.objectId).find((o) => o.id !== late.id) ?? obligations.insert({ ...late, id: `${late.id}-T2`, dueDate: '2026-12-31' });
    if (soon.dueDate <= '2026-09-26') obligations.update({ ...soon, dueDate: '2026-12-31' });
    const obj = e.app.ctx.objects.objects.get(plate.objectId)!;
    const scan = await e.req('GET', `/v1/verticales/plates/${plate.code}/scan?lat=${obj.lat}&lon=${obj.lon}&accuracyM=10`, scanner);
    expect(scan.json().situation.color).toBe('red');
    const rec = vx.scans.all().at(-1)!;
    expect(rec.presenceVerified).toBe(true);
    expect(rec.dueObligationIds).toContain(late.id);
    expect(rec.dueObligationIds).not.toContain(soon.id);
    e.clock.advance(3_600_000);
    const payer = e.app.ctx.users.all().find((u) => u.taxpayerId === soon.taxpayerId)!;
    await pay(e, payer.id, soon.id);
    expect(lines(e, soon.id).filter((l) => l.module === 'VERTICALES')).toHaveLength(0);

    // Scan rouge sans position : aucun droit à commission sur la dette échue.
    const e2 = await env();
    const vx2 = e2.app.ctx.ext.verticales as VerticalesService;
    const late2 = e2.app.ctx.assessment.obligations.get(late.id)!;
    e2.app.ctx.assessment.obligations.update({ ...late2, dueDate: '2026-09-01' });
    expect((await e2.req('GET', `/v1/verticales/plates/${plate.code}/scan`, scanner)).json().situation.color).toBe('red');
    expect(vx2.scans.all().at(-1)!.presenceVerified).toBe(false);
    e2.clock.advance(3_600_000);
    await pay(e2, payer.id, late.id);
    expect(lines(e2, late.id).filter((l) => l.module === 'VERTICALES')).toHaveLength(0);
  });
});

describe('4. « Premier contrôle » à l’heure du serveur ; attribution acquise figée', () => {
  it('contrôle hors ligne antidaté de 30 min et synchronisé tard : il ne prend pas le paiement ; une fois acquise, l’attribution ne bouge plus', async () => {
    const e = await env();
    const ti = e.app.ctx.ext.titres as TitresService;
    const c = ti.credentials.all().find((x) => x.holderTaxpayerId && x.state === 'EMIS')!;
    e.clock.set(new Date(Date.parse(c.validUntil) + 3_600_000).toISOString());
    const t0 = e.clock.now().getTime();
    const ctl = (await e.req('POST', '/v1/titres/controles', 'rk-controleur', { code: c.shortCode, ...(c.subject.plate ? { observedPlate: c.subject.plate } : {}), place: { commune: 'Kalamu', label: 'Rond-point Victoire' } })).json();
    expect(ctl.result).not.toBe('VALIDE');
    // Contrôle hors ligne d'un autre agent : heure déclarée 30 min AVANT, reçu 19 min APRÈS (avant le paiement).
    ti.controls.append({
      id: 'CTL-T-OFFLINE', method: 'CODE', credentialId: c.id, presented: c.shortCode, controllerId: 'test-hors-ligne', place: { commune: 'Kalamu', label: 'Test' },
      at: new Date(t0 - 30 * 60_000).toISOString(), offline: true, result: 'INVALIDE', displayStatus: 'EXPIRE', consumedUse: false, recordedAt: new Date(t0 + 19 * 60_000).toISOString(),
    } as unknown as Parameters<typeof ti.controls.append>[0]);
    e.clock.advance(20 * 60_000);
    const holder = e.app.ctx.users.all().find((u) => u.taxpayerId === c.holderTaxpayerId)!;
    const iss = ti.purchase(holder, { payerTaxpayerId: c.holderTaxpayerId!, channel: 'MOBILE_MONEY', items: [{ typeCode: c.typeCode, holderTaxpayerId: c.holderTaxpayerId!, subject: c.subject, place: c.place }] } as Parameters<TitresService['purchase']>[1]);
    const order = e.app.ctx.payments.byReference(iss.payments[0]!.paymentReference)!;
    expect((await signedCallback(e, callbackBody(e, order.paymentReference, order.amount))).json().status).toBe('CONFIRME');
    ti.sync();
    const mine = () => lines(e, order.obligationId).filter((l) => l.source === 'PAIEMENT');
    expect(mine().map((l) => l.agentId)).toEqual(['rk-controleur']);

    // Rapprochement : la commission est acquise et l'attribution figée.
    e.app.ctx.payments.orders.update({ ...e.app.ctx.payments.orders.get(order.id)!, status: 'RAPPROCHE' });
    expect(mine()[0]).toMatchObject({ agentId: 'rk-controleur', state: 'ACQUISE', frozen: true });
    expect(sanctions(e).commissions.frozen.get(order.id)?.agentId).toBe('rk-controleur');
    // Une synchronisation ultérieure (même classée plus tôt) ne déplace plus l'attribution.
    ti.controls.append({
      id: 'CTL-T-LATE-SYNC', method: 'CODE', credentialId: c.id, presented: c.shortCode, controllerId: 'test-resynchro', place: { commune: 'Kalamu', label: 'Test' },
      at: new Date(t0 - 10 * 60_000).toISOString(), offline: true, result: 'INVALIDE', displayStatus: 'EXPIRE', consumedUse: false, recordedAt: new Date(t0 - 10 * 60_000).toISOString(),
    } as unknown as Parameters<typeof ti.controls.append>[0]);
    expect(mine().map((l) => [l.agentId, l.state])).toEqual([['rk-controleur', 'ACQUISE']]);
  });
});

describe('5. Signaux → alertes ; contre-vérification aléatoire des constats retenus', () => {
  it('paiements systématiquement dans la minute du contrôle rouge : signal, une seule alerte par mois', async () => {
    const e = await env();
    const pk = e.app.ctx.ext.parking as ParkingService;
    const now = e.clock.now().toISOString();
    for (let i = 0; i < 3; i++) {
      const plate = `KN-08${i}1-TS`;
      pk.checks.append({ id: `T-CHK-IMM-${i}`, plate, zoneId: PARKING_DEMO.zoneGombe, commune: 'Gombe', light: 'ROUGE', title: null, agentId: 'pk-complice', at: now });
      e.clock.advance(60_000);
      expect((await e.req('POST', '/v1/parking/sessions', 'u-contribuable', { zoneId: PARKING_DEMO.zoneGombe, plate, durationMinutes: 60 }, { 'idempotency-key': randomUUID() })).statusCode).toBe(201);
    }
    const before = e.app.ctx.alerts.list().length;
    const r = (await e.req('GET', '/v1/agents/monitoring', 'pk-regie')).json();
    expect(r.rows.find((x: { agentId: string }) => x.agentId === 'pk-complice').signals.map((s: { code: string }) => s.code)).toContain('PAIEMENT_IMMEDIAT');
    const raised = e.app.ctx.alerts.list().filter((a) => a.type === 'AGENT_PAIEMENT_IMMEDIAT');
    expect(raised).toHaveLength(1);
    expect(raised[0]!.context).toMatchObject({ agentId: 'pk-complice', module: 'STATIONNEMENT' });
    const after = e.app.ctx.alerts.list().length;
    expect(after).toBeGreaterThan(before);
    // Nouveau calcul (tableau ou tâche planifiée) : pas de doublon.
    sanctions(e).monitoring.report();
    expect(e.app.ctx.alerts.list().length).toBe(after);
  });

  it('part de paiements générés très supérieure aux pairs : signal', async () => {
    const e = await env();
    const pk = e.app.ctx.ext.parking as ParkingService;
    const now = e.clock.now().toISOString();
    const fake = new Map<string, CommissionLine[]>();
    for (const [agent, gen] of [['pk-pair-1', 1], ['pk-pair-2', 1], ['pk-gen', 5]] as const) {
      for (let i = 0; i < 5; i++) pk.checks.append({ id: `T-CHK-${agent}-${i}`, plate: `KN-9${i}0${agent.length}-TS`, zoneId: PARKING_DEMO.zoneGombe, commune: 'Gombe', light: 'ROUGE', title: null, agentId: agent, at: now });
      fake.set(agent, Array.from({ length: gen }, (_, i) => ({ module: 'STATIONNEMENT', source: 'PAIEMENT', state: 'CONFIRMEE', agentId: agent, obligationId: `OB-${agent}-${i}` }) as unknown as CommissionLine));
    }
    sanctions(e).commissions.byAgent = () => fake;
    const r = sanctions(e).monitoring.report();
    expect(r.rows.find((x) => x.agentId === 'pk-gen')!.signals.map((s) => s.code)).toContain('PAIEMENTS_GENERES_ELEVES');
    expect(r.rows.find((x) => x.agentId === 'pk-pair-1')!.signals.map((s) => s.code)).not.toContain('PAIEMENTS_GENERES_ELEVES');
  });

  it('constat retenu tiré au sort : file du superviseur, résultat enregistré par une personne non intervenue ; infirmé ⇒ alerte', async () => {
    const e = await env();
    const cc = sanctions(e).counterChecks;
    cc.draw = () => 0;
    const v = (await e.req('GET', '/v1/parking/violations?status=VERIFIE', 'pk-regie')).json().items.find((x: { plate: string }) => x.plate === PARKING_DEMO.plateTenant);
    expect((await e.req('POST', `/v1/parking/violations/${v.id}/decide`, 'pk-autorite', { outcome: 'RETENUE', reason: 'Photographies probantes.' })).statusCode).toBe(200);
    // (Les données de démonstration peuvent elles-mêmes avoir été tirées au sort : on filtre sur ce constat.)
    const queue = (await e.req('GET', '/v1/agents/counter-checks?status=A_CONTRE_VERIFIER', 'u-enqueteur')).json().items.filter((x: { caseId: string }) => x.caseId === v.id);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ module: 'STATIONNEMENT', caseId: v.id, agentId: 'pk-controleur' });
    // Le vérificateur du constat ne contre-vérifie pas son propre travail ; un agent n'y a pas accès.
    expect((await e.req('POST', `/v1/agents/counter-checks/${queue[0].id}/record`, v.verification.by, { outcome: 'CONFIRME', note: 'Revu.' })).json().code).toBe('SEPARATION_OF_DUTIES');
    expect((await e.req('GET', '/v1/agents/counter-checks', 'pk-controleur')).statusCode).toBe(403);
    const done = await e.req('POST', `/v1/agents/counter-checks/${queue[0].id}/record`, 'u-enqueteur', { outcome: 'INFIRME', note: 'Véhicule absent des photographies à la revue.' });
    expect(done.json()).toMatchObject({ status: 'INFIRME', outcome: { by: 'u-enqueteur' } });
    expect(e.app.ctx.alerts.list().some((a) => a.type === 'CONTRE_VERIFICATION_INFIRMEE' && a.context.caseId === v.id)).toBe(true);

    // Non tiré au sort : rien en file.
    const e2 = await env();
    sanctions(e2).counterChecks.draw = () => 9_999;
    const v2 = (await e2.req('GET', '/v1/parking/violations?status=VERIFIE', 'pk-regie')).json().items.find((x: { plate: string }) => x.plate === PARKING_DEMO.plateTenant);
    await e2.req('POST', `/v1/parking/violations/${v2.id}/decide`, 'pk-autorite', { outcome: 'RETENUE', reason: 'Photographies probantes.' });
    expect(sanctions(e2).counterChecks.items.find((x) => x.caseId === v2.id)).toHaveLength(0);
  });

  it('publicité : un dossier retenu peut aussi être tiré au sort', async () => {
    const e = await env();
    sanctions(e).counterChecks.draw = () => 0;
    const c = (await e.req('GET', '/v1/publicite/cases?status=VERIFIE', 'pb-autorite')).json().items[0];
    expect((await e.req('POST', `/v1/publicite/cases/${c.id}/decide`, 'pb-autorite', { outcome: 'RETENU', reason: 'Écart de dimensions établi.' })).statusCode).toBe(200);
    expect(sanctions(e).counterChecks.items.find((x) => x.caseId === c.id)).toEqual([expect.objectContaining({ module: 'PUBLICITE', caseId: c.id, status: 'A_CONTRE_VERIFIER' })]);
  });
});

describe('6. Conflit d’intérêts : ni vérification ni décision au profit d’un contribuable lié', () => {
  it('stationnement et publicité', async () => {
    const e = await env();
    const users = e.app.ctx.users;
    users.add({ id: 'pk-autorite-liee', name: 'Autorité liée au titulaire (test)', roles: ['R06'], entity: DGTK, taxpayerId: 'TP-DEMO-0002' });
    users.add({ id: 'pb-sup-lie', name: 'Superviseur lié à l’exploitant (test)', roles: ['R09'], entity: DGTK, territory: [...PUB_DEMO.inspectorCommunes], taxpayerId: PUB_DEMO.advertiserTaxpayerId });
    users.add({ id: 'pb-aut-liee', name: 'Autorité liée à l’exploitant (test)', roles: ['R06'], entity: DGTK, taxpayerId: PUB_DEMO.advertiserTaxpayerId });
    const v = (await e.req('GET', '/v1/parking/violations?status=VERIFIE', 'pk-regie')).json().items.find((x: { plate: string }) => x.plate === PARKING_DEMO.plateTenant);
    expect((await e.req('POST', `/v1/parking/violations/${v.id}/decide`, 'pk-autorite-liee', { outcome: 'CLASSEE', reason: 'Classement de complaisance.' })).json().code).toBe('CONFLICT_OF_INTEREST');
    // Vérification d'un constat de la plaque du titulaire lié.
    const pk = e.app.ctx.ext.parking as ParkingService;
    const cur = pk.violations.get(v.id)!;
    pk.violations.update({ ...cur, status: 'CONSTATE' });
    users.add({ id: 'pk-sup-lie', name: 'Superviseur lié (test)', roles: ['R09'], entity: DGTK, territory: ['Gombe', 'Limete'], taxpayerId: 'TP-DEMO-0002' });
    expect((await e.req('POST', `/v1/parking/violations/${v.id}/verify`, 'pk-sup-lie', { confirm: false, note: 'Rejet de complaisance.' })).json().code).toBe('CONFLICT_OF_INTEREST');

    const pub = e.app.ctx.ext.publicite as PubliciteService;
    const chevalet = pub.devices.all().find((d) => d.type === 'CHEVALET')!;
    const insp = (await e.req('POST', '/v1/publicite/inspections', 'pb-inspecteur', { deviceId: chevalet.id, finding: 'NON_CONFORME', photos: [sha256Hex('x')], lat: chevalet.lat, lon: chevalet.lon, gpsAccuracyM: 5, observations: 'Débord.' })).json();
    expect((await e.req('POST', `/v1/publicite/cases/${insp.case.id}/verify`, 'pb-sup-lie', { confirm: false, note: 'Rejet de complaisance.' })).json().code).toBe('CONFLICT_OF_INTEREST');
    const verified = (await e.req('GET', '/v1/publicite/cases?status=VERIFIE', 'pb-autorite')).json().items[0];
    expect((await e.req('POST', `/v1/publicite/cases/${verified.id}/decide`, 'pb-aut-liee', { outcome: 'CLASSE', reason: 'Classement de complaisance.' })).json().code).toBe('CONFLICT_OF_INTEREST');
  });
});

describe('7. Publicité : droits « acte requis » liquidés quand le barème devient ACTIF', () => {
  it('file des autorisations à liquider, proposition puis approbation par une autre personne ; liquidation par défaut d’un non-déclaré retenu', async () => {
    const e = await env();
    const pub = e.app.ctx.ext.publicite as PubliciteService;
    // Barème de la publicité mobile non publié : rien en file.
    expect((await e.req('GET', '/v1/publicite/liquidations/pending', 'pb-instructeur')).json().items).toHaveLength(0);
    const rule = publishDemoRule(e.app.ctx, {
      code: AD_MOBILE_TAX_RULE, revenueCategory: 'PROVINCIAL_SPECIFIQUE', label: 'TEST — publicité sur véhicule (barème fictif)',
      legalInstrumentIds: [DEMO_INSTRUMENT], articles: ['Article 1 (fictif)'], competentAuthority: 'Gouvernorat (test)', administeringEntity: DGTK,
      taxableEvent: 'Publicité sur véhicule (test)', liableParty: 'Exploitant', baseDefinition: 'Surface × faces × tarif',
      formula: 'surface_m2 * faces * tarif_m2', rateTable: { 'tarif_m2:1': '2000', 'tarif_m2:2': '2000', 'tarif_m2:3': '2000', 'tarif_m2:4': '2000' },
      currency: 'CDF', rounding: 'HALF_UP', periodicity: 'ANNUELLE', dueRule: '30 jours (test)', exemptions: [], penalties: [], effectiveFrom: '2026-01-01',
      beneficiaryAccountAlias: DGTK_ALIAS, appealPath: 'Réclamation (test)', sourceVerification: 'OFFICIEL_CERTIFIE',
    });
    expect(rule?.status).toBe('ACTIVE');
    const pending = (await e.req('GET', '/v1/publicite/liquidations/pending', 'pb-instructeur')).json().items;
    expect(pending).toHaveLength(1);
    const id = pending[0].id as string;
    expect(pending[0].liquidation.status).toBe('ACTE_REQUIS');
    expect((await e.req('POST', `/v1/publicite/authorizations/${id}/liquidation/approve`, 'pb-autorite', { reason: 'Sans proposition.' })).json().code).toBe('LIQUIDATION_NOT_PROPOSED');
    expect((await e.req('POST', `/v1/publicite/authorizations/${id}/liquidation/propose`, 'pb-autorite', { note: 'Rôle non habilité.' })).statusCode).toBe(403);
    expect((await e.req('POST', `/v1/publicite/authorizations/${id}/liquidation/propose`, 'pb-instructeur', { note: 'Barème publié : droits à liquider.' })).statusCode).toBe(200);
    expect((await e.req('POST', `/v1/publicite/authorizations/${id}/liquidation/approve`, 'pb-instructeur', { reason: 'Auto-approbation.' })).json().code).toBe('SEPARATION_OF_DUTIES');
    const ok = (await e.req('POST', `/v1/publicite/authorizations/${id}/liquidation/approve`, 'pb-autorite', { reason: 'Liquidation conforme au barème.' })).json();
    expect(ok.liquidation).toMatchObject({ status: 'EMISE', ruleCode: AD_MOBILE_TAX_RULE });
    expect(e.app.ctx.assessment.get(ok.liquidation.obligationId).taxpayerId).toBe(PUB_DEMO.advertiserTaxpayerId);
    expect((await e.req('GET', '/v1/publicite/liquidations/pending', 'pb-instructeur')).json().items).toHaveLength(0);
    expect(pub.deviceStatus(pub.getDevice(pending[0].deviceId)).rights).toBe('IMPAYE');

    // Non déclaré retenu, exploitant identifié, barème ACTIF : droits liquidés sans case à cocher.
    const c = (await e.req('GET', '/v1/publicite/cases?status=CONSTATE', 'pb-superviseur')).json().items.find((x: { finding: string }) => x.finding === 'NON_DECLARE');
    await e.req('POST', `/v1/publicite/cases/${c.id}/verify`, 'pb-superviseur', { confirm: true, note: 'Photographies probantes.' });
    const d = (await e.req('POST', `/v1/publicite/cases/${c.id}/decide`, 'pb-autorite', { outcome: 'RETENU', reason: 'Support non déclaré établi.', ownerTaxpayerId: PUB_DEMO.advertiserTaxpayerId })).json();
    expect(d.decision.obligationId).toBeTruthy();
  });
});

describe('8. Terminal enrôlé par les données initiales : clé imprévisible hors démonstration', () => {
  it('clé configurée, sinon « demo-key » en démonstration seulement, aléatoire ailleurs', () => {
    expect(seedDeviceKey('dev-x', {}, true)).toBe('demo-key-dev-x');
    const k1 = seedDeviceKey('dev-x', {}, false);
    const k2 = seedDeviceKey('dev-x', {}, false);
    expect(k1).not.toContain('demo-key');
    expect(k1).toMatch(/^[0-9a-f]{32}$/);
    expect(k1).not.toBe(k2);
    expect(seedDeviceKey('dev-x', { 'dev-x': 'configuree' }, false)).toBe('configuree');
  });
});
