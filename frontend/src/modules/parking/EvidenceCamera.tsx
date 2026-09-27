/**
 * Caméra de preuve géolocalisée (plaque ROUGE) — jusqu'à 5 photos des ABORDS du véhicule : devant, derrière, à droite,
 * à gauche, une autre vue. La preuve porte sur le lieu et les circonstances du stationnement (marquage, panneau, trottoir,
 * voie), pas sur la plaque : elle est déjà lue au contrôle et incrustée dans chaque image. Chaque photo porte, INCRUSTÉS dans l'image : date et heure (horloge du serveur, Kinshasa),
 * agent, plaque, contrôle, coordonnées GPS et lieu saisi par l'agent. L'empreinte SHA-256 de l'image finale est
 * calculée sur l'appareil et vérifiée par le serveur, qui conserve l'image telle que reçue.
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { api, describeError, serverNow } from '../../lib/api';
import { Icon } from '../../components/Icon';

export const SLOTS = [
  { id: 'ABORDS_AVANT', label: 'Abords — devant', hint: 'Reculez : montrez ce qui est devant le véhicule (rue, marquage, panneau)' },
  { id: 'ABORDS_ARRIERE', label: 'Abords — derrière', hint: 'Reculez : montrez ce qui est derrière le véhicule et l’emplacement' },
  { id: 'ABORDS_DROITE', label: 'Abords — côté droit', hint: 'Le véhicule dans son environnement, côté droit (trottoir, passage)' },
  { id: 'ABORDS_GAUCHE', label: 'Abords — côté gauche', hint: 'Le véhicule dans son environnement, côté gauche (chaussée, circulation)' },
  { id: 'AUTRE', label: 'Autre vue', hint: 'Panneau d’interdiction, marquage au sol, horaire affiché, contexte' },
] as const;
type SlotId = (typeof SLOTS)[number]['id'];

interface Fix { lat: number; lon: number; accuracy: number | null; source: 'GPS' | 'ZONE' }
interface Taken { id: string; preview: string; sha256: string }

const kin = (t: number) => new Date(t).toLocaleString('fr-FR', { timeZone: 'Africa/Kinshasa', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Dessine l'image puis le bandeau d'horodatage incrusté (lisible, non détachable de l'image). */
function stamp(canvas: HTMLCanvasElement, source: CanvasImageSource, sw: number, sh: number, lines: string[]) {
  const scale = Math.min(1, 1280 / Math.max(sw, sh));
  const w = Math.round(sw * scale); const h = Math.round(sh * scale);
  const fs = Math.max(14, Math.round(w / 48));
  const band = lines.length * (fs + 6) + 12;
  canvas.width = w; canvas.height = h + band;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(source, 0, 0, w, h);
  ctx.fillStyle = '#10163a'; ctx.fillRect(0, h, w, band);
  ctx.fillStyle = '#F7D618'; ctx.fillRect(0, h, w, 3);
  ctx.fillStyle = '#ffffff'; ctx.font = `600 ${fs}px system-ui, Arial, sans-serif`; ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, 10, h + 8 + i * (fs + 6), w - 20));
  // Filigrane discret dans l'image : l'heure et la plaque restent visibles même si le bandeau est recadré.
  ctx.save(); ctx.globalAlpha = 0.35; ctx.font = `700 ${Math.round(fs * 0.9)}px system-ui, Arial`; ctx.fillStyle = '#ffffff';
  ctx.fillText(lines[1] ?? '', 10, 10, w - 20); ctx.restore();
}

async function encode(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  for (const q of [0.82, 0.7, 0.58, 0.45]) {
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', q));
    if (blob && blob.size <= 880_000) return blob.arrayBuffer();
  }
  throw new Error('Photo trop lourde.');
}

