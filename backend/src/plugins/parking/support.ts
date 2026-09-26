/**
 * Outils communs aux verticales du lot « stationnement et publicité » (ParkSmart, KIN PUB CONTROL) :
 * règle en vigueur du registre, état de paiement d'une obligation (circuit commun), sommes par devise,
 * publication d'une règle FICTIVE par le circuit à quatre visas (démonstration), paiement de démonstration
 * par rappel prestataire SIGNÉ (le même chemin que la production : aucun circuit parallèle).
 */
import { randomUUID } from 'node:crypto';
import { Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { AuditActor } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { hmacSha256Hex } from '../../core/crypto.js';
import { dec, decDiv, decToString } from '../../core/decimal.js';
import type { RuleInput, RuleRecord } from '../../modules/rules/service.js';

export const PAID_STATUSES = ['CONFIRME', 'REGLE', 'RAPPROCHE'] as const;

export const sha256Hex64 = /^[0-9a-f]{64}$/;

export function actorOf(u: User): AuditActor {
  return { kind: 'user', id: u.id, roles: u.roles };
}

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
  state: 'AUCUNE_REFERENCE' | 'REFERENCE_EMISE' | 'PAYE' | 'RAPPROCHE';
  paymentReference?: string;
  confirmedAt?: string;
  amount?: MoneyJSON;
}

/** État de paiement d'une obligation, lu dans le circuit commun (ordres de paiement + confirmations signées). */
export function paymentState(ctx: AppContext, obligationId: string | undefined): PaymentState {
  if (!obligationId) return { state: 'AUCUNE_REFERENCE' };
  const orders = ctx.payments.byObligation(obligationId);
  const paid = orders.find((o) => (PAID_STATUSES as readonly string[]).includes(o.status));
  if (paid) {
    return {
      state: paid.status === 'RAPPROCHE' ? 'RAPPROCHE' : 'PAYE',
      paymentReference: paid.paymentReference,
      ...(paid.confirmedAt ? { confirmedAt: paid.confirmedAt } : {}),
      amount: paid.amount,
    };
  }
  const now = ctx.clock.now();
  const open = orders.find((o) => o.status === 'INITIE' && new Date(o.expiresAt) > now);
  return open ? { state: 'REFERENCE_EMISE', paymentReference: open.paymentReference } : { state: 'AUCUNE_REFERENCE' };
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

/** Pourcentage « 62.5 » (une décimale) ; null si le dénominateur est nul. */
export function pct(num: number, den: number): string | null {
  if (den <= 0) return null;
  const tenths = Math.round((num * 1000) / den);
  return `${Math.trunc(tenths / 10)}.${Math.abs(tenths % 10)}`;
}

/** Plaque d'immatriculation normalisée (majuscules, sans espaces). */
export function normalizePlate(p: string): string {
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
  const res = ctx.payments.handleCallback(provider, { signature: hmacSha256Hex(secret, raw), nonce: randomUUID(), timestamp: ctx.clock.now().toISOString() }, raw);
  return res.status === 'CONFIRME';
}

/** Instruments et comptes partagés par les règles de démonstration du lot. */
export const DEMO_INSTRUMENT = 'demo-instrument-001';
export const DGTK_ALIAS = 'KIN-DGTK-RECETTES-01';
export const DGTK = 'DGTK';
