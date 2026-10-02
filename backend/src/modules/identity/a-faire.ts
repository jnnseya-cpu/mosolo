/**
 * « À faire » de l'usager (30/09/2026, demande du maître d'ouvrage) : l'usager n'a rien à « vérifier » lui-même ; il
 * trouve EN UN SEUL ENDROIT tout ce qui le concerne et ce qu'il doit faire, avec une action pour chaque ligne. Calculé
 * sur le compte unique (même agrégation, mêmes droits) :
 *  - « À faire maintenant » : payer, régulariser, renouveler, compléter, passer un contrôle ;
 *  - « En cours de vérification par l'administration » : rien à faire, l'usager suit l'état ;
 *  - « À jour » : titres, autorisations et pièces valides, avec leur échéance.
 * Les liens proposés ne mènent qu'à des écrans de l'usager (jamais à un écran de travail des agents).
 */
import type { MoneyJSON } from '@mosolo/shared';
import type { CompteElement, CompteSection } from './compte-unique.js';

export type GroupeAFaire = 'A_FAIRE' | 'EN_VERIFICATION' | 'A_JOUR';
export interface LigneAFaire {
  id: string; groupe: GroupeAFaire; categorie: string; libelle: string; etat: string;
  echeance: string | null; montant: MoneyJSON | null; urgence: 'EN_RETARD' | 'BIENTOT' | 'NORMALE';
  /**
   * Action de la ligne. `obligationId` : ouvre le paiement de l'obligation dans l'espace (choix du canal et de la
   * passerelle) ; `titreId` : renouvelle le titre (commande de prolongation, puis même choix du canal) ;
   * `contesterObligationId` : action secondaire « Contester » ; `lien` : écran de l'usager (détail).
   */
  action: { libelle: string; lien: string; obligationId?: string; titreId?: string; contesterObligationId?: string } | null;
}

/** Délai avant échéance à partir duquel un titre est « à renouveler » — PAR DÉFAUT, à confirmer par le maître d'ouvrage. */
export const JOURS_AVANT_RENOUVELLEMENT = 30;

/**
 * Écran de l'usager équivalent à un écran de travail (les liens du compte unique pointent parfois vers l'écran des
 * agents : l'usager est renvoyé vers SON écran, jamais vers une page réservée).
 */
export function lienUsager(lien: string | null | undefined): string | null {
  if (!lien) return null;
  if (lien.startsWith('/recouvrement')) return '/mes-arrieres';
  if (lien.startsWith('/acces/identite')) return '/mon-espace/profils';
  if (lien.startsWith('/communication/')) return '/mes-preferences';
  if (lien === '/documents') return '/mon-espace/situation';
  if (lien.startsWith('/canaux/')) return '/mes-preferences';
  if (lien.startsWith('/chaine/')) return '/fiscal/biens';
  if (lien.startsWith('/verifier/') || lien.startsWith('/preuve/')) return '/espace#sec-rc';
  if (lien.startsWith('/verticales/')) return '/services';
  if (lien === '/rakapay/cooperative') return '/services/rakapay';
  return lien;
}

const OBLIGATION_A_PAYER = ['EMISE', 'EXIGIBLE', 'EN_RETARD', 'PARTIELLEMENT_PAYEE'];
const EN_COURS = ['DEPOSE', 'DEPOSEE', 'DEMANDEE', 'SOUMISE', 'EN_INSTRUCTION', 'EN_EXAMEN', 'ECART_A_INSTRUIRE', 'RECUE', 'EN_ATTENTE', 'PROPOSEE', 'EN_COURS'];
const A_COMPLETER = ['A_COMPLETER', 'INCOMPLET', 'INCOMPLETE', 'PIECES_MANQUANTES', 'ECART_CONSTATE', 'A_CORRIGER', 'COMPLEMENT_DEMANDE'];
const VALIDE = ['VALIDE', 'VALIDEE', 'ACTIF', 'ACTIVE', 'EMIS', 'FAVORABLE', 'ACCEPTE', 'ACCORDEE', 'RAPPROCHEE', 'DELIVRE', 'DELIVREE', 'ATTRIBUE', 'ACCREDITE', 'DECLARE', 'EN_VIGUEUR'];
const EXPIRE = ['EXPIRE', 'EXPIREE', 'ANNULE', 'REVOQUE', 'SUSPENDU', 'DEFAVORABLE', 'AUCUN_CONTROLE', 'REFUSE', 'REFUSEE', 'REJETEE'];

