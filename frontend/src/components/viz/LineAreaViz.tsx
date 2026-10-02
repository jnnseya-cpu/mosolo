/**
 * Série temporelle (LineAreaViz) : courbes de 2 px, aplat facultatif à 10 %, ligne de cible facultative, réticule
 * vertical et infobulle listant toutes les séries à la date pointée. Dates en jours de Kinshasa (UTC+1).
 * 4 séries au plus (au-delà : petits multiples conseillés, ou repli « Autres »). Un seul axe des valeurs.
 */
import { Area, CartesianGrid, ComposedChart, LabelList, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { kinshasaDay, periodLabel, type Granularity } from '../../lib/aggregate';
import { fmtCompact, fmtNombre, foldSeries, RechartsTip, useElementWidth, useVizTheme, VizFrame, type Formatter, type SeriesDef, type VizFrameProps } from './core';

export interface TimePoint {
  /** Clé de période (« 2026-09-27 », « 2026-S39 », « 2026-09 ») ou instant ISO (ramené au jour de Kinshasa). */
  date: string;
  values: Record<string, number | null>;
}

export interface LineAreaVizProps extends VizFrameProps {
  points: readonly TimePoint[];
  series: readonly SeriesDef[];
  granularity?: Granularity;
  /** Aplat léger sous les courbes (conseillé pour une seule série). */
  area?: boolean;
  target?: { value: number; label: string };
  format?: Formatter;
  tickFormat?: Formatter;
  /** Étiquette directe de la dernière valeur de chaque série (défaut : oui si la largeur le permet). */
  endLabels?: boolean;
  height?: number;
}

function keyOf(d: string, g: Granularity): string {
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(d) || /^\d{4}-S\d{2}$/.test(d)) return d;
  const day = kinshasaDay(d) ?? d;
  return g === 'month' ? day.slice(0, 7) : day;
}

export function LineAreaViz(p: LineAreaVizProps) {
  const th = useVizTheme();
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const g = p.granularity ?? 'day';
  const fmt = p.format ?? ((v: number) => fmtNombre(v));
  const tick = p.tickFormat ?? fmtCompact;
  const rows = p.points.map((pt) => ({ label: keyOf(pt.date, g), values: pt.values }));
  const f = foldSeries(rows, p.series.map((s, i) => ({ ...s, color: s.color ?? th.cat[i % 8]! })), 4, th.deemph);
  const series = f.series;
  const data: Record<string, string | number | null>[] = f.rows.map((r) => ({ __k: r.label, __label: periodLabel(r.label, g), ...Object.fromEntries(series.map((s) => [s.key, r.values[s.key] ?? null])) }));
  const empty = data.length === 0 || f.rows.every((r) => series.every((s) => r.values[s.key] === null || r.values[s.key] === undefined));
  // Étiquettes de fin : seulement si elles ne se chevauchent pas (sinon légende + infobulle, jamais d'empilement).
  const lasts = series.map((s) => { for (let i = f.rows.length - 1; i >= 0; i -= 1) { const v = f.rows[i]!.values[s.key]; if (v !== null && v !== undefined) return v; } return null; }).filter((v): v is number => v !== null);
  const all = f.rows.flatMap((r) => series.map((s) => r.values[s.key])).filter((v): v is number => v !== null && v !== undefined);
  const range = (Math.max(0, ...all) - Math.min(0, ...all)) || 1;
  const apart = lasts.every((a, i) => lasts.every((b, j) => i === j || Math.abs(a - b) / range >= 0.1));
  const ends = (p.endLabels ?? true) && apart && (series.length === 1 || width >= 480);
  const n = data.length;
  const endLabel = (props: unknown, s: SeriesDef) => {
    const { x, y, index } = props as { x?: number; y?: number; index?: number };
    if (index !== n - 1 || x === undefined || y === undefined) return null;
    const v = data[n - 1]?.[s.key] as number | null | undefined;
    if (v === null || v === undefined) return null;
    return <text x={Number(x) + 8} y={Number(y) + 4} fontSize={11.5} fill={th.ink} className="viz-num">{fmt(v)}</text>;
  };
  const table = {
    columns: ['Période', ...series.map((s) => s.label), ...(p.target ? ['Cible'] : [])],
    rows: data.map((d) => [String(d.__label), ...series.map((s) => { const v = d[s.key] as number | null; return v === null || v === undefined ? 'non mesuré' : fmt(v); }), ...(p.target ? [fmt(p.target.value)] : [])]),
  };
  const legend = series.length >= 2 || p.target ? [...series.map((s) => ({ label: s.label, color: s.color! })), ...(p.target ? [{ label: p.target.label, color: th.reference, dashed: true }] : [])] : undefined;
  const rightPad = ends ? Math.min(72, Math.max(36, fmt(Math.max(0, ...f.rows.flatMap((r) => series.map((s) => r.values[s.key] ?? 0)))).length * 7 + 12)) : 12;
  return (
    <VizFrame frame={p} table={table} legend={legend} empty={empty} height={p.height ?? 240} role="img">
      <div ref={ref} className="viz-fill">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: rightPad, bottom: 4, left: 0 }}>
            <CartesianGrid vertical={false} stroke={th.grid} />
            <XAxis dataKey="__label" tick={{ fontSize: 11, fill: th.axis }} axisLine={{ stroke: th.grid }} tickLine={false} interval="preserveStartEnd" minTickGap={18} />
            <YAxis tickFormatter={tick} tick={{ fontSize: 11, fill: th.axis }} axisLine={false} tickLine={false} width={52} />
            <Tooltip cursor={{ stroke: th.axis, strokeWidth: 1 }} content={<RechartsTip format={(v) => fmt(v)} />} wrapperStyle={{ zIndex: 5, outline: 'none' }} />
            {p.target && <ReferenceLine y={p.target.value} stroke={th.reference} strokeWidth={1.5} strokeDasharray="5 4" ifOverflow="extendDomain" />}
            {series.map((s) => (p.area ? (
              <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} fill={s.color} fillOpacity={0.1} connectNulls={false}
                dot={false} activeDot={{ r: 4.5, stroke: th.surface, strokeWidth: 2 }} isAnimationActive={false}>
                {ends && <LabelList dataKey={s.key} content={(pp) => endLabel(pp, s)} />}
              </Area>
            ) : (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} dot={n <= 16 ? { r: 3, strokeWidth: 0, fill: s.color } : false}
                activeDot={{ r: 4.5, stroke: th.surface, strokeWidth: 2 }} connectNulls={false} isAnimationActive={false}>
                {ends && <LabelList dataKey={s.key} content={(pp) => endLabel(pp, s)} />}
              </Line>
            )))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </VizFrame>
  );
}
