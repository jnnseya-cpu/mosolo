/**
 * « Autour de moi » — agents des modules liés aux biens et aux activités physiques (propriété, locatif, entreprises,
 * marchés, chantiers, sites, publicité) : une fois SUR PLACE, dans leur secteur, ils voient les biens et commerces
 * proches en VERT (à jour), AMBRE (paiement partiel, échéance proche, revue) ou ROUGE (en retard), plus gris (non
 * encore liquidé) et bleu (en litige).
 *
 * Garde-fous :
 * - position GPS précise obligatoire (100 m au plus) ; aucune liste sans position ;
 * - la position doit se trouver dans le secteur de l'agent (commune de son périmètre) — « une fois dans la zone » ;
 * - rayon limité (1 km au plus) ; seuls les objets que la matrice d'habilitations autorise sont listés ;
 * - aucun montant, aucun nom de contribuable pour l'agent de terrain : couleur, motif, référence, distance ;
 * - chaque consultation est journalisée (position, précision, rayon, nombre d'objets montrés).
 * La couleur est une information de ciblage : elle ne vaut ni constat ni sanction (circuit RW1 inchangé).
 */
import type { MapStatusColor } from '@mosolo/shared';
import type { User } from '../../core/auth.js';
import { forbidden, unprocessable } from '../../core/errors.js';
import { evaluate } from '../../core/policy.js';
import type { FiscalObject } from '../../modules/objects/service.js';
import { distanceM } from '../terrain/geo.js';
import { COMMUNE_CENTROIDS, VERTICALS } from '../verticales/catalogue.js';
import type { VerticalesService } from '../verticales/service.js';
import { actorOf, CATEGORY_LABELS, type FiscalDeps } from './common.js';
import type { PropertyService } from './properties.js';
import { SITUATION_LEGEND, situationOf } from './situation.js';

export const NEARBY_MAX_ACCURACY_M = 100;
export const NEARBY_DEFAULT_RADIUS_M = 300;
export const NEARBY_MAX_RADIUS_M = 1000;
/** Au-delà de cette distance du plus proche objet connu, la commune de la position est estimée par le centre de commune. */
const AREA_OBJECT_RADIUS_M = 1500;
/** Catégories non rattachées à un lieu fixe : exclues. */
const MOBILE_CATEGORIES = new Set(['VEHICULE']);

export interface NearbyItem {
  id: string; reference: string; label: string; category: string; categoryLabel: string; vertical: string | null;
  commune: string; quartier: string; avenue: string | null; lat: number; lon: number; distanceM: number;
  color: MapStatusColor; colorLabel: string; reason: string; plate: string | null; validated: boolean; demo: boolean;
}

