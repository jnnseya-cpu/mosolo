/**
 * Postes de décision — visuels (trousse de visualisation, 27/09/2026), ajoutés SANS changer la structure des maquettes :
 *  - bloc 2 « La Ville aujourd'hui » : quatre tuiles d'indicateurs avec courbe miniature (12 derniers mois, données
 *    réelles de /v1/pilotage/drill/month) ; les fiches « chiffre jamais nu » restent consultables juste dessous ;
 *  - vignette des communes : carte de chaleur des 24 communes (non mesuré tant qu'aucune assignation n'est certifiée) ;
 *  - « Recettes » : échelle des six états (potentiel → disponible), non mesurés nommés et motivés.
 * Aucune saisie, aucun filtre : l'écran d'accueil reste consultable en 90 secondes.
 */
import { SIX_ETATS, type MoneyJSON } from '@mosolo/shared';
import { BarChartViz, HeatGrid, KpiGrid, KpiTile, LadderFunnel, StatusDistribution, TimelineStrip, fmtCompact, fmtNombre, type LadderStep } from '../../components/viz';
import type { Tone } from '../../components/StatusBadge';
import { kinshasaMonth, periodLabel, periodRange } from '../../lib/aggregate';
import { ChiffreView, usePosteApi, type Chiffre } from './common';

/** Rangée de /v1/pilotage/drill/month (niveaux de l'échelle par mois de Kinshasa). */
interface DrillMonth { rows: { key: string; values: Record<string, { consolidatedCdf: MoneyJSON | null }> }[] }

/** Niveau de l'échelle suivi par chaque chiffre du bloc 2. */
const NIVEAU: Record<string, string> = { CONSTATE: 'assessed', ENCAISSE: 'confirmed', REGLE: 'settled', RAPPROCHE: 'reconciled' };
const TON: Record<string, Tone> = { RAPPROCHE: 'good', REGLE: 'good', ENCAISSE: 'info', CONSTATE: 'neutral', POTENTIEL_ESTIME: 'warning' };

/** Les 12 derniers mois de Kinshasa, du plus ancien au courant. */
export function douzeMois(now = new Date()): string[] {
  const cur = kinshasaMonth(now)!;
  const [y, m] = cur.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 12, 1));
  return periodRange(d.toISOString().slice(0, 7), cur, 'month');
}

/** Série mensuelle d'un niveau (0 pour un mois sans fait : le serveur ne liste que les mois actifs). */
export function serieNiveau(drill: DrillMonth | null, niveau: string, mois: string[]): number[] {
  const byKey = new Map((drill?.rows ?? []).map((r) => [r.key, r]));
  return mois.map((k) => { const c = byKey.get(k)?.values[niveau]?.consolidatedCdf; return c ? Number(c.amount) : 0; });
}

const num = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? null : Number(String(v).replace(',', '.').replace('−', '-')));

/** Bloc 2 : tuiles avec courbes miniatures, puis les fiches chiffrées complètes (état, comparaison, date, taux, source). */
export function VilleAujourdhui({ chiffres }: { chiffres: Chiffre[] }) {
  const drill = usePosteApi<DrillMonth>('/v1/pilotage/drill/month', 'drill.month');
  const mois = douzeMois();
  const labels = mois.map((m) => periodLabel(m, 'month'));
  return (
    <>
      <KpiGrid max={4} label="La Ville aujourd’hui — quatre chiffres clés">
        {chiffres.slice(0, 4).map((c) => {
          const v = num(c.valeur);
          const niveau = NIVEAU[c.code];
          const money = c.unite === 'CDF' || c.unite === 'USD';
          const fmt = money ? fmtCompact : (x: number) => fmtNombre(x);
          return (
            <KpiTile key={c.code} label={c.libelle} value={v} unit={c.unite} format={fmt} href={c.source.chemin[Math.min(1, c.source.chemin.length - 1)]}
              state={{ label: c.etatLabel, tone: TON[c.etat] ?? 'neutral' }} example={c.exemple} reason={c.comparaison.libelle}
              delta={c.comparaison.type === 'PERIODE_PRECEDENTE' ? { current: v, previous: num(c.comparaison.valeur), versus: 'vs N−1', format: fmt } : undefined}
              spark={niveau && !drill.error && drill.data ? { values: serieNiveau(drill.data, niveau, mois), labels, label: `${c.libelle} — 12 derniers mois (contre-valeur CDF)`, format: fmtCompact } : undefined}
              sub={niveau && drill.error ? 'Courbe mensuelle indisponible' : undefined} />
          );
        })}
      </KpiGrid>
      <details className="ps-details">
        <summary>État, comparaison, date, taux et source de chaque chiffre</summary>
        <div className="ps-grille">{chiffres.map((c) => <ChiffreView key={c.code} c={c} grand />)}</div>
      </details>
    </>
  );
}

