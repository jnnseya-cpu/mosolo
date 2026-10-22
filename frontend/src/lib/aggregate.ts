/**
 * Agrégations pures pour les graphiques (trousse de visualisation, 27/09/2026).
 *
 * Elles permettent de dériver un graphique d'un point d'accès « liste » existant, sans modifier le serveur.
 * Règles tenues ici, une fois pour toutes :
 *  - les montants restent en MoneyJSON et sont additionnés EXACTEMENT, devise par devise (jamais de mélange CDF / USD) ;
 *  - une contre-valeur n'est produite qu'avec un taux fourni et affiché (date, source) — jamais un taux inventé ;
 *  - les jours, semaines et mois sont ceux de Kinshasa (UTC+1, sans heure d'été) ;
 *  - « Autres » regroupe la traîne au-delà du rang N, sans créer de couleur supplémentaire.
 * Les nombres rendus (`plot`) ne servent qu'à la géométrie des graphiques, jamais à un calcul financier.
 */
import { Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';

type KeyOf<T> = keyof T | ((item: T) => string | null | undefined);

function keyFn<T>(k: KeyOf<T>): (item: T) => string {
  if (typeof k === 'function') return (i) => { const v = k(i); return v === null || v === undefined || v === '' ? NON_RENSEIGNE : String(v); };
  return (i) => { const v = i[k]; return v === null || v === undefined || v === '' ? NON_RENSEIGNE : String(v); };
}

/** Libellé des éléments sans valeur pour la clé de regroupement. */
export const NON_RENSEIGNE = 'Non renseigné';
/** Libellé du regroupement de la traîne. */
export const AUTRES = 'Autres';

// ————————————————————————— comptages —————————————————————————

export interface CountRow { key: string; count: number }

/** Nombre d'éléments par valeur du champ (ou de la fonction) ; tri décroissant, puis alphabétique (fr). */
export function countBy<T>(items: readonly T[], key: KeyOf<T>): CountRow[] {
  const f = keyFn(key);
  const m = new Map<string, number>();
  for (const i of items) { const k = f(i); m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m].map(([k, count]) => ({ key: k, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key, 'fr'));
}

// ————————————————————————— montants par devise —————————————————————————

/** Totaux exacts par devise ; jamais additionnés entre devises. */
export type MoneyTotals = Partial<Record<CurrencyCode, MoneyJSON>>;

function toMoney(m: MoneyJSON): Money | null {
  try { return Money.fromJSON(m); } catch { return null; }
}

/** Additionne une liste de montants, devise par devise (les montants illisibles sont ignorés et comptés à part). */
export function sumMoney(amounts: readonly (MoneyJSON | null | undefined)[]): { totals: MoneyTotals; ignored: number } {
  const acc = new Map<CurrencyCode, Money>();
  let ignored = 0;
  for (const a of amounts) {
    if (!a) continue;
    const m = toMoney(a);
    if (!m) { ignored += 1; continue; }
    const prev = acc.get(m.currency);
    acc.set(m.currency, prev ? prev.add(m) : m);
  }
  const totals: MoneyTotals = {};
  for (const [c, m] of acc) totals[c] = m.toJSON();
  return { totals, ignored };
}

export interface SumRow { key: string; count: number; totals: MoneyTotals }

/**
 * Totaux par valeur du champ, devise par devise. `amount` est le champ MoneyJSON (ou une fonction).
 * Tri : nombre d'éléments décroissant (les devises ne sont pas comparables entre elles).
 */
export function sumBy<T>(items: readonly T[], key: KeyOf<T>, amount: keyof T | ((item: T) => MoneyJSON | null | undefined)): SumRow[] {
  const f = keyFn(key);
  const a = typeof amount === 'function' ? amount : (i: T) => i[amount] as unknown as MoneyJSON | null | undefined;
  const groups = new Map<string, T[]>();
  for (const i of items) { const k = f(i); const g = groups.get(k); if (g) g.push(i); else groups.set(k, [i]); }
  return [...groups].map(([k, g]) => ({ key: k, count: g.length, totals: sumMoney(g.map(a)).totals }))
    .sort((x, y) => y.count - x.count || x.key.localeCompare(y.key, 'fr'));
}

/** Devises présentes dans des totaux, CDF d'abord (monnaie légale), puis ordre alphabétique. */
export function currenciesOf(rows: readonly { totals: MoneyTotals }[] | MoneyTotals): CurrencyCode[] {
  const set = new Set<CurrencyCode>();
  const list = Array.isArray(rows) ? rows as readonly { totals: MoneyTotals }[] : [{ totals: rows as MoneyTotals }];
  for (const r of list) for (const c of Object.keys(r.totals) as CurrencyCode[]) set.add(c);
  return [...set].sort((a, b) => (a === 'CDF' ? -1 : b === 'CDF' ? 1 : a.localeCompare(b)));
}

/**
 * Sépare des lignes à totaux multi-devises en une série par devise (valeur numérique pour la géométrie seulement).
 * Usage : un graphique (ou une série) par devise — jamais une barre qui additionne CDF et USD.
 */
export function splitByCurrency(rows: readonly SumRow[]): Partial<Record<CurrencyCode, { key: string; value: number; money: MoneyJSON }[]>> {
  const out: Partial<Record<CurrencyCode, { key: string; value: number; money: MoneyJSON }[]>> = {};
  for (const c of currenciesOf(rows)) {
    out[c] = rows.filter((r) => r.totals[c]).map((r) => ({ key: r.key, value: Number(r.totals[c]!.amount), money: r.totals[c]! }));
  }
  return out;
}

/** Taux affiché : CDF pour une unité de devise, avec sa date et sa source (obligatoires). */
export interface DisplayedRate { currency: CurrencyCode; cdfPerUnit: string; date: string; source: string }

/**
 * Contre-valeur indicative en CDF de totaux multi-devises, calculée avec les taux FOURNIS et renvoyés pour affichage.
 * Si une devise n'a pas de taux, `missing` la nomme et la contre-valeur est `null` (pas de taux inventé).
 */
export function convertTotalsToCdf(totals: MoneyTotals, rates: readonly DisplayedRate[]): { cdf: MoneyJSON | null; used: DisplayedRate[]; missing: CurrencyCode[] } {
  let acc = Money.zero('CDF');
  const used: DisplayedRate[] = [];
  const missing: CurrencyCode[] = [];
  for (const c of currenciesOf(totals)) {
    const m = toMoney(totals[c]!);
    if (!m) continue;
    if (c === 'CDF') { acc = acc.add(m); continue; }
    const r = rates.find((x) => x.currency === c);
    if (!r) { missing.push(c); continue; }
    acc = acc.add(m.convert('CDF', r.cdfPerUnit));
    used.push(r);
  }
  return { cdf: missing.length ? null : acc.toJSON(), used, missing };
}

/** Libellé du taux utilisé, à afficher sous toute contre-valeur. */
export function rateLabel(r: DisplayedRate): string {
  return `1 ${r.currency} = ${Number(r.cdfPerUnit).toLocaleString('fr-FR')} CDF (${r.date}, ${r.source})`;
}

// ————————————————————————— temps de Kinshasa —————————————————————————

/** Décalage de Kinshasa (Africa/Kinshasa, WAT) : UTC+1 toute l'année. */
export const KINSHASA_OFFSET_MS = 3600_000;
export type Granularity = 'day' | 'week' | 'month';

function kinDate(iso: string | Date): Date | null {
  if (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso)) return new Date(`${iso}T00:00:00.000Z`); // déjà un jour de Kinshasa
  const t = typeof iso === 'string' ? Date.parse(iso) : iso.getTime();
  return Number.isNaN(t) ? null : new Date(t + KINSHASA_OFFSET_MS);
}

/** Jour de Kinshasa « AAAA-MM-JJ » d'un instant (ISO) ; une date seule est prise telle quelle. */
export function kinshasaDay(iso: string | Date): string | null {
  const d = kinDate(iso);
  return d ? d.toISOString().slice(0, 10) : null;
}

/** Mois de Kinshasa « AAAA-MM ». */
export function kinshasaMonth(iso: string | Date): string | null {
  const d = kinshasaDay(iso);
  return d ? d.slice(0, 7) : null;
}

/** Semaine ISO 8601 de Kinshasa « AAAA-Sss » (lundi → dimanche). */
export function kinshasaWeek(iso: string | Date): string | null {
  const day = kinshasaDay(iso);
  if (!day) return null;
  const d = new Date(`${day}T00:00:00.000Z`);
  const dow = (d.getUTCDay() + 6) % 7; // lundi = 0
  d.setUTCDate(d.getUTCDate() - dow + 3); // jeudi de la semaine
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-S${String(week).padStart(2, '0')}`;
}

export function periodKey(iso: string | Date, g: Granularity): string | null {
  return g === 'day' ? kinshasaDay(iso) : g === 'week' ? kinshasaWeek(iso) : kinshasaMonth(iso);
}

/** Lundi (jour de Kinshasa) d'une clé de semaine « AAAA-Sss ». */
function mondayOf(weekKey: string): string {
  const [y, w] = weekKey.split('-S').map(Number) as [number, number];
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const monday1 = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000);
  return new Date(monday1.getTime() + (w - 1) * 7 * 86400000).toISOString().slice(0, 10);
}

/** Période suivante (même granularité). */
export function nextPeriod(key: string, g: Granularity): string {
  if (g === 'month') {
    const [y, m] = key.split('-').map(Number) as [number, number];
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }
  const start = g === 'week' ? mondayOf(key) : key;
  const d = new Date(`${start}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + (g === 'week' ? 7 : 1));
  return g === 'week' ? kinshasaWeek(d.toISOString().slice(0, 10))! : d.toISOString().slice(0, 10);
}

