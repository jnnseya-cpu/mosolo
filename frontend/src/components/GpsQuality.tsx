/**
 * Éléments communs de géolocalisation précise pour les formulaires : ligne d'état (qualité, précision, relevés,
 * progression) et carte OpenStreetMap auto-hébergée pour vérifier ou ajuster le point (ajustement signalé « MANUEL »).
 */
import { useState } from 'react';
import type { LocStatus, PreciseFix } from '../lib/geo';
import { GeoMapLazy } from './GeoMapLazy';
import { Icon } from './Icon';

const Q_LABEL = { EXCELLENTE: 'Excellente', BONNE: 'Bonne', MOYENNE: 'Moyenne', FAIBLE: 'Faible' } as const;

export function GpsQualityLine({ fix, status, targetM }: { fix: PreciseFix | null; status: LocStatus; targetM: number }) {
  if (status === 'idle' && !fix) return null;
  const progress = fix?.accuracy ? Math.max(5, Math.min(100, (targetM / fix.accuracy) * 100)) : 5;
  return (
    <div className="ploc-line" aria-live="polite">
      {fix && <span className={`ploc-q ${fix.quality}`}>{fix.source === 'GPS' ? `± ${fix.accuracy} m · ${Q_LABEL[fix.quality]}` : fix.source === 'MANUEL' ? 'Ajustée à la main (signalée)' : 'Position de la zone (signalée)'}</span>}
      {fix?.source === 'GPS' && <span className="small muted">{fix.samples} relevé(s)</span>}
      {status === 'searching' && <span className="small muted">Recherche haute précision (cible {targetM} m)…</span>}
      {status === 'timeout' && <span className="small muted">Cible non atteinte : meilleure position retenue.</span>}
      {status === 'denied' && <span className="small err">Accès à la position refusé.</span>}
      {status === 'unavailable' && <span className="small err">GPS indisponible.</span>}
      {status === 'searching' && <div className="ploc-bar" aria-hidden="true"><i style={{ width: `${progress}%` }} /></div>}
    </div>
  );
}

/** Carte repliable : montre le point et son cercle de précision ; un toucher sur la carte ajuste le point. */
export function MapCheck({ lat, lon, accuracy, onPick, label = 'Voir sur la carte' }: {
  lat: number | null; lon: number | null; accuracy?: number | null; onPick?: (lat: number, lon: number) => void; label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [adjust, setAdjust] = useState(false);
  const has = lat !== null && lon !== null && Number.isFinite(lat) && Number.isFinite(lon);
  return (
    <div className="ploc-map">
      <div className="row-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}><Icon name="pin" size={14} /> {open ? 'Masquer la carte' : label}</button>
        {open && onPick && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdjust((a) => !a)} aria-pressed={adjust}>{adjust ? 'Terminer l’ajustement' : 'Ajuster sur la carte'}</button>}
      </div>
      {open && (
        <GeoMapLazy center={has ? [lon!, lat!] : [15.3136, -4.3217]} zoom={has ? 17 : 12} height={220}
          markers={has ? [{ id: 'pt', lon: lon!, lat: lat! }] : []}
          accuracy={has && accuracy ? { lon: lon!, lat: lat!, radiusM: accuracy } : null}
          onPick={adjust && onPick ? (x, y) => onPick(y, x) : undefined}
          caption={adjust ? 'Touchez la carte pour placer le point exact (signalé « ajusté à la main »).' : undefined}
          ariaLabel="Carte de la position relevée" />
      )}
    </div>
  );
}
