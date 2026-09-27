/**
 * Collusion sous « quatre yeux » : paires proposant → valideur, validations express, hors heures, valideurs qui ne
 * refusent jamais, plafond de rotation. Signaux à examiner — jamais de sanction automatique.
 */
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { StatusBadge } from '../../components/StatusBadge';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { useApp } from '../../context';
import { ActionError, hasRole, Kpi, useAction } from './shared';
import './integrite.css';

export interface CollusionFinding {
  code: string; label: string; severity: 'MEDIUM' | 'HIGH'; subjects: string[]; explanation: string;
  variables: { name: string; value: string }[]; evidence: string[]; fingerprint: string;
}
export interface CollusionPair { proposerId: string; approverId: string; approvals: number; refusals: number; sharePct: number; fast: number; offHours: number; inRotationWindow: number; circuits: string[] }
export interface CollusionApprover { approverId: string; decisions: number; approvals: number; refusals: number; fast: number; offHours: number; medianDelaySeconds: number | null; proposers: number }
export interface CollusionReport {
  generatedAt: string;
  params: {
    windowDays: number; pairShareMinPct: number; pairDecisionsMin: number; fastSeconds: number; fastMinCount: number;
    workStartHour: number; workEndHour: number; offHoursMinCount: number; neverRefuseMin: number;
    rotationEnforced: boolean; rotationMaxPerPair: number; rotationWindowDays: number; statut: string; rotationStatut: string;
  };
  circuits: { code: string; label: string; guarded: boolean; decisions: number }[];
  totals: { decisions: number; approvals: number; refusals: number; pairs: number };
  pairs: CollusionPair[];
  approvers: CollusionApprover[];
  findings: CollusionFinding[];
  masked: number;
  rotation: { enforced: boolean; maxPerPair: number; windowDays: number; atLimit: { proposerId: string; approverId: string; count: number }[] };
  automaticEffect: 'AUCUN';
  note: string;
}

const READ = ['R22', 'R23', 'R24', 'R28', 'R06'];
const RUN = ['R22', 'R24', 'R28'];

const delay = (s: number | null) => (s === null ? '—' : s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);

