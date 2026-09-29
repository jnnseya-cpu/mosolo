/**
 * Moteur de paiement, de règlement et de répartition des recettes (spécification du maître d'ouvrage du 29/09/2026,
 * « Payment, Settlement & Revenue Allocation Engine ») — CONSTRUIT PAR-DESSUS la clé du § 37A (repartition/model.ts),
 * sans rien en retirer :
 *
 *  - matrice de répartition VERSIONNÉE (règle KIN-REV-001, versions V1, V2…) : bénéficiaires, pourcentages en chaînes
 *    décimales, périmètres (recette, module, mode de paiement), dates d'effet, base juridique, document d'approbation ;
 *    circuit rédaction → vérification → approbation → activation par QUATRE personnes distinctes ;
 *  - les constantes du § 37A (10 / 10 / 10 / 70) deviennent la V1 PROPOSÉE (valeurs par défaut, statut ACTE_REQUIS) :
 *    elles ne sont ni supprimées ni modifiées ;
 *  - mêmes codes de parts que la clé (GROUPE_NSEYA, TUTELLE, AGENTS_SOUS_TRAITANTS, GOUVERNEMENT_PROVINCIAL), mêmes deux
 *    flux (Flux 1 Groupe Nseya, Flux 2 Gouvernement provincial au Trésor), même arrondi (parts tronquées, solde au
 *    Gouvernement provincial).
 *
 * Toutes les valeurs de ce fichier sont PAR DÉFAUT — à confirmer par le maître d'ouvrage.
 */
import { Money, type CurrencyCode } from '@mosolo/shared';
import { allocate, DEFAULT_SLICES, FLOW_CODES, REPARTITION_NOMBRE_FLUX, type FlowCode, type SliceCode, type SliceDef } from '../model.js';

/**
 * Identifiant de la règle de répartition : KIN-DEFAULT (spécification v1.0 du 29/09/2026, § 16) ; la v1 de la
 * spécification l'appelait « KIN-REV-001 » (alias conservé).
 */
export const REGLE_REPARTITION_ID = 'KIN-DEFAULT';
export const REGLE_REPARTITION_ALIAS = 'KIN-REV-001';
/** Date d'effet de la V1 proposée (spécification v1.0, § 16). */
export const V1_DATE_EFFET = '2026-10-01';

/** Pool des opérations de terrain — agent rattaché directement : part de l'agent (points de la transaction). PAR DÉFAUT. */
export const POOL_AGENT_DIRECT_PCT = '10';
/** Pool des opérations de terrain — agent rattaché directement : part du sous-traitant. PAR DÉFAUT. */
export const POOL_SOUS_TRAITANT_DIRECT_PCT = '0';
/** Pool — agent sous l'ombrelle d'un sous-traitant agréé : part de l'agent (7 points de la transaction). PAR DÉFAUT. */
export const POOL_AGENT_SOUS_TRAITANCE_PCT = '7';
/** Pool — agent sous l'ombrelle d'un sous-traitant agréé : part du sous-traitant (3 points). PAR DÉFAUT. */
export const POOL_SOUS_TRAITANT_SOUS_TRAITANCE_PCT = '3';
/** Canaux considérés comme ESPÈCES (points de paiement agréés, module 66). PAR DÉFAUT — le guichet bancaire est à arbitrer. */
// Décision du maître d'ouvrage (29/09/2026) : un paiement au guichet bancaire (canal BANK) compte comme espèces pour la
// part de Groupe Nseya — droit « à payer » que le Gouvernorat règle (jamais montré comme réglé d'avance).
export const CANAUX_ESPECES: readonly string[] = ['AGENT_POINT', 'BANK'];
/** Délai de grâce (jours) au-delà de la cadence de règlement avant qu'un droit soit « en retard ». PAR DÉFAUT. */
/** Délai de grâce avant « en retard » : 10 jours (décision du maître d'ouvrage du 29/09/2026 ; 5 jours auparavant). */
export const DELAI_GRACE_REGLEMENT_JOURS = 10;

