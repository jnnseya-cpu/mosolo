/**
 * Classification des données par dépôt et par champ (ch. 32 ; doc 28 : C1 public, C2 interne, C3 personnel,
 * C4 personnel sensible / secret fiscal, C5 secret) et règles de conservation.
 *
 * - Chaque dépôt découvert dans le contexte reçoit une classe et une nature ; un dépôt sans entrée est « À CLASSER »
 *   et traité, par prudence, en C3.
 * - Seuls les dépôts porteurs d'une règle de conservation sont purgeables, et JAMAIS un dépôt financier, d'audit,
 *   de preuve, fiscal, d'enquête ou de référentiel (double garde : nature ET préfixe du dépôt).
 * - La purge efface les champs personnels listés (pseudonymisation en place) : l'enregistrement, son identifiant et
 *   ses liens restent, le journal chaîné n'est jamais touché.
 * - Durées : paramètres du registre (0 = durée non fixée ⇒ aucune purge), à fixer par acte (J4, J8).
 */
import type { DataClass } from '@mosolo/shared';

export type NatureDonnee =
  | 'REFERENTIEL' | 'PERSONNEL' | 'FISCAL' | 'FINANCIER' | 'AUDIT' | 'PREUVE' | 'ENQUETE' | 'TECHNIQUE' | 'OPERATIONNEL';

/** Natures jamais purgées (§ 32 : « conservation longue limitée aux preuves d'audit » ; pièces financières). */
export const NATURES_PROTEGEES: NatureDonnee[] = ['FINANCIER', 'AUDIT', 'PREUVE', 'FISCAL', 'ENQUETE', 'REFERENTIEL'];

/** Préfixes de dépôts jamais purgés, quelle que soit la classification déclarée (seconde garde). */
export const DEPOTS_PROTEGES = [
  'core.audit', 'ledger.', 'payments.', 'receipts.', 'treasury.', 'assessment.', 'vault.', 'rules.',
  'ext.tresor.', 'ext.repartition.', 'ext.sanctions.', 'ext.verticales.calcu.', 'ext.integrite.', 'ext.juridique.',
];

export interface RegleConservation {
  /** Paramètre du registre des seuils (jours ; 0 = non fixée). */
  parametre: string;
  /** Champ de date de référence (ISO). */
  champDate: string;
  /** Champs personnels effacés à l'échéance. */
  champsEffaces: string[];
  /** Statuts exclus (enregistrement encore vivant). */
  statutsExclus?: string[];
}

export interface Classement {
  classe: DataClass;
  nature: NatureDonnee;
  libelle: string;
  /** Classe par champ (champs plus sensibles que le dépôt, ou masqués). */
  champs?: Record<string, DataClass>;
  conservation?: RegleConservation;
}

