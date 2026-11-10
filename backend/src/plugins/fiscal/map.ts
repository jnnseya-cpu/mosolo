/**
 * Carte à deux couches (§ 16.6, module 9 F6) : « situation fiscale » et « vérification / couverture du recensement ».
 * Visibilité par rôle : grand public = agrégats par commune avec seuil minimal (aucune maille < 20 objets) ;
 * contribuable = ses propres objets ; agents = objets de leur périmètre (sans montant) ; mêmes règles de
 * confidentialité pour les deux couches.
 */
import type { MapStatusColor } from '@mosolo/shared';
import type { User } from '../../core/auth.js';
import { evaluate } from '../../core/policy.js';
import { COMMUNES } from '../../reference/kinshasa.js';
import type { FiscalObject } from '../../modules/objects/service.js';
import { CATEGORY_LABELS, type FiscalDeps } from './common.js';
import { COMMUNE_CODES } from './geo.js';
import type { RelationService } from './relations.js';
import { COVERAGE_LEGEND, coverageOf, SITUATION_LEGEND, situationOf } from './situation.js';

export type MapLayer = 'situation' | 'couverture';
export const AGGREGATION_THRESHOLD = 20;
const COLORS: MapStatusColor[] = ['green', 'amber', 'red', 'grey', 'blue'];

export function buildMap(d: FiscalDeps, relations: RelationService, user: User | undefined, layer: MapLayer, commune?: string) {
  const colorOf = (o: FiscalObject) => (layer === 'situation' ? situationOf(d, o) : coverageOf(d, o, relations));
  const all = d.ctx.objects.objects.all().filter((o) => !commune || o.commune === commune);
  const legend = Object.entries(layer === 'situation' ? SITUATION_LEGEND : COVERAGE_LEGEND).map(([color, label]) => ({ color, label }));

  let scope: 'PUBLIC' | 'CONTRIBUABLE' | 'AGENT' = 'PUBLIC';
  let visible: FiscalObject[] = [];
  if (user) {
    const agentAccess = (o: FiscalObject) => evaluate(user, 'fiscal:map.objects', { communes: [o.commune] });
    if (user.roles.some((r) => r === 'R30' || r === 'R31')) {
      scope = 'CONTRIBUABLE';
      const ids = new Set<string>();
      for (const tp of [user.taxpayerId, ...(user.mandants ?? [])].filter((x): x is string => !!x)) for (const id of relations.objectIdsOf(tp)) ids.add(id);
      visible = all.filter((o) => ids.has(o.id));
    } else if (all.some((o) => agentAccess(o))) {
      scope = 'AGENT';
      visible = all.filter((o) => agentAccess(o));
    }
  }

  // Agrégats par commune (toujours) : masqués sous le seuil pour qui n'a pas accès nominatif à la commune.
  const communes = COMMUNES.filter((c) => !commune || c === commune).map((c) => {
    const objs = all.filter((o) => o.commune === c);
    const byColor = Object.fromEntries(COLORS.map((k) => [k, 0])) as Record<MapStatusColor, number>;
    for (const o of objs) byColor[colorOf(o).color]++;
    const nominative = scope === 'AGENT' && visible.some((o) => o.commune === c);
    const masked = !nominative && objs.length > 0 && objs.length < AGGREGATION_THRESHOLD;
    const dominant = objs.length ? COLORS.reduce((a, b) => (byColor[b] > byColor[a] ? b : a), 'grey' as MapStatusColor) : 'grey';
    return {
      commune: c, code: COMMUNE_CODES[c], total: masked ? null : objs.length,
      byColor: masked ? null : byColor, dominant: masked || !objs.length ? 'grey' : dominant, masked,
    };
  });

  const objects = visible.map((o) => {
    const c = colorOf(o);
    return {
      id: o.id, igf: o.igf?.code ?? null, category: o.category, categoryLabel: CATEGORY_LABELS[o.category] ?? o.category,
      commune: o.commune, quartier: o.quartier, lat: o.lat, lon: o.lon, color: c.color, label: c.label, reason: c.reason,
      demo: o.attributes['demo'] === true || o.id.includes('DEMO'),
    };
  });

  return {
    layer, scope, legend, threshold: AGGREGATION_THRESHOLD, communes, objects,
    notice: scope === 'PUBLIC'
      ? `Vue publique : agrégats par commune uniquement, masqués sous ${AGGREGATION_THRESHOLD} objets. Aucune situation individuelle.`
      : scope === 'CONTRIBUABLE' ? 'Vos biens uniquement.' : 'Objets de votre périmètre — aucun montant affiché.',
    example: true,
  };
}
