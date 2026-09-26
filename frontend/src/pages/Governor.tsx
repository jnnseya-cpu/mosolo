import { useMemo, useState, type CSSProperties } from 'react';
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
import { api, describeError, NetworkError } from '../lib/api';
import { compact, convertIndicative, plotValue } from '../lib/money';
import { SEQ_NAVY } from '../lib/palette';
import { normalizeGovernor, type GovView } from '../lib/normalize';
import type { UIKey } from '../lib/i18n';
import { COMMUNE_GRID, DEMO_ACTIONS, DEMO_GOVERNOR_RAW } from '../demo/governor';

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

function Tile({ label, value, sub, tone, toneLabel }: { label: string; value: string; sub?: string; tone?: Tone; toneLabel?: string }) {
  return (
    <div className="kpi">
      <p className="kpi-label">{label}</p>
      <p className="kpi-value">{value}</p>
      <div className="kpi-foot">
        {tone && toneLabel && <StatusBadge tone={tone} label={toneLabel} />}
        {sub && <span className="kpi-sub">{sub}</span>}
      </div>
    </div>
  );
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      {ex && <ExampleNotice text={fallback ? tr('gov.fallback') : tr('common.example')} />}

      <div className="kpi-row">
        <Tile label={tr('governor.confirmedToday')} value={bigMoney(t.confirmedToday)} sub={t.delta ? tr('gov.vsYesterday', { n: /%/.test(t.delta) ? t.delta : `${t.delta.replace('.', ',')} %` }) : undefined} />
        <Tile label={tr('governor.settled')} value={bigMoney(t.settled)} sub={tr('gov.ofConfirmed', { n: pct(t.settled, t.confirmedToday) })} />
        <Tile label={tr('governor.reconciled')} value={bigMoney(t.reconciled)} sub={tr('gov.ofSettled', { n: pct(t.reconciled, t.settled) })} />
        <Tile label={tr('governor.reconRate')} value={rate !== undefined ? `${rate.toLocaleString(nloc)} %` : '—'}
          tone={reconTone} toneLabel={tr(reconTone === 'good' ? 'gov.onTarget' : 'gov.belowTarget')} sub={tr('gov.target', { n: t.reconTarget })} />
        <Tile label={tr('governor.criticalAlerts')} value={String(t.criticalAlerts)} tone={alertTone} toneLabel={tr(alertTone === 'good' ? 'gov.noAlert' : 'gov.toHandle')} />
      </div>

      <div className="dash-grid">
        <ChartCard className="span-7" title={tr('governor.byCommune')} subtitle={tr('gov.communeSub', { unit })} example={ex}
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
        </ChartCard>

        <ChartCard className="span-5" title={tr('governor.byCategory')} subtitle={tr('gov.shareSub')} example={ex} height={240}
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
        </ChartCard>

        <ChartCard className="span-7" title={tr('governor.ladder')} subtitle={tr('gov.ladderSub', { unit })} example={ex} height={ladder.length * 28 + 30}
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
        </ChartCard>

        <section className="panel span-5" aria-labelledby="heat-title">
          <header className="panel-head">
            <div><h2 className="panel-title" id="heat-title">{tr('gov.heatTitle')}</h2><p className="panel-sub">{tr('gov.heatSub')}</p></div>
            {ex && <span className="ribbon">{tr('common.exampleShort')}</span>}
          </header>
          <ul className="heat-grid" aria-label={tr('gov.heatTitle')}>
            {d.communes.map((c) => {
              const pos = COMMUNE_GRID[c.name];
              const v = c.compliance ?? 0;
              const step = Math.min(SEQ_NAVY.length - 1, Math.floor(v / (100 / SEQ_NAVY.length)));
              return (
                <li key={c.name} className="heat-tile" style={{ background: SEQ_NAVY[step], color: step >= 3 ? '#fff' : '#111', ...(pos ? { '--gc': pos[0], '--gr': pos[1] } : {}) } as CSSProperties}
                  title={`${c.name} — ${v} %`}>
                  <span className="heat-name">{c.name}</span>
                  <span className="heat-val">{c.compliance !== undefined ? `${Math.round(v)} %` : '—'}</span>
                </li>
              );
            })}
          </ul>
          <div className="heat-legend" aria-hidden="true">
            <span>0 %</span>{SEQ_NAVY.map((c) => <i key={c} style={{ background: c }} />)}<span>100 %</span>
          </div>
          <p className="small muted">{tr('gov.heatNote')}</p>
        </section>

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
