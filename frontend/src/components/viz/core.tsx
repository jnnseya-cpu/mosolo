/**
 * Trousse de visualisation — socle commun : thème (clair / sombre sélectionnés), formats français, états (chargement,
 * vide, erreur, non mesuré), infobulle des graphiques maison et infobulle Recharts, cadre de carte (ChartCard étendue).
 * Règles : docs/document-maitre/charte-visualisation.md.
 */
import { useCallback, useEffect, useRef, useState, type FocusEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import type { TooltipProps } from 'recharts';
import { useApp } from '../../context';
import { categorical, chartTheme, DEEMPH, ordinalLadder, sequential, STATUS, UNMEASURED } from '../../lib/palette';
import { compact } from '../../lib/money';
import { ChartCard, Legend, type TableData } from '../ChartCard';
import { ErrorState } from '../States';
import { Icon } from '../Icon';

// ————————————————————————— thème —————————————————————————

export interface VizTheme {
  dark: boolean;
  /** Catégorielle validée, ordre fixe (jamais recyclée) : 8 emplacements. */
  cat: readonly string[];
  /** Séquentielle mono-teinte (7 pas), sélectionnée pour le mode. */
  seq: readonly string[];
  /** Ordinale des six états de la recette. */
  ordinal: readonly string[];
  deemph: string;
  unmeasured: string;
  status: typeof STATUS;
  grid: string; axis: string; ink: string; surface: string; reference: string;
}

export function vizTheme(dark: boolean): VizTheme {
  return {
    dark, cat: categorical(dark), seq: sequential(dark), ordinal: ordinalLadder(dark),
    deemph: dark ? DEEMPH.dark : DEEMPH.light, unmeasured: dark ? UNMEASURED.dark : UNMEASURED.light, status: STATUS, ...chartTheme(dark),
  };
}

/** Thème de la trousse selon le mode résolu (clair, sombre ou système). */
export function useVizTheme(): VizTheme {
  const { resolvedTheme } = useApp();
  return vizTheme(resolvedTheme === 'dark');
}

// ————————————————————————— formats —————————————————————————

export type Formatter = (v: number) => string;

/** Nombre français (espaces fines, virgule décimale). */
export const fmtNombre = (v: number, digits = 1): string => v.toLocaleString('fr-FR', { maximumFractionDigits: digits });
/** Nombre compact (« 4,82 Md », « 17,8 M »). */
export const fmtCompact: Formatter = (v) => compact(v, 'fr');
/** Pourcentage (« 64,2 % »). */
export const fmtPct = (v: number, digits = 1): string => `${fmtNombre(v, digits)} %`;
/** Montant compact avec sa devise (une seule devise par série). */
export const fmtDevise = (currency: string): Formatter => (v) => `${compact(v, 'fr')} ${currency}`;

/** Valeur + unité, avec « non mesuré » pour une valeur absente. */
export function fmtValeur(v: number | null | undefined, format: Formatter = (x) => fmtNombre(x), unit?: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'non mesuré';
  return unit ? `${format(v)} ${unit}` : format(v);
}

// ————————————————————————— états —————————————————————————

/** Props d'état communes à tous les composants de la trousse. */
export interface VizStateProps {
  /** Chargement en cours (sans données précédentes). */
  loading?: boolean;
  /** Erreur de chargement (ApiError, NetworkError…). */
  error?: unknown;
  onRetry?: () => void;
  /** Mesure indisponible : le motif est affiché tel quel (ex. « Aucune assignation certifiée »). */
  unmeasured?: string;
  /** Texte de l'état vide (défaut : « Aucune donnée pour cette période »). */
  emptyText?: string;
}

export const TEXTE_VIDE = 'Aucune donnée pour cette période';

/** Contenu d'un état non « prêt », ou null si le graphique peut être dessiné. */
export function vizPlaceholder(s: VizStateProps, empty: boolean): ReactNode | null {
  if (s.loading) return <VizLoading />;
  if (s.error !== undefined && s.error !== null) return <ErrorState error={s.error} onRetry={s.onRetry} />;
  if (s.unmeasured) return <VizUnmeasured reason={s.unmeasured} />;
  if (empty) return <VizEmpty text={s.emptyText} />;
  return null;
}

export function VizLoading({ label = 'Chargement du graphique…' }: { label?: string }) {
  return <div className="viz-state viz-state-loading" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" /><span>{label}</span></div>;
}
export function VizEmpty({ text = TEXTE_VIDE }: { text?: string }) {
  return <div className="viz-state viz-state-empty" role="status"><Icon name="chart" size={20} /><span>{text}</span></div>;
}
export function VizUnmeasured({ reason }: { reason: string }) {
  return (
    <div className="viz-state viz-state-unmeasured" role="status">
      <Icon name="question" size={20} />
      <span><strong>Non mesuré</strong> — {reason}</span>
    </div>
  );
}

// ————————————————————————— cadre —————————————————————————

/** Props de cadre communes (titre, mention d'exemple, outils). */
export interface VizFrameProps extends VizStateProps {
  title: string;
  subtitle?: string;
  /** Données d'exemple : ruban « EXEMPLE — non opposable » et mention dans la description lue. */
  example?: boolean;
  exampleLabel?: string;
  className?: string;
  actions?: ReactNode;
  /** Note sous le graphique (source, règle de lecture). */
  note?: ReactNode;
  /**
   * false : pas de carte (graphique incrusté dans un bloc existant). Le titre devient l'étiquette accessible et la
   * vue tableau reste disponible par un bouton compact.
   */
  framed?: boolean;
}

export interface LegendItem { label: string; color: string; dashed?: boolean }

/**
 * Cadre commun : ChartCard (titre, bascule tableau, EXEMPLE) avec états, ou version incrustée (framed=false).
 * `role` : « img » pour un dessin non interactif au clavier, « group » quand les marques sont focalisables.
 */
export function VizFrame({ frame, table, legend, empty, height = 'auto', role = 'group', ariaLabel, children }: {
  frame: VizFrameProps; table: TableData; legend?: LegendItem[]; empty: boolean; height?: number | 'auto'; role?: 'img' | 'group'; ariaLabel?: string; children: ReactNode;
}) {
  const placeholder = vizPlaceholder(frame, empty);
  const label = ariaLabel ?? `${frame.title}${frame.subtitle ? ` — ${frame.subtitle}` : ''}${frame.example ? ' (exemple, non opposable)' : ''}. Vue tableau disponible.`;
  const leg = legend && legend.length >= 2 ? <Legend items={legend} /> : undefined;
  const note = frame.note ? <div className="viz-note small muted">{frame.note}</div> : undefined;
  if (frame.framed === false) {
    return <VizInline title={frame.title} example={frame.example} table={table} placeholder={placeholder} legend={leg} role={role} label={label} note={note} className={frame.className} height={height}>{children}</VizInline>;
  }
  return (
    <ChartCard title={frame.title} subtitle={frame.subtitle} example={frame.example} exampleLabel={frame.exampleLabel} table={table} height={height} actions={frame.actions}
      legend={leg} className={`viz-card ${frame.className ?? ''}`} placeholder={placeholder ?? undefined} bodyRole={role} ariaLabel={label} footer={note}>
      {children}
    </ChartCard>
  );
}

function VizInline({ title, example, table, placeholder, legend, role, label, note, className, height, children }: {
  title: string; example?: boolean; table: TableData; placeholder: ReactNode | null; legend?: ReactNode; role: 'img' | 'group'; label: string; note?: ReactNode; className?: string; height: number | 'auto'; children: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <div className={`viz-inline ${className ?? ''}`}>
      {placeholder ? <><p className="viz-inline-title">{title}</p>{placeholder}</> : (
        <>
          <div className="viz-inline-tools">
            <p className="viz-inline-title">{title}</p>
            {example && <span className="ribbon">EXEMPLE</span>}
            <button type="button" className="btn btn-ghost btn-xs" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
              <Icon name={asTable ? 'chart' : 'table'} size={14} /> {asTable ? 'Graphique' : 'Tableau'}
            </button>
          </div>
          {asTable ? <VizTable title={title} table={table} /> : <>{legend}<div className="viz-body" style={height === 'auto' ? undefined : { height }} role={role} aria-label={label}>{children}</div></>}
        </>
      )}
      {note}
    </div>
  );
}

export function VizTable({ title, table }: { title: string; table: TableData }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <caption className="sr-only">{title}</caption>
        <thead><tr>{table.columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
        <tbody>{table.rows.map((r, i) => <tr key={i}>{r.map((v, j) => (j === 0 ? <th scope="row" key={j}>{v}</th> : <td key={j} className="num">{v}</td>))}</tr>)}</tbody>
      </table>
    </div>
  );
}

// ————————————————————————— infobulles —————————————————————————

export interface TipRow { label: string; value: string; color?: string; dashed?: boolean }

/** Corps d'infobulle : la valeur d'abord (forte), le libellé ensuite ; clé en trait court de la couleur de la série. */
export function TipBody({ title, rows, note }: { title?: string; rows: TipRow[]; note?: string }) {
  return (
    <>
      {title && <p className="viz-tip-title">{title}</p>}
      <ul>
        {rows.map((r) => (
          <li key={r.label}>
            {r.color ? <span className={`viz-tip-key${r.dashed ? ' dashed' : ''}`} style={{ borderColor: r.color }} aria-hidden="true" /> : <span />}
            <strong className="viz-tip-val">{r.value}</strong>
            <span className="viz-tip-name">{r.label}</span>
          </li>
        ))}
      </ul>
      {note && <p className="viz-tip-note">{note}</p>}
    </>
  );
}

/**
 * Infobulle des graphiques maison (survol, toucher, focus clavier). Positionnée dans le conteneur `ref`, retournée
 * près des bords pour n'être jamais rognée.
 */
export function useVizTip() {
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; w: number; content: ReactNode } | null>(null);
  const show = useCallback((e: PointerEvent<Element> | FocusEvent<Element>, content: ReactNode) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const t = e.currentTarget.getBoundingClientRect();
    const pe = e as PointerEvent<Element>;
    const pointer = typeof pe.clientX === 'number' && pe.clientX > 0;
    const x = pointer ? pe.clientX - box.left : t.left + t.width / 2 - box.left;
    const y = pointer ? pe.clientY - box.top : t.top - box.top;
    setTip({ x, y, w: box.width, content });
  }, []);
  const hide = useCallback(() => setTip(null), []);
  const bind = (content: ReactNode) => ({
    onPointerEnter: (e: PointerEvent<Element>) => show(e, content),
    onPointerMove: (e: PointerEvent<Element>) => show(e, content),
    onPointerLeave: hide,
    onFocus: (e: FocusEvent<Element>) => show(e, content),
    onBlur: hide,
  });
  let node: ReactNode = null;
  if (tip) {
    const tx = tip.w > 0 && tip.x < tip.w * 0.3 ? '-12px' : tip.w > 0 && tip.x > tip.w * 0.7 ? 'calc(-100% + 12px)' : '-50%';
    const below = tip.y < 72;
    node = <div className="viz-tip" role="tooltip" style={{ left: tip.x, top: tip.y, transform: `translate(${tx}, ${below ? '16px' : 'calc(-100% - 10px)'})` }}>{tip.content}</div>;
  }
  return { ref, bind, hide, node, active: tip !== null };
}

