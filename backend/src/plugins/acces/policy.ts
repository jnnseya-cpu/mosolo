/**
 * Matrice d'habilitations du module « acces » (§ 12, § 12A, § 10A). Non déclaré ⇒ refusé.
 * Le périmètre fin (entité et sous-entités de l'invitant, pas d'élévation, personnes distinctes, seconde validation,
 * MFA) est contrôlé dans le service. Aucune de ces actions n'est ouverte à l'IA.
 */
import { definePolicy, GRANTS, allAgentRoles } from '../../core/policy.js';

const { always, sameEntity, ownTaxpayer } = GRANTS;

export const ACCES = {
  entityRead: 'acces:entity.read',
  entityManage: 'acces:entity.manage',
  moduleRead: 'acces:module.read',
  moduleDraft: 'acces:module.draft',
  moduleVisaProgramme: 'acces:module.visa.programme',
  moduleVisaJuridique: 'acces:module.visa.juridique',
  moduleRecette: 'acces:module.recette',
  moduleActivate: 'acces:module.activate',
  moduleReattachPropose: 'acces:module.reattach.propose',
  moduleReattachApprove: 'acces:module.reattach.approve',
  claimCreate: 'acces:claim.create',
  arbitrationRead: 'acces:arbitration.read',
  arbitrationOpinion: 'acces:arbitration.opinion',
  arbitrationDecide: 'acces:arbitration.decide',
  invitationCreate: 'acces:invitation.create',
  invitationRead: 'acces:invitation.read',
  accountRevoke: 'acces:account.revoke',
  validationDecide: 'acces:validation.decide',
  grantManage: 'acces:grant.manage',
  journalRead: 'acces:journal.read',
  identityRead: 'acces:identity.read',
  proofDeclare: 'acces:identity.proof.declare',
  proofReview: 'acces:identity.proof.review',
  assistedEnrolment: 'acces:identity.assisted',
  duplicatesRead: 'acces:duplicates.read',
  mergePropose: 'acces:merge.propose',
  mergeVerify: 'acces:merge.verify',
  mergeApprove: 'acces:merge.approve',
  consultationRequest: 'acces:consultation.request',
  consultationReview: 'acces:consultation.review',
  mandateManage: 'acces:mandate.manage',
  mandateRead: 'acces:mandate.read',
  mandateCheck: 'acces:mandate.check',
  elevationRequest: 'acces:elevation.request',
  elevationApprove: 'acces:elevation.approve',
  elevationSessionRead: 'acces:elevation.session.read',
  // Types de comptes, contrats de partenariat, départements (27/09/2026).
  accountTypesRead: 'acces:account-types.read',
  partnerContractRead: 'acces:partner-contract.read',
  partnerContractPropose: 'acces:partner-contract.propose',
  partnerContractApprove: 'acces:partner-contract.approve',
  departementsRead: 'acces:departements.read',
  departementsLink: 'acces:departements.link',
} as const;

/** Lecture des dossiers d'accès d'une entité : son administration, sa direction, l'audit et la sécurité. */
const ACCESS_OVERSIGHT = { R26: always, R22: always, R23: always, R28: always, R08: sameEntity, R06: sameEntity, R07: sameEntity, R09: sameEntity } as const;

