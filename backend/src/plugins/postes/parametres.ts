/**
 * Paramètres du registre des seuils propres aux postes de décision (Cahier nouvelle version, ch. 27) : seuils de
 * remontée par catégorie (§ 27.4), remontée par ancienneté, montant et gravité, taille de corbeille suivie, durées de
 * délégation et d'habilitation de consultation, plafond de notifications, session courte des postes de décision.
 *
 * TOUTES les valeurs sont PAR_DEFAUT — à confirmer par le maître d'ouvrage. Elles vivent dans le registre des seuils
 * (integrite/gouvernance/parametres.ts) : toute modification passe par le circuit à deux personnes du registre
 * (proposition motivée, approbation par une autre personne, journalisées). Les seuils de délégation en matière
 * d'exonération et de dégrèvement relèvent du ministre provincial des Finances (maquette § 4) : ils figurent sur son
 * poste ; leur modification suit le circuit du registre sans aucun changement d'habilitation (le ministre des Finances
 * figure déjà parmi les approbateurs du registre).
 *
 * Fichier sans dépendance d'exécution (import de type seulement) : lisible par tous les modules sans cycle d'import.
 */
import type { ParamDefinition, ParamValue } from '../integrite/gouvernance/parametres.js';

const FILE = 'backend/src/plugins/postes/parametres.ts';
const CAT = 'Postes de décision (ch. 27)';
const R = (id: string, label: string, value: ParamValue, unit: string, bounds: { min?: number; max?: number } = {}, description?: string): ParamDefinition => ({
  id, label, category: CAT, value, unit, owner: 'REGISTRE', source: { file: FILE, constant: 'PARAMETRES_POSTES', exported: true }, ...bounds,
  ...(description ? { description } : {}),
});

const TOUT = '0 = tout élément de la catégorie remonte (aucun seuil de montant).';

