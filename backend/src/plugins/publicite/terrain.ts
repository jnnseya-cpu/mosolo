/**
 * KIN PUB CONTROL sur le terrain — la même vue que pour les biens (« Autour de moi »), pour les agents de la publicité.
 *
 * Réalité de Kinshasa prise en compte, dans le module existant :
 * - bâches et banderoles posées SANS autorisation ni paiement (support recensé « non déclaré » → rouge) ;
 * - publicité MOBILE sur un véhicule ou un autre objet qui se déplace : contrôle PAR LA PLAQUE, où que le véhicule soit ;
 * - enseignes sur la façade ou la porte d'un commerce, et publicités posées devant un commerce : assujetties ; les
 *   commerces enregistrés proches SANS enseigne déclarée sont signalés « à vérifier » (jamais présumés en infraction).
 *
 * Couleurs : VERT autorisé et à jour ; AMBRE demande en cours, échéance proche, barème non publié ; ROUGE affiché sans
 * autorisation, autorisation expirée ou droits impayés. Aucune mesure automatique : la couleur oriente l'inspection ;
 * le constat reste celui de l'inspecteur accrédité (photos, position), vérifié puis décidé par d'autres personnes.
 */
import type { MapStatusColor } from '@mosolo/shared';
import type { User } from '../../core/auth.js';
import { forbidden, unprocessable } from '../../core/errors.js';
import { authorize, evaluate } from '../../core/policy.js';
import type { AppContext } from '../../context.js';
import { estimateCommune } from '../fiscal/nearby.js';
import { distanceM } from '../terrain/geo.js';
import type { VerticalesService } from '../verticales/service.js';
import { actorOf } from '../parking/support.js';
import { normalizeAdPlate, type AdDevice, type PubliciteService } from './service.js';

export const AD_NEARBY_MAX_ACCURACY_M = 100;
export const AD_NEARBY_MAX_RADIUS_M = 1000;

export const PLACEMENT_LABEL: Record<AdDevice['placement'], string> = {
  SUPPORT_DEDIE: 'Support dédié', FACADE_COMMERCE: 'Façade / porte d’un commerce', DEVANT_COMMERCE: 'Devant un commerce', VEHICULE: 'Véhicule (mobile)',
};

export function adSituation(svc: PubliciteService, d: AdDevice): { color: MapStatusColor; reason: string; payable: boolean } {
  const st = svc.deviceStatus(d);
  const kase = st.openCase ? ` Dossier ${st.openCase.reference} en cours.` : '';
  if (st.status === 'RETIRE') return { color: 'grey', reason: 'Support déclaré retiré.', payable: false };
  if (st.status === 'NON_DECLARE') return { color: 'red', reason: `Affiché sans autorisation (support non déclaré).${kase}`, payable: false };
  if (st.status === 'EXPIRE') return { color: 'red', reason: `Autorisation expirée : le support est-il toujours en place ?${kase}`, payable: st.rights === 'IMPAYE' };
  if (st.rights === 'IMPAYE') return { color: 'red', reason: `Droits impayés.${kase}`, payable: true };
  if (st.status === 'DECLARE') return { color: 'amber', reason: `Déclaré : autorisation en cours d’instruction.${kase}`, payable: false };
  if (st.rights === 'ACTE_REQUIS') return { color: 'amber', reason: `Autorisé ; barème non publié (acte requis) : aucun montant exigible.${kase}`, payable: false };
  if (st.expiringSoon) return { color: 'amber', reason: `Autorisé et à jour ; l’autorisation expire bientôt.${kase}`, payable: false };
  return { color: 'green', reason: `Autorisé et à jour.${kase}`, payable: false };
}

function itemOf(svc: PubliciteService, d: AdDevice, dist: number | null) {
  const st = svc.deviceStatus(d);
  const s = adSituation(svc, d);
  return {
    id: d.id, reference: d.reference, type: d.type, placement: d.placement, placementLabel: PLACEMENT_LABEL[d.placement],
    businessName: d.businessName, businessObjectId: d.businessObjectId, vehiclePlate: d.vehiclePlate, vehicleKind: d.vehicleKind,
    surfaceM2: d.surfaceM2, faces: d.faces, commune: d.commune, quartier: d.quartier, address: d.address, lat: d.lat, lon: d.lon, distanceM: dist,
    status: st.status, rights: st.rights, expiringSoon: st.expiringSoon, validUntil: st.authorization?.validUntil ?? null, openCase: st.openCase,
    ownerIdentified: d.ownerTaxpayerId !== null, objectId: d.objectId,
    color: s.color, reason: s.reason, payable: s.payable && d.objectId !== null, demo: d.demo,
  };
}

