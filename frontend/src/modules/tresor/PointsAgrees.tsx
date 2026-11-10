/**
 * Points de paiement agréés — clauses contractuelles (§ 37) : contrat par point (acte requis tant qu'il n'est pas
 * enregistré et validé à quatre yeux), commission distincte des recettes, pénalités de retard calculées, proposées puis
 * décidées par une autre personne du Trésor. Aucun prélèvement automatique.
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
import { hasRole, Message, useAction } from './shared';
import { PointsAgreesVisuel } from './visuels';
import './tresor.css';

interface Contract { id: string; pointId: string; reference: string; sha256: string; status: string; proposedBy: string; terms: { commission: { basis: string; value: string; currency?: string }; penalty: { basis: string; value: string; currency?: string; capPct?: string } } }
interface PointRow { pointId: string; name: string; operator: string; commune: string; status: string; contractStatus: 'EN_VIGUEUR' | 'ACTE_REQUIS'; contract: Contract | null; pending: Contract | null }
interface Late { key: string; pointId: string; pointName: string; day: string; daysLate: number; status: 'CALCULEE' | 'ACTE_REQUIS'; amounts: MoneyJSON[]; computation: string; penaltyId: string | null; penaltyStatus: string | null }
interface Penalty { id: string; pointId: string; day: string; amounts: MoneyJSON[]; computation: string; status: 'PROPOSEE' | 'DECIDEE' | 'ECARTEE'; proposedBy: string; decidedBy?: string }
export interface PointsBoard { points: PointRow[]; late: Late[]; penalties: Penalty[]; notice: string }

function ContractForm({ points, onDone }: { points: PointRow[]; onDone: () => void }) {
  const { busy, msg, run } = useAction();
  const [pointId, setPointId] = useState(points[0]?.pointId ?? '');
  const [reference, setReference] = useState('');
  const [sha256, setSha] = useState('');
  const [signedOn, setSignedOn] = useState('');
  const [cb, setCb] = useState('POURCENTAGE');
  const [cv, setCv] = useState('');
  const [pb, setPb] = useState('POURCENTAGE_PAR_JOUR');
  const [pv, setPv] = useState('');
  const [cur, setCur] = useState('CDF');
  const [cap, setCap] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    void run(`/v1/tresor/points/${pointId}/contrats`, {
      reference, sha256, signedOn,
      terms: {
        commission: { basis: cb, value: cv, ...(cb === 'FORFAIT_PAR_OPERATION' ? { currency: cur } : {}) },
        penalty: { basis: pb, value: pv, ...(pb === 'FORFAIT_PAR_JOUR' ? { currency: cur } : {}), ...(cap ? { capPct: cap } : {}) },
      },
    }, 'Contrat enregistré : validation par une autre personne du Trésor.', onDone);
  }
  return (
    <form className="form" onSubmit={submit}>
      <div className="field"><label className="label" htmlFor="pc-point">Point agréé</label>
        <select id="pc-point" value={pointId} onChange={(e) => setPointId(e.target.value)}>{points.map((p) => <option key={p.pointId} value={p.pointId}>{p.name}</option>)}</select></div>
      <div className="field"><label className="label" htmlFor="pc-ref">Référence du contrat signé</label><input id="pc-ref" value={reference} onChange={(e) => setReference(e.target.value)} required minLength={3} /></div>
      <div className="field"><label className="label" htmlFor="pc-date">Signé le</label><input id="pc-date" type="date" value={signedOn} onChange={(e) => setSignedOn(e.target.value)} required /></div>
      <EmpreinteFichier label="Contrat signé (pièce)" value={sha256} onChange={setSha} />
      <div className="field"><label className="label" htmlFor="pc-cb">Commission (selon le contrat)</label>
        <select id="pc-cb" value={cb} onChange={(e) => setCb(e.target.value)}><option value="POURCENTAGE">% des encaissements</option><option value="FORFAIT_PAR_OPERATION">Forfait par opération</option></select>
        <input aria-label="Valeur de la commission" value={cv} onChange={(e) => setCv(e.target.value)} placeholder="valeur du contrat" required /></div>
      <div className="field"><label className="label" htmlFor="pc-pb">Pénalité de retard (selon le contrat)</label>
        <select id="pc-pb" value={pb} onChange={(e) => setPb(e.target.value)}><option value="POURCENTAGE_PAR_JOUR">% par jour de retard</option><option value="FORFAIT_PAR_JOUR">Forfait par jour</option></select>
        <input aria-label="Valeur de la pénalité" value={pv} onChange={(e) => setPv(e.target.value)} placeholder="valeur du contrat" required />
        <input aria-label="Plafond de la pénalité (%)" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="plafond % (facultatif)" /></div>
      <div className="field"><label className="label" htmlFor="pc-cur">Devise des forfaits</label><select id="pc-cur" value={cur} onChange={(e) => setCur(e.target.value)}><option>CDF</option><option>USD</option></select></div>
      <button type="submit" className="btn btn-primary" disabled={busy || !sha256}>Enregistrer le contrat</button>
      <Message msg={msg} />
    </form>
  );
}

export function PointsAgreesView({ board, canWrite, canPropose, onChanged }: { board: PointsBoard; canWrite: boolean; canPropose: boolean; onChanged: () => void }) {
  const { busy, msg, run } = useAction();
  const [motif, setMotif] = useState<Record<string, string>>({});
  const decide = (path: string, id: string, approve: boolean) => void run(path, { approve, motif: motif[id] }, approve ? 'Décision enregistrée.' : 'Écarté.', onChanged);
  return (
    <>
      <PointsAgreesVisuel board={board} />
      <p className="callout callout-info">{board.notice}</p>
      <Message msg={msg} />
      <section className="panel" aria-labelledby="pa-points"><h2 className="panel-title" id="pa-points">Contrats des points</h2>
        <DataTable rows={board.points} rowKey={(p) => p.pointId} caption="Contrats des points agréés"
          columns={[
            { key: 'n', label: 'Point', primary: true, render: (p) => <><span className="row-title">{p.name}</span><span className="account-code">{p.operator} · {p.commune}</span></> },
            { key: 's', label: 'Contrat', render: (p) => <StatusBadge tone={p.contractStatus === 'EN_VIGUEUR' ? 'good' : 'warning'} label={p.contractStatus === 'EN_VIGUEUR' ? `En vigueur (${p.contract?.reference})` : 'Acte requis'} /> },
            { key: 'p', label: 'À valider', full: true, render: (p) => (!p.pending ? <span className="small muted">—</span> : (
              <span className="row-between">{p.pending.reference} (par {p.pending.proposedBy})
                {canWrite && <>
                  <input aria-label={`Motif ${p.pending.id}`} value={motif[p.pending.id] ?? ''} onChange={(e) => setMotif({ ...motif, [p.pending!.id]: e.target.value })} placeholder="Motif" />
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy || (motif[p.pending.id] ?? '').length < 10} onClick={() => decide(`/v1/tresor/points/contrats/${p.pending!.id}/decision`, p.pending!.id, true)}>Valider</button>
                </>}
              </span>)) },
          ]} />
      </section>
      <section className="panel" aria-labelledby="pa-late"><h2 className="panel-title" id="pa-late">Retards de versement et pénalités calculées</h2>
        {board.late.length === 0 ? <EmptyState title="Aucun retard de versement constaté" icon="check" /> : (
          <ul className="list-rows">{board.late.map((l) => (
            <li key={l.key} className="list-row list-row-stack">
              <div className="row-between"><span className="row-title">{l.pointName} — jour de caisse {l.day} ({l.daysLate} j)</span><StatusBadge tone={l.status === 'CALCULEE' ? 'info' : 'warning'} label={l.status === 'CALCULEE' ? `Pénalité calculée : ${montants(l.amounts)}` : 'Acte requis'} /></div>
              <p className="small muted">{l.computation}</p>
              {canPropose && l.status === 'CALCULEE' && !l.penaltyId && (
                <div className="row-between">
                  <input aria-label={`Motif ${l.key}`} value={motif[l.key] ?? ''} onChange={(e) => setMotif({ ...motif, [l.key]: e.target.value })} placeholder="Motif (10 caractères au moins)" />
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy || (motif[l.key] ?? '').length < 10} onClick={() => void run('/v1/tresor/points/penalites', { pointId: l.pointId, day: l.day, motif: motif[l.key] }, 'Pénalité proposée : décision par une autre personne.', onChanged)}>Proposer la pénalité</button>
                </div>
              )}
            </li>))}
          </ul>
        )}
        {board.penalties.length > 0 && (
          <ul className="list-rows">{board.penalties.map((p) => (
            <li key={p.id} className="list-row list-row-stack">
              <div className="row-between"><span className="row-title">{p.id} — {p.pointId} ({p.day}) : {montants(p.amounts)}</span><StatusBadge tone={p.status === 'DECIDEE' ? 'serious' : p.status === 'PROPOSEE' ? 'warning' : 'neutral'} label={p.status === 'PROPOSEE' ? 'À décider' : p.status === 'DECIDEE' ? 'Retenue' : 'Écartée'} /></div>
              {canWrite && p.status === 'PROPOSEE' && (
                <div className="row-between">
                  <input aria-label={`Motif ${p.id}`} value={motif[p.id] ?? ''} onChange={(e) => setMotif({ ...motif, [p.id]: e.target.value })} placeholder="Motif de la décision" />
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy || (motif[p.id] ?? '').length < 10} onClick={() => decide(`/v1/tresor/points/penalites/${p.id}/decision`, p.id, true)}>Retenir</button>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy || (motif[p.id] ?? '').length < 10} onClick={() => decide(`/v1/tresor/points/penalites/${p.id}/decision`, p.id, false)}>Écarter</button>
                </div>
              )}
            </li>))}
          </ul>
        )}
      </section>
      {canWrite && <section className="panel" aria-labelledby="pa-new"><h2 className="panel-title" id="pa-new">Enregistrer un contrat de point</h2><ContractForm points={board.points} onDone={onChanged} /></section>}
    </>
  );
}

export default function PointsAgrees() {
  const { user } = useApp();
  const allowed = hasRole(user?.roles, 'R17', 'R18', 'R22', 'R23', 'R05');
  const b = useApi(allowed ? () => api<PointsBoard>('/v1/tresor/points') : null, [user?.id]);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Trésor" title="Points de paiement agréés — contrats, commissions et pénalités" lead="Commission contractuelle distincte des recettes, jamais prélevée sur le montant dû ; pénalités de retard calculées, proposées et décidées par deux personnes." />
      {!allowed ? <EmptyState title="Accès réservé" icon="lock">Réservé au Trésor, aux Finances et à l’audit.</EmptyState> : (
        <>
          {b.loading && <Loading />}
          {b.error !== null && <ErrorState error={b.error} onRetry={b.reload} />}
          {b.data && <PointsAgreesView board={b.data} canWrite={hasRole(user?.roles, 'R17')} canPropose={hasRole(user?.roles, 'R17', 'R18')} onChanged={b.reload} />}
        </>
      )}
    </div>
  );
}
