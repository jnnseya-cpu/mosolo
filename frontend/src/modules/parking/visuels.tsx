/**
 * Stationnement (modules 14, 70, 71, 75 et 76) et agents (commissions, surveillance) — visuels en tête d'écran
 * (trousse de visualisation, 27/09/2026). Données réelles des mêmes routes que les écrans ; montants par devise ;
 * cible d'occupation lue sur le serveur (fourchette de l'acte, 15 à 25 % de places libres), jamais inventée.
 */
import type { MoneyJSON } from '@mosolo/shared';
import {
  BarChartViz, ChartGrid, GaugeMeter, HeatGrid, KpiGrid, KpiTile, MatrixHeat, StackedBarViz, StatusDistribution, fmtNombre,
} from '../../components/viz';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { countBy } from '../../lib/aggregate';
import { CountBars, countItems, MoneyBars, MonthlyCountLine, statusItems, toNum, VisualSummary, type EtatVue } from '../../verticals/visuels';
import { NATURE, SESSION_STATUS, VIOLATION_STATUS, ZONE_STATUS, type Reservation, type Session, type Violation, type Zone } from './shared';

const RESA_ETAT: Record<string, EtatVue> = {
  DEMANDEE: { label: 'Demandée — décision attendue', tone: 'warning' }, APPROUVEE: { label: 'Approuvée', tone: 'good' }, REFUSEE: { label: 'Refusée', tone: 'critical' },
};

/** Usager : ses sessions par état et par mois, ses paiements par zone (une devise par graphique). */
export function DriverVisuels({ sessions, loading, error, onRetry }: { sessions: Session[] | null | undefined; loading?: boolean; error?: unknown; onRetry?: () => void }) {
  const list = sessions ?? [];
  const example = list.some((s) => s.zone?.demo);
  return (
    <VisualSummary label="Mon stationnement en un coup d’œil">
      <KpiGrid max={4} label="Mon stationnement — chiffres clés">
        <KpiTile hero label="Sessions actives" value={sessions ? list.filter((s) => s.status === 'ACTIVE').length : null} loading={loading && !sessions} error={error} state={{ label: 'Titre valide', tone: 'good' }} example={example} />
        <KpiTile label="En attente du paiement" value={sessions ? list.filter((s) => s.status === 'EN_ATTENTE_PAIEMENT').length : null} loading={loading && !sessions} />
        <KpiTile label="Sessions au total" value={sessions ? list.length : null} loading={loading && !sessions} />
        <KpiTile label="Temps payé" value={sessions ? list.reduce((a, s) => a + s.totalMinutes, 0) : null} unit="min" format={(v) => fmtNombre(v, 0)} loading={loading && !sessions} />
      </KpiGrid>
      <ChartGrid min={280}>
        <StatusDistribution title="Mes sessions par état" unitLabel="sessions" items={statusItems(list, (s) => s.status, SESSION_STATUS)} example={example} loading={loading && !sessions} error={error} onRetry={onRetry} />
        <MonthlyCountLine title="Mes sessions par mois" items={list} dateOf={(s) => s.createdAt} measure="Sessions" example={example} loading={loading && !sessions} />
        <MoneyBars title="Mes paiements par zone" measure="Montant" example={example} rows={list.map((s) => ({ label: s.zone?.name ?? 'Zone inconnue', money: s.total }))} emptyText="Aucun paiement de stationnement." />
      </ChartGrid>
    </VisualSummary>
  );
}

/** Contrôle et vérification : constats par état, par nature, par mois et par commune. */
export function ViolationsVisuels({ violations, title = 'Constats', loading, error, onRetry }: { violations: Violation[] | null | undefined; title?: string; loading?: boolean; error?: unknown; onRetry?: () => void }) {
  const list = violations ?? [];
  return (
    <VisualSummary label={`${title} en un coup d’œil`}>
      <KpiGrid max={4} label={`${title} — chiffres clés`}>
        <KpiTile hero label={title} value={violations ? list.length : null} loading={loading && !violations} error={error} />
        <KpiTile label="À vérifier" value={violations ? list.filter((v) => v.status === 'CONSTATE').length : null} loading={loading && !violations} state={{ label: 'Autre personne', tone: 'warning' }} />
        <KpiTile label="Décision attendue" value={violations ? list.filter((v) => v.status === 'VERIFIE').length : null} loading={loading && !violations} />
        <KpiTile label="Contestés" value={violations ? list.filter((v) => v.contests.length > 0).length : null} loading={loading && !violations} state={{ label: 'Recours ouvert', tone: 'info' }} />
      </KpiGrid>
      <ChartGrid min={280}>
        <StatusDistribution title={`${title} par état`} unitLabel="constats" items={statusItems(list, (v) => v.status, VIOLATION_STATUS)} loading={loading && !violations} error={error} onRetry={onRetry} />
        <CountBars title={`${title} par nature`} items={list} keyOf={(v) => v.nature} labelOf={(k) => NATURE[k] ?? k} measure="Constats" />
        <MonthlyCountLine title={`${title} par mois`} items={list} dateOf={(v) => v.createdAt} measure="Constats" />
        <HeatGrid className="viz-span-2" title={`${title} par commune`} measureLabel="Constats" format={(v) => fmtNombre(v, 0)}
          cells={countBy(list, (v) => v.commune).map((r) => ({ commune: r.key, value: r.count }))} unmeasuredReason="aucun constat dans cette commune" />
      </ChartGrid>
    </VisualSummary>
  );
}

