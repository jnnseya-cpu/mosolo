import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

/**
 * Brouillons (§ 23.5.3), ajout du 27/09/2026 : `?siAbsent=vide` évite l'erreur réseau d'un formulaire neuf ; sans ce
 * paramètre, le comportement 404 est inchangé ; un brouillon existant est servi normalement ; jamais celui d'un autre.
 */
describe('Brouillons — lecture d’un brouillon absent', () => {
  it('200 { draft: null } avec siAbsent=vide, 404 sans ; isolement par utilisateur conservé', async () => {
    const env = await setup();
    const absent = await env.req('GET', '/v1/drafts/registration?siAbsent=vide', 'u-guichet');
    expect(absent.statusCode).toBe(200);
    expect(absent.json()).toEqual({ draft: null });
    expect((await env.req('GET', '/v1/drafts/registration', 'u-guichet')).statusCode).toBe(404);
    await env.req('PUT', '/v1/drafts/registration', 'u-guichet', { data: { phone: '+243810000009' } });
    const present = await env.req('GET', '/v1/drafts/registration?siAbsent=vide', 'u-guichet');
    expect(present.json()).toMatchObject({ key: 'registration', data: { phone: '+243810000009' } });
    expect((await env.req('GET', '/v1/drafts/registration?siAbsent=vide', 'u-contribuable')).json()).toEqual({ draft: null });
  });
});
