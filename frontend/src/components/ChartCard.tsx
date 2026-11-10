import { useId, useState, type ReactNode } from 'react';
import { useApp } from '../context';
import { Icon } from './Icon';

export interface TableData { columns: string[]; rows: (string | number)[][] }

interface Props {
  title: string;
  subtitle?: string;
  example?: boolean;
  table: TableData;
  /** Hauteur du graphique (axe compris) ; « auto » laisse le contenu fixer la hauteur (trousse de visualisation). */
  height?: number | 'auto';
  actions?: ReactNode;
  legend?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * Trousse de visualisation (27/09/2026) — ajouts facultatifs, sans effet sur les usages existants :
   * `placeholder` remplace le graphique (chargement, vide, erreur, non mesuré) et masque la bascule tableau ;
   * `bodyRole` « group » pour un graphique dont les marques sont focalisables (l'image reste le défaut) ;
   * `ariaLabel` remplace la description lue ; `footer` s'affiche sous le graphique comme sous le tableau ;
   * `exampleLabel` précise la mention d'exemple.
   */
  placeholder?: ReactNode;
  bodyRole?: 'img' | 'group';
  ariaLabel?: string;
  footer?: ReactNode;
  exampleLabel?: string;
}

/** Carte de graphique : titre, sous-titre, bascule « vue tableau » (accessibilité), mention EXEMPLE. */
export function ChartCard({ title, subtitle, example, table, height = 280, actions, legend, children, className, placeholder, bodyRole = 'img', ariaLabel, footer, exampleLabel }: Props) {
  const { tr } = useApp();
  const [asTable, setAsTable] = useState(false);
  const id = useId();
  const label = ariaLabel ?? `${title}${subtitle ? ` — ${subtitle}` : ''}. ${tr('chart.tableHint')}`;
  return (
    <section className={`panel chart-card ${className ?? ''}`} aria-labelledby={id}>
      <header className="panel-head">
        <div>
          <h2 className="panel-title" id={id}>{title}</h2>
          {subtitle && <p className="panel-sub">{subtitle}</p>}
        </div>
        <div className="panel-tools">
          {example && <span className="ribbon" title={exampleLabel ?? tr('common.example')}>{tr('common.exampleShort')}</span>}
          {actions}
          {!placeholder && (
            <button type="button" className="btn btn-ghost btn-sm" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
              <Icon name={asTable ? 'chart' : 'table'} size={16} /> {asTable ? tr('chart.showChart') : tr('chart.showTable')}
            </button>
          )}
        </div>
      </header>
      {placeholder ? placeholder : asTable ? (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="sr-only">{title}</caption>
            <thead><tr>{table.columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>{r.map((v, j) => (j === 0 ? <th scope="row" key={j}>{v}</th> : <td key={j} className="num">{v}</td>))}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          {legend}
          <div className="chart-box" style={height === 'auto' ? undefined : { height }} role={bodyRole} aria-label={label}>
            {children}
          </div>
        </>
      )}
      {footer}
    </section>
  );
}

export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <ul className="legend" aria-label="Légende">
      {items.map((i) => (
        <li key={i.label}>
          <span className={`legend-swatch ${i.dashed ? 'dashed' : ''}`} style={{ background: i.dashed ? undefined : i.color, borderColor: i.color }} aria-hidden="true" />
          {i.label}
        </li>
      ))}
    </ul>
  );
}
