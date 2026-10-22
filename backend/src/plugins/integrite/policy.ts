/**
 * Matrice d'habilitations du module Intégrité (moindre privilège : ce qui n'est pas listé est refusé).
 * - R24 enquêteur : qualifie, instruit, conclut — ne décide jamais de la suite de son propre dossier.
 * - R06 / R21 : décident de la suite d'un dossier (personne distincte de l'enquêteur).
 * - R22 auditeur interne : lecture, contrôles mystère ; ne modifie rien d'autre.
 * - R25 délégué à la protection des données : demandes des personnes, registre des traitements.
 * - R28 responsable sécurité : incidents, campagnes de revue des accès.
 * - R12 guichet : enregistre un signalement reçu au numéro gratuit ou au guichet (opérateur de ligne).
 */
import { allAgentRoles, definePolicy, GRANTS } from '../../core/policy.js';

const { always, ownTaxpayer, mandant, sameEntity } = GRANTS;

export function declareIntegritePolicies(): void {
  // Signalements
  definePolicy('integrite:report.intake', { R12: always, R24: always });
  definePolicy('integrite:report.read', { R24: always, R22: always });
  definePolicy('integrite:report.qualify', { R24: always });
  definePolicy('integrite:report.assign', { R24: always });
  definePolicy('integrite:report.respond', { R24: always });
  definePolicy('integrite:report.close', { R24: always });
  // Signaux et alertes
  definePolicy('integrite:observation.submit', { R24: always, R32: always, R33: always });
  definePolicy('integrite:alert.read', { R24: always, R22: always, R28: always });
  definePolicy('integrite:detection.run', { R24: always, R22: always, R28: always });
  definePolicy('integrite:alert.examine', { R24: always });
  definePolicy('integrite:alert.validate', { R24: always, R28: always });
  // Dossiers d'enquête
  definePolicy('integrite:case.read', { R24: always, R22: always, R06: always, R21: always });
  definePolicy('integrite:case.open', { R24: always });
  definePolicy('integrite:case.instruct', { R24: always });
  definePolicy('integrite:case.decide', { R06: always, R21: always });
  // Contrôles mystère
  definePolicy('integrite:mystery.read', { R22: always, R24: always });
  definePolicy('integrite:mystery.plan', { R22: always, R24: always });
  definePolicy('integrite:mystery.record', { R22: always, R24: always });
  // Incidents de sécurité
  definePolicy('integrite:incident.declare', { ...allAgentRoles(always) });
  definePolicy('integrite:incident.read', { R28: always, R27: always, R26: always, R25: always, R22: always });
  definePolicy('integrite:incident.manage', { R28: always, R27: always });
  definePolicy('integrite:incident.close', { R28: always });
  definePolicy('integrite:incident.notify', { R28: always, R25: always });
  definePolicy('integrite:incident.notify-persons', { R25: always });
  // Protection des données
  definePolicy('integrite:privacy.submit', { R30: ownTaxpayer, R31: mandant, R12: always });
  definePolicy('integrite:privacy.own', { R30: ownTaxpayer, R31: mandant });
  definePolicy('integrite:privacy.process', { R25: always });
  definePolicy('integrite:privacy.registry.read', { R25: always, R22: always, R23: always, R28: always, R26: always });
  definePolicy('integrite:privacy.registry.write', { R25: always });
  definePolicy('integrite:privacy.accesslog', { R25: always, R22: always });
  // Revue des accès
  definePolicy('integrite:access-review.launch', { R28: always });
  definePolicy('integrite:access-review.read', { R28: always, R08: always, R22: always, R25: always });
  definePolicy('integrite:access-review.decide', { R28: always, R08: sameEntity });
  definePolicy('integrite:access-review.close', { R28: always });
  // Indicateurs agrégés
  definePolicy('integrite:indicators.read', { R24: always, R22: always, R28: always, R25: always, R01: always, R02: always, R05: always });
}
