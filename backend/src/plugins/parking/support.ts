/**
 * Outils communs aux verticales du lot « stationnement et publicité » (ParkSmart, KIN PUB CONTROL) :
 * règle en vigueur du registre, état de paiement d'une obligation (circuit commun), sommes par devise,
 * publication d'une règle FICTIVE par le circuit à quatre visas (démonstration), paiement de démonstration
 * par rappel prestataire SIGNÉ (le même chemin que la production : aucun circuit parallèle).
 */
import { randomUUID } from 'node:crypto';
import { Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { signedCallbackHeaders } from '../../modules/payments/callback-signing.js';
import { dec, decDiv, decToString } from '../../core/decimal.js';
import type { PaymentOrder } from '../../modules/payments/service.js';
import type { RuleInput, RuleRecord } from '../../modules/rules/service.js';

export const PAID_STATUSES = ['CONFIRME', 'REGLE', 'RAPPROCHE'] as const;

export const sha256Hex64 = /^[0-9a-f]{64}$/;

export { actorOf } from '../../core/audit.js';

/** Principal technique de liquidation (jamais sélectionnable comme utilisateur de démonstration). */
export function enginePrincipal(id: string, name: string, entity: string): User {
  return { kind: 'user', id, name, roles: ['R11'], entity };
}

/** Dernière version ACTIVE d'une règle du registre (null ⇒ « acte requis »). */
export function activeRule(ctx: AppContext, code: string | null | undefined): RuleRecord | null {
  if (!code) return null;
  const candidates = ctx.rules.list().filter((r) => r.code === code && r.status === 'ACTIVE').sort((a, b) => b.version - a.version);
  return candidates[0] ?? null;
}

/** Dernière version (tous statuts) d'une règle — pour afficher son statut. */
export function latestRule(ctx: AppContext, code: string | null | undefined): RuleRecord | null {
  if (!code) return null;
  return ctx.rules.list().filter((r) => r.code === code).sort((a, b) => b.version - a.version)[0] ?? null;
}

export interface PaymentState {
  /** PARTIEL : une ou plusieurs échéances payées, solde restant dû (jamais présenté comme payé). */
  state: 'AUCUNE_REFERENCE' | 'REFERENCE_EMISE' | 'PARTIEL' | 'PAYE' | 'RAPPROCHE';
  paymentReference?: string;
  confirmedAt?: string;
  /** Montant payé (somme des ordres confirmés, réglés ou rapprochés). */
  amount?: MoneyJSON;
  /** Solde restant dû (paiement partiel). */
  remaining?: MoneyJSON;
}

const isPaid = (o: PaymentOrder) => (PAID_STATUSES as readonly string[]).includes(o.status);

/** Ordres de paiement indexés par obligation (une seule lecture pour un calcul d'ensemble). */
export function ordersByObligation(ctx: AppContext): Map<string, PaymentOrder[]> {
  const idx = new Map<string, PaymentOrder[]>();
  for (const o of ctx.payments.orders.all()) {
    const l = idx.get(o.obligationId);
    if (l) l.push(o); else idx.set(o.obligationId, [o]);
  }
  return idx;
}

export interface PaidOrder { id: string; amount: MoneyJSON; at: string; reconciled: boolean }

/** Ordres payés d'une obligation (échéance par échéance), du plus ancien au plus récent. */
export function paidOrders(ctx: AppContext, obligationId: string, index?: Map<string, PaymentOrder[]>): PaidOrder[] {
  const orders = index ? index.get(obligationId) ?? [] : ctx.payments.byObligation(obligationId);
  return orders.filter(isPaid)
    .map((o) => ({ id: o.id, amount: o.amount, at: o.confirmedAt ?? o.createdAt, reconciled: o.status === 'RAPPROCHE' }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** État de paiement d'une obligation, lu dans le circuit commun (ordres de paiement + confirmations signées). */
export function paymentState(ctx: AppContext, obligationId: string | undefined): PaymentState {
  if (!obligationId) return { state: 'AUCUNE_REFERENCE' };
  const orders = ctx.payments.byObligation(obligationId);
  const now = ctx.clock.now();
  const open = orders.find((o) => o.status === 'INITIE' && new Date(o.expiresAt) > now);
  const paid = orders.filter(isPaid).sort((a, b) => (a.confirmedAt ?? a.createdAt).localeCompare(b.confirmedAt ?? b.createdAt));
  if (paid.length) {
    const last = paid[paid.length - 1]!;
    const total = paid.slice(1).reduce((m, o) => m.add(Money.fromJSON(o.amount)), Money.fromJSON(paid[0]!.amount));
    // Paiement par échéances : tant qu'un solde reste dû, l'obligation n'est pas payée.
    const ob = ctx.assessment.obligations.get(obligationId);
    const remaining = ob && ob.status !== 'SOLDEE' ? Money.fromJSON(ob.amount).subtract(total) : null;
    if (remaining && remaining.compare(Money.zero(remaining.currency)) > 0) {
      return {
        state: 'PARTIEL', paymentReference: open?.paymentReference ?? last.paymentReference, ...(last.confirmedAt ? { confirmedAt: last.confirmedAt } : {}),
        amount: total.toJSON(), remaining: remaining.toJSON(),
      };
    }
    return {
      state: paid.every((o) => o.status === 'RAPPROCHE') ? 'RAPPROCHE' : 'PAYE',
      paymentReference: last.paymentReference,
      ...(last.confirmedAt ? { confirmedAt: last.confirmedAt } : {}),
      amount: total.toJSON(),
    };
  }
  return open ? { state: 'REFERENCE_EMISE', paymentReference: open.paymentReference } : { state: 'AUCUNE_REFERENCE' };
}

/** Mois civil « AAAA-MM » à Kinshasa (UTC+1), pour les totaux « ce mois ». */
export function kinshasaMonth(d: Date | string): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kinshasa', year: 'numeric', month: '2-digit' }).formatToParts(new Date(d));
  return `${p.find((x) => x.type === 'year')!.value}-${p.find((x) => x.type === 'month')!.value}`;
}

/** Somme par devise (jamais d'addition de devises différentes). */
export function sumByCurrency(items: MoneyJSON[]): MoneyJSON[] {
  const acc = new Map<string, Money>();
  for (const m of items) {
    const v = Money.fromJSON(m);
    const cur = acc.get(m.currency);
    acc.set(m.currency, cur ? cur.add(v) : v);
  }
  return [...acc.values()].map((m) => m.toJSON()).sort((a, b) => a.currency.localeCompare(b.currency));
}

/** Montant divisé par un effectif (recette par place, par m²…), arrondi à l'unité monétaire. */
export function perUnit(items: MoneyJSON[], units: string): MoneyJSON[] {
  if (dec(units) === 0n) return [];
  return items.map((m) => Money.of(decToString(decDiv(dec(m.amount), dec(units))), m.currency as CurrencyCode).toJSON());
}


/**
 * Forme STOCKÉE d'une plaque au stationnement (majuscules, espaces et soulignés remplacés par des tirets, tirets
 * conservés, validée par PLATE_RE). Distincte de la clé de comparaison partagée `normalizePlate` (lettres et chiffres
 * seuls) : les plaques de stationnement déjà enregistrées gardent leurs tirets.
 */
export function normalizeParkingPlate(p: string): string {
  return p.trim().toUpperCase().replace(/[\s_]+/g, '-');
}
export const PLATE_RE = /^[A-Z0-9][A-Z0-9-]{3,13}$/;

/**
 * Publie une règle FICTIVE par le circuit réel (rédaction, visa juridique, visa financier, publication :
 * quatre personnes distinctes du jeu de démonstration), puis la marque `demo` (aucune valeur juridique).
 */
export function publishDemoRule(ctx: AppContext, input: RuleInput): RuleRecord | null {
  const drafter = ctx.users.get('u-juriste-redacteur');
  const legal = ctx.users.get('u-juriste-verificateur');
  const fin = ctx.users.get('u-validateur-financier');
  const pub = ctx.users.get('u-autorite-publication');
  if (!drafter || !legal || !fin || !pub) return null;
  const existing = activeRule(ctx, input.code);
  if (existing) return existing;
  const rule = ctx.rules.create(drafter, input);
  ctx.rules.approve(drafter, rule.id, 'REDACTEUR');
  ctx.rules.approve(legal, rule.id, 'VERIFICATEUR_JURIDIQUE');
  ctx.rules.approve(fin, rule.id, 'VALIDATEUR_FINANCIER');
  ctx.rules.approve(pub, rule.id, 'AUTORITE_PUBLICATION');
  ctx.rules.rules.update({ ...ctx.rules.rules.get(rule.id)!, demo: true });
  return ctx.rules.get(rule.id);
}

/**
 * Paiement de DÉMONSTRATION d'une obligation par le circuit commun : ordre de paiement émis au nom du redevable,
 * puis rappel du prestataire de démonstration signé HMAC (nonce, horodatage) ⇒ quittance provisoire.
 */
export function demoPay(ctx: AppContext, payer: User, obligationId: string, provider = 'mm-operator-a'): boolean {
  const secret = ctx.secrets.providerSecrets[provider];
  if (!secret) return false;
  const order = ctx.payments.createOrder(payer, obligationId, { channel: 'MOBILE_MONEY' });
  const raw = JSON.stringify({
    providerTxnId: `DEMO-${randomUUID()}`, paymentReference: order.paymentReference, amount: order.amount, status: 'SUCCESS',
    completedAt: ctx.clock.now().toISOString(),
  });
  const res = ctx.payments.handleCallback(provider, signedCallbackHeaders(secret, raw, ctx.clock.now()), raw);
  return res.status === 'CONFIRME';
}

/** Instruments et comptes partagés par les règles de démonstration du lot. */
export const DEMO_INSTRUMENT = 'demo-instrument-001';
export const DGTK_ALIAS = 'KIN-DGTK-RECETTES-01';
export const DGTK = 'DGTK';
