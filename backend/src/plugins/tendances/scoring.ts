/**
 * Veille des tendances (Trend Intelligence) — calculs déterministes de la spécification v2.3 (§ 5 et § 17).
 * Fonctions pures : aucune donnée, aucune horloge, aucun modèle. Les seuils sont des paramètres de l'installation
 * (par défaut — à confirmer par le maître d'ouvrage), jamais codés en dur dans les appels.
 */

export const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Écart absolu médian. */
export const mad = (xs: number[]): number => { const m = median(xs); return median(xs.map((x) => Math.abs(x - m))); };

export const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));

/** Hausse logarithmique : ln((c+1)/(b+1)), b = médiane de la base. */
export const lift = (c: number, base: number[]) => Math.log((c + 1) / (median(base) + 1));

/** Score d'anomalie robuste : (log1p(c) − médiane(log1p(x))) / max(1,4826 × MAD(log1p(x)), 0,2). */
export function robustZ(c: number, history: number[]): number {
  const lx = history.map((x) => Math.log1p(x));
  return (Math.log1p(c) - median(lx)) / Math.max(1.4826 * mad(lx), 0.2);
}

export interface SeuilsFlux { volumeMin: number; zMin: number; periodesMin: number }

/** Mouvement d'un flux de comptage (une famille de sources) : portes de volume, d'historique et d'anomalie. */
export function mouvement(c: number, history: number[], s: SeuilsFlux) {
  const historiqueSuffisant = history.length >= s.periodesMin;
  const z = history.length ? robustZ(c, history) : 0;
  return {
    courant: c,
    baseMediane: median(history),
    lift: lift(c, history),
    z,
    historiqueSuffisant,
    porteFranchie: historiqueSuffisant && c >= s.volumeMin && z >= s.zMin,
    // Correspondance de référence pour un flux de comptage (§ 17) : clamp(50 + 10 × z, 0, 100).
    scoreDemande: clamp(50 + 10 * z),
  };
}

export interface Composantes { demande: number; adequation: number; intention: number; moment: number; preparation: number }
/** Score d'opportunité 0–100 : 25 % demande, 25 % adéquation, 20 % intention commerciale, 15 % moment, 15 % préparation. */
export const scoreOpportunite = (c: Composantes) => 0.25 * c.demande + 0.25 * c.adequation + 0.2 * c.intention + 0.15 * c.moment + 0.15 * c.preparation;

export interface ComposantesConfiance { qualite: number; corroboration: number; couverture: number; fraicheur: number }
/** Confiance 0–100 : 35 % qualité, 25 % corroboration indépendante, 20 % couverture, 20 % fraîcheur ; une seule famille ⇒ plafond. */
export function confiance(c: ComposantesConfiance, familles: number, plafondUneFamille = 69): number {
  const v = 0.35 * c.qualite + 0.25 * c.corroboration + 0.2 * c.couverture + 0.2 * c.fraicheur;
  return familles <= 1 ? Math.min(v, plafondUneFamille) : v;
}

/** Corroboration (§ 17) : 0 pour une famille indépendante, 80 pour deux, 100 pour trois et plus. */
export const corroboration = (familles: number) => (familles >= 3 ? 100 : familles === 2 ? 80 : 0);

/** Fraîcheur : 100 à la clôture de la fenêtre, puis décroissance linéaire jusqu'à 0 à la limite de péremption. */
export const fraicheur = (heuresDepuisCloture: number, peremptionHeures: number) =>
  clamp(100 * (1 - Math.max(0, heuresDepuisCloture) / Math.max(1, peremptionHeures)));

export type Decision = 'ARCHIVER' | 'SURVEILLER' | 'BRIEF' | 'AUTOMATIQUE_ELIGIBLE';
export interface SeuilsDecision { archiveScore: number; archiveConfiance: number; brief: number; automatique: number }

/** Table de décision (§ 5). Pleine précision : aucun arrondi avant la décision (TI-03). */
export function decider(score: number, conf: number, vetos: string[], s: SeuilsDecision, optInAutomatique = false): Decision {
  if (score < s.archiveScore || conf < s.archiveConfiance) return 'ARCHIVER';
  if (vetos.length) return 'SURVEILLER';
  if (score >= s.automatique && conf >= s.automatique && optInAutomatique) return 'AUTOMATIQUE_ELIGIBLE';
  if (score >= s.brief && conf >= s.brief) return 'BRIEF';
  return 'SURVEILLER';
}

/** Canonicalisation lexicale : minuscules, sans accents ni ponctuation, espaces réduits (le texte d'origine est conservé ailleurs). */
export const canonique = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
