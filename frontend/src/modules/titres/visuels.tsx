/**
 * Titres et contrôles — visuels (trousse de visualisation, 27/09/2026) : catalogue, indicateurs des modules 70-71,
 * constats de contrôle. Données RÉELLES déjà chargées par l'écran ; aucun droit élargi ; listes vides → « Aucune
 * donnée ». Un constat n'est ni une amende ni une dette : les graphiques ne montrent aucun montant de constat.
 */
import {
  BarChartViz, ChartGrid, DonutViz, GaugeMeter, KpiGrid, KpiTile, LineAreaViz, StatusDistribution, fmtNombre, type StatusItem,
} from '../../components/viz';
import type { Tone } from '../../components/StatusBadge';
import { countBy, groupByDay } from '../../lib/aggregate';

const ent = (v: number) => fmtNombre(v, 0);

export function parEtat(values: readonly string[], dict: Record<string, { label: string; tone: Tone }>): StatusItem[] {
  const c = new Map<string, number>();
  for (const v of values) c.set(v, (c.get(v) ?? 0) + 1);
  const items: StatusItem[] = Object.keys(dict).map((k) => ({ key: k, label: dict[k]!.label, tone: dict[k]!.tone, count: c.get(k) ?? 0 }));
  const autres = values.filter((v) => !(v in dict)).length;
  return autres ? [...items, { key: 'AUTRE', label: 'Autre état', tone: 'neutral', count: autres }] : items;
}

/** États d'un constat de contrôle (libellés français d'abord). */
export const CONSTAT_ETATS: Record<string, { label: string; tone: Tone }> = {
  OUVERT: { label: 'À instruire', tone: 'warning' }, CLASSE: { label: 'Classé', tone: 'neutral' }, TRANSMIS: { label: 'Transmis', tone: 'info' },
  RETENU: { label: 'Pénalité retenue', tone: 'serious' },
};
export const constatLabel = (s: string) => CONSTAT_ETATS[s]?.label ?? s;

export function ConstatsVisuel({ constats, title = 'Constats' }: { constats: readonly { id: string; status: string; reason: string; at: string; duringGrace?: boolean }[]; title?: string }) {
  const jours = groupByDay(constats, (k) => k.at);
  return (
    <ChartGrid min={260}>
      <StatusDistribution title={`${title} par état`} unitLabel="constats" items={parEtat(constats.map((k) => k.status), CONSTAT_ETATS)} emptyText="Aucun constat."
        note={`${constats.filter((k) => k.duringGrace).length} pendant la période de grâce (pédagogique).`} />
      <BarChartViz title={`${title} par motif`} orientation="horizontal" format={ent} series={[{ key: 'n', label: 'Constats' }]}
        rows={countBy(constats, 'reason').map((r) => ({ label: r.key, values: { n: r.count } }))} emptyText="Aucun constat." />
      {jours.groups.length > 1 && (
        <LineAreaViz title={`${title} par jour`} granularity="day" area format={ent} series={[{ key: 'n', label: 'Constats' }]}
          points={jours.groups.map((g) => ({ date: g.period, values: { n: g.items.length } }))} />
      )}
    </ChartGrid>
  );
}

// ————————————————————————————————————————————————————————— Catalogue et indicateurs

interface TypeLike { code: string; module: string; moduleLabel: string; activable: boolean; legalAct: { status: string }; supports: string[] }
export function CatalogueVisuel({ types }: { types: readonly TypeLike[] }) {
  const etat = (t: TypeLike) => (t.activable ? 'ACTIVABLE' : t.legalAct.status === 'ACTE_REQUIS' ? 'ACTE_REQUIS' : 'NON_ACTIVABLE');
  const supports = countBy(types.flatMap((t) => t.supports.map((s) => ({ s }))), 's');
  return (
    <>
      <KpiGrid max={3} label="Catalogue des titres">
        <KpiTile label="Types de titres" value={types.length} format={ent} />
        <KpiTile label="Activables" value={types.filter((t) => t.activable).length} format={ent} state={{ label: 'Règle ACTIVE', tone: 'good' }} />
        <KpiTile label="En attente d’un acte" value={types.filter((t) => !t.activable).length} format={ent} state={{ label: 'Visibles, non vendables', tone: 'info' }} />
      </KpiGrid>
      <ChartGrid min={280}>
        <StatusDistribution title="Types de titres par statut de l’acte" unitLabel="types"
          items={parEtat(types.map(etat), { ACTIVABLE: { label: 'Activable', tone: 'good' }, ACTE_REQUIS: { label: 'Acte requis', tone: 'info' }, NON_ACTIVABLE: { label: 'Non activable', tone: 'warning' } })} />
        <BarChartViz title="Types de titres par module" orientation="horizontal" format={ent} series={[{ key: 'a', label: 'Activables' }, { key: 'n', label: 'En attente d’un acte' }]}
          rows={[...new Set(types.map((t) => t.module))].sort((a, b) => Number(a) - Number(b)).map((m) => {
            const ts = types.filter((t) => t.module === m);
            return { key: m, label: `${m} — ${ts[0]?.moduleLabel ?? ''}`, values: { a: ts.filter((t) => t.activable).length, n: ts.filter((t) => !t.activable).length } };
          })} />
        <DonutViz title="Supports des titres" centerLabel="mentions" format={ent} slices={supports.map((r) => ({ key: r.key, label: r.key.toLowerCase().replace(/_/g, ' '), value: r.count }))} />
      </ChartGrid>
    </>
  );
}

