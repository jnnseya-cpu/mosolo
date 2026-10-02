import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { REQUIRED_APPROVALS, SAMPLE_RULES, CURRENCIES, TAXABLE_EVENT_KINDS, TAXABLE_EVENT_LABELS, type Approval, type MoneyJSON, type RuleSheet } from '@mosolo/shared';
import { useApp } from '../context';
import { useApi } from '../hooks/useApi';
import { useAutosave } from '../hooks/useAutosave';
import { PageHead } from '../components/Shell';
import { Drawer } from '../components/Drawer';
import { DataTable } from '../components/DataTable';
import { StatusBadge, type Tone } from '../components/StatusBadge';
import { AutosaveBar } from '../components/VersionHistory';
import { ErrorState, ExampleNotice, Loading } from '../components/States';
import { Icon } from '../components/Icon';
import { MoneyText } from '../components/MoneyText';
import { api, asList, describeError, NetworkError } from '../lib/api';
import type { UIKey } from '../lib/i18n';
import { periodicityLabel, revenueCategoryLabel } from '../lib/labels';
import '../modules/recouvrement/recouvrement.css';
import { RuleLegalTests, RuleTechnicalView } from '../modules/juridique/RuleJuridiqueTools';
import { VeilleRegles } from '../modules/juridique/VeilleRegles';
import { RegistreVisuel } from './visuels';

interface HistoryEntry { at: string; action: string; by: string; status: string; detail?: string }
interface Suspension { reason: string; authority: string; instrumentRef?: string; by: string; at: string; previousStatus: string; liftedAt?: string; liftReason?: string }
type Rule = RuleSheet & {
  sample?: boolean; demo?: boolean; createdAt?: string; publishedAt?: string; activatedAt?: string;
  suspension?: Suspension; pastSuspensions?: Suspension[];
  /** Suspension ou levée proposée, en attente de l'approbation d'une seconde personne. */
  pendingSuspensionChange?: { kind: 'SUSPENSION' | 'LEVEE'; reason: string; authority?: string; proposedBy: string; proposedAt: string };
  abrogation?: { date: string; instrumentId: string; reason: string; by: string; at: string };
  retroactivity?: { instrumentId: string; article: string; justification: string };
  supersededBy?: string; history?: HistoryEntry[];
  /** Avertissements de citation (texte abrogé cité, catégorie ACTE_REQUIS). */
  citationWarnings?: string[];
};
interface Instrument { id: string; title: string; status: string; demo?: boolean; abrogatedOn?: string }
interface RecalcLine {
  obligationId: string; taxpayerId: string; fromVersion: number; obligationStatus: string; issuedOn: string; oldAmount: MoneyJSON;
  newAmount?: MoneyJSON; delta?: MoneyJSON; direction?: 'FAVORABLE' | 'DEFAVORABLE' | 'NEUTRE'; treatment: 'A_APPLIQUER' | 'EXCLUE'; reason?: string;
}
interface Recalculation {
  id: string; ruleId: string; toVersion: number; simulatedBy: string; simulatedAt: string; status: 'SIMULEE' | 'APPLIQUEE' | 'REJETEE';
  nonOpposable: boolean; retroactivityAuthorized: boolean; lines: RecalcLine[];
  totals: { examined: number; toApply: number; excluded: number; favorable: number; defavorable: number; deltaToApply: MoneyJSON | null };
  decision?: { decision: string; reason: string; by: string; at: string; applied: { from: string; to: string }[]; skipped: { obligationId: string; reason: string }[] };
}

const HISTORY_LABEL: Record<string, string> = {
  'rule.created': 'Fiche créée', 'rule.approved.redacteur': 'Visa de rédaction', 'rule.approved.verificateur_juridique': 'Visa juridique',
  'rule.approved.validateur_financier': 'Visa financier', 'rule.approved.autorite_publication': 'Publication', 'rule.activated': 'Entrée en vigueur',
  'rule.suspended': 'Suspension', 'rule.suspension.lifted': 'Levée de la suspension', 'rule.abrogated': 'Abrogation',
  'rule.abrogation.scheduled': 'Abrogation programmée', 'rule.abrogated.effective': 'Abrogation effective', 'rule.superseded': 'Remplacée par une nouvelle version',
  'rule.expired': 'Expiration',
};
const SIMULATE_ROLES = ['R13', 'R14', 'R15', 'R16', 'R06', 'R07', 'R11', 'R22'];
const errText = (x: unknown) => { const d = describeError(x); return d.message + (d.code ? ` (${d.code})` : ''); };

const STATUS_TONE: Record<string, Tone> = {
  A_VERIFIER: 'critical', BROUILLON: 'neutral', REVUE_JURIDIQUE: 'info', REVUE_FINANCIERE: 'info', APPROUVEE: 'info', PUBLIEE: 'warning',
  ACTIVE: 'good', SUSPENDUE: 'serious', EXPIREE: 'neutral', ABROGEE: 'neutral', ARCHIVEE: 'neutral',
};
const ROLE_CODE: Record<Approval['role'], string> = { REDACTEUR: 'R13', VERIFICATEUR_JURIDIQUE: 'R14', VALIDATEUR_FINANCIER: 'R15', AUTORITE_PUBLICATION: 'R16' };

