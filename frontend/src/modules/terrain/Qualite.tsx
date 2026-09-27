/**
 * Contrôle qualité de la sous-traitance (§ 15A.5, § 15A.7) : doublons et objets présumés fictifs (présomptions à
 * contre-visiter), rotation des zones, récupération des sommes versées : proposition du contrôle qualité, décision de
 * la régie, ordre de reversement du Trésor à quatre yeux.
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { EmpreinteFichier } from '../../components/EmpreinteFichier';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { useApp } from '../../context';
import { hasRole, Message, useAction } from '../tresor/shared';
import './terrain.css';

interface Suspicion { code: string; kind: 'DOUBLON' | 'FICTIF'; label: string; findingIds: string[]; subcontractorId: string | null; agentIds: string[]; detail: string; fingerprint: string }
interface RotationItem { kind: 'AGENT' | 'SOUS_TRAITANT'; id: string; name: string; commune: string; since: string; days: number; overdue: boolean }
interface Clawback { id: string; subcontractorId: string; findingIds: string[]; grounds: string; motif: string; amount: MoneyJSON; status: 'PROPOSEE' | 'DECIDEE' | 'REJETEE' | 'ORDONNEE'; proposedBy: string; decidedBy?: string; treasury?: { operationId: string } }
export interface QualityBoard {
  suspicions: Suspicion[]; rotation: { maxDays: number; blocking: boolean; statut: string; items: RotationItem[] }; clawbacks: Clawback[];
  params: { duplicateDistanceM: number; rotationMaxDays: number; statut: string }; note: string;
}
const STATUS = { PROPOSEE: ['À décider', 'warning'], DECIDEE: ['Décidée — ordre du Trésor à émettre', 'serious'], REJETEE: ['Rejetée', 'neutral'], ORDONNEE: ['Ordre de reversement émis', 'good'] } as const;

export function QualiteView({ board, roles, onChanged }: { board: QualityBoard; roles: string[]; onChanged: () => void }) {
  const { busy, msg, run } = useAction();
  const [motif, setMotif] = useState<Record<string, string>>({});
  const [sha, setSha] = useState('');
  const canPropose = hasRole(roles, 'R09', 'R11');
  const canDecide = hasRole(roles, 'R06', 'R07');
  const canTreasury = hasRole(roles, 'R17');
  return (
    <>
      <p className="callout callout-info">{board.note} Seuils : doublon à {board.params.duplicateDistanceM} m, rotation après {board.params.rotationMaxDays} jours ({board.params.statut}).</p>
      <Message msg={msg} />
      <section className="panel" aria-labelledby="tq-susp"><h2 className="panel-title" id="tq-susp">Doublons et objets présumés fictifs</h2>
        {canPropose && <EmpreinteFichier label="Pièce à l’appui d’une récupération (rapport de contre-visite)" value={sha} onChange={setSha} />}
        {board.suspicions.length === 0 ? <EmptyState title="Aucune présomption" icon="check" /> : (
          <ul className="list-rows">{board.suspicions.map((s) => (
            <li key={s.fingerprint} className="list-row list-row-stack">
              <div className="row-between"><span className="row-title">{s.label}</span><StatusBadge tone={s.kind === 'FICTIF' ? 'serious' : 'warning'} label={s.kind === 'FICTIF' ? 'Objet présumé fictif' : 'Doublon présumé'} /></div>
              <p className="small">{s.detail} — constats <span className="mono">{s.findingIds.join(', ')}</span>{s.subcontractorId ? ` · ${s.subcontractorId}` : ''}</p>
              {canPropose && s.subcontractorId && (
                <div className="row-between">
                  <input aria-label={`Motif ${s.fingerprint}`} placeholder="Motif (10 caractères au moins)" value={motif[s.fingerprint] ?? ''} onChange={(e) => setMotif({ ...motif, [s.fingerprint]: e.target.value })} />
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !sha || (motif[s.fingerprint] ?? '').length < 10}
                    onClick={() => void run('/v1/terrain/recuperations', { subcontractorId: s.subcontractorId, findingIds: s.findingIds, grounds: s.kind === 'FICTIF' ? 'OBJET_FICTIF' : 'CONSTAT_FRAUDULEUX', motif: motif[s.fingerprint], evidenceSha256: [sha] }, 'Récupération proposée : décision de la régie.', onChanged)}>Proposer une récupération</button>
                </div>
              )}
            </li>))}
          </ul>
        )}
      </section>
      <section className="panel" aria-labelledby="tq-rot"><h2 className="panel-title" id="tq-rot">Rotation des zones</h2>
        <DataTable rows={board.rotation.items} rowKey={(r) => `${r.kind}:${r.id}:${r.commune}`} caption="Rotation des zones" empty={<EmptyState title="Aucune affectation" icon="check" />}
          columns={[
            { key: 'n', label: 'Agent ou sous-traitant', primary: true, render: (r) => <><span className="row-title">{r.name}</span><span className="account-code">{r.kind === 'AGENT' ? 'Agent' : 'Sous-traitant'}</span></> },
            { key: 'c', label: 'Commune', render: (r) => r.commune },
            { key: 'd', label: 'Depuis', num: true, render: (r) => `${r.days} j` },
            { key: 's', label: 'Rotation', render: (r) => <StatusBadge tone={r.overdue ? 'serious' : 'good'} label={r.overdue ? 'À organiser' : 'Dans la durée'} /> },
          ]} />
      </section>
      <section className="panel" aria-labelledby="tq-claw"><h2 className="panel-title" id="tq-claw">Récupérations des sommes versées</h2>
        {board.clawbacks.length === 0 ? <EmptyState title="Aucune récupération" icon="check" /> : (
          <ul className="list-rows">{board.clawbacks.map((c) => (
            <li key={c.id} className="list-row list-row-stack">
              <div className="row-between"><span className="row-title">{c.id} — {c.subcontractorId} : {c.amount.amount} {c.amount.currency} ({c.findingIds.length} constat(s))</span><StatusBadge tone={STATUS[c.status][1]} label={STATUS[c.status][0]} /></div>
              <p className="small">{c.motif} — proposé par {c.proposedBy}{c.decidedBy ? `, décidé par ${c.decidedBy}` : ''}{c.treasury ? ` · opération ${c.treasury.operationId}` : ''}</p>
              {((canDecide && c.status === 'PROPOSEE') || (canTreasury && c.status === 'DECIDEE')) && (
                <div className="row-between">
                  <input aria-label={`Motif ${c.id}`} placeholder="Motif" value={motif[c.id] ?? ''} onChange={(e) => setMotif({ ...motif, [c.id]: e.target.value })} />
                  {c.status === 'PROPOSEE' ? <>
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy || (motif[c.id] ?? '').length < 10} onClick={() => void run(`/v1/terrain/recuperations/${c.id}/decision`, { approve: true, motif: motif[c.id] }, 'Récupération décidée.', onChanged)}>Décider la récupération</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy || (motif[c.id] ?? '').length < 10} onClick={() => void run(`/v1/terrain/recuperations/${c.id}/decision`, { approve: false, motif: motif[c.id] }, 'Récupération rejetée.', onChanged)}>Rejeter</button>
                  </> : (
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy || (motif[c.id] ?? '').length < 10} onClick={() => void run('/v1/tresor/operations', { kind: 'RECUPERATION_SOUS_TRAITANT', reason: motif[c.id], recuperation: { clawbackId: c.id } }, 'Ordre proposé au Trésor : validation par une autre personne.', onChanged)}>Proposer l’ordre de reversement au Trésor</button>
                  )}
                </div>
              )}
            </li>))}
          </ul>
        )}
      </section>
    </>
  );
}

export default function Qualite() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const allowed = hasRole(roles, 'R06', 'R07', 'R09', 'R11', 'R17', 'R22', 'R23', 'R24');
  const b = useApi(allowed ? () => api<QualityBoard>('/v1/terrain/qualite') : null, [user?.id]);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Terrain" title="Contrôle qualité de la sous-traitance" lead="Doublons, objets présumés fictifs, rotation des zones et récupération des sommes versées : présomptions à vérifier, décisions à deux personnes, aucun effet automatique." />
      {!allowed ? <EmptyState title="Accès réservé" icon="lock">Réservé à la régie, au contrôle qualité, au Trésor et à l’audit.</EmptyState> : (
        <>
          {b.loading && <Loading />}
          {b.error !== null && <ErrorState error={b.error} onRetry={b.reload} />}
          {b.data && <QualiteView board={b.data} roles={roles} onChanged={b.reload} />}
        </>
      )}
    </div>
  );
}
