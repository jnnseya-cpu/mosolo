import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';

interface Journal {
  days: { date: string; total: number; byStatus: Record<string, number>; distinctClients: number }[];
  totals: Record<string, number> & { total: number };
  limits: { maxPerWindow: number; windowMs: number; maxMisses: number; missWindowMs: number };
}

const COLS: [string, string][] = [
  ['VALID', 'Valides'], ['PENDING', 'En attente'], ['CANCELLED', 'Annulées'], ['REVERSED', 'Contrepassées'], ['REFUNDED', 'Remboursées'],
  ['REPLACED', 'Remplacées'], ['FRAUD_SUSPECTED', 'Suspectes'], ['UNKNOWN', 'Inconnues'], ['INVALID_CHECK_DIGIT', 'Clé erronée'], ['THROTTLED', 'Freinées'],
];

/** Journal AGRÉGÉ des vérifications publiques : compteurs par jour, aucun code ni aucune adresse. */
export default function VerificationJournal() {
  const { user, fmtDate } = useApp();
  const j = useApi(() => api<Journal>('/v1/tresor/verification-journal'), [user?.id]);
  return (
    <section className="panel" aria-labelledby="vj-title">
      <header className="panel-head">
        <div><h2 className="panel-title" id="vj-title">Vérifications publiques des quittances</h2>
          <p className="panel-sub">{j.data ? `Limite par poste : ${j.data.limits.maxPerWindow} vérifications par minute et ${j.data.limits.maxMisses} codes inconnus par ${Math.round(j.data.limits.missWindowMs / 60000)} minutes (anti-énumération).` : 'Agrégats seulement.'}</p></div>
      </header>
      {j.loading && <Loading />}
      {j.error !== null && <ErrorState error={j.error} onRetry={j.reload} />}
      {j.data && (
        <DataTable rows={j.data.days} rowKey={(d) => d.date} caption="Vérifications par jour"
          empty={<EmptyState title="Aucune vérification enregistrée." icon="qr" />}
          columns={[
            { key: 'date', label: 'Jour', primary: true, render: (d) => <span><strong>{fmtDate(d.date)}</strong><span className="small muted tr-block">{d.total} vérification(s) · {d.distinctClients} poste(s)</span></span> },
            ...COLS.map(([k, label]) => ({ key: k, label, num: true, render: (d: Journal['days'][number]) => d.byStatus[k] ?? 0 })),
          ]} />
      )}
    </section>
  );
}
