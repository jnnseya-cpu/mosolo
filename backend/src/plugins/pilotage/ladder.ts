/**
 * Échelle unifiée de la recette (§ 26.1, onze états — shared REVENUE_LADDER) calculée sur les données RÉELLES
 * du socle. Chaque niveau est un stock « ayant atteint au moins ce stade » : les niveaux sont emboîtés et ne
 * s'additionnent JAMAIS. Le contesté est un indicateur séparé, hors échelle.
 */
import { REVENUE_LADDER, UNATTRIBUTED_COMMUNE, type MoneyJSON, type RevenueLadderLevel } from '@mosolo/shared';
import { badRequest } from '../../core/errors.js';
import type { Facts, ObligationFact, OrderFact, RecordedFact } from './facts.js';
import { CurrencyTotals } from './money.js';

export interface Filters {
  commune?: string;
  category?: string;
  entity?: string;
  channel?: string;
  /** Bornes incluses, AAAA-MM-JJ. */
  from?: string;
  to?: string;
  /** Libellé de la période demandée (AAAA, AAAA-Tn, AAAA-MM). */
  period?: string;
  /** Restriction de périmètre (ABAC territoire) : communes autorisées. */
  communes?: string[];
}

export const LEVEL_LABELS: Record<RevenueLadderLevel, string> = {
  potential: 'Potentiel estimé',
  verified_base: 'Assiette vérifiée',
  assessed: 'Liquidé (constaté)',
  due: 'Exigible (échu)',
  overdue: 'En retard (impayé)',
  initiated: 'Paiement initié',
  confirmed: 'Paiement confirmé',
  settled: 'Réglé en compte public',
  reconciled: 'Rapproché',
  recorded: 'Comptabilisé',
  available: 'Disponible pour affectation',
};

export const LEVEL_DEFINITIONS: Record<RevenueLadderLevel, string> = {
  potential: 'Montant théorique issu du modèle de potentiel (§ 38.2) — estimation statistique, non opposable.',
  verified_base: 'Objets et bases vérifiés, sans liquidation encore.',
  assessed: 'Obligations calculées sur une règle publiée (hors obligations annulées ou remplacées par rectification).',
  due: 'Obligations dont l’échéance est atteinte, hors obligations contestées.',
  overdue: 'Obligations exigibles sans paiement confirmé.',
  initiated: 'Références de paiement créées, en attente de confirmation (en cours).',
  confirmed: 'Paiements confirmés serveur à serveur par le prestataire (inclut les stades suivants).',
  settled: 'Fonds constatés sur le compte public désigné (inclut le rapproché).',
  reconciled: 'Appariement obligation – paiement – relevé du compte public réalisé.',
  recorded: 'Écriture du grand livre imputée au compte public de recettes, non contrepassée.',
  available: 'Fonds disponibles selon le budget voté et les règles de trésorerie.',
};

export type Measure = 'MONTANT' | 'COMPTE' | 'NON_MESURE';

export interface LadderLevelView {
  rank: number;
  level: RevenueLadderLevel;
  label: string;
  definition: string;
  measure: Measure;
  measured: boolean;
  /** Montants par devise légale (vide si non mesuré). */
  amounts: MoneyJSON[];
  /** Contre-valeur INDICATIVE consolidée en CDF. */
  consolidatedCdf: MoneyJSON | null;
  count: number | null;
  source: string;
  dateBasis: string;
  channelFilterApplies: boolean;
  note?: string;
}

const PERIOD_RE = /^(\d{4})(?:-(0[1-9]|1[0-2])|-T([1-4])|-Q([1-4]))?$/;

/** AAAA | AAAA-MM | AAAA-Tn (ou AAAA-Qn) → bornes incluses. */
export function periodRange(period: string): { from: string; to: string } {
  const m = PERIOD_RE.exec(period);
  if (!m) throw badRequest('INVALID_PERIOD', `Période invalide : ${period} (AAAA, AAAA-MM ou AAAA-Tn attendu).`);
  const year = Number(m[1]);
  const lastDay = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const iso = (y: number, mo: number, d: number) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (m[2]) {
    const mo = Number(m[2]);
    return { from: iso(year, mo, 1), to: iso(year, mo, lastDay(year, mo)) };
  }
  const q = m[3] ?? m[4];
  if (q) {
    const start = (Number(q) - 1) * 3 + 1;
    return { from: iso(year, start, 1), to: iso(year, start + 2, lastDay(year, start + 2)) };
  }
  return { from: iso(year, 1, 1), to: iso(year, 12, 31) };
}

