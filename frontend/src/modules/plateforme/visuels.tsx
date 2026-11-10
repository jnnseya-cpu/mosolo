/**
 * Visuels communs des écrans « intégrité, accès, IA, socle, plateforme, documents, communication, preuves »
 * (trousse de visualisation, 27/09/2026). Rien n'est inventé : chaque visuel est dérivé d'une liste ou d'indicateurs
 * DÉJÀ servis par l'API à la personne qui consulte ; une valeur absente reste « non mesuré » avec son motif.
 *  - `etatsDe` : répartition par état (StatusDistribution) d'une liste, libellés et tons de l'écran ;
 *  - `serieParJour` / `ActiviteParJour` : activité par jour de Kinshasa (périodes vides comblées) ;
 *  - `IndicateursVisuels` : indicateurs de module (`Indicator`) en tuiles, jauges de progression quand une cible
 *    numérique est servie par le serveur (jamais inventée) ; le détail d'origine reste consultable dessous.
 */
import type { ReactNode } from 'react';
import type { Tone } from '../../components/StatusBadge';
import { countBy, groupByDay, kinshasaDay, periodLabel, type CountRow } from '../../lib/aggregate';
import {
  BarChartViz, DonutViz, fmtNombre, KpiGrid, KpiTile, LineAreaViz, ProgressMeter, StatusDistribution, type StatusItem, type TimePoint,
} from '../../components/viz';
import { Indicateurs, type Indicator } from '../decision/commun';

/** Table d'états d'un écran : { CODE: { label, tone } } ou { CODE: [label, tone] }. */
export type EtatMap = Record<string, { label: string; tone: Tone } | readonly [string, Tone]>;

function etat(map: EtatMap, code: string): { label: string; tone: Tone } {
  const v = map[code];
  if (!v) return { label: code, tone: 'neutral' };
  return Array.isArray(v) ? { label: v[0] as string, tone: v[1] as Tone } : (v as { label: string; tone: Tone });
}

/**
 * Répartition par état d'une liste. Avec `ordre`, tous les états du circuit sont listés (y compris à zéro), dans
 * l'ordre du circuit ; sinon seuls les états présents, du plus fréquent au moins fréquent.
 */
export function etatsDe<T>(items: readonly T[], cle: (t: T) => string, map: EtatMap, ordre?: readonly string[]): StatusItem[] {
  const rows = countBy(items, cle);
  const by = new Map(rows.map((r) => [r.key, r.count]));
  const keys = ordre ? [...ordre, ...rows.map((r) => r.key).filter((k) => !ordre.includes(k))] : rows.map((r) => r.key);
  return keys.map((k) => ({ key: k, ...etat(map, k), count: by.get(k) ?? 0 }));
}

/** Compte par clé → lignes de barres (libellés de l'écran). */
export function barresDe(rows: readonly CountRow[], libelles: Record<string, string> = {}, cle = 'n') {
  return rows.map((r) => ({ key: r.key, label: libelles[r.key] ?? r.key, values: { [cle]: r.count } }));
}

/** Enregistrement → parts d'un anneau (5 parts au plus, repli « Autres » par la trousse). */
export function partsDe(rec: Record<string, number>, libelles: Record<string, string> = {}) {
  return Object.entries(rec).filter(([, v]) => v > 0).map(([k, v]) => ({ key: k, label: libelles[k] ?? k, value: v }));
}

const JOUR = 86_400_000;

/** Série quotidienne (jours de Kinshasa) des `jours` derniers jours : nombre d'éléments par jour. */
export function serieParJour<T>(items: readonly T[], dateOf: (t: T) => string | null | undefined, jours = 30, now = new Date()) {
  const to = kinshasaDay(now)!;
  const from = kinshasaDay(new Date(now.getTime() - (jours - 1) * JOUR))!;
  const g = groupByDay(items, (t) => dateOf(t) ?? null, { from, to });
  const values = g.groups.map((x) => x.items.length);
  const dansFenetre = values.reduce((s, v) => s + v, 0);
  return { keys: g.groups.map((x) => x.period), values, labels: g.groups.map((x) => periodLabel(x.period, 'day')), dansFenetre, total: items.length };
}

/** Courbe d'activité par jour (une ou plusieurs listes datées, une série chacune ; 4 au plus). */
export function ActiviteParJour({ title, series, jours = 30, subtitle, note, example, className }: {
  title: string; series: { key: string; label: string; items: readonly { at?: string | null }[] }[]; jours?: number; subtitle?: string; note?: ReactNode; example?: boolean; className?: string;
}) {
  const s = series.map((x) => ({ ...x, serie: serieParJour(x.items, (i) => i.at ?? null, jours) }));
  const keys = s[0]?.serie.keys ?? [];
  const points: TimePoint[] = keys.map((k, i) => ({ date: k, values: Object.fromEntries(s.map((x) => [x.key, x.serie.values[i] ?? 0])) }));
  const hors = s.reduce((n, x) => n + (x.serie.total - x.serie.dansFenetre), 0);
  const vide = s.every((x) => x.serie.dansFenetre === 0);
  return (
    <LineAreaViz className={className} title={title} subtitle={subtitle ?? `${jours} derniers jours (heure de Kinshasa)`} granularity="day" area={series.length === 1}
      series={s.map((x) => ({ key: x.key, label: x.label }))} points={vide ? [] : points} format={(v) => fmtNombre(v, 0)} example={example}
      emptyText={`Aucun événement daté sur les ${jours} derniers jours${hors ? ` (${hors} plus ancien(s))` : ''}`}
      note={note ?? (hors ? `${hors} élément(s) antérieur(s) à la fenêtre, comptés dans les tableaux.` : undefined)} />
  );
}

