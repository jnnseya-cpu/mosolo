/** Outils partagés des écrans « Mon compte unique » et « Mes biens et relations » (libellés et tons, en français). */
import type { Tone } from '../../components/StatusBadge';

/** Libellés français des rubriques du compte unique. */
export const RUBRIQUE_LABELS: Record<string, string> = {
  OBJET: 'Biens et objets', VEHICULE: 'Véhicules', BAIL: 'Baux', ENTREPRISE: 'Entreprises et activités', RELATION: 'Relations aux biens',
  OBLIGATION: 'Obligations', PAIEMENT: 'Paiements', QUITTANCE: 'Quittances', TITRE: 'Titres et autorisations', PASS: 'Pass et tickets',
  SESSION: 'Sessions de stationnement', ENSEIGNE: 'Enseignes publicitaires', RECOURS: 'Recours', ARRIERE: 'Arriérés et recouvrement',
  DEMARCHE: 'Démarches', MANDAT_DONNE: 'Mandats donnés', MANDAT_RECU: 'Mandats reçus', ORGANISATION: 'Organisations', ROLE: 'Rôles',
  DOCUMENT: 'Documents et pièces', CONSENTEMENT: 'Consentements et préférences', NOTIFICATION: 'Notifications', CARTE: 'Cartes MOSOLO',
  FICHE_METIER: 'Fiches de métier rattachées',
};

/** Libellés français des états des revendications (§ 6 de la spécification) — code anglais en second. */
export const CLAIM_STATUS: Record<string, { label: string; tone: Tone }> = {
  DRAFT: { label: 'Brouillon (DRAFT)', tone: 'neutral' },
  SUBMITTED: { label: 'Soumise (SUBMITTED)', tone: 'info' },
  MATCHED_PENDING_VERIFICATION: { label: 'Rapprochée — à vérifier', tone: 'warning' },
  NEEDS_EVIDENCE: { label: 'Preuve demandée', tone: 'warning' },
  VERIFIED: { label: 'Vérifiée', tone: 'good' },
  DISPUTED: { label: 'Contestée', tone: 'serious' },
  UNDER_REVIEW: { label: 'En revue', tone: 'serious' },
  REJECTED: { label: 'Rejetée', tone: 'critical' },
  SUPERSEDED: { label: 'Remplacée', tone: 'neutral' },
  ENDED: { label: 'Terminée', tone: 'neutral' },
};
export const CLAIM_ORDER = ['DRAFT', 'SUBMITTED', 'MATCHED_PENDING_VERIFICATION', 'NEEDS_EVIDENCE', 'VERIFIED', 'DISPUTED', 'UNDER_REVIEW', 'REJECTED', 'SUPERSEDED', 'ENDED'];

export const CLAIM_ROLE: Record<string, string> = {
  OWNER: 'Propriétaire', TENANT: 'Locataire', SUBTENANT: 'Sous-locataire', OCCUPANT: 'Occupant', MANAGER: 'Gestionnaire', OPERATOR: 'Exploitant d’activité',
};

export const RECORD_STATUS: Record<string, { label: string; tone: Tone }> = {
  PROVISIONAL: { label: 'Bien provisoire (auto-déclaré)', tone: 'warning' },
  CANONICAL: { label: 'Bien de référence', tone: 'good' },
  ARCHIVED_ALIAS: { label: 'Alias archivé', tone: 'neutral' },
};

/** Ton d'un statut quelconque (obligation, titre, dossier…) : icône + libellé toujours affichés. */
export function toneOf(statut: string | undefined): Tone {
  const s = (statut ?? '').toUpperCase();
  if (/^(VALIDE|VALIDEE|VERIFIED|ACTIF|ACTIVE|EMIS|SOLDEE|CONFIRME|RAPPROCHE|REGLE|ACCORDE|ACCORDEE|DEFINITIVE|EN_VIGUEUR|TITULAIRE|DIRIGEANT)$/.test(s)) return 'good';
  if (/(RETARD|REJET|REFUS|ANNUL|REVOQ|EXPIRE|CRITIQUE|ECHOUE)/.test(s)) return 'critical';
  if (/(CONTEST|DISPUTE|REVIEW|ESCALADE|LITIGE)/.test(s)) return 'serious';
  if (/(EXIGIBLE|EMISE|ATTENTE|PENDING|PROPOSE|DEPOSE|DRAFT|SUBMITTED|MATCHED|NEEDS|INITIE|PROVISOIRE|DECLARE)/.test(s)) return 'warning';
  return 'neutral';
}

/** Empreinte SHA-256 d'un fichier, calculée dans le navigateur (le fichier ne quitte pas l'appareil). */
export async function sha256OfFile(file: Blob): Promise<string> {
  const buf = await file.arrayBuffer();
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
