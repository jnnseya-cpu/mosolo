/**
 * Trésor — visuels (trousse de visualisation, 27/09/2026). Chaque graphique est dérivé des données RÉELLES déjà
 * chargées par l'écran (aucune nouvelle route, aucun droit élargi) ; les montants restent par devise (jamais mélangés) ;
 * une liste vide affiche l'état « Aucune donnée » de la trousse, jamais un zéro trompeur.
 * Règles : docs/document-maitre/charte-visualisation.md. Rien de l'existant n'est retiré : ces blocs s'ajoutent.
 */
import type { MoneyJSON } from '@mosolo/shared';
import {
  BarChartViz, ChartGrid, DonutViz, HeatGrid, KpiGrid, KpiTile, StackedBarViz, StatusDistribution, fmtCompact, fmtNombre, type StatusItem,
} from '../../components/viz';
import type { Tone } from '../../components/StatusBadge';
import { countBy, groupByDay } from '../../lib/aggregate';
import { EXC_STATUS, OP_LABEL, OP_STATUS, QUEUE_LABEL, type Closures, type ExceptionList, type Operation, type Overview, type SuspenseList } from './shared';

const num = (m: MoneyJSON | null | undefined) => (m ? Math.abs(Number(m.amount)) : 0);
const ent = (v: number) => fmtNombre(v, 0);

/** Répartition par état à partir d'un dictionnaire d'états (ordre du dictionnaire conservé, états absents à 0). */
export function repartition<K extends string>(values: readonly K[], dict: Record<K, { label: string; tone: Tone }>): StatusItem[] {
  const c = new Map<string, number>();
  for (const v of values) c.set(v, (c.get(v) ?? 0) + 1);
  return (Object.keys(dict) as K[]).map((k) => ({ key: k, label: dict[k].label, tone: dict[k].tone, count: c.get(k) ?? 0 }));
}

// ————————————————————————————————————————————————————————— Synthèse de la page Trésor

export interface BalanceLike {
  balanced: boolean; entries?: number;
  accounts?: { account: string; label?: string; currency: string; balance: MoneyJSON }[];
}
export interface ImportLike { status: string; lines: unknown[] | number; proposedAt?: string }
type OverviewPlus = Overview & { providerReceivables?: { count: number; overdue: number; totals: MoneyJSON[]; delayDays: number } };

/** Soldes des comptes, un graphique par devise (valeur absolue, nature débitrice / créditrice dans le libellé). */
export function soldesParDevise(accounts: BalanceLike['accounts']): Record<string, { label: string; values: { solde: number } }[]> {
  const out: Record<string, { label: string; values: { solde: number } }[]> = {};
  for (const a of accounts ?? []) {
    const v = Number(a.balance.amount);
    if (!Number.isFinite(v) || v === 0) continue;
    (out[a.currency] ??= []).push({ label: `${a.label ?? a.account} (${v < 0 ? 'créditeur' : 'débiteur'})`, values: { solde: Math.abs(v) } });
  }
  for (const k of Object.keys(out)) out[k]!.sort((x, y) => y.values.solde - x.values.solde);
  return out;
}

/** Lignes de relevés importées par jour de valeur, une série par devise (nombre de lignes : aucune addition de montants). */
export function lignesParJour(imports: readonly { lines: unknown[] | number }[]): { rows: { label: string; key: string; values: Record<string, number> }[]; currencies: string[] } {
  const lines = imports.flatMap((i) => (Array.isArray(i.lines) ? i.lines as { valueDate?: string; amount?: MoneyJSON }[] : []));
  const currencies = [...new Set(lines.map((l): string => l.amount?.currency ?? '').filter((c) => c !== ''))].sort((a, b) => (a === 'CDF' ? -1 : b === 'CDF' ? 1 : a.localeCompare(b)));
  const g = groupByDay(lines, (l) => l.valueDate ?? null);
  const rows = g.groups.slice(-14).map((d) => ({
    key: d.period, label: d.period.slice(5).split('-').reverse().join('/'),
    values: Object.fromEntries(currencies.map((c) => [c, d.items.filter((l) => l.amount?.currency === c).length])),
  }));
  return { rows, currencies };
}

