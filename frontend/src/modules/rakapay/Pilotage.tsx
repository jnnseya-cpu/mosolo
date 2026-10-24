/**
 * Tableau de pilotage RakaPay / wewa (agrégats seulement) : couverture du recensement, conformité du pass,
 * paiement numérique, plaintes pour prélèvements irréguliers, billetterie, recette par commune du fait générateur.
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { MoneyText } from '../../components/MoneyText';
import { StatusBadge } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { PilotageVisuel } from './visuels';
import './rakapay.css';
import { ConstatsPanel, GracePanel } from './Billetterie';

interface StationCov { stationId: string; code: string; name: string; commune: string; registered: number; drivers: number; estimated: number | null; coverageRate: string | null; green: number; complianceNow: string }
interface Indicators {
  serverTime: string; notice: string;
  coverage: { registeredMotos: number; registeredDrivers: number; byStation: StationCov[]; byCommune: { commune: string; registered: number; estimated: number; green: number }[] };
  compliance: { controlled: number; green: number; rate: string; constats: { total: number; open: number; classified: number; transmitted: number } };
  digitalPayment: { passesIssued: number; paidDigitally: number; rate: string; target: string; byChannel: Record<string, number>; groupPaid: number; cashOnRoad: number };
  complaints: { total: number; open: number; closed: number; averageHandlingHours: string | null; confirmedShare: string | null; byCommune: { commune: string; count: number }[]; irregularLevies?: number; irregularLeviesConfirmed?: number };
  tickets: { sold: number; active: number; controls: number; reuseAttempts: number; penaltiesRetained?: number; penaltiesContested?: number };
  revenueByCommune: { commune: string; basis: string; amounts: MoneyJSON[] }[];
  titres: { wewa: { credentials: { active: number }; controls: { redShare: string; reuseAttempts: number; offline: number }; renewals: { total: number; beforeExpiry: number } } };
}
interface Complaint { id: string; category: string; commune: string; occurredAt: string; description: string; status: string; receivedAt: string; amountDemanded?: MoneyJSON }

const pct = (r: string | null) => (r === null ? '—' : `${(Number(r) * 100).toFixed(0)} %`);
const CHANNEL: Record<string, string> = { USSD: 'USSD', MOBILE_MONEY: 'Mobile Money', AGENT_POINT: 'Point agréé', BANK: 'Banque', CARD: 'Carte', QR: 'QR', TRANSFER: 'Virement' };
const CATEGORY: Record<string, string> = { PRELEVEMENT_IRREGULIER: 'Prélèvement irrégulier', DEMANDE_ESPECES: 'Demande d’espèces', CONTROLE_ABUSIF: 'Contrôle abusif', AUTRE: 'Autre' };

function Meter({ label, value, max, text }: { label: string; value: number; max: number; text: string }) {
  const w = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="rkx-meter">
      <div className="rkx-meter-row"><span>{label}</span><span>{text}</span></div>
      <div className="rkx-meter-track" role="img" aria-label={`${label} : ${text}`}><div className="rkx-meter-fill" style={{ width: `${w}%` }} /></div>
    </div>
  );
}

function Complaints() {
  const { user, fmtDate } = useApp();
  // Lecture des signalements (rakapay:complaint.read) : R01, R02, R07, R22, R24 — pas d'appel voué au refus pour les autres rôles.
  const canRead = !!user?.roles.some((r) => ['R01', 'R02', 'R07', 'R22', 'R24'].includes(r));
  const list = useApi(canRead ? () => api<Complaint[]>('/v1/rakapay/signalements') : null, [user?.id]);
  const [err, setErr] = useState<string | null>(null);
  const canHandle = !!user?.roles.some((r) => r === 'R24' || r === 'R07');
  async function handle(id: string, status: string, confirmed?: boolean) {
    setErr(null);
    const motif = window.prompt('Motif de la décision (obligatoire)');
    if (!motif || motif.trim().length < 5) return;
    try { await api(`/v1/rakapay/signalements/${id}/traitement`, { method: 'POST', body: { status, motif, ...(confirmed !== undefined ? { confirmed } : {}) } }); list.reload(); }
    catch (ex) { setErr(describeError(ex).message); }
  }
  if (!canRead) return null;
  if (list.loading) return <Loading />;
  if (list.error) return null;
  return (
    <section className="panel" aria-labelledby="rkp-sig">
      <div className="panel-head"><h2 className="panel-title" id="rkp-sig"><Icon name="alert" size={18} /> Signalements de prélèvements irréguliers</h2><span className="count">{list.data?.length ?? 0}</span></div>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      {!list.data?.length ? <EmptyState title="Aucun signalement" icon="check" /> : (
        <ul className="list-rows">
          {list.data.map((c) => (
            <li key={c.id} className="list-row">
              <div className="min0">
                <p className="row-title">{CATEGORY[c.category] ?? c.category} · {c.commune}</p>
                <p className="small muted">{c.id} · {fmtDate(c.occurredAt, true)}{c.amountDemanded ? <> · réclamé : <MoneyText money={c.amountDemanded} /></> : null}</p>
                <p className="small">{c.description}</p>
              </div>
              <div className="row-side">
                <StatusBadge tone={c.status === 'CLOS' ? 'neutral' : 'warning'} label={c.status === 'RECU' ? 'Reçu' : c.status === 'QUALIFIE' ? 'Qualifié' : c.status === 'TRANSMIS' ? 'Transmis' : 'Clos'} />
                {canHandle && c.status !== 'CLOS' && (
                  <>
                    {c.status === 'RECU' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void handle(c.id, 'QUALIFIE')}>Qualifier</button>}
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void handle(c.id, 'CLOS', true)}>Clore — confirmé</button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void handle(c.id, 'CLOS', false)}>Clore — non confirmé</button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function Pilotage() {
  const { user, fmtDate } = useApp();
  const ind = useApi(() => api<Indicators>('/v1/rakapay/indicateurs'), [user?.id]);
  const d = ind.data;
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Pilotage · RakaPay · modules 76 · 81" title="Tableau de pilotage RakaPay" lead="Couverture du recensement des wewa, conformité du pass, paiement numérique et plaintes — agrégats, sans donnée nominative." >
        <button type="button" className="btn btn-secondary btn-sm" onClick={ind.reload}><Icon name="refresh" size={16} /> Actualiser</button>
      </PageHead>
      {ind.loading ? <Loading /> : ind.error ? <ErrorState error={ind.error} onRetry={ind.reload}><p className="small">Réservé au pilotage (Gouverneur, cabinet, Finances, direction de régie, audit, observateurs).</p></ErrorState> : !d ? null : (
        <>
          <ExampleNotice text={d.notice} />
          <div className="kpi-row rkx-kpis">
            <div className="kpi"><p className="kpi-label">Motos enregistrées</p><p className="kpi-value">{d.coverage.registeredMotos}</p><div className="kpi-foot"><span className="kpi-sub">{d.coverage.registeredDrivers} conducteurs · enregistrement gratuit</span></div></div>
            <div className="kpi"><p className="kpi-label">Conformité au contrôle</p><p className="kpi-value">{pct(d.compliance.rate)}</p><div className="kpi-foot"><span className="kpi-sub">{d.compliance.green} en vert / {d.compliance.controlled} contrôlées</span></div></div>
            <div className="kpi"><p className="kpi-label">Paiement numérique</p><p className="kpi-value">{pct(d.digitalPayment.rate)}</p><div className="kpi-foot"><StatusBadge tone="good" label={`Espèces sur la route : ${d.digitalPayment.cashOnRoad}`} /></div></div>
            <div className="kpi"><p className="kpi-label">Plaintes ouvertes</p><p className="kpi-value">{d.complaints.open}</p><div className="kpi-foot"><span className="kpi-sub">{d.complaints.total} reçues · {d.complaints.averageHandlingHours ? `délai moyen ${d.complaints.averageHandlingHours} h` : 'aucune close'}</span></div></div>
          </div>

          <PilotageVisuel d={d} />
          <div className="rkx-grid">
            <section className="panel" aria-labelledby="rkp-cov">
              <div className="panel-head"><div><h2 className="panel-title" id="rkp-cov"><Icon name="pin" size={18} /> Couverture par station</h2><p className="panel-sub">Motos enregistrées / motos estimées [EXEMPLE — à établir par le recensement]</p></div></div>
              <DataTable
                caption="Couverture et conformité par station"
                rows={d.coverage.byStation}
                rowKey={(r) => r.stationId}
                columns={[
                  { key: 'st', label: 'Station', primary: true, render: (r) => <><strong>{r.name}</strong><br /><span className="small muted">{r.code} · {r.commune}</span></> },
                  { key: 'reg', label: 'Enregistrées', num: true, render: (r) => r.registered },
                  { key: 'est', label: 'Estimées [EX.]', num: true, render: (r) => r.estimated ?? '—' },
                  { key: 'cov', label: 'Couverture', render: (r) => <Meter label="" value={r.registered} max={r.estimated ?? 0} text={pct(r.coverageRate)} /> },
                  { key: 'ok', label: 'En règle', num: true, render: (r) => `${r.green} / ${r.registered}` },
                ]}
              />
            </section>
            <div className="stack">
              <section className="panel" aria-labelledby="rkp-pay">
                <h2 className="panel-title" id="rkp-pay"><Icon name="phone" size={18} /> Paiement des pass</h2>
                <div className="stack-sm" style={{ marginTop: 12 }}>
                  {Object.entries(d.digitalPayment.byChannel).map(([ch, n]) => <Meter key={ch} label={CHANNEL[ch] ?? ch} value={n} max={d.digitalPayment.passesIssued} text={`${n}`} />)}
                  <p className="small muted">{d.digitalPayment.groupPaid} pass payés en groupe par une coopérative · cible 100 % numérique · {d.digitalPayment.passesIssued} pass délivrés.</p>
                </div>
              </section>
              <section className="panel" aria-labelledby="rkp-ctl">
                <h2 className="panel-title" id="rkp-ctl"><Icon name="shieldCheck" size={18} /> Contrôles et constats</h2>
                <dl className="kv kv-dense" style={{ marginTop: 8 }}>
                  <div><dt>Pass actifs</dt><dd>{d.titres.wewa.credentials.active}</dd></div>
                  <div><dt>Part des contrôles en rouge</dt><dd>{pct(d.titres.wewa.controls.redShare)}</dd></div>
                  <div><dt>Contrôles hors ligne</dt><dd>{d.titres.wewa.controls.offline}</dd></div>
                  <div><dt>Constats ouverts / total</dt><dd>{d.compliance.constats.open} / {d.compliance.constats.total} <span className="small muted">— aucun montant</span></dd></div>
                  <div><dt>Renouvellements avant échéance</dt><dd>{d.titres.wewa.renewals.beforeExpiry} / {d.titres.wewa.renewals.total}</dd></div>
                  <div><dt>Tickets urbains vendus</dt><dd>{d.tickets.sold} · {d.tickets.controls} contrôles · {d.tickets.reuseAttempts} réutilisation(s) détectée(s)</dd></div>
                  <div><dt>Pénalités retenues / contestées</dt><dd>{d.tickets.penaltiesRetained ?? 0} / {d.tickets.penaltiesContested ?? 0}</dd></div>
                  <div><dt>Plaintes de prélèvements irréguliers</dt><dd>{d.complaints.irregularLevies ?? 0} <span className="small muted">({d.complaints.irregularLeviesConfirmed ?? 0} confirmée(s))</span></dd></div>
                </dl>
              </section>
              <section className="panel" aria-labelledby="rkp-rev">
                <h2 className="panel-title" id="rkp-rev"><Icon name="building" size={18} /> Recette par commune</h2>
                <p className="small muted">Commune de la station (départ ou attache, § 20.3), paiements confirmés.</p>
                {d.revenueByCommune.length === 0 ? <EmptyState title="Aucune recette confirmée" icon="cash" /> : (
                  <ul className="list-rows" style={{ marginTop: 8 }}>
                    {d.revenueByCommune.map((r) => <li key={r.commune} className="list-row"><span>{r.commune}</span><span className="row-side">{r.amounts.map((a) => <MoneyText key={a.currency} money={a} />)}</span></li>)}
                  </ul>
                )}
              </section>
            </div>
          </div>
          <Complaints />
          {user?.roles.some((r) => r === 'R06' || r === 'R07' || r === 'R05') && <><GracePanel /><ConstatsPanel module="81" /><ConstatsPanel module="76" /></>}
          <p className="small muted" style={{ marginTop: 12 }}>Calculé à l’heure serveur le {fmtDate(d.serverTime, true)}.</p>
        </>
      )}
    </div>
  );
}
