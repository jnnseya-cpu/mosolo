import { useState, type FormEvent } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { MoneyText } from '../../components/MoneyText';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { api, describeError } from '../../lib/api';
import './verticales.css';

interface Account { id: string; entityName: string; bank: string; accountNumberMasked: string; currency: string; type: string; status: string; validations: { finances?: { by: string }; controle?: { by: string } } }
interface Tx { id: string; bank: string; amount: MoneyJSON; at: string; beneficiary: string; reference: string; score: 'VERT' | 'AMBRE' | 'ROUGE'; findings: string[]; reportId: string | null; accountId: string | null }
interface Report { id: string; transactionId: string; score: string; findings: string[]; createdAt: string; sha256: string; status: 'OUVERT' | 'GELE' | 'CLOS'; freeze?: { by: string; reason: string; legalBasis: string }; closure?: { by: string; reason: string } }
interface Overview {
  notice: string; totals: { transactions: number; vert: number; ambre: number; rouge: number; blocked: number }; complianceRate: string;
  accounts: { declared: number; validated: number }; accountsList?: Account[]; transactions?: Tx[]; reports?: Report[];
}

const SCORE_LABEL = { VERT: 'Conforme', AMBRE: 'Correspondance partielle', ROUGE: 'Anomalie' } as const;

function ReportRow({ r, canAct, onChange }: { r: Report; canAct: boolean; onChange: () => void }) {
  const { fmtDate } = useApp();
  const [reason, setReason] = useState('');
  const [basis, setBasis] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const post = async (path: string, body: unknown) => {
    setErr(null);
    try { await api(`/v1/verticales/calcu/reports/${r.id}/${path}`, { method: 'POST', body }); onChange(); } catch (e) { setErr(describeError(e).message); }
  };
  return (
    <li className="list-row list-row-stack">
      <div className="row-between">
        <div className="min0"><p className="row-title mono">{r.id}</p><p className="small muted">{fmtDate(r.createdAt, true)} · opération <span className="mono">{r.transactionId}</span> · empreinte <span className="mono">{r.sha256.slice(0, 12)}…</span></p></div>
        <div className="row-side"><span className={`vxc-score vxc-score-${r.score}`}>{SCORE_LABEL[r.score as keyof typeof SCORE_LABEL] ?? r.score}</span><StatusBadge tone={r.status === 'GELE' ? 'warning' : r.status === 'CLOS' ? 'neutral' : 'info'} label={r.status === 'GELE' ? 'Dossier gelé' : r.status === 'CLOS' ? 'Clos' : 'Ouvert'} /></div>
      </div>
      <ul className="vxc-findings">{r.findings.map((f) => <li key={f}>{f}</li>)}</ul>
      {r.freeze && <p className="small"><Icon name="lock" size={13} /> Gel décidé par {r.freeze.by} — {r.freeze.reason} ({r.freeze.legalBasis})</p>}
      {canAct && r.status !== 'CLOS' && (
        <form className="vxc-actions" onSubmit={(e: FormEvent) => { e.preventDefault(); void post(r.status === 'OUVERT' ? 'freeze' : 'close', r.status === 'OUVERT' ? { reason, legalBasis: basis } : { reason }); }}>
          <h3>{r.status === 'OUVERT' ? 'Geler administrativement le dossier' : 'Clore le dossier (autre personne que celle qui a gelé)'}</h3>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motif" aria-label="Motif" />
          {r.status === 'OUVERT' && <input value={basis} onChange={(e) => setBasis(e.target.value)} placeholder="Base légale invoquée" aria-label="Base légale" />}
          {err && <p className="err" role="alert">{err}</p>}
          <button type="submit" className="btn btn-secondary btn-sm" disabled={reason.trim().length < 5 || (r.status === 'OUVERT' && basis.trim().length < 3)}>{r.status === 'OUVERT' ? 'Geler le dossier' : 'Clore'}</button>
          <p className="hint">Le gel porte sur le dossier de contrôle, jamais sur un paiement : CALCU ne bloque aucune opération bancaire.</p>
        </form>
      )}
    </li>
  );
}

