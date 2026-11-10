/**
 * Normalisation tolérante des réponses de l'API vers les modèles d'affichage.
 * Le contrat (specs/contrat-api.md) fixe les routes ; les noms de champs varient
 * encore entre versions du backend : on accepte les variantes connues.
 */
import { CHANNELS, isCurrencyCode, type AIRecommendation, type Channel, type MoneyJSON } from '@mosolo/shared';
import type { StatusTone } from './palette';
import type { CommunicationsOverview, Delivery } from './types';

type O = Record<string, unknown>;
const obj = (v: unknown): O => (v && typeof v === 'object' ? (v as O) : {});
const arr = (v: unknown): O[] => (Array.isArray(v) ? (v as O[]) : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);
const num = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
};

export function asMoney(v: unknown): MoneyJSON | undefined {
  const o = obj(v);
  if (typeof o.amount === 'string' && typeof o.currency === 'string' && isCurrencyCode(o.currency)) return { amount: o.amount, currency: o.currency };
  if (o.amount && typeof o.amount === 'object') return asMoney(o.amount); // FxConversion { amount: MoneyJSON, rate, … }
  return undefined;
}
const moneyNum = (m: MoneyJSON | undefined) => (m ? Number(m.amount) : 0);
const pick = (o: O, ...keys: string[]) => { for (const k of keys) if (o[k] !== undefined) return o[k]; return undefined; };

export function severityTone(s: unknown): StatusTone {
  const v = String(s ?? '').toLowerCase();
  if (v === 'critical' || v === 'critique') return 'critical';
  if (v === 'high' || v === 'serious' || v === 'elevee' || v === 'élevée') return 'serious';
  if (v === 'medium' || v === 'warning' || v === 'moyenne') return 'warning';
  return 'good';
}

export interface GovView {
  example: boolean;
  asOf?: string;
  tiles: { confirmedToday?: MoneyJSON; settled?: MoneyJSON; reconciled?: MoneyJSON; reconRate?: number; reconTarget: number; criticalAlerts: number; delta?: string };
  communes: { name: string; amount: MoneyJSON; compliance?: number }[];
  categories: { name: string; amount: MoneyJSON }[];
  ladder: { level: string; amount: MoneyJSON }[];
  /** Cumuls en unités de CDF */
  trend: { label: string; actual: number; target: number }[];
  scenarioNames: string[];
  /** Série « réalisé » puis projections par scénario (cumul, CDF) */
  scenarios: ({ label: string; actual?: number } & Record<string, number | string | undefined>)[];
  alerts: { id: string; severity: StatusTone; title: string; detail?: string; age?: string }[];
  actions: AIRecommendation[];
  exchange?: { rate: string; date: string; source?: string };
}

const MONTHS_FR = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
function monthLabel(v: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(v);
  if (!m) return v;
  return `${MONTHS_FR[Number(m[2]) - 1] ?? m[2]} ${m[1]!.slice(2)}`;
}

