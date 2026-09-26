/**
 * Données d'EXEMPLE du tableau de bord du Gouverneur (§ 26.2) — valeurs illustratives, non opposables.
 * Tous les montants en 🇨🇩 CDF (devise de consolidation), en chaînes décimales exactes.
 */
import { Money, REVENUE_LADDER, type MoneyJSON, type RevenueLadderLevel } from '@mosolo/shared';
import { COMMUNES, type Commune } from '../../reference/kinshasa.js';

const cdf = (units: bigint): MoneyJSON => Money.fromMinor(units * 100n, 'CDF').toJSON();
const MILLION = 1_000_000n;

/** Poids économique relatif et taux de conformité (EXEMPLE) par commune. */
const COMMUNE_PROFILE: Record<Commune, { weight: bigint; compliance: string; census: string; rental: string }> = {
  Bandalungwa: { weight: 17n, compliance: '58.2', census: '71.0', rental: '44.5' },
  Barumbu: { weight: 15n, compliance: '52.7', census: '66.4', rental: '39.8' },
  Bumbu: { weight: 9n, compliance: '41.3', census: '52.1', rental: '28.7' },
  Gombe: { weight: 100n, compliance: '82.6', census: '93.5', rental: '78.2' },
  Kalamu: { weight: 25n, compliance: '31.4', census: '61.8', rental: '26.9' },
  'Kasa-Vubu': { weight: 16n, compliance: '55.9', census: '69.3', rental: '42.2' },
  Kimbanseke: { weight: 15n, compliance: '34.8', census: '41.7', rental: '21.4' },
  Kinshasa: { weight: 20n, compliance: '61.5', census: '74.8', rental: '47.9' },
  Kintambo: { weight: 18n, compliance: '63.1', census: '76.2', rental: '51.3' },
  Kisenso: { weight: 6n, compliance: '36.2', census: '44.9', rental: '19.8' },
  Lemba: { weight: 22n, compliance: '57.4', census: '70.6', rental: '46.1' },
  Limete: { weight: 55n, compliance: '71.8', census: '84.2', rental: '58.6' },
  Lingwala: { weight: 14n, compliance: '59.6', census: '72.3', rental: '45.0' },
  Makala: { weight: 9n, compliance: '39.9', census: '50.6', rental: '25.2' },
  Maluku: { weight: 7n, compliance: '33.1', census: '38.4', rental: '14.6' },
  Masina: { weight: 18n, compliance: '42.7', census: '55.2', rental: '31.9' },
  Matete: { weight: 14n, compliance: '47.8', census: '60.1', rental: '34.4' },
  'Mont-Ngafula': { weight: 20n, compliance: '49.3', census: '57.8', rental: '37.5' },
  Ndjili: { weight: 16n, compliance: '44.6', census: '58.9', rental: '33.1' },
  Ngaba: { weight: 8n, compliance: '45.2', census: '59.4', rental: '30.7' },
  Ngaliema: { weight: 60n, compliance: '68.9', census: '80.7', rental: '55.8' },
  'Ngiri-Ngiri': { weight: 8n, compliance: '50.1', census: '63.5', rental: '35.9' },
  Nsele: { weight: 12n, compliance: '37.6', census: '46.3', rental: '22.8' },
  Selembao: { weight: 10n, compliance: '38.4', census: '49.2', rental: '24.3' },
};

function colorFor(compliance: string): 'green' | 'amber' | 'red' {
  const pct = Number.parseInt(compliance, 10);
  return pct >= 65 ? 'green' : pct >= 45 ? 'amber' : 'red';
}

export function communeBreakdown() {
  return COMMUNES.map((commune) => {
    const p = COMMUNE_PROFILE[commune];
    const collected = p.weight * 42n * MILLION;
    // Cible = collecté × 100 / (conformité arrondie) — entiers uniquement.
    const pct = BigInt(Number.parseInt(p.compliance, 10));
    const target = (collected * 100n) / (pct === 0n ? 1n : pct);
    return {
      commune,
      collected: cdf(collected),
      target: cdf(target),
      complianceRate: p.compliance,
      censusCoverage: p.census,
      rentalCoverage: p.rental,
      color: colorFor(p.compliance),
    };
  });
}

