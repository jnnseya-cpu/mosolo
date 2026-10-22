/**
 * Parcours du citoyen (modules 1 à 12) — visuels (trousse de visualisation, 27/09/2026). Les indicateurs servis par
 * le serveur deviennent des tuiles (valeur réelle, ratio avec numérateur / dénominateur, ou « non mesuré » avec sa
 * raison) et leurs ventilations (par canal, par niveau, par plateforme, par page) des barres. Chaque écran reçoit en
 * tête une répartition par état tirée des listes qu'il charge déjà. Aucune valeur inventée, aucune route élargie.
 */
import type { ReactNode } from 'react';
import {
  BarChartViz, ChartGrid, DonutViz, HeatGrid, KpiGrid, KpiTile, StatusDistribution, fmtNombre, type StatusItem,
} from '../../components/viz';
import type { Tone } from '../../components/StatusBadge';
import { countBy } from '../../lib/aggregate';
import { barresDe, entier, repartition, SERIE_N } from '../fiscal/visuels';
import { libelle, type Indicateur } from './common';

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
};

/** Ventilations numériques d'un indicateur (« parCanal », « parNiveau »…). */
function ventilations(i: Indicateur): { cle: string; lignes: { key: string; value: number }[] }[] {
  return Object.entries(i)
    .filter(([k, v]) => k.startsWith('par') && v && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every((x) => typeof x === 'number'))
    .map(([k, v]) => ({ cle: k, lignes: Object.entries(v as Record<string, number>).map(([key, value]) => ({ key, value })) }));
}

const SOUS: Record<string, string> = { detectes: 'détectés', surNomSeul: 'sur le nom seul', resolus: 'résolus', fusionsEnCours: 'fusions en cours', bloquees: 'bloquées', regularisees: 'régularisées', signaux: 'signaux', inconnusRecoupement: 'inconnus au recoupement', enAttenteDeRegle: 'en attente de règle', suspendues: 'suspendues' };
const PAR: Record<string, string> = { parNiveau: 'par niveau', parCanal: 'par canal', parPlateforme: 'par plateforme', parPage: 'par page' };

/** Une tuile par indicateur ; les ventilations deviennent des barres. Les textes (règles, mentions) restent dans la liste. */
export function TuilesIndicateurs({ titre, indicateurs }: { titre: string; indicateurs: Record<string, unknown> }) {
  const tuiles: ReactNode[] = [];
  const barres: ReactNode[] = [];
  for (const [cle, brut] of Object.entries(indicateurs)) {
    if (typeof brut === 'string') continue;
    if (typeof brut === 'number') { tuiles.push(<KpiTile key={cle} label={libelle(cle)} value={brut} format={entier} />); continue; }
    if (!brut || typeof brut !== 'object') continue;
    const i = brut as Indicateur;
    const ratio = i.denominateur !== undefined;
    const monnaie = Array.isArray(i.valeur);
    const valeur = monnaie ? ((i.valeur as { amount: string; currency: string }[]).map((m) => `${m.amount} ${m.currency}`).join(' + ') || 'Aucun montant') : num(i.valeur);
    const sub = ratio && i.valeur !== null && i.valeur !== undefined ? `${i.numerateur ?? 0} / ${i.denominateur}` : typeof i.unite === 'string' ? i.unite : undefined;
    if (valeur === null && i.valeur === undefined && !i.raison) {
      // Indicateur composite sans « valeur » (ex. doublons détectés / résolus) : chaque compteur numérique est une tuile.
      for (const [k, v] of Object.entries(i)) if (typeof v === 'number') tuiles.push(<KpiTile key={`${cle}-${k}`} label={`${libelle(cle)} — ${SOUS[k] ?? k}`} value={v} format={entier} />);
    } else {
      tuiles.push(
        <KpiTile key={cle} label={libelle(cle)} value={valeur} unit={ratio ? '%' : undefined} format={(v) => fmtNombre(v, 1)} sub={sub}
          reason={typeof i.raison === 'string' ? i.raison : 'Aucune donnée source.'} />,
      );
    }
    for (const v of ventilations(i)) {
      barres.push(
        <BarChartViz key={`${cle}-${v.cle}`} title={`${libelle(cle)} — ${PAR[v.cle] ?? v.cle}`} orientation="horizontal" format={entier} series={SERIE_N(libelle(cle))}
          rows={v.lignes.map((l) => ({ key: l.key, label: l.key, values: { n: l.value } }))} />,
      );
    }
  }
  if (!tuiles.length && !barres.length) return null;
  return (
    <div className="stack-sm" aria-label={`${titre} — tuiles`}>
      {tuiles.length > 0 && <KpiGrid max={4} label={titre}>{tuiles}</KpiGrid>}
      {barres.length > 0 && <ChartGrid min={280}>{barres}</ChartGrid>}
    </div>
  );
}

