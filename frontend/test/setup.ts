import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());

// jsdom n'a pas ResizeObserver (trousse de visualisation, Recharts) : bouchon inerte pour les écrans équipés de graphiques.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
}

if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// jsdom n'a pas ResizeObserver (ResponsiveContainer de Recharts, trousse de visualisation) : bouchon inerte partagé.
if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
// jsdom n'a pas ResizeObserver (Recharts ResponsiveContainer, trousse de visualisation) : bouchon inerte partagé.
// jsdom n'a pas ResizeObserver (ResponsiveContainer de Recharts, trousse de visualisation) : bouchon inerte commun,
// pour que les écrans équipés de graphiques se rendent dans tous les tests (27/09/2026).
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
}
