/**
 * Coffre des comptes bénéficiaires (module 60) — registre verrouillé : comptes bancaires et Mobile Money publics
 * (numéros masqués ; seul l'alias sort du coffre), indicateurs des changements (demandés, approuvés, refusés, en
 * attente, en refroidissement) et VETO motivé pendant le refroidissement (Gouverneur, ministre des Finances, audit, ou
 * un membre du comité financier autre que le proposant). Aucun administrateur technique ne peut substituer un compte.
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { DataTable } from '../../components/DataTable';
import { ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { useApi } from '../../hooks/useApi';
import { CoffreVisuel } from './visuels';
import { api, describeError } from '../../lib/api';

export interface VaultAccount { alias: string; entity: string; kind: 'BANCAIRE' | 'MOBILE_MONEY'; bankName: string; accountNumber: string; holderName: string; currency: string; version: number; effectiveSince: string }
export interface VaultRequestRow { id: string; alias: string; status: string; requestedBy: string; requestedAt: string; coolingEndsAt?: string; effectiveFrom?: string; effectiveAt?: string; veto?: { by: string; at: string; motif: string }; proposed: { bankName: string; accountNumber: string; holderName: string } }
export interface VaultView {
  accounts: VaultAccount[]; changeRequests: VaultRequestRow[];
  indicators?: { requested: number; approved: number; effective: number; refused: number; pending: number; coolingOff: number; accounts: { total: number; bank: number; mobileMoney: number } };
}

const VETO_ROLES = ['R01', 'R05', 'R22', 'R19'];

export function VaultRegistryPanel() {
  const { user, fmtDate } = useApp();
  const q = useApi(() => api<VaultView>('/v1/beneficiary-accounts'), [user?.id]);
  const [motif, setMotif] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const canVeto = !!user?.roles.some((r) => VETO_ROLES.includes(r));
  async function veto(id: string) {
    setMsg(null);
    try { await api(`/v1/beneficiary-accounts/change-requests/${encodeURIComponent(id)}/veto`, { method: 'POST', body: { motif: motif[id] ?? '' } }); setMsg({ ok: true, text: `Veto enregistré : la demande ${id} est annulée, le compte en vigueur ne change pas.` }); q.reload(); }
    catch (e) { const d = describeError(e); setMsg({ ok: false, text: d.message + (d.code ? ` (${d.code})` : '') }); }
  }
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  const d = q.data;
  if (!d) return null;
  const ind = d.indicators;
  const vetoable = d.changeRequests.filter((r) => r.status === 'EN_ATTENTE_APPROBATION' || r.status === 'EN_REFROIDISSEMENT');
  return (
    <section className="panel" aria-labelledby="vault-reg" data-testid="vault-registry">
      <header className="panel-head"><div>
        <h2 className="panel-title" id="vault-reg"><Icon name="lock" size={18} /> Registre verrouillé des comptes publics de destination</h2>
        <p className="panel-sub">Comptes bancaires et Mobile Money publics ; chaque référence de paiement reçoit son bénéficiaire du coffre. Changement : quorum de deux personnes, vérification hors bande, refroidissement de 72 h, date d’effet future facultative.</p>
      </div></header>
      {ind && (
        <div className="kpi-row">
          <div className="kpi"><span className="kpi-label">Changements demandés</span><span className="kpi-value">{ind.requested}</span><span className="kpi-sub">{ind.pending} en attente de quorum · {ind.coolingOff} en refroidissement</span></div>
          <div className="kpi"><span className="kpi-label">Approuvés</span><span className="kpi-value">{ind.approved}</span><span className="kpi-sub">{ind.effective} effectif(s)</span></div>
          <div className="kpi"><span className="kpi-label">Refusés (veto)</span><span className="kpi-value">{ind.refused}</span></div>
          <div className="kpi"><span className="kpi-label">Comptes verrouillés</span><span className="kpi-value">{ind.accounts.total}</span><span className="kpi-sub">{ind.accounts.bank} bancaire(s) · {ind.accounts.mobileMoney} Mobile Money</span></div>
        </div>
      )}
      <CoffreVisuel accounts={d.accounts} requests={d.changeRequests} />
      <DataTable caption="Comptes verrouillés" rows={d.accounts} rowKey={(a) => a.alias} columns={[
        { key: 'a', label: 'Alias', primary: true, render: (a) => <span className="mono">{a.alias}</span> },
        { key: 'k', label: 'Nature', render: (a) => (a.kind === 'MOBILE_MONEY' ? 'Mobile Money public' : 'Compte bancaire') },
        { key: 'e', label: 'Entité', render: (a) => a.entity },
        { key: 'b', label: 'Établissement', render: (a) => a.bankName },
        { key: 'n', label: 'Numéro (masqué)', render: (a) => <span className="mono">{a.accountNumber}</span> },
        { key: 'c', label: 'Devise', render: (a) => a.currency },
        { key: 'v', label: 'Version', num: true, render: (a) => `v${a.version} · ${fmtDate(a.effectiveSince)}` },
      ]} />
      {vetoable.length > 0 && (
        <DataTable caption="Changements en cours (veto possible)" rows={vetoable} rowKey={(r) => r.id} columns={[
          { key: 'i', label: 'Demande', primary: true, render: (r) => <span className="mono">{r.id}</span> },
          { key: 'a', label: 'Alias', render: (r) => <span className="mono">{r.alias}</span> },
          { key: 's', label: 'État', render: (r) => <StatusBadge tone={r.status === 'EN_REFROIDISSEMENT' ? 'info' : 'warning'} label={r.status === 'EN_REFROIDISSEMENT' ? 'Refroidissement' : 'Quorum attendu'} /> },
          { key: 'e', label: 'Effet', render: (r) => <span className="small">{r.effectiveFrom ? `date d’effet ${fmtDate(r.effectiveFrom, true)}` : r.coolingEndsAt ? `fin du refroidissement ${fmtDate(r.coolingEndsAt, true)}` : '—'}</span> },
          ...(canVeto ? [{
            key: 'x', label: 'Veto motivé', render: (r: VaultRequestRow) => r.requestedBy === user?.id ? <span className="small muted">Vous avez proposé ce changement.</span> : (
              <span className="row-actions">
                <input aria-label={`Motif du veto ${r.id}`} placeholder="motif (10 caractères min.)" value={motif[r.id] ?? ''} onChange={(e) => setMotif({ ...motif, [r.id]: e.target.value })} />
                <button type="button" className="btn btn-ghost btn-sm" disabled={(motif[r.id] ?? '').trim().length < 10} onClick={() => void veto(r.id)}>Opposer un veto</button>
              </span>
            ),
          }] : []),
        ]} />
      )}
      {msg && <p className={msg.ok ? 'notice notice-ok' : 'notice notice-err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
    </section>
  );
}