export function quarterOf(date: string): string {
  const y = date.slice(0, 4);
  const q = Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1;
  return `${y}-T${q}`;
}

export function inPeriod(ts: string | undefined, f: Filters): boolean {
  if (!ts) return false;
  const d = ts.slice(0, 10);
  if (f.from && d < f.from) return false;
  if (f.to && d > f.to) return false;
  return true;
}

type Dim = { commune: string; category: string; entity: string };
const communeMatch = (f: Filters, c: string) => !f.commune || f.commune === c || (f.commune === UNATTRIBUTED_COMMUNE && c === UNATTRIBUTED_COMMUNE);
export function matchesDims(x: Dim, f: Filters): boolean {
  return communeMatch(f, x.commune) && (!f.communes || f.communes.includes(x.commune)) && (!f.category || f.category === x.category) && (!f.entity || f.entity === x.entity);
}
export const matchesChannel = (x: { channel: string }, f: Filters) => !f.channel || f.channel === x.channel;

/** Obligations « vivantes » (non annulées, non remplacées). */
export const liveObligations = (facts: Facts) => facts.obligations.filter((o) => !o.cancelled);
export const isDue = (o: ObligationFact, asOf: string) => !o.cancelled && !o.contested && o.dueDate <= asOf.slice(0, 10);
export const isOverdue = (o: ObligationFact, asOf: string) => isDue(o, asOf) && !o.paidAt && o.status !== 'SOLDEE';
export const isConfirmed = (o: OrderFact) => !!o.confirmedAt && ['CONFIRME', 'REGLE', 'RAPPROCHE', 'CONTESTE'].includes(o.status);
export const isSettled = (o: OrderFact) => !!o.settledAt && (o.status === 'REGLE' || o.status === 'RAPPROCHE' || o.status === 'CONTESTE');
export const isReconciled = (o: OrderFact) => o.status === 'RAPPROCHE' && !!o.reconciledAt;
export const isInitiated = (o: OrderFact, asOf: string) => o.status === 'INITIE' && o.expiresAt > asOf;

export interface LevelSelection {
  obligations?: ObligationFact[];
  orders?: OrderFact[];
  recorded?: RecordedFact[];
}

/** Sélection des faits de chaque niveau mesurable, filtres appliqués. */
export function selectLevel(level: RevenueLadderLevel, facts: Facts, f: Filters): LevelSelection | null {
  const asOf = facts.asOf;
  const obs = facts.obligations.filter((o) => matchesDims(o, f));
  const ords = facts.orders.filter((o) => matchesDims(o, f) && matchesChannel(o, f));
  switch (level) {
    case 'assessed':
      return { obligations: obs.filter((o) => !o.cancelled && inPeriodOrAll(o.createdAt, f)) };
    case 'due':
      return { obligations: obs.filter((o) => isDue(o, asOf) && inPeriodOrAll(o.dueDate, f)) };
    case 'overdue':
      return { obligations: obs.filter((o) => isOverdue(o, asOf) && inPeriodOrAll(o.dueDate, f)) };
    case 'initiated':
      return { orders: ords.filter((o) => isInitiated(o, asOf) && inPeriodOrAll(o.createdAt, f)) };
    case 'confirmed':
      return { orders: ords.filter((o) => isConfirmed(o) && inPeriodOrAll(o.confirmedAt, f)) };
    case 'settled':
      return { orders: ords.filter((o) => isSettled(o) && inPeriodOrAll(o.settledAt, f)) };
    case 'reconciled':
      return { orders: ords.filter((o) => isReconciled(o) && inPeriodOrAll(o.reconciledAt, f)) };
    case 'recorded':
      return { recorded: facts.recorded.filter((r) => matchesDims(r, f) && matchesChannel(r, f) && inPeriodOrAll(r.at, f)) };
    default:
      return null;
  }
}

function inPeriodOrAll(ts: string | undefined, f: Filters): boolean {
  if (!f.from && !f.to) return ts !== undefined;
  return inPeriod(ts, f);
}

export function selectionTotals(sel: LevelSelection): { totals: CurrencyTotals; count: number; taxpayers: Set<string> } {
  const totals = new CurrencyTotals();
  const taxpayers = new Set<string>();
  let count = 0;
  for (const o of sel.obligations ?? []) { totals.add(o.amount); taxpayers.add(o.taxpayerId); count++; }
  for (const o of sel.orders ?? []) { totals.add(o.amount); taxpayers.add(o.taxpayerId); count++; }
  for (const r of sel.recorded ?? []) { totals.add(r.amount); taxpayers.add(r.taxpayerId); count++; }
  return { totals, count, taxpayers };
}

