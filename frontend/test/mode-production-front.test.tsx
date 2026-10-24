/**
 * Application face à un serveur HORS démonstration (audit du 24/10/2026) : le sélecteur « Utilisateur (démo) »
 * disparaît, l'utilisateur de démonstration mémorisé est oublié (sinon chaque requête, même publique, serait refusée par
 * DEMO_AUTH_DISABLED) et aucune donnée d'exemple ne remplace une erreur réseau.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AppProvider } from '../src/context';
import { DemoUserSelector } from '../src/components/Selectors';
import { getDemoUser, repliExempleAutorise, setDemoUser, setServeurDemo } from '../src/lib/api';

const reponse = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/problem+json' } }));
afterEach(() => { setDemoUser(null); setServeurDemo(true); localStorage.clear(); vi.restoreAllMocks(); });

describe('Serveur hors démonstration', () => {
  for (const [cas, status, code] of [['liste absente (404)', 404, 'NOT_FOUND'], ['en-tête refusé (401)', 401, 'DEMO_AUTH_DISABLED']] as const) {
    it(`${cas} : sélecteur masqué, utilisateur oublié, aucun repli d’exemple`, async () => {
      setDemoUser('u-gouverneur');
      globalThis.fetch = vi.fn((url: string) => (String(url).includes('/v1/demo/users') ? reponse(status, { title: 'refus', status, code }) : reponse(404, { title: 'absent', status: 404 }))) as unknown as typeof fetch;
      render(<AppProvider initialLang="fr"><DemoUserSelector /></AppProvider>);
      await waitFor(() => expect(getDemoUser()).toBeNull());
      expect(screen.queryByText('Utilisateur (démo)')).toBeNull();
      expect(repliExempleAutorise()).toBe(false);
    });
  }

  it('serveur de démonstration : le sélecteur reste proposé', async () => {
    globalThis.fetch = vi.fn((url: string) => (String(url).includes('/v1/demo/users') ? reponse(200, [{ id: 'u-gouverneur', name: 'Gouverneur', roles: ['R01'] }]) : reponse(404, { title: 'absent', status: 404 }))) as unknown as typeof fetch;
    render(<AppProvider initialLang="fr"><DemoUserSelector /></AppProvider>);
    await waitFor(() => expect(getDemoUser()).toBe('u-gouverneur'));
    expect(screen.getByText('Utilisateur (démo)')).toBeTruthy();
    expect(repliExempleAutorise()).toBe(true);
  });
});
