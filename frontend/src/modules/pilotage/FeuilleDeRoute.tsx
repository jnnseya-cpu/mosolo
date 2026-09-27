/**
 * Feuille de route et modèle opérationnel (Cahier nouvelle version, ch. 35 à 37) : phases 0 à 6 et portes de sortie,
 * plans d'action datés (30 jours → 24 mois) avec actions en retard, modèle opérationnel (postes, binômes provinciaux,
 * calendrier de transfert, indicateur d'autonomie) et gouvernance du programme (instances, réunions consignées).
 * Une porte de sortie est demandée par une personne et décidée par une autre (comité de pilotage), lors d'une réunion
 * consignée ; jamais automatiquement. Le serveur reste seul juge des droits.
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { EmpreinteFichier } from '../../components/EmpreinteFichier';
import { ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import { Section } from './shared';
import { Area, Callout, Choice, Field, hasRole, Notice, useRunner } from './planif';
import './pilotage.css';

// ————————————————————————— contrat —————————————————————————

interface ProofRow { id: string; livrable: string; reference: string; sha256: string; by: string; at: string }
export interface GateRow { id: string; phase: string; requestedBy: string; requestedAt: string; motif: string; proofIds: string[]; status: 'DEMANDEE' | 'FRANCHIE' | 'REFUSEE'; decision?: { by: string; at: string; approve: boolean; motif: string; meetingId: string } }
export interface PhaseRow {
  code: string; rank: number; label: string; objectifs: string; livrablesTexte: string; porteDeSortie: string; state: string; stateLabel: string; canStart: boolean;
  livrables: { code: string; label: string; proofs: ProofRow[] }[]; gates: GateRow[];
}
interface ActionRow { code: string; label: string; owner: string | null; status: string; statusLabel: string; proof: { reference: string; sha256: string } | null; dueDate: string | null; overdue: boolean }
export interface HorizonRow { code: string; label: string; dueDate: string | null; preuveAttendue: string; actions: ActionRow[]; overdueCount: number; doneCount: number }
interface Staffing { ok: boolean; sansBinome: { postId: string; roleLabel: string }[]; jalonsEnRetard: { postId: string; roleLabel: string; milestoneId: string; label: string; dueDate: string }[] }
export interface Roadmap {
  today: string; programme: { startDate: string | null; note: string | null }; phases: PhaseRow[]; horizons: HorizonRow[];
  overdueActions: { horizon: string; code: string; label: string; dueDate: string }[]; staffing: Staffing; rule: string;
}
interface Milestone { id: string; label: string; dueDate: string; done?: { at: string; reference: string } }
interface PostRow { id: string; functionCode: string; roleLabel: string; holderLabel: string; external: boolean; example?: boolean; transferComplete: boolean; overdueMilestones: string[]; progress: { done: number; total: number } | null; pairing?: { agentLabel: string; calendar: Milestone[] } }
export interface OperatingModel {
  principe: string; effectifsNote: string; staffing: Staffing;
  functions: { code: string; label: string; effectifIndicatif: string; rattachement: string; externeParDefaut: boolean; posts: PostRow[] }[];
  autonomy: { externalPosts: number; transferred: number; sharePct: string | null; note: string };
}
interface MeetingRow { id: string; body: string; date: string; attendees: string[]; agenda: string[]; minutes: { reference: string; sha256: string }; decisions: string[]; ruleVersionIds: string[]; gateDecisions: { gateId: string; phase: string; approve: boolean }[] }
export interface Governance {
  today: string; delaisNote: string; meetings: MeetingRow[];
  bodies: { code: string; label: string; composition: string[]; role: string; frequence: string; delaiJours: number | null; delaiStatut: string | null; secretariat: string[]; liens: { type: string; reference: string; description: string }[]; lastMeetingDate: string | null; nextDueDate: string | null; overdue: boolean | null; flag: string | null; versionsEnAttente?: { id: string; code: string; version: number; status: string; linked: boolean }[] }[];
}

const PHASE_TONE: Record<string, Tone> = { A_VENIR: 'neutral', EN_COURS: 'info', PORTE_DEMANDEE: 'warning', FRANCHIE: 'good', REFUSEE: 'critical' };
const DIRECTION = ['R02', 'R03', 'R05', 'R06'];
const COMITE_PILOTAGE = ['R01', 'R02', 'R05'];

/** Garde d'interface de la décision de porte : comité de pilotage, personne distincte du demandeur, réunion consignée. */
export function gateDecisionGuard(g: Pick<GateRow, 'status' | 'requestedBy'>, user: { id: string; roles: string[] } | null, pilotageMeetings: number): string | null {
  if (g.status !== 'DEMANDEE') return 'Porte déjà décidée.';
  if (!hasRole(user?.roles, ...COMITE_PILOTAGE)) return 'Décision réservée au comité de pilotage.';
  if (g.requestedBy === user?.id) return 'Vous avez demandé cette porte : une autre personne décide.';
  if (pilotageMeetings === 0) return 'Consigner d’abord la réunion du comité de pilotage où la décision est prise.';
  return null;
}

