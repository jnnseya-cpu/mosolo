/**
 * Protection des données : espace du délégué (R25) — demandes des personnes, registre des traitements, journal des consultations —
 * et, pour le contribuable, dépôt et suivi de ses demandes d'accès ou de rectification.
 */
import { useState } from 'react';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { Drawer } from '../../components/Drawer';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { useApp } from '../../context';
import { ActionError, hasRole, StateBadge, Tabs, useAction } from './shared';
import './integrite.css';

interface PReq {
  id: string; taxpayerId: string; type: string; details: string; field?: string; requestedValue?: string; submittedBy: string; submittedAt: string;
  dueAt: string; status: string; response?: { decision: string; note: string; at: string }; exportReady?: boolean; overdue: boolean; delayNote: string;
  firstDecision?: { by: string; at: string; note: string };
  execution?: { at: string; by: string; treated: { field: string }[]; retained: { data: string; reason: string }[] };
}
type PType = 'ACCES' | 'RECTIFICATION' | 'LIMITATION' | 'EFFACEMENT';
/** Libellés des types de demande (limitation et effacement ajoutés le 27/09/2026 : décision à deux personnes). */
const TYPE_LABELS: Record<PType, string> = {
  ACCES: 'Droit d’accès (et portabilité)', RECTIFICATION: 'Rectification', LIMITATION: 'Limitation — retrait du consentement', EFFACEMENT: 'Effacement (anonymisation)',
};
const typeLabel = (r: { type: string; field?: string }) => (r.type === 'RECTIFICATION' ? `Rectification — ${FIELD_LABELS[r.field ?? ''] ?? ''}` : TYPE_LABELS[r.type as PType] ?? r.type);
interface Proc {
  id: string; version: number; name: string; purpose: string; legalBasis: string; dataCategories: string[]; dataSubjects: string[]; recipients: string[];
  retention: string; security: string[]; module: string; sensitive: boolean; updatedAt: string; updatedBy: string;
}
interface LogRow { at: string; action: string; actor: string; actorKind: string; resourceType: string; resourceId: string | null; outcome: string }

const FIELD_LABELS: Record<string, string> = { fullName: 'Nom complet', email: 'Adresse électronique', language: 'Langue de communication' };
const LOG_LABELS: Record<string, string> = { 'taxpayer.viewed': 'Consultation d’un dossier', 'obligation.viewed': 'Consultation d’une obligation', 'integrite.privacy.export_downloaded': 'Téléchargement d’un export', 'access.denied': 'Accès refusé' };

export default function EspaceDonnees() {
  const { user } = useApp();
  const isDpo = hasRole(user?.roles, 'R25');
  const canRegistry = hasRole(user?.roles, 'R25', 'R22', 'R23', 'R28', 'R26');
  const isPerson = hasRole(user?.roles, 'R30', 'R31');
  const [tab, setTab] = useState<'demandes' | 'registre' | 'journal'>(isDpo || isPerson ? 'demandes' : 'registre');
  if (!isDpo && !canRegistry && !isPerson) {
    return (
      <div className="page"><PageHead eyebrow="Protection des données" title="Vos données" />
        <EmptyState title="Accès réservé" icon="lock">Espace réservé au délégué à la protection des données, à l’audit et aux personnes concernées.</EmptyState></div>
    );
  }
  const items: { id: 'demandes' | 'registre' | 'journal'; label: string }[] = [];
  if (isDpo || isPerson) items.push({ id: 'demandes', label: isDpo ? 'Demandes des personnes' : 'Mes demandes' });
  if (canRegistry) items.push({ id: 'registre', label: 'Registre des traitements' });
  if (hasRole(user?.roles, 'R25', 'R22')) items.push({ id: 'journal', label: 'Journal des consultations' });
  return (
    <div className="page page-wide ig-page">
      <PageHead eyebrow="Protection des données" title={isPerson && !isDpo ? 'Vos données personnelles' : 'Espace du délégué à la protection des données'}
        lead={isPerson && !isDpo
          ? 'Demandez l’accès à vos données et à l’historique des actions sur votre dossier, ou la rectification d’une donnée inexacte.'
          : 'Droits des personnes, registre des traitements et contrôle des consultations. Chaque décision est motivée et journalisée.'} />
      {items.length > 1 && <Tabs label="Rubriques" value={tab} onChange={setTab} items={items} />}
      {tab === 'demandes' && (isDpo ? <DpoRequests /> : <MyRequests />)}
      {tab === 'registre' && canRegistry && <Registry editable={isDpo} />}
      {tab === 'journal' && <AccessLog />}
    </div>
  );
}

