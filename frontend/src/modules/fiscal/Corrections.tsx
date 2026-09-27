/**
 * Corrections d'objets fiscaux : proposition motivée de correction du rang de localité ou d'un attribut de base
 * (surface…) — ancienne → nouvelle valeur — par un contrôleur, chef de service ou direction ; approbation par une
 * seconde personne distincte du proposant et du déclarant (quatre yeux), puis réévaluation des obligations ouvertes.
 * Historique jamais écrasé.
 */
import { useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { sha256Hex } from '../../lib/crypto';
import { DemoNote, FiscalTabs, ReasonAction, useViewer } from './common';
import type { FiscalObjectView } from './types';
import { AideContextuelle } from '../apprentissage/AideContextuelle';
import './fiscal.css';

export interface ObjectCorrection {
  id: string; objectId: string; taxpayerId?: string;
  proposed: { localityRank?: number; attributes?: Record<string, string> };
  before: { localityRank: number; attributes: Record<string, unknown> };
  reason: string; evidence?: { label: string; sha256?: string }[]; proposedBy: string; proposedAt: string; status: 'PROPOSEE' | 'APPLIQUEE' | 'REJETEE';
  decision?: { by: string; at: string; reason: string; approved: boolean };
  reassessed?: { obligationId: string; changed: boolean; resultingObligationId: string }[];
}
export interface ObjectChange {
  at: string; kind: 'RANG_CONFIRME' | 'RANG_CORRIGE' | 'CORRECTION'; by: string[];
  before: { localityRank: number; attributes?: Record<string, unknown> }; after: { localityRank: number; attributes?: Record<string, unknown> };
  reason: string; correctionId?: string;
}
interface CorrectionsResponse { corrections: ObjectCorrection[]; history: ObjectChange[] }
/** File des corrections (tous objets du périmètre) : résumé de l'objet joint par le serveur. */
type QueuedCorrection = ObjectCorrection & { object: { id: string; category: string; commune: string; quartier: string; localityRank: number; createdBy: string } };

const STATUS: Record<ObjectCorrection['status'], { label: string; tone: Tone }> = {
  PROPOSEE: { label: 'Proposée — seconde approbation attendue', tone: 'warning' }, APPLIQUEE: { label: 'Appliquée', tone: 'good' }, REJETEE: { label: 'Rejetée', tone: 'neutral' },
};
const CHANGE_KIND: Record<ObjectChange['kind'], string> = { RANG_CONFIRME: 'Rang confirmé', RANG_CORRIGE: 'Rang corrigé', CORRECTION: 'Correction' };
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

/** Lignes « champ : ancienne → nouvelle valeur ». */
function Diff({ before, after }: { before: { localityRank: number; attributes?: Record<string, unknown> }; after: { localityRank?: number; attributes?: Record<string, unknown> } }) {
  return (
    <ul className="plain-list small">
      {after.localityRank !== undefined && <li>Rang de localité : {before.localityRank} → <strong>{after.localityRank}</strong></li>}
      {Object.entries(after.attributes ?? {}).map(([k, v]) => <li key={k}><span className="mono">{k}</span> : {show(before.attributes?.[k])} → <strong>{show(v)}</strong></li>)}
    </ul>
  );
}

/** Pièces justificatives : libellé et empreinte SHA-256 du fichier (le fichier reste chez son détenteur). */
function EvidenceList({ items }: { items?: ObjectCorrection['evidence'] }) {
  if (!items?.length) return <p className="small muted">Aucune pièce jointe à la proposition.</p>;
  return (
    <ul className="plain-list small">
      {items.map((e, i) => <li key={`${e.label}-${i}`}><Icon name="file" size={12} /> {e.label}{e.sha256 ? <> · <span className="mono" title={e.sha256}>SHA-256 {e.sha256.slice(0, 12)}…</span></> : <span className="muted"> · sans empreinte</span>}</li>)}
    </ul>
  );
}

function CorrectionCard({ c, onChanged, objectLine }: { c: ObjectCorrection; onChanged: () => void; objectLine?: string }) {
  const { fmtDate, user } = useApp();
  const { has } = useViewer();
  const st = STATUS[c.status] ?? { label: c.status, tone: 'neutral' as Tone };
  const own = user?.id === c.proposedBy;
  const decide = (approve: boolean) => (reason: string) => api(`/v1/fiscal/object-corrections/${encodeURIComponent(c.id)}/decision`, { method: 'POST', body: { approve, reason } }).then(onChanged);
  return (
    <li className="panel">
      <div className="panel-head">
        <div className="min0"><p className="panel-title">Correction <span className="mono small">{c.id}</span></p><p className="panel-sub">{objectLine ? `${objectLine} · ` : ''}Proposée par {c.proposedBy} · {fmtDate(c.proposedAt, true)}</p></div>
        <StatusBadge tone={st.tone} label={st.label} />
      </div>
      <Diff before={c.before} after={c.proposed} />
      <p className="small">Justification : {c.reason}</p>
      <p className="caps-sm">Pièces justificatives</p>
      <EvidenceList items={c.evidence} />
      {c.decision && <p className="small muted">{c.decision.approved ? 'Approuvée' : 'Rejetée'} par {c.decision.by} · {fmtDate(c.decision.at, true)} — {c.decision.reason}</p>}
      {!!c.reassessed?.length && <p className="small">Obligations réévaluées : {c.reassessed.map((r) => `${r.obligationId}${r.changed ? ` → ${r.resultingObligationId}` : ' (inchangée)'}`).join(' ; ')}</p>}
      {c.status === 'PROPOSEE' && has('R06', 'R07') && !own && (
        <div className="row-actions">
          <ReasonAction label="Approuver" confirmLabel="Approuver et appliquer" minLength={10} onSubmit={decide(true)} />
          <ReasonAction label="Rejeter" confirmLabel="Rejeter la correction" tone="secondary" minLength={10} onSubmit={decide(false)} />
        </div>
      )}
      {c.status === 'PROPOSEE' && own && <p className="small muted"><Icon name="lock" size={14} /> Quatre yeux : l’approbation revient à une autre personne que vous.</p>}
    </li>
  );
}

function ProposeForm({ o, onDone }: { o: FiscalObjectView; onDone: () => void }) {
  const [rank, setRank] = useState('');
  const [rows, setRows] = useState<{ key: string; value: string }[]>([]);
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState<{ label: string; sha256?: string }[]>([]);
  const [evLabel, setEvLabel] = useState('');
  const [evHash, setEvHash] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const keys = Object.keys(o.attributes).filter((k) => k !== 'demo');
  const setRow = (i: number, patch: Partial<{ key: string; value: string }>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const attributes = Object.fromEntries(rows.filter((r) => r.key.trim() && r.value.trim()).map((r) => [r.key.trim(), r.value.trim()]));
  const nothing = !rank && !Object.keys(attributes).length;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api(`/v1/fiscal/objects/${encodeURIComponent(o.id)}/corrections`, { method: 'POST', body: { reason: reason.trim(), ...(rank ? { localityRank: Number(rank) } : {}), ...(Object.keys(attributes).length ? { attributes } : {}), ...(evidence.length ? { evidence } : {}) } });
      setRank(''); setRows([]); setReason(''); setEvidence([]); onDone();
    } catch (x) { setErr(describeError(x).message); } finally { setBusy(false); }
  }
  return (
    <form className="panel form" onSubmit={(e) => void submit(e)} aria-label="Proposer une correction">
      <p className="panel-title">Proposer une correction</p>
      <div className="field">
        <label className="label" htmlFor="oc-rank">Rang de localité (actuel : {o.localityRank})</label>
        <select id="oc-rank" value={rank} onChange={(e) => setRank(e.target.value)}>
          <option value="">Inchangé</option>
          {[1, 2, 3, 4].filter((r) => r !== o.localityRank).map((r) => <option key={r} value={r}>Rang {r}</option>)}
        </select>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="field-row">
          <div className="field">
            <label className="label" htmlFor={`oc-k-${i}`}>Champ</label>
            <input id={`oc-k-${i}`} list="oc-keys" value={r.key} onChange={(e) => setRow(i, { key: e.target.value })} pattern="[A-Za-z_][A-Za-z0-9_]{0,63}" required />
            <span className="hint">Valeur actuelle : {show(o.attributes[r.key.trim()])}</span>
          </div>
          <div className="field">
            <label className="label" htmlFor={`oc-v-${i}`}>Nouvelle valeur</label>
            <input id={`oc-v-${i}`} inputMode="decimal" value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} pattern="\d{1,15}(\.\d{1,6})?" required />
          </div>
        </div>
      ))}
      <datalist id="oc-keys">{keys.map((k) => <option key={k} value={k} />)}</datalist>
      <div className="btn-row"><button type="button" className="btn btn-ghost btn-sm" onClick={() => setRows([...rows, { key: keys[0] ?? '', value: '' }])}><Icon name="file" size={14} /> Ajouter un attribut de base</button></div>
      {!nothing && <Diff before={{ localityRank: o.localityRank, attributes: o.attributes }} after={{ ...(rank ? { localityRank: Number(rank) } : {}), attributes }} />}
      <div className="field">
        <label className="label" htmlFor="oc-reason">Justification et pièces (référence du constat, plan, acte…)</label>
        <textarea id="oc-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={10} maxLength={1000} />
        <span className="hint">Aucune modification avant l’approbation d’une seconde personne (chef de service ou direction).</span>
      </div>
      <fieldset className="field">
        <legend className="label">Pièces justificatives (facultatives, 10 au plus)</legend>
        <EvidenceList items={evidence} />
        <div className="field-row">
          <div className="field">
            <label className="label" htmlFor="oc-ev-label">Libellé de la pièce</label>
            <input id="oc-ev-label" value={evLabel} onChange={(e) => setEvLabel(e.target.value)} maxLength={200} placeholder="PV de constat n°…, plan cadastral…" />
          </div>
          <div className="field">
            <label className="label" htmlFor="oc-ev-file">Fichier (empreinte calculée sur l’appareil)</label>
            <input id="oc-ev-file" type="file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.arrayBuffer().then(sha256Hex).then(setEvHash); else setEvHash(undefined); }} />
          </div>
        </div>
        <div className="btn-row">
          <button type="button" className="btn btn-ghost btn-sm" disabled={evLabel.trim().length < 3 || evidence.length >= 10}
            onClick={() => { setEvidence([...evidence, { label: evLabel.trim(), ...(evHash ? { sha256: evHash } : {}) }]); setEvLabel(''); setEvHash(undefined); }}>
            <Icon name="upload" size={14} /> Ajouter la pièce
          </button>
        </div>
      </fieldset>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy || nothing || reason.trim().length < 10}><Icon name="send" size={16} /> Proposer la correction</button>
    </form>
  );
}