const IMPORT_ETATS: Record<string, { label: string; tone: Tone }> = {
  VALIDE: { label: 'Validé et appliqué', tone: 'good' },
  EN_ATTENTE_VALIDATION: { label: 'En attente de seconde validation', tone: 'warning' },
  INTEGRITE_KO: { label: 'Intégrité en échec', tone: 'critical' },
  REJETE: { label: 'Rejeté', tone: 'neutral' },
};

export function ImportsParEtat({ imports, framed = true }: { imports: readonly ImportLike[]; framed?: boolean }) {
  return <StatusDistribution framed={framed} title="Relevés importés par état" unitLabel="relevés" items={repartition(imports.map((i) => i.status), IMPORT_ETATS)} />;
}

export function TresorSynthese({ balance, overview, suspense, imports }: { balance: BalanceLike | null; overview: OverviewPlus | null; suspense: SuspenseList | null; imports: readonly ImportLike[] | null }) {
  const soldes = soldesParDevise(balance?.accounts);
  const lignes = imports ? lignesParJour(imports) : null;
  const acc = overview?.accounting;
  const partImputee = acc && acc.imputed + acc.unimputed > 0 ? (acc.imputed / (acc.imputed + acc.unimputed)) * 100 : null;
  return (
    <section className="panel tr-synthese" aria-labelledby="tr-syn-title">
      <header className="panel-head"><div>
        <h2 className="panel-title" id="tr-syn-title">Synthèse visuelle du Trésor</h2>
        <p className="panel-sub">Grand livre, rapprochement, suspens et relevés — données du jour, montants par devise (jamais additionnés entre devises).</p>
      </div></header>
      <KpiGrid max={5} label="Trésor — chiffres clés">
        <KpiTile hero label="Écritures du grand livre" value={balance?.entries ?? null} format={ent} reason="Grand livre non lisible pour ce rôle."
          state={balance ? { label: balance.balanced ? 'Équilibré' : 'Déséquilibré', tone: balance.balanced ? 'good' : 'critical' } : undefined} />
        <KpiTile label="Exceptions à traiter" value={overview?.exceptions.open ?? null} format={ent} reason="Réservé au Trésor, au rapprochement et à l’audit."
          state={overview ? (overview.exceptions.overdue ? { label: `${overview.exceptions.overdue} au-delà de 48 h`, tone: 'critical' } : { label: 'Dans les délais', tone: 'good' }) : undefined} />
        <KpiTile label="Suspens ouverts" value={overview?.suspense.open ?? null} format={ent} reason="Réservé au Trésor, au rapprochement et à l’audit."
          sub={overview?.suspense.totals.length ? overview.suspense.totals.map((m) => `${fmtCompact(Number(m.amount))} ${m.currency}`).join(' · ') + ` · ${overview.suspense.oldestDays} j max.` : undefined} />
        <KpiTile label="Rapprochés comptabilisés" value={partImputee} unit="%" format={(v) => fmtNombre(v, 1)}
          reason={acc ? 'Aucun paiement rapproché pour l’instant.' : 'Réservé au Trésor, au rapprochement et à l’audit.'}
          state={acc ? { label: `${acc.unimputed} à imputer`, tone: acc.unimputed ? 'warning' : 'good' } : undefined} />
        {overview?.providerReceivables && (
          <KpiTile label="Créances sur prestataires" value={overview.providerReceivables.count} format={ent}
            state={{ label: overview.providerReceivables.overdue ? `${overview.providerReceivables.overdue} en retard` : `Délai ${overview.providerReceivables.delayDays} j respecté`, tone: overview.providerReceivables.overdue ? 'critical' : 'good' }}
            sub={overview.providerReceivables.totals.map((m) => `${fmtCompact(Number(m.amount))} ${m.currency}`).join(' · ')} />
        )}
      </KpiGrid>
      <ChartGrid min={300}>
        {Object.entries(soldes).map(([cur, rows]) => (
          <BarChartViz key={cur} title={`Soldes des comptes — ${cur}`} subtitle="valeur absolue, nature entre parenthèses" orientation="horizontal"
            format={(v) => `${fmtCompact(v)} ${cur}`} series={[{ key: 'solde', label: `Solde (${cur})` }]} rows={rows} />
        ))}
        {balance && Object.keys(soldes).length === 0 && <BarChartViz title="Soldes des comptes" series={[{ key: 'solde', label: 'Solde' }]} rows={[]} />}
        {acc && (
          <StatusDistribution title="Paiements rapprochés — état comptable" unitLabel="paiements"
            items={[{ key: 'C', label: 'Comptabilisé', tone: 'good', count: acc.imputed }, { key: 'R', label: 'Rapproché, à imputer', tone: 'warning', count: acc.unimputed }]} />
        )}
        {suspense && (
          <BarChartViz title="Suspens par ancienneté" subtitle={`cible ${suspense.slaDays} j · jamais plus de ${suspense.maxDays} j`} format={ent}
            series={[{ key: 'n', label: 'Suspens' }]} rows={suspense.buckets.map((b) => ({ label: b.bucket, values: { n: b.count } }))}
            emptyText="Aucun fonds en attente d’identification." />
        )}
        {lignes && (
          <BarChartViz title="Lignes de relevés par jour de valeur" subtitle="nombre de lignes, une série par devise" format={ent}
            series={lignes.currencies.map((c) => ({ key: c, label: `Lignes en ${c}` }))} rows={lignes.rows} />
        )}
        {imports && <ImportsParEtat imports={imports} />}
      </ChartGrid>
    </section>
  );
}

