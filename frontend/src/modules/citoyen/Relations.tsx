/**
 * Module 7 — Gestionnaire de relations contribuable–objet : suites du détachement (vente, fin de bail, mutation).
 * Les obligations de l'ancien titulaire échues après la date d'effet sont mises en REVUE ; une personne décide
 * (maintenue ou à rectifier par le circuit de réclamation) — jamais une annulation automatique. La mutation est
 * bloquée sans quitus lorsque la règle l'exige (moteur de dépendances). Rattachement, revendication, historique et
 * litiges : écran « Biens et relations ».
 */
// Parcours par rôle (29/09/2026) : liens adaptés au compte — un écran que le rôle n'utilise pas affiche « Réalisé par : … ».
import { LienEcran as Link } from '../../components/LienEcran';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { ActionMotivee, BlocIndicateurs, Tableau } from './common';
import './citoyen.css';
import { RelationsVisuel } from './visuels';

interface Revue { id: string; obligationId: string; relationId: string; objectId: string; dateEffet: string; echeance: string; motifDetachement: string; statut: string; obligation: { label: string; amount: { amount: string; currency: string }; status: string } | null; decision?: { par: string; motif: string } }

export default function Relations() {
  const { user } = useApp();
  const q = useApi(() => api<Revue[]>('/v1/citoyen/relations/revues'), [user?.id]);
  const kpi = useApi(() => api<Record<string, unknown>>('/v1/citoyen/relations/indicateurs'), [user?.id]);
  return (
    <div className="stack">
      <PageHead eyebrow="Module 7" title="Relations contribuable–objet : revue à la date d’effet" lead="Aucune relation sans preuve minimale ; objet de forte valeur réservé au niveau N2 ; revendications concurrentes ⇒ dossier de litige." />
      <p className="small"><Link to="/fiscal/biens">Rattacher, détacher, revendiquer, historique et litiges</Link> · <Link to="/fiscal/dependances">Blocage de mutation sans quitus (règle)</Link></p>
      <BlocIndicateurs titre="Indicateurs du module 7" indicateurs={kpi.data} />
      {q.loading ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : (
        <section className="panel stack-sm" aria-label="Obligations à revoir">
          <p className="panel-title">Obligations à revoir après un détachement</p>
          <RelationsVisuel revues={q.data ?? []} />
          <Tableau entetes={['Obligation', 'Objet', 'Motif', 'Date d’effet', 'Échéance', 'Statut', 'Décision']} vide="Aucune obligation à revoir."
            lignes={(q.data ?? []).map((r) => [r.obligation ? `${r.obligation.label} — ${r.obligation.amount.amount} ${r.obligation.amount.currency}` : r.obligationId, r.objectId, r.motifDetachement, r.dateEffet, r.echeance.slice(0, 10), r.statut,
              r.statut === 'A_REVOIR' ? <span className="cit-inline">
                <ActionMotivee label="Maintenir" tone="secondary" onSubmit={(motif) => api(`/v1/citoyen/relations/revues/${r.id}/decision`, { method: 'POST', body: { statut: 'MAINTENUE', motif } }).then(q.reload)} />
                <ActionMotivee label="À rectifier" onSubmit={(motif) => api(`/v1/citoyen/relations/revues/${r.id}/decision`, { method: 'POST', body: { statut: 'A_RECTIFIER', motif } }).then(q.reload)} />
              </span> : `${r.decision?.motif ?? ''}`])} />
        </section>
      )}
    </div>
  );
}
