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

  it('distingue les pénalités du module de l’agent (visibles à tout âge)', () => {
    const mixed: OverduePenaltiesData = { ...data, count: 2, lines: [
      { ...data.lines[0]!, reference: 'PK-2026-000200', overdueDays: 3, sameModule: true },
      { ...data.lines[0]!, module: '81', moduleLabel: 'Titres', reference: 'TT-2026-000009', overdueDays: 41, sameModule: false },
    ] };
    renderWithApp(<OverduePenalties data={mixed} />);
    expect(screen.getByText(/votre module, et autres modules au-delà de 30 jours/)).toBeTruthy();
    expect(screen.getAllByText(/· votre module/)).toHaveLength(1);
    expect(screen.getByText('impayée depuis 3 jours')).toBeTruthy();
  });

  it('ne rend rien sans données ni pour un compte nul', () => {
    const a = renderWithApp(<OverduePenalties data={undefined} />);
    expect(a.container.querySelector('.overdue-pen')).toBeNull();
    const b = renderWithApp(<OverduePenalties data={{ ...data, count: 0, lines: [] }} />);
    expect(b.container.querySelector('.overdue-pen')).toBeNull();
  });
});
