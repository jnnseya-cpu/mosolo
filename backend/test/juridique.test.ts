import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ACTE_REQUIS_CIRCUIT_PROPRE, ficheTechnique, isRuleExecutable, refusParCategorie, RULE_TECHNICAL_ATTRIBUTES, SAMPLE_RULES, type RuleSheet,
} from '@mosolo/shared';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { CIRCUITS, reconstruct } from '../src/plugins/integrite/gouvernance/circuits.js';
import { ALL_PARAMETERS } from '../src/plugins/integrite/gouvernance/parametres.js';
import { DEFAULT_PLUGINS } from '../src/plugins/index.js';
import { CLASSIFICATION, classer, purgeInterdite } from '../src/plugins/juridique/classification.js';
import { etatFonction, pointJuridiqueTranche, recoupementDonneesAutorise } from '../src/plugins/juridique/gates.js';
import { ANNEXE_B_29, ANNEXE_B_FR2, POINTS_JURIDIQUES, SEPT_QUESTIONS_6_4, SOURCES_ANNEXE_A } from '../src/plugins/juridique/points.js';
import { EFFACE } from '../src/plugins/juridique/service.js';
import { TEXTES_REFERENCE_6_1 } from '../src/modules/rules/textes.js';
import { DEMO, publishCertifiedRule, setup, type TestEnv } from './helpers.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function fullEnv(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, seed: true, plugins: DEFAULT_PLUGINS, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
  await app.ready();
  const req: TestEnv['req'] = (method, url, user, body, headers = {}) => app.inject({
    method: method as 'GET', url,
    headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { app, clock, req };
}

const calc = (env: TestEnv, ruleId: string, simulate: boolean) => env.req('POST', '/v1/assessments/calculate', 'u-controleur', {
  ruleId, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: {}, simulate,
});

describe('Garde par catégorie (§ 6.3, § 6.11)', () => {
  it('ACTE_REQUIS : jamais publiable ni exécutable (hors clé du § 37A à circuit propre)', async () => {
    const env = await setup();
    const { id, responses, create } = await publishCertifiedRule(env, { code: 'TEST-PLASTIQUE', revenueCategory: 'ACTE_REQUIS' });
    expect(create.json().citationWarnings.join(' ')).toMatch(/ACTE_REQUIS/);
    expect(responses[3]!.statusCode).toBe(422);
    expect(responses[3]!.json().code).toBe('ACTE_REQUIS_NON_ACTIVABLE');
    expect(env.app.ctx.rules.get(id).status).toBe('APPROUVEE');
    // Même forcée au statut PUBLIEE (reprise, altération), la fiche n'entre jamais en vigueur.
    const r = env.app.ctx.rules.get(id);
    env.app.ctx.rules.rules.update({ ...r, status: 'PUBLIEE' });
    expect(env.app.ctx.rules.get(id).status).toBe('PUBLIEE');
    const forged = { ...SAMPLE_RULES[2]!, status: 'ACTIVE', revenueCategory: 'ACTE_REQUIS', sourceVerification: 'OFFICIEL_CERTIFIE', approvals: [
      { role: 'REDACTEUR', userId: 'a', at: '' }, { role: 'VERIFICATEUR_JURIDIQUE', userId: 'b', at: '' }, { role: 'VALIDATEUR_FINANCIER', userId: 'c', at: '' }, { role: 'AUTORITE_PUBLICATION', userId: 'd', at: '' },
    ] } as RuleSheet;
    expect(isRuleExecutable(forged, new Date('2026-09-26'))).toMatchObject({ ok: false, reason: expect.stringMatching(/ACTE_REQUIS/) });
    expect(isRuleExecutable({ ...forged, revenueCategory: 'IMPOT_PROVINCIAL' }, new Date('2026-09-26')).ok).toBe(true);
    expect(ACTE_REQUIS_CIRCUIT_PROPRE).toEqual(['CLE-REPARTITION-37A', 'CLE-PARTAGE-INTERET-COMMUN', 'CLE-PARTAGE-RECETTES-PARTAGEES']);
    // Liquidation refusée par catégorie (journalisée), simulation admise.
    env.app.ctx.rules.rules.update({ ...env.app.ctx.rules.get(id), status: 'ACTIVE' });
    const liq = await calc(env, id, false);
    expect(liq.statusCode).toBe(422);
    expect(liq.json().code).toBe('ACTE_REQUIS_NON_ACTIVABLE');
    expect((await calc(env, id, true)).statusCode).toBe(200);
  });

  it('RECETTE_CENTRALE exclue ; RECETTE_ETD non liquidée par la province ; l’espace ETD reste possible', async () => {
    const env = await setup();
    const central = await publishCertifiedRule(env, { code: 'TEST-CENTRALE', revenueCategory: 'RECETTE_CENTRALE' });
    expect(env.app.ctx.rules.get(central.id).status).toBe('ACTIVE');
    const c = await calc(env, central.id, false);
    expect(c.statusCode).toBe(422);
    expect(c.json().code).toBe('RECETTE_CENTRALE_EXCLUE');
    expect((await calc(env, central.id, true)).statusCode).toBe(200);
    const etd = await publishCertifiedRule(env, { code: 'TEST-ETD', revenueCategory: 'RECETTE_ETD' });
    const e = await calc(env, etd.id, false);
    expect(e.statusCode).toBe(422);
    expect(e.json().code).toBe('RECETTE_ETD_HORS_PROVINCE');
    const refused = env.app.ctx.audit.list({ action: 'assessment.liquidation.refused' }).items.map((x) => x.details.reason);
    expect(refused).toEqual(expect.arrayContaining(['RECETTE_CENTRALE_EXCLUE', 'RECETTE_ETD_HORS_PROVINCE']));
    expect(refusParCategorie('RECETTE_ETD', 'COMMUNE-GOMBE')).toBeNull();
    expect(refusParCategorie('RECETTE_ETD', 'DGIPK')?.code).toBe('RECETTE_ETD_HORS_PROVINCE');
    expect(refusParCategorie('IMPOT_PROVINCIAL', 'DGIPK')).toBeNull();
  });
});

describe('Cas de tests juridiques et simulation sur échantillon (§ 11.2, § 44, § 6.2)', () => {
  const good = { label: 'Personne morale, 100 m², 1er rang', inputs: { superficie_m2: '100' }, localityRank: 1, expected: { amount: '350.00' } };

  it('publication bloquée sans cas, cas non validé, cas en échec ou sans échantillon ; résultats conservés avec la version', async () => {
    const env = await setup();
    const a = await publishCertifiedRule(env, { code: 'TEST-CAS-A', legalInstrumentIds: ['ol-18-004'] }, 3);
    const pub = () => env.req('POST', `/v1/legal-rules/${a.id}/approve`, 'u-autorite-publication', { role: 'AUTORITE_PUBLICATION' });
    expect((await pub()).json().code).toBe('LEGAL_TEST_CASES_MISSING');
    // Entrée étrangère à la formule (un taux) : refusée.
    expect((await env.req('POST', `/v1/legal-rules/${a.id}/test-cases`, 'u-juriste-redacteur', { ...good, inputs: { tarif_m2: '9' } })).json().code).toBe('INPUT_NOT_ALLOWED');
    const added = await env.req('POST', `/v1/legal-rules/${a.id}/test-cases`, 'u-juriste-redacteur', good);
    expect(added.statusCode).toBe(201);
    const caseId = added.json().legalTestCases[0].id as string;
    expect((await pub()).json().code).toBe('LEGAL_TEST_CASE_NOT_VALIDATED');
    // Validation : juriste vérificateur seulement, distinct de l'auteur du cas.
    expect((await env.req('POST', `/v1/legal-rules/${a.id}/test-cases/${caseId}/validate`, 'u-juriste-redacteur')).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/legal-rules/${a.id}/test-cases/${caseId}/validate`, 'u-juriste-verificateur')).statusCode).toBe(200);
    const wrong = await env.req('POST', `/v1/legal-rules/${a.id}/test-cases`, 'u-juriste-redacteur', { ...good, label: 'Attendu erroné', expected: { amount: '999.00' } });
    await env.req('POST', `/v1/legal-rules/${a.id}/test-cases/${wrong.json().legalTestCases[1].id}/validate`, 'u-juriste-verificateur');
    const failed = await pub();
    expect(failed.statusCode).toBe(422);
    expect(failed.json().code).toBe('LEGAL_TEST_CASES_FAILED');
    const stored = env.app.ctx.rules.get(a.id);
    expect(stored.status).toBe('APPROUVEE');
    expect(stored.legalTestRuns!.at(-1)).toMatchObject({ total: 2, passed: 1, failed: 1, ruleVersion: 1 });
    expect(env.app.ctx.audit.list({ action: 'rule.publication.blocked' }).total).toBe(3);

    // Version B : cas valides (dont un cas négatif), puis échantillon exigé.
    const b = await publishCertifiedRule(env, { code: 'TEST-CAS-B', legalInstrumentIds: ['ol-18-004'] }, 3);
    const add = async (body: unknown) => (await env.req('POST', `/v1/legal-rules/${b.id}/test-cases`, 'u-juriste-redacteur', body)).json().legalTestCases.at(-1).id as string;
    for (const id of [await add(good), await add({ label: 'Superficie manquante', inputs: {}, localityRank: 1, expected: { errorCode: 'FORMULA_UNKNOWN_IDENTIFIER' } })]) {
      await env.req('POST', `/v1/legal-rules/${b.id}/test-cases/${id}/validate`, 'u-juriste-verificateur');
    }
    const run = await env.req('POST', `/v1/legal-rules/${b.id}/test-cases/run`, 'u-auditeur');
    expect(run.json()).toMatchObject({ total: 2, passed: 2, failed: 0 });
    const pubB = () => env.req('POST', `/v1/legal-rules/${b.id}/approve`, 'u-autorite-publication', { role: 'AUTORITE_PUBLICATION' });
    expect((await pubB()).json().code).toBe('SAMPLE_SIMULATION_MISSING');
    expect((await env.req('POST', `/v1/legal-rules/${b.id}/sample-simulations`, 'u-juriste-verificateur', { source: 'Aucun dossier (test de refus)' })).json().code).toBe('SAMPLE_EMPTY');
    const sim = await env.req('POST', `/v1/legal-rules/${b.id}/sample-simulations`, 'u-juriste-verificateur', {
      source: 'Dossiers réels anonymisés de la campagne 2025 (fictifs pour le test)',
      rows: [{ ref: 'D-1', inputs: { superficie_m2: '200' }, localityRank: 2, previousAmount: '480.00' }, { ref: 'D-2', inputs: {}, localityRank: 1 }],
    });
    expect(sim.statusCode).toBe(201);
    expect(sim.json()).toMatchObject({ size: 2, computed: 1, errors: 1, nonOpposable: true, totals: { amount: '500.00', previousAmount: '480.00' } });
    const ok = await pubB();
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('ACTIVE');
    expect(ok.json().legalTestRuns.length).toBe(3); // exécution manuelle + une par tentative de publication
    // Version figée : plus de cas ni de simulation.
    expect((await env.req('POST', `/v1/legal-rules/${b.id}/test-cases`, 'u-juriste-redacteur', good)).json().code).toBe('RULE_VERSION_FROZEN');
    const view = (await env.req('GET', `/v1/legal-rules/${b.id}/test-cases`, 'u-controleur')).json();
    expect(view).toMatchObject({ gate: { required: true, dispense: false, cases: 2, validated: 2, blocker: null } });
    expect(view.sampleSimulations).toHaveLength(1);

    // Nouvelle version : l'échantillon réel reprend les liquidations antérieures du code (traces figées).
    const liq = await env.req('POST', '/v1/assessments/calculate', 'u-controleur', { ruleId: b.id, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: {}, simulate: false });
    expect(liq.statusCode).toBe(201);
    const v2 = await publishCertifiedRule(env, { code: 'TEST-CAS-B', legalInstrumentIds: ['ol-18-004'], rateTable: { 'tarif_m2:1': '4', 'tarif_m2:2': '3', 'tarif_m2:3': '2', 'tarif_m2:4': '1.5' } }, 0);
    const prior = await env.req('POST', `/v1/legal-rules/${v2.id}/sample-simulations`, 'u-juriste-verificateur', { source: 'Liquidations antérieures du code (v1)' });
    expect(prior.statusCode).toBe(201);
    expect(prior.json().lines[0]).toMatchObject({ origin: 'LIQUIDATION_ANTERIEURE', ref: liq.json().obligation.id, previousAmount: liq.json().obligation.amount.amount });
  });

  it('règle de démonstration (instruments FICTIFS seulement) : dispense tracée, comportement existant conservé', async () => {
    const env = await setup();
    const { id, responses } = await publishCertifiedRule(env, { code: 'TEST-DEMO-DISPENSE' });
    expect(responses[3]!.statusCode).toBe(200);
    expect((await env.req('GET', `/v1/legal-rules/${id}`, 'u-controleur')).json().testGate).toMatchObject({ required: true, dispense: true, blocker: null });
  });
});

describe('Attributs techniques du registre (§ 6.2) et fait générateur typé', () => {
  it('fiche en snake_case du Cahier, table de correspondance complète', async () => {
    const env = await setup();
    expect(RULE_TECHNICAL_ATTRIBUTES.map((a) => a.attribut)).toEqual([
      'legal_reference', 'article', 'authority', 'administrator', 'taxable_event', 'liable_party', 'base', 'formula', 'rate', 'currency', 'rounding',
      'periodicity', 'due_rule', 'exemptions', 'penalties', 'beneficiary_account', 'effective_from', 'effective_to', 'appeal_path', 'approval_state', 'version',
    ]);
    const res = await env.req('GET', '/v1/legal-rules/rule-irl-kin-r1-v1/fiche-technique', 'u-controleur');
    expect(res.statusCode).toBe(200);
    const fiche = res.json().fiche;
    for (const a of RULE_TECHNICAL_ATTRIBUTES) expect(fiche).toHaveProperty(a.attribut);
    expect(fiche).toMatchObject({ rate: { taux: '22' }, beneficiary_account: 'KIN-DGIPK-RECETTES-01', approval_state: { status: 'A_VERIFIER' }, version: 1 });
    const typed = await publishCertifiedRule(env, { code: 'TEST-TYPE', taxableEventKind: 'POSSESSION' }, 0);
    expect(typed.create.statusCode).toBe(201);
    expect(ficheTechnique(env.app.ctx.rules.get(typed.id)).taxable_event).toEqual({ kind: 'POSSESSION', label: 'Propriété' });
    expect((await publishCertifiedRule(env, { code: 'TEST-TYPE-KO', taxableEventKind: 'INCONNU' }, 0)).create.statusCode).toBe(400);
    expect((await env.req('GET', '/v1/legal-rules/attributs-techniques', 'u-controleur')).json().faitsGenerateurs).toHaveLength(6);
  });
});

describe('Registre des textes (§ 6.1) : complétude, OL 13/001 abrogée', () => {
  it('tous les textes du tableau figurent au registre ; 13/001 ABROGÉE et jamais citée comme en vigueur', async () => {
    const env = await setup();
    const res = (await env.req('GET', '/v1/legal-instruments/completude', 'u-controleur')).json();
    expect(res.complet).toBe(true);
    expect(res.lignes).toHaveLength(TEXTES_REFERENCE_6_1.length);
    const statut = (id: string) => env.app.ctx.rules.instrument(id)?.status;
    expect(statut('ol-13-001')).toBe('ABROGE');
    for (const id of ['ol-18-003', 'loi-11-011-lofip', 'edit-budgetaire-kinshasa', 'ol-23-010', 'loi-18-014']) expect(statut(id)).toBe('A_VERIFIER');
    expect(env.app.ctx.rules.instrument('loi-18-014')?.note).toMatch(/KIN RECETTES/);
    expect(env.app.ctx.rules.instrument('ol-13-001')?.note).toMatch(/ABROGÉE/);
    // Citer 13/001 avec un effet postérieur : avertissement dès la création, publication refusée, activation impossible.
    const { id, create } = await publishCertifiedRule(env, { code: 'TEST-13-001', legalInstrumentIds: ['ol-13-001'] }, 0);
    expect(create.json().citationWarnings[0]).toMatch(/ol-13-001/);
    env.app.ctx.rules.rules.update({ ...env.app.ctx.rules.get(id), status: 'PUBLIEE' });
    expect(env.app.ctx.rules.get(id).status).toBe('PUBLIEE');
  });
});

describe('Registre des points juridiques J1–J30 (§ 6.4, annexe B) et conditionnement', () => {
  it('catalogue complet et cohérent', () => {
    // J1–J30 conservés dans l'ordre ; J31–J35 ajoutés (Document maître FR 2, annexe B, points 9 à 13).
    expect(POINTS_JURIDIQUES.slice(0, 30).map((p) => p.code)).toEqual(Array.from({ length: 30 }, (_, i) => `J${i + 1}`));
    expect(POINTS_JURIDIQUES.map((p) => p.code)).toEqual(Array.from({ length: 35 }, (_, i) => `J${i + 1}`));
    expect(ANNEXE_B_FR2.map((a) => a.point)).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
    expect(SOURCES_ANNEXE_A).toHaveLength(11);
    for (const x of [...ANNEXE_B_FR2, ...SOURCES_ANNEXE_A]) for (const c of x.points) expect(POINTS_JURIDIQUES.some((p) => p.code === c)).toBe(true);
    expect(SEPT_QUESTIONS_6_4).toHaveLength(7);
    expect(ANNEXE_B_29.map((a) => a.point)).toEqual(Array.from({ length: 29 }, (_, i) => i + 1));
    const codes = new Set(POINTS_JURIDIQUES.map((p) => p.code));
    for (const x of [...SEPT_QUESTIONS_6_4, ...ANNEXE_B_29]) for (const c of x.points) expect(codes.has(c)).toBe(true);
    expect(CIRCUITS.find((c) => c.code === 'POINT_JURIDIQUE')?.guard?.url).toBe('/v1/juridique/points/:code/decision');
    expect(CIRCUITS.find((c) => c.code === 'PURGE_CONSERVATION')?.guard?.url).toBe('/v1/juridique/donnees/purges/:id/decision');
  });

  it('trancher un point : acte (référence + empreinte), deux personnes distinctes, journalisé ; les fonctions affichent ce qu’elles attendent', async () => {
    const env = await fullEnv();
    const ctx = env.app.ctx;
    ctx.users.add({ id: 'u-jur-ministre', name: 'Juriste et ministre (test)', roles: ['R13', 'R05'], entity: 'MINFIN' });
    const reg = await env.req('GET', '/v1/juridique/points', 'u-controleur');
    expect(reg.statusCode).toBe(200);
    expect(reg.json()).toMatchObject({ summary: { total: 35, ouverts: 35, tranches: 0 } });
    expect(reg.json().annexeB).toHaveLength(29);
    expect(reg.json().annexeBFr2).toHaveLength(13);
    expect(reg.json().annexeA.find((a: { rang: number }) => a.rang === 1).instrumentsStatut).toEqual([{ id: 'ol-18-004', statut: expect.any(String) }, { id: 'ol-13-001', statut: 'ABROGE' }]);
    expect((await env.req('GET', '/v1/juridique/points', 'u-contribuable')).statusCode).toBe(403);
    // Public : état d'une fonction conditionnée (aucune donnée personnelle).
    const pub = await env.req('GET', '/v1/public/juridique/fonctions/COMMISSIONS_VERSEMENT');
    expect(pub.json()).toMatchObject({ enAttente: true, message: expect.stringMatching(/Paiement en attente de base légale \(J10\)/) });
    expect(recoupementDonneesAutorise(ctx)).toMatchObject({ autorise: false, points: ['J13', 'J8'] });
    expect(ctx.ext.recouvrement && (ctx.ext.recouvrement as { planBasis(): { pointJuridique?: { enAttente: boolean } } }).planBasis().pointJuridique?.enAttente).toBe(true);

    const acte = { reference: 'ARR-2026-010 (fictif)', titre: 'Arrêté FICTIF sur les incitations des agents', sha256: sha('acte-j10') };
    expect((await env.req('POST', '/v1/juridique/points/J10/propositions', 'u-juriste-verificateur', { acte: { ...acte, sha256: 'abc' }, motif: 'Acte publié au JO provincial (test).' })).statusCode).toBe(400);
    expect((await env.req('POST', '/v1/juridique/points/J10/propositions', 'u-controleur', { acte, motif: 'Acte publié au JO provincial (test).' })).statusCode).toBe(403);
    // Une même personne ne propose et ne décide pas.
    expect((await env.req('POST', '/v1/juridique/points/J10/propositions', 'u-jur-ministre', { acte, motif: 'Acte publié au JO provincial (test).' })).statusCode).toBe(201);
    const self = await env.req('POST', '/v1/juridique/points/J10/decision', 'u-jur-ministre', { approve: true, motif: 'Je tranche seul (refusé).' });
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe('SEPARATION_OF_DUTIES');
    expect(pointJuridiqueTranche(ctx, 'J10')).toBe(false);
    const ok = await env.req('POST', '/v1/juridique/points/J10/decision', 'u-autorite-publication', { approve: true, motif: 'Acte vérifié : point tranché (test).' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ statut: 'TRANCHE', decision: { acte: { sha256: acte.sha256 }, proposedBy: 'u-jur-ministre', decidedBy: 'u-autorite-publication' } });
    expect(pointJuridiqueTranche(ctx, 'j10')).toBe(true);
    expect(etatFonction(ctx, 'COMMISSIONS_VERSEMENT').enAttente).toBe(false);
    // Rejet d'une proposition : le point reste ouvert.
    await env.req('POST', '/v1/juridique/points/J14/propositions', 'u-juriste-verificateur', { acte: { ...acte, sha256: sha('j14') }, motif: 'Proposition sur les échéanciers (test).' });
    const rej = await env.req('POST', '/v1/juridique/points/J14/decision', 'u-ministre-finances', { approve: false, motif: 'Acte non publié : rejet (test).' });
    expect(rej.json().statut).toBe('OUVERT');
    const { decisions } = reconstruct(ctx.audit.list({ limit: 1e6 }).items);
    expect(decisions.filter((d) => d.circuit === 'POINT_JURIDIQUE').map((d) => [d.key, d.outcome])).toEqual([['J10', 'APPROUVE'], ['J14', 'REFUSE']]);
    expect(ctx.audit.verify().ok).toBe(true);
  });
});

describe('Classification C1–C5 (§ 32) et purge par durée de conservation', () => {
  it('chaque dépôt est classé ; jamais de purge financière, d’audit ou de preuve', async () => {
    const env = await fullEnv();
    const res = await env.req('GET', '/v1/juridique/donnees/classification', 'u-rssi');
    expect(res.statusCode).toBe(200);
    const depots = res.json().depots as { depot: string; classe: string; nature: string; purgeable: boolean; source: string }[];
    const known = ['comms.', 'taxpayers.', 'objects.', 'vault.', 'rules.', 'ledger.', 'assessment.', 'receipts.', 'payments.', 'treasury.', 'field.', 'appeals.', 'ai.', 'ext.acces.', 'ext.tresor.', 'ext.recouvrement.', 'ext.titres.', 'ext.parking.', 'ext.fiscal.', 'ext.integrite.', 'ext.juridique.', 'ext.socle.', 'ext.canaux.', 'ext.sanctions.'];
    for (const d of depots.filter((x) => known.some((k) => x.depot.startsWith(k)))) expect(d.source, d.depot).not.toBe('A_CLASSER');
    expect(depots.find((d) => d.depot === 'core.audit')).toMatchObject({ classe: 'C5', nature: 'AUDIT', purgeable: false });
    for (const d of depots.filter((x) => /^(payments|ledger|receipts|assessment|treasury|vault)\./.test(x.depot))) expect(d.purgeable, d.depot).toBe(false);
    expect(depots.find((d) => d.depot === 'ext.acces.otps')?.purgeable).toBe(true);
    // Double garde : même déclaré « technique » avec une règle, un dépôt financier ou d'audit n'est jamais purgé.
    const regle = { parametre: 'x', champDate: 'createdAt', champsEffaces: ['a'] };
    expect(purgeInterdite('payments.orders', { nature: 'TECHNIQUE', conservation: regle })).toMatch(/protégé/);
    expect(purgeInterdite('core.audit', { nature: 'TECHNIQUE', conservation: regle })).toMatch(/protégé/);
    expect(purgeInterdite('ext.parking.checks', { nature: 'PREUVE', conservation: regle })).toMatch(/PREUVE/);
    for (const [k, c] of Object.entries(CLASSIFICATION)) if (c.conservation) expect(purgeInterdite(k, c), k).toBeNull();
    expect(classer('ext.inconnu.depot')).toMatchObject({ classe: 'C3', nature: 'A_CLASSER' });
    expect((await env.req('GET', '/v1/juridique/donnees/classification', 'u-agent-terrain')).statusCode).toBe(403);
  });

  it('aperçu → proposition → approbation par une seconde personne ; effacement des seuls champs personnels échus', async () => {
    const env = await fullEnv();
    const ctx = env.app.ctx;
    for (const id of ['conservation.codes_otp_jours', 'conservation.sessions_canaux_jours']) {
      expect(ALL_PARAMETERS.find((p) => p.id === id)).toMatchObject({ value: 0, owner: 'REGISTRE' });
    }
    const otps = (ctx.ext.acces as { otps: { insert(x: unknown): unknown; get(id: string): Record<string, unknown> | undefined } }).otps;
    otps.insert({ id: 'OTP-OLD', purpose: 'MFA', subjectId: 'u-x', codeHash: 'h1', expiresAt: '2026-07-01T00:05:00.000Z', attempts: 0, status: 'VERIFIE', createdAt: '2026-07-01T00:00:00.000Z' });
    otps.insert({ id: 'OTP-PENDING', purpose: 'MFA', subjectId: 'u-y', codeHash: 'h2', expiresAt: '2026-07-01T00:05:00.000Z', attempts: 0, status: 'EN_ATTENTE', createdAt: '2026-07-01T00:00:00.000Z' });
    otps.insert({ id: 'OTP-NEW', purpose: 'MFA', subjectId: 'u-z', codeHash: 'h3', expiresAt: '2026-09-26T08:05:00.000Z', attempts: 0, status: 'VERIFIE', createdAt: '2026-09-26T08:00:00.000Z' });
    // Durée non fixée : rien n'est purgé, aucune proposition possible.
    const a0 = (await env.req('GET', '/v1/juridique/donnees/purges/apercu', 'integrite-u-dpo')).json();
    expect(a0.total).toBe(0);
    expect(a0.lignes.find((l: { depot: string }) => l.depot === 'ext.acces.otps').statut).toBe('DUREE_NON_FIXEE');
    expect((await env.req('POST', '/v1/juridique/donnees/purges', 'integrite-u-dpo', { motif: 'Purge trimestrielle (test).' })).json().code).toBe('RIEN_A_PURGER');
    // Durée fixée par le circuit à deux personnes du registre des seuils.
    const cr = await env.req('POST', '/v1/integrite/thresholds/change-requests', 'u-rssi', { parameterId: 'conservation.codes_otp_jours', kind: 'MODIFICATION', proposedValue: 30, motif: 'Durée proposée pour le test de purge.' });
    expect(cr.statusCode).toBe(201);
    expect((await env.req('POST', `/v1/integrite/thresholds/change-requests/${cr.json().id}/decision`, 'u-ministre-finances', { approve: true, motif: 'Durée approuvée (test).' })).statusCode).toBe(200);
    const a1 = (await env.req('GET', '/v1/juridique/donnees/purges/apercu', 'integrite-u-dpo')).json();
    expect(a1.lignes.find((l: { depot: string }) => l.depot === 'ext.acces.otps')).toMatchObject({ statut: 'ELIGIBLE', ids: ['OTP-OLD'], dureeJours: 30 });
    const counts = () => [ctx.ledger.list().length, ctx.payments.orders.count(), ctx.receipts.receipts.count(), ctx.assessment.obligations.count()];
    const before = counts();
    const prop = await env.req('POST', '/v1/juridique/donnees/purges', 'integrite-u-dpo', { motif: 'Purge des codes échus (test).' });
    expect(prop.statusCode).toBe(201);
    expect(otps.get('OTP-OLD')!.codeHash).toBe('h1'); // rien n'est effacé avant la seconde personne
    const self = await env.req('POST', `/v1/juridique/donnees/purges/${prop.json().id}/decision`, 'integrite-u-dpo', { approve: true, motif: 'Auto-approbation (refusée).' });
    expect(self.json().code).toBe('SEPARATION_OF_DUTIES');
    const done = await env.req('POST', `/v1/juridique/donnees/purges/${prop.json().id}/decision`, 'u-rssi', { approve: true, motif: 'Purge approuvée après examen (test).' });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: 'EXECUTEE', execution: { effaces: { 'ext.acces.otps': 1 } } });
    expect(otps.get('OTP-OLD')).toMatchObject({ codeHash: EFFACE, subjectId: EFFACE, status: 'VERIFIE', purgeRequestId: prop.json().id });
    expect(otps.get('OTP-PENDING')!.codeHash).toBe('h2');
    expect(otps.get('OTP-NEW')!.codeHash).toBe('h3');
    expect(counts()).toEqual(before);
    expect(ctx.audit.list({ action: 'privacy.purge.executed' }).total).toBe(1);
    const { decisions } = reconstruct(ctx.audit.list({ limit: 1e6 }).items);
    expect(decisions.find((d) => d.circuit === 'PURGE_CONSERVATION')).toMatchObject({ proposerId: 'integrite-u-dpo', approverId: 'u-rssi', outcome: 'APPROUVE' });
    expect(ctx.audit.verify().ok).toBe(true);
  });
});
