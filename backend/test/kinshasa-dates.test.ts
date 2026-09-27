import { describe, expect, it } from 'vitest';
import { isoDate, kinshasaDate } from '../src/core/clock.js';
import type { Appeal } from '../src/modules/appeals/service.js';
import { DEMO, setup } from './helpers.js';

/** 23 h 30 UTC le 26/09 = 00 h 30 le 27/09 à Kinshasa (UTC+1) : le jour métier est déjà le 27. */
const LATE_UTC = '2026-09-26T23:30:00.000Z';

async function liquidateAt(at: string) {
  const env = await setup();
  env.clock.set(at);
  const ctx = env.app.ctx;
  const object = ctx.objects.create(ctx.users.get('u-contribuable')!, {
    category: 'PARCELLE', commune: 'Masina', quartier: 'Sans Fil', localityRank: 2, lat: -4.385, lon: 15.39, attributes: { superficie_m2: '300' },
  });
  const rule = ctx.rules.rules.find((r) => r.code === DEMO.demoRuleCode)[0]!;
  const { obligation } = ctx.assessment.calculate(ctx.users.get('u-controleur')!, { ruleId: rule.id, taxpayerId: DEMO.taxpayerId, objectId: object.id, inputs: {}, simulate: false });
  return { env, obligation: obligation! };
}

describe('Jours métier à Kinshasa (UTC+1) — frontière de 23 h 30 UTC', () => {
  it('horloge : isoDate reste UTC (horodatage technique), kinshasaDate donne le jour civil local', () => {
    expect(isoDate(new Date(LATE_UTC))).toBe('2026-09-26');
    expect(kinshasaDate(new Date(LATE_UTC))).toBe('2026-09-27');
    expect(kinshasaDate(new Date('2026-09-26T22:59:59.999Z'))).toBe('2026-09-26');
  });

  it('échéance d’une liquidation : 30 jours après le jour de Kinshasa', async () => {
    expect((await liquidateAt(LATE_UTC)).obligation.dueDate).toBe('2026-10-27');
    expect((await liquidateAt('2026-09-26T22:30:00.000Z')).obligation.dueDate).toBe('2026-10-26');
  });

  it('délais de réclamation : notification, dépôt et « aujourd’hui » en jours de Kinshasa', async () => {
    const { env, obligation } = await liquidateAt(LATE_UTC);
    const appeal = { obligationId: obligation.id, submittedAt: LATE_UTC } as Appeal;
    const d = env.app.ctx.appeals.deadlines(appeal);
    // Tout est au 27/09 : notification, dépôt, aujourd'hui ⇒ 60 jours pleins restent (et non 61).
    expect(d).toMatchObject({ notifiedOn: '2026-09-27', filingDeadline: '2026-10-27', decisionDueBy: '2026-11-26', daysRemaining: 60, filedLate: false });
    // Dépôt le 27/10 à 23 h 30 UTC = 28/10 à Kinshasa : hors délai de dépôt.
    expect(env.app.ctx.appeals.deadlines({ ...appeal, submittedAt: '2026-10-27T23:30:00.000Z' }).filedLate).toBe(true);
  });

  it('journal des vérifications publiques et date du taux de change : jour de Kinshasa', async () => {
    const env = await setup();
    const ctx = env.app.ctx;
    env.clock.set('2026-09-26T22:30:00.000Z');
    expect(() => ctx.fx.ratesFor('2026-09-27')).toThrow(/Aucun taux/);
    env.clock.set(LATE_UTC);
    expect(ctx.fx.ratesFor('2026-09-27').date).toBe('2026-09-27');
    expect(ctx.fx.convert({ amount: '10.00', currency: 'USD' }, 'CDF').rateDate).toBe('2026-09-27');
    ctx.receipts.publicVerify('INCONNU', { clientKey: 'client-test' });
    expect(ctx.receipts.verificationJournal().days.map((x) => x.date)).toEqual(['2026-09-27']);
  });
});
