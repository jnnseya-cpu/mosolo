import { useState } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { DataTable } from '../../components/DataTable';
import { Drawer } from '../../components/Drawer';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { api, asList, describeError } from '../../lib/api';
import { DOMAIN_LABEL, EFFECT_LABEL, JOURNAL_LABEL, latency, short } from './labels';
import type { IaEffect, IaRec, JournalEntry } from './types';
import { JournalVisuels } from './visuels';

interface Reconstitution {
  recommendation: IaRec; outputIntact: boolean; journal: JournalEntry[]; effects: IaEffect[];
  audit: { id: string; at: string; action: string; actorKind: string; hash: string }[];
}

/** Journal IA (§ 23.3) : finalité, versions, données citées, empreintes, décision humaine et délai ; reconstitution. */
export default function IaJournal() {
  const { user, fmtDate } = useApp();
  const [type, setType] = useState('');
  const q = useApi(async () => asList<JournalEntry>(await api<unknown>(`/v1/ia/journal${type ? `?type=${type}` : ''}`)), [user?.id, type]);
  const [open, setOpen] = useState<string | null>(null);
  const [recon, setRecon] = useState<Reconstitution | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function show(id: string) {
    setOpen(id); setRecon(null); setErr(null);
    try { setRecon(await api<Reconstitution>(`/v1/ia/journal/${encodeURIComponent(id)}`)); } catch (e) { setErr(describeError(e).message); }
  }

  return (
    <div className="stack">
      <div className="seg seg-wrap" role="group" aria-label="Type d’événement">
        <button type="button" aria-pressed={type === ''} onClick={() => setType('')}>Tous</button>
        {Object.entries(JOURNAL_LABEL).map(([k, v]) => <button key={k} type="button" aria-pressed={type === k} onClick={() => setType(k)}>{v}</button>)}
      </div>
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && <JournalVisuels entries={q.data} />}
      {q.data && (
        <section className="panel">
          <DataTable<JournalEntry>
            rows={q.data.slice(0, 300)} rowKey={(r) => r.id} caption="Journal IA"
            empty={<EmptyState title="Journal vide pour ce filtre" icon="history" />}
            columns={[
              { key: 'at', label: 'Horodatage', render: (r) => fmtDate(r.at, true) },
              { key: 't', label: 'Événement', render: (r) => JOURNAL_LABEL[r.type] ?? r.type, primary: true },
              { key: 'a', label: 'Agent', render: (r) => r.agentCode },
              { key: 'who', label: 'Acteur', render: (r) => (r.actor.kind === 'ai' ? 'Agent (IA)' : r.actor.kind === 'system' ? 'Système' : `${r.actor.role ?? ''} ${r.actor.id}`) },
              { key: 'v', label: 'Versions', render: (r) => (r.promptVersion ? <span className="small">{r.modelVersion}<br />{r.promptVersion}</span> : '—') },
              { key: 'in', label: 'Données citées', render: (r) => (r.input ? `${r.input.citations.length} · ${short(r.input.hash)}` : '—') },
              { key: 'dec', label: 'Décision / délai', render: (r) => (r.decision ? `${r.decision.decision} · ${latency(r.decision.latencyMs)}` : r.action ? r.action.type : r.detail ?? '—') },
              { key: 'go', label: '', render: (r) => (r.recommendationId ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => void show(r.recommendationId!)}><Icon name="external" size={14} /> Reconstituer</button> : null) },
            ]}
          />
        </section>
      )}
      <Drawer open={open !== null} title={`Reconstitution ${open ?? ''}`} onClose={() => setOpen(null)}>
        {err && <p className="notice notice-err">{err}</p>}
        {!recon && !err && <Loading />}
        {recon && (
          <div className="stack">
            <StatusBadge tone={recon.outputIntact ? 'good' : 'critical'} label={recon.outputIntact ? 'Sortie intègre (empreinte vérifiée)' : 'Empreinte de sortie non conforme'} />
            <dl className="kv kv-dense">
              <div><dt>Agent</dt><dd>{recon.recommendation.agent}</dd></div>
              <div><dt>Finalité</dt><dd>{recon.recommendation.purpose}</dd></div>
              <div><dt>Modèle / fiche</dt><dd>{recon.recommendation.modelVersion} / {recon.recommendation.promptVersion}</dd></div>
              <div><dt>Entrée</dt><dd><code>{recon.recommendation.inputHash}</code></dd></div>
              <div><dt>Sortie</dt><dd><code>{recon.recommendation.outputHash}</code></dd></div>
              <div><dt>Décision</dt><dd>{recon.recommendation.status}{recon.recommendation.decidedByRole ? ` par ${recon.recommendation.decidedByRole}` : ''}{recon.recommendation.decisionReason ? ` — ${recon.recommendation.decisionReason}` : ''}</dd></div>
            </dl>
            <h3 className="eyebrow">Données citées</h3>
            <ul className="ia-bullets">{recon.recommendation.citations.map((c) => <li key={c.ref} className="small">{DOMAIN_LABEL[c.domain] ?? c.domain} — {c.label} <code className="muted">{c.ref}</code></li>)}</ul>
            {recon.journal.find((j) => j.input)?.input?.masked.length ? <p className="small muted">Champs masqués à l’agent : {recon.journal.find((j) => j.input)!.input!.masked.join(', ')}</p> : null}
            <h3 className="eyebrow">Chronologie</h3>
            <ol className="ia-timeline">
              {recon.journal.map((j) => <li key={j.id}><span className="small muted">{fmtDate(j.at, true)}</span> {JOURNAL_LABEL[j.type] ?? j.type}{j.decision ? ` — ${j.decision.decision} (${latency(j.decision.latencyMs)}) : ${j.decision.reason}` : ''}{j.detail ? ` — ${j.detail}` : ''}</li>)}
            </ol>
            <h3 className="eyebrow">Effets</h3>
            <ul className="ia-bullets">{recon.effects.map((e) => <li key={e.id} className="small">{EFFECT_LABEL[e.type] ?? e.type} {e.id} — {e.status === 'ANNULE' ? `annulé (${e.undoReason ?? ''})` : 'actif'}</li>)}</ul>
            {recon.effects.length === 0 && <p className="small muted">Aucun effet.</p>}
            <h3 className="eyebrow">Journal d’audit chaîné</h3>
            <ul className="ia-bullets">{recon.audit.map((a) => <li key={a.id} className="small">{a.id} · {a.action} · {a.actorKind} · <code className="muted">{a.hash.slice(0, 16)}…</code></li>)}</ul>
          </div>
        )}
      </Drawer>
    </div>
  );
}
