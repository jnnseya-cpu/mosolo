import { useEffect, useState, type FormEvent } from 'react';
import { CURRENCIES, formatMoney, isCurrencyCode, type MoneyJSON } from '@mosolo/shared';
import { useApp } from '../context';
import { useApi } from '../hooks/useApi';
import { useAutosave } from '../hooks/useAutosave';
import { useInsight } from '../hooks/useInsight';
import TresorWorkbench from '../modules/tresor/TresorWorkbench';
import { PageHead } from '../components/Shell';
import { AIInsightPanel } from '../components/AIInsightPanel';
import { MoneyText } from '../components/MoneyText';
import { StatusBadge, type Tone } from '../components/StatusBadge';
import { AutosaveBar } from '../components/VersionHistory';
import { EmptyState, ErrorState, Loading } from '../components/States';
import { Icon } from '../components/Icon';
import { api, describeError, safeGet, safeSet } from '../lib/api';
import type { UIKey } from '../lib/i18n';
import { ledgerLabel } from '../lib/labels';
import type { ReconciliationException, VaultChangeRequest } from '../lib/types';

interface Balance {
  balanced: boolean; entries?: number;
  byCurrency?: { currency: string; debit: MoneyJSON; credit: MoneyJSON; balanced: boolean }[];
  accounts?: { account: string; label?: string; currency: string; balance: MoneyJSON }[];
  headHash?: string | null;
}
interface Line { accountAlias: string; amount: string; currency: string; valueDate: string; paymentReference: string }
interface StatementDraft { statementId: string; lines: Line[] }
interface StatementResult { statementId?: string; lines?: number; matched?: { paymentReference: string; receiptNumber?: string }[]; exceptions?: ReconciliationException[] }

const today = () => new Date().toISOString().slice(0, 10);
const newLine = (): Line => ({ accountAlias: 'KIN-DGIPK-RECETTES-01', amount: '', currency: 'USD', valueDate: today(), paymentReference: '' });
/** Solde présenté en valeur absolue avec sa nature (jamais de montant négatif affiché). */
const absMoney = (m: MoneyJSON): MoneyJSON => ({ ...m, amount: m.amount.replace(/^-/, '') });
const natureKey = (m: MoneyJSON) => (/^-/.test(m.amount) ? 'ledger.creditor' : /^0+(\.0+)?$/.test(m.amount) ? 'ledger.nil' : 'ledger.debtor') as 'ledger.creditor';
const VAULT_KEY = 'mosolo.vaultRequests';
const VAULT_TONE: Record<string, Tone> = { EN_ATTENTE_APPROBATION: 'warning', EN_REFROIDISSEMENT: 'info', EFFECTIF: 'good' };

function Countdown({ until }: { until: string }) {
  const { tr } = useApp();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(i); }, []);
  const ms = new Date(until).getTime() - now;
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return <span className="small">{tr('vault.coolingOver')}</span>;
  const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4), s = Math.floor((ms % 6e4) / 1000);
  return <span className="countdown mono" role="timer" aria-label={tr('vault.coolingLeft')}>{String(h).padStart(2, '0')} h {String(m).padStart(2, '0')} min {String(s).padStart(2, '0')} s</span>;
}

function readVault(): VaultChangeRequest[] {
  try { return JSON.parse(safeGet(VAULT_KEY) ?? '[]') as VaultChangeRequest[]; } catch { return []; }
}

