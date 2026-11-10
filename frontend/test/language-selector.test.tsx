import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { CurrencySelector, LanguageSelector } from '../src/components/Selectors';
import { renderWithApp } from './helpers';

describe('Sélecteurs', () => {
  it('affiche les langues par leur nom natif, sans drapeau, avec la mention brouillon', () => {
    renderWithApp(<LanguageSelector />);
    const select = screen.getByLabelText('Langue') as HTMLSelectElement;
    const labels = [...select.options].map((o) => o.textContent ?? '');
    for (const name of ['Français', 'Lingála', 'Kiswahili', 'Kikongo', 'Tshilubà', 'English']) {
      expect(labels.some((l) => l.startsWith(name))).toBe(true);
    }
    expect(labels[0]).toBe('Français');
    expect(labels.find((l) => l.startsWith('Lingála'))).toContain('brouillon');
    // Aucun drapeau (indicateurs régionaux U+1F1E6–U+1F1FF) pour une langue
    expect(labels.join('')).not.toMatch(/[\u{1F1E6}-\u{1F1FF}]/u);
  });

  it('affiche les devises avec drapeau et code, franc congolais en premier', () => {
    renderWithApp(<CurrencySelector />);
    const select = screen.getByLabelText('Devise d’affichage') as HTMLSelectElement;
    const labels = [...select.options].map((o) => o.textContent ?? '');
    expect(labels[0]).toBe('🇨🇩 CDF');
    expect(labels[1]).toBe('🇺🇸 USD');
    expect(labels[2]).toBe('🇪🇺 EUR');
  });
});
