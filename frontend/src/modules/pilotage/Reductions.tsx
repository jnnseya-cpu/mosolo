/**
 * Réductions de recettes : brut liquidé, réductions par voie (exonération, remise, dégrèvement, non-valeur…), net
 * attendu, encaissé, par devise (jamais additionnées entre devises), par commune et par décideur ; recettes
 * potentielles non liquidées (assiette seule, aucun montant estimé) ; détection de concentration (signaux proposés à
 * l'examen humain, aucune mesure automatique).
 */
import { useEffect, useId, useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { api, describeError } from '../../lib/api';
import { COMMUNES, ENTITIES, qs, ScopeLine, Section, useFmt, type Scope } from './shared';
import './pilotage.css';

export const REDUCTION_TYPE_LABELS: Record<string, string> = {
  EXONERATION: 'Exonération appliquée à la liquidation', MINORATION_LIQUIDATION: 'Minoration à la liquidation (forçage de base)',
  REMISE: 'Remise gracieuse', RECLAMATION: 'Dégrèvement sur réclamation', CORRECTION_DECLARATION: 'Correction de déclaration',
  RECALCUL: 'Recalcul contrôlé (nouvelle version de règle)', AUTRE_RECTIFICATION: 'Autre rectification', ANNULATION: 'Annulation',
  ADMISSION_NON_VALEUR: 'Admission en non-valeur',
};

interface TypeAmount { type: string; label?: string; count: number; amount: MoneyJSON }
export interface CurrencyBlock {
  currency: string; chains: number; grossAssessed: MoneyJSON; reductions: { total: MoneyJSON; count: number; byType: TypeAmount[] };
  netExpected: MoneyJSON; collected: MoneyJSON; outstanding: MoneyJSON;
  reconciliation: { grossMinusReductions: MoneyJSON; netExpected: MoneyJSON; gap: MoneyJSON; reconciled: boolean; tolerance: string; otherReductions?: MoneyJSON };
}
interface DeciderRow { deciderId: string; traced: boolean; count: number; communes: string[]; totals: { currency: string; count: number; amount: MoneyJSON; byType: TypeAmount[] }[] }
interface PotentialRow { vertical: string; commune: string; legalStatus: string; reason: string; ruleCode: string | null; units: number; surfaceM2: string | null; unitsWithSurface: number }
interface AlertParams { demo: boolean; deciderShare: string; minReductionsInGroup: number; taxpayerThreshold: Record<string, string> }
export interface ReductionReport {
  generatedAt: string; scope: Scope; method: string; formula: string;
  totals: CurrencyBlock[]; reconciled: boolean;
  byCommune: { commune: string; totals: CurrencyBlock[] }[]; byModule: { module: string; totals: CurrencyBlock[] }[];
  byDecider: DeciderRow[]; untracedDeciders: number;
  unmatchedDeclaredReductions: { auditId: string; at: string; path: string; obligationId: string; deciderId: string | null; reason: string }[];
  currencyAnomalies: string[];
  potentialUnassessed: { note: string; units: number; byVertical: { vertical: string; units: number; communes: number }[]; rows: PotentialRow[] };
  signals: { raised: number; open: number; params: AlertParams };
}
export interface ReductionSignal { kind: 'DECIDEUR_CONCENTRE' | 'CUMUL_CONTRIBUABLE'; fingerprint: string; detail: string; context: Record<string, unknown> }
interface Detection { raised: number; signals: ReductionSignal[]; params: AlertParams; automaticEffect: 'AUCUN' }
interface ServerFilters { period?: string; commune?: string; entity?: string; type?: string; decideur?: string }

/** Filtres du rapport : tous appliqués par le serveur (totaux compris). */
function Filters({ value, onChange, agents, lock }: { value: ServerFilters; onChange: (f: ServerFilters) => void; agents: string[]; lock?: Scope | null }) {
  const id = useId();
  const set = (k: keyof ServerFilters, v: string) => onChange({ ...value, [k]: v || undefined });
  const year = new Date().getUTCFullYear();
  const periods = [String(year), `${year}-T1`, `${year}-T2`, `${year}-T3`, `${year}-T4`, String(year - 1)];
  const communes = lock?.communes ?? COMMUNES;
  return (
    <form className="pl-filters" onSubmit={(e) => e.preventDefault()} aria-label="Filtres du rapport">
      <label className="pl-filter" htmlFor={`${id}-p`}><span>Période</span>
        <select id={`${id}-p`} value={value.period ?? ''} onChange={(e) => set('period', e.target.value)}>
          <option value="">Depuis l’origine</option>
          {periods.map((p) => <option key={p} value={p}>{p.includes('-T') ? `Trimestre ${p.replace('-', ' ')}` : `Exercice ${p}`}</option>)}
        </select>
      </label>
      <label className="pl-filter" htmlFor={`${id}-c`}><span>Commune</span>
        <select id={`${id}-c`} value={value.commune ?? ''} onChange={(e) => set('commune', e.target.value)}>
          <option value="">{lock?.communes ? 'Tout le périmètre' : 'Toutes'}</option>
          {communes.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </label>
      <label className="pl-filter" htmlFor={`${id}-e`}><span>Administration</span>
        <select id={`${id}-e`} value={lock?.entity ?? value.entity ?? ''} disabled={!!lock?.entity} onChange={(e) => set('entity', e.target.value)}>
          <option value="">Toutes</option>
          {[...new Set([...(lock?.entity ? [lock.entity] : []), ...ENTITIES])].map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
      </label>
      <label className="pl-filter" htmlFor={`${id}-t`}><span>Type de réduction</span>
        <select id={`${id}-t`} value={value.type ?? ''} onChange={(e) => set('type', e.target.value)}>
          <option value="">Tous</option>
          {Object.entries(REDUCTION_TYPE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      <label className="pl-filter" htmlFor={`${id}-a`}><span>Décideur</span>
        <select id={`${id}-a`} value={value.decideur ?? ''} onChange={(e) => set('decideur', e.target.value)}>
          <option value="">Tous</option>
          {[...new Set([...(value.decideur ? [value.decideur] : []), ...agents])].map((a) => <option key={a} value={a}>{a === 'NON_TRACE' ? 'Non tracé' : a}</option>)}
        </select>
      </label>
      {(value.period || value.commune || value.entity || value.type || value.decideur) && (
        <button type="button" className="btn btn-ghost btn-sm pl-reset" onClick={() => onChange({})}><Icon name="x" size={16} /> Effacer</button>
      )}
    </form>
  );
}

function SignalList({ signals }: { signals: ReductionSignal[] }) {
  if (!signals.length) return <EmptyState title="Aucune anomalie détectée" icon="check">Aucune concentration au-delà des seuils de démonstration.</EmptyState>;
  return (
    <ul className="list-rows">
      {signals.map((s) => (
        <li key={s.fingerprint} className="list-row list-row-stack">
          <span className="row-title"><StatusBadge tone="warning" label={s.kind === 'DECIDEUR_CONCENTRE' ? 'Décideur concentré' : 'Cumul par contribuable'} /> <span className="mono small">{s.fingerprint}</span></span>
          <span className="small">{s.detail}</span>
        </li>
      ))}
    </ul>
  );
}

export default function Reductions() {
  const { user } = useApp();
  const f = useFmt();
  const roles = user?.roles ?? [];
  const canDetect = roles.some((r) => r === 'R22' || r === 'R24');
  const [filters, setFilters] = useState<ServerFilters>({});
  // Liste des décideurs connue sans filtre décideur (la réponse filtrée n'en contient qu'un).
  const [agents, setAgents] = useState<string[]>([]);
  const q = useApi(() => api<ReductionReport>(`/v1/pilotage/reductions${qs({ ...filters })}`), [user?.id, JSON.stringify(filters)]);
  const [det, setDet] = useState<{ busy: boolean; result: Detection | null; err: string | null }>({ busy: false, result: null, err: null });
  async function detect() {
    setDet({ busy: true, result: null, err: null });
    try { setDet({ busy: false, result: await api<Detection>('/v1/pilotage/reductions/detection', { method: 'POST' }), err: null }); q.reload(); }
    catch (e) { const d = describeError(e); setDet({ busy: false, result: null, err: d.message + (d.code ? ` (${d.code})` : '') }); }
  }
  const d = q.data;
  useEffect(() => {
    if (d && !filters.decideur) setAgents(d.byDecider.map((r) => r.deciderId));
  }, [d, filters.decideur]);
  const byType = (d?.totals ?? []).flatMap((t) => t.reductions.byType.map((x) => ({ ...x, currency: t.currency })));
  const filtered = !!(filters.type || filters.decideur);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Pilotage · réductions de recettes" title="Réductions de recettes" lead="Toute réduction d’une obligation (exonération, remise, dégrèvement, correction, annulation, non-valeur) est tracée avec son décideur. Montants réels par devise ; les signaux de concentration sont proposés à l’examen humain, sans effet automatique.">
        {canDetect && <button type="button" className="btn btn-secondary" disabled={det.busy} onClick={() => void detect()}><Icon name="analysis" size={16} /> Lancer la détection</button>}
      </PageHead>
      <Filters value={filters} onChange={setFilters} agents={agents} lock={d?.scope ?? null} />
      {det.err && <p className="notice notice-err" role="alert">{det.err}</p>}
      {det.result && (
        <Section title="Anomalies détectées" sub={`${det.result.signals.length} signal(aux) · ${det.result.raised} nouvelle(s) alerte(s) levée(s) · effet automatique : ${det.result.automaticEffect === 'AUCUN' ? 'aucun' : det.result.automaticEffect}`}>
          <SignalList signals={det.result.signals} />
        </Section>
      )}
      {q.loading && !d ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : d && (
        <div className="dash-grid">
          <div className="span-12">
            <ScopeLine scope={d.scope} generatedAt={d.generatedAt} />
            <p className="small muted">{d.method} Formule : {d.formula}.{filtered ? ' Filtre type / décideur : chaînes portant au moins une réduction retenue ; leurs autres réductions n’entrent que dans le rapprochement.' : ''}</p>
          </div>
          <Section title="Totaux par devise" sub={d.reconciled ? 'Rapprochement brut − réductions = net vérifié' : 'Écart de rapprochement à examiner'}>
            {d.totals.length === 0 ? <EmptyState title="Aucune obligation liquidée sur la période" icon="chart" /> : (
              <DataTable caption="Totaux par devise" rows={d.totals} rowKey={(t) => t.currency} columns={[
                { key: 'c', label: 'Devise', primary: true, render: (t) => <strong>{t.currency}</strong> },
                { key: 'g', label: 'Brut liquidé', num: true, render: (t) => f.money(t.grossAssessed) },
                { key: 'r', label: 'Réductions', num: true, render: (t) => <>{f.money(t.reductions.total)} <span className="small muted">({t.reductions.count})</span>{t.reconciliation.otherReductions && <><br /><span className="small muted">autres réductions : {f.money(t.reconciliation.otherReductions)}</span></>}</> },
                { key: 'n', label: 'Net attendu', num: true, render: (t) => f.money(t.netExpected) },
                { key: 'e', label: 'Encaissé', num: true, render: (t) => f.money(t.collected) },
                { key: 'o', label: 'Reste à recouvrer', num: true, render: (t) => f.money(t.outstanding) },
                { key: 'k', label: 'Rapprochement', render: (t) => <StatusBadge tone={t.reconciliation.reconciled ? 'good' : 'critical'} label={t.reconciliation.reconciled ? 'Rapproché' : `Écart ${f.money(t.reconciliation.gap)}`} /> },
              ]} />
            )}
          </Section>
          <Section title="Par type de réduction">
            <DataTable caption="Réductions par type" rows={byType} rowKey={(x) => `${x.type}-${x.currency}`} empty={<EmptyState title="Aucune réduction" icon="check" />} columns={[
              { key: 't', label: 'Type', primary: true, render: (x) => x.label ?? REDUCTION_TYPE_LABELS[x.type] ?? x.type },
              { key: 'n', label: 'Nombre', num: true, render: (x) => x.count },
              { key: 'm', label: 'Montant', num: true, render: (x) => f.money(x.amount) },
            ]} />
          </Section>
          <Section title="Par commune" sub={filters.type ? `Réductions de type « ${REDUCTION_TYPE_LABELS[filters.type] ?? filters.type} »` : undefined}>
            <DataTable caption="Réductions par commune" rows={d.byCommune} rowKey={(c) => c.commune} empty={<EmptyState title="Aucune commune" icon="pin" />} columns={[
              { key: 'c', label: 'Commune', primary: true, render: (c) => c.commune === 'NON_ATTRIBUE' ? 'Lieu non établi' : c.commune },
              { key: 'g', label: 'Brut liquidé', num: true, render: (c) => f.amounts(c.totals.map((t) => t.grossAssessed)) },
              { key: 'r', label: 'Réductions', num: true, render: (c) => <>{f.amounts(c.totals.filter((t) => t.reductions.count).map((t) => t.reductions.total))} <span className="small muted">({c.totals.reduce((n, t) => n + t.reductions.count, 0)})</span></> },
              { key: 'n', label: 'Net attendu', num: true, render: (c) => f.amounts(c.totals.map((t) => t.netExpected)) },
            ]} />
          </Section>
          <Section title="Par décideur" sub={d.untracedDeciders ? `${d.untracedDeciders} réduction(s) sans décideur tracé — signalées, jamais attribuées par défaut` : 'Décideur tracé pour chaque réduction'}>
            <DataTable caption="Réductions par décideur" rows={d.byDecider} rowKey={(r) => r.deciderId} empty={<EmptyState title="Aucun décideur" icon="users" />} columns={[
              { key: 'a', label: 'Décideur', primary: true, render: (r) => r.traced ? <span className="mono">{r.deciderId}</span> : <StatusBadge tone="serious" label="Non tracé" /> },
              { key: 'n', label: 'Nombre', num: true, render: (r) => r.count },
              { key: 'm', label: 'Montant', num: true, render: (r) => f.amounts(r.totals.map((t) => t.amount)) },
              { key: 'c', label: 'Communes', render: (r) => <span className="small">{r.communes.join(', ')}</span> },
            ]} />
          </Section>
          <Section title="Recettes potentielles non liquidées" sub={d.potentialUnassessed.note}>
            <DataTable caption="Recettes potentielles non liquidées" rows={d.potentialUnassessed.rows} rowKey={(r) => `${r.vertical}-${r.commune}-${r.legalStatus}`} empty={<EmptyState title="Aucune assiette en attente d’acte" icon="check" />} columns={[
              { key: 'v', label: 'Verticale', primary: true, render: (r) => r.vertical },
              { key: 'c', label: 'Commune', render: (r) => r.commune },
              { key: 's', label: 'Statut juridique', render: (r) => <span className="small">{r.legalStatus} — {r.reason}</span> },
              { key: 'u', label: 'Unités', num: true, render: (r) => r.units },
              { key: 'm', label: 'Surface (m²)', num: true, render: (r) => r.surfaceM2 ?? '—' },
            ]} />
          </Section>
          <Section title="Signaux de concentration" sub={`${d.signals.open} signal(aux) ouvert(s)`}>
            <p className="small">Seuils : un décideur au-delà de {Number(d.signals.params.deciderShare) * 100} % des réductions d’une commune sur un mois (au moins {d.signals.params.minReductionsInGroup} réductions) ; cumul par contribuable au-delà de {Object.entries(d.signals.params.taxpayerThreshold).map(([c, v]) => `${v} ${c}`).join(' ou ')}.</p>
            {d.signals.params.demo && <p className="example-notice"><Icon name="info" size={16} /> Seuils de démonstration [EXEMPLE], non opposables : à fixer par le comité anti-fraude.</p>}
            {!canDetect && <p className="small muted">La détection à la demande est réservée à l’audit et à l’anti-fraude (R22, R24).</p>}
          </Section>
          {(d.currencyAnomalies.length > 0 || d.unmatchedDeclaredReductions.length > 0) && (
            <Section title="Anomalies de traçabilité">
              <ul className="list-rows">
                {d.currencyAnomalies.map((a) => <li key={a} className="list-row small">{a}</li>)}
                {d.unmatchedDeclaredReductions.map((u) => <li key={u.auditId} className="list-row list-row-stack small"><span className="mono">{u.obligationId} · {u.path}</span><span className="muted">{u.reason}</span></li>)}
              </ul>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
