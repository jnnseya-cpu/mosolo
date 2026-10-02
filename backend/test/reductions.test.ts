/**
 * Fuites de recettes par réduction de créance ou de base : chaque test REJOUE l'attaque constatée puis vérifie le
 * circuit légitime (taux déclaré par la règle, séparation des tâches, conflit d'intérêts, traçabilité
 * `reduction.granted`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { fiscalPlugin } from '../src/plugins/fiscal/plugin.js';
import type { FiscalService } from '../src/plugins/fiscal/service.js';
import { recouvrementPlugin, RecoveryService } from '../src/plugins/recouvrement/plugin.js';
import { clearCertifiedLocalityRanks, loadCertifiedLocalityRanks } from '../src/reference/locality-ranks.js';
import { DEMO, publishCertifiedRule, type TestEnv } from './helpers.js';

const TENANT = DEMO.tenantTaxpayerId;
const MOTIVATION = 'Situation sociale difficile documentée';
const DEFAULT_RATES = { 'tarif_m2:1': '3.5', 'tarif_m2:2': '2.5', 'tarif_m2:3': '2', 'tarif_m2:4': '1.5' };

async function setupAll() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} },
    plugins: [recouvrementPlugin, fiscalPlugin],
  });
  await app.ready();
  const env: TestEnv = {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
  return { ...env, rec: app.ctx.ext['recouvrement'] as RecoveryService, fiscal: app.ctx.ext['fiscal'] as FiscalService };
}
type Env = Awaited<ReturnType<typeof setupAll>>;

const tenantArrear = (env: Env) => env.app.ctx.assessment.byTaxpayer(TENANT)[0]!.id;
const demoObligation = (env: Env) => env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId).find((o) => o.ruleCode === DEMO.demoRuleCode)!.id;
const reductions = (env: Env) => env.app.ctx.audit.list({ action: 'reduction.granted', limit: 500 }).items.map((i) => i.details as Record<string, unknown>);

/** Version de la règle de l'obligation déclarant une base de remise ET un taux maximal (40 %). */
async function remissionBasis(env: Env, rate = '40') {
  return publishCertifiedRule(env, {
    code: DEMO.demoRuleCode, exemptions: [{ basis: 'Art. 3 (fictif) — remise gracieuse', proof: 'Attestation sociale' }],
    effectiveFrom: env.clock.now().toISOString().slice(0, 10), rateTable: { ...DEFAULT_RATES, taux_remise_max: rate },
  });
}

afterEach(() => clearCertifiedLocalityRanks());

