/**
 * Bloc « Position précise » réutilisable : recherche GPS haute précision (moyenne des meilleurs relevés), qualité
 * affichée, carte OpenStreetMap auto-hébergée avec le cercle de précision, relance, correction manuelle signalée.
 * Le parent reçoit la position retenue par `onChange` (avec sa précision, son nombre de relevés et sa source).
 */
import { useEffect, useState } from 'react';
import { usePreciseLocation, type PreciseFix } from '../lib/geo';
import { GeoMapLazy } from './GeoMapLazy';
import { Icon } from './Icon';

const Q_LABEL = { EXCELLENTE: 'Excellente', BONNE: 'Bonne', MOYENNE: 'Moyenne', FAIBLE: 'Faible' } as const;

export function PreciseLocation({ onChange, targetM = 10, fallback, showMap = true, compact = false, label = 'Position' }: {
  onChange: (fix: PreciseFix | null) => void;
  targetM?: number;
  /** Position de repli (centre de zone, objet) proposée si le GPS échoue — signalée comme telle. */
  fallback?: { lat: number; lon: number; label: string };
  showMap?: boolean;
  compact?: boolean;
  label?: string;
}) {
  const loc = usePreciseLocation({ targetM });
  const [adjust, setAdjust] = useState(false);
  useEffect(() => { onChange(loc.fix); }, [loc.fix]); // eslint-disable-line react-hooks/exhaustive-deps
  const f = loc.fix;
  const progress = f?.accuracy ? Math.max(5, Math.min(100, (targetM / f.accuracy) * 100)) : loc.status === 'searching' ? 5 : 0;
  const statusText = {
    idle: 'Position non demandée.', searching: `Recherche GPS haute précision (cible ${targetM} m)…`, ok: f?.source === 'GPS' ? 'Position retenue.' : 'Position saisie (signalée au vérificateur).',
    timeout: 'Précision cible non atteinte : meilleure position retenue.', denied: 'Accès à la position refusé : autorisez la localisation.', unavailable: 'GPS indisponible sur cet appareil.',
  }[loc.status];
  return (
    <div className={`ploc${compact ? ' ploc-compact' : ''}`} aria-live="polite">
      <div className="ploc-head">
        <strong><Icon name="gps" size={15} /> {label}</strong>
        {f && <span className={`ploc-q ${f.quality}`}>{f.source === 'GPS' ? `± ${f.accuracy} m · ${Q_LABEL[f.quality]}` : f.source === 'MANUEL' ? 'Ajustée à la main' : 'Position de la zone'}</span>}
        {f && <span className="mono small">{f.lat.toFixed(6)}, {f.lon.toFixed(6)}</span>}
        {f?.source === 'GPS' && <span className="small muted">{f.samples} relevé(s)</span>}
      </div>
      {loc.status === 'searching' && <div className="ploc-bar" aria-hidden="true"><i style={{ width: `${progress}%` }} /></div>}
      <p className="small muted" style={{ margin: 0 }}>{statusText}</p>
      <div className="ploc-actions">
        {loc.status !== 'searching' && <button type="button" className="btn btn-ghost btn-sm" onClick={loc.start}><Icon name="refresh" size={14} /> Relancer le GPS</button>}
        {showMap && f && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdjust((a) => !a)} aria-pressed={adjust}><Icon name="pin" size={14} /> {adjust ? 'Terminer l’ajustement' : 'Ajuster sur la carte'}</button>}
        {fallback && (loc.status === 'denied' || loc.status === 'unavailable' || (loc.status === 'timeout' && (!f || f.quality === 'FAIBLE'))) && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => loc.setZone(fallback.lat, fallback.lon)}>{fallback.label} (signalée)</button>
        )}
      </div>
      {showMap && f && (
        <GeoMapLazy center={[f.lon, f.lat]} zoom={17} height={compact ? 180 : 240}
          markers={[{ id: 'moi', lon: f.lon, lat: f.lat, color: f.source === 'GPS' ? '#0b7a0b' : '#b27600', label: f.source === 'GPS' ? '' : 'ajustée' }]}
          accuracy={f.accuracy ? { lon: f.lon, lat: f.lat, radiusM: f.accuracy } : null}
          onPick={adjust ? (lon, lat) => loc.setManual(lat, lon) : undefined}
          caption={adjust ? 'Touchez la carte pour placer le point exact (la position sera marquée « ajustée à la main »).' : undefined}
          ariaLabel="Carte de la position" />
      )}
    </div>
  );
}