// ————————————————————————————————————————————————————————— Onglets du poste de travail

export function ExceptionsVisuel({ list }: { list: ExceptionList }) {
  return (
    <ChartGrid min={300}>
      <StackedBarViz className="viz-span-2" title="Exceptions par file" subtitle="ouvertes, en cours, clôturées" mode="absolute" format={ent}
        series={[{ key: 'open', label: 'Ouvertes' }, { key: 'prog', label: 'En cours' }, { key: 'closed', label: 'Clôturées' }]}
        rows={list.queues.map((q) => ({ label: QUEUE_LABEL[q.queue], values: { open: q.open, prog: q.inProgress, closed: q.closed } }))}
        emptyText="Aucune exception dans les files." />
      <StatusDistribution title="Exceptions par état" unitLabel="exceptions" items={repartition(list.items.map((e) => e.status), EXC_STATUS)}
        note={`${list.items.filter((e) => e.overdue).length} au-delà du délai de ${list.slaHours} h.`} />
    </ChartGrid>
  );
}

export function SuspensVisuel({ s }: { s: SuspenseList }) {
  const cur = [...new Set(s.buckets.flatMap((b) => b.amounts.map((m) => m.currency)))];
  return (
    <ChartGrid min={300}>
      <BarChartViz title="Suspens par ancienneté (nombre)" format={ent} series={[{ key: 'n', label: 'Suspens' }]}
        rows={s.buckets.map((b) => ({ label: b.bucket, values: { n: b.count } }))} emptyText="Aucun fonds en attente d’identification." />
      {cur.map((c) => (
        <BarChartViz key={c} title={`Suspens par ancienneté — montants ${c}`} format={(v) => `${fmtCompact(v)} ${c}`} series={[{ key: 'm', label: c }]}
          rows={s.buckets.map((b) => ({ label: b.bucket, values: { m: num(b.amounts.find((m) => m.currency === c)) } }))} />
      ))}
    </ChartGrid>
  );
}

export function OperationsVisuel({ ops }: { ops: readonly Operation[] }) {
  const parNature = countBy(ops, (o) => OP_LABEL[o.kind]);
  return (
    <ChartGrid min={300}>
      <StatusDistribution title="Opérations par état" unitLabel="opérations" items={repartition(ops.map((o) => o.status), OP_STATUS)} emptyText="Aucune opération proposée." />
      <BarChartViz title="Opérations par nature" orientation="horizontal" format={ent} series={[{ key: 'n', label: 'Opérations' }]}
        rows={parNature.map((r) => ({ label: r.key, values: { n: r.count } }))} emptyText="Aucune opération proposée." />
    </ChartGrid>
  );
}

