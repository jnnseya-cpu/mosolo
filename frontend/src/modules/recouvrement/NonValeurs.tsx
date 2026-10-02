/**
 * Admission en non-valeur (seule voie d'effacement total d'une créance irrécouvrable) : proposition circonstanciée
 * avec pièces par un agent de recouvrement (R20), décision motivée par une autorité distincte du proposant et du
 * liquidateur (R21). L'obligation admise passe au statut ADMISE_EN_NON_VALEUR, jamais SOLDEE : elle reste tracée.
 */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { MoneyText } from '../../components/MoneyText';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import { hasRole, WRITE_OFF_STATUS, type Arrear, type WriteOff } from './types';
import { Msg, useAction } from './actions';
import { NonValeursVisuel } from './visuels';
import './recouvrement.css';
// Parcours par rôle (29/09/2026) : un écran vide propose la prochaine action utile du travail du jour.
import { SuiteDuTravail } from '../../components/SuiteDuTravail';

async function load() {
  const [writeOffs, arrears] = await Promise.all([
    api<WriteOff[]>('/v1/recouvrement/non-valeurs'),
    api<{ items: Arrear[] }>('/v1/recouvrement/arrieres').then((r) => r.items).catch(() => [] as Arrear[]),
  ]);
  return { writeOffs, arrears };
}

function WriteOffCard({ w, meId, roles, onDone }: { w: WriteOff; meId: string | undefined; roles: string[]; onDone: () => void }) {
  const { fmtDate } = useApp();
  const [motivation, setMotivation] = useState('');
  const { busy, msg, run } = useAction(onDone);
  const st = WRITE_OFF_STATUS[w.status] ?? { label: w.status, tone: 'neutral' as const };
  const own = !!meId && meId === w.proposedBy;
  const canDecide = w.status === 'PROPOSEE' && hasRole(roles, 'R21') && !own;
  const decide = (decision: 'ADMISE' | 'REJETEE') => void run(
    () => api(`/v1/recouvrement/non-valeurs/${encodeURIComponent(w.id)}/decision`, { method: 'POST', body: { decision, motivation } }),
    decision === 'ADMISE' ? 'Créance admise en non-valeur : obligation au statut ADMISE_EN_NON_VALEUR (jamais soldée).' : 'Proposition rejetée (motif tracé) : la créance reste due.',
  );
  return (
    <article className="panel rc-decision">
      <div className="panel-head">
        <div className="min0">
          <p className="panel-title">Non-valeur <span className="mono small">{w.id}</span></p>
          <p className="panel-sub">Obligation <span className="mono">{w.obligationId}</span> · contribuable <span className="mono">{w.taxpayerId}</span></p>
        </div>
        <StatusBadge tone={st.tone} label={st.label} />
      </div>
      <p className="row-title"><MoneyText money={w.amount} showIndicative={false} /></p>
      <p className="small">{w.motivation}</p>
      <p className="caps-sm">Pièces justificatives</p>
      <ul className="plain-list small">{w.evidence.map((e) => <li key={e}>{e}</li>)}</ul>
      <p className="small muted">Proposée par {w.proposedBy} le {fmtDate(w.proposedAt, true)}</p>
      {w.status === 'ADMISE' && <p className="small"><StatusBadge tone="serious" label="ADMISE_EN_NON_VALEUR" /> L’obligation n’est pas soldée : elle reste tracée pour le comptable.</p>}
      {w.decision && <p className="small">Décision de {w.decision.by} le {fmtDate(w.decision.at, true)} — {w.decision.motivation}</p>}
      {w.status === 'PROPOSEE' && own && <p className="callout callout-info"><Icon name="lock" size={18} /> Quatre yeux : vous avez proposé cette admission ; la décision revient à une autre autorité.</p>}
      {canDecide && (
        <>
          <div className="field">
            <label className="label" htmlFor={`wd-${w.id}`}>Motivation de la décision</label>
            <textarea id={`wd-${w.id}`} rows={2} value={motivation} onChange={(e) => setMotivation(e.target.value)} minLength={10} maxLength={4000} />
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || motivation.trim().length < 10} onClick={() => decide('ADMISE')}><Icon name="check" size={14} /> Admettre en non-valeur</button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || motivation.trim().length < 10} onClick={() => decide('REJETEE')}><Icon name="x" size={14} /> Rejeter</button>
          </div>
        </>
      )}
      <Msg msg={msg} />
    </article>
  );
}

