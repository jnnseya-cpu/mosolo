/**
 * Santé des clés de signature et HMAC (administration, sécurité) : configurée ou non, empreinte courte, âge,
 * avertissements. Aucune valeur secrète n'est transmise au navigateur.
 */
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { useApp } from '../../context';
import { hasRole, Kpi } from './shared';
import { ClesVisuels } from './visuels';
import './integrite.css';

export interface KeyWarning { code: string; severity: 'INFO' | 'ATTENTION' | 'CRITIQUE'; message: string }
export interface KeyReport { id: string; purpose: string; env: string; kind: string; configured: boolean; fingerprint: string | null; length?: number; since?: string; ageDays?: number; warnings: KeyWarning[] }
export interface KeyHealth { generatedAt: string; mode: 'DEMONSTRATION' | 'EXPLOITATION'; keys: KeyReport[]; summary: { total: number; configured: number; critical: number; attention: number }; note: string }

const TONE = { INFO: 'info', ATTENTION: 'warning', CRITIQUE: 'critical' } as const;

export function KeyTable({ keys }: { keys: KeyReport[] }) {
  return (
    <DataTable rows={keys} rowKey={(k) => k.id} caption="Clés" empty={<EmptyState title="Aucune clé" icon="lock" />}
      columns={[
        { key: 'p', label: 'Usage', primary: true, render: (k) => <><span className="row-title">{k.purpose}</span><span className="account-code">{k.env}</span></> },
        { key: 'c', label: 'Configurée', render: (k) => <StatusBadge tone={k.configured ? 'good' : 'neutral'} label={k.configured ? 'Oui' : 'Non'} /> },
        { key: 'f', label: 'Empreinte', render: (k) => <span className="mono small">{k.fingerprint ?? '—'}</span> },
        { key: 'a', label: 'Âge', num: true, render: (k) => (k.ageDays !== undefined ? `${k.ageDays} j` : <span className="muted small">inconnu</span>) },
        {
          key: 'w', label: 'Avertissements', full: true, render: (k) => (k.warnings.length === 0 ? <span className="small muted">Aucun</span> : (
            <ul className="plain-list small">
              {k.warnings.map((w) => <li key={w.code} className="ig-inline"><StatusBadge tone={TONE[w.severity]} label={w.severity === 'CRITIQUE' ? 'Critique' : w.severity === 'ATTENTION' ? 'Attention' : 'Info'} />{w.message}</li>)}
            </ul>
          )),
        },
      ]} />
  );
}

export default function SanteCles() {
  const { user } = useApp();
  const allowed = hasRole(user?.roles, 'R26', 'R28');
  const h = useApi(allowed ? () => api<KeyHealth>('/v1/integrite/key-health') : null, [user?.id]);
  if (!allowed) {
    return <div className="page"><PageHead eyebrow="Sécurité" title="Santé des clés" /><EmptyState title="Accès réservé" icon="lock">Réservé à l’administration de la plateforme et au responsable sécurité.</EmptyState></div>;
  }
  return (
    <div className="page page-wide ig-page">
      <PageHead eyebrow="Sécurité" title="Santé des clés"
        lead="Clés de signature des quittances, des clôtures, des jetons et du journal d’audit, secrets des prestataires et des terminaux : présence, empreinte, âge et séparation des usages." >
        <button type="button" className="btn btn-secondary" onClick={h.reload}><Icon name="refresh" size={18} /> Revérifier</button>
      </PageHead>
      {h.loading && <Loading />}
      {h.error !== null && <ErrorState error={h.error} onRetry={h.reload} />}
      {h.data && (
        <>
          <div className="kpi-row ig-kpis">
            <Kpi label="Mode" value={<span className="ig-kpi-text">{h.data.mode === 'DEMONSTRATION' ? 'Démonstration' : 'Exploitation'}</span>} />
            <Kpi label="Clés configurées" value={`${h.data.summary.configured} / ${h.data.summary.total}`} />
            <Kpi label="Avertissements critiques" value={h.data.summary.critical} />
            <Kpi label="À surveiller" value={h.data.summary.attention} />
          </div>
          <p className="callout callout-info ig-note"><Icon name="lock" size={18} /><span>{h.data.note}</span></p>
          <ClesVisuels keys={h.data.keys} />
          <KeyTable keys={h.data.keys} />
        </>
      )}
    </div>
  );
}
