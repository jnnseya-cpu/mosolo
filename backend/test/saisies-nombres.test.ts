/**
 * Audit des saisies (01/10/2026) : les montants et nombres se saisissent comme une personne les tape — virgule
 * décimale, espaces de milliers — et sont ramenés à la forme canonique ; une valeur invalide reste refusée.
 */
import { describe, expect, it } from 'vitest';
import { decimalString, moneySchema, normaliserNombre } from '../src/core/http.js';

describe('Saisie des nombres', () => {
  it('virgule française et espaces de milliers acceptés ; forme canonique ; texte refusé', () => {
    expect(normaliserNombre('12,5')).toBe('12.5');
    expect(normaliserNombre('1 500')).toBe('1500');
    expect(normaliserNombre('1 500,00')).toBe('1500.00');
    expect(moneySchema.parse({ amount: '1 500,75', currency: 'CDF' })).toEqual({ amount: '1500.75', currency: 'CDF' });
    expect(moneySchema.parse({ amount: '150.00', currency: 'USD' }).amount).toBe('150.00');
    expect(decimalString.parse('3,25')).toBe('3.25');
    expect(moneySchema.safeParse({ amount: 'douze', currency: 'CDF' }).success).toBe(false);
    expect(moneySchema.safeParse({ amount: '-5', currency: 'CDF' }).success).toBe(false);
  });
});

describe('Saisie des nombres — règle du socle', () => {
  it('un nombre JSON (flottant) reste refusé : seule une chaîne saisie est normalisée', () => {
    expect(moneySchema.safeParse({ amount: 120.5, currency: 'USD' }).success).toBe(false);
  });
});
