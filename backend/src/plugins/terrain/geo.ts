/** Géodésie minimale : distance orthodromique (formule de haversine), en mètres entiers. */
const EARTH_RADIUS_M = 6_371_008.8;

export interface LatLon {
  lat: number;
  lon: number;
}

export function distanceM(a: LatLon, b: LatLon): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

/** Point décalé vers le sud de `meters` mètres (données de démonstration). */
export function offsetSouth(p: LatLon, meters: number): LatLon {
  return { lat: Number((p.lat - meters / 111_195).toFixed(6)), lon: p.lon };
}

/** Taux en pourcentage, une décimale, en chaîne (jamais de flottant exposé comme valeur de calcul). */
export function pct(numerator: number, denominator: number): string | null {
  if (denominator <= 0) return null;
  const tenths = Math.round((numerator * 1000) / denominator);
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}
