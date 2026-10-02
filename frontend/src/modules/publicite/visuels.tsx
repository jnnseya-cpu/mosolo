/**
 * Publicité extérieure (KIN PUB CONTROL, modules 15, 35 et 77) — visuels en tête d'écran (trousse de visualisation,
 * 27/09/2026). Données réelles des mêmes routes que les écrans (droits de lecture inchangés) ; démonstration signalée
 * « [EXEMPLE] » ; montants par devise ; aucune cible inventée (taux « Suivi (sans cible) »).
 */
import type { MoneyJSON } from '@mosolo/shared';
import {
  BarChartViz, ChartGrid, DonutViz, GaugeMeter, HeatGrid, KpiGrid, KpiTile, StackedBarViz, StatusDistribution, TimelineStrip, fmtNombre,
} from '../../components/viz';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { countBy } from '../../lib/aggregate';
import { CountBars, countItems, MoneyBars, MonthlyCountLine, statusItems, toNum, VisualSummary } from '../../verticals/visuels';
import { AD_TYPE, CASE_STATUS, DEVICE_STATUS, FINDING, REQUEST_STATUS, RIGHTS, type AuthRequest, type Case, type Device } from './types';

const FINDING_TONE = { CONFORME: 'good', NON_CONFORME: 'serious', NON_DECLARE: 'critical', RETIRE: 'neutral' } as const;
const FINDING_VUE = Object.fromEntries(Object.entries(FINDING).map(([k, label]) => [k, { label, tone: FINDING_TONE[k as keyof typeof FINDING_TONE] ?? 'neutral' }]));

/** Espace de l'exploitant : ses supports par état, par droits, par type. */
export function AdvertiserVisuels({ devices, loading, error, onRetry }: { devices: Device[] | undefined; loading?: boolean; error?: unknown; onRetry?: () => void }) {
  const list = devices ?? [];
  const example = list.some((d) => d.demo);
  return (
    <VisualSummary label="Mes supports en un coup d’œil">
      <KpiGrid max={4} label="Mes supports — chiffres clés">
        <KpiTile hero label="Supports déclarés" value={devices ? list.length : null} loading={loading && !devices} error={error} example={example} />
        <KpiTile label="Autorisés" value={devices ? list.filter((d) => d.status === 'AUTORISE').length : null} loading={loading && !devices} state={{ label: 'Autorisé', tone: 'good' }} />
        <KpiTile label="Échéance à 30 jours" value={devices ? list.filter((d) => d.expiringSoon).length : null} loading={loading && !devices} state={{ label: 'À renouveler', tone: 'warning' }} />
        <KpiTile label="Droits à payer" value={devices ? list.filter((d) => d.rights === 'IMPAYE').length : null} loading={loading && !devices} state={{ label: 'Droits à payer', tone: 'warning' }} />
      </KpiGrid>
      <ChartGrid min={280}>
        <StatusDistribution title="Mes supports par état" unitLabel="supports" items={statusItems(list, (d) => d.status, DEVICE_STATUS)} example={example} loading={loading && !devices} error={error} onRetry={onRetry} />
        <StatusDistribution title="Droits de mes supports" unitLabel="supports" items={statusItems(list, (d) => d.rights, RIGHTS)} example={example} loading={loading && !devices} />
        <DonutViz title="Mes supports par type" centerLabel="supports" example={example}
          slices={countBy(list, (d) => d.type).map((r) => ({ key: r.key, label: AD_TYPE[r.key] ?? r.key, value: r.count }))} loading={loading && !devices} />
      </ChartGrid>
    </VisualSummary>
  );
}

interface InspectionLite { id: string; finding: string; observedAt: string; caseId: string | null }

