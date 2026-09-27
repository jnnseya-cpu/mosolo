import { useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { DataTable } from '../../components/DataTable';
import { Drawer } from '../../components/Drawer';
import { MoneyText } from '../../components/MoneyText';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import { sha256Hex } from '../../lib/crypto';
import { EXC_STATUS, hasRole, Message, QUEUE_LABEL, TYPE_LABEL, useAction, type ExceptionList, type Queue, type TreasuryException } from './shared';

/** Types d'exception qui portent de l'argent (clôture uniquement par une action financière). */
const MONEY_TYPES = ['ORPHAN_CREDIT', 'CREDIT_WITHOUT_CONFIRMATION', 'UNKNOWN_ACCOUNT', 'DUPLICATE_CREDIT', 'AMOUNT_MISMATCH', 'MISSING_SETTLEMENT', 'PROVIDER_AMBIGUOUS', 'UNAPPLIED_PAYMENT', 'WRONG_ACCOUNT', 'ACCOUNT_VERSION_MISMATCH', 'RECEIPT_NOT_FINALIZABLE'];

const HISTORY_LABEL: Record<string, string> = {
  AFFECTEE: 'Affectée', PRISE_EN_CHARGE: 'Prise en charge', JUSTIFICATIF: 'Justificatif ajouté',
  RESOLUTION_PROPOSEE: 'Résolution proposée', RESOLUTION_VALIDEE: 'Résolution validée', RESOLUTION_REJETEE: 'Résolution rejetée',
};

/** Empreinte SHA-256 d'une pièce choisie localement (la pièce ne quitte pas le poste dans la démonstration). */
async function sha256File(f: File): Promise<string> {
  return sha256Hex(await f.arrayBuffer());
}

function Detail({ ex, onChanged }: { ex: TreasuryException; onChanged: () => void }) {
  const { user, users, fmtDate } = useApp();
  const { busy, msg, run } = useAction();
  const [assignee, setAssignee] = useState(ex.assignee ?? '');
  const [evLabel, setEvLabel] = useState('');
  const [evHash, setEvHash] = useState<string | undefined>();
  const [outcome, setOutcome] = useState<'RESOLUE' | 'CLASSEE'>('RESOLUE');
  const [motif, setMotif] = useState('');
  // Exception portant de l'argent : jamais classée sans suite ; issue = suspens, rapprochement ou opération exécutée.
  const moneyEx = !!ex.line || MONEY_TYPES.includes(ex.type);
  const [action, setAction] = useState<'AUCUNE' | 'MISE_EN_SUSPENS' | 'RAPPROCHEMENT' | 'OPERATION'>(moneyEx ? (ex.line ? 'MISE_EN_SUSPENS' : 'OPERATION') : 'AUCUNE');
  const [operationId, setOperationId] = useState('');
  const [rejectMotif, setRejectMotif] = useState('');
  const roles = user?.roles;
  const me = user?.id;
  const closed = ex.status === 'RESOLUE' || ex.status === 'CLASSEE';
  const base = `/v1/tresor/exceptions/${encodeURIComponent(ex.id)}`;
  const eligible = users.filter((u) => u.roles.some((r) => r === 'R18' || r === 'R17'));
  const pending = ex.proposal && !ex.decision;

  function submitEvidence(e: FormEvent) {
    e.preventDefault();
    void run(`${base}/evidence`, { label: evLabel, ...(evHash ? { sha256: evHash } : {}) }, 'Justificatif enregistré.', () => { setEvLabel(''); setEvHash(undefined); onChanged(); });
  }
  function submitProposal(e: FormEvent) {
    e.preventDefault();
    void run(`${base}/resolution`, { outcome: moneyEx ? 'RESOLUE' : outcome, motif, action, ...(action === 'OPERATION' ? { operationId: operationId.trim() } : {}) }, 'Résolution proposée : elle attend la validation d’une autre personne.', onChanged);
  }

  return (
    <div className="tr-detail">
      <div className="row-between">
        <StatusBadge tone={EXC_STATUS[ex.status].tone} label={EXC_STATUS[ex.status].label} />
        {ex.overdue && <StatusBadge tone="critical" label="Délai de 48 h dépassé" />}
      </div>
      <dl className="kv kv-dense">
        <div><dt>File</dt><dd>{ex.queue ? QUEUE_LABEL[ex.queue] : '—'}</dd></div>
        <div><dt>Nature</dt><dd>{TYPE_LABEL[ex.type] ?? ex.type}</dd></div>
        <div><dt>Référence de paiement</dt><dd className="mono">{ex.paymentReference ?? '—'}</dd></div>
        {ex.line && <div><dt>Ligne de relevé</dt><dd><MoneyText money={ex.line.amount} showIndicative={false} /> · <span className="mono">{ex.line.accountAlias}</span> · {ex.line.valueDate}</dd></div>}
        <div><dt>Ouverte le</dt><dd>{fmtDate(ex.openedAt, true)}</dd></div>
        {ex.dueAt && <div><dt>Échéance de traitement</dt><dd>{fmtDate(ex.dueAt, true)}</dd></div>}
        <div><dt>Responsable</dt><dd>{ex.assigneeName ?? 'Non affectée'}</dd></div>
      </dl>
      <p className="small">{ex.detail}</p>

      {!closed && hasRole(roles, 'R17', 'R18') && (
        <div className="tr-step">
          <h3 className="h-sub">Affectation</h3>
          <div className="input-row">
            <label className="sr-only" htmlFor="tr-assignee">Analyste</label>
            <select id="tr-assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">Choisir un analyste…</option>
              {eligible.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !assignee || assignee === ex.assignee}
              onClick={() => void run(`${base}/assign`, { assignee }, 'Exception affectée.', onChanged)}>Affecter</button>
          </div>
        </div>
      )}

      {ex.status === 'OUVERTE' && ex.assignee === me && (
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void run(`${base}/start`, {}, 'Exception prise en charge.', onChanged)}>
          <Icon name="check" size={16} /> Prendre en charge
        </button>
      )}

      {ex.status === 'EN_COURS' && ex.assignee === me && !pending && (
        <>
          <form className="form tr-step" onSubmit={submitEvidence}>
            <h3 className="h-sub">Justificatif</h3>
            <div className="field"><label className="label" htmlFor="tr-ev">Intitulé de la pièce</label>
              <input id="tr-ev" value={evLabel} onChange={(e) => setEvLabel(e.target.value)} placeholder="Réponse écrite du prestataire du …" required minLength={3} /></div>
            <div className="field"><label className="label" htmlFor="tr-ev-file">Pièce (empreinte calculée sur ce poste)</label>
              <input id="tr-ev-file" type="file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void sha256File(f).then(setEvHash); }} />
              {evHash && <span className="small mono hash">SHA-256 {evHash}</span>}</div>
            <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || evLabel.trim().length < 3}>Ajouter le justificatif</button>
          </form>
          <form className="form tr-step" onSubmit={submitProposal}>
            <h3 className="h-sub">Proposer la clôture</h3>
            <div className="seg seg-sm" role="group" aria-label="Issue">
              <button type="button" aria-pressed={outcome === 'RESOLUE'} onClick={() => setOutcome('RESOLUE')}>Résolue</button>
              {!moneyEx && <button type="button" aria-pressed={outcome === 'CLASSEE'} onClick={() => setOutcome('CLASSEE')}>Classée</button>}
            </div>
            <div className="field"><label className="label" htmlFor="tr-motif">Motif (10 caractères au moins)</label>
              <textarea id="tr-motif" rows={3} value={motif} onChange={(e) => setMotif(e.target.value)} required minLength={10} /></div>
            <div className="field"><label className="label" htmlFor="tr-action">Action financière</label>
              <select id="tr-action" value={action} onChange={(e) => setAction(e.target.value as typeof action)}>
                {!moneyEx && <option value="AUCUNE">Aucune (exception sans argent)</option>}
                {ex.line && <option value="MISE_EN_SUSPENS">Porter le crédit en compte d’attente (suspens daté)</option>}
                <option value="RAPPROCHEMENT">Rapprochement avec un paiement ou une ligne de relevé</option>
                <option value="OPERATION">Opération exécutée (contrepassation, remboursement, apurement)</option>
              </select>
              {moneyEx && <span className="hint">Argent en jeu : l’exception ne peut pas être classée sans suite.</span>}</div>
            {action === 'OPERATION' && (
              <div className="field"><label className="label" htmlFor="tr-op">Opération exécutée (OPF-…)</label>
                <input id="tr-op" className="mono" value={operationId} onChange={(e) => setOperationId(e.target.value)} required minLength={3} /></div>
            )}
            {outcome === 'RESOLUE' && (ex.evidence?.length ?? 0) === 0 && <p className="small muted">Une résolution exige au moins un justificatif.</p>}
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || motif.trim().length < 10 || (action === 'OPERATION' && operationId.trim().length < 3)}>Soumettre à validation</button>
          </form>
        </>
      )}

      {pending && ex.proposal && (
        <div className="callout callout-info tr-step">
          <Icon name="users" size={18} />
          <div>
            <p><strong>{ex.proposal.outcome === 'RESOLUE' ? 'Résolution' : 'Classement'} proposé</strong> par {users.find((u) => u.id === ex.proposal!.proposedBy)?.name ?? ex.proposal.proposedBy} — {ex.proposal.motif}
              {ex.proposal.action === 'MISE_EN_SUSPENS' ? ' · mise en suspens' : ''}</p>
            {hasRole(roles, 'R17') && me !== ex.proposal.proposedBy ? (
              <div className="row-actions">
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void run(`${base}/resolution/approve`, {}, 'Résolution validée.', onChanged)}>Valider</button>
                <input aria-label="Motif du rejet" className="input-sm" value={rejectMotif} onChange={(e) => setRejectMotif(e.target.value)} placeholder="Motif du rejet" />
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy || rejectMotif.trim().length < 10}
                  onClick={() => void run(`${base}/resolution/reject`, { motif: rejectMotif }, 'Proposition rejetée ; l’exception reste en cours.', onChanged)}>Rejeter</button>
              </div>
            ) : <p className="small muted">Validation par un comptable public distinct de l’auteur (quatre yeux).</p>}
          </div>
        </div>
      )}

      <Message msg={msg} />

      {(ex.evidence?.length ?? 0) > 0 && (
        <>
          <h3 className="h-sub">Justificatifs</h3>
          <ul className="list-rows compact-rows">
            {ex.evidence!.map((e, i) => <li key={i} className="list-row list-row-stack"><span>{e.label}</span><span className="small muted">{fmtDate(e.addedAt, true)}{e.sha256 ? ` · SHA-256 ${e.sha256.slice(0, 16)}…` : ''}</span></li>)}
          </ul>
        </>
      )}
      {(ex.history?.length ?? 0) > 0 && (
        <>
          <h3 className="h-sub">Historique</h3>
          <ol className="timeline tr-history">
            {ex.history!.map((h, i) => <li key={i}><span className="small">{fmtDate(h.at, true)}</span> — <strong>{HISTORY_LABEL[h.action] ?? h.action}</strong> · {users.find((u) => u.id === h.by)?.name ?? h.by}{h.note ? ` · ${h.note}` : ''}</li>)}
          </ol>
        </>
      )}
    </div>
  );
}