/** Métadonnées de classification : clé exacte, ou préfixe terminé par « . ». */
export const CLASSIFICATION: Record<string, Classement> = {
  'core.audit': { classe: 'C5', nature: 'AUDIT', libelle: 'Journal d’audit chaîné (permanent, archives)' },
  'comms.deliveries': { classe: 'C3', nature: 'PREUVE', libelle: 'Preuves de délivrance des communications', champs: { recipientMasked: 'C3', contentHash: 'C2' } },
  'alerts.alerts': { classe: 'C4', nature: 'ENQUETE', libelle: 'Alertes' },
  'taxpayers.taxpayers': { classe: 'C3', nature: 'PERSONNEL', libelle: 'Compte unique du contribuable', champs: { fullName: 'C3', phone: 'C3', email: 'C3', iuc: 'C2', prefs: 'C2', language: 'C2' } },
  'objects.objects': { classe: 'C3', nature: 'FISCAL', libelle: 'Objets fiscaux', champs: { lat: 'C3', lon: 'C3', attributes: 'C3', taxpayerId: 'C3' } },
  'objects.leases': { classe: 'C4', nature: 'FISCAL', libelle: 'Baux', champs: { rent: 'C4', lessorId: 'C3', lesseeId: 'C3' } },
  'vault.': { classe: 'C5', nature: 'FINANCIER', libelle: 'Coffre des comptes bénéficiaires', champs: { accountNumber: 'C5', holderName: 'C4' } },
  'rules.': { classe: 'C1', nature: 'REFERENTIEL', libelle: 'Registre juridique (règles, instruments)' },
  'ledger.': { classe: 'C4', nature: 'FINANCIER', libelle: 'Grand livre (ajout seul)' },
  'assessment.': { classe: 'C4', nature: 'FINANCIER', libelle: 'Liquidations et obligations (secret fiscal)' },
  'receipts.': { classe: 'C4', nature: 'FINANCIER', libelle: 'Quittances' },
  'payments.': { classe: 'C4', nature: 'FINANCIER', libelle: 'Ordres et confirmations de paiement' },
  'treasury.': { classe: 'C4', nature: 'FINANCIER', libelle: 'Relevés et exceptions du Trésor' },
  'field.devices': { classe: 'C5', nature: 'TECHNIQUE', libelle: 'Terminaux enrôlés (clés)', champs: { key: 'C5' } },
  'field.': { classe: 'C3', nature: 'PREUVE', libelle: 'Constats de terrain synchronisés' },
  'appeals.': { classe: 'C4', nature: 'PREUVE', libelle: 'Recours' },
  'ai.': { classe: 'C2', nature: 'OPERATIONNEL', libelle: 'Recommandations de l’IA (propositions)' },
  'ext.acces.otps': {
    classe: 'C4', nature: 'TECHNIQUE', libelle: 'Codes à usage unique (empreintes)', champs: { codeHash: 'C5', subjectId: 'C3' },
    conservation: { parametre: 'conservation.codes_otp_jours', champDate: 'createdAt', champsEffaces: ['codeHash', 'subjectId'], statutsExclus: ['EN_ATTENTE'] },
  },
  'ext.acces.consultations': { classe: 'C4', nature: 'AUDIT', libelle: 'Consultations motivées' },
  'ext.acces.proofs': { classe: 'C4', nature: 'PREUVE', libelle: 'Pièces d’identité (références masquées)', champs: { referenceMasked: 'C4', referenceHash: 'C4' } },
  'ext.acces.': { classe: 'C3', nature: 'PERSONNEL', libelle: 'Accès, entités, invitations, mandats' },
  'ext.socle.idp.challenges': {
    classe: 'C5', nature: 'TECHNIQUE', libelle: 'Défis de connexion (empreintes de codes)', champs: { codeHash: 'C5', salt: 'C5', userId: 'C3' },
    conservation: { parametre: 'conservation.codes_otp_jours', champDate: 'createdAt', champsEffaces: ['codeHash', 'userId'] },
  },
  'ext.socle.': { classe: 'C5', nature: 'TECHNIQUE', libelle: 'Authentification (identifiants, sessions)', champs: { passwordHash: 'C5', totpSecret: 'C5' } },
  'ext.canaux.engine.sessions': {
    classe: 'C3', nature: 'TECHNIQUE', libelle: 'Sessions USSD / SVI', champs: { msisdnHash: 'C3', msisdnMasked: 'C3', taxpayerId: 'C3', cardNumber: 'C3' },
    conservation: { parametre: 'conservation.sessions_canaux_jours', champDate: 'lastActivityAt', champsEffaces: ['msisdnHash', 'msisdnMasked', 'data', 'taxpayerId', 'cardNumber'], statutsExclus: ['ACTIVE'] },
  },
  'ext.canaux.cards.pins': { classe: 'C5', nature: 'TECHNIQUE', libelle: 'Codes secrets (empreintes salées)' },
  'ext.canaux.points.': { classe: 'C4', nature: 'FINANCIER', libelle: 'Points de paiement agréés et encaissements' },
  'ext.canaux.enrolment.': { classe: 'C4', nature: 'PREUVE', libelle: 'Enrôlements assistés (consentement)' },
  'ext.canaux.': { classe: 'C3', nature: 'OPERATIONNEL', libelle: 'Canaux (cartes, journaux, paiements assistés)' },
  'ext.preuves.': { classe: 'C3', nature: 'PERSONNEL', libelle: 'Conversations WhatsApp (numéro = identifiant)' },
  'ext.tresor.': { classe: 'C4', nature: 'FINANCIER', libelle: 'Trésor (opérations, clôtures, suspens)' },
  'ext.recouvrement.notices': { classe: 'C4', nature: 'PREUVE', libelle: 'Avis légaux' },
  'ext.recouvrement.': { classe: 'C4', nature: 'FISCAL', libelle: 'Recouvrement (dossiers, échéanciers, remises)' },
  'ext.fiscal.geo.': { classe: 'C1', nature: 'REFERENTIEL', libelle: 'Hiérarchie géographique' },
  'ext.fiscal.': { classe: 'C4', nature: 'FISCAL', libelle: 'Fiscal (relations, déclarations, exonérations, quitus)' },
  'ext.titres.types': { classe: 'C1', nature: 'REFERENTIEL', libelle: 'Catalogue des titres' },
  'ext.titres.': { classe: 'C3', nature: 'PREUVE', libelle: 'Titres, contrôles et constats' },
  'ext.parking.zones': { classe: 'C1', nature: 'REFERENTIEL', libelle: 'Zones de stationnement' },
  'ext.parking.': { classe: 'C3', nature: 'PREUVE', libelle: 'Stationnement (sessions, contrôles, photos, constats)', champs: { plate: 'C3', gps: 'C3' } },
  'ext.publicite.': { classe: 'C3', nature: 'PREUVE', libelle: 'Publicité (supports, dossiers, inspections)' },
  'ext.rakapay.': { classe: 'C3', nature: 'PERSONNEL', libelle: 'Transport (opérateurs, motos, conducteurs)', champs: { phone: 'C3', licenceNo: 'C3' } },
  'ext.verticales.calcu.': { classe: 'C4', nature: 'FINANCIER', libelle: 'CALCU (comptes publics, transactions)', champs: { accountNumberHash: 'C4' } },
  'ext.verticales.': { classe: 'C3', nature: 'PREUVE', libelle: 'Verticales (dossiers, plaques, scans, titres)' },
  'ext.terrain.': { classe: 'C3', nature: 'PREUVE', libelle: 'Terrain (sous-traitants, missions, constats)' },
  'ext.integrite-gouvernance.': { classe: 'C2', nature: 'AUDIT', libelle: 'Registre des seuils (décisions à deux personnes)' },
  'ext.integrite.registryVersions': { classe: 'C2', nature: 'REFERENTIEL', libelle: 'Registre des traitements (DPO)' },
  'ext.integrite.': { classe: 'C5', nature: 'ENQUETE', libelle: 'Intégrité (signalements, enquêtes, incidents)' },
  'ext.pilotage.': { classe: 'C2', nature: 'OPERATIONNEL', libelle: 'Pilotage (publications agrégées, exports)' },
  'ext.repartition.': { classe: 'C4', nature: 'FINANCIER', libelle: 'Répartition § 37A' },
  'ext.ia.': { classe: 'C2', nature: 'OPERATIONNEL', libelle: 'IA (recommandations, journal)' },
  'ext.sanctions.': { classe: 'C4', nature: 'FINANCIER', libelle: 'Commissions des agents' },
  'ext.chaine.': { classe: 'C2', nature: 'AUDIT', libelle: 'Chaîne opératoire' },
  'ext.juridique.': { classe: 'C2', nature: 'AUDIT', libelle: 'Points juridiques et purges (décisions à deux personnes)' },
};

