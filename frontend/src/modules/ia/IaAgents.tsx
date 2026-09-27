import { useState } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { api, asList, describeError } from '../../lib/api';
import { AUTONOMY_LABEL, AUTONOMY_SHORT, DOMAIN_LABEL, latency } from './labels';
import type { IaAgent, IaRec } from './types';
import { AgentsVisuels } from './visuels';

/** Catalogue des agents (fiches de contrôle), sollicitation à la demande et coupe-circuit (R28/R29). */
export default function IaAgents({ onRan }: { onRan?: (recs: IaRec[]) => void }) {
  const { user } = useApp();
  const q = useApi(async () => asList<IaAgent>(await api<unknown>('/v1/ia/agents')), [user?.id]);
  const canKill = (user?.roles ?? []).some((r) => r === 'R28' || r === 'R29');
  const canSweep = (user?.roles ?? []).some((r) => ['R22', 'R26', 'R29'].includes(r));
  const [sweepMsg, setSweepMsg] = useState<string | null>(null);

  async function sweep() {
    setSweepMsg(null);
    try {
      const out = await api<{ agent: string; created: number }[]>('/v1/ia/sweep', { method: 'POST', body: {} });
      setSweepMsg(`Balayage terminé : ${out.reduce((n, o) => n + o.created, 0)} nouvelle(s) recommandation(s).`);
      q.reload();
    } catch (e) { setSweepMsg(describeError(e).message); }
  }

  return (
    <div className="stack">
      <p className="callout callout-info"><Icon name="info" size={16} /> <span>Chaque agent ne lit que les données de sa fiche, cite ses sources et produit une recommandation au format standard. Il n’a aucun droit d’écriture sur les domaines juridiques ou financiers : un humain habilité décide.</span></p>
      {canSweep && (
        <div className="btn-row">
          <button type="button" className="btn btn-secondary" onClick={() => void sweep()}><Icon name="refresh" size={18} /> Lancer un balayage proactif</button>
          {sweepMsg && <span role="status" className="small muted">{sweepMsg}</span>}
        </div>
      )}
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && <AgentsVisuels agents={q.data} />}
      <div className="ia-agent-grid">
        {(q.data ?? []).map((a) => <AgentCard key={a.code} agent={a} canKill={canKill} onChanged={q.reload} {...(onRan ? { onRan } : {})} />)}
      </div>
    </div>
  );
}

function AgentCard({ agent: a, canKill, onChanged, onRan }: { agent: IaAgent; canKill: boolean; onChanged: () => void; onRan?: (r: IaRec[]) => void }) {
  const { user } = useApp();
  const [purpose, setPurpose] = useState('');
  const [question, setQuestion] = useState('');
  const [taxpayerId, setTaxpayerId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const needsTaxpayer = a.personal && !(user?.roles ?? []).includes('R30');

  async function run() {
    setBusy(true); setMsg(null);
    try {
      const body = { purpose: purpose.trim() || `Consultation de l’agent « ${a.name} »`, ...(question.trim() ? { question: question.trim() } : {}), ...(needsTaxpayer && taxpayerId.trim() ? { taxpayerId: taxpayerId.trim() } : {}) };
      const recs = await api<IaRec[]>(`/v1/ia/agents/${a.code}/run`, { method: 'POST', body });
      setMsg({ ok: true, text: `${recs.length} recommandation(s) produite(s) ou réutilisée(s).` });
      onRan?.(recs);
      onChanged();
    } catch (e) { setMsg({ ok: false, text: describeError(e).message }); } finally { setBusy(false); }
  }
  async function toggle() {
    if (reason.trim().length < 3) { setMsg({ ok: false, text: 'Motif obligatoire pour le coupe-circuit.' }); return; }
    setBusy(true); setMsg(null);
    try {
      await api(`/v1/ia/agents/${a.code}/state`, { method: 'POST', body: { enabled: !a.enabled, reason: reason.trim() } });
      setReason('');
      onChanged();
    } catch (e) { setMsg({ ok: false, text: describeError(e).message }); } finally { setBusy(false); }
  }

  return (
    <section className={`panel ia-agent ${a.enabled ? '' : 'ia-agent-off'}`} aria-labelledby={`ag-${a.code}`}>
      <header className="ia-agent-head">
        <div>
          <h3 id={`ag-${a.code}`}>{a.name}</h3>
          <p className="small muted">{a.technicalName} · {a.homeEntity} · fiche v{a.version}</p>
        </div>
        <span className={`ia-level ia-level-chip-${AUTONOMY_SHORT[a.autonomy]}`} title={AUTONOMY_LABEL[a.autonomy]}>{AUTONOMY_SHORT[a.autonomy]}</span>
      </header>
      <p>{a.mission}</p>
      <dl className="kv kv-dense">
        <div><dt>Agents transverses</dt><dd>{a.crossAgents.join(', ')}</dd></div>
        <div><dt>Données autorisées</dt><dd><span className="chips">{a.allowedData.map((d) => <span className="chip" key={d}>{DOMAIN_LABEL[d] ?? d}</span>)}</span></dd></div>
        <div><dt>Actions</dt><dd>{a.allowedActions.length ? a.allowedActions.map((x) => `${x.level} — ${x.label}`).join(' ; ') : 'Aucune (recommandation seule)'}</dd></div>
        <div><dt>Validation humaine</dt><dd>{a.humanValidation} ({a.validators.join(', ')})</dd></div>
        <div><dt>Interdit</dt><dd>{a.never}</dd></div>
        <div><dt>Activité</dt><dd>{a.stats.total} émise(s) · {a.stats.pending} en attente · {a.stats.accepted} acceptée(s) · {a.stats.rejected} rejetée(s) · délai médian {latency(a.stats.medianLatencyMs)}</dd></div>
      </dl>
      <div className="ia-agent-foot">
        {!a.enabled && <StatusBadge tone="critical" label={`Désactivé : ${a.disabledReason ?? ''}`} />}
        {a.canRun && a.enabled && (
          <div className="ia-inline-form">
            <label className="field"><span className="label">Finalité déclarée</span>
              <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Ex. préparer la réunion de lundi" /></label>
            {a.code === 'APPRENTISSAGE_USAGER' && (
              <label className="field"><span className="label">Votre question</span>
                <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ex. comment obtenir ma quittance ?" /></label>
            )}
            {needsTaxpayer && (
              <label className="field"><span className="label">Contribuable concerné</span>
                <input value={taxpayerId} onChange={(e) => setTaxpayerId(e.target.value)} placeholder="Identifiant du contribuable" /></label>
            )}
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void run()}><Icon name="send" size={16} /> Solliciter l’agent</button>
          </div>
        )}
        {canKill && (
          <div className="ia-inline-form">
            <label className="field"><span className="label">Motif (coupe-circuit)</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex. dérive détectée" /></label>
            <button type="button" className={`btn btn-sm ${a.enabled ? 'btn-secondary' : 'btn-primary'}`} disabled={busy} onClick={() => void toggle()}>
              <Icon name={a.enabled ? 'ban' : 'check'} size={16} /> {a.enabled ? 'Désactiver l’agent' : 'Réactiver l’agent'}
            </button>
          </div>
        )}
        <p className="small muted">Version d’analyse : {a.promptVersion}</p>
      </div>
      {msg && <p role="status" className={msg.ok ? 'notice notice-ok' : 'notice notice-err'}>{msg.text}</p>}
    </section>
  );
}
