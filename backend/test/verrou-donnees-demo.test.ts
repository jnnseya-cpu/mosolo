/**
 * Verrou des données de démonstration (décision du 27/09/2026 : toutes conservées, aucune suppression ni modification ;
 * règle n° 1 de CLAUDE.md). Chaque dépôt semé en démonstration garde au moins le nombre d'enregistrements du relevé
 * `verrou/donnees-demo.json` ; aucun dépôt ne disparaît. Horloge fixe : le semis est déterministe.
 * Nouveaux dépôts ou enregistrements : `MOSOLO_VERROU_AJOUTER=1 npx vitest run test/verrou-donnees-demo.test.ts`
 * (le relevé ne fait que croître ; un retrait se décide par le maître d'ouvrage et se consigne dans verrou/retraits.md).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { discover } from '../src/persistence/registry.js';

const RELEVE = resolve(dirname(fileURLToPath(import.meta.url)), '../../verrou/donnees-demo.json');

describe('verrou des données de démonstration', () => {
  it('aucun dépôt ni enregistrement de démonstration ne disparaît', async () => {
    const clock = new ManualClock('2026-09-30T09:00:00.000Z');
    const app = buildApp({ clock, seed: true, demoExamples: true, secrets: { auditHmacKey: 'k', providerSecrets: {}, commsProviderKeys: {} } });
    await app.ready();
    const actuel: Record<string, number> = {};
    for (const [nom, depot] of discover(app.ctx).repos) actuel[nom] = depot.count();
    await app.close();

    const reference: Record<string, number> = existsSync(RELEVE) ? JSON.parse(readFileSync(RELEVE, 'utf-8')).depots : {};
    if (process.env.MOSOLO_VERROU_AJOUTER === '1') {
      const fusion: Record<string, number> = { ...reference };
      for (const [nom, n] of Object.entries(actuel)) fusion[nom] = Math.max(fusion[nom] ?? 0, n);
      const depots = Object.fromEntries(Object.entries(fusion).sort(([a], [b]) => a.localeCompare(b)));
      writeFileSync(RELEVE, JSON.stringify({ regle: 'Données de démonstration conservées (27/09/2026) : nombre minimal d’enregistrements par dépôt, semis à horloge fixe.', depots }, null, 1) + '\n');
      return;
    }
    expect(Object.keys(reference).length, 'relevé verrou/donnees-demo.json absent').toBeGreaterThan(0);
    const pertes = Object.entries(reference)
      .filter(([nom, n]) => (actuel[nom] ?? -1) < n)
      .map(([nom, n]) => `${nom} : ${actuel[nom] ?? 'dépôt disparu'} au lieu d’au moins ${n}`);
    expect(pertes).toEqual([]);
  });
});
