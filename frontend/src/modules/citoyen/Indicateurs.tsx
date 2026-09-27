/**
 * Indicateurs des modules 1 à 12 de la Spécification fonctionnelle, calculés sur les données enregistrées. Un
 * indicateur sans donnée source est affiché « non mesuré » avec sa raison — jamais une estimation.
 */
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { BlocIndicateurs } from './common';
import './citoyen.css';

interface Reponse { calculeLe: string; modules: { module: number; titre: string; indicateurs: Record<string, unknown> }[]; notice: string }

export default function Indicateurs() {
  const { user, fmtDate } = useApp();
  const q = useApi(() => api<Reponse>('/v1/citoyen/indicateurs'), [user?.id]);
  return (
    <div className="stack">
      <PageHead eyebrow="Modules 1 à 12" title="Indicateurs du parcours du citoyen" lead="Identité, enrôlement, portail, application, portail public, USSD et SMS, relations, cadastre, locatif, patentes, véhicules, transport." />
      {q.loading ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : q.data && (
        <>
          <p className="small muted">{q.data.notice} Calculé le {fmtDate(q.data.calculeLe, true)}.</p>
          <div className="cit-kpis">{q.data.modules.map((m) => <BlocIndicateurs key={m.module} titre={`Module ${m.module} — ${m.titre}`} indicateurs={m.indicateurs} />)}</div>
        </>
      )}
    </div>
  );
}
