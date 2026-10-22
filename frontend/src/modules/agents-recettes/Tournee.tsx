/**
 * Copilote de l'agent de terrain (01/10/2026) : tournée du jour dans son territoire — objets impayés à visiter et
 * éléments découverts à confirmer, dans l'ordre de passage ; aucun montant ; jamais d'espèces.
 */
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';

interface Arret { ordre: number; commune: string; quartier?: string; position?: { lat: number; lon: number }; motif: string }
interface Tournee { communes: string[] | string; arrets: Arret[]; rappel: string[] }

export default function Tournee() {
  const { user } = useApp();
  const q = useApi(() => api<Tournee>('/v1/agents-recettes/tournee'), [user?.id]);
  return (
    <div className="page">
      <PageHead eyebrow="Terrain · copilote" title="Ma tournée du jour" lead="Ordre de passage proposé par le copilote : les plus gros enjeux d’abord, puis le plus proche." />
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : q.data && (
        <>
          <ul className="callout callout-info small" style={{ margin: '0 0 16px' }}>{q.data.rappel.map((x) => <li key={x}>{x}</li>)}</ul>
          <DataTable caption="Arrêts de la tournée" rows={q.data.arrets} rowKey={(a) => String(a.ordre)} empty={<EmptyState title="Aucun arrêt" icon="pin">Rien à visiter aujourd’hui dans votre territoire.</EmptyState>} columns={[
            { key: 'o', label: 'Ordre', primary: true, render: (a) => <strong>{a.ordre}. {a.motif}</strong> },
            { key: 'c', label: 'Lieu', render: (a) => `${a.commune}${a.quartier ? ` · ${a.quartier}` : ''}` },
            { key: 'p', label: 'Itinéraire', render: (a) => (a.position ? <a className="btn btn-ghost btn-sm" href={`https://www.openstreetmap.org/?mlat=${a.position.lat}&mlon=${a.position.lon}#map=18/${a.position.lat}/${a.position.lon}`} target="_blank" rel="noreferrer">Carte</a> : 'à relever') },
          ]} />
          <p className="small muted">Territoire : {Array.isArray(q.data.communes) ? q.data.communes.join(', ') : q.data.communes}.</p>
        </>
      )}
    </div>
  );
}