export const LADDER_EXAMPLE: Record<RevenueLadderLevel, bigint> = {
  potential: 420_000n * MILLION,
  verified_base: 262_000n * MILLION,
  assessed: 191_500n * MILLION,
  due: 151_200n * MILLION,
  overdue: 38_400n * MILLION,
  disputed: 6_150n * MILLION,
  initiated: 4_480n * MILLION,
  confirmed: 112_300n * MILLION,
  settled: 108_050n * MILLION,
  reconciled: 103_700n * MILLION,
  available: 98_200n * MILLION,
};

export function ladder() {
  return REVENUE_LADDER.map((level, i) => ({ rank: i + 1, level, amount: cdf(LADDER_EXAMPLE[level]) }));
}

export function categories() {
  const rows: [string, string, bigint, bigint][] = [
    ['IF', 'Impôt foncier', 31_400n, 52_000n],
    ['IRL', 'Impôt sur les revenus locatifs', 22_800n, 47_500n],
    ['VEH', 'Impôt sur les véhicules et TSCR', 18_900n, 24_000n],
    ['TIC', "Taxes d'intérêt commun", 14_200n, 19_800n],
    ['DADM', 'Droits administratifs et redevances de service', 12_600n, 15_200n],
    ['DOM', 'Concessions domaniales et occupation du domaine public', 7_300n, 11_900n],
    ['PEN', 'Pénalités et intérêts de retard', 2_150n, 3_400n],
    ['AUT', 'Autres recettes provinciales', 2_950n, 4_100n],
  ];
  return rows.map(([code, label, collected, target]) => ({ code, label, collected: cdf(collected * MILLION), target: cdf(target * MILLION) }));
}

export function trend() {
  const months = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
  const collected = [7_900n, 8_150n, 9_800n, 8_400n, 12_600n, 10_100n, 9_300n, 9_050n, 9_700n, 9_950n, 10_200n, 10_450n];
  const target = [9_000n, 9_000n, 10_500n, 9_500n, 13_000n, 11_000n, 10_000n, 10_000n, 10_500n, 10_500n, 11_000n, 11_000n];
  return months.map((month, i) => ({ month, collected: cdf(collected[i]! * MILLION), target: cdf(target[i]! * MILLION) }));
}

export function scenarios() {
  return [
    { code: 'conservateur', label: 'Conservateur', yearEnd: cdf(128_000n * MILLION), assumptions: ['Rythme actuel maintenu', 'Aucune campagne de régularisation', 'Taux de rapprochement stable (96 %)'] },
    { code: 'attendu', label: 'Attendu', yearEnd: cdf(141_500n * MILLION), assumptions: ['Campagne de régularisation dans 3 communes', 'Recensement locatif à Limete et Ngaliema', 'Délai moyen de règlement réduit à J+1'] },
    { code: 'ambitieux', label: 'Ambitieux', yearEnd: cdf(158_000n * MILLION), assumptions: ['Couverture du recensement > 80 % dans 12 communes', 'Paiement diaspora par carte ouvert', 'Taux de conformité +10 points à Kalamu et Kimbanseke'] },
  ];
}

export function exampleAlerts() {
  return [
    { id: 'EX-ALR-1', severity: 'CRITICAL', title: "Pic d'annulations d'avis à Ndjili", detail: '+240 % sur 7 jours par rapport à la moyenne — revue audit recommandée.', example: true },
    { id: 'EX-ALR-2', severity: 'HIGH', title: 'Règlement manquant à J+2', detail: "Confirmations d'un prestataire de monnaie mobile sans crédit constaté (exemple).", example: true },
    { id: 'EX-ALR-3', severity: 'HIGH', title: 'Baisse inexpliquée des recettes à Kalamu', detail: '−18 % sur le trimestre, alors que la base vérifiée est stable.', example: true },
  ];
}

export function tiles() {
  return {
    confirmedToday: cdf(412n * MILLION),
    settledToday: cdf(389n * MILLION),
    reconciledToday: cdf(371n * MILLION),
    reconRateJ1: '96.4',
    comparisonDMinus1: '+3.2',
  };
}
