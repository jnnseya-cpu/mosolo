/**
 * Réductions de créance (remises, exonérations, corrections à la baisse, réclamations, admissions en non-valeur).
 *
 * Doctrine :
 *  - aucun taux inventé : le taux maximal d'une remise ou d'une exonération est DÉCLARÉ dans la fiche de règle
 *    certifiée (quatre visas), soit dans sa table des taux (clés `taux_remise_max`, `plafond_remise`,
 *    `taux_exoneration_max`, éventuellement par rang : `taux_remise_max:2`), soit sur l'entrée d'exonération
 *    elle-même (`rate`, `maxAmount`) ; en l'absence de déclaration, aucune réduction n'est possible (acte requis) ;
 *  - plafond CUMULÉ sur toute la chaîne de remplacement (obligation originale → rectificatives) : une nouvelle
 *    demande sur la rectificative ne rouvre jamais le plafond ;
 *  - toute réduction accordée est tracée par l'événement d'audit `reduction.granted`
 *    ({ path, obligationId, fromAmount, toAmount, deciderId, taxpayerId }) consommé par le rapport des réductions.
 */
import { Money, type CurrencyCode, type MoneyJSON, type RuleSheet } from '@mosolo/shared';
import type { AuditActor, AuditLog } from '../../core/audit.js';
import type { Obligation } from './service.js';

/** Voies par lesquelles une créance peut être réduite (rapport des réductions). */
export type ReductionPath =
  | 'REMISE_RECOUVREMENT' | 'REMISE_REGISTRE' | 'RECLAMATION' | 'CORRECTION_DECLARATION'
  | 'EXONERATION_LIQUIDATION' | 'ADMISSION_NON_VALEUR' | 'CORRECTION_OBJET' | 'REEVALUATION_RANG';

/** Entrée d'exonération d'une fiche de règle, éventuellement complétée d'un taux et d'un plafond déclarés. */
export type DeclaredExemption = RuleSheet['exemptions'][number] & { rate?: string; maxAmount?: string };

const PCT = /^\d{1,3}(\.\d{1,6})?$/;
const AMOUNT = /^\d{1,15}(\.\d{1,6})?$/;

function validPct(v: string | undefined): string | undefined {
  if (!v || !PCT.test(v)) return undefined;
  const n = Number(v);
  return n > 0 && n <= 100 ? v : undefined;
}

function minPct(values: (string | undefined)[]): string | undefined {
  const ok = values.filter((v): v is string => v !== undefined);
  if (!ok.length) return undefined;
  return ok.reduce((a, b) => (Number(b) < Number(a) ? b : a));
}

export interface DeclaredReductionTerms {
  /** Pourcentage maximal de réduction (chaîne décimale, 100 = totale) ; absent ⇒ aucune réduction possible. */
  maxRate?: string;
  /** Plafond absolu (devise de la règle) ; absent ⇒ seul le taux s'applique. */
  cap?: Money;
  /** Origine de la déclaration (clé de la table des taux ou entrée d'exonération). */
  source: string[];
}

/**
 * Termes de réduction déclarés par la fiche de règle (jamais saisis par le demandeur).
 * `kind` : REMISE (remise gracieuse sur une créance) ou EXONERATION (réduction à la liquidation).
 */
export function declaredReductionTerms(rule: RuleSheet, kind: 'REMISE' | 'EXONERATION', localityRank?: number): DeclaredReductionTerms {
  const key = kind === 'REMISE' ? 'taux_remise_max' : 'taux_exoneration_max';
  const capKey = kind === 'REMISE' ? 'plafond_remise' : 'plafond_exoneration';
  const source: string[] = [];
  const table = rule.rateTable ?? {};
  const ranked = localityRank !== undefined ? table[`${key}:${localityRank}`] : undefined;
  const fromTable = validPct(ranked ?? table[key]);
  if (fromTable) source.push(ranked !== undefined ? `${key}:${localityRank}` : key);
  const fromEntries = minPct((rule.exemptions as DeclaredExemption[]).map((e) => validPct(e.rate)));
  if (fromEntries) source.push('exemptions[].rate');
  // Deux déclarations : la plus restrictive l'emporte.
  const maxRate = minPct([fromTable, fromEntries]);
  const caps: Money[] = [];
  const currency = rule.currency as CurrencyCode;
  const capRaw = table[capKey];
  if (capRaw && AMOUNT.test(capRaw)) { caps.push(Money.of(capRaw, currency)); source.push(capKey); }
  for (const e of rule.exemptions as DeclaredExemption[]) {
    if (e.maxAmount && AMOUNT.test(e.maxAmount)) { caps.push(Money.of(e.maxAmount, currency)); source.push('exemptions[].maxAmount'); }
  }
  const cap = caps.length ? caps.reduce((a, b) => (b.compare(a) < 0 ? b : a)) : undefined;
  return { ...(maxRate ? { maxRate } : {}), ...(cap ? { cap } : {}), source };
}

