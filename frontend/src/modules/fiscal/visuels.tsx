/**
 * Module fiscal — visuels (trousse de visualisation, 27/09/2026). Chaque écran reçoit en tête un résumé visuel dérivé
 * des SEULES données qu'il charge déjà (aucune route élargie, aucun chiffre inventé) : tuiles, répartition par état,
 * anneaux, barres, carte de chaleur des 24 communes. Les listes, formulaires et boutons existants restent inchangés
 * sous ces visuels. Données de démonstration : mention [EXEMPLE] dès qu'un élément affiché en provient.
 * Charte : docs/document-maitre/charte-visualisation.md.
 */
import type { MapStatusColor } from '@mosolo/shared';
import {
  BarChartViz, ChartGrid, DonutViz, HeatGrid, KpiGrid, KpiTile, ProgressMeter, StackedBarViz, StatusDistribution,
  fmtNombre, type StatusItem,
} from '../../components/viz';
import type { Tone } from '../../components/StatusBadge';
import { countBy, sumBy, splitByCurrency } from '../../lib/aggregate';
import { COLOR_WORD, PROBATIVE, RELATION_STATUS } from './common';
import type { Clearance, Declaration, Exemption, FiscalObjectView, LeaseRow, MapResponse, QueueResponse } from './types';

/* ------------------------------------------------------------------ outils communs (réutilisés par le périmètre) */

/** Répartition par état : ordre de la table de libellés, puis états inconnus (libellé brut, ton neutre). */
export function repartition<T>(items: readonly T[], keyOf: (x: T) => string | null | undefined, map: Record<string, { label: string; tone: Tone }>): StatusItem[] {
  const counts = countBy(items, (x) => keyOf(x) ?? '');
  const known = Object.entries(map).map(([key, v]) => ({ key, label: v.label, tone: v.tone, count: counts.find((c) => c.key === key)?.count ?? 0 }));
  const unknown = counts.filter((c) => !(c.key in map)).map((c) => ({ key: c.key, label: c.key, tone: 'neutral' as Tone, count: c.count }));
  return [...known, ...unknown];
}

/** Lignes { label, values: { n } } d'un comptage (barres à une série). */
export const barresDe = (rows: readonly { key: string; count: number }[], labelOf: (k: string) => string = (k) => k) =>
  rows.map((r) => ({ key: r.key, label: labelOf(r.key), values: { n: r.count } }));

export const SERIE_N = (label: string) => [{ key: 'n', label }];
export const entier = (v: number) => fmtNombre(v, 0);

/** Couleur de situation (serveur) → ton d'état réservé (toujours doublé d'une icône et d'un libellé). */
export const MAP_TONE: Record<MapStatusColor, Tone> = { green: 'good', amber: 'warning', red: 'critical', grey: 'neutral', blue: 'info' };
const COLOR_ORDER: MapStatusColor[] = ['green', 'amber', 'red', 'blue', 'grey'];
export const COLOR_STATES: Record<string, { label: string; tone: Tone }> = Object.fromEntries(COLOR_ORDER.map((c) => [c, { label: COLOR_WORD[c], tone: MAP_TONE[c] }]));

/* ------------------------------------------------------------------ Biens et relations */

