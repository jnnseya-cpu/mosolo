/**
 * Catalogue public des titres (§ 19A.4) : types du moteur de titres, modèle de validité, supports, statut de l'acte.
 * Les types « acte requis » (vignette, TSCR, licences, patente, péage, bon de carrière, embarquement, accostage) sont
 * visibles mais non activables : aucun prix n'est affiché tant qu'une règle ACTIVE n'existe pas.
 * Visuels par module (module 70) : couleur d'accent, pictogramme et préfixe propres au service.
 * Indicateurs des modules 70 et 71 (titres actifs, renouvellements en phase ambre, contrôles, taux de rouge,
 * réutilisations détectées, contrôles sans terminal enregistré) : visibles des autorités, de la régie et de l'audit.
 */
import type { ReactNode } from 'react';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { ErrorState, Loading } from '../../components/States';
import { MoneyText } from '../../components/MoneyText';
import { Icon, type IconName } from '../../components/Icon';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import type { MoneyJSON } from '@mosolo/shared';
import { CatalogueVisuel, IndicateursTitresVisuel } from './visuels';

interface TypeView {
  code: string; module: string; moduleLabel: string; label: string; prefix: string; plateBound: boolean; supports: string[]; demo: boolean;
  validity: { modelLabel: string; modelRule: string }; legalAct: { ref: string; status: string; note: string };
  activable: boolean; notActivableReason?: string; price: { amount: MoneyJSON | null; demo: boolean };
  visual?: { color: string; colorName: string; pictogram: string; prefix: string };
}

interface TitresIndicators {
  serverTime: string; module: string;
  credentials: { total: number; active: number; byStatus: Record<string, number> };
  controls: {
    total: number; valid: number; expired: number; invalid: number; offline: number; redShare: string; controlledOverActive: string; reuseAttempts: number;
    withRegisteredTerminal?: number; withoutRegisteredTerminal?: number;
  };
  renewals: { total: number; beforeExpiry: number };
  constats: { total: number; open: number; classified: number; transmitted: number };
}

const INDICATOR_ROLES = ['R01', 'R02', 'R05', 'R06', 'R07', 'R22', 'R23', 'R36'];
const pct = (s: string) => `${(Number(s) * 100).toFixed(1)} %`;

function Kpi({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return <div className="kpi"><span className="kpi-label">{label}</span><span className="kpi-value">{value}</span>{sub && <span className="kpi-sub">{sub}</span>}</div>;
}

function IndicatorsPanel() {
  const q = useApi(() => api<TitresIndicators>('/v1/titres/indicateurs'), []);
  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data;
  if (!d) return null;
  return (
    <section className="panel" aria-labelledby="tt-ind">
      <header className="panel-head"><div><h2 className="panel-title" id="tt-ind"><Icon name="gauge" size={18} /> Indicateurs des titres et des contrôles</h2><p className="panel-sub">Calculés à l’heure du serveur sur les titres émis et le journal des contrôles.</p></div></header>
      <div className="kpi-row">
        <Kpi label="Titres actifs" value={d.credentials.active} sub={`${d.credentials.total} émis au total`} />
        <Kpi label="Renouvellements en phase ambre" value={d.renewals.beforeExpiry} sub={`${d.renewals.total} renouvellement(s)`} />
        <Kpi label="Contrôles" value={d.controls.total} sub={`${d.controls.offline} hors ligne · ${d.controls.valid} valides`} />
        <Kpi label="Taux de rouge" value={pct(d.controls.redShare)} sub={`${d.controls.expired} expiré(s) · ${d.controls.invalid} invalide(s)`} />
        <Kpi label="Réutilisations détectées" value={d.controls.reuseAttempts} sub="usage unique présenté de nouveau" />
        {d.controls.withoutRegisteredTerminal !== undefined && <Kpi label="Contrôles sans terminal enregistré" value={d.controls.withoutRegisteredTerminal} sub={`${d.controls.withRegisteredTerminal ?? 0} depuis un terminal enregistré`} />}
      </div>
      <IndicateursTitresVisuel d={d} />
      <p className="small muted">Statuts : {Object.entries(d.credentials.byStatus).map(([k, n]) => `${k.replace(/_/g, ' ').toLowerCase()} ${n}`).join(' · ') || 'aucun titre'}. Constats : {d.constats.open} ouvert(s), {d.constats.classified} classé(s), {d.constats.transmitted} transmis — aucune pénalité automatique à l’expiration.</p>
    </section>
  );
}

export default function TitresCatalogue() {
  const { user } = useApp();
  const q = useApi(() => api<TypeView[]>('/v1/titres/types'), []);
  const rows = (q.data ?? []).slice().sort((a, b) => Number(a.module) - Number(b.module) || a.code.localeCompare(b.code));
  const canIndicators = !!user?.roles.some((r) => INDICATOR_ROLES.includes(r));
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Titres et laissez-passer (§ 19A)" title="Catalogue des titres"
        lead="Chaque titre prouve un droit ouvert et reste adossé à une quittance. Un type sans acte adopté est visible mais ne peut pas être vendu." />
      {canIndicators && <IndicatorsPanel />}
      {q.loading && <Loading />}
      {!!q.error && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && <CatalogueVisuel types={q.data} />}
      {q.data && (
        <DataTable rows={rows} rowKey={(t) => t.code}
          columns={[
            { key: 'm', label: 'Module', render: (t) => `${t.module} — ${t.moduleLabel}` },
            {
              key: 'l', label: 'Titre', primary: true, render: (t) => (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  {t.visual && <span aria-hidden="true" title={`Couleur du service : ${t.visual.colorName}`} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 6, background: t.visual.color, color: '#fff' }}><Icon name={t.visual.pictogram as IconName} size={14} /></span>}
                  <span>{t.label} <span className="mono small muted">{t.prefix}</span></span>
                </span>
              ),
            },
            { key: 'v', label: 'Validité', render: (t) => <span title={t.validity.modelRule}>{t.validity.modelLabel}{t.plateBound ? ' · lié à la plaque' : ''}</span> },
            { key: 's', label: 'Supports', render: (t) => t.supports.map((s) => s.toLowerCase().replace('_', ' ')).join(', ') },
            { key: 'a', label: 'Acte', render: (t) => <StatusBadge tone={t.activable ? 'good' : t.legalAct.status === 'ACTE_REQUIS' ? 'info' : 'warning'} label={t.activable ? 'Activable' : t.legalAct.status === 'ACTE_REQUIS' ? `Acte requis (${t.legalAct.ref})` : 'Non activable'} title={t.notActivableReason ?? t.legalAct.note} /> },
            { key: 'p', label: 'Tarif (règle du registre)', num: true, render: (t) => t.price.amount ? <span><MoneyText money={t.price.amount} />{t.price.demo ? <span className="small muted"> (démonstration)</span> : null}</span> : '—' },
          ]} />
      )}
    </div>
  );
}
