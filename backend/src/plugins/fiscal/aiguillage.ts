/**
 * Aiguillage des dossiers repris de l'ancienne DGRK (30/09/2026, réforme annoncée par le Gouvernorat : la DGRK est
 * remplacée par deux régies — DGIPK, impôts provinciaux ; DGTK, droits, taxes et redevances de la Ville). Chaque ligne
 * reprise (objet, historique, compte) est rattachée à la régie compétente :
 *  1. d'abord la fiche du registre juridique correspondant à la recette (entité administrante de la fiche) ;
 *  2. sinon la table par défaut ci-dessous — « par défaut — à confirmer par le maître d'ouvrage » (acte de répartition
 *     des recettes entre DGIPK et DGTK attendu du Gouvernorat) ;
 *  3. sinon « À ARBITRER » : décision motivée d'une personne distincte de celle qui a déposé le lot.
 * Un compte (une personne = un compte) n'est jamais scindé : il est rattaché aux régies de ses objets et recettes.
 */
import type { ObjectCategory } from '../../modules/objects/service.js';

export type Regie = 'DGIPK' | 'DGTK';
export type Aiguillage = Regie | 'A_ARBITRER';
export const AIGUILLAGE_STATUT = 'par défaut — à confirmer par le maître d’ouvrage (acte de répartition DGIPK / DGTK)';

/** Objets : régie compétente par nature (par défaut — à confirmer). */
export const AIGUILLAGE_PAR_CATEGORIE: Record<ObjectCategory, Aiguillage> = {
  PARCELLE: 'DGIPK', BATIMENT: 'DGIPK', UNITE_LOCATIVE: 'DGIPK', // impôt foncier, impôt sur les revenus locatifs
  ACTIVITE: 'DGTK', PANNEAU: 'DGTK', // taxes d'activité, publicité et enseignes
  VEHICULE: 'A_ARBITRER', AUTRE: 'A_ARBITRER', // vignette et taxes sur les véhicules : répartition à trancher par l'acte
};

/** Recettes : mots-clés du libellé repris (par défaut — à confirmer), après la fiche du registre. */
const MOTS_CLES: [RegExp, Regie][] = [
  [/foncier|revenus? locatifs?|\birl\b|loyer|impôt|impot/i, 'DGIPK'],
  [/taxe|redevance|droit|publicit|affich|enseigne|patente|stationnement|péage|peage|march[ée]|voirie|embarquement|accostage/i, 'DGTK'],
];

export function aiguillerRecette(libelle: string, fiches: { code: string; label: string; administeringEntity: string }[]): { regie: Aiguillage; motif: string } {
  const l = libelle.trim().toLowerCase();
  const fiche = fiches.find((f) => f.code.toLowerCase() === l || f.label.toLowerCase().includes(l) || l.includes(f.code.toLowerCase()));
  if (fiche && (fiche.administeringEntity === 'DGIPK' || fiche.administeringEntity === 'DGTK')) {
    return { regie: fiche.administeringEntity, motif: `Fiche ${fiche.code} du registre (entité administrante ${fiche.administeringEntity})` };
  }
  const m = MOTS_CLES.find(([re]) => re.test(libelle));
  return m ? { regie: m[1], motif: `Libellé « ${libelle} » — table par défaut (${AIGUILLAGE_STATUT})` } : { regie: 'A_ARBITRER', motif: `Libellé « ${libelle} » sans correspondance : à arbitrer` };
}

export function aiguillerObjet(categorie: ObjectCategory): { regie: Aiguillage; motif: string } {
  const regie = AIGUILLAGE_PAR_CATEGORIE[categorie] ?? 'A_ARBITRER';
  return { regie, motif: regie === 'A_ARBITRER' ? `Objet ${categorie} : répartition à trancher (acte attendu)` : `Objet ${categorie} — table par défaut (${AIGUILLAGE_STATUT})` };
}
