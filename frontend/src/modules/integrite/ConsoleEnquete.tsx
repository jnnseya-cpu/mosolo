/** Console de l'enquêteur anti-fraude : file des signalements, alertes à examiner, dossiers d'enquête. */
import { useMemo, useState } from 'react';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { Drawer } from '../../components/Drawer';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { useApp } from '../../context';
import {
  ActionError, CATEGORY_LABELS, CHANNEL_LABELS, DECISION_LABELS, EvidencePicker, FINDING_LABELS, hasRole, Kpi, SEVERITY_LABELS, SeverityBadge,
  StateBadge, Tabs, useAction, type Evidence,
} from './shared';
import './integrite.css';

interface ReportRow {
  id: string; reference: string; channel: string; category: string; categoryLabel: string; description: string; commune?: string; place?: string;
  occurredOn?: string; target?: { kind: string; reference?: string }; anonymous: boolean; reporterContactLabel: string; status: string;
  receivedAt: string; qualifyBy: string; treatBy?: string; investigatorId?: string; caseId?: string; ageHours: number; overdue: boolean;
  qualification?: { severity: string; note: string; by: string }; evidence: { id: string; sha256: string; label: string; addedAt: string }[];
  messages: { at: string; from: string; text: string }[]; closure?: { outcome: string; reason: string };
}
interface AlertRow {
  id: string; ruleCode: string; ruleLabel: string; severity: string; explanation: string; confidence: string; status: string; raisedAt: string;
  variables: { name: string; value: string; source: string }[]; subjects: { kind: string; ref: string }[]; automaticEffect: string;
  closureProposal?: { by: string; reason: string }; examinedBy?: string; caseId?: string; history: { at: string; by: string; action: string; note?: string }[];
}
interface CaseRow { id: string; title: string; status: string; investigatorId: string; openedAt: string; ageDays: number; evidence: number; finding: string | null; decision: string | null }
interface CaseDetail {
  id: string; title: string; status: string; openingReason: string; openedBy: string; openedAt: string; investigatorId: string; ageDays: number;
  evidence: { id: string; sha256: string; label: string; addedAt: string; addedBy: string }[];
  timeline: { at: string; by: string; kind: string; text: string }[]; links: { kind: string; ref: string; note?: string }[];
  contributors: string[]; reports: { id: string; reference: string; categoryLabel: string; status: string }[];
  alerts: { id: string; ruleLabel: string; severity: string; status: string }[];
  conclusions?: { finding: string; summary: string; recommendation: string; by: string; at: string };
  decision?: { decision: string; reason: string; by: string; at: string; execution: string };
  auditTrail: { at: string; action: string; actor: string; hash: string }[];
}
interface Indicators {
  signalements: { total: number; ouverts: number; enRetard: number; delaiMoyenJours: number | null; partConfirmee: string | null };
  alertes: { ouvertes: number; classees: number; versDossier: number };
  dossiers: { ouverts: number; decides: number; delaiInstructionMoyenJours: number | null };
}

type Tab = 'reports' | 'alerts' | 'cases';