function ProofFields({ value, onChange, label = 'Référence du document' }: { value: { reference: string; sha256: string }; onChange: (v: { reference: string; sha256: string }) => void; label?: string }) {
  return (
    <>
      <Field label={label} value={value.reference} onChange={(v) => onChange({ ...value, reference: v })} />
      <EmpreinteFichier label="Document (empreinte SHA-256 calculée sur l’appareil)" value={value.sha256} onChange={(sha256) => onChange({ ...value, sha256 })} />
    </>
  );
}

// ————————————————————————— phases et portes —————————————————————————

export function PhasesPanel({ r, meetings, onDone }: { r: Roadmap; meetings: MeetingRow[]; onDone: () => void }) {
  const { user } = useApp();
  const run = useRunner(onDone);
  const [motif, setMotif] = useState('');
  const [proof, setProof] = useState({ phase: '', livrable: '', reference: '', sha256: '' });
  const [dec, setDec] = useState({ meetingId: '', motif: '' });
  const direction = hasRole(user?.roles, ...DIRECTION);
  const cp = meetings.filter((m) => m.body === 'COMITE_PILOTAGE');
  const open = r.phases.filter((p) => p.state === 'EN_COURS' || p.state === 'REFUSEE');
  return (
    <Section title="Phases et portes de sortie (§ 35.1)" sub={r.rule}>
      <Notice msg={run.msg} />
      {!r.staffing.ok && <Callout tone="warn">Portes bloquées (montée en autonomie) : {r.staffing.sansBinome.length} poste(s) externe(s) sans binôme provincial, {r.staffing.jalonsEnRetard.length} jalon(s) de transfert en retard.</Callout>}
      <DataTable caption="Phases" rows={r.phases} rowKey={(p) => p.code} columns={[
        { key: 'p', label: 'Phase', primary: true, render: (p) => <><strong>{p.label}</strong><span className="small muted" style={{ display: 'block' }}>{p.objectifs}</span></> },
        { key: 'l', label: 'Livrables et preuves', render: (p) => <ul className="small">{p.livrables.map((l) => <li key={l.code}>{l.label} — {l.proofs.length ? <span>{l.proofs.length} preuve(s) · <code className="hash">{l.proofs[l.proofs.length - 1]!.sha256.slice(0, 12)}…</code></span> : <em>sans preuve</em>}</li>)}</ul> },
        { key: 'g', label: 'Porte de sortie', render: (p) => <span className="small">{p.porteDeSortie}</span> },
        { key: 's', label: 'État', render: (p) => (
          <>
            <StatusBadge tone={PHASE_TONE[p.state] ?? 'neutral'} label={p.stateLabel} />
            {p.gates[0]?.decision && <span className="small muted" style={{ display: 'block' }}>Décision motivée : {p.gates[0].decision.motif} (réunion {p.gates[0].decision.meetingId})</span>}
            {direction && p.canStart && <button type="button" className="btn btn-secondary btn-sm" disabled={run.busy || motif.trim().length < 10} onClick={() => void run.run(`/v1/pilotage/feuille-de-route/phases/${p.code}/demarrage`, { motif }, `${p.label} démarrée.`)}>Démarrer la phase</button>}
            {direction && (p.state === 'EN_COURS' || p.state === 'REFUSEE') && (
              <button type="button" className="btn btn-secondary btn-sm" disabled={run.busy || motif.trim().length < 10} onClick={() => void run.run(`/v1/pilotage/feuille-de-route/phases/${p.code}/porte`, { proofIds: p.livrables.flatMap((l) => l.proofs.map((x) => x.id)), motif }, 'Porte de sortie demandée.')}>Demander la porte</button>
            )}
            {p.gates.filter((g) => g.status === 'DEMANDEE').map((g) => {
              const why = gateDecisionGuard(g, user, cp.length);
              return why ? <span key={g.id} className="small muted" style={{ display: 'block' }}>{why}</span> : (
                <span key={g.id} className="btn-row">
                  <button type="button" className="btn btn-primary btn-sm" disabled={run.busy || !dec.meetingId || dec.motif.trim().length < 10} onClick={() => void run.run(`/v1/pilotage/feuille-de-route/portes/${g.id}/decision`, { approve: true, ...dec }, 'Porte franchie.')}>Franchir</button>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={run.busy || !dec.meetingId || dec.motif.trim().length < 10} onClick={() => void run.run(`/v1/pilotage/feuille-de-route/portes/${g.id}/decision`, { approve: false, ...dec }, 'Porte refusée.')}>Refuser</button>
                </span>
              );
            })}
          </>
        ) },
      ]} />
      {direction && <div className="form"><Field label="Motif (démarrage ou demande de porte, 10 caractères minimum)" value={motif} onChange={setMotif} /></div>}
      {hasRole(user?.roles, ...COMITE_PILOTAGE) && cp.length > 0 && (
        <div className="form">
          <Choice label="Réunion du comité de pilotage où la décision est consignée" value={dec.meetingId} onChange={(v) => setDec({ ...dec, meetingId: v })} options={[['', '— choisir —'], ...cp.map((m) => [m.id, `${m.date} · ${m.minutes.reference}`] as [string, string])]} />
          <Field label="Décision motivée (10 caractères minimum)" value={dec.motif} onChange={(v) => setDec({ ...dec, motif: v })} />
        </div>
      )}
      {direction && open.length > 0 && (
        <div className="form">
          <Choice label="Phase" value={proof.phase} onChange={(v) => setProof({ ...proof, phase: v, livrable: '' })} options={[['', '— choisir —'], ...open.map((p) => [p.code, p.label] as [string, string])]} />
          <Choice label="Livrable" value={proof.livrable} onChange={(v) => setProof({ ...proof, livrable: v })} options={[['', '— choisir —'], ...(open.find((p) => p.code === proof.phase)?.livrables ?? []).map((l) => [l.code, l.label] as [string, string])]} />
          <ProofFields value={proof} onChange={(v) => setProof({ ...proof, ...v })} />
          <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={run.busy || !proof.livrable || !proof.sha256} onClick={() => void run.run(`/v1/pilotage/feuille-de-route/phases/${proof.phase}/preuves`, { livrable: proof.livrable, reference: proof.reference, sha256: proof.sha256 }, 'Preuve déposée.')}>Déposer la preuve</button></div>
        </div>
      )}
    </Section>
  );
}

