/**
 * Recouvrement — visuels (trousse de visualisation, 27/09/2026). Graphiques dérivés des données RÉELLES déjà chargées
 * par chaque écran (aucune route ni aucun droit nouveau) ; montants par devise, jamais additionnés entre devises ;
 * listes vides → état « Aucune donnée » de la trousse. Rien de l'existant n'est retiré : ces blocs s'ajoutent.
 */
import type { MoneyJSON } from '@mosolo/shared';
import {
  BarChartViz, ChartGrid, DonutViz, GaugeMeter, HeatGrid, KpiGrid, KpiTile, LineAreaViz, StackedBarViz, StatusDistribution, TimelineStrip,
  fmtCompact, fmtNombre, type StatusItem,
} from '../../components/viz';
import type { Tone } from '../../components/StatusBadge';
import { countBy, groupByMonth } from '../../lib/aggregate';
import {
  APPEAL_STATE, INSTALLMENT_LABEL, PLAN_LABEL, PLAN_TONE, REMISSION_STATUS, RISK_TONE, WRITE_OFF_STATUS,
  type Arrear, type Balance, type Plan, type Remission, type WriteOff,
} from './types';

const ent = (v: number) => fmtNombre(v, 0);

/** Répartition par état : ordre du dictionnaire, états absents à 0, états inconnus regroupés. */
export function parEtat<K extends string>(values: readonly string[], dict: Record<K, { label: string; tone: Tone }>): StatusItem[] {
  const c = new Map<string, number>();
  for (const v of values) c.set(v, (c.get(v) ?? 0) + 1);
  const items: StatusItem[] = (Object.keys(dict) as K[]).map((k) => ({ key: k, label: dict[k].label, tone: dict[k].tone, count: c.get(k) ?? 0 }));
  const autres = values.filter((v) => !(v in dict)).length;
  return autres ? [...items, { key: 'AUTRE', label: 'Autre état', tone: 'neutral', count: autres }] : items;
}

/** Balance âgée : une série par devise (lignes = tranches d'ancienneté). */
export function balanceAgeeParDevise(balance: Balance): Record<string, { key: string; label: string; values: { m: number } }[]> {
  const out: Record<string, { key: string; label: string; values: { m: number } }[]> = {};
  const cur = new Set<string>();
  for (const b of balance.bands) for (const c of Object.keys(balance.byBand[b.code] ?? {})) cur.add(c);
  for (const c of cur) out[c] = balance.bands.map((b) => ({ key: b.code, label: b.label, values: { m: Number(balance.byBand[b.code]?.[c] ?? 0) } }));
  return out;
}

// ————————————————————————————————————————————————————————— File de recouvrement (R06, R07, R11, R20–R23)

interface Indicators {
  cases: { open: number; regularised: number; classed: number };
  proposals: { pending: number; approved: number; rejected: number };
  notices: { issued: number; read: number; undelivered: number };
  plans: { requested: number; active: number; defaulted: number };
  regularisationRate: string | null;
}
const RISQUES = { FAIBLE: { label: 'Faible', tone: RISK_TONE.FAIBLE! }, MOYEN: { label: 'Moyen', tone: RISK_TONE.MOYEN! }, ELEVE: { label: 'Élevé', tone: RISK_TONE.ELEVE! } };
const pct = (s: string | null | undefined) => (s === null || s === undefined ? null : Number(s.replace('%', '').replace(',', '.').trim()));

