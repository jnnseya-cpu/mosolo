import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { sha256Hex } from '../src/core/crypto.js';
import { CIRCUITS } from '../src/plugins/integrite/gouvernance/circuits.js';
import { planificationPlugin, type PlanificationService } from '../src/plugins/pilotage/planification/plugin.js';
import { additionalGrossMinor, EXEMPLE_ILLUSTRATIF } from '../src/plugins/pilotage/planification/model.js';
import { pilotagePlugin } from '../src/plugins/pilotage/plugin.js';
import { addMonths, BODIES, FUNCTIONS, HORIZONS, meetingOverdue, PHASES } from '../src/plugins/pilotage/programme/model.js';
import { programmePlugin } from '../src/plugins/pilotage/programme/plugin.js';
import { publishCertifiedRule, type TestEnv } from './helpers.js';

async function setup() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: {}, commsProviderKeys: {} }, plugins: [pilotagePlugin, planificationPlugin, programmePlugin] });
  await app.ready();
  const req = (method: string, url: string, user?: string, body?: unknown) => app.inject({
    method: method as 'GET', url,
    headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { app, clock, req, ctx: app.ctx };
}
type Env = Awaited<ReturnType<typeof setup>>;

const sha = (s: string) => sha256Hex(s);
const DIR = 'u-ministre-finances'; // direction de programme (R05)
const MOTIF = 'Motif détaillé de la démarche (test)';

async function meeting(env: Env, body: string, user: string, extra: Record<string, unknown> = {}) {
  const b = BODIES.find((x) => x.code === body)!;
  return env.req('POST', '/v1/pilotage/gouvernance/reunions', user, {
    body, date: '2026-09-26', attendees: [b.composition[0]!], agenda: ['Point unique (test)'],
    minutes: { reference: `PV-${body}-TEST`, sha256: sha(`pv-${body}`) }, decisions: ['Décision consignée (test)'], ...extra,
  });
}

async function proveAll(env: Env, phase: string, skip = 0) {
  const def = PHASES.find((p) => p.code === phase)!;
  const ids: string[] = [];
  for (const l of def.livrables.slice(skip)) {
    const r = await env.req('POST', `/v1/pilotage/feuille-de-route/phases/${phase}/preuves`, DIR, { livrable: l.code, reference: `DOC-${l.code}`, sha256: sha(l.code) });
    expect(r.statusCode).toBe(201);
    ids.push(r.json().id);
  }
  return ids;
}

/** Binômes pour tous les postes externes, jalons à échéance future. */
async function pairAll(env: Env, dueDate = '2026-12-31') {
  const om = (await env.req('GET', '/v1/pilotage/modele-operationnel', 'u-gouverneur')).json();
  const ext = om.functions.flatMap((f: { posts: { id: string; external: boolean; pairing?: unknown }[] }) => f.posts).filter((p: { external: boolean; pairing?: unknown }) => p.external && !p.pairing);
  for (const p of ext) {
    const r = await env.req('POST', `/v1/pilotage/modele-operationnel/postes/${p.id}/binome`, DIR, { agentLabel: 'Agent provincial désigné (poste à pourvoir)', motif: MOTIF, calendar: [{ label: 'Reprise de l’exploitation', dueDate }] });
    expect(r.statusCode).toBe(200);
  }
  return ext.length as number;
}

describe('Feuille de route (ch. 35) — référentiel, séquence, portes à deux personnes', () => {
  it('référentiel du Cahier : 7 phases, 5 horizons, 8 fonctions, 5 instances ; aucune date par défaut', async () => {
    expect(PHASES).toHaveLength(7);
    expect(PHASES[0]!.livrables.map((l) => l.label)).toEqual(['Décision provinciale', 'comité de pilotage', 'relevé juridique certifié', 'inventaire']);
    expect(PHASES[5]!.porteDeSortie).toBe('Autonomie des équipes provinciales');
    expect(HORIZONS.map((h) => h.label)).toEqual(['30 jours', '90 jours', '180 jours', '12 mois', '24 mois']);
    expect(HORIZONS[0]!.actions).toHaveLength(6);
    expect(FUNCTIONS).toHaveLength(8);
    expect(FUNCTIONS.find((f) => f.code === 'INGENIERIE')).toMatchObject({ effectifIndicatif: '6 à 10 développeurs, 1 architecte, 1 spécialiste données spatiales', externeParDefaut: true });
    const env = await setup();
    const v = (await env.req('GET', '/v1/pilotage/feuille-de-route', 'u-gouverneur')).json();
    expect(v.programme.startDate).toBeNull();
    expect(v.phases.map((p: { state: string }) => p.state)).toEqual(Array(7).fill('A_VENIR'));
    expect(v.horizons.every((h: { dueDate: string | null }) => h.dueDate === null)).toBe(true);
    expect(v.overdueActions).toHaveLength(0);
    // Démonstration : postes sans nom (« Poste à pourvoir »), marqués [EXEMPLE].
    const om = (await env.req('GET', '/v1/pilotage/modele-operationnel', 'u-gouverneur')).json();
    const posts = om.functions.flatMap((f: { posts: { holderLabel: string; roleLabel: string }[] }) => f.posts);
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((p: { holderLabel: string; roleLabel: string }) => p.holderLabel === 'Poste à pourvoir' && p.roleLabel.startsWith('[EXEMPLE]'))).toBe(true);
    expect(om.autonomy).toMatchObject({ transferred: 0, sharePct: '0.0' });
  });

  it('garde de séquence : une phase ne démarre pas avant que la porte précédente soit franchie', async () => {
    const env = await setup();
    const p1 = await env.req('POST', '/v1/pilotage/feuille-de-route/phases/P1/demarrage', DIR, { motif: MOTIF });
    expect(p1.statusCode).toBe(409);
    expect(p1.json().code).toBe('PHASE_PRECEDENTE_NON_FRANCHIE');
    expect((await env.req('POST', '/v1/pilotage/feuille-de-route/phases/P0/demarrage', DIR, { motif: MOTIF })).json().state).toBe('EN_COURS');
    expect((await env.req('POST', '/v1/pilotage/feuille-de-route/phases/P0/demarrage', DIR, { motif: MOTIF })).json().code).toBe('PHASE_DEJA_DEMARREE');
    expect((await env.req('POST', '/v1/pilotage/feuille-de-route/phases/P1/demarrage', DIR, { motif: MOTIF })).json().code).toBe('PHASE_PRECEDENTE_NON_FRANCHIE');
  });

  it('porte refusée sans preuve de chaque livrable ; bloquée sans binôme ou avec jalon de transfert en retard', async () => {
    const env = await setup();
    await env.req('POST', '/v1/pilotage/feuille-de-route/phases/P0/demarrage', DIR, { motif: MOTIF });
    const partial = await proveAll(env, 'P0', 1);
    const noProof = await env.req('POST', '/v1/pilotage/feuille-de-route/phases/P0/porte', DIR, { proofIds: partial, motif: MOTIF });
    expect(noProof.statusCode).toBe(422);
    expect(noProof.json().code).toBe('LIVRABLES_SANS_PREUVE');
    expect(noProof.json().missing.map((m: { code: string }) => m.code)).toEqual(['P0-L1']);
    // Empreinte invalide refusée.
    expect((await env.req('POST', '/v1/pilotage/feuille-de-route/phases/P0/preuves', DIR, { livrable: 'P0-L1', reference: 'DOC', sha256: 'abc' })).statusCode).toBe(400);
    const all = [...partial, ...(await proveAll(env, 'P0').then((ids) => ids.slice(0, 1)))];

    // Postes externes de démonstration sans binôme : porte bloquée, sans dérogation.
    const blocked = await env.req('POST', '/v1/pilotage/feuille-de-route/phases/P0/porte', DIR, { proofIds: all, motif: MOTIF });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('TRANSFERT_NON_CONFORME');
    expect(blocked.json().sansBinome.length).toBeGreaterThan(0);
    expect(blocked.json().detail).toMatch(/Aucune dérogation/);

    // Binômes désignés, mais un jalon est déjà échu : toujours bloquée.
    await pairAll(env, '2026-09-20');
    const late = await env.req('POST', '/v1/pilotage/feuille-de-route/phases/P0/porte', DIR, { proofIds: all, motif: MOTIF });
    expect(late.json().code).toBe('TRANSFERT_NON_CONFORME');
    expect(late.json().sansBinome).toHaveLength(0);
    expect(late.json().jalonsEnRetard.length).toBeGreaterThan(0);
    // Jalons réalisés avec preuve : indicateur d'autonomie à 100 %, porte demandable.
    for (const m of late.json().jalonsEnRetard as { postId: string; milestoneId: string }[]) {
      const r = await env.req('POST', `/v1/pilotage/modele-operationnel/postes/${m.postId}/jalons/${m.milestoneId}`, DIR, { reference: `PV-TRANSFERT-${m.milestoneId}`, sha256: sha(m.milestoneId) });
      expect(r.statusCode).toBe(200);
    }
    expect((await env.req('GET', '/v1/pilotage/modele-operationnel', 'u-gouverneur')).json().autonomy.sharePct).toBe('100.0');
    const ok = await env.req('POST', '/v1/pilotage/feuille-de-route/phases/P0/porte', DIR, { proofIds: all, motif: MOTIF });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().status).toBe('DEMANDEE');
  });

  it('décision de porte : quatre yeux, comité de pilotage, réunion consignée du comité ; puis la phase suivante démarre', async () => {
    const env = await setup();
    await env.req('POST', '/v1/pilotage/feuille-de-route/phases/P0/demarrage', DIR, { motif: MOTIF });
    const ids = await proveAll(env, 'P0');
    await pairAll(env);
    const g = (await env.req('POST', '/v1/pilotage/feuille-de-route/phases/P0/porte', DIR, { proofIds: ids, motif: MOTIF })).json();
    const url = `/v1/pilotage/feuille-de-route/portes/${g.id}/decision`;

    const same = await env.req('POST', url, DIR, { approve: true, motif: 'Je décide ma propre demande', meetingId: 'REUNION-X' });
    expect(same.statusCode).toBe(403);
    expect(same.json().code).toBe('SEPARATION_OF_DUTIES');
    expect((await env.req('POST', url, 'u-tresor', { approve: true, motif: 'Rôle hors comité de pilotage', meetingId: 'REUNION-X' })).statusCode).toBe(403);
    const noMeeting = await env.req('POST', url, 'u-gouverneur', { approve: true, motif: 'Sans réunion consignée', meetingId: 'REUNION-X' });
    expect(noMeeting.json().code).toBe('REUNION_COMITE_PILOTAGE_REQUISE');
    const tech = (await meeting(env, 'COMITE_TECHNIQUE', 'u-tresor')).json();
    expect((await env.req('POST', url, 'u-gouverneur', { approve: true, motif: 'Réunion d’une autre instance', meetingId: tech.id })).json().code).toBe('REUNION_COMITE_PILOTAGE_REQUISE');

    const cp = await meeting(env, 'COMITE_PILOTAGE', 'u-dircab', { decisions: ['Porte de la phase 0 franchie'] });
    expect(cp.statusCode).toBe(201);
    const dec = await env.req('POST', url, 'u-gouverneur', { approve: true, motif: 'Décision signée et référentiel juridique arrêté', meetingId: cp.json().id });
    expect(dec.statusCode).toBe(200);
    expect(dec.json()).toMatchObject({ status: 'FRANCHIE', decision: { by: 'u-gouverneur', meetingId: cp.json().id } });
    expect((await env.req('POST', url, 'u-dircab', { approve: false, motif: 'Seconde décision refusée', meetingId: cp.json().id })).json().code).toBe('ALREADY_DECIDED');

    const v = (await env.req('GET', '/v1/pilotage/feuille-de-route', 'u-gouverneur')).json();
    expect(v.phases[0].state).toBe('FRANCHIE');
    expect(v.phases[1].canStart).toBe(true);
    expect((await env.req('POST', '/v1/pilotage/feuille-de-route/phases/P1/demarrage', DIR, { motif: MOTIF })).json().state).toBe('EN_COURS');
    // La réunion du comité porte la trace de la décision.
    const gov = (await env.req('GET', '/v1/pilotage/gouvernance', 'u-gouverneur')).json();
    expect(gov.meetings.find((m: { id: string }) => m.id === cp.json().id).gateDecisions).toEqual([{ gateId: g.id, phase: 'P0', approve: true }]);

    // Journal : demande, décision ; circuit à deux personnes déclaré.
    const actions = env.ctx.audit.list({ limit: 100_000 }).items.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['pilotage.roadmap.phase_started', 'pilotage.roadmap.proof_recorded', 'pilotage.roadmap.gate_requested', 'pilotage.roadmap.gate_passed', 'pilotage.governance.meeting_recorded', 'pilotage.operating_model.pair_designated']));
    expect(CIRCUITS.some((c) => c.code === 'PILOTAGE_PORTE_PHASE')).toBe(true);
  });

  it('porte refusée par le comité : la phase reste fermée à la suite ; nouvelle demande possible', async () => {
    const env = await setup();
    await env.req('POST', '/v1/pilotage/feuille-de-route/phases/P0/demarrage', DIR, { motif: MOTIF });
    const ids = await proveAll(env, 'P0');
    await pairAll(env);
    const g = (await env.req('POST', '/v1/pilotage/feuille-de-route/phases/P0/porte', DIR, { proofIds: ids, motif: MOTIF })).json();
    const cp = (await meeting(env, 'COMITE_PILOTAGE', 'u-dircab')).json();
    const r = await env.req('POST', `/v1/pilotage/feuille-de-route/portes/${g.id}/decision`, 'u-gouverneur', { approve: false, motif: 'Relevé juridique incomplet', meetingId: cp.id });
    expect(r.json().status).toBe('REFUSEE');
    expect((await env.req('POST', '/v1/pilotage/feuille-de-route/phases/P1/demarrage', DIR, { motif: MOTIF })).json().code).toBe('PHASE_PRECEDENTE_NON_FRANCHIE');
    expect((await env.req('POST', '/v1/pilotage/feuille-de-route/phases/P0/porte', DIR, { proofIds: ids, motif: MOTIF })).statusCode).toBe(201);
  });
});

