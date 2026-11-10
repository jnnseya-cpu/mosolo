import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { KpiTiles, LadderList, type Kpi, type LadderLevel } from '../src/modules/pilotage/shared';
import { renderWithApp } from './helpers';

const lvl = (rank: number, level: string, label: string, measure: LadderLevel['measure'], amounts: LadderLevel['amounts'] = [], count: number | null = null): LadderLevel => ({
  rank, level, label, definition: `Définition ${label}`, measure, measured: measure !== 'NON_MESURE', amounts, consolidatedCdf: amounts.length ? { amount: '420000.00', currency: 'CDF' } : null,
  count, source: 'socle', dateBasis: '—', channelFilterApplies: false,
});

describe('Pilotage — composants', () => {
  it('échelle : niveaux mesurés en devise légale, niveaux de modèle déclarés non mesurés', () => {
    renderWithApp(<LadderList levels={[
      lvl(1, 'potential', 'Potentiel estimé', 'NON_MESURE'),
      lvl(2, 'verified_base', 'Assiette vérifiée', 'COMPTE', [], 3),
      lvl(9, 'reconciled', 'Rapproché', 'MONTANT', [{ amount: '150.00', currency: 'USD' }], 1),
    ]} />);
    expect(screen.getByText('Non mesuré — modèle')).toBeTruthy();
    expect(screen.getByText('3 objet(s)')).toBeTruthy();
    expect(screen.getByText(/150/)).toBeTruthy();
  });

  it('indicateurs : statut, cible et tendance ; non mesuré affiché comme tel', () => {
    const base: Omit<Kpi, 'code' | 'label' | 'value' | 'status'> = {
      domain: 'Rapprochement', definition: 'd', formula: 'f', source: 's', unit: '%', targetLabel: '≥ 95 %', better: 'HAUSSE', reference: '§ 39', measurable: true,
      trend: { previous: '90.0', window: '7 jours', direction: 'HAUSSE', favorable: true },
    };
    renderWithApp(<KpiTiles kpis={[
      { ...base, code: 'A', label: 'Taux de rapprochement à J+1', value: '96.4', status: 'ATTEINTE', numerator: 27, denominator: 28 },
      { ...base, code: 'B', label: 'Taux de recensement', value: null, status: 'NON_MESURE', measurable: false, trend: { previous: null, window: '7 jours', direction: 'INDISPONIBLE', favorable: null } },
    ]} />);
    expect(screen.getByText('Cible atteinte')).toBeTruthy();
    expect(screen.getAllByText('Non mesuré').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('↑ sur 7 jours')).toBeTruthy();
    expect(screen.getByText(/27\/28/)).toBeTruthy();
  });
});
