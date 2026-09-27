import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import { SIX_ETATS } from '@mosolo/shared';
import {
  CATEGORY_LABELS, CHANNEL_LABELS, DrillChart, ExportButton, FiltersBar, KpiTiles, LadderChart, qs, ScopeLine, Section, SeriesChart, useFmt,
  type Amounts, type Contested, type DrillResult, type Filters, type Kpi, type LadderLevel, type Scope, type SeriesPoint,
} from './shared';
import { OriginsTable, type Origins } from './BaseReference';
import { INSTR_STATUS } from './Instructions';
import './pilotage.css';
import {
  BarChartViz, DonutViz, fmtCompact, fmtNombre, HeatGrid, KpiTile, LadderFunnel, LineAreaViz, sixEtatsFromLadder, StatusDistribution,
} from '../../components/viz';
import { ETATS_KPI, etatsDe, KpiTileDe, nombre, Tuiles, Visuels } from './visuels';
import type { MoneyJSON } from '@mosolo/shared';

const entier = (v: number) => fmtNombre(v, 0);
const cdf = (a: Amounts | undefined) => nombre(a?.consolidatedCdf?.amount);
const texteMontants = (a: MoneyJSON[]) => a.map((m) => `${fmtCompact(Number(m.amount))} ${m.currency}`).join(' · ');

/** Visuels du tableau par profil : chiffres du jour vs veille, six états, communes, canaux, série mensuelle, états des indicateurs. */
function VisuelsProfil({ d }: { d: ProfileData }) {
  const t = d.tiles;
  const jour = (label: string, x: Record<'today' | 'yesterday', Amounts>, tone: 'info' | 'good', hero?: boolean) => (
    <KpiTile hero={hero} label={`${label} aujourd’hui`} value={cdf(x.today)} unit="CDF" format={fmtCompact} state={{ label, tone }}
      delta={{ current: cdf(x.today), previous: cdf(x.yesterday), versus: 'vs veille' }} sub={`${x.today.count ?? 0} paiement(s) · ${texteMontants(x.today.amounts) || '—'}`} reason="Aucun montant ce jour." />
  );
  const mesures = d.kpis.filter((k) => k.status !== 'NON_MESURE');
  return (
    <>
      {t && (
        <Tuiles label={`Journée du ${t.today}`} max={3}>
          {jour('Confirmé', t.confirmed, 'info', true)}
          {jour('Réglé', t.settled, 'good')}
          {jour('Rapproché', t.reconciled, 'good')}
        </Tuiles>
      )}
      {!t && mesures.length > 0 && <Tuiles label="Indicateurs clés" max={4}>{mesures.slice(0, 4).map((k) => <KpiTileDe key={k.code} k={k} href="/pilotage/indicateurs" />)}</Tuiles>}
      <Visuels label={`${d.label} en graphiques`}>
        <LadderFunnel className="viz-span-2" title="Les six états de la recette" subtitle="Emboîtés, jamais additionnés — contre-valeur indicative CDF" steps={sixEtatsFromLadder(d.ladder, texteMontants)} />
        {d.kpis.length > 0 && <StatusDistribution title="Indicateurs par état" unitLabel="indicateurs" items={etatsDe(d.kpis, (k) => k.status, ETATS_KPI)} />}
        {d.byCommune && (
          <HeatGrid className="viz-span-2" title="Rapproché par commune" subtitle="Contre-valeur indicative CDF — fait générateur" measureLabel="Rapproché (contre-valeur CDF)" unit="CDF" format={fmtCompact}
            unmeasuredReason="aucun paiement rapproché rattaché à cette commune" cells={d.byCommune.rows.filter((r) => r.key !== 'NON_ATTRIBUE').map((r) => ({ commune: r.key, value: cdf(r.values.reconciled) }))} />
        )}
        {d.byChannel && (
          <DonutViz title="Confirmé par canal de paiement" centerLabel="CDF (contre-valeur)" format={fmtCompact}
            slices={d.byChannel.rows.map((r) => ({ key: r.key, label: CHANNEL_LABELS[r.key] ?? r.key, value: cdf(r.values.confirmed) ?? 0 }))} />
        )}
        {d.byCategory && (
          <DonutViz title="Liquidé par catégorie de recette" centerLabel="CDF (contre-valeur)" format={fmtCompact}
            slices={d.byCategory.rows.map((r) => ({ key: r.key, label: CATEGORY_LABELS[r.key] ?? r.key, value: cdf(r.values.assessed) ?? 0 }))} />
        )}
        {d.series && d.series.length > 0 && (
          <LineAreaViz className="viz-span-2" title="Confirmé et rapproché, mois par mois" subtitle="Contre-valeur indicative CDF" granularity="month" format={fmtCompact}
            series={[{ key: 'c', label: 'Confirmé' }, { key: 'r', label: 'Rapproché' }]} points={d.series.map((m) => ({ date: m.month, values: { c: cdf(m.confirmed), r: cdf(m.reconciled) } }))} />
        )}
        {d.recovery && (
          <BarChartViz title="Retards par ancienneté" subtitle="Nombre d’obligations en retard" orientation="vertical" format={entier} emptyText="Aucun retard"
            series={[{ key: 'n', label: 'Obligations' }]} rows={d.recovery.buckets.map((b) => ({ key: b.code, label: b.label, values: { n: b.count } }))} />
        )}
        {d.suspense && (
          <BarChartViz title="Suspens par âge" subtitle="Confirmé non rapproché (nombre)" orientation="vertical" format={entier} emptyText="Aucun suspens"
            series={[{ key: 'n', label: 'Paiements' }]} rows={d.suspense.map((b) => ({ key: b.code, label: b.label, values: { n: b.count } }))} />
        )}
        {d.providers && (
          <BarChartViz className="viz-span-2" title="Prestataires — chaîne des paiements" subtitle="Confirmés, réglés, rapprochés (nombre)" orientation="horizontal" format={entier} emptyText="Aucun paiement confirmé"
            series={[{ key: 'c', label: 'Confirmés' }, { key: 's', label: 'Réglés' }, { key: 'r', label: 'Rapprochés' }]} rows={d.providers.map((p) => ({ key: p.provider, label: p.provider, values: { c: p.confirmed, s: p.settled, r: p.reconciled } }))} />
        )}
        {d.objects && (
          <DonutViz title={`Assiette recensée${d.commune ? ` — ${d.commune}` : ''}`} centerLabel="objets" emptyText="Aucun objet recensé"
            slices={d.objects.byCategory.map((c) => ({ key: c.category, label: c.category.replace(/_/g, ' ').toLowerCase(), value: c.count }))} />
        )}
        {d.instructions && (
          <BarChartViz title="Instructions par statut" orientation="vertical" format={entier} emptyText="Aucune instruction"
            series={[{ key: 'n', label: 'Instructions' }]} rows={d.instructions.byStatus.map((b) => ({ key: b.status, label: INSTR_STATUS[b.status]?.label ?? b.status, values: { n: b.count } }))} />
        )}
      </Visuels>
    </>
  );
}

