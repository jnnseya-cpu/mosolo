/**
 * Traduction automatique de l'interface (30/09/2026) : lots de textes traduits par le fournisseur (Google Cloud
 * Translation en service ; fournisseur de substitution ici), cache, limites, service indisponible ⇒ 503 explicite.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { traducteurGoogle } from '../src/modules/traduction/service.js';

describe('Traduction automatique de l’interface', () => {
  it('traduit par lots, met en cache, refuse les langues non prévues et les demandes trop grosses', async () => {
    let appels = 0;
    const app = buildApp({ plugins: [], traducteur: async (textes, cible) => { appels += 1; return textes.map((t) => `[${cible}] ${t}`); } });
    await app.ready();
    const post = (body: unknown) => app.inject({ method: 'POST', url: '/v1/traduction', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    expect((await app.inject({ method: 'GET', url: '/v1/traduction/etat' })).json()).toMatchObject({ disponible: true, langues: ['ln', 'sw', 'kg', 'lua', 'en'] });
    const r = (await post({ langue: 'ln', textes: ['Mon espace', 'Payer'] })).json();
    expect(r.traductions).toEqual(['[ln] Mon espace', '[ln] Payer']);
    expect(r.mention).toMatch(/version française fait foi/);
    await post({ langue: 'ln', textes: ['Mon espace'] });
    expect(appels).toBe(1); // cache
    expect((await post({ langue: 'de', textes: ['x'] })).statusCode).toBe(400);
    expect((await post({ langue: 'en', textes: Array.from({ length: 151 }, () => 'a') })).statusCode).toBe(400);
    await app.close();
  });

  it('sans fournisseur : 503 explicite ; hors Cloud Run et sans clé, aucun fournisseur ; « off » désactive', async () => {
    const app = buildApp({ plugins: [], traducteur: null });
    await app.ready();
    const r = await app.inject({ method: 'POST', url: '/v1/traduction', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ langue: 'sw', textes: ['Bonjour'] }) });
    expect(r.statusCode).toBe(503);
    expect(r.json().code).toBe('TRADUCTION_INDISPONIBLE');
    await app.close();
    expect(traducteurGoogle({})).toBeNull();
    expect(traducteurGoogle({ K_SERVICE: 'mosolo-demo', MOSOLO_TRADUCTION: 'off' })).toBeNull();
    expect(traducteurGoogle({ K_SERVICE: 'mosolo-demo' })).toBeTypeOf('function');
    expect(traducteurGoogle({ GOOGLE_TRANSLATE_API_KEY: 'x' })).toBeTypeOf('function');
  });
});
