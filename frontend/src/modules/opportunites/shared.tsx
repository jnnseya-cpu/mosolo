/**
 * Module « opportunités » (Cahier v2.9, chapitre 8) : types, libellés et vues réutilisables (testables sans serveur).
 * L'IA propose des signaux ; des personnes instruisent ; l'autorité décide ; aucune opportunité ne devient une taxe
 * sans base légale. Les actions réutilisent les briques de l'écran Intégrité (useAction, ActionError, Kpi, Tabs).
 */
import { formatMoney, type MoneyJSON } from '@mosolo/shared';
import { DataTable } from '../../components/DataTable';
import { EmptyState } from '../../components/States';
import { StatusBadge, type Tone } from '../../components/StatusBadge';

export { ActionError, hasRole, Kpi, Tabs, useAction } from '../integrite/shared';

export const money = (m: MoneyJSON | null | undefined) => (m ? formatMoney(m, { locale: 'fr' }) : '—');
export const POTENTIAL_TODO = 'à estimer par le recensement pilote';

export interface PipelineStep { n: number; code: string; label: string; content: string; responsible: string; roles: string[] }
export interface StepView extends PipelineStep { done: boolean; record: { completedBy?: string; decidedBy?: string; completedAt?: string; at?: string; summary?: string; motivation?: string; outcome?: string } | null }
export interface GridValue { value: string | null; source: string; updatedAt: string; updatedBy: string }
export interface Hypothesis { id: string; text: string; source: string; date: string; author: string; status: 'ACTIVE' | 'REVISEE'; revises?: string }
export interface LegalBasis { kind: 'REGLE' | 'ACTE'; ref: string; label: string; status: string }
export interface Decision { outcome: 'ACTIVATION' | 'REPORT' | 'ABANDON'; motivation: string; decidedBy: string; at: string; legalBasis: LegalBasis | null; effect: string }
export interface OpportunitySummary {
  id: string; code: string; title: string; section: '8.1' | '8.2' | 'SIGNAL'; track: string; origin: string; cahierPriority: number | null;
  status: 'EN_INSTRUCTION' | 'DECIDEE'; decision: string | null; domains: string[]; completed: number;
  nextStep: { n: number; label: string; responsible: string; roles: string[] } | null;
}
export interface Opportunity extends Omit<OpportunitySummary, 'decision'> {
  nature: string | null; condition: string | null; objective: string | null; legalPath: string | null; risksToControl: string | null;
  originRef: string | null; verticals: string[]; grid: Record<string, GridValue>;
  potential: { prudent: MoneyJSON | null; attendu: MoneyJSON | null; ambitieux: MoneyJSON | null; hypothesisIds: string[]; note: string };
  hypotheses: Hypothesis[]; decision: Decision | null; stepsView: StepView[]; source: string;
}

export const TRACK_LABELS: Record<string, string> = { SANS_TEXTE_NOUVEAU: 'Sans texte nouveau (§ 8.1)', ACTE_PROVINCIAL: 'Acte provincial requis (§ 8.2)', A_QUALIFIER: 'Signal à qualifier' };
export const OUTCOME_LABELS: Record<string, string> = { ACTIVATION: 'Activation', REPORT: 'Report', ABANDON: 'Abandon' };
export const ORIGIN_LABELS: Record<string, string> = {
  CAHIER: 'Cahier des charges', IA_DECOUVERTE: 'Agent « Découverte des recettes »', TERRAIN: 'Terrain', DONNEES_PARTENAIRES: 'Données partenaires', ANOMALIE: 'Anomalie',
};
export const GRID_LABELS: Record<string, string> = {
  faisabiliteJuridique: 'Faisabilité juridique', objectif: 'Objectif de politique publique', autorite: 'Autorité responsable',
  faitGenerateur: 'Fait générateur', population: 'Population concernée', methodeCalcul: 'Méthode de calcul',
  coutMiseEnOeuvre: 'Coût de mise en œuvre', impactSocial: 'Impact social', impactEconomique: 'Impact économique',
  risqueCorruption: 'Risque de corruption', exigencesControle: 'Exigences de contrôle', texteRequis: 'Texte requis',
  priorite: 'Priorité', recommandationPilote: 'Recommandation de pilote',
};

