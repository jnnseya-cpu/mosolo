/**
 * Module 14 — Stationnement public (Spécification fonctionnelle) : sessions par USSD ou SMS (passerelle signée et
 * simulateur), exemptions (véhicules officiels ; cas prévus par la règle), tous les titres actifs d'une plaque au
 * contrôleur, calcul du prix selon zone, heure et durée, vert / ambre / rouge sur l'heure du serveur.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { signedCallbackHeaders } from '../src/modules/payments/callback-signing.js';
import { parkingPlugin } from '../src/plugins/parking/plugin.js';
import { PARKING_DEMO } from '../src/plugins/parking/seed.js';
import type { ParkingService } from '../src/plugins/parking/service.js';
import { publishDemoRule } from '../src/plugins/parking/support.js';
import { titresPlugin } from '../src/plugins/titres/plugin.js';
import { PROVIDER_SECRET, type TestEnv } from './helpers.js';

async function setup(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} }, plugins: [titresPlugin, parkingPlugin] });
  await app.ready();
  return {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    }),
  };
}

const HASH = 'd'.repeat(64);
const svcOf = (env: TestEnv) => env.app.ctx.ext.parking as ParkingService;

function confirm(env: TestEnv, paymentReference: string) {
  const order = env.app.ctx.payments.byReference(paymentReference)!;
  const raw = JSON.stringify({ providerTxnId: `T-${randomUUID()}`, paymentReference, amount: order.amount, status: 'SUCCESS', completedAt: env.clock.now().toISOString() });
  return env.app.ctx.payments.handleCallback('mm-operator-a', signedCallbackHeaders(PROVIDER_SECRET, raw, env.clock.now()), raw);
}

/** Message de la passerelle de l'opérateur, signé (schéma v2 des rappels). */
function gateway(env: TestEnv, body: Record<string, unknown>, opts: { secret?: string; nonce?: string } = {}) {
  const raw = JSON.stringify(body);
  const h = signedCallbackHeaders(opts.secret ?? PROVIDER_SECRET, raw, env.clock.now(), opts.nonce ? { nonce: opts.nonce } : {});
  return env.app.inject({ method: 'POST', url: '/v1/parking/canal-texte/passerelle/mm-operator-a', headers: { 'content-type': 'application/json', 'x-signature': h.signature, 'x-nonce': h.nonce, 'x-timestamp': h.timestamp }, payload: raw });
}

