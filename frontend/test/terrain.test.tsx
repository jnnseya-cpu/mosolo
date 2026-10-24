import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../src/context';
import VerifyAgent from '../src/modules/terrain/VerifyAgent';
import { fmtPct, moduleLabel } from '../src/modules/terrain/labels';

function mockApi(routes: Record<string, unknown>) {
  globalThis.fetch = vi.fn((url: string) => {
    const hit = Object.entries(routes).find(([k]) => String(url).includes(k));
    if (!hit) return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve(new Response(JSON.stringify(hit[1]), { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as unknown as typeof fetch;
}

describe('Vérification publique de badge d’agent', () => {
  it('affiche le verdict, la structure et la zone, sans téléphone ni adresse', async () => {
    mockApi({
      '/v1/public/agent-badges/AG-7K4M2Q-X': {
        result: 'VALIDE', checkedAt: '2026-09-26T09:00:00.000Z', advice: 'Aucun agent n’encaisse.', reportable: false,
        badge: { shortCode: 'AG-7K4M2Q-X', displayName: 'Agent Limete', structure: 'DGIPK', structureKind: 'REGIE', module: 'FONCIER_LOCATIF', communes: ['Limete'], validFrom: '2026-09-26', validUntil: '2027-03-25', hasPhoto: false },
      },
      '/v1/public/terrain/mystery-checks/summary': { performed: 2, withoutIrregularity: 2, withoutIrregularityPct: '100.0' },
    });
    render(
      <AppProvider initialLang="fr">
        <MemoryRouter initialEntries={['/verifier-agent/AG-7K4M2Q-X']}>
          <Routes><Route path="/verifier-agent/:code" element={<VerifyAgent />} /></Routes>
        </MemoryRouter>
      </AppProvider>,
    );
    expect(await screen.findByText('Agent habilité')).toBeTruthy();
    expect(screen.getByText('Agent Limete')).toBeTruthy();
    expect(screen.getByText('Foncier et locatif')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/téléphone :|adresse :/i);
    expect(screen.getByText(/Aucun agent ni sous-traitant n’encaisse d’argent/)).toBeTruthy();
  });

  it('badge inconnu : invitation à signaler', async () => {
    mockApi({ '/v1/public/agent-badges/AG-FAUX': { result: 'INCONNU', checkedAt: '2026-09-26T09:00:00.000Z', advice: 'Signalez-le.', reportable: true } });
    render(
      <AppProvider initialLang="fr">
        <MemoryRouter initialEntries={['/verifier-agent/AG-FAUX']}>
          <Routes><Route path="/verifier-agent/:code" element={<VerifyAgent />} /></Routes>
        </MemoryRouter>
      </AppProvider>,
    );
    expect(await screen.findByText('Badge inconnu')).toBeTruthy();
    expect(screen.getByText('Signaler cet agent')).toBeTruthy();
  });

  it('libellés', () => {
    expect(moduleLabel('PATENTES')).toBe('Activités et patentes');
    expect(fmtPct('12.5')).toBe('12,5 %');
    expect(fmtPct(null)).toBe('—');
  });
});