describe('Plans d’action datés (§ 35.2) — échéances relatives et retards (jour de Kinshasa)', () => {
  it('sans date de démarrage : aucune échéance ; avec date : retards calculés ; réalisation exige une preuve', async () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-08-01', 12)).toBe('2027-08-01');
    const env = await setup();
    expect((await env.req('POST', '/v1/pilotage/feuille-de-route/demarrage', DIR, { startDate: '2026-08-01', motif: MOTIF })).statusCode).toBe(200);
    let v = (await env.req('GET', '/v1/pilotage/feuille-de-route', 'u-gouverneur')).json();
    expect(v.horizons.map((h: { dueDate: string }) => h.dueDate)).toEqual(['2026-08-31', '2026-10-30', '2027-01-28', '2027-08-01', '2028-08-01']);
    expect(v.overdueActions).toHaveLength(6);
    expect(v.horizons[0].overdueCount).toBe(6);

    const noProof = await env.req('POST', '/v1/pilotage/feuille-de-route/actions/H30J-A1', DIR, { status: 'REALISEE', owner: 'Cabinet du Gouverneur' });
    expect(noProof.statusCode).toBe(422);
    expect(noProof.json().code).toBe('PREUVE_REQUISE');
    const done = await env.req('POST', '/v1/pilotage/feuille-de-route/actions/H30J-A1', DIR, { status: 'REALISEE', owner: 'Cabinet du Gouverneur', proof: { reference: 'ARRETE-TEST-001', sha256: sha('arrete') } });
    expect(done.json()).toMatchObject({ status: 'REALISEE', owner: 'Cabinet du Gouverneur' });
    v = (await env.req('GET', '/v1/pilotage/feuille-de-route', 'u-gouverneur')).json();
    expect(v.overdueActions).toHaveLength(5);

    // 30/10 à 23 h 30 UTC = 31/10 à Kinshasa : l'horizon de 90 jours (échéance 30/10) est en retard.
    env.clock.set('2026-10-30T22:30:00.000Z');
    v = (await env.req('GET', '/v1/pilotage/feuille-de-route', 'u-gouverneur')).json();
    expect(v.horizons[1].overdueCount).toBe(0);
    env.clock.set('2026-10-30T23:30:00.000Z');
    v = (await env.req('GET', '/v1/pilotage/feuille-de-route', 'u-gouverneur')).json();
    expect(v.horizons[1].overdueCount).toBe(6);
  });
});