export const PARAMETRES_MOTEUR_NOTE = 'Par défaut — à confirmer par le maître d’ouvrage (spécification du 29/09/2026).';

// ————————————————————————————————————————— modes de règlement (§ 4)

/**
 * Modes de règlement d'un bénéficiaire (§ 4). TEMPS_REEL (« REAL-TIME SPLIT », fractionnement chez le prestataire) :
 * décision du maître d'ouvrage du 29/09/2026 — admis SEULEMENT pour les deux flux du § 37A (Flux 1 Groupe Nseya,
 * Flux 2 Trésor) et seulement si l'infrastructure de paiement approuvée le permet (référence d'approbation) ; jamais
 * directement vers un ministère, un agent ou un sous-traitant (ce serait un troisième flux, § 37A.4).
 */
export const MODES_REGLEMENT = {
  TEMPS_REEL: 'Fractionnement en temps réel chez le prestataire (REAL-TIME SPLIT) — deux flux du § 37A seulement, infrastructure approuvée',
  T_PLUS_1: 'Le jour ouvré suivant (T+1)',
  HEBDOMADAIRE: 'Hebdomadaire (WEEKLY)',
  MENSUEL: 'Mensuel (MONTHLY)',
  SUR_FACTURE: 'Sur facture / demande de règlement (INVOICED)',
  CONSTATE_NON_EXIGIBLE: 'Constaté, non encore exigible (ACCRUED BUT NOT YET PAYABLE)',
} as const;
export type ModeReglement = keyof typeof MODES_REGLEMENT;
export const MODES_REGLEMENT_ACTIFS: readonly ModeReglement[] = ['T_PLUS_1', 'HEBDOMADAIRE', 'MENSUEL', 'SUR_FACTURE', 'CONSTATE_NON_EXIGIBLE'];
/** Cadence (jours) utilisée pour signaler un droit « en retard » ; null : pas d'échéance. */
export const CADENCE_JOURS: Record<ModeReglement, number | null> = { TEMPS_REEL: 0, T_PLUS_1: 1, HEBDOMADAIRE: 7, MENSUEL: 31, SUR_FACTURE: 30, CONSTATE_NON_EXIGIBLE: null };

// ————————————————————————————————————————— pool des opérations de terrain (§ 8, décision du 27/09/2026)

/**
 * Deux modes, HARMONISÉS :
 *  - PAR_RECETTE_GENEREE (décision du maître d'ouvrage du 29/09/2026, mode de la V1 proposée) : la part suit la recette
 *    éligible rapprochée générée par l'agent (agent direct 10 / 0 ; agent de sous-traitant 7 / 3, en POINTS de la
 *    transaction) ;
 *  - PAR_POINTS_QUALITE (décision du 27/09/2026, CONSERVÉ et disponible) : réserve par module répartie au prorata des
 *    points de résultats vérifiés × note de qualité (sanctions/reserve-agents.ts), jamais selon le montant.
 * Seul le circuit d'approbation d'une version de règle change de mode.
 */
export const MODES_POOL = {
  PAR_POINTS_QUALITE: 'Réserve par module, au prorata des points vérifiés × note de qualité (décision du 27/09/2026) — mode conservé, disponible',
  PAR_RECETTE_GENEREE: 'Selon la recette générée par l’agent : direct 10 / 0, sous-traitance 7 / 3 (décision du 29/09/2026, mode de la V1 proposée)',
} as const;
export type ModePool = keyof typeof MODES_POOL;

/**
 * Lecture des « 7 % » (§ 8) : 7 POINTS de la transaction d'origine (défaut, lecture du texte) ou 7 % DU POOL (« si
 * l'intention est 7 % des 10 %, le calcul doit changer ») — à arbitrer par le maître d'ouvrage.
 */
