/**
 * Chaîne véhicule (modules 82 à 84) — visuels en tête d'écran (trousse de visualisation, 27/09/2026).
 * Tous dérivés des réponses déjà chargées par les écrans (indicateurs, procès-verbaux, vignettes, dossiers, sites,
 * centres, flux RFCK) ; aucun chiffre inventé, aucune cible sans acte (« Suivi (sans cible) »), devises séparées.
 */
import {
  BarChartViz, ChartGrid, DonutViz, GaugeMeter, KpiGrid, KpiTile, StatusDistribution, fmtNombre,
} from '../../components/viz';
import type { Tone } from '../../components/StatusBadge';
import { countItems, CountBars, MoneyBars, MonthlyCountLine, statusItems, VisualSummary, type EtatVue } from '../../verticals/visuels';
import { STATE, type Indicators } from './common';

const vue = (codes: string[], extra: Record<string, EtatVue> = {}): Record<string, EtatVue> =>
  Object.fromEntries(codes.map((c) => [c, extra[c] ?? STATE[c] ?? { label: c, tone: 'neutral' as Tone }]));

export const VIGNETTE_ETAT: Record<string, EtatVue> = {
  EN_STOCK: { label: 'En stock (centres)', tone: 'info' }, ATTRIBUEE: { label: 'Attribuée', tone: 'good' },
  ANNULEE: { label: 'Annulée', tone: 'serious' }, REVOQUEE: { label: 'Révoquée', tone: 'critical' },
};
const DOSSIER_ETAT = vue(['CONSTATE', 'ENLEVEMENT_DECIDE', 'EN_GARDE', 'SORTI', 'DESTINATION_PROPOSEE', 'DESTINATION_EXECUTEE', 'CLASSE'], { CLASSE: { label: 'Classé', tone: 'neutral' } });
const CENTRE_ETAT = vue(['INVITE', 'DOSSIER_DEPOSE', 'DILIGENCE_FAITE', 'PROPOSE', 'AGREE', 'SUSPENDU', 'REFUSE']);

interface PvLite { result: string; endedAt: string; centreId: string; demo?: boolean }

/** Contrôle technique : parc connu par état, vignettes par état, procès-verbaux par mois et par centre. */
export function CtVisuels({ i, pvs, stickers, loading, error, onRetry }: {
  i: Indicators['controleTechnique'] | undefined; pvs: PvLite[] | undefined; stickers: { status: string }[] | undefined; loading?: boolean; error?: unknown; onRetry?: () => void;
}) {
  const aucun = i ? Math.max(0, i.vehiculesConnus - i.ctAJour - i.ctEchus - i.defavorables) : 0;
  const example = !!pvs?.some((p) => p.demo);
  return (
    <VisualSummary label="Contrôle technique en un coup d’œil">
      <KpiGrid max={4} label="Contrôle technique — chiffres clés">
        <KpiTile hero label="CT à jour" value={i?.ctAJourPct ?? null} unit="%" format={(v) => fmtNombre(v, 1)} loading={loading && !i} error={error}
          reason="Aucun véhicule connu : taux non mesuré." sub={i ? `${i.ctAJour} / ${i.vehiculesConnus} véhicules connus` : undefined} state={{ label: 'Suivi (sans cible)', tone: 'info' }} />
        <KpiTile label="Échéances proches (30 j)" value={i?.prochainesEcheances30j ?? null} loading={loading && !i} state={{ label: 'À relancer', tone: 'warning' }} />
        <KpiTile label="CT échus" value={i?.ctEchus ?? null} loading={loading && !i} state={{ label: 'Échu', tone: 'critical' }} />
        <KpiTile label="Vignettes émises" value={i?.vignettesEmises ?? null} loading={loading && !i} sub={i ? `${i.vignettesAnnulees} annulée(s) ou révoquée(s)` : undefined} />
      </KpiGrid>
      <ChartGrid min={300}>
        <StatusDistribution title="Parc connu par état du contrôle technique" unitLabel="véhicules" loading={loading && !i} error={error} onRetry={onRetry}
          items={i ? countItems([
            ['A_JOUR', 'À jour', 'good', i.ctAJour - i.ctBientotEchus], ['BIENTOT_ECHU', 'Échéance proche', 'warning', i.ctBientotEchus],
            ['DEFAVORABLE', 'Défavorable — contre-visite', 'serious', i.defavorables], ['ECHU', 'Échu', 'critical', i.ctEchus], ['AUCUN_CONTROLE', 'Aucun contrôle', 'neutral', aucun],
          ]) : []} />
        <StatusDistribution title="Vignettes sécurisées par état" unitLabel="vignettes" items={statusItems(stickers ?? [], (s) => s.status, VIGNETTE_ETAT)} loading={!stickers && loading} />
        <MonthlyCountLine title="Procès-verbaux transmis par mois" subtitle="Fin du contrôle, mois de Kinshasa" items={pvs ?? []} dateOf={(p) => p.endedAt} measure="Procès-verbaux" example={example} />
        <DonutViz title="Résultat des procès-verbaux" centerLabel="procès-verbaux" example={example}
          slices={statusItems(pvs ?? [], (p) => p.result, { FAVORABLE: { label: 'Favorable', tone: 'good' }, DEFAVORABLE: { label: 'Défavorable', tone: 'serious' } }).map((s) => ({ key: s.key, label: s.label, value: s.count }))} />
        <CountBars title="Procès-verbaux par centre agréé" items={pvs ?? []} keyOf={(p) => p.centreId} measure="Procès-verbaux" example={example} />
      </ChartGrid>
    </VisualSummary>
  );
}