async function loadRules(): Promise<{ rules: Rule[]; fallback: boolean }> {
  try {
    return { rules: asList<Rule>(await api<unknown>('/v1/legal-rules'), 'rules'), fallback: false };
  } catch (e) {
    if (e instanceof NetworkError) return { rules: SAMPLE_RULES.map((r) => ({ ...r, sample: true })), fallback: true };
    throw e;
  }
}

function RuleStatusBadge({ status }: { status: string }) {
  const { tr } = useApp();
  return <StatusBadge tone={STATUS_TONE[status] ?? 'neutral'} label={tr(`rules.status.${status}` as UIKey)} />;
}

function ApprovalTimeline({ rule, onDone }: { rule: Rule; onDone: () => void }) {
  const { tr, fmtDate, user } = useApp();
  const next = REQUIRED_APPROVALS.find((r) => !rule.approvals.some((a) => a.role === r));
  const [role, setRole] = useState<Approval['role']>(next ?? 'REDACTEUR');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function approve(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      await api(`/v1/legal-rules/${encodeURIComponent(rule.id)}/approve`, { method: 'POST', body: { role } });
      setMsg({ ok: true, text: tr('rules.approved') });
      onDone();
    } catch (x) {
      setMsg({ ok: false, text: describeError(x).message + (describeError(x).code ? ` (${describeError(x).code})` : '') });
    } finally { setBusy(false); }
  }
  const people = new Set(rule.approvals.map((a) => a.userId));
  return (
    <div className="stack">
      <ol className="timeline">
        {REQUIRED_APPROVALS.map((r, i) => {
          const a = rule.approvals.find((x) => x.role === r);
          return (
            <li key={r} className={a ? 'done' : ''}>
              <span className="timeline-dot" aria-hidden="true">{a ? <Icon name="check" size={12} /> : i + 1}</span>
              <div>
                <p className="row-title">{tr(`approval.role.${r}` as UIKey)} <span className="muted small">({ROLE_CODE[r]})</span></p>
                <p className="small muted">{a ? tr('rules.approvedBy', { who: a.userId, date: fmtDate(a.at, true) }) : tr('rules.pending')}</p>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="small muted">{tr('rules.distinct', { n: people.size })}</p>
      {next ? (
        <form onSubmit={(e) => void approve(e)} className="form">
          <div className="field">
            <label className="label" htmlFor="appr-role">{tr('rules.approveAs')}</label>
            <select id="appr-role" value={role} onChange={(e) => setRole(e.target.value as Approval['role'])}>
              {REQUIRED_APPROVALS.map((r) => <option key={r} value={r}>{tr(`approval.role.${r}` as UIKey)} ({ROLE_CODE[r]})</option>)}
            </select>
            <span className="hint">{tr('rules.approveHint', { user: user?.name ?? '—' })}</span>
          </div>
          {rule.status === 'A_VERIFIER' && <p className="notice notice-err">{tr('rules.cannotApproveUnverified')}</p>}
          <button type="submit" className="btn btn-primary" disabled={busy}><Icon name="check" size={18} /> {tr('rules.approve')}</button>
          {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'notice notice-ok' : 'notice notice-err'}>{msg.text}</p>}
        </form>
      ) : <p className="notice notice-ok">{tr('rules.allApproved')}</p>}
    </div>
  );
}

function Feedback({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'notice notice-ok' : 'notice notice-err'}>{msg.text}</p>;
}

/** Suspension motivée, levée, abrogation datée (autorité de publication R16). */
function RuleLifecycle({ rule, instruments, onChanged }: { rule: Rule; instruments: Instrument[]; onChanged: () => void }) {
  const { fmtDate, user } = useApp();
  const canAct = !!user?.roles.some((r) => r === 'R16' || r === 'R14');
  // Approbation par une seconde personne (R15 ou R16), jamais l'auteur de la proposition.
  const pending = rule.pendingSuspensionChange;
  const canApprove = !!pending && !!user && user.id !== pending.proposedBy && user.roles.some((r) => r === 'R15' || r === 'R16');
  const [decision, setDecision] = useState('');
  async function decide(approve: boolean) {
    setBusy(true); setMsg(null);
    try {
      await api(`/v1/legal-rules/${encodeURIComponent(rule.id)}/suspension-change/decide`, { method: 'POST', body: { approve, reason: decision } });
      setMsg({ ok: true, text: approve ? (pending?.kind === 'SUSPENSION' ? 'Suspension approuvée : effective.' : 'Levée approuvée : la règle s’applique de nouveau.') : 'Proposition refusée.' });
      setDecision('');
      onChanged();
    } catch (x) { setMsg({ ok: false, text: errText(x) }); } finally { setBusy(false); }
  }
  const [mode, setMode] = useState<'none' | 'suspend' | 'lift' | 'abrogate'>('none');
  const [reason, setReason] = useState('');
  const [authority, setAuthority] = useState('Ministre provincial des Finances');
  const inForce = instruments.filter((i) => i.status === 'EN_VIGUEUR' || i.status === 'MODIFIE');
  const [instrumentId, setInstrumentId] = useState(inForce[0]?.id ?? '');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [review, setReview] = useState<{ id: string; status: string; issuedOn: string }[] | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const base = `/v1/legal-rules/${encodeURIComponent(rule.id)}`;
    try {
      if (mode === 'suspend') await api(`${base}/suspend`, { method: 'POST', body: { reason, authority } });
      else if (mode === 'lift') await api(`${base}/lift-suspension`, { method: 'POST', body: { reason } });
      else {
        const r = await api<{ obligationsToReview: { id: string; status: string; issuedOn: string }[] }>(`${base}/abrogate`, { method: 'POST', body: { date, instrumentId, reason } });
        setReview(r.obligationsToReview);
      }
      setMsg({ ok: true, text: mode === 'suspend' ? 'Suspension proposée : sans effet tant qu’une seconde personne ne l’a pas approuvée.' : mode === 'lift' ? 'Levée proposée : sans effet tant qu’une seconde personne ne l’a pas approuvée.' : 'Abrogation enregistrée : aucune liquidation à compter de la date.' });
      setMode('none'); setReason('');
      onChanged();
    } catch (x) { setMsg({ ok: false, text: errText(x) }); } finally { setBusy(false); }
  }
  const canSuspend = rule.status === 'ACTIVE' || rule.status === 'PUBLIEE';
  const canAbrogate = ['APPROUVEE', 'PUBLIEE', 'ACTIVE', 'SUSPENDUE'].includes(rule.status) && !rule.abrogation;
  return (
    <div className="stack">
      {rule.suspension && (
        <div className="callout callout-warn"><Icon name="ban" size={18} /><div><p className="row-title">Suspendue le {fmtDate(rule.suspension.at, true)}</p><p className="small">{rule.suspension.authority} — {rule.suspension.reason}</p></div></div>
      )}
      {rule.abrogation && (
        <div className="callout callout-danger"><Icon name="x" size={18} /><div><p className="row-title">Abrogation au {fmtDate(rule.abrogation.date)}</p><p className="small">Instrument abrogatoire <span className="mono">{rule.abrogation.instrumentId}</span> — {rule.abrogation.reason}</p></div></div>
      )}
      {rule.retroactivity && (
        <div className="callout callout-info"><Icon name="history" size={18} /><p className="small">Rétroactivité autorisée par <span className="mono">{rule.retroactivity.instrumentId}</span>, {rule.retroactivity.article} — {rule.retroactivity.justification}</p></div>
      )}
      {pending && (
        <div className="callout callout-info"><Icon name="users" size={18} /><div className="stack-sm">
          <p className="row-title">{pending.kind === 'SUSPENSION' ? 'Suspension' : 'Levée de suspension'} proposée le {fmtDate(pending.proposedAt, true)} — en attente d’une seconde personne</p>
          <p className="small">{pending.authority ? `${pending.authority} — ` : ''}{pending.reason} <span className="muted">(proposée par {pending.proposedBy})</span></p>
          {canApprove && (
            <div className="stack-sm">
              <label className="field"><span className="label">Motif de la décision</span><input value={decision} onChange={(e) => setDecision(e.target.value)} /></label>
              <div className="btn-row">
                <button type="button" className="btn btn-primary btn-sm" disabled={busy || decision.trim().length < 5} onClick={() => void decide(true)}>Approuver</button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy || decision.trim().length < 5} onClick={() => void decide(false)}>Refuser</button>
              </div>
            </div>
          )}
        </div></div>
      )}
      {!!rule.pastSuspensions?.length && <p className="small muted">{rule.pastSuspensions.length} suspension(s) antérieure(s) levée(s).</p>}
      {canAct ? (
        <div className="btn-row">
          {canSuspend && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMode('suspend')}><Icon name="ban" size={14} /> Suspendre</button>}
          {rule.status === 'SUSPENDUE' && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMode('lift')}><Icon name="refresh" size={14} /> Lever la suspension</button>}
          {canAbrogate && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMode('abrogate')}><Icon name="x" size={14} /> Abroger</button>}
        </div>
      ) : <p className="small muted">Suspension et abrogation : autorité de publication (R16), sur décision motivée.</p>}
      {mode !== 'none' && (
        <form className="form" onSubmit={(e) => void submit(e)}>
          {mode === 'suspend' && (
            <div className="field"><label className="label" htmlFor="lc-auth">Autorité qui suspend</label><input id="lc-auth" value={authority} onChange={(e) => setAuthority(e.target.value)} required /></div>
          )}
          {mode === 'abrogate' && (
            <div className="field-row">
              <div className="field"><label className="label" htmlFor="lc-date">Date d’abrogation</label><input id="lc-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></div>
              <div className="field">
                <label className="label" htmlFor="lc-inst">Instrument abrogatoire (en vigueur)</label>
                <select id="lc-inst" value={instrumentId} onChange={(e) => setInstrumentId(e.target.value)}>
                  {inForce.map((i) => <option key={i.id} value={i.id}>{i.demo ? '[FICTIF] ' : ''}{i.title}</option>)}
                </select>
              </div>
            </div>
          )}
          <div className="field"><label className="label" htmlFor="lc-reason">Motif</label><textarea id="lc-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={10} /></div>
          <div className="btn-row">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Confirmer</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMode('none')}>Annuler</button>
          </div>
        </form>
      )}
      <Feedback msg={msg} />
      {review && review.length > 0 && (
        <div className="callout callout-warn"><Icon name="alert" size={18} /><div><p className="row-title">Obligations émises depuis la date d’abrogation — à examiner (aucune annulation d’office)</p><ul className="plain-list small">{review.map((o) => <li key={o.id} className="mono">{o.id} · {o.status} · {o.issuedOn}</li>)}</ul></div></div>
      )}
    </div>
  );
}