export const LECTURES_POOL = {
  POINTS_DE_LA_TRANSACTION: 'Points de la transaction d’origine (agent 7 %, sous-traitant 3 % de la recette)',
  POURCENTAGE_DU_POOL: 'Pourcentage du pool (agent et sous-traitant reçoivent un pourcentage de la part du pool ; le reste demeure en réserve)',
} as const;
export type LecturePool = keyof typeof LECTURES_POOL;

/** Relation agent ↔ entité ou sous-traitant (AgentAssignment, § 18). */
export const TYPES_AGENT = {
  DIRECT_GOVERNMENT: 'Agent rattaché directement au Gouvernement provincial (DIRECT_GOVERNMENT)',
  DIRECT_MINISTRY: 'Agent rattaché directement à un ministère (DIRECT_MINISTRY)',
  DIRECT_DEPARTMENT: 'Agent rattaché directement à un département / une régie (DIRECT_DEPARTMENT)',
  SUBCONTRACTOR_AGENT: 'Agent sous l’ombrelle d’un sous-traitant agréé (SUBCONTRACTOR_AGENT)',
} as const;
export type TypeAgent = keyof typeof TYPES_AGENT;

export interface PoolConfig {
  mode: ModePool;
  lecture: LecturePool;
  /** Agent rattaché directement : [agent, sous-traitant] en pourcentages (chaînes décimales). */
  direct: { agentPct: string; sousTraitantPct: string };
  /** Agent de sous-traitant : [agent, sous-traitant]. */
  sousTraitance: { agentPct: string; sousTraitantPct: string };
}

// ————————————————————————————————————————— coûts d'exploitation (§ 14)

/** Catégories de coûts technologiques (spécification v1.0, § 25) — nom français d'abord, terme anglais entre parenthèses. */
export const POSTES_COUTS = {
  IA: 'Intelligence artificielle (AI)', LLM_API: 'Modèles de langage et API (LLM/API)', HEBERGEMENT: 'Hébergement (Hosting)', CLOUD: 'Informatique en nuage (Cloud)',
  STOCKAGE: 'Stockage (Storage)', SMS: 'SMS', COURRIEL: 'Courriel (Email)', CARTES_SIG: 'Cartes et SIG (GIS/Maps)', API_PAIEMENT: 'API de paiement (Payment API)',
  VERIFICATION_IDENTITE: 'Vérification d’identité (Identity Verification)', CYBERSECURITE: 'Cybersécurité (Cybersecurity)', SUPERVISION: 'Supervision (Monitoring)', AUTRES: 'Autres (Other)',
} as const;
export type PosteCout = keyof typeof POSTES_COUTS;
export const MODES_COUTS = {
  AUCUN: 'Aucun traitement des coûts (défaut)',
  DEDUCTION_PART_GOUVERNORAT: 'Coûts déduits de la part du Gouvernorat : position nette (présentation, sans effet sur la répartition initiale)',
  FRAIS_GESTION_NSEYA: 'Groupe Nseya finance les services : coût tiers + pourcentage de gestion approuvé, JAMAIS confondu avec les 10 %',
} as const;
export type ModeCouts = keyof typeof MODES_COUTS;
export interface CoutsConfig { mode: ModeCouts; fraisGestionPct: string | null }

// ————————————————————————————————————————— versions de la règle (§ 15)

export type MethodePaiement = 'ELECTRONIQUE' | 'ESPECES';
export const METHODES: readonly MethodePaiement[] = ['ELECTRONIQUE', 'ESPECES'];

export interface BeneficiaireRegle {
  code: SliceCode;
  label: string;
  /** Pourcentage de la recette éligible (chaîne décimale, jusqu'à trois décimales). */
  pct: string;
  flow: FlowCode;
  /** Part qui reçoit le solde et les arrondis (Gouvernement provincial). */
  remainder: boolean;
  modeReglement: ModeReglement;
}

