/**
 * Canaux inclusifs — visuels (trousse de visualisation, 27/09/2026) : points agréés, jours de caisse, enrôlement
 * assisté, carte MOSOLO, USSD / SVI. Données RÉELLES déjà chargées par l'écran (ou /v1/channels/indicators, lisible
 * par tous les rôles d'agent — aucun droit élargi) ; montants par devise, jamais additionnés entre devises ;
 * listes vides → état « Aucune donnée ». Les données de démonstration portent le ruban EXEMPLE.
 */
import type { ReactNode } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import type { MoneyJSON } from '@mosolo/shared';
import {
  BarChartViz, ChartGrid, DonutViz, GaugeMeter, HeatGrid, KpiGrid, KpiTile, LineAreaViz, StatusDistribution, TimelineStrip,
  fmtCompact, fmtNombre, type StatusItem,
} from '../../components/viz';
import type { Tone } from '../../components/StatusBadge';
import { countBy, groupByDay } from '../../lib/aggregate';
import { api } from '../../lib/api';
import { DAY_STATUS, POINT_STATUS, POINT_TYPE_LABEL } from './shared';

const ent = (v: number) => fmtNombre(v, 0);
/** Rôles d'agent public (R01–R29) et R36 : lecteurs de canaux:indicators côté serveur. */
const AGENT_ROLES = /^R(0[1-9]|1\d|2\d|36)$/;

/** Répartition par état (ordre du dictionnaire, états absents à 0, états inconnus regroupés). */
export function parEtat(values: readonly string[], dict: Record<string, { label: string; tone: Tone }>): StatusItem[] {
  const c = new Map<string, number>();
  for (const v of values) c.set(v, (c.get(v) ?? 0) + 1);
  const items: StatusItem[] = Object.keys(dict).map((k) => ({ key: k, label: dict[k]!.label, tone: dict[k]!.tone, count: c.get(k) ?? 0 }));
  const autres = values.filter((v) => !(v in dict)).length;
  return autres ? [...items, { key: 'AUTRE', label: 'Autre état', tone: 'neutral', count: autres }] : items;
}

/** Heure de Kinshasa (UTC+1) d'un instant ISO. */
export function heureKinshasa(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t + 3_600_000).getUTCHours();
}

// ————————————————————————————————————————————————————————— Indicateurs des canaux (lecture agent)

export interface ChannelIndicators {
  enrolments: { total: number; byCommune: { commune: string; total: number; created: number; toReview: number }[]; rejectedAttempts: number };
  cards: { active: number; blocked: number; revoked: number; reissues: number };
  channels: { ussdSessions: number; ivrSessions: number; authenticatedSessions: number; referencesIssued: number; voice?: { calls: number; callsWithOperation: number; operations: number; byKind: Record<string, number>; byLanguage: Record<string, number> } };
  accessibility?: { activePoints: number; communesTotal: number; communesCovered: number; communesCoveredPct: number };
  points: { active: number; suspended: number; referenced: number; collections: number; collected: MoneyJSON[]; medianSettlementHours: number | null; openExceptions: number; pendingProposals: number };
  verification: { total: number; suspectedEnumeration: number };
}

/** Lecture des indicateurs des canaux pour un rôle d'agent (sinon rien : le public ne les voit pas). */
export function useChannelIndicators() {
  const { user } = useApp();
  const agent = !!user?.roles.some((r) => AGENT_ROLES.test(r));
  return useApi(agent ? () => api<ChannelIndicators>('/v1/channels/indicators') : null, [user?.id]);
}

const VOICE_OPS: Record<string, string> = {
  CONSULTATION: 'Consultations', REFERENCE: 'Références', QUITTANCES: 'Quittances lues', VERIFICATION: 'Vérifications',
  POINTS: 'Listes de points', BLOCAGE_CARTE: 'Blocages de carte', CONTESTATION: 'Contestations',
};
const LANG_LABEL: Record<string, string> = { fr: 'Français', ln: 'Lingála', sw: 'Kiswahili', kg: 'Kikongo', lua: 'Tshilubà' };

