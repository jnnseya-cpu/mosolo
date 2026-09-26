/**
 * Règle unique de couleur de validité des preuves (titres, tickets, places, pass, certificats, autorisations, quitus,
 * badges, mandats, références de paiement…) — décision du maître d'ouvrage du 26/09/2026 :
 *
 * - VERT   : il reste au moins 50 % de la durée de validité ;
 * - AMBRE  : il reste de 1 % à moins de 50 % ;
 * - ROUGE  : il reste moins de 1 % (le titre est encore valable) ;
 * - EXPIRÉ : la validité est échue (rouge, avec « ✗ EXPIRÉ DEPUIS … ») ;
 * - GRIS   : pas encore actif.
 *
 * La couleur n'est jamais seule : icône, texte et compte à rebours l'accompagnent (§ H.11.2). L'instant de référence
 * est TOUJOURS l'heure du serveur (§ H.11.6) : le client corrige son horloge par l'écart mesuré avec `serverTime`.
 * Une quittance ne périme jamais (bande PERMANENT).
 */
export const VALIDITY_GREEN_MIN_PCT = 50;
export const VALIDITY_AMBER_MIN_PCT = 1;

export type ValidityBand = 'VERT' | 'AMBRE' | 'ROUGE' | 'EXPIRE' | 'PAS_ACTIF' | 'PERMANENT';

export interface ValidityReading {
  band: ValidityBand;
  /** Pourcentage de validité restant, 0–100 (100 avant le début ; 0 après la fin ; null si permanent). */
  pct: number | null;
  /** Millisecondes restantes avant la fin (négatif : écoulées depuis la fin). */
  remainingMs: number | null;
  totalMs: number | null;
}

const KINSHASA_OFFSET_MS = 3_600_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Date seule (AAAA-MM-JJ) → début (00:00) ou fin (23:59:59.999) de la journée à Kinshasa, en millisecondes. */
export function kinshasaBoundMs(value: string, edge: 'start' | 'end'): number {
  if (!DATE_ONLY.test(value)) return new Date(value).getTime();
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const t = edge === 'start' ? Date.UTC(y, m - 1, d, 0, 0, 0, 0) : Date.UTC(y, m - 1, d, 23, 59, 59, 999);
  return t - KINSHASA_OFFSET_MS;
}

const toMs = (t: string | number | Date, edge: 'start' | 'end' = 'start'): number =>
  t instanceof Date ? t.getTime() : typeof t === 'number' ? t : kinshasaBoundMs(t, edge);

/** Bande de couleur pour une part restante donnée (en %). */
export function bandForPct(pct: number): Exclude<ValidityBand, 'EXPIRE' | 'PAS_ACTIF' | 'PERMANENT'> {
  if (pct >= VALIDITY_GREEN_MIN_PCT) return 'VERT';
  if (pct >= VALIDITY_AMBER_MIN_PCT) return 'AMBRE';
  return 'ROUGE';
}

/** Lecture de validité à l'instant `now` (heure serveur). `until` absent = preuve permanente. */
export function readValidity(from: string | number | Date | null | undefined, until: string | number | Date | null | undefined, now: string | number | Date): ValidityReading {
  if (until === null || until === undefined || until === '') return { band: 'PERMANENT', pct: null, remainingMs: null, totalMs: null };
  const n = toMs(now);
  const u = toMs(until, 'end');
  const f = from === null || from === undefined || from === '' ? u : toMs(from, 'start');
  const total = Math.max(u - f, 0);
  const remaining = u - n;
  if (n < f) return { band: 'PAS_ACTIF', pct: 100, remainingMs: remaining, totalMs: total };
  if (remaining <= 0) return { band: 'EXPIRE', pct: 0, remainingMs: remaining, totalMs: total };
  const pct = total > 0 ? Math.min(100, (remaining / total) * 100) : 0;
  return { band: bandForPct(pct), pct, remainingMs: remaining, totalMs: total };
}

/** Durée lisible : « 2 j 04 h », « 3 h 07 min », « 12 min 05 s ». */
export function formatValidityDuration(ms: number, withSeconds = true): string {
  const abs = Math.abs(ms);
  const d = Math.floor(abs / 86_400_000);
  const h = Math.floor((abs % 86_400_000) / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const s = Math.floor((abs % 60_000) / 1000);
  const p = (x: number) => String(x).padStart(2, '0');
  if (d > 0) return `${d} j ${p(h)} h`;
  if (h > 0) return `${h} h ${p(m)} min`;
  return withSeconds ? `${m} min ${p(s)} s` : `${Math.max(m, abs > 0 ? 1 : 0)} min`;
}

/** Texte accompagnant la couleur (français ; SMS, USSD, WhatsApp, pages légères). */
export function validityText(r: ValidityReading, withSeconds = false): string {
  switch (r.band) {
    case 'PERMANENT': return 'VALABLE — sans date de fin';
    case 'PAS_ACTIF': return `PAS ENCORE ACTIF — début dans ${formatValidityDuration(r.remainingMs! - r.totalMs!, withSeconds)}`;
    case 'EXPIRE': return `✗ EXPIRÉ DEPUIS ${formatValidityDuration(r.remainingMs!, withSeconds)}`;
    case 'ROUGE': return `⚠ VALIDE — EXPIRE DANS ${formatValidityDuration(r.remainingMs!, withSeconds)}`;
    case 'AMBRE': return `⚠ VALIDE — encore ${formatValidityDuration(r.remainingMs!, withSeconds)}`;
    case 'VERT': return `✓ VALIDE — encore ${formatValidityDuration(r.remainingMs!, withSeconds)}`;
  }
}

export const VALIDITY_BAND_LABEL: Record<ValidityBand, string> = {
  VERT: 'Vert — 50 % ou plus de validité restante',
  AMBRE: 'Ambre — de 1 % à moins de 50 %',
  ROUGE: 'Rouge — moins de 1 %',
  EXPIRE: 'Expiré',
  PAS_ACTIF: 'Pas encore actif',
  PERMANENT: 'Sans date de fin',
};
