/**
 * Cartes de chaleur : HeatGrid (les 24 communes de Kinshasa, disposition schématique) et MatrixHeat (matrice
 * lignes × colonnes, ex. jour × heure). Rampe séquentielle mono-teinte sélectionnée par mode (7 classes), échelle de
 * légende, cellules « non mesuré » hachurées et nommées, encre choisie selon l'aplat, infobulle par cellule.
 */
import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { inkOn } from '../../lib/palette';
import { fmtNombre, TipBody, useElementWidth, useVizTheme, useVizTip, VizFrame, type Formatter, type VizFrameProps, type VizTheme } from './core';
import { COMMUNE_ABBR, COMMUNE_LAYOUT, COMMUNES_KINSHASA } from './communes';

/** Classe (0 → 6) d'une valeur sur le domaine ; null si non mesurée. */
export function heatStep(v: number | null | undefined, [lo, hi]: [number, number], steps = 7): number | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  if (hi <= lo) return steps - 1;
  return Math.max(0, Math.min(steps - 1, Math.floor(((v - lo) / (hi - lo)) * steps)));
}

function domainOf(values: (number | null | undefined)[], domain?: [number, number]): [number, number] {
  if (domain) return domain;
  const nums = values.filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
  return nums.length ? [Math.min(0, ...nums), Math.max(...nums)] : [0, 1];
}

export function ScaleLegend({ th, domain, format, unit, showUnmeasured }: { th: VizTheme; domain: [number, number]; format: Formatter; unit?: string; showUnmeasured: boolean }) {
  const u = unit ? (unit === '%' ? ' %' : ` ${unit}`) : '';
  return (
    <div className="viz-scale" aria-label={`Échelle : de ${format(domain[0])}${u} (clair) à ${format(domain[1])}${u} (foncé)`}>
      <span className="viz-num">{format(domain[0])}{u}</span>
      <span className="viz-scale-ramp" aria-hidden="true">{th.seq.map((c) => <i key={c} style={{ background: c }} />)}</span>
      <span className="viz-num">{format(domain[1])}{u}</span>
      {showUnmeasured && <span className="viz-scale-nm"><i className="viz-hatch" aria-hidden="true" /> non mesuré</span>}
    </div>
  );
}

export interface CommuneCell { commune: string; value: number | null; href?: string; detail?: string }

export interface HeatGridProps extends VizFrameProps {
  cells: readonly CommuneCell[];
  format?: Formatter;
  unit?: string;
  /** Domaine imposé (ex. [0, 100] pour un taux) ; défaut : 0 → maximum observé. */
  domain?: [number, number];
  /** Libellé de la mesure (« Rapproché », « Taux d'atteinte »). */
  measureLabel: string;
  /** Vignette : abréviations sur la grille géographique (aussi sur téléphone). */
  compact?: boolean;
  /** Motif affiché pour les communes sans valeur. */
  unmeasuredReason?: string;
  /** Lien de la vignette entière (mode compact). */
  href?: string;
}

