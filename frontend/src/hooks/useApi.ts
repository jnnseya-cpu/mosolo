import { useCallback, useEffect, useRef, useState } from 'react';

export interface ApiState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (d: T | null) => void;
}

/** Charge une ressource ; `deps` relance le chargement (ex. utilisateur de démo). */
export function useApi<T>(fetcher: (() => Promise<T>) | null, deps: unknown[] = []): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState<boolean>(!!fetcher);
  const [tick, setTick] = useState(0);
  const ref = useRef(fetcher);
  ref.current = fetcher;

  useEffect(() => {
    const f = ref.current;
    if (!f) { setLoading(false); return; }
    let alive = true;
    setLoading(true);
    setError(null);
    f().then(
      (d) => { if (alive) { setData(d); setLoading(false); } },
      (e: unknown) => { if (alive) { setError(e); setLoading(false); } },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload, setData };
}
