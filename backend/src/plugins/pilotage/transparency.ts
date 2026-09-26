/**
 * Transparence publique trimestrielle (§ 27.3 / § 27.4, module 54) : recettes RAPPROCHÉES par commune et par
 * catégorie, sans aucune donnée personnelle. Contrôle de divulgation avant publication (M54-S1) :
 *  - suppression primaire des cellules de moins de N contribuables distincts ;
 *  - règle de dominance : un contribuable ne peut représenter plus de 85 % d'une cellule ;
 *  - suppression secondaire (complémentaire) pour qu'aucune cellule masquée ne se déduise par différence ;
 *  - tranches d'effectifs (jamais le nombre exact) ; balayage des identifiants personnels.
 */
import { Money, UNATTRIBUTED_COMMUNE, type CurrencyCode } from '@mosolo/shared';
import type { Facts, OrderFact } from './facts.js';
import { isReconciled } from './ladder.js';

/** Seuil minimal de contribuables distincts par cellule publiée. */
export const MIN_CONTRIBUTORS = 5;
/** Part maximale d'un seul contribuable dans une cellule publiée (en pour cent). */
export const DOMINANCE_PCT = 85n;

export const CATEGORY_LABELS: Record<string, string> = {
  IMPOT_PROVINCIAL: 'Impôts provinciaux',
  INTERET_COMMUN: 'Taxes d’intérêt commun',
  PROVINCIAL_SPECIFIQUE: 'Recettes provinciales spécifiques',
  RECETTE_ETD: 'Recettes des entités territoriales décentralisées',
  RECETTE_CENTRALE: 'Recettes centrales (collecte pour compte)',
  PARTAGEE: 'Recettes partagées',
  DROIT_ADMINISTRATIF: 'Droits administratifs',
  REDEVANCE_SERVICE: 'Redevances de service',
  PENALITE: 'Pénalités',
  CONCESSION_DOMANIALE: 'Concessions domaniales',
  RECETTE_COMMERCIALE: 'Recettes commerciales',
  ACTE_REQUIS: 'Autres (acte requis)',
};

export type SuppressionReason = 'SEUIL' | 'DOMINANCE' | 'SECONDAIRE' | 'TOTAL';

export interface PublishedCell {
  currency: CurrencyCode;
  amount: string | null;
  contributors: string | null;
  suppressed: boolean;
  reason?: SuppressionReason;
}

export interface PublishedRow {
  key: string;
  label: string;
  cells: PublishedCell[];
}

export interface TransparencyContent {
  period: string;
  from: string;
  to: string;
  basis: string;
  threshold: number;
  byCommune: PublishedRow[];
  byCategory: PublishedRow[];
  totals: PublishedCell[];
  appeals: { decided: string | null; medianDays: string | null; suppressed: boolean };
  fundsUse: { published: false; note: string };
  method: string[];
}

interface Stat {
  amount: Money;
  byTaxpayer: Map<string, bigint>;
  suppressed: boolean;
  reason?: SuppressionReason;
}

function band(n: number): string {
  if (n >= 100) return '100 et plus';
  if (n >= 50) return '50 à 99';
  if (n >= 10) return '10 à 49';
  return `${MIN_CONTRIBUTORS} à 9`;
}

function newStat(currency: CurrencyCode): Stat {
  return { amount: Money.zero(currency), byTaxpayer: new Map(), suppressed: false };
}

function addTo(s: Stat, o: OrderFact) {
  const m = Money.fromJSON(o.amount);
  s.amount = s.amount.add(m);
  s.byTaxpayer.set(o.taxpayerId, (s.byTaxpayer.get(o.taxpayerId) ?? 0n) + m.minor);
}

function primary(s: Stat): void {
  if (s.byTaxpayer.size < MIN_CONTRIBUTORS) { s.suppressed = true; s.reason = 'SEUIL'; return; }
  const max = [...s.byTaxpayer.values()].reduce((a, b) => (b > a ? b : a), 0n);
  if (s.amount.minor > 0n && max * 100n > s.amount.minor * DOMINANCE_PCT) { s.suppressed = true; s.reason = 'DOMINANCE'; }
}

