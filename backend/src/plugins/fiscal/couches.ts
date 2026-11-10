/**
 * Couches du cadastre fiscal géospatial (Document maître FR 2, nouvelle version, § 17.1) : pour chacune des 21 couches
 * nommées par le Cahier, la source dans la plateforme, l'écran ou la route qui la sert et l'effectif courant lu dans les
 * dépôts. Une couche sans source de données dans la plateforme est déclarée « non disponible » (jamais simulée) ; le
 * potentiel estimé reste « non mesuré » sans modèle certifié. Agrégats seulement, sans donnée nominative. Le cadastre
 * fiscal ne tranche aucun droit réel (§ 17).
 */
import type { User } from '../../core/auth.js';
import { authorize } from '../../core/policy.js';
import { COMMUNES } from '../../reference/kinshasa.js';
import type { FiscalObject, ObjectCategory } from '../../modules/objects/service.js';
import type { FiscalDeps } from './common.js';

export type LayerStatus = 'DISPONIBLE' | 'NON_MESURE' | 'NON_DISPONIBLE';

export interface LayerView {
  code: string;
  label: string;
  status: LayerStatus;
  count: number | null;
  source: string;
  served: string;
  note?: string;
}

const typeOf = (o: FiscalObject) => (typeof o.attributes['objectType'] === 'string' ? (o.attributes['objectType'] as string) : null);

