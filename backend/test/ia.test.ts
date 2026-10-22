import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AiActor } from '../src/core/auth.js';
import { ManualClock } from '../src/core/clock.js';
import { assertAiMay } from '../src/core/policy.js';
import { AGENTS } from '../src/plugins/ia/catalogue.js';
import { DataGateway } from '../src/plugins/ia/gateway.js';
import { iaPlugin } from '../src/plugins/ia/plugin.js';
import type { IaService } from '../src/plugins/ia/service.js';
import { DEMO } from '../src/seed.js';
import type { TestEnv } from './helpers.js';

const FIELDS = ['situation', 'insight', 'risk', 'recommendation', 'nextAction', 'owner', 'deadline', 'confidence'] as const;

async function setupIa() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} },
    plugins: [iaPlugin],
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
  const svc = app.ctx.ext['ia'] as IaService;
  return { env, svc, ctx: app.ctx };
}

type Ctx = Awaited<ReturnType<typeof setupIa>>['ctx'];

/** Unité locative sans bail (rang 2) : matière réelle pour les agents locatif, découverte et missions. */
function addUnitWithoutLease(ctx: Ctx, id = 'OBJ-TEST-UNITE-02', commune = 'Limete', agent = 'u-agent-terrain') {
  return ctx.objects.create(ctx.users.get(agent)!, {
    taxpayerId: DEMO.taxpayerId, category: 'UNITE_LOCATIVE', commune, quartier: 'Quartier test', localityRank: 2, lat: -4.37, lon: 15.34,
    attributes: { parcelleId: DEMO.parcelId, niveau: 'étage 1' },
  }, id);
}

const RUNNER: Record<string, string> = {
  DECOUVERTE: 'u-dg-dgipk', ENROLEMENT: 'u-contribuable', APPRENTISSAGE_USAGER: 'u-contribuable', COPILOTE: 'u-contentieux',
  VEILLE_JURIDIQUE: 'u-juriste-verificateur', INTELLIGENCE_LOCATIVE: 'u-superviseur', MISSIONS_TERRAIN: 'u-superviseur', RAPPROCHEMENT: 'u-tresor',
  FRAUDE: 'u-enqueteur', PREVISION: 'u-ministre-finances', DECISION_EXECUTIVE: 'u-gouverneur', ALLOCATION: 'u-ministre-finances',
  APPRENTISSAGE_CONTINU: 'ia-gestionnaire-modeles', COMMUNICATION: 'u-admin-entite',
};

