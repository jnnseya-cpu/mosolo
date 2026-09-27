/**
 * Visuels des écrans généraux (ajout du 27/09/2026, charte : docs/document-maitre/charte-visualisation.md).
 * Chaque visuel est dérivé des données RÉELLES que l'écran charge déjà (aucun appel supplémentaire sauf mention),
 * avec la trousse partagée `components/viz` et les agrégations `lib/aggregate`. Rien de l'existant n'est retiré :
 * les tableaux, listes, formulaires et boutons de chaque écran restent en place, les visuels s'ajoutent au-dessus.
 * Aucun chiffre inventé : une liste vide affiche l'état vide de la trousse ; une donnée de démonstration garde
 * sa mention [EXEMPLE] ; les montants restent devise par devise (jamais additionnés entre devises).
 */
import type { ReactNode } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import {
  BarChartViz, ChartGrid, DonutViz, KpiGrid, KpiTile, LineAreaViz, ProgressMeter, StackedBarViz, StatusDistribution, TimelineStrip,
  fmtCompact, fmtDevise, fmtNombre, type StatusItem,
} from '../components/viz';
import type { Tone } from '../components/StatusBadge';
import './visuels.css';
import { countBy, groupByDay, kinshasaDay, sumMoney, topN, type CountRow, type MoneyTotals } from '../lib/aggregate';

// ————————————————————————— utilitaires —————————————————————————

/** Définition d'un état affiché : libellé français et ton (couleur d'état + icône). */
export type EtatDef = { label: string; tone: Tone };

/**
 * Répartition par état : tous les états déclarés (même à zéro, pour lire « aucun en retard ») puis les états
 * inconnus rencontrés (ton neutre, code brut) — jamais d'état caché.
 */
export function etatsDepuis(defs: Record<string, EtatDef>, rows: readonly CountRow[] | Record<string, number>, opts: { masquerZeros?: boolean } = {}): StatusItem[] {
  const counts = new Map<string, number>(Array.isArray(rows) ? (rows as CountRow[]).map((r) => [r.key, r.count]) : Object.entries(rows as Record<string, number>));
  const items: StatusItem[] = Object.entries(defs).map(([key, d]) => ({ key, label: d.label, tone: d.tone, count: counts.get(key) ?? 0 }));
  for (const [key, count] of counts) if (!(key in defs)) items.push({ key, label: key, tone: 'neutral', count });
  return opts.masquerZeros ? items.filter((i) => i.count > 0) : items;
}

/** Montant (MoneyJSON) → nombre pour la seule géométrie (l'affichage reste formaté par devise). */
export const montantNombre = (m: MoneyJSON | null | undefined): number => (m ? Number(m.amount) : 0);

/** Totaux par devise (CDF d'abord) → tuiles, une par devise présente. */
export function tuilesDevises(totals: MoneyTotals, label: (cur: string) => string, extra?: (cur: string) => Partial<Parameters<typeof KpiTile>[0]>): ReactNode[] {
  const curs = Object.keys(totals).sort((a, b) => (a === 'CDF' ? -1 : b === 'CDF' ? 1 : a.localeCompare(b)));
  return curs.map((c) => {
    const m = totals[c as keyof MoneyTotals]!;
    return <KpiTile key={c} label={label(c)} value={Number(m.amount)} unit={c} format={fmtCompact} {...(extra ? extra(c) : {})} />;
  });
}

/** Série quotidienne (jours de Kinshasa) sur les N derniers jours, pour une courbe ou une courbe miniature. */
export function serieQuotidienne<T>(items: readonly T[], dateOf: (i: T) => string | null | undefined, jours = 30, now = new Date()): { date: string; count: number }[] {
  const to = kinshasaDay(now)!;
  const from = kinshasaDay(new Date(now.getTime() - (jours - 1) * 86400000))!;
  return groupByDay(items, dateOf, { from, to }).groups.map((g) => ({ date: g.period, count: g.items.length }));
}

// ————————————————————————— Accueil (catalogue d'événements) —————————————————————————

