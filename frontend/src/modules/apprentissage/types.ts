/** Types du module d'apprentissage (§ 24), alignés sur backend/src/plugins/apprentissage/model.ts. */
export type Profil = 'CONTRIBUABLE' | 'RECENSEUR' | 'CONTROLEUR' | 'GUICHET' | 'CADRE' | 'FINANCES' | 'ADMINISTRATEUR';
export type ProfilCertifie = Exclude<Profil, 'CONTRIBUABLE'>;

export const PROFIL_LIBELLE: Record<Profil, string> = {
  CONTRIBUABLE: 'Contribuables', RECENSEUR: 'Agents recenseurs', CONTROLEUR: 'Contrôleurs', GUICHET: 'Agents de guichet',
  CADRE: 'Cadres et superviseurs', FINANCES: 'Finances et trésorerie', ADMINISTRATEUR: 'Administrateurs',
};
export const PROFILS_CERTIFIES: ProfilCertifie[] = ['RECENSEUR', 'CONTROLEUR', 'GUICHET', 'CADRE', 'FINANCES', 'ADMINISTRATEUR'];

export interface QuestionVue { id: string; enonce: string; choix: string[] }
export interface Question extends QuestionVue { bonne: number }
export type StatutVersion = 'BROUILLON' | 'PROPOSEE' | 'PUBLIEE' | 'REFUSEE' | 'REMPLACEE';

export interface VersionContenu {
  version: number; titre: string; corps: string; lingala?: { titre: string; corps: string; statut: 'BROUILLON' };
  lecons?: string[]; epreuve?: Question[]; controlePratique?: string; statut: StatutVersion; auteur: string; creeLe: string;
  proposition?: { par: string; le: string }; decision?: { par: string; le: string; approuve: boolean; motif: string };
}
export interface Contenu { id: string; type: 'FICHE' | 'MODULE' | 'PROCEDURE'; cle: string; publics: Profil[]; versions: VersionContenu[]; demo?: boolean }

/** Vue apprenant d'une version publiée (jamais la bonne réponse). */
export interface ContenuVue extends Omit<VersionContenu, 'epreuve'> {
  id: string; type: 'FICHE' | 'MODULE'; cle: string; publics: Profil[]; demo?: boolean; epreuve?: QuestionVue[]; lingalaNote?: string;
}
export interface Epreuve { id: string; userId: string; moduleId: string; version: number; scorePct: number; reussie: boolean; le: string }
export interface Certificat {
  id: string; userId: string; profil: ProfilCertifie; delivreLe: string; valableJusquau: string; delivrePar: string;
  fondement: { epreuves: string[]; evaluations: string[]; note?: string }; statut: 'DELIVRE' | 'RETIRE';
  retrait?: { par: string; le: string; motif: string }; demo?: boolean;
}
export interface Exigence { code: string; libelle: string; satisfaite: boolean; detail?: string }
export interface EtatCertification {
  applicable: boolean; valide: boolean; profil: ProfilCertifie; certificat: Certificat | null; manquants: string[]; exigences: Exigence[]; aRevoir?: string;
}
export interface Confidentialite { principe: string; enregistre: string[]; jamais: string[] }
export interface PublicVue { profil: Profil; nom: string; mode: string; libelle: string; contenu: string }

export interface Espace {
  profils: PublicVue[];
  fiches: ContenuVue[];
  modules: (ContenuVue & { derniereEpreuve: Epreuve | null })[];
  certifications: EtatCertification[];
  seuilReussitePct: number; statutSeuil: string; confidentialite: Confidentialite;
}
export interface Evaluation {
  id: string; userId: string; profil: ProfilCertifie; type: string; resultat: 'CONFORME' | 'NON_CONFORME'; observations: string; references: string[];
  echantillon?: { taille: number; conformes: number; conformitePct: number; seuilPct: number }; evaluateur: string; le: string; demo?: boolean;
}
export interface LigneRegistre {
  userId: string; nom: string; profil: ProfilCertifie; libelleProfil: string; valide: boolean; certificat: Certificat | null; manquants: string[]; aRevoir?: string;
}
export interface Registre {
  lignes: LigneRegistre[]; evaluations: Evaluation[]; today: string;
  parametres: { statut: string; seuilReussiteEpreuvePct: number; validiteCertificatJours: Record<ProfilCertifie, number>; evaluationContinueIntervalleJours: number; echantillonTaille: number; echantillonConformiteMinPct: number; note: string };
  liensIndicateurs: { libelle: string; chemin: string }[];
  evaluateurs: Record<ProfilCertifie, string[]>;
  evaluationExigee: Record<ProfilCertifie, { type: string; libelle: string }>;
}
export interface Comprehension {
  definition: string; statut: 'MESURE' | 'NON_MESURE'; tauxPct: string | null; libelle: string; examines: number; completsDuPremierCoup: number;
  sources: { source: string; disponible: boolean; examines: number; completsDuPremierCoup: number; tauxPct: string | null }[]; note: string;
}
export interface Indicateurs {
  comprehension: Comprehension;
  couverture: { profil: ProfilCertifie; libelle: string; mode: string; enVigueur: number; expires: number; retires: number; echeanceSous30j: number }[];
  confidentialite: Confidentialite; publics: PublicVue[];
}
