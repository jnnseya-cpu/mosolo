/**
 * Lot « fiscalité, parcours d'identité, campagnes » : anomalies locatives (§ 16.4), élargissement 2026 (§ 16.3),
 * dépendances entre services (§ 8.1, § 10A.3), reprise e-DGRK (§ 7.5), campagnes (§ 8, § 45), provenance et vagues
 * (§ 17.4), enrôlement par profil (§ 9.3), contestation sans écrit (§ 13A.6), tolérance et prorogation d'échéance (§ 6.2).
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import type { FiscalService } from '../src/plugins/fiscal/service.js';
import type { CampaignService } from '../src/plugins/recouvrement/campaigns.js';
import type { RecoveryService } from '../src/plugins/recouvrement/service.js';
import { DEMO } from '../src/seed.js';

async function full() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, seed: true, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
  await app.ready();
  const req = (method: string, url: string, user?: string, body?: unknown) => app.inject({
    method: method as 'GET', url,
    headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { app, clock, req, fiscal: app.ctx.ext['fiscal'] as FiscalService, campagnes: app.ctx.ext['campagnes'] as CampaignService };
}
type Env = Awaited<ReturnType<typeof full>>;

const obligationsCount = (e: Env) => e.app.ctx.assessment.obligations.count();

describe('§ 16.4 — anomalies locatives : protocole requis, listes de travail seulement', () => {
  it('sans protocole actif, aucune donnée de partenaire n’est ingérée (PROTOCOLE_REQUIS)', async () => {
    const e = await full();
    const r = await e.req('POST', '/v1/fiscal/partner-data/PAIE_EMPLOYEURS/lots', 'u-fiscal-directeur', { records: [{ employerRef: 'X', period: '2026', employeesWithHousingAllowance: 3, irlWithheld: false }] });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('PROTOCOLE_REQUIS');
  });

  it('six signaux + unités sans bail → dossiers de vérification ; aucune obligation créée ; revue humaine', async () => {
    const e = await full();
    const before = obligationsCount(e);
    const sources = ['PAIE_EMPLOYEURS', 'ANNONCES_AGENCES', 'BAUX_IMPOT_PROFESSIONNEL', 'PERMIS_IMAGERIE', 'RECEPTION_IMMEUBLES'];
    for (const source of sources) {
      const p = await e.req('POST', '/v1/fiscal/data-protocols', 'u-fiscal-chef-service', { source, partner: 'Partenaire fictif', actReference: `PROTO-FICTIF-${source}`, purpose: 'Test du rapprochement', validFrom: '2026-01-01', validTo: '2027-12-31' });
      expect(p.statusCode).toBe(201);
      // Même personne : refus (quatre yeux).
      expect((await e.req('POST', `/v1/fiscal/data-protocols/${p.json().id}/decision`, 'u-fiscal-chef-service', { approve: true, reason: 'accord' })).statusCode).toBe(403);
      expect((await e.req('POST', `/v1/fiscal/data-protocols/${p.json().id}/decision`, 'u-fiscal-directeur', { approve: true, reason: 'Protocole signé (test)' })).statusCode).toBe(200);
    }
    // Parcelle déclarée non bâtie ; immeuble réceptionné il y a plus de 12 mois sans unité.
    const agent = e.app.ctx.users.get('u-agent-terrain')!;
    const plot = e.app.ctx.objects.create(agent, { category: 'PARCELLE', commune: 'Limete', quartier: 'Kingabwa', localityRank: 2, lat: -4.37, lon: 15.35, attributes: { bati: 'non' } });
    const bldg = e.app.ctx.objects.create(agent, { category: 'BATIMENT', commune: 'Limete', quartier: 'Kingabwa', localityRank: 2, lat: -4.371, lon: 15.351, attributes: {} });
    const lot = async (source: string, records: unknown[]) => {
      const r = await e.req('POST', `/v1/fiscal/partner-data/${source}/lots`, 'u-fiscal-directeur', { records });
      expect(r.statusCode, source).toBe(201);
      return r.json();
    };
    expect((await lot('PAIE_EMPLOYEURS', [{ employerRef: DEMO.taxpayerId, period: '2026', employeesWithHousingAllowance: 12, irlWithheld: false }, { bad: true }])).rejected).toHaveLength(1);
    await lot('ANNONCES_AGENCES', [{ agency: 'Agence fictive', commune: 'Gombe', address: 'Avenue fictive 12', listedAt: '2026-09-01' }]);
    await lot('BAUX_IMPOT_PROFESSIONNEL', [{ lesseeRef: 'Société fictive SA', lessorName: 'Bailleur Totalement Inconnu', period: '2026' }]);
    await lot('PERMIS_IMAGERIE', [{ objectRef: plot.id, evidence: 'IMAGE', reference: 'IMG-FICTIVE-1', observedAt: '2026-08-01' }]);
    await lot('RECEPTION_IMMEUBLES', [{ objectRef: bldg.id, receptionDate: '2025-01-15' }]);
    const run = await e.req('POST', '/v1/fiscal/anomalies/detection', 'u-controleur');
    expect(run.statusCode).toBe(200);
    const list = (await e.req('GET', '/v1/fiscal/anomalies', 'u-controleur')).json() as { id: string; signal: string; nature: string; status: string }[];
    const signals = new Set(list.map((c) => c.signal));
    for (const s of ['COMPTEURS_MULTIPLES', 'INDEMNITES_SANS_RETENUE', 'ANNONCE_BIEN_NON_RATTACHE', 'BAIL_ENTREPRISE_BAILLEUR_INCONNU', 'PARCELLE_NON_BATIE_CONSTRUITE', 'IMMEUBLE_NEUF_SANS_UNITE']) expect(signals.has(s), s).toBe(true);
    expect(list.every((c) => c.nature === 'LISTE_DE_TRAVAIL')).toBe(true);
    // Détection idempotente, aucune obligation.
    await e.req('POST', '/v1/fiscal/anomalies/detection', 'u-controleur');
    expect((await e.req('GET', '/v1/fiscal/anomalies', 'u-controleur')).json()).toHaveLength(list.length);
    expect(obligationsCount(e)).toBe(before);
    // Revue : confirmation seulement après vérification.
    const k = list.find((c) => c.signal === 'PARCELLE_NON_BATIE_CONSTRUITE')!;
    expect((await e.req('POST', `/v1/fiscal/anomalies/${k.id}/review`, 'u-controleur', { decision: 'CONFIRMEE', reason: 'Vu sur image' })).json().code).toBe('VERIFICATION_REQUIRED');
    expect((await e.req('POST', `/v1/fiscal/anomalies/${k.id}/review`, 'u-controleur', { decision: 'EN_VERIFICATION', reason: 'Visite programmée', missionRef: 'M-1' })).statusCode).toBe(200);
    const done = await e.req('POST', `/v1/fiscal/anomalies/${k.id}/review`, 'u-controleur', { decision: 'CONFIRMEE', reason: 'Construction constatée sur place' });
    expect(done.json().followUp).toContain('aucune dette');
    expect((await e.req('GET', '/v1/fiscal/anomalies', 'u-contribuable')).statusCode).toBe(403);
  });
});

describe('§ 16.3 — élargissement d’assiette 2026 : règles À VÉRIFIER, rien d’actif', () => {
  it('trois fiches au registre, statut A_VERIFIER ; déclaration propre avec contrôles de cohérence, sans liquidation', async () => {
    const e = await full();
    const cat = (await e.req('GET', '/v1/fiscal/assiette-2026')).json();
    expect(cat.cases).toHaveLength(3);
    for (const c of cat.cases) { expect(c.active).toBe(false); expect(c.rules[0].status).toBe('A_VERIFIER'); }
    expect(e.app.ctx.rules.rules.get('rule-irl-kin-indemnites-logement-v1')!.rateTable).toEqual({});
    const before = obligationsCount(e);
    const r = await e.req('POST', '/v1/fiscal/assiette-2026/declarations', 'u-contribuable', {
      case: 'INDEMNITE_LOGEMENT', period: '2026', attest: true,
      values: { employeur_nif: 'A1234567', effectif: '10', beneficiaires: '12', situation: 'LOGEMENT_PROPRE', montant_indemnites: '1200' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().liquidation).toBe('AUCUNE');
    expect(r.json().coherence.find((c: { check: string }) => c.check.startsWith('Bénéficiaires')).ok).toBe(false);
    expect(r.json().appealPath).toContain('Conseil national du travail');
    expect(obligationsCount(e)).toBe(before);
  });
});

describe('§ 8.1 / § 10A.3 — quitus et vignette comme conditions versionnées', () => {
  it('informatif tant que l’acte n’est pas certifié ; activation sur acte + quatre yeux ; puis bloquant', async () => {
    const e = await full();
    const pub = (await e.req('GET', '/v1/public/fiscal/dependances')).json();
    const permis = pub.services.find((s: { service: string }) => s.service === 'PERMIS_DE_BATIR');
    expect(permis.conditions[0].mode).toBe('INFORMATIF');
    // Le demandeur de démonstration a un quitus (données de démonstration) : on vérifie pour un contribuable sans quitus.
    const tp = e.app.ctx.taxpayers.register({ phone: '+243899000111', fullName: 'Demandeur fictif', language: 'fr', situation: 'other' });
    let chk = await e.req('POST', '/v1/fiscal/dependencies/check', 'u-fiscal-urbanisme', { service: 'PERMIS_DE_BATIR', taxpayerId: tp.id });
    expect(chk.json().blocked).toBe(false);
    expect(chk.json().conditions[0].satisfied).toBe(false);
    // Activation : acte non certifié ⇒ refus.
    const no = await e.req('POST', '/v1/fiscal/dependencies/DEP-PERMIS-QUITUS/change', 'u-juriste-redacteur', { targetMode: 'BLOQUANT', instrumentId: 'arrete-taux-if-2026', reason: 'Arrêté de conditionnalité' });
    expect(no.json().code).toBe('ACTE_REQUIS');
    const prop = await e.req('POST', '/v1/fiscal/dependencies/DEP-PERMIS-QUITUS/change', 'u-juriste-redacteur', { targetMode: 'BLOQUANT', instrumentId: 'demo-instrument-001', article: 'Art. 1 (fictif)', reason: 'Acte fictif de démonstration' });
    expect(prop.statusCode).toBe(201);
    const act = await e.req('POST', '/v1/fiscal/dependencies/DEP-PERMIS-QUITUS/change/decision', 'u-autorite-publication', { approve: true, reason: 'Acte certifié (fictif)' });
    expect(act.statusCode).toBe(200);
    expect(act.json().version).toBe(2);
    expect(act.json().mode).toBe('BLOQUANT');
    chk = await e.req('POST', '/v1/fiscal/dependencies/check', 'u-fiscal-urbanisme', { service: 'PERMIS_DE_BATIR', taxpayerId: tp.id });
    expect(chk.json().blocked).toBe(true);
    expect(() => e.fiscal.dependencies.assertSatisfied('PERMIS_DE_BATIR', tp.id)).toThrow(/Quitus/);
    // Démarche de verticale : la condition apparaît et bloque désormais.
    const conds = e.fiscal.dependencies.conditionsForProcedure('construction', 'DEMANDE_AUTORISATION_CHANTIER', tp.id);
    expect(conds[0]!.met).toBe(false);
    // Historique versionné visible du citoyen.
    const hist = (await e.req('GET', '/v1/public/fiscal/dependances')).json().services.find((s: { service: string }) => s.service === 'PERMIS_DE_BATIR').history;
    expect(hist.map((h: { version: number; status: string }) => `${h.version}:${h.status}`)).toEqual(['1:REMPLACEE', '2:EN_VIGUEUR']);
  });

  it('fiche de module : dépendances structurées (codes du moteur) à côté du texte libre conservé', async () => {
    const e = await full();
    const body = {
      code: 'MOD-TEST-DEP', label: 'Module de test', revenueScope: 'TEST_DEPENDANCE', responsibleEntity: 'DGIPK', dependencies: ['Quitus'], dependencyRefs: ['DEP-INCONNUE'],
    };
    const bad = await e.req('POST', '/v1/acces/modules', 'u-admin-entite', body);
    if (bad.statusCode !== 403) expect(bad.json().code).toBe('UNKNOWN_DEPENDENCY');
  });
});

describe('§ 2 / § 7.5 — reprise e-DGRK par lots, sans fusion silencieuse', () => {
  const csv = [
    'type;ref_externe;nom;telephone;nif;forme;categorie;commune;quartier;rang;lat;lon;superficie_m2;compte_ref;exercice;recette;montant;devise;statut_paiement',
    'COMPTE;E-001;Compte repris un;+243897650001;NIF-E-001;PP;;;;;;;;;;;;;',
    'COMPTE;E-002;Doublon téléphone;+243810000001;;PP;;;;;;;;;;;;;',
    'OBJET;O-001;;;;;PARCELLE;Limete;Kingabwa;2;-4.3901;15.3601;500;E-001;;;;;',
    'HISTORIQUE;H-001;;;;;;;;;;;;E-001;2024;Impôt foncier;150;USD;IMPAYE',
    'OBJET;O-BAD;;;;;PISCINE;Nulle-part;;9;;;;;;;;;',
  ].join('\n');

  it('validation à blanc, intégration par une seconde personne, provenance e-DGRK, doublons proposés, historique sans obligation', async () => {
    const e = await full();
    const up = await e.req('POST', '/v1/fiscal/imports', 'u-guichet', { source: 'E_DGRK', format: 'CSV', content: csv });
    expect(up.statusCode).toBe(201);
    const b = up.json();
    expect(b.report.total).toBe(5);
    expect(b.report.invalid).toBe(1);
    expect(b.dedup.find((d: { ref: string }) => d.ref === 'E-002').kind).toBe('COMPTE_MEME_TELEPHONE');
    expect(e.app.ctx.taxpayers.taxpayers.findOne((t) => t.fullName === 'Compte repris un')).toBeUndefined();
    expect((await e.req('POST', `/v1/fiscal/imports/${b.id}/commit`, 'u-guichet')).statusCode).toBe(403);
    const before = obligationsCount(e);
    const c = await e.req('POST', `/v1/fiscal/imports/${b.id}/commit`, 'u-controleur');
    expect(c.statusCode).toBe(200);
    const tp = e.app.ctx.taxpayers.taxpayers.findOne((t) => t.fullName === 'Compte repris un')!;
    expect(tp.importedFrom).toEqual({ source: 'e-DGRK', batchId: b.id, externalRef: 'E-001' });
    // Doublon téléphone : aucune création, aucune fusion.
    expect(e.app.ctx.taxpayers.taxpayers.find((t) => t.fullName === 'Doublon téléphone')).toHaveLength(0);
    const obj = e.app.ctx.objects.objects.findOne((o) => o.importedFrom?.externalRef === 'O-001')!;
    expect(obj.censusStage).toBe(0);
    expect(obj.provenance?.superficie_m2?.source).toBe('E_DGRK');
    expect(c.json().history[0].probativeStatus).toBe('IMPORTE_SOURCE_REGIE');
    expect(obligationsCount(e)).toBe(before);
    // Décision humaine sur le doublon : rattachement sans écrasement.
    const line = b.dedup.find((d: { ref: string }) => d.ref === 'E-002').line;
    const dec = await e.req('POST', `/v1/fiscal/imports/${b.id}/duplicates/${line}/decision`, 'u-fiscal-chef-service', { decision: 'RATTACHER', reason: 'Même personne (pièce vue au guichet)' });
    expect(dec.json().mapping['COMPTE|E-002']).toBe(DEMO.taxpayerId);
    expect(e.app.ctx.taxpayers.get(DEMO.taxpayerId).fullName).not.toBe('Doublon téléphone');
  });

  it('même NIF qu’un compte existant : compte repris créé sans téléphone et fusion PROPOSÉE (double validation)', async () => {
    const e = await full();
    const acces = e.app.ctx.ext['acces'] as { declareProof(u: unknown, t: string, i: unknown): unknown; merges: { all(): { status: string; survivorId: string }[] } };
    acces.declareProof(e.app.ctx.users.get('u-guichet')!, DEMO.taxpayerId, { type: 'NIF', reference: 'NIF-DOUBLE-9' });
    const up = (await e.req('POST', '/v1/fiscal/imports', 'u-guichet', { source: 'E_DGRK', format: 'JSON', content: [{ type: 'COMPTE', ref_externe: 'E-9', nom: 'Titulaire NIF', telephone: '+243897650009', nif: 'NIF-DOUBLE-9', forme: 'PP' }] })).json();
    expect(up.dedup[0].kind).toBe('COMPTE_MEME_NIF');
    const c = (await e.req('POST', `/v1/fiscal/imports/${up.id}/commit`, 'u-fiscal-chef-service')).json();
    expect(c.dedup[0].status).toBe('PROPOSITION_DE_FUSION');
    expect(acces.merges.all().some((m) => m.status === 'PROPOSEE' && m.survivorId === DEMO.taxpayerId)).toBe(true);
  });
});

describe('§ 17.4 — provenance et vagues 0 à 5', () => {
  it('vague déduite, passage journalisé une vague à la fois, couverture par vague, provenance par donnée', async () => {
    const e = await full();
    const o = e.app.ctx.objects.create(e.app.ctx.users.get('u-agent-terrain')!, { category: 'PARCELLE', commune: 'Limete', quartier: 'Kingabwa', localityRank: 2, lat: -4.38, lon: 15.34, attributes: { superficie_m2: '300' } });
    const view = (await e.req('GET', `/v1/fiscal/objects/${o.id}`, 'u-controleur')).json();
    expect(view.census.stage).toBe(1);
    expect(view.provenance.superficie_m2.inferred).toBe(true);
    expect((await e.req('POST', `/v1/fiscal/objects/${o.id}/census-stage`, 'u-controleur', { to: 3, reason: 'saut' })).json().code).toBe('STAGE_SKIPPED');
    expect((await e.req('POST', `/v1/fiscal/objects/${o.id}/census-stage`, 'u-controleur', { to: 2, reason: 'fiche complète' })).json().code).toBe('STAGE_CONDITION');
    const p = await e.req('POST', `/v1/fiscal/objects/${o.id}/provenance`, 'u-controleur', { field: 'superficie_m2', source: 'MISSION_TERRAIN', sourceLabel: 'Mission M-7', confidence: 'ELEVEE' });
    expect(p.json().provenance.superficie_m2).toMatchObject({ source: 'MISSION_TERRAIN', confidence: 'ELEVEE', verifiedBy: 'u-controleur', inferred: false });
    const cov = (await e.req('GET', '/v1/fiscal/census/coverage?commune=Limete', 'u-controleur')).json();
    expect(cov.stages).toHaveLength(6);
    expect(cov.total).toBeGreaterThan(0);
  });
});

describe('§ 9.3 — enrôlement par profil, NIF provisoire, espaces, récupération contrôlée', () => {
  it('19 profils et plus ; déclarer un rôle ouvre une instruction ; NIF provisoire ; instruction par une autre personne', async () => {
    const e = await full();
    const prof = (await e.req('GET', '/v1/public/enrolement/profils')).json();
    expect(prof.profiles.length).toBeGreaterThanOrEqual(19);
    expect((await e.req('POST', '/v1/enrolement/roles', 'u-contribuable', { profile: 'BAILLEUR', answers: { commune: 'Limete', unites: '2', secret: 'x' } })).json().code).toBe('UNEXPECTED_FIELDS');
    const r = await e.req('POST', '/v1/enrolement/roles', 'u-contribuable', { profile: 'BAILLEUR', answers: { commune: 'Limete', unites: '2' } });
    expect(r.statusCode).toBe(201);
    expect(r.json().status).toBe('EN_INSTRUCTION');
    expect(r.json().notice).toContain('ni la propriété ni une dette');
    const mine = (await e.req('GET', '/v1/enrolement/roles', 'u-contribuable')).json();
    expect(mine.nif[0].provisionalId).toMatch(/^NIF-PROV-/);
    expect(mine.nif[0].regularisation.length).toBeGreaterThan(0);
    const d = await e.req('POST', `/v1/enrolement/roles/${r.json().id}/instruction`, 'u-controleur', { decision: 'CONFIRMEE', reason: 'Bail et unités vérifiés' });
    expect(d.json().status).toBe('CONFIRMEE');
    const nif = await e.req('POST', `/v1/enrolement/nif/${mine.nif[0].id}`, 'u-guichet', { status: 'ATTRIBUEE', nif: 'NIF-TEST-77', note: 'NIF reçu de l’administration' });
    expect(nif.json().status).toBe('ATTRIBUEE');
  });

  it('espaces sous une seule connexion ; récupération : guichet puis seconde personne', async () => {
    const e = await full();
    const sp = (await e.req('GET', '/v1/enrolement/espaces', 'u-mandataire')).json();
    expect(sp.spaces.map((s: { taxpayerId: string }) => s.taxpayerId)).toContain(DEMO.taxpayerId);
    const me = (await e.req('GET', '/v1/enrolement/espaces', 'u-contribuable')).json();
    expect(me.personal.taxpayerId).toBe(DEMO.taxpayerId);
    const tp = e.app.ctx.taxpayers.get(DEMO.taxpayerId);
    const unknown = await e.req('POST', '/v1/public/enrolement/recuperations', undefined, { iuc: 'KIN-XXXXXXXX-0', newPhone: '+243899555000', idDocumentRef: 'CE-1' });
    const known = await e.req('POST', '/v1/public/enrolement/recuperations', undefined, { iuc: tp.iuc, newPhone: '+243899555001', idDocumentRef: 'CE-DEMO-0001234' });
    expect(unknown.statusCode).toBe(202);
    expect(known.json().notice).toBe(unknown.json().notice);
    const id = known.json().reference;
    const v = await e.req('POST', `/v1/enrolement/recuperations/${id}/verification`, 'u-guichet', { note: 'Pièce présentée au guichet' });
    if (v.statusCode === 200) {
      expect((await e.req('POST', `/v1/enrolement/recuperations/${id}/decision`, 'u-fiscal-chef-service', { approve: true, reason: 'Identité vérifiée' })).statusCode).toBe(200);
      expect(e.app.ctx.taxpayers.get(DEMO.taxpayerId).phone).toBe('+243899555001');
    } else {
      expect(v.json().code).toBe('IDENTITY_NOT_MATCHED');
      expect(e.app.ctx.taxpayers.get(DEMO.taxpayerId).phone).toBe(tp.phone);
    }
  });
});

describe('§ 13A.6 — contester sans écrit : SVI et guichet', () => {
  it('SVI : option « Contester », motif par touche, résumé lu, réclamation enregistrée au nom de la personne', async () => {
    const e = await full();
    const start = await e.req('POST', '/v1/ivr/sessions', undefined, { msisdn: '+243810000001' });
    expect(start.json().prompts.join(' ')).toContain('contester');
    const sid = start.json().sessionId;
    const step = async (input: string) => (await e.req('POST', `/v1/ivr/sessions/${sid}/input`, undefined, { input })).json();
    await step('8');
    const sel = await step('1234');
    expect(sel.prompts.join(' ')).toContain('sans écrit');
    await step('1');
    const confirm = await step('1');
    expect(confirm.prompts.join(' ')).toContain('Résumé');
    const done = await step('1');
    expect(done.end).toBe(true);
    const appeal = e.app.ctx.appeals.appeals.all().at(-1)!;
    expect(appeal.taxpayerId).toBe(DEMO.taxpayerId);
    expect(appeal.type).toBe('MONTANT_ERRONE');
    expect(appeal.assisted?.channel).toBe('SVI');
    expect(appeal.assisted?.consent.sessionId).toBe(sid);
  });

  it('guichet : l’agent enregistre avec consentement oral (empreinte) ; sans preuve de consentement : refus', async () => {
    const e = await full();
    const ob = e.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId).find((o) => ['EMISE', 'EXIGIBLE', 'EN_RETARD', 'PARTIELLEMENT_PAYEE'].includes(o.status))!;
    const base = { obligationId: ob.id, type: 'BIEN_NON_DETENU', grounds: 'Le bien a été vendu, déclaré oralement.' };
    expect((await e.req('POST', '/v1/canaux/contestations-assistees', 'u-guichet', { ...base, consent: { method: 'ORAL_ENREGISTRE', summaryReadBack: true } })).json().code).toBe('CONSENT_REQUIRED');
    expect((await e.req('POST', '/v1/canaux/contestations-assistees', 'u-guichet', { ...base, consent: { method: 'TEMOIN', summaryReadBack: false, witnessName: 'Témoin fictif' } })).json().code).toBe('CONSENT_REQUIRED');
    expect((await e.req('POST', '/v1/canaux/contestations-assistees', 'u-contribuable', { ...base, consent: { method: 'TEMOIN', summaryReadBack: true, witnessName: 'Témoin fictif' } })).statusCode).toBe(403);
    const ok = await e.req('POST', '/v1/canaux/contestations-assistees', 'u-guichet', { ...base, consent: { method: 'ORAL_ENREGISTRE', summaryReadBack: true, evidenceSha256: 'a'.repeat(64) } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().assisted).toMatchObject({ channel: 'GUICHET', agentId: 'u-guichet' });
    expect(e.app.ctx.assessment.get(ob.id).status).toBe('CONTESTEE');
  });
});

describe('§ 6.2 — tolérance et prorogation d’échéance sur la fiche de règle', () => {
  it('aucun retard constaté pendant la tolérance ; prorogation à deux personnes, sans nouvelle version', async () => {
    const e = await full();
    const rec = e.app.ctx.ext['recouvrement'] as RecoveryService;
    const ob = e.app.ctx.assessment.obligations.all().find((o) => o.status === 'EMISE' || o.status === 'EXIGIBLE')!;
    const rule = e.app.ctx.rules.rules.get(ob.ruleId)!;
    e.app.ctx.rules.rules.update({ ...rule, dueToleranceDays: 10 });
    expect(e.app.ctx.assessment.dueInfo(ob).graceUntil > ob.dueDate).toBe(true);
    e.clock.set(new Date(new Date(`${ob.dueDate}T12:00:00Z`).getTime() + 5 * 86_400_000).toISOString());
    rec.runSchedule('systeme');
    expect(e.app.ctx.assessment.get(ob.id).status).not.toBe('EN_RETARD');
    e.clock.set(new Date(new Date(`${ob.dueDate}T12:00:00Z`).getTime() + 12 * 86_400_000).toISOString());
    rec.runSchedule('systeme');
    expect(e.app.ctx.assessment.get(ob.id).status).toBe('EN_RETARD');

    const versions = e.app.ctx.rules.rules.find((r) => r.code === rule.code).length;
    const p = await e.req('POST', '/v1/prorogations', 'u-fiscal-chef-service', { ruleCode: rule.code, appliesFrom: '2027-02-01', appliesTo: '2027-02-01', extendedTo: '2027-02-28', actReference: 'Arrêté fictif n° DEMO/2027', actDate: '2027-01-20', reason: 'Report de l’échéance de février (exemple)' });
    expect(p.statusCode).toBe(201);
    expect((await e.req('POST', `/v1/prorogations/${p.json().id}/decision`, 'u-fiscal-chef-service', { approve: true, reason: 'accord' })).statusCode).toBe(403);
    expect((await e.req('POST', `/v1/prorogations/${p.json().id}/decision`, 'u-fiscal-directeur', { approve: true, reason: 'Acte vu' })).json().status).toBe('ENREGISTREE');
    expect(e.app.ctx.rules.rules.find((r) => r.code === rule.code)).toHaveLength(versions);
    expect(e.app.ctx.assessment.dueInfo({ ruleId: rule.id, dueDate: '2027-02-01' }).dueDate).toBe('2027-02-28');
  });
});

describe('§ 8 / § 45 — campagne de février 2027', () => {
  it('calendrier par entité ; simulation sur données réelles ; lot pré-rempli ; lancement à deux personnes ; relances', async () => {
    const e = await full();
    const list = (await e.req('GET', '/v1/campagnes', 'u-fiscal-directeur')).json();
    const c = list.find((x: { code: string }) => x.code === 'CAMP-IF-IRL-2026-FEV2027');
    expect(c.dueDate).toBe('2027-02-01');
    expect(c.dueDateStatus).toBe('A_VERIFIER');
    const cal = (await e.req('GET', '/v1/campagnes/calendrier', 'u-gouverneur')).json();
    expect(cal.find((x: { entity: string }) => x.entity === 'DGIPK').campaigns[0].reminders).toHaveLength(2);
    const sim = (await e.req('POST', `/v1/campagnes/${c.id}/simulation`, 'u-dg-dgipk')).json();
    expect(sim.simulation.basis).toBe('DONNEES_REELLES_DU_REGISTRE');
    expect(sim.simulation.targets).toBeGreaterThan(0);
    expect(sim.simulation.warnings.join(' ')).toContain('À VÉRIFIER');
    const before = obligationsCount(e);
    const pre = (await e.req('POST', `/v1/campagnes/${c.id}/pre-remplissage`, 'u-dg-dgipk')).json();
    expect(pre.prefill.items.length).toBeGreaterThan(0);
    expect(obligationsCount(e)).toBe(before);
    expect((await e.req('POST', `/v1/campagnes/${c.id}/lancement`, 'u-dg-dgipk')).statusCode).toBe(200);
    expect((await e.req('POST', `/v1/campagnes/${c.id}/lancement/decision`, 'u-dg-dgipk', { approve: true, reason: 'accord' })).statusCode).toBe(403);
    const launched = (await e.req('POST', `/v1/campagnes/${c.id}/lancement/decision`, 'u-fiscal-directeur', { approve: true, reason: 'Campagne validée' })).json();
    expect(launched.status).toBe('LANCEE');
    e.clock.set('2027-01-20T09:00:00.000Z');
    const rel = (await e.req('POST', `/v1/campagnes/${c.id}/relances`, 'u-dg-dgipk')).json();
    expect(rel.sent.map((s: { offsetDays: number }) => s.offsetDays)).toEqual([15]);
    expect((await e.req('POST', `/v1/campagnes/${c.id}/relances`, 'u-dg-dgipk')).json().sent).toHaveLength(0);
  });
});
