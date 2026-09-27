/**
 * Gouvernance des réductions de recettes :
 *  - suspension / levée d'une règle en quatre yeux, alertes (levée rapide, décisions pendant la suspension) ;
 *  - rapport « réductions de recettes » (brut − réductions = net, par devise) et recettes potentielles non liquidées ;
 *  - signaux de concentration des réductions (décideur, cumul par contribuable) ;
 *  - actes sensibles étendus dans la détection d'intégrité.
 */
import { Money, type MoneyJSON } from '@mosolo/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import type { MosoloPlugin } from '../src/plugins/types.js';
import { integritePlugin } from '../src/plugins/integrite/plugin.js';
import { sensitiveKeysOf, type IntegriteService } from '../src/plugins/integrite/service.js';
import { pilotagePlugin } from '../src/plugins/pilotage/plugin.js';
import { reductionSignals, type ReductionLine } from '../src/plugins/pilotage/reductions.js';
import type { PilotageService } from '../src/plugins/pilotage/service.js';
import { publicitePlugin } from '../src/plugins/publicite/plugin.js';
import { verticalesPlugin } from '../src/plugins/verticales/plugin.js';
import { DEMO, publishCertifiedRule, type TestEnv } from './helpers.js';

async function setupWith(plugins: MosoloPlugin[]): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} },
    plugins,
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

const SUSPEND = { reason: 'Contestation de la base légale devant la Cour', authority: 'Ministre provincial des Finances' };
const decide = (env: TestEnv, id: string, user: string, approve = true) =>
  env.req('POST', `/v1/legal-rules/${id}/suspension-change/decide`, user, { approve, reason: approve ? 'Approbation motivée (seconde personne)' : 'Rejet motivé de la proposition' });
const liquidate = (env: TestEnv, ruleId: string) =>
  env.req('POST', '/v1/assessments/calculate', 'u-controleur', { ruleId, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: { superficie_m2: '600' }, simulate: false });

/** Décision « sans pénalité » telle que l'enregistre un module de sanctions pendant une suspension. */
function penaltyDecisionWithoutAmount(env: TestEnv, ref: string) {
  env.app.ctx.audit.append({
    actor: { kind: 'user', id: 'u-decideur', roles: ['R21'] }, action: 'parking.violation.decided_retained', resourceType: 'parking_violation', resourceId: ref,
    details: { reason: 'Stationnement gênant', obligationId: null, effect: 'Constat retenu sans pénalité : barème non publié (acte requis).' },
  });
}