/** Suppression d'une dimension (par devise) ; retourne vrai si le total doit être masqué. */
function suppressDimension(rows: Map<string, Map<CurrencyCode, Stat>>, currency: CurrencyCode, totalSuppressed: boolean): void {
  const cells = [...rows.values()].map((r) => r.get(currency)).filter((s): s is Stat => !!s);
  cells.forEach(primary);
  if (totalSuppressed) {
    cells.forEach((c) => { if (!c.suppressed) { c.suppressed = true; c.reason = 'TOTAL'; } });
    return;
  }
  // Complémentaire : jamais une seule cellule masquée quand le total est publié.
  if (cells.filter((c) => c.suppressed).length === 1) {
    const candidate = cells.filter((c) => !c.suppressed).sort((a, b) => (a.amount.minor < b.amount.minor ? -1 : a.amount.minor > b.amount.minor ? 1 : 0))[0];
    if (candidate) { candidate.suppressed = true; candidate.reason = 'SECONDAIRE'; }
  }
}

export interface TransparencyBuild {
  content: TransparencyContent;
  /** Statistiques internes (jamais publiées) — servent au contrôle anti-ré-identification. */
  internal: { dimension: string; key: string; currency: CurrencyCode; contributors: number; suppressed: boolean; maxSharePct: string }[];
}

export function buildTransparency(facts: Facts, period: string, range: { from: string; to: string }): TransparencyBuild {
  const orders = facts.orders.filter((o) => isReconciled(o) && o.reconciledAt!.slice(0, 10) >= range.from && o.reconciledAt!.slice(0, 10) <= range.to);
  const dims: Record<'commune' | 'category', Map<string, Map<CurrencyCode, Stat>>> = { commune: new Map(), category: new Map() };
  const totals = new Map<CurrencyCode, Stat>();
  for (const o of orders) {
    const cur = o.amount.currency;
    for (const [dim, key] of [['commune', o.commune], ['category', o.category]] as const) {
      const row = dims[dim].get(key) ?? new Map<CurrencyCode, Stat>();
      const s = row.get(cur) ?? newStat(cur);
      addTo(s, o);
      row.set(cur, s);
      dims[dim].set(key, row);
    }
    const t = totals.get(cur) ?? newStat(cur);
    addTo(t, o);
    totals.set(cur, t);
  }
  for (const [cur, t] of totals) {
    primary(t);
    if (t.suppressed) t.reason = t.reason ?? 'SEUIL';
    suppressDimension(dims.commune, cur, t.suppressed);
    suppressDimension(dims.category, cur, t.suppressed);
  }
  const cellOf = (cur: CurrencyCode, s: Stat): PublishedCell => s.suppressed
    ? { currency: cur, amount: null, contributors: null, suppressed: true, reason: s.reason! }
    : { currency: cur, amount: s.amount.toDecimalString(), contributors: band(s.byTaxpayer.size), suppressed: false };
  const rowsOf = (m: Map<string, Map<CurrencyCode, Stat>>, label: (k: string) => string): PublishedRow[] =>
    [...m.entries()]
      .map(([key, r]) => ({ key, label: label(key), cells: [...r.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([c, s]) => cellOf(c, s)) }))
      .sort((a, b) => (a.key === UNATTRIBUTED_COMMUNE ? 1 : b.key === UNATTRIBUTED_COMMUNE ? -1 : a.label.localeCompare(b.label, 'fr')));

  const internal: TransparencyBuild['internal'] = [];
  const share = (s: Stat) => {
    if (s.amount.minor === 0n) return '0.0';
    const max = [...s.byTaxpayer.values()].reduce((a, b) => (b > a ? b : a), 0n);
    const t = (max * 1000n) / s.amount.minor;
    return `${t / 10n}.${t % 10n}`;
  };
  for (const [dim, m] of Object.entries(dims)) {
    for (const [key, r] of m) for (const [c, s] of r) internal.push({ dimension: dim, key, currency: c, contributors: s.byTaxpayer.size, suppressed: s.suppressed, maxSharePct: share(s) });
  }
  for (const [c, s] of totals) internal.push({ dimension: 'total', key: 'TOTAL', currency: c, contributors: s.byTaxpayer.size, suppressed: s.suppressed, maxSharePct: share(s) });

  // Délais de traitement des recours décidés dans la période (agrégat masqué sous le seuil).
  const decided = facts.appeals.filter((a) => a.decidedAt && a.decidedAt.slice(0, 10) >= range.from && a.decidedAt.slice(0, 10) <= range.to);
  const days = decided.map((a) => Math.round((new Date(a.decidedAt!).getTime() - new Date(a.submittedAt).getTime()) / 86_400_000)).sort((a, b) => a - b);
  const appealsSuppressed = decided.length < MIN_CONTRIBUTORS;

  return {
    content: {
      period, from: range.from, to: range.to,
      basis: 'Recettes rapprochées (niveau 9 de l’échelle) : appariement obligation – paiement – relevé du compte public.',
      threshold: MIN_CONTRIBUTORS,
      byCommune: rowsOf(dims.commune, (k) => (k === UNATTRIBUTED_COMMUNE ? 'Lieu non établi' : k)),
      byCategory: rowsOf(dims.category, (k) => CATEGORY_LABELS[k] ?? k),
      totals: [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([c, s]) => cellOf(c, s)),
      appeals: appealsSuppressed
        ? { decided: null, medianDays: null, suppressed: true }
        : { decided: band(decided.length), medianDays: String(days[Math.floor(days.length / 2)]), suppressed: false },
      fundsUse: { published: false, note: 'Emploi des fonds par programme : publié lorsque le module d’affectation sera en service (budget voté, § 27).' },
      method: [
        `Cellule publiée seulement si au moins ${MIN_CONTRIBUTORS} contribuables distincts y contribuent.`,
        `Cellule masquée si un seul contribuable en représente plus de ${DOMINANCE_PCT} %.`,
        'Masquage complémentaire : aucune cellule masquée ne peut être retrouvée par différence avec le total.',
        'Effectifs publiés par tranches, jamais en nombre exact ; aucun nom, identifiant, adresse ni référence de paiement.',
        'Montants dans la devise légale de chaque obligation, jamais additionnés entre devises.',
        'Commune du fait générateur (lieu de l’objet ou du service), jamais l’adresse du contribuable (§ 20.3).',
      ],
    },
    internal,
  };
}