/** Console CALCU (module 80) : registre des comptes publics, correspondance des dépenses, rapports d'anomalie. */
export default function CalcuConsole() {
  const { user, fmtDate } = useApp();
  const q = useApi(() => api<Overview>('/v1/verticales/calcu/overview'), [user?.id]);
  const [err, setErr] = useState<string | null>(null);
  const roles = user?.roles ?? [];
  const validateAs = roles.includes('R22') ? 'CONTROLE' : roles.some((r) => r === 'R05' || r === 'R15') ? 'FINANCES' : null;
  const validate = async (id: string) => {
    setErr(null);
    try { await api(`/v1/verticales/calcu/accounts/${id}/validate`, { method: 'POST', body: { as: validateAs } }); q.reload(); } catch (e) { setErr(describeError(e).message); }
  };
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Contrôle de la dépense publique" title="CALCU — correspondance des dépenses"
        lead="Chaque sortie de fonds publique rapprochée de ses justificatifs : vert, ambre ou rouge. CALCU ne bloque aucun paiement et respecte le secret bancaire." />
      <ExampleNotice text="Pilote de démonstration sur une entité volontaire : comptes, pièces et opérations fictifs. Cadre juridique à adopter (J26)." />
      {q.loading && <Loading />}
      {!!q.error && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && (
        <div className="stack">
          <div className="vxc-kpis">
            <div className="vxc-kpi"><strong>{q.data.complianceRate} %</strong><span>Opérations conformes (vert)</span></div>
            <div className="vxc-kpi"><strong>{q.data.totals.ambre}</strong><span>Correspondances partielles</span></div>
            <div className="vxc-kpi"><strong>{q.data.totals.rouge}</strong><span>Anomalies (rouge)</span></div>
            <div className="vxc-kpi"><strong>{q.data.totals.blocked}</strong><span>Paiements bloqués — toujours zéro</span></div>
          </div>
          {err && <p className="notice notice-err" role="alert">{err}</p>}
          {q.data.accountsList && (
            <section className="panel">
              <div className="panel-head"><h2 className="panel-title"><Icon name="bank" size={18} /> Registre des comptes publics</h2><span className="count">{q.data.accounts.validated}/{q.data.accounts.declared} validés</span></div>
              <DataTable rows={q.data.accountsList} rowKey={(a) => a.id} empty={<EmptyState title="Aucun compte déclaré" />}
                columns={[
                  { key: 'e', label: 'Entité', primary: true, render: (a) => <span>{a.entityName}<br /><span className="mono small muted">{a.id}</span></span> },
                  { key: 'b', label: 'Banque et compte', render: (a) => <span>{a.bank} <span className="mono">{a.accountNumberMasked}</span></span> },
                  { key: 't', label: 'Type', render: (a) => `${a.type.toLowerCase()} · ${a.currency}` },
                  { key: 'v', label: 'Validation conjointe', render: (a) => <span className="small">Finances {a.validations.finances ? '✓' : '—'} · Contrôle {a.validations.controle ? '✓' : '—'}</span> },
                  { key: 's', label: 'Statut', render: (a) => <StatusBadge tone={a.status === 'VALIDE' ? 'good' : 'warning'} label={a.status === 'VALIDE' ? 'Validé, surveillé' : 'En attente'} /> },
                  { key: 'x', label: '', render: (a) => validateAs && a.status !== 'VALIDE' && !(validateAs === 'FINANCES' ? a.validations.finances : a.validations.controle) ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => void validate(a.id)}>Valider ({validateAs === 'FINANCES' ? 'Finances' : 'Contrôle'})</button> : null },
                ]} />
            </section>
          )}
          {q.data.transactions && (
            <section className="panel">
              <h2 className="panel-title"><Icon name="sync" size={18} /> Opérations transmises par la passerelle bancaire</h2>
              <DataTable rows={q.data.transactions} rowKey={(t) => t.id}
                columns={[
                  { key: 'd', label: 'Date', render: (t) => fmtDate(t.at, true) },
                  { key: 'r', label: 'Référence', primary: true, render: (t) => <span className="mono">{t.reference}</span> },
                  { key: 'b', label: 'Bénéficiaire', render: (t) => t.beneficiary },
                  { key: 'm', label: 'Montant', num: true, render: (t) => <MoneyText money={t.amount} /> },
                  { key: 's', label: 'Score', render: (t) => <span className={`vxc-score vxc-score-${t.score}`}>{SCORE_LABEL[t.score]}</span> },
                  { key: 'f', label: 'Constats', full: true, render: (t) => <ul className="vxc-findings">{t.findings.map((f) => <li key={f}>{f}</li>)}</ul> },
                ]} />
            </section>
          )}
          {q.data.reports && (
            <section className="panel">
              <div className="panel-head"><h2 className="panel-title"><Icon name="alert" size={18} /> Rapports d’anomalie</h2><span className="count">{q.data.reports.length}</span></div>
              {q.data.reports.length === 0 ? <EmptyState title="Aucun rapport" /> : <ul className="list-rows">{q.data.reports.map((r) => <ReportRow key={r.id} r={r} canAct={roles.includes('R22')} onChange={q.reload} />)}</ul>}
            </section>
          )}
          {!q.data.accountsList && <div className="callout callout-info"><Icon name="info" size={18} /><p>{q.data.notice} Vous voyez les agrégats de votre périmètre.</p></div>}
        </div>
      )}
    </div>
  );
}
