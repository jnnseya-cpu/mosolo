import type { TooltipProps } from 'recharts';
import { useApp } from '../context';
import { categorical, chartTheme } from '../lib/palette';

export function useChartColors() {
  const { resolvedTheme } = useApp();
  const dark = resolvedTheme === 'dark';
  return { cat: categorical(dark), theme: chartTheme(dark), dark };
}

/** Infobulle sobre : libellé + valeurs formatées, pastille de couleur à côté du texte (texte en encre). */
export function ChartTooltip({ active, payload, label, format }: TooltipProps<number, string> & { format?: (v: number, name?: string) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      {label !== undefined && <p className="chart-tip-label">{String(label)}</p>}
      <ul>
        {payload.map((p) => (
          <li key={String(p.dataKey ?? p.name)}>
            <span className="chart-tip-dot" style={{ background: String(p.color ?? (p.payload as { fill?: string } | undefined)?.fill ?? '#999') }} aria-hidden="true" />
            <span className="chart-tip-name">{p.name}</span>
            <span className="chart-tip-val">{format ? format(Number(p.value), String(p.name)) : String(p.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
