/**
 * Grand livre public en partie double, en ajout seul (§ 20.2).
 * Chaque écriture est équilibrée par devise ; les écritures sont chaînées par hachage ;
 * aucune correction sans contre-écriture liée à l'original.
 */
import { Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { AuditActor, AuditLog } from '../../core/audit.js';
import type { Clock } from '../../core/clock.js';
import { canonicalJson, sha256Hex } from '../../core/crypto.js';
import { conflict, notFound, unprocessable } from '../../core/errors.js';
import { InMemoryAppendOnlyRepository } from '../../core/repository.js';

export const LEDGER_ACCOUNTS = {
  CREANCES_CONTRIBUABLES: 'Créances sur contribuables',
  RECETTES_CONSTATEES: 'Recettes constatées',
  FONDS_A_RECEVOIR_PRESTATAIRES: 'Fonds à recevoir des prestataires',
  COMPTE_PUBLIC_RECETTES: 'Compte public de recettes',
  /** Suspens (§ 20.1) : fonds arrivés sur un compte public mais non identifiés ; daté, justifié, apuré sous double validation. */
  COMPTE_ATTENTE: "Compte d'attente (suspens) — fonds non identifiés",
  /** Répartition du § 37A (module 73) : instruction de virement du Flux 1 (Groupe Nseya) validée à quatre yeux. */
  REPARTITION_FLUX_1: 'Répartition des recettes — Flux 1 (Groupe Nseya) instruit',
  /** Répartition du § 37A (module 73) : instruction de virement du Flux 2 (Gouvernement provincial) validée à quatre yeux. */
  REPARTITION_FLUX_2: 'Répartition des recettes — Flux 2 (Gouvernement provincial) instruit',
  /*
   * Comptes d'ordre (hors bilan) de la répartition du § 37A (modules 59 et 73). Chaque répartition est inscrite, en
   * partie double et en ajout seul : assiette au crédit, quatre parts au débit. SIMULATION tant que la clé est au statut
   * ACTE_REQUIS (aucun fonds ne bouge) ; RÉPARTITION ARRÊTÉE une fois la clé active (les flux réels sont inscrits en
   * REPARTITION_FLUX_1 / REPARTITION_FLUX_2). Ces comptes ne touchent ni le compte public de recettes ni les créances :
   * l'équilibre du grand livre, les rapprochements et les clôtures sont inchangés.
   */
  ORDRE_SIMULATION_ASSIETTE: 'Compte d’ordre — répartition SIMULÉE : assiette rapprochée (clé non active)',
  ORDRE_SIMULATION_PART_NSEYA: 'Compte d’ordre — répartition SIMULÉE : part Groupe Nseya (Flux 1)',
  ORDRE_SIMULATION_PART_TUTELLE: 'Compte d’ordre — répartition SIMULÉE : part ministère de tutelle (Flux 2)',
  ORDRE_SIMULATION_PART_AGENTS: 'Compte d’ordre — répartition SIMULÉE : réserve agents et sous-traitants (Flux 2)',
  ORDRE_SIMULATION_PART_GOUVERNEMENT: 'Compte d’ordre — répartition SIMULÉE : part Gouvernement provincial (Flux 2)',
  ORDRE_REPARTITION_ASSIETTE: 'Compte d’ordre — répartition ARRÊTÉE : assiette rapprochée',
  ORDRE_REPARTITION_PART_NSEYA: 'Compte d’ordre — répartition ARRÊTÉE : part Groupe Nseya (Flux 1)',
  ORDRE_REPARTITION_PART_TUTELLE: 'Compte d’ordre — répartition ARRÊTÉE : part ministère de tutelle (Flux 2)',
  ORDRE_REPARTITION_PART_AGENTS: 'Compte d’ordre — répartition ARRÊTÉE : réserve agents et sous-traitants (Flux 2)',
  ORDRE_REPARTITION_PART_GOUVERNEMENT: 'Compte d’ordre — répartition ARRÊTÉE : part Gouvernement provincial (Flux 2)',
} as const;
export type LedgerAccount = keyof typeof LEDGER_ACCOUNTS;

export interface LedgerLine {
  account: LedgerAccount;
  side: 'DEBIT' | 'CREDIT';
  amount: MoneyJSON;
}

export interface LedgerEntry {
  id: string;
  seq: number;
  at: string;
  eventType: string;
  description: string;
  sourceType: string;
  sourceId: string;
  lines: LedgerLine[];
  reversalOf?: string;
  reason?: string;
  prevHash: string;
  hash: string;
}

export class LedgerService {
  private readonly entries = new InMemoryAppendOnlyRepository<LedgerEntry>();

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
  ) {}

  /** Écriture simple à deux lignes (débit / crédit). */
  postPair(input: { eventType: string; description: string; sourceType: string; sourceId: string; debit: LedgerAccount; credit: LedgerAccount; amount: MoneyJSON }): LedgerEntry {
    return this.post({
      eventType: input.eventType,
      description: input.description,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      lines: [
        { account: input.debit, side: 'DEBIT', amount: input.amount },
        { account: input.credit, side: 'CREDIT', amount: input.amount },
      ],
    });
  }

  post(input: Omit<LedgerEntry, 'id' | 'seq' | 'at' | 'prevHash' | 'hash'>): LedgerEntry {
    assertBalanced(input.lines);
    const seq = this.entries.count() + 1;
    const prevHash = this.entries.all().at(-1)?.hash ?? '0'.repeat(64);
    const base = { ...input, id: `GL-${String(seq).padStart(8, '0')}`, seq, at: this.clock.now().toISOString(), prevHash };
    const entry = this.entries.append({ ...base, hash: sha256Hex(prevHash + canonicalJson(base)) });
    this.audit.append({
      actor: { kind: 'system', id: 'grand-livre' },
      action: 'ledger.entry.posted',
      resourceType: 'ledger_entry',
      resourceId: entry.id,
      details: { eventType: entry.eventType, sourceId: entry.sourceId, reversalOf: entry.reversalOf ?? null },
    });
    return entry;
  }

  /** Contre-écriture liée à l'original : seule forme de correction admise. */
  reverse(entryId: string, reason: string, actor: AuditActor): LedgerEntry {
    const original = this.entries.get(entryId);
    if (!original) throw notFound('LEDGER_ENTRY_NOT_FOUND', `Écriture inconnue : ${entryId}`);
    if (original.reversalOf) throw conflict('CANNOT_REVERSE_REVERSAL', 'Une contre-écriture ne se contrepasse pas ; passer une nouvelle écriture.');
    if (this.entries.findOne((e) => e.reversalOf === entryId)) throw conflict('ALREADY_REVERSED', `L'écriture ${entryId} est déjà contrepassée.`);
    const entry = this.post({
      eventType: 'REVERSAL',
      description: `Contre-écriture de ${entryId} : ${reason}`,
      sourceType: original.sourceType,
      sourceId: original.sourceId,
      lines: original.lines.map((l) => ({ ...l, side: l.side === 'DEBIT' ? 'CREDIT' : 'DEBIT' })),
      reversalOf: entryId,
      reason,
    });
    this.audit.append({ actor, action: 'ledger.entry.reversed', resourceType: 'ledger_entry', resourceId: entryId, details: { reversalId: entry.id, reason } });
    return entry;
  }

  get(id: string): LedgerEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Vérification du scellement (module 59 : « écritures scellées et chaînées ») : recalcule l'empreinte de chaque
   * écriture à partir de la précédente et de son contenu canonique, et contrôle la continuité des numéros de séquence
   * et l'équilibre de chaque écriture. La première rupture est signalée ; rien n'est corrigé.
   */
  verifyChain(): { valid: boolean; entries: number; headHash: string | null; brokenAt?: string; reason?: string } {
    const all = this.entries.all();
    let prev = '0'.repeat(64);
    for (let i = 0; i < all.length; i++) {
      const e = all[i]!;
      const { hash, ...base } = e;
      if (e.seq !== i + 1) return { valid: false, entries: all.length, headHash: all.at(-1)?.hash ?? null, brokenAt: e.id, reason: 'SEQUENCE_ROMPUE' };
      if (e.prevHash !== prev) return { valid: false, entries: all.length, headHash: all.at(-1)?.hash ?? null, brokenAt: e.id, reason: 'CHAINAGE_ROMPU' };
      if (sha256Hex(prev + canonicalJson(base)) !== hash) return { valid: false, entries: all.length, headHash: all.at(-1)?.hash ?? null, brokenAt: e.id, reason: 'EMPREINTE_INVALIDE' };
      try {
        assertBalanced(e.lines);
      } catch {
        return { valid: false, entries: all.length, headHash: all.at(-1)?.hash ?? null, brokenAt: e.id, reason: 'ECRITURE_DESEQUILIBREE' };
      }
      prev = hash;
    }
    return { valid: true, entries: all.length, headHash: all.at(-1)?.hash ?? null };
  }

  list(filter: { sourceId?: string } = {}): LedgerEntry[] {
    return filter.sourceId ? this.entries.find((e) => e.sourceId === filter.sourceId) : this.entries.all();
  }

  isReversed(id: string): boolean {
    return this.entries.findOne((e) => e.reversalOf === id) !== undefined;
  }

  balance() {
    const all = this.entries.all();
    const totals = new Map<CurrencyCode, { debit: Money; credit: Money }>();
    const accounts = new Map<string, Money>();
    for (const e of all) {
      for (const l of e.lines) {
        const m = Money.fromJSON(l.amount);
        const t = totals.get(m.currency) ?? { debit: Money.zero(m.currency), credit: Money.zero(m.currency) };
        if (l.side === 'DEBIT') t.debit = t.debit.add(m);
        else t.credit = t.credit.add(m);
        totals.set(m.currency, t);
        const key = `${l.account}|${m.currency}`;
        const signed = l.side === 'DEBIT' ? m : m.negate();
        accounts.set(key, (accounts.get(key) ?? Money.zero(m.currency)).add(signed));
      }
    }
    const byCurrency = [...totals.entries()].map(([currency, t]) => ({
      currency, debit: t.debit.toJSON(), credit: t.credit.toJSON(), balanced: t.debit.equals(t.credit),
    }));
    return {
      balanced: byCurrency.every((c) => c.balanced),
      entries: all.length,
      byCurrency,
      accounts: [...accounts.entries()].map(([k, v]) => {
        const [account, currency] = k.split('|') as [LedgerAccount, CurrencyCode];
        return { account, label: LEDGER_ACCOUNTS[account], currency, balance: v.toJSON() };
      }),
      headHash: all.at(-1)?.hash ?? null,
    };
  }
}

export function assertBalanced(lines: LedgerLine[]): void {
  if (lines.length < 2) throw unprocessable('LEDGER_UNBALANCED', 'Une écriture comporte au moins un débit et un crédit.');
  const sums = new Map<CurrencyCode, bigint>();
  for (const l of lines) {
    const m = Money.fromJSON(l.amount);
    if (m.isNegative() || m.isZero()) throw unprocessable('LEDGER_INVALID_AMOUNT', 'Montants de ligne strictement positifs requis.');
    sums.set(m.currency, (sums.get(m.currency) ?? 0n) + (l.side === 'DEBIT' ? m.minor : -m.minor));
  }
  for (const [c, v] of sums) if (v !== 0n) throw unprocessable('LEDGER_UNBALANCED', `Écriture déséquilibrée en ${c}.`);
}
