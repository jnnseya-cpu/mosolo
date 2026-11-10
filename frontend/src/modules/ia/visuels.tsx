/**
 * Couche d'intelligence — visuels (trousse de visualisation, 27/09/2026) : dérivés des recommandations, agents,
 * paramètres, mémoire et journal que chaque vue charge déjà. L'IA propose, une personne décide : les graphiques
 * montrent l'état des décisions humaines, jamais une décision automatique.
 */
import { countBy } from '../../lib/aggregate';
import { BarChartViz, ChartGrid, fmtNombre, KpiGrid, KpiTile, ProgressMeter, StackedBarViz } from '../../components/viz';
import { ActiviteParJour, Barres, barresDe, Etats, etatsDe, Parts, serieParJour } from '../plateforme/visuels';
import '../plateforme/visuels.css';
import { AUTONOMY_LABEL, JOURNAL_LABEL, STATUS_LABEL, STATUS_TONE } from './labels';
import type { IaAgent, IaRec, JournalEntry } from './types';

const ETATS_REC = Object.fromEntries(Object.entries(STATUS_LABEL).map(([k, l]) => [k, { label: l, tone: STATUS_TONE[k as keyof typeof STATUS_TONE] }]));
const ORDRE_REC = ['EMISE', 'TRAITEE_AUTO', 'ACCEPTEE', 'MODIFIEE', 'REJETEE', 'ANNULEE'];

export function BoiteVisuels({ recs }: { recs: IaRec[] }) {
  const s = serieParJour(recs, (r) => r.createdAt, 14);
  const decidees = recs.filter((r) => ['ACCEPTEE', 'MODIFIEE', 'REJETEE'].includes(r.status));
  const acceptees = decidees.filter((r) => r.status !== 'REJETEE').length;
  const parAgent = [...new Set(recs.map((r) => r.agent))].map((a) => {
    const it = recs.filter((r) => r.agent === a);
    return { key: a, label: a, values: { e: it.filter((r) => r.status === 'EMISE').length, d: it.filter((r) => ['ACCEPTEE', 'MODIFIEE', 'REJETEE'].includes(r.status)).length, a: it.filter((r) => ['TRAITEE_AUTO', 'ANNULEE'].includes(r.status)).length } };
  }).sort((x, y) => (y.values.e + y.values.d + y.values.a) - (x.values.e + x.values.d + x.values.a)).slice(0, 8);
  return (
    <div className="vz-bloc" data-testid="ia-boite-visuels">
      <Sparks s={s} />
      <ChartGrid min={280} label="Recommandations — graphiques">
        <Etats title="Recommandations par état" unitLabel="recommandations" example={recs.some((r) => r.example)} items={etatsDe(recs, (r) => r.status, ETATS_REC, ORDRE_REC)} emptyText="Aucune recommandation" />
        <Parts title="Par niveau d’autonomie" centerLabel="recommandations" emptyText="Aucune recommandation"
          slices={countBy(recs, (r) => r.autonomy).map((c) => ({ key: c.key, label: AUTONOMY_LABEL[c.key as keyof typeof AUTONOMY_LABEL] ?? c.key, value: c.count }))} />
        <ProgressMeter label="Part des recommandations décidées qui sont retenues (acceptées ou modifiées)" value={decidees.length ? (100 * acceptees) / decidees.length : null} unit="%"
          format={(v) => fmtNombre(v, 0)} reason="Aucune décision humaine encore." />
        <StackedBarViz className="viz-span-2" title="Recommandations par agent" subtitle="8 agents les plus actifs" mode="absolute"
          series={[{ key: 'e', label: 'À décider' }, { key: 'd', label: 'Décidées par une personne' }, { key: 'a', label: 'Automatiques ou annulées' }]} rows={parAgent} />
        <ActiviteParJour title="Recommandations émises" series={[{ key: 'r', label: 'Recommandations', items: recs.map((r) => ({ at: r.createdAt })) }]} />
      </ChartGrid>
    </div>
  );
}

