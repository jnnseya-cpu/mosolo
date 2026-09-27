/**
 * Pilotage et décision — visuels communs du périmètre (27/09/2026, trousse de visualisation partagée).
 * Ajoutés PAR-DESSUS les écrans existants (tableaux, formulaires et boutons conservés) : tuiles d'indicateurs,
 * répartitions par état, barres par devise (jamais de devises mélangées), jauges vers une cible déclarée.
 * Aucune donnée inventée : chaque visuel lit la vue déjà chargée par l'écran ; une valeur absente est « non mesuré »
 * avec son motif ; une cible n'est dessinée que si le serveur la sert.
 */
import type { ReactNode } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import {
  BarChartViz, ChartGrid, fmtCompact, fmtNombre, KpiGrid, KpiTile, ProgressMeter, StatusDistribution, VizFrame,
  type StatusItem,
} from '../../components/viz';
import type { Tone } from '../../components/StatusBadge';
import { KPI_STATUS, kpiTone, type Kpi } from './shared';

/** Indicateur des modules 41 à 58 (même forme que `decision/commun`, redéclarée pour éviter un import circulaire). */
export interface IndicateurLike { code: string; label: string; measured: boolean; value: string | null; unit?: string; reason?: string; target?: number | string; meetsTarget?: boolean | null }

/** Nombre depuis une chaîne décimale du serveur (« 19.0 », « 12,5 ») ; null si absent ou illisible. */
export function nombre(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.').replace('−', '-'));
  return Number.isFinite(n) ? n : null;
}

// ————————————————————————— répartitions par état —————————————————————————

export type EtatMap = Record<string, { label: string; tone: Tone }>;

/**
 * Répartition par état d'une liste : un élément par état connu (ordre de la table d'états, états vides compris pour
 * que la légende reste stable), puis les états inconnus rencontrés (ton neutre, code affiché).
 */
export function etatsDe<T>(items: readonly T[], statusOf: (t: T) => string, map: EtatMap): StatusItem[] {
  const counts = new Map<string, number>();
  for (const it of items) { const s = statusOf(it); counts.set(s, (counts.get(s) ?? 0) + 1); }
  const known = Object.entries(map).map(([key, m]) => ({ key, label: m.label, tone: m.tone, count: counts.get(key) ?? 0 }));
  const unknown = [...counts.entries()].filter(([k]) => !map[k]).map(([key, count]) => ({ key, label: key.replace(/_/g, ' ').toLowerCase(), tone: 'neutral' as Tone, count }));
  return [...known, ...unknown];
}

/** États d'une obligation (§ 18.3, `ObligationStatus` du paquet partagé), libellés français. */
export const ETATS_OBLIGATION: EtatMap = {
  EMISE: { label: 'Émise', tone: 'info' }, EXIGIBLE: { label: 'Exigible', tone: 'warning' }, PARTIELLEMENT_PAYEE: { label: 'Partiellement payée', tone: 'warning' },
  SOLDEE: { label: 'Soldée', tone: 'good' }, EN_RETARD: { label: 'En retard', tone: 'critical' }, CONTESTEE: { label: 'Contestée', tone: 'serious' },
  ANNULEE: { label: 'Annulée', tone: 'neutral' }, ADMISE_EN_NON_VALEUR: { label: 'Admise en non-valeur', tone: 'neutral' },
};

/** États d'un indicateur des modules 41 à 58 : dans la cible, hors cible, mesuré sans cible, non mesuré. */
export const ETATS_INDICATEUR: EtatMap = {
  CIBLE: { label: 'Dans la cible', tone: 'good' },
  HORS_CIBLE: { label: 'Hors cible', tone: 'warning' },
  SUIVI: { label: 'Mesuré (sans cible)', tone: 'info' },
  NON_MESURE: { label: 'Non mesuré', tone: 'neutral' },
};
export function etatIndicateur(k: IndicateurLike): keyof typeof ETATS_INDICATEUR {
  if (!k.measured || k.value === null) return 'NON_MESURE';
  if (k.meetsTarget === true) return 'CIBLE';
  if (k.meetsTarget === false) return 'HORS_CIBLE';
  return 'SUIVI';
}