export function CartesEtat({ ind }: { ind: ChannelIndicators }) {
  return (
    <StatusDistribution title="Cartes MOSOLO par état" unitLabel="cartes" note={`${ind.cards.reissues} réémission(s)`}
      items={[{ key: 'A', label: 'Active', tone: 'good', count: ind.cards.active }, { key: 'B', label: 'Bloquée', tone: 'warning', count: ind.cards.blocked }, { key: 'R', label: 'Révoquée', tone: 'critical', count: ind.cards.revoked }]} />
  );
}

export function CanauxUsage({ ind }: { ind: ChannelIndicators }) {
  const v = ind.channels.voice;
  return (
    <>
      <DonutViz title="Sessions sans Internet par canal" centerLabel="sessions" format={ent}
        slices={[{ key: 'ussd', label: 'USSD', value: ind.channels.ussdSessions }, { key: 'svi', label: 'Serveur vocal (SVI)', value: ind.channels.ivrSessions }]} />
      <BarChartViz title="Opérations réalisées à la voix" orientation="horizontal" format={ent} series={[{ key: 'n', label: 'Opérations' }]}
        rows={Object.entries(v?.byKind ?? {}).filter(([, n]) => n > 0).map(([k, n]) => ({ label: VOICE_OPS[k] ?? k, values: { n } }))} emptyText="Aucune opération vocale enregistrée." />
      {v && Object.keys(v.byLanguage).length > 0 && (
        <DonutViz title="Appels vocaux par langue" centerLabel="appels" format={ent}
          slices={Object.entries(v.byLanguage).map(([k, n]) => ({ key: k, label: LANG_LABEL[k] ?? k, value: n }))} />
      )}
    </>
  );
}

// ————————————————————————————————————————————————————————— Supervision du réseau (Trésor)

interface SupPointLike { id: string; name: string; type: string; commune: string; status: string; collectionsToday: number; openExceptions: number }
export function SupervisionVisuel({ points, ind }: { points: readonly SupPointLike[] | null; ind: ChannelIndicators | null }) {
  const actifs = (points ?? []).filter((p) => p.status === 'ACTIF');
  return (
    <ChartGrid min={300} label="Réseau des points — synthèse visuelle">
      {points && <StatusDistribution title="Points de paiement par état" unitLabel="points" items={parEtat(points.map((p) => p.status), POINT_STATUS)} example />}
      {points && (
        <HeatGrid className="viz-span-2" title="Points actifs par commune" measureLabel="Points actifs" format={ent} unmeasuredReason="aucun point actif dans cette commune" example
          cells={countBy(actifs, 'commune').map((r) => ({ commune: r.key, value: r.count }))} />
      )}
      {points && (
        <BarChartViz title="Encaissements du jour par point" orientation="horizontal" format={ent} series={[{ key: 'n', label: 'Encaissements' }]} example
          rows={points.filter((p) => p.collectionsToday > 0).map((p) => ({ key: p.id, label: p.name, values: { n: p.collectionsToday } }))} emptyText="Aucun encaissement aujourd’hui." />
      )}
      {ind?.accessibility && (
        <GaugeMeter title="Communes couvertes par un point actif" subtitle={`${ind.accessibility.communesCovered} sur ${ind.accessibility.communesTotal}`} value={ind.accessibility.communesCoveredPct} unit="%" />
      )}
      {ind && (
        <HeatGrid className="viz-span-2" title="Enrôlements assistés par commune" measureLabel="Dossiers assistés" format={ent} unmeasuredReason="aucun enrôlement assisté dans cette commune"
          cells={ind.enrolments.byCommune.map((r) => ({ commune: r.commune, value: r.total, detail: `${r.created} créé(s) · ${r.toReview} à revoir` }))} />
      )}
      {ind && <CartesEtat ind={ind} />}
      {ind && <CanauxUsage ind={ind} />}
    </ChartGrid>
  );
}

// ————————————————————————————————————————————————————————— Jour de caisse (console du point, revue du Trésor)