/** Historique des versions d'un même code, chacune avec son journal (ajout seul). */
function RuleVersions({ rule }: { rule: Rule }) {
  const { fmtDate } = useApp();
  const q = useApi(() => api<{ code: string; versions: Rule[] }>(`/v1/legal-rules/${encodeURIComponent(rule.id)}/versions`), [rule.id, rule.status]);
  if (q.loading) return <Loading />;
  if (q.error !== null) return <ErrorState error={q.error} onRetry={q.reload} />;
  return (
    <div className="stack">
      {(q.data?.versions ?? []).map((v) => (
        <details key={v.id} open={v.id === rule.id} className="lr-version">
          <summary className="row-between">
            <span><span className="mono">v{v.version}</span> · {fmtDate(v.effectiveFrom)}{v.effectiveTo ? ` → ${fmtDate(v.effectiveTo)}` : ''}{v.changeReason ? <span className="muted small"> — {v.changeReason}</span> : null}</span>
            <RuleStatusBadge status={v.status} />
          </summary>
          <ol className="plain-list small lr-history">
            {(v.history ?? []).map((h) => (
              <li key={h.at + h.action}><span className="muted">{fmtDate(h.at, true)}</span> — {HISTORY_LABEL[h.action] ?? h.action} <span className="muted">({h.by})</span>{h.detail ? ` : ${h.detail}` : ''}</li>
            ))}
            {!v.history?.length && <li className="muted">Fiche modèle : historique antérieur au registre.</li>}
          </ol>
        </details>
      ))}
    </div>
  );
}

