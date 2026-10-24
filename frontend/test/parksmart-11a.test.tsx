import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderWithApp } from './helpers';
import ParkSmartPilotage, { GRID_STATUS, TARGET_CELL } from '../src/modules/parking/ParkSmartPilotage';
import { MODULE_ROUTES } from '../src/modules/registry';

describe('ParkSmart § 11A — écran de pilotage', () => {
  it('rend un état explicite sans utilisateur (écran réservé)', () => {
    const { getByText, unmount } = renderWithApp(<MemoryRouter><ParkSmartPilotage /></MemoryRouter>);
    expect(getByText('Écran réservé au pilotage et à la régie')).toBeTruthy();
    unmount();
  });
  it('libellés : trois statuts de grille (jamais la couleur seule) et cible d’occupation', () => {
    expect(GRID_STATUS.ACTE_REQUIS.label).toBe('Acte requis');
    expect(GRID_STATUS.A_VERIFIER.label).toBe('À vérifier');
    expect(TARGET_CELL.SATURE).toBe('Saturée');
  });
  it('est enregistré dans le registre des écrans, visible de la régie', () => {
    const r = MODULE_ROUTES.find((x) => x.path === '/stationnement/parksmart');
    expect(r?.nav?.roles).toContain('R07');
    expect(MODULE_ROUTES.some((x) => x.path === '/stationnement/regie')).toBe(true);
  });
});