// ————————————————————————— plans d'action datés —————————————————————————

export function HorizonsPanel({ r, onDone }: { r: Roadmap; onDone: () => void }) {
  const { user } = useApp();
  const run = useRunner(onDone);
  const direction = hasRole(user?.roles, ...DIRECTION);
  const [start, setStart] = useState({ startDate: r.programme.startDate ?? '', motif: '' });
  const [act, setAct] = useState({ code: '', owner: '', status: 'EN_COURS', reference: '', sha256: '' });
  return (
    <Section title="Plans d’action datés (§ 35.2)" sub={r.programme.startDate ? `Démarrage du programme : ${r.programme.startDate} · échéances en jour de Kinshasa (${r.today})` : r.programme.note ?? ''}>
      <Notice msg={run.msg} />
      {r.overdueActions.length > 0 && <Callout tone="warn"><strong>{r.overdueActions.length} action(s) en retard.</strong> {r.overdueActions.map((a) => `${a.horizon} : ${a.label}`).join(' · ')}</Callout>}
      {r.horizons.map((h) => (
        <div key={h.code}>
          <h3 className="panel-title">{h.label} {h.dueDate ? `— échéance ${h.dueDate}` : ''} <StatusBadge tone={h.overdueCount ? 'critical' : 'neutral'} label={`${h.doneCount}/${h.actions.length} réalisées${h.overdueCount ? ` · ${h.overdueCount} en retard` : ''}`} /></h3>
          <p className="small muted">Preuve de réalisation : {h.preuveAttendue}</p>
          <DataTable caption={`Actions à ${h.label}`} rows={h.actions} rowKey={(a) => a.code} columns={[
            { key: 'a', label: 'Action', primary: true, render: (a) => a.label },
            { key: 'o', label: 'Responsable', render: (a) => a.owner ?? '—' },
            { key: 's', label: 'Statut', render: (a) => <StatusBadge tone={a.overdue ? 'critical' : a.status === 'REALISEE' ? 'good' : 'neutral'} label={a.overdue ? `${a.statusLabel} — en retard` : a.statusLabel} /> },
            { key: 'p', label: 'Preuve', render: (a) => (a.proof ? <span className="small">{a.proof.reference} · <code className="hash">{a.proof.sha256.slice(0, 12)}…</code></span> : '—') },
          ]} />
        </div>
      ))}
      {direction && (
        <div className="form">
          <Field label="Date de démarrage du programme (saisie par une personne)" type="date" value={start.startDate} onChange={(v) => setStart({ ...start, startDate: v })} />
          <Field label="Motif" value={start.motif} onChange={(v) => setStart({ ...start, motif: v })} />
          <div className="btn-row"><button type="button" className="btn btn-secondary btn-sm" disabled={run.busy} onClick={() => void run.run('/v1/pilotage/feuille-de-route/demarrage', start, 'Date de démarrage enregistrée.')}>Enregistrer la date</button></div>
          <Choice label="Action" value={act.code} onChange={(v) => setAct({ ...act, code: v })} options={[['', '— choisir —'], ...r.horizons.flatMap((h) => h.actions.map((a) => [a.code, `${h.label} — ${a.label}`] as [string, string]))]} />
          <Field label="Responsable (service ou fonction)" value={act.owner} onChange={(v) => setAct({ ...act, owner: v })} />
          <Choice label="Statut" value={act.status} onChange={(v) => setAct({ ...act, status: v })} options={[['A_FAIRE', 'À faire'], ['EN_COURS', 'En cours'], ['REALISEE', 'Réalisée (preuve requise)']]} />
          <ProofFields label="Preuve de réalisation (référence)" value={act} onChange={(v) => setAct({ ...act, ...v })} />
          <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={run.busy || !act.code} onClick={() => void run.run(`/v1/pilotage/feuille-de-route/actions/${act.code}`, {
            status: act.status, ...(act.owner ? { owner: act.owner } : {}), ...(act.reference && act.sha256 ? { proof: { reference: act.reference, sha256: act.sha256 } } : {}),
          }, 'Action mise à jour.')}>Mettre à jour l’action</button></div>
        </div>
      )}
    </Section>
  );
}

