/**
 * Rapprochement proposé et crédits groupés (§ 20.1) : sous la correspondance exacte (seule automatique), le système
 * note les candidats (facteurs visibles) ; une personne propose, une autre confirme. Crédit groupé : fichier de détail
 * du prestataire rattaché au crédit orphelin, apparié seulement si tout est exact.
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { PageHead } from '../../components/Shell';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { sha256Hex } from '../../lib/crypto';
import { useApp } from '../../context';
import { hasRole, Message, TYPE_LABEL, useAction } from './shared';
import './tresor.css';

interface Factor { code: string; points: number; max: number; detail: string }
interface Candidate { exceptionId: string; paymentReference: string; orderAmount: MoneyJSON; lineAmount: MoneyJSON; score: number; factors: Factor[]; proposable: boolean; fx?: { rate: string; gap: MoneyJSON; gapPct: string } }
interface Item { exceptionId: string; type: string; statementId: string | null; line: { accountAlias: string; amount: MoneyJSON; valueDate: string; paymentReference: string }; detail: string; candidates: Candidate[] }
interface Proposal { id: string; exceptionId: string; paymentReference: string; score: number; motif: string; status: 'PROPOSEE' | 'CONFIRMEE' | 'REJETEE'; proposedBy: string; proposedAt: string; decidedBy?: string; decisionMotif?: string; result?: { receiptNumber: string; ecartChange?: MoneyJSON } }
export interface MatchingBoard { policy: { threshold: number; fxTolerancePct: number; statut: string; note: string }; items: Item[]; proposals: Proposal[] }

const m = (x: MoneyJSON) => `${x.amount} ${x.currency}`;
const TONE = { PROPOSEE: 'warning', CONFIRMEE: 'good', REJETEE: 'neutral' } as const;

export function AppariementsView({ board, canPropose, canDecide, onChanged }: { board: MatchingBoard; canPropose: boolean; canDecide: boolean; onChanged: () => void }) {
  const { busy, msg, run } = useAction();
  const [motif, setMotif] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<Record<string, string>>({});
  async function attach(exceptionId: string) {
    const text = (detail[exceptionId] ?? '').trim();
    const details = text.split('\n').map((l) => l.split(/[;,\t]/).map((s) => s.trim())).filter((p) => p.length >= 3 && p[0])
      .map(([paymentReference, amount, currency]) => ({ paymentReference: paymentReference!, amount: { amount: amount!, currency: currency! } }));
    await run(`/v1/tresor/exceptions/${exceptionId}/detail-prestataire`, { details, detailFileSha256: await sha256Hex(text) }, 'Crédit groupé apparié : exception résolue.', onChanged);
  }
  return (
    <>
      <p className="callout callout-info">{board.policy.note} Seuil de proposition : {board.policy.threshold}/100 ; tolérance de change : {board.policy.fxTolerancePct} % ({board.policy.statut}).</p>
      <Message msg={msg} />
      <section className="panel" aria-labelledby="app-items">
        <h2 className="panel-title" id="app-items">Crédits en exception et candidats</h2>
        {board.items.length === 0 ? <EmptyState title="Aucun crédit en attente d’appariement" icon="check" /> : (
          <ul className="list-rows">
            {board.items.map((it) => (
              <li key={it.exceptionId} className="list-row list-row-stack">
                <p className="row-title">{TYPE_LABEL[it.type] ?? it.type} <span className="mono small muted">{it.exceptionId}</span></p>
                <p className="small">{m(it.line.amount)} sur {it.line.accountAlias} · valeur {it.line.valueDate} · référence lue <span className="mono">{it.line.paymentReference}</span></p>
                {it.candidates.length === 0 ? <p className="small muted">Aucun candidat : l’exception reste dans sa file.</p> : it.candidates.map((c) => (
                  <div key={c.paymentReference} className="tr-candidate">
                    <p className="small"><strong className="mono">{c.paymentReference}</strong> — score {c.score}/100 {c.proposable ? <StatusBadge tone="info" label="Proposable" /> : <StatusBadge tone="neutral" label="Sous le seuil" />}</p>
                    <ul className="plain-list small muted">{c.factors.map((f) => <li key={f.code}>{f.points}/{f.max} — {f.detail}</li>)}</ul>
                    {c.fx && <p className="small">Écart de change enregistré : {m(c.fx.gap)} ({c.fx.gapPct} %).</p>}
                    {canPropose && c.proposable && (
                      <div className="row-between">
                        <input aria-label={`Motif de la proposition ${c.paymentReference}`} placeholder="Motif (10 caractères au moins)" value={motif[`${it.exceptionId}|${c.paymentReference}`] ?? ''}
                          onChange={(e) => setMotif({ ...motif, [`${it.exceptionId}|${c.paymentReference}`]: e.target.value })} />
                        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || (motif[`${it.exceptionId}|${c.paymentReference}`] ?? '').trim().length < 10}
                          onClick={() => void run('/v1/tresor/appariements/propositions', { exceptionId: it.exceptionId, paymentReference: c.paymentReference, motif: motif[`${it.exceptionId}|${c.paymentReference}`] }, 'Appariement proposé : confirmation par une autre personne.', onChanged)}>Proposer l’appariement</button>
                      </div>
                    )}
                  </div>
                ))}
                {canPropose && (it.type === 'ORPHAN_CREDIT' || it.type === 'CREDIT_GROUPE_ECART') && (
                  <details className="tech">
                    <summary className="small">Crédit groupé : rattacher le fichier de détail du prestataire</summary>
                    <textarea rows={3} aria-label="Fichier de détail (référence;montant;devise par ligne)" placeholder="PR-XXXX-XXXX;150.00;USD" value={detail[it.exceptionId] ?? ''} onChange={(e) => setDetail({ ...detail, [it.exceptionId]: e.target.value })} />
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void attach(it.exceptionId)}>Découper et apparier (exact seulement)</button>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel" aria-labelledby="app-props">
        <h2 className="panel-title" id="app-props">Propositions d’appariement</h2>
        {board.proposals.length === 0 ? <EmptyState title="Aucune proposition" icon="check" /> : (
          <ul className="list-rows">
            {board.proposals.map((p) => (
              <li key={p.id} className="list-row list-row-stack">
                <div className="row-between"><span className="row-title">{p.id} → <span className="mono">{p.paymentReference}</span> (score {p.score})</span><StatusBadge tone={TONE[p.status]} label={p.status === 'PROPOSEE' ? 'À confirmer' : p.status === 'CONFIRMEE' ? 'Confirmée' : 'Rejetée'} /></div>
                <p className="small">{p.motif} — proposé par {p.proposedBy}{p.decidedBy ? `, décidé par ${p.decidedBy}` : ''}{p.result?.receiptNumber ? ` · quittance ${p.result.receiptNumber} définitive` : ''}</p>
                {canDecide && p.status === 'PROPOSEE' && (
                  <div className="row-between">
                    <input aria-label={`Motif de la décision ${p.id}`} placeholder="Motif de la décision" value={motif[p.id] ?? ''} onChange={(e) => setMotif({ ...motif, [p.id]: e.target.value })} />
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy || (motif[p.id] ?? '').trim().length < 10} onClick={() => void run(`/v1/tresor/appariements/propositions/${p.id}/decision`, { approve: true, motif: motif[p.id] }, 'Appariement confirmé : écriture passée, quittance définitive.', onChanged)}>Confirmer</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy || (motif[p.id] ?? '').trim().length < 10} onClick={() => void run(`/v1/tresor/appariements/propositions/${p.id}/decision`, { approve: false, motif: motif[p.id] }, 'Proposition rejetée.', onChanged)}>Rejeter</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export default function Appariements() {
  const { user } = useApp();
  const allowed = hasRole(user?.roles, 'R17', 'R18', 'R22', 'R23');
  const b = useApi(allowed ? () => api<MatchingBoard>('/v1/tresor/appariements') : null, [user?.id]);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Trésor" title="Rapprochement proposé et crédits groupés" lead="Automatique seulement sur correspondance exacte ; au-delà du seuil, une personne propose et une autre confirme. Crédits groupés découpés par le fichier de détail du prestataire." />
      {!allowed ? <EmptyState title="Accès réservé" icon="lock">Réservé au Trésor, au rapprochement et à l’audit.</EmptyState> : (
        <>
          {b.loading && <Loading />}
          {b.error !== null && <ErrorState error={b.error} onRetry={b.reload} />}
          {b.data && <AppariementsView board={b.data} canPropose={hasRole(user?.roles, 'R17', 'R18')} canDecide={hasRole(user?.roles, 'R17')} onChanged={b.reload} />}
        </>
      )}
    </div>
  );
}
