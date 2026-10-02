import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { distanceM, offsetSouth } from '../src/plugins/terrain/geo.js';
import { terrainPlugin, type TerrainService } from '../src/plugins/terrain/plugin.js';
import { callbackBody, createOrder, signedCallback, type TestEnv } from './helpers.js';

async function setupTerrain() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} },
    plugins: [terrainPlugin],
  });
  await app.ready();
  const env: TestEnv = {
    app, clock,
    req: (method, url, user, body, headers = {}) =>
      app.inject({
        method: method as 'GET', url,
        headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
      }),
  };
  const svc = app.ctx.ext.terrain as TerrainService;
  return { env, svc, clock, req: env.req };
}

const day = (clock: ManualClock, n: number) => new Date(clock.now().getTime() + n * 86_400_000).toISOString().slice(0, 10);
const HASH = 'a'.repeat(64);

/** Sous-traitant accrédité (probatoire) + un agent habilité, par l'API. */
async function accreditedSubcontractor(t: Awaited<ReturnType<typeof setupTerrain>>) {
  const { req, clock } = t;
  const inv = await req('POST', '/v1/terrain/subcontractors', 'terrain-resp-module', {
    name: 'Test Terrain SARL', selectionReference: 'AMI-TEST-01', requestedModules: ['FONCIER_LOCATIF'], capacityAgents: 2, managerName: 'Resp Test',
  });
  expect(inv.statusCode).toBe(201);
  const { subcontractor, managerUserId } = inv.json();
  const id = subcontractor.id as string;
  expect(subcontractor.status).toBe('INVITE');
  expect((await req('POST', `/v1/terrain/subcontractors/${id}/dossier`, managerUserId, { rccm: 'RCCM-TEST', nif: 'NIF-TEST' })).json().status).toBe('EN_DILIGENCE');
  const proposal = { modules: ['FONCIER_LOCATIF'], communes: ['Limete'], validUntil: day(clock, 365), probationUntil: day(clock, 30), reason: 'Sélection AMI test' };
  // Diligence incomplète ⇒ proposition refusée.
  await req('POST', `/v1/terrain/subcontractors/${id}/diligence`, 'terrain-resp-module', { legalExistence: true, taxClearance: false, noConflictOfInterest: true, publicAgentLinksDeclared: true });
  expect((await req('POST', `/v1/terrain/subcontractors/${id}/accreditation/propose`, 'terrain-resp-module', proposal)).json().code).toBe('DILIGENCE_INCOMPLETE');
  await req('POST', `/v1/terrain/subcontractors/${id}/diligence`, 'terrain-resp-module', { legalExistence: true, taxClearance: true, noConflictOfInterest: true, publicAgentLinksDeclared: true });
  expect((await req('POST', `/v1/terrain/subcontractors/${id}/accreditation/propose`, 'terrain-resp-module', proposal)).statusCode).toBe(200);
  // Maker-checker : l'auteur de la proposition ne peut pas approuver.
  const self = await req('POST', `/v1/terrain/subcontractors/${id}/accreditation/approve`, 'terrain-resp-module', { reason: 'Auto-approbation' });
  expect(self.statusCode).toBe(403);
  expect(self.json().code).toBe('SEPARATION_OF_DUTIES');
  const ok = await req('POST', `/v1/terrain/subcontractors/${id}/accreditation/approve`, 'u-dg-dgipk', { reason: 'Dossier complet' });
  expect(ok.json().status).toBe('ACCREDITE_PROBATOIRE');
  return { id, managerUserId };
}