/** Toutes les périodes de `from` à `to` inclus (clés de même granularité). */
export function periodRange(from: string, to: string, g: Granularity, max = 1000): string[] {
  const out: string[] = [];
  let k = from;
  while (k <= to && out.length < max) { out.push(k); k = nextPeriod(k, g); }
  return out;
}

export interface PeriodGroup<T> { period: string; items: T[] }

/**
 * Regroupe par jour, semaine ou mois de Kinshasa. Avec `from`/`to` (clés de période), les périodes vides sont
 * présentes (items: []) : une série temporelle ne saute jamais une période en silence. Éléments sans date : `undated`.
 */
export function groupByPeriod<T>(items: readonly T[], dateOf: (item: T) => string | Date | null | undefined, g: Granularity, opts: { from?: string; to?: string } = {}): { groups: PeriodGroup<T>[]; undated: number } {
  const m = new Map<string, T[]>();
  let undated = 0;
  for (const i of items) {
    const d = dateOf(i);
    const k = d ? periodKey(d, g) : null;
    if (!k) { undated += 1; continue; }
    const arr = m.get(k); if (arr) arr.push(i); else m.set(k, [i]);
  }
  let keys = [...m.keys()].sort();
  if (opts.from || opts.to) {
    const from = opts.from ?? keys[0]; const to = opts.to ?? keys[keys.length - 1];
    keys = from && to ? periodRange(from, to, g) : [];
  }
  return { groups: keys.map((k) => ({ period: k, items: m.get(k) ?? [] })), undated };
}