describe('Module 14 — exemptions : véhicules officiels et cas prévus par la règle', () => {
  it('véhicule officiel : demande avec pièces par la régie, décision d’une autre personne ; VERT au contrôle, aucune session vendue ; révocation', async () => {
    const env = await setup();
    const body = { plate: 'KN-0900-GV', category: 'VEHICULE_OFFICIEL', holder: 'Gouvernorat — parc automobile (démonstration)', zoneIds: [], validFrom: '2026-09-01', validUntil: '2026-12-31', motif: 'Véhicule de service du Gouvernorat' };
    expect((await env.req('POST', '/v1/parking/exemptions', 'pk-regie', body)).json().code).toBe('DOCUMENTS_REQUIRED');
    expect((await env.req('POST', '/v1/parking/exemptions', 'u-contribuable', { ...body, documents: [HASH] })).statusCode).toBe(403);
    const req = await env.req('POST', '/v1/parking/exemptions', 'pk-regie', { ...body, documents: [HASH] });
    expect(req.statusCode).toBe(201);
    const id = req.json().id as string;
    expect((await env.req('POST', `/v1/parking/exemptions/${id}/decide`, 'pk-regie', { approve: true, motif: 'Auto-approbation interdite' })).statusCode).toBe(403);
    expect(env.app.ctx.audit.list({ limit: 1e6 }).items.some((a) => a.action === 'parking.exemption.decision_refused')).toBe(true);
    expect((await env.req('POST', `/v1/parking/exemptions/${id}/decide`, 'pk-autorite', { approve: true, motif: 'Carte grise administrative vérifiée' })).json().status).toBe('ACCORDEE');
    // Contrôle : VERT, titre EXEMPTION, listé parmi les titres actifs de la plaque.
    const ctl = (await env.req('GET', `/v1/parking/control/KN-0900-GV?zoneId=${PARKING_DEMO.zoneGombe}`, 'pk-controleur')).json();
    expect(ctl).toMatchObject({ light: 'VERT', title: 'EXEMPTION' });
    expect(ctl.activeTitles).toEqual([expect.objectContaining({ kind: 'EXEMPTION', light: 'VERT', text: 'Exempté — véhicule officiel' })]);
    // Aucune session n'est vendue à un véhicule exempté.
    await env.req('POST', '/v1/parking/vehicles', 'u-contribuable', { plate: 'KN-0900-GV' });
    const s = await env.req('POST', '/v1/parking/sessions', 'u-contribuable', { zoneId: PARKING_DEMO.zoneGombe, plate: 'KN-0900-GV', durationMinutes: 60 }, { 'idempotency-key': randomUUID() });
    expect(s.json().code).toBe('PLATE_EXEMPTED');
    // Révocation motivée : de nouveau ROUGE.
    expect((await env.req('POST', `/v1/parking/exemptions/${id}/revoke`, 'pk-autorite', { motif: 'Véhicule réformé' })).json().status).toBe('REVOQUEE');
    expect((await env.req('GET', `/v1/parking/control/KN-0900-GV?zoneId=${PARKING_DEMO.zoneGombe}`, 'pk-controleur')).json().light).toBe('ROUGE');
    const list = (await env.req('GET', '/v1/parking/exemptions', 'pk-autorite')).json().items;
    expect(list[0]).toMatchObject({ status: 'REVOQUEE', inForce: false });
  });

  it('cas prévu par la règle : seule une exonération inscrite dans la fiche de la grille ACTIVE de la zone fonde l’exemption', async () => {
    const env = await setup();
    const svc = svcOf(env);
    const regie = env.app.ctx.users.get('pk-regie')!;
    publishDemoRule(env.app.ctx, {
      code: 'TEST-PARK-EXO', revenueCategory: 'REDEVANCE_SERVICE', label: 'TEST [EXEMPLE] — grille avec exonération', legalInstrumentIds: ['demo-instrument-001'], articles: ['Art. 1 (fictif)'],
      competentAuthority: 'Gouvernorat (démonstration)', administeringEntity: 'DGTK', taxableEvent: 'Occupation d’une place en zone test (démonstration)', liableParty: 'Usager',
      baseDefinition: 'Durée × places × tarif', formula: 'duree_minutes / 60 * places * tarif_horaire', rateTable: { tarif_horaire: '1000' }, currency: 'CDF', rounding: 'HALF_UP',
      periodicity: 'PONCTUELLE', dueRule: 'Immédiat', exemptions: [{ basis: 'Véhicules de secours en intervention', proof: 'Ordre de mission du service de secours' }], penalties: [],
      effectiveFrom: '2026-01-01', beneficiaryAccountAlias: 'KIN-DGTK-RECETTES-01', appealPath: 'Réclamation (démonstration)', sourceVerification: 'OFFICIEL_CERTIFIE',
    });
    const zone = svc.createZone(regie, { code: 'TEST-EXO-KALAMU', name: 'Zone test Kalamu', commune: 'Kalamu', quartier: 'Matonge', kind: 'SECTEUR', geometry: { type: 'Polygon', coordinates: [[15.31, -4.33], [15.32, -4.33], [15.32, -4.34]] }, localityRank: 2, capacity: { standard: 10, livraison: 0, pmr: 0 }, tariffRuleCode: 'TEST-PARK-EXO', actReference: 'Acte FICTIF [EXEMPLE]' });
    const base = { plate: 'KN-0911-SC', category: 'CAS_PREVU_PAR_LA_REGLE', holder: 'Service de secours (démonstration)', zoneIds: [zone.id], validFrom: '2026-09-26', validUntil: '2026-09-30', documents: [HASH], motif: 'Intervention de secours' };
    expect((await env.req('POST', '/v1/parking/exemptions', 'pk-regie', { ...base, ruleCode: PARKING_DEMO.tariffRule, exemptionBasis: 'Véhicules de secours en intervention' })).json().code).toBe('RULE_NOT_ZONE_TARIFF');
    expect((await env.req('POST', '/v1/parking/exemptions', 'pk-regie', { ...base, ruleCode: 'TEST-PARK-EXO', exemptionBasis: 'Véhicules de livraison' })).json().code).toBe('EXEMPTION_NOT_IN_RULE');
    const ok = await env.req('POST', '/v1/parking/exemptions', 'pk-regie', { ...base, ruleCode: 'TEST-PARK-EXO', exemptionBasis: 'véhicules de secours en intervention' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ ruleCode: 'TEST-PARK-EXO', exemptionBasis: 'Véhicules de secours en intervention' });
    expect((await env.req('POST', '/v1/parking/exemptions', 'pk-regie', { ...base, ruleCode: 'TEST-PARK-EXO', exemptionBasis: 'Véhicules de secours en intervention' })).json().code).toBe('EXEMPTION_EXISTS');
    await env.req('POST', `/v1/parking/exemptions/${ok.json().id}/decide`, 'pk-autorite', { approve: true, motif: 'Ordre de mission vérifié' });
    // Exemption limitée à la zone : hors zone, aucun effet.
    expect(svc.complements.exemptionFor('KN-0911-SC', zone.id, env.clock.now())).not.toBeNull();
    expect(svc.complements.exemptionFor('KN-0911-SC', PARKING_DEMO.zoneGombe, env.clock.now())).toBeNull();
    // Fin de validité (heure du serveur) : plus d'effet.
    env.clock.advance(5 * 86_400_000);
    expect(svc.complements.exemptionFor('KN-0911-SC', zone.id, env.clock.now())).toBeNull();
  });
});

