/**
 * Invariants financiers (audit de préparation à la production) — parcours scripté sur le socle :
 * solde d'ouverture → paiement confirmé → paiement en double (non affecté, compte d'attente, à rembourser) → échec
 * prestataire → solde de clôture. Contrôles : chaque écriture équilibrée par devise, débits = crédits, chaîne de
 * hachage intacte, clôture = ouverture + mouvements, et écart de rapprochement NUL entre les fonds annoncés par le
 * prestataire et les fonds inscrits au grand livre. Le rapport est imprimé (preuve pour docs/production-readiness.md).
 */
import { randomUUID } from 'node:crypto';
import { Money, type CurrencyCode } from '@mosolo/shared';
import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '../src/modules/treasury/ledger.js';
import { callbackBody, createOrder, setup, signedCallback } from './helpers.js';

/** Comptes de trésorerie (actif : fonds reçus ou à recevoir) : leur variation doit égaler les fonds annoncés. */
const CASH = new Set(['FONDS_A_RECEVOIR_PRESTATAIRES', 'COMPTE_PUBLIC_RECETTES']);

function totals(entries: LedgerEntry[]) {
  const byAccount = new Map<string, Money>();
  let debit = Money.zero('USD');
  let credit = Money.zero('USD');
  for (const e of entries) {
    for (const l of e.lines) {
      const m = Money.fromJSON(l.amount);
      if (m.currency !== 'USD') continue;
      const signed = l.side === 'DEBIT' ? m : m.negate();
      byAccount.set(l.account, (byAccount.get(l.account) ?? Money.zero('USD' as CurrencyCode)).add(signed));
      if (l.side === 'DEBIT') debit = debit.add(m);
      else credit = credit.add(m);
    }
  }
  return { byAccount, debit, credit };
}

describe('Invariants financiers — parcours scripté', () => {
  it('ouverture, crédits, débits, trop-perçu à rembourser, clôture : écart de rapprochement nul', async () => {
    const env = await setup();
    const ledger = env.app.ctx.ledger;
    const opening = ledger.list();
    const open = totals(opening);

    // 1. Paiement confirmé (150 USD) sur l'obligation de démonstration.
    const order = (await createOrder(env)).json();
    const ok = await signedCallback(env, callbackBody(env, order.paymentReference));
    expect(ok.json().status).toBe('CONFIRME');
    // 2. Même référence payée une seconde fois (autre transaction) : trop-perçu, jamais crédité à l'obligation.
    const dup = await signedCallback(env, callbackBody(env, order.paymentReference, { amount: '150.00', currency: 'USD' }, `TXN-DOUBLE-${randomUUID()}`));
    expect(dup.statusCode).toBeLessThan(500);
    // 3. Échec prestataire : aucun mouvement de fonds.
    const failed = await signedCallback(env, { ...callbackBody(env, order.paymentReference), status: 'FAILED' });
    expect(failed.statusCode).toBeLessThan(500);

    const all = ledger.list();
    const moves = all.slice(opening.length);
    const mv = totals(moves);
    const close = totals(all);
    const received = Money.fromJSON({ amount: '300.00', currency: 'USD' }); // 1 paiement + 1 doublon annoncés SUCCESS
    const cashIn = [...mv.byAccount].filter(([a]) => CASH.has(a)).reduce((s, [, m]) => s.add(m), Money.zero('USD'));

    // Invariants.
    const bal = ledger.balance();
    expect(bal.balanced).toBe(true);
    for (const e of all) {
      const sums = new Map<string, bigint>();
      for (const l of e.lines) { const m = Money.fromJSON(l.amount); sums.set(m.currency, (sums.get(m.currency) ?? 0n) + (l.side === 'DEBIT' ? m.minor : -m.minor)); }
      for (const v of sums.values()) expect(v).toBe(0n);
    }
    expect(mv.debit.equals(mv.credit)).toBe(true);
    expect(ledger.verifyChain().valid).toBe(true);
    for (const [acc, m] of close.byAccount) expect(m.equals((open.byAccount.get(acc) ?? Money.zero('USD')).add(mv.byAccount.get(acc) ?? Money.zero('USD')))).toBe(true);
    const ecart = received.subtract(cashIn);
    expect(ecart.isZero()).toBe(true);
    // Le doublon est au crédit du compte d'attente (dette à rembourser), jamais en recette ni sur l'obligation.
    expect((mv.byAccount.get('COMPTE_ATTENTE') ?? Money.zero('USD')).negate().toDecimalString()).toBe('150.00');
    expect((mv.byAccount.get('CREANCES_CONTRIBUABLES') ?? Money.zero('USD')).negate().toDecimalString()).toBe('150.00');

    console.log(JSON.stringify({
      rapport: 'invariants financiers (USD)',
      ouverture: { ecritures: opening.length, debits: open.debit.toDecimalString(), credits: open.credit.toDecimalString() },
      mouvements: { ecritures: moves.length, debits: mv.debit.toDecimalString(), credits: mv.credit.toDecimalString(), parCompte: Object.fromEntries([...mv.byAccount].map(([a, m]) => [a, m.toDecimalString()])) },
      cloture: { ecritures: all.length, debits: close.debit.toDecimalString(), credits: close.credit.toDecimalString() },
      fondsAnnonces: received.toDecimalString(), fondsInscrits: cashIn.toDecimalString(), ecartRapprochement: ecart.toDecimalString(),
      grandLivreEquilibre: bal.balanced, chaineIntacte: ledger.verifyChain().valid,
    }));
    await env.app.close();
  });
});
