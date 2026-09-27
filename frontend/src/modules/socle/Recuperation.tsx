/**
 * Récupération de compte contrôlée (§ 9.3) : demande publique (réponse identique que le compte existe ou non, le
 * titulaire actuel est alerté), vérification d'identité au guichet, approbation par une seconde personne.
 */
import { useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { ReasonAction } from '../fiscal/common';
import './socle.css';

interface Recovery { id: string; taxpayerId: string | null; status: string; requestedAt: string; newPhoneMasked: string; verification?: { by: string; note: string }; decision?: { reason: string } }

function RequestForm() {
  const [f, setF] = useState({ iuc: '', newPhone: '', idDocumentRef: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function go(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try { const r = await api<{ reference: string; notice: string }>('/v1/public/enrolement/recuperations', { method: 'POST', body: f }); setMsg(`Référence ${r.reference}. ${r.notice}`); } catch (x) { setErr(describeError(x).message); }
  }
  if (msg) return <p className="notice" role="status">{msg}</p>;
  return (
    <form className="panel stack-sm" onSubmit={(e) => void go(e)}>
      <div className="field"><label className="label" htmlFor="rc-iuc">Identifiant du compte (IUC, ex. KIN-XXXXXXXX-X)</label><input id="rc-iuc" required value={f.iuc} onChange={(e) => setF({ ...f, iuc: e.target.value })} /></div>
      <div className="field"><label className="label" htmlFor="rc-ph">Nouveau numéro de téléphone</label><input id="rc-ph" required inputMode="tel" value={f.newPhone} onChange={(e) => setF({ ...f, newPhone: e.target.value })} /></div>
      <div className="field"><label className="label" htmlFor="rc-id">Numéro de la pièce d’identité que vous présenterez au guichet</label><input id="rc-id" required value={f.idDocumentRef} onChange={(e) => setF({ ...f, idDocumentRef: e.target.value })} /></div>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      <button type="submit" className="btn btn-primary btn-sm">Demander la récupération</button>
    </form>
  );
}

function AgentQueue() {
  const { user, fmtDate } = useApp();
  const q = useApi(() => api<Recovery[]>('/v1/enrolement/recuperations'), [user?.id]);
  const roles = user?.roles ?? [];
  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  return (
    <section className="stack-sm">
      <h2 className="h-sub">Demandes à traiter</h2>
      {(q.data ?? []).length === 0 && <EmptyState title="Aucune demande en cours." />}
      <ul className="stack-sm">{(q.data ?? []).map((r) => (
        <li key={r.id} className="panel stack-sm">
          <div className="panel-head"><div className="min0"><p className="panel-title"><span className="mono">{r.id}</span> — compte {r.taxpayerId}</p><p className="panel-sub">Demandée le {fmtDate(r.requestedAt, true)} · nouveau numéro {r.newPhoneMasked}</p></div>
            <StatusBadge tone={r.status === 'VERIFIEE' ? 'info' : 'warning'} label={r.status === 'VERIFIEE' ? 'Identité vérifiée — approbation attendue' : 'Vérification au guichet attendue'} /></div>
          {r.status === 'DEMANDEE' && roles.includes('R12') && <ReasonAction label="Pièce vérifiée au guichet" confirmLabel="Enregistrer la vérification" onSubmit={(note) => api(`/v1/enrolement/recuperations/${r.id}/verification`, { method: 'POST', body: { note } }).then(q.reload)} />}
          {r.status === 'VERIFIEE' && roles.some((x) => x === 'R07' || x === 'R06') && user?.id !== r.verification?.by && (
            <div className="btn-row">
              <ReasonAction label="Approuver" confirmLabel="Approuver la récupération" onSubmit={(reason) => api(`/v1/enrolement/recuperations/${r.id}/decision`, { method: 'POST', body: { approve: true, reason } }).then(q.reload)} />
              <ReasonAction label="Refuser" confirmLabel="Refuser" tone="secondary" onSubmit={(reason) => api(`/v1/enrolement/recuperations/${r.id}/decision`, { method: 'POST', body: { approve: false, reason } }).then(q.reload)} />
            </div>
          )}
        </li>))}</ul>
    </section>
  );
}

export default function Recuperation() {
  const { user } = useApp();
  const isAgent = (user?.roles ?? []).some((r) => ['R12', 'R07', 'R06'].includes(r));
  return (
    <div className="page">
      <PageHead eyebrow="Compte unique" title="Récupérer mon compte"
        lead="Téléphone perdu ou changé : la récupération est contrôlée. Votre identité est vérifiée au guichet MOSOLO, puis une seconde personne approuve. Le titulaire actuel est prévenu de toute demande." />
      {isAgent ? <AgentQueue /> : <RequestForm />}
    </div>
  );
}
