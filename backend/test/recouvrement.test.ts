import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { authorize } from '../src/core/policy.js';
import { recouvrementPlugin, RecoveryService } from '../src/plugins/recouvrement/plugin.js';
import { DEMO, publishCertifiedRule, type TestEnv } from './helpers.js';

const TENANT = DEMO.tenantTaxpayerId;
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

async function setupRecovery(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} },
    plugins: [recouvrementPlugin],
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

const svcOf = (env: TestEnv) => env.app.ctx.ext.recouvrement as RecoveryService;
const demoObligation = (env: TestEnv) => env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;
const tenantArrear = (env: TestEnv) => env.app.ctx.assessment.byTaxpayer(TENANT)[0]!.id;
const tenantCase = (env: TestEnv) => svcOf(env).caseFor(tenantArrear(env))!.id;
const liquidate = (env: TestEnv, ruleId: string, inputs: Record<string, string> = { superficie_m2: '600' }) =>
  env.req('POST', '/v1/assessments/calculate', 'u-controleur', { ruleId, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs, simulate: false });

// ───────────────────────── Registre juridique ─────────────────────────
describe('Registre juridique — suspension, abrogation, versions', () => {
  it('suspension motivée : bloque toute liquidation, levée motivée restaure la règle, historique tracé', async () => {
    const env = await setupRecovery();
    const { id } = await publishCertifiedRule(env, { code: 'TEST-SUSP' });
    expect(env.app.ctx.rules.get(id).status).toBe('ACTIVE');
    const payload = { reason: 'Contestation de la base légale devant la Cour', authority: 'Ministre provincial des Finances' };
    expect((await env.req('POST', `/v1/legal-rules/${id}/suspend`, 'u-juriste-redacteur', payload)).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/legal-rules/${id}/suspend`, 'u-autorite-publication', { reason: 'court', authority: 'X' })).statusCode).toBe(400);
    const s = await env.req('POST', `/v1/legal-rules/${id}/suspend`, 'u-autorite-publication', payload);
    expect(s.statusCode).toBe(200);
    expect(s.json()).toMatchObject({ status: 'SUSPENDUE', suspension: { authority: payload.authority, previousStatus: 'ACTIVE' } });
    const refused = await liquidate(env, id);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe('RULE_NOT_EXECUTABLE');
    const lifted = await env.req('POST', `/v1/legal-rules/${id}/lift-suspension`, 'u-autorite-publication', { reason: 'Arrêt de la Cour confirmant la base légale' });
    expect(lifted.json().status).toBe('ACTIVE');
    expect(lifted.json().pastSuspensions).toHaveLength(1);
    expect((await liquidate(env, id)).statusCode).toBe(201);
    const actions = env.app.ctx.rules.get(id).history!.map((h) => h.action);
    expect(actions).toEqual(expect.arrayContaining(['rule.created', 'rule.suspended', 'rule.suspension.lifted', 'rule.activated']));
    expect(env.app.ctx.audit.list({ action: 'rule.suspended' }).total).toBe(1);
  });

  it('abrogation datée par instrument en vigueur : liquidation possible avant la date, bloquée à partir de la date', async () => {
    const env = await setupRecovery();
    const { id } = await publishCertifiedRule(env, { code: 'TEST-ABRO' });
    const bad = await env.req('POST', `/v1/legal-rules/${id}/abrogate`, 'u-autorite-publication', { date: '2026-10-15', instrumentId: 'ol-69-006', reason: 'Abrogation par un texte non certifié' });
    expect(bad.json().code).toBe('INSTRUMENT_NOT_IN_FORCE');
    const ok = await env.req('POST', `/v1/legal-rules/${id}/abrogate`, 'u-autorite-publication', { date: '2026-10-15', instrumentId: 'demo-instrument-001', reason: 'Abrogation fictive de démonstration' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().rule).toMatchObject({ status: 'ACTIVE', abrogation: { date: '2026-10-15', instrumentId: 'demo-instrument-001' } });
    expect((await liquidate(env, id)).statusCode).toBe(201);
    env.clock.set('2026-10-15T08:00:00Z');
    const after = await liquidate(env, id);
    expect(after.statusCode).toBe(422);
    expect(env.app.ctx.rules.get(id).status).toBe('ABROGEE');
    const versions = await env.req('GET', `/v1/legal-rules/${id}/versions`, 'u-controleur');
    expect(versions.json().versions[0].history.map((h: { action: string }) => h.action)).toContain('rule.abrogated.effective');
  });

  it('abrogation d’un instrument : liste noire + règles à examiner, sans abrogation automatique', async () => {
    const env = await setupRecovery();
    const r = await env.req('POST', '/v1/legal-instruments/demo-instrument-001/abrogate', 'u-autorite-publication', { date: '2026-12-31', abrogatedBy: 'ol-18-004', reason: 'Abrogation fictive pour le test' });
    expect(r.statusCode).toBe(200);
    expect(r.json().instrument.status).toBe('ABROGE');
    expect(r.json().rulesToReview.map((x: { code: string }) => x.code)).toContain('DEMO-IF-BATI');
    expect(env.app.ctx.rules.rules.find((x) => x.code === 'DEMO-IF-BATI')[0]!.status).toBe('ACTIVE');
  });

  it('rétroactivité : nouvelle version à effet passé bloquée sans acte ; avec acte, publiée et l’ancienne version remplacée', async () => {
    const env = await setupRecovery();
    const v1 = await publishCertifiedRule(env, { code: 'TEST-RETRO' });
    const v2 = await publishCertifiedRule(env, { code: 'TEST-RETRO', effectiveFrom: '2026-06-01', changeReason: 'Nouveau barème' });
    expect(v2.responses[3]!.statusCode).toBe(422);
    expect(v2.responses[3]!.json().code).toBe('RETROACTIVITY_NOT_AUTHORIZED');
    const v3 = await publishCertifiedRule(env, {
      code: 'TEST-RETRO', effectiveFrom: '2026-06-01',
      retroactivity: { instrumentId: 'demo-instrument-001', article: 'Art. 2 (fictif)', justification: 'Rétroactivité expressément prévue par l’acte fictif' },
    });
    expect(v3.responses[3]!.json().status).toBe('ACTIVE');
    const old = env.app.ctx.rules.get(v1.id);
    expect(old).toMatchObject({ status: 'EXPIREE', supersededBy: v3.id });
    const versions = await env.req('GET', `/v1/legal-rules/${v3.id}/versions`, 'u-controleur');
    expect(versions.json().versions.map((v: { version: number; status: string }) => `${v.version}:${v.status}`)).toEqual(['1:EXPIREE', '2:APPROUVEE', '3:ACTIVE']);
  });
});

describe('Recalcul contrôlé après nouvelle version', () => {
  it('simulation sans effet → décision motivée d’une personne distincte → obligation rectificative, originale conservée', async () => {
    const env = await setupRecovery();
    const v1 = await publishCertifiedRule(env, { code: 'TEST-RC' });
    const o1 = (await liquidate(env, v1.id)).json().obligation;
    expect(o1.amount).toEqual({ amount: '1500.00', currency: 'USD' });
    const v2 = await publishCertifiedRule(env, { code: 'TEST-RC', effectiveFrom: '2026-09-26', rateTable: { 'tarif_m2:1': '3', 'tarif_m2:2': '2', 'tarif_m2:3': '1.5', 'tarif_m2:4': '1' } });
    expect(env.app.ctx.rules.get(v2.id).status).toBe('ACTIVE');

    expect((await env.req('POST', `/v1/legal-rules/${v2.id}/impact-simulations`, 'u-agent-terrain')).statusCode).toBe(403);
    const byDg = (await env.req('POST', `/v1/legal-rules/${v2.id}/impact-simulations`, 'u-dg-dgipk')).json();
    const self = await env.req('POST', `/v1/recalculations/${byDg.id}/decide`, 'u-dg-dgipk', { decision: 'APPLIQUER', reason: 'Application du nouveau barème' });
    expect(self.json().code).toBe('SEPARATION_OF_DUTIES');

    const sim = await env.req('POST', `/v1/legal-rules/${v2.id}/impact-simulations`, 'u-juriste-verificateur');
    expect(sim.statusCode).toBe(201);
    const rec = sim.json();
    expect(rec).toMatchObject({ status: 'SIMULEE', nonOpposable: true, totals: { toApply: 1, favorable: 1 } });
    const line = rec.lines.find((l: { obligationId: string }) => l.obligationId === o1.id);
    expect(line).toMatchObject({ treatment: 'A_APPLIQUER', direction: 'FAVORABLE', newAmount: { amount: '1200.00' }, delta: { amount: '-300.00' } });
    expect(env.app.ctx.assessment.get(o1.id).status).toBe('EMISE'); // simulation sans effet

    expect((await env.req('POST', `/v1/recalculations/${rec.id}/decide`, 'u-juriste-verificateur', { decision: 'APPLIQUER', reason: 'Application du nouveau barème' })).statusCode).toBe(403);
    const applied = await env.req('POST', `/v1/recalculations/${rec.id}/decide`, 'u-dg-dgipk', { decision: 'APPLIQUER', reason: 'Application du nouveau barème favorable' });
    expect(applied.statusCode).toBe(200);
    expect(applied.json().status).toBe('APPLIQUEE');
    const [{ from, to }] = applied.json().decision.applied;
    expect(from).toBe(o1.id);
    const original = env.app.ctx.assessment.get(o1.id);
    const rectified = env.app.ctx.assessment.get(to);
    expect(original).toMatchObject({ status: 'ANNULEE', supersededBy: to });
    expect(rectified).toMatchObject({ ruleVersion: 2, ruleId: v2.id, supersedes: o1.id, amount: { amount: '1200.00', currency: 'USD' } });
    expect(rectified.explanation.rule.version).toBe(2);
    expect(env.app.ctx.audit.list({ action: 'rule.recalculation.applied' }).total).toBe(1);
    const again = await env.req('POST', `/v1/recalculations/${rec.id}/decide`, 'u-dg-dgipk', { decision: 'REJETER', reason: 'Tentative de seconde décision' });
    expect(again.json().code).toBe('RECALCULATION_ALREADY_DECIDED');
  });

  it('jamais rétroactif en défaveur sans acte ; obligations antérieures à la date d’effet non touchées', async () => {
    const env = await setupRecovery();
    const up1 = await publishCertifiedRule(env, { code: 'TEST-UP' });
    const o = (await liquidate(env, up1.id)).json().obligation;
    const up2 = await publishCertifiedRule(env, { code: 'TEST-UP', effectiveFrom: '2026-09-26', rateTable: { 'tarif_m2:2': '3' } });
    const sim = (await env.req('POST', `/v1/legal-rules/${up2.id}/impact-simulations`, 'u-validateur-financier')).json();
    const line = sim.lines.find((l: { obligationId: string }) => l.obligationId === o.id);
    expect(line).toMatchObject({ direction: 'DEFAVORABLE', treatment: 'EXCLUE' });
    expect(line.reason).toMatch(/rétroactivité/);

    const fut1 = await publishCertifiedRule(env, { code: 'TEST-FUT' });
    const of = (await liquidate(env, fut1.id)).json().obligation;
    const fut2 = await publishCertifiedRule(env, { code: 'TEST-FUT', effectiveFrom: '2026-10-01', rateTable: { 'tarif_m2:2': '1' } });
    expect(env.app.ctx.rules.get(fut2.id).status).toBe('PUBLIEE');
    const sim2 = (await env.req('POST', `/v1/legal-rules/${fut2.id}/impact-simulations`, 'u-validateur-financier')).json();
    expect(sim2.lines.find((l: { obligationId: string }) => l.obligationId === of.id)).toMatchObject({ treatment: 'EXCLUE' });
    expect(sim2.totals.toApply).toBe(0);
    // Application refusée tant que la nouvelle version n'est pas ACTIVE.
    const early = await env.req('POST', `/v1/recalculations/${sim2.id}/decide`, 'u-dg-dgipk', { decision: 'APPLIQUER', reason: 'Tentative avant la date d’effet' });
    expect(early.json().code).toBe('RULE_NOT_EXECUTABLE');
  });
});

// ───────────────────────── Réclamations enrichies ─────────────────────────
describe('Réclamations — délais, pièces, historique, effet suspensif', () => {
  it('délais calculés, accusé horodaté, pièces par empreinte dédoublonnées, historique personnel, effet suspensif décidé par R21', async () => {
    const env = await setupRecovery();
    const obl = demoObligation(env);
    const proc = await env.req('GET', '/v1/appeals/procedure', 'u-contribuable');
    expect(proc.json()).toMatchObject({ status: 'A_VERIFIER', filingDelayDays: 30 });
    const sub = await env.req('POST', '/v1/appeals', 'u-contribuable', {
      obligationId: obl, grounds: 'La parcelle a été vendue avant le fait générateur.', type: 'BIEN_NON_DETENU',
      requestSuspensiveEffect: true, suspensiveReason: 'Paiement impossible pendant la contestation',
      documents: [{ sha256: HASH_A, name: 'acte-de-vente.pdf', mediaType: 'application/pdf', sizeBytes: 1024 }],
    });
    expect(sub.statusCode).toBe(201);
    const a = sub.json();
    expect(a).toMatchObject({ type: 'BIEN_NON_DETENU', suspensiveEffect: { status: 'DEMANDE' }, deadlines: { filingDeadline: '2026-10-26', decisionDueBy: '2026-11-25', daysRemaining: 60, state: 'DANS_LE_DELAI', filedLate: false } });
    expect(a.acknowledgement.number).toBe(`AR-${a.id}`);
    expect(a.acknowledgement.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const dup = await env.req('POST', `/v1/appeals/${a.id}/documents`, 'u-contribuable', { sha256: HASH_A, name: 'copie.pdf', mediaType: 'application/pdf' });
    expect(dup.json().documents).toHaveLength(1);
    const second = await env.req('POST', `/v1/appeals/${a.id}/documents`, 'u-contribuable', { sha256: HASH_B, name: 'plan.jpg', mediaType: 'image/jpeg' });
    expect(second.json().documents).toHaveLength(2);
    expect((await env.req('POST', `/v1/appeals/${a.id}/documents`, 'u-contribuable', { sha256: 'xyz', name: 'x', mediaType: 'image/jpeg' })).statusCode).toBe(400);
    expect((await env.req('POST', `/v1/appeals/${a.id}/documents`, 'u-locataire', { sha256: HASH_B, name: 'x', mediaType: 'image/jpeg' })).statusCode).toBe(403);

    expect((await env.req('GET', `/v1/appeals/${a.id}`, 'u-locataire')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/appeals', 'u-locataire')).json()).toHaveLength(0);
    const mine = (await env.req('GET', '/v1/appeals', 'u-contribuable')).json();
    expect(mine.map((x: { id: string }) => x.id)).toEqual([a.id]);
    expect((await env.req('GET', `/v1/appeals?taxpayerId=${TENANT}`, 'u-contribuable')).statusCode).toBe(403);

    expect((await env.req('POST', `/v1/appeals/${a.id}/suspensive-effect/decision`, 'u-contentieux', { granted: true, reason: 'Tentative sans habilitation' })).statusCode).toBe(403);
    const granted = await env.req('POST', `/v1/appeals/${a.id}/suspensive-effect/decision`, 'u-decideur', { granted: true, reason: 'Contestation sérieuse, pièces probantes' });
    expect(granted.json().suspensiveEffect).toMatchObject({ status: 'ACCORDE', decidedBy: 'u-decideur' });
    expect(granted.json().history.map((h: { action: string }) => h.action)).toEqual(expect.arrayContaining(['appeal.submitted', 'appeal.document.added', 'appeal.suspensive_effect.granted']));
  });

  it('délai de réponse dépassé : signalé une seule fois (appeal.sla_breach) ; décision motivée avec voie de recours suivante', async () => {
    const env = await setupRecovery();
    const a = (await env.req('POST', '/v1/appeals', 'u-contribuable', { obligationId: demoObligation(env), grounds: 'Rang de localité erroné.' })).json();
    env.clock.set('2026-11-26T09:00:00Z');
    const list = await env.req('GET', '/v1/appeals', 'u-contentieux');
    expect(list.json()[0].deadlines.state).toBe('DELAI_DEPASSE');
    await env.req('GET', '/v1/appeals', 'u-decideur');
    expect(env.app.ctx.audit.list({ action: 'appeal.sla_breach' }).total).toBe(1);
    expect(env.app.ctx.comms.deliveries.find((d) => d.eventCode === 'appeal.sla_breach').length).toBeGreaterThan(0);
    await env.req('POST', `/v1/appeals/${a.id}/instruct`, 'u-contentieux', { proposal: 'REJETEE', analysis: 'Rang confirmé par le cadastre.' });
    const decided = await env.req('POST', `/v1/appeals/${a.id}/decide`, 'u-decideur', { decision: 'REJETEE', reason: 'Rang confirmé par le cadastre.' });
    expect(decided.json()).toMatchObject({ status: 'REJETEE', nextRemedy: { status: 'A_VERIFIER' }, deadlines: { state: 'DECIDE_HORS_DELAI' } });
  });

  it('le décideur est distinct de l’auteur de la liquidation contestée', async () => {
    const env = await setupRecovery();
    env.app.ctx.users.add({ id: 'rec-liq-decideur', name: 'Liquidateur et décideur (test)', roles: ['R11', 'R21'], entity: 'DGIPK' });
    const rule = env.app.ctx.rules.rules.find((r) => r.code === DEMO.demoRuleCode)[0]!;
    const res = await env.req('POST', '/v1/assessments/calculate', 'rec-liq-decideur', { ruleId: rule.id, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: {}, simulate: false });
    const obl = res.json().obligation.id;
    const a = (await env.req('POST', '/v1/appeals', 'u-contribuable', { obligationId: obl, grounds: 'Double imposition du même bien.', type: 'DOUBLE_IMPOSITION' })).json();
    await env.req('POST', `/v1/appeals/${a.id}/instruct`, 'u-contentieux', { proposal: 'ACCEPTEE', analysis: 'Doublon confirmé.' });
    const self = await env.req('POST', `/v1/appeals/${a.id}/decide`, 'rec-liq-decideur', { decision: 'ACCEPTEE', reason: 'Doublon confirmé.' });
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe('SEPARATION_OF_DUTIES');
  });
});

// ───────────────────────── Avis légaux ─────────────────────────
describe('Avis légaux numérotés', () => {
  it('avis d’imposition : mentions obligatoires, empreinte, preuve de notification, accusé de lecture', async () => {
    const env = await setupRecovery();
    const obl = demoObligation(env);
    expect((await env.req('POST', '/v1/recouvrement/avis', 'u-contribuable', { obligationId: obl })).statusCode).toBe(403);
    const r = await env.req('POST', '/v1/recouvrement/avis', 'u-controleur', { obligationId: obl });
    expect(r.statusCode).toBe(201);
    const n = r.json();
    expect(n.number).toMatch(/^AI-2026-\d{6}$/);
    expect(n.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(n.content.legalBasis.length).toBeGreaterThan(0);
    expect(n.content).toMatchObject({ amount: { amount: '150.00', currency: 'USD' }, remedy: { delayDays: 30, delayStatus: 'A_VERIFIER' }, demo: true });
    expect(n.content.remedy.path.length).toBeGreaterThan(3);
    expect(n.notification).toBe('NOTIFIE');
    // Idempotent : un seul avis d'imposition par obligation.
    expect((await env.req('POST', '/v1/recouvrement/avis', 'u-controleur', { obligationId: obl })).json().number).toBe(n.number);
    const proof = await env.req('GET', `/v1/recouvrement/avis/${n.id}/preuve`, 'u-contribuable');
    expect(proof.json().deliveries.length).toBeGreaterThan(0);
    expect(proof.json().readAcknowledgement).toBeNull();
    expect((await env.req('GET', `/v1/recouvrement/avis/${n.id}`, 'u-locataire')).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/recouvrement/avis/${n.id}/lecture`, 'u-controleur')).statusCode).toBe(403);
    const read = await env.req('POST', `/v1/recouvrement/avis/${n.id}/lecture`, 'u-contribuable');
    expect(read.json().readAt).toBe('2026-09-26T09:00:00.000Z');
    expect((await env.req('GET', `/v1/recouvrement/avis/${n.id}/preuve`, 'u-contentieux')).json().readAcknowledgement.by).toBe('u-contribuable');
    // Contrôle unitaire : un avis sans base légale n'est jamais émis.
    expect(RecoveryService.missingMandatory({ ...n.content, legalBasis: [], remedy: { ...n.content.remedy, delayDays: 0 } })).toEqual(['base légale', 'délai de recours']);
  });
});

