/**
 * « Mon compte unique » (ch. 9) et « Mes biens et relations » (spécification v1.0 du 28/09/2026) — écrans : agrégation
 * de tous les modules, graphiques de la trousse, liens vers chaque module, niveaux N0–N3 ; revendications et choix de
 * candidat ; vue du propriétaire masquée ; file de revue avec les deux arbres d'une fusion ; inscription à rôles multiples.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../src/context';
import { MODULE_ROUTES } from '../src/modules/registry';
import { MonCompteUnique } from '../src/modules/compte-unique/MonCompteUnique';
import BiensRelations from '../src/modules/compte-unique/BiensRelations';
import VueProprietaire from '../src/modules/compte-unique/VueProprietaire';
import RevueBiens from '../src/modules/compte-unique/RevueBiens';

const json = (v: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(v), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } }));
function mockApi(user: { id: string; roles: string[]; taxpayerId?: string } | null, routes: Record<string, unknown | ((init?: RequestInit) => unknown)>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    if (user && String(url).includes('/v1/demo/users')) return json([{ ...user, name: `${user.id} (démo)`, entity: 'PUBLIC' }]);
    const hit = Object.entries(routes).sort((a, b) => b[0].length - a[0].length).find(([k]) => String(url).split('?')[0]!.endsWith(k) || String(url).includes(k));
    if (!hit) return Promise.reject(new TypeError('Failed to fetch'));
    return json(typeof hit[1] === 'function' ? (hit[1] as (i?: RequestInit) => unknown)(init) : hit[1]);
  }) as unknown as typeof fetch;
  if (user) localStorage.setItem('mosolo.demoUser', user.id); else localStorage.removeItem('mosolo.demoUser');
  return calls;
}
const renderApp = (el: JSX.Element, path = '/') => render(<MemoryRouter initialEntries={[path]}><AppProvider initialLang="fr">{el}</AppProvider></MemoryRouter>);

const COMPTE = {
  viewer: 'self',
  compte: { taxpayerId: 'TP-X', iuc: 'KIN-ABCDEFGH-K', nom: 'Mwamba Kasongo (fictif)', nature: 'PERSONNE_PHYSIQUE', telephone: '+243899500001', telephoneVerifie: true, niveau: 'N1', langue: 'fr', statut: 'ACTIF' },
  identite: {
    niveau: 'N1',
    niveaux: [
      { code: 'N0', label: 'N0 — déclaratif', proof: 'Téléphone', rights: 'Consulter, payer', atteint: true },
      { code: 'N1', label: 'N1 — identifié', proof: 'Pièce contrôlée', rights: 'Déclarer des objets, mandataire', atteint: true },
      { code: 'N2', label: 'N2 — vérifié', proof: 'Visite de terrain', rights: 'Objets de forte valeur', atteint: false },
      { code: 'N3', label: 'N3 — certifié', proof: 'NIF vérifié', rights: 'Opérations d’entreprise', atteint: false },
    ],
    prochainesEtapes: ['Contrôle documentaire approfondi ou visite de terrain — N2.'],
    representeAupres: [{ organisationId: 'ORG-1', raisonSociale: 'Société fictive SARL', fonction: 'Gérante', habilitation: 'DIRIGEANT', mandatActif: false }],
    reutilisation: 'Les informations vérifiées sont reprises par chaque module sans nouvelle saisie.',
  },
  sections: [
    { module: 'objets', titre: 'Biens et objets fiscaux', lien: '/fiscal/biens', elements: [
      { rubrique: 'OBJET', id: 'OBJ-1', libelle: 'Parcelle — Limete · Kingabwa', nature: 'PARCELLE', statut: 'PROVISOIRE', objectId: 'OBJ-1', lien: '/chaine/OBJ-1' },
      { rubrique: 'VEHICULE', id: 'OBJ-2', libelle: 'Véhicule KN-5002-CU — Limete', nature: 'VEHICULE', statut: 'PROVISOIRE', lien: '/vehicules/mes-vehicules' },
    ] },
    { module: 'obligations', titre: 'Obligations', lien: '/espace', elements: [
      { rubrique: 'OBLIGATION', id: 'OBL-1', libelle: 'Stationnement 60 min', statut: 'EXIGIBLE', montant: { amount: '1000.00', currency: 'CDF' }, echeance: '2026-10-01', lien: '/espace' },
    ] },
    { module: 'titres', titre: 'Titres, autorisations, pass et tickets', lien: '/titres/catalogue', elements: [
      { rubrique: 'PASS', id: 'CRD-1', libelle: 'Pass wewa 1 jour WEW-001', nature: '81', statut: 'EMIS', echeance: '2026-09-27T09:00:00.000Z', lien: '/services/rakapay' },
    ] },
    { module: 'stationnement', titre: 'Stationnement intelligent (ParkSmart)', lien: '/stationnement', elements: [
      { rubrique: 'SESSION', id: 'PKS-1', libelle: 'Session KN-5001-CU — Limete', statut: 'ACTIVE', lien: '/stationnement' },
    ] },
    { module: 'acces', titre: 'Identité, mandats et organisations', lien: '/acces/identite', elements: [
      { rubrique: 'MANDAT_DONNE', id: 'MDT-1', libelle: 'Mandat de confiance à Cabinet (CONSULTER)', statut: 'ACTIF', lien: '/acces/mandats' },
      { rubrique: 'ROLE', id: 'ORG-1:TP-X', libelle: 'Gérante — Société fictive SARL', statut: 'DIRIGEANT', lien: '/acces/mandats' },
      { rubrique: 'CONSENTEMENT', id: 'PREF-TP-X', libelle: 'Langue fr', statut: 'EN_VIGUEUR', lien: '/communication/notifications' },
    ] },
  ],
  synthese: {
    parRubrique: { OBJET: 1, VEHICULE: 1, OBLIGATION: 1, PASS: 1, SESSION: 1, MANDAT_DONNE: 1, ROLE: 1, CONSENTEMENT: 1 },
    objetsParNature: { PARCELLE: 1, VEHICULE: 1 },
    obligationsParStatutEtDevise: [{ statut: 'EXIGIBLE', devise: 'CDF', nombre: 1, total: { amount: '1000.00', currency: 'CDF' } }],
    resteDuParDevise: [{ amount: '1000.00', currency: 'CDF', affichage: '1 000,00 CDF' }],
    titres: { valides: 1, expires: 0, total: 1 },
    prochainesEcheances: [{ id: 'OBL-1', libelle: 'Stationnement 60 min', echeance: '2026-10-01', montant: { amount: '1000.00', currency: 'CDF' }, statut: 'EXIGIBLE' }],
    modules: ['objets', 'obligations', 'titres', 'stationnement', 'acces'],
  },
  principe: 'Un compte, une personne : les informations vérifiées sont réutilisées par chaque module.',
};

describe('Mon compte unique (ch. 9)', () => {
  it('agrège tous les modules : identité et niveaux, synthèse, graphiques, rubriques filtrables et liens vers chaque module', async () => {
    const calls = mockApi({ id: 'u-contribuable', roles: ['R30'], taxpayerId: 'TP-X' }, { '/v1/compte-unique/me': COMPTE });
    renderApp(<MonCompteUnique taxpayerId="TP-X" self />);
    expect(await screen.findByRole('heading', { name: 'Mon compte unique' })).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/v1/compte-unique/me'))).toBe(true);
    expect(await screen.findByText('KIN-ABCDEFGH-K')).toBeTruthy();
    expect(screen.getByText('Vérifié par code')).toBeTruthy();
    // Niveaux N0–N3 et ce que chaque niveau ouvre.
    const levels = screen.getByRole('list', { name: /Niveaux de vérification/ });
    expect(within(levels).getByText('N1 atteint')).toBeTruthy();
    expect(within(levels).getByText(/Objets de forte valeur/)).toBeTruthy();
    // Graphiques de la trousse (titres) et tableau par devise.
    expect(screen.getByRole('heading', { name: 'Mes objets par nature' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Obligations par statut' })).toBeTruthy();
    expect(screen.getByText(/jamais additionnées entre devises/)).toBeTruthy();
    // Rubriques de tous les modules, avec liens.
    expect(screen.getByText('Pass wewa 1 jour WEW-001')).toBeTruthy();
    expect(screen.getByText('Session KN-5001-CU — Limete')).toBeTruthy();
    expect(screen.getByText('Gérante — Société fictive SARL')).toBeTruthy();
    const open = screen.getByRole('link', { name: 'Ouvrir — Pass wewa 1 jour WEW-001' });
    expect(open.getAttribute('href')).toBe('/services/rakapay');
    const modules = screen.getByRole('navigation', { name: 'Modules rattachés au compte' });
    expect(within(modules).getByRole('link', { name: /Stationnement intelligent \(ParkSmart\)/ }).getAttribute('href')).toBe('/stationnement');
    expect(within(modules).getByRole('link', { name: /Mes biens et relations/ }).getAttribute('href')).toBe('/espace/biens-relations');
    // Filtre par rubrique.
    fireEvent.click(screen.getByRole('button', { name: /Pass et tickets \(1\)/ }));
    expect(screen.queryByText('Session KN-5001-CU — Limete')).toBeNull();
    expect(screen.getByText('Pass wewa 1 jour WEW-001')).toBeTruthy();
  });

  it('mandataire : lit le compte du mandant par son identifiant, vue limitée au mandat annoncée', async () => {
    const calls = mockApi({ id: 'u-mandataire', roles: ['R31'] }, { '/v1/compte-unique/TP-X': { ...COMPTE, viewer: 'mandataire', mandat: { id: 'MDT-1', objets: ['OBJ-1'] }, compte: { ...COMPTE.compte, telephone: '+243••••••01' } } });
    renderApp(<MonCompteUnique taxpayerId="TP-X" self={false} />);
    expect(await screen.findByText(/1 objet\(s\)/)).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/v1/compte-unique/TP-X'))).toBe(true);
    expect(screen.getByText(/Vue de mandataire/)).toBeTruthy();
  });

  it('routes : « Mes biens et relations » (titulaire), vue du propriétaire, file de revue (réviseurs et agents affectés)', () => {
    const r = (p: string) => MODULE_ROUTES.find((x) => x.path === p);
    expect(r('/espace/biens-relations')?.nav?.roles).toEqual(['R30']);
    expect(r('/espace/biens/:id')).toBeDefined();
    expect(r('/biens-relations/revue')?.nav?.roles).toEqual(expect.arrayContaining(['R06', 'R07', 'R11', 'R10']));
    expect(r('/biens-relations/revue')?.nav?.roles).not.toContain('R26');
  });
});

const CLAIM = {
  claimId: 'PCL-1', role: 'TENANT', statut: 'MATCHED_PENDING_VERIFICATION', statutLibelle: 'Rapprochée', typeCible: 'UNIT', version: 3, du: '2026-01-01', au: null, colocation: false, quotePart: null, origine: 'ESPACE',
  bien: { id: 'OBJ-U2', libelle: 'Unité 2, bâtiment A, n° 12, avenue Kasa-Vubu, Kingabwa, Limete', statutEnregistrement: 'CANONICAL', provenance: 'ADMINISTRATION', confiance: 'ELEVEE' },
  adresseSaisie: { commune: 'Limete', avenue: 'Kasa-Vubu', number: '12', unit_label: '2' },
  pieces: [{ id: 'PRV-1', type: 'CONTRAT_DE_LOCATION', sha256: 'a'.repeat(64), deposeeLe: '2026-09-26T09:00:00.000Z', statut: 'EN_ATTENTE' }],
  invitations: [{ id: 'INV-1', contact: '+243•••••99', expireLe: '2026-10-03T09:00:00.000Z', statut: 'SANS_SUITE' }],
  designationProprietaire: null,
  historique: [{ at: '2026-09-26T09:00:00.000Z', by: 'u', from: null, to: 'DRAFT' }, { at: '2026-09-26T09:00:01.000Z', by: 'u', from: 'DRAFT', to: 'SUBMITTED' }, { at: '2026-09-26T09:00:02.000Z', by: 'u', from: 'SUBMITTED', to: 'MATCHED_PENDING_VERIFICATION', reason: 'Candidat choisi' }],
  mentionJuridique: 'Revendication non validée juridiquement.',
};

describe('Mes biens et relations (spécification v1.0)', () => {
  it('revendications, états, provenance du bien séparée, invitations « sans suite », historique ; candidats avec « Mon adresse n’y figure pas »', async () => {
    const calls = mockApi({ id: 'u-contribuable', roles: ['R30'], taxpayerId: 'TP-X' }, {
      '/v1/moi/relations-biens': { compte: 'TP-X', actuelles: [CLAIM, { ...CLAIM, claimId: 'PCL-D', statut: 'DRAFT', bien: null, adresseSaisie: null, pieces: [], invitations: [], historique: [] }], historiques: [{ ...CLAIM, claimId: 'PCL-0', statut: 'ENDED', au: '2026-03-31' }], relationsModule7: [], parStatut: [{ statut: 'MATCHED_PENDING_VERIFICATION', libelle: 'Rapprochée', nombre: 1 }, { statut: 'DRAFT', libelle: 'Brouillon', nombre: 1 }, { statut: 'ENDED', libelle: 'Terminée', nombre: 1 }], mentionJuridique: 'Revendication non validée juridiquement.' },
      '/v1/revendications-biens': { ...CLAIM, claimId: 'PCL-2', statut: 'SUBMITTED', bien: null, candidats: 2, suite: 'CHOISIR_CANDIDAT' },
      '/v1/biens-candidats': { claimId: 'PCL-2', candidats: [{ candidateId: 'CAND-1', rang: 1, libelle: 'Unité 2, n° 12, avenue Kasa-Vubu, Limete', typeCible: 'UNIT', statutEnregistrement: 'CANONICAL', expireLe: '2026-09-26T10:00:00.000Z' }], aucun: { libelle: 'Mon adresse n’y figure pas' }, avertissement: 'Choisir un candidat ne vérifie rien.' },
    });
    renderApp(<BiensRelations />);
    expect(await screen.findByRole('heading', { name: 'Mes biens et relations' })).toBeTruthy();
    expect(screen.getByText('Revendication non validée juridiquement.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Mes relations par état' })).toBeTruthy();
    const card = screen.getAllByRole('article', { name: /Locataire — Unité 2/ })[0]!;
    expect(within(card).getByText('Rapprochée — à vérifier')).toBeTruthy();
    expect(within(card).getByText('Bien de référence')).toBeTruthy();
    expect(within(card).getByText(/sans suite \(refusée ou expirée\)/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Historique d’occupation' })).toBeTruthy();
    // Aucun champ ne demande le nom ou le téléphone de l'autre partie dans le formulaire de revendication.
    const form = screen.getByRole('heading', { name: 'Revendiquer une relation à un bien' }).closest('form')!;
    expect(within(form).queryByLabelText(/nom du propriétaire|téléphone du propriétaire/i)).toBeNull();
    fireEvent.change(within(form).getByLabelText('Avenue'), { target: { value: 'Kasa-Vubu' } });
    fireEvent.change(within(form).getByLabelText('Numéro'), { target: { value: '12' } });
    fireEvent.click(within(form).getByRole('button', { name: /Rechercher mon bien/ }));
    expect(await screen.findByRole('heading', { name: 'Est-ce votre bien ?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mon adresse n’y figure pas' })).toBeTruthy();
    const post = calls.find((c) => c.url.endsWith('/v1/revendications-biens') && c.init?.method === 'POST')!;
    const headers = post.init!.headers as Record<string, string>;
    expect(Object.keys(headers).some((h) => h.toLowerCase() === 'idempotency-key')).toBe(true);
    expect(JSON.parse(String(post.init!.body))).toMatchObject({ role: 'TENANT', address: { commune: 'Limete', avenue: 'Kasa-Vubu', number: '12' } });
  });

  it('vue du propriétaire : unités occupées et vacantes (graphique), occupation vérifiée sans identité, revendications masquées', async () => {
    mockApi({ id: 'u-contribuable', roles: ['R30'], taxpayerId: 'TP-X' }, {
      '/v1/biens/OBJ-B/vue-proprietaire': {
        bien: { id: 'OBJ-B', libelle: 'bâtiment A, n° 12, avenue Kasa-Vubu', statutEnregistrement: 'CANONICAL', provenance: 'ADMINISTRATION' }, date: '2026-09-26',
        unites: [
          { id: 'U1', libelle: '1', statutEnregistrement: 'CANONICAL', occupation: 'VACANTE', occupationsVerifiees: [], revendicationsEnAttente: [{ reference: 'PCL-9', role: 'TENANT', statut: 'MATCHED_PENDING_VERIFICATION' }], loyerIRL: [] },
          { id: 'U2', libelle: '2', statutEnregistrement: 'CANONICAL', occupation: 'OCCUPEE', occupationsVerifiees: [{ role: 'LOCATAIRE', du: '2026-02-01', au: null, colocation: false }], revendicationsEnAttente: [], loyerIRL: [{ bail: 'BAIL-1', loyer: { amount: '120.00', currency: 'USD' }, periodicite: 'MENSUELLE', du: '2026-02-01', au: null }] },
        ],
        synthese: { unites: 2, occupees: 1, vacantes: 1, enAttente: 1 }, confidentialite: 'Aucune identité des occupants n’est affichée.',
      },
    });
    renderApp(<Routes><Route path="/espace/biens/:id" element={<VueProprietaire />} /></Routes>, '/espace/biens/OBJ-B');
    expect(await screen.findByRole('heading', { name: 'Unités occupées et vacantes' })).toBeTruthy();
    expect(screen.getByText(/Locataire vérifié — depuis le/)).toBeTruthy();
    expect(screen.getByText(/1 revendication\(s\) en attente/)).toBeTruthy();
    expect(screen.getByText('Aucune identité des occupants n’est affichée.')).toBeTruthy();
  });

  it('file de revue : fusion de biens avec les deux arbres, cible canonique explicite et motif obligatoire', async () => {
    const tree = (id: string, status: string) => ({ id, categorie: 'PARCELLE', libelle: 'n° 99, avenue des Palmiers', statutEnregistrement: status, provenance: status === 'CANONICAL' ? 'ADMINISTRATION' : 'SELF_REPORTED', identifiantOfficiel: null, position: { lat: -4.37, lon: 15.34 }, revendications: 1, conflits: 0, dossierVise: false,
      enfants: [{ id: `${id}-U`, categorie: 'UNITE_LOCATIVE', libelle: '2', statutEnregistrement: status, provenance: 'SELF_REPORTED', identifiantOfficiel: null, position: { lat: -4.37, lon: 15.34 }, revendications: 1, conflits: 0, dossierVise: true, enfants: [] }] });
    const calls = mockApi({ id: 'u-dg-dgipk', roles: ['R06'] }, {
      '/v1/dossiers-revue/DRV-1/decision': { dossier: { id: 'DRV-1' } },
      '/v1/dossiers-revue/DRV-1': { id: 'DRV-1', motif: 'FUSION_BIENS', motifLibelle: 'Doublon de biens (fusion à revoir)', statut: 'OUVERT', commune: 'Limete', ouvertLe: '2026-09-26T09:00:00.000Z', revendication: null, agentTerrain: null, echeanceTerrain: null, decision: null, version: 1, note: null, revendications: [], fusion: { enregistrements: [tree('P-OWN', 'CANONICAL'), tree('P-TEN', 'PROVISIONAL')], signaux: ['ADRESSE_EXACTE'], appliquee: null }, mentionJuridique: 'Non validé juridiquement.' },
      '/v1/dossiers-revue': { items: [{ id: 'DRV-1', motif: 'FUSION_BIENS', motifLibelle: 'Doublon de biens (fusion à revoir)', statut: 'OUVERT', commune: 'Limete', ouvertLe: '2026-09-26T09:00:00.000Z', revendication: null, agentTerrain: null, echeanceTerrain: null, decision: null, version: 1 }] },
    });
    renderApp(<RevueBiens />);
    fireEvent.click(await screen.findByRole('button', { name: 'Examiner' }));
    const trees = await screen.findByLabelText('Arbres des deux enregistrements');
    expect(within(trees).getByText('Enregistrement P-OWN')).toBeTruthy();
    expect(within(trees).getByText('Enregistrement P-TEN')).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Enregistrer la décision' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Cible canonique (explicite)'), { target: { value: 'P-OWN-U' } });
    fireEvent.change(screen.getByLabelText('Motif (obligatoire)'), { target: { value: 'Même logement (test)' } });
    fireEvent.click(submit);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/v1/dossiers-revue/DRV-1/decision'))).toBe(true));
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith('/decision'))!.init!.body));
    expect(body).toMatchObject({ decision: 'FUSIONNER', canonical_target_id: 'P-OWN-U', motif: 'Même logement (test)' });
  });
});
