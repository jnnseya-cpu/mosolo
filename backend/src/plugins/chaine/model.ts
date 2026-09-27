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
