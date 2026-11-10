/**
 * Catalogue des indicateurs (29/09/2026, § 27 « Le Gouverneur n'a pas besoin de tout voir ») : les autorités
 * (R01–R05) voient d'abord une synthèse de six indicateurs de décision ; le catalogue complet reste à un clic.
 * Les autres rôles voient le catalogue complet, inchangé.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/context';
import Indicateurs, { SYNTHESE_AUTORITES } from '../src/modules/pilotage/Indicateurs';

const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } }));
const kpi = (code: string, label: string) => ({
  code, label, domain: 'Test', definition: `Définition ${label}`, formula: 'f', source: 's', unit: '%', targetLabel: '—', better: 'HAUSSE',
  reference: '§ 39', measurable: true, value: '50.0', status: 'SUIVI', trend: { previous: null, window: '7 jours', direction: 'INDISPONIBLE', favorable: null },
});
const KPIS = [...SYNTHESE_AUTORITES.map((c) => kpi(c, `Indicateur ${c}`)), kpi('TECHNIQUE_1', 'Indicateur technique un'), kpi('TECHNIQUE_2', 'Indicateur technique deux')];

function mockApi(user: { id: string; roles: string[] }) {
  globalThis.fetch = vi.fn((url: string) => {
    if (String(url).includes('/v1/demo/users')) return json([{ ...user, name: `${user.id} (démo)`, entity: 'TEST' }]);
    if (String(url).includes('/v1/pilotage/indicateurs')) return json({ generatedAt: '2026-09-29T08:00:00.000Z', scope: { level: 'PROVINCE', label: 'Province' }, summary: { total: KPIS.length, measured: KPIS.length, onTarget: 0, offTarget: 0 }, kpis: KPIS });
    return Promise.reject(new TypeError('Failed to fetch'));
  }) as unknown as typeof fetch;
  localStorage.setItem('mosolo.demoUser', user.id);
}
const renderPage = () => render(<AppProvider initialLang="fr"><MemoryRouter><Indicateurs /></MemoryRouter></AppProvider>);

describe('Catalogue des indicateurs — synthèse des autorités', () => {
  it('Gouverneur : six indicateurs de décision d’abord, détails repliés ; catalogue complet à un clic', async () => {
    mockApi({ id: 'u-gouverneur', roles: ['R01'] });
    renderPage();
    expect(await screen.findByText(`Indicateur ${SYNTHESE_AUTORITES[0]}`)).toBeTruthy();
    expect(screen.queryByText('Indicateur technique un')).toBeNull();
    expect(screen.getAllByText('Comprendre').length).toBe(SYNTHESE_AUTORITES.length);
    fireEvent.click(screen.getByRole('button', { name: /Catalogue complet/ }));
    expect(await screen.findByText('Indicateur technique un')).toBeTruthy();
  });

  it('autres rôles (Trésor) : catalogue complet, inchangé', async () => {
    mockApi({ id: 'u-tresor', roles: ['R17'] });
    renderPage();
    expect(await screen.findByText('Indicateur technique deux')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Catalogue complet/ })).toBeNull();
  });
});
