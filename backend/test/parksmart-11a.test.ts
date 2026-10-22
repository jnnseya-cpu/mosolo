import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { parkingPlugin } from '../src/plugins/parking/plugin.js';
import { PARKING_DEMO } from '../src/plugins/parking/seed.js';
import { PARKSMART_DEMO } from '../src/plugins/parking/seed-smart.js';
import type { ParkingService } from '../src/plugins/parking/service.js';
import { titresPlugin } from '../src/plugins/titres/plugin.js';
import { callbackBody, PROVIDER_SECRET, signedCallback, type TestEnv } from './helpers.js';

async function setup11A(at = '2026-09-26T09:00:00.000Z'): Promise<TestEnv & { svc: ParkingService }> {
  const clock = new ManualClock(at);
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} },
    plugins: [titresPlugin, parkingPlugin],
  });
  await app.ready();
  return {
    app, clock, svc: app.ctx.ext['parking'] as ParkingService,
    req: (method, url, user, body, headers = {}) =>
      app.inject({
        method: method as 'GET', url,
        headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
      }),
  };
}

async function pay(env: TestEnv, user: string, obligationId: string) {
  const order = await env.req('POST', `/v1/obligations/${obligationId}/payment-orders`, user, { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() });
  expect(order.statusCode).toBe(201);
  const o = order.json();
  const cb = await signedCallback(env, callbackBody(env, o.paymentReference, o.amount));
  expect(cb.json().status).toBe('CONFIRME');
}

describe('ParkSmart § 11A.2 — grilles tarifaires du registre (aucun tarif codé en dur)', () => {
  it('chaque mode a une grille réelle ACTE_REQUIS et une grille de démonstration ; la longue durée reste A_VERIFIER', async () => {
    const env = await setup11A();
    const res = await env.req('GET', '/v1/parking/tariff-modes', 'u-contribuable');
    expect(res.statusCode).toBe(200);
    const modes = res.json().items as { mode: string; grids: { scope: string; status: string; rule: { rateTable: Record<string, string>; demo: boolean } | null }[]; titleTypes: { code: string; activable: boolean }[] }[];
    expect(modes).toHaveLength(9);
    for (const m of modes) {
      expect(m.grids.find((g) => g.scope === 'REEL')!.status).toBe('ACTE_REQUIS');
      const d = m.grids.find((g) => g.scope === 'DEMO')!;
      if (m.mode === 'LONGUE_DUREE_MAJOREE') {
        expect(d.status).toBe('A_VERIFIER');
        expect(d.rule!.rateTable).toEqual({});
      } else {
        expect(d.status).toBe('ACTIVE');
        expect(d.rule!.demo).toBe(true);
      }
    }
    const resident = modes.find((m) => m.mode === 'RESIDENTIEL')!;
    expect(resident.titleTypes.find((t) => t.code === 'PKS-RESIDENTIEL')!.activable).toBe(false);
    expect(resident.titleTypes.find((t) => t.code === 'DEMO-PKS-RESIDENTIEL')!.activable).toBe(true);
    expect((await env.req('POST', '/v1/parking/tariff-grids', 'pk-regie', { mode: 'JOURNALIER', ruleCode: 'INCONNUE-Z' })).json().code).toBe('UNKNOWN_RULE');
    expect((await env.req('POST', '/v1/parking/tariff-grids', 'u-contribuable', { mode: 'JOURNALIER', ruleCode: PARKSMART_DEMO.dailyRule })).statusCode).toBe(403);
  });

  it('simulation différenciée : heure de pointe lue dans la table de la règle ; aucune simulation sans grille ACTIVE', async () => {
    const env = await setup11A();
    const sim = (at: string, zoneId: string = PARKING_DEMO.zoneGombe) => env.req('POST', '/v1/parking/tariff-simulations', 'u-contribuable', { mode: 'DEMANDE_DIFFERENCIEE', zoneId, durationMinutes: 60, at });
    const peak = (await sim('2026-09-26T07:30:00.000Z')).json();
    const off = (await sim('2026-09-26T11:30:00.000Z')).json();
    expect(peak).toMatchObject({ executable: true, peakHour: true, amount: { amount: '3000.00', currency: 'CDF' }, demo: true });
    expect(off).toMatchObject({ executable: true, peakHour: false, amount: { amount: '2000.00', currency: 'CDF' } });
    const real = (await sim('2026-09-26T07:30:00.000Z', PARKING_DEMO.zoneGombeReal)).json();
    expect(real).toMatchObject({ executable: false, status: 'ACTE_REQUIS', amount: null });
    const long = (await env.req('POST', '/v1/parking/tariff-simulations', 'u-contribuable', { mode: 'LONGUE_DUREE_MAJOREE', zoneId: PARKING_DEMO.zoneGombe, durationMinutes: 300 })).json();
    expect(long).toMatchObject({ executable: false, status: 'A_VERIFIER' });
  });

  it('une zone rattachée à la grille différenciée liquide les sessions avec l’entrée « pointe » (même circuit)', async () => {
    const env = await setup11A('2026-09-26T07:30:00.000Z');
    expect((await env.req('POST', `/v1/parking/zones/${PARKING_DEMO.zoneLimete}/tariff`, 'pk-regie', { tariffRuleCode: PARKSMART_DEMO.demandRule, actReference: 'Acte FICTIF test' })).statusCode).toBe(200);
    const s = await env.req('POST', '/v1/parking/sessions', 'u-contribuable', { zoneId: PARKING_DEMO.zoneLimete, plate: 'KN-0042-DM', durationMinutes: 60 }, { 'idempotency-key': randomUUID() });
    expect(s.statusCode).toBe(201);
    // Rang 2, heure de pointe (08:30 à Kinshasa) : 1 000 + 500 [EXEMPLE].
    expect(s.json().obligation.amount).toEqual({ amount: '1500.00', currency: 'CDF' });
  });
});

