/**
 * Modules 76 et 81 — décisions du maître d'ouvrage : commission instantanée de l'agent selon la grille contractuelle de
 * l'opérateur ; ajustement des prix et commissions par l'opérateur DANS les limites approuvées ; analyse quotidienne ;
 * blocage préventif par décision motivée ; pénalité au pourcentage réglementaire du ticket, contestable ; période de
 * grâce paramétrable (quatre yeux) avant pénalités.
 */
import { describe, expect, it } from 'vitest';
import { DAY_MS } from '../src/core/clock.js';
import { rakapayPlugin, type RakaPayService } from '../src/plugins/rakapay/plugin.js';
import { RK_DEMO } from '../src/plugins/rakapay/seed.js';
import { titresPlugin } from '../src/plugins/titres/plugin.js';
import type { TestEnv } from './helpers.js';
import { exampleRule, setupApp } from './partie5-helpers.js';

const PLACE = { commune: 'Gombe', label: 'Parking privé [EXEMPLE]', lat: -4.305, lon: 15.3 };
const M = RK_DEMO.managerUser;

async function privateOperator(env: TestEnv) {
  const ctx = env.app.ctx;
  ctx.taxpayers.register({ phone: '+243899300011', fullName: 'Parking privé fictif SARL [EXEMPLE]', language: 'fr', situation: 'other' }, 'TP-OP-PRIVE-11');
  ctx.users.add({ id: 'op-admin', name: 'Exploitant privé (démo)', roles: ['R30'], entity: 'PUBLIC', taxpayerId: 'TP-OP-PRIVE-11' });
  ctx.users.add({ id: 'rk-dg', name: 'DG DGTK (démo)', roles: ['R06'], entity: 'DGTK' });
  ctx.users.add({ id: 'op-agent-a', name: 'Agent opérateur A (démo)', roles: ['R35'], entity: 'OP-PRIVE' });
  ctx.users.add({ id: 'op-agent-b', name: 'Agent opérateur B (démo)', roles: ['R35'], entity: 'OP-PRIVE' });
  const op = (await env.req('POST', '/v1/rakapay/operateurs/candidatures', 'op-admin', { name: 'Parking privé fictif', kind: 'PRIVE', commune: 'Gombe' })).json();
  await env.req('POST', `/v1/rakapay/operateurs/${op.id}/agrement/proposition`, M, { outcome: 'ACCREDITER', motif: 'Dossier complet (démonstration)' });
  await env.req('POST', `/v1/rakapay/operateurs/${op.id}/agrement/decision`, 'rk-dg', { approve: true, motif: 'Agrément accordé (démonstration)' });
  const offer = (await env.req('POST', `/v1/rakapay/operateurs/${op.id}/offres`, 'op-admin', { family: 'STATIONNEMENT', commercialName: 'Parking 3 h', duration: { unit: 'HEURE', value: 3 }, place: PLACE, price: { amount: '1500', currency: 'CDF' } })).json();
  await env.req('POST', `/v1/rakapay/offres/${offer.id}/decision`, M, { approve: true, motif: 'Offre conforme (démonstration)' });
  expect((await env.req('POST', `/v1/rakapay/operateurs/${op.id}/agents`, 'op-admin', { userId: 'op-agent-a' })).statusCode).toBe(201);
  return { opId: op.id as string, offerId: offer.id as string };
}