// ————————————————————————— modèle opérationnel —————————————————————————

export function OperatingModelPanel({ m, onDone }: { m: OperatingModel; onDone: () => void }) {
  const { user } = useApp();
  const run = useRunner(onDone);
  const direction = hasRole(user?.roles, ...DIRECTION);
  const posts = m.functions.flatMap((f) => f.posts.map((p) => ({ ...p, functionLabel: f.label })));
  const [post, setPost] = useState({ functionCode: 'INGENIERIE', roleLabel: '' });
  const [pair, setPair] = useState({ postId: '', agentLabel: '', motif: '', calendar: '' });
  const [ms, setMs] = useState({ key: '', reference: '', sha256: '' });
  const open = posts.flatMap((p) => (p.pairing?.calendar ?? []).filter((x) => !x.done).map((x) => ({ key: `${p.id}|${x.id}`, label: `${p.roleLabel} — ${x.label} (${x.dueDate})` })));
  return (
    <Section title="Modèle opérationnel (ch. 36)" sub={m.principe}>
      <Notice msg={run.msg} />
      <p className="small"><strong>Autonomie :</strong> {m.autonomy.sharePct === null ? 'non mesurée' : `${m.autonomy.sharePct} %`} des postes externes transférés ({m.autonomy.transferred}/{m.autonomy.externalPosts}). <span className="muted">{m.autonomy.note}</span></p>
      <DataTable caption="Fonctions" rows={m.functions} rowKey={(f) => f.code} columns={[
        { key: 'f', label: 'Fonction', primary: true, render: (f) => <strong>{f.label}</strong> },
        { key: 'e', label: 'Effectif indicatif au pilote', render: (f) => <>{f.effectifIndicatif} <span className="small muted">(indicatif au pilote)</span></> },
        { key: 'r', label: 'Rattachement', render: (f) => f.rattachement },
        { key: 'n', label: 'Postes enregistrés', num: true, render: (f) => f.posts.length },
      ]} />
      <p className="small muted">{m.effectifsNote}</p>
      <DataTable caption="Registre des postes et binômes" rows={posts} rowKey={(p) => p.id} columns={[
        { key: 'p', label: 'Poste', primary: true, render: (p) => <><strong>{p.roleLabel}</strong><span className="small muted" style={{ display: 'block' }}>{p.functionLabel} · {p.holderLabel}{p.example ? ' · donnée de démonstration non contractuelle' : ''}</span></> },
        { key: 'x', label: 'Nature', render: (p) => (p.external ? 'Externe' : 'Provincial') },
        { key: 'b', label: 'Binôme provincial', render: (p) => (!p.external ? '—' : p.pairing ? p.pairing.agentLabel : <StatusBadge tone="critical" label="Sans binôme" />) },
        { key: 't', label: 'Transfert', render: (p) => (!p.external ? '—' : !p.progress ? '—' : <StatusBadge tone={p.transferComplete ? 'good' : p.overdueMilestones.length ? 'critical' : 'info'} label={`${p.progress.done}/${p.progress.total} jalons${p.overdueMilestones.length ? ` · ${p.overdueMilestones.length} en retard` : ''}`} />) },
      ]} />
      {direction && (
        <div className="form">
          <Choice label="Fonction" value={post.functionCode} onChange={(v) => setPost({ ...post, functionCode: v })} options={m.functions.map((f) => [f.code, f.label])} />
          <Field label="Libellé du poste (rôle, jamais un nom)" value={post.roleLabel} onChange={(v) => setPost({ ...post, roleLabel: v })} />
          <div className="btn-row"><button type="button" className="btn btn-secondary btn-sm" disabled={run.busy} onClick={() => void run.run('/v1/pilotage/modele-operationnel/postes', post, 'Poste enregistré (à pourvoir).')}>Ajouter le poste</button></div>
          <Choice label="Poste externe" value={pair.postId} onChange={(v) => setPair({ ...pair, postId: v })} options={[['', '— choisir —'], ...posts.filter((p) => p.external).map((p) => [p.id, p.roleLabel] as [string, string])]} />
          <Field label="Agent provincial désigné (fonction ou poste)" value={pair.agentLabel} onChange={(v) => setPair({ ...pair, agentLabel: v })} />
          <Area label="Calendrier de transfert écrit (une ligne « AAAA-MM-JJ;jalon »)" value={pair.calendar} onChange={(v) => setPair({ ...pair, calendar: v })} rows={3} />
          <Field label="Motif" value={pair.motif} onChange={(v) => setPair({ ...pair, motif: v })} />
          <div className="btn-row"><button type="button" className="btn btn-secondary btn-sm" disabled={run.busy || !pair.postId} onClick={() => void run.run(`/v1/pilotage/modele-operationnel/postes/${pair.postId}/binome`, {
            agentLabel: pair.agentLabel, motif: pair.motif, calendar: parseCalendar(pair.calendar),
          }, 'Binôme désigné.')}>Désigner le binôme</button></div>
          {open.length > 0 && <>
            <Choice label="Jalon de transfert réalisé" value={ms.key} onChange={(v) => setMs({ ...ms, key: v })} options={[['', '— choisir —'], ...open.map((o) => [o.key, o.label] as [string, string])]} />
            <ProofFields label="Preuve du transfert (référence)" value={ms} onChange={(v) => setMs({ ...ms, ...v })} />
            <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={run.busy || !ms.key || !ms.sha256} onClick={() => { const [id, jalon] = ms.key.split('|'); void run.run(`/v1/pilotage/modele-operationnel/postes/${id}/jalons/${jalon}`, { reference: ms.reference, sha256: ms.sha256 }, 'Jalon réalisé.'); }}>Valider le jalon</button></div>
          </>}
        </div>
      )}
    </Section>
  );
}