export function BiensVisuels({ objets, taxpayer }: { objets: FiscalObjectView[]; taxpayer: boolean }) {
  const exemple = objets.some((o) => o.example);
  const valides = objets.filter((o) => o.igf).length;
  const plaques = objets.filter((o) => o.plate).length;
  const relations = objets.flatMap((o) => o.relations);
  const relValidees = relations.filter((r) => r.status === 'VALIDEE').length;
  const parCommune = countBy(objets, 'commune');
  return (
    <div className="stack viz-block" aria-label="Résumé visuel des biens">
      <KpiGrid max={4} label="Biens — chiffres clés">
        <KpiTile hero label={taxpayer ? 'Mes biens' : 'Objets de mon périmètre'} value={objets.length} format={entier} example={exemple} state={{ label: 'Registre des objets', tone: 'info' }} />
        <KpiTile label="Validés (IGF attribué)" value={valides} format={entier} sub={`${objets.length - valides} provisoire(s)`} />
        <KpiTile label="QR par bien émis" value={plaques} format={entier} sub="plaque posée ou étiquette émise" />
        <KpiTile label="Relations validées" value={relValidees} format={entier} sub={`${relations.length} relation(s) au total`} />
      </KpiGrid>
      <ChartGrid min={300}>
        <StatusDistribution title="Situation fiscale des biens" subtitle="couleur calculée par le serveur" unitLabel="biens" example={exemple}
          items={repartition(objets, (o) => o.situation.color, COLOR_STATES)} emptyText="Aucun bien visible." />
        <DonutViz title="Biens par catégorie" centerLabel="biens" format={entier} example={exemple}
          slices={countBy(objets, 'categoryLabel').map((r) => ({ key: r.key, label: r.key, value: r.count }))} />
        <StatusDistribution title="Relations par statut" unitLabel="relations" example={exemple}
          items={repartition(relations, (r) => r.status, RELATION_STATUS)} emptyText="Aucune relation enregistrée." />
        {!taxpayer && parCommune.length > 0 && (
          <HeatGrid className="viz-span-all" title="Objets recensés par commune" measureLabel="Objets visibles" format={entier} example={exemple}
            cells={parCommune.map((r) => ({ commune: r.key, value: r.count }))} unmeasuredReason="aucun objet de votre périmètre dans cette commune" />
        )}
      </ChartGrid>
    </div>
  );
}

/** File de validation (agents) : trois volumes à traiter. */
export function FileValidationVisuel({ d }: { d: QueueResponse }) {
  return (
    <BarChartViz title="File de validation — volumes à traiter" orientation="horizontal" format={entier} series={SERIE_N('Dossiers')}
      rows={[
        { key: 'o', label: 'Objets à valider', values: { n: d.objectsToValidate.length } },
        { key: 'r', label: 'Rattachements proposés', values: { n: d.relations.length } },
        { key: 'c', label: 'Conflits de revendication', values: { n: d.disputes.length } },
      ]} note="Chaque dossier est décidé par une personne habilitée, avec motif." />
  );
}

/* ------------------------------------------------------------------ Déclarations */

export const DECLARATION_STATES: Record<string, { label: string; tone: Tone }> = {
  DEPOSEE: { label: 'Déposée', tone: 'info' }, LIQUIDEE: { label: 'Liquidée', tone: 'good' }, A_INSTRUIRE: { label: 'Correction en instruction', tone: 'warning' },
  CORRECTION_REJETEE: { label: 'Correction rejetée', tone: 'critical' }, REMPLACEE: { label: 'Remplacée', tone: 'neutral' },
};
const KIND_LABEL: Record<string, string> = { IF: 'Impôt foncier', IRL: 'Impôt sur les revenus locatifs' };
const MODE_LABEL: Record<string, string> = { OPPOSABLE: 'Obligation émise', SIMULATION_NON_OPPOSABLE: 'Simulation non opposable', DEJA_LIQUIDEE: 'Déjà liquidée', EN_INSTRUCTION: 'En instruction', AUCUNE: 'Aucune liquidation' };

export function DeclarationsVisuels({ decls, taxpayer }: { decls: Declaration[]; taxpayer: boolean }) {
  const parPeriode = countBy(decls, 'period').sort((a, b) => a.key.localeCompare(b.key));
  return (
    <div className="stack viz-block" aria-label="Résumé visuel des déclarations">
      <KpiGrid max={4} label="Déclarations — chiffres clés">
        <KpiTile hero label={taxpayer ? 'Mes déclarations' : 'Corrections à instruire'} value={decls.length} format={entier} state={{ label: 'Accusés de réception', tone: 'info' }} />
        <KpiTile label="Liquidées (règle ACTIVE)" value={decls.filter((d) => d.liquidation.mode === 'OPPOSABLE').length} format={entier} />
        <KpiTile label="Simulations non opposables" value={decls.filter((d) => d.liquidation.mode === 'SIMULATION_NON_OPPOSABLE').length} format={entier} sub="aucune obligation émise" />
        <KpiTile label="Vérification demandée" value={decls.filter((d) => d.verificationRequired).length} format={entier} sub="valeur déclarée inférieure au pré-rempli" />
      </KpiGrid>
      <ChartGrid min={300}>
        <StatusDistribution title="Déclarations par état" unitLabel="déclarations" items={repartition(decls, (d) => d.status, DECLARATION_STATES)} emptyText="Aucune déclaration." />
        <DonutViz title="Par impôt" centerLabel="déclarations" format={entier} slices={countBy(decls, 'kind').map((r) => ({ key: r.key, label: KIND_LABEL[r.key] ?? r.key, value: r.count }))} />
        <BarChartViz title="Suite donnée (liquidation)" orientation="horizontal" format={entier} series={SERIE_N('Déclarations')}
          rows={barresDe(countBy(decls, (d) => d.liquidation.mode), (k) => MODE_LABEL[k] ?? k)} />
        {parPeriode.length > 0 && <BarChartViz title="Déclarations par période" format={entier} series={SERIE_N('Déclarations')} rows={barresDe(parPeriode)} />}
      </ChartGrid>
    </div>
  );
}