describe('RakaPay — limites approuvées, commission instantanée, analyse quotidienne, blocage préventif (module 76)', () => {
  it('l’opérateur ajuste prix et commissions dans les limites approuvées ; la commission de l’agent est calculée à chaque vente', async () => {
    const env = await setupApp([titresPlugin, rakapayPlugin]);
    const { opId, offerId } = await privateOperator(env);
    const limits = { commissionMaxPct: '10', priceBands: [{ offerId, min: { amount: '1000', currency: 'CDF' }, max: { amount: '2000', currency: 'CDF' } }], motif: 'Limites contractuelles approuvées (démonstration).' };
    // Sans limites approuvées : aucun ajustement.
    expect((await env.req('POST', `/v1/rakapay/offres/${offerId}/prix`, 'op-admin', { price: { amount: '1800', currency: 'CDF' } })).json().code).toBe('NO_APPROVED_LIMITS');
    expect((await env.req('POST', `/v1/rakapay/operateurs/${opId}/limites`, 'op-admin', limits)).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/rakapay/operateurs/${opId}/limites`, M, limits)).statusCode).toBe(200);
    // Prix : dans la fourchette sans nouvelle approbation ; hors fourchette refusé ; la supervision n'ajuste pas à la place.
    expect((await env.req('POST', `/v1/rakapay/offres/${offerId}/prix`, 'op-admin', { price: { amount: '1800', currency: 'CDF' } })).json().price.amount).toMatch(/^1800/);
    expect((await env.req('POST', `/v1/rakapay/offres/${offerId}/prix`, 'op-admin', { price: { amount: '2500', currency: 'CDF' } })).json().code).toBe('OUTSIDE_APPROVED_LIMITS');
    expect((await env.req('POST', `/v1/rakapay/offres/${offerId}/prix`, M, { price: { amount: '1200', currency: 'CDF' } })).json().code).toBe('NOT_OPERATOR_ADMIN');
    // Grille de commission plafonnée.
    expect((await env.req('POST', `/v1/rakapay/operateurs/${opId}/grille-commissions`, 'op-admin', { rates: [{ offerId: '*', pct: '12' }] })).json().code).toBe('OUTSIDE_APPROVED_LIMITS');
    expect((await env.req('POST', `/v1/rakapay/operateurs/${opId}/grille-commissions`, 'op-admin', { rates: [{ offerId: '*', pct: '8' }] })).statusCode).toBe(200);
    // Vente : commission instantanée (8 % de 1 800).
    const sale = (await env.req('POST', '/v1/rakapay/ventes-privees', 'op-agent-a', { offerId, channel: 'MOBILE_MONEY' })).json();
    expect(sale.commission).toMatchObject({ pct: '8' });
    expect(Number(sale.commission.amount.amount)).toBe(144);
    expect((await env.req('GET', '/v1/rakapay/commissions/mes-commissions', 'op-agent-a')).json().items).toHaveLength(1);

    // Analyse quotidienne : l'opérateur voit tout ; l'agent ne voit que ses ventes ; aucune visibilité croisée.
    const an = (await env.req('GET', `/v1/rakapay/operateurs/${opId}/analyse-quotidienne?date=2026-09-26`, 'op-admin')).json();
    expect(an).toMatchObject({ viewer: 'EXPLOITANT', sales: 1, commissions: { count: 1 } });
    expect(an.byAgent[0]).toMatchObject({ key: 'op-agent-a', count: 1 });
    const mine = (await env.req('GET', `/v1/rakapay/operateurs/${opId}/analyse-quotidienne?date=2026-09-26`, 'op-agent-a')).json();
    expect(mine).toMatchObject({ viewer: 'AGENT', sales: 1, byAgent: [] });
    expect((await env.req('GET', `/v1/rakapay/operateurs/${opId}/analyse-quotidienne?date=2026-09-26`, 'op-agent-b')).statusCode).toBe(403);

    // Blocage préventif motivé (supervision), vente refusée ; levée par une AUTRE personne.
    const blk = await env.req('POST', `/v1/rakapay/operateurs/${opId}/agents/op-agent-a/blocage`, M, { motif: 'Ventes atypiques constatées : examen en cours (démonstration).' });
    expect(blk.statusCode).toBe(201);
    expect((await env.req('POST', '/v1/rakapay/ventes-privees', 'op-agent-a', { offerId, channel: 'MOBILE_MONEY' })).json().code).toBe('AGENT_BLOCKED');
    expect((await env.req('POST', `/v1/rakapay/blocages/${blk.json().id}/levee`, M, { motif: 'Levée par la même personne (refusée).' })).json().code).toBe('SEPARATION_OF_DUTIES');
    expect((await env.req('POST', `/v1/rakapay/blocages/${blk.json().id}/levee`, 'rk-dg', { motif: 'Examen clos sans abus établi (démonstration).' })).json().status).toBe('LEVE');
    expect((await env.req('POST', '/v1/rakapay/ventes-privees', 'op-agent-a', { offerId, channel: 'MOBILE_MONEY' })).statusCode).toBe(201);
    const actions = env.app.ctx.audit.list({ limit: 100000 }).items.map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['rakapay.limits.approved', 'rakapay.offer.price_adjusted', 'rakapay.offer.price_refused', 'rakapay.commission_grid.updated', 'rakapay.agent_commission.computed', 'rakapay.agent.blocked', 'rakapay.agent.unblocked']));
  });
});

describe('Pass wewa — période de grâce paramétrable et pénalité réglementaire contestable (modules 81 et 76)', () => {
  it('grâce approuvée à quatre yeux ; pendant la grâce, aucune pénalité ; après, pénalité au pourcentage du ticket, contestée par le redevable', async () => {
    const env = await setupApp([titresPlugin, rakapayPlugin]);
    const rk = env.app.ctx.ext.rakapay as RakaPayService;
    env.app.ctx.users.add({ id: 'rk-dg', name: 'DG DGTK (démo)', roles: ['R06'], entity: 'DGTK' });
    const g0 = (await env.req('GET', '/v1/rakapay/periode-grace', M)).json();
    expect(g0.modules.find((m: { module: string }) => m.module === '81')).toMatchObject({ until: '2026-10-31', active: true });
    const prop = (await env.req('POST', '/v1/rakapay/periode-grace', M, { module: '81', until: '2026-10-05', motif: 'Fin de la campagne d’enregistrement (démonstration).' })).json();
    expect((await env.req('POST', `/v1/rakapay/periode-grace/${prop.id}/decision`, M, { approve: true, motif: 'Auto-approbation refusée.' })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/rakapay/periode-grace/${prop.id}/decision`, 'rk-dg', { approve: true, motif: 'Échéance conforme à l’acte (démonstration).' })).json().status).toBe('APPROUVEE');
    expect(rk.titres.gracePeriods.get('81')).toBe('2026-10-05');

    exampleRule(env, { code: 'PEN-TITRE-81', currency: 'CDF', revenueCategory: 'PENALITE', formula: 'prix_ticket * pourcentage / 100', rateTable: { pourcentage: '50' } });
    const moto = rk.motos.findOne((m) => m.plate.replace(/\s/g, '') === 'KN-M20418')!;
    const control = () => env.req('POST', '/v1/rakapay/wewa/controles', RK_DEMO.controllerUser, { plate: moto.plate, place: { commune: 'Kalamu', label: 'Avenue de la Victoire', lat: -4.3395, lon: 15.3112 } });
    const decide = (id: string) => env.req('POST', `/v1/titres/constats/${id}/decision`, M, { outcome: 'RETENU', motif: 'Moto sans pass valide au contrôle (démonstration).', referenceTypeCode: 'RKP-WEWA-JOUR', holderTaxpayerId: RK_DEMO.driver2Taxpayer });
    // Pendant la grâce : constat pédagogique, pénalité impossible.
    const c1 = (await control()).json();
    expect(c1.constat).toBeTruthy();
    expect((await decide(c1.constat.id)).json().code).toBe('GRACE_PERIOD');
    // Après la grâce : pénalité = 50 % [EXEMPLE] du prix du ticket de référence (sa propre règle ACTIVE).
    env.clock.advance(12 * DAY_MS);
    const c2 = (await control()).json();
    const retained = await decide(c2.constat.id);
    expect(retained.statusCode, retained.body).toBe(200);
    const k = retained.json();
    expect(k).toMatchObject({ status: 'RETENU', penalty: { ruleCode: 'PEN-TITRE-81', percentage: '50', referenceTypeCode: 'RKP-WEWA-JOUR', holderTaxpayerId: RK_DEMO.driver2Taxpayer } });
    expect(Number(k.penalty.amount.amount)).toBe(Number(k.penalty.ticketPrice.amount) / 2);
    // Le redevable consulte et conteste ; le contrôleur ne peut pas décider de son propre constat.
    const mine = (await env.req('GET', '/v1/titres/constats/mine', RK_DEMO.driver2User)).json();
    expect(mine.map((x: { id: string }) => x.id)).toContain(k.id);
    const contest = await env.req('POST', `/v1/titres/constats/${k.id}/contestation`, RK_DEMO.driver2User, { grounds: 'Mon pass avait été payé la veille par la coopérative (reçu joint).' });
    expect(contest.statusCode).toBe(201);
    expect(contest.json().contests).toHaveLength(1);
    expect((await env.req('POST', `/v1/titres/constats/${k.id}/contestation`, RK_DEMO.driverUser, { grounds: 'Contestation par un tiers non concerné.' })).statusCode).toBe(403);
    const ind = (await env.req('GET', '/v1/titres/indicateurs?module=81', M)).json();
    expect(ind.constats).toMatchObject({ retained: 1, contested: 1 });
  });
});