/** Indicateurs des modules 1 à 12 : mesurés / non mesurés, par module. */
export function SyntheseIndicateurs({ modules }: { modules: { module: number; titre: string; indicateurs: Record<string, unknown> }[] }) {
  const etat = (v: unknown) => (typeof v === 'string' ? 'TEXTE' : typeof v === 'number' ? 'MESURE' : v && typeof v === 'object' && (v as Indicateur).valeur === null ? 'NON_MESURE' : 'MESURE');
  const tous = modules.flatMap((m) => Object.values(m.indicateurs).map(etat)).filter((e) => e !== 'TEXTE');
  return (
    <ChartGrid min={300}>
      <StatusDistribution title="Indicateurs des modules 1 à 12" subtitle="mesurés sur les données enregistrées" unitLabel="indicateurs"
        items={[{ key: 'm', label: 'Mesuré', tone: 'good', count: tous.filter((e) => e === 'MESURE').length }, { key: 'n', label: 'Non mesuré (motif affiché)', tone: 'neutral', count: tous.filter((e) => e === 'NON_MESURE').length }]} />
      <BarChartViz className="viz-span-2" title="Indicateurs par module" orientation="horizontal" format={entier}
        series={[{ key: 'm', label: 'Mesurés' }, { key: 'n', label: 'Non mesurés' }]}
        rows={modules.map((m) => {
          const e = Object.values(m.indicateurs).map(etat);
          return { key: String(m.module), label: `${m.module} — ${m.titre}`, values: { m: e.filter((x) => x === 'MESURE').length, n: e.filter((x) => x === 'NON_MESURE').length } };
        })} />
    </ChartGrid>
  );
}

/* ------------------------------------------------------------------ écrans */

const REVUE_STATES: Record<string, { label: string; tone: Tone }> = { A_REVOIR: { label: 'À revoir', tone: 'warning' }, MAINTENUE: { label: 'Maintenue', tone: 'good' }, A_RECTIFIER: { label: 'À rectifier', tone: 'serious' } };
export function RelationsVisuel({ revues }: { revues: { statut: string }[] }) {
  return <StatusDistribution title="Obligations à revoir après un détachement" unitLabel="obligations" items={repartition(revues, (r) => r.statut, REVUE_STATES)} emptyText="Aucune obligation à revoir." />;
}

export function LocatifVisuels({ couverture, lignes }: { couverture: { zone: string; couverture: string | null; couvertureVerifiee: string | null; unites: number }[] | null; lignes: { nature: string }[] | null }) {
  return (
    <ChartGrid min={300}>
      <BarChartViz className="viz-span-2" title="Couverture locative par zone" orientation="horizontal" format={(v) => `${fmtNombre(v, 1)} %`} example
        series={[{ key: 'c', label: 'Unités avec bail' }, { key: 'v', label: 'Avec bail vérifié' }]} loading={couverture === null}
        rows={(couverture ?? []).map((l) => ({ key: l.zone, label: l.zone, values: { c: num(l.couverture), v: num(l.couvertureVerifiee) } }))} emptyText="Aucune unité enregistrée." />
      <StatusDistribution title="Nature des calculs IRL" unitLabel="baux" loading={lignes === null} emptyText="Aucun bail vérifié."
        items={repartition(lignes ?? [], (l) => l.nature, { INDICATIF: { label: 'Indicatif', tone: 'good' }, NON_OPPOSABLE: { label: 'Non opposable', tone: 'warning' }, SANS_REGLE: { label: 'Sans règle', tone: 'neutral' } })} />
    </ChartGrid>
  );
}

export function CadastreVisuels({ couches, chaleur, indicateur, cas }: {
  couches: { code: string; libelle: string; total: number | null; restreinte: boolean }[];
  chaleur: { commune: string; objets: number; valeur: string | null; detail: string }[] | null; indicateur: string; cas: { statut: string }[] | null;
}) {
  const pct = indicateur === 'couverture' || indicateur === 'conformite';
  return (
    <ChartGrid min={300}>
      <BarChartViz title="Objets par couche" orientation="horizontal" format={entier} series={SERIE_N('Éléments')} example
        rows={couches.map((c) => ({ key: c.code, label: c.libelle, values: { n: c.total } }))} note="Couche réservée : non mesurée pour votre profil." />
      {chaleur && (
        <HeatGrid className="viz-span-2" title={`Carte de chaleur — ${indicateur}`} measureLabel={indicateur} unit={pct ? '%' : undefined} format={(v) => fmtNombre(v, 1)} example
          cells={chaleur.map((l) => ({ commune: l.commune, value: num(l.valeur), detail: l.detail }))} unmeasuredReason="aucun objet, agrégat masqué ou valeur non servie" />
      )}
      <StatusDistribution title="Cas difficiles par statut" unitLabel="cas" loading={cas === null} emptyText="Aucun cas ouvert."
        items={repartition(cas ?? [], (c) => c.statut, { OUVERT: { label: 'Ouvert', tone: 'warning' }, RENVOYE_SERVICE_FONCIER: { label: 'Renvoyé au service foncier', tone: 'info' }, RESOLU: { label: 'Résolu', tone: 'good' } })} />
    </ChartGrid>
  );
}