/** Vue du rapport (sans chargement) : réutilisable et testable. */
export function CollusionView({ report }: { report: CollusionReport }) {
  const p = report.params;
  return (
    <>
      <div className="kpi-row ig-kpis">
        <Kpi label="Décisions à deux personnes" value={report.totals.decisions} sub={`${p.windowDays} derniers jours`} />
        <Kpi label="Refus" value={report.totals.refusals} sub={`${report.totals.approvals} approbation(s)`} />
        <Kpi label="Signaux à examiner" value={report.findings.length} sub={report.masked ? `${report.masked} masqué(s) : vous concernent` : 'aucun effet automatique'} />
        <Kpi label="Rotation obligatoire" value={<span className="ig-kpi-text">{report.rotation.enforced ? 'Blocage actif' : 'Alerte seulement'}</span>}
          sub={`${report.rotation.maxPerPair} validations / paire / ${report.rotation.windowDays} j`} />
      </div>
      <p className="callout callout-info ig-note"><Icon name="info" size={18} /><span>{report.note} Seuils : {p.statut}.</span></p>

      <section className="panel" aria-labelledby="col-findings">
        <h2 className="panel-title" id="col-findings">Signaux</h2>
        {report.findings.length === 0 ? <EmptyState title="Aucun signal" icon="check">Aucune décision ne franchit les seuils sur la période.</EmptyState> : (
          <ul className="plain-list ig-stack">
            {report.findings.map((f) => (
              <li key={f.fingerprint} className="ig-block">
                <p className="ig-inline">
                  <StatusBadge tone={f.severity === 'HIGH' ? 'serious' : 'warning'} label={f.label} />
                  <span className="small mono">{f.subjects.join(' → ')}</span>
                </p>
                <p className="small">{f.explanation}</p>
                <ul className="plain-list small muted">
                  {f.variables.map((v) => <li key={v.name}>{v.name} : {v.value}</li>)}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="col-pairs">
        <h2 className="panel-title" id="col-pairs">Paires proposant → valideur</h2>
        <DataTable rows={report.pairs} rowKey={(x) => `${x.proposerId}>${x.approverId}`} caption="Paires proposant → valideur"
          empty={<EmptyState title="Aucune décision à deux personnes" icon="users" />}
          columns={[
            { key: 'p', label: 'Paire', primary: true, render: (x) => <span className="mono small">{x.proposerId} → {x.approverId}</span> },
            { key: 's', label: 'Part du proposant', num: true, render: (x) => <span className={x.sharePct >= p.pairShareMinPct ? 'ig-danger' : undefined}>{x.sharePct} %</span> },
            { key: 'a', label: 'Approuvées / refusées', num: true, render: (x) => `${x.approvals} / ${x.refusals}` },
            { key: 'f', label: 'Express', num: true, render: (x) => x.fast },
            { key: 'o', label: 'Hors heures', num: true, render: (x) => x.offHours },
            { key: 'r', label: `Rotation (${p.rotationWindowDays} j)`, num: true, render: (x) => <span className={x.inRotationWindow >= p.rotationMaxPerPair ? 'ig-danger' : undefined}>{x.inRotationWindow} / {p.rotationMaxPerPair}</span> },
            { key: 'c', label: 'Circuits', full: true, render: (x) => <span className="small muted">{x.circuits.join(', ')}</span> },
          ]} />
      </section>

      <section className="panel" aria-labelledby="col-approvers">
        <h2 className="panel-title" id="col-approvers">Valideurs</h2>
        <DataTable rows={report.approvers} rowKey={(x) => x.approverId} caption="Valideurs"
          columns={[
            { key: 'v', label: 'Valideur', primary: true, render: (x) => <span className="mono small">{x.approverId}</span> },
            { key: 'd', label: 'Décisions', num: true, render: (x) => x.decisions },
            { key: 'r', label: 'Refus', num: true, render: (x) => <span className={x.refusals === 0 && x.decisions >= p.neverRefuseMin ? 'ig-danger' : undefined}>{x.refusals}</span> },
            { key: 'm', label: 'Délai médian', num: true, render: (x) => delay(x.medianDelaySeconds) },
            { key: 'f', label: `Express (< ${p.fastSeconds} s)`, num: true, render: (x) => x.fast },
            { key: 'o', label: 'Hors heures', num: true, render: (x) => x.offHours },
            { key: 'n', label: 'Proposants', num: true, render: (x) => x.proposers },
          ]} />
      </section>

      <section className="panel" aria-labelledby="col-circuits">
        <h2 className="panel-title" id="col-circuits">Circuits suivis</h2>
        <ul className="plain-list small">
          {report.circuits.map((c) => (
            <li key={c.code}>{c.label} — {c.decisions} décision(s){c.guarded ? ' · garde de rotation' : ''}</li>
          ))}
        </ul>
        <p className="hint">Heures ouvrables : {p.workStartHour} h – {p.workEndHour} h, lundi au vendredi (heure de Kinshasa). Paramètres : {p.rotationStatut}.</p>
      </section>
    </>
  );
}

export default function Collusion() {
  const { user } = useApp();
  const allowed = hasRole(user?.roles, ...READ);
  const canRun = hasRole(user?.roles, ...RUN);
  const rep = useApi(allowed ? () => api<CollusionReport>('/v1/integrite/collusion') : null, [user?.id]);
  const a = useAction();

  if (!allowed) {
    return <div className="page"><PageHead eyebrow="Intégrité" title="Collusion sous quatre yeux" /><EmptyState title="Accès réservé" icon="lock">Réservé à l’audit, à l’anti-fraude, à la sécurité et à la direction de la régie.</EmptyState></div>;
  }
  return (
    <div className="page page-wide ig-page">
      <PageHead eyebrow="Intégrité" title="Collusion sous quatre yeux"
        lead="Qui valide qui, à quelle vitesse, à quelle heure et avec quel taux de refus : des signaux explicables, examinés par un humain.">
        {canRun && (
          <button type="button" className="btn btn-primary" disabled={a.busy} onClick={async () => { if (await a.run(() => api('/v1/integrite/collusion/run', { method: 'POST', body: {} }))) rep.reload(); }}>
            <Icon name="alert" size={18} /> Lever les alertes
          </button>
        )}
      </PageHead>
      <ActionError error={a.error} />
      {rep.loading && <Loading />}
      {rep.error !== null && <ErrorState error={rep.error} onRetry={rep.reload} />}
      {rep.data && <CollusionView report={rep.data} />}
    </div>
  );
}