// ───────────────────────── 1. Remises du recouvrement ─────────────────────────
describe('Remise de recouvrement : jamais libre, plafonnée par la règle et cumulée sur la chaîne', () => {
  it('attaque : demande à 0 puis décision libre à 0 — refusées ; montant calculé selon le taux déclaré', async () => {
    const env = await setupAll();
    const obl = tenantArrear(env); // 50,00 USD
    const basis = await remissionBasis(env);
    // La créance ne peut être ramenée à zéro par une remise.
    const zero = await env.req('POST', '/v1/recouvrement/remises', 'u-locataire', { obligationId: obl, basisRuleId: basis.id, requestedAmount: { amount: '0', currency: 'USD' }, motivation: MOTIVATION });
    expect(zero.json().code).toBe('REMISSION_TO_ZERO_FORBIDDEN');
    // Demande à 1,00 : le calcul plafonne la remise à 40 % de 50,00 ⇒ 30,00 (jamais le montant demandé).
    const r = (await env.req('POST', '/v1/recouvrement/remises', 'u-locataire', { obligationId: obl, basisRuleId: basis.id, requestedAmount: { amount: '1.00', currency: 'USD' }, motivation: MOTIVATION })).json();
    expect(r.computation).toMatchObject({ rate: '40', maxReduction: { amount: '20.00' }, computedAmount: { amount: '30.00' } });
    await env.req('POST', `/v1/recouvrement/remises/${r.id}/instruction`, 'u-contentieux', { favorable: true, analysis: 'Pièces sociales vérifiées au dossier.' });
    // Le décideur tente de saisir 0, puis un montant sous le calcul : refusés.
    const free0 = await env.req('POST', `/v1/recouvrement/remises/${r.id}/decision`, 'u-decideur', { granted: true, motivation: 'Remise totale décidée', grantedAmount: { amount: '0', currency: 'USD' } });
    expect(free0.json().code).toBe('REMISSION_BELOW_COMPUTED');
    const below = await env.req('POST', `/v1/recouvrement/remises/${r.id}/decision`, 'u-decideur', { granted: true, motivation: 'Remise généreuse décidée', grantedAmount: { amount: '10.00', currency: 'USD' } });
    expect(below.json().code).toBe('REMISSION_BELOW_COMPUTED');
    const ok = await env.req('POST', `/v1/recouvrement/remises/${r.id}/decision`, 'u-decideur', { granted: true, motivation: 'Remise conforme à l’article 3 fictif' });
    expect(ok.json().status).toBe('ACCORDEE');
    const rect = env.app.ctx.assessment.get(ok.json().rectifyingObligationId);
    expect(rect.amount).toEqual({ amount: '30.00', currency: 'USD' });
    expect(rect.status).not.toBe('SOLDEE');
    expect(rect.explanation.rectification?.decisionType).toBe('REMISE');
    expect(reductions(env).at(-1)).toMatchObject({ path: 'REMISE_RECOUVREMENT', obligationId: obl, fromAmount: { amount: '50.00' }, toAmount: { amount: '30.00' }, deciderId: 'u-decideur', taxpayerId: TENANT });
    // Rejeu sur la rectificative : le plafond cumulé est épuisé.
    const again = await env.req('POST', '/v1/recouvrement/remises', 'u-locataire', { obligationId: rect.id, basisRuleId: basis.id, requestedAmount: { amount: '5.00', currency: 'USD' }, motivation: MOTIVATION });
    expect(again.json().code).toBe('REMISSION_CAP_EXHAUSTED');
  });

  it('plafond cumulé : une seconde demande sur la rectificative n’obtient que le reliquat du plafond', async () => {
    const env = await setupAll();
    const obl = tenantArrear(env);
    const basis = await remissionBasis(env);
    const grant = async (oblId: string, requested: string) => {
      const r = (await env.req('POST', '/v1/recouvrement/remises', 'u-locataire', { obligationId: oblId, basisRuleId: basis.id, requestedAmount: { amount: requested, currency: 'USD' }, motivation: MOTIVATION })).json();
      await env.req('POST', `/v1/recouvrement/remises/${r.id}/instruction`, 'u-contentieux', { favorable: true, analysis: 'Pièces sociales vérifiées au dossier.' });
      return (await env.req('POST', `/v1/recouvrement/remises/${r.id}/decision`, 'u-decideur', { granted: true, motivation: 'Remise conforme à l’article 3 fictif' })).json();
    };
    const first = await grant(obl, '40.00'); // remise de 10,00
    expect(env.app.ctx.assessment.get(first.rectifyingObligationId).amount.amount).toBe('40.00');
    const second = await grant(first.rectifyingObligationId, '1.00'); // reliquat : 20,00 − 10,00 = 10,00
    expect(second.computation).toMatchObject({ alreadyRemitted: { amount: '10.00' }, available: { amount: '10.00' } });
    expect(env.app.ctx.assessment.get(second.rectifyingObligationId).amount.amount).toBe('30.00');
  });

  it('séparation des tâches et conflit d’intérêts : instructeur ≠ décideur ; décideur lié refusé ; contrôles rejoués à la décision', async () => {
    const env = await setupAll();
    env.app.ctx.users.add({ id: 'rec-cumul', name: 'Instructeur et décideur (test)', roles: ['R20', 'R21'], entity: 'DGIPK' });
    env.app.ctx.users.add({ id: 'rec-lie', name: 'Décideur lié à la contribuable (test)', roles: ['R21'], entity: 'DGIPK', taxpayerId: TENANT });
    const obl = tenantArrear(env);
    const basis = await remissionBasis(env);
    const r = (await env.req('POST', '/v1/recouvrement/remises', 'u-locataire', { obligationId: obl, basisRuleId: basis.id, requestedAmount: { amount: '30.00', currency: 'USD' }, motivation: MOTIVATION })).json();
    expect(r.status).toBe('DEMANDEE');
    await env.req('POST', `/v1/recouvrement/remises/${r.id}/instruction`, 'rec-cumul', { favorable: true, analysis: 'Pièces sociales vérifiées au dossier.' });
    const self = await env.req('POST', `/v1/recouvrement/remises/${r.id}/decision`, 'rec-cumul', { granted: true, motivation: 'Je décide ce que j’ai instruit' });
    expect(self.json().code).toBe('SEPARATION_OF_DUTIES');
    const related = await env.req('POST', `/v1/recouvrement/remises/${r.id}/decision`, 'rec-lie', { granted: true, motivation: 'Remise à une proche du décideur' });
    expect(related.json().code).toBe('CONFLICT_OF_INTEREST');
    env.app.ctx.assessment.setStatus(obl, 'SOLDEE');
    const late = await env.req('POST', `/v1/recouvrement/remises/${r.id}/decision`, 'u-decideur', { granted: true, motivation: 'Remise conforme à l’article 3 fictif' });
    expect(late.json().code).toBe('OBLIGATION_NOT_PAYABLE');
  });

  it('effacement total : seule l’admission en non-valeur (R20 → R21), statut ADMISE_EN_NON_VALEUR, jamais SOLDEE', async () => {
    const env = await setupAll();
    const obl = tenantArrear(env);
    const body = { obligationId: obl, motivation: 'Contribuable introuvable après enquête, biens insaisissables', evidence: ['PV de carence n° 12 (fictif)'] };
    expect((await env.req('POST', '/v1/recouvrement/non-valeurs', 'u-decideur', body)).statusCode).toBe(403);
    const w = (await env.req('POST', '/v1/recouvrement/non-valeurs', 'u-contentieux', body)).json();
    expect(w.status).toBe('PROPOSEE');
    const d = await env.req('POST', `/v1/recouvrement/non-valeurs/${w.id}/decision`, 'u-decideur', { decision: 'ADMISE', motivation: 'Irrécouvrabilité établie par le PV de carence' });
    expect(d.json().status).toBe('ADMISE');
    expect(env.app.ctx.assessment.get(obl).status).toBe('ADMISE_EN_NON_VALEUR');
    expect(reductions(env).at(-1)).toMatchObject({ path: 'ADMISSION_NON_VALEUR', obligationId: obl, toAmount: { amount: '0.00' }, deciderId: 'u-decideur' });
  });
});

