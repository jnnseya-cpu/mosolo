/** Géodésie du terrain : la distance (haversine, mètres entiers) vient de la source unique partagée. */
import type { LatLon } from '@mosolo/shared';

export { distanceM, type LatLon } from '@mosolo/shared';

/** Point décalé vers le sud de `meters` mètres (données de démonstration). */
export function offsetSouth(p: LatLon, meters: number): LatLon {
  return { lat: Number((p.lat - meters / 111_195).toFixed(6)), lon: p.lon };
}
