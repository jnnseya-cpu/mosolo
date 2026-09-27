/**
 * Tableau de bord ParkSmart (agrégats seulement) : occupation et cible de 15 à 25 % de places libres, rotation,
 * recettes confirmées par zone et par commune, conformité au contrôle, priorités de patrouille, garde-fous.
 */
import { Bar, BarChart, CartesianGrid, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatMoney, type MoneyJSON } from '@mosolo/shared';
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
import { DemoTag, Kpis, Money, pctText, ZONE_STATUS } from './shared';
import { AgentCommissions } from './AgentEarnings';
import './parking.css';

interface ZoneRow {
  zoneId: string; code: string; name: string; commune: string; kind: string; legalStatus: 'OUVERTE' | 'ACTE_REQUIS' | 'SUSPENDUE'; demo: boolean;
  capacity: number; activeSessions: number; reservedPlaces: number; occupancyRate: string | null; freeRate: string | null;
  freeTarget: 'SATURE' | 'SOUS_UTILISE' | 'DANS_LA_CIBLE' | 'SANS_OBJET'; paidSessionsToday: number; rotation: string | null;
  revenue: MoneyJSON[]; revenueReconciled: MoneyJSON[]; revenuePerPlace: MoneyJSON[]; revenuePerLinearMeter: MoneyJSON[];
  checks: number; complianceRate: string | null; violations: { total: number; pending: number; retained: number; contested: number };
}
interface Indicators {
  generatedAt: string; notice: string;
  totals: { zones: number; openZones: number; actRequiredZones: number; capacityOpen: number; activeSessions: number; occupancyRate: string | null; paidSessionsToday: number; revenue: MoneyJSON[]; checks: number; complianceRate: string | null; violationsPending: number; violationsContested: number; reservationsPending: number; partners: number };
  zones: ZoneRow[]; byCommune: { commune: string; revenue: MoneyJSON[] }[];
  patrolPriorities: { zoneId: string; code: string; name: string; nonCompliantShare: string | null; checks: number }[];
  safeguards: { overbookingEnabled: boolean; automaticPenalty: boolean; automaticImpoundOrClamp: boolean; cashCollectionByAgents: boolean };
}

const TARGET: Record<ZoneRow['freeTarget'], { tone: 'good' | 'warning' | 'neutral' | 'info'; label: string }> = {
  DANS_LA_CIBLE: { tone: 'good', label: 'Dans la cible' }, SATURE: { tone: 'warning', label: 'Saturée (< 15 % libres)' },
  SOUS_UTILISE: { tone: 'info', label: 'Sous-utilisée (> 25 % libres)' }, SANS_OBJET: { tone: 'neutral', label: 'Sans objet' },
};