// ───────────────────────── 2. Réclamations ─────────────────────────
describe('Réclamation acceptée : montant explicite, justifié, décideur sans lien', () => {
  const submit = async (env: Env, obl: string, extra: Record<string, unknown> = {}) =>
    (await env.req('POST', '/v1/appeals', 'u-contribuable', { obligationId: obl, grounds: 'Montant contesté (test).', ...extra })).json().id as string;

  it('attaque : ACCEPTEE sans montant (valait 0) refusée ; plancher = demande du contribuable, proposition et re-liquidation', async () => {
    const env = await setupAll();
    const obl = demoObligation(env); // 150,00 USD (rang 2)
    const id = await submit(env, obl, { requestedAmount: { amount: '100.00', currency: 'USD' } });
    await env.req('POST', `/v1/appeals/${id}/instruct`, 'u-contentieux', { proposal: 'PARTIELLEMENT_ACCEPTEE', analysis: 'Surface partiellement erronée.', proposedAmount: { amount: '120.00', currency: 'USD' } });
    const noAmount = await env.req('POST', `/v1/appeals/${id}/decide`, 'u-decideur', { decision: 'ACCEPTEE', reason: 'Accord total du décideur' });
    expect(noAmount.json().code).toBe('RECTIFIED_AMOUNT_REQUIRED');
    const belowRequest = await env.req('POST', `/v1/appeals/${id}/decide`, 'u-decideur', { decision: 'PARTIELLEMENT_ACCEPTEE', reason: 'Réduction au-delà de la demande', rectifiedAmount: { amount: '50.00', currency: 'USD' } });
    expect(belowRequest.json().code).toBe('RECTIFIED_AMOUNT_BELOW_JUSTIFIED');
    const belowProposal = await env.req('POST', `/v1/appeals/${id}/decide`, 'u-decideur', { decision: 'PARTIELLEMENT_ACCEPTEE', reason: 'Réduction au-delà de l’instruction', rectifiedAmount: { amount: '110.00', currency: 'USD' } });
    expect(belowProposal.json().code).toBe('RECTIFIED_AMOUNT_BELOW_JUSTIFIED');
    // Re-liquidation justificative : même règle, même rang ⇒ 150,00 ; aucune réduction n'est justifiée.
    const reliq = await env.req('POST', `/v1/appeals/${id}/decide`, 'u-decideur', { decision: 'PARTIELLEMENT_ACCEPTEE', reason: 'Réduction sur re-liquidation', rectifiedAmount: { amount: '120.00', currency: 'USD' }, reliquidationInputs: {} });
    expect(reliq.json().code).toBe('RECTIFIED_AMOUNT_BELOW_JUSTIFIED');
    const ok = await env.req('POST', `/v1/appeals/${id}/decide`, 'u-decideur', { decision: 'PARTIELLEMENT_ACCEPTEE', reason: 'Surface rectifiée selon le PV', rectifiedAmount: { amount: '120.00', currency: 'USD' } });
    expect(ok.statusCode).toBe(200);
    expect(reductions(env).at(-1)).toMatchObject({ path: 'RECLAMATION', obligationId: obl, fromAmount: { amount: '150.00' }, toAmount: { amount: '120.00' }, deciderId: 'u-decideur', taxpayerId: DEMO.taxpayerId });
  });

  it('acceptation totale explicite (0) : obligation ANNULEE (dégrèvement), jamais SOLDEE ; décideur lié refusé', async () => {
    const env = await setupAll();
    env.app.ctx.users.add({ id: 'dec-lie', name: 'Décideur lié (test)', roles: ['R21'], entity: 'DGIPK', taxpayerId: DEMO.taxpayerId });
    const obl = demoObligation(env);
    const id = await submit(env, obl, { type: 'BIEN_NON_DETENU' });
    await env.req('POST', `/v1/appeals/${id}/instruct`, 'u-contentieux', { proposal: 'ACCEPTEE', analysis: 'Bien vendu avant le fait générateur.' });
    expect((await env.req('POST', `/v1/appeals/${id}/decide`, 'dec-lie', { decision: 'ACCEPTEE', reason: 'Bien non détenu', rectifiedAmount: { amount: '0', currency: 'USD' } })).json().code).toBe('CONFLICT_OF_INTEREST');
    const d = await env.req('POST', `/v1/appeals/${id}/decide`, 'u-decideur', { decision: 'ACCEPTEE', reason: 'Acte de vente antérieur vérifié', rectifiedAmount: { amount: '0', currency: 'USD' } });
    expect(d.statusCode).toBe(200);
    expect(env.app.ctx.assessment.get(d.json().rectifyingObligationId).status).toBe('ANNULEE');
    expect(reductions(env).at(-1)).toMatchObject({ path: 'RECLAMATION', toAmount: { amount: '0.00' } });
  });
});

