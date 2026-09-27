/**
 * Tableau du pilote de 180 jours (§ 45.1, § 45.3, § 45.5) : Gombe, Limete, Kalamu, Ngaliema comparées aux communes
 * témoins ; critères de succès du Cahier ; revues signées aux jalons (J30 … J180), vérifiables et immuables.
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import { COMMUNES, Section } from './shared';
import { Callout, Field, hasRole, Notice, useRunner } from './planif';
import './pilotage.css';

interface Criterion { code: string; label: string; threshold: string; pilot: { value: string | null; unit: string; met: boolean | null; note?: string }; controls: { value: string | null; unit: string; note?: string }; gapPoints: string | null; status: string; note: string }
export interface PilotBoard {
  day: number | null; period: { from: string; to: string }; protocol: string;
  config: { startDate: string | null; communes: string[]; controls: string[]; setBy: string | null; motif: string | null };
  milestones: { milestone: string; days: number; dueDate: string | null; reached: boolean; signed: { id: string; takenAt: string; sha256: string } | null }[];
  criteria: Criterion[]; baseline: { id: string; period: string } | null;
  snapshots: { id: string; milestone: string; takenAt: string; takenBy: string; sha256: string }[];
}

const STATUS: Record<string, { label: string; tone: 'good' | 'critical' | 'neutral' | 'info' }> = {
  ATTEINT: { label: 'Atteint', tone: 'good' }, NON_ATTEINT: { label: 'Non atteint', tone: 'critical' }, NON_MESURE: { label: 'Non mesuré', tone: 'neutral' }, A_APPRECIER: { label: 'À apprécier (évaluation indépendante)', tone: 'info' },
};
const val = (v: string | null, unit: string) => (v === null ? '—' : `${v}${unit === '%' ? ' %' : unit === 's' ? ' s' : ''}`);

export function PilotView({ b, onDone }: { b: PilotBoard; onDone: () => void }) {
  const { user } = useApp();
  const r = useRunner(onDone);
  const [cfg, setCfg] = useState({ startDate: b.config.startDate ?? '', controls: b.config.controls.join(', '), motif: '' });
  const canSign = hasRole(user?.roles, 'R01', 'R05', 'R22', 'R23');
  return (
    <div className="dash-grid">
      <Section title="Communes pilotes et communes témoins" sub={b.config.startDate ? `Démarrage le ${b.config.startDate} — jour ${b.day}` : 'Date de démarrage non fixée'}>
        <p className="small"><strong>Pilotes :</strong> {b.config.communes.join(', ')} · <strong>Témoins :</strong> {b.config.controls.length ? b.config.controls.join(', ') : 'aucune désignée'}</p>
        {!b.baseline && <Callout tone="warn">Base de référence auditée absente : la progression comparée n’est pas mesurée (§ 45.5).</Callout>}
        <p className="small muted">{b.protocol}</p>
      </Section>
      <Section title="Critères de succès (§ 45.3)" sub="Seuils du Cahier ; valeurs calculées sur les données réelles de chaque groupe">
        <DataTable caption="Critères du pilote" rows={b.criteria} rowKey={(c) => c.code} columns={[
          { key: 'l', label: 'Critère', primary: true, render: (c) => <><strong>{c.label}</strong><span className="small muted" style={{ display: 'block' }}>Seuil : {c.threshold}</span></> },
          { key: 'p', label: 'Communes pilotes', num: true, render: (c) => val(c.pilot.value, c.pilot.unit) },
          { key: 't', label: 'Communes témoins', num: true, render: (c) => val(c.controls.value, c.controls.unit) },
          { key: 'g', label: 'Écart (points)', num: true, render: (c) => c.gapPoints ?? '—' },
          { key: 's', label: 'Statut', render: (c) => <><StatusBadge tone={STATUS[c.status]?.tone ?? 'neutral'} label={STATUS[c.status]?.label ?? c.status} />{c.note && <span className="small muted" style={{ display: 'block' }}>{c.note}</span>}</> },
        ]} />
      </Section>
      <Section title="Revues signées (J30 … J180)" sub="Instantané figé et signé à chaque jalon ; vérifiable par l’outil de vérification des exports">
        <Notice msg={r.msg} />
        <DataTable caption="Jalons" rows={b.milestones} rowKey={(m) => m.milestone} columns={[
          { key: 'm', label: 'Jalon', primary: true, render: (m) => <strong>{m.milestone}</strong> },
          { key: 'd', label: 'Échéance', render: (m) => m.dueDate ?? '—' },
          { key: 's', label: 'Revue', render: (m) => (m.signed ? <span className="small">Signée le {m.signed.takenAt.slice(0, 10)} · <code className="hash">{m.signed.sha256.slice(0, 16)}…</code></span> : m.reached && canSign
            ? <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/pilotage/pilote/revues/${m.milestone}`, {}, `Revue ${m.milestone} signée.`)}>Signer la revue</button>
            : <span className="small muted">{m.reached ? 'À signer (audit, Finances, Gouverneur)' : 'Jalon non atteint'}</span>) },
        ]} />
      </Section>
      {hasRole(user?.roles, 'R01', 'R05') && (
        <Section title="Configuration du protocole" sub="Date de démarrage et communes témoins (jamais une commune pilote) ; figée après la première revue signée">
          <div className="form">
            <Field label="Date de démarrage" type="date" value={cfg.startDate} onChange={(v) => setCfg({ ...cfg, startDate: v })} />
            <Field label="Communes témoins (séparées par des virgules)" value={cfg.controls} onChange={(v) => setCfg({ ...cfg, controls: v })} hint={`Communes : ${COMMUNES.filter((c) => !b.config.communes.includes(c)).join(', ')}`} />
            <Field label="Motif (10 caractères minimum)" value={cfg.motif} onChange={(v) => setCfg({ ...cfg, motif: v })} />
            <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run('/v1/pilotage/pilote/configuration', { startDate: cfg.startDate, controls: cfg.controls.split(',').map((x) => x.trim()).filter(Boolean), motif: cfg.motif }, 'Protocole enregistré.')}>Enregistrer</button></div>
          </div>
        </Section>
      )}
    </div>
  );
}

export default function Pilote() {
  const { user } = useApp();
  const q = useApi(() => api<PilotBoard>('/v1/pilotage/pilote'), [user?.id]);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Pilotage · § 45" title="Pilote de 180 jours" lead="Communes pilotes comparées aux communes témoins, sur une base de référence auditée ; décision de généralisation sur résultats vérifiés de façon indépendante." />
      {q.loading && !q.data ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : q.data && <PilotView b={q.data} onDone={q.reload} />}
    </div>
  );
}
