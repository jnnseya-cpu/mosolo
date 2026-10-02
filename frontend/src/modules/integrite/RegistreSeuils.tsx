/**
 * Registre des seuils anti-fraude : valeur, unité, fichier source et statut de chaque paramètre. Une confirmation
 * (acte du maître d'ouvrage) ou une modification (paramètres propres au registre) est proposée puis approuvée par
 * une AUTRE personne ; tout est journalisé.
 */
import { useMemo, useState } from 'react';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { useApp } from '../../context';
import { ActionError, hasRole, Kpi, useAction } from './shared';
import { SeuilsVisuels } from './visuels';
import './integrite.css';

export interface ThresholdEntry {
  id: string; label: string; category: string; value: number | boolean; defaultValue: number | boolean; unit: string; owner: 'CODE' | 'REGISTRE';
  source: { file: string; constant: string; exported: boolean }; description?: string; min?: number; max?: number;
  status: 'PAR_DEFAUT' | 'MODIFIE_A_CONFIRMER' | 'CONFIRME'; statusLabel: string; drift?: string; pendingRequest: string | null;
  confirmation?: { acte: string; proposedBy: string; approvedBy: string; at: string };
}
export interface ThresholdRequest {
  id: string; parameterId: string; kind: 'CONFIRMATION' | 'MODIFICATION'; currentValue: number | boolean; proposedValue: number | boolean;
  acte?: string; motif: string; status: 'PROPOSEE' | 'APPROUVEE' | 'REJETEE'; proposedBy: string; proposedAt: string; decision?: { by: string; at: string; motif: string };
}
export interface ThresholdRegister {
  entries: ThresholdEntry[];
  summary: { total: number; parDefaut: number; confirmes: number; modifiesAConfirmer: number };
  requests: ThresholdRequest[];
  note: string;
}

const READ = ['R22', 'R23', 'R24', 'R28', 'R06', 'R05', 'R01', 'R02', 'R26', 'R27'];
const PROPOSE = ['R24', 'R28', 'R06'];
const APPROVE = ['R06', 'R05', 'R28'];

const fmt = (v: number | boolean, unit: string) => (typeof v === 'boolean' ? (v ? 'Oui' : 'Non') : `${v.toLocaleString('fr-FR')} ${unit}`);

export function StatusOf({ e }: { e: Pick<ThresholdEntry, 'status' | 'statusLabel'> }) {
  const tone = e.status === 'CONFIRME' ? 'good' : e.status === 'MODIFIE_A_CONFIRMER' ? 'info' : 'warning';
  return <StatusBadge tone={tone} label={e.statusLabel} />;
}

export function RegisterTable({ entries, onPick }: { entries: ThresholdEntry[]; onPick?: (e: ThresholdEntry) => void }) {
  return (
    <DataTable rows={entries} rowKey={(e) => e.id} caption="Paramètres anti-fraude" empty={<EmptyState title="Aucun paramètre" />}
      columns={[
        { key: 'l', label: 'Paramètre', primary: true, render: (e) => <><span className="row-title">{e.label}</span><span className="account-code">{e.id}</span></> },
        { key: 'v', label: 'Valeur', num: true, render: (e) => <>{fmt(e.value, e.unit)}{e.value !== e.defaultValue && <span className="small muted"> (défaut {fmt(e.defaultValue, e.unit)})</span>}</> },
        { key: 's', label: 'Statut', render: (e) => <span className="ig-inline"><StatusOf e={e} />{e.drift && <span className="ig-late">{e.drift}</span>}</span> },
        { key: 'f', label: 'Source', full: true, render: (e) => <span className="small mono">{e.source.file} · {e.source.constant}{e.source.exported ? '' : ' (recopiée, vérifiée par test)'}</span> },
        ...(onPick ? [{ key: 'a', label: 'Action', render: (e: ThresholdEntry) => (e.pendingRequest ? <span className="small muted">Demande {e.pendingRequest} en attente</span>
          : <button type="button" className="btn btn-ghost btn-sm" onClick={() => onPick(e)}>{e.owner === 'REGISTRE' ? 'Confirmer / modifier' : 'Confirmer'}</button>) }] : []),
      ]} />
  );
}