export default function ExceptionQueues({ onChanged }: { onChanged?: () => void }) {
  const { user, fmtDate } = useApp();
  const [queue, setQueue] = useState<Queue | ''>('');
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const list = useApi(() => api<ExceptionList>('/v1/tresor/exceptions'), [user?.id]);
  const refresh = () => { list.reload(); onChanged?.(); };
  const items = (list.data?.items ?? []).filter((e) => (!queue || e.queue === queue) && (!onlyOpen || (e.status !== 'RESOLUE' && e.status !== 'CLASSEE')));
  const current = list.data?.items.find((e) => e.id === openId) ?? null;

  return (
    <section className="panel" aria-labelledby="trq-title">
      <header className="panel-head">
        <div><h2 className="panel-title" id="trq-title">Files d’exception</h2>
          <p className="panel-sub">Chaque exception a un responsable, un délai de {list.data?.slaHours ?? 48} h et une clôture validée par une autre personne.</p></div>
        <label className="check small"><input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /><span>À traiter seulement</span></label>
      </header>
      {list.loading && <Loading />}
      {list.error !== null && <ErrorState error={list.error} onRetry={list.reload} />}
      {list.data && (
        <>
          <div className="tr-queues" role="group" aria-label="Files">
            <button type="button" className="tr-queue" aria-pressed={queue === ''} onClick={() => setQueue('')}>
              <span className="tr-queue-name">Toutes les files</span>
              <span className="tr-queue-num">{list.data.queues.reduce((n, q) => n + q.open + q.inProgress, 0)}</span>
            </button>
            {list.data.queues.map((q) => (
              <button key={q.queue} type="button" className="tr-queue" aria-pressed={queue === q.queue} onClick={() => setQueue(q.queue)}>
                <span className="tr-queue-name">{QUEUE_LABEL[q.queue]}</span>
                <span className="tr-queue-num">{q.open + q.inProgress}</span>
                {q.overdue > 0 && <span className="tr-queue-late"><Icon name="clock" size={12} /> {q.overdue} en retard</span>}
              </button>
            ))}
          </div>
          <DataTable rows={items} rowKey={(e) => e.id} caption="Exceptions de rapprochement"
            empty={<EmptyState title="Aucune exception dans cette file." icon="check" />}
            columns={[
              { key: 'type', label: 'Nature', primary: true, render: (e) => <span><strong>{TYPE_LABEL[e.type] ?? e.type}</strong><span className="small muted tr-block mono">{e.paymentReference ?? e.id}</span></span> },
              { key: 'status', label: 'État', render: (e) => <span className="tr-badges"><StatusBadge tone={EXC_STATUS[e.status].tone} label={EXC_STATUS[e.status].label} />{e.overdue && <StatusBadge tone="critical" label="> 48 h" />}{e.proposal && !e.decision && <StatusBadge tone="info" label="À valider" />}</span> },
              { key: 'amount', label: 'Montant', num: true, render: (e) => (e.line ? <MoneyText money={e.line.amount} showIndicative={false} /> : '—') },
              { key: 'who', label: 'Responsable', render: (e) => e.assigneeName ?? <span className="muted">Non affectée</span> },
              { key: 'age', label: 'Ancienneté', render: (e) => <span title={fmtDate(e.openedAt, true)}>{e.ageHours !== undefined ? (e.ageHours < 48 ? `${e.ageHours} h` : `${Math.floor(e.ageHours / 24)} j`) : '—'}</span> },
              { key: 'act', label: 'Action', render: (e) => <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpenId(e.id)}>Ouvrir <Icon name="chevronRight" size={14} /></button> },
            ]} />
        </>
      )}
      <Drawer open={!!current} title={current ? `Exception ${current.id}` : ''} onClose={() => setOpenId(null)}>
        {current && <Detail key={current.id} ex={current} onChanged={refresh} />}
      </Drawer>
    </section>
  );
}
