import { useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { MoneyText } from '../../components/MoneyText';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import { hasRole, Message, OP_LABEL, OP_STATUS, useAction, type Operation, type OperationKind } from './shared';

const KIND_HELP: Record<Exclude<OperationKind, 'PARAMETRE_NOMENCLATURE'>, string> = {
  ANNULATION_QUITTANCE: 'Quittance provisoire ou signalée dont le paiement n’a pas abouti. Une quittance définitive ne s’annule pas.',
  REMPLACEMENT_QUITTANCE: 'Nouvelle quittance (nouveau numéro) reprenant les données faisant foi ; l’ancienne renvoie publiquement vers la nouvelle. Montant et paiement ne changent jamais.',
  CONTREPASSATION: 'Paiement inversé (prestataire, litige fondé) : contre-écriture liée à l’original, quittance « contrepassée », obligation de nouveau exigible.',
  REMBOURSEMENT: 'Après rapprochement ou sur doublon : montant payé exactement, vers l’instrument de paiement d’origine uniquement (aucun compte saisi).',
  CONTRE_ECRITURE: 'Correction d’une écriture du grand livre : jamais de modification, une écriture inverse liée et motivée.',
  APUREMENT_SUSPENS: 'Affectation d’un suspens à un paiement confirmé du même montant, ou restitution à l’émetteur d’origine.',
};

type Kind = keyof typeof KIND_HELP;

function ProposeForm({ onDone }: { onDone: () => void }) {
  const { user } = useApp();
  const { busy, msg, run } = useAction();
  const [kind, setKind] = useState<Kind>('CONTREPASSATION');
  const [target, setTarget] = useState('');
  const [payRef, setPayRef] = useState('');
  const [mode, setMode] = useState<'AFFECTATION' | 'RESTITUTION'>('AFFECTATION');
  const [reason, setReason] = useState('');
  const receiptKind = kind === 'ANNULATION_QUITTANCE' || kind === 'REMPLACEMENT_QUITTANCE';
  const canFinance = hasRole(user?.roles, 'R17', 'R18');
  const kinds = (Object.keys(KIND_HELP) as Kind[]).filter((k) => canFinance || k === 'ANNULATION_QUITTANCE' || k === 'REMPLACEMENT_QUITTANCE');

  function submit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = { kind, reason };
    if (receiptKind) body.receipt = target.trim();
    if (kind === 'CONTREPASSATION' || kind === 'REMBOURSEMENT') body.paymentReference = target.trim();
    if (kind === 'CONTRE_ECRITURE') body.ledgerEntryId = target.trim();
    if (kind === 'APUREMENT_SUSPENS') { body.suspenseId = target.trim(); body.mode = mode; if (mode === 'AFFECTATION') body.paymentReference = payRef.trim(); }
    void run('/v1/tresor/operations', body, 'Opération proposée : elle attend la validation d’une autre personne.', () => { setTarget(''); setPayRef(''); setReason(''); onDone(); });
  }
  const targetLabel = receiptKind ? 'Numéro ou code de quittance' : kind === 'CONTRE_ECRITURE' ? 'Écriture du grand livre (GL-…)' : kind === 'APUREMENT_SUSPENS' ? 'Suspens (SUSP-…)' : 'Référence de paiement';
  return (
    <form className="form" onSubmit={submit}>
      <div className="field"><label className="label" htmlFor="op-kind">Opération</label>
        <select id="op-kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          {kinds.map((k) => <option key={k} value={k}>{OP_LABEL[k]}</option>)}
        </select></div>
      <p className="small muted">{KIND_HELP[kind]}</p>
      <div className="field"><label className="label" htmlFor="op-target">{targetLabel}</label>
        <input id="op-target" className="mono" value={target} onChange={(e) => setTarget(e.target.value)} required minLength={3} /></div>
      {kind === 'APUREMENT_SUSPENS' && (
        <>
          <div className="seg seg-sm" role="group" aria-label="Mode d’apurement">
            <button type="button" aria-pressed={mode === 'AFFECTATION'} onClick={() => setMode('AFFECTATION')}>Affectation à un paiement</button>
            <button type="button" aria-pressed={mode === 'RESTITUTION'} onClick={() => setMode('RESTITUTION')}>Restitution à l’émetteur</button>
          </div>
          {mode === 'AFFECTATION' && <div className="field"><label className="label" htmlFor="op-pay">Référence du paiement confirmé</label>
            <input id="op-pay" className="mono" value={payRef} onChange={(e) => setPayRef(e.target.value)} required /></div>}
        </>
      )}
      <div className="field"><label className="label" htmlFor="op-reason">Motif détaillé (10 caractères au moins, tracé à l’audit)</label>
        <textarea id="op-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={10} /></div>
      <button type="submit" className="btn btn-primary" disabled={busy || reason.trim().length < 10 || target.trim().length < 3}>Proposer</button>
      <Message msg={msg} />
    </form>
  );
}

