/**
 * Consultation motivée d'un dossier (§ 12.1 : finalité déclarée ; H.6.8 : bris de glace) : motif obligatoire,
 * finalité journalisée ; hors périmètre, accès limité à 30 minutes, second facteur, alerte immédiate à l'audit
 * et revue a posteriori. Récusation automatique pour son propre dossier et celui de ses proches déclarés.
 */
import { useEffect, useState, type FormEvent } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { Chip } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { MoneyText } from '../../components/MoneyText';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { hasRole, PURPOSE_LABEL, useAction, type Consultation as C } from './common';
import './acces.css';

interface Dossier {
  consultation: { id: string; mode: string; purpose: string; expiresAt: string };
  taxpayer: { id: string; iuc: string; fullName: string; phoneMasked: string | null; verificationLevel: string; kind: string };
  objects: { id: string; category: string; commune: string; quartier: string }[];
  obligations: { id: string; label: string; entity: string; status: string; dueDate: string; amount: MoneyJSON | null }[];
}

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = Math.max(0, new Date(until).getTime() - now);
  const m = Math.floor(left / 60000); const s = Math.floor((left % 60000) / 1000);
  return <span className="ac-countdown" aria-live="off">{left === 0 ? 'expiré' : `${m} min ${String(s).padStart(2, '0')} s`}</span>;
}

