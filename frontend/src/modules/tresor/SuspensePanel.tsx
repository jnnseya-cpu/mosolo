import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { DataTable } from '../../components/DataTable';
import { MoneyText } from '../../components/MoneyText';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { api } from '../../lib/api';
import type { SuspenseList } from './shared';
import { SuspensVisuel } from './visuels';

export default function SuspensePanel() {
  const { user, fmtDate } = useApp();
  const s = useApi(() => api<SuspenseList>('/v1/tresor/suspense'), [user?.id]);
  return (
    <section className="panel" aria-labelledby="susp-title">
      <header className="panel-head">
        <div><h2 className="panel-title" id="susp-title">Compte d’attente (suspens)</h2>
          <p className="panel-sub">Fonds arrivés sur un compte public mais non identifiés : datés, justifiés, apurés en double validation (cible : {s.data?.slaDays ?? 5} jours, jamais plus de {s.data?.maxDays ?? 30} jours sans décision).</p></div>
      </header>
      {s.loading && <Loading />}
      {s.error !== null && <ErrorState error={s.error} onRetry={s.reload} />}
      {s.data && (
        <>
          <SuspensVisuel s={s.data} />
          <dl className="tr-buckets">
            {s.data.buckets.map((b) => (
              <div key={b.bucket} className={b.bucket.startsWith('>') && b.count > 0 ? 'tr-bucket tr-bucket-late' : 'tr-bucket'}>
                <dt>{b.bucket}</dt>
                <dd>{b.count}<span className="small muted tr-block">{b.amounts.length ? b.amounts.map((m) => <MoneyText key={m.currency} money={m} showIndicative={false} />) : '—'}</span></dd>
              </div>
            ))}
          </dl>
          {s.data.items.some((i) => i.demo) && <ExampleNotice text="Le suspens marqué « démonstration » est fictif (relevé de démonstration)." />}
          <DataTable rows={s.data.items} rowKey={(i) => i.id} caption="Suspens"
            empty={<EmptyState title="Aucun fonds en attente d’identification." icon="check" />}
            columns={[
              { key: 'id', label: 'Suspens', primary: true, render: (i) => <span><span className="mono">{i.id}</span>{i.demo && <span className="small muted tr-block">démonstration</span>}</span> },
              { key: 'amount', label: 'Montant', num: true, render: (i) => <MoneyText money={i.amount} showIndicative={false} /> },
              { key: 'acc', label: 'Compte public', render: (i) => <span className="mono small">{i.accountAlias}</span> },
              { key: 'date', label: 'Date de valeur', render: (i) => fmtDate(i.valueDate) },
              { key: 'age', label: 'Ancienneté', render: (i) => (i.status === 'OUVERT'
                ? <StatusBadge tone={i.overMax ? 'critical' : i.overSla ? 'warning' : 'good'} label={`${i.ageDays} j`} />
                : <StatusBadge tone="neutral" label={i.clearing?.mode === 'AFFECTATION' ? `Affecté à ${i.clearing.paymentReference}` : 'Restitué'} />) },
              { key: 'why', label: 'Justification', full: true, render: (i) => <span className="small">{i.justification}</span> },
            ]} />
          <p className="small muted">Apurement : onglet « Double validation », opération « Apurement de suspens ».</p>
        </>
      )}
    </section>
  );
}