function MyRequests() {
  const { user, fmtDate } = useApp();
  const list = useApi(() => api<PReq[]>('/v1/integrite/privacy/requests'), [user?.id]);
  const [type, setType] = useState<PType>('ACCES');
  const [details, setDetails] = useState('');
  const [field, setField] = useState('fullName');
  const [value, setValue] = useState('');
  const [exp, setExp] = useState<unknown>(null);
  const a = useAction();
  const taxpayerId = user?.taxpayerId;
  return (
    <div className="two-col">
      <section className="panel" aria-labelledby="my-new">
        <h2 id="my-new" className="panel-title">Nouvelle demande</h2>
        {!taxpayerId ? <p className="small muted">Demande à déposer au nom du contribuable représenté, depuis le guichet.</p> : (
          <div className="form">
            <div className="seg" role="group" aria-label="Type de demande">
              <button type="button" aria-pressed={type === 'ACCES'} onClick={() => setType('ACCES')}>Accès</button>
              <button type="button" aria-pressed={type === 'RECTIFICATION'} onClick={() => setType('RECTIFICATION')}>Rectification</button>
              <button type="button" aria-pressed={type === 'LIMITATION'} onClick={() => setType('LIMITATION')}>Limitation</button>
              <button type="button" aria-pressed={type === 'EFFACEMENT'} onClick={() => setType('EFFACEMENT')}>Effacement</button>
            </div>
            {(type === 'LIMITATION' || type === 'EFFACEMENT') && (
              <p className="hint">{type === 'LIMITATION'
                ? 'Les messages facultatifs et vos consentements (WhatsApp, canal préféré) sont retirés ; les avis obligatoires qui protègent vos droits restent envoyés.'
                : 'Les données non exigées par la loi fiscale (adresse électronique, préférences, mémoire de l’assistant) sont anonymisées. Votre identité fiscale, vos obligations, paiements et quittances sont conservés au titre de la loi.'} Décision prise par deux personnes.</p>
            )}
            {type === 'RECTIFICATION' && (
              <div className="field-row">
                <div className="field"><label className="label" htmlFor="my-f">Donnée</label><select id="my-f" value={field} onChange={(e) => setField(e.target.value)}>{Object.entries(FIELD_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
                <div className="field"><label className="label" htmlFor="my-v">Valeur exacte</label><input id="my-v" value={value} onChange={(e) => setValue(e.target.value)} /></div>
              </div>
            )}
            <div className="field"><label className="label" htmlFor="my-d">Précisions</label><textarea id="my-d" rows={3} value={details} onChange={(e) => setDetails(e.target.value)} /></div>
            <p className="hint">Le numéro de téléphone se modifie par le parcours de récupération de compte (vérification requise).</p>
            <ActionError error={a.error} />
            <button type="button" className="btn btn-primary" disabled={a.busy || details.trim().length < 5 || (type === 'RECTIFICATION' && !value.trim())} onClick={async () => {
              const body = { taxpayerId, type, details, ...(type === 'RECTIFICATION' ? { field, requestedValue: value } : {}) };
              if (await a.run(() => api('/v1/integrite/privacy/requests', { method: 'POST', body }))) { setDetails(''); setValue(''); list.reload(); }
            }}><Icon name="send" size={18} /> Déposer</button>
          </div>
        )}
      </section>
      <section className="panel" aria-labelledby="my-list">
        <h2 id="my-list" className="panel-title">Mes demandes</h2>
        {list.loading && <Loading />}
        {list.error !== null && <ErrorState error={list.error} onRetry={list.reload} />}
        {list.data && (list.data.length === 0 ? <EmptyState title="Aucune demande" /> : (
          <ul className="list-rows">
            {list.data.map((r) => (
              <li key={r.id} className="list-row">
                <span><span className="row-title">{r.type === 'ACCES' ? 'Accès à mes données' : typeLabel(r)}</span><span className="account-code">{r.id} · déposée le {fmtDate(r.submittedAt)}</span></span>
                <span className="row-side"><StateBadge value={r.status} />
                  {r.exportReady && <button type="button" className="btn btn-secondary btn-sm" onClick={async () => setExp(await api(`/v1/integrite/privacy/requests/${r.id}/export`))}><Icon name="download" size={16} /> Voir l’export</button>}
                </span>
                {r.response && <p className="small muted ig-block">Réponse : {r.response.note}</p>}
              </li>
            ))}
          </ul>
        ))}
      </section>
      <Drawer open={exp !== null} title="Export de vos données" onClose={() => setExp(null)}>
        <pre className="ig-json">{JSON.stringify(exp, null, 2)}</pre>
      </Drawer>
    </div>
  );
}

function DpoRequests() {
  const { user, fmtDate } = useApp();
  const list = useApi(() => api<PReq[]>('/v1/integrite/privacy/requests'), [user?.id]);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [exp, setExp] = useState<unknown>(null);
  const a = useAction();
  const cur = list.data?.find((r) => r.id === open);
  const act = async (path: string, body?: unknown) => { if (await a.run(() => api(`/v1/integrite/privacy/requests/${open}/${path}`, { method: 'POST', body: body ?? {} }))) { setNote(''); list.reload(); } };
  return (
    <section className="section">
      {list.loading && <Loading />}
      {list.error !== null && <ErrorState error={list.error} onRetry={list.reload} />}
      {list.data && (
        <>
          <DataTable rows={list.data} rowKey={(r) => r.id} caption="Demandes des personnes" empty={<EmptyState title="Aucune demande" />}
            columns={[
              { key: 'id', label: 'Demande', primary: true, render: (r) => <><button type="button" className="btn-link ig-rowlink" onClick={() => setOpen(r.id)}>{typeLabel({ type: r.type })}</button><span className="account-code">{r.id}</span></> },
              { key: 'tp', label: 'Personne', render: (r) => <span className="mono small">{r.taxpayerId}</span> },
              { key: 'at', label: 'Reçue', render: (r) => <span className="small">{fmtDate(r.submittedAt)}</span> },
              { key: 'due', label: 'Échéance', render: (r) => <span className={`small ${r.overdue ? 'ig-late' : ''}`}>{fmtDate(r.dueAt)}{r.overdue ? ' · dépassée' : ''}</span> },
              { key: 'st', label: 'État', render: (r) => <StateBadge value={r.status} /> },
            ]} />
          <p className="hint ig-note">{list.data[0]?.delayNote ?? ''} Délai légal à confirmer au regard du Code du numérique.</p>
        </>
      )}
      <Drawer open={!!cur} title="Demande de la personne" onClose={() => setOpen(null)}>
        {cur && (
          <div className="ig-stack">
            <div className="panel-head"><div><p className="row-title">{typeLabel({ type: cur.type })}</p><p className="panel-sub">{cur.id} · {cur.taxpayerId}</p></div><StateBadge value={cur.status} /></div>
            <dl className="kv kv-dense">
              <div><dt>Précisions</dt><dd>{cur.details}</dd></div>
              {cur.field && <div><dt>Donnée</dt><dd>{FIELD_LABELS[cur.field]}</dd></div>}
              {cur.requestedValue && <div><dt>Valeur demandée</dt><dd>{cur.requestedValue}</dd></div>}
              <div><dt>Déposée par</dt><dd className="mono">{cur.submittedBy}</dd></div>
              {cur.firstDecision && <div><dt>Première décision</dt><dd>{cur.firstDecision.by} — {cur.firstDecision.note}</dd></div>}
              {cur.response && <div><dt>Réponse</dt><dd>{cur.response.decision} — {cur.response.note}</dd></div>}
              {cur.execution && <div><dt>Conservé au titre de la loi</dt><dd>{cur.execution.retained.map((x) => x.data).join(' ; ')}</dd></div>}
            </dl>
            <ActionError error={a.error} />
            {cur.status === 'RECUE' && <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy} onClick={() => void act('take')}>Prendre en charge</button>}
            {(cur.status === 'RECUE' || cur.status === 'EN_TRAITEMENT') && (
              <fieldset className="line-box"><legend className="label">Répondre</legend>
                <textarea aria-label="Motif de la réponse" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder={cur.type === 'RECTIFICATION' ? 'Pièce justificative vérifiée…' : 'Périmètre de l’export…'} />
                <div className="btn-row">
                  <button type="button" className="btn btn-primary btn-sm" disabled={a.busy || note.trim().length < 5} onClick={() => void act('respond', { decision: 'ACCEPTEE', note })}>{cur.type === 'ACCES' ? 'Établir l’export' : cur.type === 'RECTIFICATION' ? 'Rectifier' : 'Proposer (seconde validation requise)'}</button>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy || note.trim().length < 5} onClick={() => void act('respond', { decision: 'REJETEE', note })}>Rejeter (motivé)</button>
                </div>
              </fieldset>
            )}
            {cur.status === 'EN_ATTENTE_SECONDE_VALIDATION' && (
              <fieldset className="line-box"><legend className="label">Seconde validation (autre personne que {cur.firstDecision?.by})</legend>
                <textarea aria-label="Motif de la seconde validation" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
                <div className="btn-row">
                  <button type="button" className="btn btn-primary btn-sm" disabled={a.busy || note.trim().length < 5} onClick={() => void act('validation', { approve: true, note })}>Valider et exécuter</button>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy || note.trim().length < 5} onClick={() => void act('validation', { approve: false, note })}>Refuser (motivé)</button>
                </div>
              </fieldset>
            )}
            {cur.exportReady && <button type="button" className="btn btn-secondary btn-sm" onClick={async () => setExp(await api(`/v1/integrite/privacy/requests/${cur.id}/export`))}><Icon name="download" size={16} /> Consulter l’export</button>}
            {exp !== null && <pre className="ig-json">{JSON.stringify(exp, null, 2)}</pre>}
          </div>
        )}
      </Drawer>
    </section>
  );
}

