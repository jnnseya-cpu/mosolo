/**
 * Verticales de la Partie V, CALCU, patrimoine, environnement, grands redevables, modules sectoriels et fiches 13 à 25
 * — visuels en tête d'écran (trousse de visualisation, 27/09/2026). Chaque graphique lit les données déjà servies aux
 * écrans (mêmes routes, mêmes droits) ; montants par devise ; non mesuré motivé ; démonstration « [EXEMPLE] ».
 */
import type { MoneyJSON } from '@mosolo/shared';
import {
  BarChartViz, ChartGrid, DonutViz, GaugeMeter, HeatGrid, KpiGrid, KpiTile, LadderFunnel, LineAreaViz, StackedBarViz, StatusDistribution, fmtNombre, type LadderStep,
} from '../../components/viz';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { countBy } from '../../lib/aggregate';
import {
  CASE_TONE, OBJ_LABEL, OBLIGATION_LABEL, OBLIGATION_TONE, RECEIPT_LABEL, type AviaDeclaration, type CaseView, type VerticalSpaceData,
} from '../../verticals/catalogue';
import { CountBars, countItems, MoneyBars, MonthlyCountLine, statusItems, toNum, VisualSummary, type EtatVue } from '../../verticals/visuels';

const pct = (v: string | null | undefined) => toNum(v === null || v === undefined ? null : String(v).replace('%', '').trim());
const OBJ_TONE: Record<string, EtatVue['tone']> = { VERIFIE: 'good', DECLARE: 'warning', OBSERVE: 'info', CONTESTE: 'critical' };
const OBJ_VUE: Record<string, EtatVue> = Object.fromEntries(Object.entries(OBJ_LABEL).map(([k, label]) => [k, { label, tone: OBJ_TONE[k] ?? 'neutral' }]));
const OBLIG_VUE: Record<string, EtatVue> = Object.fromEntries(Object.entries(OBLIGATION_LABEL).map(([k, label]) => [k, { label, tone: OBLIGATION_TONE[k] ?? 'neutral' }]));
const RECEIPT_TONE: Record<string, EtatVue['tone']> = { DEFINITIVE: 'good', PROVISOIRE: 'warning', ANNULEE: 'neutral', REMPLACEE: 'neutral', SUSPECTE: 'serious' };
const RECEIPT_VUE: Record<string, EtatVue> = Object.fromEntries(Object.entries(RECEIPT_LABEL).map(([k, label]) => [k, { label, tone: RECEIPT_TONE[k] ?? 'neutral' }]));

/** Répartition des démarches par état (libellé servi par le serveur). */
function caseItems(cases: readonly CaseView[]) {
  const vue: Record<string, EtatVue> = {};
  for (const c of cases) vue[c.status] = { label: c.statusLabel, tone: CASE_TONE[c.status] ?? 'neutral' };
  const order = ['DEPOSE', 'EN_INSTRUCTION', 'COMPLEMENT_DEMANDE', 'PROPOSE', 'ACCEPTE', 'REFUSE'];
  return statusItems(cases, (c) => c.status, Object.fromEntries([...order.filter((k) => vue[k]).map((k) => [k, vue[k]!]), ...Object.entries(vue).filter(([k]) => !order.includes(k))]));
}

// ------------------------------------------------------------------------------------------------ espace /services/:slug

