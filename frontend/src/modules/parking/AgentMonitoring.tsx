/**
 * Surveillance des constats par agent (recommandation retenue) : la commission de 10 % sur les pénalités crée une
 * incitation à multiplier les constats ; ce tableau la rend visible, module par module. Les SIGNAUX comparent l'agent
 * à la médiane de ses pairs ; ils ouvrent un examen humain (superviseur, contrôle mystère) et n'entraînent AUCUNE
 * mesure automatique.
 */
import { Fragment, useState } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { Kpis, pctText } from './shared';
import './parking.css';

interface Stats { controls: number; defects: number; constats: number; rejected: number; retained: number; dismissed: number; contested: number; annulled: number; weakEvidence: number }
interface ModuleStats extends Stats { module: string; moduleLabel: string }
interface Signal { code: string; module: string; level: 'A_EXAMINER' | 'INFO'; text: string }
interface Row { agentId: string; agentName: string; modules: ModuleStats[]; totals: Stats; constatRatePct: string | null; penaltyCommissionSharePct: string | null; signals: Signal[] }
interface Report { generatedAt: string; thresholds: Record<string, number>; rows: Row[]; notice: string }

const COLS: { k: keyof Stats; label: string; title: string }[] = [
  { k: 'controls', label: 'Contrôles', title: 'Contrôles, inspections ou visites réalisés' },
  { k: 'defects', label: 'Défauts', title: 'Contrôles avec défaut relevé' },
  { k: 'constats', label: 'Constats', title: 'Constats ou dossiers ouverts' },
  { k: 'rejected', label: 'Écartés', title: 'Écartés à la vérification (preuves insuffisantes)' },
  { k: 'retained', label: 'Retenus', title: 'Retenus par la décision' },
  { k: 'dismissed', label: 'Classés', title: 'Classés sans suite' },
  { k: 'contested', label: 'Contestés', title: 'Contestés par l’usager' },
  { k: 'annulled', label: 'Annulés', title: 'Pénalités annulées' },
  { k: 'weakEvidence', label: 'Preuves faibles', title: 'Photos ou positions imprécises (GPS absent ou > 50 m, horloge décalée)' },
];

export default function AgentMonitoringPage() {
  const { user, fmtDate } = useApp();
  const data = useApi(() => api<Report>('/v1/agents/monitoring'), [user?.id]);
  const [onlySignals, setOnlySignals] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const d = data.data;
  const rows = (d?.rows ?? []).filter((r) => !onlySignals || r.signals.some((s) => s.level === 'A_EXAMINER'));
  const flagged = (d?.rows ?? []).filter((r) => r.signals.some((s) => s.level === 'A_EXAMINER')).length;
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Inspection des services · tous modules" title="Surveillance des constats"
        lead="Constats par agent et par module, comparés à la médiane des pairs. Un signal ouvre un examen humain ; il n’entraîne aucune mesure automatique.">
        <button type="button" className="btn btn-secondary btn-sm" onClick={data.reload}><Icon name="refresh" size={16} /> Actualiser</button>
      </PageHead>
      {data.loading && !d ? <Loading /> : data.error ? <ErrorState error={data.error} onRetry={data.reload} /> : d && (
        <>
          <Kpis items={[
            { label: 'Agents suivis', value: d.rows.length },
            { label: 'À examiner', value: flagged, sub: 'au moins un signal' },
            { label: 'Constats', value: d.rows.reduce((a, r) => a + r.totals.constats, 0) },
            { label: 'Calculé le', value: fmtDate(d.generatedAt, true) },
          ]} />
          <div className="callout callout-info"><Icon name="shieldCheck" size={18} /><p className="small" style={{ margin: 0 }}>{d.notice}</p></div>
          <section className="panel">
            <header className="panel-head">
              <div><h2 className="panel-title"><Icon name="users" size={18} /> Agents</h2><p className="panel-sub">Les agents avec signaux apparaissent en premier. Ouvrez une ligne pour le détail par module.</p></div>
              <label className="small"><input type="checkbox" checked={onlySignals} onChange={(e) => setOnlySignals(e.target.checked)} /> Seulement « à examiner »</label>
            </header>
            {rows.length === 0 ? <EmptyState title="Aucun agent à afficher" icon="users">Aucun contrôle enregistré dans votre périmètre.</EmptyState> : (
              <div className="rtable-wrap">
                <table className="data-table mon-table">
                  <caption className="sr-only">Surveillance des constats par agent</caption>
                  <thead><tr><th scope="col">Agent</th>{COLS.map((c) => <th key={c.k} scope="col" className="num" title={c.title}>{c.label}</th>)}<th scope="col" className="num">Taux de constats</th><th scope="col" className="num">Commission issue de pénalités</th><th scope="col">Signaux</th></tr></thead>
                  <tbody>
                    {rows.map((r) => {
                      const ex = r.signals.filter((s) => s.level === 'A_EXAMINER').length;
                      const isOpen = open === r.agentId;
                      return (
                        <Fragment key={r.agentId}>
                          <tr className={ex ? 'mon-flag' : undefined}>
                            <th scope="row"><button type="button" className="btn-link" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.agentId)}>{r.agentName}</button><div className="small muted mono">{r.agentId}</div></th>
                            {COLS.map((c) => <td key={c.k} className="num">{r.totals[c.k]}</td>)}
                            <td className="num">{r.constatRatePct ? pctText(r.constatRatePct) : '—'}</td>
                            <td className="num">{r.penaltyCommissionSharePct ? pctText(r.penaltyCommissionSharePct) : '—'}</td>
                            <td>{ex ? <StatusBadge tone="warning" label={`${ex} à examiner`} /> : r.signals.length ? <StatusBadge tone="info" label="À suivre" /> : <StatusBadge tone="good" label="Aucun" />}</td>
                          </tr>
                          {isOpen && (
                            <tr className="mon-detail"><td colSpan={COLS.length + 4}>
                              {r.signals.length > 0 && <ul className="mon-signals">{r.signals.map((s) => <li key={`${s.code}-${s.module}`}><StatusBadge tone={s.level === 'A_EXAMINER' ? 'warning' : 'info'} label={s.level === 'A_EXAMINER' ? 'À examiner' : 'Info'} /> {s.text}</li>)}</ul>}
                              <table className="data-table mon-sub"><thead><tr><th scope="col">Module</th>{COLS.map((c) => <th key={c.k} scope="col" className="num">{c.label}</th>)}</tr></thead>
                                <tbody>{r.modules.map((m) => <tr key={m.module}><th scope="row">{m.moduleLabel}</th>{COLS.map((c) => <td key={c.k} className="num">{m[c.k]}</td>)}</tr>)}</tbody></table>
                            </td></tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <p className="small muted">Seuils actuels (à valider par l’inspection des services) : au moins {d.thresholds.minControls} contrôles ; taux de constats supérieur à {d.thresholds.constatRateVsMedian} × la médiane des pairs ; écartés ≥ {d.thresholds.rejectionPct} % ; classés ≥ {d.thresholds.dismissalPct} % ; contestés ou annulés ≥ {d.thresholds.contestPct} % ; preuves faibles ≥ {d.thresholds.weakEvidencePct} % ; pénalités ≥ {d.thresholds.penaltySharePct} % de la commission (information).</p>
        </>
      )}
    </div>
  );
}