function Vault() {
  const { tr, fmtDate } = useApp();
  const [list, setList] = useState<VaultChangeRequest[]>(readVault);
  const [form, setForm] = useState({ alias: 'KIN-DGIPK-RECETTES-01', bankName: '', accountNumber: '', holderName: '', reason: '' });
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = (l: VaultChangeRequest[]) => { setList(l); safeSet(VAULT_KEY, JSON.stringify(l)); };
  // Liste serveur (GET /v1/beneficiary-accounts → changeRequests) fusionnée avec les demandes de la session
  useEffect(() => {
    api<{ changeRequests?: VaultChangeRequest[] }>('/v1/beneficiary-accounts')
      .then((v) => {
        const server = v?.changeRequests ?? [];
        if (!server.length) return;
        setList((prev) => {
          const merged = [...server, ...prev.filter((p) => !server.some((x) => x.id === p.id))];
          safeSet(VAULT_KEY, JSON.stringify(merged));
          return merged;
        });
      })
      .catch(() => { /* hors ligne ou non habilité : liste locale */ });
  }, []);
  const upsert = (r: VaultChangeRequest) => save([r, ...list.filter((x) => x.id !== r.id)]);

  async function propose(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      const r = await api<VaultChangeRequest>('/v1/beneficiary-accounts/change-requests', { method: 'POST', body: form });
      upsert(r); setMsg({ ok: true, text: tr('vault.proposed') });
    } catch (x) { setMsg({ ok: false, text: describeError(x).message }); } finally { setBusy(false); }
  }
  async function approve(id: string) {
    setMsg(null);
    try {
      const r = await api<VaultChangeRequest>(`/v1/beneficiary-accounts/change-requests/${encodeURIComponent(id)}/approve`, { method: 'POST', body: { outOfBandVerified: true } });
      upsert(r); setMsg({ ok: true, text: tr('vault.approved') });
    } catch (x) { const d = describeError(x); setMsg({ ok: false, text: d.message + (d.code ? ` (${d.code})` : '') }); }
  }
  const f = (k: keyof typeof form, label: UIKey, mono = false) => (
    <div className="field">
      <label className="label" htmlFor={`v-${k}`}>{tr(label)}</label>
      <input id={`v-${k}`} className={mono ? 'mono' : undefined} value={form[k]} onChange={(e) => setForm((p) => ({ ...p, [k]: e.target.value }))} required />
    </div>
  );
  return (
    <section className="panel" aria-labelledby="vault-title">
      <header className="panel-head"><div><h2 className="panel-title" id="vault-title">{tr('vault.title')}</h2><p className="panel-sub">{tr('vault.sub')}</p></div></header>
      <div className="callout callout-warn"><Icon name="lock" size={18} /><p>{tr('vault.rules')}</p></div>
      <div className="two-col">
        <form className="form" onSubmit={(e) => void propose(e)}>
          <h3 className="h-sub">{tr('vault.propose')}</h3>
          {f('alias', 'vault.alias', true)}
          <div className="field-row">{f('bankName', 'vault.bank')}{f('holderName', 'vault.holder')}</div>
          {f('accountNumber', 'vault.account', true)}
          {f('reason', 'vault.reason')}
          <button type="submit" className="btn btn-secondary" disabled={busy}>{tr('vault.submit')}</button>
        </form>
        <div>
          <h3 className="h-sub">{tr('vault.requests')}</h3>
          {list.length === 0 ? <EmptyState title={tr('vault.none')} /> : (
            <ul className="list-rows">
              {list.map((r) => (
                <li key={r.id} className="list-row list-row-stack">
                  <div className="row-between">
                    <span className="mono row-title">{r.alias}</span>
                    <StatusBadge tone={VAULT_TONE[r.status] ?? 'neutral'} label={tr(`vault.status.${r.status}` as UIKey)} />
                  </div>
                  <p className="small muted">{r.proposed?.bankName} · {r.proposed?.accountNumber} · {tr('vault.approvalsCount', { n: r.approvals?.length ?? 0 })} · {fmtDate(r.requestedAt, true)}</p>
                  {r.status === 'EN_REFROIDISSEMENT' && r.coolingEndsAt && <p className="small">{tr('vault.cooling')} <Countdown until={r.coolingEndsAt} /></p>}
                  {r.status === 'EN_ATTENTE_APPROBATION' && (
                    <div className="row-actions">
                      <label className="check">
                        <input type="checkbox" checked={!!checked[r.id]} onChange={(e) => setChecked((p) => ({ ...p, [r.id]: e.target.checked }))} />
                        <span>{tr('vault.oob')}</span>
                      </label>
                      <button type="button" className="btn btn-primary btn-sm" disabled={!checked[r.id]} onClick={() => void approve(r.id)}>{tr('vault.approve')}</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'notice notice-ok' : 'notice notice-err'}>{msg.text}</p>}
    </section>
  );
}

function StatementForm({ onImported }: { onImported: () => void }) {
  const { tr } = useApp();
  const draft = useAutosave<StatementDraft>('treasury-statement', { statementId: `REL-${today()}-01`, lines: [newLine()] });
  const v = draft.value;
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<StatementResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const setLine = (i: number, k: keyof Line, val: string) => draft.setValue((p) => ({ ...p, lines: p.lines.map((l, j) => (j === i ? { ...l, [k]: val } : l)) }));
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null); setRes(null);
    try {
      const body = {
        statementId: v.statementId,
        lines: v.lines.map((l) => ({ accountAlias: l.accountAlias, amount: { amount: l.amount, currency: l.currency }, valueDate: l.valueDate, paymentReference: l.paymentReference })),
      };
      setRes(await api<StatementResult>('/v1/settlements/statements', { method: 'POST', body }));
      onImported();
    } catch (x) { setErr(describeError(x).message); } finally { setBusy(false); }
  }
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <div className="field">
        <label className="label" htmlFor="st-id">{tr('treasury.statementId')}</label>
        <input id="st-id" className="mono" value={v.statementId} onChange={(e) => draft.setValue((p) => ({ ...p, statementId: e.target.value }))} />
      </div>
      {v.lines.map((l, i) => (
        <fieldset key={i} className="line-box">
          <legend className="label">{tr('treasury.line', { n: i + 1 })}</legend>
          <div className="field-row">
            <div className="field"><label className="label" htmlFor={`l${i}-ref`}>{tr('payment.reference')}</label><input id={`l${i}-ref`} className="mono" value={l.paymentReference} onChange={(e) => setLine(i, 'paymentReference', e.target.value)} /></div>
            <div className="field"><label className="label" htmlFor={`l${i}-alias`}>{tr('vault.alias')}</label><input id={`l${i}-alias`} className="mono" value={l.accountAlias} onChange={(e) => setLine(i, 'accountAlias', e.target.value)} /></div>
          </div>
          <div className="field-row field-row-3">
            <div className="field"><label className="label" htmlFor={`l${i}-amt`}>{tr('explain.amount')}</label><input id={`l${i}-amt`} inputMode="decimal" className="mono" value={l.amount} onChange={(e) => setLine(i, 'amount', e.target.value.replace(',', '.'))} placeholder="450.00" /></div>
            <div className="field"><label className="label" htmlFor={`l${i}-cur`}>{tr('rules.f.currency')}</label>
              <select id={`l${i}-cur`} value={l.currency} onChange={(e) => isCurrencyCode(e.target.value) && setLine(i, 'currency', e.target.value)}>
                {['CDF', 'USD'].map((c) => <option key={c} value={c}>{CURRENCIES[c as 'CDF'].flag} {c}</option>)}
              </select></div>
            <div className="field"><label className="label" htmlFor={`l${i}-date`}>{tr('treasury.valueDate')}</label><input id={`l${i}-date`} type="date" value={l.valueDate} onChange={(e) => setLine(i, 'valueDate', e.target.value)} /></div>
          </div>
          {v.lines.length > 1 && <button type="button" className="btn-link" onClick={() => draft.setValue((p) => ({ ...p, lines: p.lines.filter((_, j) => j !== i) }))}>{tr('treasury.removeLine')}</button>}
        </fieldset>
      ))}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => draft.setValue((p) => ({ ...p, lines: [...p.lines, newLine()] }))}>+ {tr('treasury.addLine')}</button>
      <AutosaveBar draft={draft} />
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      {res && (
        <div className="result-card" role="status">
          <p>{tr('treasury.imported', { matched: res.matched?.length ?? 0, exceptions: res.exceptions?.length ?? 0 })}</p>
        </div>
      )}
      <button type="submit" className="btn btn-primary" disabled={busy}>{tr('treasury.import')}</button>
    </form>
  );
}