export default function OperationsPanel({ onChanged }: { onChanged?: () => void }) {
  const { user, users, fmtDate } = useApp();
  const [filter, setFilter] = useState<'PROPOSEE' | ''>('PROPOSEE');
  const ops = useApi(() => api<Operation[]>('/v1/tresor/operations'), [user?.id]);
  const { busy, msg, run } = useAction();
  const [note, setNote] = useState<Record<string, string>>({});
  const name = (id?: string) => users.find((u) => u.id === id)?.name ?? id ?? '—';
  const refresh = () => { ops.reload(); onChanged?.(); };
  const list = (ops.data ?? []).filter((o) => !filter || o.status === filter);
  const canApprove = hasRole(user?.roles, 'R17');
  const canPropose = hasRole(user?.roles, 'R17', 'R18', 'R20', 'R12');

  return (
    <section className="panel" aria-labelledby="op-title">
      <header className="panel-head">
        <div><h2 className="panel-title" id="op-title">Double validation</h2>
          <p className="panel-sub">Toute opération financière est proposée par une personne et exécutée seulement après validation par une autre.</p></div>
        <div className="seg seg-sm" role="group" aria-label="Filtre">
          <button type="button" aria-pressed={filter === 'PROPOSEE'} onClick={() => setFilter('PROPOSEE')}>À valider</button>
          <button type="button" aria-pressed={filter === ''} onClick={() => setFilter('')}>Historique</button>
        </div>
      </header>
      <div className="two-col">
        <div>
          {ops.loading && <Loading />}
          {ops.error !== null && <ErrorState error={ops.error} onRetry={ops.reload} />}
          {ops.data && (list.length === 0 ? <EmptyState title={filter ? 'Aucune opération en attente.' : 'Aucune opération.'} icon="check" /> : (
            <ul className="list-rows">
              {list.map((o) => (
                <li key={o.id} className="list-row list-row-stack">
                  <div className="row-between">
                    <span className="row-title">{OP_LABEL[o.kind]} <span className="mono small muted">{o.id}</span></span>
                    <StatusBadge tone={OP_STATUS[o.status].tone} label={OP_STATUS[o.status].label} />
                  </div>
                  <p className="small">{o.target.label}{o.target.amount && <> · <MoneyText money={o.target.amount} showIndicative={false} /></>}</p>
                  <p className="small muted">« {o.input.reason} » — proposé par {name(o.proposedBy)}, {fmtDate(o.proposedAt, true)}</p>
                  {o.decidedBy && <p className="small muted">{o.status === 'EXECUTEE' ? 'Validé' : 'Rejeté'} par {name(o.decidedBy)}, {fmtDate(o.decidedAt, true)}{o.decisionNote ? ` — ${o.decisionNote}` : ''}</p>}
                  {o.status === 'PROPOSEE' && canApprove && user?.id !== o.proposedBy && (
                    <div className="row-actions">
                      <input aria-label="Observation ou motif de rejet" className="input-sm" value={note[o.id] ?? ''} onChange={(e) => setNote((p) => ({ ...p, [o.id]: e.target.value }))} placeholder="Observation / motif de rejet" />
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy}
                        onClick={() => void run(`/v1/tresor/operations/${o.id}/approve`, note[o.id]?.trim() ? { note: note[o.id] } : {}, 'Opération validée et exécutée.', refresh)}>
                        <Icon name="check" size={16} /> Valider
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy || (note[o.id]?.trim().length ?? 0) < 10}
                        onClick={() => void run(`/v1/tresor/operations/${o.id}/reject`, { motif: note[o.id] }, 'Opération rejetée.', refresh)}>Rejeter</button>
                    </div>
                  )}
                  {o.status === 'PROPOSEE' && user?.id === o.proposedBy && <p className="small muted">Vous êtes l’auteur : la validation revient à une autre personne.</p>}
                </li>
              ))}
            </ul>
          ))}
          <Message msg={msg} />
        </div>
        {canPropose ? (
          <div><h3 className="h-sub">Proposer une opération</h3><ProposeForm onDone={refresh} /></div>
        ) : <p className="small muted">Votre rôle ne permet pas de proposer d’opération financière.</p>}
      </div>
    </section>
  );
}