/** Carte de chaleur des 24 communes : les communes absentes des données sont « non mesurées ». */
export function HeatGrid(p: HeatGridProps) {
  const th = useVizTheme();
  const tip = useVizTip();
  const [wref, width] = useElementWidth<HTMLDivElement>();
  // Disposition schématique (8 × 5) dès que la largeur permet des cases lisibles ; sinon grille fluide à noms complets.
  const geo = p.compact || width >= 600;
  const fmt = p.format ?? ((v: number) => fmtNombre(v));
  const u = p.unit ? (p.unit === '%' ? ' %' : ` ${p.unit}`) : '';
  const byName = new Map(p.cells.map((c) => [c.commune, c]));
  const extra = p.cells.filter((c) => !(COMMUNES_KINSHASA as readonly string[]).includes(c.commune)).map((c) => c.commune);
  const all: CommuneCell[] = [...COMMUNES_KINSHASA.map((n) => byName.get(n) ?? { commune: n, value: null }), ...extra.map((n) => byName.get(n)!)];
  const dom = domainOf(all.map((c) => c.value), p.domain);
  const anyMeasured = all.some((c) => c.value !== null);
  const anyUnmeasured = all.some((c) => c.value === null);
  const reason = p.unmeasuredReason ?? 'aucune donnée pour cette commune';
  const table = { columns: ['Commune', p.measureLabel], rows: all.map((c) => [c.commune, c.value === null ? `non mesuré — ${reason}` : `${fmt(c.value)}${u}`]) };
  const cellText = (c: CommuneCell) => (c.value === null ? `${c.commune} : non mesuré — ${reason}` : `${c.commune} : ${fmt(c.value)}${u}`);
  const tiles = all.map((c) => {
    const step = heatStep(c.value, dom);
    const fill = step === null ? th.unmeasured : th.seq[step]!;
    const pos = COMMUNE_LAYOUT[c.commune];
    const style = { background: fill, color: step === null ? 'var(--ink-2)' : inkOn(fill), ...(pos ? { '--gc': pos[0], '--gr': pos[1] } : {}) } as CSSProperties;
    const content = (
      <>
        <span className="viz-heat-name">{p.compact ? COMMUNE_ABBR[c.commune] ?? c.commune.slice(0, 3) : c.commune}</span>
        {!p.compact && <span className="viz-heat-val viz-num">{c.value === null ? 'n. m.' : `${fmt(c.value)}${p.unit === '%' ? u : ''}`}</span>}
      </>
    );
    const tipBody = <TipBody title={c.commune} rows={[{ label: p.measureLabel, value: c.value === null ? 'non mesuré' : `${fmt(c.value)}${u}` }]} note={c.value === null ? reason : c.detail} />;
    const cls = `viz-heat-cell${step === null ? ' is-unmeasured' : ''}`;
    return (
      <li key={c.commune} style={style} className={cls}>
        {c.href && !p.compact
          ? <Link to={c.href} aria-label={cellText(c)} {...tip.bind(tipBody)}>{content}</Link>
          : <span tabIndex={p.compact && p.href ? -1 : 0} role="img" aria-label={cellText(c)} {...tip.bind(tipBody)}>{content}</span>}
      </li>
    );
  });
  const grid = <div ref={wref}><ul className={`viz-heat${geo ? ' viz-heat-geo' : ''}${p.compact ? ' viz-heat-compact' : ''}`}>{tiles}</ul></div>;
  return (
    <VizFrame frame={{ ...p, unmeasured: p.unmeasured }} table={table} empty={false} role="group"
      ariaLabel={`${p.title} — ${p.measureLabel} par commune${anyMeasured ? '' : ' (aucune commune mesurée)'}. Vue tableau disponible.`}>
      <div className="viz-heat-wrap" ref={tip.ref}>
        {p.compact && p.href ? <Link to={p.href} className="viz-heat-link" aria-label={`${p.title} : ouvrir le classement des communes`}>{grid}</Link> : grid}
        {tip.node}
        <ScaleLegend th={th} domain={dom} format={fmt} unit={p.unit} showUnmeasured={anyUnmeasured} />
      </div>
    </VizFrame>
  );
}

export interface MatrixHeatProps extends VizFrameProps {
  rows: readonly string[];
  cols: readonly string[];
  /** values[ligne][colonne] ; null = non mesuré. */
  values: readonly (readonly (number | null)[])[];
  format?: Formatter;
  unit?: string;
  domain?: [number, number];
  measureLabel: string;
  /** N'afficher qu'une étiquette de colonne sur N (ex. 6 pour les heures). */
  colTickEvery?: number;
}

/** Matrice de chaleur générique (lignes × colonnes). */
export function MatrixHeat(p: MatrixHeatProps) {
  const th = useVizTheme();
  const tip = useVizTip();
  const fmt = p.format ?? ((v: number) => fmtNombre(v));
  const u = p.unit ? (p.unit === '%' ? ' %' : ` ${p.unit}`) : '';
  const flat = p.values.flat();
  const dom = domainOf(flat, p.domain);
  const every = p.colTickEvery ?? (p.cols.length > 12 ? 6 : 1);
  const empty = p.rows.length === 0 || p.cols.length === 0 || flat.every((v) => v === null);
  const table = { columns: ['', ...p.cols], rows: p.rows.map((r, i) => [r, ...p.cols.map((_, j) => { const v = p.values[i]?.[j]; return v === null || v === undefined ? 'n. m.' : fmt(v); })]) };
  return (
    <VizFrame frame={p} table={table} empty={empty} role="group">
      <div className="viz-matrix-wrap" ref={tip.ref}>
        <div className="viz-matrix" style={{ gridTemplateColumns: `auto repeat(${p.cols.length}, minmax(0, 1fr))` }}>
          <span />
          {p.cols.map((c, j) => <span key={c} className="viz-matrix-col viz-num" aria-hidden="true">{j % every === 0 ? c : ''}</span>)}
          {p.rows.map((r, i) => (
            <div key={r} className="viz-matrix-row" style={{ display: 'contents' }}>
              <span className="viz-matrix-rowlabel">{r}</span>
              {p.cols.map((c, j) => {
                const v = p.values[i]?.[j] ?? null;
                const step = heatStep(v, dom);
                return (
                  <span key={c} role="img" tabIndex={0} className={`viz-matrix-cell${step === null ? ' is-unmeasured' : ''}`} style={{ background: step === null ? th.unmeasured : th.seq[step] }}
                    aria-label={`${r}, ${c} : ${v === null ? 'non mesuré' : `${fmt(v)}${u}`}`}
                    {...tip.bind(<TipBody title={`${r} · ${c}`} rows={[{ label: p.measureLabel, value: v === null ? 'non mesuré' : `${fmt(v)}${u}` }]} />)} />
                );
              })}
            </div>
          ))}
        </div>
        {tip.node}
        <ScaleLegend th={th} domain={dom} format={fmt} unit={p.unit} showUnmeasured={flat.some((v) => v === null)} />
      </div>
    </VizFrame>
  );
}
