import { SAMPLE_RULES, type RuleSheet } from '@mosolo/shared';
import { describe, expect, it } from 'vitest';
import { kinshasaDate } from '../src/core/clock.js';
import { ApiError } from '../src/core/errors.js';
import { DEMO, publishCertifiedRule, setup } from './helpers.js';

/** Fiche fictive : taux certifié dans la table, base fournie par la requête. */
const sheet = (over: Partial<RuleSheet> = {}): RuleSheet => ({
  ...structuredClone(SAMPLE_RULES[0]!), formula: 'base * taux / 100', rateTable: { taux: '22', 'forfait:2': '150' }, ...over,
});

describe('Moteur de règles — les taux certifiés priment sur la requête', () => {
  it('une entrée qui porte le nom d’un taux est refusée (400 INPUT_NOT_ALLOWED), jamais substituée', async () => {
    const env = await setup();
    const rules = env.app.ctx.rules;
    expect(rules.evaluate(sheet(), { base: '100' }, 2).value).toBe('22');
    let err: unknown;
    try {
      rules.evaluate(sheet(), { base: '100', taux: '1' }, 2);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: 'INPUT_NOT_ALLOWED' });
    // Taux décliné par rang : ni le nom nu, ni un rang manquant ne peuvent être comblés par une entrée.
    const ranked = sheet({ formula: 'forfait' });
    expect(rules.requiredInputs(ranked)).toEqual([]);
    expect(rules.evaluate(ranked, {}, 2).rates).toEqual({ 'forfait:2': '150' });
    expect(() => rules.evaluate(ranked, { forfait: '1' }, 2)).toThrow(/non prévue/);
    expect(() => rules.evaluate(ranked, {}, 3)).toThrow(/non défini pour le rang 3/);
  });

  it('liquidation : entrée étrangère à la formule ou taux injecté → 400, le taux de la table s’applique sinon', async () => {
    const env = await setup();
    const { id } = await publishCertifiedRule(env, { code: 'TEST-INPUTS' });
    const calc = (inputs: Record<string, string>) => env.req('POST', '/v1/assessments/calculate', 'u-controleur', {
      ruleId: id, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs, simulate: true,
    });
    const injected = await calc({ superficie_m2: '100', tarif_m2: '0.01' });
    expect(injected.statusCode).toBe(400);
    expect(injected.json()).toMatchObject({ code: 'INPUT_NOT_ALLOWED', refused: ['tarif_m2'] });
    const foreign = await calc({ superficie_m2: '100', remise: '50' });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().code).toBe('INPUT_NOT_ALLOWED');
    const bad = await calc({ 'tarif_m2:2': '0.01' });
    expect(bad.statusCode).toBe(400);
    const ok = await calc({ superficie_m2: '100' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().trace.rates).toEqual({ 'tarif_m2:2': '2.5' });
  });

  it('recalcul : les anciennes entrées sont filtrées sur les entrées requises de la nouvelle version', async () => {
    const env = await setup();
    const rules = env.app.ctx.rules;
    // v1 : le taux était une entrée ; v2 : il devient un taux certifié de la table.
    const v2 = sheet();
    const oldTrace = { base: '100', taux: '5' };
    expect(() => rules.evaluate(v2, oldTrace, 2)).toThrow(/non prévue/);
    expect(rules.pickRequiredInputs(v2, oldTrace)).toEqual({ base: '100' });
    expect(rules.evaluate(v2, rules.pickRequiredInputs(v2, oldTrace), 2).value).toBe('22');
  });
});

describe('Dates des règles — journée de Kinshasa', () => {
  it('kinshasaDate : 23 h 30 UTC appartient déjà au lendemain à Kinshasa', () => {
    expect(kinshasaDate(new Date('2026-09-30T23:30:00Z'))).toBe('2026-10-01');
    expect(kinshasaDate(new Date('2026-09-30T22:59:59Z'))).toBe('2026-09-30');
  });

  it('une règle PUBLIEE devient ACTIVE à 00:00 heure de Kinshasa (23:00 UTC la veille) et liquide aussitôt', async () => {
    const env = await setup();
    const { id } = await publishCertifiedRule(env, { code: 'TEST-MINUIT', effectiveFrom: '2026-10-01' });
    env.clock.set('2026-09-30T22:59:00Z');
    expect(env.app.ctx.rules.get(id).status).toBe('PUBLIEE');
    env.clock.set('2026-09-30T23:30:00Z');
    expect(env.app.ctx.rules.get(id).status).toBe('ACTIVE');
    const res = await env.req('POST', '/v1/assessments/calculate', 'u-controleur', {
      ruleId: id, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: { superficie_m2: '100' }, simulate: false,
    });
    expect(res.statusCode).toBe(201);
  });
});