/** Types de bénéficiaires (§ 20) — nom français d'abord. */
export const TYPES_BENEFICIAIRE = {
  GOUVERNORAT: 'Gouvernorat (GOVERNORAT)', GROUPE_NSEYA: 'Groupe Nseya (GROUPE_NSEYA)', MINISTERE: 'Ministère (MINISTRY)', DEPARTEMENT: 'Département (DEPARTMENT)',
  AGENT: 'Agent (AGENT)', SOUS_TRAITANT: 'Sous-traitant (SUBCONTRACTOR)', RESERVE_POOL: 'Réserve du pool des opérations de terrain (non attribuée)',
} as const;
export type TypeBeneficiaire = keyof typeof TYPES_BENEFICIAIRE;

/** États d'un droit (§ 20, compléments) — nom français d'abord, terme anglais entre parenthèses. */
export const ETATS_DROIT = {
  CONSTATE: 'Constaté (ACCRUED)', APPROUVE: 'Approuvé (APPROVED)', PAYABLE: 'Payable (PAYABLE)', PARTIELLEMENT_REGLE: 'Partiellement réglé (PARTIALLY_SETTLED)',
  REGLE: 'Réglé (SETTLED)', CONTESTE: 'Contesté (DISPUTED)', CONTREPASSE: 'Contrepassé (REVERSED)', RECOUVRABLE: 'Contrepassé après règlement — solde recouvrable',
  RECOUVRE: 'Contrepassé — recouvré', EN_RETARD: 'En retard (OVERDUE)', NON_EXIGIBLE: 'Constaté, non exigible (ACCRUED BUT NOT YET PAYABLE)',
  SIMULATION: 'Simulation — règle non active, aucun droit exigible', BLOQUE: 'Bloqué — espèces encaissées hors point agréé (examen humain)',
} as const;
export type EtatDroit = keyof typeof ETATS_DROIT;

export type StatutVersion = 'ACTE_REQUIS' | 'PROPOSEE' | 'VERIFIEE' | 'APPROUVEE' | 'ACTIVE' | 'REJETEE';
export const STATUTS_VERSION: Record<StatutVersion, string> = {
  ACTE_REQUIS: 'Proposée par défaut — acte requis (valeurs à confirmer)',
  PROPOSEE: 'Proposée (rédaction)',
  VERIFIEE: 'Vérifiée (contrôle)',
  APPROUVEE: 'Approuvée (en attente d’activation)',
  ACTIVE: 'Active',
  REJETEE: 'Rejetée',
};

export interface VersionHistory { at: string; by: string; action: string; motif?: string }

export interface AllocationRuleVersion {
  /** `${ruleId}-V${version}` */
  id: string;
  ruleId: string;
  version: number;
  label: string;
  beneficiaries: BeneficiaireRegle[];
  scope: { revenus: string[]; modules: string[]; methodes: string[] };
  effectiveFrom: string;
  effectiveUntil: string | null;
  legalBasis: string;
  approvalDocument: string | null;
  pool: PoolConfig;
  couts: CoutsConfig;
  /** Fractionnement chez le prestataire (TEMPS_REEL) : référence de l'infrastructure approuvée, sinon null. */
  fractionnement?: { infrastructureApprouvee: string | null };
  status: StatutVersion;
  /** Valeurs par défaut du promoteur (§ 37A) tant qu'aucun acte ne les confirme. */
  parDefaut: boolean;
  createdBy: string;
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  activatedBy?: string;
  activatedAt?: string;
  history: VersionHistory[];
  demo?: boolean;
}

export const TOUT = '*';