describe('IA — catalogue des agents et sortie standard', () => {
  it('expose les 13 agents métier + Communication avec leur fiche de contrôle ; le contribuable ne voit que ses agents', async () => {
    const { env } = await setupIa();
    const list = (await env.req('GET', '/v1/ia/agents', 'u-auditeur')).json();
    expect(list).toHaveLength(14);
    for (const a of list) {
      expect(a.mission, a.code).toBeTruthy();
      expect(a.allowedData.length, a.code).toBeGreaterThan(0);
      expect(['A_AUTO', 'B_VALIDATION', 'C_RECOMMANDATION']).toContain(a.autonomy);
      expect(a.promptVersion).toMatch(new RegExp(`^${a.code.toLowerCase()}-v1-[0-9a-f]{10}$`));
      expect(a.validators.length).toBeGreaterThan(0);
    }
    const mine = (await env.req('GET', '/v1/ia/agents', 'u-contribuable')).json();
    expect(mine.map((a: { code: string }) => a.code).sort()).toEqual(['APPRENTISSAGE_USAGER', 'ENROLEMENT']);
  });

  it('chaque agent produit la sortie à 8 rubriques, journalisée (finalité, versions, empreintes, données citées) ; rôle non habilité refusé', async () => {
    const { env, ctx } = await setupIa();
    addUnitWithoutLease(ctx);
    for (const [code, user] of Object.entries(RUNNER)) {
      const res = await env.req('POST', `/v1/ia/agents/${code}/run`, user, { purpose: `Test de l’agent ${code}` });
      expect(res.statusCode, `${code}: ${res.body}`).toBe(201);
      const recs = res.json();
      expect(recs.length, code).toBeGreaterThan(0);
      for (const r of recs) {
        for (const f of FIELDS) expect(r[f], `${code}.${f}`).toBeTruthy();
        expect(r.owner, code).not.toMatch(/^(l['’])?IA\b/);
        expect(r.agentCode).toBe(code);
        expect(r.promptVersion).toMatch(/-v1-/);
        expect(r.modelVersion).toBe('regles-deterministes-ia-2.0');
        expect(r.inputHash).toMatch(/^[0-9a-f]{64}$/);
        expect(r.outputHash).toMatch(/^[0-9a-f]{64}$/);
        expect(r.notice).toMatch(/assistance de l’IA/);
        expect(r.citations.length, `${code} cite ses données`).toBeGreaterThan(0);
      }
    }
    const gen = (await env.req('GET', '/v1/ia/journal?type=GENERATION', 'u-auditeur')).json();
    expect(gen.length).toBeGreaterThanOrEqual(14);
    for (const j of gen) {
      expect(j.purpose).toBeTruthy();
      expect(j.promptVersion).toBeTruthy();
      expect(j.input.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(j.input.domains.length).toBeGreaterThan(0);
      expect(j.output.hash).toMatch(/^[0-9a-f]{64}$/);
    }
    // Refus d'accès : rôle non listé dans la fiche.
    expect((await env.req('POST', '/v1/ia/agents/FRAUDE/run', 'u-agent-terrain', { purpose: 'Curiosité' })).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/ia/agents/DECOUVERTE/run', 'u-contribuable', { purpose: 'Test' })).statusCode).toBe(403);
    // Finalité déclarée obligatoire.
    expect((await env.req('POST', '/v1/ia/agents/PREVISION/run', 'u-ministre-finances', {})).statusCode).toBe(400);
  });

  it('passerelle : un agent ne lit que les domaines de sa fiche', async () => {
    const { ctx } = await setupIa();
    const gw = new DataGateway(ctx, AGENTS.PREVISION, '2026-09-26');
    expect(() => gw.objects()).toThrow(/IA_DATA_DOMAIN_FORBIDDEN|n'est pas autorisé/);
    expect(() => gw.auditMeta()).toThrow();
    expect(() => gw.obligations()).not.toThrow();
  });

  it('dédoublonnage : une recommandation identique en attente est réutilisée ; les actions A ne sont pas rejouées', async () => {
    const { env, ctx } = await setupIa();
    const a = (await env.req('POST', '/v1/ia/agents/VEILLE_JURIDIQUE/run', 'u-juriste-verificateur', { purpose: 'Veille' })).json();
    const effects = ctx.ext['ia'] ? (ctx.ext['ia'] as IaService).effects.count() : 0;
    const b = (await env.req('POST', '/v1/ia/agents/VEILLE_JURIDIQUE/run', 'u-juriste-verificateur', { purpose: 'Veille' })).json();
    expect(b[0].id).toBe(a[0].id);
    expect((ctx.ext['ia'] as IaService).effects.count()).toBe(effects);
  });
});

describe('IA — niveaux d’autonomie', () => {
  it('niveau A : exécuté par l’agent et journalisé ; désactivable par le responsable de l’entité ; exécution manuelle ensuite', async () => {
    const { env, ctx, svc } = await setupIa();
    addUnitWithoutLease(ctx);
    const [rec] = (await env.req('POST', '/v1/ia/agents/DECOUVERTE/run', 'u-dg-dgipk', { purpose: 'Recherche de gisements' })).json();
    expect(rec.autonomy).toBe('C_RECOMMANDATION');
    const act = rec.actions.find((a: { level: string }) => a.level === 'A');
    expect(act.status).toBe('EXECUTEE_AUTO');
    const effect = svc.effects.get(act.effectId)!;
    expect(effect).toMatchObject({ type: 'BROUILLON', createdByKind: 'ai', status: 'ACTIF' });
    const auto = ctx.audit.list({ action: 'ia.action.executed' }).items;
    expect(auto.at(-1)!.actor.kind).toBe('ai');
    expect((await env.req('GET', '/v1/ia/journal?type=EXECUTION_AUTO', 'u-auditeur')).json().length).toBeGreaterThan(0);

    // Un administrateur d'une autre entité ne peut rien changer ; celui de la DGIPK désactive le niveau A.
    const body = { levelAEnabled: false, disabledActions: [], disabledAgents: [], reason: 'Période de rodage : validation manuelle' };
    expect((await env.req('PUT', '/v1/ia/autonomy/DGIPK', 'ia-admin-tresor', body)).statusCode).toBe(403);
    expect((await env.req('PUT', '/v1/ia/autonomy/DGIPK', 'u-agent-terrain', body)).statusCode).toBe(403);
    const put = await env.req('PUT', '/v1/ia/autonomy/DGIPK', 'u-admin-entite', body);
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ entity: 'DGIPK', levelAEnabled: false, canEdit: true });

    addUnitWithoutLease(ctx, 'OBJ-TEST-UNITE-03');
    const before = svc.effects.count();
    const [rec2] = (await env.req('POST', '/v1/ia/agents/DECOUVERTE/run', 'u-dg-dgipk', { purpose: 'Recherche de gisements' })).json();
    expect(rec2.id).not.toBe(rec.id);
    expect(rec2.actions[0]).toMatchObject({ status: 'NON_EXECUTEE_DESACTIVEE', blockedReason: expect.stringMatching(/désactivée/) });
    expect(svc.effects.count()).toBe(before);
    expect((await env.req('GET', '/v1/ia/journal?type=BLOCAGE_AUTONOMIE', 'u-auditeur')).json().length).toBe(1);
    // Exécution manuelle par un validateur habilité : effet créé au nom de l'humain.
    const v = await env.req('POST', `/v1/ia/recommendations/${rec2.id}/validate`, 'u-dg-dgipk', { reason: 'Fiche utile, à instruire' });
    expect(v.statusCode, v.body).toBe(200);
    expect(v.json().actions[0]).toMatchObject({ status: 'EXECUTEE', executedBy: 'u-dg-dgipk', executedByKind: 'user' });
    // Désactivation ciblée d'un agent seulement.
    await env.req('PUT', '/v1/ia/autonomy/DGIPK', 'u-admin-entite', { levelAEnabled: true, disabledActions: [], disabledAgents: ['DECOUVERTE'], reason: 'Agent en revue' });
    addUnitWithoutLease(ctx, 'OBJ-TEST-UNITE-04');
    const [rec3] = (await env.req('POST', '/v1/ia/agents/DECOUVERTE/run', 'u-dg-dgipk', { purpose: 'Recherche' })).json();
    expect(rec3.actions[0].status).toBe('NON_EXECUTEE_DESACTIVEE');
  });

  it('niveau B : rien n’est envoyé avant validation ; exécution au nom du validateur (jamais de l’IA) ; annulation possible', async () => {
    const { env, ctx, svc } = await setupIa();
    addUnitWithoutLease(ctx);
    const sent = () => ctx.comms.deliveries.find((d) => d.eventCode === 'rental.occupancy.inconsistency').length;
    const recs = (await env.req('POST', '/v1/ia/agents/INTELLIGENCE_LOCATIVE/run', 'u-superviseur', { purpose: 'Qualifier les unités sans bail' })).json();
    const rec = recs.find((r: { subject?: { id: string } }) => r.subject?.id === 'OBJ-TEST-UNITE-02');
    expect(rec).toMatchObject({ autonomy: 'B_VALIDATION', status: 'EMISE' });
    expect(rec.factors.map((f: { label: string }) => f.label)).toContain('Aucun bail en cours déclaré');
    expect(rec.situation).toMatch(/0,70/);
    expect(rec.factors.map((f: { label: string }) => f.label)).toContain('Autres unités louées sur la même parcelle');
    expect(rec.actions[0]).toMatchObject({ type: 'DEMANDER_PIECES', level: 'B', status: 'PROPOSEE' });
    expect(sent()).toBe(0);
    // L'IA ne peut jamais exécuter une action de niveau B.
    const ai: AiActor = { kind: 'ai', id: 'agent:INTELLIGENCE_LOCATIVE', agent: 'Intelligence locative' };
    expect(() => assertAiMay(ai, 'ia:action.DEMANDER_PIECES')).toThrow();
    // Acceptation simple refusée : il faut valider (un clic) pour exécuter.
    expect((await env.req('POST', `/v1/ia/recommendations/${rec.id}/decide`, 'u-superviseur', { decision: 'ACCEPTEE', reason: 'Accord' })).json().code).toBe('VALIDATION_REQUIRED');
    // Un contrôleur (qui peut solliciter l'agent) n'est pas validateur.
    expect((await env.req('POST', `/v1/ia/recommendations/${rec.id}/validate`, 'u-controleur', { reason: 'Je valide' })).statusCode).toBe(403);
    env.clock.advance(90_000);
    const v = await env.req('POST', `/v1/ia/recommendations/${rec.id}/validate`, 'u-superviseur', { reason: 'Demande justifiée' });
    expect(v.statusCode, v.body).toBe(200);
    const done = v.json();
    expect(done).toMatchObject({ status: 'ACCEPTEE', decidedBy: 'u-superviseur', decidedByRole: 'R09', decisionLatencyMs: 90_000 });
    expect(done.notice).toMatch(/validé par R09/);
    expect(sent()).toBeGreaterThan(0);
    const effect = done.effects[0];
    expect(effect).toMatchObject({ type: 'DEMANDE_PIECES', createdBy: 'u-superviseur', createdByKind: 'user', status: 'ACTIF' });
    const exec = ctx.audit.list({ action: 'ia.action.executed' }).items.find((a) => a.details['effectId'] === effect.id)!;
    expect(exec.actor).toMatchObject({ kind: 'user', id: 'u-superviseur' });
    // Annulation (acte contraire journalisé).
    const u = await env.req('POST', `/v1/ia/recommendations/${rec.id}/actions/ACT-1/undo`, 'u-superviseur', { reason: 'Bail retrouvé au dossier papier' });
    expect(u.statusCode, u.body).toBe(200);
    expect(u.json().status).toBe('ANNULEE');
    expect(svc.effects.get(effect.id)).toMatchObject({ status: 'ANNULE', undoneBy: 'u-superviseur' });
    expect((await env.req('POST', `/v1/ia/recommendations/${rec.id}/actions/ACT-1/undo`, 'u-superviseur', { reason: 'Encore' })).statusCode).toBe(409);
    const j = (await env.req('GET', `/v1/ia/journal?recommendationId=${rec.id}`, 'u-auditeur')).json().map((e: { type: string }) => e.type);
    expect(j).toEqual(expect.arrayContaining(['GENERATION', 'EXECUTION', 'VALIDATION', 'ANNULATION']));
  });

  it('niveau B : mission terrain jamais affectée hors périmètre', async () => {
    const { env, ctx } = await setupIa();
    addUnitWithoutLease(ctx, 'OBJ-TEST-GOMBE', 'Gombe', 'u-agent-gombe');
    const recs = (await env.req('POST', '/v1/ia/agents/MISSIONS_TERRAIN/run', 'u-superviseur', { purpose: 'Planifier la semaine' })).json();
    const limete = recs.find((r: { subject: { id: string } }) => r.subject.id === 'Limete');
    const gombe = recs.find((r: { subject: { id: string } }) => r.subject.id === 'Gombe');
    expect(limete.actions[0].params.agentUserId).toBe('u-agent-terrain');
    expect(gombe.actions[0].params.agentUserId).toBe('u-agent-gombe');
    const ok = await env.req('POST', `/v1/ia/recommendations/${limete.id}/validate`, 'u-superviseur', { reason: 'Tournée validée' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ctx.comms.deliveries.find((d) => d.eventCode === 'mission.assigned' && d.recipientId === 'u-agent-terrain').length).toBeGreaterThan(0);
    // Gombe n'est pas dans le périmètre du superviseur de Limete.
    const ko = await env.req('POST', `/v1/ia/recommendations/${gombe.id}/validate`, 'u-superviseur', { reason: 'Tournée' });
    expect(ko.json().code).toBe('MISSION_OUT_OF_PERIMETER');
  });

  it('niveau B : relance obligatoire seulement pour une échéance dépassée, validée par un agent de l’entité', async () => {
    const { env, ctx } = await setupIa();
    const before = (await env.req('POST', '/v1/ia/agents/COMMUNICATION/run', 'u-admin-entite', { purpose: 'Relances' })).json();
    expect(before.some((r: { actions: { type: string }[] }) => r.actions.some((a) => a.type === 'RELANCE_OBLIGATOIRE'))).toBe(false);
    env.clock.advance(45 * 86_400_000);
    const recs = (await env.req('POST', '/v1/ia/agents/COMMUNICATION/run', 'u-admin-entite', { purpose: 'Relances' })).json();
    const rel = recs.find((r: { actions: { type: string }[] }) => r.actions.some((a) => a.type === 'RELANCE_OBLIGATOIRE'));
    expect(rel.situation).toMatch(/échue/);
    expect(rel.insight).toMatch(/Aucune pénalité/);
    const obligationsBefore = JSON.stringify(ctx.assessment.obligations.all());
    const v = await env.req('POST', `/v1/ia/recommendations/${rel.id}/validate`, 'u-admin-entite', { reason: 'Relance réglementaire' });
    expect(v.statusCode, v.body).toBe(200);
    expect(ctx.comms.deliveries.find((d) => d.eventCode === 'recovery.reminder.1').length).toBeGreaterThan(0);
    // Aucun effet financier : l'obligation est inchangée.
    expect(JSON.stringify(ctx.assessment.obligations.all())).toBe(obligationsBefore);
  });

  it('niveau C : jamais exécuté ; décision humaine motivée, délai mesuré, mémoire d’entité alimentée', async () => {
    const { env, ctx } = await setupIa();
    const snap = () => JSON.stringify({ o: ctx.assessment.obligations.all(), l: ctx.ledger.list().length, p: ctx.payments.orders.all(), v: ctx.vault.view(), r: ctx.rules.rules.all() });
    const before = snap();
    const [rec] = (await env.req('POST', '/v1/ia/agents/DECISION_EXECUTIVE/run', 'u-gouverneur', { purpose: 'Note hebdomadaire' })).json();
    expect(rec.autonomy).toBe('C_RECOMMANDATION');
    expect(rec.decision).toMatchObject({ bestOption: expect.any(String), alternativeOption: expect.any(String), riskOfInaction: expect.any(String), financialImpact: expect.any(String), operationalImpact: expect.any(String) });
    expect(rec.recommendedStep).toBeTruthy();
    expect(rec.insight).toMatch(/Aucune règle réelle/);
    expect((await env.req('POST', `/v1/ia/recommendations/${rec.id}/validate`, 'u-gouverneur', { reason: 'Pour exécution' })).json().code).toBe('NOTHING_TO_EXECUTE');
    expect((await env.req('POST', `/v1/ia/recommendations/${rec.id}/decide`, 'u-tresor', { decision: 'ACCEPTEE', reason: 'Hors périmètre' })).statusCode).toBe(404);
    expect((await env.req('POST', `/v1/ia/recommendations/${rec.id}/decide`, 'u-auditeur', { decision: 'ACCEPTEE', reason: 'Contrôle' })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/ia/recommendations/${rec.id}/decide`, 'u-gouverneur', { decision: 'MODIFIEE', reason: 'Nuancer' })).json().code).toBe('MODIFICATION_REQUIRED');
    env.clock.advance(3_600_000);
    const d = await env.req('POST', `/v1/ia/recommendations/${rec.id}/decide`, 'u-gouverneur', { decision: 'ACCEPTEE', reason: 'Priorité à la certification' });
    expect(d.json()).toMatchObject({ status: 'ACCEPTEE', decisionLatencyMs: 3_600_000, decidedByRole: 'R01' });
    expect(snap()).toBe(before);
    const mem = (await env.req('GET', '/v1/ia/memory/entities/GOUVERNORAT', 'u-dircab')).json();
    expect(mem.decisions[0]).toMatchObject({ kind: 'DECISION', refs: [rec.id] });
    const recon = (await env.req('GET', `/v1/ia/journal/${rec.id}`, 'u-auditeur')).json();
    expect(recon.outputIntact).toBe(true);
    expect(recon.journal.find((j: { type: string }) => j.type === 'DECISION').decision).toMatchObject({ latencyMs: 3_600_000, role: 'R01' });
    expect(recon.audit.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['ia.recommendation.generated', 'ia.recommendation.decided']));
  });

  it('niveau C avec actions A : le rejet retire les effets automatiques', async () => {
    const { env, svc } = await setupIa();
    const [rec] = (await env.req('POST', '/v1/ia/agents/VEILLE_JURIDIQUE/run', 'u-juriste-verificateur', { purpose: 'Veille mensuelle' })).json();
    const ids = rec.actions.map((a: { effectId: string }) => a.effectId);
    expect(ids.length).toBe(2);
    const r = await env.req('POST', `/v1/ia/recommendations/${rec.id}/decide`, 'u-juriste-verificateur', { decision: 'REJETEE', reason: 'Déjà suivi par le cabinet' });
    expect(r.json().status).toBe('REJETEE');
    for (const id of ids) expect(svc.effects.get(id)!.status).toBe('ANNULE');
  });

  it('coupe-circuit : un agent désactivé ne produit plus rien (503) ; réservé à R28/R29', async () => {
    const { env } = await setupIa();
    expect((await env.req('POST', '/v1/ia/agents/FRAUDE/state', 'u-dg-dgipk', { enabled: false, reason: 'Test' })).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/ia/agents/FRAUDE/state', 'u-rssi', { enabled: false, reason: 'Dérive détectée' })).statusCode).toBe(200);
    const r = await env.req('POST', '/v1/ia/agents/FRAUDE/run', 'u-enqueteur', { purpose: 'Analyse' });
    expect(r.statusCode).toBe(503);
    expect(r.json().code).toBe('IA_AGENT_DISABLED');
    const sweep = (await env.req('POST', '/v1/ia/sweep', 'ia-gestionnaire-modeles')).json();
    expect(sweep.find((s: { agent: string }) => s.agent === 'FRAUDE').skipped).toMatch(/désactivé/);
    await env.req('POST', '/v1/ia/agents/FRAUDE/state', 'ia-gestionnaire-modeles', { enabled: true, reason: 'Corrigé' });
    expect((await env.req('POST', '/v1/ia/agents/FRAUDE/run', 'u-enqueteur', { purpose: 'Analyse' })).statusCode).toBe(201);
  });

  it('détection de fraude : signaux pseudonymisés, dossier de vérification seulement sur validation de l’enquêteur', async () => {
    const { env, svc } = await setupIa();
    for (let i = 0; i < 3; i++) await env.req('GET', '/v1/ia/journal', 'u-agent-terrain');
    const recs = (await env.req('POST', '/v1/ia/agents/FRAUDE/run', 'u-enqueteur', { purpose: 'Revue hebdomadaire' })).json();
    const refus = recs.find((r: { situation: string }) => /refus/.test(r.situation));
    expect(refus, 'signal de refus répétés').toBeTruthy();
    {
      expect(JSON.stringify(refus)).not.toContain('u-agent-terrain');
      expect(refus.situation).toMatch(/ps-[0-9a-f]{8}/);
      const v = await env.req('POST', `/v1/ia/recommendations/${refus.id}/validate`, 'u-enqueteur', { reason: 'Ouvrir la vérification' });
      expect(v.json().effects[0]).toMatchObject({ type: 'DOSSIER_VERIFICATION', assigneeRole: 'R24' });
      expect(v.json().effects[0].body).toMatch(/aucune personne n’est mise en cause/);
    }
    expect(svc.recommendations.all().every((r) => r.agentCode !== 'FRAUDE' || r.actions.every((a) => a.status !== 'EXECUTEE_AUTO'))).toBe(true);
  });
});

describe('IA — agents personnels et cloisonnement', () => {
  it('apprentissage de l’usager : réponse sourcée enregistrée (A), visible du seul titulaire', async () => {
    const { env } = await setupIa();
    const [rec] = (await env.req('POST', '/v1/ia/agents/APPRENTISSAGE_USAGER/run', 'u-contribuable', { purpose: 'Question', question: 'Comment obtenir ma quittance ?' })).json();
    expect(rec).toMatchObject({ autonomy: 'A_AUTO', status: 'TRAITEE_AUTO', taxpayerId: DEMO.taxpayerId, entity: 'PUBLIC' });
    expect(rec.sources.join(' ')).toMatch(/Quittance/);
    expect(rec.citations.some((c: { domain: string }) => c.domain === 'OBLIGATIONS_PROPRES')).toBe(true);
    const eff = (await env.req('GET', '/v1/ia/effects', 'u-contribuable')).json();
    expect(eff.some((e: { type: string }) => e.type === 'RESUME')).toBe(true);
    expect((await env.req('GET', `/v1/ia/recommendations/${rec.id}`, 'u-locataire')).statusCode).toBe(404);
    expect((await env.req('GET', '/v1/ia/inbox', 'u-locataire')).json().some((r: { id: string }) => r.id === rec.id)).toBe(false);
    expect((await env.req('GET', `/v1/ia/recommendations/${rec.id}`, 'u-dg-dgipk')).statusCode).toBe(404);
    // Mandataire : pour son mandant seulement ; guichet : contribuable obligatoire.
    expect((await env.req('POST', '/v1/ia/agents/ENROLEMENT/run', 'u-mandataire', { purpose: 'Aide', taxpayerId: DEMO.taxpayerId })).statusCode).toBe(201);
    expect((await env.req('POST', '/v1/ia/agents/ENROLEMENT/run', 'u-mandataire', { purpose: 'Aide', taxpayerId: DEMO.tenantTaxpayerId })).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/ia/agents/ENROLEMENT/run', 'u-guichet', { purpose: 'Aide' })).statusCode).toBe(400);
  });

  it('balayage initial à la première consultation : recommandations créées sans aucun envoi ni effet financier', async () => {
    const { env, ctx } = await setupIa();
    addUnitWithoutLease(ctx);
    const deliveries = ctx.comms.deliveries.count();
    const obligations = JSON.stringify(ctx.assessment.obligations.all());
    const inbox = (await env.req('GET', '/v1/ia/inbox', 'u-auditeur')).json();
    expect(inbox.length).toBeGreaterThan(3);
    expect(new Set(inbox.map((r: { agentCode: string }) => r.agentCode)).size).toBeGreaterThan(3);
    expect(ctx.comms.deliveries.count()).toBe(deliveries);
    expect(JSON.stringify(ctx.assessment.obligations.all())).toBe(obligations);
    // Cloisonnement : un agent du Trésor ne voit pas les recommandations locatives de la DGIPK.
    const tresor = (await env.req('GET', '/v1/ia/inbox', 'u-analyste-rappro')).json();
    expect(tresor.some((r: { agentCode: string }) => r.agentCode === 'INTELLIGENCE_LOCATIVE')).toBe(false);
    const filtered = (await env.req('GET', '/v1/ia/inbox?autonomy=B_VALIDATION', 'u-auditeur')).json();
    expect(filtered.every((r: { autonomy: string }) => r.autonomy === 'B_VALIDATION')).toBe(true);
  });
});

describe('IA — mémoire à quatre niveaux', () => {
  it('mémoire utilisateur : titulaire seul, liste blanche, minimisation, effacement, conservation', async () => {
    const { env } = await setupIa();
    const levels = (await env.req('GET', '/v1/ia/memory/levels', 'u-contribuable')).json();
    expect(levels.map((l: { level: string }) => l.level)).toEqual(['UTILISATEUR', 'ENTITE', 'PROCESSUS', 'INTELLIGENCE']);
    expect((await env.req('PUT', '/v1/ia/memory/me', 'u-superviseur', { key: 'priorites', value: ['Missions Limete', 'Conflits terrain'] })).statusCode).toBe(200);
    await env.req('POST', '/v1/ia/agents/MISSIONS_TERRAIN/run', 'u-superviseur', { purpose: 'Plan' });
    const me = (await env.req('GET', '/v1/ia/memory/me', 'u-superviseur')).json();
    expect(me).toMatchObject({ audience: 'AGENT_PUBLIC', purpose: 'SERVICE', frequentTasks: { MISSIONS_TERRAIN: 1 } });
    expect(me.notice).toMatch(/disciplinaire/);
    // Contribuable : préférences de service seulement (aucun profilage).
    expect((await env.req('PUT', '/v1/ia/memory/me', 'u-contribuable', { key: 'toleranceRisque', value: 'élevée' })).json().code).toBe('MEMORY_KEY_NOT_ALLOWED');
    expect((await env.req('PUT', '/v1/ia/memory/me', 'u-contribuable', { key: 'canalPrefere', value: 'sms' })).statusCode).toBe(200);
    await env.req('POST', '/v1/ia/agents/APPRENTISSAGE_USAGER/run', 'u-contribuable', { purpose: 'Question' });
    expect((await env.req('GET', '/v1/ia/memory/me', 'u-contribuable')).json().frequentTasks).toEqual({});
    // Minimisation : aucune coordonnée.
    expect((await env.req('PUT', '/v1/ia/memory/me', 'u-superviseur', { key: 'objectifs', value: 'Appeler le +243 810 000 001' })).json().code).toBe('MEMORY_PERSONAL_DATA_REFUSED');
    // Jamais consultable par un tiers, même hiérarchique ou auditeur.
    for (const who of ['u-dg-dgipk', 'u-auditeur', 'ia-dpo']) {
      const r = await env.req('GET', '/v1/ia/memory/users/u-superviseur', who);
      expect(r.statusCode).toBe(403);
      expect(r.json().code).toBe('MEMORY_PRIVATE');
    }
    // Le DPO voit le registre (volumes), pas le contenu.
    const reg = (await env.req('GET', '/v1/ia/memory/register', 'ia-dpo')).json();
    expect(reg.find((l: { level: string }) => l.level === 'UTILISATEUR').volume).toBe(2);
    expect(JSON.stringify(reg)).not.toContain('Missions Limete');
    // Effacement par clé, puis total.
    expect((await env.req('DELETE', '/v1/ia/memory/me?key=priorites', 'u-superviseur')).statusCode).toBe(200);
    expect((await env.req('GET', '/v1/ia/memory/me', 'u-superviseur')).json().items.priorites).toBeUndefined();
    await env.req('DELETE', '/v1/ia/memory/me', 'u-superviseur');
    expect((await env.req('GET', '/v1/ia/memory/me', 'u-superviseur')).json().frequentTasks).toEqual({});
    // Purge à l'échéance (13 mois sans usage pour un agent, le contribuable est conservé 24 mois).
    env.clock.advance(400 * 86_400_000);
    expect((await env.req('POST', '/v1/ia/memory/purge', 'u-superviseur')).statusCode).toBe(403);
    const purge = (await env.req('POST', '/v1/ia/memory/purge', 'ia-dpo')).json();
    expect(purge.users).toBe(0);
    expect((await env.req('GET', '/v1/ia/memory/me', 'u-contribuable')).json().items.canalPrefere.value).toBe('sms');
    env.clock.advance(400 * 86_400_000);
    expect((await env.req('POST', '/v1/ia/memory/purge', 'ia-dpo')).json().users).toBe(1);
  });

  it('mémoire d’entité : cloisonnée, effacement contrôlé et motivé, décisions conservées', async () => {
    const { env } = await setupIa();
    const dg = (await env.req('GET', '/v1/ia/memory/entities/DGIPK', 'u-superviseur')).json();
    expect(dg.hypotheses.length).toBe(1);
    expect(dg.regles.some((r: { code: string }) => r.code === DEMO.demoRuleCode)).toBe(true);
    expect((await env.req('GET', '/v1/ia/memory/entities/DGIPK', 'u-tresor')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/ia/memory/entities/DGIPK', 'u-auditeur')).statusCode).toBe(200);
    expect((await env.req('POST', '/v1/ia/memory/entities/DGIPK/items', 'u-superviseur', { kind: 'HYPOTHESE', title: 'Test', content: 'Contenu' })).statusCode).toBe(403);
    const item = (await env.req('POST', '/v1/ia/memory/entities/DGIPK/items', 'u-admin-entite', { kind: 'HYPOTHESE', title: 'Saison des pluies', content: 'Les visites terrain ralentissent de novembre à mars.' })).json();
    expect(item.retainUntil > '2029').toBe(true);
    expect((await env.req('POST', `/v1/ia/memory/entities/DGIPK/items/${item.id}/erase`, 'u-admin-entite', {})).statusCode).toBe(400);
    const er = await env.req('POST', `/v1/ia/memory/entities/DGIPK/items/${item.id}/erase`, 'u-admin-entite', { reason: 'Hypothèse obsolète' });
    expect(er.json()).toMatchObject({ status: 'EFFACEE', content: '[effacé]', erasureReason: 'Hypothèse obsolète' });
    // Décision historique : non effaçable avant l'échéance.
    const [rec] = (await env.req('POST', '/v1/ia/agents/COMMUNICATION/run', 'u-admin-entite', { purpose: 'Canaux' })).json();
    await env.req('POST', `/v1/ia/recommendations/${rec.id}/decide`, 'u-admin-entite', { decision: 'REJETEE', reason: 'Déjà planifié' });
    const dec = (await env.req('GET', '/v1/ia/memory/entities/DGIPK', 'u-admin-entite')).json().decisions[0];
    const ko = await env.req('POST', `/v1/ia/memory/entities/DGIPK/items/${dec.id}/erase`, 'ia-dpo', { reason: 'Demande' });
    expect(ko.json().code).toBe('MEMORY_RETENTION_ACTIVE');
  });

  it('mémoire de processus : suit les droits sur le dossier ; mémoire d’intelligence : agrégats sans identifiant', async () => {
    const { env, ctx, svc } = await setupIa();
    const rule = ctx.rules.rules.find((r) => r.code === DEMO.demoRuleCode)[0]!;
    const p = (await env.req('GET', `/v1/ia/memory/processes/rule/${rule.id}`, 'u-juriste-redacteur')).json();
    expect(p).toMatchObject({ step: 'ACTIVE', pending: [], retention: 'Conservée avec le dossier' });
    expect(p.done).toHaveLength(4);
    const ob = ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    const po = (await env.req('GET', `/v1/ia/memory/processes/obligation/${ob.id}`, 'u-contribuable')).json();
    expect(po.done).toContain('Liquidation');
    expect(po.pending).toContain('Référence de paiement');
    expect((await env.req('GET', `/v1/ia/memory/processes/obligation/${ob.id}`, 'u-locataire')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/ia/memory/processes/obligation/INCONNU', 'u-contribuable')).statusCode).toBe(404);
    const [rec] = (await env.req('POST', '/v1/ia/agents/PREVISION/run', 'u-ministre-finances', { purpose: 'Trésorerie' })).json();
    const pi = (await env.req('GET', `/v1/ia/memory/processes/ia/${rec.id}`, 'u-ministre-finances')).json();
    expect(pi.pending).toContain('Décision humaine');
    const intel = (await env.req('GET', '/v1/ia/memory/intelligence', 'u-agent-terrain')).json();
    expect(intel.length).toBeGreaterThan(0);
    expect(JSON.stringify(intel)).not.toMatch(/TP-|u-[a-z]|OBJ-/);
    expect(() => svc.memory.signal('FRAUDE', 'x', 'u-agent-terrain')).toThrow();
    expect((await env.req('GET', '/v1/ia/memory/intelligence', 'u-contribuable')).statusCode).toBe(403);
  });
});

describe('IA — journal et socle', () => {
  it('journal IA : lecture réservée (audit, DPO, modèles, responsables de l’entité)', async () => {
    const { env } = await setupIa();
    await env.req('POST', '/v1/ia/agents/RAPPROCHEMENT/run', 'u-tresor', { purpose: 'Clôture' });
    expect((await env.req('GET', '/v1/ia/journal', 'u-agent-terrain')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/ia/journal', 'ia-dpo')).statusCode).toBe(200);
    const own = (await env.req('GET', '/v1/ia/journal', 'ia-admin-tresor')).json();
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((j: { entity: string }) => j.entity === 'TRESOR')).toBe(true);
    expect((await env.req('GET', '/v1/ia/journal', 'u-admin-entite')).json().some((j: { entity: string }) => j.entity === 'TRESOR')).toBe(false);
  });

  it('le journal de la couche du socle cite désormais les sources et les empreintes', async () => {
    const { env, ctx } = await setupIa();
    await env.req('POST', '/v1/ai/insights', 'u-tresor', { context: 'treasury' });
    const d = ctx.audit.list({ action: 'ai.insight_generated' }).items[0]!.details;
    expect(d).toMatchObject({ promptVersion: 'treasury-v1', inputHash: expect.stringMatching(/^[0-9a-f]{64}$/), outputHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((d['sources'] as string[]).length).toBeGreaterThan(0);
    expect(ctx.audit.verify().ok).toBe(true);
  });
});
