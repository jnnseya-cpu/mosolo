/**
 * Indicateurs des modules 27 à 40 (spécification fonctionnelle, rubrique « Indicateurs ») : application complète,
 * chaque module présent, chaque indicateur calculé sur les données réelles ou « non mesuré » avec motif ; un paiement
 * confirmé fait passer les indicateurs de paiement de « non mesuré » à « mesuré ».
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { callbackBody, DEMO, PROVIDER_SECRET, signedCallback, type TestEnv } from './helpers.js';

async function setupFull(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} } });
  await app.ready();
  return {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
}

describe('Indicateurs des modules 27 à 40', () => {
  it('quatorze modules, indicateurs mesurés ou non mesurés avec motif ; accès restreint ; mesure après paiement', async () => {
    const env = await setupFull();
    expect((await env.req('GET', '/v1/pilotage/indicateurs-modules/27-40', 'u-contribuable')).statusCode).toBe(403);
    const r0 = (await env.req('GET', '/v1/pilotage/indicateurs-modules/27-40', 'u-gouverneur')).json();
    expect(r0.modules.map((m: { module: number }) => m.module)).toEqual([27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40]);
    for (const m of r0.modules) {
      expect(m.indicateurs.length).toBeGreaterThan(0);
      for (const i of m.indicateurs) {
        expect(['MESURE', 'NON_MESURE']).toContain(i.statut);
        if (i.statut === 'NON_MESURE') { expect(i.valeur).toBeNull(); expect(i.detail.length).toBeGreaterThan(5); } else expect(i.valeur).not.toBeNull();
      }
    }
    const find = (r: typeof r0, code: string) => r.modules.flatMap((m: { indicateurs: { code: string }[] }) => m.indicateurs).find((i: { code: string }) => i.code === code);
    expect(find(r0, 'M27_OBLIGATIONS_EMISES').statut).toBe('MESURE');
    // Paiement confirmé : taux de succès, délai de confirmation, délai paiement → quittance mesurés.
    const ob = env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    const order = (await env.req('POST', `/v1/obligations/${ob.id}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).json();
    env.clock.advance(60_000);
    await signedCallback(env, callbackBody(env, order.paymentReference, order.amount));
    const r1 = (await env.req('GET', '/v1/pilotage/indicateurs-modules/27-40', 'u-gouverneur')).json();
    expect(find(r1, 'M28_TAUX_SUCCES')).toMatchObject({ statut: 'MESURE', valeur: '100 %' });
    expect(find(r1, 'M28_DELAI_CONFIRMATION').statut).toBe('MESURE');
    expect(find(r1, 'M31_DELAI_QUITTANCE').statut).toBe('MESURE');
    expect(find(r1, 'M32_ENCOURS').statut).toBe('MESURE');
    expect(r1.mesures + r1.nonMesures).toBe(r1.modules.flatMap((m: { indicateurs: unknown[] }) => m.indicateurs).length);
  });
});