/** Somme en millièmes de pour cent (trois décimales au plus) : null si un pourcentage est mal formé. */
export function pctMilli(pct: string): bigint | null {
  if (!/^\d{1,3}(\.\d{1,3})?$/.test(pct)) return null;
  const [i, f = ''] = pct.split('.');
  return BigInt(i!) * 1000n + BigInt(f.padEnd(3, '0'));
}
export function formatMilli(v: bigint): string {
  const neg = v < 0n; const a = neg ? -v : v;
  return `${neg ? '-' : ''}${a / 1000n}.${String(a % 1000n).padStart(3, '0')}`;
}
/** Somme des parts exprimée « 100.000 » (trois décimales). */
export function sumPct(bs: Pick<BeneficiaireRegle, 'pct'>[]): string | null {
  let s = 0n;
  for (const b of bs) { const v = pctMilli(b.pct); if (v === null) return null; s += v; }
  return formatMilli(s);
}

/** Erreurs de forme d'une version (vide : conforme). Contrôles rejoués à chaque étape du circuit et à l'activation. */
export function checkVersionShape(v: Pick<AllocationRuleVersion, 'beneficiaries' | 'pool' | 'couts'> & { fractionnement?: AllocationRuleVersion['fractionnement'] }): { code: string; message: string }[] {
  const out: { code: string; message: string }[] = [];
  const sum = sumPct(v.beneficiaries);
  if (sum === null) out.push({ code: 'POURCENTAGE_INVALIDE', message: 'Pourcentages attendus en chaînes décimales (trois décimales au plus).' });
  else if (sum !== '100.000') out.push({ code: 'SOMME_DIFFERENTE_DE_100', message: `La somme des parts vaut ${sum} % : l’activation exige exactement 100,000 %.` });
  if (v.beneficiaries.filter((b) => b.remainder).length !== 1) out.push({ code: 'SOLDE_UNIQUE', message: 'Une et une seule part reçoit le solde et les arrondis.' });
  const codes = v.beneficiaries.map((b) => b.code);
  if (new Set(codes).size !== codes.length) out.push({ code: 'BENEFICIAIRE_EN_DOUBLE', message: 'Un bénéficiaire figure deux fois.' });
  for (const c of DEFAULT_SLICES.map((s) => s.code)) if (!codes.includes(c)) out.push({ code: 'BENEFICIAIRE_MANQUANT', message: `Bénéficiaire obligatoire absent : ${c}.` });
  const flows = new Set(v.beneficiaries.map((b) => b.flow));
  if (flows.size > REPARTITION_NOMBRE_FLUX || [...flows].some((f) => !FLOW_CODES.includes(f))) out.push({ code: 'FLUX_NON_AUTORISE', message: 'Deux flux de décaissement seulement (§ 37A.4).' });
  if (v.beneficiaries.some((b) => b.code === 'GROUPE_NSEYA' && b.flow !== 'FLUX_1') || v.beneficiaries.some((b) => b.code !== 'GROUPE_NSEYA' && b.flow !== 'FLUX_2')) {
    out.push({ code: 'FLUX_NON_AUTORISE', message: 'Groupe Nseya est réglé par le Flux 1, toutes les autres parts par le Flux 2 (§ 37A.4).' });
  }
  if (v.beneficiaries.some((b) => b.modeReglement === 'TEMPS_REEL' && b.code !== 'GROUPE_NSEYA' && b.code !== 'GOUVERNEMENT_PROVINCIAL')) {
    out.push({ code: 'FRACTIONNEMENT_TROISIEME_FLUX', message: 'Fractionnement chez le prestataire admis pour les deux flux du § 37A seulement (Groupe Nseya, Trésor) : jamais directement vers un ministère, un agent ou un sous-traitant (troisième flux, § 37A.4).' });
  }
  if (v.beneficiaries.some((b) => b.modeReglement === 'TEMPS_REEL') && !v.fractionnement?.infrastructureApprouvee) {
    out.push({ code: 'FRACTIONNEMENT_NON_APPROUVE', message: 'Fractionnement en temps réel : référence d’approbation de l’infrastructure de paiement requise.' });
  }
  if (v.beneficiaries.some((b) => !(b.modeReglement in MODES_REGLEMENT))) out.push({ code: 'MODE_REGLEMENT_INCONNU', message: 'Mode de règlement inconnu.' });
  const pool = v.beneficiaries.find((b) => b.code === 'AGENTS_SOUS_TRAITANTS');
  const pm = pool ? pctMilli(pool.pct) : null;
  const pair = (p: { agentPct: string; sousTraitantPct: string }) => { const a = pctMilli(p.agentPct); const s = pctMilli(p.sousTraitantPct); return a === null || s === null ? null : a + s; };
  const d = pair(v.pool.direct); const st = pair(v.pool.sousTraitance);
  if (d === null || st === null) out.push({ code: 'POOL_INVALIDE', message: 'Parts agent / sous-traitant attendues en chaînes décimales.' });
  else if (v.pool.lecture === 'POINTS_DE_LA_TRANSACTION' && pm !== null && (d !== pm || st !== pm)) {
    out.push({ code: 'POOL_INCOHERENT', message: `Lecture « points de la transaction » : agent + sous-traitant doivent égaler la part du pool (${pool!.pct} %).` });
  } else if (v.pool.lecture === 'POURCENTAGE_DU_POOL' && (d > 100_000n || st > 100_000n)) {
    out.push({ code: 'POOL_INCOHERENT', message: 'Lecture « pourcentage du pool » : agent + sous-traitant ne dépassent pas 100 % du pool.' });
  }
  if (v.couts.mode === 'FRAIS_GESTION_NSEYA' && (v.couts.fraisGestionPct === null || pctMilli(v.couts.fraisGestionPct) === null)) {
    out.push({ code: 'FRAIS_GESTION_INVALIDE', message: 'Frais de gestion : pourcentage approuvé requis (distinct des 10 % de Groupe Nseya).' });
  }
  return out;
}