// ───────────────────────── Arriérés et recouvrement gradué ─────────────────────────
describe('Arriérés : balance âgée, segmentation sans effet, prescription', () => {
  it('agents : segment, profil de risque et prescription ; contribuable : ses arriérés sans profilage', async () => {
    const env = await setupRecovery();
    expect((await env.req('GET', '/v1/recouvrement/arrieres', 'u-contribuable')).statusCode).toBe(403);
    const r = (await env.req('GET', '/v1/recouvrement/arrieres', 'u-contentieux')).json();
    const item = r.items.find((i: { obligationId: string }) => i.obligationId === tenantArrear(env));
    expect(item).toMatchObject({ ageDays: 73, ageBand: '31-90', automaticDecision: false, demo: true, prescription: { state: 'EN_COURS', limitationYears: 5 } });
    expect(Object.keys(item.segment)).toEqual(expect.arrayContaining(['code', 'reasons']));
    expect(item.risk.level).toMatch(/FAIBLE|MOYEN|ELEVE/);
    expect(r.balance.total.USD).toBe('50.00');
    expect(r.balance.byBand['31-90'].USD).toBe('50.00');

    const mine = (await env.req('GET', '/v1/recouvrement/mes-arrieres', 'u-locataire')).json();
    expect(mine.arrears).toHaveLength(1);
    expect(mine.arrears[0]).not.toHaveProperty('segment');
    expect(mine.arrears[0]).not.toHaveProperty('risk');
    expect(mine.arrears[0].steps.map((s: { kind: string }) => s.kind)).toEqual(['AVIS_J_PLUS_1', 'RELANCE_J_PLUS_15']);
    const own = (await env.req('GET', '/v1/recouvrement/mes-arrieres', 'u-contribuable')).json();
    expect(own.arrears).toHaveLength(0);
    expect(own.upcoming.length).toBeGreaterThan(0);
    expect((await env.req('GET', `/v1/recouvrement/mes-arrieres?taxpayerId=${TENANT}`, 'u-contribuable')).statusCode).toBe(403);
    expect((await env.req('GET', `/v1/recouvrement/mes-arrieres?taxpayerId=${DEMO.taxpayerId}`, 'u-mandataire')).statusCode).toBe(200);
  });

  it('reprise d’arriérés historiques : base légale d’origine, prescription, validation par une personne distincte', async () => {
    const env = await setupRecovery();
    const base = { taxpayerId: TENANT, revenueLabel: 'Impôt foncier (reprise, fictif)', amount: { amount: '120.00', currency: 'USD' }, instrumentIds: ['ol-13-001'], articles: ['Art. fictif'], legalOpinionRef: 'AVIS-JUR-DEMO-01' };
    expect((await env.req('POST', '/v1/recouvrement/reprises', 'u-contentieux', { ...base, fiscalYear: 2019 })).json().code).toBe('ORIGINAL_BASIS_NOT_APPLICABLE');
    expect((await env.req('POST', '/v1/recouvrement/reprises', 'u-contentieux', { ...base, fiscalYear: 2017 })).json().code).toBe('ARREAR_PRESCRIBED');
    expect((await env.req('POST', '/v1/recouvrement/reprises', 'u-contentieux', { ...base, fiscalYear: 2017, instrumentIds: ['ol-69-006'] })).json().code).toBe('INSTRUMENT_NOT_CERTIFIED');
    const ok = await env.req('POST', '/v1/recouvrement/reprises', 'u-contentieux', { ...base, fiscalYear: 2017, interruptionActRef: 'COMMANDEMENT-2021-DEMO' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ status: 'PROPOSEE', prescription: { reached: true, interrupted: true } });
    expect((await env.req('POST', `/v1/recouvrement/reprises/${ok.json().id}/validation`, 'u-contentieux', { decision: 'VALIDEE', motivation: 'Auto-validation interdite' })).statusCode).toBe(403);
    const v = await env.req('POST', `/v1/recouvrement/reprises/${ok.json().id}/validation`, 'u-dg-dgipk', { decision: 'VALIDEE', motivation: 'Avis juridique favorable et acte interruptif vérifié' });
    expect(v.json().status).toBe('VALIDEE');
  });
});