/* ------------------------------------------------------------------ Exonérations */

export const EXEMPTION_STATES: Record<string, { label: string; tone: Tone }> = {
  DEMANDEE: { label: 'Demandée — à instruire', tone: 'neutral' }, INSTRUITE: { label: 'Instruite', tone: 'info' }, VISA_JURIDIQUE: { label: 'Visa juridique', tone: 'warning' },
  APPROUVEE: { label: 'Approuvée', tone: 'good' }, REFUSEE: { label: 'Refusée', tone: 'critical' }, REVOQUEE: { label: 'Révoquée', tone: 'serious' },
  EXPIREE: { label: 'Expirée', tone: 'neutral' },
};

export function ExonerationsVisuels({ items }: { items: Exemption[] }) {
  const exemple = items.some((x) => x.legalBasis?.demo);
  const montants = splitByCurrency(sumBy(items.filter((x) => x.amount), () => 'Montant', 'amount'));
  const devises = Object.keys(montants);
  return (
    <div className="stack viz-block" aria-label="Résumé visuel des exonérations">
      <KpiGrid max={4} label="Exonérations — chiffres clés">
        <KpiTile hero label="Demandes et décisions" value={items.length} format={entier} example={exemple} state={{ label: 'Deux validations distinctes', tone: 'info' }} />
        <KpiTile label="À traiter" value={items.filter((x) => ['DEMANDEE', 'INSTRUITE', 'VISA_JURIDIQUE'].includes(x.status)).length} format={entier} />
        <KpiTile label="En vigueur" value={items.filter((x) => x.effectiveStatus === 'APPROUVEE').length} format={entier} sub="statut effectif à la date du jour" />
        {devises.length === 0
          ? <KpiTile label="Montants remis" value={null} reason="Aucune remise chiffrée : les exonérations s’appliquent par taux sur l’obligation." />
          : devises.map((c) => <KpiTile key={c} label={`Montants remis (${c})`} value={montants[c as 'CDF']![0]!.value} unit={c} format={(v) => fmtNombre(v, 2)} />)}
      </KpiGrid>
      <ChartGrid min={300}>
        <StatusDistribution title="Demandes par état" unitLabel="demandes" example={exemple} items={repartition(items, (x) => x.status, EXEMPTION_STATES)} emptyText="Aucune demande." />
        <DonutViz title="Exonérations et remises" centerLabel="décisions" format={entier} example={exemple}
          slices={countBy(items, 'kind').map((r) => ({ key: r.key, label: r.key === 'REMISE' ? 'Remise' : 'Exonération', value: r.count }))} />
      </ChartGrid>
    </div>
  );
}

/* ------------------------------------------------------------------ Quitus */

const CLEARANCE_STATES: Record<string, { label: string; tone: Tone }> = { ACTIF: { label: 'Actif', tone: 'good' }, EXPIRE: { label: 'Expiré', tone: 'neutral' }, REVOQUE: { label: 'Révoqué', tone: 'critical' } };

