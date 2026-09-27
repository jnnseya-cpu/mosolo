/**
 * Module 61 — moteur de découverte des recettes : résultats de pilote constatés par le comité de pilotage (gain net =
 * recettes pilote − groupe témoin − coût, jamais estimé) et indicateurs (opportunités instruites, gain net des pilotes).
 * Aucun résultat ne crée de règle, d'obligation ni de taxe.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { DEFAULT_PLUGINS } from '../src/plugins/index.js';

async function setupFull() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, plugins: DEFAULT_PLUGINS, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
  await app.ready();
  const req = (method: string, url: string, user?: string, body?: unknown) => app.inject({
    method: method as 'GET', url,
    headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { app, req };
}

const STEP_USERS: Record<number, string> = { 1: 'u-dg-dgipk', 2: 'u-juriste-redacteur', 3: 'opp-analyste', 4: 'u-dg-dgipk', 5: 'u-auditeur', 6: 'opp-analyste', 7: 'u-ministre-finances' };

describe('Module 61 — résultats de pilote et indicateurs du moteur de découverte', () => {
  it('résultat refusé avant la définition du pilote ; gain net constaté (avec ou sans groupe témoin) ; aucune obligation créée', async () => {
    const { app, req } = await setupFull();
    const created = await req('POST', '/v1/opportunites', 'u-dg-dgipk', { title: 'Signal terrain — étals non enregistrés (test)', origin: 'TERRAIN', summary: 'Étals relevés sans objet enregistré sur le marché pilote (test).', domains: ['IMMOBILIER_LOCATIF'] });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const before = (await req('GET', '/v1/opportunites-indicateurs', 'u-dg-dgipk')).json();
    expect(before.pilotes.note).toMatch(/non mesuré/);
    const body = {
      periodStart: '2026-07-01', periodEnd: '2026-09-30', perimeter: 'Commune de Limete (pilote)', observedRevenue: { amount: '12000000.00', currency: 'CDF' },
      comparisonRevenue: { amount: '9000000.00', currency: 'CDF' }, implementationCost: { amount: '1500000.00', currency: 'CDF' }, source: 'Relevés rapprochés du compte public (test)',
    };
    // Étape 7 non complétée : refus.
    expect((await req('POST', `/v1/opportunites/${id}/resultats-pilote`, 'u-ministre-finances', body)).json().code).toBe('PILOT_NOT_DEFINED');
    for (let n = 2; n <= 7; n++) {
      const b = n === 3 ? { summary: 'Estimation non chiffrée.', scenarios: { prudent: null, attendu: null, ambitieux: null, hypothesisIds: [] } } : { summary: `Étape ${n} instruite (test).` };
      expect((await req('POST', `/v1/opportunites/${id}/etapes/${n}`, STEP_USERS[n], b)).statusCode).toBe(200);
    }
    // Rôle non habilité (étape 7 : comité de pilotage) : refus.
    expect((await req('POST', `/v1/opportunites/${id}/resultats-pilote`, 'u-auditeur', body)).statusCode).toBe(403);
    const obligationsBefore = app.ctx.assessment.obligations.count();
    const r = await req('POST', `/v1/opportunites/${id}/resultats-pilote`, 'u-ministre-finances', body);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ netGain: { amount: '1500000.00', currency: 'CDF' }, withComparison: true, effect: 'AUCUNE_OBLIGATION_CREEE' });
    // Sans groupe témoin : gain marqué « sans comparaison ».
    const r2 = await req('POST', `/v1/opportunites/${id}/resultats-pilote`, 'u-ministre-finances', { ...body, comparisonRevenue: null });
    expect(r2.json()).toMatchObject({ netGain: { amount: '10500000.00' }, withComparison: false });
    // Devises mélangées : refus.
    expect((await req('POST', `/v1/opportunites/${id}/resultats-pilote`, 'u-ministre-finances', { ...body, implementationCost: { amount: '100.00', currency: 'USD' } })).json().code).toBe('CURRENCY_MISMATCH');
    expect(app.ctx.assessment.obligations.count()).toBe(obligationsBefore);
    const items = (await req('GET', `/v1/opportunites/${id}/resultats-pilote`, 'u-dg-dgipk')).json().items;
    expect(items).toHaveLength(2);
    const ind = (await req('GET', '/v1/opportunites-indicateurs', 'u-dg-dgipk')).json();
    expect(ind.pilotes).toMatchObject({ resultats: 2, opportunitesPilotees: 1 });
    expect(ind.pilotes.gainNet).toEqual([{ currency: 'CDF', netGain: { amount: '12000000.00', currency: 'CDF' }, netGainWithComparison: { amount: '1500000.00', currency: 'CDF' }, pilots: 2 }]);
    expect(ind.opportunites.instruites).toBeGreaterThan(before.opportunites.instruites - 1);
    expect(ind.opportunites.parEtape.find((s: { step: number }) => s.step === 7).completed).toBeGreaterThanOrEqual(1);
    expect(app.ctx.audit.list({ action: 'opportunite.pilot_result.recorded' }).total).toBe(2);
    expect((await req('GET', '/v1/opportunites-indicateurs', 'u-contribuable')).statusCode).toBe(403);
  });
});