/** Régie : constats, réservations et zones (lecture des mêmes routes que les onglets). */
export function ParkingRegieVisuels({ tick }: { tick: number }) {
  const vio = useApi(() => api<{ items: Violation[] }>('/v1/parking/violations').then((r) => r.items), [tick]);
  const res = useApi(() => api<{ items: Reservation[] }>('/v1/parking/reservations').then((r) => r.items), [tick]);
  const zones = useApi(() => api<{ items: Zone[] }>('/v1/parking/zones').then((r) => r.items), [tick]);
  const z = zones.data ?? [];
  const example = z.some((x) => x.demo);
  return (
    <VisualSummary label="Régie du stationnement en un coup d’œil">
      <KpiGrid max={4} label="Régie — chiffres clés">
        <KpiTile hero label="Constats à décider" value={vio.data ? vio.data.filter((v) => v.status === 'VERIFIE').length : null} loading={vio.loading && !vio.data} error={vio.error} />
        <KpiTile label="Réservations à décider" value={res.data ? res.data.filter((r) => r.status === 'DEMANDEE').length : null} loading={res.loading && !res.data} error={res.error} />
        <KpiTile label="Zones ouvertes" value={zones.data ? z.filter((x) => x.legalStatus === 'OUVERTE').length : null} loading={zones.loading && !zones.data} error={zones.error} sub={zones.data ? `sur ${z.length} zones` : undefined} example={example} />
        <KpiTile label="Zones en attente d’acte" value={zones.data ? z.filter((x) => x.legalStatus === 'ACTE_REQUIS').length : null} loading={zones.loading && !zones.data} state={{ label: 'Acte requis', tone: 'neutral' }} />
      </KpiGrid>
      <ChartGrid min={300}>
        <StatusDistribution title="Constats par état" unitLabel="constats" items={statusItems(vio.data ?? [], (v) => v.status, VIOLATION_STATUS)} loading={vio.loading && !vio.data} error={vio.error} onRetry={vio.reload} />
        <StatusDistribution title="Réservations par état" unitLabel="réservations" items={statusItems(res.data ?? [], (r) => r.status, RESA_ETAT)} loading={res.loading && !res.data} error={res.error} onRetry={res.reload} />
        <StatusDistribution title="Zones par statut juridique" unitLabel="zones" items={statusItems(z, (x) => x.legalStatus, ZONE_STATUS)} example={example} loading={zones.loading && !zones.data} />
        <StackedBarViz title="Occupation des zones ouvertes" subtitle="Places occupées, réservées et libres (parts disjointes)" mode="absolute" example={example}
          series={[{ key: 'a', label: 'Occupées' }, { key: 'r', label: 'Réservées' }, { key: 'f', label: 'Libres' }]}
          rows={z.filter((x) => x.legalStatus !== 'ACTE_REQUIS' && x.occupancy.capacity > 0).map((x) => ({ key: x.id, label: x.name, values: { a: x.occupancy.active, r: x.occupancy.reserved, f: x.occupancy.free } }))} />
      </ChartGrid>
    </VisualSummary>
  );
}

interface ZoneIndicatorRow { zoneId: string; code: string; name: string; legalStatus: string; freeTarget: string; capacity: number; occupancyRate: string | null; complianceRate: string | null; paidSessionsToday: number; demo: boolean }
interface DashboardLite {
  totals: { occupancyRate: string | null; complianceRate: string | null; checks: number };
  zones: ZoneIndicatorRow[]; byCommune: { commune: string; revenue: MoneyJSON[] }[];
}