export function QuitusVisuels({ list, blockers, eligible }: { list: Clearance[]; blockers: number | null; eligible: boolean | null }) {
  const actif = list.find((c) => c.status === 'ACTIF' && c.check !== 'EXPIRE');
  const jours = actif ? Math.max(0, Math.round((Date.parse(`${actif.validUntil}T23:59:59+01:00`) - Date.now()) / 86_400_000)) : null;
  const total = actif ? Math.max(1, Math.round((Date.parse(`${actif.validUntil}T00:00:00+01:00`) - Date.parse(`${actif.validFrom}T00:00:00+01:00`)) / 86_400_000)) : null;
  return (
    <div className="stack viz-block" aria-label="Résumé visuel du quitus">
      <KpiGrid max={4} label="Quitus — chiffres clés">
        <KpiTile hero label="Conditions de délivrance" value={eligible === null ? null : eligible ? 'Réunies' : 'Non réunies'} reason="Éligibilité en cours de lecture."
          state={eligible === null ? undefined : { label: eligible ? 'Quitus possible' : 'Régularisation requise', tone: eligible ? 'good' : 'critical' }} />
        <KpiTile label="Obligations bloquantes" value={blockers} format={entier} reason="Éligibilité non lue." />
        <KpiTile label="Quitus délivrés" value={list.length} format={entier} sub={`${list.filter((c) => c.status === 'ACTIF').length} actif(s)`} />
        <KpiTile label="Validité restante" value={jours} unit="jours" format={entier} reason="Aucun quitus actif." sub={actif ? `jusqu’au ${actif.validUntil}` : undefined} />
      </KpiGrid>
      <ChartGrid min={300}>
        {actif && jours !== null && total !== null && (
          <div className="panel"><ProgressMeter label="Validité du quitus actif (jours restants)" value={jours} max={total} unit="jours" format={entier} tone={jours > 30 ? 'good' : jours > 7 ? 'warning' : 'critical'}
            toneLabel={jours > 30 ? 'Valide' : jours > 7 ? 'Expire bientôt' : 'Expire très bientôt'} /></div>
        )}
        <StatusDistribution title="Mes quitus par état" unitLabel="quitus" items={repartition(list, (c) => (c.check === 'EXPIRE' ? 'EXPIRE' : c.status), CLEARANCE_STATES)} emptyText="Aucun quitus délivré." />
      </ChartGrid>
    </div>
  );
}

/** Revue des quitus actifs (agents) : nombre de quitus dont les conditions ne sont plus remplies, par motif. */
export function RevueQuitusVisuel({ rows, labels }: { rows: { blockers: { reason: string }[] }[]; labels: Record<string, string> }) {
  const motifs = countBy(rows.flatMap((r) => r.blockers), 'reason');
  return (
    <ChartGrid min={300}>
      <KpiTile label="Quitus actifs à revoir" value={rows.length} format={entier} sub="proposition — une personne décide" state={{ label: rows.length ? 'Revue humaine' : 'Conformes', tone: rows.length ? 'warning' : 'good' }} />
      <BarChartViz title="Motifs de revue" orientation="horizontal" format={entier} series={SERIE_N('Obligations')} rows={barresDe(motifs, (k) => labels[k] ?? k)} emptyText="Tous les quitus actifs remplissent encore leurs conditions." />
    </ChartGrid>
  );
}

/* ------------------------------------------------------------------ Attestations de bail */

const LEASE_STATES: Record<string, { label: string; tone: Tone }> = {
  DECLARE: { label: 'Déclaré', tone: 'neutral' }, OBSERVE: { label: 'Observé', tone: 'info' }, VERIFIE: { label: 'Vérifié', tone: 'good' },
  CONTESTE: { label: 'Contesté', tone: 'serious' }, RESILIE: { label: 'Résilié', tone: 'neutral' },
};

export function BauxVisuels({ baux }: { baux: LeaseRow[] }) {
  const loyers = splitByCurrency(sumBy(baux.filter((l) => l.state !== 'RESILIE'), 'periodicity', 'rent'));
  const devises = Object.keys(loyers) as ('CDF' | 'USD')[];
  return (
    <div className="stack viz-block" aria-label="Résumé visuel des baux">
      <KpiGrid max={4} label="Baux — chiffres clés">
        <KpiTile hero label="Baux enregistrés" value={baux.length} format={entier} example state={{ label: 'Bailleur ou locataire', tone: 'info' }} />
        <KpiTile label="Attestations émises" value={baux.filter((l) => l.attestation).length} format={entier} sub={`sur ${baux.length} bail(aux)`} />
        <KpiTile label="Baux vérifiés" value={baux.filter((l) => l.probativeStatus === 'VERIFIE').length} format={entier} />
        <KpiTile label="Résiliés" value={baux.filter((l) => l.state === 'RESILIE').length} format={entier} />
      </KpiGrid>
      <ChartGrid min={300}>
        <StatusDistribution title="Baux par état" unitLabel="baux" example items={repartition(baux, (l) => l.state ?? l.probativeStatus, LEASE_STATES)} emptyText="Aucun bail enregistré." />
        {devises.map((c) => (
          <BarChartViz key={c} title={`Loyers déclarés en cours, par périodicité (${c})`} format={(v) => `${fmtNombre(v, 2)} ${c}`} series={SERIE_N(`Loyer (${c})`)} example
            rows={loyers[c]!.map((r) => ({ key: r.key, label: r.key.toLowerCase(), values: { n: r.value } }))} note="Montant par échéance du bail, une devise par graphique." />
        ))}
      </ChartGrid>
    </div>
  );
}

