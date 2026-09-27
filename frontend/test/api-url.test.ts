/**
 * Adresse de l'API : une construction de production sans VITE_API_URL appelle la même origine (application servie par
 * l'API), jamais « localhost » — sinon injoignable pour l'usager et bloquée par la politique de contenu (CSP).
 */
import { describe, expect, it } from 'vitest';
import { resolveApiUrl } from '../src/lib/api';

describe('Adresse de l’API', () => {
  it('production sans VITE_API_URL : même origine', () => {
    expect(resolveApiUrl({ DEV: false })).toBe('');
    expect(resolveApiUrl({ DEV: false, VITE_API_URL: '' })).toBe('');
  });
  it('développement : API locale par défaut ; valeur explicite toujours prioritaire, sans « / » final', () => {
    expect(resolveApiUrl({ DEV: true })).toBe('http://localhost:8080');
    expect(resolveApiUrl({ DEV: false, VITE_API_URL: 'https://api.mosolo.example/' })).toBe('https://api.mosolo.example');
  });
});
