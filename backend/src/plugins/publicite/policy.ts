/**
 * Habilitations KIN PUB CONTROL (moindre privilège ; jamais permis à l'IA).
 * Séparation : l'inspecteur accrédité (R11) constate, le superviseur (R09) vérifie, l'autorité (R06/R07) décide ;
 * la demande d'autorisation est instruite (R07) puis décidée par une personne distincte (R06/R07).
 */
import { definePolicy, GRANTS } from '../../core/policy.js';

const { always, ownTaxpayer, mandant, sameEntity, inTerritory } = GRANTS;

export function declarePublicitePolicies(): void {
  definePolicy('publicite:device.declare', { R30: ownTaxpayer, R31: mandant });
  definePolicy('publicite:device.read', {
    R30: ownTaxpayer, R31: mandant, R06: sameEntity, R07: sameEntity, R09: inTerritory('full'), R11: inTerritory('full'), R22: always, R24: always,
  });
  definePolicy('publicite:inventory', { R06: sameEntity, R07: sameEntity, R09: sameEntity, R11: sameEntity, R22: always });
  definePolicy('publicite:authorization.request', { R30: ownTaxpayer, R31: mandant });
  definePolicy('publicite:authorization.instruct', { R07: sameEntity });
  definePolicy('publicite:authorization.decide', { R06: sameEntity, R07: sameEntity });
  definePolicy('publicite:inspection.create', { R11: inTerritory('full') });
  definePolicy('publicite:case.verify', { R09: inTerritory('full') });
  definePolicy('publicite:case.decide', { R06: sameEntity, R07: sameEntity });
  definePolicy('publicite:case.contest', { R30: ownTaxpayer, R31: mandant });
  definePolicy('publicite:accreditation.manage', { R06: sameEntity, R07: sameEntity });
  definePolicy('publicite:indicators', {
    R01: always, R02: always, R05: always, R06: sameEntity, R07: sameEntity, R09: sameEntity, R22: always, R23: always,
  });
  definePolicy('publicite:reminders.run', { R06: sameEntity, R07: sameEntity });
}
