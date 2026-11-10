import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../src/context';
import Registration from '../src/pages/Registration';
import InvitationAccept from '../src/modules/acces/InvitationAccept';
import Arbitrages from '../src/modules/acces/Arbitrages';

function mockApi(routes: Record<string, unknown>) {
  globalThis.fetch = vi.fn((url: string) => {
    const hit = Object.entries(routes).find(([k]) => String(url).includes(k));
    if (!hit) return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve(new Response(JSON.stringify(hit[1]), { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as unknown as typeof fetch;
}

function renderAt(path: string, route: string, el: JSX.Element) {
  return render(
    <AppProvider initialLang="fr">
      <MemoryRouter initialEntries={[path]}><Routes><Route path={route} element={el} /></Routes></MemoryRouter>
    </AppProvider>,
  );
}

describe('Module acces — écrans', () => {
  it('inscription : profil entreprise avec identifiants déclarés et représentant habilité, sans rôle de travail', () => {
    mockApi({});
    renderAt('/inscription', '/inscription', <Registration />);
    fireEvent.click(screen.getByRole('button', { name: /Entreprise ou organisation/ }));
    expect(screen.getByLabelText('Raison sociale')).toBeTruthy();
    expect(screen.getByLabelText('RCCM')).toBeTruthy();
    expect(screen.getByText('Représentant nommément habilité')).toBeTruthy();
    expect(screen.getByText(/comptes de travail des agents s’ouvrent uniquement sur invitation/)).toBeTruthy();
  });

  it('finalisation d’invitation : récapitulatif et exigence de clé d’accès pour un rôle sensible', async () => {
    mockApi({
      '/v1/acces/invitations/lookup': {
        id: 'INV-000001', entity: { id: 'TRESOR', name: 'Trésor provincial' }, accessLevel: 'OPERATEUR', accessLevelLabel: 'Opérateur',
        roleLabels: ['Comptable public / Trésor'], phoneMasked: '+243•••••01', expiresAt: '2026-09-29T09:00:00.000Z', status: 'ENVOYEE',
        sensitive: true, requirement: 'SECURITE', passkeyRequired: true, deviceRequired: false,
      },
    });
    renderAt('/invitation?jeton=0123456789abcdef0123', '/invitation', <InvitationAccept />);
    expect(await screen.findByText('Trésor provincial')).toBeTruthy();
    expect(screen.getByText(/compte restera inactif jusqu’à cette validation/)).toBeTruthy();
    expect(screen.getAllByText(/refusé pour ce rôle/).length).toBe(2);
  });

  it('arbitrages : dossier bloquant affiché avec détenteur et revendiquant', async () => {
    mockApi({
      '/v1/acces/arbitrations': { items: [{
        id: 'ARB-00001', kind: 'FAIT_GENERATEUR', subject: { objectId: 'OBJ-1', factCode: 'PROPRIETE_BATIE', period: '2026' },
        claimants: [{ entity: 'DGIPK', holder: true }, { entity: 'COMMUNE-LIMETE', claimId: 'REV-1', holder: false }],
        status: 'OUVERT', openedAt: '2026-09-26T09:00:00.000Z', openedBy: 'u', existingObligationIds: ['OBL-1'],
      }] },
    });
    renderAt('/acces/arbitrages', '/acces/arbitrages', <Arbitrages />);
    expect(await screen.findByText(/ARB-00001/)).toBeTruthy();
    expect(screen.getByText('DGIPK · détenteur')).toBeTruthy();
    expect(screen.getByText('COMMUNE-LIMETE · revendiquant')).toBeTruthy();
  });
});
