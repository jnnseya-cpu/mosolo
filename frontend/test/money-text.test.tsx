import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { formatMoney } from '@mosolo/shared';
import { MoneyText } from '../src/components/MoneyText';
import { renderWithApp } from './helpers';

describe('MoneyText', () => {
  it('affiche le drapeau et le code ISO via formatMoney (CDF, devise principale)', () => {
    const m = { amount: '1250000.00', currency: 'CDF' as const };
    const { container } = renderWithApp(<MoneyText money={m} />);
    const main = container.querySelector('.money-main');
    expect(main?.textContent).toBe(formatMoney(m, { locale: 'fr' }));
    expect(main?.textContent).toContain('🇨🇩 CDF');
    expect(main?.textContent).toMatch(/1.250.000,00$/);
    // Pas de contre-valeur quand la devise légale est déjà le CDF
    expect(container.querySelector('.money-indicative')).toBeNull();
  });

  it('garde la devise légale (USD) et ajoute la contre-valeur indicative en CDF', () => {
    const m = { amount: '450.00', currency: 'USD' as const };
    const indicative = { amount: '1282500.00', currency: 'CDF' as const };
    renderWithApp(<MoneyText money={m} indicative={indicative} />);
    expect(screen.getByText(formatMoney(m, { locale: 'fr' }))).toBeTruthy();
    const ind = screen.getByText(/contre-valeur indicative/);
    expect(ind.textContent).toContain('🇨🇩 CDF');
    expect(ind.textContent).toContain(formatMoney(indicative, { locale: 'fr' }));
  });

  it('montant masqué au profil (null, p. ex. agent de terrain) : « — », jamais d’erreur de rendu', () => {
    const { container } = renderWithApp(<MoneyText money={null} />);
    expect(container.textContent).toBe('—');
    expect(container.querySelector('.money-main')).toBeNull();
  });
});
