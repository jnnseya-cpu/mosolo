import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatMoney, type CurrencyCode } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { ChartCard } from '../../components/ChartCard';
import { ChartTooltip, useChartColors } from '../../components/charts';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { api, ApiError, describeError } from '../../lib/api';
import { compact } from '../../lib/money';
import './pilotage.css';

interface Cell { currency: CurrencyCode; amount: string | null; contributors: string | null; suppressed: boolean; reason?: string }
interface Row { key: string; label: string; cells: Cell[] }
interface Publication {
  period: string; version: number; publishedAt: string; authority: string;
  content: {
    period: string; from: string; to: string; basis: string; threshold: number; byCommune: Row[]; byCategory: Row[]; totals: Cell[];
    appeals: { decided: string | null; medianDays: string | null; suppressed: boolean }; fundsUse: { note: string }; method: string[];
  };
  check: { passed: boolean; checks: { code: string; label: string; passed: boolean; detail: string }[] };
  integrity: { sha256: string; signature: string; algorithm: string; keyId: string };
}
interface Index { title: string; note: string; periods: { period: string; version: number; publishedAt: string }[]; latest: Publication | null }

const REASONS: Record<string, string> = { SEUIL: 'moins de contribuables que le seuil', DOMINANCE: 'un contribuable prépondérant', SECONDAIRE: 'masquage complémentaire', TOTAL: 'total masqué' };

function CellText({ c }: { c: Cell | undefined }) {
  const { lang } = useApp();
  if (!c) return <span className="muted">—</span>;
  if (c.suppressed) return <span className="pl-masked" title={REASONS[c.reason ?? ''] ?? ''}>Masqué</span>;
  return <>{formatMoney({ amount: c.amount!, currency: c.currency }, { locale: lang === 'en' ? 'en' : 'fr' })}</>;
}

