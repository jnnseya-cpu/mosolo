/**
 * Scellement du journal d'audit (§ 25.1) : signataire (logiciel ou module matériel), copie en écriture unique (WORM),
 * racines quotidiennes horodatées et publiées hors de la plateforme, contrôles d'intégrité (chaîne ↔ copie ↔ racines).
 * Toute divergence lève une alerte critique ; aucun effet automatique.
 */
import { useState } from 'react';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { useApp } from '../../context';
import { hasRole, Kpi } from './shared';
import './integrite.css';

interface Root { id: string; day: string; partial: boolean; fromSeq: number; toSeq: number; count: number; merkleRoot: string; timestamp: { genTime: string; policy: string } | null; timestampError?: string; publication: { kind: string; ref: string } | null; publicationError?: string; createdAt: string }
interface Check { id: string; at: string; trigger: string; by: string; ok: boolean; live: { ok: boolean; length: number }; copy: { length: number; compared: number; ok: boolean }; roots: { total: number; ok: boolean }; findings: { code: string; severity: string; detail: string }[] }
export interface ScellementStatus {
  signer: { kind: string; keyId: string; note: string };
  chain: { length: number; head: { seq: number; hash: string } };
  worm: { kind: string; location: string; lastSeq: number; segments: { name: string; fromSeq: number; toSeq: number }[] };
  timestampAuthority: { name: string; external: boolean; note: string };
  publication: { kind: string; location: string; published: number };
  roots: Root[]; lastCheck: Check | null; checks: Check[];
}

export default function Scellement() {
  const { user, fmtDate } = useApp();
  const allowed = hasRole(user?.roles, 'R22', 'R23', 'R28', 'R26', 'R27');
  const canRun = hasRole(user?.roles, 'R28', 'R27', 'R22');
  const s = useApi(allowed ? () => api<ScellementStatus>('/v1/integrite/scellement') : null, [user?.id]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: (r: unknown) => string) => {
    setBusy(true); setMsg(null);
    try { const r = await fn(); setMsg({ ok: true, text: ok(r) }); s.reload(); } catch (e) { setMsg({ ok: false, text: describeError(e).message }); } finally { setBusy(false); }
  };
  if (!allowed) return <div className="page"><PageHead eyebrow="Sécurité" title="Scellement du journal" /><EmptyState title="Accès réservé" icon="lock">Réservé à l’audit, à la sécurité et à l’exploitation.</EmptyState></div>;
  return (
    <div className="page page-wide ig-page">
      <PageHead eyebrow="Sécurité" title="Scellement du journal d’audit"
        lead="Preuve pratiquement infalsifiable sans détection : chaîne d’empreintes signée, copie en écriture unique, racine quotidienne horodatée et publiée hors de la plateforme, contrôle d’intégrité horaire.">
        <button type="button" className="btn btn-secondary" onClick={s.reload}><Icon name="refresh" size={18} /> Actualiser</button>
      </PageHead>
      {s.loading && <Loading />}
      {s.error !== null && <ErrorState error={s.error} onRetry={s.reload} />}
      {msg && <p className={`notice ${msg.ok ? 'notice-ok' : 'notice-err'}`} role="status">{msg.text}</p>}
      {s.data && (
        <>
          <div className="kpi-row ig-kpis">
            <Kpi label="Enregistrements" value={s.data.chain.length} />
            <Kpi label="Copiés (WORM)" value={s.data.worm.lastSeq} />
            <Kpi label="Racines publiées" value={s.data.publication.published} />
            <Kpi label="Dernier contrôle" value={<span className="ig-kpi-text">{s.data.lastCheck ? (s.data.lastCheck.ok ? 'Intègre' : 'Divergence') : 'Aucun'}</span>} />
          </div>
          <p className="callout callout-info ig-note"><Icon name="lock" size={18} /><span>{s.data.signer.note} {s.data.timestampAuthority.note}</span></p>
          {canRun && (
            <div className="row-actions">
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void run(() => api('/v1/integrite/scellement/copie', { method: 'POST' }), (r) => `Copie WORM : ${(r as { copied: number }).copied} enregistrement(s) ajouté(s) dans un nouveau segment.`)}><Icon name="download" size={16} /> Copier (WORM)</button>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void run(() => api('/v1/integrite/scellement/racines', { method: 'POST', body: {} }), (r) => `Racine ${(r as Root).id} publiée.`)}><Icon name="send" size={16} /> Publier la racine de la veille</button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => api('/v1/integrite/scellement/controles', { method: 'POST' }), (r) => ((r as Check).ok ? 'Contrôle : chaîne, copie et racines concordent.' : `Contrôle : ${(r as Check).findings.length} divergence(s) — alerte levée.`))}><Icon name="shieldCheck" size={16} /> Contrôler maintenant</button>
            </div>
          )}
          <h2 className="panel-title">Racines quotidiennes</h2>
          <DataTable rows={s.data.roots} rowKey={(r) => r.id} caption="Racines" empty={<EmptyState title="Aucune racine publiée" icon="lock" />}
            columns={[
              { key: 'd', label: 'Jour', primary: true, render: (r) => <><span className="row-title">{r.day}{r.partial ? ' (partielle)' : ''}</span><span className="small muted">rangs {r.fromSeq}–{r.toSeq} · {r.count}</span></> },
              { key: 'm', label: 'Racine de Merkle', render: (r) => <span className="mono small">{r.merkleRoot.slice(0, 16)}…</span> },
              { key: 't', label: 'Horodatage', render: (r) => (r.timestamp ? <span className="small">{fmtDate(r.timestamp.genTime, true)}</span> : <StatusBadge tone="critical" label="Échec" />) },
              { key: 'p', label: 'Publication', render: (r) => (r.publication ? <span className="small mono">{r.publication.ref}</span> : <StatusBadge tone="critical" label="Échec" />) },
            ]} />
          <h2 className="panel-title">Contrôles d’intégrité</h2>
          <DataTable rows={s.data.checks} rowKey={(c) => c.id} caption="Contrôles" empty={<EmptyState title="Aucun contrôle" icon="shieldCheck" />}
            columns={[
              { key: 'a', label: 'Contrôle', primary: true, render: (c) => <><span className="row-title">{fmtDate(c.at, true)}</span><span className="small muted">{c.trigger === 'PLANIFIE' ? 'Planifié' : `Manuel — ${c.by}`}</span></> },
              { key: 'r', label: 'Résultat', render: (c) => <StatusBadge tone={c.ok ? 'good' : 'critical'} label={c.ok ? 'Intègre' : 'Divergence'} /> },
              { key: 'f', label: 'Constats', full: true, render: (c) => (c.findings.length ? <ul className="plain-list small">{c.findings.map((f, i) => <li key={i}>{f.detail}</li>)}</ul> : <span className="small muted">Chaîne {c.live.length} · copie {c.copy.length} · racines {c.roots.total}</span>) },
            ]} />
        </>
      )}
    </div>
  );
}