/** Réduction maximale autorisée par les termes déclarés sur une base donnée (arrondi vers le bas). */
export function maxReductionOn(base: Money, terms: DeclaredReductionTerms): Money {
  if (!terms.maxRate) return Money.zero(base.currency);
  let r = base.percent(terms.maxRate, 'DOWN');
  if (terms.cap && terms.cap.currency === base.currency && terms.cap.compare(r) < 0) r = terms.cap;
  return r;
}

/** Chaîne de remplacement d'une obligation, de l'originale (première) à celle fournie (dernière). */
export function replacementChain(get: (id: string) => Obligation | undefined, obligationId: string): Obligation[] {
  const chain: Obligation[] = [];
  const seen = new Set<string>();
  let cur = get(obligationId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.supersedes ? get(cur.supersedes) : undefined;
  }
  return chain;
}

/**
 * Remises déjà accordées sur la chaîne (tous circuits confondus : recouvrement et registre) :
 * somme des baisses des maillons dont la rectification est de type REMISE.
 */
export function remittedOnChain(chain: Obligation[]): Money {
  const currency = chain[0]!.amount.currency as CurrencyCode;
  let total = Money.zero(currency);
  for (let i = 1; i < chain.length; i++) {
    const link = chain[i]!;
    if (link.explanation.rectification?.decisionType !== 'REMISE') continue;
    const drop = Money.fromJSON(chain[i - 1]!.amount).subtract(Money.fromJSON(link.amount));
    if (!drop.isNegative()) total = total.add(drop);
  }
  return total;
}

/**
 * Remise encore disponible sur une obligation : plafond déclaré appliqué au montant ORIGINAL de la chaîne,
 * moins les remises déjà accordées sur toute la chaîne.
 */
export function remissionHeadroom(get: (id: string) => Obligation | undefined, obligationId: string, rule: RuleSheet, localityRank?: number) {
  const chain = replacementChain(get, obligationId);
  const original = Money.fromJSON(chain[0]!.amount);
  const terms = declaredReductionTerms(rule, 'REMISE', localityRank);
  const max = maxReductionOn(original, terms);
  const already = remittedOnChain(chain);
  const available = max.subtract(already);
  return { terms, original, max, already, available: available.isNegative() ? Money.zero(original.currency) : available, chain };
}

/** Événement normalisé `reduction.granted` (rapport des réductions et alertes d'intégrité). */
export function recordReductionGranted(audit: AuditLog, actor: AuditActor, p: {
  path: ReductionPath; obligationId: string; fromAmount: MoneyJSON; toAmount: MoneyJSON; deciderId: string; taxpayerId: string;
  resultingObligationId?: string; sourceId?: string; approvers?: string[]; basis?: string;
}): void {
  audit.append({
    actor, action: 'reduction.granted', resourceType: 'obligation', resourceId: p.obligationId,
    details: {
      path: p.path, obligationId: p.obligationId, fromAmount: p.fromAmount, toAmount: p.toAmount, deciderId: p.deciderId, taxpayerId: p.taxpayerId,
      ...(p.resultingObligationId ? { resultingObligationId: p.resultingObligationId } : {}),
      ...(p.sourceId ? { sourceId: p.sourceId } : {}),
      ...(p.approvers ? { approvers: p.approvers } : {}),
      ...(p.basis ? { basis: p.basis } : {}),
    },
  });
}

/** Décimal en chaîne → entier mis à l'échelle 10⁶ (comparaisons exactes, sans flottant). */
export function scaledDecimal(v: string): bigint | null {
  if (!AMOUNT.test(v)) return null;
  const [i, f = ''] = v.split('.');
  return BigInt(i!) * 1_000_000n + BigInt(f.padEnd(6, '0'));
}
