/**
 * Règles et registre juridique — compléments partagés (Cahier § 6.2, § 6.3, § 6.11, § 11.2, § 32, § 44) :
 *  - garde par catégorie : ACTE_REQUIS jamais activable, RECETTE_CENTRALE exclue de la liquidation provinciale,
 *    RECETTE_ETD non liquidée par la province ;
 *  - fait générateur typé (en plus du libellé libre, conservé) ;
 *  - table de correspondance « champ de la fiche → attribut technique » du registre (noms du Cahier, snake_case) ;
 *  - cas de tests juridiques attachés à chaque version ;
 *  - classes de confidentialité C1 à C5 (ch. 32).
 */
import type { RevenueCategory } from './domain.js';
import type { RuleSheet } from './rules.js';

/* ── Fait générateur typé (§ 6.2, doc 06 § 6.12 n° 4) ── */
export const TAXABLE_EVENT_KINDS = ['POSSESSION', 'LOCATION', 'ACTIVITE', 'TRANSACTION', 'OCCUPATION', 'ACTE'] as const;
export type TaxableEventKind = (typeof TAXABLE_EVENT_KINDS)[number];
export const TAXABLE_EVENT_LABELS: Record<TaxableEventKind, string> = {
  POSSESSION: 'Possession (propriété d’un bien)', LOCATION: 'Location (loyers perçus)', ACTIVITE: 'Exercice d’une activité',
  TRANSACTION: 'Transaction', OCCUPATION: 'Occupation du domaine public', ACTE: 'Délivrance d’un acte ou d’un service',
};

/* ── Garde par catégorie (§ 6.3, § 6.11) ── */

/**
 * Codes de règles ACTE_REQUIS dotées d'un circuit d'activation propre, adossé à un acte (référence + empreinte) et à une
 * décision à deux personnes : la clé de répartition du § 37A (circuit REPARTITION_ACTIVATION). Ce ne sont pas des
 * recettes : elles ne produisent jamais d'obligation (la liquidation refuse toujours ACTE_REQUIS). Harmonisation
 * signalée au maître d'ouvrage : § 6.3 « non activable » vs § 37A « activation sur acte ».
 */
export const ACTE_REQUIS_CIRCUIT_PROPRE: readonly string[] = ['CLE-REPARTITION-37A'];

/** Vrai si la règle relève de la catégorie ACTE_REQUIS sans circuit propre : jamais publiable ni activable. */
export function acteRequisBloque(rule: Pick<RuleSheet, 'revenueCategory' | 'code'>): boolean {
  return rule.revenueCategory === 'ACTE_REQUIS' && !ACTE_REQUIS_CIRCUIT_PROPRE.includes(rule.code);
}

/** Catégories qui ne produisent aucune obligation dans l'espace provincial (cas de tests non exigés). */
export const CATEGORIES_NON_EXECUTABLES: RevenueCategory[] = ['ACTE_REQUIS', 'RECETTE_CENTRALE'];

/** Entité d'une entité territoriale décentralisée (espace communal distinct, § 6.3) : préfixe ETD- ou COMMUNE-. */
export function estEntiteEtd(entity: string | undefined): boolean {
  return !!entity && /^(ETD|COMMUNE)[-_:]/i.test(entity);
}

/**
 * Refus de liquidation par catégorie (null = admis). Une simulation reste possible (non opposable) : « simulable,
 * non activable ». Aucun cas n'est levé par un paramètre : la séparation des compétences est constitutionnelle.
 */
export function refusParCategorie(category: RevenueCategory, liquidatorEntity: string | undefined): { code: string; detail: string } | null {
  if (category === 'ACTE_REQUIS') {
    return { code: 'ACTE_REQUIS_NON_ACTIVABLE', detail: 'Recette nécessitant un acte nouveau (§ 6.3) : simulable, jamais liquidable.' };
  }
  if (category === 'RECETTE_CENTRALE') {
    return { code: 'RECETTE_CENTRALE_EXCLUE', detail: 'Recette du pouvoir central (OL 18/003) : exclue du périmètre provincial, aucune liquidation (§ 6.3).' };
  }
  if (category === 'RECETTE_ETD' && !estEntiteEtd(liquidatorEntity)) {
    return { code: 'RECETTE_ETD_HORS_PROVINCE', detail: 'Recette d’une entité territoriale décentralisée : la province ne la liquide pas (§ 6.3) ; espace communal distinct.' };
  }
  return null;
}

/* ── Registre des règles : attributs techniques (§ 6.2, « Revenue Rule Registry — modèle technique ») ── */