// ───────────────────────── 1. Suspension en quatre yeux ─────────────────────────
describe('Registre — suspension et levée en quatre yeux', () => {
  it('une personne seule ne peut ni suspendre ni lever : proposition puis approbation par une personne distincte', async () => {
    const env = await setupWith([]);
    const { id } = await publishCertifiedRule(env, { code: 'TEST-4Y' });
    expect((await env.req('POST', `/v1/legal-rules/${id}/suspend`, 'u-juriste-redacteur', SUSPEND)).statusCode).toBe(403);
    const p = await env.req('POST', `/v1/legal-rules/${id}/suspend`, 'u-autorite-publication', SUSPEND);
    expect(p.statusCode).toBe(202);
    // Proposition sans effet : la règle reste ACTIVE et liquide toujours.
    expect(env.app.ctx.rules.get(id).status).toBe('ACTIVE');
    expect((await liquidate(env, id)).statusCode).toBe(201);
    // Double proposition refusée ; auto-approbation refusée ; le juriste vérificateur n'approuve pas.
    expect((await env.req('POST', `/v1/legal-rules/${id}/suspend`, 'u-juriste-verificateur', SUSPEND)).json().code).toBe('SUSPENSION_CHANGE_PENDING');
    const self = await decide(env, id, 'u-autorite-publication');
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe('SEPARATION_OF_DUTIES');
    expect((await decide(env, id, 'u-juriste-verificateur')).statusCode).toBe(403);
    const ok = await decide(env, id, 'u-validateur-financier');
    expect(ok.json()).toMatchObject({ status: 'SUSPENDUE', suspension: { proposedBy: 'u-autorite-publication', approvedBy: 'u-validateur-financier' } });
    expect(ok.json().pendingSuspensionChange).toBeUndefined();

    // Levée : proposée par le juriste vérificateur, approuvée par l'autorité de publication.
    env.clock.advance(10 * 86_400_000);
    expect((await env.req('POST', `/v1/legal-rules/${id}/lift-suspension`, 'u-juriste-verificateur', { reason: 'Arrêt de la Cour confirmant la base légale' })).statusCode).toBe(202);
    expect(env.app.ctx.rules.get(id).status).toBe('SUSPENDUE');
    expect((await decide(env, id, 'u-juriste-verificateur')).statusCode).toBe(403);
    const lifted = await decide(env, id, 'u-autorite-publication');
    expect(lifted.json().status).toBe('ACTIVE');
    expect(lifted.json().pastSuspensions[0]).toMatchObject({ liftProposedBy: 'u-juriste-verificateur', liftApprovedBy: 'u-autorite-publication' });
    // Suspension de 10 jours, aucune décision dans la fenêtre : aucune alerte.
    expect(env.app.ctx.alerts.list().filter((a) => a.type.startsWith('RULE_'))).toHaveLength(0);
    expect(env.app.ctx.audit.list({ action: 'rule.suspension.approval_refused' }).total).toBe(1);
  });

  it('proposition rejetée : aucune suspension, proposition close', async () => {
    const env = await setupWith([]);
    const { id } = await publishCertifiedRule(env, { code: 'TEST-4Y-REJ' });
    await env.req('POST', `/v1/legal-rules/${id}/suspend`, 'u-autorite-publication', SUSPEND);
    const r = await decide(env, id, 'u-validateur-financier', false);
    expect(r.json().status).toBe('ACTIVE');
    expect(r.json().pendingSuspensionChange).toBeUndefined();
    expect(env.app.ctx.rules.wasSuspendedBetween('TEST-4Y-REJ', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')).toBe(false);
    expect((await decide(env, id, 'u-validateur-financier')).json().code).toBe('NO_PENDING_SUSPENSION_CHANGE');
  });

  it('levée rapide et décisions prises pendant la suspension : alertes d’examen ; wasSuspendedBetween exposé', async () => {
    const env = await setupWith([]);
    const { id } = await publishCertifiedRule(env, { code: 'TEST-FENETRE' });
    const before = env.clock.now().toISOString();
    env.clock.advance(3_600_000);
    await env.req('POST', `/v1/legal-rules/${id}/suspend`, 'u-autorite-publication', SUSPEND);
    await decide(env, id, 'u-validateur-financier');
    const suspendedAt = env.app.ctx.rules.get(id).suspension!.at;
    env.clock.advance(86_400_000);
    penaltyDecisionWithoutAmount(env, 'PV-TEST-1');
    expect(env.app.ctx.rules.decisionsDuringSuspension('TEST-FENETRE').map((d) => d.resourceId)).toEqual(['PV-TEST-1']);
    env.clock.advance(86_400_000);
    await env.req('POST', `/v1/legal-rules/${id}/lift-suspension`, 'u-validateur-financier', { reason: 'Levée demandée après deux jours de suspension' }).then((r) => expect(r.statusCode).toBe(403));
    await env.req('POST', `/v1/legal-rules/${id}/lift-suspension`, 'u-juriste-verificateur', { reason: 'Levée demandée après deux jours de suspension' });
    expect((await decide(env, id, 'u-autorite-publication')).json().status).toBe('ACTIVE');
    const liftedAt = env.clock.now().toISOString();

    const alerts = env.app.ctx.alerts.list();
    const short = alerts.find((a) => a.type === 'RULE_SUSPENSION_SHORT');
    expect(short?.context).toMatchObject({ ruleCode: 'TEST-FENETRE', suspendedBy: ['u-autorite-publication', 'u-validateur-financier'], liftedBy: ['u-juriste-verificateur', 'u-autorite-publication'] });
    const during = alerts.find((a) => a.type === 'RULE_DECISIONS_DURING_SUSPENSION');
    expect((during?.context.decisions as { resourceId: string }[])[0]!.resourceId).toBe('PV-TEST-1');

    const rules = env.app.ctx.rules;
    expect(rules.wasSuspendedBetween('TEST-FENETRE', before, suspendedAt)).toBe(true);
    expect(rules.wasSuspendedBetween('TEST-FENETRE', '2026-09-27T00:00:00Z', '2026-09-27T12:00:00Z')).toBe(true);
    expect(rules.wasSuspendedBetween('TEST-FENETRE', '2026-01-01T00:00:00Z', before)).toBe(false);
    env.clock.advance(3_600_000);
    expect(rules.wasSuspendedBetween('TEST-FENETRE', new Date(new Date(liftedAt).getTime() + 1).toISOString(), env.clock.now().toISOString())).toBe(false);
    expect(rules.wasSuspendedBetween('AUTRE-CODE', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')).toBe(false);
  });
});

// ───────────────────────── 2 & 3. Rapport des réductions et concentration ─────────────────────────
let seq = 0;
function newObligation(env: TestEnv, commune: string, rank: 1 | 2 | 3 | 4 = 2) {
  const { ctx } = env.app;
  seq++;
  const tp = ctx.taxpayers.register({ phone: `+24398${String(seq).padStart(7, '0')}`, fullName: `Fictif Réductions ${seq}`, language: 'fr', situation: 'landlord' });
  const obj = ctx.objects.create(ctx.users.get('u-guichet')!, { taxpayerId: tp.id, category: 'PARCELLE', commune, quartier: 'Test', localityRank: rank, lat: -4.3, lon: 15.3, attributes: {} });
  const rule = ctx.rules.rules.find((r) => r.code === DEMO.demoRuleCode)[0]!;
  return ctx.assessment.calculate(ctx.users.get('u-controleur')!, { ruleId: rule.id, taxpayerId: tp.id, objectId: obj.id, inputs: {}, simulate: false }).obligation!;
}

function granted(env: TestEnv, p: { path: string; obligationId: string; from: MoneyJSON; to: MoneyJSON; deciderId: string; taxpayerId: string }) {
  env.app.ctx.audit.append({
    actor: { kind: 'user', id: p.deciderId, roles: ['R21'] }, action: 'reduction.granted', resourceType: 'obligation', resourceId: p.obligationId,
    details: { path: p.path, obligationId: p.obligationId, fromAmount: p.from, toAmount: p.to, deciderId: p.deciderId, taxpayerId: p.taxpayerId },
  });
}

const m = (j: MoneyJSON) => Money.fromJSON(j);

describe('Pilotage — rapport des réductions de recettes', () => {
  it('brut − réductions = net par devise ; réductions typées par voie, commune, module et décideur ; accès restreint', async () => {
    const env = await setupWith([pilotagePlugin]);
    const { ctx } = env.app;
    const decideur = ctx.users.get('u-decideur')!;
    // A : obligation intacte ; B : remise ; C : admission en non-valeur (événement reduction.granted) ; D : annulation non tracée ;
    // E : exonération à la liquidation ; F : forçage de base déclaré ; G : réclamation (rectification sans type).
    const a = newObligation(env, 'Limete');
    const b = newObligation(env, 'Limete');
    const c = newObligation(env, 'Limete');
    const d = newObligation(env, 'Limete');
    const e = newObligation(env, 'Gombe', 1);
    const f = newObligation(env, 'Gombe', 1);
    const half = m(b.amount).percent('50');
    const bRect = ctx.assessment.rectify(b.id, half.toJSON(), { appealId: 'REM-TEST-1', reason: 'Remise gracieuse (test)', decidedBy: decideur, decisionType: 'REMISE' });
    ctx.assessment.setStatus(c.id, 'ADMISE_EN_NON_VALEUR');
    granted(env, { path: 'recouvrement.non_valeur', obligationId: c.id, from: c.amount, to: { amount: '0.00', currency: 'USD' }, deciderId: 'u-decideur', taxpayerId: c.taxpayerId });
    ctx.assessment.setStatus(d.id, 'ANNULEE');
    // Exonération appliquée à la liquidation : brut 900, émis 450.
    const eObl = ctx.assessment.obligations.get(e.id)!;
    ctx.assessment.obligations.update({
      ...eObl,
      trace: {
        ...eObl.trace, grossResult: { amount: '900.00', currency: 'USD' },
        adjustments: [{ kind: 'EXONERATION', sourceId: 'EXO-T', label: 'Exonération (test)', legalBasis: { instrumentId: 'demo-instrument-001', title: 'x', article: '1' }, rate: '50', reduction: { amount: '450.00', currency: 'USD' }, validFrom: '2026-01-01', validTo: '2026-12-31', decidedBy: ['u-controleur', 'u-dg-dgipk'] }],
      },
    });
    // Forçage de base : calcul 600 ramené au montant émis (450).
    granted(env, { path: 'assessment.base_override', obligationId: f.id, from: { amount: '600.00', currency: 'USD' }, to: f.amount, deciderId: 'u-controleur', taxpayerId: f.taxpayerId });
    // Réduction déclarée sans trace correspondante : hors totaux, listée.
    granted(env, { path: 'appeal', obligationId: 'OBL-INCONNUE', from: { amount: '10', currency: 'USD' }, to: { amount: '0', currency: 'USD' }, deciderId: 'u-decideur', taxpayerId: 'x' });

    expect((await env.req('GET', '/v1/pilotage/reductions', 'u-controleur')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/pilotage/reductions', 'u-dg-dgipk')).statusCode).toBe(403);
    for (const u of ['u-dircab', 'u-ministre-finances', 'u-auditeur', 'pilotage-u-auditeur-externe', 'u-enqueteur']) {
      expect((await env.req('GET', '/v1/pilotage/reductions', u)).statusCode).toBe(200);
    }
    const res = await env.req('GET', '/v1/pilotage/reductions', 'u-gouverneur');
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r.reconciled).toBe(true);
    const usd = r.totals.find((t: { currency: string }) => t.currency === 'USD');
    // Contrôle indépendant du rapprochement : brut − réductions = net, écart ≤ 0,01.
    expect(m(usd.grossAssessed).subtract(m(usd.reductions.total)).equals(m(usd.netExpected))).toBe(true);
    expect(usd.reconciliation).toMatchObject({ reconciled: true, gap: { amount: '0.00', currency: 'USD' } });
    const byType = Object.fromEntries(usd.reductions.byType.map((t: { type: string; amount: MoneyJSON }) => [t.type, t.amount.amount]));
    expect(byType).toMatchObject({
      REMISE: m(b.amount).subtract(half).toDecimalString(),
      ADMISSION_NON_VALEUR: m(c.amount).toDecimalString(),
      ANNULATION: m(d.amount).toDecimalString(),
      EXONERATION: '450.00',
      MINORATION_LIQUIDATION: '150.00',
    });
    // Aucun total tous-devises : chaque bloc porte sa devise.
    for (const t of r.totals) expect(t.grossAssessed.currency).toBe(t.currency);
    // Net attendu : A + rectificative de B + E + F (C et D réduites à zéro).
    const ours = [a.amount, bRect.amount, e.amount, f.amount].reduce((acc, x) => acc.add(m(x)), Money.zero('USD'));
    expect(m(usd.netExpected).compare(ours)).toBeGreaterThanOrEqual(0);

    const limete = r.byCommune.find((x: { commune: string }) => x.commune === 'Limete').totals[0];
    expect(limete.reductions.count).toBe(3);
    expect(r.byModule.map((x: { module: string }) => x.module)).toContain('socle');
    const dec = r.byDecider.find((x: { deciderId: string }) => x.deciderId === 'u-decideur');
    expect(dec).toMatchObject({ count: 2, traced: true, communes: ['Limete'] });
    expect(r.byDecider.find((x: { deciderId: string }) => x.deciderId === 'u-dg-dgipk')).toMatchObject({ count: 1 });
    expect(r.byDecider.find((x: { deciderId: string }) => x.deciderId === 'u-controleur')).toMatchObject({ count: 1 });
    expect(r.untracedDeciders).toBe(1); // annulation sans acte tracé : signalée, jamais attribuée
    expect(r.unmatchedDeclaredReductions).toHaveLength(1);
    expect(r.unmatchedDeclaredReductions[0].obligationId).toBe('OBL-INCONNUE');

    // Filtre commune : seules les chaînes de Gombe ; le rapprochement tient toujours.
    const g = (await env.req('GET', '/v1/pilotage/reductions?commune=Gombe', 'u-auditeur')).json();
    expect(g.reconciled).toBe(true);
    expect(g.byCommune.map((x: { commune: string }) => x.commune)).toEqual(['Gombe']);
  });

  it('concentration : un décideur > 50 % des réductions d’une commune sur un mois lève une alerte (une seule fois)', async () => {
    const env = await setupWith([pilotagePlugin]);
    const { ctx } = env.app;
    const decideur = ctx.users.get('u-decideur')!;
    for (let i = 0; i < 3; i++) {
      const o = newObligation(env, 'Matete');
      ctx.assessment.rectify(o.id, m(o.amount).percent('10').toJSON(), { appealId: `REM-C-${i}`, reason: 'Remise (test)', decidedBy: decideur, decisionType: 'REMISE' });
    }
    const other = newObligation(env, 'Matete');
    ctx.assessment.rectify(other.id, m(other.amount).percent('90').toJSON(), { appealId: 'REM-C-X', reason: 'Remise (test)', decidedBy: ctx.users.get('u-dg-dgipk')!, decisionType: 'REMISE' });

    expect((await env.req('POST', '/v1/pilotage/reductions/detection', 'u-gouverneur')).statusCode).toBe(403);
    const first = await env.req('POST', '/v1/pilotage/reductions/detection', 'u-enqueteur');
    expect(first.statusCode).toBe(200);
    expect(first.json().raised).toBeGreaterThanOrEqual(1);
    const alert = ctx.alerts.list().find((a) => a.type === 'REDUCTION_CONCENTRATION_DECIDEUR');
    expect(alert?.context).toMatchObject({ commune: 'Matete', deciderId: 'u-decideur', count: 3, groupCount: 4, byCount: true });
    expect(alert?.context.byAmountCurrencies).toEqual(['USD']);
    // Rejouée (y compris à la lecture du rapport) : aucune nouvelle alerte.
    expect((await env.req('POST', '/v1/pilotage/reductions/detection', 'u-auditeur')).json().raised).toBe(0);
    await env.req('GET', '/v1/pilotage/reductions', 'u-auditeur');
    expect(ctx.alerts.list().filter((a) => a.type === 'REDUCTION_CONCENTRATION_DECIDEUR')).toHaveLength(1);
    // L'auditeur interne (R22) et l'enquêteur (R24) sont notifiés.
    const notified = new Set(ctx.comms.deliveries.all().filter((x) => x.eventCode === 'fraud.alert.raised').map((x) => x.recipientId));
    expect(notified.has('u-auditeur')).toBe(true);
    expect(notified.has('u-enqueteur')).toBe(true);
    expect(ext(env).detectReductionSignals().raised).toBe(0);
  });

  it('signaux : part en montant > 50 % et cumul par contribuable au-delà du seuil (par devise, jamais additionnées)', () => {
    const line = (p: Partial<ReductionLine> & { amount: MoneyJSON }): ReductionLine => ({
      type: 'REMISE', obligationId: 'O', rootId: `R-${Math.random()}`, resultingObligationId: null, at: '2026-09-10T10:00:00Z', deciderId: 'u-a',
      commune: 'Kalamu', module: 'socle', entity: 'DGIPK', ruleCode: 'X', taxpayerId: 'TP-1', ...p,
    });
    const lines = [
      line({ deciderId: 'u-a', amount: { amount: '900', currency: 'USD' } }),
      line({ deciderId: 'u-b', amount: { amount: '50', currency: 'USD' }, taxpayerId: 'TP-2' }),
      line({ deciderId: 'u-c', amount: { amount: '50', currency: 'USD' }, taxpayerId: 'TP-3' }),
      line({ deciderId: 'u-a', amount: { amount: '200', currency: 'USD' }, at: '2026-10-02T10:00:00Z' }),
      line({ deciderId: 'u-a', amount: { amount: '2000000', currency: 'CDF' }, at: '2026-10-02T10:00:00Z' }),
    ];
    const s = reductionSignals(lines);
    const dec = s.filter((x) => x.kind === 'DECIDEUR_CONCENTRE');
    // Septembre : u-a 1/3 en nombre mais 90 % du montant USD.
    expect(dec).toHaveLength(1);
    expect(dec[0]!.context).toMatchObject({ deciderId: 'u-a', month: '2026-09', byCount: false, byAmountCurrencies: ['USD'] });
    const tp = s.filter((x) => x.kind === 'CUMUL_CONTRIBUABLE');
    // TP-1 : 1 100 USD > 1 000 USD ; 2 000 000 CDF ≤ 2 500 000 CDF (devises jamais additionnées).
    expect(tp).toHaveLength(1);
    expect(tp[0]!.context).toMatchObject({ taxpayerId: 'TP-1', currency: 'USD', total: { amount: '1100.00', currency: 'USD' } });
  });

  it('recettes potentielles non liquidées : dispositifs et objets taxables sans règle ACTIVE — unités et surface, jamais de montant', async () => {
    const env = await setupWith([pilotagePlugin, publicitePlugin, verticalesPlugin]);
    const r = (await env.req('GET', '/v1/pilotage/reductions', 'u-ministre-finances')).json();
    const p = r.potentialUnassessed;
    expect(p.note).toMatch(/Aucun montant/);
    const pub = p.rows.filter((x: { vertical: string }) => x.vertical === 'publicite');
    expect(pub.length).toBeGreaterThanOrEqual(1);
    expect(pub[0]).toMatchObject({ legalStatus: 'ACTE_REQUIS' });
    expect(Number(pub[0].surfaceM2)).toBeGreaterThan(0);
    const avia = p.rows.find((x: { vertical: string }) => x.vertical === 'avia');
    expect(avia).toMatchObject({ legalStatus: 'ACTE_REQUIS' });
    expect(avia.units).toBeGreaterThanOrEqual(1);
    expect(p.units).toBe(p.rows.reduce((n: number, x: { units: number }) => n + x.units, 0));
    // Aucun montant inventé : ni devise ni montant dans la section.
    expect(JSON.stringify(p)).not.toMatch(/"currency"|"amount"/);
  });
});

function ext(env: TestEnv): PilotageService {
  return env.app.ctx.ext.pilotage as PilotageService;
}

// ───────────────────────── 5. Actes sensibles (intégrité) ─────────────────────────
describe('Intégrité — actes sensibles étendus', () => {
  it('clé action:kind pour les opérations génériques (contre-écriture)', () => {
    expect(sensitiveKeysOf({ action: 'treasury.operation.executed', details: { kind: 'CONTRE_ECRITURE' } })).toEqual(['treasury.operation.executed', 'treasury.operation.executed:CONTRE_ECRITURE']);
  });

  it('suspension de règle, contre-écriture, remises concentrées, décisions pendant suspension : alertes à examiner, sans effet automatique', async () => {
    const env = await setupWith([integritePlugin]);
    const { ctx } = env.app;
    const svc = ctx.ext.integrite as IntegriteService;
    const { id } = await publishCertifiedRule(env, { code: 'TEST-INTEG' });
    await env.req('POST', `/v1/legal-rules/${id}/suspend`, 'u-autorite-publication', SUSPEND);
    await decide(env, id, 'u-validateur-financier');
    penaltyDecisionWithoutAmount(env, 'PV-INTEG-1');
    ctx.audit.append({ actor: { kind: 'user', id: 'u-tresor', roles: ['R17'] }, action: 'treasury.operation.executed', resourceType: 'financial_operation', resourceId: 'OPF-1', details: { kind: 'CONTRE_ECRITURE', proposedBy: 'u-analyste-rappro' } });
    ctx.audit.append({ actor: { kind: 'user', id: 'u-tresor', roles: ['R17'] }, action: 'treasury.operation.executed', resourceType: 'financial_operation', resourceId: 'OPF-2', details: { kind: 'REMBOURSEMENT' } });
    for (let i = 0; i < 3; i++) ctx.audit.append({ actor: { kind: 'user', id: 'u-decideur', roles: ['R21'] }, action: 'recovery.remission.granted', resourceType: 'obligation', resourceId: `OBL-${i}`, details: { remissionId: `REM-${i}` } });
    ctx.audit.append({ actor: { kind: 'user', id: 'u-contentieux', roles: ['R20'] }, action: 'recovery.remission.granted', resourceType: 'obligation', resourceId: 'OBL-9', details: { remissionId: 'REM-9' } });

    const run = svc.runDetection('system');
    expect(run.automaticEffect).toBe('AUCUN');
    const codes = run.alerts.map((a) => a.ruleCode);
    const review = run.alerts.filter((a) => a.ruleCode === 'ACTE_SENSIBLE_A_EXAMINER').map((a) => a.variables[0]!.value);
    expect(review).toEqual(expect.arrayContaining(['rule.suspended', 'treasury.operation.executed:CONTRE_ECRITURE']));
    expect(review).not.toContain('treasury.operation.executed');
    expect(codes).toContain('DECISIONS_PENDANT_SUSPENSION');
    const conc = run.alerts.find((a) => a.ruleCode === 'CONCENTRATION_ACTES_SENSIBLES');
    expect(conc?.explanation).toContain('recovery.remission.granted');
    expect(conc?.subjects).toEqual([{ kind: 'AGENT', ref: 'u-decideur' }]);
    // Rejouée : aucune alerte en double.
    expect(svc.runDetection('system').alerts.filter((a) => a.ruleCode === 'ACTE_SENSIBLE_A_EXAMINER')).toHaveLength(0);
    // La règle reste suspendue : la détection ne décide rien.
    expect(ctx.rules.get(id).status).toBe('SUSPENDUE');
  });
});
