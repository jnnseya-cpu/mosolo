import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { screen } from '@testing-library/react';
import { renderWithApp } from './helpers';
import ParkingDriver from '../src/modules/parking/ParkingDriver';
import ParkingControl from '../src/modules/parking/ParkingControl';
import ParkingRegie from '../src/modules/parking/ParkingRegie';
import AdvertiserSpace from '../src/modules/publicite/AdvertiserSpace';
import AdInspector from '../src/modules/publicite/AdInspector';
import AdRegie from '../src/modules/publicite/AdRegie';
import AdVerify from '../src/modules/publicite/AdVerify';
import { fmtMinutes, pctText } from '../src/modules/parking/shared';

describe('ParkSmart / KIN PUB CONTROL — écrans (hors ligne, sans utilisateur)', () => {
  it('rendent un état explicite sans planter', () => {
    for (const C of [ParkingDriver, ParkingControl, ParkingRegie, AdvertiserSpace, AdInspector, AdRegie]) {
      const { unmount } = renderWithApp(<MemoryRouter><C /></MemoryRouter>);
      unmount();
    }
    renderWithApp(<MemoryRouter><AdVerify /></MemoryRouter>);
    expect(screen.getByText('Vérifier un support ou un contrôleur')).toBeTruthy();
  });
  it('formats', () => {
    expect(fmtMinutes(90)).toBe('1 h 30');
    expect(fmtMinutes(45)).toBe('45 min');
    expect(pctText('62.5')).toBe('62,5 %');
    expect(pctText(null)).toBe('—');
  });
});
