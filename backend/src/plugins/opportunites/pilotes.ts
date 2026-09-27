/**
 * Moteur de découverte des recettes (module 61) — résultats des pilotes et indicateurs.
 *
 *  - Un résultat de pilote est constaté par le comité de pilotage (rôles de l'étape 7 « Pilote ») sur une opportunité
 *    dont l'étape Pilote est complétée : recettes observées dans le périmètre pilote, recettes du groupe témoin
 *    (comparaison) et coût réel d'implémentation, avec la source des chiffres. Rien n'est estimé par le système.
 *  - Gain net d'un pilote = (recettes pilote − recettes du groupe témoin) − coût d'implémentation. Sans groupe témoin,
 *    le gain est marqué « sans comparaison » (non attribuable au seul pilote).
 *  - Indicateurs : opportunités instruites (au-delà du signal), décidées par issue, gain net des pilotes par devise.
 *  - Aucun résultat ne crée de règle, d'obligation ni de taxe (garde-fou § 8.4) : l'information éclaire la décision.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import { requireUser, type User } from '../../core/auth.js';
import { conflict, notFound, unprocessable } from '../../core/errors.js';
import { isoDateString, moneySchema, parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository } from '../../core/repository.js';
import { OPP_ACTIONS } from './policy.js';
import type { OpportunitesService } from './service.js';

export interface PilotResult {
  id: string;
  opportunityId: string;
  periodStart: string;
  periodEnd: string;
  perimeter: string;
  observedRevenue: MoneyJSON;
  comparisonRevenue: MoneyJSON | null;
  implementationCost: MoneyJSON;
  netGain: MoneyJSON;
  withComparison: boolean;
  source: string;
  note: string | null;
  recordedBy: string;
  recordedAt: string;
  /** Aucun effet juridique : ni règle, ni obligation, ni taxe. */
  effect: 'AUCUNE_OBLIGATION_CREEE';
}

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
export const pilotResultSchema = z.object({
  periodStart: isoDateString, periodEnd: isoDateString, perimeter: text(3, 300),
  observedRevenue: moneySchema, comparisonRevenue: moneySchema.nullable().optional(), implementationCost: moneySchema,
  source: text(3, 500), note: z.string().trim().max(2000).optional(),
}).strict();