/** Supports publicitaires fixes proches + commerces enregistrés sans enseigne déclarée (à vérifier). */
export function adNearby(ctx: AppContext, svc: PubliciteService, user: User, q: { lat: number; lon: number; accuracyM: number; radiusM?: number }) {
  if (!evaluate(user, 'publicite:nearby', { communes: user.territory ?? [] })) {
    throw forbidden('NEARBY_FORBIDDEN', 'Vue « Autour de moi » de la publicité réservée aux inspecteurs, superviseurs et à la régie.');
  }
  if (!(q.accuracyM > 0) || q.accuracyM > AD_NEARBY_MAX_ACCURACY_M) {
    throw unprocessable('GPS_TOO_IMPRECISE', `Position trop imprécise (± ${Math.round(q.accuracyM)} m) : ${AD_NEARBY_MAX_ACCURACY_M} m au plus.`, { maxAccuracyM: AD_NEARBY_MAX_ACCURACY_M });
  }
  const radius = Math.min(AD_NEARBY_MAX_RADIUS_M, Math.max(50, Math.round(q.radiusM ?? 300)));
  const here = { lat: q.lat, lon: q.lon };
  const fixed = svc.devices.all().filter((d) => d.placement !== 'VEHICULE' && d.registration !== 'RETIRE');
  const { commune, basis } = estimateCommune([...fixed, ...ctx.objects.objects.all().filter((o) => o.category !== 'VEHICULE')], here);
  const inArea = !user.territory?.length || user.territory.includes(commune);
  const allowed = (c: string) => !!evaluate(user, 'publicite:nearby', { communes: [c] });

  const items = inArea
    ? fixed.map((d) => ({ d, m: distanceM(here, d) })).filter(({ d, m }) => m <= radius && allowed(d.commune)).sort((a, b) => a.m - b.m).map(({ d, m }) => itemOf(svc, d, m))
    : [];
  // Commerces enregistrés (activité / établissement) sans enseigne ni publicité déclarée : à vérifier sur place.
  const withSign = new Set(svc.devices.all().filter((d) => d.businessObjectId && d.registration !== 'RETIRE').map((d) => d.businessObjectId!));
  const vx = ctx.ext.verticales as VerticalesService | undefined;
  const businesses = inArea
    ? ctx.objects.objects.all()
      .filter((o) => o.category === 'ACTIVITE' && !withSign.has(o.id) && allowed(o.commune))
      .map((o) => ({ o, m: distanceM(here, o) })).filter(({ m }) => m <= radius).sort((a, b) => a.m - b.m)
      .map(({ o, m }) => ({
        objectId: o.id, label: vx?.describeObject(o).label ?? 'Établissement', reference: o.igf?.code ?? o.id, commune: o.commune, quartier: o.quartier, avenue: o.avenue ?? null,
        lat: o.lat, lon: o.lon, distanceM: m, reason: 'Commerce enregistré sans enseigne ni publicité déclarée : vérifier la façade, la porte et les abords.',
      }))
    : [];
  const counts = { green: 0, amber: 0, red: 0, grey: 0, blue: 0 } as Record<MapStatusColor, number>;
  for (const i of items) counts[i.color]++;
  ctx.audit.append({
    actor: actorOf(user), action: 'publicite.nearby.viewed', resourceType: 'position', resourceId: `${q.lat.toFixed(5)},${q.lon.toFixed(5)}`,
    details: { accuracyM: Math.round(q.accuracyM), radiusM: radius, commune, basis, inArea, shown: items.length, red: counts.red, businessesToCheck: businesses.length },
  });
  return {
    at: ctx.clock.now().toISOString(), radiusM: radius, commune, inArea, territory: user.territory ?? null, counts, items, businessesToCheck: businesses,
    notice: inArea
      ? 'La couleur oriente l’inspection ; elle ne vaut ni constat ni sanction. Constat par l’inspecteur accrédité (photos, position). Vous ne recevez jamais d’espèces : paiement numérique vers le compte public ou point agréé.'
      : `Vous êtes hors de votre secteur (position estimée : ${commune}).`,
    example: true,
  };
}

/** Publicité mobile : contrôle par la plaque du véhicule, où qu'il se trouve dans la ville. */
export function adVehicleCheck(ctx: AppContext, svc: PubliciteService, user: User, rawPlate: string) {
  authorize(user, 'publicite:nearby', { communes: user.territory ?? [] });
  const plate = normalizeAdPlate(rawPlate);
  if (plate.length < 4) throw unprocessable('INVALID_PLATE', 'Plaque illisible : au moins 4 caractères.');
  const devices = svc.devices.all().filter((d) => d.placement === 'VEHICULE' && d.vehiclePlate === plate && d.registration !== 'RETIRE');
  ctx.audit.append({ actor: actorOf(user), action: 'publicite.vehicle.checked', resourceType: 'vehicle_plate', resourceId: plate, details: { found: devices.length } });
  return {
    plate, items: devices.map((d) => itemOf(svc, d, null)),
    notice: devices.length
      ? 'Publicité(s) déclarée(s) pour ce véhicule. Vérifiez que le visuel porté correspond (type, surface, faces).'
      : 'Aucune publicité mobile déclarée pour ce véhicule. S’il porte une publicité, constatez « non déclaré » (support mobile, plaque du véhicule, photos).',
  };
}
