/**
 * Visuels de l'apprentissage (§ 24, module 50 — ajout du 27/09/2026, charte : docs/document-maitre/charte-visualisation.md).
 * Dérivés des vues déjà chargées (espace de l'apprenant, registre des certifications, indicateurs agrégés, procédures).
 * Agrégés, jamais nominatifs au-delà de ce que l'écran affiche déjà ; seuils servis par le serveur avec leur statut
 * (« par défaut — à confirmer par le maître d'ouvrage »). Contenus de démonstration marqués [EXEMPLE].
 */
import {
  BarChartViz, ChartGrid, GaugeMeter, KpiGrid, KpiTile, ProgressMeter, StackedBarViz, StatusDistribution, fmtNombre,
} from '../../components/viz';
import { countBy } from '../../lib/aggregate';
import { etatsDepuis } from '../../pages/visuels';
import type { Comprehension, Espace, Indicateurs, LigneRegistre } from './types';
import { PROFIL_LIBELLE, PROFILS_CERTIFIES } from './types';

const n0 = (v: number) => fmtNombre(v, 0);

/** Espace de l'apprenant : modules réussis, exigences de certification, derniers résultats d'épreuve vs seuil. */
export function EspaceApprentissageVisuel({ d }: { d: Espace }) {
  const reussis = d.modules.filter((m) => m.derniereEpreuve?.reussie).length;
  const valides = d.certifications.filter((c) => c.valide).length;
  return (
    <section className="viz-section" aria-label="Mon apprentissage en un coup d’œil">
      <KpiGrid max={4} label="Mon apprentissage en un coup d’œil">
        <KpiTile hero label="Modules réussis" value={reussis} format={n0} target={d.modules.length ? { value: d.modules.length, label: `${d.modules.length} module(s) pour vos fonctions` } : undefined} example />
        <KpiTile label="Certifications en vigueur" value={valides} format={n0} sub={`sur ${d.certifications.length} applicable(s)`} state={d.certifications.length ? { label: valides === d.certifications.length ? 'À jour' : 'À compléter', tone: valides === d.certifications.length ? 'good' : 'warning' } : undefined} />
        <KpiTile label="Micro-leçons" value={d.fiches.length} format={n0} />
        <KpiTile label="Seuil de réussite" value={d.seuilReussitePct} unit="%" format={n0} sub={d.statutSeuil} />
      </KpiGrid>
      <ChartGrid min={300}>
        <BarChartViz title="Mes derniers résultats d’épreuve" subtitle="score en % ; ligne : seuil servi par le serveur" orientation="horizontal" format={(v) => `${fmtNombre(v, 0)} %`} example
          series={[{ key: 's', label: 'Score (%)' }]} reference={{ value: d.seuilReussitePct, label: `Seuil ${d.seuilReussitePct} %` }}
          rows={d.modules.map((m) => ({ key: m.id, label: m.titre, values: { s: m.derniereEpreuve ? m.derniereEpreuve.scorePct : null } }))}
          note="Un module sans épreuve passée est « non mesuré » (jamais dessiné à 0)." emptyText="Aucun module publié pour vos fonctions" />
        {d.certifications.map((c) => (
          <div key={c.profil} className="panel viz-meter-card">
            <ProgressMeter label={`Exigences de certification — ${PROFIL_LIBELLE[c.profil]}`} value={c.exigences.filter((e) => e.satisfaite).length} max={Math.max(1, c.exigences.length)}
              format={n0} unit={`sur ${c.exigences.length}`} tone={c.valide ? 'good' : 'warning'} toneLabel={c.valide ? 'Certificat en vigueur' : `${c.manquants.length} élément(s) manquant(s)`} reason="aucune exigence" />
          </div>
        ))}
      </ChartGrid>
    </section>
  );
}

