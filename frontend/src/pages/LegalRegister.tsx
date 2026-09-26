import { useState, type FormEvent, type ReactNode } from 'react';
import { REQUIRED_APPROVALS, SAMPLE_RULES, CURRENCIES, type Approval, type RuleSheet } from '@mosolo/shared';
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
import { api, asList, describeError, NetworkError } from '../lib/api';
import type { UIKey } from '../lib/i18n';

type Rule = RuleSheet & { sample?: boolean; demo?: boolean; createdAt?: string; publishedAt?: string; activatedAt?: string };

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

function RuleDetail({ rule, onChanged }: { rule: Rule; onChanged: () => void }) {
  const { tr, fmtDate } = useApp();
  const rows: [UIKey, ReactNode][] = [
    ['rules.f.code', <span className="mono">{rule.code} · v{rule.version}</span>],
    ['rules.f.category', rule.revenueCategory],
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
    ['rules.f.periodicity', rule.periodicity],
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
      <dl className="kv kv-dense">{rows.map(([k, v]) => <div key={k}><dt>{tr(k)}</dt><dd>{v}</dd></div>)}</dl>
      <h3 className="h-sub">{tr('rules.approvals')}</h3>
      <ApprovalTimeline rule={rule} onDone={onChanged} />
    </div>
  );
}

interface NewRule {
  code: string; label: string; revenueCategory: string; legalInstrumentIds: string; articles: string; competentAuthority: string;
  administeringEntity: string; taxableEvent: string; liableParty: string; baseDefinition: string; formula: string; rateTable: string;
  currency: string; rounding: string; periodicity: string; dueRule: string; effectiveFrom: string; beneficiaryAccountAlias: string;
  appealPath: string; sourceVerification: string; changeReason: string;
}
const EMPTY: NewRule = {
  code: '', label: '', revenueCategory: 'IMPOT_PROVINCIAL', legalInstrumentIds: '', articles: '', competentAuthority: 'Ministère provincial des Finances',
  administeringEntity: 'DGIPK', taxableEvent: '', liableParty: '', baseDefinition: '', formula: '', rateTable: '', currency: 'CDF', rounding: 'HALF_UP',
  periodicity: 'ANNUELLE', dueRule: '', effectiveFrom: '', beneficiaryAccountAlias: 'KIN-DGIPK-RECETTES-01', appealPath: '', sourceVerification: 'AUCUNE', changeReason: '',
};

function NewRuleForm({ onCreated }: { onCreated: () => void }) {
  const { tr } = useApp();
  const draft = useAutosave<NewRule>('legal-rule-new', EMPTY);
  const v = draft.value;
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
        body: {
          ...v, legalInstrumentIds: split(v.legalInstrumentIds), articles: split(v.articles), rateTable, exemptions: [], penalties: [],
          changeReason: v.changeReason || undefined,
        },
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
            {['IMPOT_PROVINCIAL', 'INTERET_COMMUN', 'PROVINCIAL_SPECIFIQUE', 'RECETTE_ETD', 'DROIT_ADMINISTRATIF', 'REDEVANCE_SERVICE', 'PENALITE', 'CONCESSION_DOMANIALE'].map((c) => <option key={c}>{c}</option>)}
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
      {text('baseDefinition', 'rules.f.base')}
      {text('formula', 'rules.f.formula', { mono: true, hint: 'rules.hint.formula' })}
      {text('rateTable', 'rules.f.rates', { mono: true, area: true, hint: 'rules.hint.rates' })}
      <div className="field-row">
        <div className="field">
          <label className="label" htmlFor="nr-per">{tr('rules.f.periodicity')}</label>
          <select id="nr-per" value={v.periodicity} onChange={set('periodicity')}>{['ANNUELLE', 'MENSUELLE', 'PONCTUELLE'].map((c) => <option key={c}>{c}</option>)}</select>
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
      <AutosaveBar draft={draft} />
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'notice notice-ok' : 'notice notice-err'}>{msg.text}</p>}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{tr('rules.create')}</button>
    </form>
  );
}

export default function LegalRegister() {
  const { tr, user } = useApp();
  const q = useApi(loadRules, [user?.id]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const rules = q.data?.rules ?? [];
  const open = rules.find((r) => r.id === openId) ?? null;
  return (
    <div className="page">
      <PageHead eyebrow={tr('rules.eyebrow')} title={tr('rules.title')} lead={tr('rules.lead')}>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="file" size={18} /> {tr('rules.new')}</button>
      </PageHead>
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data?.fallback && <ExampleNotice text={tr('rules.fallback')} />}
      {q.data && (
        <DataTable
          caption={tr('rules.title')}
          rows={rules}
          rowKey={(r) => r.id}
          columns={[
            { key: 'code', label: tr('rules.f.code'), primary: true, render: (r) => <><span className="mono">{r.code}</span> <span className="muted small">v{r.version}</span></> },
            { key: 'label', label: tr('rules.f.label'), render: (r) => r.label },
            { key: 'cur', label: tr('rules.f.currency'), render: (r) => `${CURRENCIES[r.currency]?.flag ?? ''} ${r.currency}` },
            { key: 'status', label: tr('space.col.status'), render: (r) => <RuleStatusBadge status={r.status} /> },
            { key: 'appr', label: tr('rules.approvals'), num: true, render: (r) => `${r.approvals.length} / 4` },
            { key: 'act', label: tr('space.col.actions'), render: (r) => <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpenId(r.id)}>{tr('rules.open')} <Icon name="chevronRight" size={16} /></button> },
          ]}
        />
      )}
      <Drawer open={!!open} title={open ? `${open.code} — ${open.label}` : ''} onClose={() => setOpenId(null)}>
        {open && <RuleDetail rule={open} onChanged={q.reload} />}
      </Drawer>
      <Drawer open={creating} title={tr('rules.new')} onClose={() => setCreating(false)}>
        <NewRuleForm onCreated={() => { q.reload(); }} />
      </Drawer>
    </div>
  );
}
