/**
 * Procès-verbaux me concernant (module 35 ; droit à la preuve et droit de contester, Cahier § 22) : le contribuable voit
 * les procès-verbaux établis sur ses objets et peut les contester ; accusé de réception horodaté, réponse motivée.
 */
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { ReasonAction } from '../fiscal/common';
import { MesPvVisuel } from './visuels';

interface MyPv { id: string; number: string; status: string; commune: string; recordedAt: string; signature: { kind: string }; statements: { observations: string }; contestations: { id: string; text: string; acknowledgement: string; answer?: { text: string } }[] }

export default function MesProcesVerbaux() {
  const { user } = useApp();
  const q = useApi(() => api<MyPv[]>('/v1/terrain/proces-verbaux/mes-proces-verbaux'), [user?.id]);
  return (
    <div className="page">
      <PageHead eyebrow="Mes droits" title="Procès-verbaux me concernant" lead="Un procès-verbal constate une situation : il ne crée ni dette ni sanction. Vous pouvez le contester ; la réponse est motivée par une personne distincte de l’agent." />
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && q.data.length > 0 && <MesPvVisuel pvs={q.data} />}
      {q.data && q.data.length === 0 && <EmptyState title="Aucun procès-verbal sur vos biens." />}
      <ul className="stack-sm">{(q.data ?? []).map((p) => (
        <li key={p.id} className="panel stack-sm">
          <p className="panel-title"><span className="mono">{p.number}</span> · {p.commune} · {new Date(p.recordedAt).toLocaleDateString('fr-FR')} · {p.status === 'VALIDE' ? 'validé' : 'en attente de validation'}</p>
          <p className="small">Constatations : {p.statements.observations}</p>
          {p.contestations.map((c) => <p key={c.id} className="small">Votre contestation : « {c.text} » — {c.acknowledgement}{c.answer ? ` — Réponse : ${c.answer.text}` : ' — réponse en attente'}</p>)}
          <ReasonAction label="Contester" confirmLabel="Envoyer la contestation" minLength={10} onSubmit={(text) => api(`/v1/terrain/proces-verbaux/${p.id}/contestations`, { method: 'POST', body: { text } }).then(q.reload)} />
        </li>))}</ul>
    </div>
  );
}