/* ------------------------------------------------------------------ Corrections d'objets */

export function CorrectionsVisuels({ objets, enAttente }: { objets: FiscalObjectView[]; enAttente: number | null }) {
  const exemple = objets.some((o) => o.example);
  const rangs = countBy(objets, (o) => String(o.localityRank)).sort((a, b) => a.key.localeCompare(b.key));
  const cycle: Record<string, { label: string; tone: Tone }> = { PROVISOIRE: { label: 'Provisoire', tone: 'info' }, ACTIF: { label: 'Actif', tone: 'good' }, SUSPENDU: { label: 'Suspendu', tone: 'warning' }, CLOS: { label: 'Clos', tone: 'neutral' } };
  return (
    <div className="stack viz-block" aria-label="Résumé visuel des objets">
      <KpiGrid max={3} label="Corrections — chiffres clés">
        <KpiTile hero label="Corrections en attente" value={enAttente} format={entier} reason="File non lue." state={{ label: 'Seconde approbation', tone: enAttente ? 'warning' : 'good' }} />
        <KpiTile label="Objets du périmètre" value={objets.length} format={entier} example={exemple} />
        <KpiTile label="Objets actifs" value={objets.filter((o) => (o.lifecycle?.state ?? (o.status === 'VALIDE' ? 'ACTIF' : 'PROVISOIRE')) === 'ACTIF').length} format={entier} />
      </KpiGrid>
      <ChartGrid min={300}>
        <BarChartViz title="Objets par rang de localité" format={entier} series={SERIE_N('Objets')} example={exemple} rows={barresDe(rangs, (k) => `Rang ${k}`)} />
        <StatusDistribution title="Cycle de vie des objets" unitLabel="objets" example={exemple} items={repartition(objets, (o) => o.lifecycle?.state ?? (o.status === 'VALIDE' ? 'ACTIF' : 'PROVISOIRE'), cycle)} />
        <StatusDistribution title="Statut probant des objets" unitLabel="objets" example={exemple} items={repartition(objets, (o) => o.probativeStatus, PROBATIVE)} />
      </ChartGrid>
    </div>
  );
}

/* ------------------------------------------------------------------ Carte à deux couches */

export function CarteVisuels({ d }: { d: MapResponse }) {
  const totals: Record<MapStatusColor, number> = { green: 0, amber: 0, red: 0, grey: 0, blue: 0 };
  for (const c of d.communes) if (c.byColor && !c.masked) for (const k of COLOR_ORDER) totals[k] += c.byColor[k] ?? 0;
  const items = COLOR_ORDER.map((k) => ({ key: k, label: d.legend.find((l) => l.color === k)?.label ?? COLOR_WORD[k], tone: MAP_TONE[k], count: totals[k] }));
  const visibles = d.communes.filter((c) => !c.masked && c.total).length;
  return (
    <div className="stack viz-block" aria-label="Résumé visuel de la carte">
      <ChartGrid min={300}>
        <StatusDistribution title={d.layer === 'situation' ? 'Situation fiscale — toutes communes' : 'Vérification — toutes communes'} subtitle="agrégats non masqués" unitLabel="objets"
          example={d.example} items={items} note={`${visibles} commune(s) avec objets visibles ; mailles de moins de ${d.threshold} objets masquées.`} />
        <HeatGrid className="viz-span-2" title="Objets par commune" measureLabel="Objets recensés" format={entier} example={d.example}
          cells={d.communes.map((c) => ({ commune: c.commune, value: c.masked ? null : c.total, detail: c.masked ? `moins de ${d.threshold} objets : masqué` : `dominante : ${COLOR_WORD[c.dominant].toLowerCase()}` }))}
          unmeasuredReason={`agrégat masqué (moins de ${d.threshold} objets) ou aucun objet visible`} />
      </ChartGrid>
    </div>
  );
}