export default function ParkingDashboard() {
  const { user, fmtDate, lang } = useApp();
  const { cat, theme } = useChartColors();
  const data = useApi(() => api<Indicators>('/v1/parking/indicators'), [user?.id]);
  const loc = lang === 'en' ? 'en' : 'fr';
  if (data.loading && !data.data) return <div className="page"><Loading /></div>;
  if (data.error) return <div className="page"><PageHead eyebrow="MOSOLO Parking" title="Tableau de bord du stationnement" /><ErrorState error={data.error} onRetry={data.reload} /></div>;
  const d = data.data!;
  const open = d.zones.filter((z) => z.legalStatus !== 'ACTE_REQUIS' && z.capacity > 0);
  const chart = open.map((z) => ({ name: z.code, value: Number.parseFloat(z.occupancyRate ?? '0') }));
  const t = d.totals;
  return (
    <div className="page page-wide">
      <PageHead eyebrow="MOSOLO Parking · pilotage" title="Tableau de bord du stationnement" lead={d.notice}>
        <span className="small muted">Actualisé le {fmtDate(d.generatedAt, true)}</span>
      </PageHead>
      <ExampleNotice text="Les zones payantes affichées sont des zones de démonstration (règle fictive) ; les zones proposées par le dossier source restent « acte requis »." />
      <Kpis items={[
        { label: 'Zones ouvertes', value: `${t.openZones} / ${t.zones}`, sub: `${t.actRequiredZones} en attente d’acte` },
        { label: 'Occupation', value: pctText(t.occupancyRate), sub: `${t.activeSessions} session(s) sur ${t.capacityOpen} places` },
        { label: 'Sessions payées du jour', value: t.paidSessionsToday },
        { label: 'Recettes confirmées', value: <Money items={t.revenue} empty="0" /> },
        { label: 'Conformité au contrôle', value: pctText(t.complianceRate), sub: `${t.checks} contrôle(s)` },
        { label: 'Constats à traiter', value: t.violationsPending, sub: `${t.violationsContested} contesté(s)` },
      ]} />

      <div className="dash-grid">
        <ChartCard className="span-7" title="Taux d’occupation par zone" subtitle="Bande verte : cible de 15 à 25 % de places libres (soit 75 à 85 % d’occupation)." example
          height={Math.max(200, chart.length * 56 + 40)}
          table={{ columns: ['Zone', 'Occupation (%)', 'Places libres (%)', 'Cible'], rows: open.map((z) => [z.name, z.occupancyRate ?? '—', z.freeRate ?? '—', TARGET[z.freeTarget].label]) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chart} layout="vertical" margin={{ top: 8, right: 24, bottom: 8, left: 8 }} barCategoryGap={14}>
              <CartesianGrid horizontal={false} stroke={theme.grid} />
              <ReferenceArea x1={75} x2={85} fill={cat[6]} fillOpacity={0.12} />
              <XAxis type="number" domain={[0, 100]} tickFormatter={(v: number) => `${v} %`} stroke={theme.axis} tick={{ fontSize: 12 }} />
              <YAxis type="category" dataKey="name" width={172} stroke={theme.axis} tick={{ fontSize: 12 }} />
              <Tooltip cursor={{ fill: theme.grid, opacity: 0.4 }} content={<ChartTooltip format={(v) => `${v.toLocaleString(loc)} %`} />} />
              <Bar dataKey="value" name="Occupation" fill={cat[0]} radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <section className="panel span-5">
          <header className="panel-head"><div><h2 className="panel-title"><Icon name="gps" size={18} /> Priorités de patrouille</h2><p className="panel-sub">Part des contrôles sans titre valide. Sert uniquement à orienter les patrouilles — jamais à sanctionner.</p></div></header>
          {d.patrolPriorities.length === 0 ? <p className="muted small">Aucun contrôle enregistré.</p> : (
            <ul className="list-rows">
              {d.patrolPriorities.map((p) => {
                const v = Number.parseFloat(p.nonCompliantShare ?? '0');
                return (
                  <li key={p.zoneId} className="list-row">
                    <div className="min0"><p className="pk-row-title">{p.name}</p><p className="pk-sub">{p.checks} contrôle(s)</p></div>
                    <div className="row-side"><div className={`pk-bar ${v >= 50 ? 'pk-bar-crit' : v >= 25 ? 'pk-bar-warn' : ''}`} aria-hidden="true"><span style={{ width: `${v}%` }} /></div><span className="small num">{pctText(p.nonCompliantShare)}</span></div>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="pk-guards" style={{ marginTop: 16 }}>
            <p className="pk-guard"><Icon name="check" size={16} /> Surréservation {d.safeguards.overbookingEnabled ? 'activée' : 'désactivée (validation juridique requise)'}</p>
            <p className="pk-guard"><Icon name="check" size={16} /> Aucune pénalité automatique : constat humain et décision motivée</p>
            <p className="pk-guard"><Icon name="check" size={16} /> Aucun blocage ni fourrière déclenché par le système</p>
            <p className="pk-guard"><Icon name="check" size={16} /> Aucun encaissement d’espèces par les agents</p>
          </div>
        </section>

        <section className="panel span-12">
          <header className="panel-head"><div><h2 className="panel-title"><Icon name="table" size={18} /> Indicateurs par zone</h2><p className="panel-sub">Recettes = paiements confirmés par le prestataire, par devise ; « rapproché » = arrivé sur le compte public.</p></div></header>
          <DataTable<ZoneRow> rows={d.zones} rowKey={(z) => z.zoneId} caption="Indicateurs par zone"
            columns={[
              { key: 'zone', label: 'Zone', primary: true, render: (z) => <>{z.name} <DemoTag show={z.demo} /></> },
              { key: 'st', label: 'Statut', render: (z) => <StatusBadge tone={ZONE_STATUS[z.legalStatus].tone} label={ZONE_STATUS[z.legalStatus].label} /> },
              { key: 'occ', label: 'Occupation', num: true, render: (z) => pctText(z.occupancyRate) },
              { key: 'tgt', label: 'Cible', render: (z) => <StatusBadge tone={TARGET[z.freeTarget].tone} label={TARGET[z.freeTarget].label} /> },
              { key: 'rot', label: 'Rotation / place / jour', num: true, render: (z) => z.rotation?.replace('.', ',') ?? '—' },
              { key: 'rev', label: 'Recettes', num: true, render: (z) => <Money items={z.revenue} empty="0" /> },
              { key: 'rpp', label: 'Par place', num: true, render: (z) => <Money items={z.revenuePerPlace} /> },
              { key: 'rpm', label: 'Par mètre linéaire', num: true, render: (z) => <Money items={z.revenuePerLinearMeter} /> },
              { key: 'cmp', label: 'Conformité', num: true, render: (z) => pctText(z.complianceRate) },
              { key: 'vio', label: 'Constats (retenus / contestés)', num: true, render: (z) => `${z.violations.total} (${z.violations.retained} / ${z.violations.contested})` },
            ]} />
        </section>

        <section className="panel span-6">
          <header className="panel-head"><div><h2 className="panel-title"><Icon name="building" size={18} /> Recettes par commune de la zone</h2><p className="panel-sub">Attribution au lieu du stationnement (§ 20.3), jamais à l’adresse de l’usager.</p></div></header>
          <ul className="list-rows">
            {d.byCommune.map((c) => (
              <li key={c.commune} className="list-row"><span className="pk-row-title">{c.commune}</span><span className="num">{c.revenue.length ? c.revenue.map((m) => formatMoney(m, { locale: loc })).join(' · ') : '0'}</span></li>
            ))}
          </ul>
        </section>
        <section className="panel span-6">
          <header className="panel-head"><div><h2 className="panel-title"><Icon name="clock" size={18} /> File de travail</h2></div></header>
          <dl className="kv">
            <div><dt>Réservations à décider</dt><dd>{t.reservationsPending}</dd></div>
            <div><dt>Constats à vérifier ou décider</dt><dd>{t.violationsPending}</dd></div>
            <div><dt>Partenaires conventionnés</dt><dd>{t.partners}</dd></div>
          </dl>
        </section>
      </div>
      <AgentCommissions />
    </div>
  );
}