export function ClosuresVisuel({ c }: { c: Closures }) {
  const days = [...c.daily].sort((a, b) => a.date.localeCompare(b.date)).slice(-14);
  return (
    <ChartGrid min={300}>
      <BarChartViz title="Écritures par journée clôturée" subtitle="14 dernières clôtures" format={ent} series={[{ key: 'n', label: 'Écritures' }]}
        rows={days.map((d) => ({ label: d.date.slice(5).split('-').reverse().join('/'), values: { n: d.entries } }))}
        emptyText={`Aucune clôture quotidienne ; ${c.unclosedEntries} écriture(s) à clôturer.`} />
      <StatusDistribution title="Journées clôturées — équilibre" unitLabel="journées"
        items={[{ key: 'ok', label: 'Équilibrées', tone: 'good', count: c.daily.filter((d) => d.balanced).length }, { key: 'ko', label: 'Déséquilibrées', tone: 'critical', count: c.daily.filter((d) => !d.balanced).length }]}
        emptyText="Aucune clôture quotidienne." />
    </ChartGrid>
  );
}

export function ComptabiliteVisuel({ rows }: { rows: readonly { state: 'RAPPROCHE' | 'COMPTABILISE'; amount: MoneyJSON; code: string | null }[] }) {
  const parDevise = countBy(rows, (r) => r.amount.currency);
  return (
    <ChartGrid min={280}>
      <StatusDistribution title="État comptable des paiements rapprochés" unitLabel="paiements"
        items={[{ key: 'C', label: 'Comptabilisé', tone: 'good', count: rows.filter((r) => r.state === 'COMPTABILISE').length }, { key: 'R', label: 'Rapproché, non imputé', tone: 'warning', count: rows.filter((r) => r.state === 'RAPPROCHE').length }]}
        emptyText="Aucun paiement rapproché pour l’instant." />
      <DonutViz title="Paiements rapprochés par devise" centerLabel="paiements" format={ent}
        slices={parDevise.map((r) => ({ key: r.key, label: r.key, value: r.count }))} />
    </ChartGrid>
  );
}

const VERIF_COLS: [string, string][] = [['VALID', 'Valides'], ['PENDING', 'En attente'], ['UNKNOWN', 'Inconnues'], ['INVALID_CHECK_DIGIT', 'Clé erronée'], ['THROTTLED', 'Freinées']];
export function VerificationsVisuel({ days }: { days: readonly { date: string; total: number; byStatus: Record<string, number> }[] }) {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date)).slice(-14);
  return (
    <ChartGrid min={300}>
      <StackedBarViz className="viz-span-2" title="Vérifications publiques par jour" subtitle="agrégats seulement (aucun code, aucune adresse)" mode="absolute" orientation="vertical" format={ent}
        series={[...VERIF_COLS.map(([key, label]) => ({ key, label })), { key: 'AUTRES', label: 'Autres états' }]}
        rows={sorted.map((d) => {
          const known = VERIF_COLS.reduce((s, [k]) => s + (d.byStatus[k] ?? 0), 0);
          return { label: d.date.slice(5).split('-').reverse().join('/'), values: { ...Object.fromEntries(VERIF_COLS.map(([k]) => [k, d.byStatus[k] ?? 0])), AUTRES: Math.max(0, d.total - known) } };
        })}
        emptyText="Aucune vérification enregistrée." />
    </ChartGrid>
  );
}

// ————————————————————————————————————————————————————————— Appariements, points agréés, grand livre, coffre

interface MatchingLike {
  policy: { threshold: number };
  items: { exceptionId: string; candidates: { paymentReference: string; score: number; proposable: boolean }[] }[];
  proposals: { status: 'PROPOSEE' | 'CONFIRMEE' | 'REJETEE' }[];
}
const PROP_ETATS = { PROPOSEE: { label: 'À confirmer', tone: 'warning' as Tone }, CONFIRMEE: { label: 'Confirmée', tone: 'good' as Tone }, REJETEE: { label: 'Rejetée', tone: 'neutral' as Tone } };

