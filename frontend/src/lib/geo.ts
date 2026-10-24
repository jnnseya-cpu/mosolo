/**
 * Géolocalisation PRÉCISE pour tout ce qui en a besoin (preuves, constats, inspections, enrôlement, missions) :
 * - GPS haute précision (`enableHighAccuracy`, jamais une position en cache) ;
 * - plusieurs relevés : la position retenue est la moyenne pondérée (1/précision²) des meilleurs relevés récents ;
 * - on attend la précision cible (10 m par défaut) ou le délai maximal, puis on garde le meilleur résultat ;
 * - la qualité est toujours affichée et transmise : EXCELLENTE ≤ 5 m, BONNE ≤ 15 m, MOYENNE ≤ 50 m, FAIBLE au-delà ;
 * - une correction manuelle sur la carte est possible mais marquée « MANUEL » (signalée au vérificateur).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type FixQuality = 'EXCELLENTE' | 'BONNE' | 'MOYENNE' | 'FAIBLE';
export interface PreciseFix {
  lat: number;
  lon: number;
  /** Précision estimée, en mètres (meilleur relevé retenu : estimation prudente). */
  accuracy: number | null;
  samples: number;
  at: string;
  source: 'GPS' | 'MANUEL' | 'ZONE';
  quality: FixQuality;
}
export type LocStatus = 'idle' | 'searching' | 'ok' | 'timeout' | 'denied' | 'unavailable';

export function qualityOf(accuracy: number | null, source: PreciseFix['source'] = 'GPS'): FixQuality {
  if (source !== 'GPS' || accuracy === null) return 'FAIBLE';
  if (accuracy <= 5) return 'EXCELLENTE';
  if (accuracy <= 15) return 'BONNE';
  if (accuracy <= 50) return 'MOYENNE';
  return 'FAIBLE';
}

interface Sample { lat: number; lon: number; acc: number; t: number }

/** Moyenne pondérée des relevés dont la précision est proche du meilleur (≤ 1,5 × le meilleur, 25 s au plus). */
export function combine(samples: Sample[], now = Date.now()): { lat: number; lon: number; accuracy: number; used: number } | null {
  const recent = samples.filter((s) => now - s.t <= 25_000);
  if (!recent.length) return null;
  const best = Math.min(...recent.map((s) => s.acc));
  const good = recent.filter((s) => s.acc <= best * 1.5);
  let w = 0; let lat = 0; let lon = 0;
  for (const s of good) { const k = 1 / (s.acc * s.acc); w += k; lat += s.lat * k; lon += s.lon * k; }
  return { lat: lat / w, lon: lon / w, accuracy: Math.round(best * 10) / 10, used: good.length };
}

export function usePreciseLocation(opts: { targetM?: number; maxWaitMs?: number; auto?: boolean } = {}) {
  const targetM = opts.targetM ?? 10;
  const maxWaitMs = opts.maxWaitMs ?? 30_000;
  const [status, setStatus] = useState<LocStatus>('idle');
  const [fix, setFix] = useState<PreciseFix | null>(null);
  const samples = useRef<Sample[]>([]);
  const watch = useRef<number | null>(null);
  const timer = useRef<number | null>(null);
  const early = useRef<number | null>(null);
  const last = useRef<PreciseFix | null>(null);

  const stop = useCallback(() => {
    if (watch.current !== null && typeof navigator !== 'undefined') navigator.geolocation?.clearWatch(watch.current);
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (early.current !== null) window.clearInterval(early.current);
    watch.current = null; timer.current = null; early.current = null;
  }, []);

  const start = useCallback(() => {
    stop();
    samples.current = [];
    if (typeof navigator === 'undefined' || !navigator.geolocation) { setStatus('unavailable'); return; }
    setStatus('searching');
    const onPos = (p: GeolocationPosition) => {
      const acc = p.coords.accuracy ?? 9999;
      samples.current.push({ lat: p.coords.latitude, lon: p.coords.longitude, acc, t: Date.now() });
      const c = combine(samples.current);
      if (!c) return;
      const f: PreciseFix = { lat: c.lat, lon: c.lon, accuracy: c.accuracy, samples: samples.current.length, at: new Date().toISOString(), source: 'GPS', quality: qualityOf(c.accuracy) };
      last.current = f;
      setFix(f);
      if (c.accuracy <= targetM && samples.current.length >= 3) { setStatus('ok'); stop(); }
    };
    // Erreur passagère (délai, signal perdu) après au moins un relevé : on garde le meilleur relevé au lieu d'abandonner.
    const onErr = (err: GeolocationPositionError) => {
      const f = last.current;
      if (err.code !== err.PERMISSION_DENIED && f) setStatus(f.accuracy !== null && f.accuracy <= targetM ? 'ok' : 'timeout');
      else setStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable');
      stop();
    };
    const opts = { enableHighAccuracy: true, maximumAge: 0, timeout: maxWaitMs };
    watch.current = navigator.geolocation.watchPosition(onPos, onErr, opts);
    // Relevé immédiat en plus du suivi : certains navigateurs ne notifient le suivi qu'au premier déplacement, et une
    // nouvelle demande « toute fraîche » peut rester sans réponse tant qu'un autre suivi est actif (terminal immobile).
    // Ce premier relevé accepte donc une mesure de moins de 10 s ; le suivi, lui, n'accepte que des mesures fraîches.
    navigator.geolocation.getCurrentPosition((p) => { if (watch.current !== null) onPos(p); }, () => undefined, { ...opts, maximumAge: 10_000 });
    // Certains appareils n'envoient qu'un relevé tant qu'ils ne bougent pas : cible tenue 6 s = position retenue.
    last.current = null;
    const t0 = Date.now();
    early.current = window.setInterval(() => {
      const f = last.current;
      if (f?.accuracy !== null && f?.accuracy !== undefined && f.accuracy <= targetM && Date.now() - t0 >= 6000) { setStatus('ok'); stop(); }
    }, 1000);
    timer.current = window.setTimeout(() => {
      const f = last.current;
      setStatus((s) => (s === 'searching' ? (f?.accuracy !== null && f?.accuracy !== undefined && f.accuracy <= targetM ? 'ok' : 'timeout') : s));
      stop();
    }, maxWaitMs);
  }, [maxWaitMs, stop, targetM]);

  useEffect(() => { if (opts.auto !== false) start(); return stop; }, []); // eslint-disable-line react-hooks/exhaustive-deps -- justifié : dépendances volontairement restreintes aux valeurs listées (sinon boucle de rendu ou rechargement à chaque rendu)

  /** Correction manuelle (clic sur la carte) : conservée, mais signalée comme MANUEL. */
  const setManual = useCallback((lat: number, lon: number) => {
    stop();
    setFix({ lat, lon, accuracy: null, samples: 0, at: new Date().toISOString(), source: 'MANUEL', quality: 'FAIBLE' });
    setStatus('ok');
  }, [stop]);
  const setZone = useCallback((lat: number, lon: number) => {
    stop();
    setFix({ lat, lon, accuracy: null, samples: 0, at: new Date().toISOString(), source: 'ZONE', quality: 'FAIBLE' });
    setStatus('ok');
  }, [stop]);

  return { status, fix, start, stop, setManual, setZone, targetM };
}

