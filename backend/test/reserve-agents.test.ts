/**
 * Module 67 — réserve des agents et sous-traitants (§ 37A.5), décision du maître d'ouvrage du 27/09/2026 :
 * la réserve de 10 % de chaque module est répartie au prorata des POINTS DE RÉSULTATS VÉRIFIÉS (objets confirmés après
 * contrôle qualité, enrôlements valides, régularisations confirmées par quittance définitive) × NOTE DE QUALITÉ, jamais
 * selon le montant liquidé ; les écrans de la commission de 10 % en sont des vues ; reprise des points fictifs ou
 * frauduleux à deux personnes.
 */
import { randomUUID } from 'node:crypto';
import { Money } from '@mosolo/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { sha256Hex } from '../src/core/crypto.js';
import { CIRCUITS, reconstruct } from '../src/plugins/integrite/gouvernance/circuits.js';
import type { AgentReserveService } from '../src/plugins/sanctions/reserve-agents.js';
import type { SanctionsService } from '../src/plugins/sanctions/service.js';
import type { TerrainService } from '../src/plugins/terrain/service.js';
import type { Finding } from '../src/plugins/terrain/model.js';
import { DEMO } from '../src/seed.js';
import { postStatement, callbackBody, PROVIDER_SECRET, signedCallback, type TestEnv } from './helpers.js';

async function fullApp() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} } });
  await app.ready();
  const env: TestEnv = {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
  return env;
}

