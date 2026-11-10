/**
 * Utilitaires communs du module « parcours du citoyen » (Spécification fonctionnelle, modules 1 à 12) : accès typés
 * aux services des autres modules (jamais un circuit parallèle), valeurs par défaut signalées « à confirmer ».
 */
import type { AppContext } from '../../context.js';
import type { FiscalService } from '../fiscal/service.js';
import type { TitresService } from '../titres/service.js';
import type { VerticalesService } from '../verticales/service.js';
import type { AccesService } from '../acces/service.js';

/** Mention imposée par le maître d'ouvrage pour toute valeur non confirmée (CLAUDE.md). */
export const PAR_DEFAUT = 'par défaut — à confirmer par le maître d’ouvrage';

export interface ParametreParDefaut<T> {
  valeur: T;
  statut: 'PAR_DEFAUT_A_CONFIRMER';
  mention: string;
  source: string;
}

export const parDefaut = <T>(valeur: T, source: string): ParametreParDefaut<T> => ({ valeur, statut: 'PAR_DEFAUT_A_CONFIRMER', mention: PAR_DEFAUT, source });

/** Service d'un autre module chargé, ou `undefined` (le module reste utilisable sans lui). */
export function extOpt<S>(ctx: AppContext, name: string): S | undefined {
  return ctx.ext[name] as S | undefined;
}

export const fiscalOf = (ctx: AppContext) => extOpt<FiscalService>(ctx, 'fiscal');
export const titresOf = (ctx: AppContext) => extOpt<TitresService>(ctx, 'titres');
export const verticalesOf = (ctx: AppContext) => extOpt<VerticalesService>(ctx, 'verticales');
export const accesOf = (ctx: AppContext) => extOpt<AccesService>(ctx, 'acces');

/** Ratio en pour cent à une décimale (chaîne) ou null si le dénominateur est nul. */
export function pct(n: number, d: number): string | null {
  if (d <= 0) return null;
  return (Math.round((n * 1000) / d) / 10).toFixed(1);
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export const hoursBetween = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;

/** Normalisation d'un texte pour comparaison (casse, accents, espaces). */
export function norm(s: string): string {
  return s.trim().toLocaleLowerCase('fr').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
}