/**
 * Variante « bouton » pour les formulaires : la recherche démarre au clic (`locate`) et le rappel reçoit chaque
 * position améliorée (moyenne des meilleurs relevés) jusqu'à la précision cible ou au délai maximal.
 */
export function usePreciseGps(opts: { targetM?: number; maxWaitMs?: number } = {}) {
  const loc = usePreciseLocation({ ...opts, auto: false });
  const cb = useRef<((f: PreciseFix) => void) | null>(null);
  useEffect(() => { if (loc.fix && cb.current) cb.current(loc.fix); }, [loc.fix]);
  const locate = useCallback((onFix: (f: PreciseFix) => void) => { cb.current = onFix; loc.start(); }, [loc.start]); // eslint-disable-line react-hooks/exhaustive-deps -- justifié : dépendances volontairement restreintes aux valeurs listées (sinon boucle de rendu ou rechargement à chaque rendu)
  const pick = useCallback((lat: number, lon: number, onFix?: (f: PreciseFix) => void) => { if (onFix) cb.current = onFix; loc.setManual(lat, lon); }, [loc.setManual]); // eslint-disable-line react-hooks/exhaustive-deps -- justifié : dépendances volontairement restreintes aux valeurs listées (sinon boucle de rendu ou rechargement à chaque rendu)
  return { ...loc, busy: loc.status === 'searching', locate, pick };
}

let webgl: boolean | null = null;
/** L'appareil sait-il afficher la carte vectorielle (WebGL) ? Sinon, les écrans gardent leur plan schématique. */
export function webglSupported(): boolean {
  if (webgl !== null) return webgl;
  try {
    if (typeof document === 'undefined' || /jsdom/i.test(navigator.userAgent)) return (webgl = false);
    const c = document.createElement('canvas');
    webgl = !!(c.getContext('webgl2') ?? c.getContext('webgl'));
  } catch { webgl = false; }
  return webgl;
}

/** Anneau (lon, lat) approchant un cercle de `radiusM` mètres — pour tracer un rayon de recherche sur la carte. */
export function circleRing(lon: number, lat: number, radiusM: number, steps = 64): [number, number][] {
  const out: [number, number][] = [];
  const dLat = radiusM / 111_320; const dLon = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) { const a = (i / steps) * 2 * Math.PI; out.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]); }
  return out;
}

/** Distance en mètres (haversine, non arrondie) : source unique partagée avec le serveur. */
export { haversineM as metersBetween } from '@mosolo/shared';

/**
 * Présence du terminal jointe à un contrôle (plaque, scan) : `lat`, `lon`, `accuracyM` ajoutés à l'URL, seulement
 * pour un relevé GPS MESURÉ (jamais une position ajustée à la main ou de repli). Sans relevé, le contrôle part sans
 * position : il reste valable mais n'ouvre aucune commission (présence non vérifiée par le serveur).
 */
export function withPresence(path: string, fix: Pick<PreciseFix, 'lat' | 'lon' | 'accuracy' | 'source'> | null | undefined): string {
  if (!fix || fix.source !== 'GPS' || fix.accuracy === null || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return path;
  const q = new URLSearchParams({ lat: fix.lat.toFixed(6), lon: fix.lon.toFixed(6), accuracyM: String(Math.round(fix.accuracy * 10) / 10) });
  return `${path}${path.includes('?') ? '&' : '?'}${q.toString()}`;
}
