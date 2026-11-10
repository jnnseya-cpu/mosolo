/**
 * Carte chargée à la demande (MapLibre ≈ 250 Ko compressés) : les écrans sans carte ne la téléchargent pas.
 * Sur un appareil sans WebGL (anciens téléphones), le `fallback` (plan schématique) est affiché à la place.
 */
import { lazy, Suspense, type ReactNode } from 'react';
import type { GeoMapProps } from './GeoMap';
import { webglSupported } from '../lib/geo';

const Impl = lazy(() => import('./GeoMap'));

export function GeoMapLazy(props: GeoMapProps & { fallback?: ReactNode }) {
  const { fallback, ...rest } = props;
  if (!webglSupported()) {
    return <>{fallback ?? <p className="geomap-note small">Carte non disponible sur cet appareil (WebGL absent) : les coordonnées restent affichées et enregistrées.</p>}</>;
  }
  return (
    <Suspense fallback={<div className="geomap-canvas geomap-loading" style={{ height: rest.height ?? 280 }} aria-busy="true">Chargement de la carte…</div>}>
      <Impl {...rest} />
    </Suspense>
  );
}
export type { GeoMapProps, GeoMarker, GeoPolygon } from './GeoMap';