export default function RegistreSeuils() {
  const { user, fmtDate } = useApp();
  const allowed = hasRole(user?.roles, ...READ);
  const canPropose = hasRole(user?.roles, ...PROPOSE);
  const canApprove = hasRole(user?.roles, ...APPROVE);
  const reg = useApi(allowed ? () => api<ThresholdRegister>('/v1/integrite/thresholds') : null, [user?.id]);
  const [category, setCategory] = useState('');
  const [pick, setPick] = useState<ThresholdEntry | null>(null);
  const [form, setForm] = useState({ kind: 'CONFIRMATION' as 'CONFIRMATION' | 'MODIFICATION', value: '', acte: '', motif: '' });
  const [motifs, setMotifs] = useState<Record<string, string>>({});
  const a = useAction();
  const categories = useMemo(() => [...new Set((reg.data?.entries ?? []).map((e) => e.category))], [reg.data]);
  const rows = (reg.data?.entries ?? []).filter((e) => !category || e.category === category);
  const pending = (reg.data?.requests ?? []).filter((r) => r.status === 'PROPOSEE');

  if (!allowed) {
    return <div className="page"><PageHead eyebrow="Intégrité" title="Registre des seuils anti-fraude" /><EmptyState title="Accès réservé" icon="lock">Réservé à l’audit, à l’anti-fraude, à la sécurité, à la direction et à l’exploitation.</EmptyState></div>;
  }
  const submit = async () => {
    if (!pick) return;
    const proposedValue = typeof pick.defaultValue === 'boolean' ? form.value === 'true' : Number(form.value);
    const body = { parameterId: pick.id, kind: form.kind, motif: form.motif, ...(form.acte.trim() ? { acte: form.acte.trim() } : {}), ...(form.kind === 'MODIFICATION' ? { proposedValue } : {}) };
    if (await a.run(() => api('/v1/integrite/thresholds/change-requests', { method: 'POST', body }))) { setPick(null); reg.reload(); }
  };
  const decide = async (r: ThresholdRequest, approve: boolean) => {
    if (await a.run(() => api(`/v1/integrite/thresholds/change-requests/${r.id}/decision`, { method: 'POST', body: { approve, motif: motifs[r.id] ?? '' } }))) reg.reload();
  };

  return (
    <div className="page page-wide ig-page">
      <PageHead eyebrow="Intégrité" title="Registre des seuils anti-fraude"
        lead="Chaque seuil qui conditionne un contrôle, avec sa source dans le code. Tant qu’aucun acte n’est enregistré, la valeur reste une valeur par défaut à confirmer par le maître d’ouvrage." />
      <ActionError error={a.error} />
      {reg.loading && <Loading />}
      {reg.error !== null && <ErrorState error={reg.error} onRetry={reg.reload} />}
      {reg.data && (
        <>
          <div className="kpi-row ig-kpis">
            <Kpi label="Paramètres" value={reg.data.summary.total} />
            <Kpi label="Par défaut, à confirmer" value={reg.data.summary.parDefaut} />
            <Kpi label="Confirmés par acte" value={reg.data.summary.confirmes} />
            <Kpi label="Demandes en attente" value={pending.length} />
          </div>
          <p className="callout callout-info ig-note"><Icon name="info" size={18} /><span>{reg.data.note}</span></p>
          <SeuilsVisuels reg={reg.data} />

          {pending.length > 0 && (
            <section className="panel" aria-labelledby="rs-pending">
              <h2 className="panel-title" id="rs-pending">Demandes à décider</h2>
              <ul className="plain-list ig-stack">
                {pending.map((r) => (
                  <li key={r.id} className="ig-block">
                    <p><strong>{r.id}</strong> · {r.kind === 'CONFIRMATION' ? 'Confirmation' : 'Modification'} de <span className="mono small">{r.parameterId}</span> : {String(r.currentValue)} → {String(r.proposedValue)}{r.acte ? ` · acte ${r.acte}` : ''}</p>
                    <p className="small muted">Proposée par {r.proposedBy} le {fmtDate(r.proposedAt, true)} — {r.motif}</p>
                    {canApprove && r.proposedBy !== user?.id ? (
                      <div className="ig-review-act">
                        <input aria-label={`Motif de décision ${r.id}`} className="input-sm" placeholder="Motif (10 caractères minimum)" value={motifs[r.id] ?? ''} onChange={(e) => setMotifs({ ...motifs, [r.id]: e.target.value })} />
                        <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy || (motifs[r.id] ?? '').trim().length < 10} onClick={() => void decide(r, true)}>Approuver</button>
                        <button type="button" className="btn btn-ghost btn-sm ig-danger" disabled={a.busy || (motifs[r.id] ?? '').trim().length < 10} onClick={() => void decide(r, false)}>Rejeter</button>
                      </div>
                    ) : <p className="small muted">{r.proposedBy === user?.id ? 'Décision par une autre personne habilitée.' : 'En attente de la direction ou de la sécurité.'}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {pick && (
            <section className="panel" aria-labelledby="rs-form">
              <h2 className="panel-title" id="rs-form">{pick.label}</h2>
              <p className="small muted">Valeur en vigueur : {fmt(pick.value, pick.unit)} · {pick.statusLabel}</p>
              <div className="seg seg-sm" role="group" aria-label="Nature de la demande">
                <button type="button" aria-pressed={form.kind === 'CONFIRMATION'} onClick={() => setForm({ ...form, kind: 'CONFIRMATION' })}>Confirmer par acte</button>
                {pick.owner === 'REGISTRE' && <button type="button" aria-pressed={form.kind === 'MODIFICATION'} onClick={() => setForm({ ...form, kind: 'MODIFICATION' })}>Modifier la valeur</button>}
              </div>
              {form.kind === 'MODIFICATION' && (typeof pick.defaultValue === 'boolean' ? (
                <label className="field"><span>Nouvelle valeur</span>
                  <select value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })}><option value="">—</option><option value="true">Oui</option><option value="false">Non</option></select>
                </label>
              ) : (
                <label className="field"><span>Nouvelle valeur ({pick.unit}{pick.min !== undefined ? `, ${pick.min} à ${pick.max}` : ''})</span>
                  <input type="number" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
                </label>
              ))}
              <label className="field"><span>Acte du maître d’ouvrage {form.kind === 'CONFIRMATION' ? '(obligatoire)' : '(facultatif)'}</span>
                <input value={form.acte} onChange={(e) => setForm({ ...form, acte: e.target.value })} placeholder="Référence et date de l’acte" />
              </label>
              <label className="field"><span>Motif</span>
                <textarea value={form.motif} onChange={(e) => setForm({ ...form, motif: e.target.value })} rows={3} />
              </label>
              <div className="input-row">
                <button type="button" className="btn btn-primary" disabled={a.busy || form.motif.trim().length < 10 || (form.kind === 'CONFIRMATION' && form.acte.trim().length < 3)} onClick={() => void submit()}>Proposer</button>
                <button type="button" className="btn btn-ghost" onClick={() => setPick(null)}>Annuler</button>
              </div>
              <p className="hint">La demande sera décidée par une autre personne habilitée ; la valeur d’une constante du code ne change que par une livraison logicielle.</p>
            </section>
          )}

          <div className="seg seg-sm seg-wrap" role="group" aria-label="Catégorie">
            <button type="button" aria-pressed={category === ''} onClick={() => setCategory('')}>Toutes</button>
            {categories.map((c) => <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(c)}>{c}</button>)}
          </div>
          <RegisterTable entries={rows} {...(canPropose ? { onPick: (e: ThresholdEntry) => { setPick(e); setForm({ kind: 'CONFIRMATION', value: '', acte: '', motif: '' }); } } : {})} />
        </>
      )}
    </div>
  );
}
