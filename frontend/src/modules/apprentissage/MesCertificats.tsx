/** Mes certificats (§ 24) : délivrance, validité, retrait motivé ; certificats de démonstration signalés [EXEMPLE]. */
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import type { Certificat } from './types';
import './apprentissage.css';

type Ligne = Certificat & { libelleProfil: string; enVigueur: boolean };

export default function MesCertificats() {
  const { user, fmtDate } = useApp();
  const q = useApi(() => api<Ligne[]>('/v1/apprentissage/mes-certificats'), [user?.id]);
  if (!user) return <div className="page"><EmptyState title="Choisissez un utilisateur de démonstration." icon="users" /></div>;
  return (
    <div className="page">
      <PageHead eyebrow="Apprentissage et poste de travail" title="Mes certificats" lead="Certificats délivrés par une personne distincte, sur épreuves réussies et évaluation conforme ; durée de validité par défaut à confirmer." />
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && (
        <DataTable caption="Mes certificats" rows={q.data} rowKey={(c) => c.id} empty={<EmptyState title="Aucun certificat pour le moment." icon="shieldCheck" />} columns={[
          { key: 'id', label: 'Certificat', primary: true, render: (c) => <span className="mono">{c.id}</span> },
          { key: 'p', label: 'Public', render: (c) => c.libelleProfil },
          { key: 'd', label: 'Délivré le', render: (c) => fmtDate(c.delivreLe) },
          { key: 'v', label: 'Valable jusqu’au', render: (c) => c.valableJusquau },
          { key: 's', label: 'Statut', render: (c) => <StatusBadge tone={c.statut === 'RETIRE' ? 'neutral' : c.enVigueur ? 'good' : 'warning'} label={c.statut === 'RETIRE' ? `Retiré — ${c.retrait?.motif ?? ''}` : c.enVigueur ? 'En vigueur' : 'Expiré — renouvellement requis'} /> },
          { key: 'n', label: 'Note', render: (c) => <span className="small muted">{c.fondement.note ?? `${c.fondement.epreuves.length} épreuve(s), ${c.fondement.evaluations.length} évaluation(s)`}</span> },
        ]} />
      )}
    </div>
  );
}
