/**
 * Document maître FR 2, ch. 42 (critère 10) : les tableaux de bord distinguent explicitement six états de la recette.
 * Correspondance avec l'échelle unifiée à onze niveaux (§ 26.1, REVENUE_LADDER) : les six états en sont des niveaux,
 * emboîtés, jamais additionnés. « Constaté » = liquidé ; « encaissé » = paiement confirmé (confirmation du prestataire).
 */
import type { RevenueLadderLevel } from './domain.js';

export const SIX_ETATS: { code: 'POTENTIEL' | 'CONSTATE' | 'ENCAISSE' | 'REGLE' | 'RAPPROCHE' | 'DISPONIBLE'; libelle: string; niveau: RevenueLadderLevel }[] = [
  { code: 'POTENTIEL', libelle: 'Potentiel', niveau: 'potential' },
  { code: 'CONSTATE', libelle: 'Constaté', niveau: 'assessed' },
  { code: 'ENCAISSE', libelle: 'Encaissé', niveau: 'confirmed' },
  { code: 'REGLE', libelle: 'Réglé', niveau: 'settled' },
  { code: 'RAPPROCHE', libelle: 'Rapproché', niveau: 'reconciled' },
  { code: 'DISPONIBLE', libelle: 'Disponible', niveau: 'available' },
];
