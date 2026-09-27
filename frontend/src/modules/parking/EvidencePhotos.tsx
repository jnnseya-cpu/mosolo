/**
 * Photos de preuve d'un constat (caméra de preuve géolocalisée) : vignettes chargées avec l'authentification de
 * l'utilisateur, chacune avec sa vue, son heure incrustée, sa position et son empreinte ; agrandissement au clic.
 * Visibles des agents habilités du périmètre et du titulaire de la plaque (droit de contester).
 */
import { useEffect, useState } from 'react';
import { apiBlob } from '../../lib/api';
import { Icon } from '../../components/Icon';

export interface EvidencePhotoMeta {
  id: string; slot: string; slotLabel: string; sha256: string; url: string; lat: number; lon: number; accuracyM: number | null;
  gpsSource: 'GPS' | 'ZONE'; place: string; stampedAt: string; receivedAt: string; agentId: string; agentName: string; clockWarning: boolean;
}

function Thumb({ p, onOpen }: { p: EvidencePhotoMeta; onOpen: (src: string) => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let url: string | null = null; let alive = true;
    apiBlob(p.url).then((b) => { if (!alive) return; url = URL.createObjectURL(b); setSrc(url); }).catch(() => { if (alive) setErr(true); });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [p.url]);
  return (
    <figure className="ev-thumb">
      <button type="button" className="ev-thumb-btn" onClick={() => src && onOpen(src)} disabled={!src} aria-label={`Agrandir : ${p.slotLabel}`}>
        {src ? <img src={src} alt={`${p.slotLabel} — photo de preuve`} loading="lazy" /> : <span className="ev-thumb-ph">{err ? 'Photo indisponible' : 'Chargement…'}</span>}
      </button>
      <figcaption>
        <strong>{p.slotLabel}</strong>
        <span>{new Date(p.stampedAt).toLocaleString('fr-FR', { timeZone: 'Africa/Kinshasa' })}</span>
        <span>{p.gpsSource === 'GPS' ? `GPS ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}${p.accuracyM !== null ? ` ± ${Math.round(p.accuracyM)} m` : ''}` : 'Position de la zone (GPS indisponible)'}</span>
        {p.clockWarning && <span className="ev-warn"><Icon name="alert" size={12} /> Heure incrustée éloignée de l’heure de réception</span>}
        <span className="mono ev-sha" title={p.sha256}>SHA-256 {p.sha256.slice(0, 12)}…</span>
      </figcaption>
    </figure>
  );
}

export function EvidencePhotos({ photos }: { photos: EvidencePhotoMeta[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!photos.length) return null;
  return (
    <div className="ev-photos">
      <p className="small muted"><Icon name="camera" size={14} /> {photos.length} photo(s) horodatée(s) et géolocalisée(s) · lieu : {photos[0]!.place} · agent : {photos[0]!.agentName}</p>
      <div className="ev-grid">{photos.map((p) => <Thumb key={p.id} p={p} onOpen={setOpen} />)}</div>
      {open && (
        <div className="ev-lightbox" role="dialog" aria-label="Photo de preuve" onClick={() => setOpen(null)}>
          <img src={open} alt="Photo de preuve agrandie" />
          <button type="button" className="btn btn-secondary" onClick={() => setOpen(null)}><Icon name="close" size={16} /> Fermer</button>
        </div>
      )}
    </div>
  );
}