export function registerAccesPolicies(): void {
  definePolicy(ACCES.entityRead, allAgentRoles(always));
  // L'administrateur de la plateforme crée les espaces (§ 12A.3) ; il n'a aucun pouvoir fiscal (§ 12A.6).
  definePolicy(ACCES.entityManage, { R26: always });
  definePolicy(ACCES.moduleRead, allAgentRoles(always));
  definePolicy(ACCES.moduleDraft, { R26: always, R06: sameEntity, R08: sameEntity });
  definePolicy(ACCES.moduleVisaProgramme, { R02: always, R03: always });
  definePolicy(ACCES.moduleVisaJuridique, { R13: always, R14: always });
  definePolicy(ACCES.moduleRecette, { R27: always, R26: always });
  // Comité de pilotage : Gouverneur, Cabinet, ministre des Finances (seconde validation sur référence d'arrêté).
  definePolicy(ACCES.moduleActivate, { R01: always, R02: always, R05: always });
  definePolicy(ACCES.moduleReattachPropose, { R26: always });
  definePolicy(ACCES.moduleReattachApprove, { R01: always, R02: always });
  // Revendication d'un fait générateur : direction, responsable de module ou contrôleur de l'entité revendiquante.
  definePolicy(ACCES.claimCreate, { R06: always, R07: always, R11: always });
  definePolicy(ACCES.arbitrationRead, {
    R01: always, R02: always, R03: always, R05: always, R13: always, R14: always, R22: always, R23: always,
    R06: sameEntity, R07: sameEntity, R08: sameEntity, R11: sameEntity,
  });
  // Comité juridique et tarifaire : avis juridique puis décision par une autorité distincte.
  definePolicy(ACCES.arbitrationOpinion, { R13: always, R14: always });
  definePolicy(ACCES.arbitrationDecide, { R01: always, R02: always, R05: always });
  // Le droit d'inviter est une permission explicite vérifiée dans le service (§ 12A.2).
  definePolicy(ACCES.invitationCreate, allAgentRoles(always));
  definePolicy(ACCES.invitationRead, ACCESS_OVERSIGHT);
  definePolicy(ACCES.accountRevoke, { R26: always, R28: always, R08: sameEntity, R06: sameEntity });
  // Seconde validation : sécurité, direction de l'entité, Cabinet/SG (hors bande), autorité d'audit, habilitation régie.
  definePolicy(ACCES.validationDecide, {
    R28: always, R06: sameEntity, R07: sameEntity, R02: always, R03: always, R22: always,
  });
  definePolicy(ACCES.grantManage, { R26: always, R08: sameEntity, R06: sameEntity });
  definePolicy(ACCES.journalRead, { R26: always, R22: always, R23: always, R28: always, R08: sameEntity, R06: sameEntity });
  definePolicy(ACCES.identityRead, { R30: ownTaxpayer, R12: always, R11: always, R07: always, R06: always, R09: always });
  definePolicy(ACCES.proofDeclare, { R30: ownTaxpayer, R12: always });
  definePolicy(ACCES.proofReview, { R12: always, R11: always, R07: always, R06: always });
  // Enrôlement assisté (N0-A) : agent de terrain habilité ou guichet ; aucun encaissement.
  definePolicy(ACCES.assistedEnrolment, { R10: always, R12: always });
  definePolicy(ACCES.duplicatesRead, { R12: always, R07: always, R06: always, R09: always });
  // Fusion d'identités (§ 12.3) : agent d'enrôlement → superviseur → responsable du registre, trois personnes distinctes.
  definePolicy(ACCES.mergePropose, { R12: always, R07: always });
  definePolicy(ACCES.mergeVerify, { R09: always, R07: always });
  definePolicy(ACCES.mergeApprove, { R06: always, R07: always });
  // Consultation motivée d'un dossier ; l'administrateur de la plateforme n'accède à aucune donnée fiscale (§ 12A.6).
  definePolicy(ACCES.consultationRequest, {
    R06: always, R07: always, R09: always, R10: always, R11: always, R12: always, R20: always, R21: always,
    R22: always, R23: always, R24: always,
    // Groupe Nseya (R38, 29/09/2026) : tout dossier individuel passe par la consultation motivée (C42-05).
    R38: always,
  });
  definePolicy(ACCES.consultationReview, { R22: always, R28: always });
  definePolicy(ACCES.mandateManage, { R30: ownTaxpayer });
  definePolicy(ACCES.mandateRead, { R30: always, R31: always });
  definePolicy(ACCES.mandateCheck, { R31: always });
  // Accès privilégié juste-à-temps (§ 12.1, § 12.3) : le personnel d'exploitation demande ; le responsable sécurité
  // approuve (personne distincte) ; la session enregistrée est lue par la sécurité et l'audit.
  definePolicy(ACCES.elevationRequest, { R26: always, R27: always, R28: always });
  definePolicy(ACCES.elevationApprove, { R28: always });
  definePolicy(ACCES.elevationSessionRead, { R28: always, R22: always, R23: always });
  // Référentiel des types de comptes (27/09/2026) : administration des accès, sécurité, audit ; R08 dans son périmètre.
  definePolicy(ACCES.accountTypesRead, { R26: always, R28: always, R22: always, R23: always, R08: always, R06: always, R02: always, R03: always });
  // Contrats de partenariat (R32 à R34) : enregistrés par l'administrateur de la plateforme, approuvés par le Cabinet ou
  // le ministre des Finances (personne distincte) — valideurs PAR DÉFAUT, à confirmer par le maître d'ouvrage.
  definePolicy(ACCES.partnerContractRead, { R26: always, R28: always, R22: always, R23: always, R02: always, R05: always, R08: always });
  definePolicy(ACCES.partnerContractPropose, { R26: always });
  // Décision du maître d'ouvrage (27/09/2026) : les contrats partenaires sont approuvés par le Directeur de cabinet (R02).
  definePolicy(ACCES.partnerContractApprove, { R02: always });
  // Départements : lecture par l'administration (R26 tout, R08 son sous-arbre — contrôlé dans le service), la sécurité et
  // l'audit ; rattachement par R26 et R08 (sous-arbre). Les modules porteurs de recettes suivent le circuit des fiches.
  definePolicy(ACCES.departementsRead, { R26: always, R08: always, R28: always, R22: always, R23: always });
  definePolicy(ACCES.departementsLink, { R26: always, R08: always });
}