/** Accueil : le catalogue d'événements réel (paquet partagé), par catégorie, obligatoires et facultatifs. */
export function CatalogueEvenementsVisuel({ events, categories }: { events: readonly { categorie: string; obligatoire: boolean }[]; categories: readonly { code: string; libelle: string }[] }) {
  const label = (c: string) => categories.find((x) => x.code === c)?.libelle ?? c;
  const par = countBy(events, 'categorie');
  const rows = par.map((r) => {
    const oblig = events.filter((e) => e.categorie === r.key && e.obligatoire).length;
    return { key: r.key, label: label(r.key), values: { oblig, fac: r.count - oblig } };
  });
  return (
    <StackedBarViz title="Catalogue d’événements par catégorie" subtitle="nombre d’événements, obligatoires et facultatifs (catalogue en vigueur)" mode="absolute"
      series={[{ key: 'oblig', label: 'Obligatoires' }, { key: 'fac', label: 'Facultatifs' }]} rows={rows} format={(v) => fmtNombre(v, 0)}
      note="Source : catalogue d’événements du paquet partagé (annexe G). Un événement obligatoire est toujours notifié." />
  );
}

// ————————————————————————— Espace contribuable —————————————————————————

interface EspaceData {
  obligations: readonly { id: string; status: string; amount: MoneyJSON; dueDate?: string; label?: string; ruleCode?: string }[];
  objects?: readonly { id: string; commune?: string; probativeStatus?: string; category?: string }[];
  receipts?: readonly { id: string; status: string; issuedAt?: string; amount?: MoneyJSON }[];
}

const OUVERTE = (s: string) => s !== 'SOLDEE' && s !== 'ANNULEE' && s !== 'ADMISE_EN_NON_VALEUR';

/** Espace contribuable : tuiles (reste dû par devise, quittances, biens), états des obligations, biens, échéances. */
export function EspaceVisuel({ p, obligationEtats, probatoire, recuEtats, example }: {
  p: EspaceData; obligationEtats: Record<string, EtatDef>; probatoire: (s: string) => string; recuEtats: Record<string, EtatDef>; example?: boolean;
}) {
  const ouvertes = p.obligations.filter((o) => OUVERTE(o.status));
  const du = sumMoney(ouvertes.map((o) => o.amount)).totals;
  const objets = p.objects ?? [];
  const recus = p.receipts ?? [];
  const provisoires = recus.filter((r) => r.status === 'PROVISOIRE').length;
  return (
    <section className="section viz-section" aria-labelledby="esp-viz">
      <h2 id="esp-viz" className="sr-only">Ma situation en un coup d’œil</h2>
      <KpiGrid max={4} label="Ma situation en un coup d’œil">
        <KpiTile hero label="Obligations à régler" value={ouvertes.length} format={(v) => fmtNombre(v, 0)} sub={`sur ${p.obligations.length} obligation(s) au total`} example={example} />
        {tuilesDevises(du, (c) => `Reste dû (${c})`, () => ({ state: { label: 'Constaté', tone: 'neutral' }, example }))}
        {Object.keys(du).length === 0 && <KpiTile label="Reste dû" value={0} format={(v) => fmtNombre(v, 0)} state={{ label: 'Rien à payer', tone: 'good' }} />}
        <KpiTile label="Quittances" value={recus.length} format={(v) => fmtNombre(v, 0)} state={provisoires ? { label: `${provisoires} provisoire(s)`, tone: 'warning' } : undefined} sub="provisoires jusqu’au rapprochement" />
        <KpiTile label="Biens et objets" value={objets.length} format={(v) => fmtNombre(v, 0)} sub={`${objets.filter((o) => o.probativeStatus === 'VERIFIE').length} vérifié(s)`} />
      </KpiGrid>
      <ChartGrid min={300}>
        <StatusDistribution title="Mes obligations par état" unitLabel="obligations" items={etatsDepuis(obligationEtats, countBy(p.obligations, 'status'), { masquerZeros: true })} example={example} />
        <DonutViz title="Mes biens par statut probant" centerLabel="biens" format={(v) => fmtNombre(v, 0)} example={example}
          slices={countBy(objets, (o) => o.probativeStatus ?? '').map((r) => ({ key: r.key, label: probatoire(r.key), value: r.count }))}
          note="Vérifié : preuve contrôlée ; déclaré ou observé : en attente de vérification." />
        <BarChartViz title="Mes biens par commune" orientation="horizontal" format={(v) => fmtNombre(v, 0)} example={example}
          series={[{ key: 'n', label: 'Biens' }]} rows={countBy(objets, (o) => o.commune ?? '').map((r) => ({ label: r.key, values: { n: r.count } }))} />
        <StatusDistribution title="Mes quittances par état" unitLabel="quittances" items={etatsDepuis(recuEtats, countBy(recus, 'status'), { masquerZeros: true })} example={example} />
        <TimelineStrip className="viz-span-all" title="Échéances de mes obligations ouvertes" example={example}
          categories={Object.values(obligationEtats).map((d) => d.label)}
          events={ouvertes.filter((o) => o.dueDate).map((o) => ({ id: o.id, at: o.dueDate!, category: obligationEtats[o.status]?.label ?? o.status, label: o.label ?? o.ruleCode ?? o.id }))}
          emptyText="Aucune échéance ouverte" />
      </ChartGrid>
    </section>
  );
}

