import { useState } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { DataTable } from '../../components/DataTable';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { api, asList, describeError } from '../../lib/api';
import { ENTITIES } from './labels';
import type { MemoryLevel } from './types';
import { MemoireVisuels } from './visuels';

type Level = 'UTILISATEUR' | 'ENTITE' | 'PROCESSUS' | 'INTELLIGENCE';
const TABS: { id: Level; label: string }[] = [
  { id: 'UTILISATEUR', label: 'Utilisateur' }, { id: 'ENTITE', label: 'Espace (entité)' }, { id: 'PROCESSUS', label: 'Processus' }, { id: 'INTELLIGENCE', label: 'Intelligence' },
];

/** Explorateur de la mémoire structurée à quatre niveaux (§ 23.5.4) : consultation, conservation, effacement contrôlé. */
export default function IaMemory() {
  const { user } = useApp();
  const levels = useApi(async () => asList<MemoryLevel>(await api<unknown>('/v1/ia/memory/levels')), [user?.id]);
  const [tab, setTab] = useState<Level>('UTILISATEUR');
  const def = (levels.data ?? []).find((l) => l.level === tab);
  const taxpayer = (user?.roles ?? []).every((r) => r === 'R30' || r === 'R31');
  const tabs = taxpayer ? TABS.filter((t) => t.id === 'UTILISATEUR' || t.id === 'PROCESSUS') : TABS;
  return (
    <div className="stack">
      <div className="seg seg-wrap" role="tablist" aria-label="Niveaux de mémoire">
        {tabs.map((t) => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>
      {def && (
        <section className="panel ia-memdef">
          <h2 className="panel-title"><Icon name="lock" size={16} /> {def.label}</h2>
          <dl className="kv kv-dense">
            <div><dt>Contenu</dt><dd>{def.contenu}</dd></div>
            <div><dt>Limites</dt><dd>{def.limites}</dd></div>
            <div><dt>Conservation</dt><dd>{def.conservation} <span className="small muted">(proposition, à valider par le délégué à la protection des données)</span></dd></div>
            <div><dt>Consultation</dt><dd>{def.consultation}</dd></div>
            <div><dt>Effacement</dt><dd>{def.effacement}</dd></div>
          </dl>
        </section>
      )}
      {tab === 'UTILISATEUR' && <UserMemory />}
      {tab === 'ENTITE' && <EntityMemory />}
      {tab === 'PROCESSUS' && <ProcessMemory />}
      {tab === 'INTELLIGENCE' && <IntelligenceMemory />}
      {(user?.roles ?? []).some((r) => r === 'R25' || r === 'R22') && <Register />}
    </div>
  );
}

interface UserMem {
  audience: string; items: Record<string, { value: string | string[]; updatedAt: string; source: string }>; frequentTasks: Record<string, number>;
  savedOutputs: string[]; allowedKeys: string[]; retention: string; expiresAt: string; notice: string; role: string;
}

function UserMemory() {
  const { user, fmtDate } = useApp();
  const q = useApi(async () => api<UserMem>('/v1/ia/memory/me'), [user?.id]);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function act(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); q.reload(); } catch (e) { setMsg({ ok: false, text: describeError(e).message }); }
  }
  if (q.loading) return <Loading />;
  if (q.error !== null) return <ErrorState error={q.error} onRetry={q.reload} />;
  const m = q.data!;
  const entries = Object.entries(m.items);
  return (
    <section className="panel">
      <header className="panel-head">
        <h2 className="panel-title">Ma mémoire</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void act(() => api('/v1/ia/memory/me', { method: 'DELETE' }), 'Mémoire effacée.')}><Icon name="x" size={16} /> Tout effacer</button>
      </header>
      <p className="callout callout-info"><Icon name="info" size={16} /> <span>{m.notice} Conservation : {m.retention} (échéance actuelle : {fmtDate(m.expiresAt)}).</span></p>
      <MemoireVisuels frequentTasks={m.frequentTasks} items={entries.length} />
      <dl className="kv kv-dense">
        <div><dt>Rôle</dt><dd>{m.role}</dd></div>
        {entries.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd className="ia-kv-action"><span>{Array.isArray(v.value) ? v.value.join(', ') : v.value}</span>
            <button type="button" className="btn btn-ghost btn-sm" aria-label={`Effacer ${k}`} onClick={() => void act(() => api(`/v1/ia/memory/me?key=${encodeURIComponent(k)}`, { method: 'DELETE' }), `« ${k} » effacé.`)}><Icon name="x" size={14} /></button></dd></div>
        ))}
        {m.audience === 'AGENT_PUBLIC' && <div><dt>Tâches fréquentes</dt><dd>{Object.entries(m.frequentTasks).map(([a, n]) => `${a} (${n})`).join(', ') || '—'}</dd></div>}
        <div><dt>Sorties enregistrées</dt><dd>{m.savedOutputs.join(', ') || '—'}</dd></div>
      </dl>
      <div className="field-row ia-mem-form">
        <label className="field"><span className="label">Clé</span>
          <select value={key} onChange={(e) => setKey(e.target.value)}><option value="">Choisir…</option>{m.allowedKeys.map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
        <label className="field"><span className="label">Valeur</span><input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Aucune coordonnée ni identifiant" /></label>
      </div>
      <div className="btn-row">
        <button type="button" className="btn btn-primary btn-sm" disabled={!key || !value.trim()} onClick={() => void act(() => api('/v1/ia/memory/me', { method: 'PUT', body: { key, value: value.trim() } }), 'Préférence enregistrée.')}>Enregistrer</button>
      </div>
      {msg && <p role="status" className={msg.ok ? 'notice notice-ok' : 'notice notice-err'}>{msg.text}</p>}
    </section>
  );
}