function Registry({ editable }: { editable: boolean }) {
  const { user, fmtDate } = useApp();
  const list = useApi(() => api<Proc[]>('/v1/integrite/privacy/registry'), [user?.id]);
  const [edit, setEdit] = useState<Proc | null>(null);
  return (
    <section className="section">
      {list.loading && <Loading />}
      {list.error !== null && <ErrorState error={list.error} onRetry={list.reload} />}
      {list.data && (
        <div className="ig-registry">
          {list.data.map((p) => (
            <article key={p.id} className="panel">
              <div className="panel-head">
                <div><h3 className="panel-title">{p.name}{p.sensitive && <span className="ig-tag">Sensible</span>}</h3><p className="panel-sub">{p.id} · version {p.version} · {fmtDate(p.updatedAt)} · module {p.module}</p></div>
                {editable && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEdit(p)}><Icon name="replace" size={16} /> Réviser</button>}
              </div>
              <p className="small">{p.purpose}</p>
              <dl className="kv kv-dense">
                <div><dt>Base légale</dt><dd>{p.legalBasis}</dd></div>
                <div><dt>Données</dt><dd>{p.dataCategories.join(', ')}</dd></div>
                <div><dt>Personnes</dt><dd>{p.dataSubjects.join(', ')}</dd></div>
                <div><dt>Destinataires</dt><dd>{p.recipients.join(', ')}</dd></div>
                <div><dt>Conservation</dt><dd>{p.retention}</dd></div>
                <div><dt>Sécurité</dt><dd>{p.security.join(', ')}</dd></div>
              </dl>
            </article>
          ))}
        </div>
      )}
      <Drawer open={!!edit} title="Réviser le traitement" onClose={() => setEdit(null)}>
        {edit && <RegistryForm rec={edit} onDone={() => { setEdit(null); list.reload(); }} />}
      </Drawer>
    </section>
  );
}