/** Tuiles des indicateurs d'un module (valeur, unité, état avec icône, cible déclarée, motif du non mesuré). */
export function TuilesIndicateurs({ items, label, max = 4 }: { items: readonly IndicateurLike[] | undefined; label: string; max?: 2 | 3 | 4 | 5 | 6 }) {
  if (!items?.length) return null;
  return (
    <div className="span-12">
      <KpiGrid max={max} label={label}>
        {items.map((k) => {
          const e = ETATS_INDICATEUR[etatIndicateur(k)]!;
          const v = k.measured ? nombre(k.value) : null;
          const cible = nombre(k.target ?? null);
          const unite = k.unit && k.unit !== '' ? k.unit : undefined;
          return (
            <KpiTile key={k.code} label={k.label} value={v === null && k.measured && k.value !== null ? k.value : v} unit={unite}
              format={(x) => fmtNombre(x, 1)}
              state={{ label: e.label, tone: e.tone }} reason={k.reason ?? 'Donnée source absente : pas encore mesurable.'}
              target={cible !== null && v !== null ? { value: cible, label: `Cible : ${k.target}${unite ? ` ${unite}` : ''}`, max: unite === '%' ? 100 : undefined } : undefined}
              sub={k.target !== undefined && cible === null ? `Cible : ${k.target}` : undefined} />
          );
        })}
      </KpiGrid>
    </div>
  );
}

/** Répartition des indicateurs par état + jauges des indicateurs en pourcentage (cible dessinée si servie). */
export function EtatIndicateurs({ items, title = 'Indicateurs par état', className }: { items: readonly IndicateurLike[] | undefined; title?: string; className?: string }) {
  const list = items ?? [];
  const pcts = list.filter((k) => k.unit === '%' || k.unit === '% réalisé');
  return (
    <>
      <StatusDistribution className={className} title={title} subtitle="Valeurs calculées sur les données réelles ; non mesuré = donnée source absente" unitLabel="indicateurs"
        items={etatsDe(list, etatIndicateur, ETATS_INDICATEUR)} emptyText="Aucun indicateur servi pour ce module" />
      {pcts.length > 0 && (
        <VizFrame frame={{ title: 'Indicateurs en pourcentage', subtitle: 'Progression vers la cible déclarée (sans cible : suivi seulement)' }} empty={false}
          table={{ columns: ['Indicateur', 'Valeur', 'Cible'], rows: pcts.map((k) => [k.label, k.measured && k.value !== null ? `${fmtNombre(nombre(k.value) ?? 0)} %` : 'non mesuré', k.target === undefined ? 'sans cible' : String(k.target)]) }}>
          <div className="pl-meters">
            {pcts.map((k) => (
              <ProgressMeter key={k.code} label={k.label} unit="%" value={k.measured ? nombre(k.value) : null} target={nombre(k.target ?? null)}
                reason={k.reason ?? 'donnée source absente'} compact
                tone={k.meetsTarget === false ? 'warning' : undefined} toneLabel={k.meetsTarget === false ? 'Hors cible' : undefined} />
            ))}
          </div>
        </VizFrame>
      )}
    </>
  );
}

// ————————————————————————— indicateurs du catalogue (§ 39) —————————————————————————

export const ETATS_KPI: EtatMap = Object.fromEntries((['ATTEINTE', 'NON_ATTEINTE', 'SANS_CIBLE', 'NON_CALCULABLE', 'NON_MESURE'] as const).map((s) => [s, {
  label: KPI_STATUS[s], tone: s === 'ATTEINTE' ? 'good' : s === 'NON_ATTEINTE' ? 'critical' : s === 'SANS_CIBLE' ? 'info' : s === 'NON_CALCULABLE' ? 'warning' : 'neutral',
}])) as EtatMap;

/** Tuile d'un indicateur du catalogue : valeur, état, tendance sur la fenêtre servie (valeur précédente réelle). */
export function KpiTileDe({ k, href }: { k: Kpi; href?: string }) {
  const v = k.status === 'NON_MESURE' ? null : nombre(k.value);
  const prev = nombre(k.trend.previous);
  const unit = k.unit === 'nombre' ? undefined : k.unit;
  return (
    <KpiTile label={k.label} value={v} unit={unit} href={href} state={{ label: KPI_STATUS[k.status], tone: kpiTone(k) }}
      reason={k.detail ?? `Non mesuré : ${k.source}`}
      delta={k.trend.direction !== 'INDISPONIBLE' && prev !== null ? { current: v, previous: prev, versus: `sur ${k.trend.window}`, better: k.better, absolute: k.unit === '%' } : undefined}
      sub={`Cible : ${k.targetLabel}${k.denominator !== undefined && k.unit === '%' ? ` · ${k.numerator ?? 0}/${k.denominator}` : ''}`} />
  );
}