/** Paie et rapproche une obligation (recette rapprochée du mois courant : alimente la réserve de son module). */
async function payAndReconcile(env: TestEnv, obligationId: string) {
  const ob = env.app.ctx.assessment.get(obligationId);
  const user = env.app.ctx.users.all().find((u) => u.taxpayerId === ob.taxpayerId)?.id ?? 'u-contribuable';
  const order = (await env.req('POST', `/v1/obligations/${obligationId}/payment-orders`, user, { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).json();
  expect(order.paymentReference, JSON.stringify(order)).toBeTruthy();
  await signedCallback(env, callbackBody(env, order.paymentReference, order.amount));
  const st = await postStatement(env, 'u-tresor', {
    statementId: `REL-${randomUUID().slice(0, 8)}`,
    lines: [{ accountAlias: order.beneficiaryAlias, amount: order.amount, valueDate: env.app.ctx.clock.now().toISOString().slice(0, 10), paymentReference: order.paymentReference }],
  });
  expect(st.statusCode, st.body).toBeLessThan(300);
  return env.app.ctx.payments.byReference(order.paymentReference)!;
}

let seq = 0;
function finding(te: TerrainService, over: Partial<Finding> & Pick<Finding, 'agentId' | 'objectId'>): Finding {
  seq += 1;
  const base: Finding = {
    id: `CST-TEST-${seq}`, clientRef: `ref-${seq}`, missionId: 'MIS-TEST', commune: 'Gombe', outcome: 'CONSTATE', observations: 'Objet présent (test).',
    gps: { lat: -4.3, lon: 15.3, accuracyM: 5, source: 'GPS' }, photoSha256: sha256Hex(`photo-${seq}`), capturedAt: '2026-11-10T08:00:00.000Z', receivedAt: '2026-11-10T08:05:00.000Z',
    reference: { kind: 'OBJET', lat: -4.3, lon: 15.3 }, distanceM: 3, toleranceM: 50, flags: [], seal: sha256Hex(`seal-${seq}`), probativeStatus: 'OBSERVE',
    status: 'VALIDE', review: { by: 'u-superviseur', at: '2026-11-10T10:00:00.000Z', decision: 'VALIDE', reason: 'Conforme (test).' },
    ...over,
  };
  return te.findings.insert(base);
}

describe('Module 67 : réserve des agents par module, points de résultats vérifiés × note de qualité', () => {
  it('répartition au prorata des points pondérés par la qualité (jamais du montant) ; vues agent, équipe, sous-traitant ; alimente la répartition', async () => {
    const env = await fullApp();
    env.clock.set('2026-11-10T09:00:00.000Z');
    const reserve = (env.app.ctx.ext.sanctions as SanctionsService).reserve as AgentReserveService;
    const te = env.app.ctx.ext.terrain as TerrainService;
    const ob = env.app.ctx.assessment.obligations.all().find((o) => o.taxpayerId === DEMO.taxpayerId && o.objectId && ['EXIGIBLE', 'EMISE'].includes(o.status))
      ?? env.app.ctx.assessment.obligations.all().find((o) => o.objectId && o.status === 'EXIGIBLE')!;
    expect(ob).toBeDefined();
    await payAndReconcile(env, ob.id);
    // Deux agents de terrain : A a 2 objets confirmés ; B 1 confirmé et 1 rejeté (note 0,5).
    const A = 'u-agent-terrain';
    const B = 'u-controleur';
    finding(te, { agentId: A, objectId: ob.objectId });
    finding(te, { agentId: A, objectId: ob.objectId, outcome: 'OBJET_NON_ENREGISTRE' });
    finding(te, { agentId: B, objectId: ob.objectId });
    finding(te, { agentId: B, objectId: ob.objectId, status: 'REJETE', review: { by: 'u-superviseur', at: '2026-11-10T10:00:00.000Z', decision: 'REJETE', reason: 'Photo floue (test).' } });
    // Auto-validation : aucun point.
    finding(te, { agentId: 'u-superviseur', objectId: ob.objectId });
    const c = reserve.compute('2026-11');
    const mod = c.modules.find((m) => m.module === ob.ruleCode && m.currency === ob.amount.currency)!;
    expect(mod).toBeDefined();
    expect(mod.status).toBe('REPARTIE');
    // Réserve : 10 % des recettes rapprochées du module dans le mois.
    expect(mod.reserve).toEqual(Money.fromJSON(ob.amount).percent('10', 'DOWN').toJSON());
    const a = c.agents.find((x) => x.agentId === A)!;
    const b = c.agents.find((x) => x.agentId === B)!;
    expect(a.quality).toMatchObject({ score: 1, confirmed: 2, judged: 2, byDefault: false });
    expect(b.quality).toMatchObject({ score: 0.5, confirmed: 1, judged: 2 });
    expect(c.agents.find((x) => x.agentId === 'u-superviseur')).toBeUndefined();
    expect(c.items.find((p) => p.agentId === 'u-superviseur')).toMatchObject({ status: 'EN_ATTENTE', statusReason: 'Auto-validation : aucun point' });
    // Prorata exact en unités mineures (troncature) : A pèse 4 fois B (2 × 1 contre 1 × 0,5).
    const R = Money.fromJSON(mod.reserve!).minor;
    const ha = mod.holders.find((h) => h.agentId === A)!;
    const hb = mod.holders.find((h) => h.agentId === B)!;
    // Le paiement rapproché dans les 72 h du constat de A est aussi une RÉGULARISATION provoquée par A : un point de
    // plus (quel que soit le montant), à faire valider à deux personnes avant d'être payable.
    expect(a.byKind).toEqual({ OBJET_CONFIRME: 2, ENROLEMENT_VALIDE: 0, REGULARISATION_CONFIRMEE: 1 });
    expect(ha.weightedPoints / hb.weightedPoints).toBeCloseTo(6, 6);
    const total = mod.holders.reduce((s, h) => s + h.weightedPoints, 0);
    expect(Money.fromJSON(ha.share!).minor).toBe((R * BigInt(Math.round(ha.weightedPoints * 1e7))) / BigInt(Math.round(total * 1e7)));
    const distributed = Money.fromJSON(mod.distributed!);
    expect(distributed.add(Money.fromJSON(mod.undistributed!)).equals(Money.fromJSON(mod.reserve!))).toBe(true);
    expect(Money.fromJSON(mod.undistributed!).isNegative()).toBe(false);
    // Objets confirmés : validés par le contrôle qualité → payables ; la régularisation attend sa validation.
    expect(Money.fromJSON(ha.payable!).minor).toBe((Money.fromJSON(ha.share!).minor * 2n) / 3n);
    expect(hb.payable).toEqual(hb.share);
    // Vues : équipe (régie) et sous-traitants ; payer par le Trésor, zéro espèce.
    expect(c.teams.some((t) => t.key === 'REGIE:DGIPK')).toBe(true);
    expect(c.cashHandled).toBe(false);
    expect(c.weights.status).toMatch(/par défaut/);
    expect(c.rules.join(' ')).toMatch(/jamais selon le montant/);
    // Accès : l'agent voit sa part ; le contribuable non ; la régie, le Trésor et l'audit voient tout.
    const mine = (await env.req('GET', '/v1/agents/me/reserve?period=2026-11', A)).json();
    expect(mine.agents.map((x: { agentId: string }) => x.agentId)).toEqual([A]);
    expect((await env.req('GET', '/v1/agents/me/reserve', 'u-contribuable')).statusCode).toBe(403);
    // Audit : points et notes pour le contrôle, sans aucun montant (décision du 29/09/2026).
    const audit = (await env.req('GET', '/v1/agents/reserve?period=2026-11', 'u-auditeur')).json();
    expect(audit.perimetre).toBe('POINTS_SANS_MONTANT');
    expect(audit.agents.length).toBeGreaterThan(0);
    expect(audit.agents.every((x: { share: unknown; payable: unknown; points: number }) => x.share === null && x.payable === null && typeof x.points === 'number')).toBe(true);
    expect((await env.req('GET', '/v1/agents/reserve?period=2026-11', 'u-gouverneur')).json().perimetre).toBe('COMPLET');
    expect((await env.req('GET', '/v1/agents/reserve?period=2026-11', 'u-contribuable')).statusCode).toBe(403);
    // Répartition (module 73) : les quotes-parts restent dans la réserve du mois.
    const rep = (await env.req('GET', '/v1/pilotage/repartition?period=2026-11', 'u-ministre-finances')).json();
    const shares = rep.agents.pointsShares.find((p: { currency: string }) => p.currency === ob.amount.currency);
    expect(shares).toMatchObject({ computed: true, withinReserve: true });
    expect(rep.agents.rules.join(' ')).toMatch(/Arbitré par le maître d’ouvrage/);
    // Écran de la commission harmonisé : le résumé de l'agent porte sa quote-part de réserve.
    const earnings = (await env.req('GET', '/v1/agents/me/earnings', A)).json();
    expect(earnings.reserve).toBeTruthy();
    expect(earnings.rules[0]).toMatch(/vue de la réserve/);
    const all = (await env.req('GET', '/v1/agents/earnings', 'u-ministre-finances')).json();
    expect(all.reserveNotice).toMatch(/points de résultats vérifiés/);
    expect((await env.req('GET', '/v1/agents/earnings', 'u-auditeur')).statusCode).toBe(403);
  });

  it('régularisation : un point par paiement provoqué rapproché et confirmé par quittance définitive, quel que soit son montant', async () => {
    const env = await fullApp();
    const reserve = (env.app.ctx.ext.sanctions as SanctionsService).reserve as AgentReserveService;
    const s = env.app.ctx.ext.sanctions as SanctionsService;
    const points = reserve.points().filter((p) => p.kind === 'REGULARISATION_CONFIRMEE');
    const lines = s.commissions.lines().filter((l) => l.orderId && (l.state === 'ACQUISE' || l.state === 'CONFIRMEE'));
    expect(points.length).toBe(lines.length);
    for (const p of points) {
      expect(p.points).toBe(1);
      const l = lines.find((x) => `${x.source}:${x.orderId}` === p.key)!;
      const final = l.state === 'ACQUISE' && env.app.ctx.receipts.byPaymentOrder(l.orderId!)?.status === 'DEFINITIVE';
      expect(p.status).toBe(final ? 'VERIFIE' : 'EN_ATTENTE');
      expect(p.modules).toEqual([env.app.ctx.assessment.get(l.obligationId).ruleCode]);
    }
    // Enrôlements valides : un point par compte créé (ou dossier déclaré distinct) ; doublon confirmé : aucun point.
    const canaux = env.app.ctx.ext.canaux as { enrolment: { enrolments: { all(): { id: string; status: string; taxpayerId?: string; review?: { decision: string } }[] } } };
    const enrols = canaux.enrolment.enrolments.all().filter((e) => e.taxpayerId && e.status !== 'DOUBLON_CONFIRME');
    expect(enrols.length).toBeGreaterThan(0);
    const enrPoints = reserve.points().filter((p) => p.kind === 'ENROLEMENT_VALIDE');
    expect(enrPoints.map((p) => p.key).sort()).toEqual(enrols.map((e) => `ENR:${e.id}`).sort());
    for (const p of enrPoints) {
      const e = enrols.find((x) => `ENR:${x.id}` === p.key)!;
      expect(p.status).toBe(e.status === 'CREE' || e.review?.decision === 'DISTINCT' ? 'VERIFIE' : 'EN_ATTENTE');
    }
  });

  it('reprise des points fictifs ou frauduleux : proposée par le contrôle qualité, décidée par une autre personne ; récupération sur les mois clos', async () => {
    const env = await fullApp();
    env.clock.set('2026-11-10T09:00:00.000Z');
    const reserve = (env.app.ctx.ext.sanctions as SanctionsService).reserve as AgentReserveService;
    const te = env.app.ctx.ext.terrain as TerrainService;
    const ob = env.app.ctx.assessment.obligations.all().find((o) => o.taxpayerId === DEMO.taxpayerId && o.objectId && ['EXIGIBLE', 'EMISE'].includes(o.status))
      ?? env.app.ctx.assessment.obligations.all().find((o) => o.objectId && o.status === 'EXIGIBLE')!;
    await payAndReconcile(env, ob.id);
    const A = 'u-agent-terrain';
    const B = 'u-controleur';
    const f1 = finding(te, { agentId: A, objectId: ob.objectId });
    finding(te, { agentId: B, objectId: ob.objectId });
    const beforeA = reserve.compute('2026-11').agents.find((x) => x.agentId === A)!;
    // L'agent ne propose pas la reprise de ses points ; un rôle non habilité non plus.
    const body = { pointKeys: [`OBJ:${f1.id}`], grounds: 'POINT_FICTIF', motif: 'Objet inexistant à la contre-visite (test).', evidenceSha256: [sha256Hex('cv')] };
    expect((await env.req('POST', '/v1/agents/reserve/reprises', 'u-contribuable', body)).statusCode).toBe(403);
    // Mois suivant : la quote-part de novembre est réputée versée.
    env.clock.set('2026-12-02T09:00:00.000Z');
    const p = await env.req('POST', '/v1/agents/reserve/reprises', 'u-controleur', body);
    expect(p.statusCode, p.body).toBe(201);
    const id = p.json().id;
    expect((await env.req('POST', '/v1/agents/reserve/reprises', 'u-superviseur', body)).json().code).toBe('REPRISE_EN_COURS');
    // Le proposant ne décide pas ; la régie (R06/R07) décide.
    expect((await env.req('POST', `/v1/agents/reserve/reprises/${id}/decision`, 'u-controleur', { approve: true, motif: 'Décision motivée (test).' })).statusCode).toBe(403);
    const d = await env.req('POST', `/v1/agents/reserve/reprises/${id}/decision`, 'u-dg-dgipk', { approve: true, motif: 'Contre-visite probante : point fictif (test).' });
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json()).toMatchObject({ status: 'DECIDEE', decision: { by: 'u-dg-dgipk', approve: true } });
    // Montant à récupérer = quote-part payable avant − après la reprise (mois clos).
    const after = reserve.compute('2026-11');
    const a2 = after.agents.find((x) => x.agentId === A);
    expect(after.items.find((x) => x.key === `OBJ:${f1.id}`)).toMatchObject({ status: 'REPRIS', clawbackId: id });
    const recovered = Money.fromJSON(d.json().toRecover[0]);
    const before = Money.fromJSON(beforeA.payable[0]!);
    const now = a2 ? Money.fromJSON(a2.payable[0] ?? { amount: '0.00', currency: before.currency }) : Money.zero(before.currency);
    expect(recovered.equals(before.subtract(now))).toBe(true);
    expect(recovered.isZero()).toBe(false);
    // La reprise dégrade la note (point repris = résultat non confirmé) et l'anti-fraude est alertée.
    if (a2) expect(a2.quality.score).toBeLessThan(1);
    expect(env.app.ctx.alerts.list().some((x) => x.type === 'RESERVE_POINTS_REPRIS')).toBe(true);
    expect(env.app.ctx.audit.list({ limit: 1e6 }).items.map((e) => e.action)).toEqual(expect.arrayContaining(['agents.reserve.clawback_proposed', 'agents.reserve.clawback_decided']));
    // Circuit à deux personnes reconstitué depuis le journal (surveillance de la collusion, garde de rotation).
    expect(CIRCUITS.find((x) => x.code === 'RESERVE_REPRISE_POINTS')?.guard?.url).toBe('/v1/agents/reserve/reprises/:id/decision');
    const { decisions } = reconstruct(env.app.ctx.audit.list({ limit: 1e6 }).items);
    expect(decisions.filter((x) => x.circuit === 'RESERVE_REPRISE_POINTS').map((x) => [x.proposerId, x.approverId, x.outcome])).toEqual([['u-controleur', 'u-dg-dgipk', 'APPROUVE']]);
  });

  it('vue « sous-traitants et équipes » (écran des sous-traitants) : un sous-traitant ne voit que sa structure', async () => {
    const env = await fullApp();
    env.clock.set('2026-11-10T09:00:00.000Z');
    const te = env.app.ctx.ext.terrain as TerrainService;
    const ob = env.app.ctx.assessment.obligations.all().find((o) => o.taxpayerId === DEMO.taxpayerId && o.objectId && ['EXIGIBLE', 'EMISE'].includes(o.status))
      ?? env.app.ctx.assessment.obligations.all().find((o) => o.objectId && o.status === 'EXIGIBLE')!;
    await payAndReconcile(env, ob.id);
    finding(te, { agentId: 'u-agent-terrain', objectId: ob.objectId, subcontractorId: 'ST-0001' });
    finding(te, { agentId: 'u-controleur', objectId: ob.objectId });
    const regie = (await env.req('GET', '/v1/terrain/points-resultats?period=2026-11', 'u-dg-dgipk')).json();
    expect(regie.available).toBe(true);
    expect(regie.subcontractors.map((x: { key: string }) => x.key)).toEqual(['ST-0001']);
    expect(regie.agents.length).toBe(2);
    const st = (await env.req('GET', '/v1/terrain/points-resultats?period=2026-11', 'terrain-st-resp')).json();
    expect(st.agents.map((x: { agentId: string }) => x.agentId)).toEqual(['u-agent-terrain']);
    expect(st.cashHandled).toBe(false);
    expect((await env.req('GET', '/v1/terrain/points-resultats', 'u-contribuable')).statusCode).toBe(403);
  });
});
