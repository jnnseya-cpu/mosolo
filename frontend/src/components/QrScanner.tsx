/**
 * Lecteur de QR universel — fonctionne sur (presque) tous les téléphones :
 * 1. caméra en direct : détecteur natif du navigateur (BarcodeDetector) s'il existe, sinon décodage en JavaScript
 *    (jsQR, chargé à la demande) sur les images de la vidéo — iPhone (Safari), Firefox, anciens Android ;
 * 2. photo du QR : l'appareil photo du téléphone prend une image, décodée sur place — utile quand la caméra en direct
 *    est refusée, indisponible (page hors HTTPS) ou trop lente.
 * Aucune image n'est envoyée au serveur : seul le texte lu du QR est transmis à la page appelante.
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Icon } from './Icon';

type Decoder = (data: Uint8ClampedArray, w: number, h: number) => string | null;
let jsqrDecoder: Promise<Decoder> | null = null;
function loadJsQr(): Promise<Decoder> {
  jsqrDecoder ??= import('jsqr').then((m) => {
    const jsQR = m.default;
    return (data, w, h) => jsQR(data, w, h, { inversionAttempts: 'attemptBoth' })?.data ?? null;
  });
  return jsqrDecoder;
}

/** Décode une image (vidéo, photo) réduite à `max` px de côté. */
async function decodeFrom(source: CanvasImageSource, sw: number, sh: number, canvas: HTMLCanvasElement, max = 800): Promise<string | null> {
  const scale = Math.min(1, max / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale)); const h = Math.max(1, Math.round(sh * scale));
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const decode = await loadJsQr();
  return decode(img.data, w, h);
}

export function QrScanner({ onResult, onClose }: { onResult: (raw: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<'starting' | 'live' | 'nocamera'>('starting');
  const [message, setMessage] = useState<string | null>(null);
  const [engine, setEngine] = useState<'natif' | 'jsqr' | null>(null);
  const done = useRef(false);

  const finish = useCallback((raw: string) => {
    if (done.current) return;
    done.current = true;
    try { navigator.vibrate?.(80); } catch { /* sans vibreur */ }
    onResult(raw.trim());
  }, [onResult]);

  useEffect(() => {
    let stream: MediaStream | null = null; let stop = false; let timer = 0;
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('nocamera');
      setMessage(window.isSecureContext === false ? 'La caméra en direct exige une connexion sécurisée (HTTPS) : prenez plutôt une photo du QR.' : 'Caméra en direct indisponible sur ce navigateur : prenez une photo du QR.');
      return;
    }
    const Native = window.BarcodeDetector;
    const native = Native ? new Native({ formats: ['qr_code'] }) : null;
    setEngine(native ? 'natif' : 'jsqr');
    if (!native) void loadJsQr(); // préchargement
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }).then((s) => {
      stream = s;
      const v = video.current;
      if (!v || stop) { s.getTracks().forEach((t) => t.stop()); return; }
      v.srcObject = s;
      void v.play();
      setStatus('live');
      const tick = async () => {
        if (stop || done.current || !video.current) return;
        const el = video.current;
        try {
          if (el.readyState >= 2 && el.videoWidth > 0) {
            let raw: string | null = null;
            if (native) raw = (await native.detect(el))[0]?.rawValue ?? null;
            else if (canvas.current) raw = await decodeFrom(el, el.videoWidth, el.videoHeight, canvas.current, 640);
            if (raw) { finish(raw); return; }
          }
        } catch { /* image pas prête : on réessaie */ }
        timer = window.setTimeout(() => void tick(), native ? 250 : 200);
      };
      void tick();
    }).catch(() => {
      setStatus('nocamera');
      setMessage('Accès à la caméra refusé ou impossible : prenez une photo du QR, ou saisissez le code imprimé sous le QR.');
    });
    return () => { stop = true; window.clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, [finish]);

  const onPhoto = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || !canvas.current) return;
    setMessage('Lecture de la photo…');
    try {
      const bmp = typeof createImageBitmap === 'function' ? await createImageBitmap(f) : null;
      let raw: string | null = null;
      if (bmp) {
        // Plusieurs tailles : un QR petit dans une grande photo se lit mieux en haute résolution.
        for (const max of [1000, 1600, 700]) { raw = await decodeFrom(bmp, bmp.width, bmp.height, canvas.current, max); if (raw) break; }
      } else {
        const url = URL.createObjectURL(f);
        const img = new Image();
        await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('image')); img.src = url; });
        raw = await decodeFrom(img, img.naturalWidth, img.naturalHeight, canvas.current, 1200);
        URL.revokeObjectURL(url);
      }
      if (raw) finish(raw);
      else setMessage('Aucun QR lisible sur cette photo. Rapprochez-vous, évitez les reflets, et cadrez le QR entier.');
    } catch {
      setMessage('Photo illisible. Réessayez, ou saisissez le code imprimé sous le QR.');
    }
  };

  return (
    <div className="qrs" role="region" aria-label="Lecteur de QR">
      {status !== 'nocamera' && (
        <div className="qrs-view">
          <video ref={video} className="qrs-video" muted playsInline aria-label="Image de la caméra" />
          <span className="qrs-frame" aria-hidden="true"><i /><i /><i /><i /></span>
          <span className="qrs-hint">{status === 'starting' ? 'Ouverture de la caméra…' : 'Placez le QR dans le cadre'}</span>
        </div>
      )}
      <canvas ref={canvas} hidden style={{ display: "none" }} aria-hidden="true" />
      {message && <p className={`small ${status === 'nocamera' ? 'notice notice-err' : 'muted'}`} role="status">{message}</p>}
      <div className="qrs-actions">
        <button type="button" className="btn btn-secondary" onClick={() => fileInput.current?.click()}><Icon name="camera" size={16} /> Prendre une photo du QR</button>
        <input ref={fileInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void onPhoto(e)} aria-label="Photo du QR" />
        <button type="button" className="btn btn-ghost" onClick={onClose}><Icon name="close" size={16} /> Fermer</button>
      </div>
      {engine && status === 'live' && <p className="small muted">Lecture {engine === 'natif' ? 'par le détecteur du navigateur' : 'en JavaScript (compatible iPhone et anciens téléphones)'} · aucune image n’est envoyée.</p>}
    </div>
  );
}