// ————————————————————————— Trésor —————————————————————————

interface Balance {
  balanced: boolean; entries?: number;
  byCurrency?: { currency: string; debit: MoneyJSON; credit: MoneyJSON; balanced: boolean }[];
  accounts?: { account: string; label?: string; currency: string; balance: MoneyJSON }[];
}

/** Trésor : équilibre du grand livre et soldes des comptes, un graphique par devise (jamais mélangées). */
export function TresorVisuel({ bal, compteLabel }: { bal: Balance; compteLabel: (a: { account: string; label?: string }) => string }) {
  const devises = (bal.byCurrency ?? []).map((c) => c.currency).sort((a, b) => (a === 'CDF' ? -1 : b === 'CDF' ? 1 : a.localeCompare(b)));
  return (
    <div className="viz-section">
      <KpiGrid max={4} label="Grand livre en un coup d’œil">
        <KpiTile hero label="Écritures du grand livre" value={bal.entries ?? null} format={(v) => fmtNombre(v, 0)} reason="nombre d’écritures non servi"
          state={{ label: bal.balanced ? 'Équilibré (débit = crédit)' : 'Déséquilibré', tone: bal.balanced ? 'good' : 'critical' }} />
        {(bal.byCurrency ?? []).map((c) => (
          <KpiTile key={c.currency} label={`Mouvements ${c.currency} (débit = crédit)`} value={Number(c.debit.amount)} unit={c.currency} format={fmtCompact}
            state={{ label: c.balanced ? 'Équilibré' : 'Écart', tone: c.balanced ? 'good' : 'critical' }} />
        ))}
      </KpiGrid>
      <ChartGrid min={320}>
        {devises.map((cur) => {
          const rows = (bal.accounts ?? []).filter((a) => a.currency === cur).map((a) => {
            const v = Number(a.balance.amount);
            return { key: a.account, label: `${compteLabel(a)} (${v < 0 ? 'créditeur' : v === 0 ? 'soldé' : 'débiteur'})`, values: { s: Math.abs(v) } };
          });
          return <BarChartViz key={cur} title={`Soldes des comptes — ${cur}`} subtitle="valeur absolue ; la nature (débiteur / créditeur) est dans le libellé" orientation="horizontal"
            series={[{ key: 's', label: `Solde (${cur})` }]} rows={rows} format={fmtDevise(cur)} />;
        })}
      </ChartGrid>
    </div>
  );
}

// ————————————————————————— Audit —————————————————————————

const ISSUE: Record<string, EtatDef> = { SUCCESS: { label: 'Réussie', tone: 'good' }, DENIED: { label: 'Refusée (contrôle d’accès)', tone: 'warning' }, FAILURE: { label: 'Échec', tone: 'critical' } };