export function outcomeTone(o: string | null | undefined): Tone {
  return o === 'ACTIVATION' ? 'good' : o === 'ABANDON' ? 'serious' : o === 'REPORT' ? 'warning' : 'info';
}

/** Pipeline en huit étapes (§ 8.4) : étape, responsable, état. */
export function PipelineView({ steps }: { steps: StepView[] }) {
  return (
    <ol className="op-pipeline" aria-label="Pipeline de découverte en huit étapes">
      {steps.map((s) => (
        <li key={s.n} className={s.done ? 'is-done' : ''}>
          <span className="op-step-n" aria-hidden="true">{s.n}</span>
          <div className="min0">
            <p className="row-title">{s.label} {s.done ? <StatusBadge tone="good" label="Complétée" /> : <StatusBadge tone="neutral" label="À faire" />}</p>
            <p className="small muted">{s.content} — <strong>{s.responsible}</strong> ({s.roles.join(', ')})</p>
            {s.record && <p className="small">{s.record.summary ?? s.record.motivation} <span className="muted mono">· {s.record.completedBy ?? s.record.decidedBy} · {(s.record.completedAt ?? s.record.at ?? '').slice(0, 10)}</span></p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Grille d'évaluation (§ 8.3) : chaque rubrique, sa valeur ou « à instruire », sa source ; potentiel jamais inventé. */
export function GridView({ opp }: { opp: Pick<Opportunity, 'grid' | 'potential'> }) {
  const p = opp.potential;
  const none = !p.prudent && !p.attendu && !p.ambitieux;
  return (
    <dl className="op-grid">
      {Object.entries(GRID_LABELS).map(([k, label]) => {
        const g = opp.grid[k];
        return (
          <div key={k} className="op-grid-row">
            <dt>{label}</dt>
            <dd>{g?.value ?? <span className="muted">À instruire</span>}{g?.value && <span className="small muted"> · {g.source}</span>}</dd>
          </div>
        );
      })}
      <div className="op-grid-row">
        <dt>Potentiel de recettes (prudent / attendu / ambitieux)</dt>
        <dd>{none ? <span className="muted">{POTENTIAL_TODO}</span> : `${money(p.prudent)} / ${money(p.attendu)} / ${money(p.ambitieux)} — ${p.note}`}</dd>
      </div>
    </dl>
  );
}

export interface WorklistItem {
  id: string; ruleCode: string; commune: string | null; quartier: string | null; lat: number | null; lon: number | null; priority: number; status: string;
  explanation: string; automaticAssessment: 'AUCUN'; variables?: { name: string; value: string }[]; subject?: { kind: string; ref: string };
  priorityFactors?: { label: string; points: number }[]; createdObjectId?: string; missionId?: string;
}
export const RULE_LABELS: Record<string, string> = {
  BAR_SANS_LICENCE: 'Bar sans autorisation (50 m)', COMMERCE_NON_ENREGISTRE: 'Commerce probablement non enregistré', VEHICULE_IMPAYE: 'Véhicule — vignette ou taxe impayée',
  SANS_QUITUS_VALIDE: 'Sans quitus valide — service bloqué', INCOHERENCE_LOCATIVE: 'Incohérence locative',
};
export const WL_STATUS: Record<string, { label: string; tone: Tone }> = {
  A_EXAMINER: { label: 'À examiner', tone: 'warning' }, VERIFICATION_REQUISE: { label: 'Vérification requise', tone: 'info' },
  MISSION_OUVERTE: { label: 'Mission ouverte', tone: 'good' }, CLOS_SANS_SUITE: { label: 'Clos sans suite', tone: 'neutral' },
  STATUT_INSTANTANE: { label: 'Statut pour le contrôleur', tone: 'info' }, SERVICE_BLOQUE: { label: 'Service bloqué', tone: 'serious' }, REGULARISE: { label: 'Régularisé', tone: 'good' },
};

/** Liste de travail priorisée (§ 8.5) — jamais un avis d'imposition. */
export function WorklistView({ items, onPick }: { items: WorklistItem[]; onPick?: (i: WorklistItem) => void }) {
  return (
    <DataTable rows={items} rowKey={(i) => i.id} caption="Liste de travail priorisée"
      empty={<EmptyState title="Liste vide" icon="check">Aucun élément à traiter.</EmptyState>}
      columns={[
        { key: 'p', label: 'Priorité', num: true, render: (i) => <strong>{i.priority}</strong> },
        { key: 'r', label: 'Règle', primary: true, render: (i) => onPick ? <button type="button" className="btn btn-ghost btn-sm op-link" onClick={() => onPick(i)}>{RULE_LABELS[i.ruleCode] ?? i.ruleCode}</button> : (RULE_LABELS[i.ruleCode] ?? i.ruleCode) },
        { key: 'c', label: 'Commune', render: (i) => i.commune ?? '—' },
        { key: 's', label: 'État', render: (i) => <StatusBadge tone={WL_STATUS[i.status]?.tone ?? 'neutral'} label={WL_STATUS[i.status]?.label ?? i.status} /> },
        { key: 'a', label: 'Avis automatique', render: () => <span className="small">Aucun</span> },
        { key: 'e', label: 'Explication', full: true, render: (i) => <span className="small muted">{i.explanation}</span> },
      ]} />
  );
}

export interface Lever { n: number; code: string; label: string; action: string; gainMeasure: string; measured: boolean; value: string; basis: string; source: string | null }

/** Les douze leviers (§ 8.6) : mesure calculée, sinon « non mesuré ». */
export function LeversView({ levers }: { levers: Lever[] }) {
  return (
    <DataTable rows={levers} rowKey={(l) => l.code} caption="Les douze leviers de maximisation"
      columns={[
        { key: 'n', label: 'Levier', primary: true, render: (l) => `${l.n}. ${l.label}` },
        { key: 'a', label: 'Action', render: (l) => l.action },
        { key: 'g', label: 'Mesure du gain', render: (l) => l.gainMeasure },
        { key: 'v', label: 'Valeur', render: (l) => l.measured ? <strong>{l.value}</strong> : <StatusBadge tone="neutral" label="Non mesuré" /> },
        { key: 'b', label: 'Base', full: true, render: (l) => <span className="small muted">{l.basis}{l.source ? ` · ${l.source}` : ''}</span> },
      ]} />
  );
}

export interface RankRow {
  id: string; code: string; title: string; revenueKind: string; revenueKindLabel: string; ranked: boolean; reason: string | null; missing: string[];
  net: MoneyJSON | null; grossAdjusted?: MoneyJSON; formula?: string; decision: string | null;
  inputs: Record<string, { value: MoneyJSON | string | null; date: string | null; source: string | null } | string>;
}
export interface RankingReport {
  method: string; rule: string; ranked: RankRow[]; notRanked: RankRow[];
  dashboards: { kind: string; label: string; ranked: number; notRanked: number; netByCurrency: MoneyJSON[] }[];
}

/** Tableaux séparés : recettes nouvelles / arriérés / rapprochement / reclassement (§ 8.7). */
export function DashboardsView({ report }: { report: RankingReport }) {
  return (
    <div className="op-dash" role="list" aria-label="Tableaux par nature de recette">
      {report.dashboards.map((d) => (
        <div key={d.kind} className="op-dash-card" role="listitem">
          <p className="caps-sm">{d.label}</p>
          <p className="op-dash-value">{d.netByCurrency.length ? d.netByCurrency.map((m) => money(m)).join(' + ') : '—'}</p>
          <p className="small muted">{d.ranked} classée(s) · {d.notRanked} non classée(s)</p>
        </div>
      ))}
    </div>
  );
}
