/**
 * Agrégations pures de la trousse de visualisation (lib/aggregate.ts) : comptages, sommes exactes par devise (jamais
 * de mélange CDF / USD), contre-valeur seulement avec un taux fourni et affiché, jours / semaines / mois de Kinshasa
 * (UTC+1), repli « Autres », parts à 100 %, tendance face à la période précédente.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTRES, convertTotalsToCdf, countBy, currenciesOf, groupByDay, groupByMonth, groupByWeek, kinshasaDay, kinshasaMonth, kinshasaWeek,
  NON_RENSEIGNE, nextPeriod, periodLabel, periodRange, rateLabel, share, splitByCurrency, sumBy, sumMoney, topN, trend, trendOfSeries, trendVsPrevious,
} from '../src/lib/aggregate';

const pay = [
  { id: 1, statut: 'PAYE', commune: 'Gombe', montant: { amount: '1000.00', currency: 'CDF' as const }, at: '2026-09-26T22:30:00Z' },
  { id: 2, statut: 'PAYE', commune: 'Gombe', montant: { amount: '50.00', currency: 'USD' as const }, at: '2026-09-27T08:00:00Z' },
  { id: 3, statut: 'IMPAYE', commune: 'Limete', montant: { amount: '0.10', currency: 'CDF' as const }, at: '2026-09-20T12:00:00Z' },
  { id: 4, statut: 'EN_ATTENTE', commune: null, montant: { amount: '0.20', currency: 'CDF' as const }, at: null },
  { id: 5, statut: 'PAYE', commune: 'Limete', montant: { amount: '25.50', currency: 'USD' as const }, at: '2026-08-31T23:30:00Z' },
];

describe('comptages', () => {
  it('countBy : tri décroissant, clé absente = « Non renseigné », fonction de clé acceptée', () => {
    expect(countBy(pay, 'statut')).toEqual([{ key: 'PAYE', count: 3 }, { key: 'EN_ATTENTE', count: 1 }, { key: 'IMPAYE', count: 1 }]);
    expect(countBy(pay, 'commune').find((r) => r.key === NON_RENSEIGNE)?.count).toBe(1);
    expect(countBy(pay, (p) => p.montant.currency)).toEqual([{ key: 'CDF', count: 3 }, { key: 'USD', count: 2 }]);
    expect(countBy([], 'x' as never)).toEqual([]);
  });
});

describe('montants : devise par devise, exacts', () => {
  it('sumMoney n’additionne jamais deux devises et reste exact (0,10 + 0,20 = 0,30)', () => {
    const { totals, ignored } = sumMoney(pay.map((p) => p.montant));
    expect(totals.CDF).toEqual({ amount: '1000.30', currency: 'CDF' });
    expect(totals.USD).toEqual({ amount: '75.50', currency: 'USD' });
    expect(ignored).toBe(0);
    expect(sumMoney([{ amount: 'abc', currency: 'CDF' }, null]).ignored).toBe(1);
  });
  it('sumBy : totaux par clé et par devise ; splitByCurrency : une série par devise (CDF d’abord)', () => {
    const rows = sumBy(pay, 'commune', 'montant');
    const gombe = rows.find((r) => r.key === 'Gombe')!;
    expect(gombe.count).toBe(2);
    expect(gombe.totals).toEqual({ CDF: { amount: '1000.00', currency: 'CDF' }, USD: { amount: '50.00', currency: 'USD' } });
    expect(currenciesOf(rows)).toEqual(['CDF', 'USD']);
    const split = splitByCurrency(rows);
    expect(split.CDF!.map((r) => r.key).sort()).toEqual(['Gombe', 'Limete', NON_RENSEIGNE]);
    expect(split.USD!.map((r) => [r.key, r.value])).toEqual([['Gombe', 50], ['Limete', 25.5]]);
  });
  it('contre-valeur CDF : seulement avec un taux fourni, daté et sourcé ; devise sans taux = null (aucun taux inventé)', () => {
    const totals = sumMoney(pay.map((p) => p.montant)).totals;
    const r = { currency: 'USD' as const, cdfPerUnit: '2850', date: '2026-09-26', source: 'BCC (démo)' };
    const ok = convertTotalsToCdf(totals, [r]);
    expect(ok.cdf).toEqual({ amount: '216175.30', currency: 'CDF' });
    expect(ok.used).toEqual([r]);
    expect(rateLabel(r)).toMatch(/^1 USD = 2\s?850 CDF \(2026-09-26, BCC \(démo\)\)$/);
    const ko = convertTotalsToCdf(totals, []);
    expect(ko.cdf).toBeNull();
    expect(ko.missing).toEqual(['USD']);
  });
});

describe('temps de Kinshasa (UTC+1)', () => {
  it('jour, semaine ISO et mois de Kinshasa', () => {
    expect(kinshasaDay('2026-09-26T22:30:00Z')).toBe('2026-09-26');
    expect(kinshasaDay('2026-09-26T23:30:00Z')).toBe('2026-09-27'); // minuit passé à Kinshasa
    expect(kinshasaDay('2026-09-27')).toBe('2026-09-27');
    expect(kinshasaDay('pas une date')).toBeNull();
    expect(kinshasaMonth('2026-08-31T23:30:00Z')).toBe('2026-09');
    expect(kinshasaWeek('2026-09-27')).toBe('2026-S39'); // dimanche
    expect(kinshasaWeek('2026-09-28')).toBe('2026-S40'); // lundi
    expect(kinshasaWeek('2027-01-01')).toBe('2026-S53');
    expect(kinshasaWeek('2026-01-01')).toBe('2026-S01');
  });
  it('groupBy* : périodes vides comblées entre from et to ; éléments sans date comptés à part', () => {
    const g = groupByDay(pay, (p) => p.at, { from: '2026-09-25', to: '2026-09-27' });
    expect(g.groups.map((x) => [x.period, x.items.length])).toEqual([['2026-09-25', 0], ['2026-09-26', 1], ['2026-09-27', 1]]);
    expect(g.undated).toBe(1);
    const m = groupByMonth(pay, (p) => p.at);
    expect(m.groups.map((x) => [x.period, x.items.length])).toEqual([['2026-09', 4]]);
    const w = groupByWeek(pay, (p) => p.at, { from: '2026-S38', to: '2026-S39' });
    expect(w.groups.map((x) => x.period)).toEqual(['2026-S38', '2026-S39']);
    expect(w.groups[0]!.items.map((p) => p.id)).toEqual([3]);
  });
  it('suites de périodes et libellés français', () => {
    expect(nextPeriod('2026-12', 'month')).toBe('2027-01');
    expect(nextPeriod('2026-S53', 'week')).toBe('2027-S01');
    expect(periodRange('2026-02-27', '2026-03-01', 'day')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
    expect(periodLabel('2026-09', 'month')).toBe('sept. 26');
    expect(periodLabel('2026-09-27', 'day')).toBe('27 sept.');
    expect(periodLabel('2026-S39', 'week')).toBe('S39 2026');
  });
});

describe('rang, parts, tendance', () => {
  it('topN replie la traîne dans « Autres » (une traîne d’un seul élément reste nommée)', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((k, i) => ({ key: k, v: 10 - i }));
    const t = topN(rows, 4, (r) => ('v' in r ? r.v : 0));
    expect(t.rows).toHaveLength(5);
    expect(t.rows[4]).toEqual({ key: AUTRES, other: true, folded: ['e', 'f'], value: 11 });
    expect(topN(rows.slice(0, 5), 4, (r) => r.v).rows).toHaveLength(5);
  });
  it('share : plus fort reste, total exact de 100 ; total nul = non calculable', () => {
    const s = share([1, 1, 1]);
    expect(s.reduce((a, b) => a! + b!, 0)).toBe(100);
    expect(s).toEqual([34, 33, 33]);
    expect(share([2, 1], 1)).toEqual([66.7, 33.3]);
    expect(share([0, 0])).toEqual([null, null]);
  });
  it('trend : hausse, baisse, stable, indisponible ; % nul si la base vaut 0', () => {
    expect(trend(120, 100)).toMatchObject({ delta: 20, pct: 20, direction: 'HAUSSE' });
    expect(trend(80, 100)).toMatchObject({ pct: -20, direction: 'BAISSE' });
    expect(trend(5, 5).direction).toBe('STABLE');
    expect(trend(5, 0)).toMatchObject({ pct: null, direction: 'HAUSSE' });
    expect(trend(null, 3).direction).toBe('INDISPONIBLE');
    expect(trendOfSeries([1, 2, 4]).pct).toBe(100);
    const tv = trendVsPrevious(pay, (p) => p.at, () => 1, '2026-09-26', '2026-09-27');
    expect(tv).toMatchObject({ current: 2, previous: 0, previousFrom: '2026-09-24', previousTo: '2026-09-25' });
  });
});