function ObjectCorrections({ o, canPropose, onChanged }: { o: FiscalObjectView; canPropose: boolean; onChanged: () => void }) {
  const { fmtDate } = useApp();
  const q0 = useApi(() => api<CorrectionsResponse>(`/v1/fiscal/objects/${encodeURIComponent(o.id)}/corrections`), [o.id]);
  const q = { ...q0, reload: () => { q0.reload(); onChanged(); } };
  const pending = q.data?.corrections.some((c) => c.status === 'PROPOSEE');
  return (
    <div className="stack">
      {o.example && <DemoNote />}
      <dl className="kv kv-dense">
        <div><dt>Objet</dt><dd><span className="mono">{o.id}</span> — {o.categoryLabel}</dd></div>
        <div><dt>Localisation</dt><dd>{o.commune} · {o.quartier}{o.avenue ? ` · ${o.avenue}` : ''}</dd></div>
        <div><dt>Rang de localité</dt><dd>{o.localityRank}</dd></div>
        <div><dt>Attributs de base</dt><dd>{Object.entries(o.attributes).filter(([k]) => k !== 'demo').map(([k, v]) => `${k} = ${show(v)}`).join(' · ') || '—'}</dd></div>
      </dl>
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && (
        <>
          {canPropose && !pending && <ProposeForm o={o} onDone={q.reload} />}
          {canPropose && pending && <p className="callout callout-info"><Icon name="info" size={18} /> Une correction est déjà proposée pour cet objet : elle doit être décidée avant toute nouvelle proposition.</p>}
          <h3 className="h-sub">Corrections</h3>
          {q.data.corrections.length === 0 ? <EmptyState title="Aucune correction" icon="check" /> : (
            <ul className="plain-list stack">{[...q.data.corrections].reverse().map((c) => <CorrectionCard key={c.id} c={c} onChanged={q.reload} />)}</ul>
          )}
          <h3 className="h-sub">Historique de l’objet</h3>
          {q.data.history.length === 0 ? <p className="small muted">Aucune modification enregistrée.</p> : (
            <ul className="list-rows">
              {q.data.history.map((h, i) => (
                <li key={`${h.at}-${i}`} className="list-row list-row-stack">
                  <span className="row-title">{CHANGE_KIND[h.kind] ?? h.kind}{h.correctionId ? <span className="mono small"> · {h.correctionId}</span> : null}</span>
                  <Diff before={h.before} after={{ ...(h.after.localityRank !== h.before.localityRank ? { localityRank: h.after.localityRank } : {}), ...(h.after.attributes ? { attributes: h.after.attributes } : {}) }} />
                  <span className="small muted">{fmtDate(h.at, true)} · {h.by.join(', ')} — {h.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export default function Corrections() {
  const { user } = useApp();
  const { has } = useViewer();
  const objs = useApi(() => api<FiscalObjectView[]>('/v1/fiscal/objects'), [user?.id]);
  const [filter, setFilter] = useState('');
  const [openId, setOpenId] = useState('');
  // Relance le détail de l'objet ouvert après une décision prise depuis la file.
  const [tick, setTick] = useState(0);
  const canApprove = has('R06', 'R07');
  const queue = useApi(() => api<QueuedCorrection[]>('/v1/fiscal/object-corrections?status=EN_ATTENTE'), [user?.id]);
  const list = (objs.data ?? []).filter((o) => !filter || `${o.id} ${o.commune} ${o.quartier} ${o.categoryLabel} ${o.igf?.code ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  const open = (objs.data ?? []).find((o) => o.id === openId) ?? null;
  return (
    <div className="page page-wide fs-page">
      <PageHead eyebrow="Fiscalité" title="Corrections d’objets" lead="Rang de localité et attributs de base (surface…) : proposition motivée, approbation par une seconde personne, historique conservé et obligations ouvertes réévaluées."><AideContextuelle cle="fiscal.corrections" libelle="Aide : proposer une correction" /></PageHead>
      <FiscalTabs />
      <section className="panel fs-corr-queue" aria-label="Corrections en attente">
        <div className="panel-head"><div><p className="panel-title">Corrections en attente d’approbation</p><p className="panel-sub">{canApprove ? 'Tous objets de votre périmètre ; vous ne pouvez pas approuver votre propre proposition.' : 'Suivi des propositions ; l’approbation revient au chef de service ou à la direction.'}</p></div></div>
        {queue.loading && <Loading />}
        {queue.error !== null && <ErrorState error={queue.error} onRetry={queue.reload} />}
        {queue.data && (queue.data.length === 0 ? <EmptyState title="Aucune correction en attente" icon="check" /> : (
          <ul className="plain-list stack">
            {queue.data.map((c) => <CorrectionCard key={c.id} c={c} onChanged={() => { queue.reload(); setTick((n) => n + 1); }} objectLine={`${c.object.id} · ${c.object.commune} · ${c.object.quartier}`} />)}
          </ul>
        ))}
      </section>
      {objs.loading && <Loading />}
      {objs.error !== null && <ErrorState error={objs.error} onRetry={objs.reload} />}
      {objs.data && (
        <div className="fs-grid">
          <section className="panel">
            <div className="field">
              <label className="label" htmlFor="oc-filter">Rechercher un objet</label>
              <input id="oc-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Identifiant, commune, quartier, IGF…" />
            </div>
            {list.length === 0 ? <EmptyState title="Aucun objet" icon="building" /> : (
              <ul className="list-rows">
                {list.slice(0, 50).map((o) => (
                  <li key={o.id} className="list-row">
                    <span className="min0"><span className="mono small">{o.id}</span><br /><span className="small muted">{o.categoryLabel} · {o.commune} · {o.quartier} · rang {o.localityRank}</span></span>
                    <button type="button" className="btn btn-ghost btn-sm" aria-pressed={o.id === openId} onClick={() => setOpenId(o.id)}>Corrections <Icon name="chevronRight" size={16} /></button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="panel">
            {open ? <ObjectCorrections key={`${open.id}-${tick}`} o={open} canPropose={has('R06', 'R07', 'R11')} onChanged={queue.reload} /> : <EmptyState title="Choisissez un objet" icon="building">Les corrections sont listées et décidées objet par objet.</EmptyState>}
          </section>
        </div>
      )}
    </div>
  );
}
