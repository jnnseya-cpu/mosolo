import type { ReactNode } from 'react';
import { STATUS_ICON, type StatusTone } from '../lib/palette';
import { Icon } from './Icon';

export type Tone = StatusTone | 'info' | 'neutral';

/** Pastille d'état : couleur + icône + libellé (jamais la couleur seule). */
export function StatusBadge({ tone, label, icon, title }: { tone: Tone; label: ReactNode; icon?: string; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      <Icon name={icon ?? STATUS_ICON[tone]} size={14} className="badge-icon" />
      <span>{label}</span>
    </span>
  );
}

export function Chip({ children, color, title }: { children: ReactNode; color?: string; title?: string }) {
  return (
    <span className="chip" title={title}>
      {color && <span className="chip-dot" style={{ background: color }} aria-hidden="true" />}
      {children}
    </span>
  );
}
