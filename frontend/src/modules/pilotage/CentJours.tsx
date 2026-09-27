/**
 * Plan des 100 premiers jours (Document maître FR 2, ch. 47) : six périodes, actions citées mot pour mot et
 * responsables ; jour 1 fixé par une personne habilitée ; chaque action suivie par une personne (état, note, preuve),
 * avec une instruction de suivi facultative émise par le circuit des instructions du pilotage.
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import { Section } from './shared';
import { Area, Callout, Choice, Field, hasRole, Notice, useRunner } from './planif';
import type { ActionPlan, CentJoursPlan } from './programme-types';
import './pilotage.css';

const TONE: Record<string, 'good' | 'warning' | 'critical' | 'neutral'> = { A_FAIRE: 'neutral', EN_COURS: 'warning', FAITE: 'good', BLOQUEE: 'critical' };

function ActionForm({ a, canInstruct, onDone }: { a: ActionPlan; canInstruct: boolean; onDone: () => void }) {
  const r = useRunner(onDone);
  const [f, setF] = useState({ etat: a.etat, note: '', entity: 'MINFIN' });
  return (
    <div className="form">
      <Notice msg={r.msg} />
      <Choice label={`État — ${a.action}`} value={f.etat} onChange={(x) => setF({ ...f, etat: x })} options={[['A_FAIRE', 'À faire'], ['EN_COURS', 'En cours'], ['FAITE', 'Faite'], ['BLOQUEE', 'Bloquée']]} />
      <Area label="Note (10 caractères minimum)" value={f.note} onChange={(x) => setF({ ...f, note: x })} rows={2} />
      <div className="btn-row">
        <button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/pilotage/programme/cent-jours/actions/${a.id}/etat`, { etat: f.etat, note: f.note }, 'Action mise à jour.')}>Enregistrer</button>
        {canInstruct && !a.instruction && <>
          <Field label="Entité destinataire de l’instruction" value={f.entity} onChange={(x) => setF({ ...f, entity: x.toUpperCase() })} />
          <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/pilotage/programme/cent-jours/actions/${a.id}/instruction`, { entity: f.entity }, 'Instruction de suivi émise.')}>Émettre une instruction de suivi</button>
        </>}
      </div>
    </div>
  );
}

export function CentJoursView({ p, onDone }: { p: CentJoursPlan; onDone: () => void }) {
  const { user } = useApp();
  const r = useRunner(onDone);
  const [start, setStart] = useState({ debut: '', motif: '' });
  const [edit, setEdit] = useState<string | null>(null);
  const canWrite = hasRole(user?.roles, 'R01', 'R02', 'R03', 'R05');
  const canInstruct = hasRole(user?.roles, 'R01', 'R02', 'R03');
  const all = p.periodes.flatMap((x) => x.actions);
  const sel = all.find((a) => a.id === edit) ?? null;
  return (
    <div className="dash-grid">
      <Section title="Jour 1" sub={p.demarrage ? `Fixé au ${p.demarrage.debut} — jour ${p.jour}` : 'Non fixé'}>
        <p className="small">{p.synthese.faites} action(s) faite(s) sur {p.synthese.actions} · {p.synthese.enRetard} en retard.</p>
        {!p.demarrage && <Callout tone="warn">Le jour 1 est fixé par la décision provinciale : aucune action n’est suivie avant.</Callout>}
        {canWrite && (
          <div className="form">
            <Notice msg={r.msg} />
            <Field label="Date du jour 1" type="date" value={start.debut} onChange={(x) => setStart({ ...start, debut: x })} />
            <Field label="Motif (10 caractères minimum)" value={start.motif} onChange={(x) => setStart({ ...start, motif: x })} />
            <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run('/v1/pilotage/programme/cent-jours/demarrage', start, 'Jour 1 enregistré.')}>Fixer le jour 1</button></div>
          </div>
        )}
      </Section>
      {p.periodes.map((per) => (
        <Section key={per.code} title={`Jours ${per.jours}`} sub={`Responsable : ${per.responsable}${per.echeance ? ` · échéance ${per.echeance}` : ''}`}>
          <DataTable caption={`Actions des jours ${per.jours}`} rows={per.actions} rowKey={(a) => a.id} columns={[
            { key: 'a', label: 'Action', primary: true, render: (a) => <>{a.action}{a.lien && <span className="small muted" style={{ display: 'block' }}>Dans la plateforme : {a.lien}</span>}</> },
            { key: 'e', label: 'État', render: (a) => <>{<StatusBadge tone={TONE[a.etat] ?? 'neutral'} label={a.etatLibelle} />}{a.enRetard && <StatusBadge tone="critical" label="En retard" />}</> },
            { key: 'i', label: 'Instruction', render: (a) => (a.instruction ? <span className="small">{a.instruction.number} · {a.instruction.status} · échéance {a.instruction.deadline}</span> : '—') },
            { key: 'x', label: 'Suivi', render: (a) => (canWrite && p.demarrage ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEdit(edit === a.id ? null : a.id)}>{edit === a.id ? 'Fermer' : 'Mettre à jour'}</button> : <span className="small muted">Lecture</span>) },
          ]} />
          {sel && per.actions.some((a) => a.id === sel.id) && <ActionForm key={sel.id} a={sel} canInstruct={canInstruct} onDone={onDone} />}
        </Section>
      ))}
    </div>
  );
}

export default function CentJours() {
  const { user } = useApp();
  const q = useApi(() => api<CentJoursPlan>('/v1/pilotage/programme/cent-jours'), [user?.id]);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Programme · ch. 47" title="Plan des 100 premiers jours" lead="Six périodes, leurs actions et leurs responsables ; chaque action suivie par une personne, avec instruction de suivi si nécessaire." />
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : q.data && <CentJoursView p={q.data} onDone={q.reload} />}
    </div>
  );
}
