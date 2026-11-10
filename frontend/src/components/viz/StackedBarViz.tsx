/**
 * Barres empilées (StackedBarViz) : partie d'un tout, en valeur absolue ou ramenée à 100 %.
 * 2 px de surface entre segments (l'air sépare, jamais un contour), bout arrondi 4 px sur le dernier segment,
 * 6 séries au plus (au-delà : « Autres »), légende toujours présente, infobulle : part et valeur de chaque segment.
 */
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from 'recharts';
import { share } from '../../lib/aggregate';
import {
  categoryAxisWidth, clip, fmtCompact, fmtNombre, fmtPct, foldSeries, TipBody, useElementWidth, useVizTheme, VizFrame,
  type Formatter, type SeriesDef, type VizFrameProps,
} from './core';
import type { BarRow } from './BarChartViz';

export interface StackedBarVizProps extends VizFrameProps {
  rows: readonly BarRow[];
  series: readonly SeriesDef[];
  /** « percent » : chaque barre ramenée à 100 % ; « absolute » : valeurs empilées. */
  mode?: 'percent' | 'absolute';
  orientation?: 'vertical' | 'horizontal';
  format?: Formatter;
  height?: number;
}

export function StackedBarViz(p: StackedBarVizProps) {
  const th = useVizTheme();
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const fmt = p.format ?? ((v: number) => fmtNombre(v));
  const mode = p.mode ?? 'percent';
  const horizontal = (p.orientation ?? 'horizontal') === 'horizontal';
  const f = foldSeries(p.rows, p.series.map((s, i) => ({ ...s, color: s.color ?? th.cat[i % 8]! })), 6, th.deemph);
  const series = f.series;
  const data = f.rows.map((r) => {
    const raw = series.map((s) => r.values[s.key] ?? 0);
    const pcts = share(raw, 1);
    const o: Record<string, number | string | null> = { __label: r.label };
    series.forEach((s, i) => { o[s.key] = mode === 'percent' ? (pcts[i] ?? 0) : raw[i]!; o[`${s.key}__raw`] = r.values[s.key] ?? null; o[`${s.key}__pct`] = pcts[i] ?? null; });
    return o;
  });
  const empty = data.length === 0 || f.rows.every((r) => series.every((s) => !r.values[s.key]));
  const labels = f.rows.map((r) => r.label);
  const catW = horizontal ? categoryAxisWidth(labels, width) : 0;
  const maxChars = horizontal ? Math.max(6, Math.floor((catW - 10) / 6.4)) : 10;
  const height = p.height ?? (horizontal ? Math.max(140, data.length * 34 + 44) : 260);
  const lastKey = series[series.length - 1]?.key;
  const tick = mode === 'percent' ? (v: number) => `${v} %` : fmtCompact;
  const table = {
    columns: ['Catégorie', ...series.flatMap((s) => [s.label, `${s.label} (part)`])],
    rows: data.map((d) => [String(d.__label), ...series.flatMap((s) => {
      const raw = d[`${s.key}__raw`] as number | null; const pc = d[`${s.key}__pct`] as number | null;
      return [raw === null ? 'non mesuré' : fmt(raw), pc === null ? '—' : fmtPct(pc)];
    })]),
  };
  const tipContent = ({ active, payload, label }: TooltipProps<number, string>) => {
    if (!active || !payload?.length) return null;
    const row = payload[0]!.payload as Record<string, number | null>;
    return (
      <div className="viz-tip viz-tip-static">
        <TipBody title={String(label)} rows={[...series].reverse().map((s) => {
          const raw = row[`${s.key}__raw`]; const pc = row[`${s.key}__pct`];
          return { label: s.label, color: s.color, value: raw === null || raw === undefined ? 'non mesuré' : `${fmt(raw)}${pc !== null && pc !== undefined ? ` · ${fmtPct(pc)}` : ''}` };
        })} />
      </div>
    );
  };
  const note = f.folded.length ? <>{p.note}{p.note ? ' · ' : ''}« Autres » regroupe : {f.folded.join(', ')}.</> : p.note;
  return (
    <VizFrame frame={{ ...p, note }} table={table} legend={series.map((s) => ({ label: s.label, color: s.color! }))} empty={empty} height={height} role="img">
      <div ref={ref} className="viz-fill">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 8, right: 16, bottom: 4, left: 0 }} barCategoryGap={horizontal ? 10 : '28%'} stackOffset="none">
            <CartesianGrid horizontal={!horizontal} vertical={horizontal} stroke={th.grid} />
            {horizontal ? (
              <>
                <XAxis type="number" domain={mode === 'percent' ? [0, 100] : [0, 'auto']} ticks={mode === 'percent' ? [0, 25, 50, 75, 100] : undefined} tickFormatter={tick} tick={{ fontSize: 11, fill: th.axis }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="__label" width={catW} tick={{ fontSize: 11.5, fill: th.ink }} tickFormatter={(l: string) => clip(l, maxChars)} axisLine={false} tickLine={false} interval={0} />
              </>
            ) : (
              <>
                <XAxis dataKey="__label" tick={{ fontSize: 11, fill: th.axis }} tickFormatter={(l: string) => clip(l, maxChars)} axisLine={{ stroke: th.grid }} tickLine={false} interval="preserveStartEnd" />
                <YAxis domain={mode === 'percent' ? [0, 100] : [0, 'auto']} tickFormatter={tick} tick={{ fontSize: 11, fill: th.axis }} axisLine={false} tickLine={false} width={48} />
              </>
            )}
            <Tooltip cursor={{ fill: th.grid, opacity: 0.5 }} content={tipContent} wrapperStyle={{ zIndex: 5, outline: 'none' }} />
            {series.map((s) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} stackId="pile" fill={s.color} stroke={th.surface} strokeWidth={2} maxBarSize={22}
                radius={s.key === lastKey ? (horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]) : 0} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </VizFrame>
  );
}