export function ActivitesVisuels({ etabs, signaux }: { etabs: { localisation: { commune: string }; patente: { active: boolean; exigible: boolean } }[]; signaux: { statut: string }[] | null }) {
  const patente: StatusItem[] = [
    { key: 'a', label: 'Patente active', tone: 'good', count: etabs.filter((e) => e.patente.active).length },
    { key: 's', label: 'Sans patente active', tone: 'warning', count: etabs.filter((e) => !e.patente.active && e.patente.exigible).length },
    { key: 'n', label: 'Patente non exigible — acte requis', tone: 'neutral', count: etabs.filter((e) => !e.patente.active && !e.patente.exigible).length },
  ];
  const communes = countBy(etabs, (e) => e.localisation.commune);
  return (
    <div className="stack viz-block">
      <KpiGrid max={3} label="Activités — chiffres clés">
        <KpiTile hero label="Établissements recensés" value={etabs.length} format={entier} example state={{ label: 'Registre des activités', tone: 'info' }} />
        <KpiTile label="Patentes actives" value={patente[0]!.count} format={entier} />
        <KpiTile label="Signaux à vérifier" value={signaux === null ? null : signaux.filter((s) => s.statut === 'A_VERIFIER').length} format={entier} reason="Réservé aux agents habilités." />
      </KpiGrid>
      <ChartGrid min={300}>
        <StatusDistribution title="Établissements et patente" unitLabel="établissements" example items={patente} emptyText="Aucun établissement." />
        <HeatGrid className="viz-span-2" title="Établissements par commune" measureLabel="Établissements" format={entier} example cells={communes.map((r) => ({ commune: r.key, value: r.count }))} unmeasuredReason="aucun établissement recensé" />
        {signaux && <StatusDistribution title="Signaux « commerce sans patente »" unitLabel="signaux" emptyText="Aucun signal."
          items={repartition(signaux, (s) => s.statut, { A_VERIFIER: { label: 'À vérifier', tone: 'warning' }, EN_MISSION: { label: 'En mission', tone: 'info' }, CONFIRME: { label: 'Confirmé', tone: 'serious' }, ECARTE: { label: 'Écarté', tone: 'neutral' } })} />}
      </ChartGrid>
    </div>
  );
}

export function VehiculesVisuels({ vehicules }: { vehicules: { categorie: string | null; usage: string | null; commune: string; situation?: { vignette?: { statut?: string } } }[] }) {
  return (
    <ChartGrid min={300}>
      <KpiTile hero label="Véhicules au référentiel" value={vehicules.length} format={entier} example state={{ label: 'Référentiel', tone: 'info' }} />
      <DonutViz title="Véhicules par usage" centerLabel="véhicules" format={entier} example slices={countBy(vehicules, (v) => v.usage ?? 'Non renseigné').map((r) => ({ key: r.key, label: r.key, value: r.count }))} />
      <BarChartViz title="Véhicules par commune" orientation="horizontal" format={entier} series={SERIE_N('Véhicules')} example rows={barresDe(countBy(vehicules, 'commune'))} />
    </ChartGrid>
  );
}

export function TransportVisuels({ autorisations }: { autorisations: { statut: string; categorieLibelle: string }[] }) {
  return (
    <ChartGrid min={300}>
      <StatusDistribution title="Autorisations par statut" unitLabel="autorisations" emptyText="Aucune autorisation enregistrée."
        items={repartition(autorisations, (a) => a.statut, { ACTIVE: { label: 'Active', tone: 'good' }, EN_ATTENTE_REGLE: { label: 'En attente de règle', tone: 'warning' }, SUSPENDUE: { label: 'Suspendue', tone: 'critical' }, RETIREE: { label: 'Retirée', tone: 'neutral' } })} />
      <DonutViz title="Autorisations par catégorie" centerLabel="autorisations" format={entier} slices={countBy(autorisations, 'categorieLibelle').map((r) => ({ key: r.key, label: r.key, value: r.count }))} />
    </ChartGrid>
  );
}

