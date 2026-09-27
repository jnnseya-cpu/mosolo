/**
 * Écrans du programme (Document maître FR 2, ch. 41 à 48) : registre des risques, recette, plan de livraison, plan
 * des 100 jours, décisions du Gouvernement ; compléments du pilote (ch. 46), six états, carte des écarts, calcul IRL.
 * Un test de page par écran, un test d'accessibilité (titre référencé par le référentiel du programme), la navigation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AppProvider } from '../src/context';
import { setDemoUser } from '../src/lib/api';
import { visibleNav } from '../src/components/Shell';
import Risques, { RisquesView } from '../src/modules/pilotage/Risques';
import Recette, { RecetteView } from '../src/modules/pilotage/Recette';
import Versions, { VersionsView } from '../src/modules/pilotage/Versions';
import CentJours, { CentJoursView } from '../src/modules/pilotage/CentJours';
import Decisions, { decisionActions, DecisionsView } from '../src/modules/pilotage/Decisions';
import { Chapitre46View } from '../src/modules/pilotage/Pilote';
import { SixEtats } from '../src/modules/pilotage/Tableaux';
import { GapCartogram } from '../src/modules/pilotage/Assignations';
import { CalculBox } from '../src/modules/fiscal/Declarations';
import type { CentJoursPlan, Decision, PlanVersions, Recette as RecetteData, RegistreDecisions, RegistreRisques } from '../src/modules/pilotage/programme-types';

const hist: never[] = [];
const RISQUES: RegistreRisques = {
  source: 'Document maître FR 2, ch. 41', echelle: 'Échelle qualitative ; rangs par défaut — à confirmer.', regle: 'Revue par une personne.',
  synthese: { total: 2, enRetard: 1, critiques: 0, mesuresExternes: 1 },
  carteChaleur: {
    probabilites: [{ code: 'MOYENNE', libelle: 'Moyenne', rang: 2 }, { code: 'ELEVEE', libelle: 'Élevée', rang: 3 }],
    impacts: [{ code: 'ELEVE', libelle: 'Élevé', rang: 3 }, { code: 'TRES_ELEVE', libelle: 'Très élevé', rang: 4 }],
    cellules: [
      { probabilite: 'MOYENNE', impact: 'ELEVE', score: 6, zone: 'ELEVEE', libelle: 'Élevée', risques: [] },
      { probabilite: 'MOYENNE', impact: 'TRES_ELEVE', score: 8, zone: 'ELEVEE', libelle: 'Élevée', risques: ['RQ01'] },
      { probabilite: 'ELEVEE', impact: 'ELEVE', score: 9, zone: 'CRITIQUE', libelle: 'Critique', risques: ['RQ02'] },
      { probabilite: 'ELEVEE', impact: 'TRES_ELEVE', score: 12, zone: 'CRITIQUE', libelle: 'Critique', risques: [] },
    ],
  },
  items: [
    { code: 'RQ01', risque: 'Référentiel appuyé sur un texte abrogé', traitement: 'Relevé juridique certifié avant paramétrage, blocage technique sans référence légale valide', source: { probabilite: 'Moyenne', impact: 'Très élevé' },
      probabilite: 'MOYENNE', probabiliteLibelle: 'Moyenne', impact: 'TRES_ELEVE', impactLibelle: 'Très élevé', criticite: { score: 8, zone: 'ELEVEE', libelle: 'Élevée' },
      proprietaire: 'R16', proprietaireStatut: 'PAR_DEFAUT — à confirmer', derniereRevue: null, prochaineRevue: '2026-12-25', revueEnRetard: true, joursDeRetard: 3,
      mesures: [{ mesure: 'blocage technique sans référence légale valide', statut: 'CONSTRUIT', code: [{ fichier: 'backend/src/modules/rules/service.ts', symbole: 'ABROGATED_INSTRUMENT' }] }], registreAnterieur: ['R01'], historique: hist },
    { code: 'RQ02', risque: 'Résistance des agents perdant des revenus informels', traitement: 'Primes sur résultats vérifiés, dialogue social préalable', source: { probabilite: 'Élevée', impact: 'Élevé' },
      probabilite: 'ELEVEE', probabiliteLibelle: 'Élevée', impact: 'ELEVE', impactLibelle: 'Élevé', criticite: { score: 9, zone: 'CRITIQUE', libelle: 'Critique' },
      proprietaire: 'R06', proprietaireStatut: 'DESIGNE', derniereRevue: null, prochaineRevue: '2026-12-25', revueEnRetard: false, joursDeRetard: 0,
      mesures: [{ mesure: 'dialogue social préalable', statut: 'EXTERNE', note: 'Action du monde réel.' }], registreAnterieur: [], historique: hist },
  ],
};
const suivi = { code: 'TEST_INTRUSION_TIERS', libelle: 'Test d’intrusion externe par un tiers indépendant', responsable: 'Responsable sécurité', etat: 'A_PLANIFIER', etatLibelle: 'À planifier', echeance: null, preuve: null, historique: hist };
const RECETTE: RecetteData = {
  source: 'FR 2', regle: 'Chaque critère renvoie à son test.',
  criteres: [
    { code: 'C42-04', critere: 'Aucun événement d’audit ne peut être modifié ou supprimé, y compris par le super-administrateur : test d’altération obligatoire.', obligatoire: 'Test d’altération', preuves: [{ fichier: 'backend/test/recette-criteres.test.ts', titre: 'C42-04 — aucun événement d’audit modifié ou supprimé, même par le super-administrateur (test d’altération)' }] },
    { code: 'C42-13', critere: 'Aucun poste de décision ne peut modifier une dette, un paiement, une quittance ou un compte bénéficiaire : test négatif par profil d’autorité.', origine: 'Critère ajouté (ch. 27)', preuves: [{ fichier: 'backend/test/postes-decision-acceptation.test.ts', titre: 'C42-13 — preuve', statut: 'PENDING_MERGE', libelle: 'preuve : lot postes de décision (à relier à la fusion)' }] },
  ],
  recits: [{ code: 'R43-01', recit: 'En tant que Kinois, je veux créer un compte avec mon téléphone pour voir ce que je dois', criteres: 'Code à usage unique ; pièce d’identité facultative au niveau N0 ; aucune obligation affichée sans objet rattaché', preuves: [{ fichier: 'backend/test/carnet-recits.test.ts', titre: 'R43-01 — Kinois' }] }],
  strategie: [{ code: 'S45-8', point: 'Recette utilisateur avec agents réels dans une commune, avant toute mise en production.', statut: 'EXTERNE', preuves: [], suivis: [suivi], note: 'Ne peut être simulée.' }],
  suivis: [suivi],
};
const VERSIONS: PlanVersions = {
  source: 'FR 2', regle: 'Construction vérifiée ; mise en service décidée.', communes: { pilote: ['Gombe', 'Limete', 'Kalamu', 'Ngaliema'], referentiel: 24 },
  items: [{ code: 'V0.1', version: 'V0.1 socle interne', public: 'Équipes internes', construction: 'CONSTRUIT', etat: 'PREVUE', etatLibelle: 'Prévue', preuve: null, historique: hist,
    contenus: [{ contenu: 'Identité', construit: true, socle: [{ cle: 'taxpayers', present: true }], modules: [{ nom: 'acces', present: true }] }] }],
};
const CENT: CentJoursPlan = {
  source: 'FR 2', demarrage: null, jour: null, regle: 'Jour 1 fixé par une personne.', synthese: { actions: 1, faites: 0, enRetard: 0 },
  periodes: [{ code: 'J001-015', jours: '1 à 15', responsable: 'Gouverneur et ministre provincial des Finances', debutDate: null, echeance: null, faites: 0,
    actions: [{ id: 'J001-015.a', action: 'Décision provinciale', etat: 'A_FAIRE', etatLibelle: 'À faire', note: null, enRetard: false, instruction: null, historique: hist }] }],
};
const decision = (over: Partial<Decision> = {}): Decision => ({
  numero: 10, id: 'D10', decision: 'Retenir un modèle contractuel hybride, sans pourcentage automatique sur les recettes publiques, et exiger le séquestre du code source et la réversibilité.',
  statut: 'A_PRENDRE', statutLibelle: 'À prendre', enAttente: null, acte: null, enregistrePar: null, validePar: null, valideLe: null,
  debloque: [{ libelle: 'Clé du § 37A', controle: 'CLE_37A_ACTE_REQUIS', etat: 'INCHANGE', detail: 'Comportement du § 37A inchangé.' }],
  contradiction: { avec: '§ 37A', texte: 'Contradiction signalée au maître d’ouvrage — arbitrage attendu', comportement: 'Le § 37A n’est pas modifié.' }, historique: hist, ...over,
});
const DECISIONS: RegistreDecisions = {
  source: 'FR 2', devise: 'KINSHASA MOSOLO — chaque franc public traçable.', regle: 'Deux personnes.', compte: { A_PRENDRE: 1, PRISE: 0, REFUSEE: 0, aValider: 0 },
  items: [decision()], synthese: [{ objet: 'Pilote', position: '180 jours à Gombe, Limete, Kalamu et Ngaliema, calé sur la campagne de février' }],
  contradictions: [{ numero: 10, avec: '§ 37A', texte: 'Contradiction signalée au maître d’ouvrage — arbitrage attendu', comportement: 'Le § 37A n’est pas modifié.' }],
};

function mockFetch(userId: string, roles: string[]) {
  setDemoUser(userId);
  const bodies: Record<string, unknown> = {
    '/v1/pilotage/programme/risques': RISQUES, '/v1/pilotage/programme/recette': RECETTE, '/v1/pilotage/programme/versions': VERSIONS,
    '/v1/pilotage/programme/cent-jours': CENT, '/v1/pilotage/programme/decisions': DECISIONS,
    '/v1/demo/users': [{ id: userId, name: 'Test', roles, entity: 'GOUVERNORAT' }],
  };
  globalThis.fetch = vi.fn((url: string) => {
    const path = new URL(String(url), 'http://localhost').pathname;
    const b = bodies[path];
    return b !== undefined ? Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })) : Promise.reject(new TypeError('Failed to fetch'));
  }) as unknown as typeof fetch;
}
const wrap = (n: ReactNode) => <AppProvider initialLang="fr"><MemoryRouter>{n}</MemoryRouter></AppProvider>;
afterEach(() => { setDemoUser(null); localStorage.clear(); });

describe('Écrans du programme (ch. 41–48)', () => {
  it('registre des risques : carte de chaleur, revue en retard signalée, mesures reliées aux contrôles', () => {
    mockFetch('u-gouv', ['R01']);
    render(wrap(<RisquesView r={RISQUES} onDone={() => undefined} />));
    expect(screen.getByText('Carte de chaleur des risques (probabilité × impact)')).toBeTruthy();
    expect(screen.getAllByText(/1 revue\(s\) en retard/).length).toBeGreaterThan(0);
    expect(screen.getByText(/En retard de 3 j/)).toBeTruthy();
    expect(screen.getByText('RQ02')).toBeTruthy();
    screen.getAllByRole('button', { name: 'Mesures et revue' })[0]!.click();
  });

  it('recette : critères avec leur test, preuve « à relier à la fusion », suivis du monde réel', async () => {
    mockFetch('u-rssi', ['R28']);
    render(wrap(<RecetteView d={RECETTE} onDone={() => undefined} />));
    expect(screen.getByText(/Critères d’acceptation \(2\)/)).toBeTruthy();
    expect(screen.getAllByText(/à relier à la fusion/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/recette-criteres\.test\.ts/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Test d’intrusion externe par un tiers indépendant').length).toBeGreaterThan(0);
    expect((await screen.findAllByRole('button', { name: 'Mettre à jour' })).length).toBe(1);
  });

  it('plan de livraison : contenu relié aux modules, construction et mise en service', () => {
    mockFetch('u-min', ['R05']);
    render(wrap(<VersionsView p={VERSIONS} onDone={() => undefined} />));
    expect(screen.getByText('V0.1 socle interne')).toBeTruthy();
    expect(screen.getByText('Construit')).toBeTruthy();
    expect(screen.getByText(/Communes du pilote : Gombe, Limete, Kalamu, Ngaliema/)).toBeTruthy();
  });

  it('100 premiers jours : jour 1 non fixé signalé, actions et responsables', () => {
    mockFetch('u-dircab', ['R02']);
    render(wrap(<CentJoursView p={CENT} onDone={() => undefined} />));
    expect(screen.getByText(/Le jour 1 est fixé par la décision provinciale/)).toBeTruthy();
    expect(screen.getByText('Décision provinciale')).toBeTruthy();
    expect(screen.getByText(/Gouverneur et ministre provincial des Finances/)).toBeTruthy();
  });

  it('décisions : contradiction signalée, synthèse finale ; l’enregistreur ne valide pas (aide d’interface)', () => {
    mockFetch('u-gouv', ['R01']);
    render(wrap(<DecisionsView reg={DECISIONS} onDone={() => undefined} />));
    expect(screen.getByText(/Contradiction signalée au maître d’ouvrage — arbitrage attendu/)).toBeTruthy();
    expect(screen.getByText('Position recommandée')).toBeTruthy();
    const pending = decision({ enAttente: { statut: 'PRISE', motif: 'm', par: 'u-min', le: '2026-09-26T09:00:00.000Z' } });
    expect(decisionActions(pending, { id: 'u-min', roles: ['R05'] })).toMatchObject({ valider: false, enregistrer: false });
    expect(decisionActions(pending, { id: 'u-gouv', roles: ['R01'] })).toMatchObject({ valider: true });
    expect(decisionActions(decision(), { id: 'u-dircab', roles: ['R02'] })).toMatchObject({ enregistrer: true, valider: false });
  });

  it('pages : chargement depuis l’API et titre de chaque écran', async () => {
    mockFetch('u-gouv', ['R01']);
    for (const [Page, title, text] of [[Risques, 'Registre des risques', 'RQ01'], [Recette, 'Recette — critères d’acceptation', 'C42-04'], [Versions, 'Plan de livraison par versions', 'V0.1 socle interne'], [CentJours, 'Plan des 100 premiers jours', 'Décision provinciale'], [Decisions, 'Décisions requises du Gouvernement provincial', 'Pilote']] as const) {
      const { unmount } = render(wrap(<Page />));
      expect(screen.getByRole('heading', { level: 1, name: title })).toBeTruthy();
      await waitFor(() => expect(screen.getAllByText(new RegExp(text)).length).toBeGreaterThan(0));
      unmount();
    }
  });

  it('accessibilité : chaque écran du programme a un titre, des tableaux légendés et des commandes étiquetées', () => {
    mockFetch('u-sg', ['R01', 'R03']);
    const views = [
      <RisquesView key="r" r={RISQUES} onDone={() => undefined} />, <RecetteView key="c" d={RECETTE} onDone={() => undefined} />,
      <VersionsView key="v" p={VERSIONS} onDone={() => undefined} />, <CentJoursView key="j" p={CENT} onDone={() => undefined} />,
      <DecisionsView key="d" reg={DECISIONS} onDone={() => undefined} />,
    ];
    for (const v of views) {
      const { container, unmount } = render(wrap(v));
      expect(container.querySelectorAll('h2').length).toBeGreaterThan(0);
      for (const t of container.querySelectorAll('table')) expect(t.querySelector('caption')?.textContent?.trim()).toBeTruthy();
      for (const el of container.querySelectorAll('input, select, textarea')) {
        const id = el.getAttribute('id');
        const labelled = !!el.getAttribute('aria-label') || (!!id && !!container.querySelector(`label[for="${id}"]`)) || !!el.closest('label');
        expect(labelled, el.outerHTML.slice(0, 80)).toBe(true);
      }
      for (const b of container.querySelectorAll('button')) expect((b.textContent ?? '').trim() || b.getAttribute('aria-label')).toBeTruthy();
      // Les états ne reposent jamais sur la seule couleur : chaque pastille porte un libellé.
      for (const badge of container.querySelectorAll('.badge, .status-badge')) expect((badge.textContent ?? '').trim()).toBeTruthy();
      unmount();
    }
  });

  it('navigation : les cinq écrans du programme pour la direction, jamais pour le contribuable', () => {
    const has = (roles: string[], to: string) => visibleNav(roles).some((n) => n.to === to);
    for (const to of ['/pilotage/risques', '/pilotage/recette', '/pilotage/versions', '/pilotage/cent-jours', '/pilotage/decisions-gouvernement']) {
      expect(has(['R01'], to), to).toBe(true);
      expect(has(['R30'], to), to).toBe(false);
      expect(has(['R10'], to), to).toBe(false);
    }
  });
});

describe('Compléments : pilote (ch. 46), six états, carte des écarts, calcul IRL', () => {
  it('pilote : communes et raisons, séquence en cinq étapes, étape en cours, communes témoins', () => {
    mockFetch('u-gouv', ['R01']);
    render(wrap(<Chapitre46View c={{
      communes: [{ commune: 'Kalamu', raison: 'Commerce dense de Matonge, habitat locatif compact', objets: 'IRL, patente, débits de boissons' }],
      sequence: [{ etape: 1, semaines: [1, 4], texte: 'Semaines 1 à 4 : paramétrage du référentiel des recettes pilotes.', enCours: true }, { etape: 2, semaines: [5, 12], texte: 'Semaines 5 à 12 : recensement.', enCours: false }],
      semaine: 3, temoins: ['Masina'], note: 'Décision d’extension humaine.',
    }} />));
    expect(screen.getByText('Commerce dense de Matonge, habitat locatif compact')).toBeTruthy();
    expect(screen.getByText(/\(en cours\)/)).toBeTruthy();
    expect(screen.getByText(/Communes témoins : Masina/)).toBeTruthy();
  });

  it('six états distingués, non mesurés déclarés ; carte schématique des écarts ; calcul avec taux, retenue et arrêté', () => {
    mockFetch('u-gouv', ['R01']);
    const lv = (level: string, label: string, measured: boolean, amount?: string) => ({ level, label, measured, consolidatedCdf: amount ? { amount, currency: 'CDF' } : null });
    render(wrap(<SixEtats levels={[lv('potential', 'Potentiel estimé', false), lv('assessed', 'Liquidé', true, '1000'), lv('confirmed', 'Confirmé', true, '500'), lv('settled', 'Réglé', true, '400'), lv('reconciled', 'Rapproché', true, '300'), lv('available', 'Disponible', false)]} />));
    for (const t of ['Potentiel', 'Constaté', 'Encaissé', 'Réglé', 'Rapproché', 'Disponible']) expect(screen.getAllByText(t).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Non mesuré')).toHaveLength(2);
    render(wrap(<GapCartogram g={{ year: '2026', certified: true, rows: [], byCommune: [{ commune: 'Limete', target: [], realised: [], ratePctCdf: '25.0' }] }} />));
    expect(screen.getByTitle('Limete — 25.0 %')).toBeTruthy();
    expect(screen.getByTitle('Gombe — sans assignation')).toBeTruthy();
    render(wrap(<CalculBox c={{ formule: 'max(0, loyers_percus * taux / 100 - retenues_imputees)', base: 'Loyers encaissés', taux: '22', tauxRetenue: '15', bareme: {}, arretes: [{ id: 'arrete-taux-irl-2026', titre: 'Arrêté des taux IRL 2026', statut: 'A_VERIFIER' }], mention: 'à vérifier' }} />));
    expect(screen.getByText(/taux 22 %/)).toBeTruthy();
    expect(screen.getByText(/retenue à la source 15 %/)).toBeTruthy();
    expect(screen.getByText(/Arrêté des taux IRL 2026 \(à vérifier\)/)).toBeTruthy();
  });
});