const CIBLE_ETAT: Record<string, EtatVue> = {
  DANS_LA_CIBLE: { label: 'Dans la cible (15 à 25 % libres)', tone: 'good' }, SATURE: { label: 'Saturée (< 15 % libres)', tone: 'warning' },
  SOUS_UTILISE: { label: 'Sous-utilisée (> 25 % libres)', tone: 'info' }, SANS_OBJET: { label: 'Sans objet', tone: 'neutral' },
};

/** Tableau de bord : zones par position vs cible, conformité, recettes par commune, sessions payées du jour. */
export function ParkingDashboardVisuels({ d }: { d: DashboardLite }) {
  const example = d.zones.some((z) => z.demo);
  const open = d.zones.filter((z) => z.legalStatus !== 'ACTE_REQUIS' && z.capacity > 0);
  return (
    <VisualSummary label="Stationnement — graphiques de pilotage">
      <ChartGrid min={300}>
        <StatusDistribution title="Zones ouvertes par rapport à la cible" subtitle="Cible de l’acte : 15 à 25 % de places libres" unitLabel="zones" example={example}
          items={statusItems(open, (z) => z.freeTarget, CIBLE_ETAT)} />
        <GaugeMeter title="Occupation des zones ouvertes" value={toNum(d.totals.occupancyRate)} unit="%" format={(v) => fmtNombre(v, 1)} example={example}
          tone="info" toneLabel="Lecture : cible exprimée en places libres, par zone" reason="Aucune zone ouverte : occupation non mesurée." />
        <GaugeMeter title="Conformité au contrôle" value={toNum(d.totals.complianceRate)} unit="%" format={(v) => fmtNombre(v, 1)} example={example}
          tone="info" toneLabel="Suivi (sans cible)" reason="Aucun contrôle enregistré : conformité non mesurée." note={`${d.totals.checks} contrôle(s)`} />
        <BarChartViz title="Sessions payées aujourd’hui, par zone" orientation="horizontal" format={(v) => fmtNombre(v, 0)} example={example}
          series={[{ key: 'n', label: 'Sessions payées' }]} rows={open.map((z) => ({ key: z.zoneId, label: z.name, values: { n: z.paidSessionsToday } }))} />
        <MoneyBars title="Recettes confirmées par commune de la zone" measure="Recettes" example={example} rows={d.byCommune.map((c) => ({ label: c.commune, money: c.revenue }))} emptyText="Aucune recette confirmée pour l’instant." />
      </ChartGrid>
    </VisualSummary>
  );
}

interface HourCellLite { hour: number; observed: boolean; freeRate: string | null; target: string }
interface OccupancyLite { date: string; target: { minPct: number; maxPct: number }; zones: { zoneId: string; code: string; name: string; capacity: number; demo: boolean; hours: HourCellLite[]; hoursSaturated: number; hoursUnderused: number; alert: unknown }[]; alerts: unknown[] }

/** ParkSmart : places libres par zone et par heure (carte de chaleur), heures saturées et sous-utilisées. */
export function ParkSmartVisuels() {
  const occ = useApi(() => api<OccupancyLite>('/v1/parking/occupancy'), []);
  const d = occ.data;
  const zones = (d?.zones ?? []).filter((z) => z.capacity > 0);
  const example = zones.some((z) => z.demo);
  const hours = Array.from({ length: 24 }, (_, h) => `${h} h`);
  return (
    <VisualSummary label="ParkSmart en un coup d’œil">
      <KpiGrid max={4} label="ParkSmart — chiffres clés">
        <KpiTile hero label="Zones suivies" value={d ? zones.length : null} loading={occ.loading && !d} error={occ.error} example={example} />
        <KpiTile label="Alertes d’occupation" value={d ? d.alerts.length : null} loading={occ.loading && !d} state={{ label: 'À examiner', tone: (d?.alerts.length ?? 0) > 0 ? 'warning' : 'good' }} />
        <KpiTile label="Heures saturées" value={d ? zones.reduce((a, z) => a + z.hoursSaturated, 0) : null} loading={occ.loading && !d} sub={d ? `moins de ${d.target.minPct} % libres` : undefined} />
        <KpiTile label="Heures sous-utilisées" value={d ? zones.reduce((a, z) => a + z.hoursUnderused, 0) : null} loading={occ.loading && !d} sub={d ? `plus de ${d.target.maxPct} % libres` : undefined} />
      </KpiGrid>
      <ChartGrid min={300}>
        <MatrixHeat className="viz-span-all" title={`Places libres par zone et par heure${d ? ` — ${d.date}` : ''}`} subtitle={d ? `Cible de l’acte : ${d.target.minPct} à ${d.target.maxPct} % de places libres ; case vide = heure non observée` : undefined}
          rows={zones.map((z) => z.code)} cols={hours} values={zones.map((z) => z.hours.map((h) => (h.observed ? toNum(h.freeRate) : null)))}
          measureLabel="Places libres" unit="%" domain={[0, 100]} format={(v) => fmtNombre(v, 0)} colTickEvery={3} example={example}
          loading={occ.loading && !d} error={occ.error} onRetry={occ.reload} />
        <StackedBarViz title="Heures par position vis-à-vis de la cible" subtitle="Heures observées de la journée, par zone" mode="absolute" example={example}
          series={[{ key: 's', label: 'Saturées' }, { key: 'c', label: 'Dans la cible' }, { key: 'u', label: 'Sous-utilisées' }]}
          rows={zones.map((z) => ({ key: z.zoneId, label: z.code, values: { s: z.hoursSaturated, c: z.hours.filter((h) => h.target === 'DANS_LA_CIBLE').length, u: z.hoursUnderused } }))} />
      </ChartGrid>
    </VisualSummary>
  );
}

