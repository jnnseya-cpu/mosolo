/**
 * Stockage local des brouillons (hors ligne) et file d'attente de synchronisation.
 * Un brouillon n'est pas un acte (§ 23.5.3) : il n'a aucun effet juridique.
 */
import { api, NetworkError, safeGet, safeSet } from './api';
import type { DraftSaveResult } from './types';

export interface LocalDraft<T = unknown> { data: T; updatedAt: string; pending: boolean; version?: number; savedAt?: string }

const PREFIX = 'mosolo.draft.';

export function readLocalDraft<T>(key: string): LocalDraft<T> | null {
  const raw = safeGet(PREFIX + key);
  if (!raw) return null;
  try { return JSON.parse(raw) as LocalDraft<T>; } catch { return null; }
}
export function writeLocalDraft<T>(key: string, d: LocalDraft<T>): void {
  safeSet(PREFIX + key, JSON.stringify(d));
}
export function removeLocalDraft(key: string): void { safeSet(PREFIX + key, null); }

export function pendingDraftKeys(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX) && readLocalDraft(k.slice(PREFIX.length))?.pending) out.push(k.slice(PREFIX.length));
    }
  } catch { /* stockage indisponible */ }
  return out;
}

export async function putDraft<T>(key: string, data: T): Promise<DraftSaveResult> {
  return api<DraftSaveResult>(`/v1/drafts/${encodeURIComponent(key)}`, { method: 'PUT', body: { data } });
}

/** Envoie au serveur les brouillons enregistrés hors ligne (au retour du réseau). */
export async function flushPendingDrafts(): Promise<number> {
  let n = 0;
  for (const key of pendingDraftKeys()) {
    const d = readLocalDraft(key);
    if (!d) continue;
    try {
      const r = await putDraft(key, d.data);
      writeLocalDraft(key, { ...d, pending: false, version: r.version, savedAt: r.savedAt });
      n++;
    } catch (e) {
      if (e instanceof NetworkError) break;
    }
  }
  return n;
}
