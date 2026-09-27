import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { sha256Hex } from '../src/core/crypto.js';
import { assertAiMay } from '../src/core/policy.js';
import { fiscalPlugin } from '../src/plugins/fiscal/plugin.js';
import type { ModelRegistryService } from '../src/plugins/ia/modeles.js';
import type { IaService } from '../src/plugins/ia/service.js';
import { DEMO } from '../src/seed.js';
import { postStatement, callbackHeaders } from './helpers.js';

async function full(plugins?: NonNullable<Parameters<typeof buildApp>[0]>['plugins']) {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, ...(plugins ? { plugins } : {}), secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
  await app.ready();
  const req = (method: string, url: string, user?: string, body?: unknown, headers: Record<string, string> = {}) => app.inject({
    method: method as 'GET', url,
    headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { payload: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  return { app, clock, req, ctx: app.ctx };
}

async function payAndReconcile(env: Awaited<ReturnType<typeof full>>, key: string) {
  const ob = env.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
  const order = (await env.req('POST', `/v1/obligations/${ob.id}/payment-orders`, 'u-guichet', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': `cle-${key}-000001` })).json();
  const raw = JSON.stringify({ providerTxnId: `TXN-${key}`, paymentReference: order.paymentReference, amount: order.amount, status: 'SUCCESS', completedAt: env.clock.now().toISOString() });
  expect((await env.req('POST', '/v1/providers/mm-operator-a/callbacks', undefined, raw, callbackHeaders('s', raw, env.clock.now()))).json().status).toBe('CONFIRME');
  await postStatement(env, 'u-tresor', { statementId: `REL-${key}`, lines: [{ accountAlias: DEMO.dgipkAlias, amount: order.amount, valueDate: env.clock.now().toISOString().slice(0, 10), paymentReference: order.paymentReference }] });
  return order as { amount: { amount: string; currency: string } };
}

describe('Module 48 — recommandation d’investissement public', () => {
  it('capacité disponible selon le budget voté (enveloppe certifiée à deux personnes) ; scénarios produits et retenus', async () => {
    const env = await full();
    const { req } = env;
    const order = await payAndReconcile(env, 'INV48');
    const cur = order.amount.currency;
    await req('POST', '/v1/pilotage/projets', 'u-ministre-finances', {
      code: 'LIM-DRAIN-01', title: 'Curage de caniveaux (fictif)', domain: 'DRAINAGE', communes: ['Limete'], beneficiaries: 'Riverains', expectedResult: 'Caniveaux dégagés',
      maturity: 'PRET_A_LANCER', cost: { amount: '1.00', currency: cur }, recurringCost: { amount: '0.10', currency: cur }, procurement: 'REGIE', risks: 'Pluies', approvalAuthority: 'Ministre provincial des Finances', legalFundSource: 'Budget voté (fictif)',
    });
    // Enveloppe du budget voté : importée, puis certifiée par une autre personne.
    const env1 = (await req('POST', '/v1/pilotage/projets/enveloppes', 'u-ministre-finances', { period: '2026', amount: { amount: '1.00', currency: cur }, actReference: 'Édit budgétaire 2026 (fictif)', label: 'Investissements 2026' })).json();
    expect((await req('POST', `/v1/pilotage/projets/enveloppes/${env1.id}/certification`, 'u-ministre-finances', { approve: true, motif: 'Auto-certification interdite' })).statusCode).toBe(403);
    expect((await req('POST', `/v1/pilotage/projets/enveloppes/${env1.id}/certification`, 'u-gouverneur', { approve: true, motif: 'Conforme à l’édit budgétaire voté' })).json().status).toBe('CERTIFIEE');
    const rec = (await req('POST', '/v1/pilotage/projets/recommandations', 'u-ministre-finances', { period: '2026-T3', currency: cur, legalFundSource: 'Recettes propres rapprochées (fictif)' })).json();
    expect(rec.scenarios[0].available.amount).toBe('1.00');
    expect(rec.scenarios[0].availableBasis).toMatch(/Enveloppe du budget voté/);
    expect(rec.notice).toMatch(/n’approuve aucune dépense/);
    await req('POST', `/v1/pilotage/projets/scenarios/${rec.scenarios[0].id}/decision`, 'u-gouverneur', { retain: true, motif: 'Scénario retenu par l’autorité (test)' });
    const list = (await req('GET', '/v1/pilotage/projets', 'u-gouverneur')).json();
    expect(list.indicators.find((i: { code: string }) => i.code === 'SCENARIOS_PRODUITS').value).toBe('3');
    expect(list.indicators.find((i: { code: string }) => i.code === 'SCENARIOS_RETENUS').value).toBe('1');
  });
});

describe('Module 49 — gestion des agents IA', () => {
  it('registre des prompts versionnés, taux d’acceptation et dérive ; version de prompt non inscrite signalée', async () => {
    const env = await full();
    const { req, ctx } = env;
    ctx.objects.create(ctx.users.get('u-agent-terrain')!, { taxpayerId: DEMO.taxpayerId, category: 'UNITE_LOCATIVE', commune: 'Limete', quartier: 'Quartier test', localityRank: 2, lat: -4.37, lon: 15.34, attributes: { parcelleId: DEMO.parcelId, niveau: 'étage 1' } }, 'OBJ-TEST-M49');
    const recs = (await req('POST', '/v1/ia/agents/DECOUVERTE/run', 'u-dg-dgipk', { purpose: 'Recherche de gisements (test)' })).json();
    expect(recs.length).toBeGreaterThan(0);
    const d = await req('POST', `/v1/ia/recommendations/${recs[0].id}/decide`, 'terrain-resp-module', { decision: 'ACCEPTEE', reason: 'Recommandation pertinente après vérification' });
    expect(d.statusCode).toBe(200);
    const p = (await req('GET', '/v1/ia/prompts', 'u-auditeur')).json();
    const dec = p.items.find((a: { agent: string }) => a.agent === 'DECOUVERTE');
    expect(dec.sheet.never).toMatch(/Ne crée aucune règle/);
    const v = dec.versions.find((x: { current: boolean }) => x.current);
    expect(v).toMatchObject({ registered: true, decisions: 1, acceptancePct: '100.0' });
    expect(p.indicators.find((i: { code: string }) => i.code === 'TAUX_ACCEPTATION').value).toBe('100.0');
    expect(p.indicators.find((i: { code: string }) => i.code === 'DERIVE_DETECTEE').measured).toBe(false);
    // Version de prompt observée au journal sans inscription au registre : alerte à examiner.
    const ia = ctx.ext.ia as IaService;
    const r0 = ia.recommendations.get(recs[0].id)!;
    ia.recommendations.update({ ...r0, promptVersion: 'decouverte-v0-inconnue' });
    (ctx.ext['ia-modeles'] as ModelRegistryService).prompts();
    expect(ctx.alerts.alerts.all().some((a) => a.type === 'IA_PROMPT_NON_ENREGISTRE')).toBe(true);
    const view = (await req('GET', '/v1/ia/modeles', 'u-auditeur')).json();
    expect(view.prompts.length).toBeGreaterThan(0);
    expect(view.indicators.map((i: { code: string }) => i.code)).toEqual(['DERIVE_DETECTEE', 'TAUX_ACCEPTATION']);
  });

  it('interdictions absolues : l’IA ne taxe pas, ne sanctionne pas, ne transfère pas, ne modifie pas un bénéficiaire', () => {
    const ai = { kind: 'ai' as const, id: 'agent:TEST', agent: 'TEST' };
    for (const a of ['CREATE_TAX', 'IMPOSE_PENALTY', 'TRANSFER_MONEY', 'CHANGE_BENEFICIARY', 'rule.create', 'payment.create', 'beneficiary.approve'] as const) {
      expect(() => assertAiMay(ai, a), a).toThrow(/AI_FORBIDDEN_ACTION|recommandation seulement/);
    }
  });

  it('coupe-circuit : arrêt immédiat d’un agent', async () => {
    const { req } = await full();
    const cut = await req('POST', '/v1/ia/agents/DECOUVERTE/state', 'ia-gestionnaire-modeles', { enabled: false, reason: 'Arrêt immédiat pour examen de dérive' });
    expect(cut.statusCode).toBe(200);
    expect((await req('POST', '/v1/ia/agents/DECOUVERTE/run', 'u-dg-dgipk', { purpose: 'Test après coupure' })).statusCode).toBe(503);
  });
});

describe('Module 50 — apprentissage et connaissance', () => {
  it('base de procédures versionnée : version publiée et historique ; nouvelle procédure publiée à quatre yeux', async () => {
    const { req } = await full();
    const lib = (await req('GET', '/v1/apprentissage/procedures', 'u-agent-terrain')).json();
    const proc = lib.items.find((p: { cle: string }) => p.cle === 'procedure.constat-terrain');
    expect(proc.publiee.version).toBe(2);
    expect(proc.historique.map((h: { statut: string }) => h.statut)).toEqual(['REMPLACEE', 'PUBLIEE']);
    const c = await req('POST', '/v1/apprentissage/contenus', 'u-admin-entite', { type: 'PROCEDURE', cle: 'procedure.guichet-accueil', publics: ['GUICHET'], titre: 'Accueil au guichet', corps: 'Accueillir, vérifier la pièce, orienter vers le paiement numérique ; aucune espèce.' });
    expect(c.statusCode).toBe(201);
    expect(c.json().id).toMatch(/^PROC-/);
    await req('POST', `/v1/apprentissage/contenus/${c.json().id}/publication/propose`, 'u-admin-entite');
    expect((await req('POST', `/v1/apprentissage/contenus/${c.json().id}/publication/decision`, 'u-admin-entite', { approve: true, motif: 'Auto-publication interdite' })).statusCode).toBe(403);
    expect((await req('POST', `/v1/apprentissage/contenus/${c.json().id}/publication/decision`, 'u-dg-dgipk', { approve: true, motif: 'Procédure relue et conforme' })).statusCode).toBe(200);
    const g = (await req('GET', '/v1/apprentissage/procedures', 'u-guichet')).json();
    expect(g.items.map((p: { cle: string }) => p.cle)).toContain('procedure.guichet-accueil');
    // Indicateurs : agents certifiés ; taux de réussite (non mesuré sans épreuve).
    const ind = (await req('GET', '/v1/apprentissage/indicateurs', 'u-dg-dgipk')).json();
    expect(Number(ind.indicators.find((i: { code: string }) => i.code === 'AGENTS_CERTIFIES').value)).toBeGreaterThan(0);
    expect(ind.indicators.find((i: { code: string }) => i.code === 'TAUX_REUSSITE')).toBeDefined();
  });
});

describe('Module 56 — grands redevables', () => {
  it('portefeuille dédié, gestionnaire dédié et rotation, convention approuvée à deux, journal des décisions, indicateurs', async () => {
    const { req, clock } = await full();
    const chief = 'vx-chef-service-dgtk';
    await req('POST', '/v1/verticales/secteurs/grands-redevables', chief, { taxpayerId: DEMO.taxpayerId, sectors: ['17', '56'], motif: 'Brasserie à fort enjeu (démonstration)' });
    let v = (await req('GET', '/v1/grands-redevables', chief)).json();
    expect(v.portfolio[0].sectors.map((s: { label: string }) => s.label)).toContain('Brasseries, boissons, alcools et tabac');
    expect(v.withoutManager).toBe(1);
    expect((await req('POST', `/v1/grands-redevables/${DEMO.taxpayerId}/gestionnaire`, chief, { managerId: 'u-tresor', motif: 'Affectation hors cellule (refusée)' })).json().code).toBe('INVALID_MANAGER');
    await req('POST', `/v1/grands-redevables/${DEMO.taxpayerId}/gestionnaire`, chief, { managerId: 'vx-instructeur-dgtk', motif: 'Gestionnaire dédié désigné' });
    // Rotation due après la durée maximale d'affectation (par défaut) ; retour immédiat de l'ancien gestionnaire interdit.
    clock.advance(25 * 30 * 86_400_000);
    v = (await req('GET', '/v1/grands-redevables', chief)).json();
    expect(v.rotationsDue).toBe(1);
    await req('POST', `/v1/grands-redevables/${DEMO.taxpayerId}/gestionnaire`, chief, { managerId: 'gr-gestionnaire-2', motif: 'Rotation des gestionnaires' });
    expect((await req('POST', `/v1/grands-redevables/${DEMO.taxpayerId}/gestionnaire`, chief, { managerId: 'vx-instructeur-dgtk', motif: 'Retour de l’ancien gestionnaire' })).json().code).toBe('ROTATION_REQUIRED');
    // Convention : base légale au registre, approbation par une seconde personne.
    const conv = { reference: 'CONV-GR-001 (fictif)', object: 'Déclaration mensuelle des volumes et rapprochement avec les accises (test).', sectors: ['17'], periodicity: 'MENSUELLE', legalBasis: { instrumentId: 'demo-instrument-001', article: 'Art. 2 (fictif)' }, signedSha256: sha256Hex('convention signée'), from: '2026-09-01', to: '2029-08-31' };
    expect((await req('POST', `/v1/grands-redevables/${DEMO.taxpayerId}/conventions`, 'gr-gestionnaire-2', { ...conv, legalBasis: { instrumentId: 'inexistant', article: 'Art. 1' } })).json().code).toBe('LEGAL_BASIS_UNKNOWN');
    const c = (await req('POST', `/v1/grands-redevables/${DEMO.taxpayerId}/conventions`, 'gr-gestionnaire-2', conv)).json();
    expect((await req('POST', `/v1/grands-redevables/conventions/${c.id}/decision`, 'gr-gestionnaire-2', { approve: true, motif: 'Auto-approbation interdite' })).statusCode).toBe(403);
    expect((await req('POST', `/v1/grands-redevables/conventions/${c.id}/decision`, chief, { approve: true, motif: 'Convention conforme au protocole' })).json().status).toBe('ACTIVE');
    // Journal : note du gestionnaire dédié ; décision réservée au cadre ; un autre agent n'écrit pas.
    expect((await req('POST', `/v1/grands-redevables/${DEMO.taxpayerId}/journal`, 'gr-gestionnaire-2', { kind: 'NOTE', text: 'Rendez-vous de suivi trimestriel tenu.' })).statusCode).toBe(201);
    expect((await req('POST', `/v1/grands-redevables/${DEMO.taxpayerId}/journal`, 'vx-instructeur-dgtk', { kind: 'NOTE', text: 'Note d’un agent non affecté.' })).json().code).toBe('NOT_ASSIGNED_MANAGER');
    expect((await req('POST', `/v1/grands-redevables/${DEMO.taxpayerId}/journal`, 'gr-gestionnaire-2', { kind: 'DECISION', text: 'Décision prise par le gestionnaire.' })).statusCode).toBe(403);
    expect((await req('POST', `/v1/grands-redevables/${DEMO.taxpayerId}/journal`, chief, { kind: 'DECISION', text: 'Garantie demandée avant échéancier : décision motivée.' })).statusCode).toBe(201);
    v = (await req('GET', '/v1/grands-redevables', chief)).json();
    const p = v.portfolio[0];
    expect(p.manager.id).toBe('gr-gestionnaire-2');
    expect(p.managers.map((m: { endReason: string | null }) => m.endReason)).toEqual(['ROTATION', null]);
    expect(p.conventions[0].compliance.expected).toBeGreaterThan(0);
    expect(p.journal.length).toBe(2);
    expect(v.indicators.map((i: { code: string }) => i.code)).toEqual(['RECETTES_GRANDS_REDEVABLES', 'DELAIS_PAIEMENT']);
    expect((await req('GET', '/v1/grands-redevables', 'u-dg-dgipk')).statusCode).toBe(403);
  });
});

describe('Module 57 — registre des exonérations', () => {
  it('échéance et révision automatiques (rappels idempotents), concentration sur un agent, indicateurs', async () => {
    const { req, clock, app } = await full([fiscalPlugin]);
    const base = { kind: 'EXONERATION', objectId: DEMO.parcelId, ruleCode: 'DEMO-IF-BATI', rate: '100', grounds: 'Bien affecté à un usage d’intérêt général (test).', proofs: [{ type: 'ATTESTATION', reference: 'ATT-57' }], validFrom: '2026-09-26', validTo: '2026-10-15' };
    const id = (await req('POST', '/v1/fiscal/exemptions', 'u-contribuable', base)).json().id;
    await req('POST', `/v1/fiscal/exemptions/${id}/instruction`, 'u-guichet', { decision: 'FAVORABLE', reason: 'Pièces complètes', legalBasis: { instrumentId: 'demo-instrument-001', article: 'Article 2 (fictif)' } });
    await req('POST', `/v1/fiscal/exemptions/${id}/legal-visa`, 'u-juriste-verificateur', { decision: 'FAVORABLE', reason: 'Fondement vérifié' });
    expect((await req('POST', `/v1/fiscal/exemptions/${id}/decision`, 'u-fiscal-chef-service', { decision: 'APPROUVEE', reason: 'Conditions réunies' })).json().status).toBe('APPROUVEE');
    const activeBefore = Number((await req('GET', '/v1/fiscal/exemptions/registre', 'u-fiscal-chef-service')).json().indicators[0].value);
    const r1 = (await req('POST', '/v1/fiscal/exemptions/rappels', 'u-fiscal-chef-service')).json();
    expect(r1.created.map((r: { kind: string }) => r.kind)).toEqual(['ECHEANCE_PROCHE']);
    expect((await req('POST', '/v1/fiscal/exemptions/rappels', 'u-fiscal-chef-service')).json().created).toHaveLength(0);
    clock.advance(25 * 86_400_000);
    const r2 = (await req('POST', '/v1/fiscal/exemptions/rappels', 'u-fiscal-chef-service')).json();
    expect(r2.created.map((r: { kind: string }) => r.kind)).toEqual(['EXPIREE']);
    const reg = (await req('GET', '/v1/fiscal/exemptions/registre', 'u-fiscal-chef-service')).json();
    expect(reg.indicators.map((i: { code: string }) => i.code)).toEqual(['EXONERATIONS_ACTIVES', 'MONTANTS', 'ANOMALIES']);
    expect(Number(reg.indicators[0].value)).toBe(activeBefore - 1);
    expect(reg.reminders).toHaveLength(2);
    expect(app.ctx.audit.list({ action: 'exemption.reminder' }).total).toBe(2);
    expect(reg.reminders[0].notified).toContain(DEMO.taxpayerId);
    // Révision automatique d'une exonération sans échéance : due douze mois après l'effet (par défaut).
    const svc = (app.ctx.ext.fiscal as { exemptions: { reviewDate(x: unknown): string; exemptions: { get(id: string): unknown } } }).exemptions;
    expect(svc.reviewDate({ ...(svc.exemptions.get(id) as object), validTo: undefined, validFrom: '2026-09-26' })).toBe('2027-09-26');
    // Concentration sur un agent instructeur : alerte proposée à l'audit (aucune mesure automatique).
    const ex = (app.ctx.ext.fiscal as { exemptions: { exemptions: { insert(x: unknown): unknown }; concentrationAlerts(): { dimension: string }[] } }).exemptions;
    for (let i = 0; i < 3; i++) ex.exemptions.insert({ id: `EXO-TEST-${i}`, kind: 'EXONERATION', taxpayerId: DEMO.taxpayerId, grounds: 'Test', proofs: [], validFrom: '2026-09-26', status: 'APPROUVEE', requestedBy: 'u-contribuable', requestedAt: '2026-09-26T09:00:00Z', steps: [{ step: 'INSTRUCTION', userId: 'u-guichet', roles: ['R12'], decision: 'FAVORABLE', reason: 'x', at: '2026-09-26T09:00:00Z' }, { step: 'DECISION', userId: `decideur-${i}`, roles: ['R07'], decision: 'FAVORABLE', reason: 'x', at: '2026-09-26T09:00:00Z' }] });
    expect(ex.concentrationAlerts().some((a) => a.dimension === 'AGENT')).toBe(true);
  });
});
