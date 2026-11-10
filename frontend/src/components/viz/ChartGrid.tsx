/**
 * Grille de cartes de graphiques (ChartGrid) : une colonne sur téléphone, puis autant de colonnes que la largeur
 * minimale le permet. Les enfants peuvent s'étendre avec la classe `viz-span-2` ou `viz-span-all`.
 */
import type { CSSProperties, ReactNode } from 'react';

export function ChartGrid({ children, min = 320, label, className }: { children: ReactNode; min?: number; label?: string; className?: string }) {
  return (
    <div className={`viz-grid ${className ?? ''}`} style={{ '--viz-min': `${min}px` } as CSSProperties} role={label ? 'region' : undefined} aria-label={label}>
      {children}
    </div>
  );
}