/** Inspection : constats par nature et par mois, inventaire par état et par commune (lecture du rôle connecté). */
export function InspectorVisuels({ tick }: { tick: number }) {
  const ins = useApi(() => api<{ items: InspectionLite[] }>('/v1/publicite/inspections').then((r) => r.items), [tick]);
  const inv = useApi(() => api<{ items: Device[] }>('/v1/publicite/inventory').then((r) => r.items), [tick]);
  const i = ins.data ?? [];
  const d = inv.data ?? [];
  const example = d.some((x) => x.demo);
  const byCommune = countBy(d, (x) => x.commune);
  return (
    <VisualSummary label="Inspection en un coup d’œil">
      <KpiGrid max={4} label="Inspection — chiffres clés">
        <KpiTile hero label="Contrôles enregistrés" value={ins.data ? i.length : null} loading={ins.loading && !ins.data} error={ins.error} />
        <KpiTile label="Constats non conformes ou non déclarés" value={ins.data ? i.filter((x) => x.finding === 'NON_CONFORME' || x.finding === 'NON_DECLARE').length : null} loading={ins.loading && !ins.data} state={{ label: 'À vérifier par une autre personne', tone: 'warning' }} />
        <KpiTile label="Supports inventoriés" value={inv.data ? d.length : null} loading={inv.loading && !inv.data} error={inv.error} example={example} />
        <KpiTile label="Non déclarés à l’inventaire" value={inv.data ? d.filter((x) => x.status === 'NON_DECLARE').length : null} loading={inv.loading && !inv.data} state={{ label: 'Non déclaré', tone: 'critical' }} />
      </KpiGrid>
      <ChartGrid min={300}>
        <StatusDistribution title="Constats par nature" unitLabel="contrôles" items={statusItems(i, (x) => x.finding, FINDING_VUE)} loading={ins.loading && !ins.data} error={ins.error} onRetry={ins.reload} />
        <MonthlyCountLine title="Contrôles par mois" items={i} dateOf={(x) => x.observedAt} measure="Contrôles" loading={ins.loading && !ins.data} />
        <StatusDistribution title="Inventaire par état" unitLabel="supports" items={statusItems(d, (x) => x.status, DEVICE_STATUS)} example={example} loading={inv.loading && !inv.data} error={inv.error} onRetry={inv.reload} />
        <HeatGrid className="viz-span-2" title="Supports inventoriés par commune" measureLabel="Supports" format={(v) => fmtNombre(v, 0)} example={example}
          cells={byCommune.map((r) => ({ commune: r.key, value: r.count }))} unmeasuredReason="aucun support inventorié dans cette commune" loading={inv.loading && !inv.data} />
      </ChartGrid>
    </VisualSummary>
  );
}

/** Régie : demandes par état et par mois, dossiers de constat par état et par commune. */
export function RegieVisuels({ tick }: { tick: number }) {
  const req = useApi(() => api<{ items: AuthRequest[] }>('/v1/publicite/authorizations').then((r) => r.items), [tick]);
  const cases = useApi(() => api<{ items: Case[] }>('/v1/publicite/cases').then((r) => r.items), [tick]);
  const r = req.data ?? [];
  const c = cases.data ?? [];
  return (
    <VisualSummary label="Régie de la publicité en un coup d’œil">
      <KpiGrid max={4} label="Régie — chiffres clés">
        <KpiTile hero label="Demandes à instruire ou décider" value={req.data ? r.filter((x) => ['DEPOSEE', 'COMPLEMENT_DEMANDE', 'PROPOSEE'].includes(x.status)).length : null} loading={req.loading && !req.data} error={req.error} />
        <KpiTile label="Autorisations accordées" value={req.data ? r.filter((x) => x.status === 'ACCORDEE').length : null} loading={req.loading && !req.data} state={{ label: 'Accordée', tone: 'good' }} />
        <KpiTile label="Constats à vérifier ou décider" value={cases.data ? c.filter((x) => x.status === 'CONSTATE' || x.status === 'VERIFIE').length : null} loading={cases.loading && !cases.data} error={cases.error} />
        <KpiTile label="Dossiers contestés" value={cases.data ? c.filter((x) => x.contests.length > 0).length : null} loading={cases.loading && !cases.data} state={{ label: 'Recours ouvert', tone: 'info' }} />
      </KpiGrid>
      <ChartGrid min={300}>
        <StatusDistribution title="Demandes d’autorisation par état" unitLabel="demandes" items={statusItems(r, (x) => x.status, REQUEST_STATUS)} loading={req.loading && !req.data} error={req.error} onRetry={req.reload} />
        <MonthlyCountLine title="Demandes déposées par mois" items={r} dateOf={(x) => x.submittedAt} measure="Demandes" loading={req.loading && !req.data} />
        <StatusDistribution title="Dossiers de constat par état" unitLabel="dossiers" items={statusItems(c, (x) => x.status, CASE_STATUS)} loading={cases.loading && !cases.data} error={cases.error} onRetry={cases.reload} />
        <CountBars title="Dossiers de constat par commune" items={c} keyOf={(x) => x.commune} measure="Dossiers" loading={cases.loading && !cases.data} />
      </ChartGrid>
    </VisualSummary>
  );
}

