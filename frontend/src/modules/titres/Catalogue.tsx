/**
 * Catalogue public des titres (§ 19A.4) : types du moteur de titres, modèle de validité, supports, statut de l'acte.
 * Les types « acte requis » (vignette, TSCR, licences, patente, péage, bon de carrière, embarquement, accostage) sont
 * visibles mais non activables : aucun prix n'est affiché tant qu'une règle ACTIVE n'existe pas.
 */
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { ErrorState, Loading } from '../../components/States';
import { MoneyText } from '../../components/MoneyText';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import type { MoneyJSON } from '@mosolo/shared';

interface TypeView {
  code: string; module: string; moduleLabel: string; label: string; prefix: string; plateBound: boolean; supports: string[]; demo: boolean;
  validity: { modelLabel: string; modelRule: string }; legalAct: { ref: string; status: string; note: string };
  activable: boolean; notActivableReason?: string; price: { amount: MoneyJSON | null; demo: boolean };
}

export default function TitresCatalogue() {
  const q = useApi(() => api<TypeView[]>('/v1/titres/types'), []);
  const rows = (q.data ?? []).slice().sort((a, b) => Number(a.module) - Number(b.module) || a.code.localeCompare(b.code));
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Titres et laissez-passer (§ 19A)" title="Catalogue des titres"
        lead="Chaque titre prouve un droit ouvert et reste adossé à une quittance. Un type sans acte adopté est visible mais ne peut pas être vendu." />
      {q.loading && <Loading />}
      {!!q.error && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && (
        <DataTable rows={rows} rowKey={(t) => t.code}
          columns={[
            { key: 'm', label: 'Module', render: (t) => `${t.module} — ${t.moduleLabel}` },
            { key: 'l', label: 'Titre', primary: true, render: (t) => <span>{t.label} <span className="mono small muted">{t.prefix}</span></span> },
            { key: 'v', label: 'Validité', render: (t) => <span title={t.validity.modelRule}>{t.validity.modelLabel}{t.plateBound ? ' · lié à la plaque' : ''}</span> },
            { key: 's', label: 'Supports', render: (t) => t.supports.map((s) => s.toLowerCase().replace('_', ' ')).join(', ') },
            { key: 'a', label: 'Acte', render: (t) => <StatusBadge tone={t.activable ? 'good' : t.legalAct.status === 'ACTE_REQUIS' ? 'info' : 'warning'} label={t.activable ? 'Activable' : t.legalAct.status === 'ACTE_REQUIS' ? `Acte requis (${t.legalAct.ref})` : 'Non activable'} title={t.notActivableReason ?? t.legalAct.note} /> },
            { key: 'p', label: 'Tarif (règle du registre)', num: true, render: (t) => t.price.amount ? <span><MoneyText money={t.price.amount} />{t.price.demo ? <span className="small muted"> (démonstration)</span> : null}</span> : '—' },
          ]} />
      )}
    </div>
  );
}