const CATEGORIE: Record<string, string> = {
  OBLIGATION: 'Impôts et redevances', ARRIERE: 'Arriérés et constats', SESSION: 'Stationnement', TITRE: 'Titres et autorisations',
  PASS: 'Titres et autorisations', DEMARCHE: 'Démarches', OBJET: 'Mes biens', VEHICULE: 'Mes véhicules', ENSEIGNE: 'Publicité et enseignes',
  ENTREPRISE: 'Mes activités', BAIL: 'Baux', DOCUMENT: 'Pièces du compte', MANDAT_DONNE: 'Mandats', MANDAT_RECU: 'Mandats',
  QUITTANCE: 'Paiements', ORGANISATION: 'Organisations', FICHE_METIER: 'Activités', RELATION: 'Mes biens',
};
/** Rubriques qui ne demandent rien (historique, préférences, notifications) : hors du « À faire ». */
const IGNOREES = new Set(['NOTIFICATION', 'PAIEMENT', 'CONSENTEMENT', 'CARTE', 'ROLE', 'RECOURS']);

function joursAvant(echeance: string, now: Date): number {
  return Math.floor((Date.parse(echeance.length === 10 ? `${echeance}T23:59:59Z` : echeance) - now.getTime()) / 86_400_000);
}

function ligne(e: CompteElement, now: Date, dejaCouverte: (obligationId: string) => boolean): LigneAFaire | null {
  if (IGNOREES.has(e.rubrique)) return null;
  const s = e.statut ?? '';
  const lien = lienUsager(e.lien) ?? '/espace';
  const base = { id: e.id, categorie: CATEGORIE[e.rubrique] ?? 'Autres', libelle: e.libelle, etat: s, echeance: e.echeance ?? null, montant: e.montant ?? null };
  const j = e.echeance ? joursAvant(e.echeance, now) : null;
  const urgence = j !== null && j < 0 ? 'EN_RETARD' as const : j !== null && j <= JOURS_AVANT_RENOUVELLEMENT ? 'BIENTOT' as const : 'NORMALE' as const;
  // Paiements dus.
  if (e.rubrique === 'OBLIGATION') {
    if (!OBLIGATION_A_PAYER.includes(s)) return null;
    // Déjà entièrement couverte par des paiements confirmés (rapprochement en cours) : rien à payer, l'usager suit.
    if (dejaCouverte(e.id)) return { ...base, groupe: 'EN_VERIFICATION', urgence: 'NORMALE', etat: 'PAYEE_EN_RAPPROCHEMENT', action: { libelle: 'Voir la quittance', lien: '/espace#sec-rc' } };
    return { ...base, groupe: 'A_FAIRE', urgence: s === 'EN_RETARD' ? 'EN_RETARD' : urgence, action: { libelle: 'Payer', lien: '/espace', obligationId: e.id } };
  }
  if (e.rubrique === 'ARRIERE') {
    // Constat retenu ou dossier de recouvrement lié à une obligation : payer (ou contester) directement ici.
    if (e.obligationId) {
      if (dejaCouverte(e.obligationId)) return { ...base, groupe: 'EN_VERIFICATION', urgence: 'NORMALE', etat: 'PAYEE_EN_RAPPROCHEMENT', action: { libelle: 'Voir la quittance', lien: '/espace#sec-rc' } };
      return { ...base, groupe: 'A_FAIRE', urgence: 'EN_RETARD', action: { libelle: e.lien === '/stationnement' ? 'Payer l’amende' : 'Payer', lien: '/espace', obligationId: e.obligationId, contesterObligationId: e.obligationId } };
    }
    return { ...base, groupe: 'A_FAIRE', urgence: 'EN_RETARD', action: { libelle: e.lien === '/stationnement' ? 'Régler ou contester le constat' : 'Régulariser (payer ou échéancier)', lien: e.lien === '/stationnement' ? '/stationnement' : '/mes-arrieres' } };
  }
  if (e.rubrique === 'SESSION') {
    if (s === 'EN_ATTENTE_PAIEMENT') return { ...base, groupe: 'A_FAIRE', urgence: 'BIENTOT', action: { libelle: 'Payer le stationnement', lien: '/stationnement' } };
    if (s === 'ACTIVE') return { ...base, groupe: 'EN_VERIFICATION', urgence: 'NORMALE', etat: 'EN_COURS', action: { libelle: 'Voir ou prolonger', lien: '/stationnement' } };
    return null;
  }
  if (e.rubrique === 'QUITTANCE') {
    return s === 'PROVISOIRE' ? { ...base, groupe: 'EN_VERIFICATION', urgence: 'NORMALE', etat: 'CONFIRMATION_BANCAIRE', action: { libelle: 'Voir la quittance', lien: '/espace#sec-rc' } } : null;
  }
  // Démarche payante (30/09/2026) : rendez-vous de contrôle technique — la redevance se paie ici, jamais en espèces au
  // centre ; une fois payée, le centre confirme le créneau.
  if (e.rubrique === 'DEMARCHE' && e.obligationId && s === 'DEMANDE') {
    if (dejaCouverte(e.obligationId)) return { ...base, groupe: 'EN_VERIFICATION', urgence: 'NORMALE', etat: 'PAYE_ATTENTE_CENTRE', action: { libelle: 'Voir la quittance', lien: '/espace#sec-rc' } };
    return { ...base, groupe: 'A_FAIRE', urgence: 'BIENTOT', etat: 'REDEVANCE_A_PAYER', action: { libelle: 'Payer la redevance', lien: '/espace', obligationId: e.obligationId } };
  }
  // Démarches : compléter si l'administration le demande ; sinon suivre.
  if (A_COMPLETER.includes(s)) return { ...base, groupe: 'A_FAIRE', urgence: 'BIENTOT', action: { libelle: 'Répondre ou compléter', lien } };
  if (EN_COURS.includes(s)) return { ...base, groupe: 'EN_VERIFICATION', urgence: 'NORMALE', action: { libelle: 'Suivre', lien } };
  if (s === 'PROVISOIRE') return { ...base, groupe: 'EN_VERIFICATION', urgence: 'NORMALE', etat: 'ENREGISTRE_A_VERIFIER', action: { libelle: 'Voir', lien } };
  // Titres, contrôles et pièces : à renouveler, à passer, ou à jour.
  if (EXPIRE.includes(s)) {
    const libelle = s === 'AUCUN_CONTROLE' || s === 'DEFAVORABLE' ? 'Prendre rendez-vous (contrôle technique)' : e.rubrique === 'DOCUMENT' ? 'Fournir à nouveau' : 'Renouveler';
    return { ...base, groupe: 'A_FAIRE', urgence: 'EN_RETARD', action: { libelle, lien: s === 'AUCUN_CONTROLE' || s === 'DEFAVORABLE' ? '/vehicules/mes-vehicules#rendez-vous-ct' : lien } };
  }
  if (VALIDE.includes(s)) {
    if (e.echeance && urgence !== 'NORMALE' && ['TITRE', 'PASS', 'MANDAT_DONNE', 'DOCUMENT'].includes(e.rubrique)) {
      return { ...base, groupe: 'A_FAIRE', urgence, action: e.id.startsWith('TIT-') ? { libelle: urgence === 'EN_RETARD' ? 'Renouveler (expiré)' : 'Renouveler', lien, titreId: e.id } : { libelle: 'Faire une nouvelle demande', lien } };
    }
    return { ...base, groupe: 'A_JOUR', urgence: 'NORMALE', action: { libelle: 'Voir', lien } };
  }
  return { ...base, groupe: 'EN_VERIFICATION', urgence: 'NORMALE', action: { libelle: 'Voir', lien } };
}

