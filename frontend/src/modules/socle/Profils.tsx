/**
 * Enrôlement par profil (§ 9.3) : parcours courts, chacun ne demandant que ce qui sert aux obligations du profil.
 * Déclarer un rôle ouvre une instruction (ni propriété ni dette). Sans NIF : identifiant provisoire et demande suivie
 * en arrière-plan. Sélecteur d'espace : personnel et organisations/mandants sous une seule connexion (aucun droit ajouté).
 * Agents : file d'instruction des rôles déclarés (personne distincte du déclarant).
 */
import { useState, type FormEvent } from 'react';
import type { EnrolmentProfile } from '@mosolo/shared';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api, describeError, safeGet, safeSet } from '../../lib/api';
import { ReasonAction } from '../fiscal/common';
import './socle.css';
import { ProfilsVisuels } from './visuels';

interface Space { taxpayerId: string; iuc: string; name: string; kind: string; type: 'PERSONNEL' | 'ORGANISATION' | 'MANDANT' }
interface Spaces { personal: Space | null; spaces: Space[]; notice: string }
interface RoleDecl { id: string; taxpayerId: string; profile: string; profileLabel: string; status: string; channel: string; declaredBy: string; declaredAt: string; notice: string; nifRequestId?: string; decision?: { reason: string } }
interface NifReq { id: string; taxpayerId: string; provisionalId: string; status: string; regularisation: string[] }

export const ROLE_STATUS: Record<string, { label: string; tone: Tone }> = {
  EN_INSTRUCTION: { label: 'En instruction', tone: 'warning' }, CONFIRMEE: { label: 'Confirmé', tone: 'good' },
  REJETEE: { label: 'Rejeté', tone: 'critical' }, COMPLEMENT_DEMANDE: { label: 'Complément demandé', tone: 'info' },
};
const SPACE_KEY = 'mosolo.espace';
const SPACE_LABEL: Record<Space['type'], string> = { PERSONNEL: 'Espace personnel', ORGANISATION: 'Espace d’organisation', MANDANT: 'Espace d’un mandant' };

/** Sélecteur d'espace : mémorise l'espace actif (confort d'affichage ; le serveur contrôle chaque action). */
export function SpaceSwitcher({ data, value, onChange }: { data: Spaces; value: string; onChange: (id: string) => void }) {
  const all = [...(data.personal ? [data.personal] : []), ...data.spaces];
  if (all.length === 0) return null;
  return (
    <div className="field">
      <label className="label" htmlFor="sp-sel">Espace actif</label>
      <select id="sp-sel" value={value} onChange={(e) => { safeSet(SPACE_KEY, e.target.value); onChange(e.target.value); }}>
        {all.map((s) => <option key={s.taxpayerId} value={s.taxpayerId}>{SPACE_LABEL[s.type]} — {s.name}</option>)}
      </select>
      <p className="small muted">{data.notice}</p>
    </div>
  );
}

function Journey({ p, taxpayerId, onDone }: { p: EnrolmentProfile; taxpayerId: string; onDone: () => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<RoleDecl | null>(null);
  async function go(e: FormEvent) {
    e.preventDefault(); setErr(null);
    const clean = Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim() !== ''));
    try { setDone(await api<RoleDecl>('/v1/enrolement/roles', { method: 'POST', body: { taxpayerId, profile: p.code, answers: clean } })); onDone(); } catch (x) { setErr(describeError(x).message); }
  }
  if (done) return <p className="notice" role="status">Déclaration <span className="mono">{done.id}</span> enregistrée : {done.notice}{done.nifRequestId ? ' Un identifiant provisoire vous est attribué ; la demande de NIF est suivie pour vous.' : ''}</p>;
  return (
    <form className="stack-sm" onSubmit={(e) => void go(e)}>
      <p className="small muted">Obligations concernées (information) : {p.obligations.join(' ; ')}</p>
      {p.fields.map((f) => (
        <div key={f.name} className="field">
          <label className="label" htmlFor={`pf-${p.code}-${f.name}`}>{f.label}{f.required ? '' : ' (facultatif)'}</label>
          {f.type === 'oui_non'
            ? <select id={`pf-${p.code}-${f.name}`} required={f.required} value={answers[f.name] ?? ''} onChange={(e) => setAnswers({ ...answers, [f.name]: e.target.value })}><option value="">—</option><option value="oui">Oui</option><option value="non">Non</option></select>
            : <input id={`pf-${p.code}-${f.name}`} required={f.required} inputMode={f.type === 'nombre' ? 'numeric' : undefined} value={answers[f.name] ?? ''} onChange={(e) => setAnswers({ ...answers, [f.name]: e.target.value })} />}
          {f.hint && <p className="small muted">{f.hint}</p>}
        </div>
      ))}
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      <button type="submit" className="btn btn-primary btn-sm">Déclarer ce rôle (ouvre une instruction)</button>
    </form>
  );
}

