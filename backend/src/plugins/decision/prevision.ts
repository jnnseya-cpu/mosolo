/**
 * Prévision des recettes — prévision de trésorerie hebdomadaire par catégorie et par commune (module 47, § 38.3) :
 *  - encaissement attendu d'une semaine = obligations EXIGIBLES dont l'échéance tombe dans la semaine (non payées, non
 *    contestées, non annulées) × taux de paiement de la catégorie ;
 *  - taux de paiement : OBSERVÉ sur les obligations échues des 365 derniers jours (donnée réelle, base jointe), ou,
 *    si le scénario choisi porte une hypothèse « taux de conformité cible » au registre des hypothèses, cette
 *    hypothèse (source, date, auteur) — jamais une valeur inventée ;
 *  - chaque prévision est FIGÉE avec ses hypothèses jointes (empreinte SHA-256) : l'écart prévision / réalisé se
 *    mesure ensuite semaine par semaine sur les paiements confirmés ;
 *  - la prévision ne fixe AUCUNE assignation (les assignations relèvent d'un acte budgétaire certifié).
 */
import { createHash } from 'node:crypto';
import { Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { kinshasaDay } from '../../core/clock.js';
import { canonicalJson } from '../../core/crypto.js';
import { notFound } from '../../core/errors.js';
import { authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { matchesDims } from '../pilotage/ladder.js';
import type { Hypothesis, ScenarioCode } from '../pilotage/planification/model.js';
import type { PlanificationService } from '../pilotage/planification/service.js';
import type { PilotageService, Query } from '../pilotage/service.js';
import { addDays, mondayOf, pctBig } from './common.js';

export interface ForecastRate { category: string; source: 'OBSERVE_365_JOURS' | 'HYPOTHESE'; ratePct: string | null; basis: { due: number; paid: number } | null; hypothesisId?: string; hypothesisSource?: string }
export interface ForecastLine { week: string; category: string; commune: string; obligations: number; due: MoneyJSON; expected: MoneyJSON }
export interface Forecast {
  id: string; createdAt: string; createdBy: string; scenario: ScenarioCode | null; weeks: number; firstWeek: string; lastWeek: string;
  filters: Record<string, unknown>; rates: ForecastRate[]; hypotheses: Hypothesis[]; lines: ForecastLine[]; sha256: string;
  assignation: 'AUCUNE'; notice: string;
}

export class PrevisionService {
  readonly forecasts = new InMemoryRepository<Forecast>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly pil: () => PilotageService, private readonly plan: () => PlanificationService | undefined) {}

  private now() { return this.ctx.clock.now().toISOString(); }

  /** Taux de paiement observé par catégorie (obligations échues des 365 derniers jours, payées / échues). */
  private observedRates(today: string, f: ReturnType<PilotageService['filtersFor']>['filters']) {
    const since = addDays(today, -365);
    const m = new Map<string, { due: number; paid: number }>();
    for (const o of this.pil().facts().obligations) {
      if (o.cancelled || o.contested || !matchesDims(o, f) || o.dueDate > today || o.dueDate < since) continue;
      const r = m.get(o.category) ?? { due: 0, paid: 0 };
      r.due++; if (o.paidAt) r.paid++;
      m.set(o.category, r);
    }
    return m;
  }

  generate(user: User, q: Query & { weeks?: number; scenario?: ScenarioCode }) {
    authorize(user, 'decision:prevision.write');
    const { filters, scope } = this.pil().filtersFor(user, q);
    const facts = this.pil().facts();
    const today = kinshasaDay(facts.asOf);
    const weeks = Math.max(1, Math.min(26, q.weeks ?? 8));
    const first = mondayOf(today);
    const last = addDays(first, weeks * 7 - 1);
    const observed = this.observedRates(today, filters);
    const hyps = q.scenario ? (this.plan()?.hypotheses.all() ?? []).filter((h) => h.status === 'EN_VIGUEUR' && h.scenario === q.scenario && h.variable === 'TAUX_CONFORMITE_CIBLE') : [];
    const open = facts.obligations.filter((o) => !o.cancelled && !o.contested && !o.paidAt && matchesDims(o, filters) && o.dueDate >= first && o.dueDate <= last);
    const categories = [...new Set([...open.map((o) => o.category), ...observed.keys()])].sort();
    const rates: ForecastRate[] = categories.map((category) => {
      const h = hyps.find((x) => x.revenue === category) ?? hyps.find((x) => x.revenue === '*');
      if (h) return { category, source: 'HYPOTHESE', ratePct: h.value, basis: observed.get(category) ?? null, hypothesisId: h.id, hypothesisSource: `${h.source} (${h.sourceDate})` };
      const b = observed.get(category);
      return { category, source: 'OBSERVE_365_JOURS', ratePct: b ? pctBig(BigInt(b.paid), BigInt(b.due)) : null, basis: b ?? null };
    });
    const rateOf = new Map(rates.map((r) => [r.category, r.ratePct]));
    const acc = new Map<string, { week: string; category: string; commune: string; currency: CurrencyCode; n: number; due: Money; expected: Money }>();
    for (const o of open) {
      const week = mondayOf(o.dueDate);
      const k = `${week}|${o.category}|${o.commune}|${o.amount.currency}`;
      const a = acc.get(k) ?? { week, category: o.category, commune: o.commune, currency: o.amount.currency, n: 0, due: Money.zero(o.amount.currency), expected: Money.zero(o.amount.currency) };
      const amt = Money.fromJSON(o.amount);
      const pct = rateOf.get(o.category);
      a.n++; a.due = a.due.add(amt); a.expected = a.expected.add(pct ? amt.percent(pct) : Money.zero(amt.currency));
      acc.set(k, a);
    }
    const lines: ForecastLine[] = [...acc.values()].sort((a, b) => a.week.localeCompare(b.week) || a.category.localeCompare(b.category) || a.commune.localeCompare(b.commune, 'fr'))
      .map((a) => ({ week: a.week, category: a.category, commune: a.commune, obligations: a.n, due: a.due.toJSON(), expected: a.expected.toJSON() }));
    const usedHyps = hyps.filter((h) => rates.some((r) => r.hypothesisId === h.id));
    const flt = { ...filters } as Record<string, unknown>;
    const content = { firstWeek: first, lastWeek: last, weeks, scenario: q.scenario ?? null, filters: flt, rates, hypotheses: usedHyps, lines };
    const f = this.forecasts.insert({
      id: this.ids.next('PREV'), createdAt: this.now(), createdBy: user.id, scenario: q.scenario ?? null, weeks, firstWeek: first, lastWeek: last, filters: flt, rates, hypotheses: usedHyps, lines,
      sha256: createHash('sha256').update(canonicalJson(content)).digest('hex'), assignation: 'AUCUNE',
      notice: 'Prévision non opposable, figée avec ses hypothèses (taux observés ou hypothèses du registre) ; elle ne fixe aucune assignation.',
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'decision.forecast.generated', resourceType: 'forecast', resourceId: f.id, details: { weeks, scenario: f.scenario, lines: lines.length, sha256: f.sha256 } });
    return { ...f, scope };
  }

  list(user: User) {
    authorize(user, 'decision:prevision.read');
    const items = this.forecasts.all().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const latestWithElapsed = items.find((f) => f.firstWeek < mondayOf(kinshasaDay(this.now())));
    const ind = latestWithElapsed ? this.gapOf(latestWithElapsed).totals : null;
    return {
      items: items.map(({ lines, ...rest }) => ({ ...rest, lineCount: lines.length })),
      indicator: ind && ind.expectedCdfMinor > 0n
        ? { code: 'ECART_PREVISION_REALISE', label: 'Réalisé / prévu (semaines écoulées)', measured: true, value: pctBig(ind.actualCdfMinor, ind.expectedCdfMinor), unit: '%', forecastId: latestWithElapsed!.id }
        : { code: 'ECART_PREVISION_REALISE', label: 'Réalisé / prévu (semaines écoulées)', measured: false, value: null, unit: '%', reason: 'Aucune prévision figée dont une semaine est déjà écoulée.' },
    };
  }

  get(user: User, id: string) {
    authorize(user, 'decision:prevision.read');
    const f = this.forecasts.get(id);
    if (!f) throw notFound('FORECAST_NOT_FOUND', `Prévision inconnue : ${id}`);
    return f;
  }

  /** Réalisé d'une semaine : paiements CONFIRMÉS dans la semaine, rattachés à la catégorie et à la commune. */
  private gapOf(f: Forecast) {
    const facts = this.pil().facts();
    const today = kinshasaDay(facts.asOf);
    const conv = (m: MoneyJSON) => { try { return m.currency === 'CDF' ? Money.fromJSON(m).minor : Money.fromJSON(this.ctx.fx.convert(m, 'CDF').amount).minor; } catch { return 0n; } };
    const actual = new Map<string, Money>();
    for (const o of facts.orders) {
      if (!o.confirmedAt || !['CONFIRME', 'REGLE', 'RAPPROCHE', 'CONTESTE'].includes(o.status)) continue;
      const k = `${mondayOf(kinshasaDay(o.confirmedAt))}|${o.category}|${o.commune}|${o.amount.currency}`;
      actual.set(k, (actual.get(k) ?? Money.zero(o.amount.currency)).add(Money.fromJSON(o.amount)));
    }
    let e = 0n; let a = 0n;
    const rows = f.lines.map((l) => {
      const elapsed = addDays(l.week, 6) < today;
      const act = actual.get(`${l.week}|${l.category}|${l.commune}|${l.expected.currency}`) ?? Money.zero(l.expected.currency);
      if (elapsed) { e += conv(l.expected); a += conv(act.toJSON()); }
      return { ...l, elapsed, actual: elapsed ? act.toJSON() : null, gap: elapsed ? act.subtract(Money.fromJSON(l.expected)).toJSON() : null, realisedPct: elapsed ? pctBig(act.minor, Money.fromJSON(l.expected).minor) : null };
    });
    return { rows, totals: { expectedCdfMinor: e, actualCdfMinor: a } };
  }

  gap(user: User, id: string) {
    const f = this.get(user, id);
    const g = this.gapOf(f);
    return {
      forecastId: f.id, sha256: f.sha256, hypotheses: f.hypotheses, rates: f.rates, rows: g.rows,
      totals: { expectedCdf: Money.fromMinor(g.totals.expectedCdfMinor, 'CDF').toJSON(), actualCdf: Money.fromMinor(g.totals.actualCdfMinor, 'CDF').toJSON(), realisedPct: pctBig(g.totals.actualCdfMinor, g.totals.expectedCdfMinor) },
      rule: 'Écart = réalisé (paiements confirmés de la semaine) − prévu ; mesuré seulement pour les semaines écoulées. Contre-valeur CDF indicative pour le total.',
    };
  }
}