function Sparks({ s }: { s: ReturnType<typeof serieParJour> }) {
  return (
    <KpiGrid max={2} label="Rythme des recommandations">
      <KpiTile label="Recommandations émises — 14 jours" value={s.dansFenetre} spark={{ values: s.values, labels: s.labels, label: 'Recommandations émises par jour' }} />
      <KpiTile label="Recommandations au total" value={s.total} sub="toutes périodes, dans votre périmètre" />
    </KpiGrid>
  );
}

export function AgentsVisuels({ agents }: { agents: IaAgent[] }) {
  const rows = agents.filter((a) => a.stats.total > 0).map((a) => ({ key: a.code, label: a.name, values: { p: a.stats.pending, a: a.stats.accepted + a.stats.modified, r: a.stats.rejected, u: a.stats.auto } }));
  return (
    <ChartGrid min={280} className="vz-bloc" label="Agents — graphiques">
      <StackedBarViz className="viz-span-2" title="Activité des agents" subtitle="recommandations par issue" mode="absolute"
        series={[{ key: 'p', label: 'En attente' }, { key: 'a', label: 'Retenues' }, { key: 'r', label: 'Rejetées' }, { key: 'u', label: 'Automatiques (A)' }]} rows={rows} emptyText="Aucun agent n’a encore produit de recommandation" />
      <Etats title="Agents actifs et coupés" unitLabel="agents"
        items={etatsDe(agents, (a) => (a.enabled ? 'ON' : 'OFF'), { ON: { label: 'Actif', tone: 'good' }, OFF: { label: 'Coupé (coupe-circuit)', tone: 'critical' } }, ['ON', 'OFF'])} />
      <Parts title="Agents par niveau d’autonomie" centerLabel="agents"
        slices={countBy(agents, (a) => a.autonomy).map((c) => ({ key: c.key, label: AUTONOMY_LABEL[c.key as keyof typeof AUTONOMY_LABEL] ?? c.key, value: c.count }))} />
    </ChartGrid>
  );
}

/** Paramètres d'autonomie (état du formulaire, avant ou après enregistrement). */
export function AutonomieVisuels({ actions, disabledActions, agents, disabledAgents, levelAEnabled }: { actions: number; disabledActions: number; agents: number; disabledAgents: number; levelAEnabled: boolean }) {
  return (
    <ChartGrid min={260} className="vz-bloc" label="Autonomie — graphiques">
      <ProgressMeter label="Actions de niveau A autorisées" value={levelAEnabled ? actions - disabledActions : 0} max={Math.max(1, actions)} unit={`/ ${actions}`} format={(v) => fmtNombre(v, 0)}
        tone={levelAEnabled ? 'info' : 'neutral'} toneLabel={levelAEnabled ? 'Niveau A actif' : 'Niveau A désactivé pour l’entité'} />
      <ProgressMeter label="Agents de l’entité avec exécution automatique" value={levelAEnabled ? agents - disabledAgents : 0} max={Math.max(1, agents)} unit={`/ ${agents}`} format={(v) => fmtNombre(v, 0)}
        tone={levelAEnabled ? 'info' : 'neutral'} toneLabel={agents ? 'Agents à actions A' : 'Aucun agent à actions A'} />
    </ChartGrid>
  );
}

export function MemoireVisuels({ frequentTasks, items }: { frequentTasks: Record<string, number>; items: number }) {
  return (
    <ChartGrid min={260} className="vz-bloc" label="Ma mémoire — graphiques">
      <Barres title="Mes tâches fréquentes" serie="Occurrences" rows={Object.entries(frequentTasks).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => ({ key: k, label: k, values: { n } }))} emptyText="Aucune tâche fréquente mémorisée" />
      <KpiGrid max={2} label="Ma mémoire en chiffres">
        <KpiTile label="Éléments mémorisés" value={items} sub="effaçables un par un" />
        <KpiTile label="Tâches suivies" value={Object.keys(frequentTasks).length} />
      </KpiGrid>
    </ChartGrid>
  );
}

