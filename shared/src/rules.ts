/**
 * Fiche de règle de recette (§ 6.12) — ce que le juriste signe est ce que le moteur exécute.
 * Les fiches d'exemple sont au statut A_VERIFIER : elles ne peuvent produire aucune obligation.
 */
import type { CurrencyCode } from './currencies.js';
import type { RevenueCategory, RuleStatus } from './domain.js';
import { kinshasaBoundMs } from './validity.js';
import { acteRequisBloque, type TaxableEventKind } from './juridique.js';

export type RateTable = Record<string, string>; // clé (rang, catégorie) -> valeur décimale en chaîne

export interface Approval {
  role: 'REDACTEUR' | 'VERIFICATEUR_JURIDIQUE' | 'VALIDATEUR_FINANCIER' | 'AUTORITE_PUBLICATION';
  userId: string;
  at: string;
}

export interface RuleSheet {
  id: string;
  code: string;
  version: number;
  revenueCategory: RevenueCategory;
  label: string;
  legalInstrumentIds: string[];
  articles: string[];
  competentAuthority: string;
  administeringEntity: string;
  taxableEvent: string;
  /** Fait générateur typé (§ 6.2) — facultatif, en plus du libellé `taxableEvent`. */
  taxableEventKind?: TaxableEventKind;
  liableParty: string;
  withholdingAgent?: string;
  baseDefinition: string;
  /** Formule dans le langage de règles du moteur (voir backend/src/modules/rules/formula.ts) */
  formula: string;
  rateTable: RateTable;
  currency: CurrencyCode;
  rounding: 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP';
  periodicity: 'ANNUELLE' | 'MENSUELLE' | 'PONCTUELLE';
  dueRule: string;
  exemptions: { basis: string; proof: string }[];
  penalties: { basis: string; description: string }[];
  effectiveFrom: string;
  effectiveTo?: string;
  beneficiaryAccountAlias: string;
  appealPath: string;
  status: RuleStatus;
  sourceVerification: 'OFFICIEL_CERTIFIE' | 'PRESSE' | 'DOCUMENT_DE_TRAVAIL' | 'AUCUNE';
  approvals: Approval[];
  supersedesVersionId?: string;
  changeReason?: string;
  /** Source documentaire de la position portée par la fiche (ex. « Cahier des exigences v2.9, § 16.2 »). */
  sourceReference?: string;
  /** Réserve de lecture : ce qui prévaut sur la fiche (ex. lecture certifiée de l'OL 18/004). */
  readingNote?: string;
  /**
   * Position du promoteur (Cahier des exigences) versée au registre pour arbitrage : jamais retenue par défaut à la place
   * d'une version antérieure (simulations non opposables comprises) tant qu'elle n'est pas certifiée et ACTIVE.
   */
  promoterPosition?: boolean;
  /**
   * Tolérance d'échéance (§ 6.2), en jours, fixée par le texte : aucun constat de retard, avis J+1 ni pénalité avant
   * l'échéance (éventuellement prorogée) augmentée de cette tolérance. Absente ⇒ aucune tolérance (comportement historique).
   */
  dueToleranceDays?: number;
  /**
   * Prorogations d'échéance (§ 6.2, doc 06 § 6.4) : acte daté qui reporte les échéances d'une plage de dates sans nouvelle
   * version de la règle (ex. 1er → 28 février). Ajout seul : une prorogation n'est jamais effacée.
   */
  dueDateExtensions?: DueDateExtension[];
}

/** Acte de prorogation d'échéance attaché à une fiche de règle. */
export interface DueDateExtension {
  id: string;
  /** Échéances concernées : de `appliesFrom` à `appliesTo` inclus (AAAA-MM-JJ). */
  appliesFrom: string;
  appliesTo: string;
  /** Nouvelle échéance. */
  extendedTo: string;
  /** Référence de l'acte (arrêté, décision) et date de l'acte. */
  actReference: string;
  actDate: string;
  reason: string;
  recordedBy: string[];
  recordedAt: string;
}