/** Tarification automatique : tarif appliqué par heure dans les fourchettes de l'acte (minimum, appliqué, maximum). */
export function TarifHeuresViz({ code, currency, hours, example }: { code: string; currency: string | undefined; hours: { hour: number; band: { min: string; max: string } | null; rate: string | null }[]; example?: boolean }) {
  const rows = hours.filter((h) => h.band).map((h) => ({ key: String(h.hour), label: `${String(h.hour).padStart(2, '0')} h`, values: { min: toNum(h.band!.min), rate: toNum(h.rate), max: toNum(h.band!.max) } }));
  return (
    <BarChartViz title={`Tarif appliqué et fourchette de l’acte — ${code}`} subtitle={`Par heure, en ${currency ?? 'devise de la règle'} par unité de la formule`} format={(v) => `${fmtNombre(v, 2)} ${currency ?? ''}`.trim()}
      series={[{ key: 'min', label: 'Minimum (acte)' }, { key: 'rate', label: 'Tarif appliqué' }, { key: 'max', label: 'Maximum (acte)' }]} rows={rows} example={example} />
  );
}

interface EarningLineLite { moduleLabel?: string; state: string; at: string; commission: MoneyJSON; source: string }
const GAIN_ETAT: Record<string, EtatVue> = {
  ACQUISE: { label: 'Acquise', tone: 'good' }, CONFIRMEE: { label: 'Payée — rapprochement en cours', tone: 'info' },
  EN_ATTENTE: { label: 'En attente de paiement', tone: 'neutral' }, ANNULEE: { label: 'Annulée', tone: 'critical' },
};

/** Mes gains : lignes par état et par mois, commission de référence par module (par devise). */
export function EarningsVisuels({ lines, validation }: { lines: EarningLineLite[]; validation?: { aDemander: number; demandees: number; validees: number } }) {
  return (
    <VisualSummary label="Mes gains en un coup d’œil">
      <ChartGrid min={280}>
        <StatusDistribution title="Lignes de commission par état" unitLabel="lignes" items={statusItems(lines, (l) => l.state, GAIN_ETAT)} />
        {validation && (
          <StatusDistribution title="Validation avant versement" unitLabel="lignes"
            items={countItems([['A_DEMANDER', 'À faire valider', 'neutral', validation.aDemander], ['DEMANDEE', 'Validation demandée', 'info', validation.demandees], ['VALIDEE', 'Validée — payable', 'good', validation.validees]])} />
        )}
        <MonthlyCountLine title="Lignes de commission par mois" items={lines} dateOf={(l) => l.at} measure="Lignes" />
        <MoneyBars title="Commission de référence par module" measure="Commission (référence)" rows={lines.filter((l) => l.state !== 'ANNULEE').map((l) => ({ label: l.moduleLabel ?? 'Stationnement', money: l.commission }))}
          note="Indicative : la quote-part de réserve (points × note de qualité) fait foi." emptyText="Aucune commission pour l’instant." />
      </ChartGrid>
    </VisualSummary>
  );
}

