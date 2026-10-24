/**
 * Modules 62 et 78 — décision du maître d'ouvrage : facturation ou compensation AUTOMATIQUE des écarts mensuels aux
 * compagnies UNE FOIS l'arrêté provincial enregistré (planificateur mensuel réel, idempotent, audité), procédure
 * contradictoire offerte à la compagnie APRÈS l'avis ; avant l'arrêté : proposition seulement.
 */
import { describe, expect, it } from 'vitest';
import { DAY_MS } from '../src/core/clock.js';
import { verticalesPlugin, type VerticalesService } from '../src/plugins/verticales/plugin.js';
import { VX_DEMO } from '../src/plugins/verticales/seed.js';
import { aviaAutoSchedulerEnabled } from '../src/plugins/verticales/avia-auto-routes.js';
import { exampleRule, setupApp } from './partie5-helpers.js';

const U = VX_DEMO.users;
const B = VX_DEMO.airlineBTaxpayerId;
const HASH = 'c'.repeat(64);

async function withAct(signedOn = '2026-08-01') {
  const env = await setupApp([verticalesPlugin]);
  const svc = env.app.ctx.ext.verticales as VerticalesService;
  const record = async () => {
    const act = (await env.req('POST', '/v1/verticales/avia/cadre/actes', U.instructor, {
      reference: 'Arrêté provincial n° EXEMPLE/2026 [EXEMPLE]', title: 'Arrêté fictif sur les taxes aériennes [EXEMPLE]', signedOn, documentSha256: HASH,
      measuresEnabled: ['PENALITE_ELECTRONIQUE'], parameters: { penaltyPerTicketUsd: null, integrationDelayDays: null },
    })).json();
    expect((await env.req('POST', `/v1/verticales/avia/cadre/actes/${act.id}/validate`, U.chief, { approve: true, reason: 'Texte conforme (exemple).' })).json().status).toBe('ENREGISTRE');
  };
  const rules = () => {
    exampleRule(env, { code: 'AVIA-ECART-REVERSEMENT', formula: 'ecart_reversement', rateTable: {}, revenueCategory: 'PROVINCIAL_SPECIFIQUE' });
    exampleRule(env, { code: 'AVIA-TAXE-PASSAGER', formula: 'passagers * taxe_passager', rateTable: { taxe_passager: '5' } });
  };
  return { env, svc, record, rules };
}

