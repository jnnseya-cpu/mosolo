/**
 * Modules 63 à 66 et 68 — compléments vérifiés : consultation SVI par numéro d'objet (64), confirmation vocale
 * complète d'une quittance (64), opérations réalisées à la voix (64), part des enrôlements par commune (63),
 * accessibilité des points par commune (66), code USSD et numéro vert « à raccorder » (convention opérateur requise).
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { IVR_NUMBER_LABEL, USSD_CODE_LABEL } from '../src/plugins/canaux/model.js';
import { canauxPlugin } from '../src/plugins/canaux/plugin.js';
import type { CanauxService } from '../src/plugins/canaux/service.js';
import { COMMUNES } from '../src/reference/kinshasa.js';
import { DEMO } from '../src/seed.js';
import { callbackBody, PROVIDER_SECRET, signedCallback, type TestEnv } from './helpers.js';

async function setup() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} }, plugins: [canauxPlugin] });
  await app.ready();
  const env: TestEnv = {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
  return { env, svc: app.ctx.ext.canaux as CanauxService };
}

async function call(env: TestEnv, channel: 'ussd' | 'ivr', msisdn: string, inputs: string[]) {
  const start = await env.req('POST', `/v1/${channel}/sessions`, undefined, { msisdn });
  expect(start.statusCode).toBe(201);
  const screens = [start.json()];
  for (const input of inputs) screens.push((await env.req('POST', `/v1/${channel}/sessions/${start.json().sessionId}/input`, undefined, { input })).json());
  return screens;
}

describe('Module 64 — serveur vocal : consultation par numéro d’objet, confirmation vocale, opérations à la voix', () => {
  it('le numéro d’objet identifie le titulaire ; son code secret reste exigé ; seules les obligations de l’objet sont lues', async () => {
    const { env, svc } = await setup();
    svc.cards.setPin(DEMO.taxpayerId, '4826', { kind: 'system', id: 'test' });
    // Objet inconnu : refus, rien n'est révélé.
    let s = await call(env, 'ivr', '+243810000101', ['1', 'OBJ-INCONNU-99']);
    expect(s[2].prompts.join(' ')).toMatch(/incorrect/i);
    s = await call(env, 'ivr', '+243810000102', ['1', DEMO.parcelId, '4826']);
    expect(s[2].prompts.join(' ')).toMatch(/Objet reconnu/);
    const balance = s[3];
    expect(balance.text).toMatch(/obligation\(s\) à payer/);
    const objectDues = env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId).filter((o) => o.objectId === DEMO.parcelId && ['EXIGIBLE', 'EMISE', 'PARTIELLEMENT_PAYEE'].includes(o.status));
    expect(balance.text).toContain(`${objectDues.length} obligation(s)`);
    // Code secret faux : aucune lecture.
    s = await call(env, 'ivr', '+243810000103', ['1', DEMO.parcelId, '1111']);
    expect(s[3].text).toMatch(/Code incorrect/);
  });

  it('confirmation vocale de la quittance : montant, objet, période et numéro de quittance ; opérations à la voix comptées', async () => {
    const { env, svc } = await setup();
    svc.cards.setPin(DEMO.taxpayerId, '4826', { kind: 'system', id: 'test' });
    // Paiement de l'obligation de démonstration : une quittance existe.
    const ob = env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    const order = (await env.req('POST', `/v1/obligations/${ob.id}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': 'k-quittance-voix' })).json();
    await signedCallback(env, callbackBody(env, order.paymentReference));
    const receipt = env.app.ctx.receipts.byPaymentOrder(env.app.ctx.payments.byReference(order.paymentReference)?.id ?? '')!;
    expect(receipt, JSON.stringify(order)).toBeDefined();
    const s = await call(env, 'ivr', '+243810000104', ['4', DEMO.parcelId, '4826']);
    const voice = s[3].prompts.join(' ');
    expect(voice).toContain('Quittance numéro');
    expect(voice).toContain('dollars américains');
    expect(voice).toContain(ob.label);
    expect(voice).toMatch(/période du/);
    expect(receipt.number.length).toBeGreaterThan(4);
    // Indicateurs : appels au SVI et opérations réalisées à la voix, par nature et par langue.
    const ind = (await env.req('GET', '/v1/channels/indicators', 'u-gouverneur')).json();
    expect(ind.channels.voice.calls).toBeGreaterThanOrEqual(1);
    expect(ind.channels.voice.byKind.QUITTANCES).toBeGreaterThanOrEqual(1);
    expect(ind.channels.voice.operations).toBeGreaterThanOrEqual(1);
    expect(ind.channels.voice.byLanguage.fr).toBeGreaterThanOrEqual(1);
    expect(ind.channels.voice.tollFreeNumber).toBe(IVR_NUMBER_LABEL);
    // Numéro vert et code court : attribués par convention opérateur — jamais inventés.
    expect(IVR_NUMBER_LABEL).toMatch(/À RACCORDER — convention opérateur requise/);
    expect(USSD_CODE_LABEL).toMatch(/À RACCORDER — convention opérateur requise/);
  });
});

describe('Modules 63 et 66 — indicateurs calculés sur les données réelles', () => {
  it('part des enrôlements assistés par commune ; communes couvertes par un point agréé actif', async () => {
    const { env, svc } = await setup();
    const ind = (await env.req('GET', '/v1/channels/indicators', 'u-gouverneur')).json();
    const total = svc.enrolment.enrolments.count();
    expect(ind.enrolments.total).toBe(total);
    const sum = ind.enrolments.byCommune.reduce((a: number, r: { total: number }) => a + r.total, 0);
    expect(sum).toBe(total);
    for (const r of ind.enrolments.byCommune) expect(r.sharePct).toBe(Math.round((r.total / total) * 1000) / 10);
    const active = svc.points.points.all().filter((p) => p.status === 'ACTIF');
    const covered = COMMUNES.filter((c) => active.some((p) => p.commune === c));
    expect(ind.accessibility).toMatchObject({ activePoints: active.length, communesTotal: COMMUNES.length, communesCovered: covered.length, populationWithin15Min: null });
    expect(ind.accessibility.communesWithoutPoint).toHaveLength(COMMUNES.length - covered.length);
    expect(ind.accessibility.note).toMatch(/non mesurée/);
    expect(ind.points.suspended).toBe(svc.points.points.all().filter((p) => p.status === 'SUSPENDU').length);
    // Module 65 : cartes actives et réémissions (approuvées en double validation).
    expect(ind.cards.active).toBe(svc.cards.cards.all().filter((c) => c.status === 'ACTIVE').length);
    expect(ind.cards.reissues).toBe(svc.cards.reissues.find((r) => r.status === 'APPROUVEE').length);
  });
});
