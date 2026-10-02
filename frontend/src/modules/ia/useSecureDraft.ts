import { useCallback, useEffect, useRef, useState } from 'react';
import { openDraft, removeSealed, sealDraft, secureStorageAvailable } from './secureStore';

export type SecureDraftStatus = 'idle' | 'saving' | 'saved' | 'unavailable';

/**
 * Enregistrement automatique CHIFFRÉ d'un champ texte (ex. motif de décision sur une recommandation d'IA) :
 * restauré à l'ouverture, scellé 800 ms après la dernière frappe, effacé après envoi. Un brouillon n'est pas un acte.
 */
export function useSecureDraft(key: string, scope: string | undefined) {
  const [value, setValueState] = useState('');
  const [status, setStatus] = useState<SecureDraftStatus>(secureStorageAvailable() ? 'idle' : 'unavailable');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    if (!scope) return;
    void openDraft<string>(key, scope).then((d) => {
      if (alive && d && typeof d.data === 'string') { setValueState(d.data); setSavedAt(d.at); setStatus('saved'); }
    });
    return () => { alive = false; if (timer.current) clearTimeout(timer.current); };
  }, [key, scope]);

  const setValue = useCallback((v: string) => {
    setValueState(v);
    if (!scope || !secureStorageAvailable()) return;
    if (timer.current) clearTimeout(timer.current);
    setStatus('saving');
    timer.current = setTimeout(() => {
      const done = v.trim() ? sealDraft(key, v, scope) : Promise.resolve((removeSealed(key), true));
      void done.then((ok) => { setStatus(ok ? 'saved' : 'unavailable'); setSavedAt(new Date().toISOString()); });
    }, 800);
  }, [key, scope]);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    removeSealed(key);
    setValueState('');
    setStatus('idle');
    setSavedAt(null);
  }, [key]);

  return { value, setValue, status, savedAt, clear };
}