describe('Gouvernance du programme (ch. 37) — instances, réunions, retards', () => {
  it('cinq instances ; réunion en retard selon la fréquence (valeurs par défaut à confirmer)', async () => {
    expect(BODIES.map((b) => [b.code, b.delaiJours])).toEqual([['COMITE_PILOTAGE', 31], ['COMITE_TECHNIQUE', 7], ['COMITE_JURIDIQUE_TARIFAIRE', null], ['CONTROLE_INDEPENDANT', 92], ['COMITE_DONNEES', 31]]);
    expect(BODIES.find((b) => b.code === 'COMITE_DONNEES')!.liens.map((l) => l.reference)).toEqual(expect.arrayContaining(['socle:export.committee', 'SOCLE_EXTRACTION_MASSIVE']));
    expect(meetingOverdue(7, '2026-09-01', '2026-09-08')).toBe(false);
    expect(meetingOverdue(7, '2026-09-01', '2026-09-09')).toBe(true);
    expect(meetingOverdue(null, null, '2026-09-09')).toBeNull();
    const env = await setup();
    let gov = (await env.req('GET', '/v1/pilotage/gouvernance', 'u-auditeur')).json();
    expect(gov.delaisNote).toMatch(/PAR_DEFAUT — à confirmer/);
    expect(gov.bodies.find((b: { code: string }) => b.code === 'COMITE_TECHNIQUE')).toMatchObject({ overdue: true, flag: 'Aucune réunion consignée' });
    expect((await meeting(env, 'COMITE_TECHNIQUE', 'u-tresor')).statusCode).toBe(201);
    env.clock.set('2026-10-03T09:00:00.000Z');
    gov = (await env.req('GET', '/v1/pilotage/gouvernance', 'u-auditeur')).json();
    expect(gov.bodies.find((b: { code: string }) => b.code === 'COMITE_TECHNIQUE')).toMatchObject({ overdue: false, nextDueDate: '2026-10-03' });
    env.clock.set('2026-10-04T09:00:00.000Z');
    gov = (await env.req('GET', '/v1/pilotage/gouvernance', 'u-auditeur')).json();
    expect(gov.bodies.find((b: { code: string }) => b.code === 'COMITE_TECHNIQUE')).toMatchObject({ overdue: true, flag: 'Réunion en retard' });
  });

  it('consignation : secrétariat de l’instance, participants par rôle, réunion tenue, procès-verbal avec empreinte', async () => {
    const env = await setup();
    expect((await meeting(env, 'COMITE_PILOTAGE', 'u-tresor')).json().code).toBe('SECRETARIAT_INSTANCE');
    expect((await meeting(env, 'COMITE_PILOTAGE', 'u-contribuable')).statusCode).toBe(403);
    expect((await meeting(env, 'COMITE_PILOTAGE', 'u-dircab', { attendees: ['Personne Nommée'] })).json().code).toBe('PARTICIPANT_PAR_ROLE');
    expect((await meeting(env, 'COMITE_PILOTAGE', 'u-dircab', { date: '2026-12-01' })).json().code).toBe('REUNION_FUTURE');
    expect((await meeting(env, 'COMITE_PILOTAGE', 'u-dircab', { minutes: { reference: 'PV', sha256: 'x' } })).statusCode).toBe(400);
    const ok = await meeting(env, 'COMITE_DONNEES', 'u-rssi', { attendees: ['Responsable des données', 'Délégué à la protection des données'] });
    expect(ok.statusCode).toBe(201);
  });

  it('comité juridique et tarifaire : chaque version de règle en attente de validation est rattachée à une réunion', async () => {
    const env = await setup();
    const rule = await publishCertifiedRule(env as unknown as TestEnv, { code: 'TEST-PROG-CJT' }, 1);
    expect(env.ctx.rules.rules.get(rule.id)!.status).toBe('REVUE_JURIDIQUE');
    let cjt = (await env.req('GET', '/v1/pilotage/gouvernance', 'u-gouverneur')).json().bodies.find((b: { code: string }) => b.code === 'COMITE_JURIDIQUE_TARIFAIRE');
    expect(cjt.overdue).toBeNull();
    expect(cjt.versionsEnAttente.find((r: { id: string }) => r.id === rule.id)).toMatchObject({ linked: false });
    expect(cjt.flag).toMatch(/version\(s\) de règle en attente sans réunion/);
    expect((await meeting(env, 'COMITE_TECHNIQUE', 'u-tresor', { ruleVersionIds: [rule.id] })).json().code).toBe('VERSIONS_HORS_INSTANCE');
    expect((await meeting(env, 'COMITE_JURIDIQUE_TARIFAIRE', 'u-juriste-verificateur', { ruleVersionIds: ['inconnue'] })).json().code).toBe('VERSION_REGLE_INCONNUE');
    const m = await meeting(env, 'COMITE_JURIDIQUE_TARIFAIRE', 'u-juriste-verificateur', { attendees: ['Juristes provinciaux', 'régies', 'contrôle'], ruleVersionIds: [rule.id] });
    expect(m.statusCode).toBe(201);
    cjt = (await env.req('GET', '/v1/pilotage/gouvernance', 'u-gouverneur')).json().bodies.find((b: { code: string }) => b.code === 'COMITE_JURIDIQUE_TARIFAIRE');
    expect(cjt.versionsEnAttente.find((r: { id: string }) => r.id === rule.id)).toMatchObject({ linked: true, meetings: [m.json().id] });
    expect(cjt.versionsEnAttente.every((r: { linked: boolean }) => r.linked) ? cjt.flag : null).toBeNull();
  });
});

