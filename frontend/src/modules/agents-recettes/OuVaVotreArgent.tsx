/**
 * « Où va votre argent » (page publique, 01/10/2026) : par commune, les recettes rapprochées (relevé bancaire) et les
 * réalisations financées sur acte. Aucune donnée individuelle ; une commune de moins de 5 contribuables n'est pas publiée.
 */
import type { MoneyJSON } from '@mosolo/shared';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { ErrorState, Loading } from '../../components/States';
import { MoneyText } from '../../components/MoneyText';

interface Vue { generatedAt: string; note: string; communes: { commune: string; publiable: boolean; recettes: MoneyJSON[]; motif: string | null; realisations: { titre: string; statut: string; avancement: string | null }[] }[] }
const STATUT: Record<string, string> = { FINANCE: 'Financée', EN_COURS: 'En cours', ACHEVE: 'Achevée' };

export default function OuVaVotreArgent() {
  const q = useApi(() => api<Vue>('/v1/public/ou-va-votre-argent'), []);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Ville de Kinshasa · transparence" title="Où va votre argent" lead="Ce que chaque commune a payé (montants confirmés par la banque) et ce qui y a été réalisé avec l’argent public." />
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : q.data && (
        <>
          <DataTable caption="Par commune" rows={q.data.communes} rowKey={(c) => c.commune} columns={[
            { key: 'c', label: 'Commune', primary: true, render: (c) => <strong>{c.commune}</strong> },
            { key: 'r', label: 'Recettes confirmées', num: true, render: (c) => (c.publiable ? (c.recettes.length ? c.recettes.map((m) => <span key={m.currency} style={{ display: 'block' }}><MoneyText money={m} showIndicative={false} /></span>) : '0') : <span className="small muted">{c.motif}</span>) },
            { key: 'p', label: 'Réalisations financées', render: (c) => (c.realisations.length ? <ul className="small" style={{ margin: 0 }}>{c.realisations.map((p) => <li key={p.titre}>{p.titre} — {STATUT[p.statut] ?? p.statut}{p.avancement ? ` (${p.avancement} %)` : ''}</li>)}</ul> : <span className="small muted">Aucune réalisation publiée pour l’instant</span>) },
          ]} />
          <p className="small muted">{q.data.note}</p>
        </>
      )}
    </div>
  );
}
