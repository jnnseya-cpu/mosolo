/**
 * File de recouvrement (agents) : balance âgée, arriérés segmentés (sans effet), dossiers au parcours daté,
 * propositions (R20) et décisions motivées (R21), échéanciers. Aucune action automatique depuis cet écran.
 */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { Drawer } from '../../components/Drawer';
import { DataTable } from '../../components/DataTable';
import { StatusBadge, Chip } from '../../components/StatusBadge';
import { MoneyText } from '../../components/MoneyText';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import {
  hasRole, moneyEntries, NOTICE_KIND_LABEL, PLAN_LABEL, PLAN_TONE, PROPOSAL_KIND_LABEL, RISK_TONE, STEP_STATUS_LABEL, STEP_TONE,
  INSTALLMENT_LABEL, type Arrear, type Balance, type Plan, type Proposal, type RecoveryCase,
} from './types';
import { Msg, useAction } from './actions';
import { RecouvrementVisuel } from './visuels';
import './recouvrement.css';

type Tab = 'arrears' | 'decisions' | 'plans';
interface ArrearsResponse { asOf: string; items: Arrear[]; balance: Balance }
interface Indicators {
  cases: { open: number; regularised: number; classed: number };
  proposals: { pending: number; approved: number; rejected: number };
  notices: { issued: number; read: number; undelivered: number };
  appeals: { open: number; overdue: number; decidedWithinDeadline: string | null };
  plans: { requested: number; active: number; defaulted: number };
  regularisationRate: string | null;
}
interface Instrument { id: string; title: string; status: string; demo?: boolean }

async function load() {
  const [arrears, indicators, proposals, plans, instruments] = await Promise.all([
    api<ArrearsResponse>('/v1/recouvrement/arrieres'),
    api<Indicators>('/v1/recouvrement/indicateurs'),
    api<Proposal[]>('/v1/recouvrement/propositions'),
    api<Plan[]>('/v1/recouvrement/echeanciers'),
    api<Instrument[]>('/v1/legal-instruments').catch(() => [] as Instrument[]),
  ]);
  return { arrears, indicators, proposals, plans, instruments };
}