describe('AVIA — exécution automatique des écarts mensuels après arrêté (modules 62, 78)', () => {
  it('avant l’arrêté : proposition seulement (aucune obligation), puis après l’arrêté : avis automatique idempotent, audité, contestable', async () => {
    const { env, svc, record, rules } = await withAct();
    rules();
    // Avant l'arrêté : même sur règles ACTIVES, aucune exécution.
    const before = await env.req('POST', '/v1/verticales/avia/auto/run', U.instructor, { period: '2026-08' });
    expect(before.statusCode).toBe(201);
    expect(before.json().run).toMatchObject({ mode: 'PROPOSITION', executions: [] });
    expect(env.app.ctx.assessment.byTaxpayer(B)).toHaveLength(0);
    expect((await env.req('POST', '/v1/verticales/avia/auto/run', U.airlineB, { period: '2026-08' })).statusCode).toBe(403);

    await record();
    const run = await env.req('POST', '/v1/verticales/avia/auto/run', U.instructor, { period: '2026-08' });
    expect(run.statusCode).toBe(201);
    expect(run.json().run.mode).toBe('EXECUTION');
    const exec = run.json().executions.find((e: { airlineTaxpayerId: string }) => e.airlineTaxpayerId === B);
    expect(exec).toMatchObject({ kind: 'FACTURATION', remittanceGap: '25.00', boardedWithoutIfa: 1, trigger: 'MANUELLE' });
    // Écart de reversement (25.00, chiffré par le RRH) + 1 passager sans IFA × 5 [EXEMPLE].
    expect(exec.billings.map((b: { amount: { amount: string } }) => b.amount.amount).sort()).toEqual(['25.00', '5.00']);
    expect(exec.notExecuted.some((n: { label: string }) => /Fret/.test(n.label))).toBe(true);
    expect(env.app.ctx.assessment.byTaxpayer(B)).toHaveLength(2);
    const decl = svc.avia.declarations.findOne((d) => d.taxpayerId === B && d.period === '2026-08')!;
    expect(decl).toMatchObject({ origin: 'CONSTAT_RRH', status: 'FACTUREE' });
    expect(decl.billing.filter((b) => b.outcome === 'EMISE')).toHaveLength(2);

    // Idempotence : passage manuel et planifié → aucun second avis.
    const again = (await env.req('POST', '/v1/verticales/avia/auto/run', U.instructor, { period: '2026-08' })).json();
    expect(again.executions).toHaveLength(0);
    expect(again.run.skipped.find((s: { airlineTaxpayerId: string }) => s.airlineTaxpayerId === B).reason).toMatch(/idempotence/);
    expect(svc.aviaAuto!.scheduledTick()).toEqual({ ran: false });
    expect(env.app.ctx.assessment.byTaxpayer(B)).toHaveLength(2);
    const audit = env.app.ctx.audit.list({ limit: 100000 }).items;
    expect(audit.filter((a) => a.action === 'avia.auto.billing.issued')).toHaveLength(2);
    expect(audit.filter((a) => a.action === 'avia.auto.run').map((a) => a.details.mode)).toEqual(['PROPOSITION', 'EXECUTION', 'EXECUTION']);

    // Procédure contradictoire APRÈS l'avis : la compagnie répond, chaque avis devient une réclamation instruite.
    const obs = await env.req('POST', `/v1/verticales/avia/auto/executions/${exec.id}/observations`, U.airlineB, { text: 'Le passager sans IFA voyageait sur un billet émis hors BSP (pièce jointe).', documents: [HASH] });
    expect(obs.statusCode).toBe(201);
    expect(obs.json().contradictory.observations[0].appealIds).toHaveLength(2);
    expect(obs.json().billings.every((b: { appeal: { id: string } | null }) => !!b.appeal)).toBe(true);
    expect((await env.req('POST', `/v1/verticales/avia/auto/executions/${exec.id}/observations`, U.airline, { text: 'Observation d’une autre compagnie non autorisée.', documents: [] })).statusCode).toBe(403);
    // La compagnie voit ses exécutions ; l'autre compagnie non.
    expect((await env.req('GET', '/v1/verticales/avia/auto/executions', U.airlineB)).json().items).toHaveLength(1);
    expect((await env.req('GET', '/v1/verticales/avia/auto/executions', U.airline)).json().items).toHaveLength(0);
    env.clock.advance(16 * DAY_MS);
    expect((await env.req('POST', `/v1/verticales/avia/auto/executions/${exec.id}/observations`, U.airlineB, { text: 'Observations tardives après le délai légal.', documents: [] })).json().code).toBe('CONTRADICTORY_CLOSED');
    const ov = (await env.req('GET', '/v1/verticales/avia/auto', U.chief)).json();
    expect(ov.totals).toMatchObject({ executions: 1, observations: 1 });
    expect(ov.rules.every((r: { status: string; demo: boolean }) => r.status === 'ACTIVE' && r.demo)).toBe(true);
  });

  it('trop-reversé : compensation automatique au mois suivant (planificateur), imputée sur le prochain écart facturé ; jamais rétroactif ; sans règle ACTIVE : proposition', async () => {
    const { env, svc, record, rules } = await withAct('2026-09-01');
    await record();
    // Mois antérieur à l'arrêté : proposition seulement (aucune rétroactivité).
    expect((await env.req('POST', '/v1/verticales/avia/auto/run', U.instructor, { period: '2026-08' })).json().run.mode).toBe('PROPOSITION');
    // Septembre : la banque crédite 30 USD sans billet de taxe correspondant → trop-reversé.
    expect((await env.req('POST', '/v1/verticales/avia/rrh/remittances', U.bank, { source: 'BANQUE_COLLECTRICE', airlineTaxpayerId: B, period: '2026-09', amount: { amount: '30.00', currency: 'USD' }, reference: 'VIR-EX-0930' })).statusCode).toBe(201);
    env.clock.set(new Date('2026-10-01T08:00:00.000Z'));
    expect(svc.aviaAuto!.scheduledTick()).toEqual({ ran: true });
    const sept = svc.aviaAuto!.executions.get(`AVIA-AUTO-2026-09-${B}`)!;
    expect(sept).toMatchObject({ kind: 'COMPENSATION', trigger: 'PLANIFIEE', compensation: { amount: '30.00', remaining: '30.00' } });
    expect(svc.avia.declarations.findOne((d) => d.taxpayerId === B && d.period === '2026-09')!.status).toBe('COMPENSEE');
    expect(svc.aviaAuto!.scheduledTick()).toEqual({ ran: false });

    // Octobre : 12 billets à 5 USD embarqués, rien crédité → écart 60 USD ; sans règle ACTIVE : rien n'est émis.
    const tickets = Array.from({ length: 12 }, (_, i) => ({ ticketNumber: `99900000${String(i).padStart(4, '0')}`, flightNumber: 'XB201', flightDate: '2026-10-02', destination: 'FBM', passengerRef: `PNR-OCT-${i}`, urbanTax: { amount: '5.00', currency: 'USD' } }));
    const tk = await env.req('POST', '/v1/verticales/avia/rrh/tickets', U.airlineB, { source: 'API_COMPAGNIE', airlineTaxpayerId: B, period: '2026-10', tickets });
    expect(tk.statusCode).toBe(201);
    const scans = tk.json().ifas.map((x: { qr: string }) => ({ qr: x.qr }));
    expect((await env.req('POST', '/v1/verticales/avia/rrh/passenger-events', U.airport, { source: 'RVA_EMBARQUEMENT', airlineTaxpayerId: B, flightNumber: 'XB201', flightDate: '2026-10-02', scans, withoutIfa: 0 })).statusCode).toBe(201);
    env.clock.set(new Date('2026-11-01T08:00:00.000Z'));
    expect(svc.aviaAuto!.scheduledTick()).toEqual({ ran: true });
    const octNoRule = svc.aviaAuto!.executions.get(`AVIA-AUTO-2026-10-${B}`)!;
    expect(octNoRule.kind).toBe('AUCUN_MONTANT');
    expect(octNoRule.notExecuted[0]!.reason).toMatch(/Aucune règle ACTIVE/);
    // Aucun avis ⇒ aucun crédit consommé.
    expect(octNoRule.creditsApplied).toEqual([]);
    expect(env.app.ctx.assessment.byTaxpayer(B)).toHaveLength(0);

    // Avec règle ACTIVE : novembre, 10 billets à 5 USD non crédités → écart 50, crédit de 30 imputé → avis de 20 USD.
    rules();
    const nov = Array.from({ length: 10 }, (_, i) => ({ ticketNumber: `99910000${String(i).padStart(4, '0')}`, flightNumber: 'XB301', flightDate: '2026-11-03', destination: 'FBM', passengerRef: `PNR-NOV-${i}`, urbanTax: { amount: '5.00', currency: 'USD' } }));
    const tk2 = (await env.req('POST', '/v1/verticales/avia/rrh/tickets', U.airlineB, { source: 'API_COMPAGNIE', airlineTaxpayerId: B, period: '2026-11', tickets: nov })).json();
    await env.req('POST', '/v1/verticales/avia/rrh/passenger-events', U.airport, { source: 'RVA_EMBARQUEMENT', airlineTaxpayerId: B, flightNumber: 'XB301', flightDate: '2026-11-03', scans: tk2.ifas.map((x: { qr: string }) => ({ qr: x.qr })), withoutIfa: 0 });
    env.clock.set(new Date('2026-12-01T08:00:00.000Z'));
    expect(svc.aviaAuto!.scheduledTick()).toEqual({ ran: true });
    const novExec = svc.aviaAuto!.executions.get(`AVIA-AUTO-2026-11-${B}`)!;
    expect(novExec.kind).toBe('FACTURATION');
    expect(novExec.billings.map((b) => b.amount.amount)).toEqual(['20.00']);
    expect(novExec.creditsApplied).toEqual([{ executionId: sept.id, amount: '30.00' }]);
    expect(svc.aviaAuto!.creditsOf(B)).toHaveLength(0);
    expect(env.app.ctx.audit.list({ limit: 100000 }).items.some((a) => a.action === 'avia.auto.compensation.imputed')).toBe(true);
  });

  it('planificateur : actif par défaut hors tests, désactivable', () => {
    expect(aviaAutoSchedulerEnabled({})).toBe(true);
    expect(aviaAutoSchedulerEnabled({ VITEST: 'true' })).toBe(false);
    expect(aviaAutoSchedulerEnabled({ VITEST: 'true', MOSOLO_AVIA_AUTO_SCHEDULER: 'on' })).toBe(true);
    expect(aviaAutoSchedulerEnabled({ MOSOLO_AVIA_AUTO_SCHEDULER: 'off' })).toBe(false);
  });
});