/** Espace du contribuable dans une verticale : objets, obligations, quittances, démarches. */
export function EspaceVerticaleVisuels({ s, example }: { s: VerticalSpaceData; example?: boolean }) {
  const aPayer = s.obligations.filter((o) => !['SOLDEE', 'ANNULEE', 'ADMISE_EN_NON_VALEUR'].includes(o.status));
  const ouvertes = s.cases.filter((c) => !['ACCEPTE', 'REFUSE'].includes(c.status));
  return (
    <VisualSummary label="Mon espace en un coup d’œil">
      <KpiGrid max={4} label="Mon espace — chiffres clés">
        <KpiTile hero label="Éléments enregistrés" value={s.objects.length} example={example} sub={`${s.objects.filter((o) => o.probativeStatus === 'VERIFIE').length} vérifié(s)`} />
        <KpiTile label="Obligations à payer" value={aPayer.length} state={{ label: aPayer.length ? 'À payer' : 'À jour', tone: aPayer.length ? 'warning' : 'good' }} example={example} />
        <KpiTile label="Quittances" value={s.receipts.length} sub={`${s.receipts.filter((r) => r.status === 'DEFINITIVE').length} définitive(s)`} />
        <KpiTile label="Démarches en cours" value={ouvertes.length} sub={`${s.cases.length} au total`} />
      </KpiGrid>
      <ChartGrid min={260}>
        <StatusDistribution title="Mes obligations par état" unitLabel="obligations" items={statusItems(s.obligations, (o) => o.status, OBLIG_VUE)} example={example} emptyText="Aucune obligation dans ce service." />
        <MoneyBars title="Montants de mes obligations" measure="Montant" rows={s.obligations.map((o) => ({ label: OBLIGATION_LABEL[o.status] ?? o.status, money: o.amount }))} example={example} emptyText="Aucun montant (acte requis ou aucune obligation)." />
        <StatusDistribution title="Mes éléments par statut probatoire" unitLabel="éléments" items={statusItems(s.objects, (o) => o.probativeStatus, OBJ_VUE)} example={example} emptyText="Aucun élément enregistré." />
        <StatusDistribution title="Mes démarches par état" unitLabel="démarches" items={caseItems(s.cases)} emptyText="Aucune démarche déposée." />
        <StatusDistribution title="Mes quittances" unitLabel="quittances" items={statusItems(s.receipts, (r) => r.status, RECEIPT_VUE)} emptyText="Aucune quittance pour ce service." />
        <MonthlyCountLine title="Mes paiements quittancés par mois" items={s.receipts} dateOf={(r) => r.paidAt} measure="Quittances" />
      </ChartGrid>
    </VisualSummary>
  );
}

interface VIndicators { byVertical: { slug: string; objects: number; cases: number; open: number; accepted: number; refused: number }[] }

/** Vue agent d'une verticale (sans données nominatives) : objets et démarches de la verticale, par issue. */
export function VerticaleAgentVisuels({ slug, allowed }: { slug: string; allowed: boolean }) {
  const q = useApi(allowed ? () => api<VIndicators>('/v1/verticales/indicators') : null, [allowed]);
  if (!allowed || q.error) return null;
  const row = q.data?.byVertical.find((r) => r.slug === slug);
  return (
    <VisualSummary label="Activité de la verticale (agrégats)">
      <KpiGrid max={4} label="Activité de la verticale">
        <KpiTile hero label="Objets enregistrés" value={row ? row.objects : q.data ? 0 : null} loading={q.loading} />
        <KpiTile label="Démarches" value={row ? row.cases : q.data ? 0 : null} loading={q.loading} />
        <KpiTile label="En cours" value={row ? row.open : q.data ? 0 : null} loading={q.loading} state={{ label: 'Instruction', tone: 'info' }} />
        <KpiTile label="Acceptées" value={row ? row.accepted : q.data ? 0 : null} loading={q.loading} state={{ label: 'Décision motivée', tone: 'good' }} />
      </KpiGrid>
      {row && (
        <StatusDistribution title="Démarches de la verticale par issue" unitLabel="démarches" subtitle="Agrégats, sans donnée nominative"
          items={countItems([['OPEN', 'En cours', 'info', row.open], ['ACCEPTED', 'Acceptées', 'good', row.accepted], ['REFUSED', 'Refusées', 'serious', row.refused]])} />
      )}
    </VisualSummary>
  );
}

// ------------------------------------------------------------------------------------------------ console des verticales

export function CasesVisuels({ cases, verticalName }: { cases: CaseView[]; verticalName: (slug: string) => string }) {
  return (
    <ChartGrid min={280}>
      <StatusDistribution title="Démarches par état" unitLabel="démarches" items={caseItems(cases)} emptyText="Aucune démarche dans votre périmètre." />
      <CountBars title="Démarches par verticale" items={cases} keyOf={(c) => c.vertical} labelOf={verticalName} measure="Démarches" />
      <MonthlyCountLine title="Démarches déposées par mois" items={cases} dateOf={(c) => c.createdAt} measure="Démarches" />
      <HeatGrid className="viz-span-2" title="Démarches par commune" measureLabel="Démarches" format={(v) => fmtNombre(v, 0)}
        cells={countBy(cases.filter((c) => c.commune), (c) => c.commune!).map((r) => ({ commune: r.key, value: r.count }))} unmeasuredReason="aucune démarche rattachée à cette commune" />
    </ChartGrid>
  );
}