export interface AdIndicatorsLite {
  totals: { devices: number; authorized: number; declaredPending: number; undeclared: number; expired: number; retired: number; authorizedRate: string | null; inspections: number; casesOpen: number; casesRetained: number; casesDismissed: number; contested: number };
  byCommune: { commune: string; devices: number; authorized: number; undeclared: number; authorizedRate: string | null; revenue: MoneyJSON[] }[];
  inspectors: { inspectorId: string; name: string; inspections: number; withPhotosAndGps: number; casesVerified: number }[];
}

/** Supervision : parc par état, taux d'autorisation, carte des communes, recettes par commune, qualité des équipes. */
export function AdDashboardVisuels({ d }: { d: AdIndicatorsLite }) {
  const t = d.totals;
  return (
    <VisualSummary label="Supervision de la publicité — graphiques">
      <ChartGrid min={300}>
        <StatusDistribution title="Parc de supports par état" unitLabel="supports" example
          items={countItems([['AUTORISE', 'Autorisé', 'good', t.authorized], ['DECLARE', 'Déclaré — autorisation en attente', 'info', t.declaredPending], ['EXPIRE', 'Autorisation expirée', 'warning', t.expired], ['NON_DECLARE', 'Non déclaré', 'critical', t.undeclared], ['RETIRE', 'Retiré', 'neutral', t.retired]])} />
        <GaugeMeter title="Taux d’autorisation des supports actifs" value={toNum(t.authorizedRate)} unit="%" format={(v) => fmtNombre(v, 1)} tone="info" toneLabel="Suivi (sans cible)"
          reason="Aucun support actif : taux non mesuré." example note="Aucune cible fixée par un acte : suivi seulement." />
        <StatusDistribution title="Dossiers de constat" unitLabel="dossiers" example note={`Dont ${t.contested} dossier(s) contesté(s) (recours ouvert).`}
          items={countItems([['OUVERT', 'En cours', 'warning', t.casesOpen], ['RETENU', 'Retenus', 'serious', t.casesRetained], ['CLASSE', 'Classés ou écartés', 'info', t.casesDismissed]])} />
        <HeatGrid className="viz-span-2" title="Taux d’autorisation par commune" measureLabel="Taux d’autorisation" unit="%" domain={[0, 100]} format={(v) => fmtNombre(v, 0)} example
          cells={d.byCommune.map((c) => ({ commune: c.commune, value: toNum(c.authorizedRate), detail: `${c.authorized} autorisé(s) sur ${c.devices} · ${c.undeclared} non déclaré(s)` }))}
          unmeasuredReason="aucun support enregistré dans cette commune" />
        <StackedBarViz title="Supports par commune" subtitle="Autorisés et non déclarés (parts disjointes)" mode="absolute" example
          series={[{ key: 'a', label: 'Autorisés' }, { key: 'u', label: 'Non déclarés' }, { key: 'o', label: 'Autres états' }]}
          rows={d.byCommune.map((c) => ({ label: c.commune, values: { a: c.authorized, u: c.undeclared, o: Math.max(0, c.devices - c.authorized - c.undeclared) } }))} />
        <MoneyBars title="Recettes confirmées par commune" measure="Recettes" example rows={d.byCommune.map((c) => ({ label: c.commune, money: c.revenue }))} emptyText="Aucune recette confirmée pour l’instant." />
        <BarChartViz title="Qualité des équipes de contrôle" subtitle="Contrôles et contrôles avec photos et GPS — jamais le nombre de sanctions" orientation="horizontal" format={(v) => fmtNombre(v, 0)} example
          series={[{ key: 'i', label: 'Contrôles' }, { key: 'p', label: 'Avec photos et GPS' }, { key: 'v', label: 'Dossiers vérifiés' }]}
          rows={d.inspectors.map((x) => ({ key: x.inspectorId, label: x.name, values: { i: x.inspections, p: x.withPhotosAndGps, v: x.casesVerified } }))} />
      </ChartGrid>
    </VisualSummary>
  );
}

