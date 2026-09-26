/**
 * Espace contribuable : mes arriérés et échéances, avis reçus (accusé de lecture), échéanciers, mes recours
 * (délais légaux et décompte, pièces par empreinte, effet suspensif). Aucun profilage n'est affiché.
 */
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { MoneyText } from '../../components/MoneyText';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { api, ApiError } from '../../lib/api';
import { sha256Hex } from '../../lib/crypto';
import {
  APPEAL_STATE, errText, INSTALLMENT_LABEL, NOTICE_KIND_LABEL, PLAN_LABEL, PLAN_TONE, SUSPENSIVE_LABEL,
  type Appeal, type Arrear, type Plan,
} from './types';
import './recouvrement.css';

interface Mine {
  asOf: string;
  arrears: Arrear[];
  upcoming: { obligationId: string; label: string; amount: MoneyJSON; dueDate: string; status: string; daysToDue: number }[];
  notices: { id: string; number: string; kind: string; title: string; issuedAt: string; readAt: string | null; obligationId: string; demo: boolean }[];
  plans: Plan[];
  planBasis: { available: boolean; title?: string; demo?: boolean; detail: string };
  procedure: { maxInstallments: number };
}

async function load() {
  const [mine, appeals] = await Promise.all([
    api<Mine>('/v1/recouvrement/mes-arrieres'),
    api<Appeal[]>('/v1/appeals').catch((e: unknown) => { if (e instanceof ApiError && e.status === 403) return [] as Appeal[]; throw e; }),
  ]);
  return { mine, appeals };
}

function useAction(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ ok: true, text: ok }); onDone(); } catch (e) { setMsg({ ok: false, text: errText(e) }); } finally { setBusy(false); }
  }
  const view = msg ? <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'notice notice-ok' : 'notice notice-err'}>{msg.text}</p> : null;
  return { busy, run, view };
}

function ArrearCard({ a, basis, max, onDone }: { a: Arrear; basis: Mine['planBasis']; max: number; onDone: () => void }) {
  const { fmtDate } = useApp();
  const [mode, setMode] = useState<'none' | 'plan' | 'obs'>('none');
  const [count, setCount] = useState(3);
  const [text, setText] = useState('');
  const act = useAction(() => { setMode('none'); setText(''); onDone(); });
  const hasPlan = a.plan && (a.plan.status === 'DEMANDE' || a.plan.status === 'ACCORDE');
  function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === 'plan') void act.run(() => api('/v1/recouvrement/echeanciers', { method: 'POST', body: { obligationId: a.obligationId, installments: count, reason: text } }), 'Demande d’échéancier enregistrée ; un agent y répondra par une décision motivée.');
    else void act.run(() => api(`/v1/recouvrement/dossiers/${encodeURIComponent(a.caseId!)}/observations`, { method: 'POST', body: { text } }), 'Vos observations sont versées au dossier.');
  }
  return (
    <article className="panel rc-arrear">
      <div className="panel-head">
        <div className="min0">
          <p className="panel-title">{a.label}</p>
          <p className="panel-sub mono">{a.obligationId}</p>
        </div>
        <StatusBadge tone="critical" label={`${a.ageDays} jours de retard`} />
      </div>
      {a.demo && <p className="example-notice"><Icon name="info" size={16} /> Démonstration : règle fictive, sans valeur juridique.</p>}
      <dl className="kv kv-dense">
        <div><dt>Montant dû</dt><dd><MoneyText money={a.amount} /></dd></div>
        <div><dt>Échéance</dt><dd>{fmtDate(a.dueDate)}</dd></div>
        <div><dt>Base légale</dt><dd>{a.legalBasis.map((l) => l.title).join(' · ')}</dd></div>
      </dl>
      {!!a.steps?.length && (
        <>
          <p className="caps-sm">Étapes déjà notifiées</p>
          <ul className="list-rows compact-rows">
            {a.steps.map((s) => (
              <li key={s.kind} className="list-row"><span>{s.label}</span><span className="row-side"><span className="small muted">{fmtDate(s.doneOn)}</span>{s.noticeId && <Link className="btn btn-ghost btn-sm" to={`/recouvrement/avis/${encodeURIComponent(s.noticeId)}`}>Lire</Link>}</span></li>
            ))}
          </ul>
        </>
      )}
      {!!a.pendingMeasure?.length && (
        <div className="callout callout-warn"><Icon name="scale" size={18} /><p>Une mesure est <strong>envisagée</strong> ({a.pendingMeasure[0]!.measureType}) mais n’est pas décidée. Vous pouvez présenter vos observations, régulariser ou contester.</p></div>
      )}
      <div className="btn-row">
        <Link className="btn btn-primary btn-sm" to="/espace"><Icon name="card" size={14} /> Payer par le circuit officiel</Link>
        {!hasPlan && basis.available && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMode('plan')}>Demander un échéancier</button>}
        {a.caseId && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMode('obs')}>Présenter mes observations</button>}
      </div>
      {!basis.available && <p className="small muted">Échéancier : {basis.detail}</p>}
      {mode !== 'none' && (
        <form className="form rc-inline-form" onSubmit={submit}>
          {mode === 'plan' && (
            <div className="field">
              <label className="label" htmlFor={`n-${a.obligationId}`}>Nombre d’échéances (2 à {max})</label>
              <input id={`n-${a.obligationId}`} type="number" min={2} max={max} value={count} onChange={(e) => setCount(Number(e.target.value))} />
              <span className="hint">Fondement : {basis.title}{basis.demo ? ' [FICTIF — démonstration]' : ''}</span>
            </div>
          )}
          <div className="field">
            <label className="label" htmlFor={`t-${a.obligationId}`}>{mode === 'plan' ? 'Motif de la demande' : 'Vos observations'}</label>
            <textarea id={`t-${a.obligationId}`} rows={3} value={text} onChange={(e) => setText(e.target.value)} required minLength={5} />
          </div>
          <div className="btn-row">
            <button type="submit" className="btn btn-primary btn-sm" disabled={act.busy}>Envoyer</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMode('none')}>Annuler</button>
          </div>
        </form>
      )}
      {act.view}
    </article>
  );
}