// ───────────────────────── 3. Corrections de déclaration ─────────────────────────
describe('Correction de déclaration à la baisse : quatre yeux au-delà du seuil ou sur élément vérifié', () => {
  it('attaque : un seul contrôleur ne suffit plus ; second contrôleur distinct ; réduction tracée', async () => {
    const env = await setupAll();
    // Règle certifiée IF assise sur la superficie (connue et VÉRIFIÉE : 600 m² sur la parcelle validée).
    await publishCertifiedRule(env, { code: 'IF-KIN-PP-BATI', effectiveFrom: '2026-09-26' });
    const decl = (await env.req('POST', '/v1/fiscal/declarations', 'u-contribuable', { objectId: DEMO.parcelId, kind: 'IF', period: '2027', inputs: {}, attest: true })).json();
    expect(decl.liquidation.mode).toBe('OPPOSABLE');
    const ob = env.app.ctx.assessment.get(decl.liquidation.obligationId);
    expect(ob.amount.amount).toBe('1500.00');
    const corr = (await env.req('POST', `/v1/fiscal/declarations/${decl.id}/corrections`, 'u-contribuable', { inputs: { superficie_m2: '100' }, reason: 'Surface surévaluée', attest: true })).json();
    expect(corr).toMatchObject({ status: 'A_INSTRUIRE', verificationRequired: true });
    const first = await env.req('POST', `/v1/fiscal/declarations/${corr.id}/instruction`, 'u-controleur', { decision: 'ACCEPTEE', reason: 'Vérifié sur pièces' });
    expect(first.json()).toMatchObject({ status: 'A_INSTRUIRE', firstReview: { by: 'u-controleur', toAmount: { amount: '250.00' } } });
    expect(env.app.ctx.assessment.get(ob.id).supersededBy).toBeUndefined();
    const same = await env.req('POST', `/v1/fiscal/declarations/${corr.id}/instruction`, 'u-controleur', { decision: 'ACCEPTEE', reason: 'Je confirme moi-même' });
    expect(same.json().code).toBe('SEPARATION_OF_DUTIES');
    const second = await env.req('POST', `/v1/fiscal/declarations/${corr.id}/instruction`, 'u-fiscal-chef-service', { decision: 'ACCEPTEE', reason: 'Contre-vérification sur place' });
    expect(second.json()).toMatchObject({ status: 'LIQUIDEE', instruction: { approvers: ['u-controleur', 'u-fiscal-chef-service'] } });
    expect(reductions(env).at(-1)).toMatchObject({ path: 'CORRECTION_DECLARATION', obligationId: ob.id, fromAmount: { amount: '1500.00' }, toAmount: { amount: '250.00' }, deciderId: 'u-fiscal-chef-service' });
  });
});