/* ------------------------------------------------------------------ Autour de moi */

const BANDES = [100, 200, 300, 500, 1000];
export function AutourVisuels({ counts, items }: { counts: Record<MapStatusColor, number>; items: { distanceM: number; demo: boolean }[] }) {
  const exemple = items.some((i) => i.demo);
  const rows = BANDES.map((b, i) => {
    const lo = i === 0 ? 0 : BANDES[i - 1]!;
    return { key: String(b), label: `${lo} à ${b} m`, values: { n: items.filter((x) => x.distanceM >= lo && x.distanceM < b).length } };
  }).filter((r) => r.values.n > 0);
  return (
    <ChartGrid min={300}>
      <StatusDistribution title="Biens proches par couleur" unitLabel="biens" example={exemple} items={COLOR_ORDER.map((k) => ({ key: k, label: COLOR_WORD[k], tone: MAP_TONE[k], count: counts[k] ?? 0 }))} />
      <BarChartViz title="Biens par distance" orientation="horizontal" format={entier} example={exemple} series={SERIE_N('Biens')} rows={rows} emptyText="Aucun bien dans ce rayon." />
    </ChartGrid>
  );
}

/* ------------------------------------------------------------------ Anomalies locatives */

export const ANOMALY_STATES: Record<string, { label: string; tone: Tone }> = {
  A_EXAMINER: { label: 'À examiner', tone: 'warning' }, EN_VERIFICATION: { label: 'En vérification', tone: 'info' },
  CONFIRMEE: { label: 'Confirmée', tone: 'serious' }, ECARTEE: { label: 'Écartée', tone: 'neutral' },
};

export function AnomaliesVisuels({ signals, cases }: { signals: { code: string; label: string; open: number; protocol: { active: boolean } }[]; cases: { status: string; commune?: string }[] | null }) {
  const actifs = signals.filter((s) => s.protocol.active).length;
  const communes = countBy((cases ?? []).filter((c) => c.commune), (c) => c.commune);
  return (
    <div className="stack viz-block" aria-label="Résumé visuel des anomalies locatives">
      <KpiGrid max={4} label="Anomalies — chiffres clés">
        <KpiTile hero label="Dossiers ouverts" value={signals.reduce((s, x) => s + x.open, 0)} format={entier} example state={{ label: 'Liste de travail', tone: 'warning' }} />
        <KpiTile label="Signaux suivis" value={signals.length} format={entier} />
        <KpiTile label="Protocoles actifs" value={actifs} format={entier} sub={`${signals.length - actifs} source(s) : protocole requis`} />
        <KpiTile label="Dossiers affichés" value={cases === null ? null : cases.length} format={entier} reason="Liste en cours de lecture." />
      </KpiGrid>
      <ChartGrid min={300}>
        <BarChartViz title="Dossiers ouverts par signal" orientation="horizontal" format={entier} series={SERIE_N('Dossiers ouverts')} example
          rows={signals.map((s) => ({ key: s.code, label: s.label, values: { n: s.protocol.active ? s.open : null } }))}
          note="Signal sans protocole actif : non mesuré (aucune donnée reçue, J13)." />
        <StatusDistribution title="Dossiers par état" unitLabel="dossiers" example items={repartition(cases ?? [], (c) => c.status, ANOMALY_STATES)} loading={cases === null} emptyText="Aucun dossier de vérification." />
        {communes.length > 0 && <HeatGrid className="viz-span-all" title="Dossiers par commune" measureLabel="Dossiers" format={entier} example cells={communes.map((r) => ({ commune: r.key, value: r.count }))} unmeasuredReason="aucun dossier dans cette commune" />}
      </ChartGrid>
    </div>
  );
}

/* ------------------------------------------------------------------ Assiette 2026 */

