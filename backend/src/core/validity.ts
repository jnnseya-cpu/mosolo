/**
 * Validité des preuves à l'heure du SERVEUR (§ H.11.6) — règle unique 50 % / 1 % (shared/validity.ts).
 * Toute réponse qui présente une preuve limitée dans le temps porte un objet `validity` : le client en tire le compte à
 * rebours et la couleur en direct, corrigés de l'écart entre son horloge et `serverTime`.
 */
import { kinshasaBoundMs, readValidity, validityText, type ValidityBand } from '@mosolo/shared';

/** Date seule → début ou fin de la journée à Kinshasa, en ISO. */
export function kinshasaBound(value: string, edge: 'start' | 'end'): string {
  return new Date(kinshasaBoundMs(value, edge)).toISOString();
}

export interface ValidityView {
  band: ValidityBand;
  pct: number | null;
  from: string | null;
  until: string | null;
  remainingSeconds: number | null;
  text: string;
  serverTime: string;
}

/** Objet `validity` d'une preuve ; `until` absent = sans date de fin (une quittance ne périme pas). */
export function validityView(from: string | null | undefined, until: string | null | undefined, now: Date): ValidityView {
  const f = from ? kinshasaBound(from, 'start') : null;
  const u = until ? kinshasaBound(until, 'end') : null;
  const r = readValidity(f, u, now);
  return {
    band: r.band, pct: r.pct === null ? null : Math.round(r.pct * 10) / 10, from: f, until: u,
    remainingSeconds: r.remainingMs === null ? null : Math.round(r.remainingMs / 1000), text: validityText(r), serverTime: now.toISOString(),
  };
}