export default function ConsoleEnquete() {
  const { user } = useApp();
  const roles = user?.roles;
  const canReports = hasRole(roles, 'R24', 'R22');
  const canAlerts = hasRole(roles, 'R24', 'R22', 'R28');
  const canCases = hasRole(roles, 'R24', 'R22', 'R06', 'R21');
  const initial: Tab = canReports ? 'reports' : canAlerts ? 'alerts' : 'cases';
  const [tab, setTab] = useState<Tab>(initial);
  const [openReport, setOpenReport] = useState<string | null>(null);
  const [openAlert, setOpenAlert] = useState<string | null>(null);
  const [openCase, setOpenCase] = useState<string | null>(null);

  const ind = useApi(canReports || canAlerts ? () => api<Indicators>('/v1/integrite/indicators') : null, [user?.id]);
  const reports = useApi(canReports ? () => api<ReportRow[]>('/v1/integrite/reports') : null, [user?.id]);
  const alerts = useApi(canAlerts ? () => api<AlertRow[]>('/v1/integrite/alerts') : null, [user?.id]);
  const cases = useApi(canCases ? () => api<CaseRow[]>('/v1/integrite/cases') : null, [user?.id]);
  const reloadAll = () => { ind.reload(); reports.reload(); alerts.reload(); cases.reload(); };

  const detect = useAction();
  const runDetection = async () => {
    await detect.run(() => api('/v1/integrite/detection/run', { method: 'POST', body: {} }));
    reloadAll();
  };

  if (!canReports && !canAlerts && !canCases) {
    return (
      <div className="page">
        <PageHead eyebrow="Intégrité" title="Console d’enquête" />
        <EmptyState title="Accès réservé" icon="lock">Cette console est réservée aux enquêteurs anti-fraude, à l’audit interne et aux autorités de décision.</EmptyState>
      </div>
    );
  }

  const tabs: { id: Tab; label: string; count?: number }[] = [];
  if (canReports) tabs.push({ id: 'reports', label: 'Signalements', count: reports.data?.filter((r) => r.status !== 'CLOS').length });
  if (canAlerts) tabs.push({ id: 'alerts', label: 'Alertes', count: alerts.data?.filter((a) => ['A_EXAMINER', 'EN_EXAMEN', 'CLOTURE_PROPOSEE'].includes(a.status)).length });
  if (canCases) tabs.push({ id: 'cases', label: 'Dossiers d’enquête', count: cases.data?.filter((c) => c.status !== 'DECIDE').length });

  return (
    <div className="page page-wide ig-page">
      <PageHead eyebrow="Intégrité · anti-fraude" title="Console d’enquête"
        lead="Le système constate et propose ; l’enquêteur instruit ; une autorité distincte décide, avec motif. Aucune alerte n’a d’effet automatique.">
        {hasRole(roles, 'R24', 'R22', 'R28') && (
          <button type="button" className="btn btn-secondary" disabled={detect.busy} onClick={() => void runDetection()}>
            <Icon name="refresh" size={18} /> {detect.busy ? 'Analyse…' : 'Lancer la détection'}
          </button>
        )}
      </PageHead>
      <ActionError error={detect.error} />
      {ind.data && (
        <div className="kpi-row ig-kpis">
          <Kpi label="Signalements ouverts" value={ind.data.signalements.ouverts} sub={`${ind.data.signalements.enRetard} hors délai`} />
          <Kpi label="Délai moyen de traitement" value={ind.data.signalements.delaiMoyenJours === null ? '—' : `${ind.data.signalements.delaiMoyenJours} j`} sub={`Part confirmée : ${ind.data.signalements.partConfirmee ?? '—'}`} />
          <Kpi label="Alertes ouvertes" value={ind.data.alertes.ouvertes} sub={`${ind.data.alertes.classees} classées · ${ind.data.alertes.versDossier} en dossier`} />
          <Kpi label="Dossiers en cours" value={ind.data.dossiers.ouverts} sub={`${ind.data.dossiers.decides} décidés`} />
          <Kpi label="Délai d’instruction" value={ind.data.dossiers.delaiInstructionMoyenJours === null ? '—' : `${ind.data.dossiers.delaiInstructionMoyenJours} j`} sub="moyenne des dossiers décidés" />
        </div>
      )}
      <ExampleNotice text="Données de démonstration fictives : signalements, alertes et dossiers illustrent le circuit." />
      <Tabs label="Files de travail" value={tab} onChange={setTab} items={tabs} />

      {tab === 'reports' && (
        <section className="section" aria-label="Signalements">
          {reports.loading && <Loading />}
          {reports.error !== null && <ErrorState error={reports.error} onRetry={reports.reload} />}
          {reports.data && (
            <DataTable rows={reports.data} rowKey={(r) => r.id} caption="Signalements"
              empty={<EmptyState title="Aucun signalement" icon="megaphone" />}
              columns={[
                { key: 'ref', label: 'Référence', primary: true, render: (r) => <button type="button" className="btn-link ig-rowlink" onClick={() => setOpenReport(r.id)}>{r.reference}</button> },
                { key: 'cat', label: 'Nature', render: (r) => <span className="small">{r.categoryLabel}</span> },
                { key: 'ch', label: 'Canal', render: (r) => <span className="small">{CHANNEL_LABELS[r.channel] ?? r.channel}</span> },
                { key: 'com', label: 'Commune', render: (r) => <span className="small">{r.commune ?? '—'}</span> },
                { key: 'sev', label: 'Gravité', render: (r) => <SeverityBadge value={r.qualification?.severity} /> },
                { key: 'st', label: 'État', render: (r) => <span className="ig-inline"><StateBadge value={r.status} />{r.overdue && <span className="ig-late"><Icon name="clock" size={14} /> hors délai</span>}</span> },
                { key: 'age', label: 'Âge', num: true, render: (r) => <span className="mono small">{r.ageHours < 48 ? `${r.ageHours} h` : `${Math.floor(r.ageHours / 24)} j`}</span> },
              ]} />
          )}
        </section>
      )}

      {tab === 'alerts' && (
        <section className="section" aria-label="Alertes">
          {alerts.loading && <Loading />}
          {alerts.error !== null && <ErrorState error={alerts.error} onRetry={alerts.reload} />}
          {alerts.data && (
            <DataTable rows={alerts.data} rowKey={(a) => a.id} caption="Alertes"
              empty={<EmptyState title="Aucune alerte" icon="shieldCheck" />}
              columns={[
                { key: 'id', label: 'Alerte', primary: true, render: (a) => <><button type="button" className="btn-link ig-rowlink" onClick={() => setOpenAlert(a.id)}>{a.ruleLabel}</button><span className="account-code">{a.id}</span></> },
                { key: 'sub', label: 'Objet', render: (a) => <span className="small">{a.subjects.map((s) => `${s.kind} ${s.ref}`).join(', ')}</span> },
                { key: 'sev', label: 'Gravité', render: (a) => <SeverityBadge value={a.severity} /> },
                { key: 'conf', label: 'Confiance', render: (a) => <span className="small">{a.confidence.toLowerCase()}</span> },
                { key: 'st', label: 'État', render: (a) => <StateBadge value={a.status} /> },
              ]} />
          )}
        </section>
      )}

      {tab === 'cases' && (
        <section className="section" aria-label="Dossiers">
          {cases.loading && <Loading />}
          {cases.error !== null && <ErrorState error={cases.error} onRetry={cases.reload} />}
          {cases.data && (
            <DataTable rows={cases.data} rowKey={(c) => c.id} caption="Dossiers d’enquête"
              empty={<EmptyState title="Aucun dossier" icon="file" />}
              columns={[
                { key: 'id', label: 'Dossier', primary: true, render: (c) => <><button type="button" className="btn-link ig-rowlink" onClick={() => setOpenCase(c.id)}>{c.title}</button><span className="account-code">{c.id}</span></> },
                { key: 'inv', label: 'Enquêteur', render: (c) => <span className="mono small">{c.investigatorId}</span> },
                { key: 'pc', label: 'Pièces', num: true, render: (c) => <span className="mono">{c.evidence}</span> },
                { key: 'st', label: 'État', render: (c) => <StateBadge value={c.status} /> },
                { key: 'age', label: 'Âge', num: true, render: (c) => <span className="mono small">{c.ageDays} j</span> },
              ]} />
          )}
        </section>
      )}

      <Drawer open={!!openReport} title="Signalement" onClose={() => setOpenReport(null)}>
        {openReport && <ReportDetail id={openReport} onChanged={reloadAll} onOpenCase={(id) => { setOpenReport(null); setTab('cases'); setOpenCase(id); }} />}
      </Drawer>
      <Drawer open={!!openAlert} title="Alerte" onClose={() => setOpenAlert(null)}>
        {openAlert && <AlertDetail id={openAlert} rows={alerts.data ?? []} onChanged={reloadAll} onOpenCase={(id) => { setOpenAlert(null); setTab('cases'); setOpenCase(id); }} />}
      </Drawer>
      <Drawer open={!!openCase} title="Dossier d’enquête" onClose={() => setOpenCase(null)}>
        {openCase && <CaseDetailView id={openCase} onChanged={reloadAll} />}
      </Drawer>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ReportDetail({ id, onChanged, onOpenCase }: { id: string; onChanged: () => void; onOpenCase: (id: string) => void }) {
  const { user, users, fmtDate } = useApp();
  const r = useApi(() => api<ReportRow>(`/v1/integrite/reports/${id}`), [id, user?.id]);
  const a = useAction();
  const [category, setCategory] = useState('');
  const [severity, setSeverity] = useState('MOYENNE');
  const [note, setNote] = useState('');
  const [investigator, setInvestigator] = useState('');
  const [withCase, setWithCase] = useState(true);
  const [message, setMessage] = useState('');
  const [outcome, setOutcome] = useState('FONDE');
  const [reason, setReason] = useState('');
  const [pub, setPub] = useState('');
  const investigators = useMemo(() => (users ?? []).filter((u) => u.roles.includes('R24')), [users]);
  const isInv = hasRole(user?.roles, 'R24');

  const act = async (path: string, body: unknown) => {
    const res = await a.run(() => api<{ case?: { id: string } | null }>(`/v1/integrite/reports/${id}/${path}`, { method: 'POST', body }));
    if (res) { r.reload(); onChanged(); }
    return res;
  };

  if (r.loading) return <Loading />;
  if (r.error !== null) return <ErrorState error={r.error} onRetry={r.reload} />;
  const d = r.data!;
  return (
    <div className="ig-stack">
      <div className="panel-head">
        <div><p className="row-title">{d.reference}</p><p className="panel-sub">{d.categoryLabel}</p></div>
        <StateBadge value={d.status} />
      </div>
      <div className="callout callout-info"><Icon name="lock" size={18} /><span>{d.reporterContactLabel}. L’identité du signalant n’est jamais affichée ; les personnes mises en cause n’ont aucun accès.</span></div>
      <dl className="kv kv-dense">
        <div><dt>Canal</dt><dd>{CHANNEL_LABELS[d.channel] ?? d.channel}</dd></div>
        <div><dt>Reçu le</dt><dd>{fmtDate(d.receivedAt, true)}</dd></div>
        <div><dt>Lieu</dt><dd>{[d.commune, d.place].filter(Boolean).join(' · ') || '—'}</dd></div>
        <div><dt>Date des faits</dt><dd>{d.occurredOn ?? '—'}</dd></div>
        <div><dt>Visé</dt><dd>{d.target ? `${d.target.kind}${d.target.reference ? ` · ${d.target.reference}` : ''}` : '—'}</dd></div>
        <div><dt>Qualification avant</dt><dd>{fmtDate(d.qualifyBy, true)}</dd></div>
        {d.treatBy && <div><dt>Traitement avant</dt><dd>{fmtDate(d.treatBy, true)}{d.overdue && <span className="ig-late"> · hors délai</span>}</dd></div>}
        {d.investigatorId && <div><dt>Enquêteur</dt><dd className="mono">{d.investigatorId}</dd></div>}
        {d.caseId && <div><dt>Dossier</dt><dd><button type="button" className="btn-link" onClick={() => onOpenCase(d.caseId!)}>{d.caseId}</button></dd></div>}
      </dl>
      <div><h3 className="ig-h3">Faits rapportés</h3><p className="ig-quote">{d.description}</p></div>
      {d.evidence.length > 0 && (
        <div><h3 className="ig-h3">Pièces (empreintes)</h3>
          <ul className="ig-evidence-list">{d.evidence.map((e) => <li key={e.id}><Icon name="file" size={16} /><span className="truncate">{e.label}</span><span className="mono small muted">{e.sha256.slice(0, 16)}…</span></li>)}</ul>
        </div>
      )}
      <div><h3 className="ig-h3">Échanges avec le signalant</h3>
        <ul className="ig-thread">{d.messages.map((m, i) => <li key={i} className={m.from === 'SIGNALANT' ? 'them' : ''}><span className="small muted">{m.from === 'SIGNALANT' ? 'Signalant' : 'Ligne'} · {fmtDate(m.at, true)}</span><p>{m.text}</p></li>)}</ul>
      </div>
      <ActionError error={a.error} />

      {isInv && d.status === 'RECU' && (
        <fieldset className="line-box">
          <legend className="label">Qualifier</legend>
          <div className="field-row">
            <div className="field"><label className="label" htmlFor="q-cat">Nature</label>
              <select id="q-cat" value={category || d.category} onChange={(e) => setCategory(e.target.value)}>{Object.entries(CATEGORY_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div className="field"><label className="label" htmlFor="q-sev">Gravité</label>
              <select id="q-sev" value={severity} onChange={(e) => setSeverity(e.target.value)}>{Object.entries(SEVERITY_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          </div>
          <div className="field"><label className="label" htmlFor="q-note">Motif de qualification</label><textarea id="q-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></div>
          <div className="btn-row">
            <button type="button" className="btn btn-primary btn-sm" disabled={a.busy || note.trim().length < 5} onClick={() => void act('qualify', { category: category || d.category, severity, receivable: true, note })}>Retenir</button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy || note.trim().length < 5} onClick={() => void act('qualify', { category: category || d.category, severity, receivable: false, note })}>Déclarer irrecevable</button>
          </div>
        </fieldset>
      )}

      {isInv && (d.status === 'QUALIFIE') && (
        <fieldset className="line-box">
          <legend className="label">Transmettre à un enquêteur</legend>
          <div className="field"><label className="label" htmlFor="q-inv">Enquêteur</label>
            <select id="q-inv" value={investigator} onChange={(e) => setInvestigator(e.target.value)}>
              <option value="">Choisir…</option>
              {investigators.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select></div>
          <label className="check"><input type="checkbox" checked={withCase} onChange={(e) => setWithCase(e.target.checked)} /><span>Ouvrir un dossier d’enquête</span></label>
          <button type="button" className="btn btn-primary btn-sm" disabled={a.busy || !investigator} onClick={async () => {
            const res = await act('assign', { investigatorId: investigator, openCase: withCase });
            if (res?.case?.id) onOpenCase(res.case.id);
          }}><Icon name="send" size={16} /> Transmettre</button>
        </fieldset>
      )}

      {isInv && d.status !== 'CLOS' && (
        <fieldset className="line-box">
          <legend className="label">Informer le signalant</legend>
          <p className="hint">Visible par le signalant avec son code. Ne mentionnez aucune personne ni élément d’enquête.</p>
          <textarea aria-label="Message au signalant" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} />
          <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy || message.trim().length < 5} onClick={async () => { if (await act('messages', { text: message })) setMessage(''); }}>Envoyer</button>
        </fieldset>
      )}

      {isInv && (d.status === 'TRANSMIS' || d.status === 'QUALIFIE') && (
        <fieldset className="line-box">
          <legend className="label">Clore le signalement</legend>
          <div className="field"><label className="label" htmlFor="c-out">Issue</label>
            <select id="c-out" value={outcome} onChange={(e) => setOutcome(e.target.value)}>{Object.entries(FINDING_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          <div className="field"><label className="label" htmlFor="c-reason">Motif interne</label><textarea id="c-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div className="field"><label className="label" htmlFor="c-pub">Message au signalant</label><textarea id="c-pub" rows={2} value={pub} onChange={(e) => setPub(e.target.value)} /></div>
          <button type="button" className="btn btn-primary btn-sm" disabled={a.busy || reason.trim().length < 10 || pub.trim().length < 10} onClick={() => void act('close', { outcome, reason, publicMessage: pub })}>Clore</button>
        </fieldset>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function AlertDetail({ id, rows, onChanged, onOpenCase }: { id: string; rows: AlertRow[]; onChanged: () => void; onOpenCase: (id: string) => void }) {
  const { user, fmtDate } = useApp();
  const d = rows.find((x) => x.id === id);
  const a = useAction();
  const [reason, setReason] = useState('');
  const [title, setTitle] = useState(d ? d.ruleLabel : '');
  if (!d) return <EmptyState title="Alerte introuvable" />;
  const isInv = hasRole(user?.roles, 'R24');
  const canValidate = hasRole(user?.roles, 'R24', 'R28') && d.status === 'CLOTURE_PROPOSEE' && d.closureProposal?.by !== user?.id && d.examinedBy !== user?.id;
  const post = async (path: string, body: unknown) => { const res = await a.run(() => api(`/v1/integrite/alerts/${id}/${path}`, { method: 'POST', body })); if (res) { setReason(''); onChanged(); } };
  const open = async () => {
    const c = await a.run(() => api<{ id: string }>('/v1/integrite/cases', { method: 'POST', body: { title, reason, alertIds: [id] } }));
    if (c) { onChanged(); onOpenCase(c.id); }
  };
  return (
    <div className="ig-stack">
      <div className="panel-head">
        <div><p className="row-title">{d.ruleLabel}</p><p className="panel-sub">{d.id} · {fmtDate(d.raisedAt, true)}</p></div>
        <span className="ig-inline"><SeverityBadge value={d.severity} /><StateBadge value={d.status} /></span>
      </div>
      <p>{d.explanation}</p>
      <div className="callout callout-info"><Icon name="info" size={18} /><span>Effet automatique : <strong>aucun</strong>. Une alerte est un signal à vérifier, jamais une preuve ni une sanction.</span></div>
      <h3 className="ig-h3">Variables et sources</h3>
      <dl className="kv kv-dense">{d.variables.map((v) => <div key={v.name}><dt>{v.name}</dt><dd>{v.value} <span className="small muted">· {v.source}</span></dd></div>)}<div><dt>Confiance</dt><dd>{d.confidence.toLowerCase()}</dd></div></dl>
      <h3 className="ig-h3">Historique</h3>
      <ul className="ig-history">{d.history.map((h, i) => <li key={i}><span className="mono small">{fmtDate(h.at, true)}</span> <span>{h.action.replace(/_/g, ' ').toLowerCase()}</span> <span className="small muted">{h.by}{h.note ? ` — ${h.note}` : ''}</span></li>)}</ul>
      <ActionError error={a.error} />
      {isInv && d.status === 'A_EXAMINER' && <button type="button" className="btn btn-primary btn-sm" disabled={a.busy} onClick={() => void post('examine', {})}>Prendre en charge</button>}
      {isInv && (d.status === 'A_EXAMINER' || d.status === 'EN_EXAMEN') && (
        <fieldset className="line-box">
          <legend className="label">Suite à donner</legend>
          <div className="field"><label className="label" htmlFor="al-reason">Motif</label><textarea id="al-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
          <div className="field"><label className="label" htmlFor="al-title">Intitulé du dossier (si ouverture)</label><input id="al-title" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="btn-row">
            <button type="button" className="btn btn-primary btn-sm" disabled={a.busy || reason.trim().length < 10 || title.trim().length < 5} onClick={() => void open()}><Icon name="file" size={16} /> Ouvrir un dossier</button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy || reason.trim().length < 10} onClick={() => void post('propose-closure', { reason })}>Proposer le classement</button>
          </div>
          <p className="hint">Le classement doit être validé par un responsable distinct.</p>
        </fieldset>
      )}
      {d.status === 'CLOTURE_PROPOSEE' && (
        <fieldset className="line-box">
          <legend className="label">Validation du classement</legend>
          <p className="small">Proposé par <span className="mono">{d.closureProposal?.by}</span> : {d.closureProposal?.reason}</p>
          {canValidate ? (
            <>
              <textarea aria-label="Motif de validation" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
              <div className="btn-row">
                <button type="button" className="btn btn-primary btn-sm" disabled={a.busy || reason.trim().length < 5} onClick={() => void post('validate-closure', { approve: true, reason })}>Valider le classement</button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy || reason.trim().length < 5} onClick={() => void post('validate-closure', { approve: false, reason })}>Refuser</button>
              </div>
            </>
          ) : <p className="hint">Validation réservée à un responsable distinct de l’enquêteur (séparation des tâches).</p>}
        </fieldset>
      )}
      {d.caseId && <button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpenCase(d.caseId!)}>Voir le dossier {d.caseId}</button>}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function CaseDetailView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { user, fmtDate } = useApp();
  const c = useApi(() => api<CaseDetail>(`/v1/integrite/cases/${id}`), [id, user?.id]);
  const a = useAction();
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [noteKind, setNoteKind] = useState<'NOTE' | 'DEMANDE_PIECES'>('NOTE');
  const [note, setNote] = useState('');
  const [finding, setFinding] = useState('FONDE');
  const [summary, setSummary] = useState('');
  const [reco, setReco] = useState('SAISINE_AUTORITE_COMPETENTE');
  const [decision, setDecision] = useState('SAISINE_AUTORITE_COMPETENTE');
  const [motif, setMotif] = useState('');

  const post = async (path: string, body: unknown) => {
    const res = await a.run(() => api<CaseDetail>(`/v1/integrite/cases/${id}/${path}`, { method: 'POST', body }));
    if (res) { c.setData(res); onChanged(); }
    return res;
  };
  if (c.loading) return <Loading />;
  if (c.error !== null) return <ErrorState error={c.error} onRetry={c.reload} />;
  const d = c.data!;
  const isInvestigator = user?.id === d.investigatorId && d.status !== 'DECIDE';
  const canDecide = hasRole(user?.roles, 'R06', 'R21') && d.status === 'CONCLUSIONS_DEPOSEES';
  const contributed = !!user && d.contributors.includes(user.id);

  return (
    <div className="ig-stack">
      <div className="panel-head">
        <div><p className="row-title">{d.title}</p><p className="panel-sub">{d.id} · ouvert le {fmtDate(d.openedAt)} · {d.ageDays} j</p></div>
        <StateBadge value={d.status} />
      </div>
      <dl className="kv kv-dense">
        <div><dt>Motif d’ouverture</dt><dd>{d.openingReason}</dd></div>
        <div><dt>Enquêteur</dt><dd className="mono">{d.investigatorId}</dd></div>
        {d.reports.length > 0 && <div><dt>Signalements</dt><dd>{d.reports.map((r) => `${r.reference} (${r.categoryLabel})`).join(', ')}</dd></div>}
        {d.alerts.length > 0 && <div><dt>Alertes</dt><dd>{d.alerts.map((x) => `${x.id} — ${x.ruleLabel}`).join(', ')}</dd></div>}
        {d.links.length > 0 && <div><dt>Liens</dt><dd>{d.links.map((l) => `${l.kind} ${l.ref}`).join(', ')}</dd></div>}
      </dl>

      <div><h3 className="ig-h3">Pièces par empreinte <span className="count">{d.evidence.length}</span></h3>
        {d.evidence.length === 0 ? <p className="small muted">Aucune pièce versée.</p> : (
          <ul className="ig-evidence-list">{d.evidence.map((e) => <li key={e.id}><Icon name="file" size={16} /><span className="truncate">{e.label}</span><span className="mono small muted" title={e.sha256}>{e.sha256.slice(0, 16)}…</span></li>)}</ul>
        )}
      </div>

      <div><h3 className="ig-h3">Chronologie</h3>
        <ol className="timeline">{d.timeline.map((e, i) => (
          <li key={i} className="done"><span className="timeline-dot"><Icon name={e.kind === 'DECISION' ? 'scale' : e.kind === 'PIECE' ? 'file' : 'check'} size={12} /></span>
            <div><p className="small"><strong>{e.kind.replace(/_/g, ' ').toLowerCase()}</strong> · <span className="muted">{fmtDate(e.at, true)} · {e.by}</span></p><p>{e.text}</p></div></li>
        ))}</ol>
      </div>

      {d.conclusions && (
        <div className="ig-conclusions"><h3 className="ig-h3">Conclusions de l’enquêteur</h3>
          <p><strong>{FINDING_LABELS[d.conclusions.finding] ?? d.conclusions.finding}</strong> — proposition : {DECISION_LABELS[d.conclusions.recommendation]}</p>
          <p className="small">{d.conclusions.summary}</p>
        </div>
      )}
      {d.decision && (
        <div className="callout callout-info"><Icon name="scale" size={18} /><div>
          <p><strong>Décision : {DECISION_LABELS[d.decision.decision]}</strong> — par <span className="mono">{d.decision.by}</span>, {fmtDate(d.decision.at, true)}</p>
          <p className="small">{d.decision.reason}</p><p className="small muted">{d.decision.execution}</p>
        </div></div>
      )}
      <ActionError error={a.error} />

      {isInvestigator && (
        <>
          <fieldset className="line-box"><legend className="label">Verser des pièces</legend>
            <EvidencePicker value={evidence} onChange={setEvidence} />
            <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy || evidence.length === 0} onClick={async () => {
              for (const e of evidence) if (!(await post('evidence', e))) return;
              setEvidence([]);
            }}>Verser au dossier</button>
          </fieldset>
          <fieldset className="line-box"><legend className="label">Note d’instruction</legend>
            <div className="seg seg-sm" role="group" aria-label="Type de note">
              <button type="button" aria-pressed={noteKind === 'NOTE'} onClick={() => setNoteKind('NOTE')}>Note</button>
              <button type="button" aria-pressed={noteKind === 'DEMANDE_PIECES'} onClick={() => setNoteKind('DEMANDE_PIECES')}>Demande de pièces</button>
            </div>
            <textarea aria-label="Texte de la note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy || note.trim().length < 5} onClick={async () => { if (await post('notes', { kind: noteKind, text: note })) setNote(''); }}>Ajouter</button>
          </fieldset>
          {d.status !== 'CONCLUSIONS_DEPOSEES' && (
            <fieldset className="line-box"><legend className="label">Déposer les conclusions</legend>
              <div className="field-row">
                <div className="field"><label className="label" htmlFor="cc-f">Constat</label><select id="cc-f" value={finding} onChange={(e) => setFinding(e.target.value)}>{Object.entries(FINDING_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
                <div className="field"><label className="label" htmlFor="cc-r">Suite proposée</label><select id="cc-r" value={reco} onChange={(e) => setReco(e.target.value)}>{Object.entries(DECISION_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
              </div>
              <textarea aria-label="Synthèse" rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Synthèse des éléments établis (20 caractères au moins)" />
              <button type="button" className="btn btn-primary btn-sm" disabled={a.busy || summary.trim().length < 20} onClick={() => void post('conclusions', { finding, summary, recommendation: reco })}>Déposer</button>
              <p className="hint">L’enquêteur propose ; la décision revient à une autorité distincte.</p>
            </fieldset>
          )}
        </>
      )}

      {canDecide && (
        <fieldset className="line-box"><legend className="label">Décision motivée</legend>
          {contributed ? <p className="callout callout-warn"><Icon name="alert" size={18} /><span>Vous avez contribué à ce dossier : la décision revient à une autre personne.</span></p> : (
            <>
              <select aria-label="Décision" value={decision} onChange={(e) => setDecision(e.target.value)}>{Object.entries(DECISION_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <textarea aria-label="Motif de la décision" rows={3} value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Motif (20 caractères au moins)" />
              <button type="button" className="btn btn-primary btn-sm" disabled={a.busy || motif.trim().length < 20} onClick={() => void post('decision', { decision, reason: motif })}><Icon name="scale" size={16} /> Décider</button>
              <p className="hint">La décision n’a aucun effet automatique : son exécution relève de l’autorité compétente.</p>
            </>
          )}
        </fieldset>
      )}

      <details className="ig-details"><summary>Traçabilité (journal d’audit chaîné)</summary>
        <ul className="ig-history">{d.auditTrail.map((e, i) => <li key={i}><span className="mono small">{fmtDate(e.at, true)}</span> <span className="small">{e.action}</span> <span className="small muted">{e.actor}</span> <span className="mono small muted">{e.hash.slice(0, 10)}…</span></li>)}</ul>
      </details>
    </div>
  );
}
