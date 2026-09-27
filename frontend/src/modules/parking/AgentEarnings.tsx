/**
 * « Mes gains » — commission de 10 % de TOUT agent, quel que soit son module (stationnement, titres et pass wewa,
 * verticales, publicité, terrain) : pénalités issues de ses constats et paiements provoqués par ses contrôles,
 * calculés sur la recette publique confirmée ou rapprochée et versés par le Trésor — jamais d'argent reçu de l'usager.
 * Le panneau `AgentCommissions` sert au pilotage, aux régies et au Trésor (vue par agent et par module).
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { Kpis, Money } from './shared';
import './parking.css';
import { AttenteBaseLegale } from '../juridique/AttenteBaseLegale';

type EarningState = 'EN_ATTENTE' | 'CONFIRMEE' | 'ACQUISE' | 'ANNULEE';
export interface EarningTotals { acquise: MoneyJSON[]; confirmee: MoneyJSON[]; enAttente: MoneyJSON[]; annulee: MoneyJSON[]; base: MoneyJSON[]; ceMois: MoneyJSON[]; payable?: MoneyJSON[] }
export type LineValidation = 'A_DEMANDER' | 'DEMANDEE' | 'VALIDEE' | 'REFUSEE';
/** Validation humaine avant versement : une commission acquise n'est payable qu'une fois validée par un superviseur distinct. */
export const VALIDATION_LABEL: Record<LineValidation, { label: string; tone: Tone }> = {
  A_DEMANDER: { label: 'À faire valider', tone: 'neutral' }, DEMANDEE: { label: 'Validation demandée', tone: 'info' },
  VALIDEE: { label: 'Validée — payable', tone: 'good' }, REFUSEE: { label: 'Refusée — à redemander', tone: 'warning' },
};
export interface EarningCounts { penalites: number; paiements: number }
interface EarningLine {
  module?: string; moduleLabel?: string; obligationId?: string;
  source: 'PENALITE' | 'PAIEMENT'; reference: string; plate: string; zone: string; at: string;
  base: MoneyJSON; commission: MoneyJSON; state: EarningState; stateLabel: string;
  validation?: LineValidation | null; validationKey?: string | null;
}
interface ModuleShare { module: string; moduleLabel: string; lines: number; commission: MoneyJSON[] }
export interface MyEarnings { agentId: string; ratePct: number; totals: EarningTotals; counts: EarningCounts; lines: EarningLine[]; rules: string[]; modules?: ModuleShare[]; validation?: { aDemander: number; demandees: number; validees: number } }
interface AgentsEarnings { items: { agentId: string; agentName: string; totals: EarningTotals; counts: EarningCounts; modules?: ModuleShare[] }[]; ratePct: number }

const STATE_TONE: Record<EarningState, Tone> = { ACQUISE: 'good', CONFIRMEE: 'info', EN_ATTENTE: 'neutral', ANNULEE: 'critical' };
const STATE_LABEL: Record<EarningState, string> = { ACQUISE: 'Acquise', CONFIRMEE: 'Payée — rapprochement en cours', EN_ATTENTE: 'En attente de paiement', ANNULEE: 'Annulée' };
const SOURCE_LABEL: Record<EarningLine['source'], string> = { PENALITE: 'Pénalité', PAIEMENT: 'Paiement généré' };

export default function AgentEarnings() {
  const { user, fmtDate } = useApp();
  const data = useApi(() => api<MyEarnings>('/v1/agents/me/earnings'), [user?.id]);
  const rate = data.data?.ratePct ?? 10;
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Agent · tous modules" title="Mes gains"
        lead={`Vous percevez ${rate} % des pénalités issues de vos constats et des paiements provoqués par vos contrôles, quel que soit votre module. Calcul sur la recette publique confirmée ; versement par le Trésor. N’acceptez jamais d’argent d’un usager.`}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={data.reload}><Icon name="refresh" size={16} /> Actualiser</button>
      </PageHead>
      {/* Versement des commissions : régime des incitations des agents (J10) — le calcul n'est pas modifié. */}
      <AttenteBaseLegale fonction="COMMISSIONS_VERSEMENT" />
      {data.loading && !data.data ? <Loading /> : data.error ? <ErrorState error={data.error} onRetry={data.reload} /> : data.data && (
        <EarningsBody d={data.data} fmtDate={fmtDate} onChanged={data.reload} />
      )}
    </div>
  );
}