const SOURCES: Record<RevenueLadderLevel, { source: string; dateBasis: string; channel: boolean }> = {
  potential: { source: 'Modèle de potentiel (§ 38.2) — non disponible', dateBasis: '—', channel: false },
  verified_base: { source: 'Registre des objets fiscaux (statut VALIDE)', dateBasis: 'Date de recensement', channel: false },
  assessed: { source: 'Obligations (liquidation)', dateBasis: 'Date d’émission', channel: false },
  due: { source: 'Obligations (échéance)', dateBasis: 'Date d’échéance', channel: false },
  overdue: { source: 'Obligations × paiements confirmés', dateBasis: 'Date d’échéance', channel: false },
  initiated: { source: 'Ordres de paiement (INITIE, non expirés)', dateBasis: 'Date de création de la référence', channel: true },
  confirmed: { source: 'Ordres de paiement confirmés par rappel prestataire signé', dateBasis: 'Date de confirmation', channel: true },
  settled: { source: 'Ordres de paiement réglés (crédit du relevé du compte public)', dateBasis: 'Date de règlement', channel: true },
  reconciled: { source: 'Rapprochements (relevé importé par le Trésor)', dateBasis: 'Date de rapprochement', channel: true },
  recorded: { source: 'Grand livre — écritures SETTLEMENT_CREDITED non contrepassées', dateBasis: 'Date d’écriture', channel: true },
  available: { source: 'Budget voté et règles de trésorerie — non intégrés', dateBasis: '—', channel: false },
};

export interface LadderContext {
  facts: Facts;
  filters: Filters;
  convert: (m: MoneyJSON) => MoneyJSON;
  /** Objets vérifiés (niveau 2), filtre commune appliqué par l'appelant. */
  verifiedObjects: number;
}

export function computeLadder(c: LadderContext): LadderLevelView[] {
  return REVENUE_LADDER.map((level, i) => {
    const meta = SOURCES[level];
    const base = {
      rank: i + 1, level, label: LEVEL_LABELS[level], definition: LEVEL_DEFINITIONS[level], source: meta.source,
      dateBasis: meta.dateBasis, channelFilterApplies: meta.channel,
    };
    if (level === 'potential' || level === 'available') {
      return {
        ...base, measure: 'NON_MESURE' as const, measured: false, amounts: [], consolidatedCdf: null, count: null,
        note: level === 'potential'
          ? 'Non mesuré : relève d’un modèle statistique (§ 38.2) non encore calibré sur une base de référence vérifiée.'
          : 'Non mesuré : la mise à disposition dépend du budget voté et des règles du Trésor, non intégrés à la plateforme.',
      };
    }
    if (level === 'verified_base') {
      return {
        ...base, measure: 'COMPTE' as const, measured: true, amounts: [], consolidatedCdf: null, count: c.verifiedObjects,
        note: 'Compté en objets vérifiés ; la valorisation monétaire de l’assiette n’est pas mesurée (modèle).',
      };
    }
    const sel = selectLevel(level, c.facts, c.filters)!;
    const { totals, count } = selectionTotals(sel);
    return {
      ...base, measure: 'MONTANT' as const, measured: true, amounts: totals.toJSON(),
      consolidatedCdf: totals.consolidated(c.convert), count,
      ...(level === 'initiated' ? { note: 'Stock en cours (non encore confirmé) : n’inclut pas les stades suivants.' } : {}),
      ...(level === 'overdue' ? { note: 'Sous-ensemble de l’exigible.' } : {}),
    };
  });
}

/** Indicateur séparé, hors échelle : obligations sous réclamation. */
export function contestedIndicator(facts: Facts, f: Filters, convert: (m: MoneyJSON) => MoneyJSON) {
  const obs = facts.obligations.filter((o) => o.contested && matchesDims(o, f));
  const totals = new CurrencyTotals();
  obs.forEach((o) => totals.add(o.amount));
  return {
    code: 'contested',
    label: 'Obligations contestées',
    separate: true,
    note: 'Indicateur séparé, hors échelle : une obligation contestée sort de l’exigible tant que la réclamation n’est pas décidée.',
    count: obs.length,
    amounts: totals.toJSON(),
    consolidatedCdf: totals.consolidated(convert),
  };
}

