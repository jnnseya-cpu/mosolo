/**
 * Matrice d'habilitations du module « verticales » (moindre privilège : ce qui n'est pas déclaré est refusé).
 * Séparation des tâches : instruire ≠ décider ; rapprocher ≠ valider (AVIA) ; déclarer ≠ valider (CALCU).
 */
import type { User } from '../../core/auth.js';
import { definePolicy, GRANTS, type Grant, type Resource } from '../../core/policy.js';

const { always, minimal, ownTaxpayer, mandant, sameEntity, inTerritory } = GRANTS;

/** Même entité ET dans le territoire de l'agent (s'il en a un). */
const sameEntityInTerritory =
  (access: 'full' | 'minimal'): Grant =>
  (u: User, r: Resource) => {
    if (!sameEntity(u, r)) return false;
    return inTerritory(access)(u, r);
  };

export const P = {
  spaceRead: 'verticales:space.read',
  caseSubmit: 'verticales:case.submit',
  caseRead: 'verticales:case.read',
  caseInstruct: 'verticales:case.instruct',
  caseVisit: 'verticales:case.visit',
  caseDecide: 'verticales:case.decide',
  plateIssue: 'verticales:plate.issue',
  plateScan: 'verticales:plate.scan',
  plateCounter: 'verticales:plate.counter',
  plateReport: 'verticales:plate.report',
  marketTitle: 'verticales:market.title',
  eventTicketing: 'verticales:event.ticketing',
  objectLiquidate: 'verticales:object.liquidate',
  eventControl: 'verticales:event.control',
  telecomReconcile: 'verticales:telecom.reconcile',
  aviaDeclare: 'verticales:avia.declare',
  aviaRead: 'verticales:avia.read',
  aviaOperatorData: 'verticales:avia.operator-data',
  aviaReconcile: 'verticales:avia.reconcile',
  aviaValidate: 'verticales:avia.validate',
  aviaBill: 'verticales:avia.bill',
  aviaAgencyPortal: 'verticales:avia.agency-portal',
  aviaAgencyCertify: 'verticales:avia.agency-certify',
  aviaRemittance: 'verticales:avia.remittance',
  aviaIfaControl: 'verticales:avia.ifa-control',
  aviaActRecord: 'verticales:avia.act-record',
  aviaActValidate: 'verticales:avia.act-validate',
  aviaMeasurePropose: 'verticales:avia.measure-propose',
  aviaMeasureDecide: 'verticales:avia.measure-decide',
  calcuDeclare: 'verticales:calcu.declare',
  calcuValidateFinances: 'verticales:calcu.validate-finances',
  calcuValidateControl: 'verticales:calcu.validate-control',
  calcuGateway: 'verticales:calcu.gateway',
  calcuRead: 'verticales:calcu.read',
  calcuFreeze: 'verticales:calcu.freeze',
  // Modules sectoriels « acte requis » (secteurs.ts) et domaine public.
  sectorRead: 'verticales:sector.read',
  sectorDeclare: 'verticales:sector.declare',
  sectorDeclRead: 'verticales:sector.declaration.read',
  sectorObserve: 'verticales:sector.observe',
  sectorThirdParty: 'verticales:sector.third-party',
  sectorReconcile: 'verticales:sector.reconcile',
  sectorDecide: 'verticales:sector.decide',
  sectorLargeTaxpayer: 'verticales:sector.large-taxpayer',
  vehicleControl: 'verticales:vehicle.control',
  domainPlan: 'verticales:domain.plan',
} as const;