interface DossierLite { status: string; daysInCustody: number; demo?: boolean }
interface SiteLite { id: string; name: string; capacity: number; occupancy: number; demo?: boolean }
interface ReconLite { siteId: string; name: string; entries: number; exits: number; inCustody: number }

/** Fourrières : dossiers par étape, occupation des sites, entrées et sorties, recette liquidée / payée par devise. */
export function FourriereVisuels({ f, dossiers, sites, recon, loading, error, onRetry }: {
  f: Indicators['fourriere'] | undefined; dossiers: DossierLite[] | undefined; sites: SiteLite[] | undefined; recon: ReconLite[] | undefined; loading?: boolean; error?: unknown; onRetry?: () => void;
}) {
  const example = !!dossiers?.some((d) => d.demo) || !!sites?.some((s) => s.demo);
  return (
    <VisualSummary label="Fourrières en un coup d’œil">
      <KpiGrid max={4} label="Fourrières — chiffres clés">
        <KpiTile hero label="Véhicules en fourrière" value={f?.enFourriere ?? null} loading={loading && !f} error={error} sub={f ? `${f.constatsEnAttente} constat(s) en attente de décision` : undefined} />
        <KpiTile label="Durée moyenne de garde" value={f?.dureeMoyenneGardeJours ?? null} unit="j" format={(v) => fmtNombre(v, 1)} loading={loading && !f} reason="Aucune sortie : durée non mesurée." />
        <KpiTile label="Garde longue (alerte)" value={f?.gardeLongue ?? null} loading={loading && !f} state={{ label: 'À examiner', tone: (f?.gardeLongue ?? 0) > 0 ? 'warning' : 'good' }} />
        <KpiTile label="Sorties" value={f?.sorties ?? null} loading={loading && !f} sub={f ? `${f.mainlevees} mainlevée(s)` : undefined} />
      </KpiGrid>
      <ChartGrid min={300}>
        <StatusDistribution title="Dossiers par étape de la chaîne" unitLabel="dossiers" items={statusItems(dossiers ?? [], (d) => d.status, DOSSIER_ETAT)} example={example} loading={!dossiers && loading} onRetry={onRetry} />
        <BarChartViz title="Occupation des sites de fourrière" subtitle="Places occupées et capacité, par site" orientation="horizontal" format={(v) => fmtNombre(v, 0)} example={example}
          series={[{ key: 'occ', label: 'Occupées' }, { key: 'cap', label: 'Capacité' }]}
          rows={(sites ?? []).map((s) => ({ key: s.id, label: s.name, values: { occ: s.occupancy, cap: s.capacity } }))} />
        <BarChartViz title="Entrées, sorties et véhicules en garde" subtitle="Rapprochement par site" orientation="horizontal" format={(v) => fmtNombre(v, 0)} example={example}
          series={[{ key: 'e', label: 'Entrées' }, { key: 's', label: 'Sorties' }, { key: 'g', label: 'En garde' }]}
          rows={(recon ?? []).map((x) => ({ key: x.siteId, label: x.name, values: { e: x.entries, s: x.exits, g: x.inCustody } }))} />
        <MoneyBars title="Recette fourrière — liquidée et payée" measure="Recette" example={example}
          rows={f ? [{ label: 'Liquidée', money: f.recetteLiquidee.map((m) => ({ amount: m.amount, currency: m.currency as 'CDF' })) }, { label: 'Payée', money: f.recettePayee.map((m) => ({ amount: m.amount, currency: m.currency as 'CDF' })) }] : []}
          emptyText="Aucune recette liquidée : frais « acte requis » tant que le barème n’est pas certifié." />
      </ChartGrid>
    </VisualSummary>
  );
}