interface ProfileRef { code: string; label: string; description: string }
interface InstructionsSummary { total: number; byStatus: { status: string; count: number }[]; overdue: { id: string; number: string; subject: string; entity: string; deadline: string }[]; closedOnTime: number; closedLate: number }
interface Bucket extends Amounts { code: string; label: string; count: number }
interface DayTiles { today: string; confirmed: Record<'today' | 'yesterday', Amounts>; settled: Record<'today' | 'yesterday', Amounts>; reconciled: Record<'today' | 'yesterday', Amounts> }
interface ProfileData {
  profile: string; label: string; description: string; generatedAt: string; scope: Scope; rule: string;
  ladder: LadderLevel[]; contested: Contested; kpis: Kpi[];
  tiles?: DayTiles; criticalAlerts?: number;
  byCommune?: DrillResult; byCategory?: DrillResult; byEntity?: DrillResult; byChannel?: DrillResult; series?: SeriesPoint[];
  recovery?: { note: string; buckets: Bucket[] };
  litigation?: { open: number; decided: number; byDecision: { decision: string; count: number }[] };
  performance?: { note: string; rows: { issuer: string; issuerId: string; issued: number; rectified: number }[] };
  suspense?: Bucket[];
  exceptions?: { open: number; byType: { type: string; count: number; over30: number }[] };
  providers?: { provider: string; confirmed: number; settled: number; reconciled: number; awaiting: number }[];
  ledger?: { balanced: boolean; entries: number; headHash: string | null };
  commune?: string | null;
  objects?: { total: number; validated: number; byCategory: { category: string; count: number }[] };
  integrity?: { audit: { ok: boolean; length: number; headHash: string; reason?: string }; ledger: { balanced: boolean; entries: number; headHash: string | null } };
  sensitive?: { code: string; label: string; count: number }[];
  exports?: { exportId: string; kind: string; format: string; generatedAt: string; sha256: string; generatedBy: { id: string } }[];
  // § 8.7 et § 26.2 : ventilation par origine ; cabinet, secrétariat général, juristes, superviseurs, chefs de service
  origins?: Origins;
  instructions?: InstructionsSummary | null;
  decisions?: { note: string; rows: { action: string; count: number }[] };
  publications?: { period: string; version: number; publishedAt: string; authority: string }[];
  rules?: { total: number; byStatus: { status: string; count: number }[]; expiring30: { id: string; code: string; effectiveTo?: string }[]; expiring90: number; suspended: number; uncertified: number; conflictsOpen: number | null; note: string };
  field?: { available: boolean; note: string; missions?: { total: number; overdue: number; byStatus: { status: string; count: number }[] }; findings?: { total: number; byStatus: { status: string; count: number }[] }; agents?: { agentId: string; missions: number; findings: number; validated: number; rejected: number }[] };
}