/** Six états (chiffres du poste) → marches de l'échelle. */
export function marchesSixEtats(six: Chiffre[]): LadderStep[] {
  return six.map((c) => {
    const v = num(c.valeur);
    return {
      code: c.code, label: SIX_ETATS.find((e) => e.code === c.code)?.libelle ?? c.etatLabel,
      value: v, display: v === null ? undefined : `${fmtCompact(v)} ${c.unite}${c.equivalents?.USD ? ` (≈ ${fmtCompact(Number(c.equivalents.USD))} USD)` : ''}`,
      reason: v === null ? (c.hypotheses?.join(' ; ') || `valeur non servie par la source (${c.source.libelle})`) : c.libelle,
    };
  });
}

/** Échelle des six états, depuis la vue « Recettes » (mêmes chiffres, même cache hors connexion). */
export function SixEtatsRecettes({ six, framed = false }: { six?: Chiffre[]; framed?: boolean }) {
  const vue = usePosteApi<{ sixEtats: Chiffre[] }>(six ? null : '/v1/postes/vues/recettes', 'vue.recettes');
  const data = six ?? vue.data?.sixEtats;
  return (
    <LadderFunnel framed={framed} title="Recettes · les six états" subtitle="emboîtés, jamais additionnés — contre-valeur indicative CDF"
      steps={data ? marchesSixEtats(data) : []} loading={!six && vue.loading && !vue.data} error={!six && !vue.data ? vue.error ?? undefined : undefined} onRetry={vue.reload}
      example={data?.some((c) => c.exemple)} note="Chaque état compte ce qui a atteint au moins ce stade ; « du précédent » = part de l’état mesuré précédent." />
  );
}

/** Vignette des communes : carte de chaleur compacte (couleur = taux d'atteinte ; gris hachuré = non mesuré). */
export function VignetteCommunes({ com }: { com: { mesure: boolean; note: string; communes: { commune: string; couleur: string; tauxPct: string | null; lien: string }[] } }) {
  const cells = com.communes.map((c) => ({ commune: c.commune, value: num(c.tauxPct), href: c.lien, detail: `Classement : ${c.couleur.toLowerCase()}` }));
  const max = Math.max(100, ...cells.map((c) => c.value ?? 0));
  return (
    <HeatGrid framed={false} compact href="/poste-de-decision/communes" title="Carte des communes, couleur selon l’écart à l’objectif" measureLabel="Taux d’atteinte de l’objectif"
      cells={cells} unit="%" domain={[0, max]} format={(v) => fmtNombre(v, 0)} unmeasuredReason={com.note} />
  );
}

// ————————————————————————— visuels des autres postes (ajout du 27/09/2026) —————————————————————————

/** Tuiles d'un groupe de chiffres du poste (état, comparaison, source) ; les fiches complètes restent affichées. */
export function TuilesChiffres({ chiffres, label, max = 3 }: { chiffres: Chiffre[]; label: string; max?: 2 | 3 | 4 }) {
  if (!chiffres.length) return null;
  return (
    <KpiGrid max={max} label={label}>
      {chiffres.map((c) => {
        const v = num(c.valeur);
        const money = c.unite === 'CDF' || c.unite === 'USD';
        const fmt = money ? fmtCompact : (x: number) => fmtNombre(x);
        return (
          <KpiTile key={c.code} label={c.libelle} value={v} unit={c.unite} format={fmt} example={c.exemple} href={c.source.chemin[Math.min(1, c.source.chemin.length - 1)]}
            state={{ label: c.etatLabel, tone: TON[c.etat] ?? 'neutral' }} reason={c.hypotheses?.join(' ; ') || c.comparaison.libelle}
            delta={c.comparaison.type === 'PERIODE_PRECEDENTE' ? { current: v, previous: num(c.comparaison.valeur), versus: 'vs N−1', format: fmt } : undefined} />
        );
      })}
    </KpiGrid>
  );
}

/** Ligne d'exécution (actes décidés) — forme minimale lue par les visuels. */
export interface ExecLike { id: string; acteLibelle: string; etat: string; enRetard: boolean; echeance: string; exemple?: boolean }

/** Exécution des décisions : exécuté, en retard, dans les délais ; échéances dans le temps. */
export function EtatExecution({ rows }: { rows: ExecLike[] }) {
  if (!rows.length) return null;
  const etat = (r: ExecLike) => (r.etat === 'EXECUTE' ? 'Exécuté' : r.enRetard ? 'En retard' : 'Dans les délais');
  return (
    <>
      <StatusDistribution framed={false} title="Actes par état d’exécution" unitLabel="actes" example={rows.some((r) => r.exemple)}
        items={[
          { key: 'x', label: 'Exécuté', tone: 'good', count: rows.filter((r) => etat(r) === 'Exécuté').length },
          { key: 'd', label: 'Dans les délais', tone: 'info', count: rows.filter((r) => etat(r) === 'Dans les délais').length },
          { key: 'r', label: 'En retard', tone: 'critical', count: rows.filter((r) => etat(r) === 'En retard').length },
        ]} />
      <TimelineStrip framed={false} title="Échéances des actes" categories={['En retard', 'Dans les délais', 'Exécuté']}
        events={rows.map((r) => ({ id: r.id, at: r.echeance, category: etat(r), label: r.acteLibelle }))} />
    </>
  );
}