/** Simulation d'impact d'une nouvelle version, puis décision motivée de la régie (R06, personne distincte). */
function ImpactSimulation({ rule }: { rule: Rule }) {
  const { fmtDate, user } = useApp();
  const roles = user?.roles ?? [];
  const canSimulate = roles.some((r) => SIMULATE_ROLES.includes(r));
  const canDecide = roles.includes('R06');
  const q = useApi(canSimulate ? () => api<Recalculation[]>(`/v1/recalculations?ruleId=${encodeURIComponent(rule.id)}`) : null, [rule.id, user?.id]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [reason, setReason] = useState('');
  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); q.reload(); } catch (x) { setMsg({ ok: false, text: errText(x) }); } finally { setBusy(false); }
  }
  if (!rule.supersedesVersionId) return <p className="small muted">Première version : aucune obligation antérieure à recalculer.</p>;
  if (!canSimulate) return <p className="small muted">Simulation réservée aux juristes, validateurs, régie et audit.</p>;
  const last = q.data?.[0];
  return (
    <div className="stack">
      <p className="small muted">Simulation sans effet sur les obligations. Aucune obligation émise avant la date d’effet n’est touchée ; aucune hausse n’est appliquée sans acte autorisant la rétroactivité. L’application exige une décision motivée d’une personne distincte, par obligation rectificative (l’originale est conservée).</p>
      <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void act(() => api(`/v1/legal-rules/${encodeURIComponent(rule.id)}/impact-simulations`, { method: 'POST' }), 'Simulation enregistrée.')}>
        <Icon name="analysis" size={14} /> Simuler l’impact
      </button>
      <Feedback msg={msg} />
      {last && (
        <div className="stack">
          <div className="row-between"><span className="mono small">{last.id}</span><StatusBadge tone={last.status === 'APPLIQUEE' ? 'good' : last.status === 'REJETEE' ? 'neutral' : 'info'} label={last.status === 'SIMULEE' ? 'Simulée — non opposable' : last.status === 'APPLIQUEE' ? 'Appliquée' : 'Rejetée'} /></div>
          <p className="small">{last.totals.examined} obligation(s) examinée(s) · {last.totals.toApply} à rectifier · {last.totals.excluded} exclue(s) · {last.totals.favorable} favorable(s) · {last.totals.defavorable} défavorable(s){last.totals.deltaToApply ? <> · écart total <MoneyText money={last.totals.deltaToApply} showIndicative={false} /></> : null}</p>
          {last.lines.length > 0 && (
            <DataTable
              caption="Obligations touchées"
              rows={last.lines}
              rowKey={(l) => l.obligationId}
              columns={[
                { key: 'o', label: 'Obligation', primary: true, render: (l) => <span className="mono small">{l.obligationId}</span> },
                { key: 'old', label: 'Ancien', num: true, render: (l) => <MoneyText money={l.oldAmount} showIndicative={false} /> },
                { key: 'new', label: 'Nouveau', num: true, render: (l) => (l.newAmount ? <MoneyText money={l.newAmount} showIndicative={false} /> : '—') },
                { key: 't', label: 'Traitement', render: (l) => <span className="small"><StatusBadge tone={l.treatment === 'A_APPLIQUER' ? 'info' : 'neutral'} label={l.treatment === 'A_APPLIQUER' ? 'À rectifier' : 'Exclue'} />{l.reason ? <span className="muted"> {l.reason}</span> : null}</span> },
              ]}
            />
          )}
          {last.decision && <p className="small">Décision de {last.decision.by} le {fmtDate(last.decision.at, true)} : {last.decision.reason} — {last.decision.applied.length} obligation(s) rectifiée(s).</p>}
          {last.status === 'SIMULEE' && canDecide && (
            <form className="form" onSubmit={(e) => { e.preventDefault(); }}>
              <div className="field"><label className="label" htmlFor="rc-dec">Motivation de la décision</label><textarea id="rc-dec" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} minLength={10} /></div>
              <div className="btn-row">
                <button type="button" className="btn btn-primary btn-sm" disabled={busy || reason.trim().length < 10} onClick={() => void act(() => api(`/v1/recalculations/${encodeURIComponent(last.id)}/decide`, { method: 'POST', body: { decision: 'APPLIQUER', reason } }), 'Recalcul appliqué par obligations rectificatives.')}>Appliquer</button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy || reason.trim().length < 10} onClick={() => void act(() => api(`/v1/recalculations/${encodeURIComponent(last.id)}/decide`, { method: 'POST', body: { decision: 'REJETER', reason } }), 'Recalcul rejeté (motif tracé).')}>Rejeter</button>
              </div>
            </form>
          )}
          {last.status === 'SIMULEE' && !canDecide && <p className="small muted">Décision : direction de la régie (R06), distincte de l’auteur de la simulation.</p>}
        </div>
      )}
    </div>
  );
}

