/**
 * Veille des tendances (Trend Intelligence) — modèle (10/11/2026). Fusion de la spécification « Trend Intelligence AI »
 * v2.3 (docs/sources/trend-intelligence-ai-build-spec-v2.3.md) dans MOSOLO : mêmes circuits (moteur de politiques,
 * journal d'audit chaîné, idempotence, relais d'IA Claude → OpenAI → Gemini comme « IA de l'hôte »), même doctrine
 * (l'IA propose, une personne décide ; aucune clé nouvelle ; aucun envoi réel sans approbation).
 * Le cœur ne connaît ni marque, ni pays, ni secteur : tout vient du profil de l'installation.
 */
import type { RoleCode } from '@mosolo/shared';
import type { Canal, GrowthBrief, TypeAction } from './contrat.js';

export const A_CONFIRMER = 'par défaut — à confirmer par le maître d’ouvrage';

/** Paramètres (§ 5, § 17, § 19) : valeurs de départ de la spécification, toutes « à confirmer ». */
export const PARAMETRES = {
  volumeMin: 20, zMin: 2, periodesMin: 4, periodesBase: 8, fenetreJours: 7,
  archiveScore: 60, archiveConfiance: 55, brief: 75, automatique: 85, plafondUneFamille: 69,
  validitePersistantH: 168, validiteSoudainH: 24, cacheEffectifS: 60,
  quotaMensuelDefaut: 50, echantillonMin: 30, seuilRetourPct: 80, petitesCohortes: 5,
};

export type AccesSource = 'PREMIERE_PARTIE' | 'IMPORT_FICHIER' | 'PUBLIC_SANS_CLE' | 'HOTE';
export const ACCES_SOURCE: Record<AccesSource, string> = {
  PREMIERE_PARTIE: 'Données propres de l’installation (agrégats, sans clé)',
  IMPORT_FICHIER: 'Import de fichier (CSV) ou saisie manuelle',
  PUBLIC_SANS_CLE: 'Flux public autorisé, sans clé (RSS…)',
  HOTE: 'Transmis par une intégration déjà autorisée de l’hôte',
};

export interface Installation {
  id: string; slug: string; libelle: string; environnement: 'DEMONSTRATION' | 'PRODUCTION';
  gel: { by: string; at: string; motif: string } | null;
  optInAutomatique: false;
  quotaMensuel: number;
  /** Rôles qui ont accès à cette installation (vide : tous les rôles habilités du module). */
  acces: RoleCode[];
  creeLe: string; creePar: string;
}

export interface SujetProfil {
  id: string; libelle: string; alias: string[];
  /** Adéquation et intention 0–100 : correspondance VÉRIFIÉE du profil (une suggestion de l'IA n'y entre jamais seule). */
  adequation: number; intention: number;
  /** Capacité à servir la demande (stock, service, délai) : sans elle, aucune activation. */
  pret: boolean;
  classe: 'PERSISTANT' | 'SOUDAIN';
  audience: string; intentionTexte: string; claims: string[]; cta: string; assetId: string | null;
}

export interface Profil {
  id: string; installationId: string; revision: number; actif: boolean;
  marche: string; locale: string; fuseau: string;
  canaux: Canal[]; assets: string[];
  claims: { id: string; texte: string; source: string }[];
  ctas: { id: string; libelle: string; cible: string }[];
  sujets: SujetProfil[];
  interdits: string[];
  resultat: { conversion: string; denominateur: string };
  qualiteFamilles: Record<string, number>;
  creePar: string; creeLe: string;
}

export interface Source {
  id: string; installationId: string; famille: string; acces: AccesSource; libelle: string;
  cadence: string; peremptionHeures: number; contexteSeul: boolean; active: boolean;
  /** Raison d'indisponibilité (ex. : accès qui exigerait une clé nouvelle — jamais demandée, TI-22). */
  indisponible: string | null;
}

export interface Observation {
  id: string; installationId: string; sourceId: string; famille: string; recordId: string; revision: number; empreinte: string;
  observeLe: string; debut: string; fin: string; ingereLe: string;
  marche: string; locale: string; sujet: string; texteOriginal: string;
  metrique: string; valeur: number; unite: string; couverture: number;
  demo?: true;
}

export interface MesureFamille {
  famille: string; contexteSeul: boolean; courant: number; baseMediane: number; periodes: number; lift: number; z: number;
  historiqueSuffisant: boolean; porteFranchie: boolean; scoreDemande: number; qualite: number; couverture: number; fraicheur: number; perimee: boolean;
}

