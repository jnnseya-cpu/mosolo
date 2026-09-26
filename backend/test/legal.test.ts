import { describe, expect, it } from 'vitest';
import { evaluateFormula, parseFormula } from '../src/modules/rules/formula.js';
import { DEMO, publishCertifiedRule, setup } from './helpers.js';

describe('Évaluateur de formules (sans eval)', () => {
  const run = (f: string, vars: Record<string, string> = {}) => evaluateFormula(parseFormula(f), (n) => {
    if (!(n in vars)) throw new Error(`inconnu ${n}`);
    return vars[n]!;
  });
  it('respecte priorités, parenthèses, max/min et décimaux exacts', () => {
    expect(run('1 + 2 * 3')).toBe('7');
    expect(run('(1 + 2) * 3')).toBe('9');
    expect(run('0.1 + 0.2')).toBe('0.3');
    expect(run('max(0, loyers * taux / 100 - retenues)', { loyers: '5400', taux: '22', retenues: '1080' })).toBe('108');
    expect(run('min(3, -2, 5)')).toBe('-2');
    expect(run('10 / 4')).toBe('2.5');
  });
  it('refuse toute construction hors grammaire', () => {
    expect(() => parseFormula('process.exit(1)')).toThrow();
    expect(() => parseFormula('constructor("x")')).toThrow(/non autorisée/);
    expect(() => parseFormula('1 +')).toThrow();
    expect(() => parseFormula('a; b')).toThrow();
    expect(() => run('1 / 0')).toThrow(/zéro/);
  });
});

