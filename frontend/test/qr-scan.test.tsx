import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { scanTarget } from '../src/modules/preuves/scan';
import { QrScanner } from '../src/components/QrScanner';
import { renderWithApp } from './helpers';

describe('QR scanné → page de vérification', () => {
  it.each([
    ['https://mosolo.kinshasa.cd/preuve/PKT4K7M2QX/imprimer', '/preuve/PKT4K7M2QX'],
    ['https://mosolo.kinshasa.cd/fiscal/verifier/bien/QZ8Z4NJZH?s=7a73', '/fiscal/verifier/bien/QZ8Z4NJZH?s=7a73'],
    ['https://mosolo.kinshasa.cd/publicite/verifier?plaque=SGt8tqIfOsPFdP_k', '/publicite/verifier?plaque=SGt8tqIfOsPFdP_k'],
    ['https://mosolo.kinshasa.cd/verifier-agent/AG-7K4M2Q-X', '/verifier-agent/AG-7K4M2Q-X'],
    ['https://mosolo.kinshasa.cd/canaux/verifier-carte?t=abc', '/canaux/verifier-carte?t=abc'],
    ['https://api.mosolo.cd/l/v?c=EVT-2026-00001-W', '/preuve/EVT-2026-00001-W'],
    ['MOSOLO1|Q26KIN0000000303|sig|DUPLICATA-2', '/verifier/Q26KIN0000000303?duplicata=2'],
    ['PKT4K7M2QX', '/preuve/PKT4K7M2QX'],
  ])('%s → %s', (raw, path) => { expect(scanTarget(raw)).toBe(path); });

  it('un jeton signé long passe par le paramètre de requête', () => {
    const tok = `MT1.${'a'.repeat(120)}.sig`;
    expect(scanTarget(tok)).toBe(`/preuve?c=${encodeURIComponent(tok)}`);
  });
});

describe('Lecteur de QR', () => {
  it('sans caméra en direct, propose la photo du QR (secours universel)', () => {
    renderWithApp(<QrScanner onResult={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: /Prendre une photo du QR/ })).toBeTruthy();
    expect(screen.getByLabelText('Photo du QR').getAttribute('capture')).toBe('environment');
    expect(screen.getByRole('status').textContent).toMatch(/photo du QR/);
  });
});
