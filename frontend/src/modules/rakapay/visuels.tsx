/**
 * RakaPay — visuels (trousse de visualisation, 27/09/2026) : pilotage wewa, coopératives, opérateurs de billetterie.
 * Données RÉELLES déjà chargées par l'écran ; montants par devise (jamais additionnés entre devises) ; les estimations
 * du recensement et les données de démonstration portent le ruban EXEMPLE. Rien de l'existant n'est retiré.
 */
import type { MoneyJSON } from '@mosolo/shared';
import {
  BarChartViz, ChartGrid, DonutViz, GaugeMeter, HeatGrid, KpiGrid, KpiTile, StatusDistribution, TrendBadge, fmtCompact, fmtNombre, type StatusItem,
} from '../../components/viz';
import type { Tone } from '../../components/StatusBadge';
import { countBy } from '../../lib/aggregate';

const ent = (v: number) => fmtNombre(v, 0);
/** Taux servi en fraction (« 0.85 ») → pourcentage ; null si absent. */
export const tauxPct = (r: string | null | undefined): number | null => (r === null || r === undefined || r === '' || Number.isNaN(Number(r)) ? null : Number(r) * 100);
/** Cible servie par le serveur (« 100 % », « 1 », « 0.8 ») → pourcentage ; null si illisible (jamais inventée). */
export function ciblePct(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = /([\d.,]+)\s*%/.exec(t);
  if (m) return Number(m[1]!.replace(',', '.'));
  const n = Number(t);
  return Number.isFinite(n) ? (n <= 1 ? n * 100 : n) : null;
}

export function parEtat(values: readonly string[], dict: Record<string, { label: string; tone: Tone }>): StatusItem[] {
  const c = new Map<string, number>();
  for (const v of values) c.set(v, (c.get(v) ?? 0) + 1);
  const items: StatusItem[] = Object.keys(dict).map((k) => ({ key: k, label: dict[k]!.label, tone: dict[k]!.tone, count: c.get(k) ?? 0 }));
  const autres = values.filter((v) => !(v in dict)).length;
  return autres ? [...items, { key: 'AUTRE', label: 'Autre état', tone: 'neutral', count: autres }] : items;
}

// ————————————————————————————————————————————————————————— Pilotage RakaPay

interface PilotageLike {
  coverage: { byStation: { stationId: string; name: string; registered: number; estimated: number | null; green: number }[]; byCommune: { commune: string; registered: number; estimated: number; green: number }[] };
  compliance: { controlled: number; green: number; rate: string; constats: { total: number; open: number; classified: number; transmitted: number } };
  digitalPayment: { passesIssued: number; paidDigitally: number; rate: string; target: string; byChannel: Record<string, number> };
  complaints: { total: number; open: number; closed: number; byCommune: { commune: string; count: number }[] };
  tickets: { sold: number; active: number; controls: number; reuseAttempts: number };
  revenueByCommune: { commune: string; amounts: MoneyJSON[] }[];
}
const CHANNEL: Record<string, string> = { USSD: 'USSD', MOBILE_MONEY: 'Mobile Money', AGENT_POINT: 'Point agréé', BANK: 'Banque', CARD: 'Carte', QR: 'QR', TRANSFER: 'Virement' };

