/**
 * Transparence publique — compléments du module 54 : parts de répartition par catégorie de bénéficiaire (§ 37A.6),
 * agrégées et publiques ; indicateurs de suivi (consultations, publications à temps) pour les autorités.
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { currentQuarter, Section } from './shared';
import { hasRole } from './planif';
import { Indicateurs, montants, type Indicator } from '../decision/commun';

interface Shares { period: string; mode: string; notice: string; suppressed: boolean; threshold: number; byCategory: { code: string; label: string; pct: string; amounts: MoneyJSON[] }[]; method: string }
interface Suivi { indicators: Indicator[]; quarters: { period: string; due: string; publishedAt: string | null; onTime: boolean | null }[]; params: { publicationDelayDays: number; status: string } }

export function PartsRepartition() {
  const [period, setPeriod] = useState(currentQuarter());
  const q = useApi(() => api<Shares>(`/v1/public/transparence/repartition/${period}`), [period]);
  return (
    <Section title="Parts de répartition par catégorie de bénéficiaire (§ 37A.6)" sub={q.data ? `${q.data.notice} ${q.data.method}` : 'Recettes rapprochées du trimestre, agrégées.'} tools={<input aria-label="Trimestre" value={period} onChange={(e) => setPeriod(e.target.value)} size={9} />}>
      {q.data && (q.data.suppressed
        ? <p className="muted">Trimestre masqué : moins de {q.data.threshold} contributeurs (protection contre la ré-identification).</p>
        : (<>
          <StatusBadge tone={q.data.mode === 'CLE_ACTIVE' ? 'good' : 'warning'} label={q.data.mode === 'CLE_ACTIVE' ? 'Clé en vigueur' : 'Simulation — acte requis'} />
          <DataTable caption="Parts" rows={q.data.byCategory} rowKey={(c) => c.code} columns={[
            { key: 'l', label: 'Bénéficiaire', primary: true, render: (c) => c.label },
            { key: 'p', label: 'Part', num: true, render: (c) => `${c.pct} %` },
            { key: 'm', label: 'Montants', num: true, render: (c) => montants(c.amounts) },
          ]} />
        </>))}
    </Section>
  );
}

export function SuiviTransparence() {
  const { user } = useApp();
  const allowed = hasRole(user?.roles, 'R01', 'R05', 'R22', 'R23');
  const q = useApi(allowed ? () => api<Suivi>('/v1/decision/transparence') : null, [user?.id]);
  if (!allowed || !q.data) return null;
  return (
    <Section title="Suivi de la transparence (autorités)" sub={`Délai de publication : ${q.data.params.publicationDelayDays} jours après la fin du trimestre (${q.data.params.status}).`}>
      <Indicateurs items={q.data.indicators} />
      <DataTable caption="Trimestres" rows={q.data.quarters} rowKey={(x) => x.period} empty={<p className="muted">Aucun trimestre échu.</p>} columns={[
        { key: 'p', label: 'Trimestre', primary: true, render: (x) => x.period },
        { key: 'd', label: 'Échéance', render: (x) => x.due },
        { key: 'u', label: 'Publié le', render: (x) => x.publishedAt?.slice(0, 10) ?? '—' },
        { key: 'o', label: 'À temps', render: (x) => (x.onTime === null ? 'en cours' : <StatusBadge tone={x.onTime ? 'good' : 'critical'} label={x.onTime ? 'Oui' : 'Non'} />) },
      ]} />
    </Section>
  );
}