interface CentreLite { id: string; status: string; commune: string; exemple?: boolean }
interface AnalyticsLite { rows: { centreId: string; name: string; inspections: number; passRate: number | null; peerRate: number | null }[]; alerts: unknown[] }

/** Centres agréés : centres par état, par commune, taux de réussite comparé aux pairs (servi par le serveur). */
export function CentresVisuels({ ind, items, an, loading, error, onRetry }: {
  ind: { actifs: number; suspendus: number; enInstruction: number } | undefined; items: CentreLite[] | undefined; an: AnalyticsLite | null | undefined; loading?: boolean; error?: unknown; onRetry?: () => void;
}) {
  const example = !!items?.some((c) => c.exemple);
  const peer = an?.rows.find((r) => r.peerRate !== null)?.peerRate ?? null;
  return (
    <VisualSummary label="Centres agréés en un coup d’œil">
      <KpiGrid max={4} label="Centres agréés — chiffres clés">
        <KpiTile hero label="Centres actifs" value={ind?.actifs ?? null} loading={loading && !ind} error={error} state={{ label: 'Agréés', tone: 'good' }} />
        <KpiTile label="Centres suspendus" value={ind?.suspendus ?? null} loading={loading && !ind} state={{ label: 'Décision motivée', tone: (ind?.suspendus ?? 0) > 0 ? 'critical' : 'good' }} />
        <KpiTile label="Agréments en instruction" value={ind?.enInstruction ?? null} loading={loading && !ind} />
        <KpiTile label="Taux de réussite des pairs" value={peer} unit="%" format={(v) => fmtNombre(v, 1)} reason={an ? 'Aucun contrôle transmis : taux non mesuré.' : 'Analytique réservée à la direction, au contrôle et à l’audit.'} />
      </KpiGrid>
      <ChartGrid min={300}>
        <StatusDistribution title="Centres et tiers de confiance par état" unitLabel="centres" items={statusItems(items ?? [], (c) => c.status, CENTRE_ETAT)} example={example} loading={!items && loading} onRetry={onRetry} />
        <CountBars title="Centres par commune" items={items ?? []} keyOf={(c) => c.commune} measure="Centres" example={example} />
        {an && (
          <BarChartViz title="Taux de réussite par centre" subtitle="Part des contrôles favorables ; ligne : taux des pairs servi par le serveur (alerte seulement, jamais une sanction)"
            orientation="horizontal" format={(v) => `${fmtNombre(v, 1)} %`} example={example}
            reference={peer !== null ? { value: peer, label: `Pairs ${fmtNombre(peer, 1)} %` } : undefined}
            series={[{ key: 't', label: 'Taux de réussite' }]} rows={an.rows.map((r) => ({ key: r.centreId, label: r.name, values: { t: r.passRate } }))} />
        )}
      </ChartGrid>
    </VisualSummary>
  );
}

interface FlowLite { code: string; status: string; statusLabel: string; exchanges: number; label: string }
interface StepLite { status: string }
interface ReqLite { status: string }