/** Clé du § 37A équivalente (codes, flux, solde) pour réutiliser le calcul exact existant (allocate). */
export function slicesOf(v: Pick<AllocationRuleVersion, 'beneficiaries'>): SliceDef[] {
  return v.beneficiaries.map((b) => {
    const d = DEFAULT_SLICES.find((s) => s.code === b.code)!;
    return { ...d, label: b.label, pct: b.pct, flow: b.flow, remainder: b.remainder };
  });
}

/** Version seed V1 : constantes du § 37A reprises TELLES QUELLES (proposées, par défaut, acte requis). */
export function defaultBeneficiaries(): BeneficiaireRegle[] {
  // Décision du maître d'ouvrage (29/09/2026) : Gouvernorat et Groupe Nseya tous les 7 jours ; ministères et opérations de
  // terrain mensuellement (T+1 reste disponible comme mode).
  const mode: Record<SliceCode, ModeReglement> = { GROUPE_NSEYA: 'HEBDOMADAIRE', TUTELLE: 'MENSUEL', AGENTS_SOUS_TRAITANTS: 'MENSUEL', GOUVERNEMENT_PROVINCIAL: 'HEBDOMADAIRE' };
  const label: Record<SliceCode, string> = {
    GROUPE_NSEYA: 'Groupe Nseya (investisseur et opérateur)', TUTELLE: 'Ministère / département responsable du module',
    AGENTS_SOUS_TRAITANTS: 'Pool des opérations de terrain (agents et sous-traitants)', GOUVERNEMENT_PROVINCIAL: 'Gouvernorat de Kinshasa (Gouvernement provincial)',
  };
  return DEFAULT_SLICES.map((s) => ({ code: s.code, label: label[s.code], pct: s.pct, flow: s.flow, remainder: s.remainder, modeReglement: mode[s.code] }));
}
/** Décision du maître d'ouvrage du 29/09/2026 : la V1 proposée répartit le pool PAR RECETTE GÉNÉRÉE (10 / 0 ; 7 / 3). */
export function defaultPool(): PoolConfig {
  return {
    mode: 'PAR_RECETTE_GENEREE', lecture: 'POINTS_DE_LA_TRANSACTION',
    direct: { agentPct: POOL_AGENT_DIRECT_PCT, sousTraitantPct: POOL_SOUS_TRAITANT_DIRECT_PCT },
    sousTraitance: { agentPct: POOL_AGENT_SOUS_TRAITANCE_PCT, sousTraitantPct: POOL_SOUS_TRAITANT_SOUS_TRAITANCE_PCT },
  };
}

