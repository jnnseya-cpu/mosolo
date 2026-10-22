/**
 * Grand livre public (module 59 de la Spécification fonctionnelle) — indicateurs et vérification du scellement.
 *
 *  - Écritures scellées et chaînées : la chaîne d'empreintes du grand livre est recalculée à la demande (aucune
 *    correction : une rupture est signalée et alerte l'audit).
 *  - Indicateur « écart grand livre / relevés » : total des lignes de relevés importées (crédits constatés sur les
 *    comptes publics) moins les entrées de fonds inscrites au compte public de recettes (débits hors contre-écritures,
 *    diminués des contre-écritures de ces entrées). Un écart positif = crédits constatés non encore inscrits (lignes en
 *    exception) ; négatif = inscriptions sans relevé importé. Calculé sur les données réelles, jamais estimé.
 *  - Indicateur « délai de clôture » : pour chaque clôture quotidienne, heures entre la fin de la journée clôturée
 *    (minuit, heure de Kinshasa) et la clôture signée ; arriéré courant = journée non clôturée la plus ancienne.
 */
import type { FastifyInstance } from 'fastify';
import { Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { requireUser, type User } from '../../core/auth.js';
import { DAY_MS, HOUR_MS } from '../../core/clock.js';
import { authorize } from '../../core/policy.js';
import { kinDate, type TresorService } from './service.js';

/** Fin (exclusive) d'une journée de Kinshasa AAAA-MM-JJ, en millisecondes UTC (Kinshasa = UTC+1, sans heure d'été). */
function endOfKinDay(date: string): number {
  return Date.parse(`${date}T00:00:00+01:00`) + DAY_MS;
}

/** Fin (exclusive) d'un mois de Kinshasa AAAA-MM. */
function endOfKinMonth(month: string): number {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return Date.parse(`${next}-01T00:00:00+01:00`);
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
};

export class GrandLivreService {
  /** Rupture déjà signalée (une alerte par empreinte de tête). */
  private alertedBreak: string | undefined;

  constructor(private readonly ctx: AppContext, private readonly tresor: TresorService) {}

  /** Vérifie la chaîne d'empreintes du grand livre ; une rupture lève une alerte critique (une seule fois). */
  verification(user: User) {
    authorize(user, 'tresor:closure.read');
    const r = this.ctx.ledger.verifyChain();
    if (!r.valid && this.alertedBreak !== `${r.brokenAt}:${r.headHash}`) {
      this.alertedBreak = `${r.brokenAt}:${r.headHash}`;
      this.ctx.alerts.raise({
        type: 'LEDGER_CHAIN_BROKEN', severity: 'CRITICAL', source: 'tresor',
        detail: `Grand livre : scellement rompu à l'écriture ${r.brokenAt} (${r.reason}). Aucune correction automatique : enquête requise.`,
        context: { brokenAt: r.brokenAt, reason: r.reason }, notifyRoles: ['R22', 'R17'],
      });
    }
    this.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'ledger.chain.verified', resourceType: 'ledger', resourceId: 'grand-livre', outcome: r.valid ? 'SUCCESS' : 'FAILURE', details: { entries: r.entries, brokenAt: r.brokenAt ?? null } });
    return { ...r, closures: this.tresor.verifyClosures(), verifiedAt: this.ctx.clock.now().toISOString() };
  }

  /** Écart grand livre / relevés, par devise. */
  statementGap() {
    const statements = new Map<CurrencyCode, Money>();
    let partial = 0;
    for (const s of this.ctx.treasury.statements.all()) {
      if (s.lineTotals) {
        for (const t of s.lineTotals) statements.set(t.currency, (statements.get(t.currency) ?? Money.zero(t.currency)).add(Money.fromJSON(t)));
      } else {
        partial += 1;
      }
    }
    const ledgerIn = new Map<CurrencyCode, Money>();
    for (const e of this.ctx.ledger.list()) {
      for (const l of e.lines) {
        if (l.account !== 'COMPTE_PUBLIC_RECETTES') continue;
        const m = Money.fromJSON(l.amount);
        const cur = ledgerIn.get(m.currency) ?? Money.zero(m.currency);
        if (!e.reversalOf && l.side === 'DEBIT') ledgerIn.set(m.currency, cur.add(m));
        else if (e.reversalOf && l.side === 'CREDIT') ledgerIn.set(m.currency, cur.subtract(m));
      }
    }
    // Explication de l'écart : lignes de relevé encore en exception ouverte (non inscrites).
    const pending = new Map<CurrencyCode, { count: number; amount: Money }>();
    for (const e of this.ctx.treasury.openStatementExceptions()) {
      const m = Money.fromJSON(e.line!.amount);
      const p = pending.get(m.currency) ?? { count: 0, amount: Money.zero(m.currency) };
      pending.set(m.currency, { count: p.count + 1, amount: p.amount.add(m) });
    }
    const currencies = [...new Set<CurrencyCode>([...statements.keys(), ...ledgerIn.keys()])].sort();
    return {
      byCurrency: currencies.map((c) => {
        const st = statements.get(c) ?? Money.zero(c);
        const gl = ledgerIn.get(c) ?? Money.zero(c);
        const p = pending.get(c);
        return {
          currency: c, statements: st.toJSON(), ledger: gl.toJSON(), gap: st.subtract(gl).toJSON(), zero: st.equals(gl),
          pendingStatementLines: p?.count ?? 0, pendingAmount: (p?.amount ?? Money.zero(c)).toJSON() as MoneyJSON,
        };
      }),
      statementsWithoutTotals: partial,
      method: 'Relevés importés (total des lignes) − entrées de fonds inscrites au compte public de recettes (débits hors contre-écritures, moins les contre-écritures de ces entrées).',
    };
  }

  /** Délai de clôture quotidienne et mensuelle (heures), et arriéré courant. */
  closureDelay() {
    const now = this.ctx.clock.now();
    const daily = this.tresor.daily.all().map((d) => ({
      id: d.id, date: d.date, closedAt: d.closedAt, entries: d.entries,
      delayHours: round1(Math.max(0, (Date.parse(d.closedAt) - endOfKinDay(d.date)) / HOUR_MS)),
    }));
    const monthly = this.tresor.monthly.all().map((m) => ({
      id: m.id, month: m.month, closedAt: m.closedAt,
      delayDays: round1(Math.max(0, (Date.parse(m.closedAt) - endOfKinMonth(m.month)) / DAY_MS)),
    }));
    const lastSeq = this.tresor.daily.all().at(-1)?.toSeq ?? 0;
    const oldest = this.ctx.ledger.list().find((e) => e.seq > lastSeq);
    const oldestDay = oldest ? kinDate(oldest.at) : null;
    const delays = daily.map((d) => d.delayHours);
    return {
      daily: daily.slice(-30).reverse(), monthly: monthly.slice(-12).reverse(),
      medianDelayHours: median(delays), averageDelayHours: delays.length ? round1(delays.reduce((a, b) => a + b, 0) / delays.length) : null,
      lastDelayHours: daily.at(-1)?.delayHours ?? null,
      backlog: {
        oldestUnclosedDate: oldestDay,
        // Journée non clôturée dont la fin est passée : heures écoulées depuis sa fin (0 si la journée est en cours).
        hoursSinceEnd: oldestDay ? round1(Math.max(0, (now.getTime() - endOfKinDay(oldestDay)) / HOUR_MS)) : null,
      },
      note: daily.length ? undefined : 'Aucune clôture quotidienne signée : délai non mesuré (aucune donnée source).',
    };
  }

  indicators(user: User) {
    authorize(user, 'tresor:closure.read');
    const chain = this.ctx.ledger.verifyChain();
    const balance = this.ctx.ledger.balance();
    return {
      generatedAt: this.ctx.clock.now().toISOString(),
      entries: balance.entries, balanced: balance.balanced, chain,
      reversals: this.ctx.ledger.list().filter((e) => !!e.reversalOf).length,
      ecartReleves: this.statementGap(),
      delaiCloture: this.closureDelay(),
      suspense: (() => {
        const open = this.tresor.suspense.find((s) => s.status === 'OUVERT');
        const ages = open.map((s) => Math.max(0, Math.floor((this.ctx.clock.now().getTime() - Date.parse(`${s.valueDate}T00:00:00+01:00`)) / DAY_MS)));
        return { open: open.length, oldestDays: ages.length ? Math.max(...ages) : 0 };
      })(),
    };
  }
}

export function registerGrandLivreRoutes(app: FastifyInstance, svc: GrandLivreService): void {
  app.get('/v1/tresor/grand-livre/indicateurs', async (req) => svc.indicators(requireUser(req)));
  app.get('/v1/tresor/grand-livre/verification', async (req) => svc.verification(requireUser(req)));
}