describe('Politiques : refus par défaut', () => {
  it('lecture et écritures refusées hors rôles habilités', async () => {
    const env = await setup();
    for (const url of ['/v1/pilotage/feuille-de-route', '/v1/pilotage/modele-operationnel', '/v1/pilotage/gouvernance']) {
      expect((await env.req('GET', url, 'u-agent-terrain')).statusCode).toBe(403);
      expect((await env.req('GET', url, 'u-contribuable')).statusCode).toBe(403);
      expect((await env.req('GET', url)).statusCode).toBe(401);
    }
    expect((await env.req('POST', '/v1/pilotage/feuille-de-route/demarrage', 'u-auditeur', { startDate: '2026-10-01', motif: MOTIF })).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/pilotage/feuille-de-route/phases/P0/demarrage', 'u-gouverneur', { motif: MOTIF })).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/pilotage/modele-operationnel/postes', 'u-agent-terrain', { functionCode: 'INGENIERIE', roleLabel: 'Développeur' })).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/pilotage/feuille-de-route/phases/P0/porte', 'u-auditeur', { proofIds: ['x'], motif: MOTIF })).statusCode).toBe(403);
    // Poste interne : pas de binôme (réservé aux postes externes).
    const p = (await env.req('POST', '/v1/pilotage/modele-operationnel/postes', DIR, { functionCode: 'TRESORERIE_RAPPROCHEMENT', roleLabel: 'Comptable public dédié' })).json();
    expect(p).toMatchObject({ external: false, holderLabel: 'Poste à pourvoir' });
    expect((await env.req('POST', `/v1/pilotage/modele-operationnel/postes/${p.id}/binome`, DIR, { agentLabel: 'Agent', motif: MOTIF, calendar: [{ label: 'Jalon', dueDate: '2026-12-01' }] })).json().code).toBe('POSTE_NON_EXTERNE');
  });
});