interface EntItem { id: string; kind: string; title: string; content: string; createdAt: string; retainUntil: string; source: string }
interface EntMem { entity: string; decisions: EntItem[]; hypotheses: EntItem[]; modeles: EntItem[]; regles: { id: string; code: string; version: number; status: string; label: string; demo: boolean }[]; circuits: string[]; erased: { id: string; kind: string; erasedAt: string; erasureReason: string }[] }

function EntityMemory() {
  const { user, fmtDate } = useApp();
  const [entity, setEntity] = useState(user?.entity && user.entity !== 'PUBLIC' ? user.entity : 'DGIPK');
  const q = useApi(async () => api<EntMem>(`/v1/ia/memory/entities/${encodeURIComponent(entity)}`), [user?.id, entity]);
  const [kind, setKind] = useState<'HYPOTHESE' | 'MODELE'>('HYPOTHESE');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [eraseId, setEraseId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function act(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); setTitle(''); setContent(''); setEraseId(null); setReason(''); q.reload(); } catch (e) { setMsg({ ok: false, text: describeError(e).message }); }
  }
  const item = (i: EntItem) => (
    <li key={i.id} className="list-row list-row-stack">
      <div className="ia-kv-action"><strong>{i.title}</strong>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setEraseId(i.id); setReason(''); }}><Icon name="x" size={14} /> Effacer</button></div>
      <span className="small">{i.content}</span>
      <span className="small muted">{i.id} · {fmtDate(i.createdAt)} · conservé jusqu’au {fmtDate(i.retainUntil)}</span>
      {eraseId === i.id && (
        <div className="ia-inline-form">
          <label className="field"><span className="label">Motif de l’effacement</span><input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <button type="button" className="btn btn-secondary btn-sm" disabled={reason.trim().length < 3}
            onClick={() => void act(() => api(`/v1/ia/memory/entities/${encodeURIComponent(entity)}/items/${i.id}/erase`, { method: 'POST', body: { reason: reason.trim() } }), 'Élément effacé (journalisé).')}>Confirmer</button>
        </div>
      )}
    </li>
  );
  return (
    <section className="panel">
      <header className="panel-head">
        <h2 className="panel-title">Mémoire de l’entité</h2>
        <select value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="Entité">{ENTITIES.map((e) => <option key={e} value={e}>{e}</option>)}</select>
      </header>
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && (
        <div className="ia-mem-grid">
          <div>
            <h3 className="eyebrow">Décisions historiques ({q.data.decisions.length})</h3>
            {q.data.decisions.length ? <ul className="list-rows">{q.data.decisions.slice(0, 20).map(item)}</ul> : <p className="small muted">Aucune décision enregistrée.</p>}
            <h3 className="eyebrow">Hypothèses ({q.data.hypotheses.length})</h3>
            <ul className="list-rows">{q.data.hypotheses.map(item)}</ul>
            <h3 className="eyebrow">Modèles ({q.data.modeles.length})</h3>
            <ul className="list-rows">{q.data.modeles.map(item)}</ul>
          </div>
          <div>
            <h3 className="eyebrow">Règles de l’entité</h3>
            <ul className="list-rows">{q.data.regles.map((r) => <li key={r.id} className="list-row"><span>{r.code} v{r.version} — {r.label}</span>{r.demo && <span className="ribbon">Démonstration</span>}</li>)}</ul>
            {q.data.regles.length === 0 && <p className="small muted">Aucune règle active administrée par cette entité.</p>}
            <h3 className="eyebrow">Circuits</h3>
            <ul className="ia-bullets">{q.data.circuits.map((c) => <li key={c} className="small">{c}</li>)}</ul>
            <h3 className="eyebrow">Ajouter une hypothèse ou un modèle</h3>
            <div className="form">
              <div className="seg seg-sm" role="group" aria-label="Type">
                <button type="button" aria-pressed={kind === 'HYPOTHESE'} onClick={() => setKind('HYPOTHESE')}>Hypothèse</button>
                <button type="button" aria-pressed={kind === 'MODELE'} onClick={() => setKind('MODELE')}>Modèle</button>
              </div>
              <label className="field"><span className="label">Titre</span><input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
              <label className="field"><span className="label">Contenu</span><textarea rows={3} value={content} onChange={(e) => setContent(e.target.value)} /></label>
              <div className="btn-row"><button type="button" className="btn btn-secondary btn-sm" disabled={title.trim().length < 3 || content.trim().length < 3}
                onClick={() => void act(() => api(`/v1/ia/memory/entities/${encodeURIComponent(entity)}/items`, { method: 'POST', body: { kind, title: title.trim(), content: content.trim() } }), 'Ajouté à la mémoire de l’entité.')}>Ajouter</button></div>
            </div>
          </div>
        </div>
      )}
      {msg && <p role="status" className={msg.ok ? 'notice notice-ok' : 'notice notice-err'}>{msg.text}</p>}
    </section>
  );
}

