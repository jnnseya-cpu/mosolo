/**
 * Données de démonstration du centre de commandement — EXEMPLE, valeurs illustratives,
 * non opposables. Utilisées uniquement si l'API est injoignable (démo PWA hors ligne).
 * Reprend la maquette du § 26.2 (fig-tableau-de-bord-gouverneur).
 */
import type { AIRecommendation } from '@mosolo/shared';

const md = (n: number) => ({ amount: (n * 1e9).toFixed(2), currency: 'CDF' as const });

/** Disposition approximative des 24 communes (ouest → est, nord → sud) pour la grille cartographique. */
export const COMMUNE_GRID: Record<string, [number, number]> = {
  Ngaliema: [1, 2], Kintambo: [2, 1], Gombe: [3, 1], Lingwala: [3, 2], Barumbu: [4, 1], Kinshasa: [4, 2],
  Bandalungwa: [2, 3], 'Kasa-Vubu': [3, 3], Kalamu: [4, 3], Limete: [5, 2], Masina: [6, 2], Nsele: [7, 2],
  Maluku: [8, 1], Matete: [5, 3], Ndjili: [6, 3], Kimbanseke: [7, 3], Selembao: [2, 4], 'Ngiri-Ngiri': [3, 4],
  Makala: [4, 4], Lemba: [5, 4], Kisenso: [6, 4], 'Mont-Ngafula': [2, 5], Bumbu: [3, 5], Ngaba: [5, 5],
};

const COMMUNES: [string, number, number][] = [
  ['Gombe', 1.42, 91], ['Limete', 0.98, 78], ['Ngaliema', 0.87, 72], ['Kalamu', 0.55, 41], ['Lemba', 0.41, 58],
  ['Masina', 0.33, 44], ['Kintambo', 0.25, 63], ['Bandalungwa', 0.21, 55], ['Kasa-Vubu', 0.19, 52], ['Barumbu', 0.17, 49],
  ['Lingwala', 0.16, 57], ['Kinshasa', 0.15, 47], ['Matete', 0.14, 39], ['Ndjili', 0.13, 36], ['Ngiri-Ngiri', 0.11, 42],
  ['Makala', 0.09, 31], ['Ngaba', 0.09, 34], ['Selembao', 0.08, 27], ['Bumbu', 0.07, 25], ['Kisenso', 0.06, 22],
  ['Kimbanseke', 0.06, 18], ['Mont-Ngafula', 0.05, 29], ['Nsele', 0.04, 21], ['Maluku', 0.02, 12],
];

export const DEMO_ACTIONS: AIRecommendation[] = [
  {
    id: 'demo-rec-kalamu', agent: 'Agent de pilotage', modelVersion: 'demo-0.1', autonomy: 'C_RECOMMANDATION',
    createdAt: '2027-02-10T09:15:00+01:00', status: 'EMISE',
    situation: 'Kalamu est à 41 % de sa cible de campagne ; le retard est concentré sur l’IRL.',
    insight: '62 % des unités recensées n’ont pas de bail déclaré ; les paiements IF sont dans la moyenne.',
    risk: 'Environ 🇨🇩 CDF 0,9 Md non mobilisé d’ici l’échéance du 28 février.',
    recommendation: 'Autoriser une campagne SMS ciblée sur les bailleurs recensés et deux guichets mobiles à Matonge.',
    nextAction: 'Soumettre la campagne au DG de la DGIPK pour validation.',
    owner: 'DG DGIPK', deadline: '12 février 2027', confidence: 'MEDIUM',
    sources: ['Registre des objets (recensement R0)', 'Journal des paiements J−10', 'Catalogue des événements — rappel_irl'],
    decision: {
      bestOption: 'Campagne SMS ciblée + 2 guichets mobiles (10 jours).',
      alternativeOption: 'Mission de contrôle terrain sur 200 unités à plus fort écart.',
      riskOfInaction: 'Retard IRL consolidé ; perte d’environ 0,9 Md CDF sur la campagne.',
      financialImpact: 'Mobilisation estimée : 0,4 à 0,6 Md CDF (confiance moyenne).',
      operationalImpact: '4 agents de guichet mobilisés 10 jours ; aucun encaissement en espèces.',
    },
  },
];

/** Réponse brute de démonstration (même forme que GET /v1/dashboards/governor), passée au normaliseur. */
export const DEMO_GOVERNOR_RAW = {
  example: true,
  asOf: '2027-02-10T09:15:00+01:00',
  tiles: {
    confirmedToday: md(4.82), settledToday: md(4.31), reconciledToday: md(4.12), reconRateJ1: '97.4', comparisonDMinus1: '+12 %',
    criticalAlerts: 3,
  },
  communes: COMMUNES.map(([commune, v, compliance]) => ({ commune, collected: md(v), complianceRate: String(compliance) })),
  categories: [
    { label: 'Impôt foncier', collected: md(1.83) }, { label: 'Impôt sur les revenus locatifs', collected: md(1.49) },
    { label: 'Vignette et taxes véhicules', collected: md(0.87) }, { label: 'Taxes et droits administratifs', collected: md(0.63) },
  ],
  ladder: ([
    ['potential', 820], ['verified_base', 410], ['assessed', 300], ['due', 240], ['overdue', 90],
    ['initiated', 4.5], ['confirmed', 148], ['settled', 140], ['reconciled', 136], ['recorded', 133], ['available', 120],
  ] as [string, number][]).map(([level, v]) => ({ level, amount: md(v) })),
  trend: ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02'].map((month, i) => ({
    month, collected: md([7.9, 8.15, 9.8, 8.4, 9.1, 10.1, 9.3, 9.05, 9.7, 11.95, 12.2, 13.45][i]!), target: md([9, 9, 10.5, 9.5, 10, 11, 10, 10, 10.5, 11.5, 11, 11][i]!),
  })),
  scenarios: [
    { code: 'conservateur', label: 'Prudent (conservateur) [EXEMPLE]', yearEnd: md(128) },
    { code: 'attendu', label: 'Attendu [EXEMPLE]', yearEnd: md(141.5) },
    { code: 'ambitieux', label: 'Transformationnel (ambitieux) [EXEMPLE]', yearEnd: md(158) },
  ],
  alerts: [
    { id: 'a1', severity: 'CRITICAL', title: 'Compte bénéficiaire : changement proposé', detail: 'KIN-DGIPK-RECETTES-01 · 1 approbation sur 2 · délai de 72 h en cours', age: '2 h' },
    { id: 'a2', severity: 'HIGH', title: 'Pic d’annulations — quartier Matonge (Kalamu)', detail: '14 annulations en 24 h contre 2 en moyenne', age: '5 h' },
    { id: 'a3', severity: 'MEDIUM', title: 'Règlement opérateur B en retard de 26 h', detail: 'Relevé attendu à J+1 09:00 ; 312 paiements confirmés non réglés', age: '26 h' },
  ],
  actions: DEMO_ACTIONS,
  exchange: { rate: '2850.00', date: '2027-02-10', source: 'EXEMPLE — cours indicatif BCC' },
};