describe('Terrain — sous-traitance, habilitation et badges', () => {
  it('parcours d’accréditation, lot probatoire réduit, agent inactif jusqu’à habilitation par la régie', async () => {
    const t = await setupTerrain();
    const { req, clock } = t;
    const { id, managerUserId } = await accreditedSubcontractor(t);

    const big = await req('POST', '/v1/terrain/lots', 'terrain-resp-module', { subcontractorId: id, module: 'FONCIER_LOCATIF', commune: 'Limete', quartiers: ['Kingabwa'], periodStart: day(clock, 0), periodEnd: day(clock, 40), maxAgents: 20 });
    expect(big.json().code).toBe('PROBATION_LOT_TOO_LARGE');
    const outZone = await req('POST', '/v1/terrain/lots', 'terrain-resp-module', { subcontractorId: id, module: 'FONCIER_LOCATIF', commune: 'Gombe', quartiers: [], periodStart: day(clock, 0), periodEnd: day(clock, 40), maxAgents: 2 });
    expect(outZone.json().code).toBe('ZONE_NOT_ACCREDITED');
    const lotRes = await req('POST', '/v1/terrain/lots', 'terrain-resp-module', { subcontractorId: id, module: 'FONCIER_LOCATIF', commune: 'Limete', quartiers: ['Kingabwa'], periodStart: day(clock, 0), periodEnd: day(clock, 40), maxAgents: 1 });
    expect(lotRes.statusCode).toBe(201);
    const lot = lotRes.json();
    expect(lot.probation).toBe(true);

    // Le sous-traitant invite un agent : compte nominatif INACTIF.
    const agentRes = await req('POST', `/v1/terrain/subcontractors/${id}/agents`, managerUserId, { displayName: 'Agent Test', declaredQuartiers: ['Mososo'] });
    expect(agentRes.statusCode).toBe(201);
    const agentId = agentRes.json().id as string;
    expect(agentRes.json().status).toBe('INVITE');
    // Un sous-traitant n'invite pas dans une autre structure.
    expect((await req('POST', '/v1/terrain/subcontractors/ST-0001/agents', managerUserId, { displayName: 'Intrus' })).statusCode).toBe(403);

    // Mission du lot : hors lot refusée, dans le lot acceptée.
    const outside = await req('POST', '/v1/terrain/missions', managerUserId, { lotId: lot.id, title: 'Hors période', commune: 'Limete', quartier: 'Kingabwa', center: { lat: -4.3712, lon: 15.3441 }, objectives: { findings: 5 }, periodStart: day(clock, 0), dueDate: day(clock, 60) });
    expect(outside.json().code).toBe('MISSION_OUTSIDE_LOT');
    const noLot = await req('POST', '/v1/terrain/missions', managerUserId, { title: 'Sans lot', commune: 'Limete', center: { lat: -4.3712, lon: 15.3441 }, objectives: { findings: 5 }, periodStart: day(clock, 0), dueDate: day(clock, 10) });
    expect(noLot.statusCode).toBe(403);
    expect(noLot.json().code).toBe('MISSION_OUTSIDE_LOT');
    const otherLot = await req('POST', '/v1/terrain/missions', managerUserId, { lotId: 'LOT-LIM-01', title: 'Lot d’un autre', commune: 'Limete', center: { lat: -4.3712, lon: 15.3441 }, objectives: { findings: 5 }, periodStart: day(clock, 0), dueDate: day(clock, 10) });
    expect(otherLot.json().code).toBe('MISSION_OUTSIDE_LOT');
    const mRes = await req('POST', '/v1/terrain/missions', managerUserId, { lotId: lot.id, title: 'Recensement test', commune: 'Limete', quartier: 'Kingabwa', center: { lat: -4.3712, lon: 15.3441 }, objectives: { findings: 5 }, periodStart: day(clock, 0), dueDate: day(clock, 10) });
    expect(mRes.statusCode).toBe(201);
    const missionId = mRes.json().id as string;

    // Agent non habilité : aucune affectation, aucun constat.
    expect((await req('POST', `/v1/terrain/missions/${missionId}/assignment`, managerUserId, { agentId })).json().code).toBe('AGENT_NOT_HABILITATED');
    expect((await req('POST', `/v1/terrain/missions/${missionId}/findings`, agentId, { clientRef: 'x', outcome: 'ABSENT', observations: '', gps: { lat: -4.3712, lon: 15.3441, accuracyM: 5 }, capturedAt: clock.now().toISOString() })).json().code).toBe('AGENT_NOT_HABILITATED');

    // Le sous-traitant ne s'habilite pas lui-même ; la régie refuse sans certification.
    const hab = { identityVerified: true, trainingCertificateRef: 'CERT-1', trainingValidUntil: day(clock, 200), ethicsSigned: true, module: 'FONCIER_LOCATIF', communes: ['Limete'], validUntil: day(clock, 40) };
    expect((await req('POST', `/v1/terrain/agents/${agentId}/habilitation`, managerUserId, hab)).statusCode).toBe(403);
    expect((await req('POST', `/v1/terrain/agents/${agentId}/habilitation`, 'terrain-resp-module', { ...hab, trainingValidUntil: day(clock, -1) })).json().code).toBe('TRAINING_NOT_CERTIFIED');
    expect((await req('POST', `/v1/terrain/agents/${agentId}/habilitation`, 'terrain-resp-module', { ...hab, ethicsSigned: false })).json().code).toBe('ETHICS_NOT_SIGNED');
    expect((await req('POST', `/v1/terrain/agents/${agentId}/habilitation`, 'terrain-resp-module', { ...hab, communes: ['Gombe'] })).json().code).toBe('ZONE_NOT_ACCREDITED');
    const habOk = await req('POST', `/v1/terrain/agents/${agentId}/habilitation`, 'terrain-resp-module', hab);
    expect(habOk.statusCode).toBe(200);
    const badge = habOk.json().badge;
    expect(badge.shortCode).toMatch(/^AG-[0-9A-Z]{6}-[0-9A-Z]$/);
    expect(habOk.json().deviceKeyOnce).toBeTruthy();

    // Vérification publique (sans authentification) : minimale.
    const pub = await req('GET', `/v1/public/agent-badges/${badge.shortCode}`);
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).toMatchObject({ result: 'VALIDE', badge: { displayName: 'Agent Test', structure: 'Test Terrain SARL', module: 'FONCIER_LOCATIF', communes: ['Limete'] } });
    const text = pub.body;
    expect(text).not.toMatch(/phone|telephone|téléphone|adresse|address|agentId|taxpayer/i);
    expect(text).not.toContain(agentId);
    // QR signé : jeton correct accepté, jeton falsifié ⇒ inconnu.
    expect((await req('GET', `/v1/public/agent-badges/${badge.shortCode}?t=${badge.qrToken}`)).json().result).toBe('VALIDE');
    expect((await req('GET', `/v1/public/agent-badges/${badge.shortCode}?t=${'0'.repeat(24)}`)).json().result).toBe('INCONNU');
    expect((await req('GET', '/v1/public/agent-badges/AG-ZZZZZZ-Z')).json()).toMatchObject({ result: 'INCONNU', reportable: true });

    // Conflit d'intérêts : quartier déclaré.
    const m2 = await req('POST', '/v1/terrain/missions', 'terrain-resp-module', { lotId: lot.id, title: 'Mososo', commune: 'Limete', quartier: 'Kingabwa', center: { lat: -4.3712, lon: 15.3441 }, objectives: { findings: 1 }, periodStart: day(clock, 0), dueDate: day(clock, 5) });
    expect(m2.statusCode).toBe(201);
    t.svc.agents.update({ ...t.svc.agents.get(agentId)!, declaredQuartiers: ['Kingabwa'] });
    expect((await req('POST', `/v1/terrain/missions/${missionId}/assignment`, managerUserId, { agentId })).json().code).toBe('CONFLICT_OF_INTEREST');
    t.svc.agents.update({ ...t.svc.agents.get(agentId)!, declaredQuartiers: [] });
    const assigned = await req('POST', `/v1/terrain/missions/${missionId}/assignment`, managerUserId, { agentId });
    expect(assigned.json().status).toBe('AFFECTEE');

    // Suspension du sous-traitant (décision motivée) ⇒ tous ses agents, badges et terminaux révoqués.
    expect((await req('POST', `/v1/terrain/subcontractors/${id}/suspend`, 'terrain-resp-module', {})).statusCode).toBe(400);
    expect((await req('POST', `/v1/terrain/subcontractors/${id}/suspend`, 'u-agent-terrain', { reason: 'Tentative non habilitée' })).statusCode).toBe(403);
    const susp = await req('POST', `/v1/terrain/subcontractors/${id}/suspend`, 'terrain-resp-module', { reason: 'Encaissement signalé : enquête en cours' });
    expect(susp.json().agentsSuspended).toEqual([agentId]);
    expect((await req('GET', `/v1/public/agent-badges/${badge.shortCode}`)).json().result).toBe('SUSPENDU');
    expect(t.env.app.ctx.field.devices.find((d) => d.agentUserId === agentId).every((d) => d.status === 'REVOQUE')).toBe(true);
    expect(t.svc.missions.get(missionId)!.status).toBe('A_AFFECTER');
    // Levée : le sous-traitant revient, ses agents restent suspendus jusqu'à ré-habilitation.
    await req('POST', `/v1/terrain/subcontractors/${id}/reinstate`, 'u-dg-dgipk', { reason: 'Enquête close sans suite' });
    expect(t.svc.subcontractors.get(id)!.status).toBe('ACCREDITE_PROBATOIRE');
    expect(t.svc.agents.get(agentId)!.status).toBe('SUSPENDU');
    // Audit tracé.
    const actions = t.env.app.ctx.audit.list({ limit: 100000 }).items.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['terrain.subcontractor.invited', 'terrain.subcontractor.accredite_probatoire', 'terrain.agent.habilite', 'terrain.subcontractor.suspendu', 'terrain.agent.suspendu']));
  });

  it('fin de probation : décision humaine après la période ; capacité d’agents ; signalement public', async () => {
    const t = await setupTerrain();
    const { req, clock } = t;
    const { id, managerUserId } = await accreditedSubcontractor(t);
    expect((await req('POST', `/v1/terrain/subcontractors/${id}/accreditation/confirm`, 'u-dg-dgipk', { reason: 'Qualité satisfaisante' })).json().code).toBe('PROBATION_NOT_OVER');
    clock.advance(31 * 86_400_000);
    const conf = await req('POST', `/v1/terrain/subcontractors/${id}/accreditation/confirm`, 'u-dg-dgipk', { reason: 'Qualité satisfaisante' });
    expect(conf.json().subcontractor.status).toBe('ACCREDITE');
    await req('POST', `/v1/terrain/subcontractors/${id}/agents`, managerUserId, { displayName: 'A1' });
    await req('POST', `/v1/terrain/subcontractors/${id}/agents`, managerUserId, { displayName: 'A2' });
    expect((await req('POST', `/v1/terrain/subcontractors/${id}/agents`, managerUserId, { displayName: 'A3' })).json().code).toBe('AGENT_CAPACITY_REACHED');
    // Photo : jamais un binaire.
    expect((await req('POST', '/v1/terrain/agents', 'terrain-resp-module', { displayName: 'Interne', photoRef: 'data:image/png;base64,AAAA' })).statusCode).toBe(400);

    const before = t.env.app.ctx.alerts.list().length;
    const rep = await req('POST', '/v1/public/agent-badges/AG-FAUX00-0/reports', undefined, { kind: 'DEMANDE_ESPECES', place: 'Marché de Limete', description: 'Demande d’argent liquide' });
    expect(rep.statusCode).toBe(201);
    expect(rep.json().reference).toMatch(/^SIG-AG-/);
    expect(t.env.app.ctx.alerts.list().length).toBe(before + 1);
    expect(t.env.app.ctx.comms.deliveries.all().some((d) => d.eventCode === 'fraud.cash_request_reported' && d.recipientId === 'u-enqueteur')).toBe(true);
  });

  it('badges de démonstration vérifiables et réémission (ancien code révoqué)', async () => {
    const t = await setupTerrain();
    const { req } = t;
    const code = t.svc.badges.findOne((b) => b.agentId === 'u-agent-terrain' && b.status === 'ACTIF')!.shortCode;
    expect(code.startsWith('AG-7K4M2Q-')).toBe(true);
    expect((await req('GET', `/v1/public/agent-badges/${code.toLowerCase().replace(/-/g, ' ')}`)).json().result).toBe('VALIDE');
    expect((await req('POST', '/v1/terrain/agents/u-agent-terrain/badge/reissue', 'terrain-st-resp', { reason: 'Perte du badge' })).statusCode).toBe(403);
    const re = await req('POST', '/v1/terrain/agents/u-agent-terrain/badge/reissue', 'terrain-resp-module', { reason: 'Perte du badge' });
    expect(re.statusCode).toBe(200);
    expect((await req('GET', `/v1/public/agent-badges/${code}`)).json().result).toBe('REVOQUE');
    expect((await req('GET', `/v1/public/agent-badges/${re.json().shortCode}`)).json().result).toBe('VALIDE');
  });
});