interface Proc { resourceType: string; resourceId: string; step: string; done: string[]; pending: string[]; blockedBy: string | null; nextDecision: string | null; owner: string | null; recentChanges: { action: string; at: string; actorKind: string }[]; history: { step: string; at: string }[]; retention: string }

function ProcessMemory() {
  const { fmtDate } = useApp();
  const [type, setType] = useState('obligation');
  const [id, setId] = useState('');
  const [p, setP] = useState<Proc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function load() {
    setErr(null); setP(null);
    try { setP(await api<Proc>(`/v1/ia/memory/processes/${type}/${encodeURIComponent(id.trim())}`)); } catch (e) { setErr(describeError(e).message); }
  }
  return (
    <section className="panel">
      <h2 className="panel-title">Où en est ce dossier ?</h2>
      <div className="field-row ia-mem-form">
        <label className="field"><span className="label">Type de dossier</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="obligation">Obligation</option><option value="appeal">Réclamation</option><option value="rule">Règle</option>
            <option value="beneficiary">Changement de compte bénéficiaire</option><option value="ia">Recommandation IA</option>
          </select></label>
        <label className="field"><span className="label">Identifiant</span><input value={id} onChange={(e) => setId(e.target.value)} placeholder="Ex. IAR-000001" /></label>
      </div>
      <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={!id.trim()} onClick={() => void load()}><Icon name="arrowRight" size={16} /> Consulter</button></div>
      {err && <p role="status" className="notice notice-err">{err}</p>}
      {p && (
        <div className="ia-process">
          <dl className="kv kv-dense">
            <div><dt>Étape atteinte</dt><dd><strong>{p.step}</strong></dd></div>
            <div><dt>Fait</dt><dd>{p.done.join(' → ') || '—'}</dd></div>
            <div><dt>En attente</dt><dd>{p.pending.join(', ') || '—'}</dd></div>
            <div><dt>Bloqué</dt><dd>{p.blockedBy ?? 'Non'}</dd></div>
            <div><dt>Prochaine décision</dt><dd>{p.nextDecision ?? '—'} {p.owner && <span className="chip">{p.owner}</span>}</dd></div>
            <div><dt>Changé récemment</dt><dd>{p.recentChanges.map((c) => `${c.action} (${fmtDate(c.at, true)})`).join(' ; ') || '—'}</dd></div>
            <div><dt>Conservation</dt><dd>{p.retention}</dd></div>
          </dl>
        </div>
      )}
    </section>
  );
}