/** Journal d'audit : volume par jour, domaines les plus actifs, issues — sur les événements chargés. */
export function AuditVisuel({ events, total, chaine, recours }: {
  events: readonly { at?: string; timestamp?: string; action?: string; type?: string; outcome?: string }[];
  total?: number | null;
  chaine: { ok: boolean; length?: number } | null;
  recours: { open: number; overdue: number; approaching: number } | null;
}) {
  const domaine = (e: { action?: string; type?: string }) => (e.action ?? e.type ?? '').split('.')[0] || 'Non renseigné';
  const dom = topN(countBy(events, domaine), 7, (r) => r.count);
  const jours = serieQuotidienne(events, (e) => e.at ?? e.timestamp, 14);
  return (
    <div className="viz-section">
      <KpiGrid max={4} label="Piste d’audit en un coup d’œil">
        <KpiTile hero label="Chaîne de hachage" value={chaine?.length ?? null} format={(v) => fmtNombre(v, 0)} unit="maillons" reason="vérification en cours ou indisponible"
          state={chaine ? { label: chaine.ok ? 'Intacte' : 'Altérée', tone: chaine.ok ? 'good' : 'critical' } : undefined} />
        <KpiTile label="Événements journalisés" value={total ?? events.length} format={(v) => fmtNombre(v, 0)} sub={`${fmtNombre(events.length, 0)} chargés à l’écran`}
          spark={{ values: jours.map((j) => j.count), labels: jours.map((j) => j.date), label: 'Événements par jour, 14 derniers jours' }} />
        <KpiTile label="Recours ouverts" value={recours ? recours.open : null} format={(v) => fmtNombre(v, 0)} reason="indicateurs des recours non servis"
          state={recours ? { label: `${recours.overdue} hors délai`, tone: recours.overdue ? 'critical' : 'good' } : undefined} />
        <KpiTile label="Recours proches de l’échéance" value={recours ? recours.approaching : null} format={(v) => fmtNombre(v, 0)} reason="indicateurs des recours non servis" />
      </KpiGrid>
      <ChartGrid min={300}>
        <LineAreaViz title="Événements par jour" subtitle="14 derniers jours (jours de Kinshasa), événements chargés" area granularity="day"
          series={[{ key: 'n', label: 'Événements' }]} points={jours.map((j) => ({ date: j.date, values: { n: j.count } }))} format={(v) => fmtNombre(v, 0)} />
        <BarChartViz title="Domaines les plus actifs" subtitle="préfixe de l’action journalisée" orientation="horizontal" format={(v) => fmtNombre(v, 0)}
          series={[{ key: 'n', label: 'Événements' }]} rows={dom.rows.map((r) => ({ label: 'other' in r ? 'Autres' : r.key, values: { n: 'other' in r ? r.value : r.count } }))}
          note={dom.folded.length ? `« Autres » regroupe : ${dom.folded.join(', ')}.` : undefined} />
        <StatusDistribution title="Issue des opérations" unitLabel="événements" items={etatsDepuis(ISSUE, countBy(events, (e) => e.outcome ?? ''), { masquerZeros: true })}
          note="« Refusée » : tentative bloquée par le contrôle d’accès, tracée comme les réussites." />
      </ChartGrid>
    </div>
  );
}

// ————————————————————————— Terrain (agent) —————————————————————————

