/**
 * Module 79 — plaque fiscale immobilière NFIU (décision du maître d'ouvrage) : l'agent HABILITÉ voit la situation
 * complète au scan (propriétaire, occupation et loyers, IF et IRL dus, payé / en attente / impayé avec pénalités,
 * historique), en lecture seule ; rapports journaliers des agents ; scan public minimal ; accès minimal inchangé.
 */
import { describe, expect, it } from 'vitest';
import { DAY_MS } from '../src/core/clock.js';
import type { VerticalesService } from '../src/plugins/verticales/plugin.js';
import { DEMO } from '../src/seed.js';
import { exampleRule, payObligation, setupApp } from './partie5-helpers.js';

describe('NFIU — situation complète pour l’agent habilité, rapports journaliers (module 79)', () => {
  it('habilitation nominative (jamais soi-même), situation complète en lecture seule, public minimal, révocation → minimal', async () => {
    const env = await setupApp();
    const vx = env.app.ctx.ext.verticales as VerticalesService;
    const plate = vx.plates.findOne((p) => p.kind === 'NFIU' && p.status === 'POSEE')!;
    // IRL [EXEMPLE] liquidé sur l'unité louée, puis payé ; l'IF de démonstration reste dû.
    const irl = exampleRule(env, { code: 'EX-IRL-KIN', formula: 'loyer_annuel * taux_irl', rateTable: { taux_irl: '0.22' }, administeringEntity: 'DGIPK', revenueCategory: 'IMPOT_PROVINCIAL', label: 'DÉMONSTRATION — IRL [EXEMPLE] (revenus locatifs)' });
    const liq = await env.req('POST', '/v1/assessments/calculate', 'u-controleur', { ruleId: irl.id, taxpayerId: DEMO.taxpayerId, objectId: DEMO.unitId, inputs: { loyer_annuel: '1200' }, simulate: false });
    expect(liq.statusCode, liq.body).toBe(201);
    await payObligation(env, liq.json().obligation.id, 'u-contribuable');

    // Agent non habilité : accès minimal inchangé.
    const minimal = (await env.req('GET', `/v1/verticales/plates/${plate.code}/scan`, 'u-agent-terrain')).json();
    expect(minimal.access).toBe('minimal');
    expect(minimal.situationComplete).toBeUndefined();
    expect(minimal.obligations).toBeUndefined();
    expect((await env.req('GET', `/v1/verticales/nfiu/plates/${plate.code}/situation`, 'u-agent-terrain')).json().code).toBe('NFIU_HABILITATION_REQUIRED');

    // Habilitation : jamais par l'agent lui-même, dans son secteur, par la direction.
    const body = { userId: 'u-agent-terrain', communes: ['Limete'], motif: 'Campagne de recouvrement IF / IRL — Limete (démonstration).', validUntil: '2026-12-31' };
    expect((await env.req('POST', '/v1/verticales/nfiu/habilitations', 'u-agent-terrain', body)).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/verticales/nfiu/habilitations', 'u-dg-dgipk', { ...body, userId: 'u-agent-gombe' })).json().code).toBe('OUTSIDE_TERRITORY');
    expect((await env.req('POST', '/v1/verticales/nfiu/habilitations', 'u-dg-dgipk', { ...body, userId: 'u-controleur' })).json().code).toBe('NOT_A_FIELD_AGENT');
    expect((await env.req('POST', '/v1/verticales/nfiu/habilitations', 'u-dg-dgipk', body)).statusCode).toBe(201);

    // Agent habilité : situation complète au scan.
    const full = (await env.req('GET', `/v1/verticales/plates/${plate.code}/scan`, 'u-agent-terrain')).json();
    expect(full.access).toBe('full');
    const s = full.situationComplete;
    expect(s.owner).toMatchObject({ taxpayerId: DEMO.taxpayerId, name: 'Mbuyi Kalala' });
    expect(s.occupation.status).toBe('LOUE');
    expect(s.occupation.leases[0].rent).toBeTruthy();
    const kinds = s.obligations.map((o: { kind: string; payment: string }) => `${o.kind}:${o.payment}`);
    expect(kinds).toEqual(expect.arrayContaining(['IRL:PAYE', 'IF:EN_ATTENTE']));
    expect(s.totals.IRL.paid).toEqual([{ amount: '264.00', currency: 'USD' }]);
    expect(s.history.payments.length).toBeGreaterThanOrEqual(1);
    expect(s.editable).toBe(false);
    expect(s.obligations.every((o: { editable: boolean }) => o.editable === false)).toBe(true);
    // Scan public : toujours minimal (aucun nom, aucun montant).
    const pub = JSON.stringify((await env.req('GET', `/v1/public/verticales/plates/${plate.code}`)).json());
    expect(pub).not.toMatch(/Mbuyi|"amount"|IRL/);

    // Après l'échéance : l'IF devient « impayé », avec les pénalités du circuit de recouvrement (proposition motivée).
    env.clock.advance(60 * DAY_MS);
    const pen = exampleRule(env, { code: 'EX-PEN-RETARD', formula: 'forfait', rateTable: { forfait: '10' }, administeringEntity: 'DGIPK', revenueCategory: 'PENALITE' });
    const ifOb = s.obligations.find((o: { kind: string }) => o.kind === 'IF');
    const prop = await env.req('POST', '/v1/recouvrement/penalites', 'u-contentieux', { obligationId: ifOb.id, penaltyRuleId: pen.id, inputs: {}, motivation: 'Retard de paiement constaté après mise en demeure (démonstration).' });
    const late = (await env.req('GET', `/v1/verticales/nfiu/plates/${plate.code}/situation`, 'u-agent-terrain')).json();
    const lateIf = late.obligations.find((o: { id: string }) => o.id === ifOb.id);
    expect(lateIf.payment).toBe('IMPAYE');
    expect(lateIf.penalties.overdueDays).toBeGreaterThan(0);
    expect(prop.statusCode, prop.body).toBe(201);
    expect(lateIf.penalties.items[0]).toMatchObject({ status: 'PROPOSEE', amount: { amount: '10.00', currency: 'USD' } });
    expect(late.totals.IF.unpaid).toBe(1);

    // Révocation : retour à l'accès minimal.
    expect((await env.req('POST', '/v1/verticales/nfiu/habilitations/u-agent-terrain/revocation', 'u-dg-dgipk', { motif: 'Fin de la campagne de recouvrement (démonstration).' })).statusCode).toBe(200);
    expect((await env.req('GET', `/v1/verticales/plates/${plate.code}/scan`, 'u-agent-terrain')).json().access).toBe('minimal');
    const audit = env.app.ctx.audit.list({ limit: 100000 }).items.map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['nfiu.habilitation.granted', 'nfiu.full_situation.viewed', 'nfiu.habilitation.revoked', 'nfiu.full_situation.refused']));
  });

  it('rapports journaliers des agents : produits automatiquement la veille, l’agent ne voit que sa ligne ; indicateurs', async () => {
    const env = await setupApp();
    const vx = env.app.ctx.ext.verticales as VerticalesService;
    const plate = vx.plates.findOne((p) => p.kind === 'NFIU' && p.status === 'POSEE')!;
    await env.req('GET', `/v1/verticales/plates/${plate.code}/scan?lat=-4.34&lon=15.35&accuracyM=8`, 'u-agent-terrain');
    await env.req('GET', `/v1/verticales/plates/${plate.code}/scan`, 'u-agent-terrain-2');
    const r = await env.req('POST', '/v1/verticales/nfiu/rapports', 'u-superviseur', { date: '2026-09-26' });
    expect(r.statusCode).toBe(201);
    const row = r.json().agents.find((a: { agentId: string }) => a.agentId === 'u-agent-terrain');
    expect(row).toMatchObject({ scans: 2, platesIssued: expect.any(Number) });
    expect(row.bySituation.red + row.bySituation.amber + row.bySituation.green + row.bySituation.grey).toBe(2);
    const mine = (await env.req('GET', '/v1/verticales/nfiu/rapports?date=2026-09-26', 'u-agent-terrain')).json();
    expect(mine.agents.map((a: { agentId: string }) => a.agentId)).toEqual(['u-agent-terrain']);
    expect(mine.scope).toBe('AGENT');
    expect((await env.req('GET', '/v1/verticales/nfiu/rapports?date=2026-09-26', 'u-contribuable')).statusCode).toBe(403);
    // Rapport de la veille produit par le planificateur, une seule fois.
    env.clock.advance(DAY_MS);
    expect(vx.nfiu!.scheduledTick()).toEqual({ ran: false }); // déjà produit à la demande pour ce jour
    env.clock.advance(DAY_MS);
    expect(vx.nfiu!.scheduledTick()).toEqual({ ran: true });
    expect(vx.nfiu!.scheduledTick()).toEqual({ ran: false });
    const hist = (await env.req('GET', '/v1/verticales/nfiu/rapports/historique', 'u-superviseur')).json().items;
    expect(hist.map((h: { date: string; trigger: string }) => `${h.date}:${h.trigger}`)).toEqual(['2026-09-27:PLANIFIEE', '2026-09-26:MANUELLE']);
    // Le rapport existant (enrichi) reste servi.
    const legacy = (await env.req('GET', '/v1/verticales/plates-report/daily?date=2026-09-26', 'u-superviseur')).json();
    expect(legacy.agents.find((a: { agentId: string }) => a.agentId === 'u-agent-terrain').bySituation).toBeDefined();
    const ind = (await env.req('GET', '/v1/verticales/nfiu/indicateurs', 'u-superviseur')).json();
    expect(ind.housesRegistered).toBe(1);
    expect(ind.IF.housesWithObligation).toBe(1);
  });
});