export function PlatesReportViz({ agents }: { agents: { agentId: string; agentName: string; platesIssued: number; scans: number }[] }) {
  return (
    <BarChartViz title="Plaques posées et scans, par agent" orientation="horizontal" format={(v) => fmtNombre(v, 0)} emptyText="Aucune activité ce jour."
      series={[{ key: 'p', label: 'Plaques posées' }, { key: 's', label: 'Scans' }]} rows={agents.map((a) => ({ key: a.agentId, label: a.agentName, values: { p: a.platesIssued, s: a.scans } }))} />
  );
}

export function NfiuReportViz({ agents }: { agents: { agentId: string; agentName: string; bySituation: Record<'red' | 'amber' | 'green' | 'grey', number> }[] }) {
  return (
    <StackedBarViz title="Situations constatées au scan, par agent" subtitle="Parts disjointes : vert, ambre, rouge, gris" mode="absolute"
      series={[{ key: 'green', label: 'Vertes (à jour)' }, { key: 'amber', label: 'Ambres' }, { key: 'red', label: 'Rouges' }, { key: 'grey', label: 'Grises (sans donnée)' }]}
      rows={agents.map((a) => ({ key: a.agentId, label: a.agentName, values: { green: a.bySituation.green, amber: a.bySituation.amber, red: a.bySituation.red, grey: a.bySituation.grey } }))} />
  );
}

export function AviaDeclVisuels({ list, periods }: { list: AviaDeclaration[]; periods: { period: string; passengersDeclared: number; passengersBoarded: number; withGap: number; validated: number }[] | undefined }) {
  const vue: Record<string, EtatVue> = {};
  for (const d of list) vue[d.status] = { label: d.statusLabel, tone: d.status === 'ECART_CONSTATE' ? 'warning' : ['VALIDEE', 'RAPPROCHEE'].includes(d.status) ? 'good' : 'info' };
  return (
    <ChartGrid min={300}>
      <StatusDistribution title="Déclarations mensuelles par état" unitLabel="déclarations" items={statusItems(list, (d) => d.status, vue)} />
      <LineAreaViz title="Passagers déclarés et embarqués, par mois" subtitle="Déclaration de la compagnie et relevé de l’exploitant" granularity="month" format={(v) => fmtNombre(v, 0)}
        series={[{ key: 'd', label: 'Déclarés' }, { key: 'b', label: 'Embarqués (exploitant)' }]}
        points={(periods ?? []).slice().sort((a, b) => a.period.localeCompare(b.period)).map((p) => ({ date: p.period, values: { d: p.passengersDeclared, b: p.passengersBoarded } }))} />
    </ChartGrid>
  );
}

export function TelecomViz({ matched, observedNotDeclared, declaredNotObserved }: { matched: number; observedNotDeclared: number; declaredNotObserved: number }) {
  return (
    <StatusDistribution title="Rapprochement des sites d’antennes" unitLabel="sites" subtitle="Déclarations des opérateurs et relevés de terrain"
      items={countItems([['OK', 'Concordants', 'good', matched], ['OND', 'Observés non déclarés', 'critical', observedNotDeclared], ['DNO', 'Déclarés non encore relevés', 'warning', declaredNotObserved]])} />
  );
}

export function VerticalsIndicatorsViz({ d, verticalName }: { d: { byVertical: { slug: string; objects: number; cases: number; open: number; accepted: number; refused: number }[]; markets: { stalls: number; occupied: number; paidOccupied: number; paidOccupancyRate: string }; plates: { nfiuInService: number; buildingsRegistered: number } }; verticalName: (s: string) => string }) {
  return (
    <ChartGrid min={300}>
      <StackedBarViz className="viz-span-2" title="Démarches par verticale et par issue" subtitle="Parts disjointes" mode="absolute"
        series={[{ key: 'o', label: 'En cours' }, { key: 'a', label: 'Acceptées' }, { key: 'r', label: 'Refusées' }]}
        rows={d.byVertical.filter((r) => r.cases > 0).map((r) => ({ key: r.slug, label: verticalName(r.slug), values: { o: r.open, a: r.accepted, r: r.refused } }))} />
      <BarChartViz title="Objets enregistrés par verticale" orientation="horizontal" format={(v) => fmtNombre(v, 0)}
        series={[{ key: 'n', label: 'Objets' }]} rows={d.byVertical.filter((r) => r.objects > 0).map((r) => ({ key: r.slug, label: verticalName(r.slug), values: { n: r.objects } }))} />
      <GaugeMeter title="Étals occupés avec titre valide" value={pct(d.markets.paidOccupancyRate)} unit="%" format={(v) => fmtNombre(v, 1)} tone="info" toneLabel="Suivi (sans cible)"
        reason="Aucun étal occupé : taux non mesuré." note={`${d.markets.paidOccupied} / ${d.markets.occupied} étals occupés`} />
      <GaugeMeter title="Biens équipés d’une plaque NFIU" value={d.plates.buildingsRegistered ? (d.plates.nfiuInService / d.plates.buildingsRegistered) * 100 : null} unit="%" format={(v) => fmtNombre(v, 1)} tone="info" toneLabel="Suivi (sans cible)"
        reason="Aucun bien enregistré : couverture non mesurée." note={`${d.plates.nfiuInService} plaques pour ${d.plates.buildingsRegistered} biens`} />
    </ChartGrid>
  );
}

