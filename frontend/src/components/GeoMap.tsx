/**
 * Carte OpenStreetMap AUTO-HÉBERGÉE (décision du maître d'ouvrage) — MapLibre GL + tuiles vectorielles PMTiles.
 * Tout est servi par MOSOLO : tuiles de Kinshasa (/tiles/kinshasa.pmtiles, fabriquées par tools/maps), polices
 * (/map/fonts) et icônes (/map/sprites). Aucun appel à Google ni à un serveur de tuiles tiers ; utilisable hors
 * réseau une fois chargée. Sans fichier de tuiles installé, la carte affiche les couches MOSOLO sur fond neutre.
 * © contributeurs OpenStreetMap (ODbL).
 */
import { useEffect, useRef, useState } from 'react';
import maplibregl, { type StyleSpecification, type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { layers, namedFlavor } from '@protomaps/basemaps';

export const TILES_URL = '/tiles/kinshasa.pmtiles';
/** Emprise de la Ville-Province (lon/lat). */
export const KINSHASA_BOUNDS: [[number, number], [number, number]] = [[15.05, -4.75], [15.70, -4.15]];

export interface GeoMarker { id: string; lon: number; lat: number; color?: string; label?: string }
export interface GeoPolygon { id: string; rings: [number, number][][]; color?: string; label?: string }
export interface GeoMapProps {
  center: [number, number];
  zoom?: number;
  /** Emprise à afficher (prioritaire sur centre et zoom) : [[ouest, sud], [est, nord]]. */
  bounds?: [[number, number], [number, number]] | null;
  height?: number;
  markers?: GeoMarker[];
  polygons?: GeoPolygon[];
  lines?: { id: string; coords: [number, number][]; color?: string }[];
  /** Cercle de précision GPS (m) autour d'une position. */
  accuracy?: { lon: number; lat: number; radiusM: number } | null;
  onPick?: (lon: number, lat: number) => void;
  onSelect?: (id: string) => void;
  caption?: string;
  ariaLabel?: string;
}

let protocolAdded = false;
let tilesProbe: Promise<boolean> | null = null;
/** Le fichier de tuiles de Kinshasa est-il installé sur ce serveur ? */
export function tilesAvailable(): Promise<boolean> {
  tilesProbe ??= fetch(TILES_URL, { method: 'GET', headers: { Range: 'bytes=0-15' } })
    .then(async (r) => (r.status === 200 || r.status === 206) && new Uint8Array(await r.arrayBuffer()).slice(0, 7).every((b, i) => b === 'PMTiles'.charCodeAt(i)))
    .catch(() => false);
  return tilesProbe;
}

function circle(lon: number, lat: number, radiusM: number, steps = 48): [number, number][] {
  const out: [number, number][] = [];
  const dLat = radiusM / 111_320; const dLon = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) { const a = (i / steps) * 2 * Math.PI; out.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]); }
  return out;
}

function style(withTiles: boolean): StyleSpecification {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return {
    version: 8,
    glyphs: `${origin}/map/fonts/{fontstack}/{range}.pbf`,
    sprite: `${origin}/map/sprites/light`,
    sources: withTiles ? { protomaps: { type: 'vector', url: `pmtiles://${origin}${TILES_URL}`, attribution: '© contributeurs OpenStreetMap' } } : {},
    layers: withTiles ? layers('protomaps', namedFlavor('light'), { lang: 'fr' }) : [{ id: 'fond', type: 'background', paint: { 'background-color': '#eef1f5' } }],
  } as StyleSpecification;
}

function overlayData(p: GeoMapProps) {
  return {
    polys: { type: 'FeatureCollection', features: (p.polygons ?? []).map((g) => ({ type: 'Feature', properties: { id: g.id, color: g.color ?? '#232C6B', label: g.label ?? '' }, geometry: { type: 'Polygon', coordinates: g.rings } })) },
    lines: { type: 'FeatureCollection', features: (p.lines ?? []).map((l) => ({ type: 'Feature', properties: { id: l.id, color: l.color ?? '#1E9BD7' }, geometry: { type: 'LineString', coordinates: l.coords } })) },
    points: { type: 'FeatureCollection', features: (p.markers ?? []).map((m) => ({ type: 'Feature', properties: { id: m.id, color: m.color ?? '#D7141A', label: m.label ?? '' }, geometry: { type: 'Point', coordinates: [m.lon, m.lat] } })) },
    acc: { type: 'FeatureCollection', features: p.accuracy ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circle(p.accuracy.lon, p.accuracy.lat, Math.max(1, p.accuracy.radiusM))] } }] : [] },
  } as const;
}