export interface ReidentificationCheck {
  passed: boolean;
  checks: { code: string; label: string; passed: boolean; detail: string }[];
}

/** Test anti-ré-identification exécuté avant toute publication (M54-S1). */
export function reidentificationCheck(build: TransparencyBuild, personalTokens: string[]): ReidentificationCheck {
  const serialized = JSON.stringify(build.content);
  const published = build.internal.filter((c) => !c.suppressed);
  const underThreshold = published.filter((c) => c.contributors < MIN_CONTRIBUTORS);
  const dominated = published.filter((c) => Number(c.maxSharePct) > Number(DOMINANCE_PCT));
  const singles: string[] = [];
  for (const dim of ['commune', 'category']) {
    const currencies = new Set(build.internal.filter((c) => c.dimension === dim).map((c) => c.currency));
    for (const cur of currencies) {
      const total = build.internal.find((c) => c.dimension === 'total' && c.currency === cur);
      const suppressed = build.internal.filter((c) => c.dimension === dim && c.currency === cur && c.suppressed).length;
      if (total && !total.suppressed && suppressed === 1) singles.push(`${dim}/${cur}`);
    }
  }
  const leaked = personalTokens.filter((t) => t.length >= 4 && serialized.includes(t));
  const forbiddenKeys = ['taxpayerId', 'paymentReference', 'fullName', 'phone', 'iuc', 'obligationId', 'receiptNumber'].filter((k) => serialized.includes(`"${k}"`));
  const checks = [
    { code: 'SEUIL', label: `Au moins ${MIN_CONTRIBUTORS} contribuables par cellule publiée`, passed: underThreshold.length === 0, detail: underThreshold.length ? `${underThreshold.length} cellule(s) sous le seuil.` : `${published.length} cellule(s) publiée(s) conformes.` },
    { code: 'DOMINANCE', label: `Aucun contribuable au-delà de ${DOMINANCE_PCT} % d’une cellule`, passed: dominated.length === 0, detail: dominated.length ? `${dominated.length} cellule(s) dominée(s).` : 'Conforme.' },
    { code: 'DIFFERENCE', label: 'Aucune cellule masquée déductible par différence', passed: singles.length === 0, detail: singles.length ? `Masquage isolé : ${singles.join(', ')}.` : 'Conforme.' },
    { code: 'IDENTIFIANTS', label: 'Aucun identifiant personnel (nom, téléphone, IUC, identifiant)', passed: leaked.length === 0, detail: leaked.length ? `${leaked.length} identifiant(s) détecté(s).` : `${personalTokens.length} identifiant(s) recherché(s), aucun trouvé.` },
    { code: 'CHAMPS', label: 'Aucun champ de niveau individuel (référence, contribuable, quittance)', passed: forbiddenKeys.length === 0, detail: forbiddenKeys.length ? forbiddenKeys.join(', ') : 'Conforme.' },
  ];
  return { passed: checks.every((c) => c.passed), checks };
}

