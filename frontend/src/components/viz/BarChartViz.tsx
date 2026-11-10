/**
 * Barres (BarChartViz) : colonnes ou barres horizontales, une série ou groupées (4 séries au plus ; au-delà, repli
 * dans « Autres »), ligne de référence facultative (cible). Barres fines (≤ 24 px), bout arrondi 4 px côté donnée,
 * 2 px d'air entre barres groupées, étiquette de valeur en bout de barre pour une série, infobulle par barre.
 * Un seul axe de valeurs (jamais deux échelles) : deux mesures d'échelles différentes = deux graphiques.
 */
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  categoryAxisWidth, clip, fmtCompact, fmtNombre, foldSeries, RechartsTip, useElementWidth, useVizTheme, VizFrame,
  type Formatter, type SeriesDef, type VizFrameProps,
} from './core';

export interface BarRow { key?: string; label: string; values: Record<string, number | null> }

export interface BarChartVizProps extends VizFrameProps {
  rows: readonly BarRow[];
  /** 1 à 4 séries (au-delà : « Autres »). Une série n'a pas de légende : le titre la nomme. */
  series: readonly SeriesDef[];
  /** « vertical » = colonnes ; « horizontal » = barres (conseillé pour les libellés longs et sur téléphone). */
  orientation?: 'vertical' | 'horizontal';
  format?: Formatter;
  /** Format compact des graduations (défaut : « 4,8 M »). */
  tickFormat?: Formatter;
  /** Ligne de référence (cible déclarée). */
  reference?: { value: number; label: string };
  /** Ligne mise en avant (les autres passent en gris de retrait) — forme « emphase ». */
  highlight?: string;
  /** Étiquettes de valeur en bout de barre (défaut : une série et ≤ 12 lignes). */
  directLabels?: boolean;
  height?: number;
}

export function BarChartViz(p: BarChartVizProps) {
  const th = useVizTheme();
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const fmt = p.format ?? ((v: number) => fmtNombre(v));
  const tick = p.tickFormat ?? fmtCompact;
  const horizontal = p.orientation === 'horizontal';
  const withColor = p.series.map((s, i) => ({ ...s, color: s.color ?? th.cat[i % 8]! }));
  const f = foldSeries(p.rows, withColor, 4, th.deemph);
  const series = f.series;
  const rows = f.rows;
  const single = series.length === 1;
  const empty = rows.length === 0 || rows.every((r) => series.every((s) => r.values[s.key] === null || r.values[s.key] === undefined));
  const data = rows.map((r) => ({ __label: r.label, __key: r.key ?? r.label, ...Object.fromEntries(series.map((s) => [s.key, r.values[s.key] ?? null])) }));
  const labels = rows.map((r) => r.label);
  const catW = horizontal ? categoryAxisWidth(labels, width) : 0;
  const maxChars = horizontal ? Math.max(6, Math.floor((catW - 10) / 6.4)) : Math.max(4, Math.floor((width || 320) / Math.max(1, rows.length) / 6.6));
  const direct = p.directLabels ?? (single && rows.length <= 12);
  const band = single ? 14 : series.length * 10 + 2 * (series.length - 1);
  const height = p.height ?? (horizontal ? Math.max(160, rows.length * (band + 14) + 44) : 260);
  const radius: [number, number, number, number] = horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0];
  const table = {
    columns: [p.orientation === 'horizontal' ? 'Catégorie' : 'Catégorie', ...series.map((s) => s.label)],
    rows: rows.map((r) => [r.label, ...series.map((s) => { const v = r.values[s.key]; return v === null || v === undefined ? 'non mesuré' : fmt(v); })]),
  };
  const legend = series.length >= 2 ? series.map((s) => ({ label: s.label, color: s.color! })) : undefined;
  const note = f.folded.length ? <>{p.note}{p.note ? ' · ' : ''}« Autres » regroupe : {f.folded.join(', ')}.</> : p.note;
  const valueLabel = (props: unknown) => {
    const { x, y, width: w, height: h, value } = props as { x?: number; y?: number; width?: number; height?: number; value?: number | null };
    if (x === undefined || y === undefined || value === null || value === undefined) return null;
    const text = fmt(Number(value));
    return horizontal
      ? <text x={Number(x) + Number(w ?? 0) + 6} y={Number(y) + Number(h ?? 0) / 2 + 4} fontSize={11} fill={th.ink} className="viz-num">{text}</text>
      : <text x={Number(x) + Number(w ?? 0) / 2} y={Number(y) - 6} fontSize={11} fill={th.ink} textAnchor="middle" className="viz-num">{text}</text>;
  };
  const rightPad = horizontal && direct ? Math.min(84, Math.max(40, Math.max(...rows.map((r) => fmt(r.values[series[0]!.key] ?? 0).length)) * 6.6 + 12)) : 16;
  return (
    <VizFrame frame={{ ...p, note }} table={table} legend={legend} empty={empty} height={height} role="img">
      <div ref={ref} className="viz-fill">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: direct && !horizontal ? 20 : 8, right: rightPad, bottom: 4, left: 0 }} barCategoryGap={horizontal ? 8 : '24%'} barGap={2}>
            <CartesianGrid horizontal={!horizontal} vertical={horizontal} stroke={th.grid} />
            {horizontal ? (
              <>
                <XAxis type="number" tickFormatter={tick} tick={{ fontSize: 11, fill: th.axis }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="__label" width={catW} tick={{ fontSize: 11.5, fill: th.ink }} tickFormatter={(l: string) => clip(l, maxChars)} axisLine={false} tickLine={false} interval={0} />
              </>
            ) : (
              <>
                <XAxis dataKey="__label" tick={{ fontSize: 11, fill: th.axis }} tickFormatter={(l: string) => clip(l, maxChars)} axisLine={{ stroke: th.grid }} tickLine={false} interval="preserveStartEnd" minTickGap={8} />
                <YAxis tickFormatter={tick} tick={{ fontSize: 11, fill: th.axis }} axisLine={false} tickLine={false} width={52} />
              </>
            )}
            <Tooltip cursor={{ fill: th.grid, opacity: 0.5 }} content={<RechartsTip format={(v) => fmt(v)} />} wrapperStyle={{ zIndex: 5, outline: 'none' }} />
            {p.reference && (
              horizontal
                ? <ReferenceLine x={p.reference.value} stroke={th.reference} strokeWidth={1.5} strokeDasharray="4 3" ifOverflow="extendDomain" label={{ value: p.reference.label, position: 'insideTopLeft', fontSize: 11, fill: th.axis }} />
                : <ReferenceLine y={p.reference.value} stroke={th.reference} strokeWidth={1.5} strokeDasharray="4 3" ifOverflow="extendDomain" label={{ value: p.reference.label, position: 'insideTopLeft', fontSize: 11, fill: th.axis }} />
            )}
            {series.map((s) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={radius} maxBarSize={single ? 24 : 12} isAnimationActive={false}>
                {p.highlight && data.map((d) => <Cell key={d.__key} fill={d.__key === p.highlight || d.__label === p.highlight ? s.color : th.deemph} />)}
                {direct && <LabelList dataKey={s.key} content={valueLabel} />}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </VizFrame>
  );
}