function RegistryForm({ rec, onDone }: { rec: Proc; onDone: () => void }) {
  const [purpose, setPurpose] = useState(rec.purpose);
  const [legalBasis, setLegalBasis] = useState(rec.legalBasis);
  const [retention, setRetention] = useState(rec.retention);
  const a = useAction();
  return (
    <div className="form">
      <p className="hint">Une révision crée une nouvelle version ; la précédente reste consultable.</p>
      <div className="field"><label className="label" htmlFor="r-p">Finalité</label><textarea id="r-p" rows={3} value={purpose} onChange={(e) => setPurpose(e.target.value)} /></div>
      <div className="field"><label className="label" htmlFor="r-l">Base légale</label><input id="r-l" value={legalBasis} onChange={(e) => setLegalBasis(e.target.value)} /></div>
      <div className="field"><label className="label" htmlFor="r-r">Durée de conservation</label><input id="r-r" value={retention} onChange={(e) => setRetention(e.target.value)} /></div>
      <ActionError error={a.error} />
      <button type="button" className="btn btn-primary" disabled={a.busy} onClick={async () => {
        const { version: _v, updatedAt: _u, updatedBy: _b, ...rest } = rec;
        if (await a.run(() => api('/v1/integrite/privacy/registry', { method: 'POST', body: { ...rest, purpose, legalBasis, retention } }))) onDone();
      }}>Enregistrer la nouvelle version</button>
    </div>
  );
}