export function EvidenceCamera({ checkId, plate, zone, agent, onDone, onCancel }: {
  checkId: string; plate: string; zone: { id: string; name: string; center: { lat: number; lon: number } };
  agent: { id: string; name: string }; onDone: (photoIds: string[], place: string, fix: Fix) => void; onCancel: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [live, setLive] = useState(false);
  const [camMsg, setCamMsg] = useState('Ouverture de la caméra…');
  const [fix, setFix] = useState<Fix | null>(null);
  const [gpsMsg, setGpsMsg] = useState('Recherche de la position GPS…');
  const [place, setPlace] = useState('');
  const [slot, setSlot] = useState<SlotId>('ABORDS_AVANT');
  const [taken, setTaken] = useState<Partial<Record<SlotId, Taken>>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(serverNow());

  useEffect(() => { const t = window.setInterval(() => setNow(serverNow()), 1000); return () => window.clearInterval(t); }, []);
  useEffect(() => {
    let stream: MediaStream | null = null; let stop = false;
    if (!navigator.mediaDevices?.getUserMedia) { setCamMsg('Caméra en direct indisponible : utilisez « Photo depuis l’appareil ».'); return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((s) => { stream = s; if (stop || !video.current) { s.getTracks().forEach((t) => t.stop()); return; } video.current.srcObject = s; void video.current.play(); setLive(true); setCamMsg(''); })
      .catch(() => setCamMsg('Caméra refusée ou indisponible : utilisez « Photo depuis l’appareil ».'));
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, []);
  useEffect(() => {
    if (!navigator.geolocation) { setGpsMsg('GPS indisponible sur cet appareil.'); return; }
    const id = navigator.geolocation.watchPosition(
      (p) => { setFix({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy ?? null, source: 'GPS' }); setGpsMsg(''); },
      () => setGpsMsg('Position GPS refusée ou introuvable.'),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  const count = Object.keys(taken).length;
  const canShoot = !!fix && place.trim().length >= 3 && !busy;

  const capture = async (source: CanvasImageSource, w: number, h: number) => {
    if (!canvas.current || !fix) return;
    setBusy(true); setErr(null);
    try {
      const at = serverNow();
      const s = SLOTS.find((x) => x.id === slot)!;
      stamp(canvas.current, source, w, h, [
        `MOSOLO · CONSTAT STATIONNEMENT · ${plate} · ${s.label}`,
        `${kin(at)} (heure serveur, Kinshasa)`,
        `Agent : ${agent.name} (${agent.id}) · contrôle ${checkId}`,
        `${fix.source === 'GPS' ? `GPS ${fix.lat.toFixed(6)}, ${fix.lon.toFixed(6)}${fix.accuracy !== null ? ` ± ${Math.round(fix.accuracy)} m` : ''}` : `Position de la zone (GPS indisponible)`} · ${place.trim()}`,
      ]);
      const buf = await encode(canvas.current);
      const sha = await sha256Hex(buf);
      const meta = await api<{ id: string }>('/v1/parking/evidence-photos', {
        method: 'POST',
        body: { checkId, slot, imageBase64: toBase64(buf), sha256: sha, lat: fix.lat, lon: fix.lon, ...(fix.accuracy !== null ? { accuracyM: fix.accuracy } : {}), gpsSource: fix.source, place: place.trim(), stampedAt: new Date(at).toISOString() },
      });
      const preview = URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' }));
      setTaken((t) => { if (t[slot]) URL.revokeObjectURL(t[slot]!.preview); return { ...t, [slot]: { id: meta.id, preview, sha256: sha } }; });
      const next = SLOTS.find((x) => x.id !== slot && !taken[x.id]);
      if (next) setSlot(next.id);
    } catch (e) {
      setErr(describeError(e).message);
    } finally { setBusy(false); }
  };

  const shoot = () => { const v = video.current; if (v && v.videoWidth) void capture(v, v.videoWidth, v.videoHeight); };
  const onPhoto = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; e.target.value = '';
    if (!f) return;
    const bmp = await createImageBitmap(f);
    await capture(bmp, bmp.width, bmp.height);
  };

  return (
    <section className="evc panel" aria-label="Caméra de preuve géolocalisée">
      <header className="panel-head"><div>
        <h2 className="panel-title"><Icon name="camera" size={18} /> Photos de preuve — <span className="pk-plate">{plate}</span></h2>
        <p className="panel-sub">Jusqu’à 5 photos des <strong>abords du véhicule</strong> (où et comment il est stationné), pas de la plaque : elle est déjà lue. Date, heure, agent, position GPS et lieu sont incrustés dans chaque image.</p>
      </div></header>

      <div className="evc-meta">
        <span><Icon name="clock" size={14} /> {kin(now)} <span className="muted">(heure serveur)</span></span>
        <span><Icon name="user" size={14} /> {agent.name}</span>
        <span className={fix ? 'evc-ok' : 'evc-wait'}><Icon name="gps" size={14} /> {fix ? (fix.source === 'GPS' ? `${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)}${fix.accuracy !== null ? ` ± ${Math.round(fix.accuracy)} m` : ''}` : 'Position de la zone (à vérifier)') : gpsMsg}</span>
        {!fix && gpsMsg !== 'Recherche de la position GPS…' && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFix({ lat: zone.center.lat, lon: zone.center.lon, accuracy: null, source: 'ZONE' })}>Utiliser la position de la zone (signalé au vérificateur)</button>
        )}
      </div>

      <label className="field"><span className="label">Lieu précis (saisi par l’agent)</span>
        <input value={place} onChange={(e) => setPlace(e.target.value)} placeholder="ex. Bd du 30 Juin, face à la poste, côté fleuve" maxLength={200} required />
      </label>

      <div className="evc-slots" role="radiogroup" aria-label="Vue à photographier">
        {SLOTS.map((s) => (
          <button key={s.id} type="button" role="radio" aria-checked={slot === s.id} className={`evc-slot${slot === s.id ? ' is-on' : ''}${taken[s.id] ? ' is-done' : ''}`} onClick={() => setSlot(s.id)}>
            {taken[s.id] ? <img src={taken[s.id]!.preview} alt="" /> : <Icon name="camera" size={18} />}
            <span>{s.label}</span>
            {taken[s.id] && <Icon name="check" size={14} />}
          </button>
        ))}
      </div>

      {/* Un seul élément vidéo (le flux reste attaché) ; masqué tant que la caméra n'est pas ouverte. */}
      <div className="evc-view" hidden={!live} style={live ? undefined : { display: 'none' }}>
        <video ref={video} className="evc-video" muted playsInline aria-label="Image de la caméra" />
        <span className="evc-overlay">{SLOTS.find((x) => x.id === slot)!.hint}</span>
      </div>
      {!live && <p className="small muted">{camMsg}</p>}
      <canvas ref={canvas} hidden style={{ display: 'none' }} aria-hidden="true" />
      {!place.trim() && <p className="small muted">Saisissez le lieu avant de photographier.</p>}
      {err && <p className="notice notice-err small">{err}</p>}

      <div className="evc-actions">
        {live && <button type="button" className="btn btn-primary" onClick={shoot} disabled={!canShoot}><Icon name="camera" size={16} /> {busy ? 'Envoi…' : `Photographier : ${SLOTS.find((x) => x.id === slot)!.label}`}</button>}
        <button type="button" className="btn btn-secondary" onClick={() => file.current?.click()} disabled={!canShoot}><Icon name="upload" size={16} /> Photo depuis l’appareil</button>
        <input ref={file} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void onPhoto(e)} aria-label="Photo depuis l’appareil" />
        <button type="button" className="btn btn-primary" disabled={count === 0 || busy || !fix} onClick={() => onDone(SLOTS.map((s) => taken[s.id]?.id).filter((x): x is string => !!x), place.trim(), fix!)}>
          <Icon name="check" size={16} /> Terminer ({count}/5)
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Annuler</button>
      </div>
    </section>
  );
}
