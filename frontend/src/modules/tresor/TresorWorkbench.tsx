import { useState, type ReactNode } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { MoneyText } from '../../components/MoneyText';
import { StatusBadge } from '../../components/StatusBadge';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import ClosuresPanel from './ClosuresPanel';
import ExceptionQueues from './ExceptionQueues';
import OperationsPanel from './OperationsPanel';
import SuspensePanel from './SuspensePanel';
import VerificationJournal from './VerificationJournal';
import { hasRole, shortHash, type Overview } from './shared';
import './tresor.css';

type Tab = 'exceptions' | 'suspense' | 'operations' | 'closures' | 'verifications';

const TABS: { id: Tab; label: string; icon: string; roles: string[] }[] = [
  { id: 'exceptions', label: 'Files d’exception', icon: 'alert', roles: ['R17', 'R18', 'R22'] },
  { id: 'suspense', label: 'Suspens', icon: 'clock', roles: ['R17', 'R18', 'R22', 'R23'] },
  { id: 'operations', label: 'Double validation', icon: 'users', roles: ['R17', 'R18', 'R20', 'R12', 'R22', 'R23'] },
  { id: 'closures', label: 'Clôtures et comptabilisation', icon: 'lock', roles: ['R17', 'R18', 'R22', 'R23', 'R05'] },
  { id: 'verifications', label: 'Vérifications publiques', icon: 'qr', roles: ['R17', 'R22', 'R24', 'R28'] },
];

function Kpi({ label, value, sub, tone, toneLabel }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'good' | 'warning' | 'critical'; toneLabel?: string }) {
  return (
    <div className="kpi">
      <p className="kpi-label">{label}</p>
      <p className="kpi-value">{value}</p>
      <div className="kpi-foot">{tone && toneLabel && <StatusBadge tone={tone} label={toneLabel} />}{sub && <span className="kpi-sub">{sub}</span>}</div>
    </div>
  );
}

/** Poste de travail du Trésor avancé : synthèse + onglets selon le rôle. */
export default function TresorWorkbench({ onChanged }: { onChanged?: () => void }) {
  const { user, fmtDate } = useApp();
  const tabs = TABS.filter((t) => hasRole(user?.roles, ...t.roles));
  const [tab, setTab] = useState<Tab>('exceptions');
  const current = tabs.find((t) => t.id === tab) ?? tabs[0];
  const ov = useApi(hasRole(user?.roles, 'R17', 'R18', 'R22', 'R23', 'R05') ? () => api<Overview>('/v1/tresor/overview') : null, [user?.id]);
  const refresh = () => { ov.reload(); onChanged?.(); };
  if (!current) return null;
  const o = ov.data;
  return (
    <div className="tr-workbench">
      {o && (
        <div className="kpi-row tr-kpis">
          <Kpi label="Exceptions à traiter" value={o.exceptions.open} tone={o.exceptions.overdue ? 'critical' : 'good'} toneLabel={o.exceptions.overdue ? `${o.exceptions.overdue} > 48 h` : 'Dans les délais'} sub={o.exceptions.unassigned ? `${o.exceptions.unassigned} non affectée(s)` : undefined} />
          <Kpi label="Suspens ouverts" value={o.suspense.open} sub={o.suspense.totals.length ? <>{o.suspense.totals.map((m: MoneyJSON) => <MoneyText key={m.currency} money={m} showIndicative={false} />)} · {o.suspense.oldestDays} j max.</> : 'Aucun'} />
          <Kpi label="Opérations à valider" value={o.operations.pending} tone={o.operations.pending ? 'warning' : 'good'} toneLabel={o.operations.pending ? 'Quatre yeux requis' : 'Aucune'} />
          <Kpi label="Dernière clôture" value={o.closures.lastClosedDate ? fmtDate(o.closures.lastClosedDate) : '—'} tone={o.closures.chainValid ? 'good' : 'critical'} toneLabel={o.closures.chainValid ? 'Chaîne intègre' : 'Chaîne rompue'} sub={<span className="mono">{shortHash(o.closures.lastHash)}</span>} />
          <Kpi label="Comptabilisés" value={o.accounting.imputed} sub={o.accounting.unimputed ? `${o.accounting.unimputed} rapproché(s) à imputer` : 'Tout est imputé'} />
        </div>
      )}
      <div className="seg seg-wrap tr-tabs" role="tablist" aria-label="Trésor avancé">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={current.id === t.id} aria-pressed={current.id === t.id} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} size={16} /> {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" aria-label={current.label}>
        {current.id === 'exceptions' && <ExceptionQueues onChanged={refresh} />}
        {current.id === 'suspense' && <SuspensePanel />}
        {current.id === 'operations' && <OperationsPanel onChanged={refresh} />}
        {current.id === 'closures' && <ClosuresPanel onChanged={refresh} />}
        {current.id === 'verifications' && <VerificationJournal />}
      </div>
    </div>
  );
}