function RuleDetail({ rule, instruments, onChanged, onNewVersion }: { rule: Rule; instruments: Instrument[]; onChanged: () => void; onNewVersion: (r: Rule) => void }) {
  const { tr, fmtDate, lang, user } = useApp();
  // Vue juriste (libellés de la fiche) ou vue technique (attributs du registre, § 6.2).
  const [vue, setVue] = useState<'juriste' | 'technique'>('juriste');
  const rows: [UIKey, ReactNode][] = [
    ['rules.f.code', <span className="mono">{rule.code} · v{rule.version}</span>],
    ['rules.f.category', revenueCategoryLabel(lang, rule.revenueCategory)],
    ['rules.f.instruments', rule.legalInstrumentIds.join(' · ') || '—'],
    ['rules.f.articles', rule.articles.join(' · ') || '—'],
    ['rules.f.authority', rule.competentAuthority],
    ['rules.f.entity', rule.administeringEntity],
    ['rules.f.event', rule.taxableEvent],
    ['rules.f.liable', rule.liableParty],
    ['rules.f.withholding', rule.withholdingAgent ?? '—'],
    ['rules.f.base', rule.baseDefinition],
    ['rules.f.formula', <code className="formula">{rule.formula}</code>],
    ['rules.f.rates', <span className="mono small">{Object.entries(rule.rateTable).map(([k, v]) => `${k} = ${v}`).join(' · ')}</span>],
    ['rules.f.currency', `${CURRENCIES[rule.currency]?.flag ?? ''} ${rule.currency} · ${rule.rounding}`],
    ['rules.f.periodicity', periodicityLabel(lang, rule.periodicity)],
    ['rules.f.due', rule.dueRule],
    ['rules.f.exemptions', rule.exemptions.length ? rule.exemptions.map((x) => x.basis).join(' · ') : '—'],
    ['rules.f.penalties', rule.penalties.length ? rule.penalties.map((x) => x.description).join(' · ') : '—'],
    ['rules.f.effective', `${fmtDate(rule.effectiveFrom)}${rule.effectiveTo ? ` → ${fmtDate(rule.effectiveTo)}` : ''}`],
    ['rules.f.alias', <span className="mono">{rule.beneficiaryAccountAlias}</span>],
    ['rules.f.appeal', rule.appealPath],
    ['rules.f.source', tr(`rules.source.${rule.sourceVerification}` as UIKey)],
  ];
  return (
    <div className="stack">
      <div className="row-between"><RuleStatusBadge status={rule.status} />{rule.sample && <span className="tag">{tr('rules.sample')}</span>}</div>
      {rule.status === 'A_VERIFIER' && <div className="callout callout-danger"><Icon name="alert" size={18} /><p>{tr('rules.aVerifierExplain')}</p></div>}
      {rule.citationWarnings?.map((w) => <p key={w} className="callout callout-warn small" role="note">{w}</p>)}
      <div className="seg seg-sm" role="group" aria-label="Vue de la fiche">
        <button type="button" aria-pressed={vue === 'juriste'} onClick={() => setVue('juriste')}>Vue juriste</button>
        <button type="button" aria-pressed={vue === 'technique'} onClick={() => setVue('technique')}>Vue technique</button>
      </div>
      {vue === 'juriste'
        ? <dl className="kv kv-dense">{rows.map(([k, v]) => <div key={k}><dt>{tr(k)}</dt><dd>{v}</dd></div>)}</dl>
        : <RuleTechnicalView rule={rule} />}
      <h3 className="h-sub">Cas de tests juridiques et contrôle fiscal</h3>
      <RuleLegalTests rule={rule} onChanged={onChanged} />
      <h3 className="h-sub">{tr('rules.approvals')}</h3>
      <ApprovalTimeline rule={rule} onDone={onChanged} />
      {!rule.sample || rule.status !== 'A_VERIFIER' ? (
        <>
          <h3 className="h-sub">Cycle de vie : suspension, abrogation</h3>
          <RuleLifecycle rule={rule} instruments={instruments} onChanged={onChanged} />
        </>
      ) : null}
      <h3 className="h-sub">Versions et historique</h3>
      <RuleVersions rule={rule} />
      {user?.roles.includes('R13') && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onNewVersion(rule)}><Icon name="replace" size={14} /> Préparer une nouvelle version</button>
      )}
      <h3 className="h-sub">Simulation d’impact et recalcul contrôlé</h3>
      <ImpactSimulation rule={rule} />
    </div>
  );
}