const addDaysIso = (d: string, n: number): string => {
  const t = new Date(`${d.slice(0, 10)}T00:00:00.000Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

/**
 * Échéance effective d'une obligation au regard de sa fiche de règle : prorogation (la plus tardive applicable), puis
 * tolérance. `graceUntil` est le dernier jour sans retard : un retard n'est constaté que si `graceUntil < aujourd'hui`.
 */
export function effectiveDue(rule: Pick<RuleSheet, 'dueToleranceDays' | 'dueDateExtensions'> | undefined, dueDate: string): { dueDate: string; graceUntil: string; toleranceDays: number; extension: DueDateExtension | null } {
  const ext = (rule?.dueDateExtensions ?? [])
    .filter((e) => e.appliesFrom <= dueDate && dueDate <= e.appliesTo && e.extendedTo > dueDate)
    .sort((a, b) => b.extendedTo.localeCompare(a.extendedTo))[0] ?? null;
  const due = ext ? ext.extendedTo : dueDate;
  const tol = Math.max(0, Math.floor(rule?.dueToleranceDays ?? 0));
  return { dueDate: due, graceUntil: tol ? addDaysIso(due, tol) : due, toleranceDays: tol, extension: ext };
}

export const REQUIRED_APPROVALS: Approval['role'][] = [
  'REDACTEUR', 'VERIFICATEUR_JURIDIQUE', 'VALIDATEUR_FINANCIER', 'AUTORITE_PUBLICATION',
];

/**
 * Une règle ne peut produire une obligation que si elle est ACTIVE, certifiée et dans sa période.
 * Les dates d'effet sont des journées de Kinshasa (UTC+1) : du 00:00 du jour d'effet au 23:59:59.999 du jour de fin,
 * heure de Kinshasa (et non minuit UTC).
 */
export function isRuleExecutable(rule: RuleSheet, at: Date): { ok: true } | { ok: false; reason: string } {
  if (rule.status !== 'ACTIVE') return { ok: false, reason: `Règle au statut ${rule.status}` };
  // § 6.3 / § 6.11 : une règle ACTE_REQUIS n'est jamais exécutable (hors clés à circuit d'activation propre).
  if (acteRequisBloque(rule)) return { ok: false, reason: 'Catégorie ACTE_REQUIS : acte nouveau requis, non activable' };
  if (rule.sourceVerification !== 'OFFICIEL_CERTIFIE') return { ok: false, reason: 'Source non certifiée' };
  const approvers = new Set(rule.approvals.map((a) => a.userId));
  const roles = new Set(rule.approvals.map((a) => a.role));
  if (!REQUIRED_APPROVALS.every((r) => roles.has(r)) || approvers.size < 4)
    return { ok: false, reason: 'Quatre approbations distinctes requises' };
  if (at.getTime() < kinshasaBoundMs(rule.effectiveFrom, 'start')) return { ok: false, reason: "Date d'effet non atteinte" };
  if (rule.effectiveTo && at.getTime() > kinshasaBoundMs(rule.effectiveTo, 'end')) return { ok: false, reason: 'Règle expirée' };
  return { ok: true };
}

/** Fiches modèles de l'Annexe B — statut A_VERIFIER (taux rapportés par la presse, arrêté non certifié). */
export const SAMPLE_RULES: RuleSheet[] = [
  {
    id: 'rule-irl-kin-r1-v1', code: 'IRL-KIN-R1', version: 1, revenueCategory: 'IMPOT_PROVINCIAL',
    label: 'Impôt sur les revenus locatifs — 1er rang',
    legalInstrumentIds: ['const-2006-art204', 'ol-18-004', 'ol-69-009', 'arrete-taux-irl-2026'],
    articles: ['Constitution art. 204 pt 16'],
    competentAuthority: 'Ministère provincial des Finances', administeringEntity: 'DGIPK',
    taxableEvent: 'Perception de loyers', liableParty: 'Bailleur', withholdingAgent: 'Locataire assujetti [À VÉRIFIER]',
    baseDefinition: 'Loyers effectivement perçus sur la période',
    formula: 'max(0, loyers_percus * taux / 100 - retenues_imputees)',
    rateTable: { taux: '22', taux_retenue: '20' }, currency: 'USD', rounding: 'HALF_UP',
    periodicity: 'ANNUELLE', dueRule: '1er février de l’année suivante [À VÉRIFIER]',
    exemptions: [], penalties: [], effectiveFrom: '2024-01-01', beneficiaryAccountAlias: 'KIN-DGIPK-RECETTES-01',
    appealPath: 'Réclamation auprès de la DGIPK [délai À VÉRIFIER]',
    status: 'A_VERIFIER', sourceVerification: 'PRESSE', approvals: [],
  },
  {
    id: 'rule-irl-kin-r234-v1', code: 'IRL-KIN-R234', version: 1, revenueCategory: 'IMPOT_PROVINCIAL',
    label: 'Impôt sur les revenus locatifs — 2e, 3e et 4e rangs',
    legalInstrumentIds: ['const-2006-art204', 'ol-18-004', 'ol-69-009', 'arrete-taux-irl-2026'],
    articles: ['Constitution art. 204 pt 16'],
    competentAuthority: 'Ministère provincial des Finances', administeringEntity: 'DGIPK',
    taxableEvent: 'Perception de loyers', liableParty: 'Bailleur', withholdingAgent: 'Locataire assujetti [À VÉRIFIER]',
    baseDefinition: 'Loyers effectivement perçus sur la période',
    formula: 'max(0, loyers_percus * taux / 100 - retenues_imputees)',
    rateTable: { taux: '17', taux_retenue: '15' }, currency: 'USD', rounding: 'HALF_UP',
    periodicity: 'ANNUELLE', dueRule: '1er février de l’année suivante [À VÉRIFIER]',
    exemptions: [], penalties: [], effectiveFrom: '2024-01-01', beneficiaryAccountAlias: 'KIN-DGIPK-RECETTES-01',
    appealPath: 'Réclamation auprès de la DGIPK [délai À VÉRIFIER]',
    status: 'A_VERIFIER', sourceVerification: 'PRESSE', approvals: [],
  },
  {
    id: 'rule-if-pp-bati-v1', code: 'IF-KIN-PP-BATI', version: 1, revenueCategory: 'IMPOT_PROVINCIAL',
    label: 'Impôt foncier — personnes physiques, bâti (forfait par rang)',
    legalInstrumentIds: ['const-2006-art204', 'ol-18-004', 'ol-69-006', 'arrete-taux-if-2026'],
    articles: ['Constitution art. 204 pt 16'],
    competentAuthority: 'Ministère provincial des Finances', administeringEntity: 'DGIPK',
    taxableEvent: 'Propriété d’un immeuble bâti [date À VÉRIFIER]', liableParty: 'Propriétaire personne physique',
    baseDefinition: 'Forfait par propriété selon le rang de localité',
    formula: 'forfait',
    rateTable: { 'forfait:1': '450', 'forfait:2': '150', 'forfait:3': '50', 'forfait:4': '10' }, currency: 'USD', rounding: 'HALF_UP',
    periodicity: 'ANNUELLE', dueRule: '1er février [À VÉRIFIER]', exemptions: [], penalties: [],
    effectiveFrom: '2026-01-01', beneficiaryAccountAlias: 'KIN-DGIPK-RECETTES-01',
    appealPath: 'Réclamation auprès de la DGIPK [délai À VÉRIFIER]',
    status: 'A_VERIFIER', sourceVerification: 'PRESSE', approvals: [],
  },
  {
    id: 'rule-if-pm-v1', code: 'IF-KIN-PM', version: 1, revenueCategory: 'IMPOT_PROVINCIAL',
    label: 'Impôt foncier — personnes morales (par m² selon le rang)',
    legalInstrumentIds: ['const-2006-art204', 'ol-18-004', 'ol-69-006', 'arrete-taux-if-2026'],
    articles: ['Constitution art. 204 pt 16'],
    competentAuthority: 'Ministère provincial des Finances', administeringEntity: 'DGIPK',
    taxableEvent: 'Propriété d’un immeuble', liableParty: 'Propriétaire personne morale',
    baseDefinition: 'Superficie en m²', formula: 'superficie_m2 * tarif_m2',
    rateTable: { 'tarif_m2:1': '3.5', 'tarif_m2:2': '2.5', 'tarif_m2:3': '2', 'tarif_m2:4': '1.5' }, currency: 'USD', rounding: 'HALF_UP',
    periodicity: 'ANNUELLE', dueRule: '1er février [À VÉRIFIER]', exemptions: [], penalties: [],
    effectiveFrom: '2026-01-01', beneficiaryAccountAlias: 'KIN-DGIPK-RECETTES-01',
    appealPath: 'Réclamation auprès de la DGIPK [délai À VÉRIFIER]',
    status: 'A_VERIFIER', sourceVerification: 'PRESSE', approvals: [],
  },
  // ── Position du promoteur (Cahier des exigences v2.9) : versions AJOUTÉES, au statut A_VERIFIER (jamais ACTIVE) ──
  // IRL : taux de l'impôt 22 % des loyers effectivement encaissés ; la retenue par le locataire est de 20 % en
  // localité de premier rang (15 % aux 2e, 3e et 4e rangs) — la « retenue de premier rang » n'est pas le taux de
  // l'impôt. Les versions 1 sont conservées ; la lecture certifiée de l'OL 18/004 et de l'arrêté des taux prévaut.
  {
    id: 'rule-irl-kin-r1-v2', code: 'IRL-KIN-R1', version: 2, revenueCategory: 'IMPOT_PROVINCIAL',
    label: 'Impôt sur les revenus locatifs — 1er rang (22 % ; retenue de premier rang 20 %)',
    legalInstrumentIds: ['const-2006-art204', 'ol-18-004', 'ol-69-009', 'arrete-taux-irl-2026'],
    articles: ['Constitution art. 204 pt 16'],
    competentAuthority: 'Ministère provincial des Finances', administeringEntity: 'DGIPK',
    taxableEvent: 'Perception de loyers', liableParty: 'Bailleur', withholdingAgent: 'Locataire assujetti [À VÉRIFIER]',
    baseDefinition: 'Loyers effectivement encaissés sur la période ; impôt de 22 %, dont 20 % retenus à la source par le locataire (retenue de premier rang), imputés sur l’impôt',
    formula: 'max(0, loyers_percus * taux / 100 - retenues_imputees)',
    rateTable: { taux: '22', taux_retenue: '20' }, currency: 'USD', rounding: 'HALF_UP',
    periodicity: 'ANNUELLE', dueRule: '1er février de l’année suivante [À VÉRIFIER]',
    exemptions: [], penalties: [], effectiveFrom: '2026-01-01', beneficiaryAccountAlias: 'KIN-DGIPK-RECETTES-01',
    appealPath: 'Réclamation auprès de la DGIPK [délai À VÉRIFIER]',
    status: 'A_VERIFIER', sourceVerification: 'DOCUMENT_DE_TRAVAIL', approvals: [],
    supersedesVersionId: 'rule-irl-kin-r1-v1', promoterPosition: true,
    changeReason: 'Position du Cahier v2.9 : IRL = 22 % des loyers encaissés, dont 20 % = retenue de premier rang (valeurs publiées en 2026 pour Kinshasa, à revalider à chaque édit budgétaire).',
    sourceReference: 'Cahier des exigences v2.9 (24/09/2026) — alerte juridique et § 16.2 « Taux et retenue »',
    readingNote: 'Position du promoteur, non certifiée : la lecture certifiée de l’OL 18/004 et de l’arrêté provincial des taux prévaut. Aucune liquidation tant que la fiche n’est pas ACTIVE (quatre visas, source officielle certifiée).',
  },
  {
    id: 'rule-irl-kin-r234-v2', code: 'IRL-KIN-R234', version: 2, revenueCategory: 'IMPOT_PROVINCIAL',
    label: 'Impôt sur les revenus locatifs — 2e, 3e et 4e rangs (22 % ; retenue 15 %)',
    legalInstrumentIds: ['const-2006-art204', 'ol-18-004', 'ol-69-009', 'arrete-taux-irl-2026'],
    articles: ['Constitution art. 204 pt 16'],
    competentAuthority: 'Ministère provincial des Finances', administeringEntity: 'DGIPK',
    taxableEvent: 'Perception de loyers', liableParty: 'Bailleur', withholdingAgent: 'Locataire assujetti [À VÉRIFIER]',
    baseDefinition: 'Loyers effectivement encaissés sur la période ; impôt de 22 %, dont 15 % retenus à la source par le locataire (2e, 3e et 4e rangs), imputés sur l’impôt',
    formula: 'max(0, loyers_percus * taux / 100 - retenues_imputees)',
    rateTable: { taux: '22', taux_retenue: '15' }, currency: 'USD', rounding: 'HALF_UP',
    periodicity: 'ANNUELLE', dueRule: '1er février de l’année suivante [À VÉRIFIER]',
    exemptions: [], penalties: [], effectiveFrom: '2026-01-01', beneficiaryAccountAlias: 'KIN-DGIPK-RECETTES-01',
    appealPath: 'Réclamation auprès de la DGIPK [délai À VÉRIFIER]',
    status: 'A_VERIFIER', sourceVerification: 'DOCUMENT_DE_TRAVAIL', approvals: [],
    supersedesVersionId: 'rule-irl-kin-r234-v1', promoterPosition: true,
    changeReason: 'Position du Cahier v2.9 : le taux de l’impôt (22 %) ne varie pas avec le rang ; seule la retenue varie (20 % au 1er rang, 15 % aux autres). La version 1 (taux 17 %) est conservée pour arbitrage.',
    sourceReference: 'Cahier des exigences v2.9 (24/09/2026) — § 16.2 « Taux et retenue »',
    readingNote: 'Position du promoteur, non certifiée : la lecture certifiée de l’OL 18/004 et de l’arrêté provincial des taux prévaut. Aucune liquidation tant que la fiche n’est pas ACTIVE.',
  },
  // Clé de répartition du § 37A : règle versionnée du registre juridique (§ 37A.7), acte requis avant toute exécution.
  {
    id: 'rule-cle-repartition-37a-v1', code: 'CLE-REPARTITION-37A', version: 1, revenueCategory: 'ACTE_REQUIS',
    label: 'Clé de répartition des recettes générées par le système (10 / 10 / 10 / 70, 30 ans)',
    legalInstrumentIds: ['const-2006-art204'],
    articles: ['Acte provincial instituant la clé (édit ou arrêté) — REQUIS (§ 37A.8)'],
    competentAuthority: 'Gouvernement provincial (acte juridique requis)', administeringEntity: 'MINFIN',
    taxableEvent: 'Recette rapprochée (états 8 et 9 de l’échelle du § 26.1)', liableParty: 'Sans objet (répartition de recettes publiques)',
    baseDefinition: 'Tout montant payé au moyen d’une référence MOSOLO, réglé sur le compte public et rapproché ; remboursements et contrepassations réduisent l’assiette ; arrondis au Gouvernement provincial',
    formula: 'recettes_rapprochees * (part_groupe_nseya + part_tutelle + part_agents + part_gouvernement) / 100',
    rateTable: { part_groupe_nseya: '10', part_tutelle: '10', part_agents: '10', part_gouvernement: '70' }, currency: 'USD', rounding: 'DOWN',
    periodicity: 'MENSUELLE', dueRule: 'Après rapprochement, selon la périodicité fixée par la convention tripartite [À VÉRIFIER]',
    exemptions: [], penalties: [], effectiveFrom: '2026-01-01', beneficiaryAccountAlias: 'DEUX-FLUX-37A [comptes verrouillés, à désigner]',
    appealPath: 'Comité de suivi de la répartition (§ 37A.7)',
    status: 'A_VERIFIER', sourceVerification: 'DOCUMENT_DE_TRAVAIL', approvals: [], promoterPosition: true,
    changeReason: 'Position du promoteur (Cahier v2.9, § 37A) : 10 % Groupe Nseya (Flux 1), 10 % ministère de tutelle, 10 % agents et sous-traitants, 70 % Gouvernement provincial (Flux 2).',
    sourceReference: 'Cahier des exigences v2.9 (24/09/2026) — § 37A',
    readingNote: 'Non active : acte juridique provincial, contrat PPP, conformité LOFIP, convention tripartite et traitement fiscal requis (§ 37A.8). Deux flux de décaissement seulement.',
  },
];
