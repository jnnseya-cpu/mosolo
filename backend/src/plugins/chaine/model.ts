/**
 * Chaîne opératoire (Cahier v2.9 § 3, Vision) : RECENSER → IDENTIFIER → GÉOLOCALISER → QUALIFIER → CALCULER →
 * NOTIFIER → PAYER → RAPPROCHER → QUITTANCER → CONTRÔLER → RECOUVRER → AUDITER → PLANIFIER.
 * Chaque maillon produit un événement horodaté, signé et inaltérable (journal d'audit chaîné, grand livre chaîné,
 * quittance signée) ; aucun maillon ne peut être sauté.
 */
import type { AuditActor } from '../../core/audit.js';

export const MAILLONS = [
  { code: 'RECENSER', label: 'Recenser', garde: 'Objet provisoire tant qu’il n’est pas vérifié', requires: [] },
  { code: 'IDENTIFIER', label: 'Identifier', garde: 'Rattachement à un compte unique ; pas de fusion automatique d’identités', requires: ['RECENSER'] },
  { code: 'GEOLOCALISER', label: 'Géolocaliser', garde: 'Identifiant géofiscal, coordonnées et précision ; contrôle de plausibilité GPS', requires: ['RECENSER'] },
  { code: 'QUALIFIER', label: 'Qualifier', garde: 'Seules les règles actives du registre, fondées sur un texte en vigueur', requires: [] },
  { code: 'CALCULER', label: 'Calculer', garde: 'Liquidation déterministe ; version de règle figée dans l’obligation', requires: ['QUALIFIER', 'IDENTIFIER'] },
  { code: 'NOTIFIER', label: 'Notifier', garde: 'Avis numérique et imprimable, preuve de délivrance, voie de recours', requires: ['CALCULER'] },
  { code: 'PAYER', label: 'Payer', garde: 'Référence unique, canal autorisé, compte bénéficiaire issu du coffre', requires: ['CALCULER'] },
  { code: 'RAPPROCHER', label: 'Rapprocher', garde: 'Obligation ↔ paiement ↔ règlement ↔ écriture ; exceptions en file', requires: ['PAYER'] },
  { code: 'QUITTANCER', label: 'Quittancer', garde: 'Quittance signée ; « provisoire » tant que le règlement n’est pas rapproché', requires: ['PAYER', 'RAPPROCHER'] },
  { code: 'CONTROLER', label: 'Contrôler', garde: 'Missions terrain ciblées ; l’agent constate, il n’encaisse pas', requires: ['RECENSER'] },
  { code: 'RECOUVRER', label: 'Recouvrer', garde: 'Relances graduées ; décision humaine habilitée, recours garanti', requires: ['CALCULER'] },
  { code: 'AUDITER', label: 'Auditer', garde: 'Reconstitution intégrale ; journal chaîné vérifié', requires: [] },
  { code: 'PLANIFIER', label: 'Planifier', garde: 'Recette rapprochée comptée au pilotage ; l’IA recommande, l’autorité décide', requires: ['RAPPROCHER'] },
] as const;

export type MaillonCode = (typeof MAILLONS)[number]['code'];
export type MaillonStatus = 'FAIT' | 'EN_ATTENTE' | 'SANS_OBJET' | 'BLOQUE';

export interface Maillon {
  rang: number;
  code: MaillonCode;
  label: string;
  garde: string;
  status: MaillonStatus;
  /** Horodatage de l'événement qui accomplit le maillon (serveur). */
  at: string | null;
  actor: AuditActor | null;
  /** Événement du journal d'audit chaîné et son empreinte (référence de chaîne). */
  auditEventId: string | null;
  auditSeq: number | null;
  chainHash: string | null;
  /** Pièces du maillon (écriture du grand livre, quittance, avis…) et leur empreinte éventuelle. */
  evidence: { type: string; id: string; hash?: string }[];
  detail: string;
  /** Motif du blocage (BLOQUE). */
  reason?: string;
  /** Vrai si le maillon est accompli alors qu'un maillon obligatoire qui le précède ne l'est pas. */
  rupture?: boolean;
  /** Maillon en attente ou bloqué : qui doit agir, où (écran du module), garde-fou — jamais accompli depuis la chaîne. */
  aAgir?: AAgir;
}

export type QuestionCode = 'QUI' | 'QUOI' | 'OU' | 'REGLE' | 'COMBIEN' | 'PAYE' | 'COMPTE_PUBLIC';
export type AnswerStatus = 'REPONDU' | 'PARTIEL' | 'EN_ATTENTE' | 'MASQUE' | 'SANS_OBJET';

export interface Answer {
  code: QuestionCode;
  question: string;
  status: AnswerStatus;
  answer: string;
  /** Sources de la réponse (identifiants), données structurées. */
  sources: Record<string, unknown>;
}

export const QUESTIONS: Record<QuestionCode, string> = {
  QUI: 'Qui ?',
  QUOI: 'Quoi ?',
  OU: 'Où ?',
  REGLE: 'Quelle règle ?',
  COMBIEN: 'Combien ?',
  PAYE: 'Payé ?',
  COMPTE_PUBLIC: 'L’argent est-il arrivé sur le compte public et comptabilisé ?',
};

/**
 * « Qui doit agir, où » pour un maillon non accompli (29/09/2026). La chaîne reste une PREUVE en lecture seule : un
 * maillon n'est jamais accompli depuis cet écran, mais par l'opération réelle dans son module (écran indiqué), par la
 * personne habilitée (mêmes droits que le serveur), ou automatiquement quand la plateforme le prévoit.
 */