describe('Parcours gradué : rappel → avis → mise en demeure → mesure proposée → décision motivée', () => {
  it('chaque étape au-delà du rappel est proposée (R20) puis décidée (R21), avec délais et base légale', async () => {
    const env = await setupRecovery();
    const caseId = tenantCase(env);
    const motivation = 'Relances restées sans suite, adresse vérifiée';
    expect((await env.req('POST', `/v1/recouvrement/dossiers/${caseId}/propositions`, 'u-decideur', { kind: 'AVIS_FORMEL', motivation })).statusCode).toBe(403);
    const p1 = await env.req('POST', `/v1/recouvrement/dossiers/${caseId}/propositions`, 'u-contentieux', { kind: 'AVIS_FORMEL', motivation });
    expect(p1.statusCode).toBe(201);
    expect(p1.json().status).toBe('PROPOSEE');
    expect((await env.req('POST', `/v1/recouvrement/dossiers/${caseId}/propositions`, 'u-contentieux', { kind: 'AVIS_FORMEL', motivation })).json().code).toBe('PROPOSAL_PENDING');
    // Rien n'est produit avant la décision.
    expect(svcOf(env).notices.find((n) => n.kind === 'AVIS_FORMEL')).toHaveLength(0);
    expect((await env.req('POST', `/v1/recouvrement/propositions/${p1.json().id}/decision`, 'u-contentieux', { decision: 'APPROUVEE', motivation })).statusCode).toBe(403);
    const d1 = await env.req('POST', `/v1/recouvrement/propositions/${p1.json().id}/decision`, 'u-decideur', { decision: 'APPROUVEE', motivation: 'Constat vérifié, voie de recours rappelée' });
    expect(d1.json()).toMatchObject({ status: 'APPROUVEE', noticeId: expect.stringMatching(/^AF-2026-/) });

    const noBasis = await env.req('POST', `/v1/recouvrement/dossiers/${caseId}/propositions`, 'u-contentieux', { kind: 'MISE_EN_DEMEURE', motivation });
    expect(noBasis.json().code).toBe('LEGAL_BASIS_REQUIRED');
    const abrogated = await env.req('POST', `/v1/recouvrement/dossiers/${caseId}/propositions`, 'u-contentieux', { kind: 'MISE_EN_DEMEURE', motivation, legalBasis: { instrumentId: 'ol-13-001', article: 'Art. X' } });
    expect(abrogated.json().code).toBe('INSTRUMENT_NOT_IN_FORCE');
    const md = { kind: 'MISE_EN_DEMEURE', motivation, legalBasis: { instrumentId: 'demo-instrument-001', article: 'Art. 4 (fictif)' } };
    expect((await env.req('POST', `/v1/recouvrement/dossiers/${caseId}/propositions`, 'u-contentieux', md)).json().code).toBe('DELAY_NOT_ELAPSED');
    env.clock.set('2026-10-11T09:00:00Z');
    const p2 = await env.req('POST', `/v1/recouvrement/dossiers/${caseId}/propositions`, 'u-contentieux', md);
    expect(p2.statusCode).toBe(201);
    const d2 = await env.req('POST', `/v1/recouvrement/propositions/${p2.json().id}/decision`, 'u-decideur', { decision: 'APPROUVEE', motivation: 'Mise en demeure conforme, double validation' });
    const mdNotice = svcOf(env).notices.get(d2.json().noticeId)!;
    expect(mdNotice.kind).toBe('MISE_EN_DEMEURE');
    expect(mdNotice.content.dueDate).toBe('2026-10-26');
    expect(mdNotice.content.decision).toMatchObject({ by: 'u-decideur', legalBasis: { instrumentId: 'demo-instrument-001' } });

    const measure = { kind: 'MESURE_EXECUTION', motivation, legalBasis: { instrumentId: 'demo-instrument-001', article: 'Art. 5 (fictif)' }, measureType: 'Mesure prévue par l’acte (fictive)' };
    expect((await env.req('POST', `/v1/recouvrement/dossiers/${caseId}/propositions`, 'u-contentieux', { ...measure, measureType: undefined })).statusCode).toBe(400);
    expect((await env.req('POST', `/v1/recouvrement/dossiers/${caseId}/propositions`, 'u-contentieux', measure)).json().code).toBe('DELAY_NOT_ELAPSED');
    env.clock.set('2026-10-27T09:00:00Z');
    const p3 = await env.req('POST', `/v1/recouvrement/dossiers/${caseId}/propositions`, 'u-contentieux', measure);
    expect(p3.statusCode).toBe(201);
    // Droit d'être entendu : la contribuable est informée de la mesure envisagée et peut présenter ses observations.
    expect(svcOf(env).notices.get(p3.json().noticeId)!.kind).toBe('MESURE_ENVISAGEE');
    expect((await env.req('POST', `/v1/recouvrement/dossiers/${caseId}/observations`, 'u-locataire', { text: 'Je sollicite un délai pour régulariser.' })).statusCode).toBe(201);
    expect((await env.req('POST', `/v1/recouvrement/dossiers/${caseId}/observations`, 'u-contribuable', { text: 'Observation d’un tiers.' })).statusCode).toBe(403);
    const d3 = await env.req('POST', `/v1/recouvrement/propositions/${p3.json().id}/decision`, 'u-decideur', { decision: 'APPROUVEE', motivation: 'Observations examinées, mesure proportionnée' });
    expect(svcOf(env).notices.get(d3.json().noticeId)!.kind).toBe('DECISION_MESURE');
    const view = (await env.req('GET', `/v1/recouvrement/dossiers/${caseId}`, 'u-locataire')).json();
    expect(view.timeline.filter((s: { status: string }) => s.status === 'FAIT').map((s: { kind: string }) => s.kind)).toEqual(['AVIS_J_PLUS_1', 'RELANCE_J_PLUS_15', 'AVIS_FORMEL', 'MISE_EN_DEMEURE', 'MESURE_EXECUTION']);

    // Régularisation constatée : la levée est PROPOSÉE par le système, décidée par une autorité.
    env.app.ctx.assessment.setStatus(tenantArrear(env), 'SOLDEE');
    const run = (await env.req('POST', '/v1/recouvrement/planification', 'u-contentieux')).json();
    expect(run.liftProposed).toBe(1);
    const lift = svcOf(env).proposals.find((p) => p.kind === 'LEVEE')[0]!;
    expect(lift.proposedBy).toBe('systeme');
    const dl = await env.req('POST', `/v1/recouvrement/propositions/${lift.id}/decision`, 'u-decideur', { decision: 'APPROUVEE', motivation: 'Obligation soldée et rapprochée' });
    expect(svcOf(env).notices.get(dl.json().noticeId)!.kind).toBe('LEVEE_MESURE');
    expect(svcOf(env).getCase(caseId).status).toBe('REGULARISE');
    // Aucune mesure n'a jamais été prise par un algorithme.
    expect(env.app.ctx.audit.list({ action: 'recovery.proposal.decided' }).items.every((r) => r.actor.kind === 'user')).toBe(true);
  });

  it('séparation des tâches : la même personne ne propose et ne décide pas ; l’IA ne décide jamais', async () => {
    const env = await setupRecovery();
    env.app.ctx.users.add({ id: 'rec-mixte', name: 'Agent mixte (test)', roles: ['R20', 'R21'], entity: 'DGIPK' });
    const p = await env.req('POST', `/v1/recouvrement/dossiers/${tenantCase(env)}/propositions`, 'rec-mixte', { kind: 'CLASSEMENT', motivation: 'Créance de faible montant, coût disproportionné' });
    const self = await env.req('POST', `/v1/recouvrement/propositions/${p.json().id}/decision`, 'rec-mixte', { decision: 'APPROUVEE', motivation: 'Auto-décision interdite' });
    expect(self.json().code).toBe('SEPARATION_OF_DUTIES');
    expect(() => authorize({ kind: 'ai', id: 'agent-recouvrement', agent: 'copilote' }, 'recouvrement:decide')).toThrow(/agent d'IA/);
  });

  it('garde-fous : aucune proposition sans adresse de notification valide ni sur recours à effet suspensif', async () => {
    const env = await setupRecovery();
    const obl = demoObligation(env);
    const o = env.app.ctx.assessment.get(obl);
    env.app.ctx.assessment.obligations.update({ ...o, dueDate: '2026-08-01' });
    const opened = await env.req('POST', '/v1/recouvrement/dossiers', 'u-contentieux', { obligationId: obl });
    expect(opened.statusCode).toBe(201);
    const caseId = opened.json().id;
    await env.req('POST', '/v1/recouvrement/planification', 'u-contentieux');
    const motivation = 'Relances restées sans suite depuis plus de trente jours';
    const noAddr = await env.req('POST', `/v1/recouvrement/dossiers/${caseId}/propositions`, 'u-contentieux', { kind: 'AVIS_FORMEL', motivation });
    expect(noAddr.statusCode).toBe(422);
    expect(noAddr.json().blockers.map((b: { code: string }) => b.code)).toContain('NO_VALID_NOTIFICATION_ADDRESS');
    expect((await env.req('POST', `/v1/recouvrement/contribuables/${DEMO.taxpayerId}/adresse-notification`, 'u-contribuable', { channel: 'TELEPHONE', value: '+243810000001', proof: 'OTP confirmé' })).statusCode).toBe(403);
    const addr = await env.req('POST', `/v1/recouvrement/contribuables/${DEMO.taxpayerId}/adresse-notification`, 'u-guichet', { channel: 'TELEPHONE', value: '+243810000001', proof: 'OTP confirmé au guichet' });
    expect(addr.json().valueMasked).not.toContain('810000');
    await env.req('POST', '/v1/appeals', 'u-contribuable', { obligationId: obl, grounds: 'Montant contesté, pièces jointes.', requestSuspensiveEffect: true });
    const susp = await env.req('POST', `/v1/recouvrement/dossiers/${caseId}/propositions`, 'u-contentieux', { kind: 'AVIS_FORMEL', motivation });
    expect(susp.json().code).toBe('SUSPENSIVE_APPEAL');
    expect(env.app.ctx.audit.list({ action: 'recovery.proposal.blocked' }).total).toBe(2);
  });

  it('planification idempotente : rappels datés, jamais de rafale, aucun accès contribuable', async () => {
    const env = await setupRecovery();
    expect((await env.req('POST', '/v1/recouvrement/planification', 'u-contribuable')).statusCode).toBe(403);
    const first = (await env.req('POST', '/v1/recouvrement/planification', 'u-contentieux')).json();
    expect(first.remindersSent).toHaveLength(0);
    env.clock.set('2026-10-12T09:00:00Z'); // J−14 pour l'obligation de démonstration (échéance 26/10)
    const r1 = (await env.req('POST', '/v1/recouvrement/planification', 'u-contentieux')).json();
    expect(r1.remindersSent).toEqual([{ obligationId: demoObligation(env), step: 'RAPPEL_J_MOINS_15' }]);
    const r2 = (await env.req('POST', '/v1/recouvrement/planification', 'u-contentieux')).json();
    expect(r2.remindersSent).toHaveLength(0);
    env.clock.set('2026-10-27T09:00:00Z'); // J+1 : constat de retard et avis
    const r3 = (await env.req('POST', '/v1/recouvrement/planification', 'u-contentieux')).json();
    expect(r3.overdueRecorded).toBe(1);
    expect(r3.remindersSent.map((x: { step: string }) => x.step)).toEqual(['AVIS_J_PLUS_1']);
    expect(env.app.ctx.assessment.get(demoObligation(env)).status).toBe('EN_RETARD');
    expect(svcOf(env).notices.find((n) => n.obligationId === demoObligation(env)).map((n) => n.kind)).toEqual(['RAPPEL', 'AVIS_ECHEANCE_DEPASSEE']);
  });
});

describe('Échéanciers', () => {
  it('demande → accord motivé (échéances exactes) → aucune mesure pendant l’échéancier → défaillance constatée par une personne', async () => {
    const env = await setupRecovery();
    const obl = tenantArrear(env);
    expect((await env.req('POST', '/v1/recouvrement/echeanciers', 'u-contribuable', { obligationId: obl, installments: 3, reason: 'Tiers' })).statusCode).toBe(403);
    const req = await env.req('POST', '/v1/recouvrement/echeanciers', 'u-locataire', { obligationId: obl, installments: 3, reason: 'Revenus irréguliers ce trimestre' });
    expect(req.statusCode).toBe(201);
    expect(req.json()).toMatchObject({ status: 'DEMANDE', legalBasis: { instrumentId: 'recouvrement-demo-echeancier', demo: true } });
    const planId = req.json().id;
    expect((await env.req('POST', '/v1/recouvrement/echeanciers', 'u-locataire', { obligationId: obl, installments: 2, reason: 'Doublon' })).json().code).toBe('PLAN_ALREADY_OPEN');
    const dec = await env.req('POST', `/v1/recouvrement/echeanciers/${planId}/decision`, 'u-contentieux', { granted: true, motivation: 'Difficulté réelle, échéancier proportionné' });
    expect(dec.json().status).toBe('ACCORDE');
    expect(dec.json().installments.map((i: { amount: { amount: string } }) => i.amount.amount)).toEqual(['16.66', '16.66', '16.68']);
    expect(dec.json().installments[0].dueDate).toBe('2026-10-26');
    expect(svcOf(env).notices.get(dec.json().noticeId)!.kind).toBe('ECHEANCIER');
    const blocked = await env.req('POST', `/v1/recouvrement/dossiers/${tenantCase(env)}/propositions`, 'u-contentieux', { kind: 'AVIS_FORMEL', motivation: 'Relances sans suite depuis longtemps' });
    expect(blocked.json().code).toBe('INSTALLMENT_PLAN_ACTIVE');
    env.clock.set('2026-10-24T09:00:00Z'); // J−2 de la première échéance : rappel amiable unique
    expect((await env.req('POST', '/v1/recouvrement/planification', 'u-contentieux')).json().installmentReminders).toBe(1);
    expect((await env.req('POST', '/v1/recouvrement/planification', 'u-contentieux')).json().installmentReminders).toBe(0);
    const early = await env.req('POST', `/v1/recouvrement/echeanciers/${planId}/defaillance`, 'u-contentieux', { motivation: 'Constat prématuré de défaillance' });
    expect(early.json().code).toBe('NO_OVERDUE_INSTALLMENT');
    env.clock.set('2026-11-06T09:00:00Z');
    const list = (await env.req('GET', '/v1/recouvrement/echeanciers', 'u-locataire')).json();
    expect(list[0]).toMatchObject({ defaultToExamine: true, status: 'ACCORDE' });
    const def = await env.req('POST', `/v1/recouvrement/echeanciers/${planId}/defaillance`, 'u-contentieux', { motivation: 'Première échéance impayée après le délai de grâce' });
    expect(def.json().status).toBe('DEFAILLANT');
    expect(env.app.ctx.comms.deliveries.find((d) => d.eventCode === 'installment_plan.defaulted').length).toBeGreaterThan(0);
  });

  it('aucun échéancier sans acte l’autorisant', async () => {
    const env = await setupRecovery();
    svcOf(env).planLegalBasisInstrumentId = null;
    const r = await env.req('POST', '/v1/recouvrement/echeanciers', 'u-locataire', { obligationId: tenantArrear(env), installments: 3, reason: 'Revenus irréguliers' });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('ACTE_REQUIS');
  });
});

describe('Pénalités et remises : règle ACTIVE et décision humaine uniquement', () => {
  it('pénalité : refusée hors règle PENALITE ACTIVE ; proposée → décidée → liquidée par le circuit commun', async () => {
    const env = await setupRecovery();
    const obl = tenantArrear(env);
    const demoRule = env.app.ctx.rules.rules.find((r) => r.code === DEMO.demoRuleCode)[0]!;
    const motivation = 'Retard de paiement constaté après relances';
    expect((await env.req('POST', '/v1/recouvrement/penalites', 'u-contentieux', { obligationId: obl, penaltyRuleId: demoRule.id, motivation })).json().code).toBe('NOT_A_PENALTY_RULE');
    const penaltyRule = { revenueCategory: 'PENALITE', formula: 'montant_base * taux / 100', rateTable: { taux: '10' }, label: 'Pénalité de retard (fictive, test)' };
    const draft = await publishCertifiedRule(env, { ...penaltyRule, code: 'TEST-PEN-BROUILLON' }, 3);
    expect((await env.req('POST', '/v1/recouvrement/penalites', 'u-contentieux', { obligationId: obl, penaltyRuleId: draft.id, inputs: { montant_base: '50' }, motivation })).json().code).toBe('PENALTY_RULE_NOT_ACTIVE');
    const active = await publishCertifiedRule(env, { ...penaltyRule, code: 'TEST-PEN' });
    const p = await env.req('POST', '/v1/recouvrement/penalites', 'u-contentieux', { obligationId: obl, penaltyRuleId: active.id, inputs: { montant_base: '50' }, motivation });
    expect(p.json()).toMatchObject({ status: 'PROPOSEE', previewAmount: { amount: '5.00', currency: 'USD' } });
    const count = env.app.ctx.assessment.obligations.count();
    expect((await env.req('POST', `/v1/recouvrement/penalites/${p.json().id}/liquidation`, 'u-controleur')).json().code).toBe('PENALTY_NOT_DECIDED');
    await env.req('POST', `/v1/recouvrement/penalites/${p.json().id}/decision`, 'u-decideur', { decision: 'APPROUVEE', motivation: 'Pénalité conforme à la règle active' });
    expect(env.app.ctx.assessment.obligations.count()).toBe(count); // décision ≠ liquidation automatique
    expect((await env.req('POST', `/v1/recouvrement/penalites/${p.json().id}/liquidation`, 'u-contentieux')).statusCode).toBe(403);
    const liq = await env.req('POST', `/v1/recouvrement/penalites/${p.json().id}/liquidation`, 'u-controleur');
    expect(liq.json().status).toBe('LIQUIDEE');
    expect(env.app.ctx.assessment.get(liq.json().liquidatedObligationId)).toMatchObject({ ruleCode: 'TEST-PEN', amount: { amount: '5.00', currency: 'USD' } });
  });

  it('remise : acte requis ; accordée par une autorité distincte via obligation rectificative', async () => {
    const env = await setupRecovery();
    const obl = tenantArrear(env);
    const demoRule = env.app.ctx.rules.rules.find((r) => r.code === DEMO.demoRuleCode)[0]!;
    const motivation = 'Situation sociale difficile documentée';
    expect((await env.req('POST', '/v1/recouvrement/remises', 'u-locataire', { obligationId: obl, basisRuleId: 'rule-irl-kin-r1-v1', requestedAmount: { amount: '30.00', currency: 'USD' }, motivation })).json().code).toBe('ACTE_REQUIS');
    expect((await env.req('POST', '/v1/recouvrement/remises', 'u-locataire', { obligationId: obl, basisRuleId: demoRule.id, requestedAmount: { amount: '30.00', currency: 'USD' }, motivation })).json().code).toBe('REMISSION_BASIS_NOT_DECLARED');
    const basis = await publishCertifiedRule(env, { code: 'TEST-REMISE', exemptions: [{ basis: 'Art. 3 (fictif) — remise gracieuse', proof: 'Attestation sociale' }] });
    const r = await env.req('POST', '/v1/recouvrement/remises', 'u-locataire', { obligationId: obl, basisRuleId: basis.id, requestedAmount: { amount: '30.00', currency: 'USD' }, motivation });
    expect(r.json().status).toBe('DEMANDEE');
    expect((await env.req('POST', `/v1/recouvrement/remises/${r.json().id}/decision`, 'u-contentieux', { granted: true, motivation: 'Sans habilitation de décision' })).statusCode).toBe(403);
    const d = await env.req('POST', `/v1/recouvrement/remises/${r.json().id}/decision`, 'u-decideur', { granted: true, motivation: 'Remise conforme à l’article 3 fictif' });
    expect(d.json().status).toBe('ACCORDEE');
    expect(env.app.ctx.assessment.get(obl)).toMatchObject({ status: 'ANNULEE', supersededBy: d.json().rectifyingObligationId });
    expect(env.app.ctx.assessment.get(d.json().rectifyingObligationId).amount).toEqual({ amount: '30.00', currency: 'USD' });
  });
});

describe('Indicateurs agrégés', () => {
  it('encours, dossiers, avis, recours : agrégats sans donnée nominative', async () => {
    const env = await setupRecovery();
    expect((await env.req('GET', '/v1/recouvrement/indicateurs', 'u-locataire')).statusCode).toBe(403);
    const ind = (await env.req('GET', '/v1/recouvrement/indicateurs', 'u-auditeur')).json();
    expect(ind.cases.open).toBe(1);
    expect(ind.recoveryCost.status).toBe('NON_MESURE');
    expect(JSON.stringify(ind)).not.toContain('Nzuzi');
  });
});
