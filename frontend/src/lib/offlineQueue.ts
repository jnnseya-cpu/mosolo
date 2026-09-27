/**
 * Files locales hors ligne (constats de terrain, enrôlements assistés, contrôles de titres) :
 * - une file PAR UTILISATEUR (clé suffixée par l'identifiant) : un autre agent sur le même appareil ne voit ni ne
 *   synchronise jamais les saisies d'un collègue ;
 * - toute modification relit la file stockée juste avant d'écrire : une saisie enregistrée pendant une
 *   synchronisation n'est jamais écrasée ; seules les entrées effectivement transmises sont retirées.
 */
import { safeGet, safeSet } from './api';

/** Préfixes des files locales connues (purgées à la déconnexion). */
export const OFFLINE_QUEUES = ['mosolo.fieldQueue.v2', 'mosolo.canaux.enrolQueue', 'mosolo.titres.queue'] as const;

export function queueKey(base: string, userId: string | null | undefined): string | null {
  return userId ? `${base}.${userId}` : null;
}

export function readQueue<T>(key: string | null): T[] {
  if (!key) return [];
  try {
    const v = JSON.parse(safeGet(key) ?? '[]') as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch { return []; }
}

/** Relit la file, applique `fn`, réécrit et renvoie la nouvelle file. */
export function updateQueue<T>(key: string | null, fn: (q: T[]) => T[]): T[] {
  if (!key) return [];
  const next = fn(readQueue<T>(key));
  safeSet(key, JSON.stringify(next));
  return next;
}

/** Déconnexion : efface les files locales de l'utilisateur (données personnelles sur un appareil partagé). */
export function purgeUserQueues(userId: string | null | undefined, bases: readonly string[] = OFFLINE_QUEUES): void {
  for (const b of bases) { const k = queueKey(b, userId); if (k) safeSet(k, null); }
}
