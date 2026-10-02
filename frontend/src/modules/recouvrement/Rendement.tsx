/**
 * Rendement du recouvrement (§ 21.1, § 21.2) : récupération brute et nette des coûts (non mesurée sans coût saisi),
 * file priorisée par rendement net estimé (observé), coûts des campagnes, garanties des grands débiteurs (proposition
 * R20, décision R21). Mesure seulement : aucune action automatique.
 */
import { useState, type FormEvent } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { EmpreinteFichier, montants } from '../../components/EmpreinteFichier';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { useApp } from '../../context';
import { hasRole, Message, useAction } from '../tresor/shared';
import { RendementVisuel } from './visuels';
import './recouvrement.css';

type Totals = Record<string, string>;
interface Summary { status: 'MESURE' | 'NON_MESURE'; detail: string; gross: Totals; reconciled: Totals; cost: Totals; net: Totals | 'NON_MESURE'; costedCases: number; cases: number; campaigns: { campaignId: string; cost: Totals }[] }
interface CaseYield { caseId: string; obligationId: string; status: string; gross: Totals; cost: Totals; net: Totals | 'NON_MESURE' }
interface Guarantee { id: string; caseId: string; nature: string; amount: MoneyJSON; description: string; status: 'PROPOSEE' | 'VALIDEE' | 'REJETEE' | 'LEVEE'; proposedBy: string; decidedBy?: string }
interface LargeDebtor { caseId: string; label: string; amount: MoneyJSON; guarantees: number; covered: Totals; pending: number }
export interface YieldBoard { summary: Summary; cases: CaseYield[]; costs: { id: string; caseId?: string; campaignId?: string; kind: string; amount: MoneyJSON; recordedBy: string }[]; largeDebtors: LargeDebtor[]; guarantees: Guarantee[]; costKinds: string[]; guaranteeNatures: string[] }
interface Priority { rank: number; obligationId: string; label: string; commune: string | null; segment: { label: string }; outstanding: MoneyJSON; observedRecoveryRate: string; observedCostPerCase: MoneyJSON | string; expectedNetYield: MoneyJSON | string }
export interface Priorities { items: Priority[]; method: string }

const val = (v: MoneyJSON | string) => (typeof v === 'string' ? (v === 'NON_MESURE' ? 'Non mesuré' : v) : `${v.amount} ${v.currency}`);

function CostForm({ kinds, onDone }: { kinds: string[]; onDone: () => void }) {
  const { busy, msg, run } = useAction();
  const [target, setTarget] = useState('');
  const [isCampaign, setIsCampaign] = useState(false);
  const [kind, setKind] = useState(kinds[0] ?? 'SMS');
  const [quantity, setQuantity] = useState('1');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [sha, setSha] = useState('');
  const [note, setNote] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    void run('/v1/recouvrement/couts', { ...(isCampaign ? { campaignId: target } : { caseId: target }), kind, quantity: Number(quantity), amount: { amount, currency }, evidenceSha256: sha, note }, 'Coût enregistré.', onDone);
  }
  return (
    <form className="form" onSubmit={submit}>
      <div className="seg seg-sm" role="group" aria-label="Rattachement">
        <button type="button" aria-pressed={!isCampaign} onClick={() => setIsCampaign(false)}>Dossier</button>
        <button type="button" aria-pressed={isCampaign} onClick={() => setIsCampaign(true)}>Campagne</button>
      </div>
      <div className="field"><label className="label" htmlFor="rc-t">{isCampaign ? 'Identifiant de campagne' : 'Dossier de recouvrement'}</label><input id="rc-t" className="mono" value={target} onChange={(e) => setTarget(e.target.value)} required /></div>
      <div className="field"><label className="label" htmlFor="rc-k">Action</label><select id="rc-k" value={kind} onChange={(e) => setKind(e.target.value)}>{kinds.map((k) => <option key={k}>{k}</option>)}</select></div>
      <div className="field"><label className="label" htmlFor="rc-q">Quantité</label><input id="rc-q" type="number" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} /></div>
      <div className="field"><label className="label" htmlFor="rc-a">Coût réel (pièce à l’appui)</label><input id="rc-a" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        <select aria-label="Devise" value={currency} onChange={(e) => setCurrency(e.target.value)}><option>USD</option><option>CDF</option></select></div>
      <EmpreinteFichier label="Pièce justificative (facture, note de frais)" value={sha} onChange={setSha} />
      <div className="field"><label className="label" htmlFor="rc-n">Note</label><input id="rc-n" value={note} onChange={(e) => setNote(e.target.value)} required minLength={5} /></div>
      <button type="submit" className="btn btn-primary" disabled={busy || !sha}>Enregistrer le coût</button>
      <Message msg={msg} />
    </form>
  );
}

