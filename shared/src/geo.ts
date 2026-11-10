/**
 * Géodésie minimale partagée (serveur et navigateur) : distance orthodromique par la formule de haversine,
 * sur la sphère de rayon moyen IUGG (6 371 008,8 m). Source unique des calculs de distance.
 */
const EARTH_RADIUS_M = 6_371_008.8;

export interface LatLon {
  lat: number;
  lon: number;
}

/** Distance en mètres, non arrondie (affichage fin, filtres côté navigateur). */
export function haversineM(a: LatLon, b: LatLon): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distance en mètres entiers (valeur exposée par l'API, comparée aux tolérances de présence). */
export function distanceM(a: LatLon, b: LatLon): number {
  return Math.round(haversineM(a, b));
}
