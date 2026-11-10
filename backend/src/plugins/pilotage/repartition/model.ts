/**
 * Clé de répartition des recettes du § 37A (Cahier des exigences v2.9) — position du promoteur, NON ACTIVE.
 *
 * Groupe Nseya finance intégralement le système d'exploitation numérique (hors moyens physiques) et reçoit 10 % des
 * recettes générées par le système pendant 30 ans ; 10 % sont constatés au profit du ministère de tutelle du module,
 * 10 % en réserve des agents de terrain et sous-traitants (par module), 70 % (solde) pour le Gouvernement provincial.
 *
 * Assiette (§ 37A.3) : tout montant payé au moyen d'une référence MOSOLO, réglé sur le compte public ET rapproché
 * (états 8 et 9 de l'échelle du § 26.1) — jamais les montants liquidés, déclarés ou initiés. Remboursements et
 * contrepassations réduisent l'assiette. Les arrondis sont affectés au Gouvernement provincial.
 * Exécution (§ 37A.4) : deux flux de décaissement SEULEMENT — Flux 1 vers Groupe Nseya (10 %), Flux 2 vers le compte du
 * Gouvernement provincial au Trésor (90 %, dont les parts des ministères et de la réserve des agents, versées ensuite
 * par le Trésor selon les procédures publiques). Toute tentative de troisième flux est rejetée.
 *
 * Valeurs PAR DÉFAUT — à confirmer par le maître d'ouvrage : aucune n'entre en production avant l'acte juridique
 * provincial et les conditions du § 37A.8 (registre des seuils anti-fraude, catégorie « Répartition des recettes »).
 */
import { Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';

/** Part de Groupe Nseya (investisseur et opérateur) — Flux 1 (PAR DÉFAUT, à confirmer). */
export const REPARTITION_PART_NSEYA_PCT = 10;
/** Part constatée au profit du ministère de tutelle du module — Flux 2 (PAR DÉFAUT, à confirmer). */
export const REPARTITION_PART_TUTELLE_PCT = 10;
/** Réserve des agents de terrain et sous-traitants, tenue par module — Flux 2 (PAR DÉFAUT, à confirmer). */
export const REPARTITION_PART_AGENTS_PCT = 10;
/** Solde pour le budget du Gouvernement provincial — Flux 2 ; reçoit les arrondis (PAR DÉFAUT, à confirmer). */
export const REPARTITION_PART_GOUVERNEMENT_PCT = 70;
/** Durée du modèle à compter de la mise en service du pilote (PAR DÉFAUT, à confirmer). */
export const REPARTITION_DUREE_ANS = 30;
/** Nombre de flux de décaissement admis (§ 37A.4) : deux et deux seulement. */
export const REPARTITION_NOMBRE_FLUX = 2;

export type SliceCode = 'GROUPE_NSEYA' | 'TUTELLE' | 'AGENTS_SOUS_TRAITANTS' | 'GOUVERNEMENT_PROVINCIAL';
export type FlowCode = 'FLUX_1' | 'FLUX_2';
export const FLOW_CODES: readonly FlowCode[] = ['FLUX_1', 'FLUX_2'];

export interface SliceDef {
  code: SliceCode;
  label: string;
  /** Pourcentage en chaîne décimale (jamais de flottant dans le calcul). */
  pct: string;
  flow: FlowCode;
  /** Part qui reçoit le solde (et donc les arrondis) : le Gouvernement provincial. */
  remainder: boolean;
  /** Clé de la table de taux de la fiche du registre juridique. */
  rateKey: string;
  calcul: string;
}

export const FLOWS: Record<FlowCode, { label: string; beneficiary: string; note: string }> = {
  FLUX_1: { label: 'Flux 1 — compte de Groupe Nseya', beneficiary: 'Groupe Nseya', note: 'Part de l’investisseur et opérateur (10 %).' },
  FLUX_2: {
    label: 'Flux 2 — compte du Gouvernement provincial au Trésor', beneficiary: 'Gouvernement provincial',
    note: 'Parts des ministères de tutelle et de la réserve des agents constatées par MOSOLO, puis versées par le Trésor provincial selon les procédures budgétaires ; solde au budget provincial.',
  },
};

export const DEFAULT_SLICES: SliceDef[] = [
  { code: 'GROUPE_NSEYA', label: 'Groupe Nseya (investisseur et opérateur)', pct: String(REPARTITION_PART_NSEYA_PCT), flow: 'FLUX_1', remainder: false, rateKey: 'part_groupe_nseya', calcul: 'De toute recette générée par le système, pendant 30 ans' },
  { code: 'TUTELLE', label: 'Ministère de tutelle du module', pct: String(REPARTITION_PART_TUTELLE_PCT), flow: 'FLUX_2', remainder: false, rateKey: 'part_tutelle', calcul: 'Des recettes générées par le ou les modules placés sous son autorité' },
  { code: 'AGENTS_SOUS_TRAITANTS', label: 'Agents de terrain et sous-traitants', pct: String(REPARTITION_PART_AGENTS_PCT), flow: 'FLUX_2', remainder: false, rateKey: 'part_agents', calcul: 'Des recettes générées, en réserve par module, répartie selon les résultats vérifiés (§ 37A.5)' },
  { code: 'GOUVERNEMENT_PROVINCIAL', label: 'Gouvernement provincial', pct: String(REPARTITION_PART_GOUVERNEMENT_PCT), flow: 'FLUX_2', remainder: true, rateKey: 'part_gouvernement', calcul: 'Solde (reçoit les arrondis)' },
];

export const BASE_DEFINITION =
  'Recette générée par le système : tout montant payé au moyen d’une référence MOSOLO, réglé sur le compte public et rapproché (états 8 et 9 de l’échelle du § 26.1). Jamais les montants liquidés, déclarés ou initiés. Remboursements et contrepassations réduisent l’assiette ; les arrondis vont au Gouvernement provincial (§ 37A.3).';

/** Somme des pourcentages en centièmes (entiers) : doit valoir exactement 100 %. */
export function pctSumIs100(slices: Pick<SliceDef, 'pct'>[]): boolean {
  const cents = slices.reduce((a, s) => {
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(s.pct)) return Number.NaN;
    const [i, f = ''] = s.pct.split('.');
    return a + Number(i) * 100 + Number(f.padEnd(2, '0'));
  }, 0);
  return cents === 10_000;
}

