import { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { formatMoney, type AIRecommendation, type MoneyJSON } from '@mosolo/shared';
import { useApp } from '../context';
import { useApi } from '../hooks/useApi';
import { PageHead } from '../components/Shell';
import { ChartCard, Legend } from '../components/ChartCard';
import { ChartTooltip, useChartColors } from '../components/charts';
import { AIInsightPanel } from '../components/AIInsightPanel';
import { StatusBadge, type Tone } from '../components/StatusBadge';
import { ErrorState, ExampleNotice, Loading } from '../components/States';
import { Icon } from '../components/Icon';
import { api, ApiError, describeError, NetworkError } from '../lib/api';
import { compact, convertIndicative, plotValue } from '../lib/money';
import { normalizeGovernor, type GovView } from '../lib/normalize';
import type { UIKey } from '../lib/i18n';
import { DEMO_ACTIONS, DEMO_GOVERNOR_RAW } from '../demo/governor';
import { Link } from 'react-router-dom';
import {
  DrillChart, ExportButton, FiltersBar, LadderChart, qs, ScopeLine, SeriesChart,
  type Amounts, type Contested, type DrillResult, type Filters, type Kpi, type LadderLevel, type Scope, type SeriesPoint,
} from '../modules/pilotage/shared';
import '../modules/pilotage/pilotage.css';
import {
  ChartGrid, DonutViz, fmtCompact, GaugeMeter, HeatGrid, KpiGrid, KpiTile, LadderFunnel, LineAreaViz, sixEtatsFromLadder, StatusDistribution,
} from '../components/viz';
import { countBy, periodLabel } from '../lib/aggregate';
import { CATEGORY_LABELS, CHANNEL_LABELS, KPI_STATUS, kpiTone, useFmt } from '../modules/pilotage/shared';

/** Tableau du Gouverneur calculé sur les données RÉELLES du socle (module pilotage). */
interface LiveGovernor {
  generatedAt: string; scope: Scope; ladder: LadderLevel[]; contested: Contested; kpis: Kpi[]; criticalAlerts: number;
  tiles: { today: string; confirmed: Record<'today' | 'yesterday', Amounts>; settled: Record<'today' | 'yesterday', Amounts>; reconciled: Record<'today' | 'yesterday', Amounts> };
  byCommune: DrillResult; byCategory: DrillResult; byEntity: DrillResult; byChannel?: DrillResult; series: SeriesPoint[];
}

/** Données réelles ; null si le module de pilotage n'est pas servi (serveur injoignable ou module absent). */
async function loadLive(filters: Filters): Promise<LiveGovernor | null> {
  try {
    return await api<LiveGovernor>(`/v1/pilotage/tableaux/gouverneur${qs({ ...filters })}`);
  } catch (e) {
    if (e instanceof NetworkError || (e instanceof ApiError && e.status === 404)) return null;
    throw e;
  }
}

type Disp = 'CDF' | 'USD';
const LADDER_GROUP: Record<string, number> = {
  potential: 0, verified_base: 0, assessed: 1, due: 1, overdue: 1, initiated: 2, confirmed: 2, settled: 3, reconciled: 3, recorded: 3, available: 3,
};

async function loadDashboard(): Promise<{ d: GovView; fallback: boolean }> {
  try {
    return { d: normalizeGovernor(await api<unknown>('/v1/dashboards/governor')), fallback: false };
  } catch (e) {
    if (e instanceof NetworkError) return { d: normalizeGovernor(DEMO_GOVERNOR_RAW), fallback: true };
    throw e;
  }
}

/**
 * Tuile d'indicateur du tableau (ancienne tuile « kpi ») : désormais une KpiTile de la trousse de visualisation, avec
 * le même libellé, la même valeur, le même état et la même ligne secondaire, plus tendance et courbe miniature.
 */
function Tile({ label, value, sub, tone, toneLabel, spark, sparkLabels, delta, hero }: {
  label: string; value: string; sub?: string; tone?: Tone; toneLabel?: string; spark?: number[]; sparkLabels?: string[];
  delta?: { current: number | null; previous: number | null; versus: string }; hero?: boolean;
}) {
  return (
    <KpiTile label={label} value={value === '—' ? null : value} reason="Pas encore calculable" sub={sub} hero={hero}
      state={tone && toneLabel ? { label: toneLabel, tone } : undefined}
      delta={delta ? { ...delta, format: fmtCompact } : undefined}
      spark={spark ? { values: spark, labels: sparkLabels, label: `${label} — 12 derniers mois (contre-valeur CDF)`, format: fmtCompact } : undefined} />
  );
}

/** Cible numérique lue dans le libellé de cible servi (« ≥ 95 % ») ; aucune cible inventée. */
function targetOf(label: string | undefined): { value: number; better: 'HAUSSE' | 'BAISSE' } | null {
  const m = label ? /([≥≤<>])\s*(\d+(?:[.,]\d+)?)\s*%/.exec(label) : null;
  return m ? { value: Number(m[2]!.replace(',', '.')), better: m[1] === '≥' || m[1] === '>' ? 'HAUSSE' : 'BAISSE' } : null;
}

/** Étiquette de valeur en bout de barre (une ligne, chiffres tabulaires). */
function barLabel(p: unknown, fmt: (v: number, l: string) => string, lang: string, color: string) {
  const { x, y, width, height, value } = p as { x?: number; y?: number; width?: number; height?: number; value?: number };
  if (x === undefined || y === undefined) return null;
  return <text x={Number(x) + Number(width ?? 0) + 6} y={Number(y) + Number(height ?? 0) / 2 + 4} fontSize={11} fill={color} style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(Number(value ?? 0), lang)}</text>;
}

