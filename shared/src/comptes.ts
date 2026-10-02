/**
 * Types de comptes (27/09/2026, demande du maître d'ouvrage : « tous les types de comptes sont créés ») — référentiel
 * partagé des 38 rôles (R38 ajouté le 29/09/2026 : Groupe Nseya) : famille, parcours de création, natures d'entité indicatives.
 *
 * Présentation et documentation seulement : les contrôles (pas d'élévation, seconde validation, MFA, contrat de
 * partenariat, accréditation) restent dans le serveur (backend/src/plugins/acces). Les natures d'entité sont
 * INDICATIVES — par défaut, à confirmer par le maître d'ouvrage — et ne sont pas opposées aux invitations existantes.
 */
import type { RoleCode } from './domain.js';

/** Familles de comptes, dans l'ordre d'affichage (sélecteur de démonstration, référentiel, graphiques). */
export const FAMILLES_COMPTES = {
  AUTORITE: 'Autorité',
  REGIE: 'Régie',
  TRESOR: 'Trésor',
  JURIDIQUE: 'Juridique',
  CONTROLE: 'Contrôle',
  TERRAIN: 'Terrain',
  AUDIT: 'Audit',
  TECHNIQUE: 'Technique',
  PUBLIC: 'Public',
  PARTENAIRE: 'Partenaire',
} as const;
export type FamilleCompte = keyof typeof FAMILLES_COMPTES;
export const ORDRE_FAMILLES = Object.keys(FAMILLES_COMPTES) as FamilleCompte[];

export const FAMILLE_DU_ROLE: Record<RoleCode, FamilleCompte> = {
  R01: 'AUTORITE', R02: 'AUTORITE', R03: 'AUTORITE', R04: 'AUTORITE', R05: 'AUTORITE',
  R06: 'REGIE', R07: 'REGIE', R08: 'REGIE', R12: 'REGIE',
  R17: 'TRESOR', R18: 'TRESOR', R19: 'TRESOR',
  R13: 'JURIDIQUE', R14: 'JURIDIQUE', R15: 'JURIDIQUE', R16: 'JURIDIQUE', R20: 'JURIDIQUE', R21: 'JURIDIQUE',
  R11: 'CONTROLE', R24: 'CONTROLE', R37: 'CONTROLE',
  R09: 'TERRAIN', R10: 'TERRAIN', R35: 'TERRAIN',
  R22: 'AUDIT', R23: 'AUDIT', R25: 'AUDIT',
  R26: 'TECHNIQUE', R27: 'TECHNIQUE', R28: 'TECHNIQUE', R29: 'TECHNIQUE',
  R30: 'PUBLIC', R31: 'PUBLIC', R36: 'PUBLIC',
  R32: 'PARTENAIRE', R33: 'PARTENAIRE', R34: 'PARTENAIRE', R38: 'PARTENAIRE',
};

/** Parcours de création d'un compte (voie réelle, jamais un amorçage). */
export const PARCOURS_CREATION = {
  INVITATION: 'Invitation en cascade → acceptation (lien, code, pièce, photo, MFA) → seconde validation si requise → compte actif',
  INSCRIPTION_PUBLIQUE: 'Inscription publique (téléphone vérifié par code à usage unique), puis connexion par code',
  INSCRIPTION_MANDATAIRE: 'Inscription publique du mandataire (téléphone vérifié par code) ; il n’agit que sur mandat daté et révocable du contribuable',
  CONTRAT_PARTENAIRE: 'Contrat de partenariat enregistré à deux personnes pour l’entité partenaire, puis invitation nominative dans cette entité',
  ACCREDITATION_SOUS_TRAITANT: 'Invitation du sous-traitant après sélection hors plateforme → dossier → diligences → accréditation à deux personnes',
  DESIGNATION_OBSERVATEUR: 'Invitation au niveau « Consultation » (observateur désigné), sans droit d’écriture ni d’invitation',
  SERVICE_VERIFICATEUR: 'Invitation au niveau « Consultation » d’un agent du service vérificateur du quitus (lecture de la seule validité du quitus)',
} as const;
export type ParcoursCreation = keyof typeof PARCOURS_CREATION;