function ProposeForm({ arrears, onDone }: { arrears: Arrear[]; onDone: () => void }) {
  const [obligationId, setObligationId] = useState('');
  const [motivation, setMotivation] = useState('');
  const [evidence, setEvidence] = useState('');
  const { busy, msg, run } = useAction(onDone);
  const pieces = evidence.split('\n').map((e) => e.trim()).filter(Boolean);
  const arrear = arrears.find((a) => a.obligationId === obligationId.trim());
  function submit(e: FormEvent) {
    e.preventDefault();
    void run(() => api('/v1/recouvrement/non-valeurs', { method: 'POST', body: { obligationId: obligationId.trim(), motivation, evidence: pieces } }),
      'Admission en non-valeur proposée : décision attendue d’une autorité distincte (R21).');
  }
  return (
    <form className="form panel" onSubmit={submit} aria-label="Proposer une admission en non-valeur">
      <p className="panel-title">Proposer une admission en non-valeur</p>
      <div className="field">
        <label className="label" htmlFor="nv-obl">Obligation échue</label>
        <input id="nv-obl" list="nv-obl-list" value={obligationId} onChange={(e) => setObligationId(e.target.value)} required />
        <datalist id="nv-obl-list">{arrears.map((a) => <option key={a.obligationId} value={a.obligationId}>{a.label}</option>)}</datalist>
        {arrear && <span className="hint">Dû : <MoneyText money={arrear.amount} showIndicative={false} /> · {arrear.ageDays} jours de retard</span>}
      </div>
      <div className="field">
        <label className="label" htmlFor="nv-mot">Motivation circonstanciée</label>
        <textarea id="nv-mot" rows={3} value={motivation} onChange={(e) => setMotivation(e.target.value)} required minLength={20} maxLength={4000} />
        <span className="hint">Au moins 20 caractères : insolvabilité, disparition, prescription…</span>
      </div>
      <div className="field">
        <label className="label" htmlFor="nv-ev">Pièces justificatives (une par ligne)</label>
        <textarea id="nv-ev" rows={3} value={evidence} onChange={(e) => setEvidence(e.target.value)} required />
        <span className="hint">{pieces.length} pièce(s) — de 1 à 20.</span>
      </div>
      <Msg msg={msg} />
      <button type="submit" className="btn btn-primary" disabled={busy || motivation.trim().length < 20 || !pieces.length || pieces.length > 20}><Icon name="send" size={16} /> Proposer</button>
    </form>
  );
}

export default function NonValeurs() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const q = useApi(load, [user?.id]);
  const [status, setStatus] = useState<WriteOff['status']>('PROPOSEE');
  const d = q.data;
  const list = (d?.writeOffs ?? []).filter((w) => w.status === status);
  const count = (s: WriteOff['status']) => (d?.writeOffs ?? []).filter((w) => w.status === s).length;
  return (
    <div className="page page-wide rc-page">
      <PageHead eyebrow="Recouvrement" title="Admissions en non-valeur" lead="Seule voie d’effacement total d’une créance irrécouvrable : proposition motivée et justifiée par un agent (R20), décision d’une autorité distincte du proposant et du liquidateur (R21). La créance admise n’est jamais « soldée ».">
        <Link className="btn btn-ghost" to="/recouvrement"><Icon name="arrowRight" size={16} className="rc-flip" /> File de recouvrement</Link>
      </PageHead>
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {d && (
        <>
          <NonValeursVisuel writeOffs={d.writeOffs} />
          {hasRole(roles, 'R20') && <ProposeForm arrears={d.arrears} onDone={q.reload} />}
          <div className="seg seg-wrap" role="group" aria-label="Statut">
            {(['PROPOSEE', 'ADMISE', 'REJETEE'] as const).map((s) => (
              <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>{WRITE_OFF_STATUS[s].label} <span className="count">{count(s)}</span></button>
            ))}
          </div>
          <div className="rc-grid">
            {list.length === 0 && <EmptyState title="Aucune admission" icon="check"><SuiteDuTravail /></EmptyState>}
            {list.map((w) => <WriteOffCard key={w.id} w={w} meId={user?.id} roles={roles} onDone={q.reload} />)}
          </div>
        </>
      )}
    </div>
  );
}
