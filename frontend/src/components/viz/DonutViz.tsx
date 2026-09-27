/**
 * Anneau (DonutViz) : part d'un tout d'un coup d'œil, 5 parts au plus — au-delà, les plus petites sont repliées dans
 * « Autres » (gris de retrait). Total au centre, légende avec parts en %, 2 px de surface entre les parts.
 * La couleur suit l'ordre d'entrée des catégories (l'entité), jamais leur rang. Une seule devise par anneau.
 * Pour comparer des valeurs proches, préférer BarChartViz.
 */
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { share, topN } from '../../lib/aggregate';
import { fmtNombre, fmtPct, RechartsTip, useVizTheme, VizFrame, type Formatter, type VizFrameProps } from './core';

export interface DonutSlice { key: string; label: string; value: number }

export interface DonutVizProps extends VizFrameProps {
  slices: readonly DonutSlice[];
  format?: Formatter;
  /** Libellé sous le total (« encaissé », « dossiers »). */
  centerLabel?: string;
  /** Nombre maximal de parts, « Autres » compris (5 au plus). */
  maxSlices?: number;
  height?: number;
}

export function DonutViz(p: DonutVizProps) {
  const th = useVizTheme();
  const fmt = p.format ?? ((v: number) => fmtNombre(v));
  const max = Math.min(5, Math.max(2, p.maxSlices ?? 5));
  const order = new Map(p.slices.map((s, i) => [s.key, i]));
  const positive = p.slices.filter((s) => s.value > 0);
  const folded = positive.length > max ? topN(positive, max - 1, (s) => s.value) : { rows: [...positive].sort((a, b) => b.value - a.value), folded: [] as string[] };
  const labelOf = new Map(p.slices.map((s) => [s.key, s.label]));
  const slices = folded.rows.map((r) => ('other' in r
    ? { key: '__autres', label: 'Autres', value: r.value, color: th.deemph }
    : { key: r.key, label: (r as DonutSlice).label, value: (r as DonutSlice).value, color: th.cat[(order.get(r.key) ?? 0) % 8]! }));
  const total = slices.reduce((s, x) => s + x.value, 0);
  const pcts = share(slices.map((s) => s.value), 0);
  const empty = total <= 0;
  const table = { columns: ['Catégorie', 'Valeur', 'Part'], rows: slices.map((s, i) => [s.label, fmt(s.value), pcts[i] === null ? '—' : fmtPct(pcts[i]!, 0)]) };
  const legend = slices.map((s, i) => ({ label: `${s.label} · ${pcts[i] === null ? '—' : fmtPct(pcts[i]!, 0)}`, color: s.color }));
  const foldedNames = folded.folded.map((k) => labelOf.get(k) ?? k);
  const note = foldedNames.length ? <>{p.note}{p.note ? ' · ' : ''}« Autres » regroupe : {foldedNames.join(', ')}.</> : p.note;
  const h = p.height ?? 220;
  return (
    <VizFrame frame={{ ...p, note }} table={table} legend={legend} empty={empty} height={h} role="img"
      ariaLabel={`${p.title} : total ${fmt(total)}${p.centerLabel ? ` ${p.centerLabel}` : ''} ; ${slices.map((s, i) => `${s.label} ${pcts[i] ?? 0} %`).join(', ')}${p.example ? ' (exemple, non opposable)' : ''}.`}>
      <div className="viz-donut">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={slices} dataKey="value" nameKey="label" innerRadius="62%" outerRadius="88%" startAngle={90} endAngle={-270} paddingAngle={0} stroke={th.surface} strokeWidth={2} isAnimationActive={false}>
              {slices.map((s) => <Cell key={s.key} fill={s.color} />)}
            </Pie>
            <Tooltip content={<RechartsTip format={(v) => `${fmt(v)} · ${total ? fmtPct((v / total) * 100, 0) : '—'}`} />} wrapperStyle={{ zIndex: 5, outline: 'none' }} />
          </PieChart>
        </ResponsiveContainer>
        <div className="viz-donut-center" aria-hidden="true">
          <strong>{fmt(total)}</strong>
          {p.centerLabel && <span>{p.centerLabel}</span>}
        </div>
      </div>
    </VizFrame>
  );
}
