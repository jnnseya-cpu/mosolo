/**
 * Planification et pilotage stratégique — modèle (pur) :
 *  - base de référence auditée (§ 38.1) et relevés de coûts, par recette, commune, canal et période ;
 *  - composantes de la RANV (§ 38.2) ;
 *  - pilote de 180 jours (§ 45.1, § 45.3, § 45.5) : communes pilotes, critères, jalons de revue ;
 *  - scénarios prudent / attendu / transformationnel (§ 38.4) et variables de sensibilité ;
 *  - assignations budgétaires (§ 26.1), instructions (§ 26.1–26.2), accords de service entre entités (§ 10A.3) ;
 *  - projets publics et scénarios d'emploi des fonds (§ 27.2–27.3).
 * Aucune valeur chiffrée n'est présumée : toute hypothèse est saisie, datée et sourcée par une personne.
 */
import { CURRENCIES, Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import { badRequest } from '../../../core/errors.js';
import { PAYMENT_CHANNELS } from '../../../modules/payments/service.js';
import { COMMUNES } from '../../../reference/kinshasa.js';

// ————————————————————————— base de référence (§ 38.1) —————————————————————————

export type MetricUnit = 'NOMBRE' | 'MONTANT' | 'HEURES' | 'JOURS';
/** Rubriques de la base de référence : liste exacte du § 38.1. */
export const BASELINE_METRICS: Record<string, { label: string; unit: MetricUnit }> = {
  CONTRIBUABLES_ENREGISTRES: { label: 'Contribuables enregistrés', unit: 'NOMBRE' },
  OBJETS_CONNUS: { label: 'Objets imposables connus', unit: 'NOMBRE' },
  LIQUIDATIONS: { label: 'Liquidations annuelles', unit: 'MONTANT' },
  ENCAISSEMENTS: { label: 'Encaissements réels', unit: 'MONTANT' },
  DELAI_REGLEMENT: { label: 'Délais de règlement', unit: 'HEURES' },
  NON_RAPPROCHES: { label: 'Paiements non rapprochés', unit: 'MONTANT' },
  ARRIERES: { label: 'Arriérés', unit: 'MONTANT' },
  EXONERATIONS: { label: 'Exonérations', unit: 'MONTANT' },
  ANNULATIONS: { label: 'Annulations', unit: 'MONTANT' },
  COUT_RECOUVREMENT: { label: 'Coût de recouvrement', unit: 'MONTANT' },
  COUT_COLLECTE: { label: 'Coût de collecte', unit: 'MONTANT' },
  PERTES_FRAUDE: { label: 'Pertes estimées par fraude', unit: 'MONTANT' },
  DELAI_TRAITEMENT: { label: 'Temps de traitement administratif', unit: 'JOURS' },
};
export const BASELINE_METRIC_CODES = Object.keys(BASELINE_METRICS);

/** Nature du jeu importé : base de référence (avant démarrage) ou relevé des coûts constatés d'une période. */
export const SET_KINDS = ['BASE_REFERENCE', 'COUTS_CONSTATES'] as const;
export type SetKind = (typeof SET_KINDS)[number];
export const SET_KIND_LABELS: Record<SetKind, string> = { BASE_REFERENCE: 'Base de référence auditée (§ 38.1)', COUTS_CONSTATES: 'Relevé des coûts constatés' };

export type CertStatus = 'IMPORTEE' | 'CERTIFIEE' | 'REJETEE' | 'REMPLACEE';
export const CERT_STATUS_LABELS: Record<CertStatus, string> = {
  IMPORTEE: 'Importée — certification par une seconde personne attendue', CERTIFIEE: 'Certifiée (deux personnes)', REJETEE: 'Rejetée', REMPLACEE: 'Remplacée par une version certifiée plus récente',
};

export interface BaselineEntry {
  metric: string;
  /** Catégorie de recette ou « * » (toutes). */
  revenue: string;
  /** Commune ou « * » (toutes). */
  commune: string;
  /** Canal de paiement ou « * » (tous). */
  channel: string;
  /** Valeur décimale en chaîne (jamais de flottant). */
  value: string;
  /** Devise légale, pour les montants seulement. */
  currency?: CurrencyCode;
}

export interface Decision { by: string; at: string; approve: boolean; motif: string }

export interface BaselineSet {
  id: string;
  kind: SetKind;
  label: string;
  period: string;
  from: string;
  to: string;
  source: { document: string; reference: string; sha256?: string };
  entries: BaselineEntry[];
  status: CertStatus;
  importedBy: string;
  importedAt: string;
  decision?: Decision;
  supersededBy?: string;
  /** Jeu de démonstration (valeurs fictives, non opposables). */
  example?: boolean;
}

const DEC = /^\d{1,15}(\.\d{1,6})?$/;
const CODE = /^[A-Z_]{2,40}$/;

/** Contrôle d'une ligne importée : rubrique connue, dimensions valides, valeur décimale positive, devise des montants. */
export function validateEntry(e: BaselineEntry, i: number): BaselineEntry {
  const where = `ligne ${i + 1}`;
  const m = BASELINE_METRICS[e.metric];
  if (!m) throw badRequest('UNKNOWN_METRIC', `${where} : rubrique inconnue ${e.metric} (§ 38.1 : ${BASELINE_METRIC_CODES.join(', ')}).`);
  if (e.commune !== '*' && !(COMMUNES as readonly string[]).includes(e.commune)) throw badRequest('UNKNOWN_COMMUNE', `${where} : commune inconnue ${e.commune}.`);
  if (e.channel !== '*' && !(PAYMENT_CHANNELS as readonly string[]).includes(e.channel)) throw badRequest('UNKNOWN_CHANNEL', `${where} : canal inconnu ${e.channel}.`);
  if (e.revenue !== '*' && !CODE.test(e.revenue)) throw badRequest('INVALID_REVENUE', `${where} : code de recette attendu (ou « * »).`);
  if (!DEC.test(e.value)) throw badRequest('INVALID_VALUE', `${where} : valeur décimale positive attendue.`);
  if (m.unit === 'MONTANT') {
    if (!e.currency || !(e.currency in CURRENCIES) || !CURRENCIES[e.currency].assessable) throw badRequest('CURRENCY_REQUIRED', `${where} : devise légale requise pour un montant.`);
  } else if (e.currency) throw badRequest('CURRENCY_FORBIDDEN', `${where} : pas de devise pour une rubrique en ${m.unit.toLowerCase()}.`);
  return { metric: e.metric, revenue: e.revenue, commune: e.commune, channel: e.channel, value: e.value, ...(e.currency ? { currency: e.currency } : {}) };
}

/** Import CSV (séparateur « ; ») : metrique;recette;commune;canal;valeur;devise. */
export function parseEntriesCsv(text: string): BaselineEntry[] {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (lines.length === 0) throw badRequest('EMPTY_IMPORT', 'Fichier vide.');
  const head = lines[0]!.toLowerCase().split(';').map((x) => x.trim());
  const expected = ['metrique', 'recette', 'commune', 'canal', 'valeur', 'devise'];
  if (expected.some((c, i) => head[i] !== c)) throw badRequest('INVALID_HEADER', `En-tête attendu : ${expected.join(';')}`);
  return lines.slice(1).map((l) => {
    const [metric = '', revenue = '*', commune = '*', channel = '*', value = '', currency = ''] = l.split(';').map((x) => x.trim());
    return { metric: metric.toUpperCase(), revenue: revenue || '*', commune: commune || '*', channel: channel || '*', value: value.replace(',', '.'), ...(currency ? { currency: currency.toUpperCase() as CurrencyCode } : {}) };
  });
}

export interface Dims { commune?: string; communes?: string[]; revenue?: string; channel?: string }

/**
 * Sélection des lignes d'une rubrique pour un périmètre : pour chaque dimension, la valeur demandée si elle est
 * précisée ; sinon la ligne « * » si elle existe, à défaut la somme des lignes détaillées. Jamais d'extrapolation.
 */
export function selectEntries(entries: BaselineEntry[], metric: string, d: Dims): BaselineEntry[] {
  let xs = entries.filter((e) => e.metric === metric);
  const dim = (key: 'commune' | 'revenue' | 'channel', v: string | undefined, many?: string[]) => {
    if (v) { xs = xs.filter((e) => e[key] === v); return; }
    if (many) { xs = xs.filter((e) => many.includes(e[key])); return; }
    if (xs.some((e) => e[key] === '*')) xs = xs.filter((e) => e[key] === '*');
  };
  dim('commune', d.commune, d.communes);
  dim('revenue', d.revenue);
  dim('channel', d.channel);
  return xs;
}

/** Montants d'une rubrique par devise (unités mineures), après sélection. */
export function amountsOf(entries: BaselineEntry[], metric: string, d: Dims): Map<CurrencyCode, bigint> {
  const out = new Map<CurrencyCode, bigint>();
  for (const e of selectEntries(entries, metric, d)) {
    if (!e.currency) continue;
    out.set(e.currency, (out.get(e.currency) ?? 0n) + Money.of(e.value, e.currency).minor);
  }
  return out;
}

export const dayCount = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Prorata entier (arithmétique BigInt) : montant × jours comparés / jours de la base. */
export function prorate(minor: bigint, daysCompared: number, daysBase: number): bigint {
  if (daysBase <= 0) return 0n;
  return (minor * BigInt(daysCompared)) / BigInt(daysBase);
}

// ————————————————————————— RANV (§ 38.2) —————————————————————————

export const RANV_COMPONENTS = [
  { code: 'ASSIETTE_SUPPLEMENTAIRE', label: 'Assiette vérifiée supplémentaire', sign: 1, method: 'Recettes rapprochées sur des objets recensés après la base de référence (origine « recette nouvelle »).' },
  { code: 'GAINS_CONFORMITE', label: 'Gains de conformité', sign: 1, method: 'Recettes courantes rapprochées des objets déjà connus − encaissements de la base ramenés à la même durée.' },
  { code: 'ARRIERES_RECOUVRES', label: 'Arriérés recouvrés', sign: 1, method: 'Recettes rapprochées payées après l’échéance (origine « régularisation d’arriérés »).' },
  { code: 'DEPERDITION_EVITEE', label: 'Déperdition évitée', sign: 1, method: 'Non mesurée : aucune estimation n’est substituée à une mesure.' },
  { code: 'GAINS_RAPPROCHEMENT', label: 'Gains de rapprochement', sign: 1, method: 'Paiements restés sans appariement plus de 48 h puis rapprochés dans la période.' },
  { code: 'COUTS_ADDITIONNELS', label: 'Coûts additionnels', sign: -1, method: 'Coûts de collecte et de recouvrement du relevé certifié − coûts de la base ramenés à la même durée.' },
  { code: 'REMBOURSEMENTS', label: 'Remboursements', sign: -1, method: 'Paiements remboursés confirmés dans la période.' },
  { code: 'CORRECTIONS', label: 'Corrections', sign: -1, method: 'Dégrèvements et rectifications de la période (réclamation, correction de déclaration, recalcul, autre rectification).' },
] as const;
export type RanvComponent = (typeof RANV_COMPONENTS)[number]['code'];

// ————————————————————————— pilote de 180 jours (§ 45) —————————————————————————

/** Communes pilotes proposées (§ 45.1). */
export const PILOT_COMMUNES = ['Gombe', 'Limete', 'Kalamu', 'Ngaliema'] as const;
/** Jalons de revue : J30, J60, J90, J120 et J180 (§ 45.5) ; J150 ajouté comme point intermédiaire (même méthode). */
export const PILOT_MILESTONES = { J30: 30, J60: 60, J90: 90, J120: 120, J150: 150, J180: 180 } as const;
export type Milestone = keyof typeof PILOT_MILESTONES;

/** Critères de succès (§ 45.3) — seuils du Cahier, cités tels quels. */
export const PILOT_CRITERIA = [
  { code: 'COUVERTURE_OBJETS', label: 'Couverture des objets prioritaires', threshold: '> 80 % dans les zones traitées', kpi: 'TAUX_RECENSEMENT', op: '>', value: '80' },
  { code: 'PART_ELECTRONIQUE', label: 'Part électronique des encaissements', threshold: '> 90 % sur le périmètre', kpi: 'PART_NUMERIQUE', op: '>', value: '90' },
  { code: 'ESPECES_AGENTS', label: 'Encaissement d’espèces par un agent', threshold: 'aucun', kpi: 'ESPECES_AGENTS', op: '=', value: '0' },
  { code: 'ECART_RAPPROCHEMENT', label: 'Écart de rapprochement', threshold: '< 1 %', kpi: 'ECART_RAPPROCHEMENT_J2', op: '<', value: '1' },
  { code: 'DELAI_QUITTANCE', label: 'Délai moyen de quittance', threshold: '< 1 minute', kpi: 'DELAI_QUITTANCE', op: '<', value: '60' },
  // Harmonisé avec le § 40 (FR 2) : mesuré par l'indicateur RECOURS_DANS_DELAI (délai légal de conception, à vérifier).
  { code: 'CONTESTATIONS_DELAI', label: 'Contestations traitées dans le délai légal', threshold: '> 90 %', kpi: 'RECOURS_DANS_DELAI', op: '>', value: '90' },
  { code: 'PROGRESSION_RECETTES', label: 'Progression des recettes pilotes vs communes témoins', threshold: 'significativement supérieure', kpi: null, op: '>', value: '0' },
] as const;

/**
 * Document maître FR 2, ch. 46 (nouvelle numérotation de l'ancien § 45) — ajouts, cités mot pour mot : raisons du
 * choix et objets prioritaires des communes (46.1), séquence en cinq étapes (46.2), critères de succès (46.3) et
 * indicateurs du § 40 qui les mesurent (la comparaison aux communes témoins est calculée pour chacun).
 */
export const PILOT_COMMUNES_46 = [
  { commune: 'Gombe', raison: 'Localité de premier rang, bureaux, forte valeur locative, publicité, point fluvial', objets: 'IRL, IF, publicité, embarquement' },
  { commune: 'Limete', raison: 'Tissu industriel et logistique, entrepôts, poids lourds', objets: 'IF, patente, véhicules, domaine public' },
  { commune: 'Kalamu', raison: 'Commerce dense de Matonge, habitat locatif compact', objets: 'IRL, patente, débits de boissons' },
  { commune: 'Ngaliema', raison: 'Habitat résidentiel de valeur élevée, bailleurs institutionnels', objets: 'IRL, IF' },
] as const;
export const PILOT_SEQUENCE_46 = [
  { etape: 1, semaines: [1, 4], texte: 'Semaines 1 à 4 : paramétrage du référentiel des recettes pilotes, conventions de données, recrutement et certification des agents.' },
  { etape: 2, semaines: [5, 12], texte: 'Semaines 5 à 12 : recensement locatif et commercial, création des objets, plaques QR sur les commerces et panneaux.' },
  { etape: 3, semaines: [13, 16], texte: 'Semaines 13 à 16 : ouverture des paiements électroniques, quittance vérifiable, assistance en centres communaux.' },
  { etape: 4, semaines: [17, 22], texte: 'Semaines 17 à 22 : campagne de déclaration pré-remplie calée sur l’échéance de début février, relances graduées.' },
  { etape: 5, semaines: [23, 26], texte: 'Semaines 23 à 26 : évaluation indépendante, comparaison avec les communes non pilotes, décision d’extension.' },
] as const;
export const PILOT_CRITERIA_46: Record<(typeof PILOT_CRITERIA)[number]['code'], { texte: string; indicateurs40: string[] }> = {
  COUVERTURE_OBJETS: { texte: 'Couverture des objets prioritaires supérieure à 80 % dans les zones traitées', indicateurs40: ['COUVERTURE_RECENSEMENT'] },
  PART_ELECTRONIQUE: { texte: 'part électronique des encaissements supérieure à 90 % sur le périmètre', indicateurs40: ['PART_ELECTRONIQUE_RECETTES'] },
  ESPECES_AGENTS: { texte: 'aucun encaissement d’espèces par un agent', indicateurs40: ['ESPECES_AGENTS'] },
  ECART_RAPPROCHEMENT: { texte: 'écart de rapprochement inférieur à 1 %', indicateurs40: ['ECART_RAPPROCHEMENT_J2', 'DELAI_PAIEMENT_RAPPROCHEMENT'] },
  DELAI_QUITTANCE: { texte: 'délai moyen de quittance inférieur à une minute', indicateurs40: ['DELAI_PAIEMENT_QUITTANCE'] },
  CONTESTATIONS_DELAI: { texte: 'taux de contestation traité dans le délai légal supérieur à 90 %', indicateurs40: ['RECOURS_DANS_DELAI'] },
  PROGRESSION_RECETTES: { texte: 'progression des recettes des communes pilotes significativement supérieure à celle des communes témoins', indicateurs40: ['BAUX_ENREGISTRES'] },
};

export function meetsThreshold(op: string, value: string, v: string | null): boolean | null {
  if (v === null) return null;
  const a = Number(v); const b = Number(value);
  return op === '>' ? a > b : op === '<' ? a < b : a === b;
}

// ————————————————————————— scénarios (§ 38.4) —————————————————————————

/** Vocabulaire du Cahier (§ 38.4) : prudent = conservateur ; transformationnel = ambitieux. */
export const SCENARIOS = {
  PRUDENT: { label: 'Prudent', equivalent: 'Conservateur', legacyCode: 'conservateur', compliance: 'Progression lente, résistance forte, extension limitée', cost: 'Investissement complet, gains différés', reading: 'Retour sur investissement au-delà de 24 mois' },
  ATTENDU: { label: 'Attendu', equivalent: 'Attendu', legacyCode: 'attendu', compliance: 'Pilote réussi, extension régulière, protocoles de données obtenus', cost: 'Investissement complet, gains progressifs', reading: 'Retour sur investissement attendu entre 12 et 24 mois' },
  TRANSFORMATIONNEL: { label: 'Transformationnel', equivalent: 'Ambitieux', legacyCode: 'ambitieux', compliance: 'Quitus généralisé, grands redevables fiabilisés, arriérés recouvrés', cost: 'Investissement complet plus campagnes', reading: 'Changement d’échelle du budget provincial' },
} as const;
export type ScenarioCode = keyof typeof SCENARIOS;
export const SCENARIO_CODES = Object.keys(SCENARIOS) as ScenarioCode[];

/** Variables des hypothèses : les trois variables de sensibilité du § 38.4 et le coût marginal du § 38.2. */
export const HYPOTHESIS_VARIABLES = {
  TAUX_CONFORMITE_CIBLE: { label: 'Taux de conformité cible', unit: '%' },
  TAUX_CHANGE: { label: 'Taux de change (CDF pour 1 USD)', unit: 'CDF/USD' },
  DELAI_PROTOCOLES_MOIS: { label: 'Délai d’obtention des protocoles de données', unit: 'mois' },
  COUT_MARGINAL: { label: 'Coût marginal de recouvrement (CDF)', unit: 'CDF' },
} as const;
export type HypothesisVariable = keyof typeof HYPOTHESIS_VARIABLES;

export interface Hypothesis {
  id: string;
  scenario: ScenarioCode;
  variable: HypothesisVariable;
  /** Catégorie de recette ou « * ». */
  revenue: string;
  value: string;
  source: string;
  sourceDate: string;
  recordedBy: string;
  recordedAt: string;
  status: 'EN_VIGUEUR' | 'REMPLACEE';
  example?: boolean;
}

export function pickHypothesis(hs: Hypothesis[], scenario: ScenarioCode, variable: HypothesisVariable, revenue: string): Hypothesis | undefined {
  const live = hs.filter((h) => h.status === 'EN_VIGUEUR' && h.scenario === scenario && h.variable === variable);
  return live.find((h) => h.revenue === revenue) ?? live.find((h) => h.revenue === '*');
}

/** Pourcentage décimal (chaîne) → points × 10 (entier), pour une arithmétique exacte. */
export function tenths(pct: string): bigint {
  const [u, d = ''] = pct.split('.');
  const neg = u!.startsWith('-');
  const v = BigInt(u!.replace('-', '') || '0') * 10n + BigInt((d + '0').slice(0, 1));
  return neg ? -v : v;
}

export const moneyOfMinor = (minor: bigint, c: CurrencyCode): MoneyJSON => Money.fromMinor(minor, c).toJSON();

/**
 * Recette additionnelle brute (§ 38.2) = potentiel × (conformité cible − conformité actuelle) × (mois utiles / 12),
 * en unités mineures ; l'écart de conformité est exprimé en points × 10 (voir `tenths`). Fonction unique, utilisée
 * par le simulateur de scénarios et par l'exemple illustratif (§ 39.3) ; le coût marginal est retranché à part.
 */
export function additionalGrossMinor(potentialMinor: bigint, deltaTenths: bigint, monthsUseful = 12n): bigint {
  return (potentialMinor * deltaTenths / 1000n) * monthsUseful / 12n;
}

// ————————————————————————— exemple illustratif (Cahier nouvelle version § 39.3) —————————————————————————

/**
 * « Exemple illustratif, à remplacer par les données du pilote » : tableau du Cahier repris mot pour mot. Données de
 * lecture seule, jamais enregistrées comme hypothèses, jamais utilisées par les scénarios ni par les tableaux de bord.
 */
export const EXEMPLE_ILLUSTRATIF = {
  titre: 'Exemple illustratif, à remplacer par les données du pilote',
  source: 'Cahier nouvelle version § 39.3',
  colonnes: ['Ligne', 'Objets (hypothèse)', 'Montant annuel moyen (hypothèse)', 'Conformité actuelle → cible (hypothèse)', 'Gain illustratif'],
  lignes: [
    { ligne: 'Revenus locatifs', objetsTexte: '2 000 000 unités louées', objets: '2000000', montantTexte: '158 USD (22 % d\'un loyer de 60 USD par mois)', montantAnnuel: '158', conformiteTexte: '8 % → 35 %', actuelle: '8', cible: '35', gainTexte: '≈ 85 M USD', gainMillionsCahier: 85 },
    { ligne: 'Impôt foncier', objetsTexte: '1 200 000 parcelles', objets: '1200000', montantTexte: '40 USD', montantAnnuel: '40', conformiteTexte: '15 % → 50 %', actuelle: '15', cible: '50', gainTexte: '≈ 17 M USD', gainMillionsCahier: 17 },
    { ligne: 'Véhicules et circulation', objetsTexte: '600 000 véhicules', objets: '600000', montantTexte: '60 USD', montantAnnuel: '60', conformiteTexte: '35 % → 70 %', actuelle: '35', cible: '70', gainTexte: '≈ 13 M USD', gainMillionsCahier: 13 },
    { ligne: 'Patente et débits de boissons', objetsTexte: '400 000 établissements', objets: '400000', montantTexte: '50 USD', montantAnnuel: '50', conformiteTexte: '10 % → 40 %', actuelle: '10', cible: '40', gainTexte: '≈ 6 M USD', gainMillionsCahier: 6 },
    { ligne: 'Publicité et antennes', objetsTexte: '15 000 objets', objets: '15000', montantTexte: '900 USD', montantAnnuel: '900', conformiteTexte: '30 % → 80 %', actuelle: '30', cible: '80', gainTexte: '≈ 7 M USD', gainMillionsCahier: 7 },
  ],
  avertissement: 'Les valeurs du tableau ci-dessus sont des hypothèses de travail destinées à illustrer la mécanique de calcul. Elles ne constituent ni une prévision, ni un engagement. Elles doivent être remplacées par les comptages du recensement pilote et par les tarifs officiels des arrêtés en vigueur avant toute présentation budgétaire.',
} as const;

// ————————————————————————— assignations, instructions, accords, projets —————————————————————————

export interface TargetEntry { commune: string; category: string; amount: MoneyJSON }
export interface TargetSet {
  id: string;
  fiscalYear: string;
  label: string;
  act: { reference: string; title: string; sha256?: string };
  entries: TargetEntry[];
  status: CertStatus;
  importedBy: string;
  importedAt: string;
  decision?: Decision;
  supersededBy?: string;
  example?: boolean;
}

export const INSTRUCTION_ORIGINS = {
  ENCAISSEMENT: 'Encaissement du jour — ouvrir les exceptions',
  COMMUNE: 'Par commune — interpeller un responsable de centre',
  CATEGORIE: 'Par catégorie — comparer au potentiel estimé',
  REGIE: 'Par régie et ministère — demander un plan d’action',
  LOCATIF: 'Couverture locative — lancer une campagne ciblée',
  FRAUDE: 'Risque et fraude — saisir l’audit ou l’inspection',
  PREVISION: 'Prévision — arbitrer les assignations',
  AFFECTATION: 'Capacité d’affectation — ouvrir le module d’affectation',
  AUTRE: 'Autre instruction',
} as const;
export type InstructionOrigin = keyof typeof INSTRUCTION_ORIGINS;
export type InstructionStatus = 'EMISE' | 'ACCUSEE' | 'RAPPORT_DEPOSE' | 'CLOSE';
export const INSTRUCTION_STATUS_LABELS: Record<InstructionStatus, string> = {
  EMISE: 'Émise', ACCUSEE: 'Accusée — en cours', RAPPORT_DEPOSE: 'Rapport déposé — clôture attendue', CLOSE: 'Close',
};

export interface Instruction {
  id: string;
  number: string;
  issuedBy: string;
  authority: string;
  origin: InstructionOrigin;
  subject: string;
  body: string;
  context: { commune?: string; category?: string; entity?: string };
  assignee: { entity: string; role?: string; userId?: string };
  deadline: string;
  status: InstructionStatus;
  issuedAt: string;
  reports: { by: string; at: string; text: string; evidenceSha256?: string }[];
  closure?: { by: string; at: string; motif: string; onTime: boolean };
  history: { at: string; by: string; action: string; text?: string }[];
  example?: boolean;
}

export const SLA_KINDS = {
  INSTRUCTION: 'Délai d’instruction',
  REVERSEMENT: 'Délai de reversement',
  VERIFICATION: 'Délai de réponse aux vérifications',
  REPONSE: 'Délai de réponse',
} as const;
export type SlaKind = keyof typeof SLA_KINDS;

export interface SlaAgreement {
  id: string;
  fromEntity: string;
  toEntity: string;
  kind: SlaKind;
  delayHours: number;
  act: { reference: string; title: string };
  recordedBy: string;
  recordedAt: string;
  active: boolean;
  example?: boolean;
}
export interface SlaRequest {
  id: string;
  agreementId: string;
  reference: string;
  openedBy: string;
  openedAt: string;
  dueAt: string;
  closedBy?: string;
  closedAt?: string;
  onTime?: boolean;
  example?: boolean;
}

/** Domaines d'emploi des fonds (§ 27.2). */
export const PROJECT_DOMAINS = {
  VOIRIE: 'Voirie', DRAINAGE: 'Drainage', ASSAINISSEMENT: 'Assainissement', DECHETS: 'Gestion des déchets', ECLAIRAGE: 'Éclairage public',
  TRANSPORT: 'Transport et mobilité', MARCHES: 'Modernisation des marchés', ECOLES: 'Écoles', SANTE: 'Centres de santé', NUMERIQUE: 'Services numériques',
  INONDATIONS: 'Protection contre les inondations', EMPLOI: 'Programmes d’emploi', SECURITE: 'Sécurité publique',
} as const;
export type ProjectDomain = keyof typeof PROJECT_DOMAINS;
export const MATURITY = { IDEE: 1, ETUDE_PREALABLE: 2, ETUDE_DETAILLEE: 3, PRET_A_LANCER: 4 } as const;
export type Maturity = keyof typeof MATURITY;
export const MATURITY_LABELS: Record<Maturity, string> = { IDEE: 'Idée', ETUDE_PREALABLE: 'Étude préalable', ETUDE_DETAILLEE: 'Étude détaillée', PRET_A_LANCER: 'Prêt à lancer' };
export const PROCUREMENT = {
  APPEL_OFFRES_OUVERT: 'Appel d’offres ouvert', APPEL_OFFRES_RESTREINT: 'Appel d’offres restreint', GRE_A_GRE: 'Marché de gré à gré (motivé)', REGIE: 'Exécution en régie', A_DETERMINER: 'À déterminer par la cellule de passation',
} as const;
export type Procurement = keyof typeof PROCUREMENT;
export type ProjectStatus = 'PROPOSE' | 'RETENU' | 'ECARTE' | 'FINANCE' | 'EN_COURS' | 'ACHEVE';
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  PROPOSE: 'Proposé', RETENU: 'Retenu par l’autorité', ECARTE: 'Écarté', FINANCE: 'Financé (acte budgétaire)', EN_COURS: 'En cours', ACHEVE: 'Achevé',
};

