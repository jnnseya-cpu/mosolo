/**
 * Types des écrans du programme (Document maître FR 2, ch. 41 à 48) — reflet des réponses de
 * /v1/pilotage/programme/* ; le serveur reste seul juge des droits et des états.
 */

/** Rôles de lecture des écrans du programme (mêmes rôles que la politique programme:read). */
export const PROGRAMME_READERS = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R13', 'R14', 'R15', 'R16', 'R17', 'R18', 'R22', 'R23', 'R24', 'R25', 'R26', 'R27', 'R28'];
export const SUPERVISION = ['R01', 'R02', 'R03', 'R05'];

export interface PreuveTest { fichier: string; titre: string; statut?: 'PENDING_MERGE'; libelle?: string }
export interface PreuveCode { fichier: string; symbole: string }
export interface Historique { at: string; by: string; action: string; texte?: string }

export interface Mesure { mesure: string; statut: 'CONSTRUIT' | 'EXTERNE'; code?: PreuveCode[]; tests?: PreuveTest[]; note?: string }
export interface Risque {
  code: string; risque: string; traitement: string; source: { probabilite: string; impact: string };
  probabilite: string; probabiliteLibelle: string; impact: string; impactLibelle: string; criticite: { score: number; zone: string; libelle: string };
  proprietaire: string; proprietaireStatut: string; derniereRevue: { at: string; by: string; commentaire: string } | null;
  prochaineRevue: string; revueEnRetard: boolean; joursDeRetard: number; mesures: Mesure[]; registreAnterieur: string[]; historique: Historique[];
}
export interface RegistreRisques {
  source: string; items: Risque[]; echelle: string; regle: string;
  carteChaleur: { probabilites: { code: string; libelle: string; rang: number }[]; impacts: { code: string; libelle: string; rang: number }[]; cellules: { probabilite: string; impact: string; score: number; zone: string; libelle: string; risques: string[] }[] };
  synthese: { total: number; enRetard: number; critiques: number; mesuresExternes: number };
}

export interface Critere { code: string; critere: string; preuves: PreuveTest[]; obligatoire?: string; origine?: string; fondement?: string }
export interface Recit { code: string; recit: string; criteres: string; preuves: PreuveTest[]; construitIci?: string }
export interface Suivi { code: string; libelle: string; responsable: string; etat: string; etatLibelle: string; echeance: string | null; preuve: { reference: string; sha256: string } | null; historique: Historique[] }
export interface PointStrategie { code: string; point: string; statut: 'CONSTRUIT' | 'PARTIEL' | 'EXTERNE'; preuves: (PreuveTest | PreuveCode)[]; suivis: Suivi[]; note: string }
export interface Recette { source: string; criteres: Critere[]; recits: Recit[]; strategie: PointStrategie[]; suivis: Suivi[]; regle: string }

export interface Version {
  code: string; version: string; public: string; construction: 'CONSTRUIT' | 'PARTIEL'; etat: string; etatLibelle: string; preuve: { reference: string; sha256: string } | null; historique: Historique[];
  contenus: { contenu: string; construit: boolean; note?: string; socle: { cle: string; present: boolean }[]; modules: { nom: string; present: boolean }[] }[];
}
export interface PlanVersions { source: string; items: Version[]; communes: { pilote: string[]; referentiel: number }; regle: string }

export interface ActionPlan { id: string; action: string; lien?: string; etat: string; etatLibelle: string; note: string | null; enRetard: boolean; instruction: { id: string; number: string; status: string; deadline: string } | null; historique: Historique[] }
export interface Periode { code: string; jours: string; responsable: string; debutDate: string | null; echeance: string | null; actions: ActionPlan[]; faites: number }
export interface CentJoursPlan { source: string; demarrage: { debut: string; fixePar: string; motif: string } | null; jour: number | null; periodes: Periode[]; synthese: { actions: number; faites: number; enRetard: number }; regle: string }

export interface Decision {
  numero: number; id: string; decision: string; statut: string; statutLibelle: string;
  enAttente: { statut: string; acte?: { reference: string; titre: string; date: string; sha256: string }; motif: string; par: string; le: string } | null;
  acte: { reference: string; titre: string; date: string; sha256: string } | null; enregistrePar: string | null; validePar: string | null; valideLe: string | null;
  debloque: { libelle: string; controle: string; etat: string; detail: string }[];
  contradiction: { avec: string; texte: string; comportement: string } | null; historique: Historique[];
}
export interface RegistreDecisions {
  source: string; items: Decision[]; synthese: { objet: string; position: string }[]; devise: string; regle: string;
  compte: { A_PRENDRE: number; PRISE: number; REFUSEE: number; aValider: number };
  contradictions: { numero: number; avec: string; texte: string; comportement: string }[];
}

/** Libellé d'une preuve de test : fichier et titre, ou mention « à relier à la fusion ». */
export function preuveTexte(p: PreuveTest | PreuveCode): string {
  if ('symbole' in p) return `${p.fichier} — ${p.symbole}`;
  return p.statut === 'PENDING_MERGE' ? `${p.libelle ?? 'preuve à relier à la fusion'} (${p.fichier})` : `${p.fichier} — « ${p.titre} »`;
}