/** Raccordement RFCK : flux par état, progression de la séquence d'intégration, exigences du domaine officiel. */
export function RfckVisuels({ flows, steps, reqs, loading }: { flows: FlowLite[] | undefined; steps: StepLite[] | undefined; reqs: ReqLite[] | undefined; loading?: boolean }) {
  const done = steps?.filter((s) => s.status === 'FRANCHIE').length ?? 0;
  const total = steps?.length ?? 0;
  const tone = (s: string): Tone => STATE[s]?.tone ?? 'neutral';
  return (
    <VisualSummary label="Raccordement RFCK en un coup d’œil">
      <KpiGrid max={3} label="Raccordement RFCK — chiffres clés">
        <KpiTile hero label="Flux ouverts par convention" value={flows ? flows.filter((f) => f.status === 'CONVENTION_ACTIVE').length : null} loading={loading && !flows} sub={flows ? `sur ${flows.length} flux` : undefined} />
        <KpiTile label="Échanges enregistrés" value={flows ? flows.reduce((s, f) => s + f.exchanges, 0) : null} loading={loading && !flows} />
        <KpiTile label="Exigences du domaine conformes" value={reqs ? reqs.filter((r) => r.status === 'CONFORME').length : null} loading={loading && !reqs} sub={reqs ? `sur ${reqs.length}` : undefined} />
      </KpiGrid>
      <ChartGrid min={300}>
        <StatusDistribution title="Interfaces RFCK ↔ MOSOLO par état" unitLabel="flux" items={statusItems(flows ?? [], (f) => f.status, Object.fromEntries((flows ?? []).map((f) => [f.status, { label: `Flux : ${f.statusLabel}`, tone: tone(f.status) }])))} loading={!flows && loading} />
        <GaugeMeter title="Séquence d’intégration — étapes franchies" value={total ? (done / total) * 100 : null} unit="%" format={(v) => fmtNombre(v, 0)}
          reason="Séquence non servie." tone="info" toneLabel="Suivi (sans cible)" note={`${done} / ${total} étapes franchies (validation humaine à chaque passage)`} loading={!steps && loading} />
        <StatusDistribution title="Domaine officiel — six exigences" unitLabel="exigences" items={statusItems(reqs ?? [], (r) => r.status, vue(['CONFORME', 'A_FAIRE', 'A_VERIFIER']))} loading={!reqs && loading} />
      </ChartGrid>
    </VisualSummary>
  );
}

interface VehLite { plate: string; controleTechnique: { state: string }; vignetteFiscale: { state: string }; quitus: { state: string }; fourriere: { status: string }[]; appointments: unknown[] }

/** Mes véhicules (usager) : état de chaque titre de ses véhicules. */
export function MesVehiculesVisuels({ vehicles }: { vehicles: VehLite[] }) {
  const v = (k: 'controleTechnique' | 'vignetteFiscale' | 'quitus') => statusItems(vehicles, (x) => x[k].state, STATE);
  return (
    <VisualSummary label="Mes véhicules en un coup d’œil">
      <KpiGrid max={4} label="Mes véhicules — chiffres clés">
        <KpiTile hero label="Véhicules rattachés" value={vehicles.length} />
        <KpiTile label="Contrôle technique à jour" value={vehicles.filter((x) => ['A_JOUR', 'BIENTOT_ECHU'].includes(x.controleTechnique.state)).length} sub={`sur ${vehicles.length}`} />
        <KpiTile label="Dossiers de fourrière en cours" value={vehicles.reduce((s, x) => s + x.fourriere.filter((d) => !['SORTI', 'DESTINATION_EXECUTEE', 'CLASSE'].includes(d.status)).length, 0)} />
        <KpiTile label="Rendez-vous de contrôle" value={vehicles.reduce((s, x) => s + x.appointments.length, 0)} />
      </KpiGrid>
      <ChartGrid min={260}>
        <StatusDistribution title="Contrôle technique" unitLabel="véhicules" items={v('controleTechnique')} />
        <StatusDistribution title="Vignette fiscale" unitLabel="véhicules" items={v('vignetteFiscale')} />
        <StatusDistribution title="Quitus provincial" unitLabel="véhicules" items={v('quitus')} />
      </ChartGrid>
    </VisualSummary>
  );
}

/** Scan unique : activité de contrôle (lecture des indicateurs quand le rôle y est habilité). */
export function ScanVisuels({ scan }: { scan: Indicators['scan'] }) {
  return (
    <KpiGrid max={3} label="Activité du scan unique">
      <KpiTile label="Scans enregistrés" value={scan.scans} />
      <KpiTile label="Décisions d’agent" value={scan.decisions} sub="identité, position, horodatage" />
      <KpiTile label="Constats transmis" value={scan.constatsTransmis} sub="aucun montant, instruction humaine" />
    </KpiGrid>
  );
}