/** Calendrier de transfert : lignes « AAAA-MM-JJ;libellé du jalon ». */
export function parseCalendar(text: string): { dueDate: string; label: string }[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [d, ...rest] = l.split(';'); return { dueDate: (d ?? '').trim(), label: rest.join(';').trim() }; });
}

// ————————————————————————— gouvernance —————————————————————————

export function GovernancePanel({ g, onDone }: { g: Governance; onDone: () => void }) {
  const { user } = useApp();
  const run = useRunner(onDone);
  const mine = g.bodies.filter((b) => hasRole(user?.roles, ...b.secretariat));
  const [m, setM] = useState({ body: mine[0]?.code ?? '', date: g.today, attendees: '', agenda: '', decisions: '', ruleVersionIds: '', reference: '', sha256: '' });
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  return (
    <Section title="Gouvernance du programme (ch. 37)" sub={g.delaisNote}>
      <Notice msg={run.msg} />
      <DataTable caption="Instances" rows={g.bodies} rowKey={(b) => b.code} columns={[
        { key: 'i', label: 'Instance', primary: true, render: (b) => <><strong>{b.label}</strong><span className="small muted" style={{ display: 'block' }}>{b.composition.join(', ')}</span></> },
        { key: 'r', label: 'Rôle', render: (b) => <span className="small">{b.role}</span> },
        { key: 'f', label: 'Fréquence', render: (b) => <>{b.frequence}{b.delaiJours !== null && <span className="small muted" style={{ display: 'block' }}>{b.delaiJours} jours — par défaut, à confirmer</span>}</> },
        { key: 'd', label: 'Dernière réunion', render: (b) => b.lastMeetingDate ?? '—' },
        { key: 's', label: 'Suivi', render: (b) => (b.flag ? <StatusBadge tone="critical" label={b.flag} /> : <StatusBadge tone="good" label={b.delaiJours === null ? 'Versions rattachées' : `À jour${b.nextDueDate ? ` (prochaine avant le ${b.nextDueDate})` : ''}`} />) },
        { key: 'l', label: 'Circuits existants', render: (b) => <ul className="small">{b.liens.map((l) => <li key={l.reference}><code>{l.reference}</code> — {l.description}</li>)}</ul> },
      ]} />
      <DataTable caption="Réunions consignées" rows={g.meetings} rowKey={(x) => x.id} columns={[
        { key: 'd', label: 'Date', primary: true, render: (x) => <><strong>{x.date}</strong> · {g.bodies.find((b) => b.code === x.body)?.label ?? x.body}</> },
        { key: 'a', label: 'Participants (rôles)', render: (x) => <span className="small">{x.attendees.join(', ')}</span> },
        { key: 'o', label: 'Ordre du jour et décisions', render: (x) => <span className="small">{x.agenda.join(' ; ')}{x.decisions.length ? ` → ${x.decisions.join(' ; ')}` : ''}{x.gateDecisions.map((d) => ` · porte ${d.phase} ${d.approve ? 'franchie' : 'refusée'}`).join('')}</span> },
        { key: 'p', label: 'Procès-verbal', render: (x) => <span className="small">{x.minutes.reference} · <code className="hash">{x.minutes.sha256.slice(0, 12)}…</code></span> },
      ]} />
      {mine.length > 0 && (
        <div className="form">
          <Choice label="Instance" value={m.body} onChange={(v) => setM({ ...m, body: v })} options={mine.map((b) => [b.code, b.label])} />
          <Field label="Date de la réunion (tenue)" type="date" value={m.date} onChange={(v) => setM({ ...m, date: v })} />
          <Area label="Participants par rôle (un par ligne, jamais un nom)" value={m.attendees} onChange={(v) => setM({ ...m, attendees: v })} rows={3} hint={`Composition : ${g.bodies.find((b) => b.code === m.body)?.composition.join(', ') ?? ''}`} />
          <Area label="Ordre du jour (un point par ligne)" value={m.agenda} onChange={(v) => setM({ ...m, agenda: v })} rows={3} />
          <Area label="Décisions prises (une par ligne)" value={m.decisions} onChange={(v) => setM({ ...m, decisions: v })} rows={3} />
          {m.body === 'COMITE_JURIDIQUE_TARIFAIRE' && <Field label="Versions de règles examinées (identifiants séparés par des virgules)" value={m.ruleVersionIds} onChange={(v) => setM({ ...m, ruleVersionIds: v })} />}
          <ProofFields label="Procès-verbal (référence)" value={m} onChange={(v) => setM({ ...m, ...v })} />
          <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={run.busy || !m.sha256} onClick={() => void run.run('/v1/pilotage/gouvernance/reunions', {
            body: m.body, date: m.date, attendees: lines(m.attendees), agenda: lines(m.agenda), decisions: lines(m.decisions), minutes: { reference: m.reference, sha256: m.sha256 },
            ...(m.ruleVersionIds.trim() ? { ruleVersionIds: m.ruleVersionIds.split(',').map((x) => x.trim()).filter(Boolean) } : {}),
          }, 'Réunion consignée.')}>Consigner la réunion</button></div>
        </div>
      )}
    </Section>
  );
}

export default function FeuilleDeRoute() {
  const { user } = useApp();
  const road = useApi(() => api<Roadmap>('/v1/pilotage/feuille-de-route'), [user?.id]);
  const om = useApi(() => api<OperatingModel>('/v1/pilotage/modele-operationnel'), [user?.id]);
  const gov = useApi(() => api<Governance>('/v1/pilotage/gouvernance'), [user?.id]);
  const reload = () => { road.reload(); om.reload(); gov.reload(); };
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Pilotage · ch. 35 à 37" title="Feuille de route et modèle opérationnel" lead="Phases et portes de sortie décidées par le comité de pilotage, plans d’action datés, binômes provinciaux et transfert de compétences, instances de gouvernance et réunions consignées." />
      {road.loading && !road.data ? <Loading /> : road.error ? <ErrorState error={road.error} onRetry={reload} /> : road.data && (
        <div className="dash-grid">
          <PhasesPanel r={road.data} meetings={gov.data?.meetings ?? []} onDone={reload} />
          <HorizonsPanel r={road.data} onDone={reload} />
          {om.data && <OperatingModelPanel m={om.data} onDone={reload} />}
          {gov.data && <GovernancePanel g={gov.data} onDone={reload} />}
        </div>
      )}
    </div>
  );
}
