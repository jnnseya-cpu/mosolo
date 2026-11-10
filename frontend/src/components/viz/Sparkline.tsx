/**
 * Courbe miniature (Sparkline) et badge de tendance (TrendBadge).
 * Sparkline : trait de 2 px dans le gris de retrait, dernier point dans l'accent ; infobulle au survol / toucher ;
 * valeurs manquantes (null) laissées en trou, jamais comblées par 0.
 * TrendBadge : flèche + texte (jamais la couleur seule) ; bon / mauvais selon le sens favorable déclaré.
 */
import { useId, useRef, useState, type PointerEvent } from 'react';
import { trend as computeTrend, type Trend } from '../../lib/aggregate';
import { Icon } from '../Icon';
import { fmtNombre, fmtPct, useVizTheme, type Formatter } from './core';

export interface SparklineProps {
  values: readonly (number | null)[];
  /** Libellés des points (périodes), pour l'infobulle et la description. */
  labels?: readonly string[];
  format?: Formatter;
  /** Description lue (ex. « Encaissé, 12 derniers mois »). */
  label: string;
  width?: number;
  height?: number;
  /** Couleur d'accent du dernier point (défaut : catégorielle n° 1). */
  accent?: string;
  /** Remplissage léger (10 %) sous la courbe. */
  area?: boolean;
}

export function Sparkline({ values, labels, format = (v) => fmtNombre(v), label, width = 120, height = 32, accent, area = false }: SparklineProps) {
  const th = useVizTheme();
  const gid = useId();
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const color = accent ?? th.cat[0]!;
  if (nums.length === 0) return <span className="viz-spark-empty small muted" role="img" aria-label={`${label} : aucune donnée`}>—</span>;
  const min = Math.min(...nums, 0);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const pad = 4;
  const n = values.length;
  const x = (i: number) => (n <= 1 ? width / 2 : pad + (i * (width - pad * 2)) / (n - 1));
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);
  // Segments continus (un trou à chaque null).
  const segs: string[] = [];
  let cur = '';
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) { if (cur) segs.push(cur); cur = ''; return; }
    cur += `${cur ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
  });
  if (cur) segs.push(cur);
  let last = -1;
  for (let i = n - 1; i >= 0; i -= 1) if (values[i] !== null && Number.isFinite(values[i] as number)) { last = i; break; }
  const lastV = values[last] as number;
  const desc = `${label} : ${n} points, dernier ${labels?.[last] ? `(${labels[last]}) ` : ''}${format(lastV)}, minimum ${format(Math.min(...nums))}, maximum ${format(max)}`;
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    const rel = ((e.clientX - r.left) / r.width) * width;
    let best = 0; let dist = Infinity;
    for (let i = 0; i < n; i += 1) { const d = Math.abs(x(i) - rel); if (d < dist) { dist = d; best = i; } }
    setHover(best);
  };
  const h = hover !== null && values[hover] !== null ? hover : null;
  return (
    <span className="viz-spark">
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none" role="img" aria-label={desc}
        onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
        {area && segs.length > 0 && (
          <path d={`${segs.join('')}L${x(last).toFixed(1)},${height - pad}L${x(values.findIndex((v) => v !== null)).toFixed(1)},${height - pad}Z`} fill={color} opacity={0.1} />
        )}
        {segs.map((d, i) => <path key={`${gid}-${i}`} d={d} fill="none" stroke={th.deemph} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />)}
        <circle cx={x(last)} cy={y(lastV)} r={3.5} fill={color} stroke={th.surface} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        {h !== null && <line x1={x(h)} x2={x(h)} y1={0} y2={height} stroke={th.axis} strokeWidth={1} vectorEffect="non-scaling-stroke" />}
      </svg>
      {h !== null && (
        <span className="viz-spark-tip" role="tooltip" style={{ left: `${(x(h) / width) * 100}%` }}>
          <strong>{format(values[h] as number)}</strong>{labels?.[h] ? ` · ${labels[h]}` : ''}
        </span>
      )}
    </span>
  );
}

export type Better = 'HAUSSE' | 'BAISSE' | 'NEUTRE';

export interface TrendBadgeProps {
  /** Tendance calculée (lib/aggregate : trend, trendOfSeries) ou valeurs brutes. */
  trend?: Trend;
  current?: number | null;
  previous?: number | null;
  /** Sens favorable : une hausse est-elle bonne ? (défaut HAUSSE) */
  better?: Better;
  /** Période de comparaison (« vs mois précédent », « vs veille »). */
  versus: string;
  /** Afficher l'écart absolu plutôt que le pourcentage. */
  absolute?: boolean;
  format?: Formatter;
}

/** Badge de tendance : icône + texte, ton selon le sens favorable ; « Tendance indisponible » sinon. */
export function TrendBadge({ trend: t0, current, previous, better = 'HAUSSE', versus, absolute = false, format = (v) => fmtNombre(v) }: TrendBadgeProps) {
  const t = t0 ?? computeTrend(current, previous);
  if (t.direction === 'INDISPONIBLE' || (!absolute && t.pct === null && t.direction !== 'STABLE')) {
    const txt = t.direction !== 'INDISPONIBLE' && t.delta !== null ? `${t.delta > 0 ? '+' : '−'}${format(Math.abs(t.delta))} ${versus} (base nulle)` : `Tendance indisponible ${versus}`;
    return <span className="viz-trend viz-trend-neutral"><Icon name={t.direction === 'HAUSSE' ? 'arrowRight' : 'mark'} size={12} className={t.direction === 'HAUSSE' ? 'viz-rot-up' : ''} /> {txt}</span>;
  }
  const favorable = better === 'NEUTRE' || t.direction === 'STABLE' ? null : (t.direction === 'HAUSSE') === (better === 'HAUSSE');
  const cls = favorable === true ? 'viz-trend-good' : favorable === false ? 'viz-trend-bad' : 'viz-trend-neutral';
  const sign = t.direction === 'HAUSSE' ? '+' : t.direction === 'BAISSE' ? '−' : '±';
  const amount = absolute ? format(Math.abs(t.delta ?? 0)) : fmtPct(Math.abs(t.pct ?? 0), 1);
  const word = t.direction === 'HAUSSE' ? 'Hausse' : t.direction === 'BAISSE' ? 'Baisse' : 'Stable';
  const verdict = favorable === true ? ', favorable' : favorable === false ? ', défavorable' : '';
  return (
    <span className={`viz-trend ${cls}`} aria-label={`${word} de ${amount} ${versus}${verdict}`}>
      <Icon name="arrowRight" size={12} className={t.direction === 'HAUSSE' ? 'viz-rot-up' : t.direction === 'BAISSE' ? 'viz-rot-down' : ''} />
      <span aria-hidden="true">{t.direction === 'STABLE' ? 'Stable' : `${sign}${amount}`} {versus}</span>
    </span>
  );
}