interface CashDayLike {
  status: string; expected: MoneyJSON[]; counted: MoneyJSON[] | null; reconciledCount: number; exceptions: { id: string }[];
  deposit: { bankSlipRef?: string; lines?: { amount: MoneyJSON }[] } | null;
  collections: { id: string; amount: MoneyJSON; collectedAt?: string; receiptStatus: string | null }[];
}
/** Attendu, compté, versé par devise (valeurs numériques pour la géométrie seulement). */
export function caisseParDevise(cd: CashDayLike): Record<string, { attendu: number; compte: number | null; verse: number | null }> {
  const out: Record<string, { attendu: number; compte: number | null; verse: number | null }> = {};
  for (const m of cd.expected) out[m.currency] = { attendu: Number(m.amount), compte: null, verse: null };
  for (const m of cd.counted ?? []) (out[m.currency] ??= { attendu: 0, compte: null, verse: null }).compte = Number(m.amount);
  for (const l of cd.deposit?.lines ?? []) { const r = (out[l.amount.currency] ??= { attendu: 0, compte: null, verse: null }); r.verse = (r.verse ?? 0) + Number(l.amount.amount); }
  return out;
}

export function CaisseVisuel({ cd, example = true }: { cd: CashDayLike; example?: boolean }) {
  const devises = caisseParDevise(cd);
  const heures = new Map<number, number>();
  for (const c of cd.collections) { const h = c.collectedAt ? heureKinshasa(c.collectedAt) : null; if (h !== null) heures.set(h, (heures.get(h) ?? 0) + 1); }
  const hs = [...heures.keys()].sort((a, b) => a - b);
  const st = DAY_STATUS[cd.status];
  return (
    <>
      <KpiGrid max={4} label="Jour de caisse — chiffres clés">
        <KpiTile label="Encaissements" value={cd.collections.length} format={ent} state={st ? { label: st.label, tone: st.tone } : undefined} example={example} />
        <KpiTile label="Rapprochés au compte public" value={cd.collections.length ? (cd.reconciledCount / cd.collections.length) * 100 : null} unit="%" format={(v) => fmtNombre(v, 0)}
          reason="aucun encaissement ce jour" sub={`${cd.reconciledCount} / ${cd.collections.length}`} example={example} />
        <KpiTile label="Exceptions ouvertes" value={cd.exceptions.length} format={ent} state={{ label: cd.exceptions.length ? 'Décision du Trésor' : 'Aucune', tone: cd.exceptions.length ? 'critical' : 'good' }} example={example} />
        <KpiTile label="Quittances définitives" value={cd.collections.filter((c) => c.receiptStatus === 'DEFINITIVE').length} format={ent}
          sub={`${cd.collections.filter((c) => c.receiptStatus !== 'DEFINITIVE').length} provisoire(s)`} example={example} />
      </KpiGrid>
      <ChartGrid min={280}>
        {Object.entries(devises).map(([c, v]) => (
          <BarChartViz key={c} title={`Attendu, compté, versé — ${c}`} orientation="horizontal" format={(x) => `${fmtCompact(x)} ${c}`} series={[{ key: 'm', label: c }]} example={example}
            rows={[{ label: 'Attendu (MOSOLO)', values: { m: v.attendu } }, { label: 'Compté à la clôture', values: { m: v.compte } }, { label: 'Versé (déclaré)', values: { m: v.verse } }]}
            note="Une valeur absente n’est pas encore saisie (non mesurée), jamais zéro." />
        ))}
        {Object.keys(devises).length === 0 && <BarChartViz title="Attendu, compté, versé" series={[{ key: 'm', label: 'Montant' }]} rows={[]} emptyText="Aucun montant attendu ce jour." />}
        {hs.length > 0 && (
          <BarChartViz title="Encaissements par heure (Kinshasa)" format={ent} series={[{ key: 'n', label: 'Encaissements' }]} example={example}
            rows={hs.map((h) => ({ label: `${String(h).padStart(2, '0')} h`, values: { n: heures.get(h) ?? 0 } }))} />
        )}
      </ChartGrid>
    </>
  );
}