/** Commissions des agents (pilotage) : points de résultats vérifiés et quote-part par agent. */
export function AgentsCommissionsVisuels({ items }: { items: { agentId: string; agentName: string; counts: { penalites: number; paiements: number }; reserve?: { points: number; share: MoneyJSON[] } | null }[] }) {
  return (
    <ChartGrid min={300}>
      <BarChartViz title="Points de résultats vérifiés par agent" subtitle="Base de la réserve (§ 37A.5) — jamais le montant liquidé" orientation="horizontal" format={(v) => fmtNombre(v, 0)}
        series={[{ key: 'p', label: 'Points' }]} rows={items.filter((a) => a.reserve).map((a) => ({ key: a.agentId, label: a.agentName, values: { p: a.reserve!.points } }))}
        emptyText="Aucune réserve calculée pour l’instant." />
      <BarChartViz title="Contrôles ayant abouti, par agent" orientation="horizontal" format={(v) => fmtNombre(v, 0)}
        series={[{ key: 'pay', label: 'Paiements générés' }, { key: 'pen', label: 'Pénalités' }]} rows={items.map((a) => ({ key: a.agentId, label: a.agentName, values: { pay: a.counts.paiements, pen: a.counts.penalites } }))} />
      <MoneyBars title="Quote-part de réserve par agent" measure="Quote-part" rows={items.map((a) => ({ label: a.agentName, money: a.reserve?.share ?? [] }))} emptyText="Aucune quote-part calculée pour l’instant." />
    </ChartGrid>
  );
}

interface ValidationLite { status: 'DEMANDEE' | 'VALIDEE' | 'REFUSEE'; agentName: string; requestedAt: string; total: MoneyJSON[] }

/** Validation des commissions : demandes par état, par agent, montants demandés par devise. */
export function ValidationsVisuels({ items }: { items: ValidationLite[] }) {
  const ETAT: Record<string, EtatVue> = { DEMANDEE: { label: 'À décider', tone: 'warning' }, VALIDEE: { label: 'Validée — payable', tone: 'good' }, REFUSEE: { label: 'Refusée', tone: 'critical' } };
  return (
    <VisualSummary label="Validation des commissions en un coup d’œil">
      <ChartGrid min={280}>
        <StatusDistribution title="Demandes de validation par état" unitLabel="demandes" items={statusItems(items, (r) => r.status, ETAT)} />
        <CountBars title="Demandes par agent" items={items} keyOf={(r) => r.agentName} measure="Demandes" />
        <MoneyBars title="Commission demandée par agent" measure="Commission" rows={items.map((r) => ({ label: r.agentName, money: r.total }))} emptyText="Aucune demande." />
      </ChartGrid>
    </VisualSummary>
  );
}

interface MonitoringRowLite { agentId: string; agentName: string; totals: { controls: number; constats: number; retained: number; rejected: number; dismissed: number; contested: number; annulled: number }; constatRatePct: string | null; signals: { level: string }[] }

/** Surveillance des constats : issue des constats par agent, taux de constats, agents à examiner. */
export function MonitoringVisuels({ rows }: { rows: MonitoringRowLite[] }) {
  const flagged = rows.filter((r) => r.signals.some((s) => s.level === 'A_EXAMINER')).length;
  return (
    <VisualSummary label="Surveillance des constats — graphiques">
      <ChartGrid min={300}>
        <StatusDistribution title="Agents par niveau de signal" unitLabel="agents" subtitle="Un signal ouvre un examen humain, jamais une mesure"
          items={countItems([['AUCUN', 'Aucun signal', 'good', rows.filter((r) => r.signals.length === 0).length], ['SUIVRE', 'À suivre', 'info', rows.filter((r) => r.signals.length > 0).length - flagged], ['EXAMINER', 'À examiner', 'warning', flagged]])} />
        <StackedBarViz title="Issue des constats par agent" subtitle="Parts disjointes" mode="absolute"
          series={[{ key: 'r', label: 'Retenus' }, { key: 'e', label: 'Écartés' }, { key: 'c', label: 'Classés' }, { key: 'a', label: 'Annulés' }]}
          rows={rows.map((r) => ({ key: r.agentId, label: r.agentName, values: { r: r.totals.retained, e: r.totals.rejected, c: r.totals.dismissed, a: r.totals.annulled } }))} />
        <BarChartViz title="Taux de constats par agent" subtitle="Constats rapportés aux contrôles" orientation="horizontal" format={(v) => `${fmtNombre(v, 1)} %`}
          series={[{ key: 't', label: 'Taux de constats' }]} rows={rows.map((r) => ({ key: r.agentId, label: r.agentName, values: { t: toNum(r.constatRatePct) } }))} />
      </ChartGrid>
    </VisualSummary>
  );
}