describe('Terrain — missions et constats scellés', () => {
  it('constat géolocalisé : écart au point enregistré signalé (jamais rejeté), rejeu idempotent, aucune dette', async () => {
    const t = await setupTerrain();
    const { req, clock } = t;
    const obligations = t.env.app.ctx.assessment.obligations.count();
    const me = (await req('GET', '/v1/terrain/me', 'u-agent-terrain')).json();
    expect(me.missions.map((m: { id: string }) => m.id)).toContain('MIS-LIM-014');
    expect(me.badge.status).toBe('ACTIF');
    expect(me.cashHandled).toBe(false);

    const obj = t.env.app.ctx.objects.objects.get('OBJ-DEMO-UNITE-01')!;
    const near = { clientRef: 'r-near', objectId: obj.id, outcome: 'CONSTATE', observations: 'Occupé', gps: { lat: obj.lat, lon: obj.lon, accuracyM: 6 }, photoSha256: HASH, capturedAt: clock.now().toISOString(), deviceId: 'dev-terrain-001' };
    const r1 = await req('POST', '/v1/terrain/missions/MIS-LIM-014/findings', 'u-agent-terrain', near);
    expect(r1.statusCode).toBe(201);
    expect(r1.json().finding).toMatchObject({ flags: [], probativeStatus: 'OBSERVE', status: 'SOUMIS' });
    expect(r1.json().finding.seal).toMatch(/^[a-f0-9]{64}$/);
    // Rejeu identique ⇒ même constat ; même référence, autre contenu ⇒ conflit.
    const replay = await req('POST', '/v1/terrain/missions/MIS-LIM-014/findings', 'u-agent-terrain', near);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, finding: { id: r1.json().finding.id } });
    expect((await req('POST', '/v1/terrain/missions/MIS-LIM-014/findings', 'u-agent-terrain', { ...near, observations: 'Autre' })).statusCode).toBe(409);

    const far = offsetSouth(obj, 430);
    const expected = distanceM(far, obj);
    const r2 = await req('POST', '/v1/terrain/missions/MIS-LIM-014/findings', 'u-agent-terrain', { ...near, clientRef: 'r-far', gps: { ...far, accuracyM: 7 } });
    expect(r2.statusCode).toBe(201);
    expect(r2.json().finding.flags).toContain('DISTANCE');
    expect(r2.json().finding.flagMessage).toBe(`Opération effectuée à ${expected} m du point enregistré — vérification requise`);
    expect(expected).toBeGreaterThanOrEqual(428);
    expect(expected).toBeLessThanOrEqual(432);
    expect(t.env.app.ctx.comms.deliveries.all().some((d) => d.eventCode === 'mission.geofence.breach')).toBe(true);

    // Garde-fous : binaire refusé, champ de montant refusé, terminal révoqué refusé, mission d'un autre refusée.
    expect((await req('POST', '/v1/terrain/missions/MIS-LIM-014/findings', 'u-agent-terrain', { ...near, clientRef: 'r-b', photoSha256: 'data:image/jpeg;base64,/9j/' })).statusCode).toBe(400);
    expect((await req('POST', '/v1/terrain/missions/MIS-LIM-014/findings', 'u-agent-terrain', { ...near, clientRef: 'r-m', amount: { amount: '10.00', currency: 'USD' } })).statusCode).toBe(400);
    expect((await req('POST', '/v1/terrain/missions/MIS-LIM-014/findings', 'u-agent-terrain', { ...near, clientRef: 'r-d', deviceId: 'dev-terrain-perdu' })).json().code).toBe('DEVICE_REVOKED');
    expect((await req('POST', '/v1/terrain/missions/MIS-LIM-014/findings', 'u-agent-terrain-2', { ...near, clientRef: 'r-o' })).json().code).toBe('MISSION_NOT_ASSIGNED');
    // Hors période de mission.
    clock.advance(30 * 86_400_000);
    expect((await req('POST', '/v1/terrain/missions/MIS-LIM-014/findings', 'u-agent-terrain', { ...near, clientRef: 'r-late', capturedAt: clock.now().toISOString() })).json().code).toBe('OUTSIDE_MISSION_PERIOD');

    // Un constat ne crée jamais d'obligation.
    expect(t.env.app.ctx.assessment.obligations.count()).toBe(obligations);
  });

  it('validation indépendante : ni l’auteur, ni sa structure ; constat revu figé', async () => {
    const t = await setupTerrain();
    const { req } = t;
    const stFinding = t.svc.findings.findOne((f) => f.subcontractorId === 'ST-0001' && f.status === 'SOUMIS')!;
    expect((await req('POST', `/v1/terrain/findings/${stFinding.id}/review`, 'terrain-st-resp', { decision: 'VALIDE', reason: 'Auto-validation' })).statusCode).toBe(403);
    expect((await req('POST', `/v1/terrain/findings/${stFinding.id}/review`, 'terrain-st-agent-1', { decision: 'VALIDE', reason: 'Auto-validation' })).statusCode).toBe(403);
    const ok = await req('POST', `/v1/terrain/findings/${stFinding.id}/review`, 'u-controleur', { decision: 'REJETE', reason: 'Photo absente, objet non retrouvé' });
    expect(ok.json().status).toBe('REJETE');
    expect((await req('POST', `/v1/terrain/findings/${stFinding.id}/review`, 'u-controleur', { decision: 'VALIDE', reason: 'Changement d’avis' })).json().code).toBe('FINDING_ALREADY_REVIEWED');
    // Le sous-traitant ne voit que ses constats.
    const list = (await req('GET', '/v1/terrain/findings', 'terrain-st-resp')).json().items as { subcontractorId?: string }[];
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((f) => f.subcontractorId === 'ST-0001')).toBe(true);
    const agentList = (await req('GET', '/v1/terrain/findings', 'u-agent-terrain-2')).json().items;
    expect(agentList).toEqual([]);
  });
});

