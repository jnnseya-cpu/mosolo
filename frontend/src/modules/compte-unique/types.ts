/** Types des réponses « Mon compte unique » (ch. 9) et « Mes biens et relations » (spécification v1.0 du 28/09/2026). */
import type { MoneyJSON } from '@mosolo/shared';

export interface CompteElement {
  rubrique: string;
  id: string;
  libelle: string;
  nature?: string;
  statut?: string;
  montant?: MoneyJSON;
  echeance?: string;
  date?: string;
  objectId?: string;
  lien?: string;
}

export interface CompteSection { module: string; titre: string; lien: string; elements: CompteElement[]; erreur?: string }

export interface NiveauDroits { code: string; label: string; proof: string; rights: string; atteint: boolean }

export interface CompteUniqueView {
  viewer: 'self' | 'mandataire' | 'agent';
  compte: { taxpayerId: string; iuc: string; nom: string; nature: string; telephone: string | null; telephoneVerifie: boolean; niveau: string; langue: string; statut: string };
  identite: {
    niveau?: string;
    niveaux?: NiveauDroits[];
    prochainesEtapes?: string[];
    preuves?: { id: string; type: string; reference: string; statut: string }[];
    organisation?: { raisonSociale: string; forme: string; representants: { nom: string; fonction: string; habilitation: string; compteRattache: boolean }[] } | null;
    representeAupres?: { organisationId: string; raisonSociale: string; fonction: string; habilitation: string; mandatActif: boolean }[];
    reutilisation?: string;
  };
  sections: CompteSection[];
  synthese: {
    parRubrique: Record<string, number>;
    objetsParNature: Record<string, number>;
    obligationsParStatutEtDevise: { statut: string; devise: string; nombre: number; total: MoneyJSON }[];
    resteDuParDevise: (MoneyJSON & { affichage: string })[];
    titres: { valides: number; expires: number; total: number };
    prochainesEcheances: { id: string; libelle: string; echeance: string; montant: MoneyJSON | null; statut: string | null }[];
    modules: string[];
  };
  mandat?: { id: string; objets: string[] | 'TOUS' };
  principe: string;
}

export interface ClaimView {
  claimId: string;
  role: string;
  statut: string;
  statutLibelle: string;
  typeCible: string;
  version: number;
  du: string | null;
  au: string | null;
  colocation: boolean;
  quotePart: string | null;
  origine: string;
  bien: { id: string; libelle: string; statutEnregistrement: string; provenance: string; confiance: string } | null;
  adresseSaisie: Record<string, string> | null;
  pieces: { id: string; type: string; sha256: string; deposeeLe: string; statut: string }[];
  invitations: { id: string; contact: string; expireLe: string; statut: string }[];
  designationProprietaire: string | null;
  historique: { at: string; by: string; from: string | null; to: string; reason?: string }[];
  mentionJuridique: string;
  candidats?: number;
  suite?: string;
  indicesIgnores?: string[];
}

export interface MesRelations {
  compte: string;
  actuelles: ClaimView[];
  historiques: ClaimView[];
  relationsModule7: { relationId: string; role: string; statut: string; du: string; au: string | null; bien: { id: string; libelle: string } | null }[];
  parStatut: { statut: string; libelle: string; nombre: number }[];
  mentionJuridique: string;
}

export interface Candidats {
  claimId: string;
  candidats: { candidateId: string; rang: number; libelle: string; typeCible: string; statutEnregistrement: string; expireLe: string }[];
  aucun: { libelle: string };
  avertissement: string;
}

export interface VueProprietaire {
  bien: { id: string; libelle: string; statutEnregistrement: string; provenance: string | null };
  date: string;
  unites: {
    id: string; libelle: string; statutEnregistrement: string; occupation: 'OCCUPEE' | 'VACANTE';
    occupationsVerifiees: { role: string; du: string; au: string | null; colocation: boolean }[];
    revendicationsEnAttente: { reference: string; role: string; statut: string }[];
    loyerIRL: { bail: string; loyer: MoneyJSON; periodicite: string; du: string; au: string | null }[];
  }[];
  synthese: { unites: number; occupees: number; vacantes: number; enAttente: number };
  confidentialite: string;
}

export interface TreeNode {
  id: string; categorie: string; libelle: string; statutEnregistrement: string; provenance: string;
  identifiantOfficiel: { value: string; namespace: string; verified: boolean } | null; position: { lat: number; lon: number };
  revendications: number; conflits: number; enfants: TreeNode[]; dossierVise: boolean;
}

export interface CaseSummary {
  id: string; motif: string; motifLibelle: string; statut: string; commune: string; ouvertLe: string;
  revendication: { id: string; role: string; statut: string } | null; agentTerrain: string | null; echeanceTerrain: string | null;
  decision: { decision: string; reason: string; by: string; at: string } | null; version: number;
}

export interface CaseDetail extends CaseSummary {
  note: string | null;
  revendications: {
    id: string; role: string; statut: string; du: string | null; au: string | null; colocation: boolean; quotePart: string | null;
    compte: { id: string; nom: string; niveau: string | null } | null;
    cible: { id: string; libelle: string; statutEnregistrement: string; provenance: string | null } | null;
    adresseSaisie: Record<string, string> | null;
    pieces: { id: string; type: string; sha256: string; deposeeLe: string; statut: string }[];
  }[];
  fusion: { enregistrements: TreeNode[]; signaux: string[]; appliquee: unknown } | null;
  mentionJuridique: string;
}