/** Écran de l'agent de terrain : avancement de ses missions et état de sa file de constats. */
export function TerrainAgentVisuel({ missions, file, fileEtats, example }: {
  missions: readonly { id: string; title: string; status: string; objectives: { findings: number }; progress: { findings: number; validated: number; objectivePct: string | null } }[];
  file: readonly { state: string }[]; fileEtats: Record<string, EtatDef>; example?: boolean;
}) {
  const ouvertes = missions.filter((m) => m.status === 'AFFECTEE' || m.status === 'EN_COURS');
  const constats = missions.reduce((s, m) => s + m.progress.findings, 0);
  const objectif = missions.reduce((s, m) => s + m.objectives.findings, 0);
  const valides = missions.reduce((s, m) => s + m.progress.validated, 0);
  return (
    <section className="section viz-section" aria-label="Mon activité en un coup d’œil">
      <KpiGrid max={4} label="Mon activité en un coup d’œil">
        <KpiTile hero label="Missions ouvertes" value={ouvertes.length} format={(v) => fmtNombre(v, 0)} sub={`sur ${missions.length} mission(s)`} example={example} />
        <KpiTile label="Constats transmis" value={constats} format={(v) => fmtNombre(v, 0)} target={objectif ? { value: objectif, label: `objectif des missions : ${objectif}` } : undefined} />
        <KpiTile label="Constats validés" value={valides} format={(v) => fmtNombre(v, 0)} sub="par revue indépendante" />
        <KpiTile label="En attente d’envoi" value={file.filter((q) => q.state === 'pending').length} format={(v) => fmtNombre(v, 0)} sub="file hors ligne de ce terminal" />
      </KpiGrid>
      <ChartGrid min={300}>
        <BarChartViz title="Avancement de mes missions" subtitle="constats transmis, validés et objectif de la mission" orientation="horizontal" format={(v) => fmtNombre(v, 0)} example={example}
          series={[{ key: 'f', label: 'Transmis' }, { key: 'v', label: 'Validés' }, { key: 'o', label: 'Objectif' }]}
          rows={missions.map((m) => ({ key: m.id, label: m.title, values: { f: m.progress.findings, v: m.progress.validated, o: m.objectives.findings } }))}
          emptyText="Aucune mission affectée" />
        <StatusDistribution title="Ma file de constats" unitLabel="constats" items={etatsDepuis(fileEtats, countBy(file, 'state'))} emptyText="File vide : aucun constat en attente" />
      </ChartGrid>
    </section>
  );
}

// ————————————————————————— Communications —————————————————————————

/** Communications : taux de remise, états des derniers envois, catalogue par gravité. */
export function CommunicationsVisuel({ delivered, attempted, recents, recentEtat, gravites, example }: {
  delivered: number; attempted: number; recents: readonly { status: string }[]; recentEtat: (s: string) => EtatDef;
  gravites: readonly { key: string; label: string; count: number }[]; example?: boolean;
}) {
  const etats = new Map<string, StatusItem>();
  for (const r of recents) {
    const d = recentEtat(r.status);
    const cur = etats.get(d.label) ?? { key: d.label, label: d.label, tone: d.tone, count: 0 };
    cur.count += 1; etats.set(d.label, cur);
  }
  return (
    <ChartGrid min={280}>
      <div className="panel viz-meter-card">
        <ProgressMeter label="Messages remis sur messages traités" value={attempted ? Math.round((delivered / attempted) * 1000) / 10 : null} unit="%"
          reason="aucun message traité pour l’instant" toneLabel={attempted ? `${fmtNombre(delivered, 0)} remis sur ${fmtNombre(attempted, 0)}` : undefined} tone={attempted ? 'info' : undefined} />
        <p className="small muted">Suivi (sans cible) : aucune cible de remise n’est fixée par un acte.</p>
      </div>
      <StatusDistribution title="Derniers envois par état" unitLabel="envois" items={[...etats.values()]} example={example} emptyText="Aucun envoi récent" />
      <DonutViz title="Catalogue par gravité" centerLabel="événements" format={(v) => fmtNombre(v, 0)} slices={gravites.map((g) => ({ key: g.key, label: g.label, value: g.count }))} />
    </ChartGrid>
  );
}

// ————————————————————————— Registre des règles —————————————————————————