export function EarningsBody({ d, fmtDate, onChanged }: { d: MyEarnings; fmtDate: (iso: string | undefined, withTime?: boolean) => string; onChanged?: () => void }) {
  const t = d.totals;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const toRequest = d.validation?.aDemander ?? 0;
  async function requestValidation() {
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ id: string; lines: unknown[] }>('/v1/agents/me/commission-validations', { method: 'POST', body: {} });
      setMsg({ ok: true, text: `Demande ${r.id} enregistrée (${r.lines.length} ligne(s)) : un superviseur distinct de vous et des personnes qui ont vérifié vos constats décide.` });
      onChanged?.();
    } catch (e) { setMsg({ ok: false, text: describeError(e).message }); } finally { setBusy(false); }
  }
  return (
    <>
      <Kpis items={[
        { label: 'Payable', value: <Money items={t.payable ?? []} empty="0" />, sub: 'acquise et validée par un superviseur' },
        { label: 'Acquise', value: <Money items={t.acquise} empty="0" />, sub: 'à faire valider avant versement' },
        { label: 'Payée — rapprochement en cours', value: <Money items={t.confirmee} empty="0" /> },
        { label: 'En attente de paiement', value: <Money items={t.enAttente} empty="0" /> },
        { label: 'Ce mois-ci', value: <Money items={t.ceMois} empty="0" /> },
        { label: 'Pénalités', value: d.counts.penalites, sub: 'issues de vos constats' },
        { label: 'Paiements générés', value: d.counts.paiements, sub: 'après vos contrôles' },
      ]} />
      {(d.modules?.length ?? 0) > 0 && (
        <div className="earn-modules">
          {d.modules!.map((m) => (
            <div key={m.module} className="earn-module"><span className="caps-sm muted">{m.moduleLabel}</span><strong><Money items={m.commission} empty="0" /></strong><span className="small muted">{m.lines} ligne(s)</span></div>
          ))}
        </div>
      )}
      {d.rules.length > 0 && (
        <div className="callout callout-info">
          <Icon name="shieldCheck" size={18} />
          <ul className="small earn-rules">{d.rules.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="cash" size={18} /> Détail des commissions</h2><p className="panel-sub">Base : recette publique rattachée à votre contrôle. Commission : {d.ratePct} % de cette base, dans la même devise. Acquise, elle n’est payable qu’après validation par un superviseur distinct.</p></div>
          {toRequest > 0 && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void requestValidation()}>Demander la validation ({toRequest})</button>}
        </header>
        {msg && <p className={msg.ok ? 'notice notice-ok' : 'notice notice-err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
        {d.lines.length === 0 ? <EmptyState title="Aucune commission pour l’instant" icon="cash">Les commissions apparaissent lorsqu’un de vos contrôles aboutit à un paiement ou à une pénalité.</EmptyState> : (
          <DataTable<EarningLine> rows={d.lines} rowKey={(l) => l.validationKey ?? `${l.obligationId ?? l.reference}-${l.source}-${l.state}`} caption="Commissions"
            columns={[
              { key: 'mod', label: 'Module', render: (l) => l.moduleLabel ?? 'Stationnement' },
              { key: 'src', label: 'Source', render: (l) => <StatusBadge tone={l.source === 'PENALITE' ? 'warning' : 'info'} label={SOURCE_LABEL[l.source]} /> },
              { key: 'ref', label: 'Référence', primary: true, render: (l) => <span className="mono">{l.reference}</span> },
              { key: 'plate', label: 'Plaque', render: (l) => l.plate ? <span className="pk-plate">{l.plate}</span> : '—' },
              { key: 'zone', label: 'Lieu', render: (l) => l.zone || '—' },
              { key: 'at', label: 'Date', render: (l) => fmtDate(l.at, true) },
              { key: 'base', label: 'Base', num: true, render: (l) => <Money items={l.base} /> },
              { key: 'com', label: `Commission ${d.ratePct} %`, num: true, render: (l) => <strong><Money items={l.commission} /></strong> },
              { key: 'state', label: 'État', render: (l) => <StatusBadge tone={STATE_TONE[l.state] ?? 'neutral'} label={l.stateLabel || STATE_LABEL[l.state]} /> },
              { key: 'val', label: 'Validation', render: (l) => l.validation ? <StatusBadge tone={VALIDATION_LABEL[l.validation].tone} label={VALIDATION_LABEL[l.validation].label} /> : '—' },
            ]} />
        )}
      </section>
    </>
  );
}

/** Commissions par agent (régie et pilotage). */
export function AgentCommissions() {
  const data = useApi(() => api<AgentsEarnings>('/v1/agents/earnings'), []);
  const rate = data.data?.ratePct ?? 10;
  return (
    <section className="panel">
      <header className="panel-head"><div><h2 className="panel-title"><Icon name="cash" size={18} /> Commissions des agents ({rate} %)</h2><p className="panel-sub">Tous les agents, tous les modules. Calculées sur la recette publique confirmée ou rapprochée et versées par le Trésor ; aucun encaissement par l’agent. Montants par devise, jamais additionnés entre devises.</p></div></header>
      {data.loading && !data.data ? <Loading /> : data.error ? <ErrorState error={data.error} onRetry={data.reload} /> : (
        <DataTable rows={data.data?.items ?? []} rowKey={(a) => a.agentId} caption="Commissions des agents" empty={<p className="muted small">Aucune commission.</p>}
          columns={[
            { key: 'name', label: 'Agent', primary: true, render: (a) => <>{a.agentName} <span className="mono small muted">{a.agentId}</span></> },
            { key: 'pen', label: 'Pénalités', num: true, render: (a) => a.counts.penalites },
            { key: 'pay', label: 'Paiements', num: true, render: (a) => a.counts.paiements },
            { key: 'mods', label: 'Modules', render: (a) => (a.modules ?? []).map((m) => m.moduleLabel).join(', ') || '—' },
            { key: 'payable', label: 'Payable (validée)', render: (a) => <Money items={a.totals.payable ?? []} empty="0" /> },
            { key: 'acq', label: 'Acquise', render: (a) => <Money items={a.totals.acquise} empty="0" /> },
            { key: 'conf', label: 'Confirmée', render: (a) => <Money items={a.totals.confirmee} empty="0" /> },
            { key: 'wait', label: 'En attente', render: (a) => <Money items={a.totals.enAttente} empty="0" /> },
          ]} />
      )}
    </section>
  );
}