/** Projet public : champs du § 27.2 (chaque scénario indique ces éléments pour chaque projet). */
export interface PublicProject {
  id: string;
  code: string;
  title: string;
  domain: ProjectDomain;
  /** Impact géographique : communes et, le cas échéant, quartiers (texte). */
  communes: string[];
  areas?: string;
  /** Bénéficiaires décrits collectivement (population, usagers) — jamais nominativement. */
  beneficiaries: string;
  expectedResult: string;
  maturity: Maturity;
  cost: MoneyJSON;
  recurringCost: MoneyJSON;
  procurement: Procurement;
  risks: string;
  approvalAuthority: string;
  legalFundSource: string;
  status: ProjectStatus;
  progressPct?: string;
  funding?: { decisionReference: string; amount: MoneyJSON; decidedBy: string; decidedAt: string; motif: string };
  createdBy: string;
  createdAt: string;
  history: { at: string; by: string; action: string; text?: string }[];
  example?: boolean;
}

export interface FundScenarioItem {
  projectId: string; code: string; title: string; domain: string; communes: string[]; beneficiaries: string; expectedResult: string;
  maturity: string; recurringCost: MoneyJSON; procurement: string; risks: string; approvalAuthority: string; legalFundSource: string;
  proposedAmount: MoneyJSON; rank: number; factors: { label: string; value: string }[];
}
export interface FundScenario {
  id: string;
  batchId: string;
  variant: string;
  label: string;
  currency: CurrencyCode;
  period: string;
  available: MoneyJSON;
  availableBasis: string;
  items: FundScenarioItem[];
  unallocated: MoneyJSON;
  proposedBy: { kind: 'ai'; agent: 'ALLOCATION' };
  proposedAt: string;
  requestedBy: string;
  status: 'PROPOSE' | 'RETENU' | 'ECARTE';
  decision?: { by: string; at: string; motif: string };
  notice: string;
}
