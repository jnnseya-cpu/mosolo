/**
 * Détecteurs complémentaires du plan anti-fraude (§ 25) : écart constats / paiements par zone, baisse inexpliquée des
 * recettes d'une zone, proximité récurrente agent–objet, rotation des zones dépassée ; exécution planifiée qui inclut
 * le contrôle des ruptures de la chaîne opératoire. Alertes à examiner — jamais de sanction automatique.
 */
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { useApp } from '../../context';
import { ActionError, hasRole, Kpi, useAction } from './shared';
import './integrite.css';

interface Signal { code: string; label: string; subject: string; detail: string; fingerprint: string }
export interface DetectorsOverview {
  detectors: { code: string; label: string; vecteur: string; source: string }[];
  params: Record<string, number>; statut: string;
  schedule: { intervalHours: number; active: boolean; lastRunAt: string | null; lastTrigger: string | null; includesChainRuptures: boolean };
  signals: Signal[]; note: string;
}

export function DetecteursView({ o }: { o: DetectorsOverview }) {
  return (
    <>
      <div className="kpi-row ig-kpis">
        <Kpi label="Signaux à examiner" value={o.signals.length} sub="aucun effet automatique" />
        <Kpi label="Exécution planifiée" value={<span className="ig-kpi-text">{o.schedule.intervalHours > 0 ? `Toutes les ${o.schedule.intervalHours} h` : 'Désactivée'}</span>} sub={o.schedule.lastRunAt ? `dernière : ${o.schedule.lastRunAt}` : 'jamais exécutée'} />
        <Kpi label="Ruptures de chaîne" value={<span className="ig-kpi-text">{o.schedule.includesChainRuptures ? 'Contrôlées à chaque exécution' : '—'}</span>} />
      </div>
      <p className="callout callout-info ig-note"><Icon name="info" size={18} /><span>{o.note} Seuils : {o.statut}.</span></p>
      <section className="panel" aria-labelledby="det-sig"><h2 className="panel-title" id="det-sig">Signaux</h2>
        {o.signals.length === 0 ? <EmptyState title="Aucun signal" icon="check">Aucune zone ni aucun agent ne franchit les seuils.</EmptyState> : (
          <ul className="plain-list ig-stack">{o.signals.map((s) => (
            <li key={s.fingerprint} className="ig-block"><p className="ig-inline"><StatusBadge tone={s.code === 'ECART_CONSTATS_PAIEMENTS' ? 'serious' : 'warning'} label={s.label} /><span className="small mono">{s.subject}</span></p><p className="small">{s.detail}</p></li>
          ))}</ul>
        )}
      </section>
      <section className="panel" aria-labelledby="det-list"><h2 className="panel-title" id="det-list">Détecteurs</h2>
        <DataTable rows={o.detectors} rowKey={(d) => d.code} caption="Détecteurs"
          columns={[
            { key: 'l', label: 'Détecteur', primary: true, render: (d) => <span className="row-title">{d.label}</span> },
            { key: 'v', label: 'Vecteur de fraude', render: (d) => d.vecteur },
            { key: 's', label: 'Source', full: true, render: (d) => <span className="small muted">{d.source}</span> },
          ]} />
        <ul className="plain-list small muted">{Object.entries(o.params).map(([k, v]) => <li key={k}>{k} : {v}</li>)}</ul>
      </section>
    </>
  );
}

export default function Detecteurs() {
  const { user } = useApp();
  const allowed = hasRole(user?.roles, 'R22', 'R23', 'R24', 'R28', 'R06');
  const canRun = hasRole(user?.roles, 'R22', 'R24', 'R28');
  const o = useApi(allowed ? () => api<DetectorsOverview>('/v1/integrite/detecteurs') : null, [user?.id]);
  const act = useAction();
  if (!allowed) return <div className="page"><PageHead eyebrow="Intégrité" title="Détecteurs anti-fraude" /><EmptyState title="Accès réservé" icon="lock">Réservé à l’audit, à l’anti-fraude et à la sécurité.</EmptyState></div>;
  return (
    <div className="page page-wide ig-page">
      <PageHead eyebrow="Intégrité" title="Détecteurs anti-fraude" lead="Écart constats / paiements, baisse inexpliquée des recettes, proximité agent–objet, rotation des zones et ruptures de la chaîne opératoire : des signaux, jamais des sanctions.">
        {canRun && <button type="button" className="btn btn-secondary" disabled={act.busy} onClick={() => void act.run(() => api('/v1/integrite/detecteurs/executions', { method: 'POST', body: {} })).then(() => o.reload())}><Icon name="refresh" size={18} /> Exécuter maintenant</button>}
      </PageHead>
      <ActionError error={act.error} />
      {o.loading && <Loading />}
      {o.error !== null && <ErrorState error={o.error} onRetry={o.reload} />}
      {o.data && <DetecteursView o={o.data} />}
    </div>
  );
}