/** Contrôle de cohérence d'une clé : quatre parts, un seul solde, deux flux seulement, somme 100 %. */
export function assertKeyShape(slices: SliceDef[]): void {
  if (!pctSumIs100(slices)) throw new Error('Clé de répartition : la somme des parts doit valoir exactement 100 %.');
  if (slices.filter((s) => s.remainder).length !== 1) throw new Error('Clé de répartition : une et une seule part reçoit le solde et les arrondis.');
  if (new Set(slices.map((s) => s.flow)).size > REPARTITION_NOMBRE_FLUX || slices.some((s) => !FLOW_CODES.includes(s.flow))) {
    throw new Error('Clé de répartition : deux flux de décaissement seulement (§ 37A.4).');
  }
}
assertKeyShape(DEFAULT_SLICES);

export interface SliceAmount { slice: SliceCode; amount: Money }

/**
 * Répartition exacte d'une assiette (unités mineures, BigInt) : chaque part non-solde est TRONQUÉE (arrondi vers le bas),
 * le solde (Gouvernement provincial) reçoit le reste — la somme des parts est toujours égale à l'assiette, sans perte.
 */
export function allocate(base: Money, slices: SliceDef[] = DEFAULT_SLICES): SliceAmount[] {
  if (base.isNegative()) throw new Error('Assiette négative : les régularisations se traitent par contre-écriture sur les répartitions suivantes.');
  let rest = base;
  const out: SliceAmount[] = [];
  for (const s of slices) {
    if (s.remainder) continue;
    const part = base.percent(s.pct, 'DOWN');
    rest = rest.subtract(part);
    out.push({ slice: s.code, amount: part });
  }
  const rem = slices.find((s) => s.remainder)!;
  out.push({ slice: rem.code, amount: rest });
  return slices.map((s) => out.find((o) => o.slice === s.code)!);
}

/** Montant de chaque flux (somme des parts qui y sont versées). */
export function flowsOf(parts: SliceAmount[], slices: SliceDef[], currency: CurrencyCode): Record<FlowCode, Money> {
  const acc: Record<FlowCode, Money> = { FLUX_1: Money.zero(currency), FLUX_2: Money.zero(currency) };
  for (const p of parts) {
    const flow = slices.find((s) => s.code === p.slice)!.flow;
    acc[flow] = acc[flow].add(p.amount);
  }
  return acc;
}

/**
 * Rattachement INDICATIF d'un module (code de règle) à son ministère de tutelle (§ 37A.5, « exemple indicatif, à
 * confirmer par arrêté ») ; à défaut : « à rattacher ». Le rattachement effectif relève de la table versionnée validée
 * par le comité de pilotage (§ 10A).
 */
export const TUTELLE_INDICATIVE: { pattern: RegExp; tutelle: string }[] = [
  { pattern: /(^|-)(IF|IRL|VEH|VIGNETTE|GR|IMPOT)(-|$)/, tutelle: 'Finances' },
  { pattern: /(STAT|PARK|RKP|WEWA|TRANSP|PEAGE|EMBARQ|AVIA)/, tutelle: 'Transports et mobilité' },
  { pattern: /(PUB|VOIRIE|CHANTIER|DOMAINE)/, tutelle: 'Infrastructures, urbanisme' },
  { pattern: /(PATENTE|MARCHE|ETAL|BOISSON)/, tutelle: 'Économie et commerce' },
  { pattern: /(PLAST|ASSAIN)/, tutelle: 'Environnement' },
  { pattern: /(CARRIERE|FOREST|MINE)/, tutelle: 'Mines, environnement' },
  { pattern: /(SPECT|EVENEMENT|CULTURE)/, tutelle: 'Culture' },
];
export const TUTELLE_A_RATTACHER = 'À rattacher (arrêté requis)';

export function tutelleOf(ruleCode: string): string {
  const code = ruleCode.toUpperCase();
  return TUTELLE_INDICATIVE.find((t) => t.pattern.test(code))?.tutelle ?? TUTELLE_A_RATTACHER;
}

export const moneyJSON = (m: Money): MoneyJSON => m.toJSON();
