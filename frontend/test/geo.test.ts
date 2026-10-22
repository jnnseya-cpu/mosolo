import { describe, expect, it } from 'vitest';
import { combine, qualityOf } from '../src/lib/geo';

describe('géolocalisation précise', () => {
  it('classe la qualité selon la précision et la source', () => {
    expect(qualityOf(4)).toBe('EXCELLENTE');
    expect(qualityOf(12)).toBe('BONNE');
    expect(qualityOf(40)).toBe('MOYENNE');
    expect(qualityOf(120)).toBe('FAIBLE');
    expect(qualityOf(3, 'MANUEL')).toBe('FAIBLE');
    expect(qualityOf(null)).toBe('FAIBLE');
  });

  it('moyenne pondérée des meilleurs relevés récents, en écartant les relevés trop imprécis ou anciens', () => {
    const now = 100_000;
    const r = combine([
      { lat: -4.3200, lon: 15.3100, acc: 8, t: now - 1000 },
      { lat: -4.3202, lon: 15.3102, acc: 8, t: now - 500 },
      { lat: -4.5, lon: 15.5, acc: 200, t: now - 200 }, // trop imprécis : écarté
      { lat: -4.9, lon: 15.9, acc: 3, t: now - 60_000 }, // trop ancien : écarté
    ], now)!;
    expect(r.used).toBe(2);
    expect(r.accuracy).toBe(8);
    expect(r.lat).toBeCloseTo(-4.3201, 6);
    expect(r.lon).toBeCloseTo(15.3101, 6);
    expect(combine([], now)).toBeNull();
  });
});