export function buildNearby(d: FiscalDeps, properties: PropertyService, user: User, q: { lat: number; lon: number; accuracyM: number; radiusM?: number }) {
  if (!evaluate(user, 'fiscal:nearby', { communes: user.territory ?? [] })) {
    throw forbidden('NEARBY_FORBIDDEN', 'Vue « Autour de moi » réservée aux agents des modules liés aux biens et aux activités.');
  }
  if (!(q.accuracyM > 0) || q.accuracyM > NEARBY_MAX_ACCURACY_M) {
    throw unprocessable('GPS_TOO_IMPRECISE', `Position trop imprécise (± ${Math.round(q.accuracyM)} m) : ${NEARBY_MAX_ACCURACY_M} m au plus. Relancez le GPS à découvert.`, { maxAccuracyM: NEARBY_MAX_ACCURACY_M });
  }
  const radius = Math.min(NEARBY_MAX_RADIUS_M, Math.max(50, Math.round(q.radiusM ?? NEARBY_DEFAULT_RADIUS_M)));
  const here = { lat: q.lat, lon: q.lon };
  const all = d.ctx.objects.objects.all().filter((o) => !MOBILE_CATEGORIES.has(o.category) && Number.isFinite(o.lat) && Number.isFinite(o.lon));

  // Commune où se trouve l'agent : celle du plus proche objet connu, sinon du centre de commune le plus proche.
  let nearest: { o: FiscalObject; m: number } | null = null;
  for (const o of all) { const m = distanceM(here, o); if (!nearest || m < nearest.m) nearest = { o, m }; }
  let commune: string;
  let communeBasis: 'OBJET_PROCHE' | 'CENTRE_DE_COMMUNE';
  if (nearest && nearest.m <= AREA_OBJECT_RADIUS_M) { commune = nearest.o.commune; communeBasis = 'OBJET_PROCHE'; } else {
    commune = Object.entries(COMMUNE_CENTROIDS).reduce((best, [c, [lat, lon]]) => {
      const m = distanceM(here, { lat, lon });
      return m < best.m ? { c, m } : best;
    }, { c: '', m: Infinity }).c;
    communeBasis = 'CENTRE_DE_COMMUNE';
  }
  const inArea = !user.territory?.length || user.territory.includes(commune);

  const vx = d.ctx.ext.verticales as VerticalesService | undefined;
  const verticalName = (o: FiscalObject) => {
    const slug = vx?.verticalOf(o);
    return slug ? VERTICALS.find((v) => v.slug === slug)?.short ?? slug : null;
  };
  const plateOf = (o: FiscalObject) => {
    const fp = properties.plates.find((p) => p.objectId === o.id && p.status !== 'REMPLACEE').at(-1);
    if (fp) return fp.nfiu;
    const vp = vx?.plates.find((p) => p.objectId === o.id && p.status === 'POSEE').at(-1);
    return vp?.code ?? null;
  };

  const items: NearbyItem[] = [];
  if (inArea) {
    for (const o of all) {
      const m = distanceM(here, o);
      if (m > radius) continue;
      if (!evaluate(user, 'fiscal:nearby', { communes: [o.commune] })) continue;
      const s = situationOf(d, o);
      const desc = vx?.describeObject(o);
      items.push({
        id: o.id, reference: o.igf?.code ?? desc?.ref ?? o.id, label: desc?.label ?? CATEGORY_LABELS[o.category] ?? o.category,
        category: o.category, categoryLabel: CATEGORY_LABELS[o.category] ?? o.category, vertical: verticalName(o),
        commune: o.commune, quartier: o.quartier, avenue: o.avenue ?? null, lat: o.lat, lon: o.lon, distanceM: m,
        color: s.color, colorLabel: s.label, reason: s.reason, plate: plateOf(o), validated: o.status === 'VALIDE',
        demo: o.attributes['demo'] === true || o.id.includes('DEMO'),
      });
    }
    items.sort((a, b) => a.distanceM - b.distanceM);
  }
  const counts = { green: 0, amber: 0, red: 0, grey: 0, blue: 0 } as Record<MapStatusColor, number>;
  for (const i of items) counts[i.color]++;

  d.ctx.audit.append({
    actor: actorOf(user), action: 'fiscal.nearby.viewed', resourceType: 'position', resourceId: `${q.lat.toFixed(5)},${q.lon.toFixed(5)}`,
    details: { accuracyM: Math.round(q.accuracyM), radiusM: radius, commune, communeBasis, inArea, shown: items.length, red: counts.red },
  });

  return {
    at: d.nowIso(), position: { lat: q.lat, lon: q.lon, accuracyM: Math.round(q.accuracyM) }, radiusM: radius, maxRadiusM: NEARBY_MAX_RADIUS_M,
    commune, communeBasis, inArea, territory: user.territory ?? null, counts, items,
    legend: (['green', 'amber', 'red', 'grey', 'blue'] as MapStatusColor[]).map((c) => ({ color: c, label: SITUATION_LEGEND[c] })),
    notice: inArea
      ? 'Situation indicative, sans montant : elle oriente la visite et ne vaut ni constat ni sanction. N’encaissez rien ; l’usager paie par les canaux officiels.'
      : `Vous êtes hors de votre secteur (position estimée : ${commune}). La vue « Autour de moi » ne s’affiche que dans les communes de votre périmètre.`,
    example: true,
  };
}