describe('Exemple illustratif (§ 39.3) — lecture seule, même formule que le simulateur', () => {
  it('chaque ligne recalculée concorde avec le chiffre arrondi du Cahier (au million près)', async () => {
    // 2 000 000 × 158 × 0,27 = 85,32 M USD
    expect(additionalGrossMinor(2_000_000n * 15_800n, 270n)).toBe(8_532_000_000n);
    const env = await setup();
    const r = await env.req('GET', '/v1/pilotage/scenarios/exemple-illustratif', 'u-gouverneur');
    expect(r.statusCode).toBe(200);
    const x = r.json();
    expect(x.avertissement).toBe(EXEMPLE_ILLUSTRATIF.avertissement);
    expect(x.avertissement).toMatch(/^Les valeurs du tableau ci-dessus sont des hypothèses de travail/);
    expect(x).toMatchObject({ example: true, nonContractual: true, stored: false, concordance: true });
    expect(x.lignes.map((l: { gainCalcule: { amount: string } }) => l.gainCalcule.amount)).toEqual(['85320000.00', '16800000.00', '12600000.00', '6000000.00', '6750000.00']);
    for (const l of x.lignes) {
      expect(l.marque).toBe('[EXEMPLE] hypothèse');
      expect(l.gainMillionsCalcule).toBe(l.gainMillionsCahier);
    }
    expect((await env.req('GET', '/v1/pilotage/scenarios/exemple-illustratif', 'u-agent-terrain')).statusCode).toBe(403);
  });

  it('jamais enregistré comme hypothèse ; n’alimente ni les scénarios ni les tableaux', async () => {
    const env = await setup();
    const svc = env.ctx.ext.planification as PlanificationService;
    const strip = (o: Record<string, unknown>) => { const { generatedAt: _g, ...rest } = o; return rest; };
    const before = strip((await env.req('GET', '/v1/pilotage/scenarios', 'u-gouverneur')).json());
    const kpisBefore = (await env.req('GET', '/v1/pilotage/indicateurs', 'u-gouverneur')).json().kpis;
    const count = svc.hypotheses.count();
    await env.req('GET', '/v1/pilotage/scenarios/exemple-illustratif', 'u-gouverneur');
    expect(svc.hypotheses.count()).toBe(count);
    expect((await env.req('GET', '/v1/pilotage/scenarios/hypotheses', 'u-gouverneur')).json().items).toHaveLength(count);
    expect(strip((await env.req('GET', '/v1/pilotage/scenarios', 'u-gouverneur')).json())).toEqual(before);
    expect((await env.req('GET', '/v1/pilotage/indicateurs', 'u-gouverneur')).json().kpis).toEqual(kpisBefore);
    const json = JSON.stringify(before);
    for (const l of EXEMPLE_ILLUSTRATIF.lignes) expect(json).not.toContain(l.gainTexte);
  });
});
