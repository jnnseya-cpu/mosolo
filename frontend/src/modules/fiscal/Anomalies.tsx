/**
 * Anomalies locatives (§ 16.4) : six signaux de rapprochement + « unités sans bail », chacun derrière un protocole
 * d'échange de données (garde « protocole requis », J13). Sortie : listes de travail pour vérification humaine —
 * jamais un avis ni une dette. Protocoles : proposition puis activation par une seconde personne.
 */
import { useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { DemoNote, FiscalTabs, ReasonAction, useViewer } from './common';
import './fiscal.css';
import { AnomaliesVisuels } from './visuels';

interface Protocol { active: boolean; reference: string | null; origin: string; notice: string }
interface SignalRow { code: string; label: string; rule: string; output: string; sourceLabel: string; protocol: Protocol; open: number }
interface Catalogue { signals: SignalRow[]; sources: { code: string; label: string; protocol: Protocol }[] }
interface AnomalyCase {
  id: string; signal: string; signalLabel: string; rule: string; output: string; summary: string; status: string; priority: number;
  objectId?: string; objectRef?: string; taxpayerId?: string; commune?: string; detectedAt: string; followUp: string | null;
  reviews: { by: string; at: string; decision: string; reason: string; missionRef?: string }[];
}
interface DataProtocol { id: string; source: string; partner: string; actReference: string; purpose: string; validFrom: string; validTo: string; status: string; proposedBy: string; decision?: { by: string; reason: string } }

export const ANOMALY_STATUS: Record<string, { label: string; tone: Tone }> = {
  A_EXAMINER: { label: 'À examiner', tone: 'warning' }, EN_VERIFICATION: { label: 'En vérification', tone: 'info' },
  CONFIRMEE: { label: 'Confirmée — suite par les circuits habituels', tone: 'serious' }, ECARTEE: { label: 'Écartée', tone: 'neutral' },
};

function CaseCard({ c, onChanged }: { c: AnomalyCase; onChanged: () => void }) {
  const { fmtDate } = useApp();
  const { has } = useViewer();
  const st = ANOMALY_STATUS[c.status] ?? { label: c.status, tone: 'neutral' as Tone };
  const review = (decision: string) => (reason: string) => api(`/v1/fiscal/anomalies/${encodeURIComponent(c.id)}/review`, { method: 'POST', body: { decision, reason } }).then(onChanged);
  const open = c.status === 'A_EXAMINER' || c.status === 'EN_VERIFICATION';
  return (
    <li className="panel">
      <div className="panel-head">
        <div className="min0"><p className="panel-title">{c.signalLabel}</p><p className="panel-sub"><span className="mono">{c.id}</span> · {c.commune ?? 'commune non établie'} · détecté le {fmtDate(c.detectedAt)} · priorité {c.priority}</p></div>
        <StatusBadge tone={st.tone} label={st.label} />
      </div>
      <p className="small">{c.summary}</p>
      <p className="small muted">Règle : {c.rule} → sortie : {c.output}. {c.objectId ? <>Objet <span className="mono">{c.objectId}</span>.</> : c.objectRef ? <>Référence : {c.objectRef}.</> : null}</p>
      {c.reviews.map((r, i) => <p key={i} className="small muted">{fmtDate(r.at, true)} — {r.by} : {ANOMALY_STATUS[r.decision]?.label ?? r.decision} — {r.reason}{r.missionRef ? ` (mission ${r.missionRef})` : ''}</p>)}
      {c.followUp && <p className="small">{c.followUp}</p>}
      {open && has('R06', 'R07', 'R11') && (
        <div className="btn-row">
          {c.status === 'A_EXAMINER' && <ReasonAction label="Lancer la vérification" confirmLabel="Programmer la vérification" onSubmit={review('EN_VERIFICATION')} />}
          {c.status === 'EN_VERIFICATION' && <ReasonAction label="Confirmer" confirmLabel="Confirmer après vérification" onSubmit={review('CONFIRMEE')} />}
          <ReasonAction label="Écarter" confirmLabel="Écarter le dossier" tone="secondary" onSubmit={review('ECARTEE')} />
        </div>
      )}
    </li>
  );
}

function ProtocolForm({ sources, onDone }: { sources: Catalogue['sources']; onDone: () => void }) {
  const [f, setF] = useState({ source: sources[0]?.code ?? 'COMPTEURS', partner: '', actReference: '', purpose: '', validFrom: '', validTo: '' });
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try { await api('/v1/fiscal/data-protocols', { method: 'POST', body: f }); onDone(); } catch (x) { setErr(describeError(x).message); }
  }
  return (
    <form className="panel stack-sm" onSubmit={(e) => void submit(e)}>
      <p className="panel-title">Proposer un protocole de données</p>
      <div className="field"><label className="label" htmlFor="pd-src">Source</label><select id="pd-src" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>{sources.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}</select></div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="pd-par">Partenaire</label><input id="pd-par" required value={f.partner} onChange={(e) => setF({ ...f, partner: e.target.value })} /></div>
        <div className="field"><label className="label" htmlFor="pd-act">Référence de l’acte (J13)</label><input id="pd-act" required value={f.actReference} onChange={(e) => setF({ ...f, actReference: e.target.value })} /></div>
      </div>
      <div className="field"><label className="label" htmlFor="pd-pur">Finalité</label><input id="pd-pur" required value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="pd-from">Début</label><input id="pd-from" type="date" required value={f.validFrom} onChange={(e) => setF({ ...f, validFrom: e.target.value })} /></div>
        <div className="field"><label className="label" htmlFor="pd-to">Fin</label><input id="pd-to" type="date" required value={f.validTo} onChange={(e) => setF({ ...f, validTo: e.target.value })} /></div>
      </div>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      <button type="submit" className="btn btn-primary btn-sm">Proposer (activation par une seconde personne)</button>
    </form>
  );
}