export const PARAMETRES_POSTES: ParamDefinition[] = [
  // § 27.4 — seuils par catégorie (contre-valeur CDF de l'enjeu)
  R('postes.seuil.publication_regle_cdf', 'Remontée : publication d’une règle ou d’un nouveau taux — seuil d’enjeu', 0, 'CDF', { min: 0, max: 1e15 }, TOUT),
  R('postes.seuil.changement_compte_beneficiaire_cdf', 'Remontée : changement d’un compte public bénéficiaire — seuil d’enjeu', 0, 'CDF', { min: 0, max: 1e15 }, TOUT),
  R('postes.seuil.exoneration_degrevement_cdf', 'Seuil de délégation : exonération, annulation ou dégrèvement remontant au ministre des Finances', 10_000_000, 'CDF', { min: 0, max: 1e15 },
    'En deçà, le service compétent tranche dans son propre périmètre (§ 27.4). Seuil de délégation du ministre provincial des Finances (maquette § 4) : toute modification passe par le circuit à deux personnes du registre, que le ministre des Finances approuve selon la matrice d’habilitations existante.'),
  R('postes.seuil.suspension_tiers_cdf', 'Remontée : suspension d’un partenaire, d’un centre agréé ou d’un prestataire — seuil d’enjeu', 0, 'CDF', { min: 0, max: 1e15 }, TOUT),
  R('postes.seuil.mesure_irreversible_bien_cdf', 'Remontée : mesure irréversible sur un bien — seuil d’enjeu', 0, 'CDF', { min: 0, max: 1e15 }, TOUT),
  R('postes.seuil.ouverture_enquete_interne_cdf', 'Remontée : ouverture d’une enquête interne — seuil d’enjeu', 0, 'CDF', { min: 0, max: 1e15 }, TOUT),
  R('postes.seuil.arbitrage_assignations_cdf', 'Remontée : arbitrage des assignations et objectifs — seuil d’enjeu', 0, 'CDF', { min: 0, max: 1e15 }, TOUT),
  R('postes.seuil.phase_contrainte_cdf', 'Remontée : déclenchement ou levée d’une phase de contrainte — seuil d’enjeu', 0, 'CDF', { min: 0, max: 1e15 }, TOUT),
  R('postes.seuil.affectation_fonds_cdf', 'Remontée : scénario d’affectation de fonds disponibles — seuil d’enjeu', 0, 'CDF', { min: 0, max: 1e15 }, TOUT),
  R('postes.seuil.alerte_deperdition_cdf', 'Remontée : alerte de déperdition — seuil d’enjeu (information immédiate du Gouverneur)', 5_000_000, 'CDF', { min: 0, max: 1e15 }),
  // Remontée à l'autorité supérieure (lecture et relance), sans retirer l'élément du décideur d'origine
  R('postes.remontee.age_n1_jours', 'Remontée d’un niveau : ancienneté d’un élément en attente', 7, 'jours', { min: 1, max: 365 }),
  R('postes.remontee.age_n2_jours', 'Remontée de deux niveaux : ancienneté d’un élément en attente', 15, 'jours', { min: 1, max: 730 }),
  R('postes.remontee.montant_n1_cdf', 'Remontée d’un niveau : enjeu au-delà de', 50_000_000, 'CDF', { min: 0, max: 1e15 }, '0 = aucune remontée par le montant.'),
  R('postes.remontee.montant_n2_cdf', 'Remontée de deux niveaux : enjeu au-delà de', 250_000_000, 'CDF', { min: 0, max: 1e15 }, '0 = aucune remontée par le montant.'),
  R('postes.remontee.gravite_min', 'Remontée d’un niveau : gravité minimale (1 normale, 2 haute, 3 critique)', 3, 'niveau', { min: 1, max: 3 }),
  // Corbeille, échéances, urgence
  R('postes.corbeille.taille_alerte', 'Taille de corbeille au-delà de laquelle une alerte de revue des seuils est levée', 10, 'éléments', { min: 1, max: 1000 },
    '§ 27.4 : « une corbeille qui dépasse une dizaine d’éléments cesse d’être lue ».'),
  R('postes.corbeille.alerte_jours', 'Nombre de jours consécutifs au-delà de la taille avant alerte (« durablement »)', 5, 'jours', { min: 1, max: 90 }),
  R('postes.fiche.delai_defaut_jours', 'Échéance d’une fiche sans date limite de la source : délai après dépôt', 10, 'jours', { min: 1, max: 365 }),
  R('postes.fiche.urgence_jours', 'Fiche urgente : échéance dans moins de', 2, 'jours', { min: 0, max: 60 }),
  // Délégation, habilitation de consultation, notifications, session
  R('postes.delegation.duree_max_jours', 'Délégation d’une catégorie de décisions : durée maximale', 90, 'jours', { min: 1, max: 730 }),
  R('postes.consultation.duree_max_jours', 'Habilitation de consultation d’une autre autorité : durée maximale', 730, 'jours', { min: 1, max: 1830 }),
  R('postes.notifications.plafond_defaut', 'Notifications par jour et par autorité : plafond par défaut (fixé ensuite par l’autorité elle-même)', 5, 'notifications', { min: 1, max: 100 }),
  R('postes.session.duree_max_min', 'Poste de décision : âge maximal de la session pour décider (session courte)', 30, 'min', { min: 5, max: 480 },
    'Au-delà, une nouvelle authentification est demandée avant toute décision (jamais en deçà des exigences existantes).'),
];

/** Lecture d'un paramètre : valeur en vigueur du registre (module de gouvernance chargé) ou valeur par défaut. */
export function posteParam(ctx: { ext: Record<string, unknown> }, id: string): number {
  const gov = ctx.ext['integrite-gouvernance'] as { value?: (id: string) => ParamValue } | undefined;
  if (gov?.value) {
    try { return Number(gov.value(id)); } catch { /* paramètre inconnu du registre chargé : défaut ci-dessous */ }
  }
  const d = PARAMETRES_POSTES.find((p) => p.id === id);
  if (!d) throw new Error(`Paramètre des postes inconnu : ${id}`);
  return Number(d.value);
}
