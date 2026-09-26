import { useId, useState, type ReactNode } from 'react';
import { useApp } from '../context';
import { Icon } from './Icon';

export interface TableData { columns: string[]; rows: (string | number)[][] }

interface Props {
  title: string;
  subtitle?: string;
  example?: boolean;
  table: TableData;
  height?: number;
  actions?: ReactNode;
  legend?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Carte de graphique : titre, sous-titre, bascule « vue tableau » (accessibilité), mention EXEMPLE. */
export function ChartCard({ title, subtitle, example, table, height = 280, actions, legend, children, className }: Props) {
  const { tr } = useApp();
  const [asTable, setAsTable] = useState(false);
  const id = useId();
  return (
    <section className={`panel chart-card ${className ?? ''}`} aria-labelledby={id}>
      <header className="panel-head">
        <div>
          <h2 className="panel-title" id={id}>{title}</h2>
          {subtitle && <p className="panel-sub">{subtitle}</p>}
        </div>
        <div className="panel-tools">
          {example && <span className="ribbon" title={tr('common.example')}>{tr('common.exampleShort')}</span>}
          {actions}
          <button type="button" className="btn btn-ghost btn-sm" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
            <Icon name={asTable ? 'chart' : 'table'} size={16} /> {asTable ? tr('chart.showChart') : tr('chart.showTable')}
          </button>
        </div>
      </header>
      {asTable ? (
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
          <div className="chart-box" style={{ height }} role="img" aria-label={`${title}${subtitle ? ` — ${subtitle}` : ''}. ${tr('chart.tableHint')}`}>
            {children}
          </div>
        </>
      )}
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
