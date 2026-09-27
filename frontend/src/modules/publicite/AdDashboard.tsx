/**
 * Tableau de supervision KIN PUB CONTROL (agrégats) : supports enregistrés et autorisés, échéances, contrôles,
 * dossiers, régularisations, recettes par m², situation par commune, qualité des inspecteurs (jamais le nombre de sanctions).
 */
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { ErrorState, ExampleNotice, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { ChartCard } from '../../components/ChartCard';
import { ChartTooltip, useChartColors } from '../../components/charts';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { DemoTag, Kpis, Money, pctText } from '../parking/shared';
import { FINDING } from './types';
import '../parking/parking.css';

interface Indicators {
  generatedAt: string; notice: string; taxRule: { code: string; version: number | null; status: string; demo: boolean };
  totals: {
    devices: number; active: number; authorized: number; declaredPending: number; undeclared: number; expired: number; retired: number; authorizedRate: string | null;
    expiringSoon: number; regularized: number; requestsPending: number; inspections: number; casesOpen: number; casesRetained: number; casesDismissed: number; casesValidated?: number; contested: number;
    obligations: number; revenue: MoneyJSON[]; authorizedSurfaceM2: string; revenuePerM2: MoneyJSON[];
  };
  byFinding: { finding: string; count: number }[];
  byCommune: { commune: string; devices: number; authorized: number; undeclared: number; authorizedRate: string | null; revenue: MoneyJSON[] }[];
  inspectors: { inspectorId: string; name: string; inspections: number; withPhotosAndGps: number; casesVerified: number; casesConfirmed: number; falseReportsRate: string | null; accuracyRate: string | null }[];
}

export default function AdDashboard() {
  const { user, fmtDate, lang } = useApp();
  const { cat, theme } = useChartColors();
  const data = useApi(() => api<Indicators>('/v1/publicite/indicators'), [user?.id]);
  if (data.loading && !data.data) return <div className="page"><Loading /></div>;
  if (data.error) return <div className="page"><PageHead eyebrow="KIN PUB CONTROL" title="Supervision de la publicité extérieure" /><ErrorState error={data.error} onRetry={data.reload} /></div>;
  const d = data.data!;
  const t = d.totals;
  const loc = lang === 'en' ? 'en' : 'fr';
  return (
    <div className="page page-wide">
      <PageHead eyebrow="KIN PUB CONTROL · supervision" title="Supervision de la publicité extérieure" lead={d.notice}>
        <span className="small muted">Actualisé le {fmtDate(d.generatedAt, true)}</span>
      </PageHead>
      <ExampleNotice text={`Règle de liquidation : ${d.taxRule.code} (${d.taxRule.status})${d.taxRule.demo ? ' — règle FICTIVE de démonstration' : ''}. Supports et exploitants fictifs.`} />
      <Kpis items={[
        { label: 'Supports actifs', value: t.active, sub: `${t.devices} enregistrés · ${t.retired} retiré(s)` },
        { label: 'Taux d’autorisation', value: pctText(t.authorizedRate), sub: `${t.authorized} autorisé(s) · ${t.undeclared} non déclaré(s)` },
        { label: 'Échéances à 30 jours', value: t.expiringSoon, sub: `${t.expired} expirée(s)` },
        { label: 'Contrôles', value: t.inspections, sub: `${t.casesOpen} dossier(s) en cours` },
        { label: 'Recettes confirmées', value: <Money items={t.revenue} empty="0" />, sub: <>par m² : <Money items={t.revenuePerM2} /></> },
      ]} />
      <div className="dash-grid">
        <ChartCard className="span-6" title="Constats par nature" subtitle="Toutes inspections confondues, y compris les contrôles conformes." height={220}
          table={{ columns: ['Nature', 'Nombre'], rows: d.byFinding.map((f) => [FINDING[f.finding] ?? f.finding, f.count]) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={d.byFinding.map((f) => ({ name: FINDING[f.finding] ?? f.finding, value: f.count }))} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid vertical={false} stroke={theme.grid} />
              <XAxis dataKey="name" stroke={theme.axis} tick={{ fontSize: 12 }} />
              <YAxis allowDecimals={false} stroke={theme.axis} tick={{ fontSize: 12 }} width={32} />
              <Tooltip cursor={{ fill: theme.grid, opacity: 0.4 }} content={<ChartTooltip format={(v) => v.toLocaleString(loc)} />} />
              <Bar dataKey="value" name="Constats" fill={cat[2]} radius={[4, 4, 0, 0]} maxBarSize={40} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
        <section className="panel span-6">
          <header className="panel-head"><div><h2 className="panel-title"><Icon name="clock" size={18} /> Procédures</h2></div></header>
          <dl className="kv">
            <div><dt>Demandes d’autorisation en cours</dt><dd>{t.requestsPending}</dd></div>
            <div><dt>Dossiers retenus</dt><dd>{t.casesRetained}</dd></div>
            <div><dt>Constats validés (vérification confirmée)</dt><dd>{t.casesValidated ?? 0}</dd></div>
            <div><dt>Dossiers classés ou écartés</dt><dd>{t.casesDismissed}</dd></div>
            <div><dt>Dossiers contestés</dt><dd>{t.contested}</dd></div>
            <div><dt>Supports régularisés (recensés puis autorisés)</dt><dd>{t.regularized}</dd></div>
            <div><dt>Surface autorisée (m², toutes faces)</dt><dd className="num">{t.authorizedSurfaceM2.replace('.', ',')}</dd></div>
            <div><dt>Avis émis</dt><dd>{t.obligations}</dd></div>
          </dl>
        </section>
        <section className="panel span-12">
          <header className="panel-head"><div><h2 className="panel-title"><Icon name="building" size={18} /> Situation par commune</h2><p className="panel-sub">Attribution au lieu du support (§ 20.3).</p></div></header>
          <DataTable rows={d.byCommune} rowKey={(c) => c.commune} caption="Situation par commune"
            columns={[
              { key: 'c', label: 'Commune', primary: true, render: (c) => c.commune },
              { key: 'n', label: 'Supports', num: true, render: (c) => c.devices },
              { key: 'a', label: 'Autorisés', num: true, render: (c) => c.authorized },
              { key: 'u', label: 'Non déclarés', num: true, render: (c) => c.undeclared },
              { key: 'r', label: 'Taux d’autorisation', num: true, render: (c) => pctText(c.authorizedRate) },
              { key: 'm', label: 'Recettes', num: true, render: (c) => <Money items={c.revenue} empty="0" /> },
            ]} />
        </section>
        <section className="panel span-12">
          <header className="panel-head"><div><h2 className="panel-title"><Icon name="users" size={18} /> Qualité des équipes de contrôle</h2><p className="panel-sub">Évaluation sur la qualité des preuves et l’exactitude — jamais sur le nombre de sanctions.</p></div></header>
          <DataTable rows={d.inspectors} rowKey={(i) => i.inspectorId} caption="Qualité des inspecteurs" empty={<p className="muted small">Aucune inspection.</p>}
            columns={[
              { key: 'n', label: 'Inspecteur', primary: true, render: (i) => <>{i.name} <DemoTag /></> },
              { key: 'i', label: 'Contrôles', num: true, render: (i) => i.inspections },
              { key: 'p', label: 'Avec photos et GPS', num: true, render: (i) => i.withPhotosAndGps },
              { key: 'v', label: 'Dossiers vérifiés', num: true, render: (i) => i.casesVerified },
              { key: 'a', label: 'Exactitude', num: true, render: (i) => i.accuracyRate ? <StatusBadge tone={Number.parseFloat(i.accuracyRate) >= 80 ? 'good' : 'warning'} label={pctText(i.accuracyRate)} /> : '—' },
              { key: 'f', label: 'Constats écartés', num: true, render: (i) => pctText(i.falseReportsRate) },
            ]} />
        </section>
      </div>
    </div>
  );
}
