/**
 * Réclamations et recours — côté administration (module 37 ; Document maître FR 2, nouvelle version, § 13.4 et § 23).
 * Chaque recours a un propriétaire (service compétent dès le dépôt, puis agent de contentieux désigné par la direction
 * de la régie), un délai légal décompté par le serveur, un état et une décision motivée. Instruction par un agent de
 * contentieux (R20), décision par une autorité distincte (R21) ; l'effet suspensif est décidé par l'autorité, jamais
 * d'office. Le serveur reste juge de chaque contrôle (quatre yeux, conflit d'intérêts, montants).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { StatusBadge, Chip } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { AppealDeadlinesPanel, type AppealIndicators } from '../../components/AppealDeadlinesPanel';
import { api } from '../../lib/api';
import { APPEAL_STATE, SUSPENSIVE_LABEL, hasRole, type Appeal } from './types';
import { Msg, useAction } from './actions';
import './recouvrement.css';

export type AgentAppeal = Appeal & {
  owner?: { entity: string; userId?: string; assignedBy?: string; assignedAt: string };
  instructorId?: string;
  proposal?: { decision: string; analysis: string; at: string; proposedAmount?: { amount: string; currency: string } };
  requestedAmount?: { amount: string; currency: string };
};
type Owner = { id: string; name: string; entity: string };
type Tab = 'ouverts' | 'decider' | 'decides';

const STATUS_LABEL: Record<string, string> = {
  DEPOSEE: 'Déposé — à instruire', PROPOSITION: 'Instruit — décision attendue', ACCEPTEE: 'Accepté', PARTIELLEMENT_ACCEPTEE: 'Partiellement accepté', REJETEE: 'Rejeté',
};
const DECISIONS = [
  { code: 'REJETEE', label: 'Rejet' }, { code: 'PARTIELLEMENT_ACCEPTEE', label: 'Acceptation partielle' }, { code: 'ACCEPTEE', label: 'Acceptation totale' },
];

async function load(canAssign: boolean) {
  const [appeals, indicators, owners] = await Promise.all([
    api<AgentAppeal[]>('/v1/appeals'),
    api<AppealIndicators>('/v1/appeals/indicateurs'),
    canAssign ? api<Owner[]>('/v1/appeals/proprietaires').catch(() => [] as Owner[]) : Promise.resolve([] as Owner[]),
  ]);
  return { appeals, indicators, owners };
}

export function AppealCard({ a, meId, roles, owners, onDone }: { a: AgentAppeal; meId: string | undefined; roles: string[]; owners: Owner[]; onDone: () => void }) {
  const { fmtDate } = useApp();
  const { busy, msg, run } = useAction(onDone);
  const [text, setText] = useState('');
  const [decision, setDecision] = useState('REJETEE');
  const [amount, setAmount] = useState('');
  const [assignee, setAssignee] = useState('');
  const url = (p: string) => `/v1/appeals/${encodeURIComponent(a.id)}/${p}`;
  const st = APPEAL_STATE[a.deadlines.state] ?? { label: a.deadlines.state, tone: 'neutral' as const };
  const open = a.status === 'DEPOSEE' || a.status === 'PROPOSITION';
  const canAssign = open && hasRole(roles, 'R06', 'R07');
  const canInstruct = a.status === 'DEPOSEE' && hasRole(roles, 'R20');
  const canDecide = a.status === 'PROPOSITION' && hasRole(roles, 'R21') && meId !== a.instructorId;
  const canDecideSuspensive = open && hasRole(roles, 'R21') && a.suspensiveEffect?.status === 'DEMANDE';
  const short = text.trim().length < 10;
  const currency = a.requestedAmount?.currency ?? a.proposal?.proposedAmount?.currency ?? 'USD';
  const needsAmount = decision !== 'REJETEE';
  return (
    <article className="panel rc-decision" aria-label={`Recours ${a.id}`}>
      <div className="panel-head">
        <div className="min0">
          <p className="panel-title">Recours <span className="mono small">{a.id}</span> {a.type && <Chip>{a.type}</Chip>}</p>
          <p className="panel-sub">Obligation <span className="mono">{a.obligationId}</span> · accusé {a.acknowledgement?.number ?? '—'} · déposé le {fmtDate(a.submittedAt, true)}</p>
        </div>
        <StatusBadge tone={st.tone} label={st.label} />
      </div>
      <dl className="kv kv-dense">
        <div><dt>État</dt><dd>{STATUS_LABEL[a.status] ?? a.status}</dd></div>
        <div><dt>Propriétaire</dt><dd>{a.owner ? <>{a.owner.entity} · {a.owner.userId ?? <span className="muted">file du service (à affecter)</span>}</> : '—'}</dd></div>
        <div><dt>Délai légal</dt><dd>Décision attendue avant le {fmtDate(a.deadlines.decisionDueBy)}{a.deadlines.daysRemaining !== null ? ` · ${a.deadlines.daysRemaining} jour(s) restant(s)` : ''}</dd></div>
        <div><dt>Effet suspensif</dt><dd>{SUSPENSIVE_LABEL[a.suspensiveEffect?.status ?? 'NON_DEMANDE']}</dd></div>
      </dl>
      <p className="small">{a.grounds}</p>
      {a.proposal && <p className="small"><Chip>Proposition : {STATUS_LABEL[a.proposal.decision] ?? a.proposal.decision}</Chip> {a.instructorId} — {a.proposal.analysis}</p>}
      {a.decision && <p className="small">Décision motivée ({fmtDate(a.decision.at, true)}) : {a.decision.reason}{a.nextRemedy && <> · voie suivante : {a.nextRemedy.hierarchical}</>}</p>}
      {canAssign && owners.length > 0 && (
        <div className="field-row">
          <div className="field">
            <label className="label" htmlFor={`as-${a.id}`}>Propriétaire nominatif (agent de contentieux)</label>
            <select id={`as-${a.id}`} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">— choisir —</option>
              {owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <div className="field">
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !assignee}
              onClick={() => void run(() => api(url('assign'), { method: 'POST', body: { assigneeId: assignee, reason: 'Affectation par la direction de la régie' } }), 'Propriétaire désigné (historique conservé).')}>
              <Icon name="user" size={14} /> Affecter
            </button>
          </div>
        </div>
      )}
      {(canInstruct || canDecide) && (
        <>
          <div className="field-row">
            <div className="field">
              <label className="label" htmlFor={`dc-${a.id}`}>{canInstruct ? 'Proposition' : 'Décision'}</label>
              <select id={`dc-${a.id}`} value={decision} onChange={(e) => setDecision(e.target.value)}>
                {DECISIONS.map((d) => <option key={d.code} value={d.code}>{d.label}</option>)}
              </select>
            </div>
            {needsAmount && (
              <div className="field">
                <label className="label" htmlFor={`am-${a.id}`}>Montant rectifié ({currency})</label>
                <input id={`am-${a.id}`} inputMode="decimal" pattern="\d{1,15}(\.\d{1,2})?" value={amount} onChange={(e) => setAmount(e.target.value)} />
                <span className="hint">Explicite, y compris 0 pour une acceptation totale ; contrôlé par le serveur.</span>
              </div>
            )}
          </div>
          <div className="field">
            <label className="label" htmlFor={`tx-${a.id}`}>{canInstruct ? 'Analyse motivée' : 'Motivation de la décision'}</label>
            <textarea id={`tx-${a.id}`} rows={2} value={text} onChange={(e) => setText(e.target.value)} minLength={10} maxLength={5000} />
          </div>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || short || (needsAmount && canDecide && !amount.trim())}
            onClick={() => void run(() => canInstruct
              ? api(url('instruct'), { method: 'POST', body: { proposal: decision, analysis: text, ...(needsAmount && amount.trim() ? { proposedAmount: { amount: amount.trim(), currency } } : {}) } })
              : api(url('decide'), { method: 'POST', body: { decision, reason: text, ...(needsAmount ? { rectifiedAmount: { amount: amount.trim(), currency } } : {}) } }),
            canInstruct ? 'Proposition enregistrée : décision attendue d’une autorité distincte (R21).' : 'Décision motivée enregistrée et notifiée ; voie de recours suivante indiquée.')}>
            <Icon name="check" size={14} /> {canInstruct ? 'Instruire' : 'Décider'}
          </button>
        </>
      )}
      {a.status === 'PROPOSITION' && hasRole(roles, 'R21') && meId === a.instructorId && (
        <p className="callout callout-info"><Icon name="lock" size={18} /> Quatre yeux : vous avez instruit ce recours ; la décision revient à une autre personne.</p>
      )}
      {canDecideSuspensive && (
        <div className="btn-row">
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || short} onClick={() => void run(() => api(url('suspensive-effect/decision'), { method: 'POST', body: { granted: true, reason: text } }), 'Effet suspensif accordé (motif tracé).')}>Accorder l’effet suspensif</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy || short} onClick={() => void run(() => api(url('suspensive-effect/decision'), { method: 'POST', body: { granted: false, reason: text } }), 'Effet suspensif refusé (motif tracé).')}>Refuser l’effet suspensif</button>
        </div>
      )}
      {!!a.history?.length && (
        <details className="small"><summary>Historique ({a.history.length})</summary>
          <ol>{a.history.map((h, i) => <li key={i}>{fmtDate(h.at, true)} — {h.action} · {h.by}{h.detail ? ` — ${h.detail}` : ''}</li>)}</ol>
        </details>
      )}
      <Msg msg={msg} />
    </article>
  );
}

export default function Recours() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const canAssign = hasRole(roles, 'R06', 'R07');
  const q = useApi(() => load(canAssign), [user?.id]);
  const [picked, setTab] = useState<Tab | null>(null);
  const tab: Tab = picked ?? (hasRole(roles, 'R21') ? 'decider' : 'ouverts');
  const all = q.data?.appeals ?? [];
  const groups: Record<Tab, AgentAppeal[]> = {
    ouverts: all.filter((a) => a.status === 'DEPOSEE'),
    decider: all.filter((a) => a.status === 'PROPOSITION'),
    decides: all.filter((a) => a.status !== 'DEPOSEE' && a.status !== 'PROPOSITION'),
  };
  return (
    <div className="page page-wide rc-page">
      <PageHead eyebrow="Contentieux" title="Réclamations et recours" lead="Chaque recours a un propriétaire, un délai légal, un état et une décision motivée. Instruction par un agent de contentieux, décision par une autorité distincte ; aucune décision automatique.">
        <Link className="btn btn-ghost" to="/recouvrement"><Icon name="arrowRight" size={16} className="rc-flip" /> File de recouvrement</Link>
      </PageHead>
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && (
        <>
          <AppealDeadlinesPanel data={q.data.indicators} />
          <div className="seg seg-wrap" role="group" aria-label="Vue">
            <button type="button" aria-pressed={tab === 'ouverts'} onClick={() => setTab('ouverts')}>À instruire <span className="count">{groups.ouverts.length}</span></button>
            <button type="button" aria-pressed={tab === 'decider'} onClick={() => setTab('decider')}>À décider <span className="count">{groups.decider.length}</span></button>
            <button type="button" aria-pressed={tab === 'decides'} onClick={() => setTab('decides')}>Décidés <span className="count">{groups.decides.length}</span></button>
          </div>
          <div className="rc-grid">
            {groups[tab].length === 0 && <EmptyState title="Aucun recours" icon="check" />}
            {groups[tab].map((a) => <AppealCard key={a.id} a={a} meId={user?.id} roles={roles} owners={q.data!.owners} onDone={q.reload} />)}
          </div>
        </>
      )}
    </div>
  );
}