interface NewRule {
  code: string; label: string; revenueCategory: string; legalInstrumentIds: string; articles: string; competentAuthority: string;
  administeringEntity: string; taxableEvent: string; liableParty: string; baseDefinition: string; formula: string; rateTable: string;
  currency: string; rounding: string; periodicity: string; dueRule: string; effectiveFrom: string; beneficiaryAccountAlias: string;
  appealPath: string; sourceVerification: string; changeReason: string;
  /** Fait générateur typé (§ 6.2), facultatif. */
  taxableEventKind?: string;
  retroInstrumentId: string; retroArticle: string; retroJustification: string;
}
const EMPTY: NewRule = {
  code: '', label: '', revenueCategory: 'IMPOT_PROVINCIAL', legalInstrumentIds: '', articles: '', competentAuthority: 'Ministère provincial des Finances',
  administeringEntity: 'DGIPK', taxableEvent: '', liableParty: '', baseDefinition: '', formula: '', rateTable: '', currency: 'CDF', rounding: 'HALF_UP',
  periodicity: 'ANNUELLE', dueRule: '', effectiveFrom: '', beneficiaryAccountAlias: 'KIN-DGIPK-RECETTES-01', appealPath: '', sourceVerification: 'AUCUNE', changeReason: '',
  retroInstrumentId: '', retroArticle: '', retroJustification: '',
};

/** Pré-remplissage d'une nouvelle version à partir de la version en vigueur. */
function draftFrom(r: Rule): NewRule {
  return {
    ...EMPTY, code: r.code, label: r.label, revenueCategory: r.revenueCategory, legalInstrumentIds: r.legalInstrumentIds.join(', '),
    articles: r.articles.join(', '), competentAuthority: r.competentAuthority, administeringEntity: r.administeringEntity,
    taxableEvent: r.taxableEvent, liableParty: r.liableParty, baseDefinition: r.baseDefinition, formula: r.formula,
    rateTable: Object.entries(r.rateTable).map(([k, v]) => `${k} = ${v}`).join('\n'), currency: r.currency, rounding: r.rounding,
    periodicity: r.periodicity, dueRule: r.dueRule, effectiveFrom: '', beneficiaryAccountAlias: r.beneficiaryAccountAlias,
    appealPath: r.appealPath, sourceVerification: r.sourceVerification, changeReason: '',
  };
}

