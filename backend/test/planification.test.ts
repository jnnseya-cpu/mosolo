import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { sha256Hex } from '../src/core/crypto.js';
import { scenarios as exampleScenarios } from '../src/modules/dashboards/example-data.js';
import { iaModelesPlugin } from '../src/plugins/ia/modeles.js';
import { iaPlugin } from '../src/plugins/ia/plugin.js';
import { CIRCUITS, reconstruct } from '../src/plugins/integrite/gouvernance/circuits.js';
import { ALL_PARAMETERS } from '../src/plugins/integrite/gouvernance/parametres.js';
import { partageLegalPlugin } from '../src/plugins/pilotage/partage-legal/plugin.js';
import { planificationPlugin } from '../src/plugins/pilotage/planification/plugin.js';
import { parseEntriesCsv, selectEntries } from '../src/plugins/pilotage/planification/model.js';
import { pilotagePlugin } from '../src/plugins/pilotage/plugin.js';
import { DEMO } from '../src/seed.js';
import { callbackHeaders, publishCertifiedRule } from './helpers.js';

const SECRET = 'test-secret-mm-operator-a';

async function setup(plugins = [pilotagePlugin, planificationPlugin, partageLegalPlugin, iaPlugin, iaModelesPlugin]) {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': SECRET }, commsProviderKeys: {} }, plugins });
  await app.ready();
  const req = (method: string, url: string, user?: string, body?: unknown) => app.inject({
    method: method as 'GET', url,
    headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { app, clock, req, ctx: app.ctx };
}
type Env = Awaited<ReturnType<typeof setup>>;

async function payAndReconcile(env: Env, obligationId: string) {
  const order = (await env.app.inject({
    method: 'POST', url: `/v1/obligations/${obligationId}/payment-orders`, payload: JSON.stringify({ channel: 'MOBILE_MONEY' }),
    headers: { 'x-demo-user': 'u-guichet', 'content-type': 'application/json', 'idempotency-key': randomUUID() },
  })).json();
  const raw = JSON.stringify({ providerTxnId: `TXN-${randomUUID()}`, paymentReference: order.paymentReference, amount: order.amount, status: 'SUCCESS', completedAt: env.clock.now().toISOString() });
  const cb = await env.app.inject({ method: 'POST', url: '/v1/providers/mm-operator-a/callbacks', payload: raw, headers: { 'content-type': 'application/json', ...callbackHeaders(SECRET, raw, env.clock.now()) } });
  expect(cb.json().status).toBe('CONFIRME');
  const st = await env.req('POST', '/v1/settlements/statements', 'u-tresor', {
    statementId: `REL-${randomUUID()}`, lines: [{ accountAlias: DEMO.dgipkAlias, amount: order.amount, valueDate: env.clock.now().toISOString().slice(0, 10), paymentReference: order.paymentReference }],
  });
  expect(st.statusCode).toBe(201);
  return order as { paymentReference: string; amount: { amount: string; currency: string } };
}

const kpi = async (env: Env, code: string, user = 'u-gouverneur') => ((await env.req('GET', '/v1/pilotage/indicateurs', user)).json().kpis as { code: string; status: string; value: string | null; measurable: boolean; detail?: string }[]).find((k) => k.code === code)!;

const CSV = [
  'metrique;recette;commune;canal;valeur;devise',
  'ENCAISSEMENTS;*;*;*;3650.00;USD',
  'OBJETS_CONNUS;IMPOT_PROVINCIAL;*;*;1;',
  'COUT_COLLECTE;*;*;*;365.00;USD',
].join('\n');

describe('Base de référence auditée et RANV (§ 38.1–38.2)', () => {
  it('RANV « non mesurée » sans base certifiée ; import, certification à deux personnes, puis RANV calculée et ventilée', async () => {
    const env = await setup();
    expect((await kpi(env, 'RANV'))).toMatchObject({ status: 'NON_MESURE', measurable: false, value: null });
    const ob = env.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    await payAndReconcile(env, ob.id);

    const imp = await env.req('POST', '/v1/pilotage/base-reference', 'u-ministre-finances', { kind: 'BASE_REFERENCE', label: 'Base 2025 (test, fictive)', period: '2025', source: { document: 'Rapport d’audit (fictif)', reference: 'AUD-2025-01' }, csv: CSV });
    expect(imp.statusCode).toBe(201);
    const set = imp.json();
    expect(set).toMatchObject({ status: 'IMPORTEE', from: '2025-01-01', to: '2025-12-31' });
    expect(set.entries).toHaveLength(3);
    // Import seul : RANV toujours non mesurée.
    expect((await kpi(env, 'RANV')).status).toBe('NON_MESURE');
    // Quatre yeux : la personne qui importe ne certifie pas.
    const self = await env.req('POST', `/v1/pilotage/base-reference/${set.id}/certification`, 'u-ministre-finances', { approve: true, motif: 'Certification par moi-même (refusée)' });
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe('SEPARATION_OF_DUTIES');
    const bad = await env.req('POST', `/v1/pilotage/base-reference/${set.id}/certification`, 'u-tresor', { approve: true, motif: 'Rôle non habilité à certifier' });
    expect(bad.statusCode).toBe(403);
    const ok = await env.req('POST', `/v1/pilotage/base-reference/${set.id}/certification`, 'u-auditeur', { approve: true, motif: 'Base rapprochée des comptes 2025 (audit fictif)' });
    expect(ok.json().status).toBe('CERTIFIEE');

    const r = (await env.req('GET', '/v1/pilotage/ranv', 'u-gouverneur')).json();
    expect(r.certified).toBe(true);
    expect(r.period).toEqual({ from: '2026-01-01', to: '2026-09-26' });
    const comp = (c: string) => r.components.find((x: { code: string }) => x.code === c);
    // Objet recensé après la base ⇒ recette nouvelle ; base 3 650 USD sur 365 j ramenée à 269 j = 2 690 USD.
    expect(comp('ASSIETTE_SUPPLEMENTAIRE').amounts).toEqual([{ amount: '150.00', currency: 'USD' }]);
    expect(comp('GAINS_CONFORMITE').amounts).toEqual([{ amount: '-2690.00', currency: 'USD' }]);
    expect(comp('DEPERDITION_EVITEE').measured).toBe(false);
    expect(comp('COUTS_ADDITIONNELS').measured).toBe(false);
    expect(r.ranv).toEqual([{ amount: '-2540.00', currency: 'USD' }]);
    expect(r.partial).toBe(true);
    // § 8.7 : ventilation par origine, somme = rapproché.
    expect(r.origins.rows.map((x: { origin: string }) => x.origin)).toEqual(['RECLASSEMENT', 'RAPPROCHEMENT', 'ARRIERES', 'NOUVELLE', 'COURANTE']);
    expect(r.origins.total.amounts).toEqual([{ amount: '150.00', currency: 'USD' }]);
    expect(r.origins.reference.source).toBe('BASE_CERTIFIEE');
    const k = await kpi(env, 'RANV');
    expect(k).toMatchObject({ status: 'SANS_CIBLE', measurable: true, value: '-94.4' });
    // Échelle et tableaux : ventilation toujours présente.
    const ladder = (await env.req('GET', '/v1/pilotage/echelle', 'u-gouverneur')).json();
    expect(ladder.origins.rows).toHaveLength(5);

    // Relevé de coûts certifié ⇒ coût de collecte mesuré ; circuits de gouvernance reconstitués.
    const cost = (await env.req('POST', '/v1/pilotage/base-reference', 'u-validateur-financier', { kind: 'COUTS_CONSTATES', label: 'Coûts 2026-T3', period: '2026-T3', source: { document: 'Comptabilité (fictif)', reference: 'CPT-T3' }, entries: [{ metric: 'COUT_COLLECTE', value: '15.00', currency: 'USD' }] })).json();
    await env.req('POST', `/v1/pilotage/base-reference/${cost.id}/certification`, 'u-auditeur', { approve: true, motif: 'Relevé de coûts vérifié (fictif)' });
    expect((await kpi(env, 'COUT_COLLECTE'))).toMatchObject({ measurable: true, value: '10.0' });
    const d = reconstruct(env.ctx.audit.list({ limit: 1_000_000 }).items).decisions.filter((x) => x.circuit === 'PILOTAGE_BASE_REFERENCE');
    expect(d).toHaveLength(2);
    expect(d[0]).toMatchObject({ proposerId: 'u-ministre-finances', approverId: 'u-auditeur', outcome: 'APPROUVE' });
    expect(CIRCUITS.map((c) => c.code)).toEqual(expect.arrayContaining(['PILOTAGE_BASE_REFERENCE', 'PILOTAGE_ASSIGNATIONS', 'IA_MODELE_MISE_EN_SERVICE']));
  });

  it('import : rubriques du § 38.1 seulement, devise pour les montants, sélection par périmètre sans extrapolation', () => {
    const e = parseEntriesCsv(CSV);
    expect(e[0]).toMatchObject({ metric: 'ENCAISSEMENTS', revenue: '*', value: '3650.00', currency: 'USD' });
    expect(selectEntries([{ metric: 'ENCAISSEMENTS', revenue: '*', commune: 'Gombe', channel: '*', value: '1', currency: 'USD' }, { metric: 'ENCAISSEMENTS', revenue: '*', commune: 'Limete', channel: '*', value: '2', currency: 'USD' }], 'ENCAISSEMENTS', {})).toHaveLength(2);
    expect(selectEntries([{ metric: 'ENCAISSEMENTS', revenue: '*', commune: '*', channel: '*', value: '3', currency: 'USD' }, { metric: 'ENCAISSEMENTS', revenue: '*', commune: 'Limete', channel: '*', value: '2', currency: 'USD' }], 'ENCAISSEMENTS', {})).toHaveLength(1);
  });

  it('refus : rubrique inconnue, montant sans devise, relevé de coûts hors coûts', async () => {
    const env = await setup([pilotagePlugin, planificationPlugin]);
    const src = { document: 'x (fictif)', reference: 'REF' };
    expect((await env.req('POST', '/v1/pilotage/base-reference', 'u-ministre-finances', { kind: 'BASE_REFERENCE', label: 'Base', period: '2025', source: src, entries: [{ metric: 'INVENTE', value: '1' }] })).json().code).toBe('UNKNOWN_METRIC');
    expect((await env.req('POST', '/v1/pilotage/base-reference', 'u-ministre-finances', { kind: 'BASE_REFERENCE', label: 'Base', period: '2025', source: src, entries: [{ metric: 'ENCAISSEMENTS', value: '1' }] })).json().code).toBe('CURRENCY_REQUIRED');
    expect((await env.req('POST', '/v1/pilotage/base-reference', 'u-ministre-finances', { kind: 'COUTS_CONSTATES', label: 'Coûts', period: '2025', source: src, entries: [{ metric: 'ENCAISSEMENTS', value: '1', currency: 'USD' }] })).json().code).toBe('INVALID_COST_SET');
  });
});

describe('Pilote de 180 jours vs communes témoins (§ 45.3–45.5)', () => {
  it('critères du § 45.3 par groupe ; revues signées aux jalons, vérifiables, immuables', async () => {
    const env = await setup([pilotagePlugin, planificationPlugin]);
    let b = (await env.req('GET', '/v1/pilotage/pilote', 'u-gouverneur')).json();
    expect(b.config.communes).toEqual(['Gombe', 'Limete', 'Kalamu', 'Ngaliema']);
    expect(b.milestones.map((m: { milestone: string }) => m.milestone)).toEqual(['J30', 'J60', 'J90', 'J120', 'J150', 'J180']);
    expect((await env.req('POST', '/v1/pilotage/pilote/revues/J30', 'u-auditeur')).json().code).toBe('PILOT_NOT_STARTED');
    expect((await env.req('POST', '/v1/pilotage/pilote/configuration', 'u-ministre-finances', { startDate: '2026-09-01', controls: ['Gombe'], motif: 'Témoin invalide (commune pilote)' })).json().code).toBe('CONTROL_IS_PILOT');
    const cfg = await env.req('POST', '/v1/pilotage/pilote/configuration', 'u-ministre-finances', { startDate: '2026-09-01', controls: ['Masina', 'Lemba'], motif: 'Protocole d’évaluation : témoins désignés' });
    expect(cfg.statusCode).toBe(200);
    const ob = env.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    await payAndReconcile(env, ob.id); // Limete (pilote)
    b = (await env.req('GET', '/v1/pilotage/pilote', 'u-gouverneur')).json();
    const c = (code: string) => b.criteria.find((x: { code: string }) => x.code === code);
    expect(c('PART_ELECTRONIQUE').pilot).toMatchObject({ value: '100.0', met: true });
    expect(c('ESPECES_AGENTS').pilot).toMatchObject({ value: '0', met: true });
    expect(c('COUVERTURE_OBJETS').status).toBe('NON_MESURE');
    expect(c('PROGRESSION_RECETTES').status).toBe('NON_MESURE'); // sans base certifiée
    expect((await env.req('POST', '/v1/pilotage/pilote/revues/J60', 'u-auditeur')).json().code).toBe('MILESTONE_NOT_REACHED');
    env.clock.advance(6 * 86_400_000); // 2026-10-02 ≥ J30 (2026-10-01)
    const sig = await env.req('POST', '/v1/pilotage/pilote/revues/J30', 'u-auditeur');
    expect(sig.statusCode).toBe(201);
    const s = sig.json();
    const v = (await env.req('POST', '/v1/pilotage/exports/verify', undefined, { payload: s.payload, sha256: s.sha256, signature: s.signature })).json();
    expect(v).toMatchObject({ valid: true, registered: { kind: 'pilote' } });
    expect((await env.req('POST', '/v1/pilotage/pilote/revues/J30', 'u-auditeur')).json().code).toBe('ALREADY_SIGNED');
    expect((await env.req('POST', '/v1/pilotage/pilote/revues/J30', 'u-tresor')).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/pilotage/pilote/configuration', 'u-ministre-finances', { startDate: '2026-08-01', controls: ['Masina'], motif: 'Changement de date après revue' })).json().code).toBe('PILOT_STARTED');
  });
});

describe('Simulateur de scénarios sur la base réelle (§ 38.3–38.4)', () => {
  it('prudent = conservateur, transformationnel = ambitieux ; hypothèses datées et sourcées ; sensibilité ; exemples marqués', async () => {
    const env = await setup([pilotagePlugin, planificationPlugin]);
    let s = (await env.req('GET', '/v1/pilotage/scenarios', 'u-gouverneur')).json();
    expect(s.equivalence).toEqual({ PRUDENT: 'conservateur', TRANSFORMATIONNEL: 'ambitieux' });
    expect(s.scenarios.map((x: { code: string }) => x.code)).toEqual(['PRUDENT', 'ATTENDU', 'TRANSFORMATIONNEL']);
    expect(s.nonContractual).toBe(true);
    expect(s.scenarios[1].complete).toBe(false);
    expect(s.scenarios[1].missing.length).toBeGreaterThan(0);
    // Au 31/12, l'obligation de démonstration (150 USD) est échue et impayée : conformité observée 0 %.
    env.clock.set('2026-12-31T09:00:00.000Z');
    const h = await env.req('POST', '/v1/pilotage/scenarios/hypotheses', 'u-ministre-finances', { scenario: 'ATTENDU', variable: 'TAUX_CONFORMITE_CIBLE', revenue: '*', value: '50', source: 'Hypothèse de travail (fictive) — test', sourceDate: '2026-09-01' });
    expect(h.statusCode).toBe(201);
    expect((await env.req('POST', '/v1/pilotage/scenarios/hypotheses', 'u-tresor', { scenario: 'ATTENDU', variable: 'TAUX_CHANGE', revenue: '*', value: '2800', source: 'x (fictif)', sourceDate: '2026-09-01' })).statusCode).toBe(403);
    s = (await env.req('GET', '/v1/pilotage/scenarios', 'u-gouverneur')).json();
    const att = s.scenarios.find((x: { code: string }) => x.code === 'ATTENDU');
    expect(att.lines[0]).toMatchObject({ available: true, currentCompliance: '0.0', targetCompliance: '50', additionalGross: [{ amount: '75.00', currency: 'USD' }] });
    expect(att.hypotheses[0]).toMatchObject({ source: 'Hypothèse de travail (fictive) — test', sourceDate: '2026-09-01' });
    expect(att.sensitivity).toHaveProperty('compliancePlusOnePointCdf');
    expect(att.sensitivity).toHaveProperty('exchangeRatePlusOnePctCdf');
    expect(att.sensitivity).toHaveProperty('protocolDelayPlusOneMonthCdf');
    // Simulation ad hoc (non enregistrée).
    const adhoc = (await env.req('POST', '/v1/pilotage/scenarios/simulation', 'u-gouverneur', { hypotheses: [{ scenario: 'PRUDENT', variable: 'DELAI_PROTOCOLES_MOIS', revenue: '*', value: '6', source: 'Test (fictif)', sourceDate: '2026-09-01' }] })).json();
    expect(adhoc.scenarios[0]).toMatchObject({ protocolDelayMonths: 6, protocolDelaySource: 'HYPOTHESE' });
    // Scénarios d'exemple du tableau du Gouverneur : conservés et marqués [EXEMPLE].
    const ex = exampleScenarios();
    expect(ex.map((x) => x.code)).toEqual(['conservateur', 'attendu', 'ambitieux']);
    expect(ex.every((x) => x.example && x.label.includes('[EXEMPLE]'))).toBe(true);
    expect(ex.map((x) => x.cahierCode)).toEqual(['PRUDENT', 'ATTENDU', 'TRANSFORMATIONNEL']);
  });
});

describe('Assignations, instructions, accords de service, satisfaction, disponibilité (§ 26, § 10A.3, § 39)', () => {
  it('assignations certifiées à deux personnes et carte des écarts ; indicateur de réalisation mesuré', async () => {
    const env = await setup([pilotagePlugin, planificationPlugin]);
    expect((await kpi(env, 'ECART_ASSIGNATION')).status).toBe('NON_MESURE');
    const ob = env.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    await payAndReconcile(env, ob.id);
    const t = (await env.req('POST', '/v1/pilotage/assignations', 'u-validateur-financier', {
      fiscalYear: '2026', label: 'Assignations 2026 (fictives)', act: { reference: 'CONTRAT-PERF-2026 (fictif)', title: 'Contrat de performance (fictif)' },
      entries: [{ commune: 'Limete', category: 'IMPOT_PROVINCIAL', amount: { amount: '600.00', currency: 'USD' } }, { commune: 'Gombe', category: '*', amount: { amount: '100.00', currency: 'USD' } }],
    })).json();
    expect(t.status).toBe('IMPORTEE');
    expect((await env.req('GET', '/v1/pilotage/assignations/ecarts', 'u-gouverneur')).json().certified).toBe(false);
    await env.req('POST', `/v1/pilotage/assignations/${t.id}/certification`, 'u-ministre-finances', { approve: true, motif: 'Assignations conformes au budget voté (fictif)' });
    const g = (await env.req('GET', '/v1/pilotage/assignations/ecarts?annee=2026', 'u-gouverneur')).json();
    expect(g.certified).toBe(true);
    expect(g.rows.find((r: { commune: string }) => r.commune === 'Limete')).toMatchObject({ realised: { amount: '150.00', currency: 'USD' }, gap: { amount: '450.00', currency: 'USD' }, ratePct: '25.0' });
    expect(g.totals.ratePct).toBe('21.4');
    expect((await kpi(env, 'ECART_ASSIGNATION'))).toMatchObject({ measurable: true, value: '21.4' });
  });

  it('instruction du Gouverneur : service désigné, échéance, rapport, clôture par l’autorité ; suivi au tableau du cabinet', async () => {
    const env = await setup([pilotagePlugin, planificationPlugin]);
    const i = await env.req('POST', '/v1/pilotage/instructions', 'u-gouverneur', { origin: 'COMMUNE', subject: 'Baisse des recettes à Limete', body: 'Expliquer la baisse et proposer un plan d’action.', assignee: { entity: 'DGIPK', role: 'R06' }, deadline: '2026-10-10' });
    expect(i.statusCode).toBe(201);
    const id = i.json().id;
    expect((await env.req('POST', '/v1/pilotage/instructions', 'u-dg-dgipk', { origin: 'AUTRE', subject: 'Sujet test', body: 'Émise par un non-émetteur.', assignee: { entity: 'DGIPK' }, deadline: '2026-10-10' })).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/pilotage/instructions', 'u-tresor')).json().items).toHaveLength(0);
    expect((await env.req('POST', `/v1/pilotage/instructions/${id}/accuse`, 'u-tresor')).statusCode).toBe(404);
    expect((await env.req('POST', `/v1/pilotage/instructions/${id}/accuse`, 'u-dg-dgipk')).json().status).toBe('ACCUSEE');
    expect((await env.req('POST', `/v1/pilotage/instructions/${id}/cloture`, 'u-dircab', { motif: 'Clôture sans rapport (refusée)' })).json().code).toBe('REPORT_REQUIRED');
    expect((await env.req('POST', `/v1/pilotage/instructions/${id}/rapport`, 'u-dg-dgipk', { text: 'Plan d’action déposé : campagne ciblée.', evidenceSha256: sha256Hex('plan') })).json().status).toBe('RAPPORT_DEPOSE');
    const closed = (await env.req('POST', `/v1/pilotage/instructions/${id}/cloture`, 'u-dircab', { motif: 'Rapport satisfaisant, instruction close.' })).json();
    expect(closed).toMatchObject({ status: 'CLOSE', closure: { onTime: true } });
    expect((await kpi(env, 'INSTRUCTIONS_DELAIS'))).toMatchObject({ measurable: true, value: '100.0' });
    const cab = (await env.req('GET', '/v1/pilotage/tableaux/cabinet', 'u-dircab')).json();
    expect(cab.instructions.closedOnTime).toBe(1);
    expect((await env.req('GET', '/v1/pilotage/tableaux/cabinet', 'u-tresor')).statusCode).toBe(403);
  });

  it('accords de service entre entités, satisfaction, disponibilité, rattachement et couverture SIG', async () => {
    const env = await setup([pilotagePlugin, planificationPlugin]);
    expect((await kpi(env, 'ACCORDS_SERVICE')).status).toBe('NON_MESURE');
    expect((await kpi(env, 'SATISFACTION')).status).toBe('NON_MESURE');
    expect((await kpi(env, 'DISPONIBILITE')).status).toBe('NON_MESURE');
    expect((await kpi(env, 'COUVERTURE_SIG'))).toMatchObject({ measurable: true, value: '100.0' });
    expect((await kpi(env, 'TAUX_RATTACHEMENT')).measurable).toBe(true);
    expect((await kpi(env, 'DEPOT_A_TEMPS')).status).toBe('NON_MESURE');
    expect((await kpi(env, 'ARRIERES_RECOUVRES'))).toMatchObject({ value: '0' });
    const a = (await env.req('POST', '/v1/pilotage/accords-service', 'u-ministre-finances', { fromEntity: 'DGIPK', toEntity: 'TRESOR', kind: 'VERIFICATION', delayHours: 48, act: { reference: 'CONV-2026-01 (fictive)', title: 'Convention de service (fictive)' } })).json();
    const r = (await env.req('POST', `/v1/pilotage/accords-service/${a.id}/demandes`, 'u-dg-dgipk', { reference: 'VERIF-001' })).json();
    expect((await env.req('POST', `/v1/pilotage/accords-service/demandes/${r.id}/cloture`, 'u-dg-dgipk')).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/pilotage/accords-service/demandes/${r.id}/cloture`, 'u-tresor')).json().onTime).toBe(true);
    expect((await kpi(env, 'ACCORDS_SERVICE'))).toMatchObject({ measurable: true, value: '100.0' });
    expect((await env.req('POST', '/v1/satisfaction', 'u-gouverneur', { moment: 'APRES_PAIEMENT', note: 5 })).statusCode).toBe(403);
    await env.req('POST', '/v1/satisfaction', 'u-contribuable', { moment: 'APRES_PAIEMENT', note: 4, receiptNumber: 'Q-1' });
    expect((await env.req('POST', '/v1/satisfaction', 'u-contribuable', { moment: 'APRES_PAIEMENT', note: 1, receiptNumber: 'Q-1' })).json().code).toBe('ALREADY_ANSWERED');
    await env.req('POST', '/v1/satisfaction', 'u-locataire', { moment: 'APRES_VISITE', note: 5 });
    expect((await kpi(env, 'SATISFACTION'))).toMatchObject({ measurable: true, value: '4.5', status: 'ATTEINTE' });
    expect((await env.req('GET', '/v1/pilotage/satisfaction', 'u-gouverneur')).json().afterPayment.masked).toBe(true);
    await env.req('POST', '/v1/pilotage/disponibilite/sondes', 'u-superadmin', { target: 'api', ok: true });
    await env.req('POST', '/v1/pilotage/disponibilite/sondes', 'u-superadmin', { target: 'api', ok: false });
    expect((await kpi(env, 'DISPONIBILITE'))).toMatchObject({ measurable: true, value: '50.0' });
  });

  it('tableaux du § 26.2 : secrétaire général, juristes, superviseurs, chefs de service', async () => {
    const env = await setup([pilotagePlugin, planificationPlugin]);
    env.ctx.users.add({ id: 't-sg', name: 'SG (test)', roles: ['R03'], entity: 'GOUVERNORAT' });
    env.ctx.users.add({ id: 't-chef', name: 'Chef de service (test)', roles: ['R07'], entity: 'DGIPK' });
    const list = (await env.req('GET', '/v1/pilotage/tableaux', 't-sg')).json().profiles.map((p: { code: string }) => p.code);
    expect(list).toContain('sg');
    const sg = (await env.req('GET', '/v1/pilotage/tableaux/sg', 't-sg')).json();
    expect(sg.decisions).toHaveProperty('rows');
    const jur = (await env.req('GET', '/v1/pilotage/tableaux/juridique', 'u-juriste-verificateur')).json();
    expect(jur.rules.total).toBeGreaterThan(0);
    expect(jur.rules.byStatus.some((x: { status: string }) => x.status === 'A_VERIFIER')).toBe(true);
    const sup = (await env.req('GET', '/v1/pilotage/tableaux/superviseur', 'u-superviseur')).json();
    expect(sup.field.available).toBe(false);
    expect(sup.scope.kind).toBe('TERRITOIRE');
    const chef = (await env.req('GET', '/v1/pilotage/tableaux/chef-service', 't-chef')).json();
    expect(chef.scope).toMatchObject({ kind: 'ENTITE', entity: 'DGIPK' });
    expect(chef.kpis.map((k: { code: string }) => k.code)).toContain('CONVERSION_AVIS_PAIEMENT');
    expect((await env.req('GET', '/v1/pilotage/tableaux/juridique', 'u-tresor')).statusCode).toBe(403);
  });
});

describe('Projets publics et emploi des fonds (§ 27.2–27.3)', () => {
  it('l’IA propose des scénarios classés ; l’autorité décide ; financement sur acte ; publication trimestrielle sans donnée personnelle', async () => {
    const env = await setup([pilotagePlugin, planificationPlugin]);
    const ob = env.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    await payAndReconcile(env, ob.id);
    const p = await env.req('POST', '/v1/pilotage/projets', 'u-ministre-finances', {
      code: 'LIM-ECL-01', title: 'Éclairage public avenue test (fictif)', domain: 'ECLAIRAGE', communes: ['Limete'], beneficiaries: 'Riverains et usagers de l’avenue',
      expectedResult: 'Avenue éclairée la nuit', maturity: 'PRET_A_LANCER', cost: { amount: '100.00', currency: 'USD' }, recurringCost: { amount: '5.00', currency: 'USD' },
      procurement: 'APPEL_OFFRES_OUVERT', risks: 'Retard de passation', approvalAuthority: 'Ministre provincial des Finances', legalFundSource: 'Budget provincial voté 2026 (fictif)',
    });
    expect(p.statusCode).toBe(201);
    const rec = await env.req('POST', '/v1/pilotage/projets/recommandations', 'u-ministre-finances', { period: '2026-T3', currency: 'USD', legalFundSource: 'Recettes propres rapprochées (fictif)' });
    expect(rec.statusCode).toBe(201);
    const batch = rec.json();
    expect(batch.scenarios).toHaveLength(3);
    const sc = batch.scenarios.find((x: { items: { code: string }[] }) => x.items.some((i) => i.code === 'LIM-ECL-01'));
    expect(sc).toMatchObject({ status: 'PROPOSE', proposedBy: { kind: 'ai', agent: 'ALLOCATION' }, available: { amount: '150.00', currency: 'USD' } });
    const item = sc.items.find((i: { code: string }) => i.code === 'LIM-ECL-01');
    for (const f of ['beneficiaries', 'communes', 'expectedResult', 'maturity', 'recurringCost', 'procurement', 'risks', 'approvalAuthority', 'legalFundSource', 'proposedAmount']) expect(item).toHaveProperty(f);
    const aiAudit = env.ctx.audit.list({ action: 'pilotage.fund_scenario.proposed', limit: 10 }).items[0]!;
    expect(aiAudit.actor.kind).toBe('ai');
    expect((await env.req('POST', `/v1/pilotage/projets/scenarios/${sc.id}/decision`, 'u-tresor', { retain: true, motif: 'Non habilité à décider' })).statusCode).toBe(403);
    const dec = (await env.req('POST', `/v1/pilotage/projets/scenarios/${sc.id}/decision`, 'u-gouverneur', { retain: true, motif: 'Scénario retenu par l’autorité (test)' })).json();
    expect(dec.status).toBe('RETENU');
    const pid = p.json().id;
    const fund = (await env.req('POST', `/v1/pilotage/projets/${pid}/financement`, 'u-ministre-finances', { decisionReference: 'ARR-BUDG-2026-07 (fictif)', amount: { amount: '100.00', currency: 'USD' }, motif: 'Crédits ouverts par arrêté (fictif)' })).json();
    expect(fund.status).toBe('FINANCE');
    await env.req('POST', `/v1/pilotage/projets/${pid}/avancement`, 'u-dg-dgipk', { progressPct: '40', note: 'Pose des candélabres' });
    const prev = (await env.req('GET', '/v1/pilotage/transparence/2026-T3', 'u-ministre-finances')).json();
    expect(prev.content.fundedProjects.byCommune[0]).toMatchObject({ commune: 'Limete', projects: [{ code: 'LIM-ECL-01', status: 'EN_COURS', progressPct: '40' }] });
    expect(JSON.stringify(prev.content.fundedProjects)).not.toMatch(/taxpayer|Mbuyi|obligationId/);
  });
});

describe('Registre des modèles d’IA (§ 23.1)', () => {
  it('modèles en service déclarés ; jeux approuvés par le DPO ; mise en service à deux personnes ; retour arrière ; suivi calculé', async () => {
    const env = await setup([pilotagePlugin, iaPlugin, iaModelesPlugin]);
    const v = (await env.req('GET', '/v1/ia/modeles', 'ia-gestionnaire-modeles')).json();
    expect(v.models.map((m: { code: string }) => m.code)).toEqual(expect.arrayContaining(['AGENTS-METIER', 'ASSISTANT-SOCLE']));
    expect(v.monitoring.params.status).toMatch(/PAR_DEFAUT/);
    expect((await env.req('GET', '/v1/ia/modeles', 'u-tresor')).statusCode).toBe(403);
    const ds = (await env.req('POST', '/v1/ia/jeux-donnees', 'ia-gestionnaire-modeles', { code: 'JEU-TEST-01', label: 'Décisions validées (test)', source: 'Journal IA', legalBasis: 'Mission de service public (à confirmer)', periodFrom: '2026-01-01', periodTo: '2026-06-30', sha256: sha256Hex('jeu'), minimisation: 'Pseudonymisé', sensitive: false })).json();
    const ver = (await env.req('POST', '/v1/ia/modeles/AGENTS-METIER/versions', 'ia-gestionnaire-modeles', { version: 'regles-deterministes-ia-2.1', datasetIds: [ds.id], explainability: 'Facteurs affichés' })).json();
    expect((await env.req('POST', `/v1/ia/modeles/versions/${ver.id}/mise-en-service`, 'ia-gestionnaire-modeles', { motif: 'Mise en service demandée (prérequis manquants)' })).json().code).toBe('PROMOTION_PREREQUISITES');
    expect((await env.req('POST', `/v1/ia/jeux-donnees/${ds.id}/decision`, 'ia-dpo', { approve: true, motif: 'Jeu conforme, minimisé' })).json().status).toBe('APPROUVE');
    await env.req('POST', `/v1/ia/modeles/versions/${ver.id}/evaluations`, 'ia-gestionnaire-modeles', { metric: 'Taux d’acceptation rejoué', value: '82', reportSha256: sha256Hex('eval'), conclusion: 'Conforme' });
    await env.req('POST', `/v1/ia/modeles/versions/${ver.id}/tests-biais`, 'u-auditeur', { dimension: 'ENTITE', method: 'Écart d’acceptation', result: '3 points', passed: true, reportSha256: sha256Hex('biais') });
    expect((await env.req('POST', `/v1/ia/modeles/versions/${ver.id}/mise-en-service`, 'ia-gestionnaire-modeles', { motif: 'Prérequis réunis, mise en service demandée' })).statusCode).toBe(202);
    expect((await env.req('POST', `/v1/ia/modeles/versions/${ver.id}/mise-en-service/decision`, 'ia-gestionnaire-modeles', { approve: true, motif: 'Auto-approbation (refusée)' })).statusCode).toBe(403);
    const ok = (await env.req('POST', `/v1/ia/modeles/versions/${ver.id}/mise-en-service/decision`, 'u-auditeur', { approve: true, motif: 'Validation humaine avant mise en service' })).json();
    expect(ok).toMatchObject({ status: 'EN_SERVICE', replaces: 'AGENTS-METIER@regles-deterministes-ia-2.0' });
    const back = (await env.req('POST', `/v1/ia/modeles/versions/${ver.id}/retour-arriere`, 'u-rssi', { motif: 'Retour arrière après incident (test)' })).json();
    expect(back).toMatchObject({ id: 'AGENTS-METIER@regles-deterministes-ia-2.0', status: 'EN_SERVICE' });
    const d = reconstruct(env.ctx.audit.list({ limit: 1_000_000 }).items).decisions.filter((x) => x.circuit === 'IA_MODELE_MISE_EN_SERVICE');
    expect(d[0]).toMatchObject({ proposerId: 'ia-gestionnaire-modeles', approverId: 'u-auditeur' });
    const mon = (await env.req('GET', '/v1/ia/modeles/surveillance', 'u-auditeur')).json();
    expect(mon.automaticEffect).toBe('AUCUN');
    expect(ALL_PARAMETERS.map((p) => p.id)).toEqual(expect.arrayContaining(['ia.derive_points', 'ia.biais_ecart_points']));
  });
});

describe('Partage légal des recettes (§ 27.1, § 30.6) — distinct du § 37A', () => {
  it('clés A_VERIFIER : assiette seulement ; fiche certifiée (quatre visas) : parts exactes sur rapproché et comptabilisé ; ETD limitée à sa commune', async () => {
    const env = await setup([pilotagePlugin, partageLegalPlugin]);
    const keys = (await env.req('GET', '/v1/legal-shares/keys', 'u-ministre-finances')).json();
    expect(keys.keys.map((k: { code: string; status: string }) => [k.code, k.status])).toEqual([['CLE-PARTAGE-INTERET-COMMUN', 'A_VERIFIER'], ['CLE-PARTAGE-RECETTES-PARTAGEES', 'A_VERIFIER']]);
    expect(env.ctx.rules.list().find((r) => r.code === 'CLE-PARTAGE-INTERET-COMMUN')).toMatchObject({ status: 'A_VERIFIER', rateTable: {} });
    // Recette d'intérêt commun (règle certifiée de test, valeurs fictives) payée et rapprochée à Limete.
    const tic = await publishCertifiedRule(env as never, { code: 'TEST-TIC', revenueCategory: 'INTERET_COMMUN', beneficiaryAccountAlias: DEMO.dgipkAlias });
    const tp = env.ctx.taxpayers.register({ phone: '+243970009901', fullName: 'Fictif Partage', language: 'fr', situation: 'landlord' });
    const obj = env.ctx.objects.create(env.ctx.users.get('u-guichet')!, { taxpayerId: tp.id, category: 'PARCELLE', commune: 'Limete', quartier: 'Test', localityRank: 2, lat: -4.3, lon: 15.3, attributes: {} });
    const { obligation } = env.ctx.assessment.calculate(env.ctx.users.get('u-controleur')!, { ruleId: tic.id, taxpayerId: tp.id, objectId: obj.id, inputs: { superficie_m2: '100' }, simulate: false });
    await payAndReconcile(env, obligation!.id);
    let c = await env.req('POST', '/v1/legal-shares:calculate', 'u-ministre-finances', { period: '2026-T3' });
    expect(c.statusCode).toBe(201);
    expect(c.json()).toMatchObject({ lines: [], disbursement: 'AUCUN' });
    expect(c.json().notCalculable[0]).toMatchObject({ code: 'CLE-PARTAGE-INTERET-COMMUN', base: [{ amount: '250.00', currency: 'USD' }] });
    expect((await env.req('POST', '/v1/legal-shares/calculate', 'u-gouverneur', { period: '2026-T3' })).statusCode).toBe(403);
    // Nouvelle version de la fiche (quatre visas) avec table de taux FICTIVE de test.
    const keyPub = await publishCertifiedRule(env as never, { code: 'CLE-PARTAGE-INTERET-COMMUN', revenueCategory: 'ACTE_REQUIS', formula: 'recettes_rapprochees * (part_etd + part_province) / 100', rateTable: { part_etd: '40', part_province: '60' }, effectiveFrom: '2026-09-26' });
    expect(keyPub.responses.map((x) => x.statusCode), JSON.stringify(keyPub.responses.map((x) => x.json()))).toEqual([200, 200, 200, 200]);
    c = await env.req('POST', '/v1/legal-shares/calculate', 'u-ministre-finances', { period: '2026-T3' });
    expect(c.json().notCalculable).toEqual([expect.objectContaining({ code: 'CLE-PARTAGE-RECETTES-PARTAGEES' })]);
    const line = c.json().lines[0];
    expect(line).toMatchObject({ keyCode: 'CLE-PARTAGE-INTERET-COMMUN', revenueCode: 'TEST-TIC', commune: 'Limete', base: { reconciled: { amount: '250.00', currency: 'USD' }, recorded: { amount: '250.00', currency: 'USD' } } });
    expect(line.shares.map((s: { entity: string; reconciled: { amount: string } }) => [s.entity, s.reconciled.amount])).toEqual([['ETD-Limete', '100.00'], ['PROVINCE-KINSHASA', '150.00']]);
    env.ctx.users.add({ id: 't-admin-gombe', name: 'Administrateur Gombe (test)', roles: ['R08'], entity: 'COMMUNE-GOMBE', territory: ['Gombe'] });
    const gombe = (await env.req('GET', `/v1/legal-shares/calculations/${c.json().id}`, 't-admin-gombe')).json();
    expect(gombe.lines).toHaveLength(0);
    // Cadre d'incitation : registre seulement, acte par une personne distincte, aucun versement.
    const inc = (await env.req('POST', '/v1/legal-shares/incitations', 'u-validateur-financier', { code: 'INC-TEST', label: 'Incitation (test)', legalBasis: 'Arrêté (fictif)', approvedFormula: 'Résultat vérifié × coefficient (fictif)', conditions: 'Résultats vérifiés', cap: 'À fixer', antiGamingControl: 'Contre-vérification aléatoire', taxTreatment: 'À confirmer', approvalCircuit: 'Quatre yeux', accounting: 'Compte à désigner' })).json();
    expect(inc).toMatchObject({ status: 'A_VERIFIER', payout: 'AUCUN' });
    expect((await env.req('POST', `/v1/legal-shares/incitations/${inc.id}/acte`, 'u-juriste-verificateur', { reference: 'ARR-INC-01 (fictif)' })).json().status).toBe('ACTE_ENREGISTRE');
  });
});
