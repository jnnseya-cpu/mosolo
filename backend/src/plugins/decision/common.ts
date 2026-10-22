/**
 * Outils communs du module « décision » (Pilotage et décision, modules 41 à 47 de la spécification fonctionnelle) :
 * conversion indicative en CDF, pourcentages exacts (entiers), journalisation. Lecture seule sur le socle.
 */
import { Money, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';

/** Unités mineures CDF (contre-valeur INDICATIVE au taux officiel du jour) ; null si aucune conversion possible. */
export function cdfMinor(ctx: AppContext, m: MoneyJSON): bigint | null {
  if (m.currency === 'CDF') return Money.fromJSON(m).minor;
  try {
    return Money.fromJSON(ctx.fx.convert(m, 'CDF').amount).minor;
  } catch {
    return null;
  }
}

export function cdfJson(minor: bigint): MoneyJSON {
  return Money.fromMinor(minor, 'CDF').toJSON();
}

/** Pourcentage à une décimale (arrondi au plus proche), arithmétique entière ; null si dénominateur nul. */
export function pctBig(num: bigint, den: bigint): string | null {
  if (den <= 0n) return null;
  const q = (num * 2000n + den) / (2n * den);
  return `${q / 10n}.${q % 10n}`;
}

export function pctNum(num: number, den: number): string | null {
  return pctBig(BigInt(num), BigInt(den));
}

export function audit(ctx: AppContext, user: User | { kind: 'system'; id: string }, action: string, resourceType: string, resourceId: string, details: Record<string, unknown> = {}) {
  ctx.audit.append({
    actor: 'kind' in user ? user : actorOf(user),
    action, resourceType, resourceId, details,
  });
}

/** Ajout de jours à une date AAAA-MM-JJ (UTC). */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Lundi (AAAA-MM-JJ) de la semaine ISO contenant `day`. */
export function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(day, -dow);
}
