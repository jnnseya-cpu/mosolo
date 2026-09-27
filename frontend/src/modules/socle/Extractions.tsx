/**
 * Extractions de données (§ 12.3, § 12.5, § 31.1) : en deçà du seuil du registre, export signé par une personne
 * habilitée (motif, second facteur), filigrané ; au-delà, demande à trois visas — demandeur motivé → responsable des
 * données → comité des données — puis paquet chiffré, filigrané et expirant, remis au seul demandeur sous une phrase
 * secrète qu'il choisit (déchiffrement hors ligne).
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
import './socle.css';

interface BulkRequest {
  id: string; requestedBy: string; reason: string; finalite: string; repos: string[]; rowsAtRequest: number; threshold: number;
  status: 'DEMANDEE' | 'VISA_DONNEES' | 'APPROUVEE' | 'REFUSEE' | 'EXPIREE' | 'RETIREE';
  requestedAt: string; dataOwner?: { by: string; motif: string }; committee?: { by: string; motif: string }; expiresAt?: string; packageAvailable: boolean; packageRows: number | null;
}

const STATUS: Record<BulkRequest['status'], [string, Tone]> = {
  DEMANDEE: ['Visa du responsable des données attendu', 'warning'], VISA_DONNEES: ['Décision du comité attendue', 'warning'],
  APPROUVEE: ['Approuvée — paquet disponible', 'good'], REFUSEE: ['Refusée', 'neutral'], EXPIREE: ['Expirée', 'neutral'], RETIREE: ['Retirée', 'neutral'],
};

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Extractions() {
  const { user, fmtDate } = useApp();
  const roles = user?.roles ?? [];
  const allowed = roles.some((r) => ['R26', 'R27', 'R25', 'R02', 'R03', 'R05', 'R22', 'R23', 'R28'].includes(r));
  const canRequest = roles.some((r) => ['R26', 'R27'].includes(r));
  const isDataOwner = roles.includes('R25');
  const isCommittee = roles.some((r) => ['R02', 'R03', 'R05'].includes(r));
  const list = useApi(allowed ? () => api<{ items: BulkRequest[]; threshold: number }>('/v1/socle/exports/requests') : null, [user?.id]);
  const [form, setForm] = useState({ reason: '', finalite: '', repos: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); list.reload(); } catch (e) { setMsg({ ok: false, text: describeError(e).message }); } finally { setBusy(false); }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const repos = form.repos.split(',').map((s) => s.trim()).filter(Boolean);
    void run(async () => {
      const r = await api<Record<string, unknown>>('/v1/socle/exports', { method: 'POST', body: { reason: form.reason.trim(), ...(form.finalite.trim() ? { finalite: form.finalite.trim() } : {}), ...(repos.length ? { repos } : {}) } });
      if (r.status !== 'VISAS_REQUIS') download(`export-signe-${new Date().toISOString().slice(0, 10)}.json`, r);
    }, 'Demande traitée : export signé téléchargé, ou circuit à trois visas engagé si le seuil est dépassé.');
  };
  const decide = (r: BulkRequest, step: 'data-owner' | 'committee', approve: boolean) => {
    const motif = window.prompt(approve ? 'Motif du visa' : 'Motif du refus');
    if (!motif || motif.trim().length < 5) return;
    void run(() => api(`/v1/socle/exports/requests/${r.id}/${step}`, { method: 'POST', body: { approve, motif: motif.trim() } }), approve ? 'Visa enregistré.' : 'Demande refusée.');
  };
  const fetchPackage = (r: BulkRequest) => {
    const passphrase = window.prompt('Phrase secrète de chiffrement du paquet (12 caractères minimum, à conserver hors de la plateforme)');
    if (!passphrase || passphrase.length < 12) return;
    void run(async () => download(`extraction-${r.id}.chiffre.json`, await api(`/v1/socle/exports/requests/${r.id}/package`, { method: 'POST', body: { passphrase } })), 'Paquet chiffré téléchargé (filigrané à votre nom).');
  };

  if (!allowed) return <div className="page"><PageHead eyebrow="Données" title="Extractions de données" /><EmptyState title="Accès réservé" icon="lock">Réservé à l’exploitation, au responsable des données, au comité des données, à l’audit et à la sécurité.</EmptyState></div>;
  return (
    <div className="page page-wide socle-page">
      <PageHead eyebrow="Données" title="Extractions de données"
        lead={`Au-delà de ${list.data?.threshold ?? '…'} lignes (seuil par défaut — à confirmer) : trois visas de personnes distinctes, paquet chiffré, filigrané et expirant ; alerte immédiate à la sécurité et à l’audit.`} />
      {list.loading && <Loading />}
      {list.error !== null && <ErrorState error={list.error} onRetry={list.reload} />}
      {msg && <p className={`notice ${msg.ok ? 'notice-ok' : 'notice-err'}`} role="status">{msg.text}</p>}
      {canRequest && (
        <section className="panel">
          <div className="panel-head"><h2 className="panel-title">Nouvelle extraction</h2></div>
          <form className="form" onSubmit={submit}>
            <div className="field"><label htmlFor="ex-motif" className="label">Motif</label><input id="ex-motif" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></div>
            <div className="field"><label htmlFor="ex-fin" className="label">Finalité (registre des traitements)</label><input id="ex-fin" value={form.finalite} onChange={(e) => setForm({ ...form, finalite: e.target.value })} /></div>
            <div className="field"><label htmlFor="ex-repos" className="label">Périmètre (dépôts, séparés par des virgules ; vide = tout)</label><input id="ex-repos" className="mono" value={form.repos} onChange={(e) => setForm({ ...form, repos: e.target.value })} placeholder="ext.acces.entities, payments.orders" /></div>
            <button type="submit" className="btn btn-primary" disabled={busy || form.reason.trim().length < 5}><Icon name="download" size={16} /> Demander</button>
          </form>
        </section>
      )}
      {list.data && (
        <DataTable rows={list.data.items} rowKey={(r) => r.id} caption="Demandes d’extraction massive" empty={<EmptyState title="Aucune demande d’extraction massive" icon="download" />}
          columns={[
            { key: 'i', label: 'Demande', primary: true, render: (r) => <><span className="row-title mono">{r.id}</span><span className="small muted">{r.requestedBy} · {fmtDate(r.requestedAt, true)} · {r.rowsAtRequest} lignes</span></> },
            { key: 's', label: 'Statut', render: (r) => <StatusBadge tone={STATUS[r.status][1]} label={STATUS[r.status][0]} /> },
            { key: 'f', label: 'Finalité', full: true, render: (r) => <span className="small">{r.finalite}{r.dataOwner ? ` — visa données : ${r.dataOwner.by}` : ''}{r.committee ? ` — comité : ${r.committee.by}` : ''}{r.expiresAt ? ` — expire le ${fmtDate(r.expiresAt, true)}` : ''}</span> },
            {
              key: 'x', label: '', render: (r) => (
                <div className="row-actions">
                  {isDataOwner && r.status === 'DEMANDEE' && r.requestedBy !== user?.id && <><button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => decide(r, 'data-owner', true)}>Viser</button><button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => decide(r, 'data-owner', false)}>Refuser</button></>}
                  {isCommittee && r.status === 'VISA_DONNEES' && <><button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => decide(r, 'committee', true)}>Approuver</button><button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => decide(r, 'committee', false)}>Refuser</button></>}
                  {r.packageAvailable && r.requestedBy === user?.id && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => fetchPackage(r)}><Icon name="download" size={14} /> Paquet chiffré</button>}
                </div>
              ),
            },
          ]} />
      )}
    </div>
  );
}