export default function Anomalies() {
  const { user } = useApp();
  const { has } = useViewer();
  const [signal, setSignal] = useState('');
  const cat = useApi(() => api<Catalogue>('/v1/fiscal/anomalies/catalogue'), [user?.id]);
  const list = useApi(() => api<AnomalyCase[]>(`/v1/fiscal/anomalies${signal ? `?signal=${signal}` : ''}`), [user?.id, signal]);
  const protos = useApi(has('R06', 'R07', 'R11', 'R22', 'R24', 'R25') ? () => api<{ items: DataProtocol[] }>('/v1/fiscal/data-protocols') : null, [user?.id]);
  const [msg, setMsg] = useState<string | null>(null);
  async function detect() {
    setMsg(null);
    try { const r = await api<{ created: number; refreshed: number; notice: string }>('/v1/fiscal/anomalies/detection', { method: 'POST' }); setMsg(`${r.created} dossier(s) créé(s), ${r.refreshed} complété(s). ${r.notice}`); list.reload(); cat.reload(); } catch (x) { setMsg(describeError(x).message); }
  }
  const reload = () => { list.reload(); cat.reload(); protos.reload(); };
  return (
    <div className="page page-wide fs-page">
      <PageHead eyebrow="Revenu locatif" title="Anomalies locatives"
        lead="Rapprochements sur données de partenaires (compteurs, paie, agences, baux d’entreprise, permis et imagerie, réceptions d’immeubles) et unités sans bail. Chaque signal produit une liste de travail pour vérification humaine — jamais un avis ni une dette. Sans protocole actif, aucune donnée n’est reçue." />
      <FiscalTabs />
      <DemoNote>Le protocole « compteurs » et ses données sont FICTIFS (démonstration) ; les autres sources restent « protocole requis ».</DemoNote>
      {cat.data && <AnomaliesVisuels signals={cat.data.signals} cases={list.data ?? null} />}
      {cat.loading && <Loading />}
      {cat.error !== null && <ErrorState error={cat.error} onRetry={cat.reload} />}
      {cat.data && (
        <div className="rtable-wrap"><table className="data-table rtable compact">
          <thead><tr><th>Signal</th><th>Règle</th><th>Sortie</th><th>Source et protocole</th><th className="num">Ouverts</th></tr></thead>
          <tbody>{cat.data.signals.map((s) => (
            <tr key={s.code}>
              <td data-label="Signal" className="cell-primary"><button type="button" className="btn btn-ghost btn-sm" onClick={() => setSignal(signal === s.code ? '' : s.code)}>{s.label}</button></td>
              <td data-label="Règle">{s.rule}</td><td data-label="Sortie">{s.output}</td>
              <td data-label="Source"><StatusBadge tone={s.protocol.active ? 'good' : 'warning'} label={s.protocol.active ? 'Protocole actif' : 'Protocole requis'} title={s.protocol.notice} /> <span className="small muted">{s.sourceLabel}</span></td>
              <td data-label="Ouverts" className="num">{s.open}</td>
            </tr>))}</tbody>
        </table></div>
      )}
      {has('R06', 'R07', 'R11') && <div className="btn-row"><button type="button" className="btn btn-primary" onClick={() => void detect()}><Icon name="refresh" size={16} /> Lancer les rapprochements</button></div>}
      {msg && <p className="notice" role="status">{msg}</p>}
      <h2 className="h-sub">Liste de travail{signal ? ` — ${cat.data?.signals.find((s) => s.code === signal)?.label ?? signal}` : ''}</h2>
      {list.loading && <Loading />}
      {list.error !== null && <ErrorState error={list.error} onRetry={list.reload} />}
      {list.data && list.data.length === 0 && <EmptyState title="Aucun dossier de vérification." />}
      <ul className="stack-sm">{(list.data ?? []).map((c) => <CaseCard key={c.id} c={c} onChanged={reload} />)}</ul>
      {protos.data && (
        <section className="stack-sm">
          <h2 className="h-sub">Protocoles d’échange de données</h2>
          <ul className="stack-sm">{protos.data.items.map((p) => (
            <li key={p.id} className="panel">
              <div className="panel-head"><div className="min0"><p className="panel-title">{p.partner}</p><p className="panel-sub"><span className="mono">{p.id}</span> · {p.source} · {p.actReference} · du {p.validFrom} au {p.validTo}</p></div>
                <StatusBadge tone={p.status === 'ACTIF' ? 'good' : p.status === 'PROPOSE' ? 'warning' : 'neutral'} label={p.status === 'PROPOSE' ? 'Proposé — activation attendue' : p.status === 'ACTIF' ? 'Actif' : 'Rejeté'} /></div>
              {p.status === 'PROPOSE' && user?.id !== p.proposedBy && has('R06', 'R25') && (
                <div className="btn-row">
                  <ReasonAction label="Activer" confirmLabel="Activer le protocole" onSubmit={(reason) => api(`/v1/fiscal/data-protocols/${p.id}/decision`, { method: 'POST', body: { approve: true, reason } }).then(reload)} />
                  <ReasonAction label="Rejeter" confirmLabel="Rejeter" tone="secondary" onSubmit={(reason) => api(`/v1/fiscal/data-protocols/${p.id}/decision`, { method: 'POST', body: { approve: false, reason } }).then(reload)} />
                </div>
              )}
            </li>))}</ul>
          {has('R06', 'R07') && cat.data && <ProtocolForm sources={cat.data.sources} onDone={reload} />}
        </section>
      )}
    </div>
  );
}
