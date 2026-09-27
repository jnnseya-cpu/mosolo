/**
 * Couverture locative par avenue, quartier et commune (Document maître FR 2, nouvelle version, § 16.6) : effectifs
 * enregistrés, occupation (propriétaire / loué), bailleurs et locataires identifiés, valeur locative déclarée et vérifiée
 * (annualisée, par devise), obligations payées et impayées, concentration de l'activité locative. Les estimations et le
 * taux de couverture sont « non mesurés » tant qu'aucun modèle de potentiel certifié n'existe (jamais inventés).
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { CouvertureLocativeVisuel } from './visuels';

export interface RentalCoverageRow {
  level: 'COMMUNE' | 'QUARTIER' | 'AVENUE'; commune: string; quartier: string | null; avenue: string | null;
  estimated: { parcels: null; units: null; status: string; note: string };
  registered: { parcels: number; buildings: number; units: number; validated: number };
  occupancy: { ownerOccupied: number; leased: number; vacant: number; undeclared: number; ownerOccupiedPct: number | null; leasedPct: number | null };
  parties: { lessors: number; tenants: number };
  leases: { active: number; verified: number; terminated: number; contested: number };
  declaredRentalValue: Record<string, string> | null; verifiedRentalValue: Record<string, string> | null;
  legallyTaxableBase: { status: string; note: string };
  obligations: { paid: number; unpaid: number; overdue: number; paidAmount: Record<string, string> | null; unpaidAmount: Record<string, string> | null };
  concentrationPct: number | null;
  census: { coverageRate: null; status: string; validationRate: number | null };
}
export interface RentalCoverage { asOf: string; level: RentalCoverageRow['level']; access: 'full' | 'minimal'; rows: RentalCoverageRow[]; notice: string }

const amounts = (a: Record<string, string> | null) => (a === null ? 'masqué' : Object.entries(a).map(([c, v]) => `${v} ${c}`).join(' · ') || '—');
const pct = (v: number | null) => (v === null ? '—' : `${v} %`);

export function RentalCoverageTable({ data }: { data: RentalCoverage }) {
  const zone = (r: RentalCoverageRow) => [r.commune, r.quartier, r.avenue].filter(Boolean).join(' › ');
  return (
    <div className="stack-sm">
      <p className="small muted">{data.notice}{data.access === 'minimal' ? ' Accès minimal : aucun montant.' : ''}</p>
      <div className="rtable-wrap"><table className="data-table rtable">
        <caption className="sr-only">Couverture locative</caption>
        <thead><tr>
          <th>Zone</th><th className="num">Parcelles / unités enregistrées</th><th className="num">Estimé</th><th className="num">Occupé propriétaire / loué</th>
          <th className="num">Bailleurs / locataires</th><th>Valeur locative déclarée (an)</th><th>Obligations payées / impayées</th><th className="num">Concentration</th><th className="num">Couverture</th>
        </tr></thead>
        <tbody>{data.rows.map((r) => (
          <tr key={zone(r)}>
            <td data-label="Zone" className="cell-primary">{zone(r)}</td>
            <td data-label="Enregistrées" className="num">{r.registered.parcels} / {r.registered.units}</td>
            <td data-label="Estimé" className="num" title={r.estimated.note}>non mesuré</td>
            <td data-label="Occupation" className="num">{pct(r.occupancy.ownerOccupiedPct)} / {pct(r.occupancy.leasedPct)}</td>
            <td data-label="Parties" className="num">{r.parties.lessors} / {r.parties.tenants}</td>
            <td data-label="Valeur locative">{amounts(r.declaredRentalValue)}{r.verifiedRentalValue && Object.keys(r.verifiedRentalValue).length > 0 ? <span className="small muted"> (vérifiée : {amounts(r.verifiedRentalValue)})</span> : null}</td>
            <td data-label="Obligations">{r.obligations.paid} / {r.obligations.unpaid}{r.obligations.overdue ? ` (${r.obligations.overdue} en retard)` : ''}{r.obligations.unpaidAmount ? <span className="small muted"> · impayé {amounts(r.obligations.unpaidAmount)}</span> : null}</td>
            <td data-label="Concentration" className="num">{pct(r.concentrationPct)}</td>
            <td data-label="Couverture" className="num" title="Taux de couverture non mesuré sans modèle de potentiel ; taux de validation affiché">non mesuré · validé {pct(r.census.validationRate)}</td>
          </tr>
        ))}</tbody>
      </table></div>
      {data.rows[0] && <p className="small muted">{data.rows[0].legallyTaxableBase.note}</p>}
    </div>
  );
}

export function CouvertureLocative({ commune }: { commune: string }) {
  const { user } = useApp();
  const [level, setLevel] = useState<RentalCoverageRow['level']>('QUARTIER');
  const q = useApi(() => api<RentalCoverage>(`/v1/fiscal/couverture-locative?niveau=${level}${commune ? `&commune=${encodeURIComponent(commune)}` : ''}`), [user?.id, level, commune]);
  return (
    <section className="panel" aria-labelledby="rc-locatif">
      <h2 id="rc-locatif" className="panel-title">Couverture locative</h2>
      <div className="seg seg-wrap" role="group" aria-label="Niveau">
        {(['COMMUNE', 'QUARTIER', 'AVENUE'] as const).map((l) => (
          <button key={l} type="button" aria-pressed={level === l} onClick={() => setLevel(l)}>{l === 'COMMUNE' ? 'Par commune' : l === 'QUARTIER' ? 'Par quartier' : 'Par avenue'}</button>
        ))}
      </div>
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && <CouvertureLocativeVisuel rows={q.data.rows} />}
      {q.data && <RentalCoverageTable data={q.data} />}
    </section>
  );
}
