/**
 * Palettes de visualisation validées (skill dataviz, scripts/validate_palette.js).
 * Catégorielle claire : ordre fixé par la charte Ville de Kinshasa, jamais recyclé.
 *   Avertissements assumés : or (#E0A526) et rose (#e87ba4) < 3:1 sur surface claire,
 *   paire vert/rouge (7-8) en bande CVD 6–8 → étiquettes directes et vue tableau obligatoires.
 * Catégorielle sombre : mêmes teintes, pas ajustés pour la surface sombre #141A33
 *   (bande de luminance, contraste ≥ 3:1 ; paire 7-8 en bande 6–8 → même encodage secondaire).
 */
export const CATEGORICAL_LIGHT = ['#1E9BD7', '#E0A526', '#4453b5', '#eb6834', '#8a5cc2', '#e87ba4', '#1E8C3A', '#e34948'] as const;
export const CATEGORICAL_DARK = ['#1E9BD7', '#b98300', '#7080e6', '#d65a2c', '#9468d6', '#d05f89', '#187832', '#e8665a'] as const;

/** Couleurs d'état réservées — toujours accompagnées d'une icône et d'un libellé. */
export const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' } as const;
export type StatusTone = keyof typeof STATUS;
export const STATUS_ICON: Record<StatusTone | 'info' | 'neutral', string> = {
  good: 'check', warning: 'alert', serious: 'alert', critical: 'x', info: 'info', neutral: 'mark',
};

/** Rampe séquentielle mono-teinte (bleu marine), clair → foncé. */
export const SEQ_NAVY = ['#E3EAF7', '#C3D0EE', '#97ACE0', '#6A85CC', '#4A64B4', '#34469A', '#232C6B'] as const;

export function categorical(dark: boolean): readonly string[] {
  return dark ? CATEGORICAL_DARK : CATEGORICAL_LIGHT;
}

export function chartTheme(dark: boolean) {
  return {
    grid: dark ? '#252D4D' : '#E6E9F0',
    axis: dark ? '#A7AEC4' : '#4A4F5C',
    ink: dark ? '#EEF1F8' : '#111111',
    surface: dark ? '#141A33' : '#FFFFFF',
    reference: dark ? '#A7AEC4' : '#4A4F5C',
  };
}

// ————————————————————————— trousse de visualisation (27/09/2026) —————————————————————————
// Ajouts : rien de ce qui précède n'est modifié. Validation : docs/document-maitre/charte-visualisation.md.

/**
 * Rampe séquentielle SÉLECTIONNÉE pour le mode sombre (même teinte marine, OKLCH h 272) : l'ancre s'inverse,
 * faible = sombre (≥ 2:1 sur la surface #141A33), fort = clair ; validée `--ordinal --mode dark` (ΔL ≥ 0,06). SEQ_NAVY n'est pas réutilisée en sombre (pas d'inversion automatique).
 */
export const SEQ_NAVY_DARK = ['#455390', '#5969a7', '#6e7fbf', '#8496d8', '#9badf1', '#b2c5ff', '#cadeff'] as const;

/**
 * Rampe ORDINALE des six états de la recette (potentiel → disponible) : une teinte, pas de luminance réguliers (ΔL 0,08).
 * Validée `--ordinal` : clair (surface #FFFFFF, extrémité claire 2,53:1) et sombre (surface #141A33, 2,45:1).
 * Clair : l'état le plus avancé est le plus foncé ; sombre : le plus clair.
 */
export const ORDINAL_LADDER_LIGHT = ['#8a9ff0', '#7386d5', '#5c6eba', '#4757a1', '#324087', '#20296f'] as const;
export const ORDINAL_LADDER_DARK = ['#44549d', '#596bb7', '#7083d2', '#879cec', '#a0b6ff', '#b8cfff'] as const;

/** Gris de mise en retrait (« Autres », contexte) et fond « non mesuré » (toujours avec libellé et motif). */
export const DEEMPH = { light: '#A9B0C0', dark: '#5A6385' } as const;
export const UNMEASURED = { light: '#E6E9F0', dark: '#252D4D' } as const;

export function sequential(dark: boolean): readonly string[] {
  return dark ? SEQ_NAVY_DARK : SEQ_NAVY;
}
export function ordinalLadder(dark: boolean): readonly string[] {
  return dark ? ORDINAL_LADDER_DARK : ORDINAL_LADDER_LIGHT;
}

/** Encre lisible (blanc ou encre) sur un aplat, choisie par la luminance relative de l'aplat. */
export function inkOn(fill: string): string {
  const h = fill.replace('#', '');
  if (h.length !== 6) return '#111111';
  const ch = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  // Seuil d'égal contraste entre le blanc et l'encre #111111.
  return lum > 0.18 ? '#111111' : '#FFFFFF';
}