export default function GeoMap(props: GeoMapProps) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [withTiles, setWithTiles] = useState<boolean | null>(null);

  useEffect(() => { void tilesAvailable().then(setWithTiles); }, []);

  useEffect(() => {
    if (withTiles === null || !el.current) return;
    if (!protocolAdded) { const proto = new Protocol(); maplibregl.addProtocol('pmtiles', proto.tile); protocolAdded = true; }
    const m = new maplibregl.Map({
      container: el.current, style: style(withTiles), center: props.center, zoom: props.zoom ?? 15, maxBounds: [[14.6, -5.2], [16.2, -3.7]],
      attributionControl: { compact: true }, cooperativeGestures: false,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    m.on('load', () => {
      const d = overlayData(latest.current);
      m.addSource('m-acc', { type: 'geojson', data: d.acc as never });
      m.addSource('m-polys', { type: 'geojson', data: d.polys as never });
      m.addSource('m-lines', { type: 'geojson', data: d.lines as never });
      m.addSource('m-points', { type: 'geojson', data: d.points as never });
      m.addLayer({ id: 'm-acc-fill', type: 'fill', source: 'm-acc', paint: { 'fill-color': '#1E9BD7', 'fill-opacity': 0.15 } });
      m.addLayer({ id: 'm-acc-line', type: 'line', source: 'm-acc', paint: { 'line-color': '#1E9BD7', 'line-width': 1.5 } });
      m.addLayer({ id: 'm-polys-fill', type: 'fill', source: 'm-polys', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.18 } });
      m.addLayer({ id: 'm-polys-line', type: 'line', source: 'm-polys', paint: { 'line-color': ['get', 'color'], 'line-width': 2 } });
      m.addLayer({ id: 'm-lines', type: 'line', source: 'm-lines', paint: { 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': 0.8 } });
      m.addLayer({ id: 'm-points', type: 'circle', source: 'm-points', paint: { 'circle-radius': 7, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
      m.addLayer({ id: 'm-labels', type: 'symbol', source: 'm-points', layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Medium'], 'text-size': 12, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': '#1b1d24', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } });
      for (const layer of ['m-points', 'm-polys-fill', 'm-lines']) {
        m.on('click', layer, (e) => { const id = e.features?.[0]?.properties?.id; if (id) latest.current.onSelect?.(String(id)); });
        m.on('mouseenter', layer, () => { if (latest.current.onSelect) m.getCanvas().style.cursor = 'pointer'; });
        m.on('mouseleave', layer, () => { m.getCanvas().style.cursor = ''; });
      }
      if (latest.current.bounds) m.fitBounds(latest.current.bounds, { padding: 30, maxZoom: 17, duration: 0 });
    });
    m.on('click', (e) => latest.current.onPick?.(e.lngLat.lng, e.lngLat.lat));
    map.current = m;
    return () => { m.remove(); map.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withTiles]);

  // Mise à jour des couches MOSOLO et du centre sans recréer la carte.
  useEffect(() => {
    const m = map.current;
    if (!m || !m.isStyleLoaded()) return;
    const d = overlayData(props);
    (m.getSource('m-acc') as GeoJSONSource | undefined)?.setData(d.acc as never);
    (m.getSource('m-polys') as GeoJSONSource | undefined)?.setData(d.polys as never);
    (m.getSource('m-lines') as GeoJSONSource | undefined)?.setData(d.lines as never);
    (m.getSource('m-points') as GeoJSONSource | undefined)?.setData(d.points as never);
  }, [props.markers, props.polygons, props.lines, props.accuracy]);
  useEffect(() => { if (!props.bounds) map.current?.easeTo({ center: props.center, duration: 400 }); }, [props.center[0], props.center[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const b = props.bounds;
  useEffect(() => { if (b && map.current) map.current.fitBounds(b, { padding: 30, maxZoom: 17, duration: 300 }); }, [b?.[0][0], b?.[0][1], b?.[1][0], b?.[1][1]]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <figure className="geomap">
      <div ref={el} className="geomap-canvas" style={{ height: props.height ?? 280 }} role="application" aria-label={props.ariaLabel ?? 'Carte OpenStreetMap'} />
      {withTiles === false && <p className="geomap-note small">Fond OpenStreetMap de Kinshasa non encore installé sur ce serveur (outil : <span className="mono">tools/maps/construire-tuiles-kinshasa.sh</span>) : seules les couches MOSOLO sont affichées.</p>}
      {props.caption && <figcaption className="small muted">{props.caption}</figcaption>}
    </figure>
  );
}