export function RecouvrementVisuel({ items, balance, indicators, plans }: { items: readonly Arrear[]; balance: Balance; indicators: Indicators; plans: readonly Plan[] }) {
  const bands = balanceAgeeParDevise(balance);
  const segments = Object.entries(balance.bySegment).map(([k, n]) => ({ key: k, label: items.find((a) => a.segment?.code === k)?.segment?.label ?? k, value: n }));
  const taux = pct(indicators.regularisationRate);
  return (
    <>
      <ChartGrid min={300}>
        {Object.entries(bands).map(([c, rows]) => (
          <BarChartViz key={c} title={`Balance âgée — ${c}`} subtitle="encours échu par tranche d’ancienneté" orientation="horizontal" format={(v) => `${fmtCompact(v)} ${c}`}
            series={[{ key: 'm', label: `Encours (${c})` }]} rows={rows} />
        ))}
        {Object.keys(bands).length === 0 && <BarChartViz title="Balance âgée" series={[{ key: 'm', label: 'Encours' }]} rows={[]} emptyText="Aucun arriéré à ce jour." />}
        <HeatGrid className="viz-span-2" title="Arriérés par commune" measureLabel="Créances échues" format={ent} unmeasuredReason="aucun arriéré rattaché à cette commune"
          cells={countBy(items.filter((a) => a.commune), 'commune').map((r) => ({ commune: r.key, value: r.count }))} />
        <DonutViz title="Arriérés par segment" centerLabel="créances" format={ent} slices={segments} />
        <StatusDistribution title="Profil de risque (aide à l’orientation)" unitLabel="créances" emptyText="Aucun profil calculé."
          items={parEtat(items.map((a) => a.risk?.level ?? '').filter(Boolean), RISQUES)} note="Aucune mesure n’est déclenchée par le profil." />
        <StatusDistribution title="Décisions (propositions)" unitLabel="propositions"
          items={[{ key: 'p', label: 'Attendues', tone: 'warning', count: indicators.proposals.pending }, { key: 'a', label: 'Approuvées', tone: 'good', count: indicators.proposals.approved }, { key: 'r', label: 'Rejetées', tone: 'neutral', count: indicators.proposals.rejected }]} />
        <StatusDistribution title="Échéanciers par état" unitLabel="échéanciers" items={parEtat(plans.map((p) => p.status), Object.fromEntries(Object.keys(PLAN_LABEL).map((k) => [k, { label: PLAN_LABEL[k]!, tone: PLAN_TONE[k] ?? 'neutral' }])))} />
        <GaugeMeter title="Taux de régularisation des dossiers" subtitle="suivi, sans cible fixée par un acte" value={taux} unit="%" reason="aucun dossier mesuré pour l’instant" />
        <GaugeMeter title="Avis lus (sur notifiés)" value={indicators.notices.issued ? (indicators.notices.read / indicators.notices.issued) * 100 : null} unit="%" reason="aucun avis notifié" />
      </ChartGrid>
    </>
  );
}

// ————————————————————————————————————————————————————————— Espace contribuable (R30, R31)

interface MineLike {
  arrears: readonly Arrear[];
  upcoming: readonly { obligationId: string; label: string; amount: MoneyJSON; dueDate: string; daysToDue: number }[];
  notices: readonly { readAt: string | null }[];
  plans: readonly Plan[];
}
export function MesArrieresVisuel({ mine, appeals }: { mine: MineLike; appeals: number }) {
  const rows = mine.plans.flatMap((p) => p.rows ?? []);
  const totals = new Map<string, number>();
  for (const a of mine.arrears) totals.set(a.amount.currency, (totals.get(a.amount.currency) ?? 0) + Number(a.amount.amount));
  return (
    <section className="section" aria-label="Ma situation en un coup d’œil">
      <KpiGrid max={4} label="Ma situation">
        <KpiTile hero label="Arriérés" value={mine.arrears.length} format={ent} state={{ label: mine.arrears.length ? 'À régulariser' : 'À jour', tone: mine.arrears.length ? 'warning' : 'good' }}
          sub={[...totals].map(([c, v]) => `${fmtCompact(v)} ${c}`).join(' · ') || undefined} />
        <KpiTile label="Prochaines échéances" value={mine.upcoming.length} format={ent} sub={mine.upcoming[0] ? `la plus proche dans ${Math.min(...mine.upcoming.map((u) => u.daysToDue))} j` : undefined} />
        <KpiTile label="Avis non lus" value={mine.notices.filter((n) => !n.readAt).length} format={ent} state={{ label: `${mine.notices.length} avis reçus`, tone: 'info' }} />
        <KpiTile label="Réclamations" value={appeals} format={ent} />
      </KpiGrid>
      <ChartGrid min={280}>
        <TimelineStrip title="Mes échéances à venir" categories={['Échéance']} emptyText="Aucune échéance à venir."
          events={mine.upcoming.map((u) => ({ id: u.obligationId, at: u.dueDate, category: 'Échéance', label: `${u.label} — ${u.amount.amount} ${u.amount.currency}` }))} />
        <StatusDistribution title="Mes échéances d’échéancier" unitLabel="échéances" emptyText="Aucun échéancier."
          items={parEtat(rows.map((r) => r.state), INSTALLMENT_LABEL as Record<string, { label: string; tone: Tone }>)} />
      </ChartGrid>
    </section>
  );
}

// ————————————————————————————————————————————————————————— Recours, remises, non-valeurs