export function PilotageVisuel({ d }: { d: PilotageLike }) {
  const devises = [...new Set(d.revenueByCommune.flatMap((r) => r.amounts.map((a) => a.currency)))];
  return (
    <ChartGrid min={300} label="Pilotage RakaPay — synthèse visuelle">
      <GaugeMeter title="Paiement numérique des pass" subtitle={`${d.digitalPayment.paidDigitally} sur ${d.digitalPayment.passesIssued} pass`}
        value={d.digitalPayment.passesIssued ? tauxPct(d.digitalPayment.rate) : null} unit="%" target={ciblePct(d.digitalPayment.target)} targetLabel="Cible servie par le serveur" reason="aucun pass délivré" />
      <GaugeMeter title="Conformité au contrôle" subtitle={`${d.compliance.green} en vert sur ${d.compliance.controlled} contrôlées`} value={d.compliance.controlled ? tauxPct(d.compliance.rate) : null} unit="%" reason="aucun contrôle" />
      <HeatGrid className="viz-span-2" title="Motos enregistrées par commune" measureLabel="Motos enregistrées" format={ent} unmeasuredReason="aucune station recensée dans cette commune"
        cells={d.coverage.byCommune.map((r) => ({ commune: r.commune, value: r.registered, detail: `${r.green} en règle · estimées ${r.estimated} [EXEMPLE]` }))} />
      <BarChartViz className="viz-span-2" title="Couverture par station" subtitle="enregistrées et estimées — estimation [EXEMPLE] à établir par le recensement" orientation="horizontal" format={ent} example
        series={[{ key: 'r', label: 'Enregistrées' }, { key: 'g', label: 'En règle' }, { key: 'e', label: 'Estimées [EXEMPLE]' }]}
        rows={d.coverage.byStation.map((s) => ({ key: s.stationId, label: s.name, values: { r: s.registered, g: s.green, e: s.estimated } }))} />
      <DonutViz title="Pass payés par canal" centerLabel="pass" format={ent}
        slices={Object.entries(d.digitalPayment.byChannel).map(([k, n]) => ({ key: k, label: CHANNEL[k] ?? k, value: n }))} />
      <StatusDistribution title="Constats de contrôle" unitLabel="constats" note="Aucun montant : un constat n’est pas une amende."
        items={[{ key: 'o', label: 'À instruire', tone: 'warning', count: d.compliance.constats.open }, { key: 'c', label: 'Classés', tone: 'neutral', count: d.compliance.constats.classified }, { key: 't', label: 'Transmis', tone: 'info', count: d.compliance.constats.transmitted }]} />
      <StatusDistribution title="Plaintes (prélèvements irréguliers)" unitLabel="plaintes"
        items={[{ key: 'o', label: 'Ouvertes', tone: 'warning', count: d.complaints.open }, { key: 'c', label: 'Closes', tone: 'good', count: d.complaints.closed }]} />
      <HeatGrid className="viz-span-2" title="Plaintes par commune" measureLabel="Plaintes" format={ent} unmeasuredReason="aucune plainte dans cette commune"
        cells={d.complaints.byCommune.map((r) => ({ commune: r.commune, value: r.count }))} />
      <BarChartViz title="Billetterie urbaine" orientation="horizontal" format={ent} series={[{ key: 'n', label: 'Nombre' }]}
        rows={[{ label: 'Tickets vendus', values: { n: d.tickets.sold } }, { label: 'Tickets actifs', values: { n: d.tickets.active } }, { label: 'Contrôles', values: { n: d.tickets.controls } }, { label: 'Réutilisations détectées', values: { n: d.tickets.reuseAttempts } }]} />
      {devises.map((c) => (
        <HeatGrid key={c} className="viz-span-2" title={`Recette confirmée par commune — ${c}`} measureLabel={`Recette (${c})`} unit={c} format={fmtCompact} unmeasuredReason="aucune recette confirmée rattachée à cette commune"
          cells={d.revenueByCommune.map((r) => ({ commune: r.commune, value: (() => { const a = r.amounts.find((x) => x.currency === c); return a ? Number(a.amount) : null; })() }))} />
      ))}
    </ChartGrid>
  );
}

// ————————————————————————————————————————————————————————— Espace coopérative

