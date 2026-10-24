/**
 * ParkSmart (module 75) — tarification dynamique AUTOMATIQUE à l'intérieur des fourchettes fixées par l'acte
 * (minimum / maximum par zone et par heure, pas d'ajustement), pour maintenir 15 à 25 % de places libres.
 * Hors fourchette ou sans acte : recommandation seulement (onglet « Occupation et recommandations »).
 */
import { useApp } from '../../context';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { DemoTag, ErrorLine, hasRole, useAction } from './shared';
import { TarifHeuresViz } from './visuels';

export interface DynamicZone {
  zoneId: string; code: string; name: string; commune: string; demo: boolean; mode: 'AUTOMATIQUE' | 'RECOMMANDATION_SEULEMENT'; reason: string;
  rule: { code: string; version: number; demo: boolean; currency: string } | null; currentHour: number; currentRate: string | null;
  hours: { hour: number; band: { min: string; max: string; step: string | null } | null; rate: string | null; lastEvaluated: string | null }[];
  history: { at: string; hour: number; from: string; to: string; freeRate: string | null; reason: string; trigger: string }[];
}
export interface DynamicView {
  target: { minPct: number; maxPct: number }; scheduler: { active: boolean; frequency: string }; notice: string;
  zones: DynamicZone[];
  runs: { id: string; date: string; hour: number; trigger: string; at: string; adjusted: { zoneId: string; from: string; to: string }[]; recommendationOnly: { zoneId: string; reason: string }[] }[];
}

const hh = (h: number) => `${String(h).padStart(2, '0')} h`;

export function TarificationDynamiqueTab() {
  const { user, fmtDate } = useApp();
  const q = useApi(() => api<DynamicView>('/v1/parking/tarification-dynamique'), [user?.id]);
  const act = useAction();
  const canRun = hasRole(user?.roles, 'R06', 'R07');
  if (q.loading && !q.data) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data;
  return (
    <div className="stack">
      <div className="callout callout-info"><Icon name="scale" size={18} /><p>{d.notice}</p></div>
      <section className="panel">
        <h2 className="panel-title"><Icon name="clock" size={18} /> Planificateur</h2>
        <p className="small">Cible : {d.target.minPct} à {d.target.maxPct} % de places libres · {d.scheduler.frequency} · {d.scheduler.active ? 'actif' : 'inactif sur ce serveur'}</p>
        {canRun && <button type="button" className="btn" disabled={act.busy} onClick={() => void act.run(() => api('/v1/parking/tarification-dynamique/run', { method: 'POST', body: {} }), () => q.reload())}>Évaluer l’heure écoulée</button>}
        <ErrorLine error={act.error} />
      </section>
      {d.zones.length === 0 ? <EmptyState title="Aucune zone" /> : d.zones.map((z) => (
        <section key={z.zoneId} className="panel" aria-label={`Zone ${z.code}`}>
          <header className="panel-head">
            <div><h3 className="panel-title">{z.name} <span className="mono small">{z.code}</span> {(z.demo || z.rule?.demo) && <DemoTag label="[EXEMPLE]" />}</h3><p className="pk-sub">{z.commune} · {z.reason}</p></div>
            <StatusBadge tone={z.mode === 'AUTOMATIQUE' ? 'good' : 'neutral'} label={z.mode === 'AUTOMATIQUE' ? 'Tarif automatique (fourchettes de l’acte)' : 'Recommandation seulement'} />
          </header>
          {z.mode === 'AUTOMATIQUE' && (
            <>
              <p className="small">Tarif en vigueur à {hh(z.currentHour)} : <strong>{z.currentRate ?? '—'} {z.rule?.currency}</strong> / unité de la formule (règle {z.rule?.code} v{z.rule?.version})</p>
              <TarifHeuresViz code={z.code} currency={z.rule?.currency} hours={z.hours} example={z.demo || !!z.rule?.demo} />
              <DataTable caption={`Fourchettes et tarifs par heure — ${z.code}`} rows={z.hours.filter((h) => h.band)} rowKey={(h) => String(h.hour)} columns={[
                { key: 'h', label: 'Heure', render: (h) => hh(h.hour) },
                { key: 'min', label: 'Minimum (acte)', num: true, render: (h) => h.band!.min },
                { key: 'max', label: 'Maximum (acte)', num: true, render: (h) => h.band!.max },
                { key: 'step', label: 'Pas', num: true, render: (h) => h.band!.step ?? 'non fixé' },
                { key: 'rate', label: 'Tarif appliqué', num: true, render: (h) => h.rate ?? '—' },
              ]} />
              {z.history.length > 0 && (
                <ul className="list-rows">{z.history.map((x) => <li key={`${x.at}-${x.hour}`} className="list-row"><span className="small">{fmtDate(x.at, true)} · {hh(x.hour)} : {x.from} → {x.to}</span><span className="pk-sub">{x.reason}</span></li>)}</ul>
              )}
            </>
          )}
        </section>
      ))}
    </div>
  );
}