describe('ParkSmart — abonnement résidentiel digital : titre § 19A lié à la plaque, reconnu au contrôle', () => {
  it('la plaque abonnée est VERTE dans la zone de l’abonnement, ROUGE ailleurs', async () => {
    const env = await setup11A();
    env.clock.advance(4 * 3_600_000); // la session horaire de démonstration est expirée
    const ok = (await env.req('GET', `/v1/parking/control/${PARKING_DEMO.plateOwner}?zoneId=${PARKING_DEMO.zoneGombe}`, 'pk-controleur')).json();
    expect(ok).toMatchObject({ light: 'VERT', title: 'TITRE' });
    const other = (await env.req('GET', `/v1/parking/control/${PARKING_DEMO.plateOwner}?zoneId=${PARKING_DEMO.zoneLimete}`, 'pk-controleur')).json();
    expect(other.light).toBe('ROUGE');
  });
});

describe('ParkSmart — occupation 15–25 %, capteurs, recommandation jamais appliquée', () => {
  it('profil horaire, alertes hors cible ; la recommandation retenue ne change ni la zone ni le registre', async () => {
    const env = await setup11A();
    expect((await env.req('GET', '/v1/parking/occupancy', 'u-contribuable')).statusCode).toBe(403);
    const occ = (await env.req('GET', '/v1/parking/occupancy', 'pk-regie')).json();
    const gombe = occ.zones.find((z: { zoneId: string }) => z.zoneId === PARKING_DEMO.zoneGombe);
    expect(gombe.hours).toHaveLength(24);
    expect(gombe.hours.some((h: { source: string | null; target: string }) => h.source === 'CAPTEUR' && h.target === 'SATURE')).toBe(true);
    expect(occ.target).toEqual({ minPct: 15, maxPct: 25 });
    expect((await env.req('POST', `/v1/parking/zones/${PARKING_DEMO.zoneGombe}/sensor-readings`, 'pk-regie', { sensorId: 'CAP-T', occupied: 9999 })).json().code).toBe('INVALID_OCCUPANCY');

    const recs = (await env.req('GET', '/v1/parking/pricing-recommendations', 'pk-regie')).json().items as { id: string; zoneId: string; applied: boolean; status: string }[];
    expect(recs.length).toBeGreaterThan(0);
    const rec = recs[0]!;
    expect(rec.applied).toBe(false);
    const zoneBefore = env.svc.getZone(rec.zoneId);
    const rulesBefore = env.app.ctx.rules.list().length;
    const d = await env.req('POST', `/v1/parking/pricing-recommendations/${rec.id}/decide`, 'pk-regie', { outcome: 'RETENUE_POUR_NOUVELLE_VERSION', reason: 'À instruire par le circuit à quatre visas (test).' });
    expect(d.statusCode).toBe(200);
    expect(d.json().applied).toBe(false);
    expect(env.svc.getZone(rec.zoneId).tariffRuleCode).toBe(zoneBefore.tariffRuleCode);
    expect(env.app.ctx.rules.list().length).toBe(rulesBefore);
    expect((await env.req('POST', `/v1/parking/pricing-recommendations/${rec.id}/decide`, 'pk-regie', { outcome: 'ECARTEE', reason: 'Double décision (test).' })).json().code).toBe('RECOMMENDATION_ALREADY_DECIDED');
  });

  it('données urbaines agrégées : aucune plaque, cellules sous le seuil k masquées', async () => {
    const env = await setup11A();
    const res = await env.req('GET', '/v1/parking/urban-data', 'pk-regie');
    expect(res.statusCode).toBe(200);
    const text = res.body;
    for (const p of [PARKING_DEMO.plateOwner, PARKING_DEMO.plateTenant, PARKING_DEMO.plateMerchant]) expect(text).not.toContain(p);
    const body = res.json();
    expect(body.kThreshold).toBe(5);
    expect(body.suppressedCells).toBeGreaterThan(0);
  });

  it('sources de recettes : catalogue § 11A.3, recharge électrique en phase future, zone premium classée', async () => {
    const env = await setup11A();
    const res = (await env.req('GET', '/v1/parking/revenue-sources', 'pk-regie')).json();
    const svcs = res.sources.find((x: { code: string }) => x.code === 'SERVICES_VALEUR_AJOUTEE');
    expect(svcs.items.find((i: { label: string }) => i.label.includes('recharge')).status).toBe('PHASE_FUTURE');
    expect(res.sources.find((x: { code: string }) => x.code === 'ZONES_PREMIUM').zones[0].category).toBe('COMMERCIALE');
    expect(res.sources.find((x: { code: string }) => x.code === 'REDEVANCES').titlesRevenue.length).toBe(1);
  });
});

