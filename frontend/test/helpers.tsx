import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { AppProvider } from '../src/context';

/** Rend un composant dans le contexte applicatif, backend simulé hors ligne. */
export function renderWithApp(ui: ReactElement) {
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
  return render(<AppProvider initialLang="fr">{ui}</AppProvider>);
}
