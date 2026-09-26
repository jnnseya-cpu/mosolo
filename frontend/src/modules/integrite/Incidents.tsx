/** Incidents de sécurité : déclaration, gravité, propriétaire, cycle, notifications, clôture avec preuve. */
import { useState } from 'react';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { Drawer } from '../../components/Drawer';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { sha256Hex } from '../../lib/crypto';
import { useApp } from '../../context';
import { ActionError, hasRole, SEVERITY_LABELS, SeverityBadge, StateBadge, useAction } from './shared';
import './integrite.css';

interface Incident {
  id: string; title: string; description: string; category: string; severity: string; declaredBy: string; declaredAt: string; detectedAt: string;
  ownerId?: string; dueAt: string; status: string; personalDataImpacted: boolean; affectedTaxpayerIds: string[]; fromAlertId?: string; demo?: boolean;
  notifications: { target: string; by: string; at: string; note: string; deliveries: number }[];
  log: { at: string; by: string; status: string; note: string }[]; closure?: { proofSha256: string; summary: string; by: string; at: string };
  overdue: boolean; escalation: string | null;
}
interface CoreAlert { id: string; at: string; type: string; severity: string; detail: string }

const CATEGORY: Record<string, string> = {
  ACCES_NON_AUTORISE: 'Accès non autorisé', FUITE_DONNEES: 'Fuite de données', COMPROMISSION_APPAREIL: 'Appareil compromis',
  INDISPONIBILITE: 'Indisponibilité', FRAUDE_TECHNIQUE: 'Fraude technique', INTEGRITE_JOURNAL: 'Intégrité du journal', AUTRE: 'Autre',
};
const TARGETS: Record<string, string> = { DPO: 'Délégué à la protection des données', COMITE_SECURITE: 'Comité de sécurité', AUTORITE_COMPETENTE: 'Autorité compétente', PERSONNES_CONCERNEES: 'Personnes concernées' };
const NEXT: Record<string, string> = { DECLARE: 'EN_COURS', EN_COURS: 'CONTENU', CONTENU: 'RESOLU' };
const NEXT_LABEL: Record<string, string> = { EN_COURS: 'Prendre en charge', CONTENU: 'Déclarer contenu', RESOLU: 'Déclarer résolu' };