describe('ParkSmart — plaque : profil explicable, priorisation seulement ; blocage et fourrière jamais algorithmiques', () => {
  it('le classement ne décide rien ; la transmission est humaine, sans mesure ; l’IA et le contrôleur sont refusés', async () => {
    const env = await setup11A();
    const v = env.svc.violations.find((x) => x.status === 'VERIFIE')[0]!;
    const dec = await env.req('POST', `/v1/parking/violations/${v.id}/decide`, 'pk-autorite', { outcome: 'RETENUE', reason: 'Photographies probantes (test).' });
    expect(dec.json().decision.obligationId).toBeTruthy();
    const auditBefore = env.app.ctx.audit.list({ limit: 100000 }).items.length;

    const pr = (await env.req('GET', '/v1/parking/plates/priorities', 'pk-regie')).json();
    expect(pr.automaticMeasure).toBe(false);
    expect(pr.items[0]).toMatchObject({ plate: v.plate, unpaid: 1, retained: 1 });
    const prof = (await env.req('GET', `/v1/parking/plates/${v.plate}/profile`, 'pk-regie')).json();
    expect(prof).toMatchObject({ usage: 'PRIORISATION_PATROUILLES_ET_PROPOSITIONS', automaticMeasure: false });
    expect(prof.score.explanation.length).toBeGreaterThanOrEqual(3);
    // Lecture seule : seule la consultation est journalisée, aucune mesure ni transmission n'est créée.
    const newActions = env.app.ctx.audit.list({ limit: 100000 }).items.slice(auditBefore).map((r) => r.action);
    expect(newActions.every((a) => a === 'parking.plate.profile_viewed')).toBe(true);
    expect(env.svc.smart.referrals.count()).toBe(0);

    expect((await env.req('GET', `/v1/parking/plates/${v.plate}/profile`, 'u-contribuable')).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/parking/plates/${v.plate}/referrals`, 'pk-controleur', { measure: 'FOURRIERE', grounds: 'Récidive constatée (test).' })).statusCode).toBe(403);
    expect(() => env.svc.smart.refer({ kind: 'ai', id: 'ia-test', agent: 'test' }, v.plate, { measure: 'FOURRIERE', grounds: 'Proposition automatique (test)' })).toThrow(/IA|AI/);
    expect((await env.req('POST', `/v1/parking/plates/${PARKING_DEMO.plateMerchant}/referrals`, 'pk-regie', { measure: 'FOURRIERE', grounds: 'Aucune dette (test).' })).json().code).toBe('NO_UNPAID_PENALTY');
    const ref = await env.req('POST', `/v1/parking/plates/${v.plate}/referrals`, 'pk-regie', { measure: 'BLOCAGE_ADMINISTRATIF', grounds: 'Pénalité impayée (test).' });
    expect(ref.statusCode).toBe(201);
    expect(ref.json()).toMatchObject({ status: 'TRANSMISE_AU_CONTENTIEUX', measureTaken: false });
    expect(env.app.ctx.audit.list({ limit: 100000 }).items.some((r) => /impound|fourriere\.decided|blocage\.decided/i.test(r.action))).toBe(false);
  });
});

describe('ParkSmart § 11A.5 — surréservation désactivée sans validation juridique ; compensation', () => {
  it('refus sans validation, sans historique ; puis taux fondé sur l’historique réel et borné à 15 %', async () => {
    const env = await setup11A();
    expect((await env.req('GET', '/v1/parking/overbooking', 'pk-regie')).json().active).toBe(false);
    expect((await env.req('POST', '/v1/parking/overbooking/activation', 'pk-autorite', { enabled: true, reason: 'Essai sans validation (test).' })).json().code).toBe('LEGAL_VALIDATION_REQUIRED');
    expect((await env.req('POST', '/v1/parking/overbooking/legal-validation', 'pk-regie', { reference: 'Avis test', guarantee: 'COMPENSATION_AUTOMATIQUE', reason: 'Avis juridique (test).' })).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/parking/overbooking/legal-validation', 'pk-autorite', { reference: 'Avis juridique protection du consommateur n° TEST-1', guarantee: 'COMPENSATION_AUTOMATIQUE', reason: 'Avis favorable (test).' })).statusCode).toBe(201);
    expect((await env.req('POST', '/v1/parking/overbooking/activation', 'pk-autorite', { enabled: true, reason: 'Activation (test).' })).json().code).toBe('INSUFFICIENT_HISTORY');

    // Historique réel simulé : 30 réservations approuvées échues jamais payées (annulations).
    const past = new Date(env.clock.now().getTime() - 3 * 86_400_000).toISOString();
    for (let i = 0; i < 30; i++) {
      env.svc.reservations.insert({ id: `PKR-HIST-${i}`, reference: `RSV-HIST-${i}`, zoneId: PARKING_DEMO.zoneGombe, commune: 'Gombe', taxpayerId: 'TP-PK-0001', requestedBy: 'pk-marchand', requestedAt: past, purpose: 'LIVRAISON', places: 1, startAt: past, endAt: past, plate: null, notes: '', status: 'APPROUVEE' });
    }
    const st = (await env.req('GET', '/v1/parking/overbooking', 'pk-regie')).json();
    expect(st.stats).toMatchObject({ enoughHistory: true, suggestedRatePct: 15 });
    expect((await env.req('POST', '/v1/parking/overbooking/activation', 'pk-autorite', { enabled: true, ratePct: 20, reason: 'Taux excessif (test).' })).json().code).toBe('INVALID_RATE');
    const on = (await env.req('POST', '/v1/parking/overbooking/activation', 'pk-autorite', { enabled: true, ratePct: 15, reason: 'Activation encadrée (test).' })).json();
    expect(on).toMatchObject({ active: true, ratePct: 15 });

    // Capacité 40 + 15 % (6 places) : 40 puis 4 places approuvées sur la même période.
    const start = new Date(env.clock.now().getTime() + 48 * 3_600_000); start.setUTCMinutes(0, 0, 0);
    const end = new Date(start.getTime() + 3_600_000);
    const ids: string[] = [];
    for (const places of [40, 4]) {
      const r = await env.req('POST', '/v1/parking/reservations', 'pk-marchand', { zoneId: PARKING_DEMO.zoneGombe, purpose: 'EVENEMENT', places, startAt: start.toISOString(), endAt: end.toISOString() });
      expect(r.statusCode).toBe(201);
      ids.push(r.json().id);
    }
    for (const id of ids) expect((await env.req('POST', `/v1/parking/reservations/${id}/decide`, 'pk-regie', { approve: true, reason: 'Accord (test).' })).statusCode).toBe(200);

    // Indisponibilité : compensation automatique égale au montant payé.
    const approved = env.svc.reservations.get(ids[1]!)!;
    await pay(env, 'pk-marchand', approved.obligationId!);
    const comp = await env.req('POST', `/v1/parking/reservations/${ids[1]}/unavailability`, 'pk-regie', { reason: 'Place occupée à l’arrivée (test).' });
    expect(comp.statusCode).toBe(201);
    expect(comp.json()).toMatchObject({ status: 'COMPENSATION_DUE', guarantee: 'COMPENSATION_AUTOMATIQUE' });
    expect(comp.json().amount).toEqual(env.app.ctx.assessment.get(approved.obligationId!).amount);
  });
});

describe('ParkSmart § 11A.5, 11A.7, 11A.8 — reconfigurations, affectation, déploiement', () => {
  it('reconfiguration : planification sans effet sur la capacité', async () => {
    const env = await setup11A();
    const cap = env.svc.getZone(PARKING_DEMO.zoneLimete).capacity;
    const list = (await env.req('GET', '/v1/parking/reconfigurations', 'pk-regie')).json().items as { id: string; kind: string }[];
    expect(list.some((r) => r.kind === 'STATIONNEMENT_EN_EPI')).toBe(true);
    const upd = await env.req('POST', `/v1/parking/reconfigurations/${list[0]!.id}/status`, 'pk-regie', { status: 'PROGRAMMEE', reason: 'Inscrit au programme (test).' });
    expect(upd.json().status).toBe('PROGRAMMEE');
    expect(env.svc.getZone(PARKING_DEMO.zoneLimete).capacity).toEqual(cap);
  });

  it('affectation : engagement publié par une autre personne, visible publiquement, jamais automatique', async () => {
    const env = await setup11A();
    const pub = await env.req('GET', '/v1/parking/affectation');
    expect(pub.statusCode).toBe(200);
    expect(pub.json().automaticEarmarking).toBe(false);
    expect(pub.json().items).toHaveLength(1);
    expect((await env.req('POST', '/v1/parking/affectation/commitments', 'pk-regie', { domain: 'MOBILITE', label: 'Affectation par acte (test)', legalForm: 'ACTE_JURIDIQUE', period: '2027' })).json().code).toBe('ACT_REFERENCE_REQUIRED');
    const c = await env.req('POST', '/v1/parking/affectation/commitments', 'pk-regie', { domain: 'MOBILITE', label: 'Engagement mobilité (test)', period: '2027' });
    expect(c.statusCode).toBe(201);
    expect((await env.req('POST', `/v1/parking/affectation/commitments/${c.json().id}/publish`, 'pk-regie')).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/parking/affectation/commitments/${c.json().id}/publish`, 'pk-autorite')).json().published).toBe(true);
    expect((await env.req('GET', '/v1/parking/affectation')).json().items).toHaveLength(2);
  });

  it('phases : activation refusée tant que l’acte manque, dans l’ordre, par l’autorité seulement', async () => {
    const env = await setup11A();
    const dep = (await env.req('GET', '/v1/parking/deployment', 'pk-regie')).json();
    expect(dep.phases).toHaveLength(3);
    expect(dep.phases[0].activable).toBe(false);
    const act = { actReference: 'Arrêté FICTIF de zonage (test)', reason: 'Lancement de la phase pilote (test).' };
    expect((await env.req('POST', '/v1/parking/deployment/phases/1/activation', 'pk-autorite', act)).json().code).toBe('ZONE_ACT_REQUIRED');
    expect((await env.req('POST', '/v1/parking/deployment/phases/2/activation', 'pk-autorite', act)).json().code).toBe('PREVIOUS_PHASE_REQUIRED');
    for (const z of [PARKING_DEMO.zoneGombeReal, PARKING_DEMO.zone30Juin]) {
      await env.req('POST', `/v1/parking/zones/${z}/tariff`, 'pk-regie', { tariffRuleCode: PARKING_DEMO.tariffRule, actReference: 'Arrêté FICTIF (test)' });
    }
    expect((await env.req('POST', '/v1/parking/deployment/phases/1/activation', 'pk-regie', act)).statusCode).toBe(403);
    const ok = await env.req('POST', '/v1/parking/deployment/phases/1/activation', 'pk-autorite', act);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('ACTIVEE');
  });
});
