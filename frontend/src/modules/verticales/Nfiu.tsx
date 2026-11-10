/**
 * Plaque fiscale immobilière NFIU (module 79) — écrans ajoutés à la console des verticales :
 *  - `NfiuSituation` : situation complète au scan pour l'agent HABILITÉ (propriétaire, occupation et loyers, IF et IRL,
 *    payé / en attente / impayé, pénalités, historique) — lecture seule, aucun montant modifiable ;
 *  - `NfiuHabilitations` : habilitations nominatives par la direction (jamais par l'agent), révocation motivée ;
 *  - `NfiuRapports` : rapports journaliers des agents (produits automatiquement la veille ; l'agent voit sa ligne).
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApi } from '../../hooks/useApi';
import { Icon } from '../../components/Icon';
import { MoneyText } from '../../components/MoneyText';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { api, describeError } from '../../lib/api';
import { useApp } from '../../context';
import { NfiuReportViz } from './visuels';

export interface NfiuFullSituation {
  owner: { taxpayerId: string; name: string; kind: string } | null;
  occupation: { status: 'LOUE' | 'OCCUPE_OU_NON_DECLARE'; label: string; leases: { id: string; rent: MoneyJSON; periodicity: string; start: string; probativeStatus: string }[] };
  obligations: { id: string; kind: 'IF' | 'IRL' | 'AUTRE'; label: string; amount: MoneyJSON; dueDate: string; payment: string; paymentLabel: string; remaining: MoneyJSON; penalties: { overdueDays: number; items: { id: string; status: string; amount: MoneyJSON }[] } }[];
  totals: Record<'IF' | 'IRL', { due: MoneyJSON[]; paid: MoneyJSON[]; remaining: MoneyJSON[]; unpaid: number }>;
  history: { payments: { obligationId: string; kind: string; amount: MoneyJSON; confirmedAt: string | null }[]; plates: { code: string; status: string; issuedAt: string }[]; scans: { at: string; situation: string | null }[]; visits: { date: string; result: string }[] };
  editable: false; notice: string;
}

const PAY_TONE: Record<string, Tone> = { PAYE: 'good', PARTIEL: 'warning', EN_ATTENTE: 'info', IMPAYE: 'serious', CONTESTE: 'neutral' };
const moneyList = (l: MoneyJSON[]) => (l.length ? l.map((m, i) => <span key={i}><MoneyText money={m} />{i < l.length - 1 ? ', ' : ''}</span>) : '0');

export function NfiuSituation({ s }: { s: NfiuFullSituation }) {
  const { fmtDate } = useApp();
  return (
    <section className="panel" aria-label="Situation complète NFIU">
      <h3 className="panel-title"><Icon name="shieldCheck" size={18} /> Situation complète (agent habilité)</h3>
      <dl className="kv kv-dense">
        <div><dt>Propriétaire</dt><dd>{s.owner ? `${s.owner.name} (${s.owner.taxpayerId})` : 'Non rattaché'}</dd></div>
        <div><dt>Statut</dt><dd>{s.occupation.label}</dd></div>
        {s.occupation.leases.map((l) => <div key={l.id}><dt>Loyer déclaré</dt><dd><MoneyText money={l.rent} /> · {l.periodicity.toLowerCase()} · depuis {fmtDate(l.start)}</dd></div>)}
        {(['IF', 'IRL'] as const).map((k) => (
          <div key={k}><dt>{k === 'IF' ? 'Impôt foncier' : 'IRL'}</dt><dd>dû {moneyList(s.totals[k].due)} · payé {moneyList(s.totals[k].paid)} · reste {moneyList(s.totals[k].remaining)}{s.totals[k].unpaid ? ` · ${s.totals[k].unpaid} impayé(s)` : ''}</dd></div>
        ))}
      </dl>
      <ul className="list-rows">
        {s.obligations.map((o) => (
          <li key={o.id} className="list-row">
            <div className="min0">
              <p className="row-title">{o.kind} — {o.label}</p>
              <p className="small muted mono">{o.id} · échéance {fmtDate(o.dueDate)}{o.penalties.overdueDays ? ` · ${o.penalties.overdueDays} jour(s) de retard` : ''}</p>
              {o.penalties.items.map((p) => <p key={p.id} className="small">Pénalité {p.status.toLowerCase()} : <MoneyText money={p.amount} /></p>)}
            </div>
            <div className="row-side"><MoneyText money={o.amount} /><StatusBadge tone={PAY_TONE[o.payment] ?? 'neutral'} label={o.paymentLabel} /></div>
          </li>
        ))}
      </ul>
      <details>
        <summary>Historique</summary>
        <ul className="small">
          {s.history.payments.map((p, i) => <li key={`p${i}`}>Paiement {p.kind} <MoneyText money={p.amount} /> le {p.confirmedAt ? fmtDate(p.confirmedAt, true) : '—'}</li>)}
          {s.history.plates.map((p) => <li key={p.code}>Plaque {p.code} ({p.status.toLowerCase()}) posée le {fmtDate(p.issuedAt)}</li>)}
          {s.history.visits.map((v, i) => <li key={`v${i}`}>Visite du {fmtDate(v.date)} : {v.result}</li>)}
          <li>{s.history.scans.length} scan(s) récent(s)</li>
        </ul>
      </details>
      <p className="hint"><Icon name="lock" size={13} /> {s.notice}</p>
    </section>
  );
}

interface Habilitation { userId: string; agentName: string; communes: string[]; motif: string; validUntil: string; active: boolean; revoked?: { motif: string } }

export function NfiuHabilitations() {
  const { fmtDate } = useApp();
  const q = useApi(() => api<{ items: Habilitation[] }>('/v1/verticales/nfiu/habilitations'), []);
  const [form, setForm] = useState({ userId: '', communes: '', motif: '', validUntil: '' });
  const [err, setErr] = useState<string | null>(null);
  const post = async (path: string, body: unknown) => { setErr(null); try { await api(path, { method: 'POST', body }); q.reload(); } catch (e) { setErr(describeError(e).message); } };
  if (q.loading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  return (
    <section className="panel">
      <h2 className="panel-title"><Icon name="users" size={18} /> Habilitations NFIU (situation complète)</h2>
      <p className="small muted">Accordées nommément par la direction, dans le secteur de l’agent, avec une échéance ; jamais par l’agent lui-même. Sans habilitation, l’agent garde l’accès minimal.</p>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void post('/v1/verticales/nfiu/habilitations', { userId: form.userId.trim(), communes: form.communes.split(',').map((c) => c.trim()).filter(Boolean), motif: form.motif, validUntil: form.validUntil }); }}>
        <label className="field"><span>Agent (identifiant)</span><input value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} required /></label>
        <label className="field"><span>Communes (séparées par des virgules)</span><input value={form.communes} onChange={(e) => setForm({ ...form, communes: e.target.value })} required /></label>
        <label className="field"><span>Motif</span><input value={form.motif} onChange={(e) => setForm({ ...form, motif: e.target.value })} minLength={10} required /></label>
        <label className="field"><span>Échéance</span><input type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} required /></label>
        <button type="submit" className="btn btn-primary">Habiliter</button>
      </form>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      {q.data.items.length === 0 ? <EmptyState title="Aucune habilitation" /> : (
        <ul className="list-rows">
          {q.data.items.map((h) => (
            <li key={h.userId} className="list-row">
              <div className="min0"><p className="row-title">{h.agentName}</p><p className="small muted">{h.communes.join(', ')} · jusqu’au {fmtDate(h.validUntil)} · {h.motif}</p></div>
              <div className="row-side">
                <StatusBadge tone={h.active ? 'good' : 'neutral'} label={h.active ? 'Active' : h.revoked ? 'Révoquée' : 'Échue'} />
                {h.active && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void post(`/v1/verticales/nfiu/habilitations/${h.userId}/revocation`, { motif: 'Révocation décidée par la direction (motif saisi à l’écran).' })}>Révoquer</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface Report { date: string; generatedAt: string; trigger: string; scope?: 'AGENT'; agents: { agentId: string; agentName: string; platesIssued: number; platesReplaced: number; scans: number; fullSituations: number; bySituation: Record<'red' | 'amber' | 'green' | 'grey', number>; presenceVerified: number; communes: string[] }[] }

export function NfiuRapports() {
  const { user } = useApp();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const q = useApi(() => api<Report>(`/v1/verticales/nfiu/rapports?date=${date}`), [date, user?.id]);
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="panel-title"><Icon name="history" size={18} /> Rapports journaliers NFIU</h2><input type="date" className="input-sm" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Jour du rapport" /></div>
      {q.loading && <Loading />}
      {!!q.error && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && (
        <>
          <p className="small muted">{q.data.scope === 'AGENT' ? 'Votre activité du jour.' : 'Tous les agents.'} Production {q.data.trigger === 'PLANIFIEE' ? 'automatique' : 'à la demande'}.</p>
          {q.data.agents.length > 0 && <NfiuReportViz agents={q.data.agents} />}
          <DataTable caption="Rapport journalier des agents NFIU" rows={q.data.agents} rowKey={(r) => r.agentId} empty={<EmptyState title="Aucune activité ce jour" />} columns={[
            { key: 'a', label: 'Agent', render: (r) => r.agentName },
            { key: 'p', label: 'Poses', num: true, render: (r) => r.platesIssued },
            { key: 's', label: 'Scans', num: true, render: (r) => r.scans },
            { key: 'r', label: 'Rouges', num: true, render: (r) => r.bySituation.red },
            { key: 'am', label: 'Ambres', num: true, render: (r) => r.bySituation.amber },
            { key: 'v', label: 'Verts', num: true, render: (r) => r.bySituation.green },
            { key: 'f', label: 'Situations complètes', num: true, render: (r) => r.fullSituations },
            { key: 'pr', label: 'Présence vérifiée', num: true, render: (r) => r.presenceVerified },
          ]} />
        </>
      )}
    </section>
  );
}
