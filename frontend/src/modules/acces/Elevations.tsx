/**
 * Accès privilégiés juste-à-temps (§ 12.1, § 12.3, Annexe C) : le personnel d'exploitation demande une élévation
 * motivée et limitée dans le temps ; le responsable sécurité (personne distincte, second facteur) l'approuve ou la
 * refuse ; l'élévation expire d'elle-même ; chaque action de la session est enregistrée et consultable.
 */
import { useState, type FormEvent } from 'react';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { useApp } from '../../context';

export interface Elevation {
  id: string; userId: string; role: string; roleLabel: string; motif: string; ticketRef?: string; durationMinutes: number;
  status: 'DEMANDEE' | 'ACTIVE' | 'REFUSEE' | 'EXPIREE' | 'TERMINEE' | 'REVOQUEE';
  requestedAt: string; decidedBy?: string; decisionMotif?: string; startsAt?: string; expiresAt?: string; endedAt?: string; endReason?: string;
  actions: number; remainingSeconds: number;
}
interface ElevationList { items: Elevation[]; elevatableRoles: { code: string; label: string }[]; maxMinutes: number }
interface SessionView { elevation: Elevation; items: { seq: number; at: string; action: string; resourceType: string; resourceId: string | null; outcome: string; details?: Record<string, unknown> }[] }

export const ELEVATION_STATUS: Record<Elevation['status'], [string, Tone]> = {
  DEMANDEE: ['Demandée', 'warning'], ACTIVE: ['Active', 'serious'], REFUSEE: ['Refusée', 'neutral'],
  EXPIREE: ['Expirée', 'good'], TERMINEE: ['Terminée', 'good'], REVOQUEE: ['Révoquée', 'critical'],
};