export function layersCatalogue(d: FiscalDeps, user: User): { layers: LayerView[]; notice: string } {
  authorize(user, 'fiscal:map.objects', user.territory ? { communes: user.territory } : {});
  const objs = d.ctx.objects.objects.all().filter((o) => !user.territory || user.territory.includes(o.commune));
  const cat = (c: ObjectCategory) => objs.filter((o) => o.category === c).length;
  const typed = (...t: string[]) => objs.filter((o) => { const x = typeOf(o); return !!x && t.includes(x); }).length;
  const ext = <T>(name: string) => d.ctx.ext[name] as T | undefined;
  const repoCount = (name: string, repo: string): number | null => {
    const e = ext<Record<string, { count?: () => number } | undefined>>(name);
    const r = e?.[repo];
    return r && typeof r.count === 'function' ? r.count() : null;
  };
  const avail = (n: number | null): LayerStatus => (n === null ? 'NON_DISPONIBLE' : 'DISPONIBLE');
  const L = (code: string, label: string, count: number | null, source: string, served: string, note?: string, status?: LayerStatus): LayerView =>
    ({ code, label, status: status ?? avail(count), count, source, served, ...(note ? { note } : {}) });
  const geo = (level: 'QUARTIER' | 'AVENUE') => d.geo.list({ level }).filter((g) => !user.territory || user.territory.includes(g.commune)).length;
  const zones = repoCount('parking', 'zones');
  const markets = repoCount('verticales', 'markets');
  const stations = repoCount('rakapay', 'stations');
  const layers: LayerView[] = [
    L('COMMUNES', 'Communes', user.territory ? user.territory.length : COMMUNES.length, 'Référentiel territorial (24 communes)', 'GET /v1/fiscal/geo-units?level=COMMUNE'),
    L('QUARTIERS', 'Quartiers', geo('QUARTIER'), 'Hiérarchie SIG (quartiers créés à la validation)', 'GET /v1/fiscal/geo-units?level=QUARTIER'),
    L('AVENUES', 'Avenues et rues', geo('AVENUE'), 'Hiérarchie SIG (voies)', 'GET /v1/fiscal/geo-units?level=AVENUE'),
    L('PARCELLES', 'Parcelles', cat('PARCELLE'), 'Objets fiscaux', 'GET /v1/fiscal/map ; /fiscal/carte'),
    L('BATIMENTS', 'Bâtiments', cat('BATIMENT'), 'Objets fiscaux', 'GET /v1/fiscal/map ; /fiscal/carte'),
    L('UNITES', 'Unités', cat('UNITE_LOCATIVE'), 'Objets fiscaux', 'GET /v1/fiscal/map ; /fiscal/carte'),
    L('ETABLISSEMENTS', 'Établissements', cat('ACTIVITE') + typed('ETABLISSEMENT'), 'Objets fiscaux (activités, établissements)', 'GET /v1/fiscal/map ; /autour-de-moi'),
    L('MARCHES', 'Marchés', markets, 'Verticale Marchés et domaine public', 'GET /v1/verticales/marches/plan'),
    L('ZONES_STATIONNEMENT', 'Zones de stationnement', zones, 'Stationnement intelligent (ParkSmart)', 'GET /v1/parking/zones ; /stationnement'),
    L('PANNEAUX', 'Panneaux', cat('PANNEAU'), 'Publicité extérieure (KIN PUB CONTROL)', 'GET /v1/publicite/carte/couches ; /publicite'),
    L('ANTENNES', 'Antennes', typed('SITE_TELECOM'), 'Verticale Télécom (sites)', 'Espace de la verticale Télécom'),
    L('AXES_TRANSPORT', 'Axes de transport', stations, 'Stations de la billetterie (RakaPay) — les axes eux-mêmes ne sont pas encore cartographiés', 'GET /v1/rakapay/stations',
      'Couche partielle : stations seulement ; tracé des axes à fournir par le référentiel du transport.', stations === null ? 'NON_DISPONIBLE' : 'DISPONIBLE'),
    L('PORTS', 'Ports et points d’embarquement', null, 'Verticale Ports (cadrage sectoriel préalable)', '—',
      'Aucune donnée de points d’embarquement dans la plateforme : cadrage sectoriel préalable (verticale Ports).', 'NON_DISPONIBLE'),
    L('EMBARCATIONS', 'Embarcations', typed('EMBARCATION'), 'Verticale Ports (embarcations)', 'Espace de la verticale Ports'),
    L('CONCESSIONS', 'Concessions', typed('CONCESSION_FORESTIERE', 'CARRIERE'), 'Verticales Forêts et Carrières', 'Espaces des verticales Forêts et Carrières'),
    L('INFRASTRUCTURES_PUBLIQUES', 'Infrastructures publiques', null, 'Projets publics (planification)', '—',
      'Aucune couche géoréférencée d’infrastructures publiques : les projets publics sont suivis sans emprise cartographique.', 'NON_DISPONIBLE'),
    L('ZONES_INSPECTION', 'Zones d’inspection', repoCount('terrain', 'missions'), 'Missions de terrain (zones assignées)', 'GET /v1/terrain/findings ; /terrain'),
    L('CHALEUR_RECETTES', 'Cartes de chaleur des recettes', COMMUNES.length, 'Échelle de la recette par commune (tableau du Gouverneur)', 'GET /v1/pilotage/echelle ; /gouverneur'),
    L('COUVERTURE_RECENSEMENT', 'Couverture du recensement', objs.length, 'Couche « vérification / couverture » de la carte fiscale', 'GET /v1/fiscal/map?layer=couverture'),
    L('CONFORMITE', 'Niveaux de conformité', objs.length, 'Couche « situation fiscale » (vert, ambre, rouge, gris, bleu)', 'GET /v1/fiscal/map?layer=situation'),
    L('POTENTIEL', 'Potentiel estimé', null, 'Modèle de potentiel (non certifié)', 'GET /v1/pilotage/indicateurs (TAUX_RECENSEMENT : non mesuré)',
      'Non mesuré tant qu’aucun modèle de potentiel certifié n’existe : jamais inventé.', 'NON_MESURE'),
  ];
  return { layers, notice: 'Couches du § 17.1 : effectifs du périmètre du lecteur, sans donnée nominative. Le cadastre fiscal localise des objets générateurs de recettes sans trancher les droits réels.' };
}
