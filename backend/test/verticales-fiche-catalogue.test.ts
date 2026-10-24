/**
 * Fiche publique d'une verticale sous « /v1/verticales/catalogue/:slug » (27/09/2026) : « /v1/verticales/actifs » est
 * aussi la liste du patrimoine (réservée), qui masquait la fiche de la verticale « actifs » dans /services/actifs
 * (403 pour tout usager). Le nouveau chemin sert les dix-sept fiches ; l'ancien chemin et la liste du patrimoine sont
 * conservés à l'identique.
 */
import { describe, expect, it } from 'vitest';
import { setupApp } from './partie5-helpers.js';

describe('fiche des verticales sans collision de chemin', () => {
  it('sert la fiche « actifs » au public et au contribuable, sans toucher la liste réservée du patrimoine', async () => {
    const env = await setupApp();
    const pub = await env.req('GET', '/v1/verticales/catalogue/actifs');
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).toMatchObject({ slug: 'actifs' });
    expect(Array.isArray(pub.json().procedures)).toBe(true);
    expect((await env.req('GET', '/v1/verticales/catalogue/actifs', 'u-contribuable')).statusCode).toBe(200);
    // Liste du patrimoine : toujours réservée (inchangée).
    expect((await env.req('GET', '/v1/verticales/actifs', 'u-contribuable')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/verticales/actifs', 'vx-chef-patrimoine')).statusCode).toBe(200);
  });

  it('dix-sept fiches identiques par l’ancien et le nouveau chemin (hors « actifs », occupé par le patrimoine)', async () => {
    const env = await setupApp();
    const items = (await env.req('GET', '/v1/verticales')).json().items as { slug: string }[];
    expect(items).toHaveLength(17);
    for (const { slug } of items) {
      const fresh = await env.req('GET', `/v1/verticales/catalogue/${slug}`);
      expect(fresh.statusCode, slug).toBe(200);
      expect(fresh.json().slug).toBe(slug);
      if (slug !== 'actifs') expect((await env.req('GET', `/v1/verticales/${slug}`)).json()).toEqual(fresh.json());
    }
    expect((await env.req('GET', '/v1/verticales/catalogue/inconnue')).statusCode).toBe(404);
  });
});