export const groupByDay = <T>(items: readonly T[], dateOf: (item: T) => string | Date | null | undefined, opts?: { from?: string; to?: string }) => groupByPeriod(items, dateOf, 'day', opts);
export const groupByWeek = <T>(items: readonly T[], dateOf: (item: T) => string | Date | null | undefined, opts?: { from?: string; to?: string }) => groupByPeriod(items, dateOf, 'week', opts);
export const groupByMonth = <T>(items: readonly T[], dateOf: (item: T) => string | Date | null | undefined, opts?: { from?: string; to?: string }) => groupByPeriod(items, dateOf, 'month', opts);

const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
/** Libellé français court d'une clé de période (« 27 sept. », « S39 2026 », « sept. 26 »). */
export function periodLabel(key: string, g: Granularity): string {
  if (g === 'month') { const [y, m] = key.split('-'); return `${MOIS[Number(m) - 1] ?? m} ${y?.slice(2)}`; }
  if (g === 'week') { const [y, w] = key.split('-S'); return `S${w} ${y}`; }
  const [, m, d] = key.split('-');
  return `${Number(d)} ${MOIS[Number(m) - 1] ?? m}`;
}

// ————————————————————————— rang, parts, tendance —————————————————————————

/**
 * Garde les N premiers (par valeur décroissante) et replie la traîne dans « Autres » (valeur additionnée, nombre
 * d'éléments repliés dans `folded`). Si la traîne ne compte qu'un élément, il est gardé tel quel.
 */