/** Tableau public trimestriel des recettes rapprochées (§ 27.4) — sans aucune donnée personnelle. */
export default function Transparence() {
  const { fmtDate, lang } = useApp();
  const { cat, theme } = useChartColors();
  const index = useApi(() => api<Index>('/v1/public/transparency'), []);
  const [period, setPeriod] = useState<string | null>(null);
  const selected = period ?? index.data?.latest?.period ?? null;
  const pub = useApi<Publication | null>(selected ? () => (selected === index.data?.latest?.period ? Promise.resolve(index.data.latest) : api<Publication>(`/v1/public/transparency/${selected}`)) : null, [selected, index.data]);
  const [verify, setVerify] = useState<string | null>(null);

  const head = <PageHead eyebrow="Transparence publique" title="Où vont nos impôts ?" lead="Recettes rapprochées sur les comptes publics, par commune et par catégorie, publiées chaque trimestre par l’autorité. Aucune donnée personnelle." />;
  if (index.loading) return <div className="page page-wide">{head}<Loading /></div>;
  if (index.error) return <div className="page page-wide">{head}<ErrorState error={index.error} onRetry={index.reload} /></div>;
  if (!index.data?.periods.length) return <div className="page page-wide">{head}<EmptyState title="Aucun tableau publié pour l’instant" icon="globe">Le premier tableau trimestriel sera publié par l’autorité après le test anti-ré-identification.</EmptyState></div>;
  const p = pub.data;
  const currencies = p ? p.content.totals.map((t) => t.currency) : [];

  const runVerify = async () => {
    if (!p) return;
    setVerify('…');
    try {
      const r = await api<{ valid: boolean }>('/v1/pilotage/exports/verify', { method: 'POST', body: { data: p.content, sha256: p.integrity.sha256, signature: p.integrity.signature } });
      setVerify(r.valid ? 'Authentique : l’empreinte et la signature correspondent au contenu affiché.' : 'ÉCHEC : le contenu ne correspond pas à la signature publiée.');
    } catch (e) { setVerify(describeError(e).message); }
  };

  return (
    <div className="page page-wide">
      {head}
      <div className="pl-toolbar">
        <div className="pl-tabs" role="group" aria-label="Trimestre">
          {index.data.periods.map((x) => <button key={x.period} type="button" aria-pressed={x.period === selected} onClick={() => setPeriod(x.period)}>{x.period.replace('-T', ' · T')}</button>)}
        </div>
      </div>
      {pub.loading ? <Loading /> : pub.error ? (pub.error instanceof ApiError && pub.error.status === 404 ? <EmptyState title="Trimestre non publié" /> : <ErrorState error={pub.error} onRetry={pub.reload} />) : p && (
        <>
          <section className="pl-public-hero" aria-label="Total du trimestre">
            <p>Trimestre {p.period.replace('-T', ' · T')} — du {fmtDate(p.content.from)} au {fmtDate(p.content.to)}</p>
            <div className="pl-big">{p.content.totals.map((t) => <div key={t.currency}><CellText c={t} /></div>)}</div>
            <p>{p.content.basis}</p>
            <p className="small">Publié le {fmtDate(p.publishedAt, true)} par {p.authority} · version {p.version}</p>
          </section>
          <div className="dash-grid">
            {currencies.map((c, i) => {
              const rows = p.content.byCommune.map((r) => ({ r, cell: r.cells.find((x) => x.currency === c) })).filter((x) => x.cell);
              const data = rows.map(({ r, cell }) => ({ name: r.label, value: cell!.suppressed ? 0 : Number(cell!.amount), masked: cell!.suppressed }));
              data.sort((a, b) => b.value - a.value);
              return (
                <ChartCard key={c} className="span-7" title={`Recettes rapprochées par commune (${c})`} subtitle={`Commune du fait générateur — cellule masquée sous ${p.content.threshold} contribuables`} height={Math.max(200, data.length * 30 + 30)}
                  table={{ columns: ['Commune', `Montant (${c})`, 'Contribuables'], rows: rows.map(({ r, cell }) => [r.label, cell!.suppressed ? 'Masqué' : cell!.amount!, cell!.contributors ?? '—']) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data} layout="vertical" margin={{ top: 4, right: 80, bottom: 4, left: 0 }} barCategoryGap={6}>
                      <CartesianGrid horizontal={false} stroke={theme.grid} />
                      <XAxis type="number" tickFormatter={(v: number) => compact(v, lang)} tick={{ fontSize: 11, fill: theme.axis }} axisLine={false} tickLine={false} />
                      <YAxis type="category" dataKey="name" width={104} tick={{ fontSize: 12, fill: theme.ink }} axisLine={false} tickLine={false} interval={0} />
                      <Tooltip content={<ChartTooltip format={(v) => `${compact(v, lang)} ${c}`} />} />
                      <Bar dataKey="value" name={`Rapproché (${c})`} radius={[0, 4, 4, 0]} maxBarSize={16} isAnimationActive={false}>
                        {data.map((d) => <Cell key={d.name} fill={d.masked ? theme.grid : cat[i % cat.length]} />)}
                        <LabelList dataKey="value" content={(pp) => {
                          const { x, y, width, height, index: k } = pp as { x?: number; y?: number; width?: number; height?: number; index?: number };
                          const d = data[k ?? 0];
                          if (x === undefined || y === undefined || !d) return null;
                          return <text x={Number(x) + Number(width ?? 0) + 6} y={Number(y) + Number(height ?? 0) / 2 + 4} fontSize={11} fill={d.masked ? theme.axis : theme.ink} fontStyle={d.masked ? 'italic' : 'normal'}>{d.masked ? 'masqué' : compact(d.value, lang)}</text>;
                        }} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </ChartCard>
              );
            })}
            <section className="panel span-5">
              <header className="panel-head"><div><h2 className="panel-title">Par catégorie de recette</h2><p className="panel-sub">Recettes rapprochées du trimestre</p></div></header>
              <DataTable caption="Par catégorie" rows={p.content.byCategory} rowKey={(r) => r.key}
                columns={[
                  { key: 'l', label: 'Catégorie', render: (r) => r.label, primary: true },
                  ...currencies.map((c) => ({ key: c, label: c, render: (r: Row) => <CellText c={r.cells.find((x) => x.currency === c)} />, num: true })),
                ]} />
              <p className="small muted">Délais de recours : {p.content.appeals.suppressed ? 'trop peu de décisions sur le trimestre pour publier sans risque.' : `${p.content.appeals.decided} décisions, délai médian ${p.content.appeals.medianDays} jour(s).`}</p>
              <p className="small muted">{p.content.fundsUse.note}</p>
            </section>
            <section className="panel span-6">
              <header className="panel-head"><div><h2 className="panel-title">Protection des personnes</h2><p className="panel-sub">Test anti-ré-identification exécuté avant publication</p></div>
                <StatusBadge tone={p.check.passed ? 'good' : 'critical'} label={p.check.passed ? 'Réussi' : 'Échec'} /></header>
              <ul className="pl-checks">
                {p.check.checks.map((c) => <li key={c.code}><StatusBadge tone={c.passed ? 'good' : 'critical'} label={c.passed ? 'OK' : 'KO'} /><div className="min0"><p className="row-title">{c.label}</p><p className="small muted">{c.detail}</p></div></li>)}
              </ul>
              <ul className="plain-list small muted">{p.content.method.map((m) => <li key={m}>{m}</li>)}</ul>
            </section>
            <section className="panel span-6">
              <header className="panel-head"><div><h2 className="panel-title">Authenticité</h2><p className="panel-sub">Empreinte SHA-256 et signature {p.integrity.algorithm} ({p.integrity.keyId})</p></div></header>
              <dl className="kv">
                <dt>Empreinte</dt><dd><code className="hash">{p.integrity.sha256}</code></dd>
                <dt>Signature</dt><dd><code className="hash">{p.integrity.signature}</code></dd>
              </dl>
              <button type="button" className="btn btn-secondary btn-sm" onClick={runVerify}><Icon name="shieldCheck" size={16} /> Vérifier l’authenticité</button>
              {verify && <p className="small" role="status">{verify}</p>}
            </section>
          </div>
          <p className="small muted">Seuil de publication : {p.content.threshold} contribuables distincts par cellule.</p>
        </>
      )}
    </div>
  );
}