function AppealCard({ a, onDone }: { a: Appeal; onDone: () => void }) {
  const { fmtDate } = useApp();
  const act = useAction(onDone);
  const [reason, setReason] = useState('');
  const open = a.status === 'DEPOSEE' || a.status === 'PROPOSITION';
  const state = APPEAL_STATE[a.deadlines.state] ?? { label: a.deadlines.state, tone: 'neutral' as const };
  async function attach(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const sha256 = await sha256Hex(await f.arrayBuffer());
    void act.run(() => api(`/v1/appeals/${encodeURIComponent(a.id)}/documents`, { method: 'POST', body: { sha256, name: f.name, mediaType: f.type || 'application/octet-stream', sizeBytes: f.size } }), 'Pièce enregistrée par son empreinte SHA-256.');
  }
  return (
    <article className="panel">
      <div className="panel-head">
        <div className="min0">
          <p className="panel-title">Réclamation {a.id}</p>
          <p className="panel-sub">Obligation <span className="mono">{a.obligationId}</span> · déposée le {fmtDate(a.submittedAt, true)}</p>
        </div>
        <StatusBadge tone={state.tone} label={state.label} />
      </div>
      {open && a.deadlines.daysRemaining !== null && (
        <p className="rc-countdown"><span className="rc-countdown-num">{Math.max(0, a.deadlines.daysRemaining)}</span> jour(s) restant(s) pour la décision — avant le {fmtDate(a.deadlines.decisionDueBy)}</p>
      )}
      <dl className="kv kv-dense">
        <div><dt>Motif</dt><dd>{a.grounds}</dd></div>
        <div><dt>Accusé de réception</dt><dd className="mono small">{a.acknowledgement?.number ?? '—'}</dd></div>
        <div><dt>Délai d’introduction</dt><dd>{fmtDate(a.deadlines.filingDeadline)}{a.deadlines.filedLate ? ' — déposée après ce délai (recevabilité examinée par un agent)' : ''}</dd></div>
        <div><dt>Effet suspensif</dt><dd>{SUSPENSIVE_LABEL[a.suspensiveEffect?.status ?? 'NON_DEMANDE']}{a.suspensiveEffect?.decisionReason ? ` — ${a.suspensiveEffect.decisionReason}` : ''}</dd></div>
        <div><dt>Pièces</dt><dd>{a.documents?.length ? a.documents.map((d) => `${d.name} (${d.sha256.slice(0, 10)}…)`).join(' · ') : 'Aucune'}</dd></div>
        {a.decision && <div><dt>Décision</dt><dd>{a.decision.decision} — {a.decision.reason}</dd></div>}
        {a.nextRemedy && <div><dt>Voie suivante</dt><dd className="small">{a.nextRemedy.hierarchical} ; {a.nextRemedy.judicial}</dd></div>}
      </dl>
      <p className="small muted">Délais : valeurs de conception à confirmer par l’Édit n° 005/2021 [À VÉRIFIER].</p>
      {open && (
        <div className="btn-row">
          <label className="btn btn-secondary btn-sm rc-file"><Icon name="upload" size={14} /> Joindre une pièce<input type="file" onChange={(e) => void attach(e)} /></label>
        </div>
      )}
      {open && (a.suspensiveEffect?.status ?? 'NON_DEMANDE') === 'NON_DEMANDE' && (
        <form className="form rc-inline-form" onSubmit={(e) => { e.preventDefault(); void act.run(() => api(`/v1/appeals/${encodeURIComponent(a.id)}/suspensive-effect`, { method: 'POST', body: { reason } }), 'Demande d’effet suspensif transmise à l’autorité de décision.'); }}>
          <div className="field">
            <label className="label" htmlFor={`se-${a.id}`}>Demander l’effet suspensif (aucune mesure pendant l’examen si accordé)</label>
            <input id={`se-${a.id}`} value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} required />
          </div>
          <button type="submit" className="btn btn-ghost btn-sm" disabled={act.busy}>Demander</button>
        </form>
      )}
      {!!a.history?.length && (
        <details className="rc-history"><summary className="small">Historique ({a.history.length})</summary>
          <ul className="plain-list small muted">{a.history.map((h) => <li key={h.at + h.action}>{fmtDate(h.at, true)} — {h.action}{h.detail ? ` : ${h.detail}` : ''}</li>)}</ul>
        </details>
      )}
      {act.view}
    </article>
  );
}

