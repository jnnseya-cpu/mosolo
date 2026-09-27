/**
 * Habilitations de la verticale ParkSmart (moindre privilège ; non déclaré ⇒ refusé ; jamais permis à l'IA).
 * Circuit RW1 : le contrôleur (R11) constate, le superviseur (R09) vérifie, la régie (R06/R07) décide,
 * le contentieux (R20/R21) traite les recours sur obligation.
 */
import { allAgentRoles, definePolicy, GRANTS } from '../../core/policy.js';

const { always, ownTaxpayer, mandant, sameEntity, inTerritory } = GRANTS;

export function declareParkingPolicies(): void {
  definePolicy('parking:zone.read', { ...allAgentRoles(always), R30: always, R31: always });
  definePolicy('parking:zone.manage', { R06: sameEntity, R07: sameEntity });
  definePolicy('parking:vehicle.declare', { R30: ownTaxpayer, R31: mandant });
  definePolicy('parking:session.create', { R30: ownTaxpayer, R31: mandant });
  definePolicy('parking:session.read', { R30: ownTaxpayer, R31: mandant, R06: sameEntity, R07: sameEntity, R22: always });
  definePolicy('parking:control', { R11: inTerritory('minimal'), R09: inTerritory('minimal') });
  definePolicy('parking:violation.record', { R11: inTerritory('full') });
  definePolicy('parking:violation.verify', { R09: inTerritory('full') });
  definePolicy('parking:violation.decide', { R06: sameEntity, R07: sameEntity });
  definePolicy('parking:violation.read', {
    R30: ownTaxpayer, R31: mandant, R11: inTerritory('full'), R09: inTerritory('full'), R06: sameEntity, R07: sameEntity,
    R20: always, R21: always, R22: always, R24: always,
  });
  definePolicy('parking:violation.contest', { R30: ownTaxpayer, R31: mandant });
  definePolicy('parking:reservation.request', { R30: ownTaxpayer, R31: mandant });
  definePolicy('parking:reservation.decide', { R06: sameEntity, R07: sameEntity });
  definePolicy('parking:partner.manage', { R06: sameEntity, R07: sameEntity });
  definePolicy('parking:partner.declare', { R30: ownTaxpayer, R06: sameEntity, R07: sameEntity });
  definePolicy('parking:indicators', {
    R01: always, R02: always, R05: always, R06: sameEntity, R07: sameEntity, R09: sameEntity, R22: always, R23: always,
  });
  definePolicy('parking:reminders.run', { R06: sameEntity, R07: sameEntity });
  // Chapitre 11A (smart.ts) : recommandations tarifaires décidées par la régie ; profil de plaque réservé à la priorisation ;
  // transmission au contentieux par la régie (aucune mesure) ; surréservation, affectation et déploiement : autorité (R06).
  definePolicy('parking:pricing.decide', { R06: sameEntity, R07: sameEntity });
  definePolicy('parking:plate.profile', { R06: sameEntity, R07: sameEntity, R09: sameEntity, R20: always, R21: always, R22: always });
  definePolicy('parking:plate.refer', { R06: sameEntity, R07: sameEntity });
  definePolicy('parking:overbooking.validate', { R06: sameEntity });
  definePolicy('parking:affectation.manage', { R06: sameEntity, R07: sameEntity });
  definePolicy('parking:deployment.activate', { R06: sameEntity });
}
