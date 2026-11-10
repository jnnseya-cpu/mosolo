/**
 * Visuels des verticales (Partie V), du stationnement, de la publicité et de la chaîne véhicule (27/09/2026).
 * Petits adaptateurs entre les listes déjà chargées par les écrans et la trousse partagée `components/viz` : aucune
 * donnée nouvelle, aucun chiffre inventé, jamais deux devises additionnées (un graphique par devise), démonstration
 * signalée « [EXEMPLE] » par la trousse (`example`).
 */
import type { ReactNode } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import type { Tone } from '../components/StatusBadge';
import { BarChartViz, LineAreaViz, fmtCompact, fmtNombre, type BarRow, type StatusItem, type VizFrameProps } from '../components/viz';
import { countBy, groupByMonth, kinshasaMonth, periodRange } from '../lib/aggregate';
import './visuels.css';

/** Nombre depuis une chaîne décimale servie par le serveur (« 64.2 », « 64,2 ») ; null si absent. */
export function toNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.').replace('−', '-').replace(/\s/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Libellé et ton d'un état. */
export interface EtatVue { label: string; tone: Tone }

/**
 * Répartition par état d'une liste : un élément par état présent, dans l'ordre du référentiel `vue` (états inconnus à
 * la fin, libellé brut, ton neutre).
 */
export function statusItems<T>(items: readonly T[], keyOf: (item: T) => string, vue: Record<string, EtatVue> = {}): StatusItem[] {
  const rows = countBy(items, keyOf);
  const order = Object.keys(vue);
  const rank = (k: string) => { const i = order.indexOf(k); return i < 0 ? order.length : i; };
  return rows
    .sort((a, b) => rank(a.key) - rank(b.key))
    .map((r) => ({ key: r.key, label: vue[r.key]?.label ?? r.key, tone: vue[r.key]?.tone ?? 'neutral', count: r.count }));
}

/** Répartition par état à partir de compteurs déjà servis (états disjoints). */
export function countItems(entries: readonly (readonly [key: string, label: string, tone: Tone, count: number | null | undefined])[]): StatusItem[] {
  return entries.map(([key, label, tone, count]) => ({ key, label, tone, count: Math.max(0, count ?? 0) }));
}

/** Liste de montants (un par devise) d'une valeur servie sous forme de tableau, d'objet ou de null. */
function asList(m: MoneyJSON[] | MoneyJSON | null | undefined): MoneyJSON[] {
  if (!m) return [];
  return Array.isArray(m) ? m : [m];
}

/**
 * Lignes « libellé → montants » vers une série de barres PAR DEVISE (jamais additionnées entre devises). Les devises
 * sont rendues dans l'ordre CDF, USD, puis les autres.
 */
export function moneyBarsByCurrency(rows: readonly { label: string; key?: string; money: MoneyJSON[] | MoneyJSON | null | undefined }[]): { currency: string; rows: BarRow[] }[] {
  const byCur = new Map<string, BarRow[]>();
  for (const r of rows) {
    for (const m of asList(r.money)) {
      const v = toNum(m.amount);
      if (v === null) continue;
      const list = byCur.get(m.currency) ?? [];
      const existing = list.find((x) => x.label === r.label);
      if (existing) existing.values.v = (existing.values.v ?? 0) + v;
      else list.push({ key: r.key ?? r.label, label: r.label, values: { v } });
      byCur.set(m.currency, list);
    }
  }
  const rank = (c: string) => (c === 'CDF' ? 0 : c === 'USD' ? 1 : 2);
  return [...byCur.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0])).map(([currency, list]) => ({ currency, rows: list.sort((a, b) => (b.values.v ?? 0) - (a.values.v ?? 0)) }));
}

/**
 * Montants par libellé : un graphique en barres horizontales par devise (règle 4 de la charte). Sans montant : l'état
 * vide de la trousse, jamais un zéro dessiné.
 */
