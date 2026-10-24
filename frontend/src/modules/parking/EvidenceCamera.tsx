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
import { PreciseLocation } from '../../components/PreciseLocation';
import type { PreciseFix } from '../../lib/geo';
import { encode, kinTime, sha256Hex, stamp, toBase64 } from '../../lib/evidenceJpeg';

export const SLOTS = [
  { id: 'ABORDS_AVANT', label: 'Abords — devant', hint: 'Reculez : montrez ce qui est devant le véhicule (rue, marquage, panneau)' },
  { id: 'ABORDS_ARRIERE', label: 'Abords — derrière', hint: 'Reculez : montrez ce qui est derrière le véhicule et l’emplacement' },
  { id: 'ABORDS_DROITE', label: 'Abords — côté droit', hint: 'Le véhicule dans son environnement, côté droit (trottoir, passage)' },
  { id: 'ABORDS_GAUCHE', label: 'Abords — côté gauche', hint: 'Le véhicule dans son environnement, côté gauche (chaussée, circulation)' },
  { id: 'AUTRE', label: 'Autre vue', hint: 'Panneau d’interdiction, marquage au sol, horaire affiché, contexte' },
] as const;
type SlotId = (typeof SLOTS)[number]['id'];

export interface Fix { lat: number; lon: number; accuracy: number | null; source: 'GPS' | 'MANUEL' | 'ZONE' }
interface Taken { id: string; preview: string; sha256: string }

const kin = kinTime;

export function EvidenceCamera({ checkId, plate, zone, agent, onDone, onCancel }: {
  checkId: string; plate: string; zone: { id: string; name: string; center: { lat: number; lon: number } };
  agent: { id: string; name: string }; onDone: (photoIds: string[], place: string, fix: Fix) => void; onCancel: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [live, setLive] = useState(false);
  const [camMsg, setCamMsg] = useState('Ouverture de la caméra…');
  const [liveFix, setFix] = useState<Fix | null>(null);
  const [place, setPlace] = useState('');
  const [slot, setSlot] = useState<SlotId>('ABORDS_AVANT');
  const [taken, setTaken] = useState<Partial<Record<SlotId, Taken>>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(serverNow());
  // Position figée à la première photo : toutes les images et le constat portent la même position que celle incrustée.
  const [stampFix, setStampFix] = useState<Fix | null>(null);
  const takenRef = useRef(taken);
  takenRef.current = taken;
  // Aperçus libérés à la fermeture de la caméra (sinon les images restent en mémoire).
  useEffect(() => () => { Object.values(takenRef.current).forEach((t) => t && URL.revokeObjectURL(t.preview)); }, []);

  useEffect(() => { const t = window.setInterval(() => setNow(serverNow()), 1000); return () => window.clearInterval(t); }, []);
  useEffect(() => {
    let stream: MediaStream | null = null; let stop = false;
    if (!navigator.mediaDevices?.getUserMedia) { setCamMsg('Caméra en direct indisponible : utilisez « Photo depuis l’appareil ».'); return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((s) => { stream = s; if (stop || !video.current) { s.getTracks().forEach((t) => t.stop()); return; } video.current.srcObject = s; void video.current.play(); setLive(true); setCamMsg(''); })
      .catch(() => setCamMsg('Caméra refusée ou indisponible : utilisez « Photo depuis l’appareil ».'));
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, []);
  const onFix = (f: PreciseFix | null) => setFix(f ? { lat: f.lat, lon: f.lon, accuracy: f.accuracy !== null ? Math.round(f.accuracy * 10) / 10 : null, source: f.source } : null);
  const srcText = (f: Fix) => f.source === 'GPS' ? `GPS ${f.lat.toFixed(6)}, ${f.lon.toFixed(6)}${f.accuracy !== null ? ` ± ${Math.round(f.accuracy)} m` : ''}`
    : f.source === 'MANUEL' ? `Position ajustée à la main ${f.lat.toFixed(6)}, ${f.lon.toFixed(6)}` : 'Position de la zone (GPS indisponible)';

  const fix = stampFix ?? liveFix;
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
        `${srcText(fix)} · ${place.trim()}`,
      ]);
      const buf = await encode(canvas.current);
      const sha = await sha256Hex(buf);
      const meta = await api<{ id: string }>('/v1/parking/evidence-photos', {
        method: 'POST',
        body: { checkId, slot, imageBase64: toBase64(buf), sha256: sha, lat: fix.lat, lon: fix.lon, ...(fix.accuracy !== null ? { accuracyM: fix.accuracy } : {}), gpsSource: fix.source, place: place.trim(), stampedAt: new Date(at).toISOString() },
      });
      setStampFix((f) => f ?? fix);
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
    let bmp: ImageBitmap;
    try { bmp = await createImageBitmap(f); } catch { setErr('Photo illisible : reprenez la photo ou choisissez une autre image.'); return; }
    try { await capture(bmp, bmp.width, bmp.height); } finally { bmp.close?.(); }
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
      </div>

      <PreciseLocation label="Position du véhicule" targetM={10} compact onChange={onFix}
        fallback={{ lat: zone.center.lat, lon: zone.center.lon, label: 'Utiliser la position de la zone' }} />
      {stampFix && <p className="small muted">Position retenue pour ce constat (incrustée dans les photos) : {srcText(stampFix)}.</p>}

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