export function AviaRrhViz({ kpis, reconciliations }: { kpis: { period: string; known: number; counted: number; verified: number; compensated: number }[]; reconciliations: { id: string; period: string; withGap: number; airlines: number }[] }) {
  const k = kpis[0];
  const steps: LadderStep[] = k ? [
    { code: 'CONNUS', label: 'Départs connus (billets avec IFA)', value: k.known, display: fmtNombre(k.known, 0) },
    { code: 'COMPTES', label: 'Départs comptés (embarquements RVA)', value: k.counted, display: fmtNombre(k.counted, 0) },
    { code: 'VERIFIES', label: 'Départs vérifiés (sortie DGM du même IFA)', value: k.verified, display: fmtNombre(k.verified, 0) },
    { code: 'COMPENSES', label: 'Départs compensés (taxe créditée ou décision humaine)', value: k.compensated, display: fmtNombre(k.compensated, 0) },
  ] : [];
  return (
    <ChartGrid min={300}>
      <LadderFunnel title={`Chaîne des départs${k ? ` — ${k.period}` : ''}`} subtitle="Du billet à la sortie vérifiée" steps={steps} emptyText="Aucun départ tracé." />
      <StackedBarViz title="Rapprochements mensuels" subtitle="Compagnies avec et sans écart (parts disjointes)" mode="absolute"
        series={[{ key: 'g', label: 'Avec écart' }, { key: 'o', label: 'Sans écart' }]}
        rows={reconciliations.filter((r, i, all) => all.findIndex((x) => x.period === r.period) === i).map((r) => ({ key: r.id, label: r.period, values: { g: r.withGap, o: Math.max(0, r.airlines - r.withGap) } }))} />
    </ChartGrid>
  );
}

export function AviaAutoViz({ executions, billed }: { executions: { kind: string }[]; billed: { amount: string; currency: string }[] }) {
  return (
    <ChartGrid min={300}>
      <StatusDistribution title="Exécutions des écarts mensuels" unitLabel="exécutions"
        items={statusItems(executions, (e) => e.kind, { FACTURATION: { label: 'Avis émis', tone: 'warning' }, COMPENSATION: { label: 'Compensation (crédit)', tone: 'good' }, AUCUN_MONTANT: { label: 'Aucun montant exécutable', tone: 'neutral' } })} />
      <MoneyBars title="Montants facturés automatiquement" measure="Facturé" rows={[{ label: 'Facturé', money: billed as MoneyJSON[] }]} emptyText="Aucune facturation (proposition seulement avant l’arrêté)." />
    </ChartGrid>
  );
}

// ------------------------------------------------------------------------------------------------ CALCU

interface CalcuOverviewLite {
  totals: { transactions: number; vert: number; ambre: number; rouge: number; blocked: number }; complianceRate: string; accounts: { declared: number; validated: number };
  transactions?: { bank: string; at: string; amount: MoneyJSON; score: string }[]; reports?: { status: string }[];
}

