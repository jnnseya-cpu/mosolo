import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { OverduePenalties, type OverduePenaltiesData } from '../src/components/OverduePenalties';
import { renderWithApp } from './helpers';

const data: OverduePenaltiesData = {
  count: 1, thresholdDays: 30, guidance: 'Informez le titulaire : il règle par téléphone, USSD ou point agréé.',
  lines: [{ module: '71', moduleLabel: 'Stationnement', reference: 'PK-2026-000123', nature: 'Stationnement non payé', decidedAt: '2026-07-01T10:00:00Z', overdueDays: 88 }],
};

describe('OverduePenalties', () => {
  it('affiche la référence, l’ancienneté et la consigne, sans aucun montant', () => {
    const { container } = renderWithApp(<OverduePenalties data={data} />);
    expect(screen.getByText('PK-2026-000123')).toBeTruthy();
    expect(screen.getByText(/Pénalités impayées depuis plus de 30 jours/)).toBeTruthy();
    expect(screen.getByText('impayée depuis 88 jours')).toBeTruthy();
    expect(screen.getByText(/Aucun montant n’est affiché ici/)).toBeTruthy();
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\b(CDF|USD|FC)\b/);
    expect(text).not.toMatch(/\d[\d\s.,]*\s?(CDF|USD|\$)/);
  });

  it('ne rend rien sans données ni pour un compte nul', () => {
    const a = renderWithApp(<OverduePenalties data={undefined} />);
    expect(a.container.querySelector('.overdue-pen')).toBeNull();
    const b = renderWithApp(<OverduePenalties data={{ ...data, count: 0, lines: [] }} />);
    expect(b.container.querySelector('.overdue-pen')).toBeNull();
  });
});
