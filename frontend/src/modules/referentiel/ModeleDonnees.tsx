/**
 * Modèle de données et matrice d'habilitations (Document maître FR 2, nouvelle version, ch. 30 et ch. 12), évalués en
 * direct par le serveur : pour chaque entité, cycle de vie du Cahier rapproché des états réellement portés par le code
 * et effectifs courants (sans donnée personnelle) ; pour chaque rôle du Cahier, interdits refusés et facultés câblées.
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import './referentiel.css';

export interface EntityView {
  code: string; entity: string; purpose: string; relations: string; confidentiality: string;
  cahierLifecycle: { cahier: string; platform: string[]; note?: string }[] | null;
  platformStates: string[]; source: string; audit: string[]; retention: string;
  counts: Record<string, number> | null; total: number | null;
}
export interface RoleRowView {
  cahierRole: string; platformRoles: string[]; sees: string; can: string; never: string;
  forbidden: { action: string; label: string }[];
  structural?: { label: string; test: string }[];
  checks: { role: string; allowedOk: boolean; forbiddenBreaches: string[]; structuralBreaches: string[] }[];
  ok: boolean;
}

export function EntityTable({ entities }: { entities: EntityView[] }) {
  return (
    <DataTable rows={entities} rowKey={(e) => e.code} caption="Entités du modèle de données conceptuel (ch. 30)"
      columns={[
        { key: 'e', label: 'Entité', primary: true, render: (e) => <><span className="row-title">{e.entity}</span><span className="small muted">{e.purpose}</span></> },
        { key: 'c', label: 'Confidentialité', render: (e) => <span className="small">{e.confidentiality}</span> },
        { key: 'l', label: 'Cycle de vie (Cahier → plateforme)', render: (e) => e.cahierLifecycle ? (
          <ul className="plain-list small">{e.cahierLifecycle.map((m) => (
            <li key={m.cahier}><strong>{m.cahier}</strong> → <span className="mono">{m.platform.join(', ')}</span>{e.counts ? ` · ${e.counts[m.cahier] ?? 0}` : ''}</li>
          ))}</ul>
        ) : <span className="small muted">États de la plateforme : <span className="mono">{e.platformStates.join(', ')}</span></span> },
        { key: 't', label: 'Effectif', num: true, render: (e) => (e.total === null ? '—' : String(e.total)) },
        { key: 's', label: 'Source', render: (e) => <span className="mono small">{e.source}</span> },
      ]} />
  );
}

export function RoleMatrixTable({ rows }: { rows: RoleRowView[] }) {
  return (
    <DataTable rows={rows} rowKey={(r) => r.cahierRole} caption="Rôles et habilitations (ch. 12)"
      columns={[
        { key: 'r', label: 'Rôle', primary: true, render: (r) => <><span className="row-title">{r.cahierRole}</span><span className="mono small">{r.platformRoles.join(', ')}</span></> },
        { key: 'v', label: 'Voit', render: (r) => <span className="small">{r.sees}</span> },
        { key: 'p', label: 'Peut faire', render: (r) => <span className="small">{r.can}</span> },
        { key: 'n', label: 'Ne peut jamais', render: (r) => <span className="small">{r.never}<br /><span className="muted">{r.forbidden.length} action(s) vérifiée(s) refusée(s)</span></span> },
        { key: 'ok', label: 'Contrôle', render: (r) => <StatusBadge tone={r.ok ? 'good' : 'critical'} label={r.ok ? 'Conforme' : `Écart : ${r.checks.flatMap((c) => c.forbiddenBreaches).join(', ') || 'faculté non câblée'}`} /> },
      ]} />
  );
}

type Tab = 'donnees' | 'roles';

export default function ModeleDonnees() {
  const { user } = useApp();
  const [tab, setTab] = useState<Tab>('donnees');
  const dm = useApi(() => api<{ notice: string; entities: EntityView[] }>('/v1/referentiel/modele-donnees'), [user?.id]);
  const mx = useApi(() => api<{ notice: string; transverse: string[]; rows: RoleRowView[]; ok: boolean }>('/v1/referentiel/matrice-habilitations'), [user?.id]);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Référentiel" title="Modèle de données et habilitations"
        lead="Correspondance vérifiée en direct entre le Document maître (ch. 30 et ch. 12) et le code : cycles de vie, confidentialité, effectifs sans donnée personnelle ; interdits de chaque rôle refusés par le point de décision central." />
      <div className="seg seg-wrap" role="group" aria-label="Vue">
        <button type="button" aria-pressed={tab === 'donnees'} onClick={() => setTab('donnees')}>Modèle de données</button>
        <button type="button" aria-pressed={tab === 'roles'} onClick={() => setTab('roles')}>Matrice d’habilitations</button>
      </div>
      {tab === 'donnees' && (
        <>
          {dm.loading && <Loading />}
          {dm.error !== null && <ErrorState error={dm.error} onRetry={dm.reload} />}
          {dm.data && <><p className="small muted">{dm.data.notice}</p><EntityTable entities={dm.data.entities} /></>}
        </>
      )}
      {tab === 'roles' && (
        <>
          {mx.loading && <Loading />}
          {mx.error !== null && <ErrorState error={mx.error} onRetry={mx.reload} />}
          {mx.data && (
            <>
              <p className="small muted">{mx.data.notice}</p>
              <StatusBadge tone={mx.data.ok ? 'good' : 'critical'} label={mx.data.ok ? 'Aucun interdit accordé' : 'Écart détecté — examen requis'} />
              <RoleMatrixTable rows={mx.data.rows} />
              <section className="panel"><p className="panel-title">Contrôles transverses (§ 12.1)</p><ul className="small">{mx.data.transverse.map((t) => <li key={t}>{t}</li>)}</ul></section>
            </>
          )}
        </>
      )}
    </div>
  );
}