/** Registre des règles : états du cycle de vie, visas obtenus (sur 4), devise de liquidation. */
export function RegistreVisuel({ rules, etat, example }: {
  rules: readonly { status: string; approvals: readonly unknown[]; currency: string; suspension?: unknown }[]; etat: (s: string) => EtatDef; example?: boolean;
}) {
  const parEtat = new Map<string, StatusItem>();
  for (const r of rules) {
    const d = etat(r.status);
    const cur = parEtat.get(r.status) ?? { key: r.status, label: d.label, tone: d.tone, count: 0 };
    cur.count += 1; parEtat.set(r.status, cur);
  }
  const visas = [0, 1, 2, 3, 4].map((n) => ({ label: `${n} visa${n > 1 ? 's' : ''} sur 4`, values: { n: rules.filter((r) => Math.min(4, r.approvals.length) === n).length } }));
  const actives = rules.filter((r) => r.status === 'ACTIVE').length;
  return (
    <div className="viz-section">
      <KpiGrid max={4} label="Registre en un coup d’œil">
        <KpiTile hero label="Fiches de règle" value={rules.length} format={(v) => fmtNombre(v, 0)} example={example} />
        <KpiTile label="Règles actives" value={actives} format={(v) => fmtNombre(v, 0)} state={{ label: 'Opposables', tone: 'good' }} />
        <KpiTile label="En circuit de visas" value={rules.filter((r) => ['BROUILLON', 'REVUE_JURIDIQUE', 'REVUE_FINANCIERE', 'APPROUVEE'].includes(r.status)).length} format={(v) => fmtNombre(v, 0)} sub="quatre visas requis" />
        <KpiTile label="Suspendues ou à vérifier" value={rules.filter((r) => r.status === 'SUSPENDUE' || r.status === 'A_VERIFIER').length} format={(v) => fmtNombre(v, 0)} state={{ label: 'À surveiller', tone: 'warning' }} />
      </KpiGrid>
      <ChartGrid min={300}>
        <StatusDistribution title="Règles par état" unitLabel="règles" items={[...parEtat.values()]} example={example} />
        <BarChartViz title="Avancement des visas" subtitle="rédaction, juridique, financier, publication" orientation="horizontal" format={(v) => fmtNombre(v, 0)} example={example}
          series={[{ key: 'n', label: 'Règles' }]} rows={visas} />
        <DonutViz title="Devise de liquidation" centerLabel="règles" format={(v) => fmtNombre(v, 0)} example={example}
          slices={countBy(rules, 'currency').map((r) => ({ key: r.key, label: r.key, value: r.count }))} />
      </ChartGrid>
    </div>
  );
}

// ————————————————————————— Portail des services —————————————————————————

/** Portail des services : statut juridique des verticales ; pour le contribuable, sa situation par service. */
export function ServicesVisuel({ items, legalTone, mine }: {
  items: readonly { slug: string; name: string; legal: string; legalLabel: string }[];
  legalTone: Record<string, Tone>;
  mine?: readonly { slug: string; objects: number; toPay: number; openCases: number }[];
}) {
  const parStatut = new Map<string, StatusItem>();
  for (const v of items) {
    const cur = parStatut.get(v.legal) ?? { key: v.legal, label: v.legalLabel, tone: legalTone[v.legal] ?? 'neutral', count: 0 };
    cur.count += 1; parStatut.set(v.legal, cur);
  }
  const nom = new Map(items.map((v) => [v.slug, v.name]));
  const rows = (mine ?? []).filter((m) => m.objects + m.toPay + m.openCases > 0).map((m) => ({ key: m.slug, label: nom.get(m.slug) ?? m.slug, values: { o: m.objects, p: m.toPay, c: m.openCases } }));
  return (
    <ChartGrid min={300}>
      <StatusDistribution title="Services par statut juridique" unitLabel="services" items={[...parStatut.values()]}
        note="Aucun service n’est « confirmé » tant que ses textes et barèmes ne sont pas certifiés." />
      {mine && (
        <BarChartViz title="Ma situation par service" orientation="horizontal" format={(v) => fmtNombre(v, 0)} emptyText="Aucun objet ni démarche dans les services"
          series={[{ key: 'o', label: 'Objets' }, { key: 'p', label: 'À payer' }, { key: 'c', label: 'Démarches en cours' }]} rows={rows} />
      )}
    </ChartGrid>
  );
}

// ————————————————————————— Espace d'une verticale —————————————————————————

