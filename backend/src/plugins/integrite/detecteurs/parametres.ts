/**
 * Seuils ajoutés par le lot trésorerie / recouvrement / sous-traitance / détecteurs, versés au registre des seuils
 * anti-fraude (integrite/gouvernance/parametres.ts) : constantes importées (jamais recopiées), statut « par défaut — à
 * confirmer par le maître d'ouvrage » tant qu'aucun acte n'est enregistré.
 */
import type { ParamDefinition } from '../gouvernance/parametres.js';
import { APPARIEMENT_SEUIL_PROPOSITION, TOLERANCE_CHANGE_PCT } from '../../tresor/appariement.js';
import { DOUBLON_DISTANCE_M, ROTATION_ZONE_BLOCAGE, ROTATION_ZONE_MAX_JOURS } from '../../terrain/qualite-fraude.js';
import { DETECTEURS_PARAMS } from './service.js';

const src = (file: string, constant: string) => ({ file: `backend/src/${file}`, constant, exported: true });
const C = (id: string, label: string, category: string, value: number | boolean, unit: string, source: ParamDefinition['source'], description?: string): ParamDefinition => ({
  id, label, category, value, unit, owner: 'CODE', source, ...(description ? { description } : {}),
});
const DET = 'plugins/integrite/detecteurs/service.ts';

export const PARAMETRES_COMPLEMENTAIRES: ParamDefinition[] = [
  C('tresor.appariement_seuil_proposition', 'Rapprochement : score minimal pour PROPOSER un appariement (confirmation humaine)', 'Trésor et quatre yeux', APPARIEMENT_SEUIL_PROPOSITION, 'points sur 100', src('plugins/tresor/appariement.ts', 'APPARIEMENT_SEUIL_PROPOSITION'),
    'L’appariement automatique reste réservé à la correspondance exacte ; sous ce seuil, rien n’est proposé.'),
  C('tresor.tolerance_change_pct', 'Rapprochement : tolérance de change d’un crédit en autre devise', 'Trésor et quatre yeux', TOLERANCE_CHANGE_PCT, '%', src('plugins/tresor/appariement.ts', 'TOLERANCE_CHANGE_PCT')),
  C('terrain.doublon_distance_m', 'Terrain : distance en deçà de laquelle deux nouveaux objets sont un doublon présumé', 'Contrôles et preuves', DOUBLON_DISTANCE_M, 'm', src('plugins/terrain/qualite-fraude.ts', 'DOUBLON_DISTANCE_M')),
  C('terrain.rotation_zone_max_j', 'Terrain : durée maximale d’un agent ou d’un sous-traitant sur une même commune', 'Rotation obligatoire', ROTATION_ZONE_MAX_JOURS, 'jours', src('plugins/terrain/qualite-fraude.ts', 'ROTATION_ZONE_MAX_JOURS')),
  C('terrain.rotation_zone_blocage', 'Terrain : bloquer l’affectation au-delà de la durée (sinon alerte seulement)', 'Rotation obligatoire', ROTATION_ZONE_BLOCAGE, 'oui/non', src('plugins/terrain/qualite-fraude.ts', 'ROTATION_ZONE_BLOCAGE')),
  C('detecteurs.ecart_fenetre_j', 'Détecteur écart constats / paiements : fenêtre d’analyse', 'Détection (Intégrité)', DETECTEURS_PARAMS.ecartFenetreJours, 'jours', src(DET, 'DETECTEURS_PARAMS.ecartFenetreJours')),
  C('detecteurs.ecart_delai_paiement_j', 'Détecteur écart constats / paiements : délai laissé au paiement', 'Détection (Intégrité)', DETECTEURS_PARAMS.ecartDelaiPaiementJours, 'jours', src(DET, 'DETECTEURS_PARAMS.ecartDelaiPaiementJours')),
  C('detecteurs.ecart_min_constats', 'Détecteur écart constats / paiements : constats minimum par zone', 'Détection (Intégrité)', DETECTEURS_PARAMS.ecartMinConstats, 'constats', src(DET, 'DETECTEURS_PARAMS.ecartMinConstats')),
  C('detecteurs.ecart_part_min_pct', 'Détecteur écart constats / paiements : part sans paiement déclenchant l’alerte', 'Détection (Intégrité)', DETECTEURS_PARAMS.ecartPartMinPct, '%', src(DET, 'DETECTEURS_PARAMS.ecartPartMinPct')),
  C('detecteurs.baisse_fenetre_j', 'Détecteur baisse des recettes d’une zone : durée de chaque fenêtre comparée', 'Détection (Intégrité)', DETECTEURS_PARAMS.baisseFenetreJours, 'jours', src(DET, 'DETECTEURS_PARAMS.baisseFenetreJours')),
  C('detecteurs.baisse_part_min_pct', 'Détecteur baisse des recettes d’une zone : baisse déclenchant l’alerte', 'Détection (Intégrité)', DETECTEURS_PARAMS.baissePartMinPct, '%', src(DET, 'DETECTEURS_PARAMS.baissePartMinPct')),
  C('detecteurs.baisse_min_paiements', 'Détecteur baisse des recettes d’une zone : paiements minimum de la période précédente', 'Détection (Intégrité)', DETECTEURS_PARAMS.baisseMinPaiements, 'paiements', src(DET, 'DETECTEURS_PARAMS.baisseMinPaiements')),
  C('detecteurs.proximite_fenetre_j', 'Détecteur proximité agent–objet : fenêtre', 'Détection (Intégrité)', DETECTEURS_PARAMS.proximiteFenetreJours, 'jours', src(DET, 'DETECTEURS_PARAMS.proximiteFenetreJours')),
  C('detecteurs.proximite_min_interventions', 'Détecteur proximité agent–objet : interventions d’un même agent sur un même objet', 'Détection (Intégrité)', DETECTEURS_PARAMS.proximiteMinInterventions, 'interventions', src(DET, 'DETECTEURS_PARAMS.proximiteMinInterventions')),
  C('detecteurs.intervalle_h', 'Détecteurs et ruptures de chaîne : intervalle d’exécution planifiée (0 = désactivée)', 'Détection (Intégrité)', DETECTEURS_PARAMS.intervalleHeures, 'h', src(DET, 'DETECTEURS_PARAMS.intervalleHeures')),
];
