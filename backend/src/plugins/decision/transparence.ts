/**
 * Transparence publique — compléments du module 54, construits sur la publication trimestrielle existante du pilotage
 * (tableau signé, test anti-ré-identification, réalisations financées) :
 *  - PARTS DE RÉPARTITION par catégorie de bénéficiaire (§ 37A.6) : clé du § 37A appliquée aux recettes RAPPROCHÉES du
 *    trimestre, agrégats seulement ; mode SIMULATION tant que la clé n'est pas active (acte requis) ;
 *    publiée seulement si le trimestre a au moins MIN_CONTRIBUTORS contributeurs (anti-ré-identification) ;
 *  - INDICATEURS : consultations publiques (compteur agrégé par jour, sans adresse ni identifiant) ; publications à
 *    temps (première version publiée au plus tard N jours après la fin du trimestre — N PAR DÉFAUT, à confirmer).
 */
import { Money, type CurrencyCode, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { kinshasaDay } from '../../core/clock.js';
import { badRequest } from '../../core/errors.js';
import { authorize } from '../../core/policy.js';
import { isReconciled, periodRange, quarterOf } from '../pilotage/ladder.js';
import { allocate, DEFAULT_SLICES, type SliceDef } from '../pilotage/repartition/model.js';
import type { PilotageService } from '../pilotage/service.js';
import { MIN_CONTRIBUTORS } from '../pilotage/transparency.js';

/** Délai de publication après la fin du trimestre (jours) — PAR DÉFAUT, à confirmer par le maître d'ouvrage. */
export const PUBLICATION_DELAY_DAYS = 45;

type Repartition = { key(): { status: string; slices: SliceDef[]; version: number } };

export class TransparenceService {
  /** Consultations publiques par jour (AAAA-MM-JJ → nombre) : aucun identifiant, aucune adresse. */
  readonly consultations = new Map<string, number>();

  constructor(private readonly ctx: AppContext, private readonly pil: () => PilotageService) {}

  count() {
    const day = kinshasaDay(this.ctx.clock.now().toISOString());
    this.consultations.set(day, (this.consultations.get(day) ?? 0) + 1);
  }

  /** Parts de répartition du trimestre (public, agrégats). */
  shares(period: string) {
    if (!/^\d{4}-[TQ][1-4]$/.test(period)) throw badRequest('INVALID_PERIOD', 'Trimestre AAAA-Tn attendu.');
    const norm = period.replace('-Q', '-T');
    const range = periodRange(norm);
    const rep = this.ctx.ext.repartition as Repartition | undefined;
    const key = rep?.key();
    const slices = key?.slices ?? DEFAULT_SLICES;
    const mode = key?.status === 'ACTIVE' ? 'CLE_ACTIVE' : 'SIMULATION';
    const base = new Map<CurrencyCode, Money>();
    const contributors = new Set<string>();
    for (const o of this.pil().facts().orders) {
      if (!isReconciled(o)) continue;
      const d = kinshasaDay(o.reconciledAt!);
      if (d < range.from || d > range.to) continue;
      contributors.add(o.taxpayerId);
      base.set(o.amount.currency, (base.get(o.amount.currency) ?? Money.zero(o.amount.currency)).add(Money.fromJSON(o.amount)));
    }
    const suppressed = contributors.size < MIN_CONTRIBUTORS;
    return {
      period: norm, mode, keyVersion: key?.version ?? null,
      notice: mode === 'CLE_ACTIVE' ? 'Parts calculées sur les recettes rapprochées avec la clé de répartition en vigueur (§ 37A.6).' : 'Simulation : clé de répartition non encore active (acte juridique requis) ; pourcentages par défaut à confirmer par le maître d’ouvrage.',
      suppressed, threshold: MIN_CONTRIBUTORS,
      byCategory: suppressed ? [] : slices.map((s) => ({
        code: s.code, label: s.label, pct: s.pct,
        amounts: [...base.values()].map((m) => (allocate(m, slices).find((p) => p.slice === s.code)?.amount ?? Money.zero(m.currency)).toJSON()) as MoneyJSON[],
      })),
      method: 'Assiette : recettes rapprochées du trimestre (niveau 9). Aucune donnée individuelle ; trimestre masqué sous le seuil de contributeurs.',
    };
  }

  indicators(user: User) {
    authorize(user, 'pilotage:transparency.preview');
    // Conversion justifiée : lecture seule du dépôt des publications du pilotage, non exporté dans son type public.
    const pubs = (this.pil() as unknown as { publications: { all(): { period: string; version: number; publishedAt: string }[] } }).publications.all();
    const first = new Map<string, string>();
    for (const p of pubs) if (!first.has(p.period) || p.publishedAt < first.get(p.period)!) first.set(p.period, p.publishedAt);
    // Trimestres échus depuis le premier trimestre publiable (premier paiement rapproché) jusqu'au trimestre précédent.
    const facts = this.pil().facts();
    const firstRec = facts.orders.filter((o) => isReconciled(o)).map((o) => kinshasaDay(o.reconciledAt!)).sort()[0];
    const today = kinshasaDay(this.ctx.clock.now().toISOString());
    const quarters: { period: string; due: string; publishedAt: string | null; onTime: boolean | null }[] = [];
    if (firstRec) {
      let q = quarterOf(firstRec);
      const cur = quarterOf(today);
      while (q < cur) {
        const end = periodRange(q).to;
        const due = new Date(Date.parse(`${end}T00:00:00Z`) + PUBLICATION_DELAY_DAYS * 86_400_000).toISOString().slice(0, 10);
        const at = first.get(q) ?? null;
        quarters.push({ period: q, due, publishedAt: at, onTime: at ? kinshasaDay(at) <= due : due < today ? false : null });
        const [y, t] = q.split('-T');
        q = Number(t) === 4 ? `${Number(y) + 1}-T1` : `${y}-T${Number(t) + 1}`;
      }
    }
    const decided = quarters.filter((x) => x.onTime !== null);
    const total = [...this.consultations.values()].reduce((a, b) => a + b, 0);
    return {
      params: { publicationDelayDays: PUBLICATION_DELAY_DAYS, status: 'PAR_DEFAUT — à confirmer par le maître d’ouvrage' },
      quarters, consultationsByDay: [...this.consultations.entries()].sort().map(([day, count]) => ({ day, count })),
      indicators: [
        { code: 'CONSULTATIONS', label: 'Consultations publiques de la transparence', measured: true, value: String(total), unit: 'consultations', note: 'Compteur agrégé par jour, sans adresse ni identifiant.' },
        decided.length
          ? { code: 'PUBLICATIONS_A_TEMPS', label: 'Publications à temps', measured: true, value: ((decided.filter((x) => x.onTime).length * 100) / decided.length).toFixed(1), unit: '%', basis: { onTime: decided.filter((x) => x.onTime).length, due: decided.length } }
          : { code: 'PUBLICATIONS_A_TEMPS', label: 'Publications à temps', measured: false, value: null, unit: '%', reason: 'Aucun trimestre échu à publier (aucune recette rapprochée d’un trimestre clos).' },
      ],
    };
  }
}