describe('Registre juridique', () => {
  it('AC-LEG-01 : une règle A_VERIFIER ne liquide pas (422) et la tentative est journalisée', async () => {
    const env = await setup();
    const before = env.app.ctx.assessment.obligations.count();
    const res = await env.req('POST', '/v1/assessments/calculate', 'u-controleur', {
      ruleId: 'rule-if-pp-bati-v1', taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: {}, simulate: false,
    });
    expect(res.statusCode).toBe(422);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ code: 'RULE_NOT_EXECUTABLE', status: 422 });
    expect(env.app.ctx.assessment.obligations.count()).toBe(before);
    const audit = env.app.ctx.audit.list({ action: 'assessment.liquidation.refused' });
    expect(audit.total).toBe(1);
    expect(audit.items[0]!.outcome).toBe('DENIED');
  });

  it('simulation autorisée sur une règle A_VERIFIER mais non opposable', async () => {
    const env = await setup();
    const res = await env.req('POST', '/v1/assessments/calculate', 'u-controleur', {
      ruleId: 'rule-if-pp-bati-v1', taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: {}, simulate: true,
    });
    expect(res.statusCode).toBe(200);
    const { trace, obligation } = res.json();
    expect(obligation).toBeNull();
    expect(trace).toMatchObject({ nonOpposable: true, executable: false, rates: { 'forfait:2': '150' }, result: { amount: '150.00', currency: 'USD' } });
  });

  it('AC-LEG-02 : la même personne ne peut pas rédiger et publier', async () => {
    const env = await setup();
    const { id, responses } = await publishCertifiedRule(env);
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    // Nouvelle fiche : le rédacteur tente de publier lui-même.
    const again = await publishCertifiedRule(env, { code: 'TEST-SOD' });
    expect(again.id).not.toBe(id);
    const env2 = await setup();
    const c = await env2.req('POST', '/v1/legal-rules', 'u-juriste-redacteur', { ...env2.app.ctx.rules.get(id), id: undefined });
    expect(c.statusCode).toBe(400); // champs non admis (strict)
    const r = await publishCertifiedRule(env2, { code: 'TEST-SOD-2' });
    const ruleId = r.id;
    // Remise à zéro partielle : fiche neuve, 3 visas puis le rédacteur tente la publication.
    const f = await env2.req('POST', '/v1/legal-rules', 'u-juriste-redacteur', {
      ...pick(env2.app.ctx.rules.get(ruleId)), code: 'TEST-SOD-3',
    });
    const fid = f.json().id;
    await env2.req('POST', `/v1/legal-rules/${fid}/approve`, 'u-juriste-redacteur', { role: 'REDACTEUR' });
    await env2.req('POST', `/v1/legal-rules/${fid}/approve`, 'u-juriste-verificateur', { role: 'VERIFICATEUR_JURIDIQUE' });
    await env2.req('POST', `/v1/legal-rules/${fid}/approve`, 'u-validateur-financier', { role: 'VALIDATEUR_FINANCIER' });
    const publish = await env2.req('POST', `/v1/legal-rules/${fid}/approve`, 'u-juriste-redacteur', { role: 'AUTORITE_PUBLICATION' });
    expect(publish.statusCode).toBe(403);
    expect(publish.json().code).toBe('SEPARATION_OF_DUTIES');
    expect(env2.app.ctx.rules.get(fid).status).toBe('APPROUVEE');
    // Le vérificateur ne peut pas non plus publier (personne déjà intervenue).
    const byVerifier = await env2.req('POST', `/v1/legal-rules/${fid}/approve`, 'u-juriste-verificateur', { role: 'AUTORITE_PUBLICATION' });
    expect(byVerifier.json().code).toBe('SEPARATION_OF_DUTIES');
    // Et le cumul des rôles R13 + R16 est impossible par construction.
    expect(() => env2.app.ctx.users.add({ id: 'u-cumul', name: 'Cumul', roles: ['R13', 'R16'], entity: 'MINFIN' })).toThrow(/Cumul interdit/);
  });

  it('AC-LEG-03 : une règle citant un instrument abrogé ne peut pas être publiée', async () => {
    const env = await setup();
    const { id, responses } = await publishCertifiedRule(env, { code: 'TEST-OL13', legalInstrumentIds: ['ol-13-001', 'demo-instrument-001'] });
    expect(responses.slice(0, 3).every((r) => r.statusCode === 200)).toBe(true);
    const last = responses[3]!;
    expect(last.statusCode).toBe(422);
    expect(last.json()).toMatchObject({ code: 'ABROGATED_INSTRUMENT', instrumentId: 'ol-13-001' });
    expect(env.app.ctx.rules.get(id).status).toBe('APPROUVEE');
    expect(env.app.ctx.audit.list({ action: 'rule.publication.blocked' }).total).toBe(1);
  });

  it('cycle : 4 visas distincts → PUBLIEE, puis ACTIVE à la date d’effet (horloge injectée)', async () => {
    const env = await setup();
    const { id, responses } = await publishCertifiedRule(env, { code: 'TEST-FUTUR', effectiveFrom: '2026-10-01' });
    expect(responses.map((r) => r.json().status)).toEqual(['REVUE_JURIDIQUE', 'REVUE_FINANCIERE', 'APPROUVEE', 'PUBLIEE']);
    expect(env.app.ctx.rules.get(id).status).toBe('PUBLIEE');
    env.clock.set('2026-10-01T08:00:00Z');
    const list = await env.req('GET', '/v1/legal-rules', 'u-controleur');
    expect(list.json().find((r: { id: string }) => r.id === id).status).toBe('ACTIVE');
  });

  it('visas dans l’ordre et par le bon rôle ; source non certifiée bloquée', async () => {
    const env = await setup();
    const { id } = await publishCertifiedRule(env, { code: 'TEST-PRESSE', sourceVerification: 'PRESSE' });
    expect(env.app.ctx.rules.get(id).status).toBe('APPROUVEE');
    const c = await env.req('POST', '/v1/legal-rules', 'u-juriste-verificateur', {});
    expect(c.statusCode).toBe(403);
    const r = await env.req('POST', '/v1/legal-rules/rule-irl-kin-r1-v1/approve', 'u-juriste-redacteur', { role: 'REDACTEUR' });
    expect(r.json().code).toBe('RULE_REQUIRES_VERIFICATION');
  });
});

function pick(rule: Record<string, unknown>) {
  const keys = ['revenueCategory', 'label', 'legalInstrumentIds', 'articles', 'competentAuthority', 'administeringEntity', 'taxableEvent', 'liableParty',
    'baseDefinition', 'formula', 'rateTable', 'currency', 'rounding', 'periodicity', 'dueRule', 'exemptions', 'penalties', 'effectiveFrom',
    'beneficiaryAccountAlias', 'appealPath', 'sourceVerification'];
  return Object.fromEntries(keys.map((k) => [k, rule[k]]));
}