// ───────────────────────── 4. Exonérations et remises du registre ─────────────────────────
describe('Registre des exonérations : taux déclaré par la règle, base légale de la règle, quatre yeux, conflit d’intérêts', () => {
  const base = {
    kind: 'EXONERATION', objectId: DEMO.parcelId, ruleCode: DEMO.demoRuleCode, grounds: 'Usage d’intérêt général (test).',
    proofs: [{ type: 'ATTESTATION', reference: 'ATT-TEST-9' }], validFrom: '2026-09-26', validTo: '2027-12-31',
  };

  it('attaque : taux au choix du demandeur et base légale quelconque — refusés', async () => {
    const env = await setupAll();
    // Nouvelle version de la règle ne déclarant qu'un taux maximal de 30 %.
    await publishCertifiedRule(env, { code: DEMO.demoRuleCode, effectiveFrom: '2026-09-26', formula: 'forfait', rateTable: { 'forfait:1': '450', 'forfait:2': '150', 'forfait:3': '50', 'forfait:4': '10', taux_exoneration_max: '30' } });
    const tooHigh = await env.req('POST', '/v1/fiscal/exemptions', 'u-contribuable', { ...base, rate: '100' });
    expect(tooHigh.json().code).toBe('EXEMPTION_RATE_EXCEEDS_DECLARED');
    const otherBasis = await env.req('POST', '/v1/fiscal/exemptions', 'u-contribuable', { ...base, rate: '30', legalBasis: { instrumentId: 'const-2006-art204', article: 'Art. 204' } });
    expect(otherBasis.json().code).toBe('LEGAL_BASIS_NOT_RULE_BASIS');
    const noRate = await publishCertifiedRule(env, { code: 'TEST-SANS-TAUX' });
    expect(noRate.id).toBeTruthy();
    expect((await env.req('POST', '/v1/fiscal/exemptions', 'u-contribuable', { ...base, ruleCode: 'TEST-SANS-TAUX', rate: '10' })).json().code).toBe('EXEMPTION_RATE_NOT_DECLARED');
    expect((await env.req('POST', '/v1/fiscal/exemptions', 'u-contribuable', { ...base, rate: '30' })).statusCode).toBe(201);
  });

  it('attaque : instruction par l’initiateur ou par un agent lié — refusées ; remise au-delà du plafond déclaré refusée', async () => {
    const env = await setupAll();
    env.app.ctx.users.add({ id: 'guichet-lie', name: 'Guichet lié (test)', roles: ['R12'], entity: 'DGIPK', taxpayerId: DEMO.taxpayerId });
    const id = (await env.req('POST', '/v1/fiscal/exemptions', 'u-guichet', { ...base, taxpayerId: DEMO.taxpayerId, rate: '50', legalBasis: { instrumentId: 'demo-instrument-001', article: 'Art. 2' } })).json().id;
    expect((await env.req('POST', `/v1/fiscal/exemptions/${id}/instruction`, 'u-guichet', { decision: 'FAVORABLE', reason: 'Conforme' })).json().code).toBe('SEPARATION_OF_DUTIES');
    expect((await env.req('POST', `/v1/fiscal/exemptions/${id}/instruction`, 'guichet-lie', { decision: 'FAVORABLE', reason: 'Conforme' })).json().code).toBe('CONFLICT_OF_INTEREST');
    expect((await env.req('POST', `/v1/fiscal/exemptions/${id}/instruction`, 'u-controleur', { decision: 'FAVORABLE', reason: 'Conforme' })).json().status).toBe('INSTRUITE');
    // Remise : la règle (fictive) déclare 50 % au plus ; 100,00 sur 150,00 est refusé, 75,00 accepté.
    const obA = env.app.ctx.assessment.byTaxpayer('TP-FISC-DEMO-01')[0]!;
    expect(obA.amount.amount).toBe('150.00');
    const remise = { kind: 'REMISE', obligationId: obA.id, grounds: 'Sinistre (exemple fictif).', proofs: [{ type: 'PV', reference: 'PV-9' }], validFrom: '2026-09-26', legalBasis: { instrumentId: 'demo-instrument-001', article: 'Art. 5 (fictif)' } };
    expect((await env.req('POST', '/v1/fiscal/exemptions', 'u-guichet', { ...remise, amount: { amount: '100.00', currency: 'USD' } })).json().code).toBe('REMISE_EXCEEDS_DECLARED_CAP');
    const rid = (await env.req('POST', '/v1/fiscal/exemptions', 'u-guichet', { ...remise, amount: { amount: '75.00', currency: 'USD' } })).json().id;
    await env.req('POST', `/v1/fiscal/exemptions/${rid}/instruction`, 'u-controleur', { decision: 'FAVORABLE', reason: 'Conforme' });
    await env.req('POST', `/v1/fiscal/exemptions/${rid}/legal-visa`, 'u-juriste-verificateur', { decision: 'FAVORABLE', reason: 'Conforme' });
    const d = await env.req('POST', `/v1/fiscal/exemptions/${rid}/decision`, 'u-fiscal-directeur', { decision: 'APPROUVEE', reason: 'Sinistre constaté' });
    expect(d.json().status).toBe('APPROUVEE');
    expect(reductions(env).at(-1)).toMatchObject({ path: 'REMISE_REGISTRE', obligationId: obA.id, fromAmount: { amount: '150.00' }, toAmount: { amount: '75.00' }, deciderId: 'u-fiscal-directeur' });
  });
});

