import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { DataTable } from '../../components/DataTable';
import { MoneyText } from '../../components/MoneyText';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { API_URL, api, authHeaders, describeError } from '../../lib/api';
import { hasRole, Message, shortHash, useAction, type Closures } from './shared';

interface Accounting {
  rows: { paymentReference: string; paymentStatus: string; amount: MoneyJSON; receiptNumber: string | null; state: 'RAPPROCHE' | 'COMPTABILISE'; code: string | null; demoCode: boolean | null; dayClosed: boolean }[];
  counts: { rapproche: number; comptabilise: number };
}
interface Nomenclature { version: number; entries: { revenueCategory: string; code: string; label: string; demo: boolean; version: number }[]; notice: string }

function ClosureBlock({ onChanged }: { onChanged?: () => void }) {
  const { user, fmtDate } = useApp();
  const c = useApi(() => api<Closures>('/v1/tresor/closures'), [user?.id]);
  const { busy, msg, run } = useAction();
  const [date, setDate] = useState('');
  const canWrite = hasRole(user?.roles, 'R17');
  const refresh = () => { c.reload(); onChanged?.(); };
  const day = date || c.data?.today || '';
  return (
    <section className="panel" aria-labelledby="clo-title">
      <header className="panel-head">
        <div><h2 className="panel-title" id="clo-title">Clôtures</h2>
          <p className="panel-sub">Clôture quotidienne signée (empreinte chaînée à la précédente) et clôture mensuelle du comptable public.</p></div>
        {c.data && <StatusBadge tone={c.data.chain.valid ? 'good' : 'critical'} label={c.data.chain.valid ? 'Chaîne intègre' : `Chaîne rompue (${c.data.chain.brokenAt})`} />}
      </header>
      {c.loading && <Loading />}
      {c.error !== null && <ErrorState error={c.error} onRetry={c.reload} />}
      {c.data && (
        <>
          <dl className="kv kv-dense">
            <div><dt>Dernière journée clôturée</dt><dd>{c.data.lastClosedDate ? fmtDate(c.data.lastClosedDate) : 'Aucune'}</dd></div>
            <div><dt>Écritures non clôturées</dt><dd>{c.data.unclosedEntries}{c.data.oldestUnclosedDate ? ` (depuis le ${fmtDate(c.data.oldestUnclosedDate)})` : ''}</dd></div>
          </dl>
          {canWrite && (
            <div className="row-actions tr-step">
              <label className="sr-only" htmlFor="clo-date">Journée à clôturer</label>
              <input id="clo-date" type="date" value={day} max={c.data.today} onChange={(e) => setDate(e.target.value)} />
              <button type="button" className="btn btn-primary btn-sm" disabled={busy || !day} onClick={() => void run('/v1/tresor/closures/daily', { date: day }, `Journée du ${day} clôturée et signée.`, refresh)}>
                <Icon name="lock" size={16} /> Clôturer la journée
              </button>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !day} onClick={() => void run('/v1/tresor/closures/monthly', { month: day.slice(0, 7) }, `Mois ${day.slice(0, 7)} clôturé.`, refresh)}>
                Clôturer le mois {day.slice(0, 7)}
              </button>
            </div>
          )}
          <Message msg={msg} />
          <DataTable rows={c.data.daily} rowKey={(d) => d.id} caption="Clôtures quotidiennes"
            empty={<EmptyState title="Aucune clôture quotidienne." icon="lock" />}
            columns={[
              { key: 'date', label: 'Journée', primary: true, render: (d) => <span><strong>{fmtDate(d.date)}</strong><span className="small muted tr-block">écritures {d.fromSeq}–{d.toSeq} ({d.entries})</span></span> },
              { key: 'bal', label: 'Équilibre', render: (d) => <StatusBadge tone={d.balanced ? 'good' : 'critical'} label={d.balanced ? 'Équilibrée' : 'Déséquilibrée'} /> },
              { key: 'open', label: 'À la clôture', render: (d) => <span className="small">{d.openExceptions} exception(s) · {d.openSuspense} suspens · {d.unimputed} non imputé(s)</span> },
              { key: 'hash', label: 'Empreinte', render: (d) => <span className="mono small" title={`${d.hash}\nprécédente : ${d.prevHash}`}>{shortHash(d.hash)}</span> },
              { key: 'by', label: 'Signée', render: (d) => <span className="small">{fmtDate(d.closedAt, true)}</span> },
            ]} />
          {c.data.monthly.length > 0 && (
            <ul className="list-rows compact-rows">
              {c.data.monthly.map((m) => (
                <li key={m.id} className="list-row"><span className="row-title">Mois {m.month}</span>
                  <span className="small muted">{m.dailyClosures.length} journée(s) · {m.imputed} imputation(s) · <span className="mono">{shortHash(m.hash)}</span></span></li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function AccountingBlock({ onChanged }: { onChanged?: () => void }) {
  const { user } = useApp();
  const acc = useApi(() => api<Accounting>('/v1/tresor/accounting'), [user?.id]);
  const nom = useApi(() => api<Nomenclature>('/v1/tresor/nomenclature'), [user?.id]);
  const { busy, msg, run, setMsg } = useAction();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const canRun = hasRole(user?.roles, 'R17');
  const canExport = hasRole(user?.roles, 'R17', 'R22', 'R23');

  async function download(format: 'csv' | 'json') {
    setMsg(null);
    const qs = new URLSearchParams({ format, ...(from ? { from } : {}), ...(to ? { to } : {}) });
    try {
      // Mêmes en-têtes que `api` : le jeton porteur d'une session réelle est transmis, pas seulement l'utilisateur de démonstration.
      const res = await fetch(`${API_URL}/v1/tresor/exports?${qs.toString()}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`Export refusé (${res.status}).`);
      const text = await res.text();
      const sha = res.headers.get('x-mosolo-sha256') ?? (format === 'json' ? (JSON.parse(text) as { sha256?: string }).sha256 : undefined);
      const blob = new Blob([text], { type: format === 'csv' ? 'text/csv' : 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `mosolo-export-comptable.${format}`;
      a.click();
      // Révocation différée : certains navigateurs lisent l'URL après le clic (téléchargement sinon annulé).
      const href = a.href;
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
      setMsg({ ok: true, text: `Export ${format.toUpperCase()} signé${sha ? ` — SHA-256 ${sha}` : ''}.` });
    } catch (e) { setMsg({ ok: false, text: describeError(e).message }); }
  }

  return (
    <section className="panel" aria-labelledby="acc-title">
      <header className="panel-head">
        <div><h2 className="panel-title" id="acc-title">Comptabilisation et export</h2>
          <p className="panel-sub">Un paiement rapproché devient « Comptabilisé » lorsqu’il est imputé selon la nomenclature ; l’export vers la comptabilité publique est signé.</p></div>
        {acc.data && <span className="small muted">{acc.data.counts.comptabilise} comptabilisé(s) · {acc.data.counts.rapproche} à imputer</span>}
      </header>
      {nom.data && (
        <>
          <ExampleNotice text={nom.data.notice} />
          <ul className="chips tr-nomen">
            {nom.data.entries.map((e) => <li key={e.revenueCategory} className="chip" title={e.label}><span className="mono">{e.code}</span>&nbsp;{e.revenueCategory.replace(/_/g, ' ').toLowerCase()}{e.demo ? ' · démo' : ''}</li>)}
          </ul>
        </>
      )}
      {canRun && (
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
          onClick={() => void run<{ imputed: unknown[]; unmapped: unknown[] }>('/v1/tresor/imputations/run', {}, 'Imputation effectuée.', (r) => { setMsg({ ok: true, text: `${r.imputed.length} paiement(s) imputé(s) ; ${r.unmapped.length} sans code de nomenclature.` }); acc.reload(); onChanged?.(); })}>
          <Icon name="ledger" size={16} /> Imputer les paiements rapprochés
        </button>
      )}
      {acc.loading && <Loading />}
      {acc.error !== null && <ErrorState error={acc.error} onRetry={acc.reload} />}
      {acc.data && (
        <DataTable rows={acc.data.rows} rowKey={(r) => r.paymentReference} caption="État comptable"
          empty={<EmptyState title="Aucun paiement rapproché pour l’instant." />}
          columns={[
            { key: 'ref', label: 'Paiement', primary: true, render: (r) => <span><span className="mono">{r.paymentReference}</span><span className="small muted tr-block">{r.receiptNumber ?? '—'}</span></span> },
            { key: 'amt', label: 'Montant', num: true, render: (r) => <MoneyText money={r.amount} showIndicative={false} /> },
            { key: 'state', label: 'État', render: (r) => <StatusBadge tone={r.state === 'COMPTABILISE' ? 'good' : 'warning'} label={r.state === 'COMPTABILISE' ? 'Comptabilisé' : 'Rapproché, non imputé'} /> },
            { key: 'code', label: 'Imputation', render: (r) => (r.code ? <span className="mono small">{r.code}{r.demoCode ? ' (démo)' : ''}</span> : '—') },
            { key: 'day', label: 'Jour', render: (r) => <span className="small">{r.dayClosed ? 'Clôturé' : 'Non clôturé'}</span> },
          ]} />
      )}
      {canExport && (
        <div className="row-actions tr-step">
          <label className="small" htmlFor="exp-from">Du</label><input id="exp-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <label className="small" htmlFor="exp-to">au</label><input id="exp-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <button type="button" className="btn btn-primary btn-sm" onClick={() => void download('csv')}><Icon name="download" size={16} /> Export CSV signé</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void download('json')}>JSON</button>
        </div>
      )}
      <Message msg={msg} />
    </section>
  );
}

export default function ClosuresPanel({ onChanged }: { onChanged?: () => void }) {
  return (
    <div className="tr-stack">
      <ClosureBlock onChanged={onChanged} />
      <AccountingBlock onChanged={onChanged} />
    </div>
  );
}