export function AssietteVisuels({ cases, decls }: { cases: { code: string; label: string; active: boolean; fields: unknown[]; coherence: string[] }[]; decls: { case: string; coherence: { ok: boolean }[] }[] | null }) {
  const checks = (decls ?? []).flatMap((d) => d.coherence);
  return (
    <div className="stack viz-block" aria-label="Résumé visuel de l’assiette 2026">
      <KpiGrid max={4} label="Assiette 2026 — chiffres clés">
        <KpiTile hero label="Nouveaux cas de l’édit" value={cases.length} format={entier} state={{ label: 'Règles à vérifier', tone: 'warning' }} />
        <KpiTile label="Règles actives" value={cases.filter((c) => c.active).length} format={entier} sub="quatre visas requis" />
        <KpiTile label="Déclarations déposées" value={decls === null ? null : decls.length} format={entier} reason="Connectez-vous pour voir vos déclarations." />
        <KpiTile label="Points de cohérence à vérifier" value={decls === null ? null : checks.filter((k) => !k.ok).length} format={entier} reason="Connectez-vous pour voir vos déclarations." />
      </KpiGrid>
      <ChartGrid min={300}>
        <BarChartViz title="Champs et contrôles par cas" orientation="horizontal" format={entier}
          series={[{ key: 'f', label: 'Champs du formulaire' }, { key: 'c', label: 'Contrôles de cohérence' }]}
          rows={cases.map((c) => ({ key: c.code, label: c.label, values: { f: c.fields.length, c: c.coherence.length } }))} />
        <StatusDistribution title="Contrôles de cohérence de mes déclarations" unitLabel="contrôles" emptyText="Aucune déclaration déposée."
          items={[{ key: 'ok', label: 'Cohérent', tone: 'good', count: checks.filter((k) => k.ok).length }, { key: 'ko', label: 'À vérifier', tone: 'warning', count: checks.filter((k) => !k.ok).length }]} />
      </ChartGrid>
    </div>
  );
}

/* ------------------------------------------------------------------ Conditions des services */

export function DependancesVisuels({ services }: { services: { service: string; label: string; conditions: { mode: string }[]; history: unknown[] }[] }) {
  const conds = services.flatMap((s) => s.conditions);
  return (
    <div className="stack viz-block" aria-label="Résumé visuel des conditions">
      <KpiGrid max={3} label="Conditions — chiffres clés">
        <KpiTile hero label="Services conditionnés" value={services.length} format={entier} state={{ label: 'Règles versionnées', tone: 'info' }} />
        <KpiTile label="Conditions en vigueur" value={conds.length} format={entier} />
        <KpiTile label="Conditions bloquantes" value={conds.filter((c) => c.mode === 'BLOQUANT').length} format={entier} sub="après publication de l’acte" />
      </KpiGrid>
      <ChartGrid min={300}>
        <StatusDistribution title="Conditions par mode" unitLabel="conditions"
          items={[{ key: 'INFORMATIF', label: 'Informatif — ne bloque pas', tone: 'info', count: conds.filter((c) => c.mode === 'INFORMATIF').length }, { key: 'BLOQUANT', label: 'Obligatoire — bloque', tone: 'serious', count: conds.filter((c) => c.mode === 'BLOQUANT').length }]} />
        <BarChartViz title="Versions de règle par service" orientation="horizontal" format={entier} series={SERIE_N('Versions de règle')}
          rows={services.map((s) => ({ key: s.service, label: s.label, values: { n: s.history.length } }))} />
      </ChartGrid>
    </div>
  );
}

/* ------------------------------------------------------------------ Recensement */