/** Espace d'une verticale : tuiles et répartition des obligations et démarches (compte unique). */
export function VerticaleVisuel({ s, obligationEtats, caseTone }: {
  s: { objects: readonly unknown[]; obligations: readonly { status: string; amount: MoneyJSON }[]; receipts: readonly { status: string }[]; cases: readonly { status: string; statusLabel: string }[] };
  obligationEtats: Record<string, EtatDef>;
  /** Ton de chaque état de démarche (catalogue des verticales) ; à défaut, déduit du code. */
  caseTone?: Record<string, Tone>;
}) {
  const ouvertes = s.obligations.filter((o) => OUVERTE(o.status));
  const du = sumMoney(ouvertes.map((o) => o.amount)).totals;
  const demarches = new Map<string, StatusItem>();
  for (const c of s.cases) {
    const cur = demarches.get(c.status) ?? { key: c.status, label: c.statusLabel, tone: caseTone?.[c.status] ?? (/REJET|REFUS/.test(c.status) ? 'critical' : /ACCORD|DELIVR|CLOS|VALID/.test(c.status) ? 'good' : 'info'), count: 0 };
    cur.count += 1; demarches.set(c.status, cur);
  }
  return (
    <section className="viz-section" aria-label="Ma situation dans ce service">
      <KpiGrid max={4} label="Ma situation dans ce service">
        <KpiTile hero label="Éléments enregistrés" value={s.objects.length} format={(v) => fmtNombre(v, 0)} example />
        <KpiTile label="Obligations ouvertes" value={ouvertes.length} format={(v) => fmtNombre(v, 0)} sub={`sur ${s.obligations.length}`} />
        {tuilesDevises(du, (c) => `Reste dû (${c})`, () => ({ example: true }))}
        <KpiTile label="Démarches" value={s.cases.length} format={(v) => fmtNombre(v, 0)} sub={`${s.receipts.length} quittance(s)`} />
      </KpiGrid>
      {(s.obligations.length > 0 || s.cases.length > 0) && (
        <ChartGrid min={280}>
          <StatusDistribution title="Obligations par état" unitLabel="obligations" example items={etatsDepuis(obligationEtats, countBy(s.obligations, 'status'), { masquerZeros: true })} emptyText="Aucune obligation" />
          <StatusDistribution title="Démarches par état" unitLabel="démarches" items={[...demarches.values()]} emptyText="Aucune démarche déposée" />
        </ChartGrid>
      )}
    </section>
  );
}

// ————————————————————————— Inscription (registre des pièces) —————————————————————————

/** Inscription, vue du guichet : pièces d'identité en attente de revue (registre servi par l'accès). */
export function PiecesEnAttenteVisuel({ items, typeLabel, niveauLabel }: {
  items: readonly { type: string; status: string; taxpayer?: { verificationLevel?: string; kind?: string } }[]; typeLabel: (t: string) => string; niveauLabel: (n: string) => string;
}) {
  return (
    <ChartGrid min={280}>
      <DonutViz title="Pièces en attente de revue, par type" centerLabel="pièces" format={(v) => fmtNombre(v, 0)} example
        slices={countBy(items, 'type').map((r) => ({ key: r.key, label: typeLabel(r.key), value: r.count }))} emptyText="Aucune pièce en attente" />
      <BarChartViz title="Niveau de vérification des comptes concernés" orientation="horizontal" format={(v) => fmtNombre(v, 0)} example
        series={[{ key: 'n', label: 'Comptes' }]} rows={countBy(items, (i) => i.taxpayer?.verificationLevel ?? '').map((r) => ({ label: niveauLabel(r.key), values: { n: r.count } }))} emptyText="Aucune pièce en attente" />
    </ChartGrid>
  );
}

// ————————————————————————— Couche d'intelligence —————————————————————————

const AUTONOMIE: Record<string, EtatDef> = {
  A_AUTO: { label: 'Niveau A — automatique (sans effet juridique ni financier)', tone: 'good' }, B_VALIDATION: { label: 'Niveau B — validation humaine', tone: 'warning' },
  C_RECOMMANDATION: { label: 'Niveau C — recommandation, jamais exécutée', tone: 'info' },
};

