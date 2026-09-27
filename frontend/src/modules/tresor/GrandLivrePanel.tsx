/**
 * Grand livre public (module 59) : indicateurs calculés sur les données réelles — écart grand livre / relevés (par
 * devise, expliqué par les lignes de relevé encore en exception), délai de clôture quotidienne et mensuelle, arriéré,
 * suspens ouverts — et vérification à la demande du scellement (chaîne d'empreintes, séquence, équilibre, clôtures
 * signées). Aucune correction : une rupture est signalée à l'audit.
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { DataTable } from '../../components/DataTable';
import { ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { MoneyText } from '../../components/MoneyText';
import { StatusBadge } from '../../components/StatusBadge';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';

export interface ChainCheck { valid: boolean; entries: number; headHash: string | null; brokenAt?: string; reason?: string }
export interface GrandLivreIndicators {
  generatedAt: string; entries: number; balanced: boolean; chain: ChainCheck; reversals: number;
  ecartReleves: {
    byCurrency: { currency: string; statements: MoneyJSON; ledger: MoneyJSON; gap: MoneyJSON; zero: boolean; pendingStatementLines: number; pendingAmount: MoneyJSON }[];
    statementsWithoutTotals: number; method: string;
  };
  delaiCloture: {
    daily: { id: string; date: string; closedAt: string; entries: number; delayHours: number }[];
    monthly: { id: string; month: string; closedAt: string; delayDays: number }[];
    medianDelayHours: number | null; averageDelayHours: number | null; lastDelayHours: number | null;
    backlog: { oldestUnclosedDate: string | null; hoursSinceEnd: number | null }; note?: string;
  };
  suspense: { open: number; oldestDays: number };
}
type Verification = ChainCheck & { closures: { valid: boolean; brokenAt?: string }; verifiedAt: string };

const CHAIN_REASON: Record<string, string> = {
  SEQUENCE_ROMPUE: 'séquence des écritures rompue', CHAINAGE_ROMPU: 'chaînage rompu (empreinte précédente)', EMPREINTE_INVALIDE: 'empreinte recalculée différente', ECRITURE_DESEQUILIBREE: 'écriture déséquilibrée',
};

export function GrandLivrePanel() {
  const { user, fmtDate } = useApp();
  const q = useApi(() => api<GrandLivreIndicators>('/v1/tresor/grand-livre/indicateurs'), [user?.id]);
  const [check, setCheck] = useState<Verification | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function verify() {
    setErr(null);
    try { setCheck(await api<Verification>('/v1/tresor/grand-livre/verification')); } catch (e) { setErr(describeError(e).message); }
  }
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data;
  if (!d) return null;
  const c = d.delaiCloture;
  return (
    <section className="panel" aria-labelledby="gl-title" data-testid="grand-livre">
      <header className="panel-head"><div>
        <h2 className="panel-title" id="gl-title"><Icon name="ledger" size={18} /> Grand livre public — scellement et indicateurs</h2>
        <p className="panel-sub">Partie double, ajout seul ; corrections par contre-écriture liée, motivée et approuvée à quatre yeux ; comptes d’attente datés ; clôtures signées.</p>
      </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void verify()}><Icon name="shieldCheck" size={16} /> Vérifier le scellement</button>
      </header>
      <div className="kpi-row">
        <div className="kpi"><span className="kpi-label">Écritures</span><span className="kpi-value">{d.entries}</span><span className="kpi-sub">{d.reversals} contre-écriture(s) · {d.balanced ? 'équilibré' : 'DÉSÉQUILIBRÉ'}</span></div>
        <div className="kpi"><span className="kpi-label">Chaîne d’empreintes</span><span className="kpi-value"><StatusBadge tone={d.chain.valid ? 'good' : 'critical'} label={d.chain.valid ? 'Intègre' : 'Rompue'} /></span><span className="kpi-sub">{d.chain.headHash ? `tête ${d.chain.headHash.slice(0, 12)}…` : 'aucune écriture'}</span></div>
        <div className="kpi"><span className="kpi-label">Délai de clôture quotidienne</span><span className="kpi-value">{c.medianDelayHours === null ? '—' : `${c.medianDelayHours} h`}</span><span className="kpi-sub">{c.note ?? `médiane · moyenne ${c.averageDelayHours} h · dernière ${c.lastDelayHours} h`}</span></div>
        <div className="kpi"><span className="kpi-label">Journée non clôturée la plus ancienne</span><span className="kpi-value">{c.backlog.oldestUnclosedDate ?? 'aucune'}</span><span className="kpi-sub">{c.backlog.hoursSinceEnd ? `${c.backlog.hoursSinceEnd} h depuis sa fin` : 'à jour'}</span></div>
        <div className="kpi"><span className="kpi-label">Comptes d’attente ouverts</span><span className="kpi-value">{d.suspense.open}</span><span className="kpi-sub">plus ancien : {d.suspense.oldestDays} j</span></div>
      </div>
      {!d.chain.valid && <p className="notice notice-err" role="alert">Rupture du scellement à l’écriture {d.chain.brokenAt} : {CHAIN_REASON[d.chain.reason ?? ''] ?? d.chain.reason}. Aucune correction automatique — l’audit est alerté.</p>}
      {check && (
        <p className={check.valid && check.closures.valid ? 'notice notice-ok' : 'notice notice-err'} role="status">
          Vérifié le {fmtDate(check.verifiedAt, true)} : {check.entries} écriture(s), chaîne {check.valid ? 'intègre' : `rompue à ${check.brokenAt}`} ; clôtures signées {check.closures.valid ? 'intègres' : `rompues à ${check.closures.brokenAt}`}.
        </p>
      )}
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      <DataTable caption="Écart grand livre / relevés" rows={d.ecartReleves.byCurrency} rowKey={(r) => r.currency} empty={<p className="small muted">Aucun relevé ni aucune entrée de fonds.</p>} columns={[
        { key: 'c', label: 'Devise', primary: true, render: (r) => <strong>{r.currency}</strong> },
        { key: 's', label: 'Relevés importés', num: true, render: (r) => <MoneyText money={r.statements} showIndicative={false} /> },
        { key: 'l', label: 'Inscrit au compte public', num: true, render: (r) => <MoneyText money={r.ledger} showIndicative={false} /> },
        { key: 'g', label: 'Écart', num: true, render: (r) => <StatusBadge tone={r.zero ? 'good' : 'warning'} label={r.zero ? 'nul' : r.gap.amount} /> },
        { key: 'p', label: 'Lignes en exception', num: true, render: (r) => <>{r.pendingStatementLines} · <MoneyText money={r.pendingAmount} showIndicative={false} /></> },
      ]} />
      <p className="small muted">{d.ecartReleves.method}{d.ecartReleves.statementsWithoutTotals ? ` ${d.ecartReleves.statementsWithoutTotals} relevé(s) antérieur(s) sans total conservé.` : ''}</p>
      {c.daily.length > 0 && (
        <DataTable caption="Délais des clôtures quotidiennes" rows={c.daily.slice(0, 10)} rowKey={(r) => r.id} columns={[
          { key: 'd', label: 'Journée', primary: true, render: (r) => r.date },
          { key: 'c', label: 'Clôturée le', render: (r) => fmtDate(r.closedAt, true) },
          { key: 'n', label: 'Écritures', num: true, render: (r) => r.entries },
          { key: 'h', label: 'Délai', num: true, render: (r) => `${r.delayHours} h` },
        ]} />
      )}
      {c.monthly.length > 0 && <p className="small">Clôtures mensuelles : {c.monthly.map((m) => `${m.month} (${m.delayDays} j)`).join(' · ')}.</p>}
    </section>
  );
}