/** « À traiter » du cabinet : dossiers par état d'instruction. */
export function EtatInstruction({ items }: { items: { etat: string; etatLabel: string }[] }) {
  if (!items.length) return null;
  const tones: Record<string, Tone> = { INSTRUIT: 'good', INCOMPLET: 'critical' };
  const codes = [...new Set(items.map((i) => i.etat))];
  return (
    <StatusDistribution framed={false} title="Dossiers par état d’instruction" unitLabel="dossiers"
      items={codes.map((k) => ({ key: k, label: items.find((i) => i.etat === k)!.etatLabel, tone: tones[k] ?? 'warning', count: items.filter((i) => i.etat === k).length }))} />
  );
}

/** Classement des communes (vue « Communes ») en carte de chaleur des 24 communes. */
export function CarteClassement({ classement, note }: { classement: { commune: string; tauxPct: string | null; couleur: string }[]; note: string }) {
  const cells = classement.map((c) => ({ commune: c.commune, value: num(c.tauxPct), detail: `Classement : ${c.couleur.toLowerCase()}` }));
  const max = Math.max(100, ...cells.map((c) => c.value ?? 0));
  return (
    <HeatGrid framed={false} compact title="Communes, couleur selon l’écart à l’objectif" measureLabel="Taux d’atteinte de l’objectif" cells={cells} unit="%" domain={[0, max]} format={(v) => fmtNombre(v, 0)} unmeasuredReason={note} />
  );
}

/** Taille des corbeilles par autorité, avec le seuil servi par le serveur (statut affiché). */
export function CorbeillesVisuel({ autorites, seuil, statut }: { autorites: { userId: string; nom: string; taille: number }[]; seuil: number; statut: string }) {
  return (
    <BarChartViz framed={false} title="Taille des corbeilles" orientation="horizontal" format={(v) => fmtNombre(v, 0)} series={[{ key: 'n', label: 'Éléments en attente' }]}
      reference={{ value: seuil, label: `Seuil ${seuil}` }} subtitle={`Seuil : ${statut}`} rows={autorites.map((a) => ({ key: a.userId, label: a.nom, values: { n: a.taille } }))} />
  );
}

/** File de travail (poste de travail) : tuiles, éléments par module, échéances. */
export interface FileLike { id: string; module: string; objet: string; echeance: string | null; enRetard: boolean; depose: string }
export function VisuelsFile({ file, enAttente }: { file: FileLike[]; enAttente: number }) {
  const modules = [...new Set(file.map((w) => w.module))];
  return (
    <>
      <KpiGrid max={3} label="File de travail — synthèse">
        <KpiTile hero label="Éléments à traiter" value={enAttente} format={(v) => fmtNombre(v, 0)} state={{ label: 'Aujourd’hui', tone: 'info' }} />
        <KpiTile label="En retard" value={file.filter((w) => w.enRetard).length} format={(v) => fmtNombre(v, 0)} state={{ label: file.some((w) => w.enRetard) ? 'À traiter en priorité' : 'Aucun retard', tone: file.some((w) => w.enRetard) ? 'critical' : 'good' }} />
        <KpiTile label="Modules sources" value={modules.length} format={(v) => fmtNombre(v, 0)} state={{ label: 'Décision dans le module', tone: 'neutral' }} />
      </KpiGrid>
      <div className="viz-grid" style={{ ['--viz-min' as string]: '300px' }}>
        <BarChartViz title="Éléments par module source" orientation="horizontal" format={(v) => fmtNombre(v, 0)} emptyText="Rien à traiter aujourd’hui" series={[{ key: 'n', label: 'Éléments' }, { key: 'r', label: 'En retard' }]}
          rows={modules.map((m) => ({ key: m, label: m, values: { n: file.filter((w) => w.module === m).length, r: file.filter((w) => w.module === m && w.enRetard).length } }))} />
        <TimelineStrip className="viz-span-2" title="Échéances de la file" categories={['En retard', 'À échéance']} emptyText="Aucune échéance"
          events={file.filter((w) => w.echeance).map((w) => ({ id: w.id, at: w.echeance!, category: w.enRetard ? 'En retard' : 'À échéance', label: `${w.objet} (${w.module})` }))} />
      </div>
    </>
  );
}
