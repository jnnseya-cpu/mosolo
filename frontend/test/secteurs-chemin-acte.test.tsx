/**
 * Modules sectoriels « acte requis » : chemin vers l'acte (29/09/2026) — prochaine étape, boutons réservés aux rôles
 * habilités (les autres voient qui doit agir), travaux possibles avant l'acte ; chaîne opératoire : « qui doit agir,
 * où » pour chaque maillon en attente, lien actif seulement pour le rôle habilité, « Comment ça marche ».
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/context';
import { setDemoUser } from '../src/lib/api';
import Secteurs from '../src/modules/verticales/Secteurs';
import { CheminActe, peutAgir, rolesEnClair, TRAVAUX_AVANT_ACTE, type CheminActeView } from '../src/modules/verticales/CheminActe';
import { ChaineStepper } from '../src/modules/chaine/SeptQuestions';
import Chaine from '../src/modules/chaine/Chaine';
import type { Maillon } from '../src/modules/chaine/types';

function mockApi(routes: Record<string, unknown>, users: unknown[] = []) {
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/v1/demo/users')) return Promise.resolve(new Response(JSON.stringify(users), { status: 200, headers: { 'content-type': 'application/json' } }));
    const path = Object.keys(routes).find((p) => url.split('?')[0]!.endsWith(p));
    if (!path) return Promise.resolve(new Response(JSON.stringify({ title: 'Introuvable', status: 404 }), { status: 404, headers: { 'content-type': 'application/json' } }));
    return Promise.resolve(new Response(JSON.stringify(routes[path]), { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as unknown as typeof fetch;
}
const wrap = (ui: JSX.Element) => render(<AppProvider initialLang="fr"><MemoryRouter>{ui}</MemoryRouter></AppProvider>);
afterEach(() => { setDemoUser(null); localStorage.clear(); });

const chemin: CheminActeView = {
  module: '22', etat: 'ACTE_REQUIS', etatLabel: 'Acte requis avant tout paiement', ruleCode: null, faites: 0, total: 3,
  note: 'Avant l’acte : aucun montant.',
  etapes: [
    { code: 'J1', kind: 'POINT_JURIDIQUE', label: 'J1 — Texte consolidé', statut: 'A_FAIRE', detail: 'Point ouvert.', action: { label: 'Enregistrer l’acte', path: '/juridique/points?point=J1', roles: ['R13', 'R14'], qui: 'Juriste rédacteur ou vérificateur' } },
    { code: 'REGLE', kind: 'REGLE', label: 'Règle du registre', statut: 'A_FAIRE', detail: 'Aucune règle.', action: { label: 'Rédiger la règle', path: '/registre?nouvelle=1', roles: ['R13'], qui: 'Juriste rédacteur' } },
    { code: 'CONFIGURATION', kind: 'CONFIGURATION', label: 'Fiche du module', statut: 'A_FAIRE', detail: 'À configurer.', action: { label: 'Activer après acte', path: '/verticales/fiches?onglet=configuration&module=22', roles: ['R06'], qui: 'Directeur général de la régie (DGTK)' } },
  ],
  prochaine: null,
};
chemin.prochaine = chemin.etapes[0]!;

describe('Chemin vers l’acte : actions réservées aux rôles habilités', () => {
  it('peutAgir et libellés des rôles', () => {
    expect(peutAgir({ roles: ['R13', 'R14'] }, ['R14'])).toBe(true);
    expect(peutAgir({ roles: ['R06'] }, ['R07', 'R11'])).toBe(false);
    expect(peutAgir(null, ['R06'])).toBe(false);
    expect(rolesEnClair(['R13', 'R14'])).toBe('Juriste rédacteur ou Juriste vérificateur');
  });

  it('juriste : bouton « Enregistrer l’acte » vers le point juridique ; directeur : pas de bouton juridique, mais « Activer après acte »', () => {
    const { unmount } = wrap(<CheminActe chemin={chemin} roles={['R13']} />);
    const next = screen.getByLabelText('Prochaine étape du module 22');
    const link = within(next).getByRole('link', { name: /Enregistrer l’acte/ });
    expect(link.getAttribute('href')).toBe('/juridique/points?point=J1');
    unmount();
    wrap(<CheminActe chemin={chemin} roles={['R06']} />);
    const next2 = screen.getByLabelText('Prochaine étape du module 22');
    expect(within(next2).queryByRole('link')).toBeNull();
    expect(within(next2).getByText(/Qui doit agir :/)).toBeTruthy();
    expect(within(next2).getByText(/Juriste rédacteur ou Juriste vérificateur/)).toBeTruthy();
    // Dans la liste complète, le directeur a son bouton sur l'étape de configuration.
    const activate = screen.getByRole('link', { name: /Activer après acte/ });
    expect(activate.getAttribute('href')).toBe('/verticales/fiches?onglet=configuration&module=22');
    expect(screen.queryByRole('link', { name: /Rédiger la règle/ })).toBeNull();
  });

  it('travaux avant l’acte : chaque module a un circuit existant ; les liens suivent les rôles des écrans', () => {
    for (const m of ['11', '13', '16', '17', '21', '22', '23', '24', '25', '56']) expect(TRAVAUX_AVANT_ACTE[m]!.length, m).toBeGreaterThan(0);
    expect(TRAVAUX_AVANT_ACTE['22']!.find((t) => t.path === '#sec-declarer')!.roles).toEqual(['R30', 'R31']);
  });

  it('écran Secteurs : le contribuable voit l’état, la prochaine étape (qui doit agir) et « Déclarer » ; aucun bouton juridique', async () => {
    setDemoUser('vx-redevable-sectoriel');
    mockApi({
      '/v1/verticales/secteurs': {
        notice: 'Modules sous ACTE_REQUIS.',
        items: [{
          module: '22', name: 'Carrières et recettes minières', function: 'Sites', vertical: 'construction', verticalName: 'MOSOLO Build', legal: 'ACTE_REQUIS', prerequisites: ['J1 — base légale des carrières'],
          revenueCodes: [], credentialTypes: [], declarationKinds: [{ kind: 'SORTIES_CARRIERE', label: 'Déclaration mensuelle des sorties de carrière', keys: { camions: 'Camions sortis' } }], observationSources: ['COMPTAGE_SORTIES'], routes: [],
          counts: { references: 0, declarations: 1, observations: 1 }, etat: 'ACTE_REQUIS', cheminActe: chemin, activite: [{ label: 'Sites de carrière', value: 1 }],
        }],
      },
      '/v1/verticales/secteurs/declarations': { items: [] },
      '/v1/fiscal/objects': [{ id: 'OBJ-CAR-1', commune: 'Nsele', quartier: 'Kinkole', attributes: { objectType: 'CARRIERE', nom: 'Carrière de sable [EXEMPLE]' } }],
    }, [{ id: 'vx-redevable-sectoriel', name: 'Redevable sectoriel fictif [EXEMPLE] (démo)', roles: ['R30'], entity: 'PUBLIC', taxpayerId: 'TP-VX-SECT-01' }]);
    wrap(<Secteurs />);
    expect(await screen.findByText('22 — Carrières et recettes minières')).toBeTruthy();
    expect(screen.getByText('Acte requis avant tout paiement')).toBeTruthy();
    expect(screen.getByText('Sites de carrière : 1')).toBeTruthy();
    expect(await screen.findByLabelText('Prochaine étape du module 22')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Enregistrer l’acte/ })).toBeNull();
    expect((await screen.findByRole('link', { name: 'Déclarer les sorties de carrière' })).getAttribute('href')).toBe('#sec-declarer');
    expect(screen.getByText('Comment avancer vers l’acte ?')).toBeTruthy();
    // Choix du site parmi les objets du redevable (saisie libre conservée).
    expect(document.getElementById('sec-declarer')).toBeTruthy();
  });
});

const CODES = ['RECENSER', 'IDENTIFIER', 'GEOLOCALISER', 'QUALIFIER', 'CALCULER', 'NOTIFIER', 'PAYER', 'RAPPROCHER', 'QUITTANCER', 'CONTROLER', 'RECOUVRER', 'AUDITER', 'PLANIFIER'];
const maillons: Maillon[] = CODES.map((code, i) => ({
  rang: i + 1, code, label: code.charAt(0) + code.slice(1).toLowerCase(), garde: `Garde ${code}`, status: i < 6 ? 'FAIT' : 'EN_ATTENTE',
  at: null, actor: null, auditEventId: null, auditSeq: null, chainHash: null, evidence: [], detail: `Détail ${code}`,
  ...(i >= 6 ? { aAgir: code === 'PAYER'
    ? { qui: 'Le contribuable ou son mandataire', roles: ['R30', 'R31'], ou: [{ label: 'Mon espace — payer', path: '/espace' }], automatique: false, note: 'Jamais d’espèces remises à un agent.' }
    : { qui: `Acteur ${code}`, roles: ['R17'], ou: [{ label: `Écran ${code}`, path: '/tresor' }], automatique: true, note: 'Note' } } : {}),
}));

describe('Chaîne opératoire : qui doit agir, où', () => {
  it('maillon en attente : qui, où (lien seulement pour le rôle habilité), garde-fou ; lecture seule', async () => {
    setDemoUser('u-contribuable');
    mockApi({}, [{ id: 'u-contribuable', name: 'Contribuable démo', roles: ['R30'], entity: 'PUBLIC', taxpayerId: 'TP-DEMO-0001' }]);
    wrap(<ChaineStepper maillons={maillons} />);
    // Premier maillon en attente ouvert par défaut : PAYER.
    const box = await screen.findByLabelText('Qui doit agir — Payer');
    expect(within(box).getByText(/Le contribuable ou son mandataire/)).toBeTruthy();
    expect(await within(box).findByRole('link', { name: /Mon espace — payer/ })).toBeTruthy();
    expect(within(box).getByText(/jamais depuis cette chaîne/)).toBeTruthy();
    expect(screen.getByText('Garde PAYER')).toBeTruthy();
    // Aucun bouton pour « accomplir » un maillon.
    expect(screen.queryByRole('button', { name: /valider|accomplir|cocher/i })).toBeNull();
  });

  it('rôle non habilité : l’écran est nommé sans lien', async () => {
    mockApi({});
    wrap(<ChaineStepper maillons={maillons} />);
    const box = await screen.findByLabelText('Qui doit agir — Payer');
    expect(within(box).queryByRole('link')).toBeNull();
    expect(within(box).getByText('Mon espace — payer')).toBeTruthy();
  });

  it('page Chaîne : « Comment ça marche » en tête', async () => {
    setDemoUser('u-controleur');
    mockApi({ '/v1/obligations': [] }, [{ id: 'u-controleur', name: 'Contrôleur', roles: ['R11'], entity: 'DGIPK' }]);
    wrap(<Chaine />);
    expect(screen.getByText('Comment ça marche ?')).toBeTruthy();
    expect(screen.getByText(/on ne « coche » rien ici/)).toBeTruthy();
  });
});
