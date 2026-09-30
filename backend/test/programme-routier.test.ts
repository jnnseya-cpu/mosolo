/**
 * Programme routier du Gouvernorat (30/09/2026, annonce du Cabinet du Gouverneur transmise par le maître d'ouvrage) :
 * 160 km livrés, plus de 600 km en cours — chiffres annoncés, « à confirmer » ; recettes liées à la route (péage
 * provincial, droits de voirie, taxe de circulation) mises en regard, agrégées, sans affectation automatique.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { DEFAULT_PLUGINS } from '../src/plugins/index.js';
import { PROGRAMME_ROUTIER } from '../src/plugins/pilotage/recette-programme/referentiels.js';

async function env() {
  const clock = new ManualClock('2026-09-30T09:00:00.000Z');
  const app = buildApp({ clock, seed: true, plugins: DEFAULT_PLUGINS, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
  await app.ready();
  const get = (url: string, user: string) => app.inject({ method: 'GET', url, headers: { 'x-demo-user': user } });
  return { app, get };
}

describe('Programme routier du Gouvernorat — vue programme', () => {
  it('160 km livrés, plus de 600 km en cours (annoncés, à confirmer) ; péage, voirie et circulation mis en regard ; lecture journalisée', async () => {
    const { app, get } = await env();
    const r = await get('/v1/pilotage/programme/routes', 'u-gouverneur');
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.indicateurs.map((i: { code: string; valeur: number }) => [i.code, i.valeur])).toEqual([['KM_LIVRES', 160], ['KM_EN_COURS', 600]]);
    expect(b.statut).toMatch(/à confirmer/);
    expect(b.source).toMatch(/Cabinet du Gouverneur, 30\/09\/2026/);
    expect(b.kmTotalAnnonce).toBe(760);
    expect(b.recettes.lignes.map((l: { code: string }) => l.code)).toEqual(['PEAGE', 'VOIRIE', 'CIRCULATION']);
    expect(b.avertissement).toMatch(/pas affectées automatiquement/);
    // Total rapproché = somme des lignes, par devise.
    const somme: Record<string, number> = {};
    for (const l of b.recettes.lignes) for (const m of l.rapproche) somme[m.currency] = (somme[m.currency] ?? 0) + Number(m.amount);
    for (const m of b.recettes.totalRapproche) expect(Number(m.amount)).toBeCloseTo(somme[m.currency] ?? 0, 2);
    // Recettes routières : régie compétente proposée par l'aiguillage DGIPK / DGTK (par défaut — à confirmer).
    expect(b.recettes.lignes.find((l: { code: string }) => l.code === 'PEAGE').regie.regie).toBe('DGTK');
    // Résumé dans la synthèse du programme.
    expect((await get('/v1/pilotage/programme', 'u-gouverneur')).json().programmeRoutier.code).toBe(PROGRAMME_ROUTIER.code);
    expect(app.ctx.audit.list({ action: 'programme.routier.viewed' }).items.length).toBeGreaterThan(0);
  });

  it('réservé aux lecteurs du programme : un usager est refusé', async () => {
    const { get } = await env();
    expect((await get('/v1/pilotage/programme/routes', 'u-contribuable')).statusCode).toBe(403);
  });
});
