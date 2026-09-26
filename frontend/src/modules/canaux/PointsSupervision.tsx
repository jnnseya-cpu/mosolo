import { useState, type FormEvent, type ReactNode } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { MoneyText } from '../../components/MoneyText';
import { StatusBadge } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { api, describeError } from '../../lib/api';
import { hasRole, POINT_STATUS, POINT_TYPE_LABEL } from './shared';
import './canaux.css';

interface SupPoint {
  id: string; name: string; type: string; operator: string; commune: string; status: string; approval: { authority: string; reference: string };
  referencedBy: string; activatedBy?: string; suspension?: { motif: string; by: string; at: string };
  collectionsToday: number; openExceptions: number; pendingProposals: number; habilitated: boolean; settlementDelayHours: number;
}
interface Proposal { id: string; pointId: string; reason: string; detail: string; status: string; proposedAt: string; decidedBy?: string; motif?: string }
interface Exc { id: string; pointId: string; day: string; type: string; detail: string; expected: MoneyJSON[]; observed: MoneyJSON[]; openedAt: string }
interface Indicators {
  enrolments: { total: number; byCommune: { commune: string; total: number; created: number; toReview: number }[]; rejectedAttempts: number };
  cards: { active: number; blocked: number; revoked: number; reissues: number };
  channels: { ussdSessions: number; ivrSessions: number; authenticatedSessions: number; referencesIssued: number };
  points: { active: number; suspended: number; referenced: number; pilotCommunesWithBankDesk: number; collections: number; collected: MoneyJSON[]; medianSettlementHours: number | null; openExceptions: number; pendingProposals: number };
  verification: { total: number; suspectedEnumeration: number };
}

