import { describe, it, expect } from 'vitest';
import { readValidity, bandForPct, validityText } from '../src/validity.js';

const F = '2026-09-26T08:00:00Z';
const U = '2026-09-26T18:00:00Z'; // 10 h de validité
const at = (h: number) => new Date(Date.parse(F) + h * 3_600_000);

describe('règle de couleur de validité 50 % / 1 %', () => {
  it('seuils exacts', () => {
    expect(bandForPct(100)).toBe('VERT');
    expect(bandForPct(50)).toBe('VERT');
    expect(bandForPct(49.99)).toBe('AMBRE');
    expect(bandForPct(1)).toBe('AMBRE');
    expect(bandForPct(0.99)).toBe('ROUGE');
    expect(bandForPct(0.1)).toBe('ROUGE');
  });
  it('sur une fenêtre réelle, à l’heure serveur', () => {
    expect(readValidity(F, U, at(0)).band).toBe('VERT');
    expect(readValidity(F, U, at(5.0)).band).toBe('VERT'); // 50 % restant
    expect(readValidity(F, U, at(5.1)).band).toBe('AMBRE'); // 49 %
    expect(readValidity(F, U, at(9.9)).band).toBe('AMBRE'); // 1 % (6 min sur 10 h)
    expect(readValidity(F, U, at(9.95)).band).toBe('ROUGE'); // 0,5 %
    expect(readValidity(F, U, at(10)).band).toBe('EXPIRE');
    expect(readValidity(F, U, at(-1)).band).toBe('PAS_ACTIF');
    expect(readValidity(F, null, at(3)).band).toBe('PERMANENT');
  });
  it('la couleur est toujours accompagnée d’un texte', () => {
    expect(validityText(readValidity(F, U, at(9)))).toMatch(/^⚠ VALIDE — encore 1 h 00 min/);
    expect(validityText(readValidity(F, U, at(9.95)))).toMatch(/EXPIRE DANS 3 min/);
    expect(validityText(readValidity(F, U, at(11)))).toMatch(/EXPIRÉ DEPUIS 1 h 00 min/);
    expect(validityText(readValidity(F, U, at(1)))).toMatch(/^✓ VALIDE/);
  });
});