export function CalcuVisuels({ o }: { o: CalcuOverviewLite }) {
  const t = o.totals;
  return (
    <VisualSummary label="CALCU en un coup d’œil">
      <KpiGrid max={4} label="CALCU — chiffres clés">
        <KpiTile hero label="Opérations conformes (vert)" value={pct(o.complianceRate)} unit="%" format={(v) => fmtNombre(v, 1)} state={{ label: 'Suivi (sans cible)', tone: 'info' }} example sub={`${t.vert} / ${t.transactions} opérations`} reason="Aucune opération transmise." />
        <KpiTile label="Correspondances partielles" value={t.ambre} state={{ label: 'Ambre', tone: 'warning' }} example />
        <KpiTile label="Anomalies" value={t.rouge} state={{ label: 'Rouge', tone: 'critical' }} example />
        <KpiTile label="Paiements bloqués" value={t.blocked} state={{ label: 'Toujours zéro', tone: 'good' }} sub="CALCU ne bloque aucun paiement" />
      </KpiGrid>
      <ChartGrid min={280}>
        <StatusDistribution title="Opérations par score de correspondance" unitLabel="opérations" example
          items={countItems([['VERT', 'Vert — conforme', 'good', t.vert], ['AMBRE', 'Ambre — correspondance partielle', 'warning', t.ambre], ['ROUGE', 'Rouge — anomalie', 'critical', t.rouge]])} />
        <GaugeMeter title="Comptes publics validés conjointement" value={o.accounts.declared ? (o.accounts.validated / o.accounts.declared) * 100 : null} unit="%" format={(v) => fmtNombre(v, 0)} example
          tone="info" toneLabel="Suivi (sans cible)" reason="Aucun compte déclaré." note={`${o.accounts.validated} / ${o.accounts.declared} comptes validés (Finances et Contrôle)`} />
        {o.transactions && <MoneyBars title="Montants des opérations par banque" measure="Montant" example rows={o.transactions.map((x) => ({ label: x.bank, money: x.amount }))} />}
        {o.transactions && <MonthlyCountLine title="Opérations transmises par mois" items={o.transactions} dateOf={(x) => x.at} measure="Opérations" example />}
        {o.reports && <StatusDistribution title="Rapports d’anomalie par état" unitLabel="rapports" example
          items={statusItems(o.reports, (r) => r.status, { OUVERT: { label: 'Ouvert', tone: 'info' }, GELE: { label: 'Dossier gelé', tone: 'warning' }, CLOS: { label: 'Clos', tone: 'neutral' } })} />}
      </ChartGrid>
    </VisualSummary>
  );
}

interface OrganeLite {
  controlled: { transactions: number; amounts: MoneyJSON[] }; recovered: { count: number; amounts: MoneyJSON[] };
  recommendations: { issued: number; executed: number; due: number; executionRate: string | null };
  institutionsAtRisk?: { entityName: string; rouge: number; ambre: number; vert: number }[]; exposedZones?: { commune: string; anomalies: number }[];
}

export function OrganeVisuels({ d }: { d: OrganeLite }) {
  return (
    <VisualSummary label="Organe de contrôle — graphiques">
      <ChartGrid min={280}>
        <MoneyBars title="Montants contrôlés et récupérés" measure="Montant" example rows={[{ label: 'Contrôlés', money: d.controlled.amounts }, { label: 'Récupérés', money: d.recovered.amounts }]} emptyText="Aucun montant contrôlé." />
        <GaugeMeter title="Exécution des recommandations échues" value={d.recommendations.due ? (d.recommendations.executed / d.recommendations.due) * 100 : null} unit="%" format={(v) => fmtNombre(v, 0)} example
          tone="info" toneLabel="Suivi (sans cible)" reason="Aucune recommandation échue : taux non mesuré." note={`${d.recommendations.executed} exécutée(s) sur ${d.recommendations.due} échue(s) · ${d.recommendations.issued} émise(s)`} />
        {d.institutionsAtRisk && (
          <StackedBarViz className="viz-span-2" title="Institutions à risque — opérations par score" subtitle="Parts disjointes" mode="absolute" example
            series={[{ key: 'r', label: 'Rouge' }, { key: 'a', label: 'Ambre' }, { key: 'v', label: 'Vert' }]}
            rows={d.institutionsAtRisk.map((x) => ({ label: x.entityName, values: { r: x.rouge, a: x.ambre, v: x.vert } }))} />
        )}
        {d.exposedZones && (
          <HeatGrid className="viz-span-2" title="Zones à forte exposition (anomalies par commune)" measureLabel="Anomalies" format={(v) => fmtNombre(v, 0)} example
            cells={d.exposedZones.filter((z) => z.commune !== 'NON_LOCALISE').map((z) => ({ commune: z.commune, value: z.anomalies }))}
            unmeasuredReason="aucun justificatif localisé dans cette commune" note={d.exposedZones.some((z) => z.commune === 'NON_LOCALISE') ? `Non localisé : ${d.exposedZones.find((z) => z.commune === 'NON_LOCALISE')!.anomalies} anomalie(s) (justificatif sans commune).` : undefined} />
        )}
      </ChartGrid>
    </VisualSummary>
  );
}

// ------------------------------------------------------------------------------------------------ patrimoine, environnement

const ACTIF_ETAT: Record<string, EtatVue> = {
  INVENTORIE: { label: 'Inventorié', tone: 'neutral' }, EVALUE: { label: 'Évalué', tone: 'info' }, EN_APPEL: { label: 'En appel', tone: 'warning' }, ATTRIBUE: { label: 'Attribué', tone: 'good' },
};