/** Répartition par état, avec état vide explicite. */
export function Etats({ title, items, unitLabel, subtitle, note, example, className, emptyText }: {
  title: string; items: StatusItem[]; unitLabel?: string; subtitle?: string; note?: ReactNode; example?: boolean; className?: string; emptyText?: string;
}) {
  return <StatusDistribution className={className} title={title} subtitle={subtitle} items={items} unitLabel={unitLabel} note={note} example={example} emptyText={emptyText} />;
}

/** Barres horizontales d'un comptage (une série, libellés longs). */
export function Barres({ title, rows, serie = 'Nombre', subtitle, note, example, className, emptyText, format }: {
  title: string; rows: { key?: string; label: string; values: Record<string, number | null> }[]; serie?: string; subtitle?: string; note?: ReactNode; example?: boolean; className?: string; emptyText?: string; format?: (v: number) => string;
}) {
  return <BarChartViz className={className} title={title} subtitle={subtitle} orientation="horizontal" series={[{ key: 'n', label: serie }]} rows={rows} note={note} example={example} emptyText={emptyText} format={format ?? ((v) => fmtNombre(v, 0))} />;
}

/** Anneau (part d'un tout). */
export function Parts({ title, slices, centerLabel, subtitle, note, example, className, emptyText }: {
  title: string; slices: { key: string; label: string; value: number }[]; centerLabel?: string; subtitle?: string; note?: ReactNode; example?: boolean; className?: string; emptyText?: string;
}) {
  return <DonutViz className={className} title={title} subtitle={subtitle} slices={slices} centerLabel={centerLabel} note={note} example={example} emptyText={emptyText} format={(v) => fmtNombre(v, 0)} />;
}

/** Valeur numérique d'un indicateur servi en texte (« 97,5 », « 12 ») ; null si non numérique. */
export function nombreDe(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[\s\u202f\u00a0]/g, '').replace(',', '.').replace('%', '').replace('\u2212', '-'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Indicateurs de module en tuiles (valeur, état « Mesuré / Hors cible / Cible atteinte », motif du non-mesuré) et,
 * pour ceux qui portent une cible numérique servie par le serveur, une jauge de progression. Le bloc d'origine
 * (`Indicateurs`) reste consultable, replié, sous les tuiles.
 */
export function IndicateursVisuels({ items, titre = 'Indicateurs du module' }: { items: Indicator[] | undefined; titre?: string }) {
  if (!items?.length) return null;
  const jauges = items.filter((k) => k.measured && nombreDe(k.value) !== null && nombreDe(k.target ?? null) !== null);
  return (
    <div className="stack-sm viz-indicateurs">
      <KpiGrid max={items.length >= 4 ? 4 : (Math.max(2, items.length) as 2 | 3)} label={titre}>
        {items.map((k) => {
          const n = nombreDe(k.value);
          const state = !k.measured ? undefined : k.meetsTarget === false ? { label: 'Hors cible', tone: 'warning' as Tone } : k.meetsTarget ? { label: 'Cible atteinte', tone: 'good' as Tone } : { label: 'Mesuré', tone: 'info' as Tone };
          return (
            <KpiTile key={k.code} label={k.label} value={k.measured ? (n ?? k.value) : null} unit={k.unit} state={state}
              reason={k.reason ?? 'Donnée source absente.'} sub={k.target !== undefined ? `Cible : ${k.target}${k.unit ? ` ${k.unit}` : ''}` : undefined} />
          );
        })}
      </KpiGrid>
      {jauges.length > 0 && (
        <div className="viz-jauges">
          {jauges.map((k) => (
            <ProgressMeter key={k.code} label={k.label} value={nombreDe(k.value)} target={nombreDe(k.target ?? null)} targetLabel="servie par le serveur"
              unit={k.unit} tone={k.meetsTarget === false ? 'warning' : k.meetsTarget ? 'good' : undefined} toneLabel={k.meetsTarget === false ? 'Hors cible' : k.meetsTarget ? 'Cible atteinte' : undefined} />
          ))}
        </div>
      )}
      <details className="viz-details">
        <summary className="small">Détail des indicateurs (valeur, état, cible, motif)</summary>
        <Indicateurs items={items} />
      </details>
    </div>
  );
}
