import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { OverduePenalties, type OverduePenaltiesData } from '../src/components/OverduePenalties';
import { renderWithApp } from './helpers';

const data: OverduePenaltiesData = {
  count: 1, thresholdDays: 30, guidance: '',
  lines: [{ module: '71', moduleLabel: 'Stationnement', reference: 'PK-2026-000123', nature: 'Stationnement non payé', decidedAt: '2026-07-01T10:00:00Z', overdueDays: 88, amount: { amount: '20000.00', currency: 'CDF' } }],
};

describe('OverduePenalties', () => {
  it('affiche la référence, l’ancienneté, le montant (non négociable) et la consigne', () => {
    const { container } = renderWithApp(<OverduePenalties data={data} />);
    expect(screen.getByText('PK-2026-000123')).toBeTruthy();
    expect(screen.getByText(/Pénalités impayées depuis plus de 30 jours/)).toBeTruthy();
    expect(screen.getByText('impayée depuis 88 jours')).toBeTruthy();
    expect(screen.getByText(/il ne se négocie pas/)).toBeTruthy();
    const text = container.textContent ?? '';
    expect(text).toMatch(/CDF/);
    expect(text).toMatch(/20.000,00/);
  });

  it('ne rend rien sans données ni pour un compte nul', () => {
    const a = renderWithApp(<OverduePenalties data={undefined} />);
    expect(a.container.querySelector('.overdue-pen')).toBeNull();
    const b = renderWithApp(<OverduePenalties data={{ ...data, count: 0, lines: [] }} />);
    expect(b.container.querySelector('.overdue-pen')).toBeNull();
  });
});