interface Signal { id: string; period: string; agentCode: string; metric: string; dimension: string; count: number }

function IntelligenceMemory() {
  const { user } = useApp();
  const q = useApi(async () => asList<Signal>(await api<unknown>('/v1/ia/memory/intelligence')), [user?.id]);
  return (
    <section className="panel">
      <h2 className="panel-title">Signaux agrégés (pseudonymisés)</h2>
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && (
        <DataTable<Signal>
          rows={q.data} rowKey={(r) => r.id} caption="Mémoire d’intelligence"
          empty={<EmptyState title="Aucun signal agrégé pour l’instant" icon="chart" />}
          columns={[
            { key: 'p', label: 'Période', render: (r) => r.period },
            { key: 'a', label: 'Agent', render: (r) => r.agentCode, primary: true },
            { key: 'm', label: 'Indicateur', render: (r) => r.metric },
            { key: 'd', label: 'Dimension', render: (r) => r.dimension },
            { key: 'n', label: 'Nombre', render: (r) => r.count, num: true },
          ]}
        />
      )}
    </section>
  );
}

function Register() {
  const { user } = useApp();
  const q = useApi(async () => asList<{ level: string; label: string; conservation: string; volume: number }>(await api<unknown>('/v1/ia/memory/register')), [user?.id]);
  const [msg, setMsg] = useState<string | null>(null);
  async function purge() {
    try { const r = await api<{ users: number; entityItems: number; signals: number }>('/v1/ia/memory/purge', { method: 'POST', body: {} }); setMsg(`Purge : ${r.users} mémoire(s) utilisateur, ${r.entityItems} élément(s) d’entité, ${r.signals} signal(aux).`); q.reload(); }
    catch (e) { setMsg(describeError(e).message); }
  }
  return (
    <section className="panel">
      <header className="panel-head">
        <h2 className="panel-title"><Icon name="shieldCheck" size={16} /> Registre de la mémoire (volumes, jamais le contenu)</h2>
        {(user?.roles ?? []).includes('R25') && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void purge()}>Appliquer les durées de conservation</button>}
      </header>
      <ul className="list-rows">{(q.data ?? []).map((l) => <li key={l.level} className="list-row"><span>{l.label}</span><span className="small muted">{l.conservation}</span><strong className="num">{l.volume}</strong></li>)}</ul>
      {msg && <p role="status" className="small muted">{msg}</p>}
    </section>
  );
}
