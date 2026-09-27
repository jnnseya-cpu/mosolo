/**
 * Vue autonome « Sept questions et chaîne opératoire » : /chaine (recherche + contrôle des ruptures pour l'audit),
 * /chaine/:objectId (objet fiscal), /chaine/obligation/:obligationId (obligation).
 */
import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import { SeptQuestionsPanel } from './SeptQuestions';
import type { RupturesView } from './types';
import './chaine.css';

const AUDIT_ROLES = ['R22', 'R23', 'R24', 'R28'];

function Ruptures() {
  const { user, fmtDate } = useApp();
  const q = useApi(() => api<RupturesView>('/v1/integrite/chaine/ruptures'), [user?.id]);
  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data!;
  return (
    <section className="panel ch-ruptures" aria-labelledby="ch-rupt">
      <div className="panel-head">
        <div>
          <p className="panel-title" id="ch-rupt"><Icon name="shieldCheck" size={18} /> Maillons sautés</p>
          <p className="panel-sub">Quittance sans paiement confirmé, paiement sans obligation liquidée, obligation sans règle validée, règle active sans texte en vigueur. Alerte pour examen humain — aucun effet automatique.</p>
        </div>
        <span className="count">{d.total}</span>
      </div>
      <p className="small muted">Contrôle du {fmtDate(d.scannedAt, true)} · {d.alertsRaised} nouvelle(s) alerte(s).</p>
      {d.total === 0 ? <EmptyState title="Aucun maillon sauté dans les dépôts." icon="check" /> : (
        <ul className="list-rows">
          {d.ruptures.map((r) => (
            <li key={`${r.code}-${r.resourceId}`} className="list-row">
              <div className="min0">
                <p className="row-title">{r.label}</p>
                <p className="small">{r.detail}</p>
                <p className="small muted mono">{r.resourceType} {r.resourceId} · maillon {r.maillon}</p>
              </div>
              <div className="row-side"><StatusBadge tone={r.severity === 'CRITICAL' ? 'critical' : 'serious'} label={r.severity === 'CRITICAL' ? 'Critique' : 'Élevée'} /></div>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn btn-secondary btn-sm" onClick={q.reload}><Icon name="refresh" size={16} /> Relancer le contrôle</button>
    </section>
  );
}

export default function Chaine() {
  const { objectId, obligationId } = useParams();
  const { user } = useApp();
  const nav = useNavigate();
  const [ref, setRef] = useState('');
  const audit = !!user?.roles.some((r) => AUDIT_ROLES.includes(r));
  const go = (e: FormEvent) => {
    e.preventDefault();
    const v = ref.trim();
    if (!v) return;
    nav(/^OBL-/i.test(v) ? `/chaine/obligation/${encodeURIComponent(v)}` : `/chaine/${encodeURIComponent(v)}`);
  };
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Vision · chaîne opératoire" title="Sept questions et chaîne opératoire"
        lead="Pour chaque objet et chaque obligation : qui ? quoi ? où ? quelle règle ? combien ? payé ? l’argent est-il arrivé sur le compte public et comptabilisé ? — et les treize maillons, de RECENSER à PLANIFIER, chacun horodaté et signé. Aucun maillon ne peut être sauté." />
      <form className="ch-search section" onSubmit={go} role="search">
        <label className="sr-only" htmlFor="ch-ref">Identifiant d’objet ou d’obligation</label>
        <input id="ch-ref" className="mono" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="OBJ-… ou OBL-…" />
        <button type="submit" className="btn btn-primary" disabled={!ref.trim()}>Afficher</button>
      </form>
      {!user && <EmptyState title="Choisissez un utilisateur de démonstration (en-tête) : les réponses dépendent de vos habilitations." icon="user" />}
      {user && (objectId || obligationId) && (
        <section className="section panel">
          <SeptQuestionsPanel {...(obligationId ? { obligationId } : { objectId: objectId! })} standaloneLink={false} />
        </section>
      )}
      {user && audit && <section className="section"><Ruptures /></section>}
    </div>
  );
}
