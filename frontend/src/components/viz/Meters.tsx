/**
 * Jauges : GaugeMeter (demi-cercle) et ProgressMeter (barre) — progression vers une cible.
 * Le remplissage porte l'état (couleur d'état + icône + libellé, jamais la couleur seule) ; la piste est un pas plus
 * clair de la même teinte. Aucun seuil n'est inventé : l'état vient de l'appelant (`tone`) ou, à défaut, de la seule
 * comparaison à la cible déclarée (« Cible atteinte » / « Sous la cible »).
 */
import type { ReactNode } from 'react';
import { STATUS_ICON } from '../../lib/palette';
import { Icon } from '../Icon';
import type { Tone } from '../StatusBadge';
import { fmtNombre, VizFrame, VizUnmeasured, useVizTheme, type Formatter, type VizFrameProps } from './core';
import type { Better } from './Sparkline';

export interface MeterProps {
  value: number | null;
  /** Cible déclarée (source à citer dans `targetLabel`). */
  target?: number | null;
  targetLabel?: string;
  /** Bornes de l'échelle (défaut 0 → 100, ou 0 → max(valeur, cible) × 1,1 si l'unité n'est pas « % »). */
  min?: number;
  max?: number;
  unit?: string;
  format?: Formatter;
  better?: Better;
  /** État imposé par l'appelant (prioritaire), avec son libellé. */
  tone?: Tone;
  toneLabel?: string;
  /** Motif si la valeur n'est pas mesurée. */
  reason?: string;
}

export function meterState(p: Pick<MeterProps, 'value' | 'target' | 'better' | 'tone' | 'toneLabel'>): { tone: Tone; label: string } {
  if (p.tone) return { tone: p.tone, label: p.toneLabel ?? '' };
  if (p.value === null) return { tone: 'neutral', label: 'Non mesuré' };
  if (p.target === null || p.target === undefined) return { tone: 'info', label: 'Suivi (sans cible)' };
  const ok = p.better === 'BAISSE' ? p.value <= p.target : p.value >= p.target;
  return ok ? { tone: 'good', label: 'Cible atteinte' } : { tone: 'warning', label: 'Sous la cible' };
}

function toneColor(tone: Tone, th: ReturnType<typeof useVizTheme>): string {
  if (tone === 'good' || tone === 'warning' || tone === 'serious' || tone === 'critical') return th.status[tone];
  return tone === 'info' ? th.cat[0]! : th.deemph;
}

function scale(p: MeterProps): [number, number] {
  const min = p.min ?? 0;
  if (p.max !== undefined) return [min, p.max];
  if (p.unit === '%') return [min, 100];
  const top = Math.max(p.value ?? 0, p.target ?? 0) * 1.1 || 1;
  return [min, top];
}

function StateLine({ tone, label }: { tone: Tone; label: string }) {
  return <span className={`viz-meter-state badge badge-${tone}`}><Icon name={STATUS_ICON[tone]} size={14} className="badge-icon" /><span>{label}</span></span>;
}

export interface ProgressMeterProps extends MeterProps {
  /** Libellé de la jauge (lu par les lecteurs d'écran, affiché au-dessus). */
  label: string;
  /** Masque le libellé visible (tuile qui l'affiche déjà). */
  hideLabel?: boolean;
  compact?: boolean;
  extra?: ReactNode;
}

/** Barre de progression vers la cible (4 px arrondis au bout, repère de cible). */
export function ProgressMeter(p: ProgressMeterProps) {
  const th = useVizTheme();
  const fmt = p.format ?? ((v: number) => fmtNombre(v));
  const unit = p.unit ? (p.unit === '%' ? ' %' : ` ${p.unit}`) : '';
  if (p.value === null) return <div className="viz-meter">{!p.hideLabel && <p className="viz-meter-label">{p.label}</p>}<VizUnmeasured reason={p.reason ?? 'mesure indisponible'} /></div>;
  const [lo, hi] = scale(p);
  const pct = (v: number) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo || 1)) * 100));
  const st = meterState(p);
  const color = toneColor(st.tone, th);
  const valueText = `${fmt(p.value)}${unit}${p.target !== undefined && p.target !== null ? ` sur une cible de ${fmt(p.target)}${unit}` : ''} — ${st.label}`;
  return (
    <div className={`viz-meter${p.compact ? ' viz-meter-compact' : ''}`}>
      {!p.hideLabel && <p className="viz-meter-label">{p.label}</p>}
      <div className="viz-meter-track" role="meter" aria-label={p.label} aria-valuemin={lo} aria-valuemax={hi} aria-valuenow={p.value} aria-valuetext={valueText}
        style={{ background: `color-mix(in srgb, ${color} 18%, ${th.surface})` }}>
        <span className="viz-meter-fill" style={{ width: `${pct(p.value)}%`, background: color }} />
        {p.target !== undefined && p.target !== null && <span className="viz-meter-target" style={{ left: `${pct(p.target)}%`, background: th.ink }} title={`Cible : ${fmt(p.target)}${unit}`} />}
      </div>
      <div className="viz-meter-foot">
        <strong className="viz-meter-value">{fmt(p.value)}{unit}</strong>
        {p.target !== undefined && p.target !== null && <span className="small muted">cible {fmt(p.target)}{unit}{p.targetLabel ? ` · ${p.targetLabel}` : ''}</span>}
        <StateLine tone={st.tone} label={st.label} />
        {p.extra}
      </div>
    </div>
  );
}