export function PiecesVisuels({ facteurs, revues }: { facteurs: { code: string; libelle: string; points: number; max: number }[] | null; revues: { score: number }[] | null }) {
  const bandes = [[0, 40], [40, 60], [60, 80], [80, 101]] as const;
  return (
    <ChartGrid min={300}>
      {facteurs && (
        <BarChartViz className="viz-span-2" title="Score de confiance — points par facteur" orientation="horizontal" format={entier}
          series={[{ key: 'p', label: 'Points obtenus' }, { key: 'm', label: 'Maximum' }]}
          rows={facteurs.map((f) => ({ key: f.code, label: f.libelle, values: { p: f.points, m: f.max } }))} />
      )}
      {revues && (
        <BarChartViz title="Cas à risque par tranche de score" format={entier} series={SERIE_N('Cas')} emptyText="Aucun cas en attente de revue."
          rows={revues.length ? bandes.map(([lo, hi]) => ({ key: `${lo}`, label: `${lo}–${Math.min(hi, 100)}`, values: { n: revues.filter((r) => r.score >= lo && r.score < hi).length } })) : []} />
      )}
    </ChartGrid>
  );
}

const OBLIG_STATES: Record<string, { label: string; tone: Tone }> = {
  EMISE: { label: 'Émise', tone: 'neutral' }, EXIGIBLE: { label: 'Exigible', tone: 'warning' }, PARTIELLEMENT_PAYEE: { label: 'Partiellement payée', tone: 'info' },
  SOLDEE: { label: 'Soldée', tone: 'good' }, EN_RETARD: { label: 'En retard', tone: 'critical' }, CONTESTEE: { label: 'Contestée', tone: 'serious' },
};
export function SituationVisuels({ parStatut, objets }: { parStatut: Record<string, number>; objets: { categorie: string }[] }) {
  const items = Object.entries(OBLIG_STATES).map(([key, v]) => ({ key, ...v, count: parStatut[key] ?? 0 }))
    .concat(Object.entries(parStatut).filter(([k]) => !(k in OBLIG_STATES)).map(([key, count]) => ({ key, label: key, tone: 'neutral' as Tone, count })));
  return (
    <ChartGrid min={280}>
      <StatusDistribution title="Mes obligations par état" unitLabel="obligations" items={items} emptyText="Aucune obligation." />
      <DonutViz title="Mes objets par catégorie" centerLabel="objets" format={entier} slices={countBy(objets, 'categorie').map((r) => ({ key: r.key, label: r.key, value: r.count }))} />
    </ChartGrid>
  );
}

export function PortailVisuels({ familles, echeances }: { familles: { famille: string; libelle: string; disponible: boolean; regles: { nature: string }[] }[]; echeances: { aVerifier: boolean }[] | null }) {
  const regles = familles.flatMap((f) => f.regles);
  return (
    <ChartGrid min={280}>
      <StatusDistribution title="Simulateurs disponibles" unitLabel="simulateurs"
        items={[{ key: 'd', label: 'Disponible', tone: 'good', count: familles.filter((f) => f.disponible).length }, { key: 'i', label: 'Indisponible (aucune règle publiée)', tone: 'neutral', count: familles.filter((f) => !f.disponible).length }]} />
      <StatusDistribution title="Règles simulables par nature" unitLabel="règles" emptyText="Aucune règle publiée."
        items={repartition(regles, (r) => r.nature, { INDICATIF: { label: 'Indicatif (règle ACTIVE)', tone: 'good' }, ILLUSTRATION_NON_OPPOSABLE: { label: 'Illustration non opposable', tone: 'warning' }, INDISPONIBLE: { label: 'Indisponible', tone: 'neutral' } })} />
      {echeances && <StatusDistribution title="Calendrier fiscal" unitLabel="échéances" emptyText="Aucune échéance publiée."
        items={[{ key: 'c', label: 'Échéance confirmée', tone: 'good', count: echeances.filter((e) => !e.aVerifier).length }, { key: 'v', label: 'À vérifier', tone: 'warning', count: echeances.filter((e) => e.aVerifier).length }]} />}
    </ChartGrid>
  );
}

export function PortefeuilleVisuel({ titres }: { titres: { etatServeur: string }[] }) {
  return (
    <StatusDistribution title="Titres du portefeuille (état serveur à la synchronisation)" unitLabel="titres" emptyText="Aucun titre synchronisé."
      items={repartition(titres, (t) => t.etatServeur, { PAS_ENCORE_ACTIF: { label: 'Pas encore actif', tone: 'info' }, VALIDE: { label: 'Valide', tone: 'good' }, BIENTOT_EXPIRE: { label: 'Expire bientôt', tone: 'warning' }, CRITIQUE: { label: 'Expire très bientôt', tone: 'serious' }, EXPIRE: { label: 'Expiré', tone: 'critical' }, SUSPENDU: { label: 'Suspendu', tone: 'critical' }, INVALIDE: { label: 'Invalide', tone: 'critical' } })} />
  );
}