export const RULE_TECHNICAL_ATTRIBUTES = [
  { attribut: 'legal_reference', champ: 'Référence légale', source: 'legalInstrumentIds' },
  { attribut: 'article', champ: 'Article', source: 'articles' },
  { attribut: 'authority', champ: 'Autorité compétente', source: 'competentAuthority' },
  { attribut: 'administrator', champ: 'Administration (régie)', source: 'administeringEntity' },
  { attribut: 'taxable_event', champ: 'Fait générateur', source: 'taxableEvent (+ taxableEventKind)' },
  { attribut: 'liable_party', champ: 'Catégorie d’assujetti', source: 'liableParty' },
  { attribut: 'base', champ: 'Base de calcul', source: 'baseDefinition' },
  { attribut: 'formula', champ: 'Formule', source: 'formula' },
  { attribut: 'rate', champ: 'Taux ou tarif', source: 'rateTable' },
  { attribut: 'currency', champ: 'Devise', source: 'currency' },
  { attribut: 'rounding', champ: 'Arrondi', source: 'rounding' },
  { attribut: 'periodicity', champ: 'Périodicité', source: 'periodicity' },
  { attribut: 'due_rule', champ: 'Échéance', source: 'dueRule' },
  { attribut: 'exemptions', champ: 'Exonérations', source: 'exemptions' },
  { attribut: 'penalties', champ: 'Pénalités', source: 'penalties' },
  { attribut: 'beneficiary_account', champ: 'Compte public bénéficiaire (référence au coffre)', source: 'beneficiaryAccountAlias' },
  { attribut: 'effective_from', champ: 'Entrée en vigueur', source: 'effectiveFrom' },
  { attribut: 'effective_to', champ: 'Fin', source: 'effectiveTo' },
  { attribut: 'appeal_path', champ: 'Voie de recours', source: 'appealPath' },
  { attribut: 'approval_state', champ: 'Approbation', source: 'status + approvals' },
  { attribut: 'version', champ: 'Version', source: 'version' },
] as const;
export type RuleTechnicalAttribute = (typeof RULE_TECHNICAL_ATTRIBUTES)[number]['attribut'];

export interface RuleTechnicalSheet {
  code: string;
  legal_reference: string[];
  article: string[];
  authority: string;
  administrator: string;
  taxable_event: { kind: TaxableEventKind | null; label: string };
  liable_party: string;
  base: string;
  formula: string;
  rate: Record<string, string>;
  currency: string;
  rounding: string;
  periodicity: string;
  due_rule: string;
  exemptions: { basis: string; proof: string }[];
  penalties: { basis: string; description: string }[];
  beneficiary_account: string;
  effective_from: string;
  effective_to: string | null;
  appeal_path: string;
  approval_state: { status: string; approvals: { role: string; user_id: string; at: string }[] };
  version: number;
}

/** Fiche au format technique du Cahier (noms snake_case) : même règle, lisible par le juriste et exécutable par le moteur. */
export function ficheTechnique(rule: RuleSheet): RuleTechnicalSheet {
  return {
    code: rule.code,
    legal_reference: [...rule.legalInstrumentIds],
    article: [...rule.articles],
    authority: rule.competentAuthority,
    administrator: rule.administeringEntity,
    taxable_event: { kind: rule.taxableEventKind ?? null, label: rule.taxableEvent },
    liable_party: rule.liableParty,
    base: rule.baseDefinition,
    formula: rule.formula,
    rate: { ...rule.rateTable },
    currency: rule.currency,
    rounding: rule.rounding,
    periodicity: rule.periodicity,
    due_rule: rule.dueRule,
    exemptions: rule.exemptions.map((e) => ({ ...e })),
    penalties: rule.penalties.map((p) => ({ ...p })),
    beneficiary_account: rule.beneficiaryAccountAlias,
    effective_from: rule.effectiveFrom,
    effective_to: rule.effectiveTo ?? null,
    appeal_path: rule.appealPath,
    approval_state: { status: rule.status, approvals: rule.approvals.map((a) => ({ role: a.role, user_id: a.userId, at: a.at })) },
    version: rule.version,
  };
}

/* ── Cas de tests juridiques (§ 11.2, § 44, § 6.2 contrôle fiscal) ── */

export interface LegalTestCase {
  id: string;
  label: string;
  /** Entrées de la formule (hors taux : ceux-ci viennent toujours de la table certifiée). */
  inputs: Record<string, string>;
  localityRank: number;
  /** Résultat attendu : montant arrondi selon la règle, OU code d'erreur attendu (cas négatif). */
  expected: { amount: string } | { errorCode: string };
  addedBy: string;
  addedAt: string;
  /** Validation par un juriste vérificateur (R14), distinct de l'auteur du cas. */
  validatedBy?: string;
  validatedAt?: string;
}

export interface LegalTestResult {
  caseId: string;
  label: string;
  passed: boolean;
  expected: LegalTestCase['expected'];
  actual: { amount: string } | { errorCode: string; message: string };
}

export interface LegalTestRun {
  at: string;
  by: string;
  ruleId: string;
  ruleVersion: number;
  total: number;
  passed: number;
  failed: number;
  results: LegalTestResult[];
}

/* ── Classes de confidentialité (ch. 32 ; doc 28 § 28.4) ── */
export const DATA_CLASSES = {
  C1: 'Public',
  C2: 'Interne',
  C3: 'Personnel',
  C4: 'Personnel sensible / secret fiscal',
  C5: 'Secret (clés, preuves d’enquête, journal)',
} as const;
export type DataClass = keyof typeof DATA_CLASSES;

/* ── Points juridiques (§ 6.4, doc 06 § 6.13, annexe H.3.2) ── */
export type PointJuridiqueStatut = 'OUVERT' | 'TRANCHE';
