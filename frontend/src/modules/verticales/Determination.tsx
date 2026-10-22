/**
 * Entreprises (MOSOLO Business, Partie V) : détermination des obligations d'un établissement par activité, lieu et
 * catégorie — chaque prélèvement candidat avec l'état réel de sa règle ; « l'existence d'une activité n'emporte pas
 * assujettissement : la règle décide ». Aucune obligation n'est créée par cette détermination.
 */
import { useApi } from '../../hooks/useApi';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';

interface Determination {
  objectId: string; activite: string | null; commune: string; localityRank: number; categorie: string; notice: string;
  items: { code: string; label: string; ruleCode: string; ruleStatus: string; demo: boolean; applicable: boolean; action: string; criteres: { activite: string; lieu: string; categorie: string } }[];
}

export function EtablissementObligations({ objectId, label }: { objectId: string; label: string }) {
  const q = useApi(() => api<Determination>(`/v1/verticales/entreprises/etablissements/${objectId}/obligations`), [objectId]);
  if (q.loading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  return (
    <section className="panel" aria-label={`Obligations déterminées — ${label}`}>
      <h3 className="panel-title"><Icon name="scale" size={16} /> Obligations déterminées — {label}</h3>
      <ul className="list-rows">
        {q.data.items.map((i) => (
          <li key={i.code} className="list-row">
            <div className="min0"><p className="row-title">{i.label}</p><p className="small muted">{i.criteres.activite} · {i.criteres.lieu} · {i.criteres.categorie} · règle {i.ruleCode}</p><p className="small">{i.action}</p></div>
            <div className="row-side"><StatusBadge tone={i.applicable ? 'good' : 'neutral'} label={i.applicable ? `Applicable (${i.ruleStatus}${i.demo ? ' [EXEMPLE]' : ''})` : i.ruleStatus} /></div>
          </li>
        ))}
      </ul>
      <p className="hint">{q.data.notice}</p>
    </section>
  );
}
