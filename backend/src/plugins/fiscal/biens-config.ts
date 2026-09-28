/**
 * Liaison des biens et occupations — paramètres du § 10 de la spécification v1.0 (28/09/2026).
 *
 * Chaque paramètre est une valeur PAR DÉFAUT, À CONFIRMER PAR LE MAÎTRE D'OUVRAGE (et par les responsables juridiques
 * et des données de la province) avant la production. Tant que `validationJuridique` n'est pas confirmée, les
 * revendications sont affichées « non validées juridiquement » et n'alimentent aucune liquidation définitive.
 */
import type { RoleCode } from '@mosolo/shared';

export const STATUT_PARAMETRE = 'PAR_DEFAUT_A_CONFIRMER' as const;
export const MENTION_PARAMETRE = 'par défaut — à confirmer par le maître d’ouvrage';

export interface Parametre<T> { valeur: T; statut: typeof STATUT_PARAMETRE; libelle: string }
const p = <T>(valeur: T, libelle: string): Parametre<T> => ({ valeur, statut: STATUT_PARAMETRE, libelle });

/** Rôles d'une revendication de bien (spécification § 3) + exploitant d'activité (décision du 28/09/2026). */
export const CLAIM_ROLES = ['OWNER', 'TENANT', 'SUBTENANT', 'OCCUPANT', 'MANAGER', 'OPERATOR'] as const;
export type ClaimRole = (typeof CLAIM_ROLES)[number];
export const CLAIM_ROLE_LABELS: Record<ClaimRole, string> = {
  OWNER: 'Propriétaire (OWNER)', TENANT: 'Locataire (TENANT)', SUBTENANT: 'Sous-locataire (SUBTENANT)', OCCUPANT: 'Occupant (OCCUPANT)',
  MANAGER: 'Gestionnaire / mandataire du bien (MANAGER)', OPERATOR: 'Exploitant d’activité (OPERATOR)',
};

export const CONFIG_BIENS = {
  preuvesAccepteesParRole: p<Record<ClaimRole, string[]>>({
    OWNER: ['TITRE_FONCIER', 'CERTIFICAT_ENREGISTREMENT', 'ACTE_DE_VENTE', 'ATTESTATION_COUTUMIERE', 'ACTE_SUCCESSORAL', 'CONSTAT_TERRAIN'],
    TENANT: ['CONTRAT_DE_LOCATION', 'QUITTANCE_LOYER', 'FACTURE_SERVICE', 'CONSTAT_TERRAIN'],
    SUBTENANT: ['CONTRAT_DE_LOCATION', 'QUITTANCE_LOYER', 'CONSTAT_TERRAIN'],
    OCCUPANT: ['FACTURE_SERVICE', 'CONTRAT_DE_LOCATION', 'CONSTAT_TERRAIN'],
    MANAGER: ['MANDAT_DE_GESTION'],
    OPERATOR: ['AUTORISATION_EXPLOITATION', 'CONTRAT_DE_LOCATION', 'CONSTAT_TERRAIN'],
  }, 'Preuves acceptées par rôle (une invitation acceptée est une preuve d’appui, jamais suffisante seule)'),
  espacesNomsIdentifiant: p([
    { namespace: 'KIN-CADASTRE', issuer: 'Circonscription foncière de Kinshasa (à confirmer)' },
    { namespace: 'MOSOLO-IGF', issuer: 'KINSHASA MOSOLO — identifiant géofiscal interne (§ 17.3)' },
  ], 'Espace de noms et émetteur de l’identifiant officiel du bien'),
  verificateurs: p<RoleCode[]>(['R06', 'R07', 'R11'], 'Qui peut vérifier la propriété ou l’occupation (réviseurs habilités ; jamais un administrateur technique)'),
  agentTerrainPeutVerifier: p(false, 'Le constat d’un agent de terrain vaut preuve ; la décision « vérifiée » reste au réviseur'),
  seuilDistanceGpsM: p(30, 'Distance GPS « proche » pour proposer un candidat (mètres)'),
  seuilDistanceGpsLargeM: p(80, 'Distance GPS « voisine » (mètres)'),
  seuilConstatTerrainM: p(150, 'Distance maximale entre le constat de l’agent et le bien (mètres)'),
  scoreMinimalCandidat: p(40, 'Score minimal d’un candidat (classement seulement : aucun score ne vérifie)'),
  dureeInvitationJours: p(7, 'Durée de validité d’une invitation (jours)'),
  dureeCandidatMinutes: p(60, 'Durée de validité d’une proposition de candidat (minutes)'),
  dureeAffectationTerrainHeures: p(72, 'Durée d’affectation d’un dossier à un agent de terrain (heures)'),
  fondementFiscal: p('Relations VÉRIFIÉES en vigueur à la date concernée ; revendications non vérifiées exclues de toute liquidation définitive, pénalité ou attestation', 'Fondement de l’assujettissement par date d’effet'),
  conservationPreuves: p('10 ans après la fin de la relation', 'Conservation des preuves'),
  recours: p('Nouveau dossier de revue (APPEL) puis voie juridictionnelle', 'Voie de recours'),
  mandatAgentTerrain: p('Territoire affecté, dossier affecté, durée limitée', 'Mandat de l’agent de terrain'),
  divulgation: p({ locataireVoitDesignationProprietaire: true, proprietaireVoitOccupation: 'EXISTENCE_PERIODE_ET_LOYER_DU_BAIL_DECLARE' }, 'Règles de divulgation entre les parties après vérification'),
  validationJuridique: p(false, 'Validation juridique du dispositif (tant que « false » : revendications « non validées juridiquement »)'),
};

export const MENTION_JURIDIQUE = 'Revendication non validée juridiquement : elle ne vaut ni titre, ni bail, ni assujettissement ; aucun effet fiscal définitif tant que les règles du § 10 ne sont pas approuvées.';
