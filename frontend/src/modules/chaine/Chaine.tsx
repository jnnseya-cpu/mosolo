/**
 * Vue autonome « Sept questions et chaîne opératoire » : /chaine (recherche + contrôle des ruptures pour l'audit),
 * /chaine/:objectId (objet fiscal), /chaine/obligation/:obligationId (obligation).
 */
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
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
import { DonutViz, fmtNombre, KpiGrid, KpiTile, StatusDistribution } from '../../components/viz';
import { ETATS_OBLIGATION, etatsDe } from '../pilotage/visuels';
import { CATEGORY_LABELS } from '../pilotage/shared';

interface ObligationLite { id: string; objectId: string; label: string; revenueCategory: string; entity: string; status: string; dueDate: string }

/**
 * Obligations lisibles par le rôle (même droit « obligation.read » que le serveur) : répartition par état et par
 * catégorie, et accès direct à la chaîne de chacune — aucune saisie d'identifiant nécessaire.
 */
function ObligationsAcces() {
  const { user } = useApp();
  const q = useApi(() => api<ObligationLite[]>('/v1/obligations'), [user?.id]);
  if (q.loading || q.error || !q.data) return null;
  const items = q.data;
  const recent = [...items].sort((a, b) => b.dueDate.localeCompare(a.dueDate)).slice(0, 12);
  const cats = items.reduce<Record<string, number>>((m, o) => { m[o.revenueCategory] = (m[o.revenueCategory] ?? 0) + 1; return m; }, {});
  return (
    <section className="section panel" aria-labelledby="ch-obl">
      <div className="panel-head"><div><p className="panel-title" id="ch-obl">Obligations de votre périmètre</p><p className="panel-sub">Ouvrir la chaîne opératoire d’une obligation ou de son objet</p></div><span className="count">{items.length}</span></div>
      <KpiGrid max={3} label="Obligations — synthèse">
        <KpiTile hero label="Obligations lisibles" value={items.length} format={(v) => fmtNombre(v, 0)} state={{ label: 'Votre périmètre', tone: 'info' }} />
        <KpiTile label="Soldées" value={items.filter((o) => o.status === 'SOLDEE').length} format={(v) => fmtNombre(v, 0)} state={{ label: 'Soldée', tone: 'good' }} />
        <KpiTile label="En retard ou contestées" value={items.filter((o) => o.status === 'EN_RETARD' || o.status === 'CONTESTEE').length} format={(v) => fmtNombre(v, 0)} state={{ label: 'À suivre', tone: 'warning' }} />
      </KpiGrid>
      <div className="viz-grid" style={{ ['--viz-min' as string]: '280px' }}>
        <StatusDistribution title="Obligations par état" unitLabel="obligations" items={etatsDe(items, (o) => o.status, ETATS_OBLIGATION).filter((i) => i.count > 0)} />
        <DonutViz title="Obligations par catégorie" centerLabel="obligations" slices={Object.entries(cats).map(([k, v]) => ({ key: k, label: CATEGORY_LABELS[k] ?? k, value: v }))} />
      </div>
      <ul className="list-rows">
        {recent.map((o) => (
          <li key={o.id} className="list-row">
            <div className="min0"><p className="row-title mono">{o.id}</p><p className="small muted">{o.label} · échéance {o.dueDate}</p></div>
            <div className="row-side btn-row">
              <Link className="btn btn-secondary btn-sm" to={`/chaine/obligation/${encodeURIComponent(o.id)}`}>Chaîne</Link>
              <Link className="btn btn-ghost btn-sm" to={`/chaine/${encodeURIComponent(o.objectId)}`}>Objet</Link>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

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
      <div className="viz-grid" style={{ ['--viz-min' as string]: '280px' }}>
        <StatusDistribution title="Maillons sautés par gravité" unitLabel="ruptures" emptyText="Aucun maillon sauté"
          items={[{ key: 'c', label: 'Critique', tone: 'critical', count: d.ruptures.filter((r) => r.severity === 'CRITICAL').length }, { key: 'e', label: 'Élevée', tone: 'serious', count: d.ruptures.filter((r) => r.severity !== 'CRITICAL').length }]} />
        <DonutViz title="Maillons sautés par nature" centerLabel="ruptures" emptyText="Aucun maillon sauté"
          slices={Object.entries(d.counts).map(([k, v]) => ({ key: k, label: d.ruptures.find((r) => r.code === k)?.label ?? k.replace(/_/g, ' ').toLowerCase(), value: v }))} />
      </div>
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
      {user && !objectId && !obligationId && <ObligationsAcces />}
      {user && audit && <section className="section"><Ruptures /></section>}
    </div>
  );
}