function InstructionsBlock({ s }: { s: InstructionsSummary }) {
  return (
    <>
      <div className="pl-figs">
        <div className="pl-fig"><span>Instructions</span><strong>{s.total}</strong></div>
        {s.byStatus.map((b) => <div className="pl-fig" key={b.status}><span>{INSTR_STATUS[b.status]?.label ?? b.status}</span><strong>{b.count}</strong></div>)}
        <div className="pl-fig"><span>En retard</span><strong>{s.overdue.length}</strong></div>
        <div className="pl-fig"><span>Closes dans / hors délai</span><strong>{s.closedOnTime} / {s.closedLate}</strong></div>
      </div>
      {s.overdue.length > 0 && <ul className="small">{s.overdue.map((o) => <li key={o.id}>{o.number} — {o.subject} ({o.entity}, échéance {o.deadline})</li>)}</ul>}
    </>
  );
}

function DayFigures({ t }: { t: DayTiles }) {
  const f = useFmt();
  const cell = (label: string, x: Record<'today' | 'yesterday', Amounts>) => (
    <div className="pl-fig">
      <span>{label} aujourd’hui</span>
      <strong>{f.amounts(x.today.amounts)}</strong>
      <span>{x.today.count ?? 0} paiement(s) · veille : {f.amounts(x.yesterday.amounts)}</span>
    </div>
  );
  return <div className="pl-figs">{cell('Confirmé', t.confirmed)}{cell('Réglé', t.settled)}{cell('Rapproché', t.reconciled)}</div>;
}

function BucketTable({ rows, caption }: { rows: Bucket[]; caption: string }) {
  const f = useFmt();
  return (
    <DataTable caption={caption} rows={rows} rowKey={(r) => r.code}
      columns={[
        { key: 'l', label: 'Tranche', render: (r) => r.label, primary: true },
        { key: 'n', label: 'Nombre', render: (r) => r.count, num: true },
        { key: 'a', label: 'Montants (devise légale)', render: (r) => f.amounts(r.amounts), num: true },
        { key: 'c', label: 'Contre-valeur CDF', render: (r) => f.cdf(r.consolidatedCdf), num: true },
      ]} />
  );
}

/**
 * Les six états de la recette distingués explicitement (Document maître FR 2, ch. 42, critère 10) : potentiel,
 * constaté, encaissé, réglé, rapproché, disponible — niveaux de l'échelle, jamais additionnés ; non mesuré déclaré.
 */