export function topN<R extends { key: string }>(rows: readonly R[], n: number, valueOf: (r: R) => number, otherLabel = AUTRES): { rows: (R | { key: string; other: true; folded: string[]; value: number })[]; folded: string[] } {
  const sorted = [...rows].sort((a, b) => valueOf(b) - valueOf(a));
  if (sorted.length <= n + 1 || n < 1) return { rows: sorted, folded: [] };
  const head = sorted.slice(0, n);
  const tail = sorted.slice(n);
  return { rows: [...head, { key: otherLabel, other: true, folded: tail.map((t) => t.key), value: tail.reduce((s, t) => s + valueOf(t), 0) }], folded: tail.map((t) => t.key) };
}

/**
 * Parts en % (méthode du plus fort reste : les parts arrondies totalisent exactement 100).
 * Total nul : toutes les parts valent `null` (non calculable), jamais 0 % trompeur.
 */
export function share(values: readonly number[], decimals = 0): (number | null)[] {
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  if (!total) return values.map(() => null);
  const f = 10 ** decimals;
  const raw = values.map((v) => (Math.max(0, v) / total) * 100 * f);
  const floor = raw.map(Math.floor);
  let rest = 100 * f - floor.reduce((s, v) => s + v, 0);
  const order = raw.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r);
  for (const o of order) { if (rest <= 0) break; floor[o.i]! += 1; rest -= 1; }
  return floor.map((v) => v / f);
}

export type TrendDirection = 'HAUSSE' | 'BAISSE' | 'STABLE' | 'INDISPONIBLE';
export interface Trend { current: number | null; previous: number | null; delta: number | null; pct: number | null; direction: TrendDirection }

/** Tendance d'une valeur face à la période précédente ; `pct` est null si la période précédente vaut 0 ou manque. */
export function trend(current: number | null | undefined, previous: number | null | undefined): Trend {
  const c = current ?? null; const p = previous ?? null;
  if (c === null || p === null || !Number.isFinite(c) || !Number.isFinite(p)) return { current: c, previous: p, delta: null, pct: null, direction: 'INDISPONIBLE' };
  const delta = c - p;
  const pct = p === 0 ? null : (delta / Math.abs(p)) * 100;
  return { current: c, previous: p, delta, pct, direction: delta > 0 ? 'HAUSSE' : delta < 0 ? 'BAISSE' : 'STABLE' };
}

/**
 * Tendance d'une série par période : dernière période face à l'avant-dernière (ex. mois courant vs mois précédent).
 */
export function trendOfSeries(values: readonly (number | null)[]): Trend {
  return trend(values.length ? values[values.length - 1] : null, values.length > 1 ? values[values.length - 2] : null);
}

/**
 * Tendance sur une fenêtre de dates : somme des valeurs dans [from, to] (jours de Kinshasa inclus) face à la fenêtre
 * précédente de même longueur.
 */
export function trendVsPrevious<T>(items: readonly T[], dateOf: (item: T) => string | Date | null | undefined, valueOf: (item: T) => number, from: string, to: string): Trend & { previousFrom: string; previousTo: string } {
  const len = periodRange(from, to, 'day').length;
  const pTo = new Date(`${from}T00:00:00.000Z`); pTo.setUTCDate(pTo.getUTCDate() - 1);
  const pFrom = new Date(pTo); pFrom.setUTCDate(pFrom.getUTCDate() - (len - 1));
  const previousFrom = pFrom.toISOString().slice(0, 10); const previousTo = pTo.toISOString().slice(0, 10);
  let cur = 0; let prev = 0;
  for (const i of items) {
    const d = dateOf(i); const k = d ? kinshasaDay(d) : null;
    if (!k) continue;
    if (k >= from && k <= to) cur += valueOf(i);
    else if (k >= previousFrom && k <= previousTo) prev += valueOf(i);
  }
  return { ...trend(cur, prev), previousFrom, previousTo };
}