export interface AAgir {
  /** Qui doit agir, en clair. */
  qui: string;
  /** Rôles qui détiennent le droit (le lien n'est actif que pour eux). */
  roles: string[];
  /** Écran(s) où l'opération réelle accomplit le maillon. */
  ou: { label: string; path: string }[];
  /** Vrai si le maillon s'accomplit sans intervention humaine (événement du prestataire, moteur, relevé). */
  automatique: boolean;
  note: string;
}

export const PROCHAINE_ACTION: Record<MaillonCode, AAgir> = {
  RECENSER: { qui: 'Agent de terrain, contrôleur, ou le contribuable lui-même (déclaration)', roles: ['R10', 'R11', 'R35', 'R30', 'R31'], ou: [{ label: 'Terrain', path: '/terrain' }, { label: 'Biens et relations', path: '/fiscal/biens' }], automatique: false, note: 'L’objet reste provisoire tant qu’il n’est pas vérifié.' },
  IDENTIFIER: { qui: 'Le contribuable revendique le bien ; un agent habilité (directeur, chef de service, contrôleur) valide le rattachement', roles: ['R30', 'R06', 'R07', 'R11'], ou: [{ label: 'Mes biens et relations', path: '/espace/biens-relations' }, { label: 'Biens et relations (validation)', path: '/fiscal/biens' }, { label: 'Revue des biens et relations', path: '/biens-relations/revue' }], automatique: false, note: 'Jamais de fusion automatique d’identités ; rapprochement sur identifiant, GPS, adresse et numéro d’unité.' },
  GEOLOCALISER: { qui: 'Agent habilité distinct du déclarant (directeur, chef de service, contrôleur)', roles: ['R06', 'R07', 'R11'], ou: [{ label: 'Biens et relations (validation de l’objet)', path: '/fiscal/biens' }], automatique: false, note: 'L’identifiant géofiscal est attribué à la validation ; contrôle de plausibilité GPS.' },
  QUALIFIER: { qui: 'Juriste rédacteur, puis trois autres personnes (visa juridique, visa financier, publication)', roles: ['R13', 'R14', 'R15', 'R16'], ou: [{ label: 'Registre des règles', path: '/registre' }], automatique: false, note: 'Seule une règle ACTIVE, fondée sur un texte en vigueur, qualifie l’objet.' },
  CALCULER: { qui: 'Agent habilité à liquider (directeur, chef de service, contrôleur), ou déclaration du contribuable', roles: ['R06', 'R07', 'R11', 'R30', 'R31'], ou: [{ label: 'Console des verticales', path: '/verticales/console' }, { label: 'Déclarations', path: '/fiscal/declarations' }], automatique: false, note: 'Liquidation déterministe sur règle ACTIVE ; sans règle ACTIVE, simulation non opposable seulement.' },
  NOTIFIER: { qui: 'Automatique à la liquidation (avis numérique) ; avis du recouvrement par un agent habilité', roles: ['R06', 'R07', 'R11', 'R20'], ou: [{ label: 'Recouvrement', path: '/recouvrement' }], automatique: true, note: 'Avis numérique et imprimable, preuve de délivrance, voie de recours.' },
  PAYER: { qui: 'Le contribuable ou son mandataire, par un canal officiel (Mobile Money, banque, point agréé)', roles: ['R30', 'R31'], ou: [{ label: 'Mon espace — payer', path: '/espace' }, { label: 'Mes arriérés et échéances', path: '/mes-arrieres' }], automatique: false, note: 'Paiement numérique vers le compte public ; jamais d’espèces remises à un agent.' },
  RAPPROCHER: { qui: 'Automatique au relevé de règlement ; exceptions traitées par le Trésor (comptable public, analyste de rapprochement)', roles: ['R17', 'R18'], ou: [{ label: 'Trésor', path: '/tresor' }], automatique: true, note: 'Obligation ↔ paiement ↔ règlement ↔ écriture ; les exceptions vont en file, jamais corrigées en silence.' },
  QUITTANCER: { qui: 'Automatique : quittance signée à la confirmation du paiement, définitive après rapprochement du règlement', roles: [], ou: [{ label: 'Trésor (rapprochement)', path: '/tresor' }], automatique: true, note: 'Aucune quittance sans paiement confirmé.' },
  CONTROLER: { qui: 'Superviseur terrain ou chef de service (mission), agent de terrain (constat)', roles: ['R07', 'R09', 'R10', 'R35'], ou: [{ label: 'Supervision terrain', path: '/terrain/supervision' }, { label: 'Inspection et constat', path: '/terrain/inspection' }], automatique: false, note: 'L’agent constate, il n’encaisse pas ; missions ciblées par le risque.' },
  RECOUVRER: { qui: 'Agent habilité du recouvrement (directeur, chef de service, contrôleur, contentieux) ; décision humaine', roles: ['R06', 'R07', 'R11', 'R20', 'R21'], ou: [{ label: 'Recouvrement', path: '/recouvrement' }], automatique: false, note: 'Relances graduées ; aucune sanction automatique ; recours garanti.' },
  AUDITER: { qui: 'Auditeur interne ou externe', roles: ['R22', 'R23'], ou: [{ label: 'Piste d’audit par dossier', path: '/pilotage/piste-audit' }, { label: 'Journal d’audit', path: '/audit' }], automatique: false, note: 'Reconstitution intégrale depuis le journal chaîné.' },
  PLANIFIER: { qui: 'Automatique : la recette rapprochée est comptée au pilotage ; l’autorité décide', roles: [], ou: [{ label: 'Tableaux par profil', path: '/pilotage/tableaux' }], automatique: true, note: 'L’IA recommande, l’autorité décide.' },
};
