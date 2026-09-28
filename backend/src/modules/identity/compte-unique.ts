/**
 * Compte unique (Cahier, ch. 9 « Modèle un utilisateur, un compte » ; ajout du 28/09/2026).
 *
 * Un registre de contributions : chaque module (socle et modules d'extension) déclare ce qu'il détient pour un compte
 * (objets, obligations, titres, quittances, recours, mandats, organisations, documents, consentements, véhicules, baux,
 * entreprises, pass, sessions, enseignes, arriérés, notifications…). La vue « Mon compte unique » les agrège SANS copier
 * de données et SANS second enregistrement de la personne : chaque élément renvoie à l'écran de son module.
 *
 * Les modules qui tiennent une fiche « personne » de métier (conducteur wewa, agence, sous-traitant…) la déclarent
 * aussi (`fiches`) : la fiche porte le lien vers le compte unique ; une fiche non rattachée est signalée, jamais
 * fusionnée d'office (le rattachement exact se fait sur un téléphone vérifié ou un NIF, jamais sur un nom).
 */
import type { MoneyJSON } from '@mosolo/shared';

export const RUBRIQUES = [
  'OBJET', 'VEHICULE', 'BAIL', 'ENTREPRISE', 'RELATION', 'OBLIGATION', 'PAIEMENT', 'QUITTANCE', 'TITRE', 'PASS', 'SESSION',
  'ENSEIGNE', 'RECOURS', 'ARRIERE', 'DEMARCHE', 'MANDAT_DONNE', 'MANDAT_RECU', 'ORGANISATION', 'ROLE', 'DOCUMENT',
  'CONSENTEMENT', 'NOTIFICATION', 'CARTE', 'FICHE_METIER',
] as const;
export type Rubrique = (typeof RUBRIQUES)[number];

/** Libellés français des rubriques (affichage). */
export const RUBRIQUE_LABELS: Record<Rubrique, string> = {
  OBJET: 'Biens et objets', VEHICULE: 'Véhicules', BAIL: 'Baux', ENTREPRISE: 'Entreprises et activités', RELATION: 'Relations aux biens',
  OBLIGATION: 'Obligations', PAIEMENT: 'Paiements', QUITTANCE: 'Quittances', TITRE: 'Titres et autorisations', PASS: 'Pass et tickets',
  SESSION: 'Sessions de stationnement', ENSEIGNE: 'Enseignes et supports publicitaires', RECOURS: 'Recours', ARRIERE: 'Arriérés et recouvrement',
  DEMARCHE: 'Démarches', MANDAT_DONNE: 'Mandats donnés', MANDAT_RECU: 'Mandats reçus', ORGANISATION: 'Organisations et rôles', ROLE: 'Rôles déclarés',
  DOCUMENT: 'Documents', CONSENTEMENT: 'Consentements et préférences', NOTIFICATION: 'Notifications', CARTE: 'Cartes MOSOLO',
  FICHE_METIER: 'Fiches de métier rattachées',
};

export interface CompteElement {
  rubrique: Rubrique;
  id: string;
  libelle: string;
  /** Sous-type (catégorie d'objet, type de titre…). */
  nature?: string;
  statut?: string;
  montant?: MoneyJSON;
  /** Date d'échéance (obligation) ou de fin de validité (titre, pass). */
  echeance?: string;
  date?: string;
  /** Objet fiscal concerné : sert au périmètre d'un mandat limité à certains objets. */
  objectId?: string;
  /** Écran du module (lien de l'interface). */
  lien?: string;
}

export interface CompteSection {
  module: string;
  titre: string;
  lien: string;
  elements: CompteElement[];
  erreur?: string;
}

/** Fiche « personne » de métier tenue par un module (jamais un second compte). */
export interface FicheMetier {
  module: string;
  type: string;
  id: string;
  libelle: string;
  /** Compte unique rattaché (absent : fiche non rattachée, signalée). */
  taxpayerId?: string;
  /** Téléphone de la fiche (normalisé) — sert au seul rattachement exact après vérification par code. */
  phone?: string;
}

export interface CompteContributor {
  module: string;
  titre: string;
  lien: string;
  collect(taxpayerId: string): CompteElement[];
  /** Fiches « personne » de métier du module (conducteurs, agences…). */
  fiches?(): FicheMetier[];
  /**
   * Rattachement EXACT des fiches du module à un compte dont le téléphone vient d'être vérifié par code (jamais sur
   * un nom). Retourne le nombre de fiches rattachées ; chaque rattachement est journalisé par le module.
   */
  rattacher?(taxpayerId: string, phone: string): number;
}

/**
 * Branchements d'accès et d'identité fournis par le module « acces » (preuves, niveaux, mandats, consultation motivée).
 * Sans module « acces » chargé : seul le titulaire lit son compte.
 */
export interface CompteUniqueGates {
  /** Mandat ACTIF du mandataire (action CONSULTER) et objets couverts (liste vide = tous les objets du mandant). */
  mandate?(userId: string, taxpayerId: string): { mandateId: string; objectIds: string[] } | null;
  /** Consultation motivée active (circuit existant du module accès) ; compte la lecture. */
  consultation?(userId: string, taxpayerId: string, consultationId: string): boolean;
  /** Identité enrichie : preuves (masquées), niveau et droits ouverts, prochaines étapes, organisations. */
  identite?(taxpayerId: string, viewer: 'self' | 'mandataire' | 'agent'): Record<string, unknown>;
}

export class CompteUniqueRegistry {
  private readonly contributors = new Map<string, CompteContributor>();
  readonly gates: CompteUniqueGates = {};

  /** Déclaration (idempotente par module : une seconde déclaration remplace la première). */
  register(c: CompteContributor): void {
    this.contributors.set(c.module, c);
  }

  list(): CompteContributor[] {
    return [...this.contributors.values()];
  }

  /** Sections du compte : une erreur d'un module n'empêche jamais l'affichage des autres (section marquée). */
  collect(taxpayerId: string): CompteSection[] {
    return this.list().map((c) => {
      try {
        return { module: c.module, titre: c.titre, lien: c.lien, elements: c.collect(taxpayerId) };
      } catch (e) {
        return { module: c.module, titre: c.titre, lien: c.lien, elements: [], erreur: e instanceof Error ? e.message : 'Section indisponible' };
      }
    });
  }

  fiches(): FicheMetier[] {
    return this.list().flatMap((c) => {
      try { return c.fiches?.() ?? []; } catch { return []; }
    });
  }

  rattacher(taxpayerId: string, phone: string): number {
    let n = 0;
    for (const c of this.list()) {
      try { n += c.rattacher?.(taxpayerId, phone) ?? 0; } catch { /* rattachement non bloquant */ }
    }
    return n;
  }
}
