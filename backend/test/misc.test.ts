import { describe, expect, it } from 'vitest';
import { DEMO, demoObligationId, setup } from './helpers.js';

describe('Socle', () => {
  it('santé, méta (devises avec drapeaux, CDF principale), utilisateurs de démo', async () => {
    const env = await setup();
    expect((await env.req('GET', '/health')).json().status).toBe('ok');
    const meta = (await env.req('GET', '/v1/meta')).json();
    expect(meta.primaryCurrency).toBe('CDF');
    expect(meta.currencies[0]).toMatchObject({ code: 'CDF', flag: '🇨🇩' });
    expect(meta.catalogue).toEqual({ events: 239, categories: 23, mandatory: 126 });
    expect(meta.communes).toHaveLength(24);
    const users = (await env.req('GET', '/v1/demo/users')).json();
    for (const role of ['R01', 'R05', 'R06', 'R13', 'R14', 'R15', 'R16', 'R17', 'R19', 'R21', 'R22', 'R26', 'R10', 'R30']) {
      expect(users.some((u: { roles: string[] }) => u.roles.includes(role)), role).toBe(true);
    }
    expect(users.filter((u: { roles: string[] }) => u.roles.includes('R19')).length).toBeGreaterThanOrEqual(2);
    const cors = await env.app.inject({ method: 'OPTIONS', url: '/v1/meta', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' } });
    expect(cors.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('taux de change : source déclarée ; taux manquant → FX_RATE_MISSING', async () => {
    const env = await setup();
    const r = (await env.req('GET', '/v1/exchange-rates/2026-09-26')).json();
    expect(r).toMatchObject({ base: 'CDF', source: 'BCC (démo)', demo: true });
    expect(r.rates.find((x: { currency: string }) => x.currency === 'USD')).toMatchObject({ cdfPerUnit: '2850', flag: '🇺🇸' });
    const missing = await env.req('GET', '/v1/exchange-rates/2030-01-01');
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'FX_RATE_MISSING', type: expect.any(String), title: expect.any(String), detail: expect.any(String), status: 404 });
    expect((await env.req('GET', '/v1/exchange-rates/hier')).json().code).toBe('INVALID_DATE');
  });

  it('inscription publique, anti-doublon, objet provisoire et bail', async () => {
    const env = await setup();
    const reg = await env.req('POST', '/v1/registrations', undefined, { phone: '+243 899 000 111', fullName: 'Kabasele Tshibanda', language: 'lua', situation: 'owner_occupier' });
    expect(reg.statusCode).toBe(201);
    expect(reg.json()).toMatchObject({ verificationLevel: 'N0', iuc: expect.stringMatching(/^KIN-[0-9A-Z]{8}-[0-9A-Z]$/) });
    const dup = await env.req('POST', '/v1/registrations', undefined, { phone: '+243899000111', fullName: 'Autre', language: 'fr', situation: 'tenant' });
    expect(dup.json().code).toBe('PHONE_ALREADY_REGISTERED');
    const bad = await env.req('POST', '/v1/registrations', undefined, { phone: '12', fullName: 'X', language: 'xx', situation: 'roi' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('VALIDATION_ERROR');

    const obj = await env.req('POST', '/v1/fiscal-objects', 'u-contribuable', { category: 'UNITE_LOCATIVE', commune: 'Limete', quartier: 'Kingabwa', localityRank: 2, lat: -4.37, lon: 15.34, attributes: { surface_m2: '40' } });
    expect(obj.statusCode).toBe(201);
    expect(obj.json()).toMatchObject({ taxpayerId: DEMO.taxpayerId, status: 'PROVISOIRE', probativeStatus: 'DECLARE' });
    expect((await env.req('POST', '/v1/fiscal-objects', 'u-contribuable', { category: 'PARCELLE', commune: 'Paris', quartier: 'x', localityRank: 1, lat: -4.3, lon: 15.3 })).json().code).toBe('UNKNOWN_COMMUNE');
    expect((await env.req('POST', '/v1/fiscal-objects', 'u-agent-gombe', { taxpayerId: DEMO.taxpayerId, category: 'PARCELLE', commune: 'Limete', quartier: 'x', localityRank: 1, lat: -4.3, lon: 15.3 })).statusCode).toBe(403);

    const lease = await env.req('POST', '/v1/leases', 'u-locataire', { unitObjectId: obj.json().id, lessorId: DEMO.taxpayerId, rent: { amount: '120.00', currency: 'USD' }, periodicity: 'MENSUELLE', start: '2026-09-01' });
    expect(lease.statusCode).toBe(201);
    expect(lease.json()).toMatchObject({ lesseeId: DEMO.tenantTaxpayerId, declaredByRole: 'LOCATAIRE' });
    expect(env.app.ctx.comms.deliveries.find((d) => d.eventCode === 'lease.declared_by_tenant' && d.recipientId === DEMO.taxpayerId).length).toBeGreaterThan(0);
    const float = await env.req('POST', '/v1/leases', 'u-contribuable', { unitObjectId: obj.json().id, rent: { amount: 120.5, currency: 'USD' }, periodicity: 'MENSUELLE', start: '2026-09-01' });
    expect(float.statusCode).toBe(400);
  });

  it('AC-ASS-01 : l’explication d’une obligation contient règle, version, base légale, assiette, formule, montant, échéance, recours', async () => {
    const env = await setup();
    const o = (await env.req('GET', `/v1/obligations/${demoObligationId(env)}`, 'u-contribuable')).json();
    expect(o.explanation).toMatchObject({
      rule: { code: 'DEMO-IF-BATI', version: 1 },
      legalBasis: [{ id: 'demo-instrument-001', status: 'EN_VIGUEUR' }],
      baseDefinition: expect.any(String),
      formula: 'forfait',
      rates: { 'forfait:2': '150' },
      amount: { amount: '150.00', currency: 'USD' },
      dueDate: '2026-10-26',
      appealPath: expect.any(String),
    });
    expect(o.trace).toMatchObject({ ruleVersion: 1, nonOpposable: false, executable: true, legalInstrumentIds: ['demo-instrument-001'] });
    const list = (await env.req('GET', '/v1/obligations', 'u-contribuable')).json();
    expect(list).toHaveLength(1);
  });

  it('liquidation déterministe d’une règle certifiée avec entrées décimales', async () => {
    const env = await setup();
    const { publishCertifiedRule } = await import('./helpers.js');
    const { id } = await publishCertifiedRule(env);
    const body = { ruleId: id, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: { superficie_m2: '600.5' }, simulate: true };
    const a = (await env.req('POST', '/v1/assessments/calculate', 'u-controleur', body)).json();
    const b = (await env.req('POST', '/v1/assessments/calculate', 'u-controleur', body)).json();
    expect(a.trace.result).toEqual({ amount: '1501.25', currency: 'USD' });
    expect(b.trace.result).toEqual(a.trace.result);
    const real = await env.req('POST', '/v1/assessments/calculate', 'u-controleur', { ...body, simulate: false });
    expect(real.statusCode).toBe(201);
    expect(real.json().obligation.amount).toEqual({ amount: '1501.25', currency: 'USD' });
    const missing = await env.req('POST', '/v1/assessments/calculate', 'u-controleur', { ...body, inputs: {} });
    expect(missing.json().code).toBe('FORMULA_UNKNOWN_IDENTIFIER');
  });

  it('tableau du Gouverneur : 24 communes, échelle à 11 niveaux, actions en AIRecommendation', async () => {
    const env = await setup();
    const d = (await env.req('GET', '/v1/dashboards/governor', 'u-gouverneur')).json();
    expect(d.byCommune).toHaveLength(24);
    expect(new Set(d.byCommune.map((c: { commune: string }) => c.commune)).size).toBe(24);
    expect(d.ladder).toHaveLength(11);
    expect(d.ladder.map((l: { level: string }) => l.level)[0]).toBe('potential');
    expect(d.scenarios).toHaveLength(3);
    expect(d.trend).toHaveLength(12);
    expect(d.actions.length).toBeGreaterThanOrEqual(3);
    expect(d.actions[0]).toMatchObject({ autonomy: 'C_RECOMMANDATION', status: 'EMISE', example: true });
    expect(d.tiles.confirmedToday.currency).toBe('CDF');
    const again = (await env.req('GET', '/v1/dashboards/governor', 'u-gouverneur')).json();
    expect(again.actions.map((a: { id: string }) => a.id)).toEqual(d.actions.map((a: { id: string }) => a.id));
  });
});
