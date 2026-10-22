/**
 * Les 24 communes de Kinshasa (même liste que backend/src/reference/kinshasa.ts et modules/pilotage/shared.ts) et leur
 * disposition schématique ouest → est sur une grille de 8 colonnes × 5 rangées (carte de chaleur, pas une carte
 * géographique : les surfaces ne sont pas à l'échelle).
 */
export const COMMUNES_KINSHASA = [
  'Bandalungwa', 'Barumbu', 'Bumbu', 'Gombe', 'Kalamu', 'Kasa-Vubu', 'Kimbanseke', 'Kinshasa', 'Kintambo', 'Kisenso', 'Lemba', 'Limete',
  'Lingwala', 'Makala', 'Maluku', 'Masina', 'Matete', 'Mont-Ngafula', 'Ndjili', 'Ngaba', 'Ngaliema', 'Ngiri-Ngiri', 'Nsele', 'Selembao',
] as const;

/** Position [colonne, rangée] (1-indexées) de chaque commune. */
export const COMMUNE_LAYOUT: Record<string, [number, number]> = {
  Ngaliema: [1, 2], Kintambo: [2, 1], Gombe: [3, 1], Lingwala: [3, 2], Barumbu: [4, 1], Kinshasa: [4, 2],
  Bandalungwa: [2, 3], 'Kasa-Vubu': [3, 3], Kalamu: [4, 3], Limete: [5, 2], Masina: [6, 2], Nsele: [7, 2],
  Maluku: [8, 1], Matete: [5, 3], Ndjili: [6, 3], Kimbanseke: [7, 3], Selembao: [2, 4], 'Ngiri-Ngiri': [3, 4],
  Makala: [4, 4], Lemba: [5, 4], Kisenso: [6, 4], 'Mont-Ngafula': [2, 5], Bumbu: [3, 5], Ngaba: [5, 5],
};

/** Abréviation à trois lettres (vignette) — désambiguïsée pour Kinshasa / Kintambo / Kimbanseke et Ngaba / Ngaliema. */
export const COMMUNE_ABBR: Record<string, string> = {
  Bandalungwa: 'Ban', Barumbu: 'Bar', Bumbu: 'Bum', Gombe: 'Gom', Kalamu: 'Kal', 'Kasa-Vubu': 'KaV', Kimbanseke: 'Kim', Kinshasa: 'Kin',
  Kintambo: 'Kit', Kisenso: 'Kis', Lemba: 'Lem', Limete: 'Lim', Lingwala: 'Lin', Makala: 'Mak', Maluku: 'Mal', Masina: 'Mas',
  Matete: 'Mat', 'Mont-Ngafula': 'MtN', Ndjili: 'Ndj', Ngaba: 'Ngb', Ngaliema: 'Ngl', 'Ngiri-Ngiri': 'NgN', Nsele: 'Nse', Selembao: 'Sel',
};