function AgentQueue() {
  const { user, fmtDate } = useApp();
  const q = useApi(() => api<{ items: RoleDecl[]; nif: NifReq[] }>('/v1/enrolement/roles'), [user?.id]);
  if (q.loading) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  const items = (q.data?.items ?? []).filter((r) => r.status === 'EN_INSTRUCTION' || r.status === 'COMPLEMENT_DEMANDE');
  const all = q.data?.items ?? [];
  const decide = (id: string, decision: string) => (reason: string) => api(`/v1/enrolement/roles/${id}/instruction`, { method: 'POST', body: { decision, reason } }).then(q.reload);
  return (
    <section className="stack-sm">
      <h2 className="h-sub">Rôles déclarés à instruire</h2>
      <ProfilsVisuels roles={all} statuts={ROLE_STATUS} titre="Déclarations de rôle par état (file d’instruction)" />
      {items.length === 0 && <EmptyState title="Aucune déclaration en instruction." />}
      <ul className="stack-sm">{items.map((r) => (
        <li key={r.id} className="panel stack-sm">
          <div className="panel-head"><div className="min0"><p className="panel-title">{r.profileLabel}</p><p className="panel-sub"><span className="mono">{r.id}</span> · {r.taxpayerId} · {r.channel === 'GUICHET' ? 'au guichet' : 'en ligne'} · {fmtDate(r.declaredAt, true)}</p></div><StatusBadge tone={ROLE_STATUS[r.status]?.tone ?? 'neutral'} label={ROLE_STATUS[r.status]?.label ?? r.status} /></div>
          {user?.id !== r.declaredBy && <div className="btn-row">
            <ReasonAction label="Confirmer" confirmLabel="Confirmer le rôle" onSubmit={decide(r.id, 'CONFIRMEE')} />
            <ReasonAction label="Demander un complément" confirmLabel="Demander" tone="secondary" onSubmit={decide(r.id, 'COMPLEMENT_DEMANDE')} />
            <ReasonAction label="Rejeter" confirmLabel="Rejeter" tone="secondary" onSubmit={decide(r.id, 'REJETEE')} />
          </div>}
        </li>))}</ul>
    </section>
  );
}

export default function Profils() {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const isTaxpayer = roles.some((r) => r === 'R30' || r === 'R31');
  const isAgent = roles.some((r) => ['R07', 'R11', 'R12'].includes(r));
  const prof = useApi(() => api<{ profiles: EnrolmentProfile[]; notice: string }>('/v1/public/enrolement/profils'), []);
  const spaces = useApi(isTaxpayer ? () => api<Spaces>('/v1/enrolement/espaces') : null, [user?.id]);
  const [space, setSpace] = useState<string>(() => safeGet(SPACE_KEY) ?? '');
  const active = space || spaces.data?.personal?.taxpayerId || spaces.data?.spaces[0]?.taxpayerId || '';
  const mine = useApi(isTaxpayer && active ? () => api<{ items: RoleDecl[]; nif: NifReq[] }>(`/v1/enrolement/roles?taxpayerId=${encodeURIComponent(active)}`) : null, [user?.id, active]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Mon compte unique" title="Mes profils et mes espaces"
        lead="Choisissez ce qui vous concerne : chaque parcours est court et ne demande que l’utile. Déclarer un rôle n’établit ni la propriété ni une dette : un agent instruit votre déclaration." />
      {spaces.data && <SpaceSwitcher data={spaces.data} value={active} onChange={setSpace} />}
      {prof.loading && <Loading />}
      {prof.error !== null && <ErrorState error={prof.error} onRetry={prof.reload} />}
      {prof.data && <p className="small muted">{prof.data.notice}</p>}
      {prof.data && <ProfilsVisuels profiles={prof.data.profiles} roles={mine.data?.items} statuts={ROLE_STATUS} titre="Mes rôles déclarés par état" />}
      <ul className="stack-sm">{(prof.data?.profiles ?? []).map((p) => (
        <li key={p.code} className="panel stack-sm">
          <div className="panel-head">
            <div className="min0"><p className="panel-title">{p.label}</p><p className="panel-sub">{p.obligations.join(' ; ')}{p.nifExpected ? ' · NIF attendu (provisoire possible)' : ''}</p></div>
            {isTaxpayer && active && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(open === p.code ? null : p.code)}>{open === p.code ? 'Fermer' : 'C’est moi'}</button>}
          </div>
          {open === p.code && active && <Journey p={p} taxpayerId={active} onDone={mine.reload} />}
        </li>))}</ul>
      {mine.data && (
        <section className="stack-sm">
          <h2 className="h-sub">Mes rôles déclarés</h2>
          {mine.data.items.length === 0 && <p className="small muted">Aucun rôle déclaré pour cet espace.</p>}
          <ul className="plain-list small">{mine.data.items.map((r) => <li key={r.id}>{r.profileLabel} — {ROLE_STATUS[r.status]?.label ?? r.status}{r.decision ? ` (${r.decision.reason})` : ''}</li>)}</ul>
          {mine.data.nif.map((n) => (
            <div key={n.id} className="panel stack-sm"><p className="panel-title">Identifiant provisoire <span className="mono">{n.provisionalId}</span></p><p className="small">Demande de NIF : {n.status.toLowerCase()}</p><ol className="plain-list small">{n.regularisation.map((s) => <li key={s}>{s}</li>)}</ol></div>
          ))}
        </section>
      )}
      {isAgent && <AgentQueue />}
    </div>
  );
}
