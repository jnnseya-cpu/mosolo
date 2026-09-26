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