export default function Incidents() {
  const { user, fmtDate } = useApp();
  const canRead = hasRole(user?.roles, 'R28', 'R27', 'R26', 'R25', 'R22');
  const isAgent = !!user && user.roles.some((r) => Number.parseInt(r.slice(1), 10) <= 29);
  const list = useApi(canRead ? () => api<Incident[]>('/v1/integrite/incidents') : null, [user?.id]);
  const cands = useApi(canRead ? () => api<CoreAlert[]>('/v1/integrite/incidents/candidates') : null, [user?.id]);
  const [open, setOpen] = useState<string | null>(null);
  const [declare, setDeclare] = useState<{ fromAlert?: CoreAlert } | null>(null);
  const reload = () => { list.reload(); cands.reload(); };

  return (
    <div className="page page-wide ig-page">
      <PageHead eyebrow="Sécurité" title="Incidents de sécurité"
        lead="Chaque incident a un propriétaire, une gravité, un délai et une preuve de clôture. Un dépassement de délai déclenche une escalade d’information, jamais une correction automatique.">
        {isAgent && <button type="button" className="btn btn-primary" onClick={() => setDeclare({})}><Icon name="alert" size={18} /> Déclarer un incident</button>}
      </PageHead>
      {!canRead ? (
        <EmptyState title="Registre réservé" icon="lock">Tout agent peut déclarer un incident ; le registre est réservé à la sécurité, à l’exploitation, au DPO et à l’audit.</EmptyState>
      ) : (
        <>
          {cands.data && cands.data.length > 0 && (
            <section className="panel ig-cands" aria-labelledby="inc-cand">
              <h2 id="inc-cand" className="panel-title"><Icon name="antenna" size={18} /> Alertes techniques non rattachées <span className="count">{cands.data.length}</span></h2>
              <ul className="list-rows compact-rows">
                {cands.data.slice(0, 5).map((c) => (
                  <li key={c.id} className="list-row">
                    <span><span className="row-title">{c.type}</span> <span className="small muted">· {c.detail}</span></span>
                    {hasRole(user?.roles, 'R28', 'R27', 'R26', 'R25', 'R22') && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDeclare({ fromAlert: c })}>Déclarer</button>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="section" aria-labelledby="inc-list">
            <div className="section-head"><h2 id="inc-list">Registre</h2>{list.data && <span className="count">{list.data.length}</span>}</div>
            {list.loading && <Loading />}
            {list.error !== null && <ErrorState error={list.error} onRetry={list.reload} />}
            {list.data && (
              <DataTable rows={list.data} rowKey={(i) => i.id} caption="Incidents" empty={<EmptyState title="Aucun incident déclaré" icon="shieldCheck" />}
                columns={[
                  { key: 't', label: 'Incident', primary: true, render: (i) => <><button type="button" className="btn-link ig-rowlink" onClick={() => setOpen(i.id)}>{i.title}</button><span className="account-code">{i.id} · {CATEGORY[i.category]}</span></> },
                  { key: 'g', label: 'Gravité', render: (i) => <SeverityBadge value={i.severity} /> },
                  { key: 'o', label: 'Propriétaire', render: (i) => <span className="mono small">{i.ownerId ?? '—'}</span> },
                  { key: 'd', label: 'Échéance', render: (i) => <span className={`small ${i.overdue ? 'ig-late' : ''}`}>{fmtDate(i.dueAt, true)}{i.overdue ? ' · dépassée' : ''}</span> },
                  { key: 'p', label: 'Données perso.', render: (i) => (i.personalDataImpacted ? <span className="small"><Icon name="user" size={14} /> oui</span> : <span className="small muted">non</span>) },
                  { key: 's', label: 'État', render: (i) => <StateBadge value={i.status} /> },
                ]} />
            )}
            {list.data?.some((i) => i.demo) && <ExampleNotice text="Incidents de démonstration (fictifs)." />}
          </section>
        </>
      )}
      <Drawer open={!!declare} title="Déclarer un incident" onClose={() => setDeclare(null)}>
        {declare && <DeclareForm fromAlert={declare.fromAlert} onDone={() => { setDeclare(null); reload(); }} />}
      </Drawer>
      <Drawer open={!!open} title="Incident" onClose={() => setOpen(null)}>
        {open && list.data && <IncidentDetail inc={list.data.find((i) => i.id === open)!} onDone={reload} />}
      </Drawer>
    </div>
  );
}

function DeclareForm({ fromAlert, onDone }: { fromAlert?: CoreAlert; onDone: () => void }) {
  const [title, setTitle] = useState(fromAlert ? `Alerte ${fromAlert.type}` : '');
  const [description, setDescription] = useState(fromAlert?.detail ?? '');
  const [category, setCategory] = useState('ACCES_NON_AUTORISE');
  const [severity, setSeverity] = useState(fromAlert?.severity === 'CRITICAL' ? 'CRITIQUE' : 'ELEVEE');
  const [pd, setPd] = useState(false);
  const a = useAction();
  return (
    <div className="form">
      {fromAlert && <p className="callout callout-info"><Icon name="antenna" size={18} /><span>Rattaché à l’alerte du socle {fromAlert.id}.</span></p>}
      <div className="field"><label className="label" htmlFor="d-t">Intitulé</label><input id="d-t" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
      <div className="field"><label className="label" htmlFor="d-d">Description</label><textarea id="d-d" rows={4} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="d-c">Catégorie</label><select id="d-c" value={category} onChange={(e) => setCategory(e.target.value)}>{Object.entries(CATEGORY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="field"><label className="label" htmlFor="d-s">Gravité</label><select id="d-s" value={severity} onChange={(e) => setSeverity(e.target.value)}>{Object.entries(SEVERITY_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
      </div>
      <label className="check"><input type="checkbox" checked={pd} onChange={(e) => setPd(e.target.checked)} /><span>Des données personnelles sont ou peuvent être concernées</span></label>
      <p className="hint">Délais de traitement de démonstration, paramétrables : critique 24 h, élevée 72 h, moyenne 7 j, faible 30 j.</p>
      <ActionError error={a.error} />
      <button type="button" className="btn btn-primary" disabled={a.busy || title.trim().length < 5 || description.trim().length < 10} onClick={async () => {
        if (await a.run(() => api('/v1/integrite/incidents', { method: 'POST', body: { title, description, category, severity, personalDataImpacted: pd, ...(fromAlert ? { fromAlertId: fromAlert.id } : {}) } }))) onDone();
      }}>Déclarer</button>
    </div>
  );
}

function IncidentDetail({ inc, onDone }: { inc: Incident; onDone: () => void }) {
  const { user, users, fmtDate } = useApp();
  const a = useAction();
  const [note, setNote] = useState('');
  const [owner, setOwner] = useState('');
  const [target, setTarget] = useState('COMITE_SECURITE');
  const [summary, setSummary] = useState('');
  const [proofText, setProofText] = useState('');
  const roles = user?.roles;
  const manage = hasRole(roles, 'R28', 'R27');
  const post = async (path: string, body: unknown) => { if (await a.run(() => api(`/v1/integrite/incidents/${inc.id}/${path}`, { method: 'POST', body }))) { setNote(''); onDone(); } };
  if (!inc) return <EmptyState title="Incident introuvable" />;
  const owners = (users ?? []).filter((u) => u.roles.some((r) => ['R26', 'R27', 'R28'].includes(r)));
  const next = NEXT[inc.status];
  const targets = Object.entries(TARGETS).filter(([k]) => (k === 'PERSONNES_CONCERNEES' ? hasRole(roles, 'R25') && inc.personalDataImpacted : hasRole(roles, 'R28', 'R25')));
  return (
    <div className="ig-stack">
      <div className="panel-head"><div><p className="row-title">{inc.title}</p><p className="panel-sub">{inc.id} · {CATEGORY[inc.category]}</p></div><span className="ig-inline"><SeverityBadge value={inc.severity} /><StateBadge value={inc.status} /></span></div>
      {inc.escalation && <p className="callout callout-warn"><Icon name="clock" size={18} /><span>{inc.escalation}</span></p>}
      <p>{inc.description}</p>
      <dl className="kv kv-dense">
        <div><dt>Détecté</dt><dd>{fmtDate(inc.detectedAt, true)}</dd></div>
        <div><dt>Déclaré par</dt><dd className="mono">{inc.declaredBy}</dd></div>
        <div><dt>Échéance</dt><dd>{fmtDate(inc.dueAt, true)}</dd></div>
        <div><dt>Propriétaire</dt><dd className="mono">{inc.ownerId ?? 'à désigner'}</dd></div>
        <div><dt>Données personnelles</dt><dd>{inc.personalDataImpacted ? `Oui (${inc.affectedTaxpayerIds.length} personne(s) identifiée(s))` : 'Non'}</dd></div>
        {inc.closure && <div><dt>Preuve de clôture</dt><dd className="mono small">{inc.closure.proofSha256.slice(0, 24)}…</dd></div>}
      </dl>
      <h3 className="ig-h3">Journal</h3>
      <ul className="ig-history">{inc.log.map((l, i) => <li key={i}><span className="mono small">{fmtDate(l.at, true)}</span> <StateBadge value={l.status} /> <span className="small">{l.note}</span> <span className="small muted">{l.by}</span></li>)}</ul>
      {inc.notifications.length > 0 && (<><h3 className="ig-h3">Notifications</h3>
        <ul className="ig-history">{inc.notifications.map((n, i) => <li key={i}><span className="mono small">{fmtDate(n.at, true)}</span> <span className="small">{TARGETS[n.target]}</span> <span className="small muted">{n.note}{n.deliveries ? ` · ${n.deliveries} envoi(s)` : ''}</span></li>)}</ul></>)}
      <ActionError error={a.error} />
      {manage && inc.status !== 'CLOS' && (
        <fieldset className="line-box"><legend className="label">Pilotage</legend>
          <div className="input-row">
            <select aria-label="Propriétaire" value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">Désigner un propriétaire…</option>{owners.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
            <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy || !owner} onClick={() => void post('assign', { ownerId: owner })}>Désigner</button>
          </div>
          {next && (<>
            <textarea aria-label="Note d’étape" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note d’étape" />
            <button type="button" className="btn btn-primary btn-sm" disabled={a.busy || note.trim().length < 5 || !inc.ownerId} onClick={() => void post('status', { status: next, note })}>{NEXT_LABEL[next]}</button>
            {!inc.ownerId && <p className="hint">Désignez d’abord un propriétaire.</p>}
          </>)}
        </fieldset>
      )}
      {targets.length > 0 && inc.status !== 'CLOS' && (
        <fieldset className="line-box"><legend className="label">Notifier</legend>
          <select aria-label="Destinataire" value={target} onChange={(e) => setTarget(e.target.value)}>{targets.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <textarea aria-label="Motif de la notification" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
          <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy || note.trim().length < 5} onClick={() => void post('notifications', { target, note })}><Icon name="send" size={16} /> Notifier</button>
          <p className="hint">L’information des personnes concernées est décidée par le DPO.</p>
        </fieldset>
      )}
      {hasRole(roles, 'R28') && inc.status === 'RESOLU' && (
        <fieldset className="line-box"><legend className="label">Clôturer avec preuve</legend>
          <textarea aria-label="Rapport de clôture" rows={3} value={proofText} onChange={(e) => setProofText(e.target.value)} placeholder="Rapport de clôture (son empreinte SHA-256 est scellée)" />
          <textarea aria-label="Synthèse" rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Synthèse (10 caractères au moins)" />
          <button type="button" className="btn btn-primary btn-sm" disabled={a.busy || summary.trim().length < 10 || proofText.trim().length < 10} onClick={async () => {
            const proofSha256 = await sha256Hex(proofText);
            await post('close', { proofSha256, summary });
          }}>Clôturer</button>
        </fieldset>
      )}
    </div>
  );
}
