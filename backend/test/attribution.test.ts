import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEMO } from '../src/seed.js';
import { callbackBody, setup, signedCallback, type TestEnv } from './helpers.js';

/** Paie une obligation précise par le rappel générique signé. */
async function pay(env: TestEnv, obligationId: string) {
  const order = (await env.req('POST', `/v1/obligations/${obligationId}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).json();
  const cb = await signedCallback(env, callbackBody(env, order.paymentReference, order.amount));
  expect(cb.json().status).toBe('CONFIRME');
  return order;
}

describe('§ 20.3 — attribution territoriale : commune du fait générateur', () => {
  it('chaque obligation compte pour la commune de son objet, pas pour celle du contribuable', async () => {
    const env = await setup();
    const ctx = env.app.ctx;
    const owner = ctx.users.get('u-contribuable')!;
    // Même contribuable, second bien situé à Masina (le premier est à Limete).
    const masina = ctx.objects.create(owner, {
      category: 'PARCELLE', commune: 'Masina', quartier: 'Sans Fil', localityRank: 2, lat: -4.385, lon: 15.39, attributes: { superficie_m2: '300' },
    });
    const rule = ctx.rules.rules.find((r) => r.code === DEMO.demoRuleCode)[0]!;
    const { obligation } = ctx.assessment.calculate(ctx.users.get('u-controleur')!, {
      ruleId: rule.id, taxpayerId: DEMO.taxpayerId, objectId: masina.id, inputs: {}, simulate: false,
    });
    const limete = ctx.assessment.byTaxpayer(DEMO.taxpayerId).find((o) => o.objectId === DEMO.parcelId)!;
    expect(limete.attribution).toMatchObject({ commune: 'Limete', quartier: 'Kingabwa', basis: 'LIEU_OBJET', sourceId: DEMO.parcelId });
    expect(obligation!.attribution).toMatchObject({ commune: 'Masina', basis: 'LIEU_OBJET', sourceId: masina.id });

    const o1 = await pay(env, limete.id);
    const o2 = await pay(env, obligation!.id);
    expect(ctx.payments.byReference(o1.paymentReference)!.attribution!.commune).toBe('Limete');
    expect(ctx.payments.byReference(o2.paymentReference)!.attribution!.commune).toBe('Masina');

    const rows = ctx.payments.revenueByCommune();
    expect(rows).toEqual([
      { commune: 'Limete', confirmedCount: 1, paid: [limete.amount], reconciled: [] },
      { commune: 'Masina', confirmedCount: 1, paid: [obligation!.amount], reconciled: [] },
    ]);

    // Rapprochement avec le relevé du compte public : seul « rapproché » est une recette arrivée.
    const st = await env.req('POST', '/v1/settlements/statements', 'u-tresor', {
      statementId: 'REL-ATTR-1', lines: [{ accountAlias: DEMO.dgipkAlias, amount: limete.amount, valueDate: '2026-09-26', paymentReference: o1.paymentReference }],
    });
    expect(st.statusCode).toBe(201);
    expect(ctx.payments.revenueByCommune()[0]).toMatchObject({ commune: 'Limete', reconciled: [limete.amount] });

    const dash = (await env.req('GET', '/v1/dashboards/governor', 'u-gouverneur')).json();
    expect(dash.liveByCommune).toMatchObject({ example: false, rows: expect.arrayContaining([expect.objectContaining({ commune: 'Masina' })]) });
    expect(JSON.stringify(dash.liveByCommune)).not.toContain(DEMO.taxpayerId);
  });

  it('une rectification conserve la commune d’origine ; un lieu non établi n’est jamais deviné', async () => {
    const env = await setup();
    const ctx = env.app.ctx;
    const ob = ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    const obj = ctx.objects.get(ob.objectId);
    // Correction ultérieure de la localisation de l'objet : l'obligation déjà émise ne change pas de commune.
    ctx.objects.objects.update({ ...obj, commune: 'Kalamu' });
    const rectified = ctx.assessment.rectify(ob.id, { amount: '100.00', currency: 'USD' }, {
      appealId: 'REC-TEST', reason: 'test', decidedBy: ctx.users.get('u-decideur')!,
    });
    expect(rectified.attribution).toEqual(ob.attribution);
    expect(rectified.attribution.commune).toBe('Limete');

    // Nouvel objet dont la commune n'est pas établie (une seule obligation annuelle par objet : jamais de double perception).
    const unlocated = ctx.objects.create(ctx.users.get('u-contribuable')!, {
      category: 'PARCELLE', commune: 'Masina', quartier: 'Sans Fil', localityRank: 2, lat: -4.385, lon: 15.39, attributes: {},
    });
    ctx.objects.objects.update({ ...ctx.objects.get(unlocated.id), commune: '' });
    const rule = ctx.rules.rules.find((r) => r.code === DEMO.demoRuleCode)[0]!;
    const { obligation } = ctx.assessment.calculate(ctx.users.get('u-controleur')!, {
      ruleId: rule.id, taxpayerId: DEMO.taxpayerId, objectId: unlocated.id, inputs: {}, simulate: false,
    });
    expect(obligation!.attribution).toMatchObject({ commune: null, basis: 'NON_LOCALISE' });
  });
});