// ————————————————————————— montants par devise —————————————————————————

type Montants = MoneyJSON[] | MoneyJSON | null | undefined;
const liste = (m: Montants): MoneyJSON[] => (m ? (Array.isArray(m) ? m : [m]) : []);

/** Montant d'une devise dans une liste (somme exacte si plusieurs lignes de la même devise) ; null si absente. */
export function montantDevise(m: Montants, devise: string): number | null {
  const l = liste(m).filter((x) => x.currency === devise);
  return l.length ? l.reduce((s, x) => s + Number(x.amount), 0) : null;
}

/** Devises présentes (CDF d'abord), dans l'ordre d'apparition sinon. */
export function devisesDe(montants: readonly Montants[]): string[] {
  const s = new Set<string>();
  for (const m of montants) for (const x of liste(m)) s.add(x.currency);
  return [...s].sort((a, b) => (a === 'CDF' ? -1 : b === 'CDF' ? 1 : 0));
}

export interface LigneMontants { key?: string; label: string; values: Record<string, Montants> }

/**
 * Barres par devise : un graphique par devise (jamais de devises additionnées), séries côte à côte (niveaux emboîtés
 * de l'échelle, jamais empilés). Une ligne sans montant dans la devise vaut 0 pour cette devise.
 */
export function BarresParDevise({ title, subtitle, rows, series, orientation = 'horizontal', className, note, emptyText }: {
  title: string; subtitle?: string; rows: readonly LigneMontants[]; series: readonly { key: string; label: string }[]; orientation?: 'horizontal' | 'vertical'; className?: string; note?: ReactNode; emptyText?: string;
}) {
  const devises = devisesDe(rows.flatMap((r) => Object.values(r.values)));
  if (devises.length === 0) return <BarChartViz className={className} title={title} subtitle={subtitle} rows={[]} series={series} emptyText={emptyText ?? 'Aucun montant pour cette période'} />;
  return (
    <>
      {devises.map((d) => (
        <BarChartViz key={d} className={className} title={devises.length > 1 ? `${title} — ${d}` : title} subtitle={subtitle ?? `Montants en ${d} (devise légale, jamais additionnée à une autre)`}
          orientation={orientation} format={(v) => `${fmtCompact(v)} ${d}`} tickFormat={fmtCompact} note={note}
          series={series} rows={rows.filter((r) => Object.values(r.values).some((m) => montantDevise(m, d) !== null)).map((r) => ({ key: r.key ?? r.label, label: r.label, values: Object.fromEntries(series.map((s) => [s.key, montantDevise(r.values[s.key], d) ?? 0])) }))} />
      ))}
    </>
  );
}

// ————————————————————————— mise en page —————————————————————————

/** Bande visuelle pleine largeur (dans une `dash-grid`) : grille de cartes de graphiques. */
export function Visuels({ children, label, min = 300 }: { children: ReactNode; label: string; min?: number }) {
  return <div className="span-12 pl-visuels"><ChartGrid min={min} label={label}>{children}</ChartGrid></div>;
}

/** Bande de tuiles pleine largeur (dans une `dash-grid`). */
export function Tuiles({ children, label, max = 4 }: { children: ReactNode; label: string; max?: 2 | 3 | 4 | 5 | 6 }) {
  return <div className="span-12"><KpiGrid max={max} label={label}>{children}</KpiGrid></div>;
}

/** Compte des éléments par clé (ordre décroissant) → lignes d'un graphique à une série. */
export function lignesCompte<T>(items: readonly T[], keyOf: (t: T) => string, labelOf: (k: string) => string = (k) => k): { key: string; label: string; values: { n: number } }[] {
  const m = new Map<string, number>();
  for (const it of items) { const k = keyOf(it) || 'Non renseigné'; m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ key: k, label: labelOf(k), values: { n } }));
}
