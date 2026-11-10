import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/context';
import Login from '../src/modules/socle/Login';

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } }));
}

describe('Écran de connexion (socle)', () => {
  it('contribuable : téléphone puis code → session ouverte, jeton envoyé en Bearer', async () => {
    try { localStorage.clear(); } catch { /* stockage indisponible */ }
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/v1/auth/demo-accounts')) return json({ status: 404, code: 'ROUTE_NOT_FOUND', title: 'Ressource introuvable' }, 404);
      if (url.endsWith('/v1/auth/login')) return json({ challengeId: 'CHL-1', method: 'sms-otp', expiresAt: new Date(Date.now() + 300_000).toISOString(), destination: '+243••••••01', demoCode: '123456' });
      if (url.endsWith('/v1/auth/otp')) return json({
        accessToken: 'jeton.de.test', tokenType: 'Bearer', expiresIn: 900, acr: 'urn:mosolo:acr:otp', passkeyRequired: false,
        session: { id: 'SES-1', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), sharedDevice: false },
        user: { id: 'u-contribuable', name: 'Mbuyi Kalala (contribuable fictif)', roles: ['R30'], entity: 'PUBLIC' },
      });
      if (url.endsWith('/v1/auth/sessions')) return json({ items: [{ id: 'SES-1', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), sharedDevice: false, acr: 'urn:mosolo:acr:otp', active: true, current: true }] });
      return Promise.reject(new TypeError('Failed to fetch'));
    }) as unknown as typeof fetch;

    render(<MemoryRouter><AppProvider initialLang="fr"><Login /></AppProvider></MemoryRouter>);
    expect(screen.getByRole('heading', { name: 'Connexion' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Numéro de téléphone'), { target: { value: '+243 81 000 0001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recevoir un code' }));
    await screen.findByText(/Code envoyé au/);
    expect(screen.getByText('123456')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Se connecter' }));
    await screen.findByRole('heading', { name: 'Session ouverte' });
    expect(screen.getByText('Code à usage unique (téléphone)')).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/v1/auth/sessions'))).toBe(true));
    const sessionsCall = calls.find((c) => c.url.endsWith('/v1/auth/sessions'))!;
    expect((sessionsCall.init?.headers as Record<string, string>).Authorization).toBe('Bearer jeton.de.test');
    expect(screen.getByRole('button', { name: /Se déconnecter/ })).toBeTruthy();
  });

  it('agent : identifiant et mot de passe obligatoires avant le second facteur', async () => {
    try { localStorage.clear(); } catch { /* stockage indisponible */ }
    globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
    render(<MemoryRouter><AppProvider initialLang="fr"><Login /></AppProvider></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: /Agent public/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Continuer' }));
    expect(await screen.findByText('Identifiant et mot de passe obligatoires.')).toBeTruthy();
    expect(screen.getByText(/mode démonstration est désactivé/)).toBeTruthy();
  });
});