const RANG_URGENCE = { EN_RETARD: 0, BIENTOT: 1, NORMALE: 2 } as const;

export function aFaire(sections: CompteSection[], now: Date, dejaCouverte: (obligationId: string) => boolean = () => false) {
  const elements = sections.flatMap((s) => s.elements);
  // Une obligation déjà portée par un constat ou un dossier (paiement direct sur cette ligne) n'est pas répétée.
  // Idem pour une démarche payante (rendez-vous de contrôle technique et sa redevance, 30/09/2026).
  const portees = new Set(elements.filter((e) => (e.rubrique === 'ARRIERE' || e.rubrique === 'DEMARCHE') && e.obligationId).map((e) => e.obligationId!));
  const lignes = elements.filter((e) => !(e.rubrique === 'OBLIGATION' && portees.has(e.id))).map((e) => ligne(e, now, dejaCouverte)).filter((l): l is LigneAFaire => !!l);
  const tri = (a: LigneAFaire, b: LigneAFaire) => RANG_URGENCE[a.urgence] - RANG_URGENCE[b.urgence] || (a.echeance ?? '9999').localeCompare(b.echeance ?? '9999');
  const groupe = (g: GroupeAFaire) => lignes.filter((l) => l.groupe === g).sort(tri);
  return {
    aFaire: groupe('A_FAIRE'),
    enVerification: groupe('EN_VERIFICATION'),
    aJour: groupe('A_JOUR'),
    regles: {
      renouvellementJours: JOURS_AVANT_RENOUVELLEMENT,
      statut: 'par défaut — à confirmer par le maître d’ouvrage',
      principe: 'Tout ce qui vous concerne, en un seul endroit : ce que vous devez faire, ce que l’administration vérifie, ce qui est à jour. Vous n’avez rien à vérifier vous-même.',
    },
  };
}
