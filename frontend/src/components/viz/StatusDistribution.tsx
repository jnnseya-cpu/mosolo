/**
 * Répartition par état (StatusDistribution) : une barre horizontale empilée aux couleurs d'état réservées, chaque
 * segment doublé d'une icône et d'un libellé dans la liste (jamais la couleur seule). 2 px de surface entre segments,
 * extrémités arrondies 4 px, infobulle au survol, au toucher et au clavier.
 */
import { share } from '../../lib/aggregate';
import { STATUS_ICON } from '../../lib/palette';
import { Icon } from '../Icon';
import type { Tone } from '../StatusBadge';
import { fmtNombre, fmtPct, TipBody, useVizTheme, useVizTip, VizFrame, type Formatter, type VizFrameProps } from './core';

export interface StatusItem {
  key: string;
  label: string;
  count: number;
  tone: Tone;
  /** Icône imposée (défaut : icône de l'état). */
  icon?: string;
}

/** Préréglage des états de paiement (libellés français d'abord). */
export const ETATS_PAIEMENT: Record<string, { label: string; tone: Tone }> = {
  PAYE: { label: 'Payé', tone: 'good' },
  EN_ATTENTE: { label: 'En attente', tone: 'warning' },
  IMPAYE: { label: 'Impayé', tone: 'critical' },
};

export interface StatusDistributionProps extends VizFrameProps {
  items: readonly StatusItem[];
  format?: Formatter;
  /** Unité comptée (« paiements », « indicateurs »). */
  unitLabel?: string;
}

export function StatusDistribution(p: StatusDistributionProps) {
  const th = useVizTheme();
  const tip = useVizTip();
  const fmt = p.format ?? ((v: number) => fmtNombre(v, 0));
  const total = p.items.reduce((s, i) => s + Math.max(0, i.count), 0);
  const pcts = share(p.items.map((i) => i.count), 0);
  const color = (t: Tone) => (t === 'good' || t === 'warning' || t === 'serious' || t === 'critical' ? th.status[t] : t === 'info' ? th.cat[0]! : th.deemph);
  const table = { columns: ['État', 'Nombre', 'Part'], rows: p.items.map((i, k) => [i.label, fmt(i.count), pcts[k] === null ? '—' : fmtPct(pcts[k]!, 0)]) };
  const visible = p.items.filter((i) => i.count > 0);
  return (
    <VizFrame frame={p} table={table} empty={total === 0} role="group"
      ariaLabel={`${p.title} : ${p.items.map((i, k) => `${i.label} ${fmt(i.count)} (${pcts[k] ?? 0} %)`).join(', ')}${p.example ? ' (exemple, non opposable)' : ''}`}>
      <div className="viz-status" ref={tip.ref}>
        <div className="viz-status-bar" style={{ background: th.surface }}>
          {visible.map((i) => {
            const k = p.items.indexOf(i);
            return (
              <span key={i.key} className="viz-status-seg" role="img" tabIndex={0} style={{ flexGrow: i.count, background: color(i.tone) }}
                aria-label={`${i.label} : ${fmt(i.count)}${p.unitLabel ? ` ${p.unitLabel}` : ''}, ${pcts[k] ?? 0} %`}
                {...tip.bind(<TipBody title={i.label} rows={[{ label: p.unitLabel ?? 'nombre', value: `${fmt(i.count)} · ${fmtPct(pcts[k] ?? 0, 0)}`, color: color(i.tone) }]} />)} />
            );
          })}
        </div>
        {tip.node}
        <ul className="viz-status-list">
          {p.items.map((i, k) => (
            <li key={i.key}>
              <span className={`viz-status-key badge badge-${i.tone}`}><Icon name={i.icon ?? STATUS_ICON[i.tone]} size={14} className="badge-icon" /><span>{i.label}</span></span>
              <strong className="viz-num">{fmt(i.count)}</strong>
              <span className="small muted viz-num">{pcts[k] === null ? '—' : fmtPct(pcts[k]!, 0)}</span>
            </li>
          ))}
        </ul>
      </div>
    </VizFrame>
  );
}