/** Classement d'un dépôt : entrée exacte, sinon préfixe le plus long, sinon « À CLASSER » (C3 par prudence). */
export function classer(depot: string): (Classement & { source: 'EXACT' | 'PREFIXE' }) | { classe: DataClass; nature: 'A_CLASSER'; libelle: string; source: 'A_CLASSER' } {
  const exact = CLASSIFICATION[depot];
  if (exact) return { ...exact, source: 'EXACT' };
  const prefix = Object.keys(CLASSIFICATION).filter((k) => k.endsWith('.') && depot.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  if (prefix) return { ...CLASSIFICATION[prefix]!, source: 'PREFIXE' };
  return { classe: 'C3', nature: 'A_CLASSER', libelle: 'Dépôt à classer (traité en C3 par prudence)', source: 'A_CLASSER' };
}

/** Garde de purge : refus pour toute nature protégée ou tout dépôt protégé (financier, audit, preuve…). */
export function purgeInterdite(depot: string, c: { nature: string; conservation?: RegleConservation }): string | null {
  if (DEPOTS_PROTEGES.some((p) => depot === p || depot.startsWith(p))) return `Dépôt protégé (${depot}) : jamais purgé (financier, audit ou référentiel).`;
  if ((NATURES_PROTEGEES as string[]).includes(c.nature)) return `Nature ${c.nature} : jamais purgée (conservation longue des preuves, § 32).`;
  if (c.nature === 'A_CLASSER') return 'Dépôt non classé : aucune purge avant classification.';
  if (!c.conservation) return 'Aucune règle de conservation déclarée pour ce dépôt.';
  return null;
}
