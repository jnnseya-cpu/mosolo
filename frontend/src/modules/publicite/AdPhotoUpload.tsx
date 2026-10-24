/**
 * Photos de preuve d'une inspection publicitaire : chaque photo choisie est redessinée avec un bandeau incrusté
 * (heure serveur, inspecteur, position), ré-encodée en JPEG, puis VERSÉE au serveur (empreinte SHA-256 vérifiée)
 * AVANT le constat. Le constat cite ensuite ces photos par leur empreinte (même inspecteur, 30 minutes au plus) ;
 * sans photo versée, la preuve est signalée comme faible au vérificateur.
 */
import { useEffect, useRef, useState } from 'react';
import { api, describeError, serverNow } from '../../lib/api';
import { encode, kinTime, sha256Hex, stamp, toBase64 } from '../../lib/evidenceJpeg';
import { Icon } from '../../components/Icon';
import type { AdPhotoMeta } from './types';
import type { EvidencePhotoMeta } from '../parking/EvidencePhotos';

export interface UploadedPhoto { id: string; sha256: string; preview: string }
export interface PhotoPosition { lat: number; lon: number; accuracy?: number; source: 'GPS' | 'MANUEL' | 'ZONE' }

/** Corps de `POST /v1/publicite/evidence-photos` (précision transmise seulement si elle est connue). */
export function evidenceBody(buf: ArrayBuffer, sha256: string, pos: PhotoPosition, stampedAt: number) {
  return {
    imageBase64: toBase64(buf), sha256, lat: pos.lat, lon: pos.lon, ...(pos.accuracy !== undefined ? { accuracyM: pos.accuracy } : {}),
    gpsSource: pos.source, stampedAt: new Date(stampedAt).toISOString(),
  };
}

/** Photo publicitaire présentée comme une photo de preuve (vignette authentifiée, heure, position, empreinte). */
export function adPhotoView(p: AdPhotoMeta, i: number): EvidencePhotoMeta {
  return {
    id: p.id, slot: 'PUBLICITE', slotLabel: `Photo ${i + 1}`, sha256: p.sha256, url: p.url, lat: p.lat, lon: p.lon, accuracyM: p.accuracyM, gpsSource: p.gpsSource,
    place: '', stampedAt: p.stampedAt, receivedAt: p.receivedAt, agentId: p.agentId, agentName: p.agentId, clockWarning: p.clockWarning, lowAccuracy: p.lowAccuracy,
  };
}

const posText = (p: PhotoPosition) => p.source === 'GPS'
  ? `GPS ${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}${p.accuracy !== undefined ? ` ± ${Math.round(p.accuracy)} m` : ''}`
  : `Position ${p.source === 'MANUEL' ? 'ajustée à la main' : 'de repli'} ${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`;

export function AdPhotoUpload({ value, onChange, position, inspector, max = 4 }: {
  value: UploadedPhoto[]; onChange: (v: UploadedPhoto[]) => void; position: PhotoPosition | null; inspector: { id: string; name: string } | null; max?: number;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const kept = useRef(value);
  kept.current = value;
  // Aperçus libérés à la fermeture du formulaire.
  useEffect(() => () => { kept.current.forEach((p) => URL.revokeObjectURL(p.preview)); }, []);

  async function add(files: FileList | null) {
    if (!files?.length || !position) return;
    setBusy(true); setErr(null);
    const out = [...value];
    const canvas = document.createElement('canvas');
    try {
      for (const f of Array.from(files).slice(0, max - value.length)) {
        let bmp: ImageBitmap;
        try { bmp = await createImageBitmap(f); } catch { throw new Error(`Photo illisible (${f.name}) : reprenez la photo ou choisissez une autre image.`); }
        const at = serverNow();
        try {
          stamp(canvas, bmp, bmp.width, bmp.height, [
            'MOSOLO · KIN PUB CONTROL · CONSTAT PUBLICITÉ',
            `${kinTime(at)} (heure serveur, Kinshasa)`,
            `Inspecteur : ${inspector ? `${inspector.name} (${inspector.id})` : 'inconnu'}`,
            posText(position),
          ]);
        } finally { bmp.close?.(); }
        const buf = await encode(canvas);
        const sha = await sha256Hex(buf);
        const meta = await api<AdPhotoMeta>('/v1/publicite/evidence-photos', { method: 'POST', body: evidenceBody(buf, sha, position, at) });
        out.push({ id: meta.id, sha256: meta.sha256, preview: URL.createObjectURL(new Blob([buf], { type: 'image/jpeg' })) });
        onChange([...out]);
      }
    } catch (e) {
      setErr(describeError(e).message);
    } finally { setBusy(false); }
  }
  const remove = (i: number) => { URL.revokeObjectURL(value[i]!.preview); onChange(value.filter((_, j) => j !== i)); };
  return (
    <div className="field">
      <span className="label">Photographies (obligatoires)</span>
      <label className={`btn btn-secondary btn-sm pk-file${!position ? ' is-disabled' : ''}`} aria-disabled={!position || busy || value.length >= max}>
        <Icon name="camera" size={16} /> {busy ? 'Envoi de la photo…' : 'Prendre ou joindre une photo'}
        <input type="file" accept="image/*" capture="environment" multiple className="sr-only" onChange={(e) => { void add(e.target.files); e.target.value = ''; }} disabled={!position || busy || value.length >= max} />
      </label>
      {!position && <span className="hint">Localisez-vous (ou placez le point) avant de photographier : la position est incrustée dans chaque photo.</span>}
      {value.length > 0 && (
        <ul className="pk-hashes">
          {value.map((p, i) => (
            <li key={p.id}><img src={p.preview} alt={`Photo ${i + 1}`} width={48} height={36} style={{ objectFit: 'cover', borderRadius: 4 }} /> <Icon name="lock" size={14} /> <span className="mono">{p.sha256.slice(0, 16)}…</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(i)} aria-label={`Retirer la photo ${i + 1}`}>Retirer</button></li>
          ))}
        </ul>
      )}
      {err && <p className="notice notice-err small" role="alert">{err}</p>}
      <span className="hint">Chaque photo est versée au serveur (image conservée, empreinte SHA-256 vérifiée) avant le constat ; l’heure est celle du serveur.</span>
    </div>
  );
}