interface CoopLike {
  members: { motoId: string; station: { name: string } | null; status: { color: 'VERT' | 'AMBRE' | 'ROUGE' } }[];
  payments: { status: string }[];
}
const COULEURS: Record<string, { label: string; tone: Tone }> = { VERT: { label: 'En règle', tone: 'good' }, AMBRE: { label: 'À renouveler', tone: 'warning' }, ROUGE: { label: 'Pas en règle', tone: 'critical' } };
const PAIEMENTS: Record<string, { label: string; tone: Tone }> = {
  EN_ATTENTE_PAIEMENT: { label: 'En attente de paiement', tone: 'warning' }, PARTIELLEMENT_EMISE: { label: 'Partiellement émise', tone: 'info' }, EMISE: { label: 'Titre(s) émis', tone: 'good' },
  EXPIREE: { label: 'Référence expirée', tone: 'neutral' }, ANNULEE: { label: 'Annulée', tone: 'neutral' },
};
export function CooperativeVisuel({ v }: { v: CoopLike }) {
  const parStation = countBy(v.members, (m) => m.station?.name ?? 'Sans station');
  return (
    <ChartGrid min={280}>
      <StatusDistribution title="Membres par conformité" unitLabel="membres" example items={parEtat(v.members.map((m) => m.status.color), COULEURS)} emptyText="Aucun membre." />
      <BarChartViz title="Membres par station" orientation="horizontal" format={ent} series={[{ key: 'n', label: 'Membres' }]} example
        rows={parStation.map((r) => ({ label: r.key, values: { n: r.count } }))} emptyText="Aucun membre." />
      <StatusDistribution title="Paiements groupés par état" unitLabel="paiements" example items={parEtat(v.payments.map((p) => p.status), PAIEMENTS)} emptyText="Aucun paiement groupé." />
    </ChartGrid>
  );
}

// ————————————————————————————————————————————————————————— Opérateurs de billetterie

interface Group { key: string; count: number; amounts: MoneyJSON[] }
const OP_ETATS: Record<string, { label: string; tone: Tone }> = {
  CANDIDAT: { label: 'Candidature', tone: 'info' }, ACCREDITE: { label: 'Accrédité', tone: 'good' }, SUSPENDU: { label: 'Suspendu', tone: 'critical' }, REFUSE: { label: 'Refusé', tone: 'neutral' }, INVITE: { label: 'Invité', tone: 'info' },
};
const OFFRE_ETATS: Record<string, { label: string; tone: Tone }> = { PROPOSEE: { label: 'En attente', tone: 'warning' }, APPROUVEE: { label: 'Approuvée', tone: 'good' }, REFUSEE: { label: 'Refusée', tone: 'neutral' } };
const FAMILLE: Record<string, string> = { STATIONNEMENT: 'Stationnement', ACCES: 'Accès (transport, marchés, zones)' };

export function SupervisionOperateursVisuel({ operators, offers, circuits, reviews }: {
  operators: readonly { status: string; kind: string; commune: string }[]; offers: readonly { status: string; family: string }[];
  circuits: { public: { label: string; amounts: MoneyJSON[] }; private: { label: string; amounts: MoneyJSON[]; sales: number } } | null;
  reviews: readonly { status: string }[] | null;
}) {
  const devises = circuits ? [...new Set([...circuits.public.amounts, ...circuits.private.amounts].map((m) => m.currency))] : [];
  return (
    <ChartGrid min={280} label="Billetterie — synthèse visuelle">
      <StatusDistribution title="Opérateurs par état d’agrément" unitLabel="opérateurs" items={parEtat(operators.map((o) => o.status), OP_ETATS)} emptyText="Aucun opérateur." />
      <HeatGrid className="viz-span-2" title="Opérateurs par commune" measureLabel="Opérateurs" format={ent} unmeasuredReason="aucun opérateur dans cette commune" cells={countBy(operators, 'commune').map((r) => ({ commune: r.key, value: r.count }))} />
      <StatusDistribution title="Offres par état" unitLabel="offres" items={parEtat(offers.map((o) => o.status), OFFRE_ETATS)} emptyText="Aucune offre." />
      <DonutViz title="Offres par famille" centerLabel="offres" format={ent} slices={countBy(offers, 'family').map((r) => ({ key: r.key, label: FAMILLE[r.key] ?? r.key, value: r.count }))} />
      {circuits && devises.map((c) => (
        <BarChartViz key={c} title={`Deux circuits séparés — ${c}`} subtitle="jamais additionnés : le circuit privé ne transite pas par le compte public" orientation="horizontal"
          format={(v) => `${fmtCompact(v)} ${c}`} series={[{ key: 'm', label: c }]}
          rows={[{ label: circuits.public.label, values: { m: Number(circuits.public.amounts.find((m) => m.currency === c)?.amount ?? 0) } }, { label: circuits.private.label, values: { m: Number(circuits.private.amounts.find((m) => m.currency === c)?.amount ?? 0) } }]} />
      ))}
      {reviews && (
        <StatusDistribution title="Revues de ventes atypiques" unitLabel="signaux" emptyText="Aucun signal."
          items={parEtat(reviews.map((r) => r.status), { A_EXAMINER: { label: 'À examiner', tone: 'warning' }, CLASSEE: { label: 'Classée', tone: 'neutral' }, TRANSMISE_INTEGRITE: { label: 'Transmise à l’intégrité', tone: 'serious' } })} />
      )}
    </ChartGrid>
  );
}