export default function Treasury() {
  const { tr, user, lang } = useApp();
  const [tick, setTick] = useState(0);
  const bal = useApi(() => api<Balance>('/v1/ledger/balance'), [user?.id]);
  const ai = useInsight('treasury', [user?.id]);
  const loc = lang === 'en' ? 'en' : 'fr';
  return (
    <div className="page page-wide">
      <PageHead eyebrow={tr('treasury.eyebrow')} title={tr('nav.treasury')} lead={tr('treasury.lead')} />
      <div className="dash-grid">
        <section className="panel span-5" aria-labelledby="bal-title">
          <header className="panel-head"><h2 className="panel-title" id="bal-title">{tr('treasury.balance')}</h2>
            {bal.data && <StatusBadge tone={bal.data.balanced ? 'good' : 'critical'} label={tr(bal.data.balanced ? 'treasury.balanced' : 'treasury.unbalanced')} />}</header>
          {bal.loading && <Loading />}
          {bal.error !== null && <ErrorState error={bal.error} onRetry={bal.reload} />}
          {bal.data && (
            <>
              <table className="data-table compact">
                <thead><tr><th scope="col">{tr('rules.f.currency')}</th><th scope="col" className="num">{tr('treasury.debit')}</th><th scope="col" className="num">{tr('treasury.credit')}</th></tr></thead>
                <tbody>
                  {(bal.data.byCurrency ?? []).map((c) => (
                    <tr key={c.currency}><th scope="row">{c.currency}</th><td className="num">{formatMoney(c.debit, { locale: loc })}</td><td className="num">{formatMoney(c.credit, { locale: loc })}</td></tr>
                  ))}
                </tbody>
              </table>
              <p className="small muted">{tr('treasury.entries', { n: bal.data.entries ?? 0 })}{bal.data.headHash ? ` · ${tr('treasury.head')} ${bal.data.headHash.slice(0, 12)}…` : ''}</p>
              {(bal.data.accounts?.length ?? 0) > 0 && (
                <ul className="list-rows compact-rows">
                  {bal.data.accounts!.map((a) => (
                    <li key={`${a.account}-${a.currency}`} className="list-row"><div className="min0"><p className="row-title">{ledgerLabel(lang, a.account) === a.account && a.label ? a.label : ledgerLabel(lang, a.account)}</p><span className="account-code">{a.account}</span></div><div className="row-side"><MoneyText money={absMoney(a.balance)} showIndicative={false} /><span className="nature">{tr(natureKey(a.balance))}</span></div></li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>

        <section className="panel span-7" aria-labelledby="st-title">
          <header className="panel-head"><div><h2 className="panel-title" id="st-title">{tr('treasury.statement')}</h2><p className="panel-sub">{tr('treasury.statementSub')}</p></div></header>
          <StatementForm onImported={() => { bal.reload(); setTick((n) => n + 1); }} />
        </section>
        <div className="span-12"><TresorWorkbench key={tick} onChanged={bal.reload} /></div>

        <div className="span-12"><AIInsightPanel rec={ai.rec} loading={ai.loading} error={ai.error} onRefresh={ai.reload} compact /></div>
        <div className="span-12"><Vault /></div>
      </div>
    </div>
  );
}
