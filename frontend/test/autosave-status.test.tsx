import { describe, expect, it } from 'vitest';
import { AutosaveStatus } from '../src/components/AutosaveStatus';
import type { AutosaveState } from '../src/hooks/useAutosave';
import { renderWithApp } from './helpers';

function textFor(state: AutosaveState) {
  const { container, unmount } = renderWithApp(<AutosaveStatus state={state} />);
  const live = container.querySelector('[role="status"]');
  const out = { text: live?.textContent?.trim() ?? '', ariaLive: live?.getAttribute('aria-live'), kind: live?.getAttribute('data-state') };
  unmount();
  return out;
}

describe('AutosaveStatus', () => {
  it('annonce « Enregistré à HH:MM » (aria-live polite)', () => {
    const at = new Date(2027, 1, 10, 9, 15).toISOString();
    const r = textFor({ kind: 'saved', at });
    expect(r.text).toBe('Enregistré à 09:15');
    expect(r.ariaLive).toBe('polite');
    expect(r.kind).toBe('saved');
  });
  it('affiche les états enregistrement, hors ligne et erreur', () => {
    expect(textFor({ kind: 'saving' }).text).toBe('Enregistrement…');
    expect(textFor({ kind: 'offline' }).text).toBe('Hors ligne — enregistré sur l’appareil');
    expect(textFor({ kind: 'error' }).text).toBe('Échec de l’enregistrement — nouvelle tentative');
  });
});