export function AppariementsVisuel({ board }: { board: MatchingLike }) {
  const cands = board.items.flatMap((i) => i.candidates.map((c) => ({ ...c, ex: i.exceptionId })));
  return (
    <>
      <KpiGrid max={4} label="Appariement — chiffres clés">
        <KpiTile label="Crédits en exception" value={board.items.length} format={ent} state={{ label: board.items.length ? 'À apparier' : 'Aucun', tone: board.items.length ? 'warning' : 'good' }} />
        <KpiTile label="Candidats proposables" value={cands.filter((c) => c.proposable).length} format={ent} sub={`seuil ${board.policy.threshold}/100`} />
        <KpiTile label="Propositions à confirmer" value={board.proposals.filter((p) => p.status === 'PROPOSEE').length} format={ent} state={{ label: 'Quatre yeux', tone: 'info' }} />
        <KpiTile label="Appariements confirmés" value={board.proposals.filter((p) => p.status === 'CONFIRMEE').length} format={ent} />
      </KpiGrid>
      <ChartGrid min={300}>
        <BarChartViz title="Score des candidats" subtitle="facteurs visibles ; seuil de proposition en repère" orientation="horizontal" format={ent}
          series={[{ key: 's', label: 'Score /100' }]} reference={{ value: board.policy.threshold, label: `Seuil ${board.policy.threshold}` }}
          rows={cands.slice(0, 12).map((c) => ({ key: `${c.ex}|${c.paymentReference}`, label: c.paymentReference, values: { s: c.score } }))}
          emptyText="Aucun candidat : aucun crédit en attente d’appariement." />
        <StatusDistribution title="Propositions d’appariement par état" unitLabel="propositions" items={repartition(board.proposals.map((p) => p.status), PROP_ETATS)} emptyText="Aucune proposition." />
      </ChartGrid>
    </>
  );
}

interface PointsLike {
  points: { pointId: string; name: string; commune: string; contractStatus: 'EN_VIGUEUR' | 'ACTE_REQUIS' }[];
  late: { key: string; pointName: string; day: string; daysLate: number }[];
  penalties: { status: 'PROPOSEE' | 'DECIDEE' | 'ECARTEE' }[];
}
export function PointsAgreesVisuel({ board }: { board: PointsLike }) {
  const parCommune = countBy(board.points, 'commune');
  return (
    <>
      <KpiGrid max={4} label="Points agréés — chiffres clés">
        <KpiTile label="Points agréés" value={board.points.length} format={ent} />
        <KpiTile label="Contrats en vigueur" value={board.points.filter((p) => p.contractStatus === 'EN_VIGUEUR').length} format={ent}
          state={{ label: `${board.points.filter((p) => p.contractStatus === 'ACTE_REQUIS').length} acte(s) requis`, tone: board.points.some((p) => p.contractStatus === 'ACTE_REQUIS') ? 'warning' : 'good' }} />
        <KpiTile label="Retards de versement" value={board.late.length} format={ent} state={{ label: board.late.length ? 'À examiner' : 'Aucun', tone: board.late.length ? 'serious' : 'good' }} />
        <KpiTile label="Pénalités à décider" value={board.penalties.filter((p) => p.status === 'PROPOSEE').length} format={ent} state={{ label: 'Décision humaine', tone: 'info' }} />
      </KpiGrid>
      <ChartGrid min={300}>
        <StatusDistribution title="Contrats des points" unitLabel="points"
          items={[{ key: 'V', label: 'En vigueur', tone: 'good', count: board.points.filter((p) => p.contractStatus === 'EN_VIGUEUR').length }, { key: 'A', label: 'Contrat : acte requis', tone: 'warning', count: board.points.filter((p) => p.contractStatus === 'ACTE_REQUIS').length }]} />
        <HeatGrid className="viz-span-2" title="Points agréés par commune" measureLabel="Points agréés" format={ent} unmeasuredReason="aucun point agréé dans cette commune"
          cells={parCommune.map((r) => ({ commune: r.key, value: r.count }))} />
        <BarChartViz title="Retards de versement (jours)" orientation="horizontal" format={(v) => `${fmtNombre(v, 0)} j`} series={[{ key: 'j', label: 'Jours de retard' }]}
          rows={board.late.map((l) => ({ key: l.key, label: `${l.pointName} · ${l.day}`, values: { j: l.daysLate } }))} emptyText="Aucun retard de versement constaté." />
        <StatusDistribution title="Pénalités par état" unitLabel="pénalités" emptyText="Aucune pénalité proposée."
          items={repartition(board.penalties.map((p) => p.status), { PROPOSEE: { label: 'À décider', tone: 'warning' }, DECIDEE: { label: 'Retenue', tone: 'serious' }, ECARTEE: { label: 'Écartée', tone: 'neutral' } })} />
      </ChartGrid>
    </>
  );
}

