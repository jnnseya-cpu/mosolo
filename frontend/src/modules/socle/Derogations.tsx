/**
 * Dérogations à la base connue d'un objet (liquidation) : une saisie inférieure aux données connues au-delà de la
 * tolérance exige une demande motivée du liquidateur puis l'approbation d'une seconde personne de la hiérarchie
 * (R06, R07), distincte du demandeur et sans lien avec le contribuable. Consultation : liquidation, hiérarchie, audit.
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { api, describeError } from '../../lib/api';
import './socle.css';
import { DerogationsVisuels } from './visuels';

export interface BaseOverride {
  id: string; ruleId: string; taxpayerId: string; objectId: string; inputs: Record<string, string>;
  lowered: { field: string; reference: string; referenceSource: 'CONSTAT' | 'ATTRIBUT'; declared: string }[];
  motive: string; requestedBy: string; requestedAt: string; status: 'DEMANDEE' | 'APPROUVEE' | 'REFUSEE' | 'UTILISEE';
  decision?: { by: string; at: string; reason: string; approved: boolean }; usedByObligationId?: string;
}

const STATUS: Record<BaseOverride['status'], { label: string; tone: Tone }> = {
  DEMANDEE: { label: 'En attente d’approbation', tone: 'warning' }, APPROUVEE: { label: 'Approuvée — non encore utilisée', tone: 'info' },
  REFUSEE: { label: 'Refusée', tone: 'neutral' }, UTILISEE: { label: 'Utilisée à la liquidation', tone: 'good' },
};
const SOURCE: Record<string, string> = { CONSTAT: 'constat de terrain', ATTRIBUT: 'attribut déclaré' };

function OverrideCard({ b, onDone }: { b: BaseOverride; onDone: () => void }) {
  const { fmtDate, user } = useApp();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const roles = user?.roles ?? [];
  const own = user?.id === b.requestedBy;
  const canDecide = b.status === 'DEMANDEE' && roles.some((r) => r === 'R06' || r === 'R07') && !own;
  const st = STATUS[b.status] ?? { label: b.status, tone: 'neutral' as Tone };
  async function decide(approve: boolean) {
    setBusy(true); setMsg(null);
    try {
      await api(`/v1/assessments/base-overrides/${encodeURIComponent(b.id)}/decision`, { method: 'POST', body: { approve, reason: reason.trim() } });
      setMsg({ ok: true, text: approve ? 'Dérogation approuvée : le liquidateur peut l’utiliser une fois.' : 'Dérogation refusée (motif tracé).' });
      onDone();
    } catch (e) { const d = describeError(e); setMsg({ ok: false, text: d.message + (d.code ? ` (${d.code})` : '') }); } finally { setBusy(false); }
  }
  return (
    <article className="panel socle-override">
      <div className="panel-head">
        <div className="min0">
          <p className="panel-title">Dérogation <span className="mono small">{b.id}</span></p>
          <p className="panel-sub">Objet <span className="mono">{b.objectId}</span> · contribuable <span className="mono">{b.taxpayerId}</span> · règle <span className="mono">{b.ruleId}</span></p>
        </div>
        <StatusBadge tone={st.tone} label={st.label} />
      </div>
      <DataTable caption="Champs abaissés" rows={b.lowered} rowKey={(l) => l.field} columns={[
        { key: 'f', label: 'Champ', primary: true, render: (l) => <span className="mono">{l.field}</span> },
        { key: 'r', label: 'Référence connue', num: true, render: (l) => <>{l.reference} <span className="small muted">({SOURCE[l.referenceSource] ?? l.referenceSource})</span></> },
        { key: 'd', label: 'Saisie', num: true, render: (l) => <strong>{l.declared}</strong> },
      ]} />
      <p className="small">Motif : {b.motive}</p>
      <p className="small muted">Demandée par {b.requestedBy} le {fmtDate(b.requestedAt, true)}</p>
      {b.decision && <p className="small">{b.decision.approved ? 'Approuvée' : 'Refusée'} par {b.decision.by} le {fmtDate(b.decision.at, true)} — {b.decision.reason}</p>}
      {b.usedByObligationId && <p className="small">Utilisée par l’obligation <span className="mono">{b.usedByObligationId}</span></p>}
      {b.status === 'DEMANDEE' && own && <p className="callout callout-info"><Icon name="lock" size={18} /> Quatre yeux : vous avez demandé cette dérogation ; l’approbation revient à une autre personne.</p>}
      {canDecide && (
        <>
          <div className="field">
            <label className="label" htmlFor={`bo-${b.id}`}>Motif de la décision</label>
            <textarea id={`bo-${b.id}`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} maxLength={2000} />
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || reason.trim().length < 10} onClick={() => void decide(true)}><Icon name="check" size={14} /> Approuver</button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || reason.trim().length < 10} onClick={() => void decide(false)}><Icon name="x" size={14} /> Refuser</button>
          </div>
        </>
      )}
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'notice notice-ok' : 'notice notice-err'}>{msg.text}</p>}
    </article>
  );
}

export default function Derogations() {
  const { user } = useApp();
  const q = useApi(() => api<BaseOverride[]>('/v1/assessments/base-overrides'), [user?.id]);
  const [status, setStatus] = useState<BaseOverride['status']>('DEMANDEE');
  const all = q.data ?? [];
  const list = all.filter((b) => b.status === status);
  return (
    <div className="page page-wide socle-overrides">
      <PageHead eyebrow="Liquidation" title="Dérogations à la base" lead="Une base inférieure aux données connues de l’objet (au-delà de la tolérance) n’est retenue qu’après la demande motivée du liquidateur et l’approbation d’une seconde personne de la hiérarchie." />
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && (
        <>
          <DerogationsVisuels items={all} statuts={STATUS} />
          <div className="seg seg-wrap socle-seg" role="group" aria-label="Statut">
            {(Object.keys(STATUS) as BaseOverride['status'][]).map((s) => (
              <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>{STATUS[s].label} <span className="count">{all.filter((b) => b.status === s).length}</span></button>
            ))}
          </div>
          <div className="socle-override-grid">
            {list.length === 0 && <EmptyState title="Aucune dérogation" icon="check" />}
            {list.map((b) => <OverrideCard key={b.id} b={b} onDone={q.reload} />)}
          </div>
        </>
      )}
    </div>
  );
}