export class PilotResultsService {
  readonly results = new InMemoryAppendOnlyRepository<PilotResult>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly opps: OpportunitesService) {}

  record(u: User, opportunityId: string, input: z.infer<typeof pilotResultSchema>): PilotResult {
    authorize(u, 'opportunites:step.7');
    const o = this.opps.opportunities.get(opportunityId);
    if (!o) throw notFound('OPPORTUNITY_NOT_FOUND', `Opportunité inconnue : ${opportunityId}`);
    if (!o.steps.some((s) => s.n === 7)) throw conflict('PILOT_NOT_DEFINED', 'Résultat impossible : l’étape 7 « Pilote » (périmètre, durée, indicateurs, groupe de comparaison) n’est pas complétée.');
    if (input.periodEnd < input.periodStart) throw unprocessable('INVALID_PERIOD', 'Période du pilote invalide.');
    const observed = Money.parseStrict(input.observedRevenue);
    const cost = Money.parseStrict(input.implementationCost);
    const comparison = input.comparisonRevenue ? Money.parseStrict(input.comparisonRevenue) : null;
    const currencies = new Set([observed.currency, cost.currency, ...(comparison ? [comparison.currency] : [])]);
    if (currencies.size > 1) throw unprocessable('CURRENCY_MISMATCH', 'Recettes, groupe témoin et coût dans une seule devise.');
    if (observed.isNegative() || cost.isNegative() || comparison?.isNegative()) throw unprocessable('INVALID_AMOUNT', 'Montants positifs ou nuls attendus.');
    const net = observed.subtract(comparison ?? Money.zero(observed.currency)).subtract(cost);
    const r = this.results.append({
      id: this.ids.next('PIL', 4), opportunityId: o.id, periodStart: input.periodStart, periodEnd: input.periodEnd, perimeter: input.perimeter,
      observedRevenue: observed.toJSON(), comparisonRevenue: comparison?.toJSON() ?? null, implementationCost: cost.toJSON(), netGain: net.toJSON(),
      withComparison: !!comparison, source: input.source, note: input.note ?? null, recordedBy: u.id, recordedAt: this.ctx.clock.now().toISOString(),
      effect: 'AUCUNE_OBLIGATION_CREEE',
    });
    this.ctx.audit.append({ actor: actorOf(u), action: 'opportunite.pilot_result.recorded', resourceType: 'opportunite', resourceId: o.id, details: { resultId: r.id, netGain: r.netGain, withComparison: r.withComparison, source: r.source } });
    return r;
  }

  list(u: User, opportunityId: string): PilotResult[] {
    authorize(u, OPP_ACTIONS.read);
    return this.results.find((r) => r.opportunityId === opportunityId);
  }

  indicators(u: User) {
    authorize(u, OPP_ACTIONS.read);
    const all = this.opps.opportunities.all();
    const instructed = all.filter((o) => o.steps.some((s) => s.n >= 2) || o.status === 'DECIDEE');
    const gains = new Map<CurrencyCode, { net: Money; comparable: Money; pilots: number }>();
    for (const r of this.results.all()) {
      const m = Money.fromJSON(r.netGain);
      const g = gains.get(m.currency) ?? { net: Money.zero(m.currency), comparable: Money.zero(m.currency), pilots: 0 };
      gains.set(m.currency, { net: g.net.add(m), comparable: r.withComparison ? g.comparable.add(m) : g.comparable, pilots: g.pilots + 1 });
    }
    return {
      generatedAt: this.ctx.clock.now().toISOString(),
      opportunites: {
        total: all.length, instruites: instructed.length, enInstruction: all.filter((o) => o.status === 'EN_INSTRUCTION' && o.steps.some((s) => s.n >= 2)).length,
        signauxNonInstruits: all.filter((o) => o.status === 'EN_INSTRUCTION' && !o.steps.some((s) => s.n >= 2)).length,
        decidees: { total: all.filter((o) => o.status === 'DECIDEE').length, ...Object.fromEntries((['ACTIVATION', 'REPORT', 'ABANDON'] as const).map((k) => [k, all.filter((o) => o.decision?.outcome === k).length])) },
        parEtape: Array.from({ length: 8 }, (_, i) => ({ step: i + 1, completed: i === 7 ? all.filter((o) => !!o.decision).length : all.filter((o) => o.steps.some((s) => s.n === i + 1)).length })),
      },
      pilotes: {
        resultats: this.results.count(),
        opportunitesPilotees: new Set(this.results.all().map((r) => r.opportunityId)).size,
        gainNet: [...gains.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, g]) => ({ currency, netGain: g.net.toJSON(), netGainWithComparison: g.comparable.toJSON(), pilots: g.pilots })),
        ...(this.results.count() === 0 ? { note: 'Aucun résultat de pilote constaté : gain net non mesuré (aucune donnée source).' } : {}),
      },
      methode: 'Gain net = (recettes pilote − recettes du groupe témoin) − coût d’implémentation, constaté par le comité de pilotage avec sa source ; jamais estimé par le système.',
    };
  }
}

export function registerPilotRoutes(app: FastifyInstance, svc: PilotResultsService): void {
  app.get('/v1/opportunites-indicateurs', async (req) => svc.indicators(requireUser(req)));
  app.get<{ Params: { id: string } }>('/v1/opportunites/:id/resultats-pilote', async (req) => ({ items: svc.list(requireUser(req), req.params.id) }));
  app.post<{ Params: { id: string } }>('/v1/opportunites/:id/resultats-pilote', async (req, reply) =>
    reply.code(201).send(svc.record(requireUser(req), req.params.id, parse(pilotResultSchema, req.body))));
}