export function PatrimoineVisuels({ assets, calls, revenues }: {
  assets: { status: string; nature: string; commune: string; demo: boolean }[]; calls: { status: string; candidatures: number }[];
  revenues: { liquidated: MoneyJSON[]; paid: MoneyJSON[]; reconciled: MoneyJSON[] }[] | undefined;
}) {
  const example = assets.some((a) => a.demo);
  return (
    <VisualSummary label="Patrimoine provincial en un coup d’œil">
      <KpiGrid max={4} label="Patrimoine — chiffres clés">
        <KpiTile hero label="Actifs inventoriés" value={assets.length} example={example} />
        <KpiTile label="Attribués" value={assets.filter((a) => a.status === 'ATTRIBUE').length} state={{ label: 'Attribution motivée', tone: 'good' }} example={example} />
        <KpiTile label="Appels publics" value={calls.length} sub={`${calls.reduce((s, c) => s + c.candidatures, 0)} candidature(s)`} />
        <KpiTile label="Appels ouverts" value={calls.filter((c) => c.status === 'PUBLIE').length} state={{ label: 'Plis scellés', tone: 'info' }} />
      </KpiGrid>
      <ChartGrid min={280}>
        <StatusDistribution title="Actifs par étape" unitLabel="actifs" items={statusItems(assets, (a) => a.status, ACTIF_ETAT)} example={example} />
        <CountBars title="Actifs par nature" items={assets} keyOf={(a) => a.nature} labelOf={(k) => k.replace(/_/g, ' ').toLowerCase()} measure="Actifs" example={example} />
        <HeatGrid className="viz-span-2" title="Actifs par commune" measureLabel="Actifs" format={(v) => fmtNombre(v, 0)} example={example}
          cells={countBy(assets, (a) => a.commune).map((r) => ({ commune: r.key, value: r.count }))} unmeasuredReason="aucun actif inventorié dans cette commune" />
        {revenues && <MoneyBars title="Revenus domaniaux — liquidé, payé, rapproché" measure="Revenus" example={example} emptyText="Aucun revenu domanial liquidé."
          note="Niveaux emboîtés (le rapproché est inclus dans le payé) : lus côte à côte, jamais additionnés."
          rows={[{ label: 'Liquidé', money: revenues.flatMap((r) => r.liquidated) }, { label: 'Payé', money: revenues.flatMap((r) => r.paid) }, { label: 'Rapproché', money: revenues.flatMap((r) => r.reconciled) }]} />}
      </ChartGrid>
    </VisualSummary>
  );
}

export function EnvironnementVisuels({ items, activated }: { items: { raisonSociale: string; categorie: string | null; commune: string; tonnage: { tonnes: string } | null; obligations: number }[]; activated: boolean }) {
  const tonnes = items.map((i) => toNum(i.tonnage?.tonnes)).filter((v): v is number => v !== null);
  return (
    <VisualSummary label="Environnement en un coup d’œil">
      <KpiGrid max={4} label="Environnement — chiffres clés">
        <KpiTile hero label="Metteurs en marché" value={items.length} />
        <KpiTile label="Tonnage déclaré" value={tonnes.length ? tonnes.reduce((a, b) => a + b, 0) : null} unit="t" format={(v) => fmtNombre(v, 1)} reason="Aucun tonnage déclaré." />
        <KpiTile label="Obligations émises" value={items.reduce((s, i) => s + i.obligations, 0)} state={{ label: activated ? 'Édit publié' : 'Désactivé (aucun édit)', tone: activated ? 'good' : 'neutral' }} />
        <KpiTile label="Communes couvertes" value={new Set(items.map((i) => i.commune)).size} />
      </KpiGrid>
      <ChartGrid min={280}>
        <BarChartViz title="Tonnage déclaré par assujetti" orientation="horizontal" format={(v) => `${fmtNombre(v, 1)} t`} emptyText="Aucun tonnage déclaré."
          series={[{ key: 't', label: 'Tonnes' }]} rows={items.filter((i) => i.tonnage).map((i) => ({ label: i.raisonSociale, values: { t: toNum(i.tonnage!.tonnes) } }))} />
        <DonutViz title="Assujettis par catégorie" centerLabel="assujettis" slices={countBy(items, (i) => i.categorie ?? 'Non renseignée').map((r) => ({ key: r.key, label: r.key, value: r.count }))} />
        <HeatGrid className="viz-span-2" title="Assujettis par commune" measureLabel="Assujettis" format={(v) => fmtNombre(v, 0)}
          cells={countBy(items, (i) => i.commune).map((r) => ({ commune: r.key, value: r.count }))} unmeasuredReason="aucun assujetti enregistré dans cette commune" />
      </ChartGrid>
    </VisualSummary>
  );
}

