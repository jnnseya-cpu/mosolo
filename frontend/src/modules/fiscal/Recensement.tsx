/**
 * Recensement massif (§ 17.4) : couverture par vague (0 préparation … 5 entretien), par commune ; chaque donnée porte
 * sa provenance, son niveau de confiance, sa date de vérification et son responsable (fiche de l'objet).
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { FiscalTabs } from './common';
import { CouvertureLocative } from './CouvertureLocative';
import './fiscal.css';
import { RecensementVisuels } from './visuels';

interface Coverage {
  total: number; imported: number; withExplicitProvenance: number;
  stages: { stage: number; label: string; target: string; output: string; count: number; pct: number; atLeast: number }[];
  byCommune: Record<string, Record<string, number>>;
}

export default function Recensement() {
  const { user } = useApp();
  const [commune, setCommune] = useState('');
  const q = useApi(() => api<Coverage>(`/v1/fiscal/census/coverage${commune ? `?commune=${encodeURIComponent(commune)}` : ''}`), [user?.id, commune]);
  const communes = Object.keys(q.data?.byCommune ?? {});
  return (
    <div className="page page-wide fs-page">
      <PageHead eyebrow="Recensement" title="Vagues de recensement et provenance"
        lead="Cinq sources (terrain, auto-déclaration, données administratives, partenaires autorisés, observation géospatiale). Chaque objet avance d’une vague à la fois ; aucune vague n’a d’effet fiscal avant la fiscalisation par une règle validée." />
      <FiscalTabs />
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && (
        <div className="stack">
          <div className="field"><label className="label" htmlFor="rc-com">Commune</label>
            <select id="rc-com" value={commune} onChange={(e) => setCommune(e.target.value)}><option value="">Toutes</option>{(commune ? [commune] : communes).map((c) => <option key={c} value={c}>{c}</option>)}</select></div>
          <RecensementVisuels d={q.data} />
          <p className="small">{q.data.total} objet(s) · {q.data.imported} repris d’un système existant · {q.data.withExplicitProvenance} avec provenance vérifiée enregistrée.</p>
          <div className="rtable-wrap"><table className="data-table rtable">
            <thead><tr><th>Vague</th><th>Cible</th><th>Sortie attendue</th><th className="num">Objets</th><th className="num">Part</th><th className="num">Au moins cette vague</th></tr></thead>
            <tbody>{q.data.stages.map((s) => (
              <tr key={s.stage}><td data-label="Vague" className="cell-primary">{s.stage} — {s.label}</td><td data-label="Cible">{s.target}</td><td data-label="Sortie">{s.output}</td>
                <td data-label="Objets" className="num">{s.count}</td><td data-label="Part" className="num">{s.pct} %</td><td data-label="Au moins" className="num">{s.atLeast}</td></tr>))}</tbody>
          </table></div>
          <CouvertureLocative commune={commune} />
        </div>
      )}
    </div>
  );
}