/** Étiquette directe en fin de courbe (≤ 4 séries). */
function endLabel(p: unknown, n: number, text: string, color: string) {
  const { x, y, index } = p as { x?: number; y?: number; index?: number };
  if (index !== n - 1 || x === undefined || y === undefined) return null;
  return <text x={Number(x) + 8} y={Number(y) + 4} fontSize={12} fill={color} style={{ fontVariantNumeric: 'tabular-nums' }}>{text}</text>;
}

export default function Governor() {
  const { tr, fmtDate, lang, rates, user } = useApp();
  const { cat, theme } = useChartColors();
  const q = useApi(loadDashboard, [user?.id]);
  const ai = useApi<{ rec: AIRecommendation; example: boolean }>(async () => {
    try {
      return { rec: await api<AIRecommendation>('/v1/ai/insights', { method: 'POST', body: { context: 'governor' } }), example: false };
    } catch (e) {
      if (e instanceof NetworkError) return { rec: DEMO_ACTIONS[0]!, example: true };
      throw e;
    }
  }, [user?.id]);
  const [filters, setFilters] = useState<Filters>({});
  const live = useApi(() => loadLive(filters), [user?.id, JSON.stringify(filters)]);
  // Mois par mois, tous les niveaux (dont le réglé) : courbes miniatures des tuiles.
  const monthly = useApi(async () => {
    try { return await api<DrillResult>(`/v1/pilotage/drill/month${qs({ ...filters })}`); } catch { return null; }
  }, [user?.id, JSON.stringify(filters)]);
  const pf = useFmt();
  const [disp, setDisp] = useState<Disp>('CDF');
  const [sort, setSort] = useState<'value' | 'alpha'>('value');
  const [allCommunes, setAllCommunes] = useState(false);

  const d = q.data?.d;
  const fallback = q.data?.fallback ?? false;
  const usdRate = d?.exchange?.rate ?? rates?.rates.USD ?? null;
  const rateDate = d?.exchange?.date ?? rates?.date ?? '';
  const rateObj = useMemo(() => (usdRate ? { date: rateDate, rates: { USD: usdRate } } : null), [usdRate, rateDate]);
  const rateNum = usdRate ? Number(usdRate) : 1;
  const loc = lang === 'en' ? 'en' : 'fr';
  const nloc = loc === 'en' ? 'en-GB' : 'fr-FR';
  const dispMoney = (m: MoneyJSON): MoneyJSON => (disp === 'USD' ? convertIndicative(m, 'USD', rateObj) ?? m : m);
  const dispNum = (m: MoneyJSON) => plotValue(dispMoney(m));
  /** Conversion d'un cumul CDF (géométrie uniquement) */
  const dispCdf = (v: number) => (disp === 'USD' ? v / rateNum : v);
  const unit = disp === 'USD' ? '🇺🇸 USD' : '🇨🇩 CDF';
  const fmtC = (v: number) => `${compact(v, lang)} ${disp}`;
  const bigMoney = (m?: MoneyJSON) => { if (!m) return '—'; const x = dispMoney(m); return `${compact(plotValue(x), lang)} ${x.currency}`; };

  const communes = useMemo(() => {
    const list = (d?.communes ?? []).map((c) => ({ name: c.name, value: dispNum(c.amount), money: c.amount, compliance: c.compliance }));
    list.sort((a, b) => (sort === 'value' ? b.value - a.value : a.name.localeCompare(b.name, 'fr')));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justifié : dépendances volontairement restreintes aux valeurs listées (sinon boucle de rendu ou rechargement à chaque rendu)
  }, [d, sort, disp, rateObj]);
  const shownCommunes = allCommunes ? communes : communes.slice(0, 10);

  if (q.loading) return <div className="page"><Loading /></div>;
  if (q.error !== null || !d) return <div className="page"><PageHead title={tr('governor.title')} /><ErrorState error={q.error} onRetry={q.reload} /></div>;

  const t = d.tiles;
  const ex = d.example || fallback;
  const cats = d.categories.map((c) => ({ name: c.name, value: dispNum(c.amount), money: c.amount }));
  const catTotal = cats.reduce((s, c) => s + c.value, 0) || 1;
  const ladder = d.ladder.map((l) => ({ name: tr(`ladder.${l.level}` as UIKey), level: l.level, value: dispNum(l.amount), group: LADDER_GROUP[l.level] ?? 0 }));
  const groupNames = [tr('ladder.group.base'), tr('ladder.group.obligations'), tr('ladder.group.payments'), tr('ladder.group.treasury')];
  const trend = d.trend.map((p) => ({ label: p.label, actual: dispCdf(p.actual), target: dispCdf(p.target) }));
  const lastTrend = trend[trend.length - 1];
  const scen = d.scenarios.map((s) => {
    const o: Record<string, number | string | undefined> = { label: s.label, actual: s.actual !== undefined ? dispCdf(s.actual) : undefined };
    d.scenarioNames.forEach((_, i) => { const v = s[`s${i}`]; o[`s${i}`] = typeof v === 'number' ? dispCdf(v) : undefined; });
    return o;
  });
  const lastScen = scen[scen.length - 1];
  const rate = t.reconRate;
  const reconTone: Tone = rate === undefined ? 'neutral' : rate >= t.reconTarget ? 'good' : rate >= 90 ? 'warning' : 'critical';
  const alertTone: Tone = t.criticalAlerts > 0 ? 'critical' : 'good';
  const pct = (a?: MoneyJSON, b?: MoneyJSON) => (a && b && plotValue(b) ? Math.round((plotValue(a) / plotValue(b)) * 100) : 0);
  const scenColors = [cat[0]!, cat[1]!, cat[2]!];
  const L = live.data ?? null;
  const cdfOf = (a?: Amounts) => (a?.consolidatedCdf ? bigMoney(a.consolidatedCdf) : '—');
  /** Contre-valeur CDF indicative d'un agrégat, pour la géométrie des graphiques uniquement. */
  const num = (a?: Amounts | null): number | null => (a?.consolidatedCdf ? plotValue(a.consolidatedCdf) : null);
  const months = (monthly.data?.rows ?? []).map((r) => r.key).sort().slice(-12);
  const sparkMonths = months.length >= 2 ? months : (L?.series ?? []).map((m) => m.month);
  const sparkLabels = sparkMonths.map((m) => periodLabel(m, 'month'));
  const sparkOf = (level: 'confirmed' | 'settled' | 'reconciled'): number[] | undefined => {
    if (months.length >= 2) return months.map((m) => num(monthly.data!.rows.find((r) => r.key === m)?.values[level]) ?? 0);
    if (level === 'settled' || !L?.series.length) return undefined;
    return L.series.map((m) => num(m[level]) ?? 0);
  };
  const liveRecon = L?.kpis.find((k) => k.code === 'RAPPROCHEMENT_J1');
  const reconTarget = targetOf(liveRecon?.targetLabel);
  const liveReconTone: Tone = !liveRecon || liveRecon.value === null ? 'neutral' : liveRecon.status === 'ATTEINTE' ? 'good' : Number(liveRecon.value) >= 90 ? 'warning' : 'critical';

  return (
    <div className="page page-wide">
      <PageHead eyebrow={tr('gov.eyebrow')} title={tr('governor.title')} lead={tr('gov.lead', { date: fmtDate(d.asOf, true) })}>
        <div className="seg" role="group" aria-label={tr('gov.displayCurrency')}>
          {(['CDF', 'USD'] as Disp[]).map((c) => (
            <button key={c} type="button" aria-pressed={disp === c} disabled={c === 'USD' && !rateObj} onClick={() => setDisp(c)}>
              {c === 'CDF' ? '🇨🇩' : '🇺🇸'} {c}
            </button>
          ))}
        </div>
      </PageHead>
      <p className="small muted rate-line">
        {tr('gov.consolidation')}
        {usdRate ? ` · ${tr('gov.rate', { rate: formatMoney({ amount: Number(usdRate).toFixed(2), currency: 'CDF' }, { locale: loc }), date: rateDate })}` : ''}
        {d.exchange?.source ? ` · ${d.exchange.source}` : rates?.source ? ` · ${rates.source}` : ''}
      </p>
      {L ? (
        <>
          <FiltersBar value={filters} onChange={setFilters} lock={L.scope} />
          <div className="pl-toolbar">
            <ScopeLine scope={L.scope} generatedAt={L.generatedAt} />
            <span className="pl-export">
              <Link className="btn btn-ghost btn-sm" to="/pilotage/indicateurs"><Icon name="gauge" size={16} /> Indicateurs</Link>
              <Link className="btn btn-ghost btn-sm" to="/pilotage/tableaux"><Icon name="grid" size={16} /> Tableaux par profil</Link>
              <ExportButton kind="echelle" params={{ ...filters }} label="Rapport signé" />
            </span>
          </div>
          <KpiGrid max={5} label="Chiffres du jour">
            <Tile hero label={tr('governor.confirmedToday')} value={cdfOf(L.tiles.confirmed.today)} sub={`Veille : ${cdfOf(L.tiles.confirmed.yesterday)} · ${L.tiles.confirmed.today.count ?? 0} paiement(s)`}
              delta={{ current: num(L.tiles.confirmed.today), previous: num(L.tiles.confirmed.yesterday), versus: 'vs veille' }} spark={sparkOf('confirmed')} sparkLabels={sparkLabels} />
            <Tile label={tr('governor.settled')} value={cdfOf(L.tiles.settled.today)} sub={`Veille : ${cdfOf(L.tiles.settled.yesterday)}`}
              delta={{ current: num(L.tiles.settled.today), previous: num(L.tiles.settled.yesterday), versus: 'vs veille' }} spark={sparkOf('settled')} sparkLabels={sparkLabels} />
            <Tile label={tr('governor.reconciled')} value={cdfOf(L.tiles.reconciled.today)} sub={`Veille : ${cdfOf(L.tiles.reconciled.yesterday)}`}
              delta={{ current: num(L.tiles.reconciled.today), previous: num(L.tiles.reconciled.yesterday), versus: 'vs veille' }} spark={sparkOf('reconciled')} sparkLabels={sparkLabels} />
            <Tile label={tr('governor.reconRate')} value={liveRecon?.value != null ? `${Number(liveRecon.value).toLocaleString(nloc)} %` : '—'}
              tone={liveReconTone} toneLabel={liveRecon?.value == null ? 'Pas encore calculable' : liveRecon.status === 'ATTEINTE' ? tr('gov.onTarget') : tr('gov.belowTarget')} sub={liveRecon?.targetLabel ?? ''} />
            <Tile label={tr('governor.criticalAlerts')} value={String(L.criticalAlerts)} tone={L.criticalAlerts > 0 ? 'critical' : 'good'} toneLabel={tr(L.criticalAlerts > 0 ? 'gov.toHandle' : 'gov.noAlert')} />
          </KpiGrid>
          <ChartGrid min={300} label="Vue d’ensemble en graphiques">
            <LadderFunnel className="viz-span-2" title="Les six états de la recette" subtitle="Potentiel → disponible — emboîtés, jamais additionnés ; montants par devise"
              steps={sixEtatsFromLadder(L.ladder, pf.amounts)} note="Barres : contre-valeur indicative CDF (taux du jour). Un état non mesuré est hachuré et motivé." />
            {reconTarget && liveRecon ? (
              <GaugeMeter title={liveRecon.label} subtitle={liveRecon.question ?? 'Paiements rapprochés à J+1'} value={liveRecon.value === null ? null : Number(liveRecon.value)} unit="%"
                target={reconTarget.value} better={reconTarget.better} targetLabel={liveRecon.targetLabel} tone={liveReconTone}
                toneLabel={liveRecon.value == null ? 'Pas encore calculable' : KPI_STATUS[liveRecon.status]} reason={liveRecon.detail ?? 'Pas encore calculable'} />
            ) : null}
            <HeatGrid className="viz-span-2" title="Rapproché par commune" subtitle="Fait générateur — contre-valeur indicative CDF ; disposition schématique ouest → est"
              measureLabel="Rapproché (contre-valeur CDF)" format={fmtCompact} unit="CDF" unmeasuredReason="aucun paiement rapproché rattaché à cette commune"
              cells={L.byCommune.rows.filter((r) => r.key !== 'NON_ATTRIBUE').map((r) => ({ commune: r.key, value: num(r.values.reconciled), detail: `Liquidé : ${cdfOf(r.values.assessed)} · confirmé : ${cdfOf(r.values.confirmed)}` }))} />
            <StatusDistribution title="Indicateurs par état" subtitle={`${L.kpis.length} indicateurs du tableau de bord`} unitLabel="indicateurs"
              items={countBy(L.kpis, 'status').map((r) => ({ key: r.key, label: KPI_STATUS[r.key as Kpi['status']] ?? r.key, count: r.count, tone: kpiTone({ status: r.key } as Kpi) }))} />
            <DonutViz title="Liquidé par catégorie" subtitle="Part de chaque catégorie — contre-valeur indicative CDF" centerLabel="CDF liquidés" format={fmtCompact}
              slices={L.byCategory.rows.map((r) => ({ key: r.key, label: CATEGORY_LABELS[r.key] ?? r.key, value: num(r.values.assessed) ?? 0 }))} />
            <DonutViz title="Encaissé par canal" subtitle="Paiements confirmés — contre-valeur indicative CDF" centerLabel="CDF encaissés" format={fmtCompact}
              slices={L.byChannel?.rows.map((r) => ({ key: r.key, label: CHANNEL_LABELS[r.key] ?? r.key, value: num(r.values.confirmed) ?? 0 })) ?? []} />
            <LineAreaViz className="viz-span-2" title="Encaissé et rapproché, mois par mois" subtitle="12 derniers mois — contre-valeur indicative CDF" granularity="month" area format={fmtCompact}
              series={[{ key: 'confirmed', label: 'Encaissé (confirmé)' }, { key: 'reconciled', label: 'Rapproché' }]}
              points={L.series.map((m) => ({ date: m.month, values: { confirmed: num(m.confirmed), reconciled: num(m.reconciled) } }))} />
          </ChartGrid>
          <div className="dash-grid" style={{ marginBottom: 24 }}>
            <LadderChart className="span-7" levels={L.ladder} contested={L.contested} />
            <DrillChart className="span-5" drill={L.byCommune} title="Par commune (fait générateur)" subtitle="Liquidé, confirmé et rapproché — contre-valeur indicative CDF" />
            <DrillChart className="span-6" drill={L.byCategory} title={tr('governor.byCategory')} />
            <SeriesChart className="span-6" months={L.series} />
            <DrillChart className="span-12" drill={L.byEntity} title="Par régie et administration" levels={['assessed', 'overdue', 'confirmed', 'reconciled']} />
          </div>
          <h2 className="section-title">Illustrations en attente de mesure</h2>
          <ExampleNotice text="EXEMPLE — les blocs ci-dessous (conformité, cible, scénarios, alertes illustratives) attendent le modèle de potentiel, la cible budgétaire et les scénarios validés : valeurs illustratives, non opposables." />
        </>
      ) : (
        <>
          {ex && <ExampleNotice text={fallback ? tr('gov.fallback') : tr('common.example')} />}

          <KpiGrid max={5} label="Chiffres du jour (exemple)">
            <Tile hero label={tr('governor.confirmedToday')} value={bigMoney(t.confirmedToday)} sub={t.delta ? tr('gov.vsYesterday', { n: /%/.test(t.delta) ? t.delta : `${t.delta.replace('.', ',')} %` }) : undefined} />
            <Tile label={tr('governor.settled')} value={bigMoney(t.settled)} sub={tr('gov.ofConfirmed', { n: pct(t.settled, t.confirmedToday) })} />
            <Tile label={tr('governor.reconciled')} value={bigMoney(t.reconciled)} sub={tr('gov.ofSettled', { n: pct(t.reconciled, t.settled) })} />
            <Tile label={tr('governor.reconRate')} value={rate !== undefined ? `${rate.toLocaleString(nloc)} %` : '—'}
              tone={reconTone} toneLabel={tr(reconTone === 'good' ? 'gov.onTarget' : 'gov.belowTarget')} sub={tr('gov.target', { n: t.reconTarget })} />
            <Tile label={tr('governor.criticalAlerts')} value={String(t.criticalAlerts)} tone={alertTone} toneLabel={tr(alertTone === 'good' ? 'gov.noAlert' : 'gov.toHandle')} />
          </KpiGrid>

          {live.error ? <p className="small err" role="alert">Données réelles indisponibles : {describeError(live.error).message}</p> : null}
        </>
      )}

      <div className="dash-grid">
        {!L && <ChartCard className="span-7" title={tr('governor.byCommune')} subtitle={tr('gov.communeSub', { unit })} example={ex}
          height={Math.max(260, shownCommunes.length * 28 + 30)}
          table={{ columns: [tr('gov.commune'), `${tr('explain.amount')} (${disp})`, tr('gov.compliance')], rows: communes.map((c) => [c.name, formatMoney(dispMoney(c.money), { locale: loc }), c.compliance !== undefined ? `${c.compliance.toLocaleString(nloc)} %` : '—']) }}
          actions={
            <>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSort((s) => (s === 'value' ? 'alpha' : 'value'))} aria-label={tr('gov.sortToggle')}>
                <Icon name="sort" size={16} /> {sort === 'value' ? tr('gov.sortValue') : tr('gov.sortAlpha')}
              </button>
              {communes.length > 10 && (
                <button type="button" className="btn btn-ghost btn-sm" aria-pressed={allCommunes} onClick={() => setAllCommunes((v) => !v)}>
                  {allCommunes ? tr('gov.top10') : tr('gov.all', { n: communes.length })}
                </button>
              )}
            </>
          }>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={shownCommunes} layout="vertical" margin={{ top: 4, right: 64, bottom: 4, left: 0 }} barCategoryGap={6}>
              <CartesianGrid horizontal={false} stroke={theme.grid} />
              <XAxis type="number" tickFormatter={(v: number) => compact(v, lang)} tick={{ fontSize: 11, fill: theme.axis }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" width={92} tick={{ fontSize: 12, fill: theme.ink }} axisLine={false} tickLine={false} interval={0} />
              <Tooltip cursor={{ fill: theme.grid, opacity: 0.5 }} content={<ChartTooltip format={fmtC} />} />
              <Bar dataKey="value" name={tr('gov.confirmed')} fill={cat[0]} radius={[0, 4, 4, 0]} maxBarSize={14} isAnimationActive={false}>
                <LabelList dataKey="value" content={(p) => barLabel(p, compact, lang, theme.ink)} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>}

        {!L && <ChartCard className="span-5" title={tr('governor.byCategory')} subtitle={tr('gov.shareSub')} example={ex} height={240}
          legend={<Legend items={cats.map((c, i) => ({ label: `${c.name} · ${Math.round((c.value / catTotal) * 100)} %`, color: cat[Math.min(i, 7)]! }))} />}
          table={{ columns: [tr('gov.category'), `${tr('explain.amount')} (${disp})`, tr('gov.share')], rows: cats.map((c) => [c.name, formatMoney(dispMoney(c.money), { locale: loc }), `${Math.round((c.value / catTotal) * 100)} %`]) }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={cats} dataKey="value" nameKey="name" innerRadius="56%" outerRadius="78%" paddingAngle={1} stroke={theme.surface} strokeWidth={2} isAnimationActive={false}
                label={cats.length <= 4 ? ({ percent }: { percent: number }) => `${Math.round(percent * 100)} %` : false} labelLine={false}>
                {cats.map((c, i) => <Cell key={c.name} fill={cat[Math.min(i, 7)]} />)}
              </Pie>
              <Tooltip content={<ChartTooltip format={fmtC} />} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>}

        {!L && <ChartCard className="span-7" title={tr('governor.ladder')} subtitle={tr('gov.ladderSub', { unit })} example={ex} height={ladder.length * 28 + 30}
          legend={<Legend items={groupNames.map((g, i) => ({ label: g, color: cat[i]! }))} />}
          table={{ columns: [tr('gov.level'), `${tr('explain.amount')} (${disp})`], rows: d.ladder.map((l) => [tr(`ladder.${l.level}` as UIKey), formatMoney(dispMoney(l.amount), { locale: loc })]) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={ladder} layout="vertical" margin={{ top: 4, right: 64, bottom: 4, left: 0 }} barCategoryGap={5}>
              <CartesianGrid horizontal={false} stroke={theme.grid} />
              <XAxis type="number" tickFormatter={(v: number) => compact(v, lang)} tick={{ fontSize: 11, fill: theme.axis }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" width={176} tick={{ fontSize: 11.5, fill: theme.ink }} axisLine={false} tickLine={false} interval={0} />
              <Tooltip cursor={{ fill: theme.grid, opacity: 0.5 }} content={<ChartTooltip format={fmtC} />} />
              <Bar dataKey="value" name={tr('explain.amount')} radius={[0, 4, 4, 0]} maxBarSize={14} isAnimationActive={false}>
                {ladder.map((l) => <Cell key={l.level} fill={cat[l.group]} />)}
                <LabelList dataKey="value" content={(p) => barLabel(p, compact, lang, theme.ink)} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p className="small muted chart-note">{tr('gov.ladderNote')}</p>
        </ChartCard>}

        <HeatGrid className="span-5" title={tr('gov.heatTitle')} subtitle={tr('gov.heatSub')} example={ex} measureLabel={tr('gov.compliance')} unit="%" domain={[0, 100]}
          format={(v) => String(Math.round(v))} note={tr('gov.heatNote')} unmeasuredReason="taux de conformité non servi pour cette commune"
          cells={d.communes.map((c) => ({ commune: c.name, value: c.compliance ?? null, detail: `${tr('explain.amount')} : ${formatMoney(dispMoney(c.amount), { locale: loc })}` }))} />

        <ChartCard className="span-6" title={tr('gov.campaign')} subtitle={tr('gov.campaignSub', { unit })} example={ex} height={260}
          legend={<Legend items={[{ label: tr('gov.actual'), color: cat[0]! }, { label: tr('gov.targetLine'), color: theme.reference, dashed: true }]} />}
          table={{ columns: [tr('gov.period'), tr('gov.actual'), tr('gov.targetLine')], rows: trend.map((p) => [p.label, fmtC(p.actual), fmtC(p.target)]) }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trend} margin={{ top: 8, right: 72, bottom: 4, left: 0 }}>
              <CartesianGrid vertical={false} stroke={theme.grid} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: theme.axis }} axisLine={{ stroke: theme.grid }} tickLine={false} interval="preserveStartEnd" minTickGap={16} />
              <YAxis tick={{ fontSize: 11, fill: theme.axis }} tickFormatter={(v: number) => compact(v, lang)} axisLine={false} tickLine={false} width={68} />
              <Tooltip content={<ChartTooltip format={fmtC} />} />
              <Line type="monotone" dataKey="target" name={tr('gov.targetLine')} stroke={theme.reference} strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="actual" name={tr('gov.actual')} stroke={cat[0]} strokeWidth={2} dot={{ r: 3, strokeWidth: 0, fill: cat[0] }} activeDot={{ r: 5 }} isAnimationActive={false}>
                <LabelList dataKey="actual" content={(p) => endLabel(p, trend.length, lastTrend ? compact(lastTrend.actual, lang) : '', theme.ink)} />
              </Line>
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard className="span-6" title={tr('governor.scenarios')} subtitle={tr('gov.scenariosSub', { unit })} example={ex} height={260}
          legend={<Legend items={[{ label: tr('gov.actual'), color: theme.ink }, ...d.scenarioNames.map((n, i) => ({ label: n, color: scenColors[i] ?? cat[i]! }))]} />}
          table={{ columns: [tr('gov.period'), tr('gov.actual'), ...d.scenarioNames], rows: scen.map((s) => [String(s.label), typeof s.actual === 'number' ? fmtC(s.actual) : '—', ...d.scenarioNames.map((_, i) => (typeof s[`s${i}`] === 'number' ? fmtC(s[`s${i}`] as number) : '—'))]) }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={scen} margin={{ top: 8, right: 72, bottom: 4, left: 0 }}>
              <CartesianGrid vertical={false} stroke={theme.grid} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: theme.axis }} axisLine={{ stroke: theme.grid }} tickLine={false} interval="preserveStartEnd" minTickGap={12} />
              <YAxis tick={{ fontSize: 11, fill: theme.axis }} tickFormatter={(v: number) => compact(v, lang)} axisLine={false} tickLine={false} width={68} domain={['auto', 'auto']} />
              <Tooltip content={<ChartTooltip format={fmtC} />} />
              <Line type="monotone" dataKey="actual" name={tr('gov.actual')} stroke={theme.ink} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
              {d.scenarioNames.map((n, i) => (
                <Line key={n} type="monotone" dataKey={`s${i}`} name={n} stroke={scenColors[i] ?? cat[i]} strokeWidth={2} strokeDasharray={i === 1 ? undefined : '6 3'} dot={false} connectNulls activeDot={{ r: 4 }} isAnimationActive={false}>
                  <LabelList dataKey={`s${i}`} content={(p) => endLabel(p, scen.length, lastScen && typeof lastScen[`s${i}`] === 'number' ? compact(lastScen[`s${i}`] as number, lang) : '', theme.ink)} />
                </Line>
              ))}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <section className="panel span-5" aria-labelledby="alerts-title">
          <header className="panel-head"><h2 className="panel-title" id="alerts-title">{tr('gov.alerts')}</h2><span className="count">{d.alerts.length}</span></header>
          {d.alerts.length === 0 ? <p className="muted">{tr('gov.noAlert')}</p> : (
            <ul className="alert-list">
              {d.alerts.map((a) => (
                <li key={a.id} className={`alert-item alert-${a.severity}`}>
                  <StatusBadge tone={a.severity} label={tr(`severity.${a.severity}` as UIKey)} />
                  <div className="min0">
                    <p className="row-title">{a.title}</p>
                    {a.detail && <p className="small muted">{a.detail}</p>}
                  </div>
                  {a.age && <span className="small muted nowrap">{a.age}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="span-7 stack-sm">
          <h2 className="section-title">{tr('governor.actions')}</h2>
          <AIInsightPanel rec={ai.data?.rec ?? d.actions[0] ?? null} loading={ai.loading} example={ai.data?.example ?? ex}
            error={ai.error ? describeError(ai.error).message : null} onRefresh={ai.reload} />
        </div>
      </div>
    </div>
  );
}