function Kpi({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return <div className="kpi"><span className="kpi-label">{label}</span><span className="kpi-value">{value}</span>{sub && <span className="kpi-sub">{sub}</span>}</div>;
}

export default function PointsSupervision() {
  const { user, fmtDate } = useApp();
  const sup = useApi(() => api<{ points: SupPoint[]; proposals: Proposal[]; exceptions: Exc[] }>('/v1/payment-points'), [user?.id]);
  const ind = useApi(() => api<Indicators>('/v1/channels/indicators'), [user?.id]);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const tresor = hasRole(user?.roles, 'R17');

  async function act(path: string, body?: unknown, ok = 'Décision enregistrée et journalisée.') {
    setErr(null); setMsg(null);
    try { await api(path, { method: 'POST', ...(body !== undefined ? { body } : {}) }); setMsg(ok); sup.reload(); ind.reload(); } catch (e) { setErr(describeError(e).message); }
  }
  const withMotif = (label: string, f: (motif: string) => void) => {
    const motif = window.prompt(`${label} — motif (10 caractères minimum) :`);
    if (motif && motif.trim().length >= 10) f(motif.trim()); else if (motif !== null) setErr('Motif d’au moins 10 caractères requis.');
  };

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Trésor — points de paiement agréés" title="Supervision du réseau de paiement assisté" lead="Référencement sur agrément, activation par une seconde personne, rapprochement quotidien des versements. Le système constate et propose ; le Trésor décide, avec motif (ARB-12)." />
      <ExampleNotice text="Réseau de démonstration : points, agréments et montants fictifs." />
      {!hasRole(user?.roles, 'R17', 'R18', 'R22', 'R24') && <div className="callout callout-warn">Réservé au Trésor (R17), à l’analyste de rapprochement (R18), à l’audit (R22) et à l’enquête anti-fraude (R24).</div>}
      {ind.data && (
        <div className="kpi-row cx-kpis">
          <Kpi label="Points actifs" value={ind.data.points.active} sub={`${ind.data.points.suspended} suspendu(s) · ${ind.data.points.referenced} en attente d’activation`} />
          <Kpi label="Guichets bancaires MOSOLO" value={`${ind.data.points.pilotCommunesWithBankDesk} / 4`} sub="communes pilotes couvertes (D15)" />
          <Kpi label="Encaissements" value={ind.data.points.collections} sub={ind.data.points.collected.map((m) => `${m.currency} ${m.amount}`).join(' · ') || '—'} />
          <Kpi label="Délai médian de versement" value={ind.data.points.medianSettlementHours === null ? '—' : `${ind.data.points.medianSettlementHours.toFixed(1)} h`} sub="clôture → versement" />
          <Kpi label="Enrôlements assistés" value={ind.data.enrolments.total} sub={`${ind.data.cards.active} carte(s) active(s)`} />
          <Kpi label="Sessions USSD / SVI" value={`${ind.data.channels.ussdSessions} / ${ind.data.channels.ivrSessions}`} sub={`${ind.data.channels.referencesIssued} référence(s) émise(s)`} />
        </div>
      )}
      {msg && <p className="notice notice-ok">{msg}</p>}
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      {sup.loading && <Loading />}
      {sup.error !== null && <ErrorState error={sup.error} onRetry={sup.reload} />}
      {sup.data && (
        <>
          <section className="panel" aria-labelledby="cx-props">
            <header className="panel-head"><div><h2 className="panel-title" id="cx-props"><Icon name="scale" size={18} /> Propositions de suspension</h2><p className="panel-sub">Issues d’un écart ou d’un retard de versement. Aucune suspension automatique.</p></div><span className="count">{sup.data.proposals.filter((p) => p.status === 'PROPOSEE').length}</span></header>
            {sup.data.proposals.length === 0 ? <EmptyState title="Aucune proposition" icon="check" /> : (
              <ul className="list-rows">{sup.data.proposals.map((p) => (
                <li key={p.id} className="list-row list-row-stack">
                  <div className="row-between"><span className="row-title">{p.pointId} — {p.reason.replace(/_/g, ' ').toLowerCase()}</span>
                    <StatusBadge tone={p.status === 'PROPOSEE' ? 'warning' : p.status === 'ECARTEE' ? 'neutral' : 'critical'} label={p.status === 'PROPOSEE' ? 'En attente de décision' : p.status === 'ECARTEE' ? 'Écartée' : 'Suspension décidée'} /></div>
                  <p className="small">{p.detail} <span className="muted">· proposé le {fmtDate(p.proposedAt, true)}</span></p>
                  {p.motif && <p className="small muted">Décision de {p.decidedBy} : {p.motif}</p>}
                  {tresor && p.status === 'PROPOSEE' && (
                    <div className="btn-row">
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => withMotif('Décider la suspension', (motif) => void act(`/v1/payment-points/${p.pointId}/suspend`, { motif, proposalId: p.id }))}><Icon name="ban" size={16} /> Décider la suspension</button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => withMotif('Écarter la proposition', (motif) => void act(`/v1/payment-point-proposals/${p.id}/dismiss`, { motif }))}>Écarter (justifié)</button>
                    </div>
                  )}
                </li>
              ))}</ul>
            )}
          </section>

          <section className="panel cx-mt" aria-labelledby="cx-reg">
            <header className="panel-head"><h2 className="panel-title" id="cx-reg"><Icon name="store" size={18} /> Registre des points</h2><span className="count">{sup.data.points.length}</span></header>
            <DataTable<SupPoint>
              rows={sup.data.points} rowKey={(p) => p.id} caption="Registre des points de paiement agréés"
              columns={[
                { key: 'name', label: 'Point', primary: true, render: (p) => <span className="cx-cell"><strong>{p.name}</strong><span className="small muted">{p.id} · {POINT_TYPE_LABEL[p.type]}</span><span className="small muted">Agrément {p.approval.reference} ({p.approval.authority})</span></span> },
                { key: 'commune', label: 'Commune', render: (p) => p.commune },
                { key: 'status', label: 'Statut', render: (p) => <span className="cx-cell"><StatusBadge tone={POINT_STATUS[p.status]?.tone ?? 'neutral'} label={POINT_STATUS[p.status]?.label ?? p.status} title={p.suspension?.motif} /><span className="small muted">{p.habilitated ? 'Signature habilitée' : 'Aucune habilitation'}</span></span> },
                { key: 'today', label: 'Jour', num: true, render: (p) => <span className="cx-cell"><span>{p.collectionsToday} encaiss.</span><span className="small muted">{p.openExceptions} exception(s)</span></span> },
                {
                  key: 'act', label: 'Décision', full: true, render: (p) => !tresor ? '—' : (
                    <span className="btn-row">
                      {p.status === 'REFERENCE' && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void act(`/v1/payment-points/${p.id}/activate`, undefined, 'Point activé (seconde personne).')}>Activer</button>}
                      {p.status === 'ACTIF' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => withMotif('Suspendre', (motif) => void act(`/v1/payment-points/${p.id}/suspend`, { motif }))}>Suspendre</button>}
                      {p.status === 'SUSPENDU' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => withMotif('Rétablir', (motif) => void act(`/v1/payment-points/${p.id}/reinstate`, { motif }))}>Rétablir</button>}
                    </span>
                  ),
                },
              ]}
            />
          </section>

          <section className="panel cx-mt" aria-labelledby="cx-excs">
            <header className="panel-head"><h2 className="panel-title" id="cx-excs"><Icon name="alert" size={18} /> Exceptions de rapprochement des points</h2><span className="count">{sup.data.exceptions.length}</span></header>
            {sup.data.exceptions.length === 0 ? <EmptyState title="Aucune exception" icon="check" /> : (
              <ul className="list-rows">{sup.data.exceptions.map((e) => (
                <li key={e.id} className="list-row list-row-stack">
                  <span className="row-title">{e.pointId} · {e.day} · {e.type.replace(/_/g, ' ').toLowerCase()}</span>
                  <span className="small">{e.detail}</span>
                  <span className="small muted">Attendu : {e.expected.map((m) => <MoneyText key={m.currency} money={m} showIndicative={false} />)} · constaté : {e.observed.length ? e.observed.map((m) => <MoneyText key={m.currency} money={m} showIndicative={false} />) : 'rien'}</span>
                </li>
              ))}</ul>
            )}
          </section>
          {tresor && <ReferenceForm onDone={() => { sup.reload(); ind.reload(); }} />}
        </>
      )}
    </div>
  );
}