function NewRuleForm({ onCreated, initial }: { onCreated: () => void; initial?: NewRule | null }) {
  const { tr, lang } = useApp();
  const draft = useAutosave<NewRule>('legal-rule-new', EMPTY);
  const v = draft.value;
  const { setValue } = draft;
  // Pré-remplissage uniquement quand une nouvelle version est demandée (pas à chaque rendu).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- justifié : dépendances volontairement restreintes aux valeurs listées (sinon boucle de rendu ou rechargement à chaque rendu)
  useEffect(() => { if (initial) setValue(initial); }, [initial]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (k: keyof NewRule) => (e: { target: { value: string } }) => draft.setValue((p) => ({ ...p, [k]: e.target.value }));
  const text = (k: keyof NewRule, label: UIKey, opts: { mono?: boolean; area?: boolean; hint?: UIKey; type?: string } = {}) => (
    <div className="field">
      <label className="label" htmlFor={`nr-${k}`}>{tr(label)}</label>
      {opts.area ? <textarea id={`nr-${k}`} rows={2} value={v[k]} onChange={set(k)} className={opts.mono ? 'mono' : undefined} />
        : <input id={`nr-${k}`} type={opts.type ?? 'text'} value={v[k]} onChange={set(k)} className={opts.mono ? 'mono' : undefined} />}
      {opts.hint && <span className="hint">{tr(opts.hint)}</span>}
    </div>
  );
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const rateTable = Object.fromEntries(v.rateTable.split(/[\n;]/).map((l) => l.split('=').map((x) => x.trim())).filter((p) => p.length === 2 && p[0]).map((p) => [p[0], p[1]]));
    const split = (s: string) => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
    try {
      await api('/v1/legal-rules', {
        method: 'POST',
        body: (() => {
          const { retroInstrumentId, retroArticle, retroJustification, taxableEventKind, ...rest } = v;
          return {
            ...rest, ...(taxableEventKind ? { taxableEventKind } : {}), legalInstrumentIds: split(v.legalInstrumentIds), articles: split(v.articles), rateTable, exemptions: [], penalties: [],
            changeReason: v.changeReason || undefined,
            ...(retroInstrumentId ? { retroactivity: { instrumentId: retroInstrumentId, article: retroArticle, justification: retroJustification } } : {}),
          };
        })(),
      });
      setMsg({ ok: true, text: tr('rules.created') });
      draft.reset();
      onCreated();
    } catch (x) {
      const d = describeError(x);
      setMsg({ ok: false, text: d.message + (d.code ? ` (${d.code})` : '') });
    } finally { setBusy(false); }
  }
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <p className="small muted">{tr('rules.newLead')}</p>
      <div className="field-row">{text('code', 'rules.f.code', { mono: true })}{text('label', 'rules.f.label')}</div>
      <div className="field-row">
        <div className="field">
          <label className="label" htmlFor="nr-cat">{tr('rules.f.category')}</label>
          <select id="nr-cat" value={v.revenueCategory} onChange={set('revenueCategory')}>
            {['IMPOT_PROVINCIAL', 'INTERET_COMMUN', 'PROVINCIAL_SPECIFIQUE', 'RECETTE_ETD', 'DROIT_ADMINISTRATIF', 'REDEVANCE_SERVICE', 'PENALITE', 'CONCESSION_DOMANIALE'].map((c) => <option key={c} value={c}>{revenueCategoryLabel(lang, c)}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor="nr-cur">{tr('rules.f.currency')}</label>
          <select id="nr-cur" value={v.currency} onChange={set('currency')}>
            {Object.values(CURRENCIES).filter((c) => c.assessable).map((c) => <option key={c.code} value={c.code}>{c.flag} {c.code}</option>)}
          </select>
        </div>
      </div>
      {text('legalInstrumentIds', 'rules.f.instruments', { mono: true, hint: 'rules.hint.list' })}
      {text('articles', 'rules.f.articles')}
      <div className="field-row">{text('competentAuthority', 'rules.f.authority')}{text('administeringEntity', 'rules.f.entity')}</div>
      <div className="field-row">{text('taxableEvent', 'rules.f.event')}{text('liableParty', 'rules.f.liable')}</div>
      <div className="field">
        <label className="label" htmlFor="nr-tek">Fait générateur typé (facultatif)</label>
        <select id="nr-tek" value={v.taxableEventKind ?? ''} onChange={set('taxableEventKind')}>
          <option value="">—</option>
          {TAXABLE_EVENT_KINDS.map((k) => <option key={k} value={k}>{TAXABLE_EVENT_LABELS[k]}</option>)}
        </select>
      </div>
      {text('baseDefinition', 'rules.f.base')}
      {text('formula', 'rules.f.formula', { mono: true, hint: 'rules.hint.formula' })}
      {text('rateTable', 'rules.f.rates', { mono: true, area: true, hint: 'rules.hint.rates' })}
      <div className="field-row">
        <div className="field">
          <label className="label" htmlFor="nr-per">{tr('rules.f.periodicity')}</label>
          <select id="nr-per" value={v.periodicity} onChange={set('periodicity')}>{['ANNUELLE', 'MENSUELLE', 'PONCTUELLE'].map((c) => <option key={c} value={c}>{periodicityLabel(lang, c)}</option>)}</select>
        </div>
        {text('effectiveFrom', 'rules.f.effectiveFrom', { type: 'date' })}
      </div>
      <div className="field-row">{text('dueRule', 'rules.f.due')}{text('beneficiaryAccountAlias', 'rules.f.alias', { mono: true })}</div>
      {text('appealPath', 'rules.f.appeal')}
      <div className="field">
        <label className="label" htmlFor="nr-src">{tr('rules.f.source')}</label>
        <select id="nr-src" value={v.sourceVerification} onChange={set('sourceVerification')}>
          {['OFFICIEL_CERTIFIE', 'PRESSE', 'DOCUMENT_DE_TRAVAIL', 'AUCUNE'].map((c) => <option key={c} value={c}>{tr(`rules.source.${c}` as UIKey)}</option>)}
        </select>
      </div>
      {text('changeReason', 'rules.f.changeReason')}
      <fieldset className="field lr-retro">
        <legend className="label">Rétroactivité (facultatif)</legend>
        <span className="hint">Une nouvelle version dont la date d’effet précède sa publication n’est publiable que si un acte en vigueur l’autorise expressément.</span>
        <div className="field-row">
          <div className="field"><label className="label" htmlFor="nr-retro-inst">Instrument autorisant</label><input id="nr-retro-inst" className="mono" value={v.retroInstrumentId} onChange={set('retroInstrumentId')} /></div>
          <div className="field"><label className="label" htmlFor="nr-retro-art">Article</label><input id="nr-retro-art" value={v.retroArticle} onChange={set('retroArticle')} /></div>
        </div>
        <div className="field"><label className="label" htmlFor="nr-retro-just">Justification</label><textarea id="nr-retro-just" rows={2} value={v.retroJustification} onChange={set('retroJustification')} /></div>
      </fieldset>
      <AutosaveBar draft={draft} />
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'notice notice-ok' : 'notice notice-err'}>{msg.text}</p>}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{tr('rules.create')}</button>
    </form>
  );
}