export type StatutOpportunite = 'DETECTEE' | 'SURVEILLEE' | 'ELIGIBLE' | 'ECARTEE' | 'BRIEFEE' | 'EXPIREE';
export interface Opportunite {
  id: string; installationId: string; sujet: string; libelle: string; marche: string; locale: string;
  finFenetre: string; versionCalcul: string; empreinteEntrees: string; calculeLe: string;
  familles: MesureFamille[];
  composantes: { demande: number; adequation: number; intention: number; moment: number; preparation: number };
  score: number;
  composantesConfiance: { qualite: number; corroboration: number; couverture: number; fraicheur: number };
  confiance: number;
  vetos: string[]; blocages: string[];
  decision: 'ARCHIVER' | 'SURVEILLER' | 'BRIEF' | 'AUTOMATIQUE_ELIGIBLE';
  statut: StatutOpportunite;
  preuves: string[];
  remplacePar?: string;
}

export type StatutBrief = 'BROUILLON' | 'APPROUVE' | 'REMPLACE' | 'REVOQUE';
export interface Brief {
  id: string; briefId: string; version: number; installationId: string; statut: StatutBrief;
  contenu: GrowthBrief; classe: 'PERSISTANT' | 'SOUDAIN'; opportuniteId: string; profilRevision: number;
  creePar: string; creeLe: string;
  approbation?: { by: string; at: string };
  revocation?: { by: string; at: string; motif: string };
}

export type StatutAction = 'PROPOSEE' | 'APPROUVEE' | 'EN_FILE' | 'APPLIQUEE' | 'ECHEC' | 'RECONCILIATION' | 'RETABLIE' | 'CONFLIT' | 'EXPORTEE';
export interface Action {
  id: string; installationId: string; briefId: string; briefVersion: number; type: TypeAction; canal: Canal;
  agent: 'SEO' | 'MARKETING';
  cibleId: string | null; revisionAttendue: number | null;
  champs: Record<string, string>;
  precedent: Record<string, string> | null;
  preuves: string[]; claims: string[];
  statut: StatutAction;
  cleIdempotence: string;
  auteur: string; creeLe: string; profilRevision: number;
  generation: { route: 'IA_HOTE' | 'DETERMINISTE'; fournisseur: string | null; modele: string | null; degrade: boolean; motif: string | null };
  approbation?: { by: string; at: string; empreinte: string; revision: number | null; politique: number };
  recu?: { cle: string; revision: number; at: string };
  revisionAppliquee?: number;
  retour?: { by: string; at: string; motif: string; revision: number };
  erreur?: { code: string; message: string; at: string };
  export?: { by: string; at: string; destination: string };
}

export interface ChampsPage { titre: string; description: string; accroche: string; ctaLibelle: string; bloc: string; ctaCible: string }
export interface Page {
  id: string; installationId: string; slug: string; sujet: string;
  /** Surface existante de la plateforme où la révision active s'affiche : article du blog public ou page propre. */
  surface: 'BLOG' | 'PAGE';
  revisionActive: number | null; statut: 'BROUILLON' | 'APPROUVEE';
  creePar: string; creeLe: string; approuvePar?: string; approuveLe?: string;
}
export interface RevisionPage { id: string; assetId: string; installationId: string; revision: number; champs: ChampsPage; creeLe: string; cleAction: string | null }
export interface Mesure { id: string; installationId: string; assetId: string; revision: number; jour: string; evenement: 'VISITE' | 'CTA'; nombre: number }
export interface Travail { id: string; installationId: string; actionId: string; nature: 'EXECUTER'; at: string }
export interface Usage { id: string; installationId: string; mois: string; statut: 'RESERVE' | 'REGLE' | 'LIBERE'; at: string }

// ——— Rôles (à confirmer par le maître d'ouvrage) ———
/** Lecture : direction, régies, IA, audit, exploitation, Groupe Nseya. */
export const LECTEURS: RoleCode[] = ['R01', 'R02', 'R03', 'R05', 'R06', 'R07', 'R08', 'R22', 'R23', 'R26', 'R27', 'R28', 'R29', 'R38'];
/** Proposer (profil, imports, calcul, brief brouillon, génération, page brouillon). */
export const PROPOSANTS: RoleCode[] = ['R06', 'R07', 'R08', 'R29'];
/** Approuver (brief, action, première page, retour arrière) : cabinet — communication publique (à confirmer). */
export const APPROBATEURS: RoleCode[] = ['R02', 'R03'];
/** Gel d'urgence d'une installation. */
export const GELEURS: RoleCode[] = ['R02', 'R26', 'R28'];
/** Travaux (file d'exécution, rapprochement) : exploitation. */
export const EXPLOITANTS: RoleCode[] = ['R27'];
/** Dépôt d'observations par une intégration déjà autorisée (partenaire de données). */
export const DEPOSANTS: RoleCode[] = ['R06', 'R07', 'R29', 'R34'];
