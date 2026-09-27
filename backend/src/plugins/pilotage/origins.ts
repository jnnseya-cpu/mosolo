/**
 * Ventilation par origine (§ 8.7) : « les tableaux de bord séparent toujours recettes nouvelles, régularisation
 * d'arriérés, amélioration du rapprochement et simple reclassement ». Calculée sur les recettes RAPPROCHÉES (niveau 9)
 * de la période, chaque paiement étant classé dans UNE seule origine (priorité décroissante ci-dessous) : la somme des
 * origines égale donc exactement le rapproché de la période, par devise. Aucun montant n'est estimé.
 */
import type { MoneyJSON } from '@mosolo/shared';
import { DAY_MS, kinshasaDay } from '../../core/clock.js';
import type { Facts, OrderFact } from './facts.js';
import { isReconciled, matchesChannel, matchesDims, type Filters } from './ladder.js';
import { CurrencyTotals } from './money.js';

export const ORIGINS = ['RECLASSEMENT', 'RAPPROCHEMENT', 'ARRIERES', 'NOUVELLE', 'COURANTE'] as const;
export type Origin = (typeof ORIGINS)[number];

export const ORIGIN_LABELS: Record<Origin, { label: string; definition: string }> = {
  RECLASSEMENT: { label: 'Simple reclassement', definition: 'Paiement d’une obligation rectificative qui remplace une obligation antérieure : aucune recette nouvelle, l’assiette est seulement reclassée.' },
  RAPPROCHEMENT: { label: 'Amélioration du rapprochement', definition: 'Paiement resté sans appariement plus de 48 heures puis rapproché : résorption des suspens.' },
  ARRIERES: { label: 'Régularisation d’arriérés', definition: 'Paiement confirmé après l’échéance de l’obligation.' },
  NOUVELLE: { label: 'Recette nouvelle', definition: 'Paiement portant sur un objet recensé à partir de la date de référence (base de référence certifiée, sinon début de la période).' },
  COURANTE: { label: 'Recette courante (objets déjà connus)', definition: 'Paiement à l’échéance d’un objet déjà connu à la date de référence.' },
};

export interface OriginContext {
  facts: Facts;
  filters: Filters;
  convert: (m: MoneyJSON) => MoneyJSON;
  /** Obligations rectificatives (qui en remplacent une autre). */
  successorIds: Set<string>;
  /** Date de recensement des objets (AAAA-MM-JJ…). */
  objectCreatedAt: Map<string, string>;
  /** Date de référence : fin de la base de référence certifiée, à défaut début de la période ; null ⇒ « nouvelle » indéterminable. */
  referenceDate: string | null;
  referenceSource: 'BASE_CERTIFIEE' | 'DEBUT_PERIODE' | 'AUCUNE';
}

export function originOf(o: OrderFact, c: OriginContext, obligationDue: Map<string, string>, obligationObject: Map<string, string>): Origin {
  if (c.successorIds.has(o.obligationId)) return 'RECLASSEMENT';
  if (o.confirmedAt && o.reconciledAt && new Date(o.reconciledAt).getTime() - new Date(o.confirmedAt).getTime() > 2 * DAY_MS) return 'RAPPROCHEMENT';
  const due = obligationDue.get(o.obligationId);
  if (due && o.confirmedAt && kinshasaDay(o.confirmedAt) > due) return 'ARRIERES';
  const created = c.objectCreatedAt.get(obligationObject.get(o.obligationId) ?? '');
  if (c.referenceDate && created && created.slice(0, 10) >= c.referenceDate) return 'NOUVELLE';
  return 'COURANTE';
}

/** Ventilation du rapproché de la période par origine (montants par devise, contre-valeur CDF indicative). */
export function originsSplit(c: OriginContext) {
  const due = new Map(c.facts.obligations.map((o) => [o.id, o.dueDate]));
  const obj = new Map(c.facts.obligations.map((o) => [o.id, o.objectId]));
  const f = c.filters;
  const inRange = (ts: string) => { const d = kinshasaDay(ts); return (!f.from || d >= f.from) && (!f.to || d <= f.to); };
  const orders = c.facts.orders.filter((o) => isReconciled(o) && matchesDims(o, f) && matchesChannel(o, f) && inRange(o.reconciledAt!));
  const totals = new Map<Origin, { t: CurrencyTotals; n: number }>(ORIGINS.map((k) => [k, { t: new CurrencyTotals(), n: 0 }]));
  const all = new CurrencyTotals();
  for (const o of orders) {
    const k = originOf(o, c, due, obj);
    const cell = totals.get(k)!;
    cell.t.add(o.amount); cell.n++;
    all.add(o.amount);
  }
  return {
    basis: 'Recettes rapprochées (niveau 9) de la période ; chaque paiement relève d’une seule origine.',
    rule: 'Les tableaux séparent toujours recettes nouvelles, régularisation d’arriérés, amélioration du rapprochement et simple reclassement (§ 8.7).',
    reference: { date: c.referenceDate, source: c.referenceSource,
      note: c.referenceSource === 'BASE_CERTIFIEE' ? 'Date de référence : fin de la base de référence certifiée.'
        : c.referenceSource === 'DEBUT_PERIODE' ? 'Aucune base de référence certifiée : la date de référence est le début de la période filtrée.'
          : 'Aucune base de référence certifiée ni période : les recettes nouvelles ne sont pas distinguées des recettes courantes.' },
    rows: ORIGINS.map((k) => ({ origin: k, ...ORIGIN_LABELS[k], count: totals.get(k)!.n, amounts: totals.get(k)!.t.toJSON(), consolidatedCdf: totals.get(k)!.t.consolidated(c.convert) })),
    total: { count: orders.length, amounts: all.toJSON(), consolidatedCdf: all.consolidated(c.convert) },
  };
}