export function CircuitPriveVisuel({ circuit }: { circuit: { sales: number; cancellations: number; byZone: Group[]; byHour: Group[]; byAgent: Group[] } }) {
  return (
    <ChartGrid min={260}>
      <BarChartViz title="Ventes privées par heure" format={ent} series={[{ key: 'n', label: 'Ventes' }]}
        rows={[...circuit.byHour].sort((a, b) => Number(a.key) - Number(b.key)).map((g) => ({ label: `${g.key} h`, values: { n: g.count } }))} emptyText="Aucune vente privée." />
      <HeatGrid className="viz-span-2" title="Ventes privées par zone" measureLabel="Ventes" format={ent} unmeasuredReason="aucune vente dans cette commune" cells={circuit.byZone.map((g) => ({ commune: g.key, value: g.count }))} />
      <BarChartViz title="Ventes privées par agent" orientation="horizontal" format={ent} series={[{ key: 'n', label: 'Ventes' }]}
        rows={circuit.byAgent.map((g) => ({ label: g.key, values: { n: g.count } }))} emptyText="Aucune vente par agent." />
    </ChartGrid>
  );
}

export function AnalyseQuotidienneVisuel({ a }: { a: { date: string; sales: number; cancellations: number; previous7DaysAverage: number; byHour: Group[]; byOffer: Group[]; byAgent: Group[] } }) {
  return (
    <>
      <KpiGrid max={3} label="Analyse quotidienne">
        <KpiTile label={`Ventes du ${a.date.split('-').reverse().join('/')}`} value={a.sales} format={ent}
          sub={<TrendBadge current={a.sales} previous={a.previous7DaysAverage} versus="vs moyenne des 7 jours précédents" />} />
        <KpiTile label="Annulations" value={a.cancellations} format={ent} state={{ label: a.sales ? `${fmtNombre((a.cancellations / Math.max(1, a.sales)) * 100, 0)} % des ventes` : 'Aucune vente', tone: 'info' }} />
        <KpiTile label="Moyenne des 7 jours précédents" value={a.previous7DaysAverage} format={(v) => fmtNombre(v, 1)} />
      </KpiGrid>
      <ChartGrid min={260}>
        <BarChartViz title="Ventes par heure" format={ent} series={[{ key: 'n', label: 'Ventes' }]}
          rows={[...a.byHour].sort((x, y) => Number(x.key) - Number(y.key)).map((g) => ({ label: `${g.key} h`, values: { n: g.count } }))} emptyText="Aucune vente ce jour." />
        <DonutViz title="Ventes par offre" centerLabel="ventes" format={ent} slices={a.byOffer.map((g) => ({ key: g.key, label: g.key, value: g.count }))} />
        <BarChartViz title="Ventes par agent" orientation="horizontal" format={ent} series={[{ key: 'n', label: 'Ventes' }]}
          rows={a.byAgent.map((g) => ({ label: g.key, values: { n: g.count } }))} emptyText="Aucune vente par agent." />
      </ChartGrid>
    </>
  );
}