function AccessLog() {
  const { user, fmtDate } = useApp();
  const [tp, setTp] = useState('');
  const [q, setQ] = useState('');
  const list = useApi(() => api<LogRow[]>(`/v1/integrite/privacy/access-log${q ? `?taxpayerId=${encodeURIComponent(q)}` : ''}`), [user?.id, q]);
  return (
    <section className="section">
      <form className="input-row ig-filter" onSubmit={(e) => { e.preventDefault(); setQ(tp.trim()); }}>
        <label className="sr-only" htmlFor="log-tp">Identifiant de la personne</label>
        <input id="log-tp" value={tp} onChange={(e) => setTp(e.target.value)} placeholder="Filtrer par identifiant de contribuable" />
        <button type="submit" className="btn btn-secondary">Filtrer</button>
      </form>
      {list.loading && <Loading />}
      {list.error !== null && <ErrorState error={list.error} onRetry={list.reload} />}
      {list.data && (
        <DataTable rows={list.data} rowKey={(r) => `${r.at}-${r.action}-${r.actor}-${r.resourceId}`} caption="Journal des consultations" empty={<EmptyState title="Aucune consultation journalisée" />}
          columns={[
            { key: 'at', label: 'Date', render: (r) => <span className="small">{fmtDate(r.at, true)}</span> },
            { key: 'a', label: 'Événement', primary: true, render: (r) => <span>{LOG_LABELS[r.action] ?? r.action}</span> },
            { key: 'who', label: 'Acteur', render: (r) => <span className="mono small">{r.actor}</span> },
            { key: 'res', label: 'Objet', render: (r) => <span className="small">{r.resourceType} · {r.resourceId ?? '—'}</span> },
            { key: 'o', label: 'Issue', render: (r) => <span className={`small ${r.outcome === 'DENIED' ? 'ig-late' : ''}`}>{r.outcome === 'DENIED' ? 'Refusé' : 'Autorisé'}</span> },
          ]} />
      )}
    </section>
  );
}