// ------------------------------------------------------------------------------------------------ grands redevables, secteurs

export function GrandsRedevablesVisuels({ portfolio }: { portfolio: { taxpayerId: string; name: string; sectors: { label: string }[]; manager: { rotation: { due: boolean } } | null; revenue: MoneyJSON[]; overdueObligations: number }[] }) {
  const sans = portfolio.filter((p) => !p.manager).length;
  const rot = portfolio.filter((p) => p.manager?.rotation.due).length;
  return (
    <VisualSummary label="Grands redevables en un coup d’œil">
      <ChartGrid min={280}>
        <StatusDistribution title="Gestionnaire dédié" unitLabel="redevables"
          items={countItems([['OK', 'Gestionnaire en place', 'good', portfolio.length - sans - rot], ['ROT', 'Rotation due', 'warning', rot], ['SANS', 'À désigner', 'critical', sans]])} />
        <DonutViz title="Portefeuille par secteur" centerLabel="rattachements" slices={countBy(portfolio.flatMap((p) => p.sectors), (s) => s.label).map((r) => ({ key: r.key, label: r.key, value: r.count }))} />
        <MoneyBars title="Recettes confirmées par redevable" measure="Recettes" rows={portfolio.map((p) => ({ label: p.name, money: p.revenue }))} emptyText="Aucune recette confirmée." />
        <BarChartViz title="Obligations échues impayées par redevable" orientation="horizontal" format={(v) => fmtNombre(v, 0)}
          series={[{ key: 'o', label: 'Échues impayées' }]} rows={portfolio.map((p) => ({ key: p.taxpayerId, label: p.name, values: { o: p.overdueObligations } }))} />
      </ChartGrid>
    </VisualSummary>
  );
}

const DECL_ETAT: Record<string, EtatVue> = {
  DEPOSEE: { label: 'Déposée', tone: 'info' }, RAPPROCHEE: { label: 'Rapprochée — sans écart', tone: 'good' }, ECART_A_INSTRUIRE: { label: 'Écart à instruire', tone: 'warning' },
  SANS_DONNEE_TIERCE: { label: 'Sans donnée observée', tone: 'neutral' }, VALIDEE: { label: 'Validée', tone: 'good' }, EN_CONTRADICTOIRE: { label: 'Procédure contradictoire', tone: 'warning' },
};

export function SecteursVisuels({ modules, withDeclarations }: { modules: { module: string; name: string; counts: { references: number; declarations: number; observations: number } }[]; withDeclarations: boolean }) {
  const q = useApi(withDeclarations ? () => api<{ items: { status: string; declaredAt: string }[] }>('/v1/verticales/secteurs/declarations') : null, [withDeclarations]);
  return (
    <VisualSummary label="Modules sectoriels en un coup d’œil">
      <KpiGrid max={4} label="Modules sectoriels — chiffres clés">
        <KpiTile hero label="Modules sur le socle" value={modules.length} state={{ label: 'Acte requis', tone: 'neutral' }} />
        <KpiTile label="Déclarations" value={modules.reduce((s, m) => s + m.counts.declarations, 0)} />
        <KpiTile label="Relevés de terrain" value={modules.reduce((s, m) => s + m.counts.observations, 0)} />
        <KpiTile label="Références" value={modules.reduce((s, m) => s + m.counts.references, 0)} />
      </KpiGrid>
      <ChartGrid min={300}>
        <BarChartViz className="viz-span-2" title="Activité par module" orientation="horizontal" format={(v) => fmtNombre(v, 0)}
          series={[{ key: 'd', label: 'Déclarations' }, { key: 'o', label: 'Relevés' }, { key: 'r', label: 'Références' }]}
          rows={modules.map((m) => ({ key: m.module, label: `${m.module} — ${m.name}`, values: { d: m.counts.declarations, o: m.counts.observations, r: m.counts.references } }))} />
        {withDeclarations && !q.error && (
          <StatusDistribution title="Déclarations par état" unitLabel="déclarations" items={statusItems(q.data?.items ?? [], (d) => d.status, DECL_ETAT)} loading={q.loading && !q.data} />
        )}
      </ChartGrid>
    </VisualSummary>
  );
}

