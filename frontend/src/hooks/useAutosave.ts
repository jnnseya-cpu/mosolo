import { useCallback, useEffect, useRef, useState } from 'react';
import { api, asList, NetworkError } from '../lib/api';
import { putDraft, readLocalDraft, removeLocalDraft, writeLocalDraft } from '../lib/drafts';
import type { DraftDoc, DraftVersion } from '../lib/types';

export type AutosaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: string; version?: number }
  | { kind: 'offline' }
  | { kind: 'error'; message?: string };

export interface AutosaveApi<T> {
  value: T;
  setValue: (next: T | ((prev: T) => T)) => void;
  status: AutosaveState;
  restoredFrom: 'local' | 'server' | null;
  versions: DraftVersion[];
  versionsLoading: boolean;
  versionsError: boolean;
  loadVersions: () => void;
  restoreVersion: (v: DraftVersion) => boolean;
  reset: (next?: T) => void;
}

export const AUTOSAVE_DELAY_MS = 1500;

/**
 * Enregistrement automatique (§ 23.5.3) : PUT /v1/drafts/:key 1,5 s après chaque changement,
 * copie locale immédiate, repli hors ligne sur l'appareil, restauration au rechargement,
 * historique des versions (GET /v1/drafts/:key/versions).
 */
export function useAutosave<T extends object>(key: string, initial: T, opts: { delay?: number; server?: boolean } = {}): AutosaveApi<T> {
  const delay = opts.delay ?? AUTOSAVE_DELAY_MS;
  const server = opts.server ?? true;
  const local = readLocalDraft<T>(key);
  const [value, setValueState] = useState<T>(() => (local ? { ...initial, ...local.data } : initial));
  const [status, setStatus] = useState<AutosaveState>(() => {
    if (!local) return { kind: 'idle' };
    if (local.pending) return { kind: 'offline' };
    return local.savedAt ? { kind: 'saved', at: local.savedAt, version: local.version } : { kind: 'idle' };
  });
  const [restoredFrom, setRestoredFrom] = useState<'local' | 'server' | null>(local ? 'local' : null);
  const [versions, setVersions] = useState<DraftVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(value);
  latest.current = value;
  const dirty = useRef(false);

  const save = useCallback(async () => {
    const data = latest.current;
    const now = new Date().toISOString();
    if (!server || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      writeLocalDraft(key, { data, updatedAt: now, pending: true });
      setStatus({ kind: 'offline' });
      return;
    }
    setStatus({ kind: 'saving' });
    try {
      const r = await putDraft(key, data);
      writeLocalDraft(key, { data, updatedAt: now, pending: false, version: r.version, savedAt: r.savedAt ?? now });
      setStatus({ kind: 'saved', at: r.savedAt ?? now, version: r.version });
    } catch (e) {
      writeLocalDraft(key, { data, updatedAt: now, pending: true });
      if (e instanceof NetworkError) setStatus({ kind: 'offline' });
      else {
        setStatus({ kind: 'error', message: e instanceof Error ? e.message : undefined });
        timer.current = setTimeout(() => void save(), 5000);
      }
    }
  }, [key, server]);

  // Restauration côté serveur si aucune modification locale en attente
  useEffect(() => {
    if (!server) return;
    let alive = true;
    api<DraftDoc<T> | null>(`/v1/drafts/${encodeURIComponent(key)}`)
      .then((doc) => {
        if (!alive || !doc || doc.data === undefined || dirty.current) return;
        const l = readLocalDraft<T>(key);
        if (l?.pending) return;
        if (l && doc.savedAt && l.savedAt && doc.savedAt <= l.savedAt) return;
        setValueState((prev) => ({ ...prev, ...doc.data }));
        setRestoredFrom('server');
        if (doc.savedAt) setStatus({ kind: 'saved', at: doc.savedAt, version: doc.version });
      })
      .catch(() => { /* pas de brouillon serveur ou hors ligne */ });
    return () => { alive = false; };
  }, [key, server]);

  // Au retour du réseau, renvoyer la version locale en attente
  useEffect(() => {
    const on = () => { if (readLocalDraft(key)?.pending) void save(); };
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, [key, save]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const schedule = useCallback((data: T) => {
    dirty.current = true;
    const prev = readLocalDraft<T>(key);
    writeLocalDraft(key, { ...(prev ?? {}), data, updatedAt: new Date().toISOString(), pending: true });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), delay);
  }, [key, delay, save]);

  const setValue = useCallback((next: T | ((prev: T) => T)) => {
    setValueState((prev) => {
      const v = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
      latest.current = v;
      schedule(v);
      return v;
    });
  }, [schedule]);

  const loadVersions = useCallback(() => {
    setVersionsLoading(true);
    setVersionsError(false);
    api<unknown>(`/v1/drafts/${encodeURIComponent(key)}/versions`)
      .then((v) => setVersions(asList<DraftVersion>(v, 'versions').slice().sort((a, b) => b.version - a.version)))
      .catch(() => setVersionsError(true))
      .finally(() => setVersionsLoading(false));
  }, [key]);

  const restoreVersion = useCallback((v: DraftVersion) => {
    if (v.data === undefined || v.data === null) return false;
    setValue(v.data as T);
    return true;
  }, [setValue]);

  const reset = useCallback((next?: T) => {
    if (timer.current) clearTimeout(timer.current);
    removeLocalDraft(key);
    dirty.current = false;
    setValueState(next ?? initial);
    setStatus({ kind: 'idle' });
    setRestoredFrom(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { value, setValue, status, restoredFrom, versions, versionsLoading, versionsError, loadVersions, restoreVersion, reset };
}