export default function Elevations() {
  const { user, fmtDate } = useApp();
  const list = useApi(user ? () => api<ElevationList>('/v1/acces/elevations') : null, [user?.id]);
  const [form, setForm] = useState({ role: 'R26', durationMinutes: 30, motif: '', ticketRef: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [session, setSession] = useState<SessionView | null>(null);
  const [busy, setBusy] = useState(false);
  const isSecurity = !!user?.roles.includes('R28');
  const canRequest = !!user?.roles.some((r) => ['R26', 'R27', 'R28'].includes(r));

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); list.reload(); } catch (e) { setMsg({ ok: false, text: describeError(e).message }); } finally { setBusy(false); }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api('/v1/acces/elevations', { method: 'POST', body: { role: form.role, durationMinutes: Number(form.durationMinutes), motif: form.motif.trim(), ...(form.ticketRef.trim() ? { ticketRef: form.ticketRef.trim() } : {}) } }),
      'Demande enregistrée : le responsable sécurité est prévenu.');
  };
  const decide = (id: string, approve: boolean) => {
    const motif = window.prompt(approve ? 'Motif de l’approbation' : 'Motif du refus');
    if (!motif || motif.trim().length < 5) return;
    void run(() => api(`/v1/acces/elevations/${id}/decision`, { method: 'POST', body: { approve, motif: motif.trim() } }), approve ? 'Élévation approuvée : elle expirera automatiquement.' : 'Élévation refusée.');
  };
  const end = (id: string) => {
    const motif = window.prompt('Motif de la fin anticipée');
    if (!motif || motif.trim().length < 5) return;
    void run(() => api(`/v1/acces/elevations/${id}/end`, { method: 'POST', body: { motif: motif.trim() } }), 'Élévation terminée.');
  };
  const openSession = async (id: string) => {
    try { setSession(await api<SessionView>(`/v1/acces/elevations/${id}/session`)); } catch (e) { setMsg({ ok: false, text: describeError(e).message }); }
  };

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Accès" title="Accès privilégiés juste-à-temps"
        lead="Élévation temporaire, motivée, approuvée par une autre personne, expirant automatiquement ; chaque action de la session est enregistrée. La consultation « bris de glace » reste disponible." />
      {list.loading && <Loading />}
      {list.error !== null && <ErrorState error={list.error} onRetry={list.reload} />}
      {msg && <p className={`notice ${msg.ok ? 'notice-ok' : 'notice-err'}`} role="status">{msg.text}</p>}
      {list.data && canRequest && (
        <section className="panel">
          <div className="panel-head"><h2 className="panel-title">Demander une élévation</h2></div>
          <form className="form" onSubmit={submit}>
            <div className="field">
              <label htmlFor="elv-role" className="label">Rôle temporaire</label>
              <select id="elv-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {list.data.elevatableRoles.map((r) => <option key={r.code} value={r.code}>{r.label} ({r.code})</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="elv-duree" className="label">Durée (minutes, {list.data.maxMinutes} au plus — par défaut, à confirmer)</label>
              <input id="elv-duree" type="number" min={5} max={list.data.maxMinutes} value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: Number(e.target.value) })} />
            </div>
            <div className="field">
              <label htmlFor="elv-motif" className="label">Motif précis</label>
              <textarea id="elv-motif" rows={2} value={form.motif} onChange={(e) => setForm({ ...form, motif: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="elv-ticket" className="label">Référence d’incident ou de changement (facultatif)</label>
              <input id="elv-ticket" value={form.ticketRef} onChange={(e) => setForm({ ...form, ticketRef: e.target.value })} />
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy || form.motif.trim().length < 10}><Icon name="lock" size={16} /> Demander</button>
          </form>
        </section>
      )}
      {list.data && (
        <DataTable rows={list.data.items} rowKey={(e) => e.id} caption="Élévations" empty={<EmptyState title="Aucune élévation" icon="lock" />}
          columns={[
            { key: 'id', label: 'Élévation', primary: true, render: (e) => <><span className="row-title mono">{e.id}</span><span className="small muted">{e.userId} → {e.roleLabel}</span></> },
            { key: 's', label: 'Statut', render: (e) => <StatusBadge tone={ELEVATION_STATUS[e.status][1]} label={ELEVATION_STATUS[e.status][0]} /> },
            { key: 'm', label: 'Motif', full: true, render: (e) => <span className="small">{e.motif}{e.ticketRef ? ` (${e.ticketRef})` : ''}</span> },
            { key: 't', label: 'Échéance', render: (e) => (e.status === 'ACTIVE' && e.expiresAt ? <span className="small">{fmtDate(e.expiresAt, true)} · {Math.ceil(e.remainingSeconds / 60)} min</span> : <span className="small muted">{e.durationMinutes} min</span>) },
            { key: 'a', label: 'Actions enregistrées', num: true, render: (e) => e.actions },
            {
              key: 'x', label: '', render: (e) => (
                <div className="row-actions">
                  {isSecurity && e.status === 'DEMANDEE' && e.userId !== user?.id && <>
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => decide(e.id, true)}>Approuver</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => decide(e.id, false)}>Refuser</button>
                  </>}
                  {(e.status === 'ACTIVE' || (e.status === 'DEMANDEE' && e.userId === user?.id)) && (e.userId === user?.id || isSecurity) && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => end(e.id)}>{e.userId === user?.id ? 'Terminer' : 'Révoquer'}</button>}
                  {e.actions > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openSession(e.id)}>Session</button>}
                </div>
              ),
            },
          ]} />
      )}
      {session && (
        <section className="panel">
          <div className="panel-head"><h2 className="panel-title">Session enregistrée — {session.elevation.id}</h2><button type="button" className="btn btn-ghost btn-sm" onClick={() => setSession(null)}>Fermer</button></div>
          <ul className="plain-list small">
            {session.items.map((i) => <li key={i.seq}><span className="mono">{fmtDate(i.at, true)}</span> — {i.action} {i.details?.path ? <span className="mono">{String(i.details.method)} {String(i.details.path)} ({String(i.details.statusCode)})</span> : <span className="muted">{i.resourceType} {i.resourceId ?? ''}</span>}</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}