export function RelevesVisuel({ statements }: { statements: readonly { statementId: string; matched: number; unmatched: number }[] }) {
  return (
    <BarChartViz title="Relevés importés : lignes appariées et en attente" orientation="horizontal" format={ent}
      series={[{ key: 'm', label: 'Appariées' }, { key: 'u', label: 'Non appariées' }]}
      rows={statements.slice(0, 10).map((s) => ({ key: s.statementId, label: s.statementId, values: { m: s.matched, u: s.unmatched } }))} emptyText="Aucun relevé importé." />
  );
}

// ————————————————————————————————————————————————————————— Où payer ? (public)

interface PublicPointLike { id: string; type: string; commune: string; status: string; demo: boolean }
export function OuPayerVisuel({ points, guichets }: { points: readonly PublicPointLike[]; guichets: readonly { commune: string }[] }) {
  const actifs = points.filter((p) => p.status === 'ACTIF');
  const example = points.some((p) => p.demo);
  return (
    <>
      <KpiGrid max={4} label="Réseau de paiement en espèces">
        <KpiTile label="Points agréés" value={points.length} format={ent} example={example} />
        <KpiTile label="Points ouverts" value={actifs.length} format={ent} state={{ label: `${points.length - actifs.length} suspendu(s)`, tone: points.length - actifs.length ? 'warning' : 'good' }} example={example} />
        <KpiTile label="Guichets MOSOLO" value={guichets.length} format={ent} example={example} />
        <KpiTile label="Communes desservies" value={new Set(actifs.map((p) => p.commune)).size} format={ent} sub="sur 24 communes" example={example} />
      </KpiGrid>
      <ChartGrid min={300}>
        <HeatGrid className="viz-span-2" title="Points ouverts par commune" measureLabel="Points agréés ouverts" format={ent} unmeasuredReason="aucun point agréé ouvert dans cette commune pour l’instant" example={example}
          cells={countBy(actifs, 'commune').map((r) => ({ commune: r.key, value: r.count }))} />
        <DonutViz title="Points par type d’établissement" centerLabel="points" format={ent} example={example}
          slices={countBy(points, 'type').map((r) => ({ key: r.key, label: POINT_TYPE_LABEL[r.key] ?? r.key, value: r.count }))} />
      </ChartGrid>
    </>
  );
}

// ————————————————————————————————————————————————————————— Enrôlement assisté

interface EnrolmentLike { id: string; status: string; commune: string; channel: string; receivedAt: string; person: { language: string } }
const ENROL_ETATS: Record<string, { label: string; tone: Tone }> = { CREE: { label: 'N0-A · carte émise', tone: 'good' }, A_REVOIR: { label: 'À revoir', tone: 'warning' }, DOUBLON_CONFIRME: { label: 'Doublon confirmé', tone: 'neutral' } };
const CHANNEL_LABEL: Record<string, string> = { DOMICILE: 'À domicile', SITE: 'Sur site', GUICHET_MOSOLO: 'Guichet MOSOLO' };
export function EnrolementVisuel({ list, queued }: { list: readonly EnrolmentLike[]; queued: number }) {
  const jours = groupByDay(list, (e) => e.receivedAt);
  return (
    <>
      <KpiGrid max={4} label="Enrôlement assisté — chiffres clés">
        <KpiTile label="Dossiers transmis" value={list.length} format={ent} example />
        <KpiTile label="Comptes N0-A créés" value={list.filter((e) => e.status === 'CREE').length} format={ent} state={{ label: 'Carte émise', tone: 'good' }} example />
        <KpiTile label="À revoir (doublon possible)" value={list.filter((e) => e.status === 'A_REVOIR').length} format={ent} state={{ label: 'Superviseur', tone: 'warning' }} example />
        <KpiTile label="En file locale" value={queued} format={ent} sub="à synchroniser (lot signé)" />
      </KpiGrid>
      <ChartGrid min={280}>
        <StatusDistribution title="Dossiers par état" unitLabel="dossiers" items={parEtat(list.map((e) => e.status), ENROL_ETATS)} emptyText="Aucun dossier transmis." example />
        <HeatGrid className="viz-span-2" title="Dossiers par commune" measureLabel="Dossiers d’enrôlement" format={ent} unmeasuredReason="aucun dossier dans cette commune" example
          cells={countBy(list, 'commune').map((r) => ({ commune: r.key, value: r.count }))} />
        <DonutViz title="Dossiers par lieu d’enrôlement" centerLabel="dossiers" format={ent} example
          slices={countBy(list, 'channel').map((r) => ({ key: r.key, label: CHANNEL_LABEL[r.key] ?? r.key, value: r.count }))} />
        <DonutViz title="Dossiers par langue du résumé" centerLabel="dossiers" format={ent} example
          slices={countBy(list, (e) => e.person.language).map((r) => ({ key: r.key, label: LANG_LABEL[r.key] ?? r.key, value: r.count }))} />
        <LineAreaViz title="Dossiers reçus par jour" granularity="day" area format={ent} series={[{ key: 'n', label: 'Dossiers' }]} example
          points={jours.groups.map((g) => ({ date: g.period, values: { n: g.items.length } }))} />
      </ChartGrid>
    </>
  );
}

