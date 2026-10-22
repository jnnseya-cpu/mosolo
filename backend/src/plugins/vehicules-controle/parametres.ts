/**
 * Seuils de la chaîne véhicule versés au registre des seuils anti-fraude (integrite/gouvernance/parametres.ts) :
 * constantes importées (jamais recopiées), statut « par défaut — à confirmer par le maître d'ouvrage ».
 * Aucun tarif ni taux n'y figure : les frais relèvent des fiches du registre juridique.
 */
import type { ParamDefinition } from '../integrite/gouvernance/parametres.js';
import { ANALYTIQUE_HISTORIQUE_SEMAINES, ANALYTIQUE_PARAMS, FOURRIERE_ALERTE_GARDE_JOURS, PV_TRANSMISSION_MAX_MINUTES, REPRISE_ECHANTILLON } from './model.js';

const F = 'plugins/vehicules-controle/model.ts';
const src = (constant: string) => ({ file: `backend/src/${F}`, constant, exported: true });
const C = (id: string, label: string, value: number, unit: string, constant: string, description?: string): ParamDefinition => ({
  id, label, category: 'Chaîne véhicule (RFCK)', value, unit, owner: 'CODE', source: src(constant), ...(description ? { description } : {}),
});

export const PARAMETRES_VEHICULES: ParamDefinition[] = [
  C('vehicules.pv_transmission_max_min', 'Contrôle technique : délai maximal de transmission du procès-verbal après le contrôle', PV_TRANSMISSION_MAX_MINUTES, 'min', 'PV_TRANSMISSION_MAX_MINUTES',
    'Au-delà, le procès-verbal est refusé : jamais de ressaisie ultérieure.'),
  C('vehicules.fourriere_alerte_garde_j', 'Fourrière : garde au-delà de laquelle une alerte est levée', FOURRIERE_ALERTE_GARDE_JOURS, 'jours', 'FOURRIERE_ALERTE_GARDE_JOURS',
    'Alerte à examiner par une personne ; aucune destination légale automatique.'),
  C('vehicules.centres_taux_reussite_pct', 'Centres : taux de réussite signalé comme anormal', ANALYTIQUE_PARAMS.tauxReussiteAlertePct, '%', 'ANALYTIQUE_PARAMS.tauxReussiteAlertePct', 'Alerte seulement ; suspension uniquement par décision motivée de la RFCK.'),
  C('vehicules.centres_echantillon_min', 'Centres : contrôles minimum avant de mesurer taux et uniformité', ANALYTIQUE_PARAMS.echantillonMin, 'contrôles', 'ANALYTIQUE_PARAMS.echantillonMin'),
  C('vehicules.centres_duree_min_min', 'Centres : durée d’inspection en deçà de laquelle elle est invraisemblable', ANALYTIQUE_PARAMS.dureeInspectionMinMinutes, 'min', 'ANALYTIQUE_PARAMS.dureeInspectionMinMinutes'),
  C('vehicules.centres_serie_nombre', 'Centres : contrôles d’un même inspecteur formant une série', ANALYTIQUE_PARAMS.serieMemeInspecteur, 'contrôles', 'ANALYTIQUE_PARAMS.serieMemeInspecteur'),
  C('vehicules.centres_serie_fenetre_min', 'Centres : fenêtre de la série d’un même inspecteur', ANALYTIQUE_PARAMS.serieFenetreMinutes, 'min', 'ANALYTIQUE_PARAMS.serieFenetreMinutes'),
  C('vehicules.reprise_echantillon', 'Reprise des registres RFCK : taille de l’échantillon contrôlé', REPRISE_ECHANTILLON, 'enregistrements', 'REPRISE_ECHANTILLON'),
  C('vehicules.analytique_historique_sem', 'Analytique des centres : historique exigé avant ouverture', ANALYTIQUE_HISTORIQUE_SEMAINES, 'semaines', 'ANALYTIQUE_HISTORIQUE_SEMAINES'),
];