export function registerVerticalPolicies(): void {
  definePolicy(P.spaceRead, { R30: ownTaxpayer, R31: mandant });
  definePolicy(P.caseSubmit, { R30: ownTaxpayer, R31: mandant });
  // Lecture d'un dossier : le demandeur, son mandataire, les agents de l'entité gestionnaire, l'audit.
  definePolicy(P.caseRead, {
    R30: ownTaxpayer, R31: mandant, R06: sameEntity, R07: sameEntity, R11: sameEntity, R12: sameEntity,
    R10: sameEntityInTerritory('minimal'), R22: always, R24: sameEntity,
  });
  definePolicy(P.caseInstruct, { R11: sameEntity, R07: sameEntity, R24: sameEntity });
  definePolicy(P.caseVisit, { R10: sameEntityInTerritory('full'), R11: sameEntity });
  definePolicy(P.caseDecide, { R07: sameEntity, R06: sameEntity, R22: sameEntity });

  // Plaques (NFIU, étals, sites…) : l'agent de terrain pose dans son territoire ; aucun montant n'est modifiable.
  definePolicy(P.plateIssue, { R10: inTerritory('full'), R11: always, R07: always });
  definePolicy(P.plateScan, { R10: inTerritory('minimal'), R11: always, R07: always });
  definePolicy(P.plateCounter, { R12: always });
  definePolicy(P.plateReport, { R09: always, R07: always, R06: always, R11: always });

  definePolicy(P.marketTitle, { R30: ownTaxpayer, R31: mandant });
  definePolicy(P.eventTicketing, { R30: ownTaxpayer, R31: mandant });
  definePolicy(P.objectLiquidate, { R11: sameEntity, R07: sameEntity });
  definePolicy(P.eventControl, { R10: sameEntityInTerritory('full'), R11: sameEntity });
  definePolicy(P.telecomReconcile, { R11: sameEntity, R07: sameEntity, R06: sameEntity });

  definePolicy(P.aviaDeclare, { R30: ownTaxpayer, R31: mandant });
  definePolicy(P.aviaRead, { R30: ownTaxpayer, R31: mandant, R11: sameEntity, R07: sameEntity, R06: sameEntity, R22: always });
  definePolicy(P.aviaOperatorData, { R34: always });
  definePolicy(P.aviaReconcile, { R11: sameEntity });
  definePolicy(P.aviaValidate, { R07: sameEntity, R06: sameEntity });
  definePolicy(P.aviaBill, { R07: sameEntity, R06: sameEntity });
  // Pôle de rapprochement (§ 11C) : agences certifiées (portail), certification à quatre yeux, reversements (BSP : partenaire
  // de données ; banque collectrice), contrôle terrain de l'IFA, arrêté à double validation, mesures décidées par l'autorité.
  definePolicy(P.aviaAgencyPortal, { R30: ownTaxpayer, R31: mandant });
  definePolicy(P.aviaAgencyCertify, { R07: sameEntity, R06: sameEntity });
  definePolicy(P.aviaRemittance, { R34: always, R33: always });
  definePolicy(P.aviaIfaControl, { R10: always, R11: always, R24: always, R34: always });
  definePolicy(P.aviaActRecord, { R11: sameEntity, R07: sameEntity });
  definePolicy(P.aviaActValidate, { R07: sameEntity, R06: sameEntity, R05: always });
  definePolicy(P.aviaMeasurePropose, { R11: sameEntity, R07: sameEntity });
  definePolicy(P.aviaMeasureDecide, { R06: sameEntity, R05: always, R01: always });

  // CALCU : l'entité déclare ; les Finances et l'organe de contrôle valident conjointement ; la banque transmet.
  definePolicy(P.calcuDeclare, { R08: always, R17: always });
  definePolicy(P.calcuValidateFinances, { R05: always, R15: always });
  definePolicy(P.calcuValidateControl, { R22: always });
  definePolicy(P.calcuGateway, { R33: always });
  definePolicy(P.calcuRead, { R22: always, R23: always, R05: always, R15: always, R01: always, R08: minimal, R17: minimal });
  definePolicy(P.calcuFreeze, { R22: always });

  // Modules sectoriels : le redevable déclare ; l'agent de terrain relève (comptage, passage, point de contrôle) ;
  // le partenaire de données verse les données tierces sous protocole ; le contrôleur rapproche ; une autre personne décide.
  definePolicy(P.sectorRead, {
    R01: always, R02: always, R05: always, R06: sameEntity, R07: sameEntity, R09: always, R10: minimal, R11: sameEntity, R22: always, R23: always, R24: always,
  });
  definePolicy(P.sectorDeclare, { R30: ownTaxpayer, R31: mandant });
  definePolicy(P.sectorDeclRead, { R30: ownTaxpayer, R31: mandant, R06: sameEntity, R07: sameEntity, R11: sameEntity, R22: always, R24: sameEntity });
  definePolicy(P.sectorObserve, { R10: inTerritory('full'), R11: sameEntity, R35: inTerritory('full') });
  definePolicy(P.sectorThirdParty, { R34: always });
  definePolicy(P.sectorReconcile, { R11: sameEntity });
  definePolicy(P.sectorDecide, { R06: sameEntity, R07: sameEntity });
  definePolicy(P.sectorLargeTaxpayer, { R06: sameEntity, R07: sameEntity });
  // Contrôle d'un véhicule par plaque : réponse minimale (titres, autorisations), jamais le nom du propriétaire.
  definePolicy(P.vehicleControl, { R09: inTerritory('minimal'), R10: inTerritory('minimal'), R11: always, R35: inTerritory('minimal') });
  definePolicy(P.domainPlan, { R06: sameEntity, R07: sameEntity, R09: always, R10: inTerritory('minimal'), R11: sameEntity, R22: always });
}
