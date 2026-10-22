/**
 * Stockage local des brouillons (hors ligne) et file d'attente de synchronisation.
 * Un brouillon n'est pas un acte (§ 23.5.3) : il n'a aucun effet juridique.
 *
 * Sécurité (§ 23.5, lot IA) : les brouillons ne sont JAMAIS écrits en clair sur l'appareil. Le contenu vit en
 * mémoire pendant la session ; sa copie persistante est chiffrée (AES-GCM-256, clé dérivée par utilisateur d'une
 * clé d'appareil non exportable — modules/ia/secureStore.ts). Sans WebCrypto, rien n'est persisté (mémoire seule).
 */
import { api, getDemoUser, NetworkError } from './api';
import type { DraftSaveResult } from './types';
import { migrateClearDrafts, openDraft, removeSealed, sealDraft, SEALED_PREFIX } from '../modules/ia/secureStore';

export interface LocalDraft<T = unknown> { data: T; updatedAt: string; pending: boolean; version?: number; savedAt?: string }

const cache = new Map<string, LocalDraft>();
const scope = () => getDemoUser() ?? 'anonyme';

export function readLocalDraft<T>(key: string): LocalDraft<T> | null {
  return (cache.get(key) as LocalDraft<T> | undefined) ?? null;
}
export function writeLocalDraft<T>(key: string, d: LocalDraft<T>): void {
  cache.set(key, d as LocalDraft);
  void sealDraft(key, d, scope());
}
export function removeLocalDraft(key: string): void {
  cache.delete(key);
  removeSealed(key);
}

export function pendingDraftKeys(): string[] {
  return [...cache.entries()].filter(([, d]) => d.pending).map(([k]) => k);
}

/**
 * Au démarrage : chiffre les brouillons historiques en clair puis déchiffre en mémoire ceux de l'utilisateur courant.
 * Un brouillon d'un autre utilisateur, ou altéré, ne se déchiffre pas et reste ignoré.
 */
export async function hydrateDrafts(): Promise<number> {
  const s = scope();
  try { await migrateClearDrafts(s); } catch { /* chiffrement indisponible */ }
  let n = 0;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(SEALED_PREFIX)) keys.push(k.slice(SEALED_PREFIX.length));
    }
    for (const key of keys) {
      const opened = await openDraft<LocalDraft>(key, s);
      if (opened?.data && typeof opened.data === 'object') { cache.set(key, opened.data); n++; }
    }
  } catch { /* stockage indisponible */ }
  return n;
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