export const PARCOURS_DU_ROLE: Record<RoleCode, ParcoursCreation> = {
  ...(Object.fromEntries(Array.from({ length: 29 }, (_, i) => [`R${String(i + 1).padStart(2, '0')}`, 'INVITATION'])) as Record<RoleCode, ParcoursCreation>),
  R30: 'INSCRIPTION_PUBLIQUE',
  R31: 'INSCRIPTION_MANDATAIRE',
  R32: 'CONTRAT_PARTENAIRE', R33: 'CONTRAT_PARTENAIRE', R34: 'CONTRAT_PARTENAIRE',
  R35: 'ACCREDITATION_SOUS_TRAITANT',
  R36: 'DESIGNATION_OBSERVATEUR',
  R37: 'SERVICE_VERIFICATEUR',
  R38: 'CONTRAT_PARTENAIRE',
};

/**
 * Natures d'entité auxquelles un compte du rôle appartient normalement — INDICATIF (par défaut, à confirmer par le
 * maître d'ouvrage) ; « PUBLIC » : compte public hors entité.
 */
const INSTITUTIONS = ['EXECUTIF', 'MINISTERE', 'REGIE', 'TRESOR', 'AUDIT', 'COMMUNE', 'SERVICE_TECHNIQUE'];
export const NATURES_ENTITE_DU_ROLE: Record<RoleCode, string[]> = {
  R01: ['EXECUTIF'], R02: ['EXECUTIF'], R03: ['EXECUTIF'], R04: ['MINISTERE'], R05: ['MINISTERE'],
  R06: ['REGIE'], R07: ['REGIE', 'COMMUNE', 'SERVICE_TECHNIQUE', 'MINISTERE'], R08: [...INSTITUTIONS, 'PLATEFORME'],
  R09: ['REGIE', 'COMMUNE', 'SERVICE_TECHNIQUE'], R10: ['REGIE', 'COMMUNE', 'SERVICE_TECHNIQUE'], R11: ['REGIE', 'COMMUNE', 'SERVICE_TECHNIQUE', 'MINISTERE'],
  R12: ['REGIE', 'COMMUNE', 'AUDIT'], R13: ['MINISTERE', 'SERVICE_TECHNIQUE'], R14: ['MINISTERE', 'SERVICE_TECHNIQUE'], R15: ['MINISTERE'], R16: ['MINISTERE', 'EXECUTIF'],
  R17: ['TRESOR'], R18: ['TRESOR'], R19: ['TRESOR'], R20: ['REGIE', 'SERVICE_TECHNIQUE'], R21: ['REGIE', 'SERVICE_TECHNIQUE'],
  R22: ['AUDIT'], R23: ['AUDIT'], R24: ['AUDIT'], R25: ['EXECUTIF', 'AUDIT'],
  R26: ['PLATEFORME'], R27: ['PLATEFORME'], R28: ['PLATEFORME'], R29: ['PLATEFORME'],
  R30: ['PUBLIC'], R31: ['PUBLIC'],
  R32: ['BANQUE_PSP', 'OPERATEUR_DELEGUE', 'PARTENAIRE'], R33: ['BANQUE_PSP'], R34: ['PARTENAIRE', 'OPERATEUR_DELEGUE'],
  R35: ['SOUS_TRAITANT'], R36: ['PARTENAIRE', 'AUDIT', 'EXECUTIF'], R37: ['SERVICE_TECHNIQUE', 'MINISTERE', 'EXECUTIF'],
  R38: ['OPERATEUR_DELEGUE'],
};

/** Rôles couverts par un contrat de partenariat (création par contrat enregistré à deux personnes). */
/** R38 (Groupe Nseya, 29/09/2026) : compte partenaire créé sous contrat, lecture seule. */
export const ROLES_CONTRAT_PARTENAIRE: readonly RoleCode[] = ['R32', 'R33', 'R34', 'R38'];
