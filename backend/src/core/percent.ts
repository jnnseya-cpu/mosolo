/**
 * Pourcentage « 62.5 » (une décimale, arrondi au plus proche) en chaîne, jamais un flottant exposé comme valeur de
 * calcul ; null si le dénominateur est nul ou négatif. Source unique des taux de couverture et de conformité.
 * Le pilotage garde sa variante en BigInt (`plugins/pilotage/money.ts`) : exacte au-delà de 2^53 / 1000, et qui
 * refuse les entrées non entières.
 */
export function pct(num: number, den: number): string | null {
  if (den <= 0) return null;
  const tenths = Math.round((num * 1000) / den);
  return `${Math.trunc(tenths / 10)}.${Math.abs(tenths % 10)}`;
}