export function RecensementVisuels({ d }: { d: { total: number; imported: number; withExplicitProvenance: number; stages: { stage: number; label: string; count: number; atLeast: number }[]; byCommune: Record<string, Record<string, number>> } }) {
  const communes = Object.entries(d.byCommune).map(([commune, st]) => ({ commune, total: Object.values(st).reduce((s, n) => s + n, 0), st }));
  const vagues = d.stages.map((s) => ({ key: String(s.stage), label: `${s.stage} — ${s.label}` }));
  return (
    <div className="stack viz-block" aria-label="Résumé visuel du recensement">
      <KpiGrid max={4} label="Recensement — chiffres clés">
        <KpiTile hero label="Objets recensés" value={d.total} format={entier} example state={{ label: 'Toutes vagues', tone: 'info' }} />
        <KpiTile label="Au moins en vague 4" value={d.stages.find((s) => s.stage === 4)?.atLeast ?? null} format={entier} reason="Vague non servie." sub={`sur ${d.total} objet(s)`} />
        <KpiTile label="Repris d’un système existant" value={d.imported} format={entier} />
        <KpiTile label="Provenance vérifiée" value={d.withExplicitProvenance} format={entier} />
      </KpiGrid>
      <ChartGrid min={300}>
        <BarChartViz title="Objets ayant atteint au moins chaque vague" orientation="horizontal" format={entier} series={SERIE_N('Objets')} example
          rows={d.stages.map((s) => ({ key: String(s.stage), label: `${s.stage} — ${s.label}`, values: { n: s.atLeast } }))} note="Chaque objet avance d’une vague à la fois." />
        <StackedBarViz title="Vague atteinte, par commune" mode="absolute" orientation="horizontal" format={entier} example
          series={vagues} rows={communes.map((c) => ({ key: c.commune, label: c.commune, values: Object.fromEntries(vagues.map((v) => [v.key, c.st[v.key] ?? 0])) }))} />
        <HeatGrid className="viz-span-all" title="Objets recensés par commune" measureLabel="Objets" format={entier} example
          cells={communes.map((c) => ({ commune: c.commune, value: c.total }))} unmeasuredReason="aucun objet recensé dans cette commune" />
      </ChartGrid>
    </div>
  );
}

/** Couverture locative : unités enregistrées et occupation par zone. */
export function CouvertureLocativeVisuel({ rows }: { rows: { commune: string; quartier: string | null; avenue: string | null; occupancy: { ownerOccupied: number; leased: number; vacant: number; undeclared: number } }[] }) {
  const zone = (r: (typeof rows)[number]) => [r.commune, r.quartier, r.avenue].filter(Boolean).join(' › ');
  return (
    <StackedBarViz title="Occupation des unités enregistrées" mode="absolute" orientation="horizontal" format={entier} example
      series={[{ key: 'p', label: 'Occupé par le propriétaire' }, { key: 'l', label: 'Loué' }, { key: 'v', label: 'Vacant' }, { key: 'u', label: 'Non déclaré' }]}
      rows={rows.slice(0, 12).map((r) => ({ key: zone(r), label: zone(r), values: { p: r.occupancy.ownerOccupied, l: r.occupancy.leased, v: r.occupancy.vacant, u: r.occupancy.undeclared } }))}
      note={rows.length > 12 ? `12 premières zones sur ${rows.length} (toutes dans le tableau).` : 'Estimation du potentiel : non mesurée sans modèle certifié.'} emptyText="Aucune unité enregistrée." />
  );
}

/* ------------------------------------------------------------------ Reprise e-DGRK */

export function RepriseVisuels({ lots }: { lots: { status: string; report: { valid: number; invalid: number; total: number }; dedup: unknown[] }[] }) {
  const valid = lots.reduce((s, b) => s + b.report.valid, 0);
  const invalid = lots.reduce((s, b) => s + b.report.invalid, 0);
  const total = lots.reduce((s, b) => s + b.report.total, 0);
  return (
    <div className="stack viz-block" aria-label="Résumé visuel de la reprise">
      <KpiGrid max={4} label="Reprise — chiffres clés">
        <KpiTile hero label="Lots déposés" value={lots.length} format={entier} state={{ label: 'Validation à blanc', tone: 'info' }} />
        <KpiTile label="Lots intégrés" value={lots.filter((b) => b.status === 'INTEGRE').length} format={entier} sub="par une seconde personne" />
        <KpiTile label="Lignes valides" value={valid} format={entier} sub={`${total} ligne(s) au total`} />
        <KpiTile label="Doublons proposés" value={lots.reduce((s, b) => s + b.dedup.length, 0)} format={entier} sub="jamais fusionnés automatiquement" />
      </KpiGrid>
      <ChartGrid min={300}>
        <StatusDistribution title="Lots par état" unitLabel="lots" emptyText="Aucun lot déposé."
          items={repartition(lots, (b) => b.status, { VALIDE_A_BLANC: { label: 'Validé à blanc', tone: 'warning' }, INTEGRE: { label: 'Intégré', tone: 'good' } })} />
        <StatusDistribution title="Lignes par résultat" unitLabel="lignes" emptyText="Aucune ligne déposée."
          items={[{ key: 'ok', label: 'Valide', tone: 'good', count: valid }, { key: 'ko', label: 'En erreur', tone: 'critical', count: invalid }]} />
      </ChartGrid>
    </div>
  );
}