export default function LegalRegister() {
  const { tr, user } = useApp();
  const q = useApi(loadRules, [user?.id]);
  const inst = useApi(() => api<Instrument[]>('/v1/legal-instruments').catch(() => [] as Instrument[]), [user?.id]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [initial, setInitial] = useState<NewRule | null>(null);
  const rules = q.data?.rules ?? [];
  // Liens directs depuis le chemin vers l'acte des modules sectoriels (29/09/2026) : ?code=CODE ouvre la dernière version
  // de la règle (visas) ; ?nouvelle=CODE ouvre la rédaction avec le code prérempli (?nouvelle=1 : code à choisir).
  const [params] = useState(() => new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search));
  const askedCode = params.get('code');
  const askedNew = params.get('nouvelle');
  const [linkDone, setLinkDone] = useState(false);
  useEffect(() => {
    if (linkDone || !q.data) return;
    if (askedCode) {
      const r = q.data.rules.filter((x) => x.code === askedCode).sort((a, b) => b.version - a.version)[0];
      if (r) setOpenId(r.id);
    } else if (askedNew) {
      if (askedNew !== '1') setInitial({ ...EMPTY, code: askedNew });
      setCreating(true);
    }
    setLinkDone(true);
  }, [q.data, askedCode, askedNew, linkDone]);
  const open = rules.find((r) => r.id === openId) ?? null;
  return (
    <div className="page">
      <PageHead eyebrow={tr('rules.eyebrow')} title={tr('rules.title')} lead={tr('rules.lead')}>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="file" size={18} /> {tr('rules.new')}</button>
      </PageHead>
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data?.fallback && <ExampleNotice text={tr('rules.fallback')} />}
      {/* Visuel de synthèse (27/09/2026) : cycle de vie, visas et devises des fiches chargées. */}
      {q.data && <RegistreVisuel rules={rules} example={q.data.fallback || rules.some((r) => r.demo || r.sample)} etat={(s) => ({ label: tr(`rules.status.${s}` as UIKey), tone: STATUS_TONE[s] ?? 'neutral' })} />}
      {q.data && (
        <DataTable
          caption={tr('rules.title')}
          rows={rules}
          rowKey={(r) => r.id}
          columns={[
            { key: 'code', label: tr('rules.f.code'), primary: true, render: (r) => <span className="nowrap-cell"><span className="mono">{r.code}</span> <span className="muted small">v{r.version}</span></span> },
            { key: 'label', label: tr('rules.f.label'), render: (r) => r.label },
            { key: 'cur', label: tr('rules.f.currency'), render: (r) => <span className="nowrap-cell">{CURRENCIES[r.currency]?.flag ?? ''}&nbsp;{r.currency}</span> },
            { key: 'status', label: tr('space.col.status'), render: (r) => <RuleStatusBadge status={r.status} /> },
            { key: 'appr', label: tr('rules.approvals'), num: true, render: (r) => `${r.approvals.length} / 4` },
            { key: 'eff', label: 'Effet', render: (r) => <span className="small nowrap-cell">{r.abrogation ? `abrogée au ${r.abrogation.date}` : r.suspension ? 'suspendue' : r.effectiveFrom}</span> },
            { key: 'act', label: tr('space.col.actions'), render: (r) => <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpenId(r.id)}>{tr('rules.open')} <Icon name="chevronRight" size={16} /></button> },
          ]}
        />
      )}
      {/* Module 26 : veille (règles expirantes, conflits de normes), archivage à quatre yeux, indicateurs. */}
      {q.data && !q.data.fallback && <VeilleRegles onChanged={q.reload} />}
      <Drawer open={!!open} title={open ? `${open.code} — ${open.label}` : ''} onClose={() => setOpenId(null)}>
        {open && <RuleDetail rule={open} instruments={inst.data ?? []} onChanged={q.reload} onNewVersion={(r) => { setInitial(draftFrom(r)); setOpenId(null); setCreating(true); }} />}
      </Drawer>
      <Drawer open={creating} title={initial ? `Nouvelle version — ${initial.code}` : tr('rules.new')} onClose={() => { setCreating(false); setInitial(null); }}>
        <NewRuleForm initial={initial} onCreated={() => { q.reload(); }} />
      </Drawer>
    </div>
  );
}