// ————————————————————————————————————————————————————————— Carte et avis ; contestation au guichet

interface NoticeLike { dues: { obligationId: string; label: string; amount: MoneyJSON; dueDate: string }[] }
export function AvisVisuel({ notice }: { notice: NoticeLike }) {
  const cur = [...new Set(notice.dues.map((d) => d.amount.currency))];
  return (
    <ChartGrid min={260}>
      {cur.map((c) => (
        <BarChartViz key={c} title={`Sommes dues — ${c}`} orientation="horizontal" format={(v) => `${fmtCompact(v)} ${c}`} series={[{ key: 'm', label: c }]} example
          rows={notice.dues.filter((d) => d.amount.currency === c).map((d) => ({ key: d.obligationId, label: d.label, values: { m: Number(d.amount.amount) } }))} />
      ))}
      <TimelineStrip title="Échéances de l’avis" categories={['Échéance']} example emptyText="Aucune somme due."
        events={notice.dues.map((d) => ({ id: d.obligationId, at: d.dueDate, category: 'Échéance', label: `${d.label} — ${d.amount.amount} ${d.amount.currency}` }))} />
    </ChartGrid>
  );
}

const OBL_ETATS: Record<string, { label: string; tone: Tone }> = {
  EMISE: { label: 'Émise', tone: 'info' }, EXIGIBLE: { label: 'Exigible', tone: 'warning' }, EN_RETARD: { label: 'En retard', tone: 'critical' },
  PARTIELLEMENT_PAYEE: { label: 'Partiellement payée', tone: 'warning' }, SOLDEE: { label: 'Soldée', tone: 'good' }, CONTESTEE: { label: 'Contestée', tone: 'serious' },
};
export function SituationContribuable({ obligations }: { obligations: readonly { id: string; label: string; status: string; dueDate: string }[] }) {
  return (
    <ChartGrid min={280}>
      <StatusDistribution title="Obligations de la personne par état" unitLabel="obligations" items={parEtat(obligations.map((o) => o.status), OBL_ETATS)} emptyText="Aucune obligation." />
      <TimelineStrip title="Échéances des obligations contestables" categories={['Échéance']} emptyText="Aucune obligation contestable."
        events={obligations.filter((o) => ['EMISE', 'EXIGIBLE', 'EN_RETARD', 'PARTIELLEMENT_PAYEE'].includes(o.status)).map((o) => ({ id: o.id, at: o.dueDate, category: 'Échéance', label: o.label }))} />
    </ChartGrid>
  );
}

/** Indicateurs des canaux affichés sous un écran public quand la personne connectée est un agent. */
export function IndicateursAgent({ children }: { children: (ind: ChannelIndicators) => ReactNode }) {
  const q = useChannelIndicators();
  return q.data ? <>{children(q.data)}</> : null;
}