interface IndicatorsLike {
  credentials: { total: number; active: number; byStatus: Record<string, number> };
  controls: { total: number; valid: number; expired: number; invalid: number; offline: number; redShare: string; reuseAttempts: number; withRegisteredTerminal?: number; withoutRegisteredTerminal?: number };
  renewals: { total: number; beforeExpiry: number };
  constats: { total: number; open: number; classified: number; transmitted: number };
}
/** Les statuts affichés du moteur de titres (§ 19A.2). */
const TITRE_ETATS: Record<string, string> = { PAS_ENCORE_ACTIF: 'Pas encore actif', VALIDE: 'Valide', BIENTOT_EXPIRE: 'Bientôt expiré', CRITIQUE: 'Critique', EXPIRE: 'Expiré', SUSPENDU: 'Suspendu', INVALIDE: 'Invalide' };
export function IndicateursTitresVisuel({ d }: { d: IndicatorsLike }) {
  return (
    <ChartGrid min={260}>
      <StatusDistribution title="Résultats des contrôles" unitLabel="contrôles"
        items={[{ key: 'v', label: 'Valide', tone: 'good', count: d.controls.valid }, { key: 'e', label: 'Expiré', tone: 'warning', count: d.controls.expired }, { key: 'i', label: 'Invalide', tone: 'critical', count: d.controls.invalid }]} />
      <DonutViz title="Titres émis par état" centerLabel="titres" format={ent}
        slices={Object.entries(d.credentials.byStatus).map(([k, n]) => ({ key: k, label: TITRE_ETATS[k] ?? k.replace(/_/g, ' ').toLowerCase(), value: n }))} />
      <GaugeMeter title="Part des contrôles en rouge" subtitle="suivi, sans cible fixée par un acte" value={d.controls.total ? Number(d.controls.redShare) * 100 : null} unit="%" reason="aucun contrôle" />
      <GaugeMeter title="Renouvellements avant échéance" subtitle={`${d.renewals.beforeExpiry} sur ${d.renewals.total}`} value={d.renewals.total ? (d.renewals.beforeExpiry / d.renewals.total) * 100 : null} unit="%" reason="aucun renouvellement" />
      {d.controls.withoutRegisteredTerminal !== undefined && (
        <StatusDistribution title="Contrôles selon le terminal" unitLabel="contrôles"
          items={[{ key: 'w', label: 'Terminal enregistré', tone: 'good', count: d.controls.withRegisteredTerminal ?? 0 }, { key: 'o', label: 'Sans terminal enregistré', tone: 'warning', count: d.controls.withoutRegisteredTerminal }]} />
      )}
      <StatusDistribution title="Constats (agrégat)" unitLabel="constats"
        items={[{ key: 'o', label: 'À instruire', tone: 'warning', count: d.constats.open }, { key: 'c', label: 'Classés', tone: 'neutral', count: d.constats.classified }, { key: 't', label: 'Transmis', tone: 'info', count: d.constats.transmitted }]} />
    </ChartGrid>
  );
}

/** Contrôle terrain : tuiles de la session du contrôleur (file hors ligne, paquet, constats). */
export function ControleurTuiles({ queued, plates, revocations, constats }: { queued: number; plates: number | null; revocations: number | null; constats: readonly { status: string }[] | null }) {
  return (
    <KpiGrid max={4} label="Contrôle — chiffres clés">
      <KpiTile label="Constats à instruire" value={constats ? constats.filter((k) => k.status === 'OUVERT').length : null} format={ent} reason="constats non lus" sub={constats ? `${constats.length} au total` : undefined} />
      <KpiTile label="Contrôles hors ligne en attente" value={queued} format={ent} state={{ label: queued ? 'À synchroniser' : 'Rien en attente', tone: queued ? 'warning' : 'good' }} />
      <KpiTile label="Plaques du paquet hors ligne" value={plates} format={ent} reason="paquet non téléchargé" />
      <KpiTile label="Révocations du paquet" value={revocations} format={ent} reason="paquet non téléchargé" />
    </KpiGrid>
  );
}