// ───────────────────────── 5. Rang de localité ─────────────────────────
describe('Rang de localité : provisoire à la déclaration, confirmé par une personne distincte, table certifiée prioritaire', () => {
  const rule = (env: Env) => env.app.ctx.rules.rules.find((r) => r.code === DEMO.demoRuleCode && r.status === 'ACTIVE')[0]!;
  const declare = (env: Env, rank: 1 | 2 | 3 | 4) => env.req('POST', '/v1/fiscal-objects', 'u-contribuable', {
    category: 'PARCELLE', commune: 'Limete', quartier: 'Kingabwa', localityRank: rank, lat: -4.372, lon: 15.346, attributes: { superficie_m2: '400' },
  });

  it('attaque : rang 4 déclaré ⇒ obligation marquée à réévaluer ; la validation confirme le rang 2 et rectifie à la hausse', async () => {
    const env = await setupAll();
    const obj = (await declare(env, 4)).json();
    expect(obj).toMatchObject({ localityRank: 4, rankStatus: 'PROVISOIRE' });
    const liq = await env.req('POST', '/v1/assessments/calculate', 'u-controleur', { ruleId: rule(env).id, taxpayerId: DEMO.taxpayerId, objectId: obj.id, inputs: {}, simulate: false });
    const ob = liq.json().obligation;
    expect(ob.amount.amount).toBe('10.00');
    expect(env.app.ctx.assessment.get(ob.id).reassessmentRequired).toMatchObject({ reason: 'RANG_PROVISOIRE', provisionalRank: 4 });
    // Le déclarant ne valide pas son propre rang.
    expect((await env.req('POST', `/v1/fiscal/objects/${obj.id}/validate`, 'u-contribuable')).statusCode).toBe(403);
    const v = await env.req('POST', `/v1/fiscal/objects/${obj.id}/validate`, 'u-fiscal-chef-service', { localityRank: 2, reason: 'Quartier de 2e rang (constat sur place).' });
    expect(v.statusCode).toBe(200);
    const after = env.app.ctx.objects.get(obj.id);
    expect(after).toMatchObject({ localityRank: 2, rankStatus: 'CONFIRME', rankConfirmedBy: 'u-fiscal-chef-service' });
    expect(after.history?.at(-1)).toMatchObject({ kind: 'RANG_CORRIGE', before: { localityRank: 4 }, after: { localityRank: 2 } });
    const original = env.app.ctx.assessment.get(ob.id);
    expect(original.status).toBe('ANNULEE');
    const re = env.app.ctx.assessment.get(original.supersededBy!);
    expect(re).toMatchObject({ amount: { amount: '150.00' }, explanation: { localityRank: 2, rectification: { decisionType: 'REEVALUATION' } } });
    expect(re.reassessmentRequired).toBeUndefined();
  });

  it('table certifiée : elle s’impose à la déclaration et à la validation', async () => {
    const env = await setupAll();
    loadCertifiedLocalityRanks([{ commune: 'Limete', quartier: 'Kingabwa', rank: 2, instrumentId: 'demo-instrument-001', article: 'Annexe (fictive)', certifiedAt: '2026-09-01' }]);
    const obj = (await declare(env, 4)).json();
    expect(obj).toMatchObject({ localityRank: 2, rankStatus: 'CONFIRME', rankSource: 'TABLE_CERTIFIEE' });
    const v = await env.req('POST', `/v1/fiscal/objects/${obj.id}/validate`, 'u-controleur', { localityRank: 4 });
    expect(v.json().code).toBe('LOCALITY_RANK_CERTIFIED_MISMATCH');
  });

  it('correction de rang ou de surface : quatre yeux, historique, réévaluation des obligations ouvertes', async () => {
    const env = await setupAll();
    const obj = (await declare(env, 2)).json();
    await env.req('POST', `/v1/fiscal/objects/${obj.id}/validate`, 'u-controleur');
    const ob = (await env.req('POST', '/v1/assessments/calculate', 'u-controleur', { ruleId: rule(env).id, taxpayerId: DEMO.taxpayerId, objectId: obj.id, inputs: {}, simulate: false })).json().obligation;
    expect(ob.amount.amount).toBe('150.00');
    // Un rang confirmé ne se change pas par une simple revalidation.
    expect((await env.req('POST', `/v1/fiscal/objects/${obj.id}/validate`, 'u-fiscal-chef-service', { localityRank: 4 })).json().code).toBe('RANK_ALREADY_CONFIRMED');
    const c = (await env.req('POST', `/v1/fiscal/objects/${obj.id}/corrections`, 'u-controleur', { localityRank: 3, reason: 'Reclassement du quartier constaté' })).json();
    expect(c.status).toBe('PROPOSEE');
    expect((await env.req('POST', `/v1/fiscal/object-corrections/${c.id}/decision`, 'u-controleur', { approve: true, reason: 'Auto-approbation interdite' })).statusCode).toBe(403);
    env.app.ctx.users.add({ id: 'chef-proposant', name: 'Chef qui propose (test)', roles: ['R07'], entity: 'DGIPK' });
    const c2 = await env.req('POST', `/v1/fiscal/object-corrections/${c.id}/decision`, 'u-fiscal-chef-service', { approve: true, reason: 'Contre-vérification cadastrale' });
    expect(c2.json()).toMatchObject({ status: 'APPLIQUEE', reassessed: [{ obligationId: ob.id, changed: true }] });
    expect(env.app.ctx.objects.get(obj.id).history?.at(-1)).toMatchObject({ kind: 'CORRECTION', by: ['u-controleur', 'u-fiscal-chef-service'], before: { localityRank: 2 }, after: { localityRank: 3 } });
    const re = env.app.ctx.assessment.get(env.app.ctx.assessment.get(ob.id).supersededBy!);
    expect(re.amount.amount).toBe('50.00');
    expect(reductions(env).at(-1)).toMatchObject({ path: 'CORRECTION_OBJET', obligationId: ob.id, fromAmount: { amount: '150.00' }, toAmount: { amount: '50.00' } });
    // Proposant et approbateur distincts, même au sein de la hiérarchie.
    const c3 = (await env.req('POST', `/v1/fiscal/objects/${obj.id}/corrections`, 'chef-proposant', { localityRank: 2, reason: 'Retour au rang initial demandé' })).json();
    expect((await env.req('POST', `/v1/fiscal/object-corrections/${c3.id}/decision`, 'chef-proposant', { approve: true, reason: 'Auto-approbation interdite' })).json().code).toBe('SEPARATION_OF_DUTIES');
  });

  it('file des corrections en attente (tous objets) et pièces justificatives conservées et visibles de l’approbateur', async () => {
    const env = await setupAll();
    const obj = (await declare(env, 2)).json();
    await env.req('POST', `/v1/fiscal/objects/${obj.id}/validate`, 'u-controleur');
    const sha = 'a'.repeat(64);
    const bad = await env.req('POST', `/v1/fiscal/objects/${obj.id}/corrections`, 'u-controleur', { localityRank: 3, reason: 'Reclassement du quartier constaté', evidence: [{ label: 'PV', sha256: 'xyz' }] });
    expect(bad.statusCode).toBe(400);
    const c = (await env.req('POST', `/v1/fiscal/objects/${obj.id}/corrections`, 'u-controleur', {
      localityRank: 3, reason: 'Reclassement du quartier constaté', evidence: [{ label: 'PV de constat n° 42', sha256: sha }, { label: 'Plan cadastral (référence)' }],
    })).json();
    expect(c.evidence).toEqual([{ label: 'PV de constat n° 42', sha256: sha }, { label: 'Plan cadastral (référence)' }]);
    const q = await env.req('GET', '/v1/fiscal/object-corrections?status=EN_ATTENTE', 'u-fiscal-chef-service');
    expect(q.statusCode).toBe(200);
    const mine = q.json().find((x: { id: string }) => x.id === c.id);
    expect(mine).toMatchObject({ status: 'PROPOSEE', evidence: [{ sha256: sha }, { label: 'Plan cadastral (référence)' }], object: { id: obj.id, commune: obj.commune } });
    expect((await env.req('GET', '/v1/fiscal/object-corrections?status=EN_ATTENTE', 'u-contribuable')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/fiscal/object-corrections?status=INCONNU', 'u-fiscal-chef-service')).statusCode).toBe(400);
    await env.req('POST', `/v1/fiscal/object-corrections/${c.id}/decision`, 'u-fiscal-chef-service', { approve: false, reason: 'Pièces insuffisantes pour reclasser' });
    expect((await env.req('GET', '/v1/fiscal/object-corrections?status=EN_ATTENTE', 'u-fiscal-chef-service')).json().some((x: { id: string }) => x.id === c.id)).toBe(false);
    expect((await env.req('GET', '/v1/fiscal/object-corrections?status=REJETEE', 'u-fiscal-chef-service')).json().some((x: { id: string }) => x.id === c.id)).toBe(true);
  });
});

// ───────────────────────── 6. Base de liquidation ─────────────────────────
describe('Base de liquidation : pré-remplie depuis l’objet ; saisie inférieure ⇒ motif + seconde approbation', () => {
  it('attaque : superficie saisie 100 au lieu de 600 — refusée ; dérogation motivée approuvée par une autre personne', async () => {
    const env = await setupAll();
    const { id: ruleId } = await publishCertifiedRule(env, { code: 'TEST-BASE' });
    const calc = (inputs: Record<string, string>, extra: Record<string, unknown> = {}) =>
      env.req('POST', '/v1/assessments/calculate', 'u-controleur', { ruleId, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs, simulate: false, ...extra });
    const low = await calc({ superficie_m2: '100' });
    expect(low.json()).toMatchObject({ code: 'BASE_OVERRIDE_REQUIRES_APPROVAL' });
    expect(env.app.ctx.audit.list({ action: 'assessment.base_override.refused' }).total).toBe(1);
    const req = (await env.req('POST', '/v1/assessments/base-overrides', 'u-controleur', { ruleId, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: { superficie_m2: '100' }, motive: 'Démolition partielle constatée le 20/09' })).json();
    expect(req).toMatchObject({ status: 'DEMANDEE', lowered: [{ field: 'superficie_m2', reference: '600', declared: '100' }] });
    expect((await env.req('POST', `/v1/assessments/base-overrides/${req.id}/decision`, 'u-controleur', { approve: true, reason: 'Auto-approbation interdite' })).statusCode).toBe(403);
    expect((await calc({ superficie_m2: '100' }, { baseOverrideId: req.id })).json().code).toBe('BASE_OVERRIDE_REQUIRES_APPROVAL');
    await env.req('POST', `/v1/assessments/base-overrides/${req.id}/decision`, 'u-dg-dgipk', { approve: true, reason: 'PV de démolition vérifié sur place' });
    const ok = await calc({ superficie_m2: '100' }, { baseOverrideId: req.id });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().trace.baseOverride).toMatchObject({ requestId: req.id, approvedBy: 'u-dg-dgipk' });
    expect(env.app.ctx.audit.list({ action: 'assessment.base_override' }).items.find((i) => i.action === 'assessment.base_override')?.details).toMatchObject({ requestedBy: 'u-controleur', approvedBy: 'u-dg-dgipk', motive: 'Démolition partielle constatée le 20/09' });
    expect(env.app.ctx.assessment.baseOverrides.get(req.id)!.status).toBe('UTILISEE');
  });

  it('tolérance de 5 % ; le dernier constat terrain prime sur l’attribut déclaré', async () => {
    const env = await setupAll();
    const a = await publishCertifiedRule(env, { code: 'TEST-TOL-A' });
    const b = await publishCertifiedRule(env, { code: 'TEST-TOL-B' });
    const calc = (ruleId: string, v: string) => env.req('POST', '/v1/assessments/calculate', 'u-controleur', { ruleId, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: { superficie_m2: v }, simulate: false });
    expect((await calc(a.id, '575')).statusCode).toBe(201); // −4,2 % : toléré
    const parcel = env.app.ctx.objects.get(DEMO.parcelId);
    env.app.ctx.objects.objects.update({ ...parcel, observed: { ...parcel.observed, superficie_m2: '800' } });
    const r = await calc(b.id, '600');
    expect(r.json()).toMatchObject({ code: 'BASE_OVERRIDE_REQUIRES_APPROVAL', lowered: [{ field: 'superficie_m2', reference: '800', referenceSource: 'CONSTAT' }] });
  });
});

// ───────────────────────── 7. Échéanciers abandonnés ─────────────────────────
describe('Échéancier abandonné : défaillance proposée automatiquement, retard constaté, encours à risque', () => {
  it('attaque : échéancier accordé puis jamais payé — la dette n’est plus gelée', async () => {
    const env = await setupAll();
    const obl = demoObligation(env);
    const plan = (await env.req('POST', '/v1/recouvrement/echeanciers', 'u-contribuable', { obligationId: obl, installments: 2, reason: 'Revenus irréguliers ce trimestre' })).json();
    const dec = (await env.req('POST', `/v1/recouvrement/echeanciers/${plan.id}/decision`, 'u-decideur', { granted: true, motivation: 'Difficulté réelle, échéancier proportionné' })).json();
    expect(dec.installments.map((i: { dueDate: string }) => i.dueDate)).toEqual(['2026-10-26', '2026-11-25']);
    // Première échéance impayée au-delà du délai de grâce (10 jours).
    env.clock.set('2026-11-06T09:00:00Z');
    const run = (await env.req('POST', '/v1/recouvrement/planification', 'u-contentieux')).json();
    expect(run.defaultsProposed).toBe(1);
    expect((await env.req('POST', '/v1/recouvrement/planification', 'u-contentieux')).json().defaultsProposed).toBe(0);
    expect(env.app.ctx.audit.list({ action: 'installment_plan.default.proposed' }).total).toBe(1);
    expect(env.rec.plans.get(plan.id)!.defaultProposal).toMatchObject({ overdueSeqs: [1] });
    const alerted = env.app.ctx.comms.deliveries.find((d) => d.eventCode === 'approval.requested').map((d) => d.recipientId);
    expect(alerted).toEqual(expect.arrayContaining(['u-contentieux', 'u-decideur']));
    // Un échéancier non respecté ne bloque plus les mesures ; il pèse dans l'encours à risque.
    expect(env.rec.measureBlockers(env.app.ctx.assessment.get(obl)).map((b) => b.code)).not.toContain('INSTALLMENT_PLAN_ACTIVE');
    const ind = (await env.req('GET', '/v1/recouvrement/indicateurs', 'u-auditeur')).json();
    expect(ind.plans).toMatchObject({ defaultProposed: 1, atRisk: { count: 1, amount: { USD: '150.00' } } });
    expect(env.app.ctx.assessment.get(obl).status).toBe('EMISE');
    // Dernière échéance dépassée : l'obligation est constatée EN_RETARD.
    env.clock.set('2026-11-26T09:00:00Z');
    await env.req('POST', '/v1/recouvrement/planification', 'u-contentieux');
    expect(env.app.ctx.assessment.get(obl).status).toBe('EN_RETARD');
    // La défaillance reste constatée par une personne.
    expect(env.rec.plans.get(plan.id)!.status).toBe('ACCORDE');
  });
});