export default function Consultation() {
  const { user, fmtDate } = useApp();
  const roles = user?.roles ?? [];
  const reviewer = hasRole(roles, 'R22', 'R28');
  const list = useApi(() => api<{ items: C[] }>('/v1/acces/consultations'), [user?.id]);
  const act = useAction(user?.id);
  const [f, setF] = useState({ taxpayerId: '', purpose: 'CONTROLE', motif: '' });
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  async function submit(e: FormEvent) {
    e.preventDefault();
    const c = await act.run(() => api<C>('/v1/acces/consultations', { method: 'POST', body: { taxpayerId: f.taxpayerId.trim(), purpose: f.purpose, motif: f.motif.trim() } }),
      (r) => (r.mode === 'PERIMETRE' ? 'Dossier dans votre périmètre : finalité journalisée.' : 'Bris de glace accordé pour 30 minutes : l’audit est alerté et la consultation sera revue.'));
    if (c) { list.reload(); await openDossier(c.id); }
  }
  async function openDossier(id: string) {
    const d = await act.run(() => api<Dossier>(`/v1/acces/consultations/${id}/dossier`));
    if (d) setDossier(d);
  }
  const allowed = hasRole(roles, 'R06', 'R07', 'R09', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22', 'R23', 'R24');

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Accès aux dossiers" title="Consultation motivée" lead="Toute consultation d’un dossier individuel déclare sa finalité. Hors de votre périmètre, l’accès « bris de glace » est exceptionnel : motivé, limité dans le temps, signalé immédiatement à l’audit et revu." />
      {!allowed && !reviewer && <EmptyState title="Fonction réservée aux agents habilités (l’administrateur de la plateforme n’accède à aucune donnée fiscale individuelle)" icon="lock" />}
      <div className="ac-grid">
        {allowed && (
          <form className="panel form" onSubmit={(e) => void submit(e)} aria-labelledby="cs-title">
            <h2 className="panel-title" id="cs-title">Demande motivée</h2>
            <div className="field"><label className="label" htmlFor="cs-t">Identifiant du contribuable</label><input id="cs-t" className="mono" value={f.taxpayerId} onChange={(e) => setF({ ...f, taxpayerId: e.target.value })} placeholder="TP-DEMO-0001" required /></div>
            <div className="field"><label className="label" htmlFor="cs-p">Finalité</label>
              <select id="cs-p" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })}>{Object.entries(PURPOSE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div className="field"><label className="label" htmlFor="cs-m">Motif détaillé</label><textarea id="cs-m" rows={4} value={f.motif} onChange={(e) => setF({ ...f, motif: e.target.value })} required />
              <span className="hint">{f.motif.trim().length} / 20 caractères minimum. Le motif est inscrit au journal chaîné.</span></div>
            <p className="ac-guard ac-guard-warn"><Icon name="alert" size={16} /> <span>Hors périmètre : second facteur exigé, accès de 30 minutes, alerte à l’audit et au responsable sécurité. Votre propre dossier et ceux de vos proches déclarés sont refusés (récusation).</span></p>
            {act.node}
            <button type="submit" className="btn btn-primary" disabled={act.busy || f.motif.trim().length < 20}><Icon name="lock" size={18} /> Demander l’accès</button>
          </form>
        )}
        <div className="ac-stack">
          {dossier && (
            <section className="panel" aria-labelledby="ds-title">
              <div className={`ac-banner ${dossier.consultation.mode === 'PERIMETRE' ? 'perimetre' : ''}`}>
                <Icon name={dossier.consultation.mode === 'PERIMETRE' ? 'check' : 'alert'} size={18} />
                <span>{dossier.consultation.mode === 'PERIMETRE' ? 'Dans votre périmètre' : 'Bris de glace'} · {PURPOSE_LABEL[dossier.consultation.purpose]} · expire dans <Countdown until={dossier.consultation.expiresAt} /></span>
              </div>
              <h2 className="panel-title" id="ds-title" style={{ marginTop: 12 }}>{dossier.taxpayer.fullName}</h2>
              <div className="ac-meta"><span className="mono">{dossier.taxpayer.iuc}</span><span>{dossier.taxpayer.verificationLevel}</span><span>{dossier.taxpayer.phoneMasked ?? 'sans téléphone'}</span></div>
              <h3 className="ac-section-title" style={{ marginTop: 12 }}>Objets</h3>
              <div className="ac-chips">{dossier.objects.map((o) => <Chip key={o.id}>{o.category} · {o.commune}</Chip>)}{dossier.objects.length === 0 && <span className="small muted">Aucun objet</span>}</div>
              <h3 className="ac-section-title" style={{ marginTop: 12 }}>Obligations</h3>
              {dossier.obligations.length === 0 ? <p className="small muted">Aucune obligation.</p> : (
                <ul className="list-rows compact-rows">{dossier.obligations.map((o) => (
                  <li key={o.id} className="list-row"><div className="min0"><p className="row-title">{o.label}</p><p className="small muted">{o.entity} · échéance {fmtDate(o.dueDate)} · {o.status}</p></div>{o.amount && <MoneyText money={o.amount} />}</li>
                ))}</ul>
              )}
              <p className="small muted" style={{ marginTop: 8 }}>Chaque lecture est journalisée.</p>
            </section>
          )}
          <section className="panel" aria-labelledby="hist-title">
            <header className="panel-head"><h2 className="panel-title" id="hist-title">{reviewer ? 'Consultations à revoir' : 'Mes consultations'}</h2><span className="count">{list.data?.items.length ?? 0}</span></header>
            {list.loading && <Loading />}
            {list.error !== null && <ErrorState error={list.error} onRetry={list.reload} />}
            {list.data && (list.data.items.length === 0 ? <EmptyState title="Aucune consultation motivée" /> : (
              <DataTable rows={list.data.items} rowKey={(c) => c.id} caption="Consultations"
                columns={[
                  { key: 'who', label: 'Agent', render: (c) => <span className="mono small">{c.userId}</span> },
                  { key: 'tp', label: 'Dossier', primary: true, render: (c) => <><span className="row-title mono">{c.taxpayerId}</span><span className="small muted"> {PURPOSE_LABEL[c.purpose]}</span></> },
                  { key: 'mode', label: 'Mode', render: (c) => <Chip>{c.mode === 'PERIMETRE' ? 'Périmètre' : 'Bris de glace'}</Chip> },
                  { key: 'm', label: 'Motif', render: (c) => <span className="small">{c.motif}</span> },
                  { key: 'at', label: 'Date', render: (c) => fmtDate(c.grantedAt, true) },
                  { key: 'rv', label: 'Revue', render: (c) => c.review ? <span className="small">{c.review.conclusion === 'JUSTIFIEE' ? 'Justifiée' : 'Injustifiée'} ({c.review.by})</span>
                    : reviewer && c.userId !== user?.id ? (
                      <div className="ac-actions">
                        <input className="input-sm" aria-label="Observation" placeholder="Observation" value={notes[c.id] ?? ''} onChange={(e) => setNotes({ ...notes, [c.id]: e.target.value })} />
                        <button type="button" className="btn btn-secondary btn-sm" disabled={(notes[c.id] ?? '').trim().length < 5} onClick={() => void act.run(() => api(`/v1/acces/consultations/${c.id}/review`, { method: 'POST', body: { conclusion: 'JUSTIFIEE', note: notes[c.id] } }), 'Consultation revue : justifiée.').then(() => list.reload())}>Justifiée</button>
                        <button type="button" className="btn btn-ghost btn-sm" disabled={(notes[c.id] ?? '').trim().length < 5} onClick={() => void act.run(() => api(`/v1/acces/consultations/${c.id}/review`, { method: 'POST', body: { conclusion: 'INJUSTIFIEE', note: notes[c.id] } }), 'Consultation jugée injustifiée : dossier transmis (aucune sanction automatique).').then(() => list.reload())}>Injustifiée</button>
                      </div>
                    ) : c.userId === user?.id && new Date(c.expiresAt).getTime() > Date.now() ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openDossier(c.id)}>Ouvrir</button> : <span className="small muted">En attente</span> },
                ]} />
            ))}
            {!allowed && act.node}
          </section>
        </div>
      </div>
    </div>
  );
}
