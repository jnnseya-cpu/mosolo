/**
 * Bloc « Recours et délais légaux » (Document maître FR 2, nouvelle version, § 23) : chaque recours a un propriétaire,
 * un délai légal, un état et une décision motivée ; le non-respect du délai est suivi au tableau de bord de la direction
 * de la régie et de l'audit interne. Agrégats et références de dossiers, sans nom de contribuable.
 */
import { useApp } from '../context';
import { DataTable } from './DataTable';

export interface AppealIndicators {
  asOf: string; open: number; overdue: number; approaching: number; unassigned: number; decided: number; decidedLate: number;
  decidedWithinDeadlineRate: string | null;
  byOwner: { entity: string; userId: string | null; open: number; overdue: number }[];
  overdueItems: { id: string; entity: string; ownerUserId: string | null; decisionDueBy: string; daysLate: number; status: string }[];
  basis: string;
}

export function AppealDeadlinesPanel({ data }: { data: AppealIndicators }) {
  const { fmtDate } = useApp();
  return (
    <section className="panel" aria-labelledby="appeals-deadlines">
      <h2 id="appeals-deadlines" className="panel-title">Recours et délais légaux</h2>
      <p className="panel-sub">Chaque recours a un propriétaire, un délai légal, un état et une décision motivée. Délais : {data.basis}.</p>
      <div className="kpi-row">
        <div className="kpi"><p className="kpi-label">Recours ouverts</p><p className="kpi-value">{data.open}</p><p className="kpi-sub">{data.approaching} à échéance proche</p></div>
        <div className="kpi"><p className="kpi-label">Recours hors délai</p><p className="kpi-value">{data.overdue}</p><p className="kpi-sub">non décidés à la date limite</p></div>
        <div className="kpi"><p className="kpi-label">Sans propriétaire nominatif</p><p className="kpi-value">{data.unassigned}</p><p className="kpi-sub">en file du service compétent</p></div>
        <div className="kpi"><p className="kpi-label">Décidés dans le délai</p><p className="kpi-value">{data.decidedWithinDeadlineRate ?? '—'}</p><p className="kpi-sub">{data.decidedLate} hors délai sur {data.decided} décidé(s)</p></div>
      </div>
      {data.overdueItems.length > 0 && (
        <DataTable rows={data.overdueItems} rowKey={(r) => r.id} caption="Recours hors délai"
          columns={[
            { key: 'id', label: 'Recours', primary: true, render: (r) => <span className="mono">{r.id}</span> },
            { key: 'owner', label: 'Propriétaire', render: (r) => <span className="small">{r.entity}{r.ownerUserId ? ` · ${r.ownerUserId}` : ' · file du service'}</span> },
            { key: 'due', label: 'Décision attendue avant', render: (r) => fmtDate(r.decisionDueBy) },
            { key: 'late', label: 'Retard (jours)', num: true, render: (r) => String(r.daysLate) },
          ]} />
      )}
    </section>
  );
}