interface GrandLivreLike {
  ecartReleves: { byCurrency: { currency: string; statements: MoneyJSON; ledger: MoneyJSON }[] };
  delaiCloture: { daily: { id: string; date: string; delayHours: number }[] };
}
export function GrandLivreVisuel({ d }: { d: GrandLivreLike }) {
  const delais = [...d.delaiCloture.daily].sort((a, b) => a.date.localeCompare(b.date)).slice(-14);
  return (
    <ChartGrid min={300}>
      {d.ecartReleves.byCurrency.map((r) => (
        <BarChartViz key={r.currency} title={`Relevés et compte public — ${r.currency}`} subtitle="l’écart doit être nul" orientation="horizontal"
          format={(v) => `${fmtCompact(v)} ${r.currency}`} series={[{ key: 'm', label: r.currency }]}
          rows={[{ label: 'Relevés importés', values: { m: num(r.statements) } }, { label: 'Inscrit au compte public', values: { m: num(r.ledger) } }]} />
      ))}
      <BarChartViz title="Délai des clôtures quotidiennes" subtitle="heures entre la fin de journée et la signature" format={(v) => `${fmtNombre(v, 0)} h`}
        series={[{ key: 'h', label: 'Délai (h)' }]} rows={delais.map((r) => ({ key: r.id, label: r.date.slice(5).split('-').reverse().join('/'), values: { h: r.delayHours } }))}
        emptyText="Aucune clôture quotidienne signée." />
    </ChartGrid>
  );
}

const VAULT_ETATS: Record<string, { label: string; tone: Tone }> = {
  EN_ATTENTE_APPROBATION: { label: 'Quorum attendu', tone: 'warning' }, EN_REFROIDISSEMENT: { label: 'Refroidissement (72 h)', tone: 'info' },
  EFFECTIF: { label: 'Effectif', tone: 'good' }, ANNULEE: { label: 'Annulée (veto)', tone: 'neutral' },
};
export function CoffreVisuel({ accounts, requests }: { accounts: readonly { kind: string; currency: string }[]; requests: readonly { status: string }[] }) {
  const items = repartition(requests.map((r) => r.status).filter((s) => s in VAULT_ETATS), VAULT_ETATS);
  const autres = requests.filter((r) => !(r.status in VAULT_ETATS)).length;
  return (
    <ChartGrid min={280}>
      <DonutViz title="Comptes verrouillés par nature" centerLabel="comptes" format={ent}
        slices={countBy(accounts, (a) => `${a.kind === 'MOBILE_MONEY' ? 'Mobile Money' : 'Bancaire'} ${a.currency}`).map((r) => ({ key: r.key, label: r.key, value: r.count }))} />
      <StatusDistribution title="Demandes de changement par état" unitLabel="demandes" emptyText="Aucune demande de changement."
        items={autres ? [...items, { key: 'AUTRE', label: 'Autre état', tone: 'neutral', count: autres }] : items} />
    </ChartGrid>
  );
}
