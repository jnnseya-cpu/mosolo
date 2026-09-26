import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../src/context';
import Services from '../src/pages/Services';
import PlateVerify from '../src/modules/verticales/PlateVerify';

function mockApi(routes: Record<string, unknown>) {
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const path = Object.keys(routes).find((p) => url.endsWith(p));
    if (!path) return Promise.resolve(new Response(JSON.stringify({ title: 'Introuvable', status: 404 }), { status: 404, headers: { 'content-type': 'application/json' } }));
    return Promise.resolve(new Response(JSON.stringify(routes[path]), { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as unknown as typeof fetch;
}

const summary = (slug: string, name: string, legal: string, legalLabel: string) => ({
  slug, name, short: name, icon: 'basket', accent: '#e34948', modules: [20], legal, legalLabel, acceptsLevies: legal !== 'ACTE_REQUIS',
  entity: 'DGTK', entityName: 'DGTK', tutelle: 'Économie', release: 'R2', audience: 'Vendeurs', promise: `Promesse ${name}`, vigilance: 'Vigilance', managedBy: null,
});

describe('Portail des verticales branché sur l’API', () => {
  it('affiche le catalogue servi par le serveur et son statut juridique', async () => {
    mockApi({
      '/v1/demo/users': [],
      '/v1/verticales': { items: [summary('marches', 'MOSOLO Markets', 'BASE_A_CERTIFIER', 'Base légale existante — textes et barèmes à certifier'), summary('avia', 'MOSOLO AVIA', 'ACTE_REQUIS', 'Acte requis avant tout paiement')], notice: '' },
    });
    render(<AppProvider initialLang="fr"><MemoryRouter><Services /></MemoryRouter></AppProvider>);
    expect(await screen.findByText('MOSOLO Markets')).toBeTruthy();
    expect(screen.getByText('MOSOLO AVIA')).toBeTruthy();
    expect(screen.getByText('Acte requis avant tout paiement')).toBeTruthy();
    expect(screen.getByText(/règles fictives de démonstration, non opposables/)).toBeTruthy();
  });
});

describe('Vérification publique d’une plaque', () => {
  it('montre l’authenticité, la commune et le quartier — jamais de nom ni de situation de paiement', async () => {
    mockApi({
      '/v1/demo/users': [],
      '/v1/public/verticales/plates/KIN-LMT-000001-A': { code: 'KIN-LMT-000001-A', authentique: true, type: 'Plaque fiscale immobilière (NFIU)', statut: 'EN_SERVICE', enregistre: true, commune: 'Limete', quartier: 'Kingabwa', message: 'Plaque authentique, objet enregistré.' },
      '/v1/public/verticales/certificates/KIN-LMT-000001-A': { code: 'KIN-LMT-000001-A', authentique: false },
    });
    render(<AppProvider initialLang="fr"><MemoryRouter initialEntries={['/verifier-plaque/KIN-LMT-000001-A']}><Routes><Route path="/verifier-plaque/:code" element={<PlateVerify />} /></Routes></MemoryRouter></AppProvider>);
    expect(await screen.findByText('Plaque authentique, objet enregistré.')).toBeTruthy();
    expect(screen.getByText('Limete')).toBeTruthy();
    expect(screen.getByText('Kingabwa')).toBeTruthy();
    expect(screen.queryByText(/Impayé|À jour|En attente de paiement|Mbuyi/)).toBeNull();
  });
});