describe('Terrain — contrôle qualité, contrôles mystère, rémunération indicative', () => {
  it('échantillonnage (≥ 5 % + 100 % des cas à risque), contre-visite indépendante, taux d’erreur', async () => {
    const t = await setupTerrain();
    const { req } = t;
    expect((await req('POST', '/v1/terrain/quality/samples', 'u-controleur', { ratePercent: 2 })).json().code).toBe('SAMPLE_RATE_TOO_LOW');
    expect((await req('POST', '/v1/terrain/quality/samples', 'terrain-st-resp', { ratePercent: 10 })).statusCode).toBe(403);
    const flagged = t.svc.findings.find((f) => f.status === 'SOUMIS' && f.flags.includes('DISTANCE'));
    expect(flagged.length).toBeGreaterThan(0);
    const s = await req('POST', '/v1/terrain/quality/samples', 'u-controleur', { ratePercent: 5 });
    expect(s.statusCode).toBe(201);
    const { sample, counterVisits } = s.json();
    for (const f of flagged) expect(sample.riskSelected).toContain(f.id);
    expect(sample.randomSelected.length).toBeGreaterThanOrEqual(1);
    const cv = counterVisits.find((c: { findingId: string }) => c.findingId === flagged[0]!.id);

    // Indépendance : ni l'auteur, ni un agent de sous-traitant.
    expect((await req('POST', `/v1/terrain/counter-visits/${cv.id}/assignment`, 'u-controleur', { agentId: flagged[0]!.agentId })).json().code).toBe('SEPARATION_OF_DUTIES');
    expect((await req('POST', `/v1/terrain/counter-visits/${cv.id}/assignment`, 'u-controleur', { agentId: 'terrain-st-agent-1' })).json().code).toBe('NOT_INDEPENDENT');
    // Décision impossible avant la contre-visite.
    expect((await req('POST', `/v1/terrain/findings/${flagged[0]!.id}/review`, 'u-controleur', { decision: 'VALIDE', reason: 'Trop tôt' })).json().code).toBe('COUNTER_VISIT_PENDING');
    expect((await req('POST', `/v1/terrain/counter-visits/${cv.id}/assignment`, 'u-controleur', { agentId: 'terrain-agent-regie-qc' })).json().status).toBe('A_FAIRE');
    const f0 = flagged[0]!;
    expect((await req('POST', `/v1/terrain/counter-visits/${cv.id}/result`, 'u-agent-terrain-2', { result: 'CONFORME', notes: 'x'.repeat(5), gps: f0.gps })).statusCode).toBe(403);
    const done = await req('POST', `/v1/terrain/counter-visits/${cv.id}/result`, 'terrain-agent-regie-qc', { result: 'NON_CONFORME', notes: 'Objet introuvable à l’adresse', gps: { lat: f0.reference.lat, lon: f0.reference.lon, accuracyM: 5 } });
    expect(done.json()).toMatchObject({ proposal: 'REJETER', counterVisit: { status: 'REALISEE' } });
    // La proposition ne décide pas : le constat reste à revoir.
    expect(t.svc.findings.get(f0.id)!.status).toBe('A_CONTRE_VISITER');
    await req('POST', `/v1/terrain/findings/${f0.id}/review`, 'u-controleur', { decision: 'REJETE', reason: 'Contre-visite non conforme' });

    const board = (await req('GET', '/v1/terrain/quality', 'u-controleur')).json();
    const row = board.byAgent.find((r: { key: string }) => r.key === f0.agentId);
    expect(row.counterVisitsDone).toBe(1);
    expect(row.nonConforming).toBe(1);
    expect(row.errorRatePct).toBe('100.0');
    const st = board.bySubcontractor.find((r: { key: string }) => r.key === 'ST-0001');
    expect(st.errorRatePct).toBe('0.0');
    // Le sous-traitant voit sa propre qualité seulement.
    const own = (await req('GET', '/v1/terrain/quality', 'terrain-st-resp')).json();
    expect(own.bySubcontractor.map((r: { key: string }) => r.key)).toEqual(['ST-0001']);
  });

  it('contrôle mystère : irrégularité ⇒ alerte et proposition, jamais de sanction automatique ; résultats publics agrégés', async () => {
    const t = await setupTerrain();
    const { req, clock } = t;
    const plan = await req('POST', '/v1/terrain/mystery-checks', 'u-enqueteur', { targetKind: 'AGENT', targetId: 'terrain-st-agent-1', plannedFor: day(clock, 1) });
    expect(plan.statusCode).toBe(201);
    expect((await req('POST', '/v1/terrain/mystery-checks', 'terrain-st-resp', { targetKind: 'AGENT', targetId: 'terrain-st-agent-1', plannedFor: day(clock, 1) })).statusCode).toBe(403);
    const r = await req('POST', `/v1/terrain/mystery-checks/${plan.json().id}/result`, 'u-enqueteur', { result: 'IRREGULARITE', notes: 'Demande d’espèces constatée' });
    expect(r.json().proposal).toMatch(/décision motivée/);
    expect(t.svc.agents.get('terrain-st-agent-1')!.status).toBe('HABILITE');
    expect(t.env.app.ctx.alerts.list().some((a) => a.type === 'MYSTERY_CHECK_IRREGULARITY')).toBe(true);
    const pub = (await req('GET', '/v1/public/terrain/mystery-checks/summary')).json();
    expect(pub).toMatchObject({ performed: 3, withoutIrregularity: 2, aggregated: true });
    expect(JSON.stringify(pub)).not.toContain('terrain-st-agent-1');
  });

  it('rémunération indicative sur livrables vérifiés, indépendante des paiements des contribuables', async () => {
    const t = await setupTerrain();
    const { req } = t;
    const r1 = (await req('GET', '/v1/terrain/subcontractors/ST-0001/remuneration', 'terrain-st-resp')).json();
    expect(r1).toMatchObject({ available: true, indicative: true, example: true, basis: 'LIVRABLES_VERIFIES' });
    const validated = t.svc.findings.find((f) => f.subcontractorId === 'ST-0001' && f.status === 'VALIDE').length;
    expect(r1.lines[0].count).toBe(validated);
    expect(r1.total.amount).toMatch(/^\d+\.\d{2}$/);
    expect(r1.notice).toMatch(/Jamais un pourcentage des recettes/);
    // Un paiement confirmé d'un contribuable ne change rien au calcul.
    const order = (await createOrder(t.env)).json();
    expect((await signedCallback(t.env, callbackBody(t.env, order.paymentReference), { secret: 'test-secret-mm-operator-a' })).statusCode).toBe(200);
    const r2 = (await req('GET', '/v1/terrain/subcontractors/ST-0001/remuneration', 'terrain-st-resp')).json();
    expect(r2.total).toEqual(r1.total);
    // Un autre sous-traitant ne voit pas cette rémunération ; un agent non plus.
    expect((await req('GET', '/v1/terrain/subcontractors/ST-0001/remuneration', 'terrain-st2-resp')).statusCode).toBe(403);
    expect((await req('GET', '/v1/terrain/subcontractors/ST-0001/remuneration', 'u-agent-terrain')).statusCode).toBe(403);
    // Aucune route d'encaissement dans le module.
    const routes = t.env.app.printRoutes();
    expect(routes).not.toMatch(/terrain[^\n]*(cash|encaiss|payment)/i);
  });

  it('indicateurs de production et tolérance GPS par commune (paramètre de la régie)', async () => {
    const t = await setupTerrain();
    const { req } = t;
    const ind = (await req('GET', '/v1/terrain/indicators', 'u-superviseur')).json();
    expect(ind.cashHandled).toBe(false);
    expect(ind.missions.total).toBeGreaterThan(0);
    expect(ind.byCommune.every((c: { commune: string }) => ['Limete', 'Lemba', 'Matete', 'Ngaba'].includes(c.commune))).toBe(true);
    expect((await req('GET', '/v1/terrain/indicators', 'u-contribuable')).statusCode).toBe(403);
    expect((await req('PUT', '/v1/terrain/settings/gps-tolerance/Limete', 'terrain-resp-module', { meters: 80, reason: 'Densité du bâti' })).statusCode).toBe(403);
    const put = await req('PUT', '/v1/terrain/settings/gps-tolerance/Limete', 'u-dg-dgipk', { meters: 80, reason: 'Densité du bâti' });
    expect(put.json().byCommune.Limete).toBe(80);
    // Le superviseur ne voit que les missions de son territoire.
    const ms = (await req('GET', '/v1/terrain/missions', 'u-superviseur')).json().items as { commune: string }[];
    expect(ms.some((m) => m.commune === 'Gombe')).toBe(false);
    // L'agent Gombe ne voit que ses missions.
    const mg = (await req('GET', '/v1/terrain/missions', 'u-agent-gombe')).json().items as { id: string }[];
    expect(mg.map((m) => m.id)).toEqual(['MIS-GOM-002']);
  });
});