interface AppealIndicators { open: number; overdue: number; approaching: number; unassigned: number; decided: number; decidedLate: number; byOwner?: { owner?: string; label?: string; entity?: string; open?: number; overdue?: number }[] }
const APPEAL_STATUS: Record<string, { label: string; tone: Tone }> = {
  DEPOSEE: { label: 'À instruire', tone: 'info' }, PROPOSITION: { label: 'À décider', tone: 'warning' }, ACCEPTEE: { label: 'Accepté', tone: 'good' },
  PARTIELLEMENT_ACCEPTEE: { label: 'Partiellement accepté', tone: 'good' }, REJETEE: { label: 'Rejeté', tone: 'neutral' },
};
export function RecoursVisuel({ appeals, ind }: { appeals: readonly { status: string; submittedAt: string; deadlines: { state: string } }[]; ind: AppealIndicators }) {
  const mois = groupByMonth(appeals, (a) => a.submittedAt);
  return (
    <>
      <KpiGrid max={4} label="Recours — chiffres clés">
        <KpiTile label="Recours en cours" value={ind.open} format={ent} state={{ label: ind.unassigned ? `${ind.unassigned} sans propriétaire` : 'Tous affectés', tone: ind.unassigned ? 'warning' : 'good' }} />
        <KpiTile label="Hors délai" value={ind.overdue} format={ent} state={{ label: ind.overdue ? 'Délai légal dépassé' : 'Aucun', tone: ind.overdue ? 'critical' : 'good' }} />
        <KpiTile label="Échéance proche" value={ind.approaching} format={ent} />
        <KpiTile label="Décidés" value={ind.decided} format={ent} sub={ind.decidedLate ? `${ind.decidedLate} hors délai` : undefined} />
      </KpiGrid>
      <ChartGrid min={300}>
        <StatusDistribution title="Recours par état" unitLabel="recours" items={parEtat(appeals.map((a) => a.status), APPEAL_STATUS)} emptyText="Aucun recours." />
        <StatusDistribution title="Recours par délai" unitLabel="recours" items={parEtat(appeals.map((a) => a.deadlines.state), APPEAL_STATE)} emptyText="Aucun recours." />
        <LineAreaViz title="Recours déposés par mois" granularity="month" area format={ent} series={[{ key: 'n', label: 'Recours' }]}
          points={mois.groups.map((g) => ({ date: g.period, values: { n: g.items.length } }))} />
      </ChartGrid>
    </>
  );
}

export function RemisesVisuel({ remissions }: { remissions: readonly Remission[] }) {
  const cur = [...new Set(remissions.map((r) => r.requestedAmount.currency))];
  return (
    <ChartGrid min={300}>
      <StatusDistribution title="Remises par état" unitLabel="demandes" items={parEtat(remissions.map((r) => r.status), REMISSION_STATUS)} emptyText="Aucune demande de remise." />
      {cur.map((c) => {
        const rs = remissions.filter((r) => r.requestedAmount.currency === c);
        return (
          <StackedBarViz key={c} title={`Montants des remises — ${c}`} mode="absolute" format={(v) => `${fmtCompact(v)} ${c}`}
            series={[{ key: 'd', label: 'Demandé' }, { key: 'a', label: 'Accordé' }]}
            rows={[{ label: 'Demandes', values: { d: rs.reduce((s, r) => s + Number(r.requestedAmount.amount), 0), a: 0 } },
              { label: 'Décisions', values: { d: 0, a: rs.reduce((s, r) => s + (r.decision?.grantedAmount && r.decision.fromAmount ? Number(r.decision.fromAmount.amount) - Number(r.decision.grantedAmount.amount) : 0), 0) } }]} />
        );
      })}
    </ChartGrid>
  );
}

export function NonValeursVisuel({ writeOffs }: { writeOffs: readonly WriteOff[] }) {
  const cur = [...new Set(writeOffs.map((w) => w.amount.currency))];
  return (
    <ChartGrid min={300}>
      <StatusDistribution title="Admissions en non-valeur par état" unitLabel="propositions" items={parEtat(writeOffs.map((w) => w.status), WRITE_OFF_STATUS)} emptyText="Aucune proposition d’admission." />
      {cur.map((c) => (
        <BarChartViz key={c} title={`Montants proposés et admis — ${c}`} orientation="horizontal" format={(v) => `${fmtCompact(v)} ${c}`} series={[{ key: 'm', label: c }]}
          rows={(['PROPOSEE', 'ADMISE', 'REJETEE'] as const).map((s) => ({ label: WRITE_OFF_STATUS[s].label, values: { m: writeOffs.filter((w) => w.status === s && w.amount.currency === c).reduce((t, w) => t + Number(w.amount.amount), 0) } }))} />
      ))}
    </ChartGrid>
  );
}

