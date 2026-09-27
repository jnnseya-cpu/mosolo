/**
 * File de validation des commissions (superviseurs R09, chefs de service R07, directions de régie R06) : une commission
 * acquise n'est payable par le Trésor qu'après validation par une personne DISTINCTE de l'agent bénéficiaire et des
 * personnes qui ont vérifié ou décidé le constat d'origine. Décision motivée, journalisée, soumise à la garde de
 * rotation de l'intégrité. Aucune validation automatique : le système calcule, un humain décide.
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { Money } from './shared';
import './parking.css';

export interface ValidationRequest {
  id: string; agentId: string; agentName: string; status: 'DEMANDEE' | 'VALIDEE' | 'REFUSEE'; requestedAt: string; motif?: string;
  total: MoneyJSON[]; excluded: string[]; blockReason: string | null;
  lines: { key: string; module: string; source: 'PENALITE' | 'PAIEMENT'; reference: string; commission: MoneyJSON; verifierIds: string[] }[];
  decision?: { by: string; at: string; approve: boolean; motif: string };
}
export interface ValidationQueue { items: ValidationRequest[]; pending: number; rule: string }

const STATUS: Record<ValidationRequest['status'], { label: string; tone: Tone }> = {
  DEMANDEE: { label: 'À décider', tone: 'warning' }, VALIDEE: { label: 'Validée — payable', tone: 'good' }, REFUSEE: { label: 'Refusée', tone: 'critical' },
};

/** La personne qui consulte peut-elle décider ? (le serveur reste seul juge : séparation des tâches, rotation). */
export const canDecideCommission = (r: ValidationRequest): boolean => r.status === 'DEMANDEE' && r.blockReason === null;

export default function CommissionValidations() {
  const { user } = useApp();
  const q = useApi(() => api<ValidationQueue>('/v1/agents/commission-validations'), [user?.id]);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Agents · tous modules" title="Validation des commissions"
        lead="Une commission acquise (recette rapprochée au compte public) n’est payable qu’après votre validation motivée. Vous ne pouvez pas valider la commission d’un constat que vous avez vérifié ou décidé. Chaque ligne validée est un point de régularisation payable de la réserve des agents (§ 37A.5 : points × note de qualité, jamais le montant).">
        <button type="button" className="btn btn-secondary btn-sm" onClick={q.reload}><Icon name="refresh" size={16} /> Actualiser</button>
      </PageHead>
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : q.data && <ValidationQueueView queue={q.data} onDone={q.reload} />}
    </div>
  );
}

export function ValidationQueueView({ queue, onDone }: { queue: ValidationQueue; onDone: () => void }) {
  const { fmtDate } = useApp();
  const [motifs, setMotifs] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  async function decide(r: ValidationRequest, approve: boolean) {
    const motif = (motifs[r.id] ?? '').trim();
    if (motif.length < 10) { setMsg({ ok: false, text: 'Motif d’au moins 10 caractères requis.' }); return; }
    setBusy(r.id); setMsg(null);
    try {
      await api(`/v1/agents/commission-validations/${encodeURIComponent(r.id)}/decision`, { method: 'POST', body: { approve, motif } });
      setMsg({ ok: true, text: approve ? `Commission ${r.id} validée : payable par le Trésor.` : `Demande ${r.id} refusée ; l’agent peut en déposer une nouvelle.` });
      onDone();
    } catch (e) { setMsg({ ok: false, text: describeError(e).message }); } finally { setBusy(null); }
  }
  return (
    <>
      <div className="callout callout-info" data-testid="commission-rule"><Icon name="shieldCheck" size={18} /><span className="small">{queue.rule}</span></div>
      {msg && <p className={msg.ok ? 'notice notice-ok' : 'notice notice-err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
      <section className="panel">
        <header className="panel-head"><h2 className="panel-title"><Icon name="cash" size={18} /> Demandes de validation</h2><span className="count">{queue.pending}</span></header>
        {queue.items.length === 0 ? <EmptyState title="Aucune demande" icon="check">Les agents demandent la validation de leurs commissions acquises depuis « Mes gains ».</EmptyState> : (
          <ul className="list-rows">{queue.items.map((r) => (
            <li key={r.id} className="list-row list-row-stack">
              <div className="row-between">
                <span className="row-title">{r.agentName} <span className="mono small muted">{r.agentId} · {r.id}</span></span>
                <StatusBadge tone={STATUS[r.status].tone} label={STATUS[r.status].label} />
              </div>
              <p className="small">Total : <strong><Money items={r.total} /></strong> · {r.lines.length} ligne(s) · demandée le {fmtDate(r.requestedAt, true)}</p>
              <ul className="small plain-list">{r.lines.map((l) => (
                <li key={l.key}><span className="mono">{l.reference}</span> — {l.module.toLowerCase()} · {l.source === 'PENALITE' ? 'pénalité' : 'paiement généré'} · <Money items={l.commission} />{l.verifierIds.length ? <span className="muted"> · constat vérifié/décidé par {l.verifierIds.join(', ')}</span> : null}</li>
              ))}</ul>
              {r.decision && <p className="small muted">{r.decision.approve ? 'Validée' : 'Refusée'} par {r.decision.by} le {fmtDate(r.decision.at, true)} : {r.decision.motif}</p>}
              {r.status === 'DEMANDEE' && (canDecideCommission(r) ? (
                <div className="form">
                  <div className="field"><label className="label" htmlFor={`cv-${r.id}`}>Motif de la décision (10 caractères minimum)</label>
                    <input id={`cv-${r.id}`} value={motifs[r.id] ?? ''} onChange={(e) => setMotifs((m) => ({ ...m, [r.id]: e.target.value }))} /></div>
                  <div className="btn-row">
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy === r.id} onClick={() => void decide(r, true)}>Valider (payable)</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy === r.id} onClick={() => void decide(r, false)}>Refuser</button>
                  </div>
                </div>
              ) : <p className="small muted" data-testid="commission-block">{r.blockReason}</p>)}
            </li>
          ))}</ul>
        )}
      </section>
    </>
  );
}