/** Couche d'intelligence : recommandations par agent et par niveau d'autonomie (boîte de réception réelle). */
export function IaVisuel({ recs }: { recs: readonly { agent?: string; autonomy?: string; status?: string; confidence?: string }[] }) {
  const agents = topN(countBy(recs, (r) => r.agent ?? ''), 5, (r) => r.count);
  return (
    <ChartGrid min={300}>
      <BarChartViz title="Recommandations par agent" orientation="horizontal" format={(v) => fmtNombre(v, 0)} emptyText="Aucune recommandation"
        series={[{ key: 'n', label: 'Recommandations' }]} rows={agents.rows.map((r) => ({ label: 'other' in r ? 'Autres' : r.key, values: { n: 'other' in r ? r.value : r.count } }))} />
      <StatusDistribution title="Par niveau d’autonomie" unitLabel="recommandations" items={etatsDepuis(AUTONOMIE, countBy(recs, (r) => r.autonomy ?? ''), { masquerZeros: true })}
        note="L’IA propose ; une personne habilitée décide. Le niveau C n’est jamais exécuté." emptyText="Aucune recommandation" />
    </ChartGrid>
  );
}

// ————————————————————————— RakaPay (historique) —————————————————————————

const COMMANDE: Record<string, EtatDef> = {
  EMISE: { label: 'Titre(s) émis', tone: 'good' }, PARTIELLEMENT_EMISE: { label: 'Partiellement émise', tone: 'info' }, EN_ATTENTE_PAIEMENT: { label: 'En attente de paiement', tone: 'warning' },
  EXPIREE: { label: 'Expirée — rien n’est dû', tone: 'neutral' }, ANNULEE: { label: 'Annulée — rien n’est dû', tone: 'neutral' },
};

/** Historique RakaPay : commandes par état et par jour (30 derniers jours). */
export function RakaPayHistoriqueVisuel({ orders }: { orders: readonly { status: string; createdAt: string; context?: string }[] }) {
  const jours = serieQuotidienne(orders, (o) => o.createdAt, 30);
  return (
    <ChartGrid min={280}>
      <StatusDistribution title="Mes commandes par état" unitLabel="commandes" items={etatsDepuis(COMMANDE, countBy(orders, 'status'), { masquerZeros: true })} example emptyText="Aucune commande" />
      <LineAreaViz title="Mes commandes par jour" subtitle="30 derniers jours" area granularity="day" example series={[{ key: 'n', label: 'Commandes' }]}
        points={jours.map((j) => ({ date: j.date, values: { n: j.count } }))} format={(v) => fmtNombre(v, 0)} />
    </ChartGrid>
  );
}

const ETAT_TITRE: Record<string, EtatDef> = {
  EMIS: { label: 'Émis (valable selon sa période)', tone: 'good' }, SUSPENDU: { label: 'Suspendu', tone: 'warning' }, CONSOMME: { label: 'Consommé', tone: 'neutral' },
  REVOQUE: { label: 'Révoqué', tone: 'critical' }, ANNULE: { label: 'Annulé', tone: 'neutral' }, REMPLACE: { label: 'Remplacé', tone: 'info' },
};

/** Pass wewa : répartition par état et frise des débuts de validité (données de démonstration [EXEMPLE]). */
export function PassVisuel({ passes }: { passes: readonly { id: string; number: string; state: string; validFrom: string; validUntil: string; demo?: boolean }[] }) {
  const ex = passes.some((p) => p.demo);
  return (
    <ChartGrid min={280}>
      <StatusDistribution framed={false} title="Mes pass par état" unitLabel="pass" example={ex} items={etatsDepuis(ETAT_TITRE, countBy(passes, 'state'), { masquerZeros: true })} />
      <TimelineStrip framed={false} title="Début de validité de mes pass" example={ex}
        events={passes.map((p) => ({ id: p.id, at: p.validFrom, category: ETAT_TITRE[p.state]?.label ?? p.state, label: `${p.number} — jusqu’au ${p.validUntil.slice(0, 10)}` }))} />
    </ChartGrid>
  );
}