/** Registre des certifications : comptes certifiés ou à compléter, par public. */
export function RegistreCertificationsVisuel({ lignes }: { lignes: readonly LigneRegistre[] }) {
  const rows = PROFILS_CERTIFIES.map((p) => {
    const l = lignes.filter((x) => x.profil === p);
    return { key: p, label: PROFIL_LIBELLE[p], values: { v: l.filter((x) => x.valide).length, m: l.filter((x) => !x.valide).length } };
  }).filter((r) => r.values.v + r.values.m > 0);
  return (
    <ChartGrid min={300}>
      <StatusDistribution title="Certification des comptes" unitLabel="comptes" example emptyText="Aucun compte"
        items={etatsDepuis({ OUI: { label: 'Certificat en vigueur', tone: 'good' }, NON: { label: 'Éléments manquants', tone: 'warning' } }, countBy(lignes, (l) => (l.valide ? 'OUI' : 'NON')))} />
      <StackedBarViz title="Par public" mode="absolute" format={n0} example series={[{ key: 'v', label: 'En vigueur' }, { key: 'm', label: 'À compléter' }]} rows={rows} />
    </ChartGrid>
  );
}

/** Indicateurs agrégés : couverture des certificats par public et compréhension des contribuables. */
export function IndicateursApprentissageVisuel({ d }: { d: Pick<Indicateurs, 'couverture'> & { comprehension: Comprehension } }) {
  const c = d.comprehension;
  const taux = c.statut === 'MESURE' && c.tauxPct !== null ? Number(c.tauxPct) : null;
  return (
    <ChartGrid min={300}>
      <BarChartViz className="viz-span-2" title="Couverture des certificats par public" subtitle="agrégée, jamais nominative" orientation="horizontal" format={n0} example
        series={[{ key: 'v', label: 'En vigueur' }, { key: 'e', label: 'Échéance sous 30 jours' }, { key: 'x', label: 'Expirés' }, { key: 'r', label: 'Retirés' }]}
        rows={d.couverture.map((x) => ({ key: x.profil, label: x.libelle, values: { v: x.enVigueur, e: x.echeanceSous30j, x: x.expires, r: x.retires } }))}
        note="« Échéance sous 30 jours » est un sous-ensemble des certificats en vigueur (barres côte à côte, jamais empilées)." />
      <GaugeMeter title="Dossiers complets du premier coup" value={taux} unit="%" reason={c.libelle} tone="info" toneLabel={`Suivi (sans cible) — ${c.examines} dossier(s) examiné(s)`} />
    </ChartGrid>
  );
}

/** Base de procédures : versions publiées ou non, nombre de versions par procédure. */
export function ProceduresVisuel({ items }: { items: readonly { cle: string; demo: boolean; publiee: { titre: string } | null; historique: readonly unknown[] }[] }) {
  return (
    <ChartGrid min={300}>
      <StatusDistribution title="Procédures par état de publication" unitLabel="procédures" example={items.some((p) => p.demo)} emptyText="Aucune procédure pour votre public"
        items={etatsDepuis({ PUB: { label: 'Version publiée (opposable)', tone: 'good' }, NON: { label: 'Non publiée', tone: 'neutral' } }, countBy(items, (p) => (p.publiee ? 'PUB' : 'NON')))} />
      <BarChartViz title="Versions par procédure" orientation="horizontal" format={n0} example={items.some((p) => p.demo)} emptyText="Aucune procédure"
        series={[{ key: 'n', label: 'Versions' }]} rows={items.map((p) => ({ key: p.cle, label: p.publiee?.titre ?? p.cle, values: { n: p.historique.length } }))} />
    </ChartGrid>
  );
}

/** Mes certificats : en vigueur, expirés, retirés. */
export function MesCertificatsVisuel({ items }: { items: readonly { statut: string; enVigueur: boolean }[] }) {
  return (
    <StatusDistribution title="Mes certificats par état" unitLabel="certificats" example emptyText="Aucun certificat pour le moment"
      items={etatsDepuis({ V: { label: 'En vigueur', tone: 'good' }, E: { label: 'Expiré — renouvellement requis', tone: 'warning' }, R: { label: 'Retiré', tone: 'neutral' } },
        countBy(items, (c) => (c.statut === 'RETIRE' ? 'R' : c.enVigueur ? 'V' : 'E')))} />
  );
}