export function SixEtats({ levels }: { levels: { level: string; label: string; measured: boolean; consolidatedCdf: { amount: string; currency: string } | null; note?: string }[] }) {
  return (
    <section className="panel span-12" aria-labelledby="six-etats">
      <header className="panel-head"><div><h2 className="panel-title" id="six-etats">Six états de la recette</h2><p className="panel-sub">Distingués explicitement, jamais additionnés (contre-valeur CDF indicative)</p></div></header>
      <div className="pl-figs">
        {SIX_ETATS.map((s) => {
          const l = levels.find((x) => x.level === s.niveau);
          return (
            <div key={s.code} className="pl-fig">
              <span>{s.libelle}</span>
              <strong>{!l || !l.measured ? 'Non mesuré' : l.consolidatedCdf ? `${Number(l.consolidatedCdf.amount).toLocaleString('fr-FR', { maximumFractionDigits: 0 })} ${l.consolidatedCdf.currency}` : '—'}</strong>
              <span className="small muted">{l?.label ?? s.niveau}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function Tableaux() {
  const { user } = useApp();
  const [params, setParams] = useSearchParams();
  const list = useApi(() => api<{ profiles: ProfileRef[] }>('/v1/pilotage/tableaux'), [user?.id]);
  const profiles = list.data?.profiles ?? [];
  const wanted = params.get('profil');
  const current = profiles.find((p) => p.code === wanted)?.code ?? profiles[0]?.code ?? null;
  const [filters, setFilters] = useState<Filters>({});
  useEffect(() => { setFilters({}); }, [user?.id]);
  const data = useApi<ProfileData>(current ? () => api<ProfileData>(`/v1/pilotage/tableaux/${current}${qs({ ...filters })}`) : null, [current, user?.id, JSON.stringify(filters)]);

  const head = <PageHead eyebrow="Pilotage · données réelles" title="Tableaux de bord par profil" lead="Chaque tableau lit l’échelle unifiée de la recette sur les données du socle, dans le périmètre de votre rôle. Agrégats seulement." />;
  if (list.loading) return <div className="page page-wide">{head}<Loading /></div>;
  if (list.error) return <div className="page page-wide">{head}<ErrorState error={list.error} onRetry={list.reload} /></div>;
  if (!current) return <div className="page page-wide">{head}<EmptyState title="Aucun tableau de pilotage pour votre rôle" icon="lock">Les tableaux sont réservés aux autorités, régies, Trésor, communes et auditeurs. La transparence publique reste ouverte à tous.<p><Link to="/transparence">Consulter la transparence publique</Link></p></EmptyState></div>;

  const d = data.data;
  const exportParams = { ...filters };
  return (
    <div className="page page-wide">
      {head}
      <div className="pl-toolbar">
        <div className="pl-tabs" role="group" aria-label="Profil">
          {profiles.map((p) => (
            <button key={p.code} type="button" aria-pressed={p.code === current} onClick={() => { setParams({ profil: p.code }); }}>{p.label}</button>
          ))}
        </div>
        <ExportButton kind="echelle" params={exportParams} label="Exporter l’échelle (signé)" />
      </div>
      <FiltersBar value={filters} onChange={setFilters} lock={d?.scope ?? null} />
      {data.loading && !d ? <Loading /> : data.error ? <ErrorState error={data.error} onRetry={data.reload} /> : d && (
        <>
          <ScopeLine scope={d.scope} generatedAt={d.generatedAt} />
          <p className="small muted">{d.description}</p>
          <div className="dash-grid">
            <VisuelsProfil d={d} />
            {d.kpis.length > 0 && <div className="span-12"><KpiTiles kpis={d.kpis.filter((k) => k.status !== 'NON_MESURE').slice(0, 8)} /></div>}
            {d.tiles && <Section title="Encaissement du jour" sub={`Journée du ${d.tiles.today} — comparaison avec la veille`}><DayFigures t={d.tiles} /></Section>}
            <SixEtats levels={d.ladder} />
            <LadderChart className="span-7" levels={d.ladder} contested={d.contested} />
            {d.byCommune && <DrillChart className="span-5" drill={d.byCommune} title="Par commune (fait générateur)" />}
            {d.byCategory && <DrillChart className="span-6" drill={d.byCategory} title="Par catégorie de recette" />}
            {d.byEntity && <DrillChart className="span-6" drill={d.byEntity} title="Par administration" />}
            {d.byChannel && <DrillChart className="span-6" drill={d.byChannel} title="Par canal de paiement" levels={['confirmed', 'settled', 'reconciled']} />}
            {d.series && <SeriesChart className="span-6" months={d.series} />}
            {d.origins && <Section title="Ventilation par origine (§ 8.7)" sub={d.origins.basis}><OriginsTable origins={d.origins} /></Section>}
            {d.instructions !== undefined && (
              <Section title="Suivi des instructions" sub="Instruction → service désigné → échéance → rapport → clôture" tools={<Link className="btn btn-ghost btn-sm" to="/pilotage/instructions"><Icon name="arrowRight" size={16} /> Ouvrir</Link>}>
                {d.instructions ? <InstructionsBlock s={d.instructions} /> : <p className="muted">Module de planification non chargé.</p>}
              </Section>
            )}
            {d.decisions && (
              <Section title="Décisions et mise en œuvre" sub={d.decisions.note}>
                <DataTable caption="Décisions" rows={d.decisions.rows} rowKey={(r) => r.action} empty={<p className="muted">Aucune décision journalisée.</p>}
                  columns={[{ key: 'a', label: 'Acte', render: (r) => r.action, primary: true }, { key: 'n', label: 'Nombre', render: (r) => r.count, num: true }]} />
                {d.publications && d.publications.length > 0 && <p className="small muted">Publications : {d.publications.map((p) => `${p.period} v${p.version}`).join(', ')}</p>}
              </Section>
            )}
            {d.rules && (
              <Section title="État du référentiel juridique" sub={d.rules.note}>
                <div className="pl-figs">
                  <div className="pl-fig"><span>Fiches</span><strong>{d.rules.total}</strong></div>
                  {d.rules.byStatus.map((b) => <div className="pl-fig" key={b.status}><span>{b.status.replace(/_/g, ' ').toLowerCase()}</span><strong>{b.count}</strong></div>)}
                  <div className="pl-fig"><span>Expirant sous 90 jours</span><strong>{d.rules.expiring90}</strong></div>
                  <div className="pl-fig"><span>Actives non certifiées</span><strong>{d.rules.uncertified}</strong></div>
                  <div className="pl-fig"><span>Suspendues</span><strong>{d.rules.suspended}</strong></div>
                  <div className="pl-fig"><span>Conflits ouverts</span><strong>{d.rules.conflictsOpen ?? '—'}</strong></div>
                </div>
              </Section>
            )}
            {d.field && (
              <Section title="Charge, productivité et qualité du terrain" sub={d.field.note}>
                {!d.field.available ? <p className="muted">{d.field.note}</p> : (
                  <DataTable caption="Agents" rows={d.field.agents ?? []} rowKey={(r) => r.agentId} empty={<p className="muted">Aucune activité.</p>}
                    columns={[
                      { key: 'a', label: 'Agent', render: (r) => r.agentId, primary: true },
                      { key: 'm', label: 'Missions', render: (r) => r.missions, num: true },
                      { key: 'f', label: 'Constats', render: (r) => r.findings, num: true },
                      { key: 'v', label: 'Validés / rejetés', render: (r) => `${r.validated} / ${r.rejected}`, num: true },
                    ]} />
                )}
              </Section>
            )}

            {d.recovery && (
              <Section title="Recouvrement — obligations en retard" sub={d.recovery.note}><BucketTable rows={d.recovery.buckets} caption="Retards par ancienneté" /></Section>
            )}
            {d.litigation && (
              <Section title="Contentieux" sub="Réclamations sur le périmètre">
                <div className="pl-figs">
                  <div className="pl-fig"><span>Ouvertes</span><strong>{d.litigation.open}</strong></div>
                  <div className="pl-fig"><span>Décidées</span><strong>{d.litigation.decided}</strong></div>
                  {d.litigation.byDecision.map((b) => <div className="pl-fig" key={b.decision}><span>{b.decision.replace(/_/g, ' ').toLowerCase()}</span><strong>{b.count}</strong></div>)}
                </div>
              </Section>
            )}
            {d.performance && (
              <Section title="Performance des services émetteurs" sub={d.performance.note}>
                <DataTable caption="Performance" rows={d.performance.rows} rowKey={(r) => r.issuerId}
                  columns={[
                    { key: 'i', label: 'Service', render: (r) => r.issuer, primary: true },
                    { key: 'n', label: 'Obligations émises', render: (r) => r.issued, num: true },
                    { key: 'r', label: 'Rectifications fondées', render: (r) => r.rectified, num: true },
                  ]} />
              </Section>
            )}
            {d.suspense && <Section title="Suspens : confirmé non rapproché" sub="Par ancienneté de la confirmation prestataire"><BucketTable rows={d.suspense} caption="Suspens par âge" /></Section>}
            {d.exceptions && (
              <Section title="Files d’exception" sub={`${d.exceptions.open} exception(s) ouverte(s)`} tools={<Link className="btn btn-ghost btn-sm" to="/tresor"><Icon name="arrowRight" size={16} /> Ouvrir le Trésor</Link>}>
                {d.exceptions.byType.length === 0 ? <p className="muted">Aucune exception ouverte.</p> : (
                  <DataTable caption="Exceptions" rows={d.exceptions.byType} rowKey={(r) => r.type}
                    columns={[{ key: 't', label: 'Type', render: (r) => r.type.replace(/_/g, ' ').toLowerCase(), primary: true }, { key: 'n', label: 'Ouvertes', render: (r) => r.count, num: true }, { key: 'o', label: '> 30 jours', render: (r) => r.over30, num: true }]} />
                )}
              </Section>
            )}
            {d.providers && (
              <Section title="Prestataires" sub={d.ledger ? `Grand livre : ${d.ledger.entries} écriture(s), ${d.ledger.balanced ? 'équilibré' : 'DÉSÉQUILIBRÉ'}` : undefined}>
                {d.providers.length === 0 ? <p className="muted">Aucun paiement confirmé.</p> : (
                  <DataTable caption="Prestataires" rows={d.providers} rowKey={(r) => r.provider}
                    columns={[
                      { key: 'p', label: 'Prestataire', render: (r) => r.provider, primary: true },
                      { key: 'c', label: 'Confirmés', render: (r) => r.confirmed, num: true },
                      { key: 's', label: 'Réglés', render: (r) => r.settled, num: true },
                      { key: 'r', label: 'Rapprochés', render: (r) => r.reconciled, num: true },
                      { key: 'a', label: 'En attente', render: (r) => r.awaiting > 0 ? <StatusBadge tone="warning" label={String(r.awaiting)} /> : '0', num: true },
                    ]} />
                )}
              </Section>
            )}
            {d.objects && (
              <Section title={`Assiette recensée${d.commune ? ` — ${d.commune}` : ''}`} sub="Objets fiscaux du territoire (fait générateur)">
                <div className="pl-figs">
                  <div className="pl-fig"><span>Objets recensés</span><strong>{d.objects.total}</strong></div>
                  <div className="pl-fig"><span>Objets validés</span><strong>{d.objects.validated}</strong></div>
                  {d.objects.byCategory.map((c) => <div className="pl-fig" key={c.category}><span>{c.category.replace(/_/g, ' ').toLowerCase()}</span><strong>{c.count}</strong></div>)}
                </div>
              </Section>
            )}
            {d.integrity && (
              <Section title="Intégrité des chaînes" sub="Journal d’audit chaîné et grand livre en partie double" tools={<Link className="btn btn-secondary btn-sm" to="/pilotage/piste-audit"><Icon name="history" size={16} /> Piste d’audit par dossier</Link>}>
                <div className="pl-figs">
                  <div className="pl-fig"><span>Journal d’audit</span><strong><StatusBadge tone={d.integrity.audit.ok ? 'good' : 'critical'} label={d.integrity.audit.ok ? 'Intègre' : 'Rompu'} /></strong><span>{d.integrity.audit.length} événements · <code className="hash">{d.integrity.audit.headHash.slice(0, 16)}…</code></span></div>
                  <div className="pl-fig"><span>Grand livre</span><strong><StatusBadge tone={d.integrity.ledger.balanced ? 'good' : 'critical'} label={d.integrity.ledger.balanced ? 'Équilibré' : 'Déséquilibré'} /></strong><span>{d.integrity.ledger.entries} écriture(s)</span></div>
                  {d.sensitive?.map((s) => <div className="pl-fig" key={s.code}><span>{s.label}</span><strong>{s.count}</strong></div>)}
                </div>
              </Section>
            )}
            {d.exports && (
              <Section title="Extractions signées récentes" sub="Chaque export est journalisé avec son empreinte">
                {d.exports.length === 0 ? <p className="muted">Aucun export.</p> : (
                  <DataTable caption="Exports" rows={d.exports} rowKey={(r) => `${r.exportId}-${r.format}`}
                    columns={[
                      { key: 'k', label: 'Export', render: (r) => `${r.kind} (${r.format})`, primary: true },
                      { key: 'u', label: 'Par', render: (r) => r.generatedBy.id },
                      { key: 'h', label: 'SHA-256', render: (r) => <code className="hash">{r.sha256.slice(0, 16)}…</code> },
                    ]} />
                )}
              </Section>
            )}
          </div>
          <p className="small muted">{d.rule}</p>
        </>
      )}
    </div>
  );
}

