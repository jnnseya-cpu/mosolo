/**
 * Partie V — chaque étape de parcours (`verticales/parcours.ts`) cite une route RÉELLE de l'API : aucune étape ne
 * renvoie à une route inexistante (contrôle de cohérence du catalogue des parcours).
 */
import { describe, expect, it } from 'vitest';
import { PARCOURS } from '../src/plugins/verticales/parcours.js';
import { setupApp } from './partie5-helpers.js';

describe('Partie V — routes des parcours', () => {
  it('dix-sept verticales, chaque étape sur une route existante de l’API', async () => {
    const env = await setupApp();
    expect(Object.keys(PARCOURS)).toHaveLength(17);
    const missing: string[] = [];
    for (const [slug, p] of Object.entries(PARCOURS)) {
      for (const e of p.etapes) {
        const [method, url] = e.route.split(' ') as [string, string];
        // Paramètres de chemin remplacés par une valeur quelconque : seule compte l'existence de la route (jamais ROUTE_NOT_FOUND).
        const res = await env.app.inject({ method: method as 'GET', url: url.replace(/:[A-Za-z]+/g, 'X'), ...(method === 'POST' ? { payload: {} } : {}) });
        if (res.statusCode === 404 && res.json().code === 'ROUTE_NOT_FOUND') missing.push(`${slug} ${e.rang} : ${e.route}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