export interface CarteLite {
  supports: { status: string; expiringSoon: boolean; openCase: boolean }[];
  density: { commune: string; activeSupports: number }[];
  zonesToControl: { computed: { commune: string; undeclared: number; expired: number; openCases: number; citizenReports: number; aiConfirmed: number; total: number }[] };
  availableSpaces: unknown[]; interventions: unknown[]; citizenReports: unknown[]; aiProposals: unknown[];
}

/** Carte et pilote : densité par commune, priorités de contrôle (proposées, jamais ordonnées), avancement du pilote. */
export function CarteVisuels({ L, steps }: { L: CarteLite; steps: { status: string }[] | undefined }) {
  const done = steps?.filter((s) => s.status === 'TERMINEE').length ?? 0;
  return (
    <VisualSummary label="Carte de la publicité — graphiques">
      <KpiGrid max={4} label="Carte — chiffres clés">
        <KpiTile hero label="Supports cartographiés" value={L.supports.length} example />
        <KpiTile label="Espaces disponibles" value={L.availableSpaces.length} example />
        <KpiTile label="Signalements citoyens" value={L.citizenReports.length} />
        <KpiTile label="Propositions d’analyse d’image" value={L.aiProposals.length} sub="à vérifier par une personne" />
      </KpiGrid>
      <ChartGrid min={300}>
        <HeatGrid className="viz-span-2" title="Densité de supports actifs par commune" measureLabel="Supports actifs" format={(v) => fmtNombre(v, 0)} example
          cells={L.density.map((x) => ({ commune: x.commune, value: x.activeSupports }))} unmeasuredReason="aucun support actif cartographié" />
        <StackedBarViz title="Zones à contrôler — motifs par commune" subtitle="Priorités proposées (jamais un ordre de contrôle)" mode="absolute" example
          series={[{ key: 'u', label: 'Non déclarés' }, { key: 'e', label: 'Expirés' }, { key: 'c', label: 'Dossiers ouverts' }, { key: 'r', label: 'Signalements' }, { key: 'a', label: 'Analyses confirmées' }]}
          rows={L.zonesToControl.computed.map((x) => ({ label: x.commune, values: { u: x.undeclared, e: x.expired, c: x.openCases, r: x.citizenReports, a: x.aiConfirmed } }))} />
        <StatusDistribution title="Supports cartographiés par état" unitLabel="supports" items={statusItems(L.supports, (s) => s.status, DEVICE_STATUS)} example />
        {steps && (
          <GaugeMeter title="Pilote en sept étapes — avancement" value={steps.length ? (done / steps.length) * 100 : null} unit="%" format={(v) => fmtNombre(v, 0)} tone="info" toneLabel="Suivi (sans cible)"
            reason="Pilote non servi." note={`${done} / ${steps.length} étapes terminées`} />
        )}
      </ChartGrid>
    </VisualSummary>
  );
}

interface ExpiryLite { kind: 'CONTRAT' | 'AUTORISATION'; id: string; reference: string; until: string; daysLeft: number; expiringSoon: boolean; expired: boolean }

/** Contrats et échéances : frise des échéances, par état. */
export function ContratsVisuels({ items, noticeDays }: { items: ExpiryLite[]; noticeDays: number }) {
  const cat = (i: ExpiryLite) => (i.expired ? 'Échu' : i.expiringSoon ? `Dans le préavis (${noticeDays} j)` : 'Plus tard');
  return (
    <VisualSummary label="Échéances en un coup d’œil">
      <ChartGrid min={300}>
        <StatusDistribution title="Échéances par état" unitLabel="échéances"
          items={countItems([['ECHU', 'Échu', 'critical', items.filter((i) => i.expired).length], ['PREAVIS', `Dans le préavis (${noticeDays} j)`, 'warning', items.filter((i) => !i.expired && i.expiringSoon).length], ['PLUS_TARD', 'Plus tard', 'good', items.filter((i) => !i.expired && !i.expiringSoon).length]])} />
        <TimelineStrip className="viz-span-2" title="Frise des échéances" subtitle="Contrats et autorisations" categories={['Échu', `Dans le préavis (${noticeDays} j)`, 'Plus tard']}
          events={items.map((i) => ({ id: `${i.kind}-${i.id}`, at: i.until, category: cat(i), label: `${i.kind === 'CONTRAT' ? 'Contrat' : 'Autorisation'} ${i.reference}` }))} />
      </ChartGrid>
    </VisualSummary>
  );
}