// ————————————————————————————————————————— calcul d'une transaction

export type BeneficiaryKind = SliceCode | 'AGENT' | 'SOUS_TRAITANT';

export interface AllocationLine {
  /** Bénéficiaire : GOUVERNORAT, GROUPE_NSEYA, ENTITE:<id>, POOL:<module>, AGENT:<id>, SOUS_TRAITANT:<id>. */
  beneficiary: string;
  kind: BeneficiaryKind;
  beneficiaryType: TypeBeneficiaire;
  /** Part d'origine de la clé (le pool se subdivise en agent / sous-traitant / réserve). */
  slice: SliceCode;
  label: string;
  /** Pourcentage effectif de la recette (information ; le calcul est exact en unités mineures). */
  pct: string;
  amount: { amount: string; currency: CurrencyCode };
  flow: FlowCode;
  modeReglement: ModeReglement;
}

export interface PoolTarget { agentId: string | null; agentType: TypeAgent | null; subcontractorId: string | null; module: string }

/**
 * Répartition exacte d'une transaction : parts de la clé (troncature, solde au Gouvernement provincial — calcul du
 * § 37A réutilisé), puis subdivision de la part du pool selon le mode de la version. La somme des lignes est TOUJOURS
 * égale à l'assiette.
 */
export function allocateTransaction(base: Money, v: Pick<AllocationRuleVersion, 'beneficiaries' | 'pool'>, ctx: { entity: string; entityLabel: string; entityType: 'MINISTERE' | 'DEPARTEMENT'; pool: PoolTarget }): AllocationLine[] {
  const slices = slicesOf(v);
  const parts = allocate(base, slices);
  const out: AllocationLine[] = [];
  const pctOf = (m: Money) => (base.isZero() ? '0.000' : formatMilli((m.minor * 100_000n) / base.minor));
  for (const p of parts) {
    const b = v.beneficiaries.find((x) => x.code === p.slice)!;
    const common = { slice: p.slice, flow: b.flow, modeReglement: b.modeReglement };
    if (p.slice === 'GOUVERNEMENT_PROVINCIAL') out.push({ ...common, beneficiary: 'GOUVERNORAT', kind: p.slice, beneficiaryType: 'GOUVERNORAT', label: b.label, pct: pctOf(p.amount), amount: p.amount.toJSON() });
    else if (p.slice === 'GROUPE_NSEYA') out.push({ ...common, beneficiary: 'GROUPE_NSEYA', kind: p.slice, beneficiaryType: 'GROUPE_NSEYA', label: b.label, pct: pctOf(p.amount), amount: p.amount.toJSON() });
    else if (p.slice === 'TUTELLE') out.push({ ...common, beneficiary: `ENTITE:${ctx.entity}`, kind: p.slice, beneficiaryType: ctx.entityType, label: `${b.label} — ${ctx.entityLabel}`, pct: pctOf(p.amount), amount: p.amount.toJSON() });
    else {
      const poolLine = (m: Money): AllocationLine => ({ ...common, beneficiary: `POOL:${ctx.pool.module}`, kind: p.slice, beneficiaryType: 'RESERVE_POOL', label: `Réserve du pool — module ${ctx.pool.module}`, pct: pctOf(m), amount: m.toJSON() });
      const t = ctx.pool;
      if (v.pool.mode === 'PAR_POINTS_QUALITE' || !t.agentId || !t.agentType) { out.push(poolLine(p.amount)); continue; }
      const cfg = t.agentType === 'SUBCONTRACTOR_AGENT' && t.subcontractorId ? v.pool.sousTraitance : v.pool.direct;
      let agent: Money; let sub: Money;
      if (v.pool.lecture === 'POINTS_DE_LA_TRANSACTION') {
        agent = base.percent(cfg.agentPct, 'DOWN');
        if (agent.compare(p.amount) > 0) agent = p.amount;
        sub = p.amount.subtract(agent);
      } else {
        agent = p.amount.percent(cfg.agentPct, 'DOWN');
        sub = p.amount.percent(cfg.sousTraitantPct, 'DOWN');
      }
      const rest = p.amount.subtract(agent).subtract(sub);
      out.push({ ...common, beneficiary: `AGENT:${t.agentId}`, kind: 'AGENT', beneficiaryType: 'AGENT', label: `Agent ${t.agentId}`, pct: pctOf(agent), amount: agent.toJSON() });
      if (t.agentType === 'SUBCONTRACTOR_AGENT' && t.subcontractorId && !sub.isZero()) {
        out.push({ ...common, beneficiary: `SOUS_TRAITANT:${t.subcontractorId}`, kind: 'SOUS_TRAITANT', beneficiaryType: 'SOUS_TRAITANT', label: `Sous-traitant ${t.subcontractorId}`, pct: pctOf(sub), amount: sub.toJSON() });
      } else if (!sub.isZero()) out.push(poolLine(sub));
      if (!rest.isZero()) out.push(poolLine(rest));
    }
  }
  return out;
}

