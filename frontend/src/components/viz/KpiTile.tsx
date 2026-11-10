/**
 * Tuile d'indicateur (KpiTile) et grille de tuiles (KpiGrid, 2 à 6 colonnes selon la largeur).
 * Contrat : libellé (sans deux-points) · valeur héroïque avec unité (chiffres proportionnels) · état / libellé ·
 * écart facultatif à la période précédente (icône + texte, sens favorable) · courbe miniature facultative ·
 * jauge de cible facultative. États : chargement, non mesuré (avec motif), erreur.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Trend } from '../../lib/aggregate';
import { StatusBadge, type Tone } from '../StatusBadge';
import { Icon } from '../Icon';
import { describeError } from '../../lib/api';
import { fmtNombre, type Formatter } from './core';
import { Sparkline, TrendBadge, type Better } from './Sparkline';
import { ProgressMeter } from './Meters';

export interface KpiTileProps {
  label: string;
  /** Valeur (nombre formaté par `format`, ou texte déjà formaté) ; null = non mesuré. */
  value: number | string | null;
  unit?: string;
  format?: Formatter;
  /** État ou nature du chiffre (« Encaissé », « Rapproché », « Estimation »…), avec son ton. */
  state?: { label: string; tone?: Tone };
  /** Écart à la période précédente. */
  delta?: { trend?: Trend; current?: number | null; previous?: number | null; versus: string; better?: Better; absolute?: boolean; format?: Formatter };
  /** Courbe miniature (12 points conseillés). */
  spark?: { values: readonly (number | null)[]; labels?: readonly string[]; label?: string; format?: Formatter };
  /** Jauge de cible (valeur comparée à `target`). */
  target?: { value: number; label?: string; better?: Better; max?: number };
  /** Ligne secondaire (comparaison, date, source…). */
  sub?: ReactNode;
  /** Lien vers le détail (source du chiffre). */
  href?: string;
  example?: boolean;
  loading?: boolean;
  error?: unknown;
  /** Motif quand la valeur n'est pas mesurée. */
  reason?: string;
  /** Mise en avant (tuile héroïque, une seule par vue). */
  hero?: boolean;
  className?: string;
}

export function KpiTile(p: KpiTileProps) {
  const fmt = p.format ?? ((v: number) => fmtNombre(v));
  const unmeasured = p.value === null || (typeof p.value === 'number' && !Number.isFinite(p.value));
  const valueText = unmeasured ? 'Non mesuré' : typeof p.value === 'number' ? fmt(p.value) : String(p.value);
  const title = p.href ? <Link to={p.href} className="viz-kpi-link">{p.label}<Icon name="chevronRight" size={14} /></Link> : p.label;
  const body = p.loading ? (
    <p className="viz-kpi-value viz-kpi-loading" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" /> <span className="small muted">Chargement…</span></p>
  ) : p.error ? (
    <p className="viz-kpi-error small" role="alert"><Icon name="alert" size={14} /> Indisponible : {describeError(p.error).message}</p>
  ) : (
    <>
      <p className={`viz-kpi-value${unmeasured ? ' is-unmeasured' : ''}`}>
        <span>{valueText}</span>{!unmeasured && p.unit && <small className="viz-kpi-unit"> {p.unit}</small>}
      </p>
      {unmeasured && <p className="small muted viz-kpi-reason">{p.reason ?? 'Mesure indisponible.'}</p>}
      <div className="viz-kpi-foot">
        {p.state && <StatusBadge tone={p.state.tone ?? 'neutral'} label={p.state.label} />}
        {p.example && <StatusBadge tone="neutral" label="[EXEMPLE]" />}
        {p.delta && !unmeasured && <TrendBadge trend={p.delta.trend} current={p.delta.current} previous={p.delta.previous} versus={p.delta.versus} better={p.delta.better} absolute={p.delta.absolute} format={p.delta.format ?? fmt} />}
      </div>
      {p.spark && <div className="viz-kpi-spark"><Sparkline values={p.spark.values} labels={p.spark.labels} label={p.spark.label ?? p.label} format={p.spark.format ?? fmt} area /></div>}
      {p.target && !unmeasured && typeof p.value === 'number' && (
        <ProgressMeter label={`${p.label} — progression vers la cible`} hideLabel compact value={p.value} target={p.target.value} targetLabel={p.target.label} better={p.target.better} max={p.target.max} unit={p.unit} format={fmt} />
      )}
      {p.sub && <div className="viz-kpi-sub">{p.sub}</div>}
    </>
  );
  return (
    <article className={`viz-kpi${p.hero ? ' viz-kpi-hero' : ''}${p.example ? ' is-example' : ''} ${p.className ?? ''}`} aria-label={`${p.label} : ${valueText}${!unmeasured && p.unit ? ` ${p.unit}` : ''}${p.state ? ` — ${p.state.label}` : ''}${p.example ? ' (exemple)' : ''}`}>
      <h3 className="viz-kpi-label">{title}</h3>
      {body}
    </article>
  );
}

/** Grille responsive de tuiles : 2 colonnes sur téléphone, jusqu'à `max` (2 à 6) sur grand écran. */
export function KpiGrid({ children, max = 4, label, className }: { children: ReactNode; max?: 2 | 3 | 4 | 5 | 6; label?: string; className?: string }) {
  return <div className={`viz-kpi-grid viz-cols-${max} ${className ?? ''}`} role="group" aria-label={label ?? 'Indicateurs clés'}>{children}</div>;
}