export function RendementView({ board, priorities, roles, onChanged }: { board: YieldBoard; priorities: Priorities | null; roles: string[]; onChanged: () => void }) {
  const { busy, msg, run } = useAction();
  const [motif, setMotif] = useState<Record<string, string>>({});
  const [g, setG] = useState<{ caseId: string; nature: string; amount: string; currency: string; description: string; sha: string }>({ caseId: '', nature: board.guaranteeNatures[0] ?? 'AUTRE', amount: '', currency: 'USD', description: '', sha: '' });
  const s = board.summary;
  return (
    <>
      <div className="kpi-row">
        <div className="kpi"><p className="kpi-label caps-sm">Récupération brute</p><p className="kpi-value">{montants(s.gross)}</p></div>
        <div className="kpi"><p className="kpi-label caps-sm">Coûts saisis</p><p className="kpi-value">{montants(s.cost)}</p></div>
        <div className="kpi"><p className="kpi-label caps-sm">Récupération nette</p><p className="kpi-value">{montants(s.net)}</p></div>
        <div className="kpi"><p className="kpi-label caps-sm">Dossiers chiffrés</p><p className="kpi-value">{s.costedCases} / {s.cases}</p></div>
      </div>
      <p className="callout callout-info">{s.detail}</p>
      <RendementVisuel summary={s} guarantees={board.guarantees} priorities={priorities?.items ?? []} />
      <Message msg={msg} />
      {priorities && (
        <section className="panel" aria-labelledby="rd-prio"><h2 className="panel-title" id="rd-prio">File priorisée par rendement net estimé</h2>
          <p className="hint">{priorities.method}</p>
          <DataTable rows={priorities.items} rowKey={(p) => p.obligationId} caption="File priorisée"
            columns={[
              { key: 'r', label: 'Rang', num: true, render: (p) => p.rank },
              { key: 'o', label: 'Obligation', primary: true, render: (p) => <><span className="row-title">{p.label}</span><span className="account-code">{p.segment.label} · {p.commune ?? '—'}</span></> },
              { key: 'd', label: 'Restant dû', num: true, render: (p) => val(p.outstanding) },
              { key: 't', label: 'Taux observé', num: true, render: (p) => (p.observedRecoveryRate === 'NON_MESURE' ? 'Non mesuré' : p.observedRecoveryRate) },
              { key: 'n', label: 'Rendement net estimé', num: true, render: (p) => val(p.expectedNetYield) },
            ]} />
        </section>
      )}
      <section className="panel" aria-labelledby="rd-cases"><h2 className="panel-title" id="rd-cases">Dossiers : brut, coûts, net</h2>
        <DataTable rows={board.cases} rowKey={(c) => c.caseId} caption="Rendement par dossier" empty={<EmptyState title="Aucun dossier" icon="check" />}
          columns={[
            { key: 'c', label: 'Dossier', primary: true, render: (c) => <span className="mono">{c.caseId}</span> },
            { key: 'g', label: 'Brut', num: true, render: (c) => montants(c.gross) },
            { key: 'k', label: 'Coûts', num: true, render: (c) => montants(c.cost) },
            { key: 'n', label: 'Net', num: true, render: (c) => montants(c.net) },
          ]} />
      </section>
      <section className="panel" aria-labelledby="rd-gar"><h2 className="panel-title" id="rd-gar">Grands débiteurs : garanties et supervision</h2>
        {board.largeDebtors.length === 0 ? <EmptyState title="Aucun grand débiteur en dossier ouvert" icon="check" /> : (
          <ul className="list-rows">{board.largeDebtors.map((d) => <li key={d.caseId} className="list-row"><span className="row-title">{d.label} <span className="mono small">{d.caseId}</span></span><span className="small">{d.amount.amount} {d.amount.currency} · garanties {d.guarantees} ({montants(d.covered)}) · en attente {d.pending}</span></li>)}</ul>
        )}
        <ul className="list-rows">{board.guarantees.map((x) => (
          <li key={x.id} className="list-row list-row-stack">
            <div className="row-between"><span className="row-title">{x.id} — {x.nature} {x.amount.amount} {x.amount.currency}</span><StatusBadge tone={x.status === 'VALIDEE' ? 'good' : x.status === 'PROPOSEE' ? 'warning' : 'neutral'} label={x.status} /></div>
            <p className="small">{x.description} — proposé par {x.proposedBy}{x.decidedBy ? `, décidé par ${x.decidedBy}` : ''}</p>
            {hasRole(roles, 'R21') && (x.status === 'PROPOSEE' || x.status === 'VALIDEE') && (
              <div className="row-between">
                <input aria-label={`Motivation ${x.id}`} value={motif[x.id] ?? ''} onChange={(e) => setMotif({ ...motif, [x.id]: e.target.value })} placeholder="Motivation" />
                {x.status === 'PROPOSEE' ? <>
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy || (motif[x.id] ?? '').length < 10} onClick={() => void run(`/v1/recouvrement/garanties/${x.id}/decision`, { decision: 'VALIDEE', motivation: motif[x.id] }, 'Garantie validée.', onChanged)}>Valider</button>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy || (motif[x.id] ?? '').length < 10} onClick={() => void run(`/v1/recouvrement/garanties/${x.id}/decision`, { decision: 'REJETEE', motivation: motif[x.id] }, 'Garantie rejetée.', onChanged)}>Rejeter</button>
                </> : <button type="button" className="btn btn-ghost btn-sm" disabled={busy || (motif[x.id] ?? '').length < 10} onClick={() => void run(`/v1/recouvrement/garanties/${x.id}/mainlevee`, { motivation: motif[x.id] }, 'Mainlevée enregistrée.', onChanged)}>Mainlevée</button>}
              </div>
            )}
          </li>))}
        </ul>
        {hasRole(roles, 'R20') && (
          <form className="form" onSubmit={(e) => { e.preventDefault(); void run('/v1/recouvrement/garanties', { caseId: g.caseId, nature: g.nature, amount: { amount: g.amount, currency: g.currency }, description: g.description, evidenceSha256: g.sha }, 'Garantie proposée : décision par l’autorité compétente.', onChanged); }}>
            <div className="field"><label className="label" htmlFor="rg-c">Dossier du grand débiteur</label>
              <select id="rg-c" value={g.caseId} onChange={(e) => setG({ ...g, caseId: e.target.value })}><option value="">—</option>{board.largeDebtors.map((d) => <option key={d.caseId} value={d.caseId}>{d.label}</option>)}</select></div>
            <div className="field"><label className="label" htmlFor="rg-n">Nature</label><select id="rg-n" value={g.nature} onChange={(e) => setG({ ...g, nature: e.target.value })}>{board.guaranteeNatures.map((n) => <option key={n}>{n}</option>)}</select></div>
            <div className="field"><label className="label" htmlFor="rg-a">Montant garanti</label><input id="rg-a" value={g.amount} onChange={(e) => setG({ ...g, amount: e.target.value })} required />
              <select aria-label="Devise" value={g.currency} onChange={(e) => setG({ ...g, currency: e.target.value })}><option>USD</option><option>CDF</option></select></div>
            <div className="field"><label className="label" htmlFor="rg-d">Description</label><input id="rg-d" value={g.description} onChange={(e) => setG({ ...g, description: e.target.value })} required minLength={5} /></div>
            <EmpreinteFichier label="Pièce de la garantie" value={g.sha} onChange={(sha) => setG({ ...g, sha })} />
            <button type="submit" className="btn btn-secondary" disabled={busy || !g.caseId || !g.sha}>Proposer la garantie</button>
          </form>
        )}
      </section>
      {hasRole(roles, 'R06', 'R07', 'R20') && <section className="panel" aria-labelledby="rd-cost"><h2 className="panel-title" id="rd-cost">Saisir un coût de recouvrement</h2><CostForm kinds={board.costKinds} onDone={onChanged} /></section>}
    </>
  );
}

export default function Rendement() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const allowed = hasRole(roles, 'R06', 'R07', 'R11', 'R17', 'R20', 'R21', 'R22', 'R23');
  const b = useApi(allowed ? () => api<YieldBoard>('/v1/recouvrement/rendement') : null, [user?.id]);
  const p = useApi(allowed ? () => api<Priorities>('/v1/recouvrement/priorites') : null, [user?.id]);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Recouvrement" title="Rendement du recouvrement" lead="Récupération brute et nette des coûts, priorisation par rendement net, campagnes mesurées, garanties des grands débiteurs. Le système mesure ; une personne décide." />
      {!allowed ? <EmptyState title="Accès réservé" icon="lock">Réservé au recouvrement, à la régie et à l’audit.</EmptyState> : (
        <>
          {b.loading && <Loading />}
          {b.error !== null && <ErrorState error={b.error} onRetry={b.reload} />}
          {b.data && <RendementView board={b.data} priorities={p.data} roles={roles} onChanged={() => { b.reload(); p.reload(); }} />}
        </>
      )}
    </div>
  );
}
