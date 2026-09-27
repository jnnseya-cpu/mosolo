/**
 * Registre des modèles d'IA (§ 23.1) : modèles, versions, jeux de données approuvés, évaluations, tests de biais,
 * suivi de dérive calculé sur le journal réel, mise en service à deux personnes et retour arrière.
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import { Section } from '../pilotage/shared';
import { Field, hasRole, Notice, useRunner } from '../pilotage/planif';
import '../pilotage/pilotage.css';
import { type Indicator } from '../decision/commun';
import { IndicateursVisuels } from '../plateforme/visuels';
import { JEU_STATUS, ModelesVisuels } from './visuels';

interface Version { id: string; version: string; status: string; datasetIds: string[]; evaluations: unknown[]; biasTests: { passed: boolean }[]; registeredBy: string; builtin?: boolean; promotion?: { proposedBy: string }; replaces?: string }
interface Model { code: string; label: string; kind: string; purpose: string; versions: Version[] }
interface Dataset { id: string; code: string; label: string; source: string; legalBasis: string; status: string; sensitive: boolean; proposedBy: string }
interface Row { modelVersion: string; registered: boolean; decisions: number; acceptancePct: number | null; window: { recentPct: number | null; previousPct: number | null; driftPoints: number | null; driftAlert: boolean }; bias: { gapPoints: number | null; alert: boolean } }
interface PromptRow { agent: string; name: string; current: string; sheet: { mission: string; never: string; autonomy: string; allowedActions: string[] }; versions: { promptVersion: string; current: boolean; registered: boolean; inModels: { id: string; status: string }[]; recommendations: number; decisions: number; acceptancePct: string | null }[] }
export interface RegistryView { prompts?: PromptRow[]; indicators?: Indicator[]; kinds: Record<string, string>; models: Model[]; datasets: Dataset[]; governance: string[]; monitoring: { params: { derivePoints: number; biasPoints: number; windowDays: number; minDecisions: number; status: string }; rows: Row[]; note: string } }

export const VERSION_STATUS: Record<string, { label: string; tone: Tone }> = {
  ENREGISTREE: { label: 'Enregistrée', tone: 'info' }, MISE_EN_SERVICE_PROPOSEE: { label: 'Mise en service proposée', tone: 'warning' }, EN_SERVICE: { label: 'En service', tone: 'good' }, RETIREE: { label: 'Retirée', tone: 'neutral' },
};

export default function ModelesPage() {
  const { user } = useApp();
  const q = useApi(() => api<RegistryView>('/v1/ia/modeles'), [user?.id]);
  const r = useRunner(q.reload);
  const [motif, setMotif] = useState('');
  const d = q.data;
  return (
    <div className="page page-wide">
      <PageHead eyebrow="IA · § 23.1" title="Registre des modèles d’IA" lead="Versions, jeux de données, évaluations, biais, dérive et explicabilité ; validation humaine à deux personnes avant mise en service ; retour arrière possible." />
      <Notice msg={r.msg} />
      {q.loading && !d ? <Loading /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : d && (
        <div className="dash-grid">
          <Section title="Vue d’ensemble du registre"><ModelesVisuels d={d} /></Section>
          <Section title="Modèles et versions">
            {d.models.map((m) => (
              <div key={m.code} style={{ marginBottom: 12 }}>
                <p><strong>{m.label}</strong> <span className="small muted">({d.kinds[m.kind] ?? m.kind}) — {m.purpose}</span></p>
                <DataTable caption={`Versions ${m.code}`} rows={m.versions} rowKey={(v) => v.id} columns={[
                  { key: 'v', label: 'Version', primary: true, render: (v) => <span className="mono">{v.version}</span> },
                  { key: 's', label: 'Statut', render: (v) => <StatusBadge tone={VERSION_STATUS[v.status]?.tone ?? 'neutral'} label={VERSION_STATUS[v.status]?.label ?? v.status} /> },
                  { key: 'e', label: 'Évaluations / biais', num: true, render: (v) => `${v.evaluations.length} / ${v.biasTests.filter((b) => b.passed).length} réussi(s)` },
                  { key: 'a', label: 'Actions', render: (v) => (
                    <div className="btn-row">
                      {v.status === 'ENREGISTREE' && hasRole(user?.roles, 'R29') && <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy || motif.trim().length < 10} onClick={() => void r.run(`/v1/ia/modeles/versions/${encodeURIComponent(v.id)}/mise-en-service`, { motif }, 'Mise en service proposée.')}>Proposer la mise en service</button>}
                      {v.status === 'MISE_EN_SERVICE_PROPOSEE' && hasRole(user?.roles, 'R29', 'R22', 'R28') && v.promotion?.proposedBy !== user?.id && v.registeredBy !== user?.id && (
                        <button type="button" className="btn btn-primary btn-sm" disabled={r.busy || motif.trim().length < 10} onClick={() => void r.run(`/v1/ia/modeles/versions/${encodeURIComponent(v.id)}/mise-en-service/decision`, { approve: true, motif }, 'Version mise en service.')}>Approuver</button>
                      )}
                      {v.status === 'EN_SERVICE' && v.replaces && hasRole(user?.roles, 'R29', 'R28') && <button type="button" className="btn btn-ghost btn-sm" disabled={r.busy || motif.trim().length < 10} onClick={() => void r.run(`/v1/ia/modeles/versions/${encodeURIComponent(v.id)}/retour-arriere`, { motif }, 'Retour arrière effectué.')}>Retour arrière</button>}
                    </div>
                  ) },
                ]} />
              </div>
            ))}
            <Field label="Motif (10 caractères minimum)" value={motif} onChange={setMotif} />
          </Section>
          {d.indicators && <Section title="Indicateurs (module 49)"><IndicateursVisuels items={d.indicators} /></Section>}
          {d.prompts && (
            <Section title="Registre des prompts (versions)" sub="La version de prompt est l’empreinte de la fiche de contrôle de l’agent : toute modification crée une nouvelle version ; une version observée non inscrite est signalée. Coupe-circuit : écran des agents d’IA.">
              <DataTable caption="Prompts" rows={d.prompts.flatMap((a) => a.versions.map((v) => ({ ...v, agent: a.name, never: a.sheet.never })))} rowKey={(x) => `${x.agent}-${x.promptVersion}`} columns={[
                { key: 'a', label: 'Agent', primary: true, render: (x) => <><strong>{x.agent}</strong><span className="small muted" style={{ display: 'block' }}>Interdits : {x.never}</span></> },
                { key: 'v', label: 'Version de prompt', render: (x) => <><span className="mono">{x.promptVersion}</span> {x.current && <StatusBadge tone="info" label="Courante" />} {!x.registered && <StatusBadge tone="critical" label="Non inscrite" />}</> },
                { key: 'm', label: 'Versions de modèle', render: (x) => x.inModels.map((m) => `${m.id} (${m.status})`).join(', ') || '—' },
                { key: 'd', label: 'Recommandations / décisions', num: true, render: (x) => `${x.recommendations} / ${x.decisions}` },
                { key: 't', label: 'Acceptation', num: true, render: (x) => (x.acceptancePct === null ? '—' : `${x.acceptancePct} %`) },
              ]} />
            </Section>
          )}
          <Section title="Suivi de dérive et de biais" sub={`${d.monitoring.note} Seuils : ${d.monitoring.params.derivePoints} points (dérive), ${d.monitoring.params.biasPoints} points (biais), ${d.monitoring.params.minDecisions} décisions minimum — ${d.monitoring.params.status}.`}>
            <DataTable caption="Suivi" rows={d.monitoring.rows} rowKey={(x) => x.modelVersion} columns={[
              { key: 'v', label: 'Version observée', primary: true, render: (x) => <>{x.modelVersion} {!x.registered && <StatusBadge tone="critical" label="Non enregistrée" />}</> },
              { key: 'd', label: 'Décisions', num: true, render: (x) => x.decisions },
              { key: 'a', label: 'Acceptation', num: true, render: (x) => (x.acceptancePct === null ? '—' : `${x.acceptancePct} %`) },
              { key: 'w', label: 'Dérive (points)', num: true, render: (x) => (x.window.driftPoints === null ? 'non calculée' : <StatusBadge tone={x.window.driftAlert ? 'critical' : 'good'} label={String(x.window.driftPoints)} />) },
              { key: 'b', label: 'Écart entre entités', num: true, render: (x) => (x.bias.gapPoints === null ? 'non calculé' : <StatusBadge tone={x.bias.alert ? 'critical' : 'good'} label={String(x.bias.gapPoints)} />) },
            ]} />
          </Section>
          <Section title="Jeux de données" sub="Approuvés, datés et documentés par le délégué à la protection des données ; aucune donnée sensible sans base légale">
            <DataTable caption="Jeux" rows={d.datasets} rowKey={(x) => x.id} columns={[
              { key: 'l', label: 'Jeu', primary: true, render: (x) => <><strong>{x.label}</strong><span className="small muted" style={{ display: 'block' }}>{x.code} · {x.source} · {x.legalBasis}</span></> },
              { key: 's', label: 'Statut', render: (x) => <StatusBadge tone={x.status === 'APPROUVE' ? 'good' : x.status === 'REFUSE' ? 'critical' : 'warning'} label={JEU_STATUS[x.status]?.label ?? x.status} /> },
              { key: 'a', label: 'Décision', render: (x) => (x.status === 'PROPOSE' && hasRole(user?.roles, 'R25') && x.proposedBy !== user?.id ? <button type="button" className="btn btn-primary btn-sm" disabled={r.busy || motif.trim().length < 10} onClick={() => void r.run(`/v1/ia/jeux-donnees/${x.id}/decision`, { approve: true, motif }, 'Jeu approuvé.')}>Approuver</button> : '—') },
            ]} />
            <ul className="small">{d.governance.map((g) => <li key={g}>{g}</li>)}</ul>
          </Section>
        </div>
      )}
    </div>
  );
}
