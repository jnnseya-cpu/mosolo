/**
 * Mes doléances (01/10/2026) : l'usager signale un problème (comportement d'un agent, montant, paiement, service) ; la
 * doléance est orientée vers le bon service avec un délai de réponse ; l'auteur n'est jamais révélé à l'agent mis en
 * cause. Un montant contesté suit aussi le circuit des recours (lien proposé).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { COMMUNES } from '../../verticals/catalogue';
import { Area, Choice, Notice, useRunner } from '../pilotage/planif';

interface Mes { items: { id: string; reference: string; at: string; commune: string; libelle: string; service: string; echeance: string; statut: string; reponse: { at: string; texte: string } | null }[]; categories: Record<string, { libelle: string; circuit?: string }>; delaiJours: number }

export default function MesDoleances() {
  const { user, fmtDate } = useApp();
  const q = useApi(() => api<Mes>('/v1/doleances/miennes'), [user?.id]);
  const r = useRunner(q.reload);
  const [f, setF] = useState({ commune: COMMUNES[0] ?? 'Gombe', categorie: 'SERVICE', texte: '' });
  const circuit = q.data?.categories[f.categorie]?.circuit;
  return (
    <div className="page">
      <PageHead eyebrow="Mon espace" title="Mes doléances" lead="Un problème avec un agent, un montant, un paiement ou un service ? Signalez-le : il est transmis au bon service, qui vous répond." />
      <Notice msg={r.msg} />
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : q.data && (
        <>
          <section className="panel">
            <div className="form">
              <Choice label="Commune" value={f.commune} onChange={(v) => setF({ ...f, commune: v })} options={COMMUNES.map((c) => [c, c])} />
              <Choice label="Sujet" value={f.categorie} onChange={(v) => setF({ ...f, categorie: v })} options={Object.entries(q.data.categories).map(([k, c]) => [k, c.libelle])} />
              <Area label="Votre doléance (10 caractères au moins)" rows={4} value={f.texte} onChange={(v) => setF({ ...f, texte: v })} />
              {circuit && <p className="small">Pour contester un montant, déposez aussi un <Link to={circuit}>recours</Link> : il suspend le recouvrement pendant l’examen.</p>}
              <div className="btn-row"><button type="button" className="btn btn-primary" disabled={r.busy || f.texte.trim().length < 10} onClick={() => void r.run('/v1/doleances', { commune: f.commune, categorie: f.categorie, texte: f.texte.trim() }, 'Doléance transmise : vous recevrez une réponse.').then((x) => { if (x) setF({ ...f, texte: '' }); })}>Envoyer</button></div>
              <p className="small muted">Réponse attendue sous {q.data.delaiJours} jours. Votre nom n’est jamais communiqué à l’agent concerné.</p>
            </div>
          </section>
          <DataTable caption="Mes doléances" rows={q.data.items} rowKey={(x) => x.id} empty={<EmptyState title="Aucune doléance" icon="message" />} columns={[
            { key: 'd', label: 'Doléance', primary: true, render: (x) => <><strong>{x.reference} — {x.libelle}</strong><span className="small muted" style={{ display: 'block' }}>{fmtDate(x.at, true)} · {x.commune} · {x.service}</span></> },
            { key: 's', label: 'État', render: (x) => <StatusBadge tone={x.statut === 'REPONDUE' ? 'good' : 'warning'} label={x.statut === 'REPONDUE' ? 'Répondue' : `En cours (réponse attendue le ${x.echeance})`} /> },
            { key: 'r', label: 'Réponse', render: (x) => x.reponse?.texte ?? '—' },
          ]} />
        </>
      )}
    </div>
  );
}