export function JournalVisuels({ entries }: { entries: JournalEntry[] }) {
  const lat = entries.filter((e) => e.decision?.latencyMs !== undefined).map((e) => e.decision!.latencyMs! / 60_000).sort((a, b) => a - b);
  const med = lat.length ? lat[Math.floor(lat.length / 2)]! : null;
  const acteurs = { ai: 'Agent (IA)', user: 'Personne', system: 'Système' } as Record<string, string>;
  return (
    <div className="vz-bloc" data-testid="ia-journal-visuels">
      <KpiGrid max={3} label="Journal IA — chiffres clés">
        <KpiTile label="Événements journalisés" value={entries.length} sub="filtre courant" />
        <KpiTile label="Décisions humaines" value={entries.filter((e) => e.type === 'DECISION' || e.type === 'VALIDATION').length} state={{ label: 'Une personne décide', tone: 'good' }} />
        <KpiTile label="Délai médian de décision" value={med} unit="min" format={(v) => fmtNombre(v, 0)} reason="Aucune décision datée dans ce filtre." />
      </KpiGrid>
      <ChartGrid min={280} label="Journal IA — graphiques">
        <Barres title="Événements par type" serie="Événements" rows={barresDe(countBy(entries, (e) => e.type), JOURNAL_LABEL)} emptyText="Journal vide pour ce filtre" />
        <Parts title="Événements par acteur" centerLabel="événements" slices={countBy(entries, (e) => e.actor.kind).map((c) => ({ key: c.key, label: acteurs[c.key] ?? c.key, value: c.count }))} emptyText="Journal vide" />
        <ActiviteParJour className="viz-span-2" title="Événements du journal IA" series={[{ key: 'j', label: 'Événements', items: entries.map((e) => ({ at: e.at })) }]} />
      </ChartGrid>
    </div>
  );
}

interface RegLite {
  models: { code: string; versions: { status: string }[] }[];
  datasets: { status: string }[];
  monitoring: { rows: { modelVersion: string; acceptancePct: number | null; decisions: number }[] };
}
const VERS: Record<string, { label: string; tone: 'info' | 'warning' | 'good' | 'neutral' }> = {
  ENREGISTREE: { label: 'Enregistrée', tone: 'info' }, MISE_EN_SERVICE_PROPOSEE: { label: 'Mise en service proposée', tone: 'warning' }, EN_SERVICE: { label: 'En service', tone: 'good' }, RETIREE: { label: 'Retirée', tone: 'neutral' },
};
const JEUX: Record<string, { label: string; tone: 'good' | 'warning' | 'critical' }> = { APPROUVE: { label: 'Approuvé', tone: 'good' }, PROPOSE: { label: 'Proposé', tone: 'warning' }, REFUSE: { label: 'Refusé', tone: 'critical' } };
export const JEU_STATUS = JEUX;

export function ModelesVisuels({ d }: { d: RegLite }) {
  const versions = d.models.flatMap((m) => m.versions);
  return (
    <ChartGrid min={280} className="vz-bloc" label="Registre des modèles — graphiques">
      <Etats title="Versions de modèles par statut" unitLabel="versions" items={etatsDe(versions, (v) => v.status, VERS, ['ENREGISTREE', 'MISE_EN_SERVICE_PROPOSEE', 'EN_SERVICE', 'RETIREE'])} />
      <Etats title="Jeux de données par statut" unitLabel="jeux" items={etatsDe(d.datasets, (x) => x.status, JEUX, ['PROPOSE', 'APPROUVE', 'REFUSE'])} />
      <BarChartViz className="viz-span-2" title="Taux d’acceptation par version observée" orientation="horizontal" series={[{ key: 'a', label: 'Acceptation (%)' }]}
        rows={d.monitoring.rows.map((r) => ({ key: r.modelVersion, label: r.modelVersion, values: { a: r.acceptancePct } }))} format={(v) => `${fmtNombre(v, 0)} %`}
        emptyText="Aucune version observée" note="Non mesuré (hachures) tant qu’aucune décision n’est enregistrée pour la version." />
    </ChartGrid>
  );
}