/** Infobulle Recharts de la trousse (même hiérarchie que TipBody). */
export function RechartsTip({ active, payload, label, format, labelFormat, note }: TooltipProps<number, string> & { format: (v: number, name: string) => string; labelFormat?: (l: string) => string; note?: string }) {
  if (!active || !payload?.length) return null;
  const rows: TipRow[] = payload.filter((p) => p.value !== null && p.value !== undefined).map((p) => ({
    label: String(p.name), value: format(Number(p.value), String(p.name)),
    color: String(p.color ?? (p.payload as { fill?: string } | undefined)?.fill ?? '#999'),
  }));
  const l = label === undefined ? undefined : labelFormat ? labelFormat(String(label)) : String(label);
  return <div className="viz-tip viz-tip-static"><TipBody title={l} rows={rows} note={note} /></div>;
}

/** Largeur d'un élément (ResizeObserver) : sert aux choix « téléphone d'abord » (largeur d'axe, étiquettes). */
export function useElementWidth<T extends HTMLElement>(): [RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => { const e = entries[0]; if (e) setW(e.contentRect.width); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Série : clé stable, libellé français ; la couleur suit l'ordre déclaré (jamais le rang de la valeur). */
export interface SeriesDef { key: string; label: string; color?: string }

/**
 * Replie les séries au-delà de `max` dans « Autres » (somme, gris de retrait) — jamais une 9e teinte.
 */
export function foldSeries<R extends { values: Record<string, number | null> }>(rows: readonly R[], series: readonly SeriesDef[], max: number, deemph: string): { rows: R[]; series: SeriesDef[]; folded: string[] } {
  if (series.length <= max) return { rows: [...rows], series: [...series], folded: [] };
  const keep = series.slice(0, max - 1);
  const rest = series.slice(max - 1);
  const other: SeriesDef = { key: '__autres', label: 'Autres', color: deemph };
  return {
    series: [...keep, other],
    folded: rest.map((s) => s.label),
    rows: rows.map((r) => {
      const vals = rest.map((s) => r.values[s.key]).filter((v): v is number => v !== null && v !== undefined);
      return { ...r, values: { ...r.values, __autres: vals.length ? vals.reduce((a, b) => a + b, 0) : null } };
    }),
  };
}

/** Largeur d'axe des catégories : assez pour le plus long libellé, bornée à 40 % de la largeur disponible. */
export function categoryAxisWidth(labels: readonly string[], width: number, fontPx = 11.5): number {
  const longest = labels.reduce((m, l) => Math.max(m, l.length), 0);
  const want = Math.ceil(longest * fontPx * 0.56) + 10;
  const cap = width > 0 ? Math.max(72, Math.floor(width * 0.4)) : 160;
  return Math.min(Math.max(48, want), cap);
}

/** Tronque un libellé d'axe (le libellé complet reste dans l'infobulle et la vue tableau). */
export function clip(label: string, maxChars: number): string {
  return label.length > maxChars ? `${label.slice(0, Math.max(1, maxChars - 1))}…` : label;
}

/** Définition SVG du motif hachuré « non mesuré » (45°, ton sur ton). */
export function HatchDef({ id, color, bg }: { id: string; color: string; bg: string }) {
  return (
    <defs>
      <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="6" height="6" fill={bg} />
        <line x1="0" y1="0" x2="0" y2="6" stroke={color} strokeWidth="1.5" />
      </pattern>
    </defs>
  );
}
