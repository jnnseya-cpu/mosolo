/**
 * Gouvernance des données (ch. 32) : classification de chaque dépôt et de ses champs (C1 à C5) et purge par durée de
 * conservation. La purge suit trois temps : aperçu (simulation), proposition motivée, approbation par une AUTRE
 * personne ; seuls des champs personnels de dépôts techniques sont effacés, jamais les données financières, d'audit
 * ou de preuve. Les durées sont des paramètres du registre des seuils (0 = non fixée : aucune purge).
 */
import { useState } from 'react';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { useApp } from '../../context';
import { ActionError, hasRole, Kpi, useAction } from '../integrite/shared';
import '../integrite/integrite.css';

interface Depot {
  depot: string; enregistrements: number; classe: string; nature: string; libelle: string; source: string;
  champs: Record<string, string>; conservation: { parametre: string; champDate: string; champsEffaces: string[] } | null; purgeable: boolean; refusPurge: string | null;
}
interface Classification { classes: Record<string, string>; depots: Depot[]; aClasser: number; note: string }
interface Ligne { depot: string; parametre: string; dureeJours: number; statut: string; motif?: string; ids: string[]; champsEffaces: string[] }
interface Apercu { generatedAt: string; lignes: Ligne[]; total: number }
interface Purge { id: string; status: 'PROPOSEE' | 'EXECUTEE' | 'REJETEE'; at: string; proposedBy: string; motif: string; apercu: Apercu; decision?: { by: string; at: string; motif: string }; execution?: { effaces: Record<string, number>; ignores: unknown[] } }

const READ = ['R25', 'R28', 'R26', 'R22', 'R23'];
const PROPOSE = ['R25', 'R28'];
const DECIDE = ['R25', 'R28', 'R26'];
const CLASS_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'serious' | 'critical'> = { C1: 'neutral', C2: 'info', C3: 'warning', C4: 'serious', C5: 'critical' };
const LIGNE_LABEL: Record<string, string> = { DUREE_NON_FIXEE: 'Durée non fixée (aucune purge)', ELIGIBLE: 'Éligible', RIEN_A_PURGER: 'Rien d’échu', INTERDIT: 'Interdit' };

