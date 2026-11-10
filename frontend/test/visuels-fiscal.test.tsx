/**
 * Visuels du périmètre « fiscal » (fiscal, citoyen, référentiel, juridique, opportunités — 27/09/2026) : les graphiques
 * se rendent avec des données réelles, affichent l'état vide, offrent la vue tableau, et ne montrent jamais une valeur
 * absente comme un zéro (« non mesuré » avec motif). Les écrans restent inchangés sous les visuels.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/context';
import {
  AnomaliesVisuels, BiensVisuels, CarteVisuels, DeclarationsVisuels, RecensementVisuels, RepriseVisuels, repartition, COLOR_STATES,
} from '../src/modules/fiscal/visuels';
import { SyntheseIndicateurs, TuilesIndicateurs } from '../src/modules/citoyen/visuels';
import { ListeTravailVisuels, RegistreVisuels } from '../src/modules/opportunites/visuels';
import { DonneesVisuels, PointsVisuels } from '../src/modules/juridique/visuels';
import { RecettesVisuels } from '../src/modules/referentiel/visuels';
import type { FiscalObjectView, MapResponse } from '../src/modules/fiscal/types';

function wrap(ui: ReactElement) {
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
  return render(<AppProvider initialLang="fr"><MemoryRouter>{ui}</MemoryRouter></AppProvider>);
}
afterEach(() => localStorage.clear());

const obj = (id: string, color: 'green' | 'amber' | 'red', commune: string, over: Partial<FiscalObjectView> = {}): FiscalObjectView => ({
  id, category: 'PARCELLE', categoryLabel: 'Parcelle', commune, quartier: 'Q', avenue: null, localityRank: 2, status: 'VALIDE', probativeStatus: 'VERIFIE',
  igf: { code: `KIN-${id}`, uuid: '00000000-0000', assignedAt: '2026-09-01' }, holder: 'moi', highValue: false, attributes: {},
  situation: { color, label: color, reason: 'motif' }, coverage: { color: 'green', label: 'ok', reason: '' }, occupancy: { code: 'O', label: 'Occupé' },
  tree: { geo: [], objects: [], children: [] }, plate: null, relations: [{ role: 'PROPRIETAIRE', roleLabel: 'Propriétaire', share: null, from: '2026-01-01', status: 'VALIDEE', own: true }],
  leases: [], example: true, ...over,
});

describe('repartition (répartition par état)', () => {
  it('garde l’ordre de la table, compte zéro les états absents et conserve les états inconnus', () => {
    const r = repartition([{ s: 'amber' }, { s: 'amber' }, { s: 'green' }, { s: 'XYZ' }], (x) => x.s, COLOR_STATES);
    expect(r.map((i) => [i.key, i.count])).toEqual([['green', 1], ['amber', 2], ['red', 0], ['blue', 0], ['grey', 0], ['XYZ', 1]]);
    expect(r.find((i) => i.key === 'XYZ')!.tone).toBe('neutral');
  });
});

describe('Biens et relations — résumé visuel', () => {
  it('tuiles, répartition des couleurs de situation, catégories, carte des communes (agent) et vue tableau', () => {
    wrap(<BiensVisuels taxpayer={false} objets={[obj('A', 'green', 'Limete'), obj('B', 'amber', 'Limete'), obj('C', 'red', 'Gombe', { igf: null })]} />);
    expect(screen.getByText('Objets de mon périmètre')).toBeTruthy();
    expect(screen.getByText('Situation fiscale des biens')).toBeTruthy();
    expect(screen.getByText('Objets recensés par commune')).toBeTruthy();
    expect(screen.getByText('1 provisoire(s)')).toBeTruthy();
    // Répartition : libellé + icône + nombre (jamais la couleur seule).
    const grp = screen.getByRole('group', { name: /Situation fiscale des biens : Vert 1/ });
    expect(within(grp).getByText('Ambre')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /Vue tableau|Tableau/ })[0]!);
    expect(screen.getAllByRole('table').length).toBeGreaterThan(0);
  });
  it('contribuable : pas de carte des communes ; liste vide = état vide, pas de zéro dessiné', () => {
    wrap(<BiensVisuels taxpayer objets={[]} />);
    expect(screen.queryByText('Objets recensés par commune')).toBeNull();
    expect(screen.getByText('Aucun bien visible.')).toBeTruthy();
  });
});

describe('Carte à deux couches — agrégats', () => {
  it('commune masquée (moins de N objets) = non mesurée, jamais 0', () => {
    const d: MapResponse = {
      layer: 'situation', scope: 'AGENT', threshold: 20, notice: '', example: true,
      legend: [{ color: 'green', label: 'Régularisé' }],
      communes: [
        { commune: 'Limete', code: 'LIM', total: 41, byColor: { green: 10, amber: 30, red: 1, grey: 0, blue: 0 }, dominant: 'amber', masked: false },
        { commune: 'Gombe', code: 'GOM', total: null, byColor: null, dominant: 'grey', masked: true },
      ],
      objects: [],
    };
    wrap(<CarteVisuels d={d} />);
    expect(screen.getByText('Situation fiscale — toutes communes')).toBeTruthy();
    expect(screen.getByRole('group', { name: /Régularisé 10/ })).toBeTruthy();
    expect(screen.getAllByText(/moins de 20 objets/).length).toBeGreaterThan(0);
  });
});

describe('Déclarations, anomalies, recensement, reprise', () => {
  it('déclarations par état et par suite donnée', () => {
    const d = { id: 'D1', status: 'LIQUIDEE', kind: 'IRL', period: '2026', verificationRequired: false, liquidation: { mode: 'SIMULATION_NON_OPPOSABLE', message: '' } };
    wrap(<DeclarationsVisuels taxpayer decls={[d as never]} />);
    expect(screen.getByText('Mes déclarations')).toBeTruthy();
    expect(screen.getByText('Déclarations par état')).toBeTruthy();
    expect(screen.getByRole('group', { name: /Liquidée 1/ })).toBeTruthy();
  });
  it('signal sans protocole actif : non mesuré (aucune donnée reçue)', () => {
    wrap(<AnomaliesVisuels cases={[{ status: 'A_EXAMINER', commune: 'Limete' }]}
      signals={[{ code: 'A', label: 'Compteurs', open: 1, protocol: { active: true } }, { code: 'B', label: 'Paie', open: 0, protocol: { active: false } }]} />);
    expect(screen.getByText('Dossiers ouverts par signal')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /Vue tableau|Tableau/ })[0]!);
    const row = screen.getAllByRole('row').find((r) => /Paie/.test(r.textContent ?? ''))!;
    expect(within(row).getByText('non mesuré')).toBeTruthy();
  });
  it('recensement : vagues atteintes et 24 communes', () => {
    wrap(<RecensementVisuels d={{ total: 10, imported: 0, withExplicitProvenance: 0, stages: [{ stage: 0, label: 'Préparation', count: 0, atLeast: 10 }, { stage: 4, label: 'Fiscalisation', count: 4, atLeast: 4 }], byCommune: { Limete: { 0: 6, 4: 4 } } }} />);
    expect(screen.getByText('Objets ayant atteint au moins chaque vague')).toBeTruthy();
    expect(screen.getByText('sur 10 objet(s)')).toBeTruthy();
    expect(screen.getAllByText('Kinshasa').length).toBeGreaterThan(0);
  });
  it('reprise : aucun lot = états vides', () => {
    wrap(<RepriseVisuels lots={[]} />);
    expect(screen.getByText('Aucun lot déposé.')).toBeTruthy();
  });
});

describe('Parcours du citoyen — tuiles d’indicateurs', () => {
  it('ratio en %, valeur null = « Non mesuré » avec raison, ventilation en barres', () => {
    wrap(<TuilesIndicateurs titre="Module 2" indicateurs={{
      tauxRejet: { valeur: '25.0', numerateur: 1, denominateur: 4 },
      delaiMoyen: { valeur: null, raison: 'Aucune déclaration décidée.' },
      enrolementsParCanal: { valeur: 2, parCanal: { AGENT: 2, WEB: 0 } },
      gratuite: 'Enrôlement gratuit.',
    }} />);
    expect(screen.getByText('1 / 4')).toBeTruthy();
    expect(screen.getByText('Non mesuré')).toBeTruthy();
    expect(screen.getByText('Aucune déclaration décidée.')).toBeTruthy();
    expect(screen.getByText('Enrôlements par canal — par canal')).toBeTruthy();
    expect(screen.queryByText('Enrôlement gratuit.')).toBeNull();
  });
  it('synthèse des modules : mesurés / non mesurés', () => {
    wrap(<SyntheseIndicateurs modules={[{ module: 1, titre: 'Identité', indicateurs: { a: { valeur: 1 }, b: { valeur: null, raison: 'x' } } }]} />);
    expect(screen.getByRole('group', { name: /Mesuré 1 \(50 %\), Non mesuré \(motif affiché\) 1/ })).toBeTruthy();
  });
});

describe('Opportunités, juridique, référentiel', () => {
  it('registre des opportunités : état et avancement du pipeline', () => {
    wrap(<RegistreVisuels all={[{ id: 'O1', code: 'G1', title: 't', section: '8.1', track: 'SANS_TEXTE_NOUVEAU', origin: 'CAHIER', cahierPriority: 1, status: 'EN_INSTRUCTION', decision: null, domains: [], completed: 3, nextStep: null }]} />);
    expect(screen.getByText('Étapes complétées du pipeline')).toBeTruthy();
    expect(screen.getByRole('group', { name: /En instruction 1/ })).toBeTruthy();
  });
  it('liste de travail vide : état vide', () => {
    wrap(<ListeTravailVisuels items={[]} />);
    expect(screen.getByText('Liste vide.')).toBeTruthy();
  });
  it('points juridiques : progression suivie sans cible inventée', () => {
    wrap(<PointsVisuels fonctions={[{ enAttente: true }]} points={[{ statut: 'OUVERT', autorite: 'Finances', proposition: null }, { statut: 'TRANCHE', autorite: 'Finances', proposition: null }]} />);
    expect(screen.getByText('Suivi (sans cible)')).toBeTruthy();
    expect(screen.getByRole('meter')).toBeTruthy();
  });
  it('données : dépôts par classe C1 à C5', () => {
    wrap(<DonneesVisuels classes={{ C5: 'Secret' }} depots={[{ classe: 'C5', enregistrements: 12, purgeable: false, source: 'EXACT' }]} />);
    expect(screen.getByText('Dépôts par classe')).toBeTruthy();
  });
  it('référentiel : aucun pourcentage (le référentiel ne porte aucun taux)', () => {
    wrap(<RecettesVisuels codes={null} sections={[{ id: '7.1', title: '§ 7.1 — Impôts provinciaux' }]}
      lines={[{ code: 'R1', section: '7.1', competenceLabel: 'Province', activation: { activable: false }, inventory: [{ renseigne: true }, { renseigne: false }] }]} />);
    expect(screen.getByText('Lignes par section du Cahier (ch. 7)')).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
  });
});