describe('Module 14 — tous les titres actifs d’une plaque, prix selon zone, heure et durée, feu sur l’heure du serveur', () => {
  it('le contrôleur voit toutes les sessions valables de la plaque (plusieurs zones), vert puis ambre puis rouge', async () => {
    const env = await setup();
    const owner = 'u-contribuable';
    const start = (zoneId: string, minutes: number) => env.req('POST', '/v1/parking/sessions', owner, { zoneId, plate: PARKING_DEMO.plateOwner, durationMinutes: minutes }, { 'idempotency-key': randomUUID() });
    const s = await start(PARKING_DEMO.zoneLimete, 60);
    expect(s.statusCode).toBe(201);
    // Prix selon zone (rang 1 à Gombe, rang 2 à Limete), durée : la règle calcule, jamais une saisie.
    const rankLimete = svcOf(env).getZone(PARKING_DEMO.zoneLimete).localityRank;
    expect(rankLimete).toBeGreaterThan(1);
    const amount = s.json().obligation.amount.amount as string;
    const order = env.app.ctx.payments.createOrder(env.app.ctx.users.get(owner)!, s.json().obligation.id, { channel: 'MOBILE_MONEY' });
    confirm(env, order.paymentReference);
    expect(Number(amount)).toBeGreaterThan(0);
    const titles = (await env.req('GET', `/v1/parking/plates/${PARKING_DEMO.plateOwner}/active-titles`, 'pk-controleur')).json();
    expect(titles.items.filter((t: { kind: string }) => t.kind === 'SESSION').length).toBeGreaterThanOrEqual(1);
    expect(titles.items.every((t: { light: string }) => ['VERT', 'AMBRE'].includes(t.light))).toBe(true);
    expect((await env.req('GET', `/v1/parking/plates/${PARKING_DEMO.plateOwner}/active-titles`, 'u-contribuable')).statusCode).toBe(403);
    const ctl = (await env.req('GET', `/v1/parking/control/${PARKING_DEMO.plateOwner}?zoneId=${PARKING_DEMO.zoneLimete}`, 'pk-controleur')).json();
    expect(ctl.light).toBe('VERT');
    expect(ctl.activeTitles.some((t: { zone: string }) => t.zone === 'DEMO-LIMETE-LUMUMBA')).toBe(true);
    env.clock.advance(40 * 60_000);
    expect((await env.req('GET', `/v1/parking/control/${PARKING_DEMO.plateOwner}?zoneId=${PARKING_DEMO.zoneLimete}`, 'pk-controleur')).json().light).toBe('AMBRE');
    env.clock.advance(30 * 60_000);
    expect((await env.req('GET', `/v1/parking/control/${PARKING_DEMO.plateOwner}?zoneId=${PARKING_DEMO.zoneLimete}`, 'pk-controleur')).json().light).toBe('ROUGE');
  });
});