export default function DonneesConservation() {
  const { user, fmtDate } = useApp();
  const allowed = hasRole(user?.roles, ...READ);
  const canPropose = hasRole(user?.roles, ...PROPOSE);
  const canDecide = hasRole(user?.roles, ...DECIDE);
  const cls = useApi(allowed ? () => api<Classification>('/v1/juridique/donnees/classification') : null, [user?.id]);
  const purges = useApi(allowed ? () => api<{ items: Purge[] }>('/v1/juridique/donnees/purges') : null, [user?.id]);
  const [apercu, setApercu] = useState<Apercu | null>(null);
  const [motif, setMotif] = useState('');
  const [motifs, setMotifs] = useState<Record<string, string>>({});
  const a = useAction();

  if (!allowed) {
    return <div className="page"><PageHead eyebrow="Protection des données" title="Classification et conservation" /><EmptyState title="Accès réservé" icon="lock">Réservé au délégué à la protection des données, à la sécurité, à l’administration et à l’audit.</EmptyState></div>;
  }
  const pending = (purges.data?.items ?? []).filter((p) => p.status === 'PROPOSEE');
  return (
    <div className="page page-wide ig-page">
      <PageHead eyebrow="Protection des données" title="Classification et conservation"
        lead="Chaque dépôt et chaque champ porte sa classe (C1 public à C5 secret). La purge à l’échéance efface des champs personnels, après aperçu et approbation par une seconde personne ; jamais de données financières, d’audit ou de preuve." />
      <ActionError error={a.error} />
      {cls.loading && <Loading />}
      {cls.error !== null && <ErrorState error={cls.error} onRetry={cls.reload} />}
      {cls.data && (
        <>
          <div className="kpi-row ig-kpis">
            <Kpi label="Dépôts classés" value={cls.data.depots.length - cls.data.aClasser} />
            <Kpi label="À classer" value={cls.data.aClasser} />
            <Kpi label="Purgeables (règle de conservation)" value={cls.data.depots.filter((d) => d.purgeable).length} />
            <Kpi label="Purges à décider" value={pending.length} />
          </div>
          <p className="callout callout-info ig-note"><Icon name="info" size={18} /><span>{cls.data.note} Classes : {Object.entries(cls.data.classes).map(([k, v]) => `${k} ${v}`).join(' · ')}.</span></p>

          <section className="panel" aria-labelledby="dc-purge">
            <h2 className="panel-title" id="dc-purge">Purge par durée de conservation</h2>
            {canPropose && <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy} onClick={() => void a.run(async () => setApercu(await api<Apercu>('/v1/juridique/donnees/purges/apercu')))}>Aperçu (simulation)</button>}
            {apercu && (
              <>
                <DataTable rows={apercu.lignes} rowKey={(l) => l.depot} caption="Aperçu de la purge"
                  columns={[
                    { key: 'd', label: 'Dépôt', primary: true, render: (l) => <span className="mono small">{l.depot}</span> },
                    { key: 'p', label: 'Durée', render: (l) => <span className="small">{l.dureeJours ? `${l.dureeJours} jours` : 'non fixée'} <span className="mono muted">({l.parametre})</span></span> },
                    { key: 's', label: 'État', render: (l) => <StatusBadge tone={l.statut === 'ELIGIBLE' ? 'warning' : l.statut === 'INTERDIT' ? 'critical' : 'neutral'} label={LIGNE_LABEL[l.statut] ?? l.statut} /> },
                    { key: 'n', label: 'Enregistrements', num: true, render: (l) => l.ids.length },
                    { key: 'c', label: 'Champs effacés', full: true, render: (l) => <span className="mono small">{l.champsEffaces.join(', ') || '—'}</span> },
                  ]} />
                {apercu.total > 0 && (
                  <div className="ig-review-act">
                    <input aria-label="Motif de la proposition de purge" className="input-sm" placeholder="Motif (10 caractères minimum)" value={motif} onChange={(e) => setMotif(e.target.value)} />
                    <button type="button" className="btn btn-primary btn-sm" disabled={a.busy || motif.trim().length < 10} onClick={() => void a.run(async () => { await api('/v1/juridique/donnees/purges', { method: 'POST', body: { motif } }); setApercu(null); setMotif(''); purges.reload(); })}>Proposer la purge</button>
                  </div>
                )}
              </>
            )}
            {pending.map((p) => (
              <div key={p.id} className="ig-block">
                <p><strong>{p.id}</strong> — {p.apercu.total} enregistrement(s) ; proposée par {p.proposedBy} le {fmtDate(p.at, true)} — {p.motif}</p>
                {canDecide && p.proposedBy !== user?.id ? (
                  <div className="ig-review-act">
                    <input aria-label={`Motif de décision ${p.id}`} className="input-sm" placeholder="Motif (10 caractères minimum)" value={motifs[p.id] ?? ''} onChange={(e) => setMotifs({ ...motifs, [p.id]: e.target.value })} />
                    <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy || (motifs[p.id] ?? '').trim().length < 10} onClick={() => void a.run(async () => { await api(`/v1/juridique/donnees/purges/${p.id}/decision`, { method: 'POST', body: { approve: true, motif: motifs[p.id] } }); purges.reload(); cls.reload(); })}>Approuver et exécuter</button>
                    <button type="button" className="btn btn-ghost btn-sm ig-danger" disabled={a.busy || (motifs[p.id] ?? '').trim().length < 10} onClick={() => void a.run(async () => { await api(`/v1/juridique/donnees/purges/${p.id}/decision`, { method: 'POST', body: { approve: false, motif: motifs[p.id] } }); purges.reload(); })}>Rejeter</button>
                  </div>
                ) : <p className="small muted">Décision par une autre personne habilitée.</p>}
              </div>
            ))}
            {(purges.data?.items ?? []).filter((p) => p.status !== 'PROPOSEE').map((p) => (
              <p key={p.id} className="small">{p.id} · {p.status === 'EXECUTEE' ? `exécutée (${Object.entries(p.execution?.effaces ?? {}).map(([d, n]) => `${d} : ${n}`).join(', ')})` : 'rejetée'} — décision de {p.decision?.by}</p>
            ))}
          </section>

          <DataTable rows={cls.data.depots} rowKey={(d) => d.depot} caption="Classification des dépôts"
            columns={[
              { key: 'd', label: 'Dépôt', primary: true, render: (d) => <><span className="row-title">{d.libelle}</span><span className="account-code">{d.depot}</span></> },
              { key: 'c', label: 'Classe', render: (d) => <StatusBadge tone={CLASS_TONE[d.classe] ?? 'neutral'} label={`${d.classe}${d.source === 'A_CLASSER' ? ' (à classer)' : ''}`} /> },
              { key: 'n', label: 'Nature', render: (d) => <span className="small">{d.nature}</span> },
              { key: 'e', label: 'Enregistrements', num: true, render: (d) => d.enregistrements },
              { key: 'f', label: 'Champs classés', full: true, render: (d) => <span className="mono small">{Object.entries(d.champs).map(([k, v]) => `${k}:${v}`).join(' · ') || '—'}</span> },
              { key: 'p', label: 'Purge', render: (d) => <span className="small">{d.purgeable ? `Oui (${d.conservation?.parametre ?? ''})` : `Non — ${d.refusPurge ?? ''}`}</span> },
            ]} />
        </>
      )}
    </div>
  );
}