function CaseTimeline({ c }: { c: RecoveryCase }) {
  const { fmtDate } = useApp();
  return (
    <ol className="timeline rc-timeline">
      {c.timeline.map((s, i) => (
        <li key={s.kind} className={s.status === 'FAIT' ? 'done' : ''}>
          <span className="timeline-dot" aria-hidden="true">{s.status === 'FAIT' ? <Icon name="check" size={12} /> : i + 1}</span>
          <div className="min0">
            <p className="row-title">{s.label} {s.requiresDecision && <span className="rc-tag">décision R21</span>}</p>
            <p className="small muted">
              {s.plannedOn ? `Prévue le ${fmtDate(s.plannedOn)}` : 'Date fixée par l’étape précédente'}
              {s.doneOn ? ` · faite le ${fmtDate(s.doneOn)}` : ''}
              {s.demoHistoric ? ' · historique fictif' : ''}
            </p>
            <div className="rc-inline">
              <StatusBadge tone={STEP_TONE[s.status] ?? 'neutral'} label={STEP_STATUS_LABEL[s.status] ?? s.status} />
              {s.noticeId && <Link className="btn btn-ghost btn-sm" to={`/recouvrement/avis/${encodeURIComponent(s.noticeId)}`}><Icon name="file" size={14} /> Avis</Link>}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function ProposeForm({ c, instruments, onDone }: { c: RecoveryCase; instruments: Instrument[]; onDone: () => void }) {
  const inForce = instruments.filter((i) => i.status === 'EN_VIGUEUR' || i.status === 'MODIFIE');
  const suggested = (['AVIS_FORMEL', 'MISE_EN_DEMEURE', 'MESURE_EXECUTION'] as const).find((k) => k === c.nextStep.kind) ?? 'AVIS_FORMEL';
  const [kind, setKind] = useState<string>(suggested);
  const [motivation, setMotivation] = useState('');
  const [instrumentId, setInstrumentId] = useState(inForce[0]?.id ?? '');
  const [article, setArticle] = useState('');
  const [measureType, setMeasureType] = useState('');
  const { busy, msg, run } = useAction(onDone);
  const needsBasis = kind === 'MISE_EN_DEMEURE' || kind === 'MESURE_EXECUTION';
  function submit(e: FormEvent) {
    e.preventDefault();
    void run(() => api(`/v1/recouvrement/dossiers/${encodeURIComponent(c.id)}/propositions`, {
      method: 'POST',
      body: { kind, motivation, ...(needsBasis ? { legalBasis: { instrumentId, article } } : {}), ...(kind === 'MESURE_EXECUTION' ? { measureType } : {}) },
    }), 'Proposition enregistrée : elle attend la décision motivée d’une autorité distincte.');
  }
  return (
    <form className="form" onSubmit={submit}>
      <div className="field">
        <label className="label" htmlFor="rc-kind">Étape proposée</label>
        <select id="rc-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          {Object.entries(PROPOSAL_KIND_LABEL).filter(([k]) => k !== 'LEVEE').map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {needsBasis && (
        <div className="field-row">
          <div className="field">
            <label className="label" htmlFor="rc-inst">Base légale (instrument en vigueur)</label>
            <select id="rc-inst" value={instrumentId} onChange={(e) => setInstrumentId(e.target.value)}>
              {inForce.map((i) => <option key={i.id} value={i.id}>{i.demo ? '[FICTIF] ' : ''}{i.title}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="rc-art">Article</label>
            <input id="rc-art" value={article} onChange={(e) => setArticle(e.target.value)} required />
          </div>
        </div>
      )}
      {kind === 'MESURE_EXECUTION' && (
        <div className="field">
          <label className="label" htmlFor="rc-measure">Nature de la mesure prévue par l’acte</label>
          <input id="rc-measure" value={measureType} onChange={(e) => setMeasureType(e.target.value)} required />
        </div>
      )}
      <div className="field">
        <label className="label" htmlFor="rc-mot">Motivation</label>
        <textarea id="rc-mot" rows={3} value={motivation} onChange={(e) => setMotivation(e.target.value)} required minLength={10} />
        <span className="hint">Aucune étape n’est produite avant la décision d’une autorité distincte (R21).</span>
      </div>
      <Msg msg={msg} />
      <button type="submit" className="btn btn-primary" disabled={busy}><Icon name="send" size={16} /> Proposer</button>
    </form>
  );
}

function ArrearDetail({ a, instruments, roles, onChanged }: { a: Arrear; instruments: Instrument[]; roles: string[]; onChanged: () => void }) {
  const { fmtDate } = useApp();
  const q = useApi(a.caseId ? () => api<RecoveryCase>(`/v1/recouvrement/dossiers/${encodeURIComponent(a.caseId!)}`) : null, [a.caseId]);
  const { busy, msg, run } = useAction(() => { onChanged(); q.reload(); });
  const agent = hasRole(roles, 'R20');
  const c = q.data;
  return (
    <div className="stack">
      {a.demo && <p className="example-notice"><Icon name="info" size={16} /> Données de démonstration : règle fictive, dates antérieures fictives.</p>}
      <dl className="kv kv-dense">
        <div><dt>Obligation</dt><dd className="mono">{a.obligationId}</dd></div>
        <div><dt>Contribuable</dt><dd className="mono">{a.taxpayerId}</dd></div>
        <div><dt>Montant</dt><dd><MoneyText money={a.amount} /></dd></div>
        <div><dt>Échéance</dt><dd>{fmtDate(a.dueDate)} · {a.ageDays} jours de retard</dd></div>
        <div><dt>Base légale</dt><dd>{a.legalBasis.map((l) => l.title).join(' · ')}</dd></div>
        <div><dt>Prescription (indicative)</dt><dd>{fmtDate(a.prescription.prescribedOn)} · <span className="muted">{a.prescription.note}</span></dd></div>
      </dl>
      {a.segment && (
        <section className="rc-box">
          <p className="caps-sm">Segment — orientation, sans effet</p>
          <p className="row-title">{a.segment.label}</p>
          <p className="small">{a.segment.approach}</p>
          <ul className="plain-list small muted">{a.segment.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          {a.risk && <p className="small">Profil de risque : <StatusBadge tone={RISK_TONE[a.risk.level] ?? 'neutral'} label={a.risk.level.toLowerCase()} /> {a.risk.factors.join(' · ') || 'aucun facteur'}</p>}
        </section>
      )}
      {!!a.recoverability?.blockers.length && (
        <div className="callout callout-warn"><Icon name="lock" size={18} /><div><p className="row-title">Garde-fous actifs</p><ul className="plain-list small">{a.recoverability.blockers.map((b) => <li key={b.code}>{b.detail}</li>)}</ul></div></div>
      )}
      {!a.caseId && agent && (
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void run(() => api('/v1/recouvrement/dossiers', { method: 'POST', body: { obligationId: a.obligationId } }), 'Dossier ouvert.')}>
          <Icon name="file" size={16} /> Ouvrir un dossier de recouvrement
        </button>
      )}
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {c && (
        <>
          <h3 className="h-sub">Parcours daté</h3>
          <CaseTimeline c={c} />
          <div className="rc-box">
            <p className="caps-sm">Prochaine étape suggérée</p>
            <p className="row-title">{c.nextStep.label}</p>
            {c.nextStep.blockers.length > 0 && <ul className="plain-list small muted">{c.nextStep.blockers.map((b) => <li key={b.code}>{b.detail}</li>)}</ul>}
          </div>
          {!!c.observations.length && (
            <>
              <h3 className="h-sub">Observations du contribuable</h3>
              <ul className="list-rows">{c.observations.map((o) => <li key={o.at} className="list-row list-row-stack"><span className="small muted">{fmtDate(o.at, true)}</span><span>{o.text}</span></li>)}</ul>
            </>
          )}
          {!!c.proposals.length && (
            <>
              <h3 className="h-sub">Propositions et décisions</h3>
              <ul className="list-rows">
                {c.proposals.map((p) => (
                  <li key={p.id} className="list-row list-row-stack">
                    <span className="row-title">{PROPOSAL_KIND_LABEL[p.kind] ?? p.kind} <StatusBadge tone={p.status === 'APPROUVEE' ? 'good' : p.status === 'REJETEE' ? 'neutral' : 'info'} label={p.status.toLowerCase()} /></span>
                    <span className="small muted">Proposée par {p.proposedBy} le {fmtDate(p.proposedAt, true)} — {p.motivation}</span>
                    {p.decision && <span className="small">Décision de {p.decision.by} : {p.decision.motivation}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {agent && c.status === 'OUVERT' && (
            <>
              <div className="btn-row">
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void run(() => api(`/v1/recouvrement/dossiers/${encodeURIComponent(c.id)}/rappel`, { method: 'POST' }), 'Rappel amiable envoyé.')}>
                  <Icon name="message" size={14} /> Envoyer le rappel dû
                </button>
              </div>
              <h3 className="h-sub">Proposer une étape</h3>
              <ProposeForm c={c} instruments={instruments} onDone={() => { onChanged(); q.reload(); }} />
            </>
          )}
        </>
      )}
      <Msg msg={msg} />
    </div>
  );
}

function DecisionCard({ p, onDone }: { p: Proposal; onDone: () => void }) {
  const { fmtDate } = useApp();
  const [motivation, setMotivation] = useState('');
  const { busy, msg, run } = useAction(onDone);
  const decide = (decision: 'APPROUVEE' | 'REJETEE') => void run(
    () => api(`/v1/recouvrement/propositions/${encodeURIComponent(p.id)}/decision`, { method: 'POST', body: { decision, motivation } }),
    decision === 'APPROUVEE' ? 'Décision enregistrée ; l’avis correspondant est notifié.' : 'Proposition rejetée (motif tracé).',
  );
  return (
    <article className="panel rc-decision">
      <div className="panel-head">
        <div className="min0">
          <p className="panel-title">{PROPOSAL_KIND_LABEL[p.kind] ?? p.kind}</p>
          <p className="panel-sub">Dossier {p.caseId} · obligation <span className="mono">{p.obligationId}</span></p>
        </div>
        <Chip>{p.proposedBy === 'systeme' ? 'Proposée par le système (levée)' : `Proposée par ${p.proposedBy}`}</Chip>
      </div>
      <p className="small">{p.motivation}</p>
      {p.legalBasis && <p className="small muted">Fondement : {p.legalBasis.title} — {p.legalBasis.article}</p>}
      {p.measureType && <p className="small muted">Mesure : {p.measureType}</p>}
      <p className="small muted">Le {fmtDate(p.proposedAt, true)}</p>
      <div className="field">
        <label className="label" htmlFor={`dec-${p.id}`}>Motivation de la décision</label>
        <textarea id={`dec-${p.id}`} rows={2} value={motivation} onChange={(e) => setMotivation(e.target.value)} minLength={10} />
      </div>
      <div className="btn-row">
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || motivation.trim().length < 10} onClick={() => decide('APPROUVEE')}><Icon name="check" size={14} /> Approuver</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy || motivation.trim().length < 10} onClick={() => decide('REJETEE')}><Icon name="x" size={14} /> Rejeter</button>
      </div>
      <Msg msg={msg} />
    </article>
  );
}

function PlanCard({ p, roles, onDone }: { p: Plan; roles: string[]; onDone: () => void }) {
  const { fmtDate } = useApp();
  const [motivation, setMotivation] = useState('');
  const { busy, msg, run } = useAction(onDone);
  return (
    <article className="panel">
      <div className="panel-head">
        <div className="min0">
          <p className="panel-title">Échéancier {p.id}</p>
          <p className="panel-sub">Obligation <span className="mono">{p.obligationId}</span> · {p.requestedCount} échéances demandées le {fmtDate(p.requestedAt)}</p>
        </div>
        <StatusBadge tone={PLAN_TONE[p.status] ?? 'neutral'} label={PLAN_LABEL[p.status] ?? p.status} />
      </div>
      <p className="small">{p.reason}</p>
      <p className="small muted">Fondement : {p.legalBasis.title}{p.legalBasis.demo ? ' [FICTIF]' : ''}</p>
      {!!p.rows?.length && (
        <ul className="list-rows compact-rows">
          {p.rows.map((r) => (
            <li key={r.seq} className="list-row"><span>N° {r.seq} · {fmtDate(r.dueDate)}</span><span className="row-side"><MoneyText money={r.amount} showIndicative={false} /><StatusBadge tone={INSTALLMENT_LABEL[r.state]!.tone} label={INSTALLMENT_LABEL[r.state]!.label} /></span></li>
          ))}
        </ul>
      )}
      {p.defaultToExamine && <div className="callout callout-warn"><Icon name="alert" size={18} /><p>Échéance impayée au-delà du délai de grâce : défaillance à examiner par un agent.</p></div>}
      {(p.status === 'DEMANDE' && hasRole(roles, 'R20', 'R21')) || (p.defaultToExamine && hasRole(roles, 'R20')) ? (
        <>
          <div className="field">
            <label className="label" htmlFor={`pl-${p.id}`}>Motivation</label>
            <textarea id={`pl-${p.id}`} rows={2} value={motivation} onChange={(e) => setMotivation(e.target.value)} />
          </div>
          <div className="btn-row">
            {p.status === 'DEMANDE' ? (
              <>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy || motivation.trim().length < 10} onClick={() => void run(() => api(`/v1/recouvrement/echeanciers/${encodeURIComponent(p.id)}/decision`, { method: 'POST', body: { granted: true, motivation } }), 'Échéancier accordé et notifié.')}>Accorder</button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy || motivation.trim().length < 10} onClick={() => void run(() => api(`/v1/recouvrement/echeanciers/${encodeURIComponent(p.id)}/decision`, { method: 'POST', body: { granted: false, motivation } }), 'Demande refusée (motif tracé).')}>Refuser</button>
              </>
            ) : (
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy || motivation.trim().length < 10} onClick={() => void run(() => api(`/v1/recouvrement/echeanciers/${encodeURIComponent(p.id)}/defaillance`, { method: 'POST', body: { motivation } }), 'Défaillance constatée.')}>Constater la défaillance</button>
            )}
          </div>
        </>
      ) : null}
      <Msg msg={msg} />
    </article>
  );
}

export default function RecoveryQueue() {
  const { user, fmtDate } = useApp();
  const roles = user?.roles ?? [];
  const q = useApi(load, [user?.id]);
  const [tab, setTab] = useState<Tab>('arrears');
  const [segment, setSegment] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const sched = useAction(q.reload);
  const d = q.data;
  const items = (d?.arrears.items ?? []).filter((a) => !segment || a.segment?.code === segment);
  const open = d?.arrears.items.find((a) => a.obligationId === openId) ?? null;
  const pending = (d?.proposals ?? []).filter((p) => p.status === 'PROPOSEE');
  const canSchedule = hasRole(roles, 'R20', 'R06', 'R07');
  return (
    <div className="page page-wide rc-page">
      <PageHead eyebrow="Recouvrement" title="File de recouvrement" lead="Arriérés, parcours gradué et décisions motivées. Le système constate et rappelle ; toute étape au-delà du rappel est proposée par un agent et décidée par une autorité distincte.">
        {canSchedule && (
          <button type="button" className="btn btn-secondary" disabled={sched.busy} onClick={() => void sched.run(() => api('/v1/recouvrement/planification', { method: 'POST' }), 'Planification exécutée : rappels datés et constats de retard à jour.')}>
            <Icon name="refresh" size={16} /> Exécuter la planification
          </button>
        )}
        <Link className="btn btn-ghost" to="/recouvrement/remises"><Icon name="scale" size={16} /> Remises</Link>
        <Link className="btn btn-ghost" to="/recouvrement/non-valeurs"><Icon name="ban" size={16} /> Non-valeurs</Link>
      </PageHead>
      <Msg msg={sched.msg} />
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {d && (
        <>
          <div className="kpi-row">
            <div className="kpi"><p className="kpi-label">Encours échu</p><div className="kpi-value rc-kpi-money">{moneyEntries(d.arrears.balance.total).map((m) => <MoneyText key={m.currency} money={m} showIndicative={false} />)}{!d.arrears.balance.count && '—'}</div><p className="kpi-sub">{d.arrears.balance.count} créance(s) au {fmtDate(d.arrears.asOf)}</p></div>
            <div className="kpi"><p className="kpi-label">Dossiers ouverts</p><p className="kpi-value">{d.indicators.cases.open}</p><p className="kpi-sub">{d.indicators.cases.regularised} régularisé(s)</p></div>
            <div className="kpi"><p className="kpi-label">Décisions attendues</p><p className="kpi-value">{d.indicators.proposals.pending}</p><p className="kpi-sub">{d.indicators.proposals.approved} approuvée(s)</p></div>
            <div className="kpi"><p className="kpi-label">Avis notifiés</p><p className="kpi-value">{d.indicators.notices.issued}</p><p className="kpi-sub">{d.indicators.notices.read} lu(s)</p></div>
            <div className="kpi"><p className="kpi-label">Recours hors délai</p><p className="kpi-value">{d.indicators.appeals.overdue}</p><p className="kpi-sub">{d.indicators.appeals.open} en cours</p></div>
          </div>

          <section className="panel rc-aging">
            <div className="panel-head"><div><p className="panel-title">Balance âgée</p><p className="panel-sub">Totaux par devise, jamais additionnés entre devises</p></div></div>
            <div className="rc-bands">
              {d.arrears.balance.bands.map((b) => (
                <div key={b.code} className="rc-band">
                  <p className="caps-sm">{b.label}</p>
                  {moneyEntries(d.arrears.balance.byBand[b.code]).map((m) => <MoneyText key={m.currency} money={m} showIndicative={false} />)}
                  {!d.arrears.balance.byBand[b.code] && <span className="muted">—</span>}
                </div>
              ))}
            </div>
          </section>

          <RecouvrementVisuel items={d.arrears.items} balance={d.arrears.balance} indicators={d.indicators} plans={d.plans} />

          <div className="seg seg-wrap" role="group" aria-label="Vue">
            <button type="button" aria-pressed={tab === 'arrears'} onClick={() => setTab('arrears')}>Arriérés <span className="count">{d.arrears.items.length}</span></button>
            <button type="button" aria-pressed={tab === 'decisions'} onClick={() => setTab('decisions')}>Décisions <span className="count">{pending.length}</span></button>
            <button type="button" aria-pressed={tab === 'plans'} onClick={() => setTab('plans')}>Échéanciers <span className="count">{d.plans.length}</span></button>
          </div>

          {tab === 'arrears' && (
            <>
              <div className="field rc-filter">
                <label className="label" htmlFor="rc-seg">Segment</label>
                <select id="rc-seg" value={segment} onChange={(e) => setSegment(e.target.value)}>
                  <option value="">Tous les segments</option>
                  {Object.keys(d.arrears.balance.bySegment).map((s) => <option key={s} value={s}>{d.arrears.items.find((a) => a.segment?.code === s)?.segment?.label ?? s} ({d.arrears.balance.bySegment[s]})</option>)}
                </select>
              </div>
              <DataTable
                caption="Arriérés"
                rows={items}
                rowKey={(a) => a.obligationId}
                empty={<EmptyState title="Aucun arriéré" icon="check">Aucune obligation échue impayée.</EmptyState>}
                columns={[
                  { key: 'o', label: 'Obligation', primary: true, render: (a) => <span className="min0"><span className="mono small">{a.obligationId}</span><br /><span className="small muted">{a.label}</span></span> },
                  { key: 'm', label: 'Montant', num: true, render: (a) => <MoneyText money={a.amount} showIndicative={false} /> },
                  { key: 'age', label: 'Retard', num: true, render: (a) => `${a.ageDays} j` },
                  { key: 'seg', label: 'Segment', render: (a) => a.segment ? <Chip>{a.segment.label}</Chip> : '—' },
                  { key: 'risk', label: 'Risque', render: (a) => a.risk ? <StatusBadge tone={RISK_TONE[a.risk.level] ?? 'neutral'} label={a.risk.level.toLowerCase()} /> : '—' },
                  { key: 'next', label: 'Étape suivante', render: (a) => <span className="small">{a.nextStep?.label ?? 'Dossier à ouvrir'}{a.nextStep && !a.nextStep.eligible && a.nextStep.blockers.length ? <span className="muted"> · bloquée</span> : null}</span> },
                  { key: 'act', label: 'Actions', render: (a) => <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpenId(a.obligationId)}>Ouvrir <Icon name="chevronRight" size={16} /></button> },
                ]}
              />
              <p className="small muted rc-foot">La segmentation et le profil de risque sont des aides à l’orientation : ils ne déclenchent aucune mesure. Seuil « grand redevable » : valeur de démonstration [EXEMPLE].</p>
            </>
          )}

          {tab === 'decisions' && (
            <div className="rc-grid">
              {!hasRole(roles, 'R21') && <p className="callout callout-info"><Icon name="info" size={18} /> Les décisions sont réservées à l’autorité de décision (R21), distincte de l’agent qui propose.</p>}
              {pending.length === 0 && <EmptyState title="Aucune décision attendue" icon="check" />}
              {hasRole(roles, 'R21') ? pending.map((p) => <DecisionCard key={p.id} p={p} onDone={q.reload} />) : pending.map((p) => (
                <article key={p.id} className="panel"><p className="panel-title">{PROPOSAL_KIND_LABEL[p.kind]}</p><p className="small muted">{p.caseId} · {p.motivation}</p></article>
              ))}
            </div>
          )}

          {tab === 'plans' && (
            <div className="rc-grid">
              {d.plans.length === 0 && <EmptyState title="Aucun échéancier" icon="clock" />}
              {d.plans.map((p) => <PlanCard key={p.id} p={p} roles={roles} onDone={q.reload} />)}
            </div>
          )}
        </>
      )}
      <Drawer open={!!open} title={open ? `Arriéré ${open.obligationId}` : ''} onClose={() => setOpenId(null)}>
        {open && d && <ArrearDetail a={open} instruments={d.instruments} roles={roles} onChanged={q.reload} />}
      </Drawer>
      {d && d.proposals.some((p) => p.noticeId) && (
        <section className="section">
          <h2 className="h-sub">Derniers avis issus de décisions</h2>
          <ul className="list-rows">
            {d.proposals.filter((p) => p.noticeId).slice(0, 6).map((p) => (
              <li key={p.id} className="list-row"><span>{NOTICE_KIND_LABEL[p.kind === 'MESURE_EXECUTION' ? 'DECISION_MESURE' : p.kind] ?? p.kind} · <span className="mono small">{p.noticeId}</span></span><Link className="btn btn-ghost btn-sm" to={`/recouvrement/avis/${encodeURIComponent(p.noticeId!)}`}>Aperçu imprimable <Icon name="arrowRight" size={14} /></Link></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
