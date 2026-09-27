/**
 * Refus par défaut (audit de préparation à la production) : chaque route GET du catalogue (specs/routes-api.md,
 * généré depuis le code) est appelée SANS authentification. Seules les routes publiques par conception (préfixes
 * listés ci-dessous : vérifications, transparence, métadonnées) peuvent répondre 200 ; toutes les autres refusent.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = [
  /^\/health$/, /^\/\.well-known\//, /^\/v1\/public\//, /^\/v1\/meta$/, /^\/v1\/demo\//, /^\/v1\/auth\/demo-accounts$/, /^\/l(\/|$)/,
  /^\/v1\/verify/, /^\/v1\/publicite\/public\//, /^\/v1\/exchange-rates/, /^\/v1\/fx/, /^\/v1\/whatsapp\//, /^\/v1\/providers\/connectors$/,
];
/**
 * Routes publiques PAR CONCEPTION hors des préfixes ci-dessus, relevées et examinées lors de l'audit (27/09/2026) :
 * référentiels, catalogues, clés publiques, vérification d'une quittance, carte agrégée (masquée sous le seuil),
 * engagements publiés. Aucune ne renvoie de nom, de téléphone ni de montant individuel. Toute nouvelle route anonyme
 * doit être ajoutée ici EXPLICITEMENT (revue de sécurité), sinon ce test échoue.
 * À arbitrer par le maître d'ouvrage : /v1/verticales/marches/plan (statut de titre par étal, sans nom).
 */
const PUBLIC_BY_DESIGN = new Set([
  '/v1/acces/levels', '/v1/catalogue-api', '/v1/quittances/:ref/verification', '/v1/fiscal/assiette-2026', '/v1/fiscal/census/stages',
  '/v1/fiscal/geo-units', '/v1/fiscal/imports/format', '/v1/fiscal/map', '/v1/fiscal/reference', '/v1/parking/affectation',
  '/v1/partenaires/api/v1', '/v1/rakapay/catalogue', '/v1/rakapay/cooperatives', '/v1/rakapay/lignes', '/v1/rakapay/offres',
  '/v1/rakapay/operateurs', '/v1/rakapay/stations', '/v1/referentiel/espaces', '/v1/titres/cle-publique', '/v1/titres/types',
  '/v1/verticales', '/v1/verticales/marches/plan', '/v1/verticales/secteurs',
]);

describe('Refus par défaut sans authentification', () => {
  it('toutes les routes GET non publiques refusent un appel anonyme (401/403/404), jamais 5xx', async () => {
    const routes = readFileSync(join(ROOT, 'specs/routes-api.md'), 'utf8').split('\n')
      .map((l) => /^\| GET \| `([^`]+)` \|/.exec(l)?.[1]).filter((x): x is string => !!x);
    expect(routes.length).toBeGreaterThan(300);
    const app = buildApp({ clock: new ManualClock('2026-09-27T09:00:00.000Z'), secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
    await app.ready();
    const open: string[] = [];
    const statuses: Record<number, number> = {};
    for (const r of routes) {
      const url = r.replace(/:[a-zA-Z]+/g, 'X');
      const res = await app.inject({ method: 'GET', url });
      statuses[res.statusCode] = (statuses[res.statusCode] ?? 0) + 1;
      expect(res.statusCode, url).toBeLessThan(500);
      if (res.statusCode < 400 && !PUBLIC.some((p) => p.test(r)) && !PUBLIC_BY_DESIGN.has(r)) open.push(`${r} → ${res.statusCode}`);
    }
    console.log(JSON.stringify({ rapport: 'refus par défaut (anonyme)', routesGet: routes.length, statuts: statuses, ouvertesHorsListePublique: open }));
    expect(open).toEqual([]);
    await app.close();
  });
});