export function MoneyBars({ title, subtitle, rows, measure = 'Montant', example, note, emptyText, loading, error, onRetry, className }: VizFrameProps & {
  rows: readonly { label: string; key?: string; money: MoneyJSON[] | MoneyJSON | null | undefined }[]; measure?: string;
}) {
  const parts = moneyBarsByCurrency(rows);
  if (parts.length === 0) {
    return <BarChartViz title={title} subtitle={subtitle} rows={[]} series={[{ key: 'v', label: measure }]} example={example} note={note} emptyText={emptyText} loading={loading} error={error} onRetry={onRetry} className={className} />;
  }
  return (
    <>
      {parts.map((p) => (
        <BarChartViz key={p.currency} className={className} title={parts.length > 1 ? `${title} — ${p.currency}` : title} subtitle={subtitle ?? `${measure} en ${p.currency} (une devise par graphique)`}
          orientation="horizontal" format={(v) => `${fmtCompact(v)} ${p.currency}`} tickFormat={fmtCompact}
          series={[{ key: 'v', label: `${measure} (${p.currency})` }]} rows={p.rows} example={example} note={note} loading={loading} error={error} onRetry={onRetry} />
      ))}
    </>
  );
}

/** Les N derniers mois de Kinshasa (clés « AAAA-MM »), du plus ancien au courant. */
export function lastMonths(n = 12, now: Date = new Date()): string[] {
  const cur = kinshasaMonth(now)!;
  const [y, m] = cur.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - n, 1));
  return periodRange(d.toISOString().slice(0, 7), cur, 'month');
}

/**
 * Nombre d'éléments par mois de Kinshasa (de la plus ancienne date présente, au plus 12 mois avant, jusqu'au mois
 * courant) : périodes vides comblées, jamais sautées.
 */
export function monthlyCounts<T>(items: readonly T[], dateOf: (item: T) => string | null | undefined, now: Date = new Date()): { date: string; values: { n: number } }[] {
  const months = lastMonths(12, now);
  const dated = items.map(dateOf).filter((d): d is string => !!d).map((d) => kinshasaMonth(d)).filter((d): d is string => !!d).sort();
  const first = dated[0];
  const cur = months[months.length - 1]!;
  const last = dated[dated.length - 1];
  const from = first && first > months[0]! ? first : months[0]!;
  const to = last && last > cur ? last : cur;
  const g = groupByMonth(items, (i) => dateOf(i) ?? null, { from, to });
  return g.groups.map((x) => ({ date: x.period, values: { n: x.items.length } }));
}

/** Courbe mensuelle d'un comptage (dépôts, constats, contrôles…) : état vide si aucune date. */
export function MonthlyCountLine<T>({ title, subtitle, items, dateOf, measure, example, note, loading, error, onRetry, className }: VizFrameProps & {
  items: readonly T[]; dateOf: (item: T) => string | null | undefined; measure: string;
}) {
  const points = monthlyCounts(items, dateOf);
  const empty = points.every((p) => p.values.n === 0);
  return (
    <LineAreaViz title={title} subtitle={subtitle} granularity="month" area format={(v) => fmtNombre(v, 0)} className={className}
      series={[{ key: 'n', label: measure }]} points={empty ? [] : points} example={example} note={note} loading={loading} error={error} onRetry={onRetry} />
  );
}

/** Barres simples « libellé → nombre » (répartition par catégorie, commune, type…), triées décroissantes. */
export function CountBars<T>({ title, subtitle, items, keyOf, labelOf, measure, example, note, max = 12, className, loading, error, onRetry }: VizFrameProps & {
  items: readonly T[]; keyOf: (item: T) => string; labelOf?: (key: string) => string; measure: string; max?: number;
}) {
  const rows = countBy(items, keyOf).slice(0, max).map((r) => ({ key: r.key, label: labelOf ? labelOf(r.key) : r.key, values: { n: r.count } }));
  return (
    <BarChartViz title={title} subtitle={subtitle} orientation="horizontal" format={(v) => fmtNombre(v, 0)} className={className}
      series={[{ key: 'n', label: measure }]} rows={rows} example={example} note={note} loading={loading} error={error} onRetry={onRetry} />
  );
}

/** Enveloppe d'un bloc visuel en tête d'écran (titre lu, espacement commun). */
export function VisualSummary({ label, children }: { label: string; children: ReactNode }) {
  return <section className="vx-visuals" aria-label={label}>{children}</section>;
}
