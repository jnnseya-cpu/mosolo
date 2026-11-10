import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import type { AiActor } from '../src/core/auth.js';
import { DEFAULT_PLUGINS } from '../src/plugins/index.js';
import { findVertical } from '../src/plugins/verticales/catalogue.js';
import { DISCOVERY_DOMAINS, GRID_FIELDS, LEADS_8_1, LEADS_8_2, LEVERS, PIPELINE } from '../src/plugins/opportunites/model.js';
import type { OpportunitesService } from '../src/plugins/opportunites/service.js';

async function setupFull() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, plugins: DEFAULT_PLUGINS, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
  await app.ready();
  const req = (method: string, url: string, user?: string, body?: unknown) => app.inject({
    method: method as 'GET', url,
    headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  const svc = app.ctx.ext.opportunites as OpportunitesService;
  return { app, req, svc, clock };
}

/** Utilisateur de démonstration par rôle (le premier trouvé). */
const STEP_USERS: Record<number, string> = {
  1: 'u-dg-dgipk', 2: 'u-juriste-redacteur', 3: 'opp-analyste', 4: 'u-dg-dgipk', 5: 'u-auditeur', 6: 'opp-analyste', 7: 'u-ministre-finances',
};

async function instruct(req: Awaited<ReturnType<typeof setupFull>>['req'], id: string, upTo = 7) {
  for (let n = 1; n <= upTo; n++) {
    const body = n === 3 ? { summary: 'Estimation non chiffrée à ce stade.', scenarios: { prudent: null, attendu: null, ambitieux: null, hypothesisIds: [] } } : { summary: `Étape ${n} instruite pour le test.` };
    // Le ministre des Finances (R05) instruit le pilote : un autre décideur (Gouverneur) rendra la décision.
    const r = await req('POST', `/v1/opportunites/${id}/etapes/${n}`, STEP_USERS[n], body);
    expect(r.statusCode, `étape ${n} : ${r.body}`).toBe(200);
  }
}

describe('Opportunités — registre, grille et pipeline (§ 8.1 – § 8.4)', () => {
  it('seed : 7 pistes § 8.1 et 8 pistes § 8.2, grille complète, potentiel non inventé, hypothèses datées et sourcées', async () => {
    const { req } = await setupFull();
    const list = (await req('GET', '/v1/opportunites', 'u-dg-dgipk')).json().items as { id: string; section: string; track: string }[];
    expect(list.filter((o) => o.section === '8.1')).toHaveLength(7);
    expect(list.filter((o) => o.section === '8.2')).toHaveLength(8);
    expect(LEADS_8_1).toHaveLength(7);
    expect(LEADS_8_2).toHaveLength(8);
    for (const o of list.filter((x) => x.section !== 'SIGNAL')) {
      const full = (await req('GET', `/v1/opportunites/${o.id}`, 'u-gouverneur')).json();
      expect(Object.keys(full.grid).sort()).toEqual([...GRID_FIELDS].sort());
      expect(full.potential).toMatchObject({ prudent: null, attendu: null, ambitieux: null, note: 'à estimer par le recensement pilote' });
      for (const h of full.hypotheses) { expect(h.date).toMatch(/^\d{4}-\d{2}-\d{2}$/); expect(h.source).toBeTruthy(); }
      if (o.section === '8.2') { expect(full.track).toBe('ACTE_PROVINCIAL'); expect(full.objective && full.legalPath && full.risksToControl).toBeTruthy(); }
      else expect(full.track).toBe('SANS_TEXTE_NOUVEAU');
    }
    const g = (await req('GET', '/v1/opportunites/OPP-G82-01', 'u-dg-dgipk')).json();
    expect(g.legalPath).toContain('Édit provincial');
    expect(g.risksToControl).toContain('Double imposition');
  });

  it('champ de découverte : 20 domaines rattachés aux verticales du catalogue ; pipeline en 8 étapes avec rôle responsable', async () => {
    const { req } = await setupFull();
    const scope = (await req('GET', '/v1/opportunites/decouverte/champ', 'u-dg-dgipk')).json();
    expect(scope.domains).toHaveLength(20);
    expect(scope.agent.code).toBe('DECOUVERTE');
    for (const d of DISCOVERY_DOMAINS) for (const v of d.verticals) expect(findVertical(v), v).toBeDefined();
    for (const l of [...LEADS_8_1, ...LEADS_8_2]) for (const v of l.verticals) expect(findVertical(v), v).toBeDefined();
    const p = (await req('GET', '/v1/opportunites/pipeline', 'u-dg-dgipk')).json();
    expect(p.steps.map((s: { label: string }) => s.label)).toEqual(['Signal', 'Qualification juridique', 'Estimation', 'Impact socio-économique', 'Risque de corruption', 'Coût d’implémentation', 'Pilote', 'Décision']);
    expect(PIPELINE[7]!.roles).toEqual(['R01', 'R04', 'R05']);
    // Refus par défaut : un contribuable ne lit pas le registre.
    expect((await req('GET', '/v1/opportunites', 'u-contribuable')).statusCode).toBe(403);
  });

  it('étapes : ordre imposé, rôle responsable exigé, journalisées', async () => {
    const { req, app } = await setupFull();
    const id = 'OPP-G81-05';
    // Juriste ne complète pas le signal ; qualification avant signal refusée.
    expect((await req('POST', `/v1/opportunites/${id}/etapes/1`, 'u-juriste-redacteur', { summary: 'Signal saisi par un juriste.' })).statusCode).toBe(403);
    const early = await req('POST', `/v1/opportunites/${id}/etapes/2`, 'u-juriste-redacteur', { summary: 'Qualification prématurée.' });
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe('STEP_OUT_OF_ORDER');
    expect((await req('POST', `/v1/opportunites/${id}/etapes/1`, 'u-dg-dgipk', { summary: 'Signal : panneaux non déclarés relevés.' })).statusCode).toBe(200);
    // Estimation : un montant sans hypothèse citée est refusé.
    await req('POST', `/v1/opportunites/${id}/etapes/2`, 'u-juriste-redacteur', { summary: 'Base existante — taxe publicitaire.' });
    const bad = await req('POST', `/v1/opportunites/${id}/etapes/3`, 'opp-analyste', { summary: 'Estimation chiffrée.', scenarios: { prudent: { amount: '1000.00', currency: 'USD' }, attendu: null, ambitieux: null, hypothesisIds: [] } });
    expect(bad.json().code).toBe('HYPOTHESES_REQUIRED');
    const ok = await req('POST', `/v1/opportunites/${id}/etapes/3`, 'opp-analyste', { summary: 'Estimation fondée sur H1.', scenarios: { prudent: { amount: '1000.00', currency: 'USD' }, attendu: null, ambitieux: null, hypothesisIds: ['G81-05-H1'] } });
    expect(ok.statusCode).toBe(200);
    expect(app.ctx.audit.list({ limit: 100000 }).items.filter((e) => e.action === 'opportunite.step.completed' && e.resourceId === id)).toHaveLength(3);
  });

  it('garde-fou : aucune opportunité ne devient une taxe par décision algorithmique ; activation sans base légale impossible', async () => {
    const { req, app, svc } = await setupFull();
    const id = 'OPP-G82-01';
    // Décision avant la fin de l'instruction : refusée.
    expect((await req('POST', `/v1/opportunites/${id}/decision`, 'u-gouverneur', { outcome: 'REPORT', motivation: 'Motivation suffisamment longue.' })).json().code).toBe('PIPELINE_INCOMPLETE');
    await instruct(req, id);
    // Un agent d'IA ne décide ni n'instruit aucune étape.
    const ai: AiActor = { kind: 'ai', id: 'ia-decouverte', agent: 'DECOUVERTE' } as unknown as AiActor;
    expect(() => svc.decide(ai, id, { outcome: 'ACTIVATION', motivation: 'Décision algorithmique interdite.', legalBasis: { kind: 'ACTE', ref: 'ol-18-004' } })).toThrow(/agent d'IA/);
    expect(() => svc.completeStep(ai, 'OPP-G82-02', 1, { summary: 'Signal automatique.' })).toThrow();
    // Rôle non compétent (direction de régie) : refusé.
    expect((await req('POST', `/v1/opportunites/${id}/decision`, 'u-dg-dgipk', { outcome: 'ABANDON', motivation: 'Décision hors compétence.' })).statusCode).toBe(403);
    const rulesBefore = app.ctx.rules.rules.count();
    const obligationsBefore = app.ctx.assessment.obligations.count();
    const noBasis = await req('POST', `/v1/opportunites/${id}/decision`, 'u-gouverneur', { outcome: 'ACTIVATION', motivation: 'Activation souhaitée sans texte.' });
    expect(noBasis.statusCode).toBe(422);
    expect(noBasis.json().code).toBe('LEGAL_BASIS_REQUIRED');
    const draftRule = app.ctx.rules.rules.all().find((r) => r.status !== 'ACTIVE')!;
    const notActive = await req('POST', `/v1/opportunites/${id}/decision`, 'u-gouverneur', { outcome: 'ACTIVATION', motivation: 'Activation sur une règle non active.', legalBasis: { kind: 'REGLE', ref: draftRule.id } });
    expect(notActive.json().code).toBe('LEGAL_BASIS_NOT_ACTIVE');
    const abrogated = await req('POST', `/v1/opportunites/${id}/decision`, 'u-gouverneur', { outcome: 'ACTIVATION', motivation: 'Activation sur un acte abrogé.', legalBasis: { kind: 'ACTE', ref: 'ol-13-001' } });
    expect(abrogated.json().code).toBe('LEGAL_BASIS_NOT_ACTIVE');
    const done = await req('POST', `/v1/opportunites/${id}/decision`, 'u-gouverneur', { outcome: 'ACTIVATION', motivation: 'Acte en vigueur cité, pilote concluant.', legalBasis: { kind: 'ACTE', ref: 'demo-instrument-001' } });
    expect(done.statusCode).toBe(200);
    expect(done.json().decision).toMatchObject({ outcome: 'ACTIVATION', effect: 'AUCUNE_OBLIGATION_CREEE', legalBasis: { kind: 'ACTE', status: 'EN_VIGUEUR' } });
    // L'activation ne crée ni règle ni obligation.
    expect(app.ctx.rules.rules.count()).toBe(rulesBefore);
    expect(app.ctx.assessment.obligations.count()).toBe(obligationsBefore);
    expect(app.ctx.audit.list({ limit: 100000 }).items.some((e) => e.action === 'opportunite.activation.refused' && e.outcome === 'DENIED')).toBe(true);
    // Séparation : l'autorité qui a instruit le pilote (R05) ne décide pas.
    await instruct(req, 'OPP-G82-03');
    const self = await req('POST', '/v1/opportunites/OPP-G82-03/decision', 'u-ministre-finances', { outcome: 'REPORT', motivation: 'Report motivé par le ministre.' });
    expect(self.json().code).toBe('SEPARATION_OF_DUTIES');
    expect((await req('POST', '/v1/opportunites/OPP-G82-03/decision', 'u-gouverneur', { outcome: 'REPORT', motivation: 'Report : étude d’impact à compléter.' })).json().decision.outcome).toBe('REPORT');
  });

  it('signal de l’agent Découverte des recettes versé au registre par une personne ; grille et hypothèses révisables', async () => {
    const { req, app } = await setupFull();
    const ia = app.ctx.ext.ia as { run: (u: unknown, code: string, i: { purpose: string }) => { id: string }[] };
    ia.run(app.ctx.users.get('u-dg-dgipk'), 'DECOUVERTE', { purpose: 'Test du moteur de découverte' });
    const signals = (await req('GET', '/v1/opportunites/decouverte/signaux-ia', 'u-dg-dgipk')).json();
    expect(signals.available).toBe(true);
    const recId = signals.items[0]!.id as string;
    const created = await req('POST', '/v1/opportunites', 'u-dg-dgipk', { title: 'Unités sans bail — commune ciblée', origin: 'IA_DECOUVERTE', originRef: recId, summary: 'Signal de l’agent confirmé par la direction.', domains: ['IMMOBILIER_LOCATIF'] });
    expect(created.statusCode).toBe(201);
    const opp = created.json();
    expect(opp.steps[0]).toMatchObject({ n: 1, completedBy: 'u-dg-dgipk' });
    expect((await req('POST', '/v1/opportunites', 'u-dg-dgipk', { title: 'Doublon du même signal', origin: 'IA_DECOUVERTE', originRef: recId, summary: 'Même signal importé deux fois.', domains: ['IMMOBILIER_LOCATIF'] })).statusCode).toBe(409);
    // Grille : rubrique juridique réservée aux juristes.
    expect((await req('PUT', `/v1/opportunites/${opp.id}/grille/faisabiliteJuridique`, 'opp-analyste', { value: 'x', reason: 'Tentative hors rôle' })).json().code).toBe('GRID_FIELD_ROLE');
    expect((await req('PUT', `/v1/opportunites/${opp.id}/grille/faisabiliteJuridique`, 'u-juriste-verificateur', { value: 'Base IRL existante', reason: 'Qualification' })).statusCode).toBe(200);
    const rev = await req('POST', `/v1/opportunites/${opp.id}/hypotheses`, 'opp-analyste', { text: 'Taux d’occupation observé à confirmer.', source: 'Recensement pilote Limete', date: '2026-09-20', revises: opp.hypotheses[0].id });
    expect(rev.json().hypotheses.map((h: { status: string }) => h.status)).toEqual(['REVISEE', 'ACTIVE']);
  });
});

describe('Recoupement (§ 8.5) : protocole, conformité, liste de travail — jamais d’avis automatique', () => {
  it('ingestion refusée sans protocole signé ni vérification Code du numérique', async () => {
    const { req, app } = await setupFull();
    const s = (await req('POST', '/v1/recoupement/sources', 'opp-analyste', { kind: 'LIVRAISONS_BRASSERIE', partnerName: 'Dépôt test', description: 'Livraisons test' })).json();
    const rec = { records: [{ pointRef: 'P1', commune: 'Limete', lat: -4.37, lon: 15.34, deliveries: 3 }] };
    const r1 = await req('POST', `/v1/recoupement/sources/${s.id}/lots`, 'opp-partenaire', rec);
    expect(r1.statusCode).toBe(409);
    expect(r1.json().code).toBe('SOURCE_NOT_AUTHORISED');
    await req('POST', `/v1/recoupement/sources/${s.id}/protocole`, 'u-dg-dgipk', { reference: 'PROT-1', signedOn: '2026-09-01', signatories: 'DGIPK / dépôt', documentSha256: 'a'.repeat(64) });
    expect((await req('POST', `/v1/recoupement/sources/${s.id}/lots`, 'opp-partenaire', rec)).statusCode).toBe(409);
    // Conformité : délégué à la protection des données seulement.
    const compliance = { personalData: false, lawfulBasis: 'Mission d’intérêt public', minimisation: 'Positions', retention: '12 mois', security: 'Chiffrement', conclusion: 'CONFORME', note: '' };
    expect((await req('POST', `/v1/recoupement/sources/${s.id}/conformite`, 'u-dg-dgipk', compliance)).statusCode).toBe(403);
    expect((await req('POST', `/v1/recoupement/sources/${s.id}/conformite`, 'opp-dpo', compliance)).json().status).toBe('ACTIVE');
    const obligations = app.ctx.assessment.obligations.count();
    const ok = await req('POST', `/v1/recoupement/sources/${s.id}/lots`, 'opp-partenaire', rec);
    expect(ok.statusCode).toBe(201);
    expect(ok.json().items[0]).toMatchObject({ ruleCode: 'BAR_SANS_LICENCE', status: 'A_EXAMINER', automaticAssessment: 'AUCUN' });
    expect(app.ctx.assessment.obligations.count()).toBe(obligations);
    expect(app.ctx.alerts.alerts.all().some((a) => a.type === 'INGESTION_SANS_PROTOCOLE')).toBe(true);
  });

  it('règle bar : autorisation de débit de boissons à moins de 50 m ⇒ aucun signal ; sinon objet provisoire à l’examen, puis mission terrain', async () => {
    const { req, app, svc } = await setupFull();
    const src = svc.sources.all().find((s) => s.kind === 'LIVRAISONS_BRASSERIE' && s.status === 'ACTIVE')!;
    app.ctx.objects.create(app.ctx.users.get('u-controleur')!, { category: 'ACTIVITE', commune: 'Lemba', quartier: 'Salongo', localityRank: 2, lat: -4.4100, lon: 15.3300, attributes: { objectType: 'DEBIT_BOISSONS' } });
    const near = await req('POST', `/v1/recoupement/sources/${src.id}/lots`, 'opp-partenaire', { records: [{ pointRef: 'P-NEAR', commune: 'Lemba', lat: -4.4102, lon: 15.3301, deliveries: 5 }] });
    expect(near.json().items).toHaveLength(0);
    const list = (await req('GET', '/v1/recoupement/liste-travail?ruleCode=BAR_SANS_LICENCE', 'u-dg-dgipk')).json();
    const priorities = list.items.map((i: { priority: number }) => i.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => b - a));
    const item = list.items[0];
    // Mission impossible avant l'examen humain.
    expect((await req('POST', `/v1/recoupement/liste-travail/${item.id}/mission`, 'terrain-resp-module', { dueDate: '2026-10-10' })).json().code).toBe('REVIEW_REQUIRED');
    const reviewed = await req('POST', `/v1/recoupement/liste-travail/${item.id}/examen`, 'u-controleur', { decision: 'VERIFICATION_REQUISE', reason: 'Livraisons régulières constatées', localityRank: 3 });
    expect(reviewed.statusCode).toBe(200);
    const obj = app.ctx.objects.objects.get(reviewed.json().createdObjectId)!;
    expect(obj).toMatchObject({ status: 'PROVISOIRE', category: 'ACTIVITE' });
    expect(obj.attributes.objectType).toBe('BAR');
    const m = await req('POST', `/v1/recoupement/liste-travail/${item.id}/mission`, 'terrain-resp-module', { dueDate: '2026-10-10' });
    expect(m.statusCode, m.body).toBe(201);
    expect(m.json().item.status).toBe('MISSION_OUVERTE');
    // L'agent de terrain voit sa liste en accès minimal (sans variables).
    const field = (await req('GET', '/v1/recoupement/liste-travail', 'u-agent-terrain')).json();
    expect(field.access).toBe('minimal');
    expect(field.items.every((i: Record<string, unknown>) => !('variables' in i) && ['Limete', 'Lemba', 'Matete'].includes(i.commune as string))).toBe(true);
  });

  it('immeuble multi-unités : examen humain puis mission ; code marchand ; plaque ; quitus bloquant jusqu’à régularisation', async () => {
    const { req, svc, app } = await setupFull();
    const items = svc.worklist.all();
    expect(items.map((i) => i.ruleCode).sort()).toEqual(expect.arrayContaining(['BAR_SANS_LICENCE', 'COMMERCE_NON_ENREGISTRE', 'VEHICULE_IMPAYE', 'SANS_QUITUS_VALIDE', 'INCOHERENCE_LOCATIVE']));
    expect(items.every((i) => i.automaticAssessment === 'AUCUN')).toBe(true);
    const building = items.find((i) => i.ruleCode === 'INCOHERENCE_LOCATIVE')!;
    expect(building.status).toBe('A_EXAMINER');
    expect((await req('POST', `/v1/recoupement/liste-travail/${building.id}/examen`, 'u-controleur', { decision: 'VERIFICATION_REQUISE', reason: 'Vacances déclarées improbables' })).statusCode).toBe(200);
    expect((await req('POST', `/v1/recoupement/liste-travail/${building.id}/mission`, 'u-superviseur', { dueDate: '2026-10-15' })).statusCode).toBe(201);
    // Plaque : statut minimal pour le contrôleur.
    const plate = (await req('GET', '/v1/recoupement/plaques/KN-9999-ZZ', 'u-controleur')).json();
    expect(plate.result).toBe('INCONNU');
    expect(plate).not.toHaveProperty('taxpayerId');
    expect((await req('GET', '/v1/recoupement/plaques/KN-4471-BD', 'u-controleur')).json().result).toMatch(/ROUGE|VERT/);
    // Quitus : service bloqué (informatif tant que J6 n'est pas en vigueur), levé après régularisation.
    const block = svc.blocks.all()[0]!;
    expect(block).toMatchObject({ status: 'BLOQUE', opposable: false });
    const recheck = (await req('POST', `/v1/recoupement/blocages/${block.id}/reexamen`, 'u-guichet')).json();
    const fiscal = app.ctx.ext.fiscal as { clearances: { active: (id: string) => unknown } };
    expect(recheck.status).toBe(fiscal.clearances.active(block.taxpayerId) ? 'LEVE' : 'BLOQUE');
    // Conditionnalité opposable seulement si un acte EN VIGUEUR est désigné.
    expect((await req('PUT', '/v1/recoupement/parametres', 'u-dg-dgipk', { quitusActInstrumentId: 'arrete-taux-irl-2026', reason: 'Acte non certifié' })).json().code).toBe('INSTRUMENT_NOT_IN_FORCE');
  });
});

describe('Leviers (§ 8.6) et maximisation (§ 8.7)', () => {
  it('douze leviers : mesure calculée ou « non mesuré »', async () => {
    const { req } = await setupFull();
    const l = (await req('GET', '/v1/opportunites-leviers', 'u-gouverneur')).json().levers as { code: string; measured: boolean; value: string }[];
    expect(l).toHaveLength(12);
    expect(l.map((x) => x.code)).toEqual(LEVERS.map((x) => x.code));
    for (const x of l.filter((y) => !y.measured)) expect(x.value).toBe('non mesuré');
    expect(l.find((x) => x.code === 'DONNEES')!.measured).toBe(true);
    expect(l.find((x) => x.code === 'FRAUDE')!.measured).toBe(false);
  });

  it('classement par revenu net ajusté au risque : entrée inconnue ⇒ non classée ; entrées datées et sourcées ; tableaux séparés', async () => {
    const { req } = await setupFull();
    const before = (await req('GET', '/v1/opportunites-maximisation/classement', 'u-gouverneur')).json();
    expect(before.ranked).toHaveLength(0);
    expect(before.notRanked.length).toBeGreaterThanOrEqual(15);
    const id = 'OPP-G81-04';
    expect((await req('PUT', `/v1/opportunites/${id}/maximisation/legalPotential`, 'opp-analyste', { value: { amount: '1000.00', currency: 'USD' } })).json().code).toBe('INPUT_UNSOURCED');
    const src = { date: '2026-09-20', source: 'Hypothèse d’analyste — test' };
    const set = (k: string, value: unknown) => req('PUT', `/v1/opportunites/${id}/maximisation/${k}`, 'opp-analyste', { value, ...src });
    await set('legalPotential', { amount: '1000.00', currency: 'USD' });
    await set('complianceProbability', '0.5');
    await set('collectionSpeed', '0.8');
    await set('censusCost', { amount: '50.00', currency: 'USD' });
    await set('controlCost', { amount: '30.00', currency: 'USD' });
    await set('contestRisk', { amount: '10.00', currency: 'USD' });
    const last = await set('socialRisk', { amount: '10.00', currency: 'USD' });
    expect(last.json()).toMatchObject({ ranked: true, net: { amount: '300.00', currency: 'USD' } });
    expect((await set('complianceProbability', '1.5')).json().code).toBe('INVALID_FRACTION');
    const after = (await req('GET', '/v1/opportunites-maximisation/classement', 'u-gouverneur')).json();
    expect(after.ranked[0].id).toBe(id);
    expect(after.dashboards.map((d: { kind: string }) => d.kind)).toEqual(['RECETTE_NOUVELLE', 'REGULARISATION_ARRIERES', 'AMELIORATION_RAPPROCHEMENT', 'RECLASSEMENT']);
    expect(after.dashboards.find((d: { kind: string }) => d.kind === 'REGULARISATION_ARRIERES').netByCurrency).toEqual([{ amount: '300.00', currency: 'USD' }]);
  });

  it('cas d’usage prioritaires et simulation de campagne (sans effet)', async () => {
    const { req, app } = await setupFull();
    const uc = (await req('GET', '/v1/opportunites-maximisation/cas-usage', 'u-dg-dgipk')).json();
    for (const k of ['rentalLayer', 'shopsVsPatentes', 'expiring', 'confirmedNotReconciled', 'concentrations', 'forecast', 'simulations']) expect(uc, k).toHaveProperty(k);
    expect(uc.rentalLayer.points.length).toBeGreaterThan(0);
    const obligations = app.ctx.assessment.obligations.count();
    const sim = await req('POST', '/v1/opportunites-maximisation/simulations', 'opp-analyste', {
      label: 'Campagne panneaux Gombe', targets: 100, averageDue: { amount: '20.00', currency: 'USD' }, complianceProbability: '0.5', collectionSpeed: '0.5',
      censusCostPerTarget: { amount: '1.00', currency: 'USD' }, controlCostPerTarget: { amount: '1.00', currency: 'USD' }, contestRisk: { amount: '10.00', currency: 'USD' }, socialRisk: { amount: '0.00', currency: 'USD' },
      hypotheses: [{ text: 'Hypothèse de test', source: 'Test', date: '2026-09-20' }],
    });
    expect(sim.statusCode).toBe(201);
    expect(sim.json().result.net).toEqual({ amount: '290.00', currency: 'USD' });
    expect(sim.json().effect).toBe('AUCUN');
    expect(app.ctx.assessment.obligations.count()).toBe(obligations);
    expect((await req('POST', '/v1/opportunites-maximisation/simulations', 'u-controleur', {})).statusCode).toBeGreaterThanOrEqual(400);
  });
});