// ------------------------------------------------------------------------------------------------ fiches 13 à 25

type IndValue = string | number | MoneyJSON[] | { label: string; amounts: MoneyJSON[] }[] | null;
interface FicheModule { module: string; rule: { status: string }; indicators: { key: string; label: string; value: IndValue; measured: boolean }[] }

export function FichesVisuels({ modules }: { modules: FicheModule[] }) {
  const nums = modules.flatMap((m) => m.indicators.filter((i) => i.measured && typeof i.value === 'number').map((i) => ({ m: m.module, i })));
  return (
    <VisualSummary label="Fiches sectorielles en un coup d’œil">
      <KpiGrid max={4} label="Fiches — chiffres clés">
        <KpiTile hero label="Modules suivis" value={modules.length} />
        <KpiTile label="Règles ACTIVES" value={modules.filter((m) => m.rule.status === 'ACTIVE').length} state={{ label: 'Liquidation automatique', tone: 'good' }} />
        <KpiTile label="Indicateurs mesurés" value={modules.reduce((s, m) => s + m.indicators.filter((i) => i.measured).length, 0)} />
        <KpiTile label="Indicateurs non mesurés" value={modules.reduce((s, m) => s + m.indicators.filter((i) => !i.measured).length, 0)} sub="donnée source absente, motif affiché" />
      </KpiGrid>
      <ChartGrid min={300}>
        <StatusDistribution title="Modules par état de la règle" unitLabel="modules"
          items={countItems([['ACTIVE', 'Règle ACTIVE', 'good', modules.filter((m) => m.rule.status === 'ACTIVE').length], ['AUTRE', 'Acte requis ou règle non active', 'neutral', modules.filter((m) => m.rule.status !== 'ACTIVE').length]])} />
        <StackedBarViz title="Indicateurs mesurés par module" subtitle="Mesurés et non mesurés (parts disjointes)" mode="absolute"
          series={[{ key: 'm', label: 'Mesurés' }, { key: 'n', label: 'Non mesurés' }]}
          rows={modules.map((m) => ({ key: m.module, label: `Module ${m.module}`, values: { m: m.indicators.filter((i) => i.measured).length, n: m.indicators.filter((i) => !i.measured).length } }))} />
        {nums.length > 0 && (
          <BarChartViz className="viz-span-2" title="Indicateurs chiffrés des modules" orientation="horizontal" format={(v) => fmtNombre(v, 0)}
            series={[{ key: 'v', label: 'Valeur' }]} rows={nums.map(({ m, i }) => ({ key: `${m}-${i.key}`, label: `${m} · ${i.label}`, values: { v: i.value as number } }))} />
        )}
      </ChartGrid>
    </VisualSummary>
  );
}

export function RegistreFicheViz({ items }: { items: { probativeStatus: string; commune: string }[] }) {
  if (!items.length) return null;
  return (
    <ChartGrid min={260}>
      <StatusDistribution title="Objets par statut probatoire" unitLabel="objets" items={statusItems(items, (o) => o.probativeStatus, OBJ_VUE)} />
      <CountBars title="Objets par commune" items={items} keyOf={(o) => o.commune} measure="Objets" />
    </ChartGrid>
  );
}

export function LiquidationsFicheViz({ items, vue }: { items: { status: string; module: string }[]; vue: Record<string, EtatVue> }) {
  return (
    <ChartGrid min={280}>
      <StatusDistribution title="Liquidations par état" unitLabel="liquidations" items={statusItems(items, (l) => l.status, vue)} emptyText="Aucune liquidation." />
      <CountBars title="Liquidations par module" items={items} keyOf={(l) => `Module ${l.module}`} measure="Liquidations" />
    </ChartGrid>
  );
}

export function PlastiqueViz({ ind, declarations }: { ind: { assujettis: number; simulations: number; declarations: number }; declarations: { status: string }[] }) {
  return (
    <VisualSummary label="Contribution plastique en un coup d’œil">
      <KpiGrid max={3} label="Plastique — chiffres clés">
        <KpiTile hero label="Assujettis" value={ind.assujettis} />
        <KpiTile label="Simulations (non opposables)" value={ind.simulations} />
        <KpiTile label="Déclarations" value={ind.declarations} />
      </KpiGrid>
      {declarations.length > 0 && <StatusDistribution title="Déclarations par état" unitLabel="déclarations" items={statusItems(declarations, (d) => d.status)} />}
    </VisualSummary>
  );
}