// ————————————————————————————————————————————————————————— Campagnes et rendement

const CAMP_ETATS: Record<string, { label: string; tone: Tone }> = {
  BROUILLON: { label: 'Brouillon', tone: 'neutral' }, SIMULEE: { label: 'Simulée', tone: 'info' }, LANCEMENT_PROPOSE: { label: 'Lancement proposé', tone: 'warning' },
  LANCEE: { label: 'Lancée', tone: 'good' }, ARRETEE: { label: 'Arrêtée', tone: 'critical' }, CLOTUREE: { label: 'Clôturée', tone: 'neutral' },
};
export function CampagnesVisuel({ campaigns, calendar }: { campaigns: readonly { status: string; communes: string[]; simulation?: { channels: Record<string, number> } }[]; calendar: readonly { entity: string; campaigns: { code: string; label: string; dueDate: string; reminders: { label: string; date: string }[] }[] }[] }) {
  const events = calendar.flatMap((e) => e.campaigns.flatMap((c) => [
    { id: `${c.code}-due`, at: c.dueDate, category: 'Échéance', label: `${e.entity} — ${c.label}` },
    ...c.reminders.map((r, i) => ({ id: `${c.code}-r${i}`, at: r.date, category: 'Relance', label: `${r.label} — ${c.label}` })),
  ]));
  const communes = countBy(campaigns.flatMap((c) => c.communes.map((x) => ({ commune: x }))), 'commune');
  const canaux = new Map<string, number>();
  for (const c of campaigns) for (const [k, v] of Object.entries(c.simulation?.channels ?? {})) canaux.set(k, (canaux.get(k) ?? 0) + v);
  return (
    <ChartGrid min={300}>
      <TimelineStrip className="viz-span-2" title="Calendrier des campagnes" categories={['Échéance', 'Relance']} events={events} emptyText="Aucune campagne planifiée." />
      <StatusDistribution title="Campagnes par état" unitLabel="campagnes" items={parEtat(campaigns.map((c) => c.status), CAMP_ETATS)} emptyText="Aucune campagne." />
      <HeatGrid className="viz-span-2" title="Communes couvertes par les campagnes" measureLabel="Campagnes" format={ent} unmeasuredReason="aucune campagne dans cette commune"
        cells={communes.map((r) => ({ commune: r.key, value: r.count }))} />
      <DonutViz title="Messages simulés par canal" centerLabel="messages" format={ent}
        slices={[...canaux].map(([k, v]) => ({ key: k, label: k.toUpperCase() === 'IN-APP' ? 'Application' : k.toUpperCase(), value: v }))} />
    </ChartGrid>
  );
}

export function CampagnesRecouvrementVisuel({ campaigns }: { campaigns: readonly { code: string; summary: { targets: number; byGroup: Record<string, number>; excluded: number; contacts: number; visitsToDo: number } }[] }) {
  return (
    <ChartGrid min={300}>
      <StackedBarViz title="Cibles par groupe (test / témoin)" mode="absolute" format={ent}
        series={[{ key: 'TEST', label: 'Test' }, { key: 'TEMOIN', label: 'Témoin' }, { key: 'RESERVE', label: 'Réserve' }, { key: 'EXCLU', label: 'Exclues' }]}
        rows={campaigns.map((c) => ({ label: c.code, values: { TEST: c.summary.byGroup.TEST ?? 0, TEMOIN: c.summary.byGroup.TEMOIN ?? 0, RESERVE: c.summary.byGroup.RESERVE ?? 0, EXCLU: c.summary.excluded } }))}
        emptyText="Aucune campagne de recouvrement." />
      <BarChartViz title="Contacts et visites à faire" format={ent} series={[{ key: 'c', label: 'Contacts' }, { key: 'v', label: 'Visites à faire' }]}
        rows={campaigns.map((c) => ({ label: c.code, values: { c: c.summary.contacts, v: c.summary.visitsToDo } }))} emptyText="Aucune campagne de recouvrement." />
    </ChartGrid>
  );
}