export default function MyArrears() {
  const { user, fmtDate } = useApp();
  const q = useApi(load, [user?.id]);
  const d = q.data;
  const isTaxpayer = !!user?.roles.some((r) => r === 'R30' || r === 'R31');
  return (
    <div className="page rc-page">
      <PageHead eyebrow="Mon espace" title="Mes arriérés et échéances" lead="Ce que vous devez, pourquoi, jusqu’à quand, et vos droits : échéancier si un acte l’autorise, observations avant toute mesure, réclamation avec délais affichés." />
      {!isTaxpayer && <p className="callout callout-info"><Icon name="info" size={18} /> Écran réservé aux contribuables et à leurs mandataires : choisissez un profil contribuable de démonstration.</p>}
      {q.loading && <Loading />}
      {q.error !== null && isTaxpayer && <ErrorState error={q.error} onRetry={q.reload} />}
      {d && (
        <>
          <section className="section">
            <h2 className="h-sub">Arriérés</h2>
            {d.mine.arrears.length === 0 ? <EmptyState title="Aucun arriéré" icon="check">Aucune obligation échue impayée à ce jour ({fmtDate(d.mine.asOf)}).</EmptyState> : (
              <div className="rc-grid">{d.mine.arrears.map((a) => <ArrearCard key={a.obligationId} a={a} basis={d.mine.planBasis} max={d.mine.procedure.maxInstallments} onDone={q.reload} />)}</div>
            )}
          </section>

          <section className="section">
            <h2 className="h-sub">Prochaines échéances</h2>
            {d.mine.upcoming.length === 0 ? <p className="muted small">Aucune échéance à venir.</p> : (
              <ul className="list-rows">
                {d.mine.upcoming.map((u) => (
                  <li key={u.obligationId} className="list-row"><span className="min0"><span className="row-title">{u.label}</span><br /><span className="small muted">Échéance le {fmtDate(u.dueDate)} · dans {u.daysToDue} jour(s)</span></span><MoneyText money={u.amount} /></li>
                ))}
              </ul>
            )}
          </section>

          <section className="section">
            <h2 className="h-sub">Échéanciers</h2>
            {d.mine.plans.length === 0 ? <p className="muted small">Aucun échéancier.</p> : d.mine.plans.map((p) => (
              <article key={p.id} className="panel rc-plan">
                <div className="panel-head"><p className="panel-title">Échéancier {p.id}</p><StatusBadge tone={PLAN_TONE[p.status] ?? 'neutral'} label={PLAN_LABEL[p.status] ?? p.status} /></div>
                {p.decision && <p className="small">{p.decision.granted ? 'Accordé' : 'Refusé'} le {fmtDate(p.decision.at)} — {p.decision.motivation}</p>}
                {!!p.rows?.length && (
                  <ul className="list-rows compact-rows">
                    {p.rows.map((r) => <li key={r.seq} className="list-row"><span>Échéance {r.seq} · {fmtDate(r.dueDate)}</span><span className="row-side"><MoneyText money={r.amount} showIndicative={false} /><StatusBadge tone={INSTALLMENT_LABEL[r.state]!.tone} label={INSTALLMENT_LABEL[r.state]!.label} /></span></li>)}
                  </ul>
                )}
                {p.legalBasis.demo && <p className="small muted">Fondement FICTIF de démonstration : {p.legalBasis.title}</p>}
              </article>
            ))}
          </section>

          <section className="section">
            <h2 className="h-sub">Avis reçus</h2>
            {d.mine.notices.length === 0 ? <p className="muted small">Aucun avis.</p> : (
              <ul className="list-rows">
                {d.mine.notices.map((n) => (
                  <li key={n.id} className="list-row">
                    <span className="min0"><span className="row-title">{NOTICE_KIND_LABEL[n.kind] ?? n.title}</span><br /><span className="small muted mono">{n.number}</span> <span className="small muted">· {fmtDate(n.issuedAt, true)}</span></span>
                    <span className="row-side">
                      {n.readAt ? <StatusBadge tone="good" label="Lu" /> : <StatusBadge tone="info" label="Non lu" />}
                      <Link className="btn btn-ghost btn-sm" to={`/recouvrement/avis/${encodeURIComponent(n.id)}`}>Ouvrir <Icon name="chevronRight" size={14} /></Link>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="section">
            <h2 className="h-sub">Mes réclamations</h2>
            {d.appeals.length === 0 ? <p className="muted small">Aucune réclamation. Vous pouvez contester une obligation depuis votre espace.</p> : (
              <div className="rc-grid">{d.appeals.map((a) => <AppealCard key={a.id} a={a} onDone={q.reload} />)}</div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
