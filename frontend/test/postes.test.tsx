/**
 * Postes de décision (Cahier nouvelle version, ch. 27 ; critères d'acceptation du ch. 42) — écrans : menu de cinq
 * entrées du Gouverneur, fiche à neuf blocs et quatre issues motivées, chiffre jamais nu, écran d'accueil sans aucune
 * saisie, consultation hors connexion, poste de travail séparé, noms nouveaux avec anciens noms conservés.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../src/context';
import { setDemoUser } from '../src/lib/api';
import { MENU_GOUVERNEUR, menuDe, NAV, visibleNav } from '../src/components/Shell';
import { MODULE_ROUTES } from '../src/modules/registry';
import { ChiffreView, ecrireHorsLigne, FicheCard, gardeAction, type Chiffre, type Fiche } from '../src/modules/postes/common';
import PosteDecision, { AccueilPoste } from '../src/modules/postes/PosteDecision';
import { TravailVue, type Travail } from '../src/modules/postes/PosteTravail';

function mockApi(userId: string, roles: string[], handler?: (url: string, init?: RequestInit) => Response | null) {
  setDemoUser(userId);
  const f = vi.fn((url: string, init?: RequestInit) => {
    if (String(url).includes('/v1/demo/users')) return Promise.resolve(new Response(JSON.stringify([{ id: userId, name: 'Autorité (test)', roles, entity: 'GOUVERNORAT' }]), { status: 200, headers: { 'content-type': 'application/json' } }));
    const r = handler?.(String(url), init);
    return r ? Promise.resolve(r) : Promise.reject(new TypeError('Failed to fetch'));
  });
  globalThis.fetch = f as unknown as typeof fetch;
  return f;
}
afterEach(() => { setDemoUser(null); localStorage.clear(); });

const wrap = (ui: React.ReactElement, path = '/') => (
  <AppProvider initialLang="fr"><MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter></AppProvider>
);

const chiffre = (over: Partial<Chiffre> = {}): Chiffre => ({
  code: 'ENCAISSE', libelle: 'Encaissé — exercice 2026', valeur: '594500.00', unite: 'CDF', etat: 'ENCAISSE', etatLabel: 'Encaissé', estimation: false, date: '2026-09-26T09:00:00.000Z',
  equivalents: { CDF: '594500.00', USD: '208.60' }, taux: { devise: 'USD', cdfParUnite: '2850', date: '2026-09-26', source: 'BCC (démo)', nature: 'indicatif' },
  comparaison: { type: 'PERIODE_PRECEDENTE', libelle: 'Même période de l’exercice 2025', valeur: null, ecart: null, tendance: 'INDISPONIBLE' }, deltaDuJour: '1000.00',
  source: { libelle: 'Échelle unifiée', chemin: ['/poste-de-decision', '/pilotage/indicateurs', '/pilotage/tableaux'], api: '/v1/pilotage/echelle' }, ...over,
});

const fiche = (over: Partial<Fiche> = {}): Fiche => ({
  id: 'DOSSIER:DOSS-000001', source: 'DOSSIER', module: 'Postes de décision', categorie: { code: 'SUSPENSION_TIERS', libelle: 'Suspension d’un partenaire, d’un centre agréé ou d’un prestataire', niveau: 'Ministre de tutelle, information du Gouverneur' },
  presence: ['DECIDEUR'], objet: 'Suspendre l’habilitation d’un centre de contrôle technique agréé',
  demandeur: { id: 'vc-u-direction-rfck', libelle: 'Direction générale de la RFCK', serviceInstructeur: 'Service de contrôle interne de la RFCK', validationAmont: 'Instruit par le service de contrôle interne' },
  enjeu: { texte: '1 centre, 3 412 procès-verbaux sur 90 jours [EXEMPLE]', chiffres: [], nombre: '1 centre', commune: 'Limete', figures: [{ libelle: 'Taux de réussite du centre', valeur: '99,4', unite: '%' }] },
  echeance: { date: '2026-10-01', joursRestants: 5, urgente: false, enRetard: false, consequenceSilence: 'Au-delà, les procès-verbaux litigieux continuent de produire des effets' },
  fondement: ['Arrêté ministériel du 12 novembre 2025', 'Décision d’habilitation du centre'], position: { recommandation: 'Suspension recommandée pour 30 jours.', reserves: ['2 des 4 signaux peuvent s’expliquer par la clientèle du centre.'] },
  siRienNestDecide: 'Le centre continue d’émettre', pieces: { replie: true, nombre: 2, items: [{ libelle: 'Rapport du contrôle interne [EXEMPLE]' }, { libelle: 'Décision d’habilitation' }] },
  actions: [
    { code: 'APPROUVER', libelle: 'Approuver la suspension', possible: true, motifObligatoire: true }, { code: 'REFUSER', libelle: 'Refuser', possible: true, motifObligatoire: true },
    { code: 'DELEGUER', libelle: 'Déléguer au ministre des Transports', possible: true, motifObligatoire: true }, { code: 'COMPLEMENT', libelle: 'Demander un complément d’enquête', possible: true, motifObligatoire: true },
  ],
  delegationSuggeree: { userId: 'vc-u-ministre-transports', libelle: 'Ministre provincial des Transports' }, individuel: false, information: false, gravite: 'HAUTE', complements: [],
  ecran: '/poste-de-decision/fiche/DOSSIER%3ADOSS-000001', exemple: true, enjeuCdf: '0', ...over,
});

const REGLES = [{ titre: 'Jamais un chiffre nu', texte: 'Tout montant porte son état.' }, { titre: 'Voir sans manipuler', texte: 'Aucun poste de décision ne permet de modifier une dette, un paiement, une quittance ou un compte bénéficiaire.' }];
const accueilGouverneur = () => ({
  profil: 'GOUVERNEUR', titre: 'Cabinet du Gouverneur', zeroSaisie: true, exercice: '2026', genereLe: '2026-09-26T09:00:00.000Z',
  menu: MENU_GOUVERNEUR.map((m) => ({ code: m.to.split('/').pop()!, libelle: m.label!, ouvre: '', pourquoi: '' })),
  reperes: [{ valeur: '90 s', libelle: 'temps de consultation visé' }, { valeur: '3', libelle: 'niveaux de profondeur au maximum' }, { valeur: 'Lundi', libelle: 'note hebdomadaire hors connexion' }],
  regles: REGLES, sixEtats: ['Potentiel', 'Constaté', 'Encaissé', 'Réglé', 'Rapproché', 'Disponible'], pied: 'KINSHASA MOSOLO · Postes de décision', habilitations: 'Les habilitations ne changent pas.',
  budget: { temps: '60 à 90 secondes', frequence: 'Quotidienne', support: 'Téléphone' }, entete: { enAttente: 2, urgentes: 1, libelle: '2 dossiers · 1 urgent' },
  corbeille: { taille: 2, differes: [], nonPresentables: 0 },
  bloc1: { titre: 'Ce qui attend votre décision', fiches: [fiche(), fiche({ id: 'DOSSIER:DOSS-000002', objet: 'Arbitrer l’assignation de recettes du deuxième trimestre', echeance: { date: '2026-09-27', joursRestants: 1, urgente: true, enRetard: false, consequenceSilence: 'x' } })] },
  bloc2: { titre: 'La Ville aujourd’hui · exercice en cours', chiffres: [chiffre(), chiffre({ code: 'REGLE', etat: 'REGLE', etatLabel: 'Réglé en compte public', libelle: 'Réglé' }), chiffre({ code: 'RAPPROCHE', etat: 'RAPPROCHE', etatLabel: 'Rapproché', libelle: 'Rapproché' }), chiffre({ code: 'ECART_ASSIGNATION', unite: '%', etat: 'RATIO', etatLabel: 'Ratio', valeur: null, equivalents: undefined, taux: undefined, libelle: 'Écart à l’assignation' })] },
  bloc3: { titre: 'Ce qui ne va pas', alertes: [{ id: 'ALR-1', type: 'ECART', gravite: 'HIGH', cause: 'Écart de rapprochement sur 3 jours.', ageJours: 3, enjeu: null, lien: '/poste-de-decision/alertes?id=ALR-1' }], total: 1 },
  communes: { mesure: false, note: 'Aucune assignation certifiée : couleurs non mesurées (gris).', communes: [{ commune: 'Gombe', couleur: 'GRIS', tauxPct: null, lien: '/x' }, { commune: 'Limete', couleur: 'GRIS', tauxPct: null, lien: '/x' }] },
  jamaisRemonte: [], illustrations: { LA_VILLE: [{ code: 'ENCAISSE', libelle: 'Milliards FC encaissés', valeur: '68,4', unite: 'Md FC', etatLabel: 'Encaissé', exemple: true as const, mention: '[EXEMPLE] Maquette de travail soumise à validation' }] },
});

describe('Menu et noms (§ 27.5, catalogue n° 41 à 44)', () => {
  it('menu du Gouverneur : cinq entrées, pas davantage ; les autres profils gardent leurs écrans ; les anciens tableaux restent accessibles', () => {
    expect(menuDe(['R01']).map((n) => n.label)).toEqual(['Décisions', 'Recettes', 'Alertes', 'Communes', 'Rechercher']);
    expect(menuDe(['R01'])).toHaveLength(5);
    expect(menuDe(['R01']).some((n) => n.to === '/verifier')).toBe(false);
    for (const r of ['R02', 'R03', 'R04', 'R05']) expect(menuDe([r]).some((n) => n.to === '/poste-de-decision'), r).toBe(true);
    expect(visibleNav(['R10']).some((n) => n.to === '/poste-de-decision')).toBe(false);
    expect(NAV.some((n) => n.to === '/gouverneur')).toBe(true);
    for (const p of ['/decision/commandement', '/pilotage/tableaux', '/poste-de-travail']) expect(MODULE_ROUTES.some((r) => r.path === p), p).toBe(true);
  });

  it('noms français nouveaux d’abord, anciens noms conservés entre parenthèses', () => {
    const label = (p: string) => MODULE_ROUTES.find((r) => r.path === p)!.nav!.label;
    expect(label('/poste-de-decision')).toBe('Postes de décision des autorités (ancien Centre de commandement exécutif)');
    expect(label('/decision/regie-fiscale')).toBe('Poste de travail — régie fiscale (Tableau de bord de la régie fiscale)');
    expect(label('/decision/regie-taxes')).toBe('Poste de travail — régie des taxes (Tableau de bord de la régie des taxes)');
    expect(label('/decision/ministere')).toBe('Postes ministériels (Tableau de bord ministériel)');
  });
});

describe('Chiffre jamais nu et fiche de décision (§ 27.3, § 27.10)', () => {
  it('chaque chiffre porte son état, sa date, son taux et sa source ; une estimation reste visuellement distincte', () => {
    mockApi('u-g', ['R01']);
    const { container } = render(wrap(<><ChiffreView c={chiffre()} /><ChiffreView c={chiffre({ code: 'POTENTIEL', etat: 'POTENTIEL_ESTIME', etatLabel: 'Potentiel estimé', estimation: true, valeur: null })} /></>));
    expect(screen.getByText('État · Encaissé')).toBeTruthy();
    expect(screen.getAllByText(/1 USD = 2 850 CDF \(2026-09-26, BCC \(démo\)\)/).length).toBe(2);
    expect(screen.getByText('Estimation')).toBeTruthy();
    expect(container.querySelectorAll('.ps-estimation')).toHaveLength(1);
    expect(container.querySelector('.ps-chiffre-lien')!.getAttribute('href')).toBe('/pilotage/indicateurs');
  });

  it('fiche : neuf blocs, pièces repliées, quatre issues ; motif écrit obligatoire avant tout envoi', async () => {
    const f = mockApi('u-g', ['R01']);
    const { container } = render(wrap(<FicheCard f={fiche()} />));
    for (const b of ['Demandeur', 'Enjeu', 'Échéance', 'Fondement', 'Position du service', 'Si rien n’est décidé']) expect(screen.getByText(b)).toBeTruthy();
    expect(screen.getByText('Suspendre l’habilitation d’un centre de contrôle technique agréé')).toBeTruthy();
    const details = container.querySelector('details.ps-pieces') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Approuver la suspension', 'Refuser', 'Déléguer au ministre des Transports', 'Demander un complément d’enquête']);
    fireEvent.click(screen.getByText('Approuver la suspension'));
    fireEvent.change(screen.getByLabelText(/Motif écrit/), { target: { value: 'court' } });
    fireEvent.click(screen.getByText(/Confirmer — Approuver la suspension/));
    expect(await screen.findByText(/Motif écrit obligatoire/)).toBeTruthy();
    expect(f.mock.calls.filter(([u]) => String(u).includes('/action'))).toHaveLength(0);
    expect(gardeAction(fiche().actions[2]!, 'Tutelle du ministère des Transports', { userId: '', jusquau: '' })).toMatch(/personne nommée/);
    expect(gardeAction({ ...fiche().actions[0]!, possible: false, raison: 'Décision réservée' }, 'x'.repeat(20))).toBe('Décision réservée');
  });

  it('aucune action financière directe : une fiche n’offre que les quatre issues', () => {
    mockApi('u-g', ['R01']);
    render(wrap(<FicheCard f={fiche()} />));
    for (const b of screen.getAllByRole('button')) expect(b.textContent).not.toMatch(/payer|annuler la dette|quittance|compte bénéficiaire|rembourser/i);
  });
});

describe('Écran d’accueil du Gouverneur (§ 27.5) — critère des 90 secondes', () => {
  it('« Une autorité ouvrant la plateforme sans formation identifie en moins de quatre-vingt-dix secondes ce qui attend sa décision et ce qui ne va pas dans son périmètre. » — aucune saisie requise', () => {
    mockApi('u-g', ['R01']);
    const t0 = performance.now();
    const { container } = render(wrap(<AccueilPoste a={accueilGouverneur() as never} onDone={() => {}} />));
    const ms = performance.now() - t0;
    expect(screen.getByText('Ce qui attend votre décision')).toBeTruthy();
    expect(screen.getByText('La Ville aujourd’hui · exercice en cours')).toBeTruthy();
    expect(screen.getByText('Ce qui ne va pas')).toBeTruthy();
    expect(screen.getByText('Écart de rapprochement sur 3 jours.')).toBeTruthy();
    expect(screen.getByText('Communes')).toBeTruthy();
    // Aucun filtre, aucune période, aucune commune à choisir : aucun champ de saisie sur l'écran d'accueil.
    expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0);
    expect(screen.getByText('Urgent')).toBeTruthy();
    expect(screen.getByText(/\[EXEMPLE\] Illustration de la maquette/)).toBeTruthy();
    expect(ms).toBeLessThan(3000);
  });

  it('hors connexion : les fiches en attente et l’écran d’accueil restent consultables sur l’appareil', async () => {
    mockApi('u-g', ['R01']);
    ecrireHorsLigne('u-g', 'accueil', accueilGouverneur());
    render(wrap(<Routes><Route path="/poste-de-decision" element={<PosteDecision />} /></Routes>, '/poste-de-decision'));
    await waitFor(() => expect(screen.getByText(/Hors connexion — données conservées sur l’appareil/)).toBeTruthy());
    expect(screen.getByText('Cabinet du Gouverneur')).toBeTruthy();
    expect(screen.getAllByText('Suspendre l’habilitation d’un centre de contrôle technique agréé').length).toBeGreaterThan(0);
    expect(screen.getByText('Les règles qui tiennent ces écrans')).toBeTruthy();
    expect(screen.getByText('Lundi')).toBeTruthy();
  });

  it('la note du lundi est conservée hors connexion et affiche la source de chaque chiffre', async () => {
    mockApi('u-g', ['R01']);
    ecrireHorsLigne('u-g', 'accueil', accueilGouverneur());
    ecrireHorsLigne('u-g', 'note', {
      courante: { id: 'NOTE-1', sha256: 'a'.repeat(64), version: 1, produiteLe: '2026-09-26T09:00:00.000Z', contenu: {
        titre: 'La note du lundi', semaine: { code: '2026-S39', lundi: '2026-09-21', dimanche: '2026-09-27' }, arreteAu: '2026-09-26', recettes: [chiffre({ libelle: 'Encaissé — semaine 2026-S39' })],
        decisions: [{ date: '2026-09-26', geste: 'APPROUVER', objet: 'Suspendre l’habilitation', effet: 'Non engagé' }], communes: { base: 'Classement (test)', enAvance: [{ commune: 'Gombe', valeur: '1' }], enRetard: [{ commune: 'Ndjili', valeur: '0' }] },
        alertes: [{ cause: 'Écart de rapprochement.', ageJours: 3 }], echeances7j: [{ objet: 'Suspendre l’habilitation', echeance: '2026-10-01' }], remontees: [], indicateursHorsCible: [], sources: ['Échelle unifiée de la recette (pilotage)'], ia: 'Note déterministe, produite sans IA.',
      } }, historique: [{ id: 'NOTE-1', semaine: { code: '2026-S39' }, version: 1, sha256: 'a'.repeat(64), produiteLe: '2026-09-26T09:00:00.000Z' }], horsConnexion: 'Consultable hors connexion.',
    });
    render(wrap(<Routes><Route path="/poste-de-decision/:vue" element={<PosteDecision />} /></Routes>, '/poste-de-decision/note'));
    expect(await screen.findByText(/La note du lundi — semaine 2026-S39/)).toBeTruthy();
    expect(screen.getByText('Encaissé — semaine 2026-S39')).toBeTruthy();
    expect(screen.getByText(/Échelle unifiée de la recette \(pilotage\)/)).toBeTruthy();
    expect(screen.getByText('Non engagé')).toBeTruthy();
  });
});

describe('Poste de travail (§ 27.13) : file de travail séparée de la corbeille', () => {
  it('écran d’entrée, indicateur dominant, file de travail et lien distinct vers la corbeille de décision', () => {
    mockApi('u-dg', ['R06']);
    const t: Travail = {
      famille: 'POSTE_DE_TRAVAIL', question: '« Que dois-je traiter aujourd’hui ? »', enAttente: 1,
      postes: [{ code: 'DIRECTEUR_REGIE', utilisateur: 'Directeur de régie', ecranEntree: 'Assiette, recouvrement, contentieux, performance des agents et des centres', indicateurDominant: 'Écart à l’assignation et couverture du recensement', liens: [{ libelle: 'Poste de travail — régie fiscale (n° 42)', chemin: '/decision/regie-fiscale' }], indicateur: [{ code: 'ECART_ASSIGNATION', libelle: 'Écart à l’assignation', valeur: null, unite: '%', statut: 'NON_MESURE' }] }],
      file: [{ id: 'BASE:X', module: 'Planification', objet: 'Certifier « Coûts » (2026-T3)', demandeur: 'Ministre', depose: '2026-09-26T09:00:00Z', echeance: null, enRetard: false, ecran: '/pilotage/base-reference', categorie: null, individuel: false }],
      corbeille: { lien: '/poste-de-decision', note: 'Les deux restent séparées à l’écran.' },
    };
    render(wrap(<TravailVue t={t} />));
    expect(screen.getByText('Directeur de régie')).toBeTruthy();
    expect(screen.getByText(/Indicateur dominant : Écart à l’assignation et couverture du recensement/)).toBeTruthy();
    expect(screen.getByText('Certifier « Coûts » (2026-T3)').closest('a')!.getAttribute('href')).toBe('/pilotage/base-reference');
    expect(screen.getByText('Ouvrir le poste de décision').getAttribute('href')).toBe('/poste-de-decision');
  });
});
