import type { ReactNode } from 'react';

export interface Column<T> { key: string; label: string; render: (row: T) => ReactNode; num?: boolean; primary?: boolean; full?: boolean }

/** Tableau aligné (chiffres tabulaires) qui se replie en cartes sur petit écran. */
export function DataTable<T>({ columns, rows, rowKey, caption, empty }: {
  columns: Column<T>[]; rows: T[]; rowKey: (r: T) => string; caption?: string; empty?: ReactNode;
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <div className="rtable-wrap">
      <table className="data-table rtable">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>{columns.map((c) => <th key={c.key} scope="col" className={c.num ? 'num' : undefined}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)}>
              {columns.map((c) => (
                <td key={c.key} data-label={c.label} className={`${c.num ? 'num' : ''} ${c.primary ? 'cell-primary' : ''} ${c.full ? 'cell-full' : ''}`}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
