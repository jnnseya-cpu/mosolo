/**
 * Centres agréés et tiers de confiance (module 84 — n° 61 du catalogue du maître d'ouvrage du 27/09/2026).
 * Agrément à deux personnes, habilitations datées, quotas, analytique de conformité (alertes seulement), suspension
 * UNIQUEMENT par décision motivée de la RFCK (jamais automatique), propagée aux terminaux de contrôle.
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import { Section } from '../pilotage/shared';
import { Callout, Notice, useRunner } from '../pilotage/planif';
import { hasRole, NOTE_NUMEROTATION, pct, StateBadge, Tile, Tiles } from './common';
import { CentresVisuels } from './visuels';

interface Centre {
  id: string; publicCode: string; name: string; kindLabel: string; commune: string; status: string; categories: string[]; activities: string[];
  habilitation?: { from: string; to: string }; quotas: { stockVignettes: number; inspectionsParJour: number }; suspension?: { motif: string; at: string }; exemple?: boolean;
}
interface Analytics {
  rows: { centreId: string; name: string; status: string; inspections: number; passRate: number | null; peerRate: number | null; favorable: number; stickersConsumed: number; shortInspections: number; outsideHours: number; series: number }[];
  byPoint: { point: string; label: string; centres: { centreId: string; name: string; ratePct: number | null }[] }[];
  alerts: { centreId: string; label: string; detail: string }[];
  notice: string;
}

export default function CentresAgrees() {
  const { user } = useApp();
  const list = useApi(() => api<{ items: Centre[]; indicators: { actifs: number; suspendus: number; enInstruction: number } }>('/v1/centres-agrees'), [user?.id]);
  const an = useApi(() => (hasRole(user?.roles, 'R06', 'R07', 'R22', 'R23', 'R24') ? api<Analytics>('/v1/centres-agrees/analytique') : Promise.resolve(null)), [user?.id]);
  const reload = () => { list.reload(); an.reload(); };
  const r = useRunner(reload);
  const [sus, setSus] = useState({ id: '', motif: '', legalRef: '' });

  if (!user) return <div className="page"><PageHead title="Centres agréés et tiers de confiance" /><p className="notice">Connectez-vous.</p></div>;
  const conform = an.data?.rows.filter((x) => x.passRate !== null) ?? [];
  return (
    <div className="page page-wide">
      <PageHead eyebrow={`Chaîne véhicule · module 84 (${NOTE_NUMEROTATION})`} title="Centres agréés et tiers de confiance" lead="Centres de contrôle technique, opérateurs de fourrière et autres tiers de confiance : agrément, habilitations, quotas et conformité." />
      <Notice msg={r.msg} />
      <CentresVisuels ind={list.data?.indicators} items={list.data?.items} an={an.data} loading={list.loading} error={list.error} onRetry={reload} />
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorState error={list.error} onRetry={reload} /> : list.data && (
        <>
          <Tiles>
            <Tile label="Centres actifs" value={list.data.indicators.actifs} />
            <Tile label="Centres suspendus" value={list.data.indicators.suspendus} />
            <Tile label="Agréments en instruction" value={list.data.indicators.enInstruction} />
            <Tile label="Taux de conformité (pairs)" value={pct(conform[0]?.peerRate ?? null)} hint="Part des contrôles favorables, tous centres" />
            <Tile label="Alertes d’analytique" value={an.data?.alerts.length ?? '—'} />
          </Tiles>
          <div className="dash-grid">
            <Section title="Centres et tiers de confiance">
              <Callout tone="warn">Suspension uniquement par décision motivée de la RFCK, jamais automatique ; elle est propagée immédiatement aux terminaux de contrôle.</Callout>
              <DataTable caption="Centres" rows={list.data.items} rowKey={(c) => c.id} empty={<EmptyState title="Aucun centre" icon="building" />} columns={[
                { key: 'n', label: 'Centre', primary: true, render: (c) => <><strong>{c.name}</strong><span className="small muted" style={{ display: 'block' }}>{c.kindLabel} · {c.commune} · {c.publicCode}</span></> },
                { key: 's', label: 'Statut', render: (c) => <><StateBadge state={c.status} />{c.suspension && <span className="small muted" style={{ display: 'block' }}>{c.suspension.motif}</span>}</> },
                { key: 'h', label: 'Habilitation', render: (c) => (c.habilitation ? `${c.habilitation.from} → ${c.habilitation.to}` : '—') },
                { key: 'q', label: 'Quotas', render: (c) => `${c.quotas.stockVignettes} vignettes · ${c.quotas.inspectionsParJour} contrôles / jour` },
                { key: 'a', label: 'Actions', render: (c) => (hasRole(user.roles, 'R06') && c.status === 'AGREE' ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSus({ ...sus, id: c.id })}>Suspendre (décision motivée)</button> : null) },
              ]} />
              {sus.id && (
                <div className="vc-form">
                  <h3>Suspension motivée — {sus.id}</h3>
                  <label><span>Motif</span><input value={sus.motif} onChange={(e) => setSus({ ...sus, motif: e.target.value })} /></label>
                  <label><span>Référence (convention, acte)</span><input value={sus.legalRef} onChange={(e) => setSus({ ...sus, legalRef: e.target.value })} /></label>
                  <button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/centres-agrees/${sus.id}/suspension`, { motif: sus.motif, legalRef: sus.legalRef }, 'Suspension décidée et propagée aux terminaux.')}>Décider la suspension</button>
                </div>
              )}
            </Section>
            {an.data && (
              <Section title="Analytique de conformité" sub={an.data.notice} tools={hasRole(user.roles, 'R06', 'R07') ? <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy} onClick={() => void r.run('/v1/centres-agrees/analytique/alertes', {}, 'Alertes levées pour examen humain.')}>Lever les alertes</button> : undefined}>
                <DataTable caption="Taux de réussite comparé aux pairs" rows={an.data.rows} rowKey={(x) => x.centreId} columns={[
                  { key: 'n', label: 'Centre', primary: true, render: (x) => x.name },
                  { key: 'i', label: 'Contrôles', num: true, render: (x) => x.inspections },
                  { key: 't', label: 'Taux de réussite', num: true, render: (x) => `${pct(x.passRate)} (pairs ${pct(x.peerRate)})` },
                  { key: 'v', label: 'Favorables / vignettes', num: true, render: (x) => `${x.favorable} / ${x.stickersConsumed}` },
                  { key: 'd', label: 'Durées courtes · hors horaires · séries', render: (x) => `${x.shortInspections} · ${x.outsideHours} · ${x.series}` },
                ]} />
                <DataTable caption="Non-conformités par point et par centre" rows={an.data.byPoint} rowKey={(p) => p.point} columns={[
                  { key: 'p', label: 'Point de l’arrêté', primary: true, render: (p) => p.label },
                  { key: 'c', label: 'Taux de non-conformité par centre', render: (p) => <span className="small">{p.centres.map((c) => `${c.name} : ${pct(c.ratePct)}`).join(' · ')}</span> },
                ]} />
                {an.data.alerts.length > 0 && <ul>{an.data.alerts.map((a, k) => <li key={k} className="small"><strong>{a.label}</strong> — {a.detail}</li>)}</ul>}
              </Section>
            )}
          </div>
        </>
      )}
    </div>
  );
}
