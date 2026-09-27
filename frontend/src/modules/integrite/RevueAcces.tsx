/** Revue périodique des habilitations : chaque accès est confirmé ou retiré par un responsable distinct, avec motif. */
import { useMemo, useState } from 'react';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { useApp } from '../../context';
import { ActionError, hasRole, Kpi, StateBadge, useAction } from './shared';
import './integrite.css';

interface Item { id: string; userId: string; userName: string; entity: string; role: string; roleLabel: string; privileged: boolean; decision: string; reason?: string; decidedBy?: string; elevations?: { id: string; role: string; motif: string; actions: number }[] }
interface Campaign {
  id: string; label: string; launchedBy: string; launchedAt: string; dueAt: string; nextReviewAt: string; status: string; items: Item[];
  progress: { total: number; decided: number; toRemove: number; privileged: number }; overdue: boolean;
}

export default function RevueAcces() {
  const { user, fmtDate } = useApp();
  const allowed = hasRole(user?.roles, 'R28', 'R08', 'R22', 'R25');
  const canDecide = hasRole(user?.roles, 'R28', 'R08');
  const isRssi = hasRole(user?.roles, 'R28');
  const list = useApi(allowed ? () => api<Campaign[]>('/v1/integrite/access-reviews') : null, [user?.id]);
  const [filter, setFilter] = useState<'todo' | 'all' | 'privileged'>('todo');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [label, setLabel] = useState('Revue trimestrielle T4 2026');
  const [closed, setClosed] = useState<{ removals: { userId: string; role: string; reason?: string }[]; execution: string } | null>(null);
  const a = useAction();
  // Plusieurs campagnes possibles (revue complète, revue mensuelle des accès privilégiés) : la plus récente par défaut.
  const [campId, setCampId] = useState<string | null>(null);
  const camp = list.data?.find((c) => c.id === campId) ?? list.data?.[0];
  const rows = useMemo(() => (camp?.items ?? []).filter((i) => filter === 'all' || (filter === 'todo' ? i.decision === 'A_CONFIRMER' : i.privileged)), [camp, filter]);

  if (!allowed) {
    return <div className="page"><PageHead eyebrow="Gouvernance des accès" title="Revue des accès" /><EmptyState title="Accès réservé" icon="lock">Réservé au responsable sécurité, aux administrateurs d’entité, à l’audit et au DPO.</EmptyState></div>;
  }
  const decide = async (item: Item, decision: 'MAINTENU' | 'RETRAIT_A_EXECUTER') => {
    const reason = reasons[item.id] ?? '';
    if (await a.run(() => api(`/v1/integrite/access-reviews/${camp!.id}/items/${encodeURIComponent(item.id)}/decision`, { method: 'POST', body: { decision, reason: reason || (decision === 'MAINTENU' ? 'Accès justifié par la fonction.' : '') } }))) list.reload();
  };

  return (
    <div className="page page-wide ig-page">
      <PageHead eyebrow="Gouvernance des accès" title="Revue périodique des habilitations"
        lead="Trimestrielle pour tous, mensuelle pour les accès privilégiés. Nul ne confirme ses propres accès ; un retrait est motivé et exécuté par l’administrateur de l’annuaire.">
        {isRssi && camp?.status === 'OUVERTE' && (
          <button type="button" className="btn btn-primary" disabled={a.busy} onClick={async () => {
            const r = await a.run(() => api<{ removals: { userId: string; role: string; reason?: string }[]; execution: string }>(`/v1/integrite/access-reviews/${camp.id}/close`, { method: 'POST', body: {} }));
            if (r) { setClosed(r); list.reload(); }
          }}><Icon name="check" size={18} /> Clôturer la campagne</button>
        )}
      </PageHead>
      <ActionError error={a.error} />
      {list.loading && <Loading />}
      {list.error !== null && <ErrorState error={list.error} onRetry={list.reload} />}
      {closed && (
        <div className="callout callout-info"><Icon name="check" size={18} /><div>
          <p><strong>Campagne clôturée.</strong> {closed.removals.length} retrait(s) à exécuter.</p>
          {closed.removals.length > 0 && <ul className="plain-list small">{closed.removals.map((r) => <li key={r.userId + r.role}>{r.userId} · {r.role} — {r.reason}</li>)}</ul>}
          <p className="small muted">{closed.execution}</p>
        </div></div>
      )}
      {list.data && !camp && <EmptyState title="Aucune campagne" icon="users" />}
      {isRssi && list.data && (!camp || camp.status === 'CLOTUREE') && (
        <section className="panel ig-launch">
          <h2 className="panel-title">Lancer une campagne</h2>
          <div className="input-row">
            <label className="sr-only" htmlFor="rv-label">Intitulé</label>
            <input id="rv-label" value={label} onChange={(e) => setLabel(e.target.value)} />
            <button type="button" className="btn btn-primary" disabled={a.busy || label.trim().length < 3} onClick={async () => { if (await a.run(() => api('/v1/integrite/access-reviews', { method: 'POST', body: { label } }))) { setClosed(null); list.reload(); } }}>Lancer</button>
          </div>
        </section>
      )}
      {isRssi && list.data && (
        <section className="panel ig-launch">
          <h2 className="panel-title">Revue mensuelle des accès privilégiés</h2>
          <p className="small muted">Rôles privilégiés et élévations juste-à-temps du mois ; ouverte automatiquement le 1er du mois (paramètre du registre).</p>
          <button type="button" className="btn btn-secondary" disabled={a.busy} onClick={async () => { if (await a.run(() => api('/v1/integrite/access-reviews/privileged', { method: 'POST', body: {} }))) { setCampId(null); list.reload(); } }}>Ouvrir la revue du mois</button>
        </section>
      )}
      {list.data && list.data.length > 1 && (
        <div className="field">
          <label htmlFor="rv-camp" className="label">Campagne</label>
          <select id="rv-camp" value={camp?.id ?? ''} onChange={(e) => setCampId(e.target.value)}>
            {list.data.map((c) => <option key={c.id} value={c.id}>{c.label} — {c.status === 'OUVERTE' ? 'ouverte' : 'clôturée'}</option>)}
          </select>
        </div>
      )}
      {camp && (
        <>
          <div className="kpi-row ig-kpis">
            <Kpi label="Campagne" value={<span className="ig-kpi-text">{camp.label}</span>} sub={<StateBadge value={camp.status} />} />
            <Kpi label="Accès revus" value={`${camp.progress.decided} / ${camp.progress.total}`} sub={camp.overdue ? 'échéance dépassée' : `échéance ${fmtDate(camp.dueAt)}`} />
            <Kpi label="Retraits décidés" value={camp.progress.toRemove} />
            <Kpi label="Accès privilégiés" value={camp.progress.privileged} sub="revue mensuelle" />
            <Kpi label="Prochaine revue" value={<span className="ig-kpi-text">{fmtDate(camp.nextReviewAt)}</span>} />
          </div>
          {camp.label.includes('démo') && <ExampleNotice text="Campagne de démonstration portant sur les comptes fictifs de l’annuaire." />}
          <div className="seg seg-sm seg-wrap" role="group" aria-label="Filtre">
            <button type="button" aria-pressed={filter === 'todo'} onClick={() => setFilter('todo')}>À confirmer</button>
            <button type="button" aria-pressed={filter === 'privileged'} onClick={() => setFilter('privileged')}>Privilégiés</button>
            <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>Tous</button>
          </div>
          <DataTable rows={rows} rowKey={(i) => i.id} caption="Accès à revoir" empty={<EmptyState title="Rien à confirmer" icon="check" />}
            columns={[
              { key: 'u', label: 'Personne', primary: true, render: (i) => <><span className="row-title">{i.userName}</span><span className="account-code">{i.userId} · {i.entity}</span></> },
              { key: 'r', label: 'Rôle', render: (i) => <span className="small">{i.role} — {i.roleLabel}{i.privileged && <span className="ig-tag">Privilégié</span>}{i.elevations?.length ? <span className="ig-tag">{i.elevations.length} élévation(s) : {i.elevations.map((e) => `${e.id} (${e.actions} action(s))`).join(', ')}</span> : null}</span> },
              { key: 'd', label: 'Décision', render: (i) => <span className="ig-inline"><StateBadge value={i.decision} />{i.decidedBy && <span className="small muted">{i.decidedBy}</span>}</span> },
              {
                key: 'a', label: 'Action', full: true, render: (i) => (camp.status === 'OUVERTE' && canDecide && i.decision === 'A_CONFIRMER' && i.userId !== user?.id ? (
                  <div className="ig-review-act">
                    <input aria-label={`Motif pour ${i.userName}`} className="input-sm" placeholder="Motif (obligatoire pour un retrait)" value={reasons[i.id] ?? ''} onChange={(e) => setReasons({ ...reasons, [i.id]: e.target.value })} />
                    <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy} onClick={() => void decide(i, 'MAINTENU')}>Confirmer</button>
                    <button type="button" className="btn btn-ghost btn-sm ig-danger" disabled={a.busy || (reasons[i.id] ?? '').trim().length < 5} onClick={() => void decide(i, 'RETRAIT_A_EXECUTER')}>Retirer</button>
                  </div>
                ) : i.userId === user?.id && i.decision === 'A_CONFIRMER' ? <span className="small muted">Revue par un autre responsable</span> : <span className="small muted">{i.reason ?? ''}</span>),
              },
            ]} />
        </>
      )}
    </div>
  );
}