export interface GaugeMeterProps extends MeterProps, VizFrameProps {}

/** Jauge en demi-cercle (carte par défaut ; framed=false pour l'incruster). */
export function GaugeMeter(p: GaugeMeterProps) {
  const th = useVizTheme();
  const fmt = p.format ?? ((v: number) => fmtNombre(v));
  const unit = p.unit ? (p.unit === '%' ? ' %' : ` ${p.unit}`) : '';
  const [lo, hi] = scale(p);
  const st = meterState(p);
  const color = toneColor(st.tone, th);
  const frac = (v: number) => Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1)));
  const R = 70; const cx = 90; const cy = 84; const sw = 12;
  const pt = (f: number) => [cx - R * Math.cos(Math.PI * f), cy - R * Math.sin(Math.PI * f)] as const;
  const arc = (f: number) => { const [x, y] = pt(f); return `M${cx - R},${cy} A${R},${R} 0 0 1 ${x.toFixed(2)},${y.toFixed(2)}`; };
  const table = { columns: ['Mesure', 'Valeur'], rows: [['Valeur', p.value === null ? 'non mesuré' : `${fmt(p.value)}${unit}`], ['Cible', p.target === null || p.target === undefined ? 'sans cible' : `${fmt(p.target)}${unit}`], ['État', st.label]] as (string | number)[][] };
  const unmeasured = p.value === null ? (p.unmeasured ?? p.reason ?? 'mesure indisponible') : p.unmeasured;
  const valueText = p.value === null ? 'non mesuré' : `${fmt(p.value)}${unit}${p.target !== undefined && p.target !== null ? ` sur une cible de ${fmt(p.target)}${unit}` : ''} — ${st.label}`;
  return (
    <VizFrame frame={{ ...p, unmeasured }} table={table} empty={false} role="group">
      <div className="viz-gauge">
        <svg viewBox="0 0 180 100" role="meter" aria-label={p.title} aria-valuemin={lo} aria-valuemax={hi} aria-valuenow={p.value ?? undefined} aria-valuetext={valueText}>
          <path d={arc(1)} fill="none" stroke={color} strokeOpacity={0.18} strokeWidth={sw} strokeLinecap="round" />
          {p.value !== null && frac(p.value) > 0 && <path d={arc(frac(p.value))} fill="none" stroke={color} strokeWidth={sw} strokeLinecap="round" />}
          {p.target !== undefined && p.target !== null && (() => {
            const f = frac(p.target); const [x1, y1] = [cx - (R - sw) * Math.cos(Math.PI * f), cy - (R - sw) * Math.sin(Math.PI * f)]; const [x2, y2] = [cx - (R + sw) * Math.cos(Math.PI * f), cy - (R + sw) * Math.sin(Math.PI * f)];
            return <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={th.ink} strokeWidth={2} strokeLinecap="round"><title>{`Cible : ${fmt(p.target)}${unit}`}</title></line>;
          })()}
          <text x={cx} y={cy - 8} textAnchor="middle" className="viz-gauge-value" fill={th.ink}>{p.value === null ? '—' : `${fmt(p.value)}${unit}`}</text>
          <text x={cx - R} y={cy + 14} textAnchor="middle" className="viz-axis-text" fill={th.axis}>{fmt(lo)}</text>
          <text x={cx + R} y={cy + 14} textAnchor="middle" className="viz-axis-text" fill={th.axis}>{fmt(hi)}</text>
        </svg>
        <div className="viz-gauge-foot">
          <StateLine tone={st.tone} label={st.label} />
          {p.target !== undefined && p.target !== null && <span className="small muted">Cible : {fmt(p.target)}{unit}{p.targetLabel ? ` — ${p.targetLabel}` : ''}</span>}
        </div>
      </div>
    </VizFrame>
  );
}
