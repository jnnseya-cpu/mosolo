import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { DashboardsView, GridView, LeversView, PipelineView, WorklistView, type Lever, type StepView, type WorklistItem } from '../src/modules/opportunites/shared';
import { OpportunitySheet } from '../src/modules/opportunites/Registre';
import { visibleNav } from '../src/components/Shell';
import { renderWithApp } from './helpers';

const steps: StepView[] = ['Signal', 'Qualification juridique', 'Estimation', 'Impact socio-économique', 'Risque de corruption', 'Coût d’implémentation', 'Pilote', 'Décision'].map((label, i) => ({
  n: i + 1, code: `S${i + 1}`, label, content: `Contenu ${i + 1}`, responsible: i === 7 ? 'Autorité compétente' : 'Responsable', roles: i === 7 ? ['R01', 'R04', 'R05'] : ['R06'],
  done: i === 0, record: i === 0 ? { completedBy: 'u-dg-dgipk', completedAt: '2026-09-26T09:00:00Z', summary: 'Signal confirmé' } : null,
}));
const grid = Object.fromEntries(['faisabiliteJuridique', 'objectif', 'autorite', 'faitGenerateur', 'population', 'methodeCalcul', 'coutMiseEnOeuvre', 'impactSocial', 'impactEconomique', 'risqueCorruption', 'exigencesControle', 'texteRequis', 'priorite', 'recommandationPilote']
  .map((k) => [k, { value: k === 'texteRequis' ? 'Édit provincial' : null, source: 'Cahier v2.9, § 8.2', updatedAt: '2026-09-26', updatedBy: 'cahier-v2.9' }]));
const potential = { prudent: null, attendu: null, ambitieux: null, hypothesisIds: [], note: 'à estimer par le recensement pilote' };

describe('Opportunités — vues', () => {
  it('pipeline en huit étapes avec responsable et état', () => {
    renderWithApp(<PipelineView steps={steps} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(8);
    expect(screen.getByText(/Autorité compétente/)).toBeTruthy();
    expect(screen.getAllByText('Complétée')).toHaveLength(1);
  });

  it('grille : rubriques « à instruire » et potentiel jamais inventé', () => {
    renderWithApp(<GridView opp={{ grid, potential }} />);
    expect(screen.getAllByText('À instruire').length).toBe(13);
    expect(screen.getByText('à estimer par le recensement pilote')).toBeTruthy();
    expect(screen.getByText('Édit provincial')).toBeTruthy();
  });

  it('fiche : l’étape de décision est réservée à l’autorité ; garde-fou affiché', () => {
    const opp = {
      id: 'OPP-G82-01', code: 'G82-01', title: 'Contribution environnementale sur les plastiques', section: '8.2' as const, track: 'ACTE_PROVINCIAL', origin: 'CAHIER', cahierPriority: null,
      status: 'EN_INSTRUCTION' as const, domains: [], completed: 7, nextStep: { n: 8, label: 'Décision', responsible: 'Autorité compétente', roles: ['R01', 'R04', 'R05'] },
      nature: null, condition: null, objective: 'Réduction des déchets plastiques', legalPath: 'Édit provincial', risksToControl: 'Double imposition', originRef: null, verticals: [],
      grid, potential, hypotheses: [], decision: null, stepsView: steps, source: 'Cahier',
    };
    renderWithApp(<OpportunitySheet opp={opp} roles={['R06']} onChange={() => {}} />);
    expect(screen.getByText(/réservée à Autorité compétente/)).toBeTruthy();
    expect(screen.getByText(/aucune opportunité ne devient une taxe par simple décision algorithmique/)).toBeTruthy();
    expect(screen.queryByText('Rendre la décision')).toBeNull();
  });

  it('décision : l’activation exige une base légale (bouton inactif sans référence)', () => {
    const opp = {
      id: 'OPP-G82-01', code: 'G82-01', title: 'Plastiques', section: '8.2' as const, track: 'ACTE_PROVINCIAL', origin: 'CAHIER', cahierPriority: null,
      status: 'EN_INSTRUCTION' as const, domains: [], completed: 7, nextStep: { n: 8, label: 'Décision', responsible: 'Autorité compétente', roles: ['R01', 'R04', 'R05'] },
      nature: null, condition: null, objective: null, legalPath: null, risksToControl: null, originRef: null, verticals: [], grid, potential, hypotheses: [], decision: null, stepsView: steps, source: 'Cahier',
    };
    renderWithApp(<OpportunitySheet opp={opp} roles={['R01']} onChange={() => {}} />);
    expect((screen.getByText('Rendre la décision') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Activation impossible sans base légale/)).toBeTruthy();
  });

  it('liste de travail : jamais d’avis automatique ; leviers non mesurés affichés comme tels ; tableaux séparés', () => {
    const items: WorklistItem[] = [{ id: 'LT-1', ruleCode: 'BAR_SANS_LICENCE', commune: 'Limete', quartier: null, lat: -4.37, lon: 15.34, priority: 74, status: 'A_EXAMINER', explanation: 'Point de vente [EXEMPLE]', automaticAssessment: 'AUCUN' }];
    renderWithApp(<WorklistView items={items} />);
    expect(screen.getAllByText('Aucun').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Bar sans autorisation (50 m)').length).toBeGreaterThan(0);
    const levers: Lever[] = [
      { n: 6, code: 'PAIEMENT', label: 'Paiement', action: 'a', gainMeasure: 'Conversion ordre → paiement', measured: true, value: '50.0 %', basis: 'b', source: 's' },
      { n: 9, code: 'FRAUDE', label: 'Fraude', action: 'a', gainMeasure: 'Déperdition évitée', measured: false, value: 'non mesuré', basis: 'b', source: null },
    ];
    renderWithApp(<LeversView levers={levers} />);
    expect(screen.getAllByText('Non mesuré').length).toBeGreaterThan(0);
    renderWithApp(<DashboardsView report={{ method: '', rule: '', ranked: [], notRanked: [], dashboards: [
      { kind: 'RECETTE_NOUVELLE', label: 'Recettes nouvelles', ranked: 0, notRanked: 3, netByCurrency: [] },
      { kind: 'RECLASSEMENT', label: 'Simple reclassement', ranked: 0, notRanked: 1, netByCurrency: [] },
    ] }} />);
    expect(screen.getAllByText('Simple reclassement').length).toBeGreaterThan(0);
  });

  it('navigation : écrans visibles selon le rôle (contribuable exclu)', () => {
    const to = (roles: string[]) => visibleNav(roles).map((n) => n.to);
    expect(to(['R01'])).toEqual(expect.arrayContaining(['/opportunites', '/opportunites/maximisation']));
    expect(to(['R25'])).toEqual(expect.arrayContaining(['/opportunites/recoupement']));
    expect(to(['R30'])).not.toContain('/opportunites');
  });
});