export function normalizeGovernor(raw: unknown): GovView {
  const r = obj(raw);
  const t = obj(r.tiles);
  const alertsRaw = arr(pick(r, 'alerts', 'criticalAlerts'));
  const alerts = alertsRaw.map((a, i) => ({
    id: str(a.id) ?? `al-${i}`, severity: severityTone(a.severity), title: str(pick(a, 'title', 'type')) ?? '—',
    detail: str(pick(a, 'detail', 'description')), age: str(a.age),
  }));
  const communes = arr(pick(r, 'communes', 'byCommune')).map((c) => ({
    name: str(pick(c, 'commune', 'name')) ?? '—',
    amount: asMoney(pick(c, 'amount', 'collected', 'confirmed')) ?? { amount: '0', currency: 'CDF' as const },
    compliance: num(pick(c, 'compliance', 'complianceRate')),
  }));
  const categories = arr(pick(r, 'categories', 'byCategory')).map((c) => ({
    name: str(pick(c, 'category', 'label', 'name')) ?? '—',
    amount: asMoney(pick(c, 'amount', 'collected')) ?? { amount: '0', currency: 'CDF' as const },
  }));
  const ladder = arr(r.ladder).map((l) => ({ level: str(l.level) ?? '', amount: asMoney(l.amount) ?? { amount: '0', currency: 'CDF' as const } }));

  // Tendance : cumul réalisé vs cumul cible
  let accA = 0, accT = 0;
  const trend = arr(r.trend).map((p) => {
    const a = asMoney(pick(p, 'collected', 'actual')); const tg = asMoney(p.target);
    const av = a ? moneyNum(a) : (num(p.actual) ?? 0) * 1e9;
    const tv = tg ? moneyNum(tg) : (num(p.target) ?? 0) * 1e9;
    const cumulative = p.cumulative === true || (!a && num(p.actual) !== undefined);
    accA = cumulative ? av : accA + av; accT = cumulative ? tv : accT + tv;
    return { label: p.month ? monthLabel(String(p.month)) : String(pick(p, 'day', 'label', 'period') ?? ''), actual: accA, target: accT };
  });

  // Scénarios : soit séries mensuelles, soit valeurs de fin d'exercice
  const scRaw = arr(r.scenarios);
  let scenarioNames: string[] = [];
  let scenarios: GovView['scenarios'] = [];
  if (scRaw.length && pick(scRaw[0]!, 'yearEnd') !== undefined) {
    scenarioNames = scRaw.map((s) => str(pick(s, 'label', 'code')) ?? '—');
    const last = trend[trend.length - 1];
    const start = last?.actual ?? 0;
    const pts = trend.slice(-4).map((p) => ({ label: p.label, actual: p.actual } as GovView['scenarios'][number]));
    if (pts.length) scenarioNames.forEach((_, i) => { pts[pts.length - 1]![`s${i}`] = start; });
    const steps = [0.34, 0.67, 1];
    const labels = ['T+1', 'T+2', 'Fin d’exercice'];
    steps.forEach((k, j) => {
      const row: GovView['scenarios'][number] = { label: labels[j]! };
      scRaw.forEach((s, i) => { const y = moneyNum(asMoney(s.yearEnd)); row[`s${i}`] = start + (y - start) * k; });
      pts.push(row);
    });
    scenarios = pts;
  } else if (scRaw.length) {
    scenarioNames = ['Central', 'Pessimiste', 'Optimiste'];
    scenarios = scRaw.map((s) => ({
      label: String(pick(s, 'period', 'label') ?? ''),
      s0: (num(s.central) ?? 0) * 1e9, s1: (num(s.pessimistic) ?? 0) * 1e9, s2: (num(s.optimistic) ?? 0) * 1e9,
    }));
  }

  const exchange = obj(r.exchange);
  return {
    example: r.example !== false,
    asOf: str(pick(r, 'asOf', 'generatedAt', 'date')),
    tiles: {
      confirmedToday: asMoney(t.confirmedToday),
      settled: asMoney(pick(t, 'settled', 'settledToday')),
      reconciled: asMoney(pick(t, 'reconciled', 'reconciledToday')),
      reconRate: num(pick(t, 'reconciliationRate', 'reconRateJ1', 'reconRate')),
      reconTarget: num(t.reconTarget) ?? 95,
      criticalAlerts: num(t.criticalAlerts) ?? alerts.filter((a) => a.severity === 'critical').length,
      delta: str(pick(t, 'confirmedDelta', 'comparisonDMinus1')),
    },
    communes, categories, ladder, trend, scenarioNames, scenarios, alerts,
    // Conversion justifiée : recommandations déjà normalisées côté serveur ; tableau garanti par arr().
    actions: arr(r.actions) as unknown as AIRecommendation[],
    exchange: exchange.rate ? { rate: String(exchange.rate), date: String(exchange.date ?? ''), source: str(exchange.source) } : undefined,
  };
}

export function normalizeComms(raw: unknown, fallback: CommunicationsOverview): CommunicationsOverview {
  const r = obj(raw);
  const cat = obj(r.catalogue);
  const del = obj(r.delivered);
  const channelsArr = arr(r.channels);
  const covRaw = r.coverage;
  const coverage = CHANNELS.map((c: Channel) => {
    const fromArr = Array.isArray(covRaw) ? arr(covRaw).find((x) => x.channel === c) : undefined;
    const fromRec = !Array.isArray(covRaw) ? num(obj(covRaw)[c]) : undefined;
    const ch = channelsArr.find((x) => x.channel === c);
    return {
      channel: c,
      events: num(fromArr?.events) ?? fromRec ?? num(ch?.defaultEvents) ?? 0,
      sent: num(fromArr?.sent) ?? num(ch?.sent) ?? 0,
    };
  });
  const wired = channelsArr.length ? channelsArr.filter((c) => c.wired === true).map((c) => String(c.channel)) : undefined;
  const recent: Delivery[] = arr(r.recent).map((d, i) => ({
    id: str(d.id) ?? `d-${i}`, eventCode: str(d.eventCode) ?? '—', channel: str(d.channel) ?? '—', status: str(d.status) ?? 'en_file',
    provider: str(d.provider), at: str(pick(d, 'at', 'createdAt')), recipient: str(pick(d, 'recipientMasked', 'recipient')), entity: str(d.entity),
  }));
  return {
    example: r.example === true,
    catalogue: {
      events: num(r.catalogue) ?? num(cat.events) ?? fallback.catalogue.events,
      categories: num(r.categories) ?? num(cat.categories) ?? fallback.catalogue.categories,
      mandatory: num(r.mandatory) ?? num(cat.mandatory) ?? fallback.catalogue.mandatory,
    },
    delivered: {
      delivered: num(r.delivered) ?? num(del.delivered) ?? 0,
      attempted: num(r.attempted) ?? num(del.attempted) ?? 0,
    },
    connectedChannels: wired ?? (Array.isArray(r.connectedChannels) ? (r.connectedChannels as string[]) : num(r.channelsWired) ?? num(r.connectedChannels) ?? 0),
    coverage,
    recent,
  };
}

export function normalizeDeliveries(raw: unknown): Delivery[] {
  return normalizeComms({ recent: Array.isArray(raw) ? raw : obj(raw).deliveries ?? obj(raw).items ?? [] }, {
    catalogue: { events: 0, categories: 0, mandatory: 0 }, delivered: { delivered: 0, attempted: 0 }, connectedChannels: 0, coverage: [], recent: [],
  }).recent;
}
