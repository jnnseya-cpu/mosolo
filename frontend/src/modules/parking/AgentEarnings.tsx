/**
 * Gains de l'agent de contrôle ParkSmart (R11) : 10 % des pénalités et des paiements de stationnement générés par ses
 * contrôles « rouge », calculés sur la recette publique confirmée ou rapprochée et versés par le Trésor — jamais
 * d'argent reçu de l'usager. Le panneau `AgentCommissions` sert à la régie et au pilotage (vue par agent).
 */
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { Kpis, Money } from './shared';
import './parking.css';

type EarningState = 'EN_ATTENTE' | 'CONFIRMEE' | 'ACQUISE' | 'ANNULEE';
export interface EarningTotals { acquise: MoneyJSON[]; confirmee: MoneyJSON[]; enAttente: MoneyJSON[]; annulee: MoneyJSON[]; base: MoneyJSON[]; ceMois: MoneyJSON[] }
export interface EarningCounts { penalites: number; paiements: number }
interface EarningLine {
  source: 'PENALITE' | 'PAIEMENT'; reference: string; plate: string; zone: string; at: string;
  base: MoneyJSON; commission: MoneyJSON; state: EarningState; stateLabel: string;
}
interface MyEarnings { agentId: string; ratePct: number; totals: EarningTotals; counts: EarningCounts; lines: EarningLine[]; rules: string[] }
interface AgentsEarnings { items: { agentId: string; agentName: string; totals: EarningTotals; counts: EarningCounts }[]; ratePct: number }

const STATE_TONE: Record<EarningState, Tone> = { ACQUISE: 'good', CONFIRMEE: 'info', EN_ATTENTE: 'neutral', ANNULEE: 'critical' };
const STATE_LABEL: Record<EarningState, string> = { ACQUISE: 'Acquise', CONFIRMEE: 'Payée — rapprochement en cours', EN_ATTENTE: 'En attente de paiement', ANNULEE: 'Annulée' };
const SOURCE_LABEL: Record<EarningLine['source'], string> = { PENALITE: 'Pénalité', PAIEMENT: 'Paiement généré' };

export default function AgentEarnings() {
  const { user, fmtDate } = useApp();
  const data = useApi(() => api<MyEarnings>('/v1/parking/agents/me/earnings'), [user?.id]);
  const rate = data.data?.ratePct ?? 10;
  return (
    <div className="page page-wide">
      <PageHead eyebrow="MOSOLO Parking · agent" title="Mes gains"
        lead={`Vous percevez ${rate} % des pénalités et des paiements de stationnement générés par vos contrôles « rouge », calculés uniquement sur la recette publique confirmée et versés par le Trésor. N’acceptez jamais d’argent d’un usager.`}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={data.reload}><Icon name="refresh" size={16} /> Actualiser</button>
      </PageHead>
      {data.loading && !data.data ? <Loading /> : data.error ? <ErrorState error={data.error} onRetry={data.reload} /> : data.data && (
        <EarningsBody d={data.data} fmtDate={fmtDate} />
      )}
    </div>
  );
}

function EarningsBody({ d, fmtDate }: { d: MyEarnings; fmtDate: (iso: string | undefined, withTime?: boolean) => string }) {
  const t = d.totals;
  return (
    <>
      <Kpis items={[
        { label: 'Acquise', value: <Money items={t.acquise} empty="0" />, sub: 'à verser par le Trésor' },
        { label: 'Payée — rapprochement en cours', value: <Money items={t.confirmee} empty="0" /> },
        { label: 'En attente de paiement', value: <Money items={t.enAttente} empty="0" /> },
        { label: 'Ce mois-ci', value: <Money items={t.ceMois} empty="0" /> },
        { label: 'Pénalités', value: d.counts.penalites, sub: 'issues de vos constats' },
        { label: 'Paiements générés', value: d.counts.paiements, sub: 'après vos contrôles rouges' },
      ]} />
      {d.rules.length > 0 && (
        <div className="callout callout-info">
          <Icon name="shieldCheck" size={18} />
          <ul className="small earn-rules">{d.rules.map((r) => <li key={r}>{r}</li>)}</ul>
        </div>
      )}
      <section className="panel">
        <header className="panel-head"><div><h2 className="panel-title"><Icon name="cash" size={18} /> Détail des commissions</h2><p className="panel-sub">Base : recette publique rattachée à votre contrôle. Commission : {d.ratePct} % de cette base, dans la même devise.</p></div></header>
        {d.lines.length === 0 ? <EmptyState title="Aucune commission pour l’instant" icon="cash">Les commissions apparaissent lorsqu’un contrôle « rouge » aboutit à un paiement ou à une pénalité.</EmptyState> : (
          <DataTable<EarningLine> rows={d.lines} rowKey={(l) => `${l.source}-${l.reference}`} caption="Commissions"
            columns={[
              { key: 'src', label: 'Source', render: (l) => <StatusBadge tone={l.source === 'PENALITE' ? 'warning' : 'info'} label={SOURCE_LABEL[l.source]} /> },
              { key: 'ref', label: 'Référence', primary: true, render: (l) => <span className="mono">{l.reference}</span> },
              { key: 'plate', label: 'Plaque', render: (l) => <span className="pk-plate">{l.plate}</span> },
              { key: 'zone', label: 'Zone', render: (l) => l.zone },
              { key: 'at', label: 'Date', render: (l) => fmtDate(l.at, true) },
              { key: 'base', label: 'Base', num: true, render: (l) => <Money items={l.base} /> },
              { key: 'com', label: `Commission ${d.ratePct} %`, num: true, render: (l) => <strong><Money items={l.commission} /></strong> },
              { key: 'state', label: 'État', render: (l) => <StatusBadge tone={STATE_TONE[l.state] ?? 'neutral'} label={l.stateLabel || STATE_LABEL[l.state]} /> },
            ]} />
        )}
      </section>
    </>
  );
}

/** Commissions par agent (régie et pilotage). */
export function AgentCommissions() {
  const data = useApi(() => api<AgentsEarnings>('/v1/parking/agents/earnings'), []);
  const rate = data.data?.ratePct ?? 10;
  return (
    <section className="panel">
      <header className="panel-head"><div><h2 className="panel-title"><Icon name="cash" size={18} /> Commissions des agents ({rate} %)</h2><p className="panel-sub">Calculées sur la recette publique confirmée ou rapprochée et versées par le Trésor ; aucun encaissement par l’agent. Montants par devise, jamais additionnés entre devises.</p></div></header>
      {data.loading && !data.data ? <Loading /> : data.error ? <ErrorState error={data.error} onRetry={data.reload} /> : (
        <DataTable rows={data.data?.items ?? []} rowKey={(a) => a.agentId} caption="Commissions des agents" empty={<p className="muted small">Aucune commission.</p>}
          columns={[
            { key: 'name', label: 'Agent', primary: true, render: (a) => <>{a.agentName} <span className="mono small muted">{a.agentId}</span></> },
            { key: 'pen', label: 'Pénalités', num: true, render: (a) => a.counts.penalites },
            { key: 'pay', label: 'Paiements', num: true, render: (a) => a.counts.paiements },
            { key: 'acq', label: 'Acquise', render: (a) => <Money items={a.totals.acquise} empty="0" /> },
            { key: 'conf', label: 'Confirmée', render: (a) => <Money items={a.totals.confirmee} empty="0" /> },
            { key: 'wait', label: 'En attente', render: (a) => <Money items={a.totals.enAttente} empty="0" /> },
          ]} />
      )}
    </section>
  );
}