function ReferenceForm({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ name: '', type: 'AGENT_MONNAIE_MOBILE', operator: '', authority: '', reference: '', grantedOn: new Date().toISOString().slice(0, 10), commune: 'Limete', quartier: '', address: '', lat: '-4.37', lon: '15.35', hours: 'Lun–sam 8 h–18 h', perTx: '500.00', perDay: '3000.00', operators: 'canaux-op-limete' });
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(null); setOk(null);
    try {
      const p = await api<{ id: string }>('/v1/payment-points', { method: 'POST', body: {
        name: f.name, type: f.type, operator: f.operator, approval: { authority: f.authority, reference: f.reference, grantedOn: f.grantedOn },
        commune: f.commune, quartier: f.quartier, address: f.address, lat: Number(f.lat), lon: Number(f.lon), hours: f.hours,
        limits: { perTransaction: [{ amount: f.perTx, currency: 'USD' }], perDay: [{ amount: f.perDay, currency: 'USD' }] }, settlementDelayHours: 24,
        operatorUserIds: f.operators.split(',').map((s) => s.trim()).filter(Boolean),
      } });
      setOk(`Point ${p.id} référencé : activation par une seconde personne du Trésor requise.`);
      onDone();
    } catch (x) { setErr(describeError(x).message); }
  }
  return (
    <details className="panel cx-mt">
      <summary className="panel-title"><Icon name="upload" size={18} /> Référencer un nouveau point (agrément requis)</summary>
      <form className="form cx-mt" onSubmit={submit}>
        <div className="field-row">
          <div className="field"><label className="label" htmlFor="rf-n">Nom</label><input id="rf-n" value={f.name} onChange={(e) => set('name', e.target.value)} required /></div>
          <div className="field"><label className="label" htmlFor="rf-t">Type</label><select id="rf-t" value={f.type} onChange={(e) => set('type', e.target.value)}>{Object.entries(POINT_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        </div>
        <div className="field-row">
          <div className="field"><label className="label" htmlFor="rf-o">Établissement régulé</label><input id="rf-o" value={f.operator} onChange={(e) => set('operator', e.target.value)} required /></div>
          <div className="field"><label className="label" htmlFor="rf-a">Autorité d’agrément</label><input id="rf-a" value={f.authority} onChange={(e) => set('authority', e.target.value)} required /></div>
        </div>
        <div className="field-row">
          <div className="field"><label className="label" htmlFor="rf-r">N° d’agrément</label><input id="rf-r" value={f.reference} onChange={(e) => set('reference', e.target.value)} required /></div>
          <div className="field"><label className="label" htmlFor="rf-c">Commune</label><input id="rf-c" value={f.commune} onChange={(e) => set('commune', e.target.value)} required /></div>
        </div>
        <div className="field-row">
          <div className="field"><label className="label" htmlFor="rf-q">Quartier</label><input id="rf-q" value={f.quartier} onChange={(e) => set('quartier', e.target.value)} required /></div>
          <div className="field"><label className="label" htmlFor="rf-ad">Adresse</label><input id="rf-ad" value={f.address} onChange={(e) => set('address', e.target.value)} required /></div>
        </div>
        <div className="field-row">
          <div className="field"><label className="label" htmlFor="rf-pt">Plafond par opération (USD) [EXEMPLE]</label><input id="rf-pt" className="mono" value={f.perTx} onChange={(e) => set('perTx', e.target.value)} /></div>
          <div className="field"><label className="label" htmlFor="rf-pd">Plafond journalier (USD) [EXEMPLE]</label><input id="rf-pd" className="mono" value={f.perDay} onChange={(e) => set('perDay', e.target.value)} /></div>
        </div>
        <div className="field"><label className="label" htmlFor="rf-op">Opérateurs R32 (identifiants séparés par des virgules)</label><input id="rf-op" className="mono" value={f.operators} onChange={(e) => set('operators', e.target.value)} /></div>
        <button type="submit" className="btn btn-primary">Référencer</button>
        {ok && <p className="notice notice-ok">{ok}</p>}
        {err && <p className="notice notice-err" role="alert">{err}</p>}
      </form>
    </details>
  );
}
