/**
 * Lecture de plaque d'immatriculation par la caméra (OCR Tesseract servi par MOSOLO, /ocr/ — aucun service externe).
 * La machine PROPOSE, l'agent DÉCIDE : le texte lu est affiché, corrigeable, et n'est utilisé qu'après confirmation.
 * Caméra en direct avec un cadre de visée au format plaque ; secours par photo. Aucune image n'est envoyée au serveur.
 */
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Icon } from './Icon';

type Recognize = (canvas: HTMLCanvasElement) => Promise<{ text: string; confidence: number }>;
let engine: Promise<Recognize> | null = null;

/** Moteur chargé une seule fois (≈ 7 Mo, mis en cache ensuite). */
function loadEngine(): Promise<Recognize> {
  engine ??= (async () => {
    const T = await import('tesseract.js');
    const worker = await T.createWorker('eng', T.OEM.LSTM_ONLY, {
      workerPath: '/ocr/worker.min.js', corePath: '/ocr/', langPath: '/ocr', gzip: true, workerBlobURL: false,
    });
    await worker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-',
      tessedit_pageseg_mode: T.PSM.SINGLE_LINE,
    });
    return async (canvas: HTMLCanvasElement) => {
      const r = await worker.recognize(canvas);
      return { text: r.data.text, confidence: r.data.confidence };
    };
  })();
  engine.catch(() => { engine = null; });
  return engine;
}

/** Nettoie la lecture : majuscules, chiffres et tirets ; propose la forme « KN-0000-XX » si elle s'y prête. */
export function normalizePlateReading(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const compact = s.replace(/-/g, '');
  const m = /^([A-Z]{2})(\d{4})([A-Z]{2})$/.exec(compact);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return s;
}

/** Zone du cadre de visée (proportions de l'image) : bande horizontale centrée, format plaque. */
const GUIDE = { x: 0.1, y: 0.38, w: 0.8, h: 0.24 };

/** Recadre la plaque, passe en niveaux de gris, étire le contraste et agrandit pour la lecture. */
function prepare(source: CanvasImageSource, sw: number, sh: number, out: HTMLCanvasElement, useGuide: boolean) {
  const cx = useGuide ? sw * GUIDE.x : 0; const cy = useGuide ? sh * GUIDE.y : 0;
  const cw = useGuide ? sw * GUIDE.w : sw; const ch = useGuide ? sh * GUIDE.h : sh;
  const scale = Math.min(3, 1400 / cw);
  out.width = Math.round(cw * scale); out.height = Math.round(ch * scale);
  const ctx = out.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, cx, cy, cw, ch, 0, 0, out.width, out.height);
  const img = ctx.getImageData(0, 0, out.width, out.height);
  const d = img.data;
  let min = 255; let max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
    d[i] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < d.length; i += 4) {
    const v = ((d[i]! - min) * 255) / range;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}

export function PlateScanner({ onConfirm, onClose }: { onConfirm: (plate: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const work = useRef<HTMLCanvasElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [live, setLive] = useState(false);
  const [status, setStatus] = useState<string>('Ouverture de la caméra…');
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState<{ text: string; confidence: number } | null>(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    let stream: MediaStream | null = null; let stop = false;
    void loadEngine().catch(() => setStatus('Moteur de lecture indisponible : saisissez la plaque.'));
    if (!navigator.mediaDevices?.getUserMedia) { setStatus('Caméra en direct indisponible : prenez une photo de la plaque.'); return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((s) => {
        stream = s;
        if (stop || !video.current) { s.getTracks().forEach((t) => t.stop()); return; }
        video.current.srcObject = s;
        void video.current.play();
        setLive(true);
        setStatus('Placez la plaque dans le cadre, puis « Lire la plaque ».');
      })
      .catch(() => setStatus('Caméra refusée ou indisponible : prenez une photo de la plaque.'));
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, []);

  const read = useCallback(async (source: CanvasImageSource, w: number, h: number, useGuide: boolean) => {
    if (!work.current) return;
    setBusy(true); setStatus('Lecture en cours…');
    try {
      const rec = await loadEngine();
      prepare(source, w, h, work.current, useGuide);
      const r = await rec(work.current);
      const text = normalizePlateReading(r.text);
      setReading({ text, confidence: Math.round(r.confidence) });
      setValue(text);
      setStatus(text ? 'Vérifiez la lecture, corrigez si besoin, puis confirmez.' : 'Aucun texte lisible : rapprochez-vous ou saisissez la plaque.');
    } catch {
      setStatus('Lecture impossible : saisissez la plaque.');
    } finally { setBusy(false); }
  }, []);

  const shoot = () => {
    const v = video.current;
    if (v && v.videoWidth) void read(v, v.videoWidth, v.videoHeight, true);
  };
  const onPhoto = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    const bmp = await createImageBitmap(f);
    await read(bmp, bmp.width, bmp.height, false);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = normalizePlateReading(value);
    if (p.length >= 4) onConfirm(p);
  };

  return (
    <div className="plq" role="region" aria-label="Lecture de plaque">
      {/* Un seul élément vidéo (le flux reste attaché) ; masqué tant que la caméra n'est pas ouverte. */}
      <div className="plq-view" hidden={!live} style={live ? undefined : { display: 'none' }}>
        <video ref={video} className="plq-video" muted playsInline aria-label="Image de la caméra" />
        <span className="plq-guide" aria-hidden="true" />
      </div>
      <canvas ref={work} hidden style={{ display: 'none' }} aria-hidden="true" />
      <p className="small muted" role="status">{status}</p>
      <div className="plq-actions">
        {live && <button type="button" className="btn btn-primary" onClick={shoot} disabled={busy}><Icon name="camera" size={16} /> {busy ? 'Lecture…' : 'Lire la plaque'}</button>}
        <button type="button" className="btn btn-secondary" onClick={() => file.current?.click()} disabled={busy}><Icon name="upload" size={16} /> Photo de la plaque</button>
        <input ref={file} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void onPhoto(e)} aria-label="Photo de la plaque" />
        <button type="button" className="btn btn-ghost" onClick={onClose}><Icon name="close" size={16} /> Fermer</button>
      </div>
      {reading && (
        <form className="plq-confirm" onSubmit={submit}>
          <label className="field"><span className="label">Plaque lue{reading.confidence ? ` (confiance ${reading.confidence} %)` : ''} — à vérifier</span>
            <input className="pk-plate-input" value={value} onChange={(e) => setValue(e.target.value.toUpperCase())} autoComplete="off" aria-label="Plaque lue, modifiable" />
          </label>
          <button type="submit" className="btn btn-primary" disabled={normalizePlateReading(value).length < 4}><Icon name="check" size={16} /> Confirmer et contrôler</button>
        </form>
      )}
    </div>
  );
}