export function sumLines(lines: { amount: { amount: string; currency: CurrencyCode } }[], currency: CurrencyCode): Money {
  return lines.reduce((a, l) => a.add(Money.fromJSON(l.amount)), Money.zero(currency));
}

// ————————————————————————————————————————— rattachement officiel module → entité (§ 7)

/**
 * Module du catalogue (M01…M81, V-<verticale>) d'un code de règle — PAR DÉFAUT, à confirmer : rattachement indicatif par
 * motif, comme la tutelle indicative du § 37A. Une fiche de module ACTIVE qui cite la règle l'emporte toujours.
 */
export const MODULE_DES_REGLES: { pattern: RegExp; module: string }[] = [
  { pattern: /(^|-)IRL(-|$)|LOCATI/, module: 'V-locatif' },
  { pattern: /(^|-)(IF|IMPOT|FONCIER|NFIU)(-|$)/, module: 'V-propriete' },
  { pattern: /(VEH|VIGNETTE)/, module: 'M11' },
  { pattern: /(RKP|WEWA|BILLET)/, module: 'M76' },
  { pattern: /(STAT|PARK)/, module: 'M14' },
  { pattern: /(TRANSP)/, module: 'M12' },
  { pattern: /(EMBARQ)/, module: 'M13' },
  { pattern: /(AVIA)/, module: 'M62' },
  { pattern: /(PEAGE)/, module: 'M25' },
  { pattern: /(PORT|ACCOST)/, module: 'M24' },
  { pattern: /(PUB)/, module: 'M15' },
  { pattern: /(ANTENNE|TELECOM)/, module: 'M16' },
  { pattern: /(BOISSON|TABAC)/, module: 'M17' },
  { pattern: /(PLAST|ENVIRON)/, module: 'M18' },
  { pattern: /(ASSAIN|VOIRIE)/, module: 'M19' },
  { pattern: /(MARCHE|ETAL|DOMAINE)/, module: 'M20' },
  { pattern: /(SPECT|EVENEMENT|CULTURE)/, module: 'M21' },
  { pattern: /(CARRIERE|MINE)/, module: 'M22' },
  { pattern: /(FOREST)/, module: 'M23' },
  { pattern: /(PATENTE|ACTIVITE|COMMERCE)/, module: 'M10' },
];
export function moduleOfRule(ruleCode: string): string | null {
  const c = ruleCode.toUpperCase();
  return MODULE_DES_REGLES.find((m) => m.pattern.test(c))?.module ?? null;
}
export const ENTITE_A_RATTACHER = 'A_RATTACHER';
