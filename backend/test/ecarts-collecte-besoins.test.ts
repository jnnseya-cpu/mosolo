/**
 * Écarts de collecte par commune traités comme des BESOINS (consigne du maître d'ouvrage, 30/09/2026) : l'IA ne suggère
 * qu'à partir des besoins recensés, des écarts de collecte (liquidé échu − rapproché) et des recettes générées.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import type { Facts } from '../src/plugins/pilotage/facts.js';
import { DEFAULT_PLUGINS } from '../src/plugins/index.js';
import type { PlanificationService } from '../src/plugins/pilotage/planification/service.js';

const ob = (id: string, commune: string, amount: string, dueDate: string, cancelled = false) => ({
  id, taxpayerId: 'tp', objectId: 'o', commune, category: 'IMPOT_PROVINCIAL', entity: 'DGIPK', ruleCode: 'R', amount: { amount, currency: 'USD' as const },
  status: 'EMISE', createdAt: '2026-07-01T00:00:00Z', createdBy: 'x', dueDate, cancelled, rectified: false, contested: false,
});
const paid = (obligationId: string, amount: string, reconciled: boolean) => ({
  id: `P-${obligationId}-${amount}`, paymentReference: 'ref', obligationId, taxpayerId: 'tp', commune: 'x', category: 'c', entity: 'e', channel: 'MOBILE_MONEY',
  amount: { amount, currency: 'USD' as const }, createdAt: '2026-07-02T00:00:00Z', expiresAt: '2026-07-03T00:00:00Z', status: reconciled ? 'RAPPROCHE' : 'CONFIRME',
  ...(reconciled ? { reconciledAt: '2026-07-05T00:00:00Z' } : {}), ledgerEntryIds: [],
});

describe('Écarts de collecte par commune = besoins', () => {
  it('liquidé échu sur la période − rapproché, par commune, classé par écart ; annulé, hors période, non rapproché exclus du rapproché', async () => {
    const app = buildApp({ clock: new ManualClock('2026-09-30T09:00:00.000Z'), seed: true, plugins: DEFAULT_PLUGINS, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
    await app.ready();
    const svc = app.ctx.ext.planification as PlanificationService;
    const facts = {
      asOf: '2026-09-30T09:00:00Z', recorded: [], appeals: [],
      obligations: [
        ob('A1', 'Gombe', '100.00', '2026-08-01'), ob('A2', 'Gombe', '50.00', '2026-08-15'),
        ob('B1', 'Limete', '300.00', '2026-07-20'),
        ob('C1', 'Kalamu', '40.00', '2026-09-01'),
        ob('X1', 'Limete', '999.00', '2026-08-01', true), // annulée
        ob('Y1', 'Limete', '999.00', '2026-11-01'), // hors période
      ],
      orders: [paid('A1', '100.00', true), paid('B1', '100.00', true), paid('B1', '50.00', false), paid('C1', '40.00', true)],
    } as unknown as Facts;
    const gaps = svc.collectionGaps(facts, 'USD', { from: '2026-07-01', to: '2026-09-30' });
    expect(gaps.map((g) => [g.rank, g.commune, g.gap.amount, g.recoveryPct])).toEqual([[1, 'Limete', '200.00', '33.3'], [2, 'Gombe', '50.00', '66.7']]);
    expect(gaps[0]!.assessed.amount).toBe('300.00');
    expect(gaps[0]!.suggestion).toMatch(/aucune dépense ; décision par une personne/);
    expect(gaps[0]!.targetGap).toBeNull(); // aucune assignation certifiée
  });
});
