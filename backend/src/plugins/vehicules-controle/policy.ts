/**
 * Habilitations de la chaîne véhicule (moindre privilège : non déclaré ⇒ refusé ; jamais permis à l'IA).
 * Préfixes : `vc:` contrôle technique, vignettes sécurisées, scan unique ; `fourriere:` ; `centres:` ; `rfck:` interfaces,
 * domaine officiel et séquence d'intégration.
 */
import type { User } from '../../core/auth.js';
import { definePolicy, GRANTS, type Grant } from '../../core/policy.js';
import { RFCK } from './model.js';

const { always, ownTaxpayer, mandant } = GRANTS;
/** Agent de la RFCK (entité RFCK). */
const rfck: Grant = (u: User) => (u.entity === RFCK.id ? 'full' : false);
/** Tiers de confiance (centre, opérateur) : le service vérifie en plus que l'utilisateur appartient au centre visé. */
const tiers: Grant = (u: User) => (u.entity !== RFCK.id ? 'full' : false);

const LECTURE = { R01: always, R02: always, R03: always, R04: always, R05: always, R06: rfck, R07: rfck, R08: rfck, R09: always, R11: always, R17: always, R21: always, R22: always, R23: always, R24: always, R25: always };

export function declareVehiculesPolicies(): void {
  // Contrôle technique, vignettes sécurisées, mode courtoisie, scan unique
  definePolicy('vc:read', LECTURE);
  definePolicy('vc:pv.submit', { R34: tiers });
  definePolicy('vc:sticker.lot.issue', { R07: rfck });
  definePolicy('vc:sticker.assign', { R34: tiers });
  definePolicy('vc:sticker.cancel', { R34: tiers });
  definePolicy('vc:sticker.revoke', { R06: rfck, R07: rfck });
  definePolicy('vc:courtesy.decide', { R01: always, R04: always });
  definePolicy('vc:reminders.run', { R06: rfck, R07: rfck });
  definePolicy('vc:scan', { R09: always, R10: always, R11: always });
  definePolicy('vc:scan.decision', { R10: always, R11: always });
  definePolicy('vc:vehicle.own', { R30: ownTaxpayer, R31: mandant });
  definePolicy('vc:appointment.confirm', { R34: tiers });

  // Fourrières
  definePolicy('fourriere:read', { ...LECTURE, R10: rfck, R35: tiers });
  definePolicy('fourriere:site.manage', { R06: rfck, R07: rfck });
  definePolicy('fourriere:constat', { R10: rfck, R11: rfck });
  definePolicy('fourriere:decision', { R06: rfck, R07: rfck, R21: always });
  definePolicy('fourriere:entry', { R10: rfck, R35: tiers });
  definePolicy('fourriere:correction.propose', { R07: rfck, R10: rfck });
  definePolicy('fourriere:correction.approve', { R06: rfck });
  definePolicy('fourriere:liquidate', { R06: rfck, R07: rfck });
  definePolicy('fourriere:exit', { R10: rfck, R35: tiers });
  definePolicy('fourriere:mainlevee', { R06: rfck, R21: always });
  definePolicy('fourriere:contest', { R30: ownTaxpayer, R31: mandant });
  definePolicy('fourriere:contest.decide', { R21: always });
  definePolicy('fourriere:disposal.propose', { R07: rfck });
  definePolicy('fourriere:disposal.validate1', { R06: rfck });
  definePolicy('fourriere:disposal.validate2', { R04: always });
  definePolicy('fourriere:alerts.run', { R06: rfck, R07: rfck });
  definePolicy('fourriere:own', { R30: ownTaxpayer, R31: mandant });

  // Centres agréés et tiers de confiance
  definePolicy('centres:read', { ...LECTURE, R34: tiers, R35: tiers });
  definePolicy('centres:invite', { R07: rfck });
  definePolicy('centres:diligence', { R07: rfck });
  definePolicy('centres:propose', { R07: rfck });
  definePolicy('centres:decide', { R06: rfck });
  definePolicy('centres:habilitation', { R06: rfck });
  definePolicy('centres:suspend', { R06: rfck });
  definePolicy('centres:reinstatement.request', { R07: rfck });
  definePolicy('centres:reinstatement.decide', { R06: rfck });
  definePolicy('centres:analytics', { R06: rfck, R07: rfck, R22: always, R23: always, R24: always });
  definePolicy('centres:enrol', { R34: tiers });

  // Interfaces RFCK, domaine officiel, séquence d'intégration, fiche de l'entité
  definePolicy('rfck:read', { ...LECTURE, R26: always, R27: always, R28: always, R34: tiers });
  definePolicy('rfck:convention.record', { R06: rfck, R07: rfck });
  definePolicy('rfck:convention.compliance', { R25: always });
  definePolicy('rfck:flow.exchange', { R07: rfck, R34: tiers });
  definePolicy('rfck:reprise.import', { R07: rfck });
  definePolicy('rfck:reprise.control', { R06: rfck });
  definePolicy('rfck:figures.decide', { R06: rfck });
  definePolicy('rfck:step.validate', { R06: rfck });
  definePolicy('rfck:cash.attest', { R17: always });
  definePolicy('rfck:entity.contacts', { R08: rfck, R26: always });
  definePolicy('domaine:propose', { R26: always });
  definePolicy('domaine:validate', { R02: always });
  definePolicy('domaine:legacy', { R26: always });
  definePolicy('domaine:watch', { R24: always, R28: always });
  definePolicy('domaine:takedown', { R28: always });
}
