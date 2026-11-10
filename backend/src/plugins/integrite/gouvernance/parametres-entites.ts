/**
 * Variables par département (27/09/2026, demande du maître d'ouvrage : « l'administrateur rattache des variables aux
 * départements ») — surcharges par entité des paramètres du registre des seuils.
 *
 * Règles :
 *  - seul un paramètre déclaré « modulable par entité » ci-dessous peut recevoir une surcharge ; la liste est PAR DÉFAUT
 *    — à confirmer par le maître d'ouvrage (chaque entrée est un paramètre du REGISTRE déjà lu par un consommateur
 *    branché sur la résolution par entité) ;
 *  - les variables des barèmes juridiques (tables de taux des règles) restent gouvernées par le registre des règles et
 *    ses quatre visas : JAMAIS de surcharge d'entité ;
 *  - toute surcharge passe par le circuit à deux personnes du registre (proposition motivée, date d'effet, approbation
 *    par une personne distincte), journalisé ;
 *  - résolution : entité → entité parente (en remontant) → valeur globale du registre.
 *
 * Fichier sans dépendance d'exécution : lisible par les consommateurs sans cycle d'import.
 */
import type { ParamValue } from './parametres.js';

export const STATUT_MODULABLE = 'PAR_DEFAUT — à confirmer par le maître d’ouvrage';

/** Paramètres modulables par entité, avec le consommateur qui applique la valeur de l'entité. */
export const MODULABLES_PAR_ENTITE: Readonly<Record<string, { consommateur: string; entite: string }>> = {
  'plafonds.agent.alerte_jour': { consommateur: 'integrite/securite/surveillance.ts — alerte de références par agent', entite: 'entité de l’agent' },
  'plafonds.agent.max_jour': { consommateur: 'integrite/securite/surveillance.ts — plafond bloquant de références par agent', entite: 'entité de l’agent' },
  'dlp.lectures_max': { consommateur: 'integrite/securite/surveillance.ts — lecture massive (DLP)', entite: 'entité de la personne qui lit' },
  'postes.notifications.plafond_defaut': { consommateur: 'postes/service.ts — plafond de notifications par autorité', entite: 'entité de l’autorité' },
  'postes.corbeille.taille_alerte': { consommateur: 'postes/service.ts — alerte de taille de corbeille', entite: 'entité de l’autorité' },
};

export const isModulable = (id: string): boolean => Object.hasOwn(MODULABLES_PAR_ENTITE, id);

/** Surcharge approuvée d'un paramètre pour une entité. */
export interface EntityOverride {
  /** `${parameterId}|${entity}` */
  id: string;
  parameterId: string;
  entity: string;
  value: ParamValue;
  effectiveFrom: string;
  status: 'ACTIVE' | 'RETIREE';
  requestId: string;
  proposedBy: string;
  approvedBy: string;
  acte?: string;
  history: { at: string; by: string; action: string; value: ParamValue | null; effectiveFrom: string; requestId: string }[];
}

/** Lecture d'un paramètre pour une entité (valeur de l'entité, de sa lignée, sinon globale) — module de gouvernance chargé. */
export function paramForEntity(ctx: { ext: Record<string, unknown> }, id: string, entity: string | undefined, fallback: () => ParamValue): ParamValue {
  const gov = ctx.ext['integrite-gouvernance'] as { valueFor?: (id: string, entity: string) => ParamValue } | undefined;
  if (entity && gov?.valueFor && isModulable(id)) {
    try { return gov.valueFor(id, entity); } catch { /* repli ci-dessous */ }
  }
  return fallback();
}
