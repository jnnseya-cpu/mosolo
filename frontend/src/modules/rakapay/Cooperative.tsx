/**
 * Espace coopérative wewa (module 81) : membres et conformité, alertes de renouvellement, paiement groupé
 * (une référence, activation individuelle de chaque pass), inscription gratuite des membres.
 * La coopérative n'encaisse aucune espèce, ne modifie aucun tarif et ne valide aucun contrôle.
 * Accréditation et suspension : décision humaine motivée du responsable du module.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { Money, type MoneyJSON } from '@mosolo/shared';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { MoneyText } from '../../components/MoneyText';
import { StatusBadge } from '../../components/StatusBadge';
import { ValidityCountdown } from '../../components/ValidityCountdown';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError, newIdempotencyKey } from '../../lib/api';
import { ISSUANCE_LABEL, type Issuance } from '../titres/common';
import '../titres/titres.css';
import { CooperativeVisuel } from './visuels';
import './rakapay.css';

type Duration = 'JOUR' | 'SEMAINE' | 'MOIS';
interface CoopSummary { id: string; code: string; name: string; commune: string; status: string; members: number; demo: boolean }
interface Member {
  motoId: string; plate: string; orderNumber: string; station: { id: string; name: string; commune: string } | null;
  driver: { id: string; displayName: string; vestNumber: string; hasAccount: boolean } | null;
  status: { color: 'VERT' | 'AMBRE' | 'ROUGE'; text: string; nothingToPay?: boolean; validFrom?: string; validUntil?: string };
}
interface CoopView {
  cooperative: { id: string; code: string; name: string; status: string; commune: string; decisions: { decision: string; motif: string; by: string; at: string }[]; demo: boolean };
  stations: { id: string; name: string; commune: string }[];
  members: Member[];
  compliance: { members: number; green: number; red: number; rate: string };
  renewalAlerts: { plate: string; validUntil?: string }[];
  payments: Issuance[];
  prices: { duration: Duration; amount: MoneyJSON | null; demo: boolean; ruleCode: string | null }[];
  limits: string;
}

const TONE = { VERT: 'vert', AMBRE: 'ambre', ROUGE: 'rouge' } as const;
const COOP_STATUS: Record<string, { tone: 'good' | 'warning' | 'critical' | 'info'; label: string }> = {
  ACCREDITE: { tone: 'good', label: 'Accréditée' }, SUSPENDU: { tone: 'critical', label: 'Suspendue (décision motivée)' }, INVITE: { tone: 'info', label: 'Invitée — accréditation en attente' },
};

function Decisions({ coop, onDone }: { coop: CoopView['cooperative']; onDone: () => void }) {
  const [motif, setMotif] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const options = coop.status === 'INVITE' ? ['ACCREDITER'] : coop.status === 'ACCREDITE' ? ['SUSPENDRE'] : ['REACTIVER'];
  const label: Record<string, string> = { ACCREDITER: 'Accréditer', SUSPENDRE: 'Suspendre', REACTIVER: 'Réactiver' };
  async function decide(decision: string) {
    setErr(null);
    try { await api(`/v1/rakapay/cooperatives/${coop.id}/decisions`, { method: 'POST', body: { decision, motif } }); setMotif(''); onDone(); }
    catch (ex) { setErr(describeError(ex).message); }
  }
  return (
    <section className="panel" aria-labelledby="rkc-dec">
      <h2 className="panel-title" id="rkc-dec"><Icon name="scale" size={18} /> Décision du responsable du module</h2>
      <p className="small muted">Aucune suspension automatique : le système constate, une personne habilitée décide avec motif, tracé dans l’audit.</p>
      <div className="form" style={{ marginTop: 12 }}>
        <div className="field"><label className="label" htmlFor="rkc-motif">Motif (obligatoire)</label><textarea id="rkc-motif" rows={2} value={motif} onChange={(e) => setMotif(e.target.value)} /></div>
        {err && <p className="notice notice-err" role="alert">{err}</p>}
        <div className="btn-row">{options.map((o) => <button key={o} type="button" className={`btn ${o === 'SUSPENDRE' ? 'btn-secondary' : 'btn-primary'} btn-sm`} disabled={motif.trim().length < 5} onClick={() => void decide(o)}>{label[o]}</button>)}</div>
      </div>
      {coop.decisions.length > 0 && (
        <ul className="list-rows" style={{ marginTop: 12 }}>
          {coop.decisions.map((d, i) => <li key={i} className="list-row"><div className="min0"><p className="row-title">{label[d.decision] ?? d.decision}</p><p className="small muted">{d.motif}</p></div><span className="small muted">{d.by}</span></li>)}
        </ul>
      )}
    </section>
  );
}

function RegisterMember({ view, onDone }: { view: CoopView; onDone: () => void }) {
  const [f, setF] = useState({ plate: '', orderNumber: '', make: '', ownerLabel: '', stationId: view.stations[0]?.id ?? '', displayName: '', licenceNo: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(null); setMsg(null);
    try {
      const m = await api<{ id: string; plate: string }>('/v1/rakapay/wewa/motos', { method: 'POST', body: { plate: f.plate, orderNumber: f.orderNumber, make: f.make, ownerLabel: f.ownerLabel, stationId: f.stationId, cooperativeId: view.cooperative.id } });
      const d = await api<{ vestNumber: string }>('/v1/rakapay/wewa/conducteurs', { method: 'POST', body: { displayName: f.displayName, licenceNo: f.licenceNo, motoId: m.id, cooperativeId: view.cooperative.id } });
      setMsg(`Moto ${m.plate} et conducteur enregistrés gratuitement — gilet ${d.vestNumber}.`);
      setF({ ...f, plate: '', orderNumber: '', make: '', ownerLabel: '', displayName: '', licenceNo: '' });
      onDone();
    } catch (ex) { setErr(describeError(ex).message); }
  }
  return (
    <details className="panel">
      <summary className="panel-title" style={{ cursor: 'pointer' }}><Icon name="users" size={18} /> Inscrire un membre (gratuit)</summary>
      <form className="form" style={{ marginTop: 12 }} onSubmit={(e) => void submit(e)}>
        <div className="tt-inline-fields">
          <div className="field"><label className="label" htmlFor="rkm-plate">Plaque</label><input id="rkm-plate" className="mono" value={f.plate} onChange={set('plate')} required /></div>
          <div className="field"><label className="label" htmlFor="rkm-ord">Numéro d’ordre</label><input id="rkm-ord" value={f.orderNumber} onChange={set('orderNumber')} required /></div>
          <div className="field"><label className="label" htmlFor="rkm-make">Marque</label><input id="rkm-make" value={f.make} onChange={set('make')} required /></div>
          <div className="field"><label className="label" htmlFor="rkm-own">Propriétaire</label><input id="rkm-own" value={f.ownerLabel} onChange={set('ownerLabel')} required /></div>
          <div className="field"><label className="label" htmlFor="rkm-st">Station d’attache</label><select id="rkm-st" value={f.stationId} onChange={set('stationId')}>{view.stations.map((s) => <option key={s.id} value={s.id}>{s.name} — {s.commune}</option>)}</select></div>
          <div className="field"><label className="label" htmlFor="rkm-drv">Conducteur</label><input id="rkm-drv" value={f.displayName} onChange={set('displayName')} required /></div>
          <div className="field"><label className="label" htmlFor="rkm-lic">Permis n°</label><input id="rkm-lic" value={f.licenceNo} onChange={set('licenceNo')} required /></div>
        </div>
        {err && <p className="notice notice-err" role="alert">{err}</p>}
        {msg && <p className="notice notice-ok" role="status">{msg}</p>}
        <button type="submit" className="btn btn-secondary">Enregistrer</button>
      </form>
    </details>
  );
}

export default function Cooperative() {
  const { user, fmtDate } = useApp();
  const list = useApi(() => api<CoopSummary[]>('/v1/rakapay/cooperatives'), []);
  const [coopId, setCoopId] = useState('');
  const current = coopId || list.data?.[0]?.id || '';
  const view = useApi(current ? () => api<CoopView>(`/v1/rakapay/cooperatives/${current}`) : null, [current, user?.id]);
  const [sel, setSel] = useState<Record<string, Duration | ''>>({});
  const [channel, setChannel] = useState('MOBILE_MONEY');
  const [iss, setIss] = useState<Issuance | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(newIdempotencyKey);
  const v = view.data;
  const isManager = !!user?.roles.some((r) => r === 'R06' || r === 'R07');
  const items = useMemo(() => Object.entries(sel).filter(([, d]) => d).map(([motoId, duration]) => ({ motoId, duration: duration as Duration })), [sel]);
  const total = useMemo(() => {
    if (!v) return null;
    let sum: Money | null = null;
    for (const it of items) {
      const p = v.prices.find((x) => x.duration === it.duration);
      if (!p?.amount) return null;
      sum = sum ? sum.add(Money.fromJSON(p.amount)) : Money.fromJSON(p.amount);
    }
    return sum ? sum.toJSON() : null; // aperçu ; le montant exigible est calculé par le serveur
  }, [items, v]);

  async function pay(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { setIss(await api<Issuance>(`/v1/rakapay/cooperatives/${current}/paiements-groupes`, { method: 'POST', body: { items, channel }, idempotencyKey: key })); setSel({}); setKey(newIdempotencyKey()); view.reload(); }
    catch (ex) { setErr(describeError(ex).message); } finally { setBusy(false); }
  }

  return (
    <div className="page page-wide">
      <PageHead eyebrow="RakaPay · pass wewa · module 81" title="Espace coopérative" lead="Suivre les membres et leur conformité, payer les pass en groupe : une référence, chaque pass activé individuellement.">
        {list.data && list.data.length > 1 && (
          <select aria-label="Coopérative" value={current} onChange={(e) => { setCoopId(e.target.value); setIss(null); }}>
            {list.data.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      </PageHead>
      <ExampleNotice text="Démonstration : coopérative, membres et plaques fictifs ; tarifs issus d’une règle FICTIVE publiée par le circuit." />
      {view.loading || list.loading ? <Loading /> : view.error ? (
        <ErrorState error={view.error} onRetry={view.reload}><p className="small">Espace réservé au compte de la coopérative et au responsable du module (démo : « Coopérative des wewa de Kalamu — gérance »).</p></ErrorState>
      ) : !v ? <EmptyState title="Aucune coopérative" icon="users" /> : (
        <>
          <div className="kpi-row rkx-kpis">
            <div className="kpi"><p className="kpi-label">Membres</p><p className="kpi-value">{v.compliance.members}</p><div className="kpi-foot"><StatusBadge tone={COOP_STATUS[v.cooperative.status]?.tone ?? 'info'} label={COOP_STATUS[v.cooperative.status]?.label ?? v.cooperative.status} /></div></div>
            <div className="kpi"><p className="kpi-label">En règle</p><p className="kpi-value">{v.compliance.green}</p><div className="kpi-foot"><span className="kpi-sub">{Math.round(Number(v.compliance.rate) * 100)} % des membres</span></div></div>
            <div className="kpi"><p className="kpi-label">Pas en règle</p><p className="kpi-value">{v.compliance.red}</p><div className="kpi-foot"><span className="kpi-sub">aucun pass valide</span></div></div>
            <div className="kpi"><p className="kpi-label">À renouveler</p><p className="kpi-value">{v.renewalAlerts.length}</p><div className="kpi-foot"><span className="kpi-sub">phase ambre</span></div></div>
          </div>
          <CooperativeVisuel v={v} />
          <div className="callout callout-info"><Icon name="info" size={18} /><p>{v.limits}</p></div>

          <div className="rkx-grid">
            <section className="panel" aria-labelledby="rkc-members">
              <div className="panel-head"><div><h2 className="panel-title" id="rkc-members"><Icon name="users" size={18} /> Membres et paiement groupé</h2><p className="panel-sub">Cochez une durée pour chaque membre à payer</p></div></div>
              {v.members.length === 0 ? <EmptyState title="Aucun membre" icon="users" /> : (
                <form onSubmit={(e) => void pay(e)}>
                  <ul className="rkx-members">
                    {v.members.map((m) => (
                      <li key={m.motoId} className="rkx-member">
                        <Icon name="moto" size={20} />
                        <div className="min0">
                          <p className="row-title mono">{m.plate}</p>
                          <p className="small muted">{m.driver ? `${m.driver.displayName} · gilet ${m.driver.vestNumber}` : 'Aucun conducteur affecté'} · {m.station?.name ?? '—'}</p>
                          <span className={`tt-status tt-status-sm tt-${TONE[m.status.color]}`}><Icon name={m.status.color === 'ROUGE' && !m.status.nothingToPay ? 'x' : m.status.color === 'VERT' ? 'check' : 'alert'} size={13} /> {m.status.color === 'ROUGE' && !m.status.nothingToPay ? 'Pas en règle' : m.status.validUntil ? `En règle jusqu’au ${fmtDate(m.status.validUntil, true)}` : 'En règle'}</span>
                          {m.status.validUntil && <> <ValidityCountdown compact from={m.status.validFrom} until={m.status.validUntil} /></>}
                        </div>
                        <div className="row-side">
                          <select aria-label={`Durée du pass pour ${m.plate}`} value={sel[m.motoId] ?? ''} disabled={!m.driver} onChange={(e) => setSel({ ...sel, [m.motoId]: e.target.value as Duration | '' })}>
                            <option value="">Ne pas payer</option><option value="JOUR">Jour</option><option value="SEMAINE">Semaine</option><option value="MOIS">Mois</option>
                          </select>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="form" style={{ marginTop: 16 }}>
                    <div className="field"><label className="label" htmlFor="rkc-ch">Moyen de paiement de la coopérative</label>
                      <select id="rkc-ch" value={channel} onChange={(e) => setChannel(e.target.value)}><option value="MOBILE_MONEY">Mobile Money</option><option value="BANK">Virement bancaire</option><option value="USSD">USSD</option><option value="AGENT_POINT">Point de paiement agréé</option></select></div>
                    <div className="rk-price">
                      {total ? <MoneyText money={total} /> : <span className="muted">Sélectionnez des membres</span>}
                      <p className="small muted">Aperçu : {items.length} pass. Le montant exigible est calculé par le serveur selon la règle du registre {v.prices[0]?.ruleCode}{v.prices[0]?.demo ? ' (FICTIVE, démonstration)' : ''}.</p>
                    </div>
                    {err && <p className="notice notice-err" role="alert">{err}</p>}
                    <button type="submit" className="btn btn-primary btn-block" disabled={busy || items.length === 0 || v.cooperative.status !== 'ACCREDITE' || !user?.roles.includes('R30')}>{busy ? 'Création…' : 'Obtenir la référence du paiement groupé'}</button>
                  </div>
                </form>
              )}
              {iss && (
                <div className="result-card" role="status" style={{ marginTop: 16 }}>
                  {iss.payments.map((p) => (
                    <div key={p.paymentReference}>
                      <p className="label">Référence du paiement groupé — {p.commune}</p>
                      <p className="ref-big mono">{p.paymentReference}</p>
                      <p><MoneyText money={p.amount} /> · valable jusqu’au {fmtDate(p.expiresAt, true)}{p.status === 'EN_ATTENTE' && <> <ValidityCountdown compact from={iss.createdAt} until={p.expiresAt} label="Référence de paiement" /></>}</p>
                    </div>
                  ))}
                  <p className="small">Après la confirmation signée de l’opérateur, chaque pass est activé individuellement (plaque + conducteur) et chaque conducteur reçoit un SMS.</p>
                </div>
              )}
            </section>

            <div className="stack">
              {v.renewalAlerts.length > 0 && (
                <section className="panel" aria-labelledby="rkc-alerts">
                  <h2 className="panel-title" id="rkc-alerts"><Icon name="alert" size={18} /> Alertes de renouvellement</h2>
                  <ul className="list-rows" style={{ marginTop: 8 }}>{v.renewalAlerts.map((a) => <li key={a.plate} className="list-row"><span className="mono">{a.plate}</span><span className="small">{a.validUntil ? fmtDate(a.validUntil, true) : ''}</span></li>)}</ul>
                </section>
              )}
              <section className="panel" aria-labelledby="rkc-pay">
                <div className="panel-head"><h2 className="panel-title" id="rkc-pay"><Icon name="history" size={18} /> Paiements groupés</h2><span className="count">{v.payments.length}</span></div>
                {v.payments.length === 0 ? <EmptyState title="Aucun paiement groupé" icon="cash" /> : (
                  <ul className="list-rows">
                    {v.payments.map((p) => (
                      <li key={p.id} className="list-row">
                        <div className="min0"><p className="row-title mono">{p.payments.map((x) => x.paymentReference).join(', ')}</p><p className="small muted">{fmtDate(p.createdAt, true)} · {p.items.length} pass</p></div>
                        <StatusBadge tone={p.status === 'EMISE' ? 'good' : p.status === 'EN_ATTENTE_PAIEMENT' ? 'warning' : 'neutral'} label={ISSUANCE_LABEL[p.status] ?? p.status} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              {user?.roles.includes('R30') && v.cooperative.status === 'ACCREDITE' && <RegisterMember view={v} onDone={view.reload} />}
              {isManager && <Decisions coop={v.cooperative} onDone={() => { view.reload(); list.reload(); }} />}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