export const DRILL_DIMENSIONS = ['commune', 'category', 'entity', 'channel', 'month'] as const;
export type DrillDimension = (typeof DRILL_DIMENSIONS)[number];
const DRILL_LEVELS: RevenueLadderLevel[] = ['assessed', 'due', 'overdue', 'initiated', 'confirmed', 'settled', 'reconciled', 'recorded'];

/** Consultation détaillée (drill-down) : valeurs de chaque niveau mesurable par dimension. */
export function drill(dimension: DrillDimension, c: LadderContext) {
  const keyOf = (x: { commune?: string; category?: string; entity?: string; channel?: string }, ts?: string): string | undefined => {
    switch (dimension) {
      case 'commune': return x.commune;
      case 'category': return x.category;
      case 'entity': return x.entity;
      case 'channel': return x.channel;
      case 'month': return ts?.slice(0, 7);
    }
  };
  const rows = new Map<string, Map<RevenueLadderLevel, { totals: CurrencyTotals; count: number }>>();
  const bump = (key: string | undefined, level: RevenueLadderLevel, amount: MoneyJSON) => {
    if (!key) return;
    const row = rows.get(key) ?? new Map();
    const cell = row.get(level) ?? { totals: new CurrencyTotals(), count: 0 };
    cell.totals.add(amount);
    cell.count++;
    row.set(level, cell);
    rows.set(key, row);
  };
  for (const level of DRILL_LEVELS) {
    if (dimension === 'channel' && !SOURCES[level].channel) continue;
    const sel = selectLevel(level, c.facts, c.filters)!;
    const dateOf = (o: OrderFact) => (level === 'initiated' ? o.createdAt : level === 'confirmed' ? o.confirmedAt : level === 'settled' ? o.settledAt : o.reconciledAt);
    for (const o of sel.obligations ?? []) bump(keyOf(o, level === 'assessed' ? o.createdAt : o.dueDate), level, o.amount);
    for (const o of sel.orders ?? []) bump(keyOf(o, dateOf(o)), level, o.amount);
    for (const r of sel.recorded ?? []) bump(keyOf(r, r.at), level, r.amount);
  }
  const levels = dimension === 'channel' ? DRILL_LEVELS.filter((l) => SOURCES[l].channel) : DRILL_LEVELS;
  return {
    dimension,
    levels: levels.map((l) => ({ level: l, label: LEVEL_LABELS[l] })),
    rule: 'Chaque colonne est un niveau distinct de l’échelle : ne jamais additionner les colonnes.',
    rows: [...rows.entries()]
      .map(([key, m]) => ({
        key,
        values: Object.fromEntries(levels.map((l) => {
          const cell = m.get(l);
          return [l, cell ? { amounts: cell.totals.toJSON(), consolidatedCdf: cell.totals.consolidated(c.convert), count: cell.count } : { amounts: [], consolidatedCdf: { amount: '0.00', currency: 'CDF' }, count: 0 }];
        })),
      }))
      .sort((a, b) => (a.key === UNATTRIBUTED_COMMUNE ? 1 : b.key === UNATTRIBUTED_COMMUNE ? -1 : a.key.localeCompare(b.key, 'fr'))),
  };
}

/** Série mensuelle réelle (confirmé, rapproché) sur les N derniers mois. */
export function monthlySeries(c: LadderContext, months = 12) {
  const end = new Date(c.facts.asOf);
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
    keys.push(d.toISOString().slice(0, 7));
  }
  const f = { ...c.filters };
  delete f.from; delete f.to; delete f.period;
  const confirmed = selectLevel('confirmed', c.facts, f)!.orders!;
  const reconciled = selectLevel('reconciled', c.facts, f)!.orders!;
  const assessed = selectLevel('assessed', c.facts, f)!.obligations!;
  return keys.map((month) => {
    const conf = new CurrencyTotals(); const rec = new CurrencyTotals(); const ass = new CurrencyTotals();
    confirmed.filter((o) => o.confirmedAt!.startsWith(month)).forEach((o) => conf.add(o.amount));
    reconciled.filter((o) => o.reconciledAt!.startsWith(month)).forEach((o) => rec.add(o.amount));
    assessed.filter((o) => o.createdAt.startsWith(month)).forEach((o) => ass.add(o.amount));
    return {
      month,
      assessed: { amounts: ass.toJSON(), consolidatedCdf: ass.consolidated(c.convert) },
      confirmed: { amounts: conf.toJSON(), consolidatedCdf: conf.consolidated(c.convert) },
      reconciled: { amounts: rec.toJSON(), consolidatedCdf: rec.consolidated(c.convert) },
    };
  });
}