type Totals = Record<string, string>;
export function RendementVisuel({ summary, guarantees, priorities }: { summary: { status: string; detail: string; gross: Totals; cost: Totals; net: Totals | 'NON_MESURE'; costedCases: number; cases: number }; guarantees: readonly { status: string }[]; priorities: readonly { commune: string | null }[] }) {
  const cur = [...new Set([...Object.keys(summary.gross), ...Object.keys(summary.cost)])];
  const net = summary.net === 'NON_MESURE' ? null : summary.net;
  return (
    <ChartGrid min={300}>
      {cur.map((c) => (
        <BarChartViz key={c} title={`Brut, coûts et net — ${c}`} orientation="horizontal" format={(v) => `${fmtCompact(v)} ${c}`} series={[{ key: 'm', label: c }]}
          rows={[{ label: 'Récupération brute', values: { m: Number(summary.gross[c] ?? 0) } }, { label: 'Coûts saisis', values: { m: Number(summary.cost[c] ?? 0) } },
            { label: 'Récupération nette', values: { m: net ? Number(net[c] ?? 0) : null } }]}
          note={net ? undefined : 'Net non mesuré : motif affiché en tête d’écran.'} />
      ))}
      {cur.length === 0 && <BarChartViz title="Brut, coûts et net" series={[{ key: 'm', label: 'Montant' }]} rows={[]} unmeasured={summary.status === 'NON_MESURE' ? 'aucun montant récupéré ni coût saisi (motif en tête d’écran)' : undefined} />}
      <GaugeMeter title="Dossiers dont le coût est saisi" subtitle={`${summary.costedCases} sur ${summary.cases}`} value={summary.cases ? (summary.costedCases / summary.cases) * 100 : null} unit="%" reason="aucun dossier" />
      <StatusDistribution title="Garanties des grands débiteurs" unitLabel="garanties" emptyText="Aucune garantie proposée."
        items={parEtat(guarantees.map((g) => g.status), { PROPOSEE: { label: 'Proposée', tone: 'warning' }, VALIDEE: { label: 'Validée', tone: 'good' }, REJETEE: { label: 'Rejetée', tone: 'neutral' }, LEVEE: { label: 'Levée', tone: 'info' } })} />
      <HeatGrid className="viz-span-2" title="File priorisée par commune" measureLabel="Créances priorisées" format={ent} unmeasuredReason="aucune créance priorisée dans cette commune"
        cells={countBy(priorities.filter((p) => p.commune), 'commune').map((r) => ({ commune: r.key, value: r.count }))} />
    </ChartGrid>
  );
}

// ————————————————————————————————————————————————————————— Avis : chronologie de la notification

const ENVOI_ETATS: Record<string, { label: string; tone: Tone }> = {
  delivre: { label: 'Délivré', tone: 'good' }, lu: { label: 'Lu', tone: 'good' }, envoye: { label: 'Envoyé', tone: 'info' }, en_file: { label: 'En file', tone: 'info' },
  journalise: { label: 'Journalisé (mode démonstration)', tone: 'neutral' }, echoue: { label: 'Échoué', tone: 'critical' }, supprime_par_preference: { label: 'Non envoyé (préférence)', tone: 'warning' },
};
export function NotificationChronologie({ issuedAt, deliveries, readAt, fieldAt, channelLabel }: {
  issuedAt: string; deliveries: readonly { id: string; at: string; channel: string; status: string }[]; readAt: string | null; fieldAt?: string | null;
  channelLabel: Record<string, string>;
}) {
  const events = [
    { id: 'emis', at: issuedAt, category: 'Émission', label: 'Avis émis (contenu scellé)' },
    ...deliveries.map((d) => ({ id: d.id, at: d.at, category: 'Envoi', label: `${channelLabel[d.channel] ?? d.channel} — ${ENVOI_ETATS[d.status]?.label ?? d.status}` })),
    ...(fieldAt ? [{ id: 'remise', at: fieldAt, category: 'Remise en personne', label: 'Remise en personne enregistrée' }] : []),
    ...(readAt ? [{ id: 'lu', at: readAt, category: 'Lecture', label: 'Accusé de lecture' }] : []),
  ];
  return (
    <ChartGrid min={280}>
      <TimelineStrip className="viz-span-2" title="Chronologie de la notification" categories={['Émission', 'Envoi', 'Remise en personne', 'Lecture']} events={events} />
      <StatusDistribution title="Envois par résultat" unitLabel="envois" emptyText="Aucun envoi enregistré." items={parEtat(deliveries.map((d) => d.status), ENVOI_ETATS).filter((i) => i.count > 0)} />
    </ChartGrid>
  );
}