describe('Module 14 — sessions par USSD ou SMS', () => {
  it('simulateur : démarrer (SMS), payer la référence, prolonger (USSD), consulter, terminer ; plaque non déclarée refusée', async () => {
    const env = await setup();
    const sms = (text: string, user = 'u-contribuable') => env.req('POST', '/v1/parking/canal-texte/simulateur', user, { channel: 'SMS', text });
    const ussd = (text: string) => env.req('POST', '/v1/parking/canal-texte/simulateur', 'u-contribuable', { channel: 'USSD', text });
    const r1 = (await sms(`STAT DEMO-LIMETE-LUMUMBA ${PARKING_DEMO.plateOwner} 60`)).json();
    expect(r1.outcome).toBe('OK');
    expect(r1.access.status).toMatch(/À RACCORDER/);
    const ref = /référence ([A-Za-z0-9-]+)/.exec(r1.reply)![1]!;
    const session = svcOf(env).getSession(r1.sessionId);
    expect(session.plate).toBe(PARKING_DEMO.plateOwner);
    expect(env.app.ctx.payments.byReference(ref)!.channel).toBe('MOBILE_MONEY');
    confirm(env, ref);
    expect(svcOf(env).sessionView(svcOf(env).getSession(r1.sessionId)).status).toBe('ACTIVE');
    const r2 = (await ussd(`2*${session.ticketCode}*30`)).json();
    expect(r2.outcome).toBe('OK');
    const ref2 = /référence ([A-Za-z0-9-]+)/.exec(r2.reply)![1]!;
    expect(env.app.ctx.payments.byReference(ref2)!.channel).toBe('USSD');
    const r3 = (await ussd(`4*${PARKING_DEMO.plateOwner}`)).json();
    expect(r3.reply).toMatch(/Session payée/);
    const r4 = (await sms(`FIN ${session.ticketCode}`)).json();
    expect(r4.outcome).toBe('OK');
    expect(svcOf(env).sessionView(svcOf(env).getSession(r1.sessionId)).status).toBe('TERMINEE');
    expect((await sms('STAT DEMO-LIMETE-LUMUMBA KN-4444-ZZ 60')).json().reply).toMatch(/non déclarée/);
    expect((await sms('BONJOUR')).json().outcome).toBe('REFUS');
    // Aucune session sans compte contribuable.
    expect((await env.req('POST', '/v1/parking/canal-texte/simulateur', 'pk-controleur', { channel: 'SMS', text: 'ETAT KN-0001-DM' })).statusCode).toBe(403);
    const stats = (await env.req('GET', '/v1/parking/canal-texte/statistiques', 'pk-regie')).json();
    expect(stats.byChannel.find((c: { channel: string }) => c.channel === 'SMS')).toMatchObject({ sessions: 1 });
    expect(JSON.stringify(stats)).not.toMatch(/\+243/);
  });

  it('passerelle de l’opérateur : signature v2 exigée, rejeu refusé, numéro inconnu refusé sans effet', async () => {
    const env = await setup();
    const ok = await gateway(env, { channel: 'SMS', msisdn: '+243810000001', text: `ETAT ${PARKING_DEMO.plateOwner}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().outcome).toBe('OK');
    expect((await gateway(env, { channel: 'SMS', msisdn: '+243810000001', text: 'ETAT KN-0001-DM' }, { secret: 'mauvais-secret' })).statusCode).toBe(401);
    const nonce = randomUUID();
    expect((await gateway(env, { channel: 'USSD', msisdn: '+243810000001', text: '4*KN-0001-DM' }, { nonce })).statusCode).toBe(200);
    expect((await gateway(env, { channel: 'USSD', msisdn: '+243810000001', text: '4*KN-0001-DM' }, { nonce })).statusCode).toBe(409);
    const unknown = (await gateway(env, { channel: 'SMS', msisdn: '+243899999999', text: `STAT DEMO-LIMETE-LUMUMBA ${PARKING_DEMO.plateOwner} 60` })).json();
    expect(unknown.outcome).toBe('REFUS');
    expect(unknown.reply).toMatch(/non rattaché/);
    expect((await env.app.inject({ method: 'POST', url: '/v1/parking/canal-texte/passerelle/operateur-inconnu', headers: { 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(404);
  });
});
