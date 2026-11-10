/**
 * Programme — Document maître FR 2, ch. 41 à 48 et annexes A–B :
 *  - chaque texte des référentiels est vérifié MOT POUR MOT contre la source (docs/sources/…txt.md) ;
 *  - chaque preuve citée (fichier de code + symbole, fichier de test + titre exact) existe réellement ;
 *  - registre des risques (carte de chaleur, revue par une personne, revue en retard signalée, audit) ;
 *  - recette (critères, récits, stratégie, suivis du monde réel) ; plan de livraison ; plan des 100 jours ;
 *  - registre des décisions (enregistrement par une personne, validation par une autre, acte et empreinte,
 *    contradiction signalée, verrous calculés) ; refus de l'OL 13/001.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { CIRCUITS, reconstruct } from '../src/plugins/integrite/gouvernance/circuits.js';
import { DEFAULT_PLUGINS } from '../src/plugins/index.js';
import { ANNEXE_B_FR2, SOURCES_ANNEXE_A } from '../src/plugins/juridique/points.js';
import { PILOT_COMMUNES_46, PILOT_CRITERIA_46, PILOT_SEQUENCE_46 } from '../src/plugins/pilotage/planification/model.js';
import {
  CONTRADICTION_SIGNALEE, CRITERES_42, DECISIONS_48, DEVISE_FR2, FICHIER_POSTES_DECISION, IMPACTS, PLAN_100_JOURS_47, PROBABILITES, RECITS_43, RISQUES_41, STRATEGIE_45,
  SUIVIS_EXTERNES, SYNTHESE_48_2, VERSIONS_44, type PreuveCode, type PreuveTest,
} from '../src/plugins/pilotage/recette-programme/referentiels.js';
import { KPI_CATALOGUE } from '../src/plugins/pilotage/kpis.js';
import { DEMO, publishCertifiedRule, type TestEnv } from './helpers.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const norm = (s: string) => s.replace(/[’‘]/g, '\'').replace(/\s+/g, ' ').trim();
const SOURCE = norm(readFileSync(`${ROOT}docs/sources/Document_Maitre_FR_2_nouvelle_version.txt.md`, 'utf8'));
const RAW_SOURCE = readFileSync(`${ROOT}docs/sources/Document_Maitre_FR_2_nouvelle_version.txt.md`, 'utf8').replace(/[’‘]/g, '\'');
const inSource = (s: string) => SOURCE.includes(norm(s));
const row = (...cells: string[]) => RAW_SOURCE.includes(cells.map((c) => c.replace(/[’‘]/g, '\'')).join('\t'));
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

describe('Référentiels du programme : textes cités mot pour mot (Document maître FR 2)', () => {
  it('ch. 41 : 13 risques, probabilité, impact et traitement ; chaque mesure est un élément du traitement', () => {
    expect(RISQUES_41).toHaveLength(13);
    for (const r of RISQUES_41) {
      expect(row(r.risque, PROBABILITES[r.probabilite].libelle, IMPACTS[r.impact].libelle, r.traitement), r.code).toBe(true);
      for (const m of r.mesures) expect(norm(r.traitement).toLowerCase(), `${r.code} ${m.mesure}`).toContain(norm(m.mesure).toLowerCase());
    }
  });

  it('ch. 42, 43, 44, 45 : critères, récits, versions et stratégie de tests', () => {
    // 10 critères du Document maître FR 2, cités mot pour mot ; 5 critères ajoutés (postes de décision, autre lot).
    expect(CRITERES_42).toHaveLength(15);
    for (const c of CRITERES_42.slice(0, 10)) expect(inSource(c.critere), c.code).toBe(true);
    for (const c of CRITERES_42.slice(10)) {
      expect(c.origine, c.code).toMatch(/ch\. 27/);
      // Lot « postes de décision » fusionné : drapeau PENDING_MERGE retiré, preuve = test titré du texte du critère.
      expect(c.preuves[0]).toMatchObject({ fichier: FICHIER_POSTES_DECISION, titre: `« ${c.critere} »` });
      expect(c.preuves[0]!.statut).toBeUndefined();
    }
    expect(RECITS_43).toHaveLength(10);
    for (const r of RECITS_43) expect(row(r.recit, r.criteres), r.code).toBe(true);
    expect(VERSIONS_44.map((v) => v.code)).toEqual(['V0.1', 'V0.5', 'V1.0', 'V1.5', 'V2.0', 'V2.5', 'V3.0']);
    for (const v of VERSIONS_44) {
      expect(row(v.version, v.contenuSource, v.public), v.code).toBe(true);
      for (const c of v.contenus) expect(v.contenuSource, `${v.code} ${c.contenu}`).toContain(c.contenu);
    }
    expect(STRATEGIE_45).toHaveLength(9);
    for (const p of STRATEGIE_45) expect(inSource(p.point), p.code).toBe(true);
  });

  it('ch. 46 : quatre communes (raison, objets), séquence en cinq étapes, sept critères liés aux indicateurs du § 40', () => {
    expect(PILOT_COMMUNES_46.map((c) => c.commune)).toEqual(['Gombe', 'Limete', 'Kalamu', 'Ngaliema']);
    for (const c of PILOT_COMMUNES_46) expect(row(c.commune, c.raison, c.objets), c.commune).toBe(true);
    expect(PILOT_SEQUENCE_46).toHaveLength(5);
    for (const s of PILOT_SEQUENCE_46) expect(inSource(`${s.etape}. ${s.texte}`), String(s.etape)).toBe(true);
    const codes = new Set(KPI_CATALOGUE.map((k) => k.code));
    const crit = Object.entries(PILOT_CRITERIA_46);
    expect(crit).toHaveLength(7);
    for (const [code, c] of crit) {
      expect(inSource(c.texte), code).toBe(true);
      for (const k of c.indicateurs40) expect(codes.has(k), `${code} → ${k}`).toBe(true);
    }
    for (const k of ['PART_ELECTRONIQUE_RECETTES', 'DELAI_PAIEMENT_QUITTANCE', 'DELAI_PAIEMENT_RAPPROCHEMENT', 'RECOURS_DANS_DELAI', 'BAUX_ENREGISTRES', 'COUVERTURE_RECENSEMENT']) {
      expect(crit.some(([, c]) => c.indicateurs40.includes(k)), k).toBe(true);
    }
  });

  it('ch. 47, 48 et annexes A–B : plan des 100 jours, dix décisions, synthèse, sources et points à vérifier', () => {
    expect(PLAN_100_JOURS_47.map((p) => p.jours)).toEqual(['1 à 15', '16 à 30', '31 à 45', '46 à 60', '61 à 80', '81 à 100']);
    for (const p of PLAN_100_JOURS_47) {
      expect(row(p.jours, p.actionsSource, p.responsable), p.code).toBe(true);
      for (const a of p.actions) expect(norm(p.actionsSource), a.id).toContain(norm(a.action));
    }
    expect(DECISIONS_48.map((d) => d.numero)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const d of DECISIONS_48) expect(inSource(`${d.numero}. ${d.decision}`), `décision ${d.numero}`).toBe(true);
    expect(SYNTHESE_48_2).toHaveLength(7);
    for (const s of SYNTHESE_48_2) expect(row(s.objet, s.position), s.objet).toBe(true);
    expect(inSource(DEVISE_FR2)).toBe(true);
    expect(SOURCES_ANNEXE_A).toHaveLength(11);
    for (const a of SOURCES_ANNEXE_A) expect(row(a.source, a.usage, a.fiabilite), String(a.rang)).toBe(true);
    // Annexe B : 12 points dans le texte extrait ; le 13e figure dans le fichier Word de la même version.
    expect(ANNEXE_B_FR2).toHaveLength(13);
    for (const b of ANNEXE_B_FR2.filter((x) => x.point <= 12)) expect(inSource(`${b.point}. ${b.objet}`), String(b.point)).toBe(true);
    expect(ANNEXE_B_FR2[12]!.objet).toMatch(/^Valeur probante de la vignette électronique/);
  });
});

describe('Preuves citées : chaque fichier et chaque test existent réellement', () => {
  const tests: PreuveTest[] = [
    ...RISQUES_41.flatMap((r) => r.mesures.flatMap((m) => m.tests ?? [])),
    ...CRITERES_42.flatMap((c) => c.preuves), ...RECITS_43.flatMap((r) => r.preuves),
    ...STRATEGIE_45.flatMap((p) => p.preuves.filter((x): x is PreuveTest => 'titre' in x)),
  ];
  const codes: PreuveCode[] = [
    ...RISQUES_41.flatMap((r) => r.mesures.flatMap((m) => m.code ?? [])),
    ...STRATEGIE_45.flatMap((p) => p.preuves.filter((x): x is PreuveCode => 'symbole' in x)),
  ];

  it('chaque test cité existe (fichier) et porte exactement le titre cité', () => {
    expect(tests.length).toBeGreaterThan(40);
    // Tolérance EXPLICITE et bornée : seul le fichier du lot « postes de décision » peut attendre la fusion.
    const pending = tests.filter((t) => t.statut === 'PENDING_MERGE');
    expect(pending.length).toBeLessThanOrEqual(5);
    for (const t of pending) expect(t.fichier).toBe(FICHIER_POSTES_DECISION);
    for (const t of tests) {
      if (t.statut === 'PENDING_MERGE') continue;
      const path = `${ROOT}${t.fichier}`;
      expect(existsSync(path), t.fichier).toBe(true);
      const text = readFileSync(path, 'utf8');
      expect(text.includes(`'${t.titre}'`) || text.includes(`\`${t.titre}\``) || text.includes(`"${t.titre}"`), `${t.fichier} — ${t.titre}`).toBe(true);
    }
  });

  it('chaque contrôle cité existe dans le code (fichier et symbole)', () => {
    expect(codes.length).toBeGreaterThan(20);
    for (const c of codes) {
      const path = `${ROOT}${c.fichier}`;
      expect(existsSync(path), c.fichier).toBe(true);
      expect(readFileSync(path, 'utf8').includes(c.symbole), `${c.fichier} — ${c.symbole}`).toBe(true);
    }
  });

  it('chaque critère et chaque récit a au moins un test dédié ; tout élément EXTERNE est suivi', () => {
    for (const c of CRITERES_42) expect(c.preuves.some((p) => p.fichier.endsWith('recette-criteres.test.ts') || p.fichier.startsWith('frontend/') || p.statut === 'PENDING_MERGE' || p.fichier === FICHIER_POSTES_DECISION), c.code).toBe(true);
    for (const r of RECITS_43) expect(r.preuves.some((p) => p.fichier.endsWith('carnet-recits.test.ts')), r.code).toBe(true);
    const suivis = new Set(SUIVIS_EXTERNES.map((s) => s.code));
    for (const p of STRATEGIE_45) {
      for (const s of p.suivis) expect(suivis.has(s), `${p.code} → ${s}`).toBe(true);
      if (p.statut !== 'CONSTRUIT') expect(p.suivis.length, p.code).toBeGreaterThan(0);
    }
    for (const r of RISQUES_41) for (const m of r.mesures) {
      if (m.statut === 'CONSTRUIT') expect((m.code?.length ?? 0) + (m.tests?.length ?? 0), `${r.code} ${m.mesure}`).toBeGreaterThan(0);
      else expect(m.note, `${r.code} ${m.mesure}`).toBeTruthy();
    }
    expect(existsSync(`${ROOT}tools/charge/pic-fin-janvier.mjs`)).toBe(true);
  });
});

describe('Registre des risques (ch. 41)', () => {
  it('carte de chaleur, propriétaire par défaut à confirmer, revue par une personne, revue en retard signalée, audit', async () => {
    const env = await fullEnv();
    const reg = (await env.req('GET', '/v1/pilotage/programme/risques', 'u-gouverneur')).json();
    expect(reg.items).toHaveLength(13);
    expect(reg.carteChaleur.cellules).toHaveLength(16);
    expect(reg.carteChaleur.cellules.flatMap((c: { risques: string[] }) => c.risques).sort()).toEqual(RISQUES_41.map((r) => r.code).sort());
    const rq01 = reg.items.find((x: { code: string }) => x.code === 'RQ01');
    expect(rq01).toMatchObject({ probabilite: 'MOYENNE', impact: 'TRES_ELEVE', criticite: { score: 8, zone: 'ELEVEE' }, proprietaire: 'R16', revueEnRetard: false, prochaineRevue: '2026-12-25' });
    expect(rq01.proprietaireStatut).toMatch(/PAR_DEFAUT/);
    expect((await env.req('GET', '/v1/pilotage/programme/risques', 'u-contribuable')).statusCode).toBe(403);
    // 91 jours plus tard : toutes les revues sont en retard, signalées (jamais closes automatiquement).
    env.clock.advance(91 * 86_400_000);
    const late = (await env.req('GET', '/v1/pilotage/programme/risques', 'u-gouverneur')).json();
    expect(late.synthese.enRetard).toBe(13);
    expect(late.items[0].joursDeRetard).toBe(1);
    // Revue : réservée au propriétaire ou à la supervision ; commentaire obligatoire.
    expect((await env.req('POST', '/v1/pilotage/programme/risques/RQ01/revues', 'u-tresor', { probabilite: 'FAIBLE', impact: 'TRES_ELEVE', commentaire: 'Revue par un rôle non propriétaire' })).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/pilotage/programme/risques/RQ01/revues', 'u-dg-dgipk', { probabilite: 'FAIBLE', impact: 'TRES_ELEVE', commentaire: 'DG de régie, propriétaire d’un autre risque' })).json().code).toBe('NOT_RISK_OWNER');
    expect((await env.req('POST', '/v1/pilotage/programme/risques/RQ01/revues', 'u-autorite-publication', { probabilite: 'FAIBLE', impact: 'TRES_ELEVE', commentaire: 'court' })).statusCode).toBe(400);
    const rev = await env.req('POST', '/v1/pilotage/programme/risques/RQ01/revues', 'u-autorite-publication', { probabilite: 'FAIBLE', impact: 'TRES_ELEVE', commentaire: 'Relevé juridique certifié engagé ; OL 13/001 bloquée (revue fictive).' });
    expect(rev.statusCode).toBe(201);
    expect(rev.json()).toMatchObject({ probabilite: 'FAIBLE', criticite: { score: 4, zone: 'MODEREE' }, revueEnRetard: false, source: { probabilite: 'Moyenne', impact: 'Très élevé' } });
    // Désignation d'un propriétaire : supervision seulement, motivée.
    expect((await env.req('POST', '/v1/pilotage/programme/risques/RQ02/proprietaire', 'u-dg-dgipk', { role: 'R07', motif: 'Auto-désignation refusée' })).statusCode).toBe(403);
    const own = await env.req('POST', '/v1/pilotage/programme/risques/RQ02/proprietaire', 'u-ministre-finances', { role: 'R07', motif: 'Chef de service désigné pour le suivi du risque' });
    expect(own.json()).toMatchObject({ proprietaire: 'R07', proprietaireStatut: 'DESIGNE' });
    expect(env.app.ctx.audit.list({ action: 'programme.risque.reviewed' }).items[0]).toMatchObject({ actor: { id: 'u-autorite-publication' }, resourceId: 'RQ01' });
    expect(env.app.ctx.audit.list({ action: 'programme.risque.owner_designated' }).total).toBe(1);
  });
});

describe('Recette, versions et plan des 100 jours (ch. 42–45, 47)', () => {
  it('recette : 10 critères, 10 récits, 9 points de stratégie ; suivis du monde réel mis à jour par une personne, sur preuve', async () => {
    const env = await fullEnv();
    const r = (await env.req('GET', '/v1/pilotage/programme/recette', 'u-auditeur')).json();
    expect(r.criteres).toHaveLength(15);
    // Lot « postes de décision » fusionné : plus aucune preuve en attente ; les 5 critères C42-11 à C42-15 sont prouvés par son fichier.
    expect(r.criteres.filter((c: { preuves: { statut?: string }[] }) => c.preuves.some((p) => p.statut === 'PENDING_MERGE'))).toHaveLength(0);
    expect(r.criteres.filter((c: { preuves: { fichier: string }[] }) => c.preuves[0]!.fichier === FICHIER_POSTES_DECISION)).toHaveLength(5);
    expect(r.recits).toHaveLength(10);
    expect(r.strategie).toHaveLength(9);
    expect(r.suivis.every((s: { etat: string }) => s.etat === 'A_PLANIFIER')).toBe(true);
    expect(r.strategie.find((p: { code: string }) => p.code === 'S45-8')).toMatchObject({ statut: 'EXTERNE', suivis: [{ code: 'RECETTE_UTILISATEUR_AGENTS' }] });
    expect((await env.req('POST', '/v1/pilotage/programme/recette/suivis/TEST_INTRUSION_TIERS', 'u-rssi', { etat: 'REALISE', motif: 'Test d’intrusion réalisé par un tiers' })).json().code).toBe('PREUVE_REQUISE');
    expect((await env.req('POST', '/v1/pilotage/programme/recette/suivis/TEST_INTRUSION_TIERS', 'u-contribuable', { etat: 'PLANIFIE', motif: 'Tentative de mise à jour' })).statusCode).toBe(403);
    const ok = await env.req('POST', '/v1/pilotage/programme/recette/suivis/TEST_INTRUSION_TIERS', 'u-rssi', { etat: 'PLANIFIE', motif: 'Prestataire indépendant retenu (fictif)', echeance: '2026-12-15' });
    expect(ok.json()).toMatchObject({ etat: 'PLANIFIE', echeance: '2026-12-15' });
    expect(env.app.ctx.audit.list({ action: 'programme.suivi.updated' }).total).toBe(1);
  });

  it('versions V0.1 à V3.0 : construction vérifiée sur les modules chargés, mise en service décidée sur preuve', async () => {
    const env = await fullEnv();
    const v = (await env.req('GET', '/v1/pilotage/programme/versions', 'u-ministre-finances')).json();
    expect(v.items).toHaveLength(7);
    for (const x of v.items) expect(x.construction, x.code).toBe('CONSTRUIT');
    expect(v.items[0]).toMatchObject({ version: 'V0.1 socle interne', public: 'Équipes internes', etat: 'PREVUE' });
    expect(v.communes).toMatchObject({ pilote: ['Gombe', 'Limete', 'Kalamu', 'Ngaliema'], referentiel: 24 });
    expect((await env.req('POST', '/v1/pilotage/programme/versions/V0.1/etat', 'u-ministre-finances', { etat: 'EN_SERVICE', motif: 'Mise en service sans procès-verbal' })).json().code).toBe('PREUVE_REQUISE');
    const s = await env.req('POST', '/v1/pilotage/programme/versions/V0.1/etat', 'u-ministre-finances', { etat: 'EN_RECETTE', motif: 'Recette interne ouverte (fictif)' });
    expect(s.json()).toMatchObject({ code: 'V0.1', etat: 'EN_RECETTE' });
    expect((await env.req('POST', '/v1/pilotage/programme/versions/V0.1/etat', 'u-gouverneur', { etat: 'EN_SERVICE', motif: 'Rôle non habilité', preuve: { reference: 'PV-1', sha256: sha('pv') } })).statusCode).toBe(403);
    // Sans le module de planification, la version V1.0 n'est plus « construite » : la vérification est réelle.
    const partial = buildApp({ clock: new ManualClock('2026-09-26T09:00:00.000Z'), plugins: DEFAULT_PLUGINS.filter((p) => p.name !== 'planification' && p.name !== 'campagnes'), secrets: { auditHmacKey: 'k', providerSecrets: {}, commsProviderKeys: {} } });
    await partial.ready();
    const pv = (await partial.inject({ method: 'GET', url: '/v1/pilotage/programme/versions', headers: { 'x-demo-user': 'u-gouverneur' } })).json();
    expect(pv.items.find((x: { code: string }) => x.code === 'V1.0').construction).toBe('PARTIEL');
  });

  it('100 premiers jours : jour 1 fixé par une personne, actions suivies, instruction de suivi par le circuit existant', async () => {
    const env = await fullEnv();
    const p0 = (await env.req('GET', '/v1/pilotage/programme/cent-jours', 'u-dircab')).json();
    expect(p0.periodes).toHaveLength(6);
    expect(p0.synthese.actions).toBe(18);
    expect(p0.demarrage).toBeNull();
    expect((await env.req('POST', '/v1/pilotage/programme/cent-jours/actions/J001-015.a/etat', 'u-dircab', { etat: 'FAITE', note: 'Décision signée (fictif)' })).json().code).toBe('PLAN_NOT_STARTED');
    const st = await env.req('POST', '/v1/pilotage/programme/cent-jours/demarrage', 'u-gouverneur', { debut: '2026-09-20', motif: 'Décision provinciale de lancement (fictive)' });
    expect(st.json()).toMatchObject({ jour: 7, periodes: [{ debutDate: '2026-09-20', echeance: '2026-10-04' }, { echeance: '2026-10-19' }, {}, {}, {}, { echeance: '2026-12-28' }] });
    const done = await env.req('POST', '/v1/pilotage/programme/cent-jours/actions/J001-015.a/etat', 'u-dircab', { etat: 'FAITE', note: 'Décision signée (fictif)', preuve: { reference: 'DEC-2026-001 (fictif)', sha256: sha('dec') } });
    expect(done.json().periodes[0].actions[0]).toMatchObject({ etat: 'FAITE', enRetard: false });
    const ins = await env.req('POST', '/v1/pilotage/programme/cent-jours/actions/J016-030.a/instruction', 'u-dircab', { entity: 'MINFIN' });
    expect(ins.statusCode).toBe(201);
    const a = ins.json().periodes[1].actions[0];
    expect(a).toMatchObject({ etat: 'EN_COURS', instruction: { status: 'EMISE', deadline: '2026-10-19' } });
    const planif = env.app.ctx.ext.planification as { instructions: { get(id: string): { subject: string } | undefined } };
    expect(planif.instructions.get(a.instruction.id)!.subject).toMatch(/Plan des 100 jours/);
    expect((await env.req('POST', '/v1/pilotage/programme/cent-jours/demarrage', 'u-gouverneur', { debut: '2026-09-01', motif: 'Changement du jour 1 après suivi' })).json().code).toBe('PLAN_STARTED');
    env.clock.set('2026-10-05T09:00:00.000Z');
    const late = (await env.req('GET', '/v1/pilotage/programme/cent-jours', 'u-dircab')).json();
    expect(late.periodes[0].actions.filter((x: { enRetard: boolean }) => x.enRetard).map((x: { id: string }) => x.id)).toEqual(['J001-015.b', 'J001-015.c']);
    expect(env.app.ctx.audit.list({ action: 'programme.plan100.instruction_issued' }).total).toBe(1);
  });
});

describe('Registre des décisions du Gouvernement provincial (ch. 48)', () => {
  it('enregistrement par une personne, validation par une autre, acte et empreinte ; verrous calculés ; contradiction du § 37A signalée', async () => {
    const env = await fullEnv();
    const reg = (await env.req('GET', '/v1/pilotage/programme/decisions', 'u-gouverneur')).json();
    expect(reg.items).toHaveLength(10);
    expect(reg.compte).toMatchObject({ A_PRENDRE: 10, PRISE: 0, REFUSEE: 0 });
    const d = (n: number) => reg.items.find((x: { numero: number }) => x.numero === n);
    expect(d(3).debloque[0]).toMatchObject({ controle: 'OL_13_001_REFUSEE', etat: 'GARDE_ACTIVE' });
    expect(d(7).debloque[0]).toMatchObject({ controle: 'ECHEANCIERS_MOBILE_MONEY', etat: 'ACTE_REQUIS' });
    expect(d(4).debloque[0].etat).toBe('EN_ATTENTE');
    expect(d(10).contradiction).toMatchObject({ texte: CONTRADICTION_SIGNALEE });
    expect(d(10).contradiction.avec).toMatch(/§ 37A/);
    expect(reg.contradictions).toHaveLength(1);
    expect(reg.synthese).toHaveLength(7);
    // Enregistrement : acte (référence, date, empreinte) exigé pour une décision prise.
    expect((await env.req('POST', '/v1/pilotage/programme/decisions/3/enregistrement', 'u-ministre-finances', { statut: 'PRISE', motif: 'Arrêté de refondation signé (fictif)' })).json().code).toBe('ACTE_REQUIS');
    expect((await env.req('POST', '/v1/pilotage/programme/decisions/3/enregistrement', 'u-contribuable', { statut: 'REFUSEE', motif: 'Tentative non habilitée' })).statusCode).toBe(403);
    const acte = { reference: 'ARR-PROV-2026-003 (fictif)', titre: 'Arrêté FICTIF de refondation du référentiel', date: '2026-09-25', sha256: sha('acte-3') };
    const rec = await env.req('POST', '/v1/pilotage/programme/decisions/3/enregistrement', 'u-ministre-finances', { statut: 'PRISE', acte, motif: 'Arrêté de refondation signé (fictif)' });
    expect(rec.statusCode).toBe(201);
    expect(rec.json()).toMatchObject({ statut: 'A_PRENDRE', enAttente: { statut: 'PRISE', par: 'u-ministre-finances', acte: { sha256: acte.sha256 } } });
    // La même personne ne valide pas.
    const self = await env.req('POST', '/v1/pilotage/programme/decisions/3/validation', 'u-ministre-finances', { approve: true, motif: 'Auto-validation (refusée)' });
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe('SEPARATION_OF_DUTIES');
    const val = await env.req('POST', '/v1/pilotage/programme/decisions/3/validation', 'u-gouverneur', { approve: true, motif: 'Acte vérifié et conforme (fictif)' });
    expect(val.json()).toMatchObject({ statut: 'PRISE', acte: { reference: acte.reference }, enregistrePar: 'u-ministre-finances', validePar: 'u-gouverneur' });
    // La décision prise n'a aucun effet automatique : la garde OL 13/001 reste celle du registre des règles.
    expect(val.json().debloque[0].etat).toBe('GARDE_ACTIVE');
    const ol13 = await publishCertifiedRule(env, { code: 'DECISION3-OL13', legalInstrumentIds: ['ol-13-001'] });
    expect(ol13.responses.at(-1)!.json().code).toBe('ABROGATED_INSTRUMENT');
    // Décision 7 prise : le paiement fractionné reste « acte requis » tant que J14 n'est pas tranché par son circuit.
    await env.req('POST', '/v1/pilotage/programme/decisions/7/enregistrement', 'u-dircab', { statut: 'PRISE', acte: { ...acte, reference: 'ACTE-7 (fictif)', sha256: sha('acte-7') }, motif: 'Acte de paiement fractionné adopté (fictif)' });
    const v7 = (await env.req('POST', '/v1/pilotage/programme/decisions/7/validation', 'u-ministre-finances', { approve: true, motif: 'Acte vérifié et conforme (fictif)' })).json();
    expect(v7).toMatchObject({ statut: 'PRISE', debloque: [{ etat: 'ACTE_REQUIS' }] });
    // Rejet d'un enregistrement : la décision redevient à prendre.
    await env.req('POST', '/v1/pilotage/programme/decisions/10/enregistrement', 'u-dircab', { statut: 'REFUSEE', motif: 'Modèle contractuel non retenu (fictif)' });
    const rej = (await env.req('POST', '/v1/pilotage/programme/decisions/10/validation', 'u-gouverneur', { approve: false, motif: 'Enregistrement incomplet : à reprendre' })).json();
    expect(rej).toMatchObject({ statut: 'A_PRENDRE', enAttente: null });
    expect((await env.req('POST', '/v1/pilotage/programme/decisions/3/enregistrement', 'u-dircab', { statut: 'REFUSEE', motif: 'Décision déjà prise, nouvel enregistrement' })).json().code).toBe('DECISION_CLOSE');
    // Circuit à deux personnes reconstitué depuis le journal d'audit.
    expect(CIRCUITS.find((c) => c.code === 'DECISION_GOUVERNEMENT')?.guard?.url).toBe('/v1/pilotage/programme/decisions/:numero/validation');
    const { decisions } = reconstruct(env.app.ctx.audit.list({ limit: 1e6 }).items);
    expect(decisions.filter((x) => x.circuit === 'DECISION_GOUVERNEMENT').map((x) => [x.key, x.outcome])).toEqual([['D3', 'APPROUVE'], ['D7', 'APPROUVE'], ['D10', 'REFUSE']]);
    expect(env.app.ctx.audit.verify().ok).toBe(true);
  });

  it('refus des règles fondées sur l’OL 13/001 : instrument abrogé, liquidation impossible', async () => {
    const env = await fullEnv();
    expect(env.app.ctx.rules.instrument('ol-13-001')).toMatchObject({ status: 'ABROGE', abrogatedBy: 'ol-18-004' });
    const { id, responses } = await publishCertifiedRule(env, { code: 'OL13-REFUS', legalInstrumentIds: ['ol-13-001'] });
    expect(responses.at(-1)!.json()).toMatchObject({ code: 'ABROGATED_INSTRUMENT', instrumentId: 'ol-13-001' });
    const r = await env.req('POST', '/v1/assessments/calculate', 'u-controleur', { ruleId: id, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: {}, simulate: false });
    expect(r.json().code).toBe('RULE_NOT_EXECUTABLE');
  });

  it('synthèse du programme et pilote (ch. 46) : communes, séquence, critères et indicateurs du § 40, communes témoins', async () => {
    const env = await fullEnv();
    const s = (await env.req('GET', '/v1/pilotage/programme', 'u-gouverneur')).json();
    expect(s).toMatchObject({ risques: { total: 13 }, decisions: { A_PRENDRE: 10 }, versions: { total: 7 }, recette: { criteres: 15, recits: 10, pointsStrategie: 9 }, centJours: { actions: 18 } });
    await env.req('POST', '/v1/pilotage/pilote/configuration', 'u-ministre-finances', { startDate: '2026-09-01', controls: ['Masina', 'Lemba'], motif: 'Protocole d’évaluation : témoins désignés' });
    const b = (await env.req('GET', '/v1/pilotage/pilote', 'u-gouverneur')).json();
    expect(b.chapitre46.communes.map((c: { commune: string }) => c.commune)).toEqual(['Gombe', 'Limete', 'Kalamu', 'Ngaliema']);
    expect(b.chapitre46.sequence).toHaveLength(5);
    expect(b.chapitre46.semaine).toBe(4);
    expect(b.chapitre46.sequence[0].enCours).toBe(true);
    expect(b.chapitre46.temoins).toEqual(['Masina', 'Lemba']);
    const c = (code: string) => b.criteria.find((x: { code: string }) => x.code === code);
    expect(c('CONTESTATIONS_DELAI').indicateurs40[0]).toMatchObject({ code: 'RECOURS_DANS_DELAI' });
    expect(c('PART_ELECTRONIQUE').indicateurs40[0].code).toBe('PART_ELECTRONIQUE_RECETTES');
    expect(c('DELAI_QUITTANCE').indicateurs40[0].code).toBe('DELAI_PAIEMENT_QUITTANCE');
    expect(c('ECART_RAPPROCHEMENT').texte46).toBe('écart de rapprochement inférieur à 1 %');
    expect(b.criteria).toHaveLength(7);
    for (const x of b.criteria) expect(x.indicateurs40.every((i: { pilot: unknown; controls: unknown }) => 'pilot' in i && 'controls' in i)).toBe(true);
  });
});
