/**
 * Registre des textes de référence — tableau du § 6.1 du Cahier (complétude). Chaque ligne du tableau est rattachée
 * aux instruments du registre qui la portent ; un instrument absent est signalé (jamais inventé ni activé).
 * Statuts prudents : tout ce qui n'a pas fait l'objet d'un relevé juridique certifié reste A_VERIFIER, donc
 * désactivé dans le moteur (§ 6.1 « Périmètre du référentiel à valider formellement »).
 * L'OL 13/001 est enregistrée ABROGÉE (par l'OL 18/004) : aucune règle ne peut la citer comme texte en vigueur.
 */
import type { LegalInstrumentStatus } from '@mosolo/shared';
import type { LegalInstrument } from './service.js';

export interface TexteReference {
  /** Ligne du tableau du § 6.1. */
  texte: string;
  objet: string;
  usage: string;
  instrumentIds: string[];
}

/** Tableau du § 6.1 (Cahier des exigences consolidé) — ordre du Cahier. */
export const TEXTES_REFERENCE_6_1: TexteReference[] = [
  { texte: 'Constitution de la RDC, art. 204', objet: 'Compétences exclusives des provinces, dont les impôts cédés (point 16)', usage: 'Fondement constitutionnel des quatre impôts provinciaux', instrumentIds: ['const-2006-art204'] },
  { texte: 'Ordonnance-loi n° 18/004 du 13 mars 2018', objet: 'Nomenclature des impôts, droits, taxes et redevances de la province et de l’ETD, modalités de répartition', usage: 'Base normative du référentiel MOSOLO ; abroge l’Ordonnance-loi n° 13/001 du 23 février 2013', instrumentIds: ['ol-18-004'] },
  { texte: 'Ordonnance-loi n° 13/001 du 23 février 2013', objet: 'Ancienne nomenclature (abrogée par l’OL 18/004)', usage: 'ABROGÉE : liste noire, jamais citée comme texte en vigueur', instrumentIds: ['ol-13-001'] },
  { texte: 'Ordonnance-loi n° 18/003 du 13 mars 2018', objet: 'Nomenclature des droits, taxes et redevances du pouvoir central', usage: 'Exclure du périmètre provincial les recettes centrales et éviter les doublons', instrumentIds: ['ol-18-003'] },
  { texte: 'Ordonnance-loi n° 69/006 du 10 février 1969', objet: 'Impôts réels (foncier, véhicules, superficie des concessions)', usage: 'Base historique de l’IF et de l’impôt sur les véhicules ; vérifier les modifications successives', instrumentIds: ['ol-69-006'] },
  { texte: 'Ordonnance-loi n° 69/009 du 10 février 1969', objet: 'Impôts cédulaires sur les revenus', usage: 'Base historique de l’IRL ; vérifier les modifications successives', instrumentIds: ['ol-69-009'] },
  { texte: 'Loi n° 11/011 du 13 juillet 2011 (LOFIP)', objet: 'Finances publiques : budget, comptabilité, trésorerie, contrôle', usage: 'Encadre le circuit des fonds, l’exécution budgétaire et la comptabilisation', instrumentIds: ['loi-11-011-lofip'] },
  { texte: 'Édits budgétaires annuels de la Ville de Kinshasa', objet: 'Taux, innovations et règles de perception provinciales', usage: 'Source des taux applicables et des extensions d’assiette', instrumentIds: ['edit-budgetaire-kinshasa'] },
  { texte: 'Arrêtés du ministre provincial des Finances', objet: 'Fixation des taux IF et IRL, modalités de perception', usage: 'Source directe des barèmes intégrés au référentiel', instrumentIds: ['arrete-taux-irl-2026', 'arrete-taux-if-2026'] },
  { texte: 'Ordonnance-loi n° 23/010 du 13 mars 2023 (Code du numérique)', objet: 'Numérique, données personnelles, transactions électroniques', usage: 'Cadre de protection des données et de la signature électronique, à confirmer dans son détail', instrumentIds: ['ol-23-010'] },
  { texte: 'Loi n° 18/014 du 9 juillet 2018', objet: 'Objet à établir au Journal officiel (référence non confirmée en l’état)', usage: 'Précision KIN RECETTES : porterait ratification de l’OL 18/004 et confirmerait l’abrogation du texte de 2013 — à confirmer par le relevé certifié', instrumentIds: ['loi-18-014'] },
];

/**
 * Instruments complémentaires (ajoutés s'ils manquent ; jamais de remplacement d'un instrument existant). Aucun n'est
 * certifié : statut A_VERIFIER tant que le service juridique provincial n'a pas produit le relevé certifié.
 */
export const INSTRUMENTS_COMPLEMENTAIRES: LegalInstrument[] = [
  { id: 'ol-18-003', title: 'Ordonnance-loi n° 18/003 du 13 mars 2018 (nomenclature du pouvoir central) [statut À VÉRIFIER]', status: 'A_VERIFIER', note: 'Sert à exclure les recettes centrales du périmètre provincial (catégorie RECETTE_CENTRALE).' },
  { id: 'loi-11-011-lofip', title: 'Loi n° 11/011 du 13 juillet 2011 relative aux finances publiques (LOFIP) [statut À VÉRIFIER]', status: 'A_VERIFIER', note: 'Circuit des fonds, exécution budgétaire, comptabilisation.' },
  { id: 'edit-budgetaire-kinshasa', title: 'Édit budgétaire annuel de la Ville de Kinshasa (exercice en cours) [texte intégral À VÉRIFIER]', status: 'A_VERIFIER', note: 'Annexe B, point 4 ; point juridique J3.' },
  { id: 'ol-23-010', title: 'Ordonnance-loi n° 23/010 du 13 mars 2023 portant Code du numérique [dispositions À VÉRIFIER]', status: 'A_VERIFIER', note: 'Résidence des données, signature électronique, données personnelles (J7, J8).' },
  {
    id: 'loi-18-014', title: 'Loi n° 18/014 du 9 juillet 2018 [objet À VÉRIFIER au Journal officiel]', status: 'A_VERIFIER',
    note: 'Précision de la spécification KIN RECETTES (Journal officiel via Leganet) : porterait ratification de l’OL 18/004 et confirmerait l’abrogation de l’OL 13/001 — lève en partie la réserve ; à confirmer par le relevé juridique certifié (J2).',
  },
];

export interface CompletudeLigne extends TexteReference {
  instruments: { id: string; present: boolean; status: LegalInstrumentStatus | null; title: string | null }[];
  complet: boolean;
  statut: LegalInstrumentStatus | 'ABSENT' | 'MIXTE';
}

/** Rapprochement du tableau § 6.1 avec le registre. */
export function completude(get: (id: string) => LegalInstrument | undefined): { lignes: CompletudeLigne[]; complet: boolean; absents: string[] } {
  const lignes = TEXTES_REFERENCE_6_1.map((t) => {
    const instruments = t.instrumentIds.map((id) => {
      const i = get(id);
      return { id, present: !!i, status: i?.status ?? null, title: i?.title ?? null };
    });
    const statuses = new Set(instruments.map((i) => i.status ?? 'ABSENT'));
    return {
      ...t, instruments, complet: instruments.every((i) => i.present),
      statut: (statuses.size === 1 ? [...statuses][0]! : 'MIXTE') as CompletudeLigne['statut'],
    };
  });
  const absents = lignes.flatMap((l) => l.instruments.filter((i) => !i.present).map((i) => i.id));
  return { lignes, complet: absents.length === 0, absents };
}
