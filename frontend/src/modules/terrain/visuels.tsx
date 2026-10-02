/**
 * Visuels des écrans du terrain (ajout du 27/09/2026, charte : docs/document-maitre/charte-visualisation.md).
 * Dérivés des indicateurs et listes que chaque écran charge déjà (supervision, inspection, sous-traitants, contrôle
 * qualité, équipements, réserve des agents, vérification publique). Aucun chiffre inventé ; les seuils affichés sont
 * ceux que sert le serveur, avec leur statut (« par défaut — à confirmer par le maître d'ouvrage »). Rien de
 * l'existant n'est retiré : tableaux, bandeaux d'indicateurs et actions restent en place.
 */
import type { MoneyJSON } from '@mosolo/shared';
import {
  BarChartViz, ChartGrid, DonutViz, GaugeMeter, HeatGrid, KpiGrid, KpiTile, LineAreaViz, ProgressMeter, StackedBarViz, StatusDistribution,
  fmtDevise, fmtNombre, type StatusItem,
} from '../../components/viz';
import { countBy, periodRange, splitByCurrency, sumBy } from '../../lib/aggregate';
import { etatsDepuis, type EtatDef } from '../../pages/visuels';
import { AGENT_STATUS, BADGE_RESULT, FINDING_STATUS, MISSION_STATUS, ST_STATUS } from './labels';
import type { FieldAgent, Indicators, Subcontractor } from './types';

const n0 = (v: number) => fmtNombre(v, 0);
const pct = (s: string | null | undefined): number | null => (s === null || s === undefined || s === '' ? null : Number(s));

// ————————————————————————— Supervision —————————————————————————

/** Supervision : missions par état, constats par jour et par état, production par commune (24 communes), équipes. */
export function SupervisionVisuel({ ind, example }: { ind: Indicators; example?: boolean }) {
  const days = ind.findings.byDay ?? [];
  const serie = days.length ? periodRange(days[0]!.date, days[days.length - 1]!.date, 'day') : [];
  const parJour = new Map(days.map((d) => [d.date, d.count]));
  const constats: Record<string, number> = { VALIDE: ind.findings.validated, REJETE: ind.findings.rejected, SOUMIS: ind.findings.pending };
  const agents: Record<string, number> = { HABILITE: ind.agents.habilitated, INVITE: ind.agents.invited, SUSPENDU: ind.agents.suspended };
  return (
    <ChartGrid min={300} label="Supervision en graphiques">
      <StatusDistribution title="Missions par état" unitLabel="missions" items={etatsDepuis(MISSION_STATUS, ind.missions.byStatus)} example={example}
        note={ind.missions.overdue ? `${ind.missions.overdue} mission(s) en retard sur l’échéance.` : 'Aucune mission en retard.'} />
      <StatusDistribution title="Constats par état de revue" unitLabel="constats" items={etatsDepuis({ VALIDE: FINDING_STATUS.VALIDE, SOUMIS: FINDING_STATUS.SOUMIS, REJETE: FINDING_STATUS.REJETE }, constats)} example={example} />
      <LineAreaViz title="Constats transmis par jour" subtitle="jours de Kinshasa" area granularity="day" example={example} format={n0}
        series={[{ key: 'n', label: 'Constats' }]} points={serie.map((d) => ({ date: d, values: { n: parJour.get(d) ?? 0 } }))} />
      <BarChartViz title="Production par commune" subtitle="constats, validés et objectif des missions" orientation="horizontal" format={n0} example={example}
        series={[{ key: 'f', label: 'Constats' }, { key: 'v', label: 'Validés' }, { key: 'o', label: 'Objectif' }]}
        rows={ind.byCommune.map((c) => ({ label: c.commune, values: { f: c.findings, v: c.validated, o: c.objectiveTarget } }))} />
      <HeatGrid className="viz-span-2" title="Atteinte de l’objectif par commune" measureLabel="Objectif atteint (constats / objectif des missions)" unit="%" domain={[0, 100]} example={example}
        format={(v) => fmtNombre(v, 1)} cells={ind.byCommune.map((c) => ({ commune: c.commune, value: pct(c.objectivePct), detail: `${c.findings} constat(s) sur ${c.objectiveTarget} · tolérance GPS ${c.toleranceM} m` }))}
        unmeasuredReason="aucune mission de terrain dans cette commune" />
      <StatusDistribution title="Agents de terrain par état" unitLabel="agents" items={etatsDepuis({ HABILITE: AGENT_STATUS.HABILITE, INVITE: AGENT_STATUS.INVITE, SUSPENDU: AGENT_STATUS.SUSPENDU }, agents)} example={example} />
      {ind.subcontractors && <StatusDistribution title="Sous-traitants par état" unitLabel="sous-traitants" items={etatsDepuis(ST_STATUS, ind.subcontractors)} example={example} />}
      {ind.badgeVerifications && (
        <StatusDistribution title="Vérifications publiques de badges" unitLabel="vérifications" emptyText="Aucune vérification de badge par le public"
          items={etatsDepuis(Object.fromEntries(Object.entries(BADGE_RESULT).map(([k, b]) => [k, { label: b.label, tone: b.tone }])), ind.badgeVerifications.byResult)} />
      )}
      <div className="panel viz-meter-card">
        <ProgressMeter label="Constats avec photo scellée" value={pct(ind.findings.withPhotoPct)} unit="%" reason="aucun constat" tone="info" toneLabel="Suivi (sans cible)" />
        <ProgressMeter label="Constats signalés (écart GPS)" value={pct(ind.findings.flaggedPct)} unit="%" reason="aucun constat" tone="info" toneLabel="Suivi (sans cible)" />
      </div>
    </ChartGrid>
  );
}

// ————————————————————————— Inspection —————————————————————————

export interface InspectionIndicateurs {
  constats: { total: number; soumis: number; valides: number; rejetes: number; horsZone: number };
  tauxValidation: { statut?: string; valeur: string | null; motif?: string; revus?: number };
  procesVerbaux: { total: number; transmis: number; valides: number; rejetes: number; refusDeSigner: number };
  contestations: { total: number; traitees: number };
  dossiers?: number;
}

/** Inspection (module 35) : constats, procès-verbaux, contestations et taux de validation. */
export function InspectionVisuel({ d }: { d: InspectionIndicateurs }) {
  const taux = d.tauxValidation.valeur ? Number(d.tauxValidation.valeur.replace(/[^\d.,]/g, '').replace(',', '.')) : null;
  return (
    <section className="viz-section" aria-label="Inspection en un coup d’œil">
      <KpiGrid max={4} label="Inspection en un coup d’œil">
        <KpiTile hero label="Constats" value={d.constats.total} format={n0} sub={`${d.constats.horsZone} hors zone ou à distance`} />
        <KpiTile label="Procès-verbaux" value={d.procesVerbaux.total} format={n0} sub={`${d.procesVerbaux.refusDeSigner} refus de signer`} />
        <KpiTile label="Contestations" value={d.contestations.total} format={n0} state={{ label: `${d.contestations.traitees} traitée(s)`, tone: d.contestations.total > d.contestations.traitees ? 'warning' : 'good' }} />
        <KpiTile label="Dossiers d’inspection préparés" value={d.dossiers ?? null} format={n0} reason="non servi par le serveur" />
      </KpiGrid>
      <ChartGrid min={280}>
        <StatusDistribution title="Constats par état" unitLabel="constats" items={[
          { key: 'v', label: 'Validés', tone: 'good', count: d.constats.valides }, { key: 's', label: 'En attente de revue', tone: 'warning', count: d.constats.soumis },
          { key: 'r', label: 'Rejetés', tone: 'critical', count: d.constats.rejetes },
        ]} />
        <StatusDistribution title="Procès-verbaux par état" unitLabel="procès-verbaux" emptyText="Aucun procès-verbal" items={[
          { key: 'v', label: 'Validés (figés)', tone: 'good', count: d.procesVerbaux.valides }, { key: 't', label: 'Transmis, à valider', tone: 'warning', count: d.procesVerbaux.transmis },
          { key: 'r', label: 'Rejetés', tone: 'critical', count: d.procesVerbaux.rejetes },
        ]} />
        <GaugeMeter title="Taux de validation des constats revus" value={taux} unit="%" reason={d.tauxValidation.motif ?? 'aucun constat revu'} tone="info" toneLabel={`Suivi (sans cible) — ${d.tauxValidation.revus ?? 0} revu(s)`} />
      </ChartGrid>
    </section>
  );
}

// ————————————————————————— Procès-verbaux me concernant —————————————————————————

/** Contribuable : ses procès-verbaux par état et ses contestations (répondues ou en attente). */
export function MesPvVisuel({ pvs }: { pvs: readonly { status: string; contestations: readonly { answer?: unknown }[] }[] }) {
  const contest = pvs.flatMap((p) => p.contestations);
  return (
    <ChartGrid min={280}>
      <StatusDistribution title="Mes procès-verbaux" unitLabel="procès-verbaux" example emptyText="Aucun procès-verbal sur vos biens"
        items={etatsDepuis({ VALIDE: { label: 'Validé', tone: 'good' }, TRANSMIS: { label: 'En attente de validation', tone: 'warning' } }, countBy(pvs, (p) => (p.status === 'VALIDE' ? 'VALIDE' : 'TRANSMIS')))} />
      <StatusDistribution title="Mes contestations" unitLabel="contestations" example emptyText="Aucune contestation"
        items={[{ key: 'r', label: 'Réponse motivée reçue', tone: 'good', count: contest.filter((c) => c.answer).length }, { key: 'a', label: 'Réponse en attente', tone: 'warning', count: contest.filter((c) => !c.answer).length }]} />
    </ChartGrid>
  );
}

// ————————————————————————— Sous-traitants et équipes —————————————————————————

/** Sous-traitants : états d'accréditation, agents par état et par structure. */
export function SousTraitantsVisuel({ subs, agents, example }: { subs: readonly Subcontractor[]; agents: readonly FieldAgent[]; example?: boolean }) {
  const nom = new Map(subs.map((s) => [s.id, s.name]));
  const parStructure = [...new Set(agents.map((a) => a.subcontractorId ?? ''))].map((k) => {
    const l = agents.filter((a) => (a.subcontractorId ?? '') === k);
    return { key: k || 'regie', label: k ? nom.get(k) ?? k : 'Équipes internes de la régie', values: { h: l.filter((a) => a.status === 'HABILITE').length, i: l.filter((a) => a.status === 'INVITE').length, s: l.filter((a) => a.status === 'SUSPENDU' || a.status === 'REVOQUE').length } };
  });
  return (
    <ChartGrid min={300}>
      <StatusDistribution title="Sous-traitants par état d’accréditation" unitLabel="sous-traitants" items={etatsDepuis(ST_STATUS, countBy(subs, 'status'), { masquerZeros: true })} example={example} emptyText="Aucun sous-traitant" />
      <StatusDistribution title="Agents par état" unitLabel="agents" items={etatsDepuis(AGENT_STATUS, countBy(agents, 'status'), { masquerZeros: true })} example={example} emptyText="Aucun agent" />
      <StackedBarViz title="Agents par structure" mode="absolute" format={n0} example={example}
        series={[{ key: 'h', label: 'Habilités' }, { key: 'i', label: 'En attente d’habilitation' }, { key: 's', label: 'Suspendus ou révoqués' }]} rows={parStructure} />
    </ChartGrid>
  );
}

// ————————————————————————— Contrôle qualité —————————————————————————

const RECUP: Record<string, EtatDef> = {
  PROPOSEE: { label: 'À décider', tone: 'warning' }, DECIDEE: { label: 'Décidée — ordre à émettre', tone: 'serious' }, ORDONNEE: { label: 'Ordre de reversement émis', tone: 'good' }, REJETEE: { label: 'Rejetée', tone: 'neutral' },
};

/** Contrôle qualité : présomptions, ancienneté des équipes sur leur zone (seuil servi), récupérations par devise. */
export function QualiteVisuel({ board }: { board: { suspicions: readonly { kind: string }[]; rotation: { maxDays: number; statut: string; items: readonly { name: string; commune: string; days: number; overdue: boolean }[] }; clawbacks: readonly { status: string; amount: MoneyJSON }[] } }) {
  const recup = splitByCurrency(sumBy(board.clawbacks, 'status', 'amount'));
  return (
    <ChartGrid min={300} label="Contrôle qualité en graphiques">
      <StatusDistribution title="Présomptions à contre-visiter" unitLabel="présomptions" emptyText="Aucune présomption"
        items={etatsDepuis({ DOUBLON: { label: 'Doublons présumés', tone: 'warning' }, FICTIF: { label: 'Objets présumés fictifs', tone: 'serious' } }, countBy(board.suspicions, 'kind'))}
        note="Présomptions seulement : aucune sanction automatique, décision à deux personnes." />
      <BarChartViz title="Ancienneté des équipes sur leur zone" subtitle={`jours ; rotation après ${board.rotation.maxDays} jours (${board.rotation.statut})`} orientation="horizontal" format={n0}
        series={[{ key: 'd', label: 'Jours sur la zone' }]} reference={{ value: board.rotation.maxDays, label: `Rotation : ${board.rotation.maxDays} j` }}
        rows={board.rotation.items.map((r, i) => ({ key: `${r.name}-${i}`, label: `${r.name} (${r.commune})`, values: { d: r.days } }))} emptyText="Aucune équipe en zone" />
      <StatusDistribution title="Récupérations des sommes versées" unitLabel="récupérations" items={etatsDepuis(RECUP, countBy(board.clawbacks, 'status'))} emptyText="Aucune récupération" />
      {Object.entries(recup).map(([cur, rows]) => (
        <BarChartViz key={cur} title={`Montants à récupérer — ${cur}`} orientation="horizontal" format={fmtDevise(cur)} series={[{ key: 'm', label: `Montant (${cur})` }]}
          rows={(rows ?? []).map((r) => ({ label: RECUP[r.key]?.label ?? r.key, values: { m: r.value } }))} />
      ))}
    </ChartGrid>
  );
}

// ————————————————————————— Équipements terrain —————————————————————————

const ETAT_TERMINAL: Record<string, EtatDef> = {
  ACTIF: { label: 'Actif', tone: 'good' }, DONNEES_EXPIREES: { label: 'Données hors ligne expirées', tone: 'warning' }, QUARANTAINE: { label: 'En quarantaine', tone: 'critical' }, REVOQUE: { label: 'Révoqué', tone: 'neutral' },
};

/** Équipements (module 58) : terminaux par état, liaison appareil–utilisateur, incidents par nature. */
export function EquipementsVisuel({ equipments, incidents }: { equipments: readonly { state: string; binding: { status: string } }[]; incidents: readonly { kind: string }[] }) {
  return (
    <ChartGrid min={280} label="Terminaux en graphiques">
      <StatusDistribution title="Terminaux par état" unitLabel="terminaux" items={etatsDepuis(ETAT_TERMINAL, countBy(equipments, 'state'))} emptyText="Aucun terminal enrôlé" />
      <StatusDistribution title="Liaison appareil–utilisateur" unitLabel="terminaux" emptyText="Aucun terminal enrôlé"
        items={etatsDepuis({ ATTESTEE: { label: 'Attestée', tone: 'good' }, A_ATTESTER: { label: 'À attester', tone: 'warning' } }, countBy(equipments, (e) => e.binding.status))} />
      <DonutViz title="Incidents par nature" centerLabel="incidents" format={n0} emptyText="Aucun incident"
        slices={countBy(incidents, 'kind').map((r) => ({ key: r.key, label: r.key.replace(/_/g, ' ').toLowerCase(), value: r.count }))} />
    </ChartGrid>
  );
}

// ————————————————————————— Réserve des agents —————————————————————————

interface ReserveLike {
  points: { verified: number; pending: number; reclaimed: number; suspected: number; unattached: number };
  agents: readonly { agentId: string; name: string; byKind: Record<string, number>; quality: { score: number; byDefault: boolean } }[];
  modules: readonly { module: string; currency: string | null; distributed: MoneyJSON | null; undistributed: MoneyJSON | null }[];
  items: readonly { status: string }[];
  mode: string | null;
}

/** Réserve (§ 37A.5) : points par agent et par nature, état des points, répartition par module (une devise par graphique). */
export function ReserveVisuel({ d }: { d: ReserveLike }) {
  const devises = [...new Set(d.modules.map((m) => m.currency).filter((c): c is string => !!c))];
  const simulation = d.mode !== 'CALCUL';
  return (
    <section className="viz-section" aria-label="Réserve en graphiques">
      <KpiGrid max={4} label="Réserve en un coup d’œil">
        <KpiTile hero label="Points vérifiés" value={d.points.verified} format={n0} state={{ label: simulation ? 'Simulation (acte requis)' : 'Calcul', tone: simulation ? 'warning' : 'good' }} />
        <KpiTile label="Points en attente" value={d.points.pending} format={n0} sub={`${d.points.unattached} non rattaché(s)`} />
        <KpiTile label="Points repris" value={d.points.reclaimed} format={n0} sub={`${d.points.suspected} présumé(s)`} />
        <KpiTile label="Agents bénéficiaires" value={d.agents.length} format={n0} />
      </KpiGrid>
      <ChartGrid min={300}>
        <StackedBarViz title="Points par agent et par nature" mode="absolute" format={n0} emptyText="Aucun point ce mois-ci"
          series={[{ key: 'OBJET_CONFIRME', label: 'Objets confirmés' }, { key: 'ENROLEMENT_VALIDE', label: 'Enrôlements valides' }, { key: 'REGULARISATION_CONFIRMEE', label: 'Régularisations confirmées' }]}
          rows={d.agents.map((a) => ({ key: a.agentId, label: a.name, values: { OBJET_CONFIRME: a.byKind.OBJET_CONFIRME ?? 0, ENROLEMENT_VALIDE: a.byKind.ENROLEMENT_VALIDE ?? 0, REGULARISATION_CONFIRMEE: a.byKind.REGULARISATION_CONFIRMEE ?? 0 } }))} />
        <StatusDistribution title="Points par état" unitLabel="points" emptyText="Aucun point ce mois-ci"
          items={etatsDepuis({ VERIFIE: { label: 'Vérifié', tone: 'good' }, EN_ATTENTE: { label: 'En attente', tone: 'warning' }, REPRIS: { label: 'Repris', tone: 'critical' } }, countBy(d.items, 'status'))} />
        <BarChartViz title="Note de qualité par agent" orientation="horizontal" format={(v) => `${fmtNombre(v, 0)} %`} emptyText="Aucun agent"
          series={[{ key: 'q', label: 'Note de qualité (%)' }]} rows={d.agents.map((a) => ({ key: a.agentId, label: `${a.name}${a.quality.byDefault ? ' (défaut)' : ''}`, values: { q: Math.round(a.quality.score * 100) } }))} />
        {devises.map((cur) => (
          <StackedBarViz key={cur} title={`Réserve par module — ${cur}`} subtitle="répartie et non répartie" mode="absolute" format={fmtDevise(cur)}
            series={[{ key: 'r', label: 'Répartie' }, { key: 'u', label: 'Non répartie' }]}
            rows={d.modules.filter((m) => m.currency === cur).map((m) => ({ label: m.module, values: { r: m.distributed ? Number(m.distributed.amount) : 0, u: m.undistributed ? Number(m.undistributed.amount) : 0 } }))} />
        ))}
      </ChartGrid>
    </section>
  );
}

// ————————————————————————— Vérification publique d'un agent —————————————————————————

/** Public : résultats agrégés des contrôles mystère (aucune donnée personnelle). */
export function ControlesMystereVisuel({ s }: { s: { performed: number; withoutIrregularity: number; withoutIrregularityPct: string | null } }) {
  const items: StatusItem[] = [
    { key: 'ok', label: 'Sans irrégularité', tone: 'good', count: s.withoutIrregularity },
    { key: 'ko', label: 'Avec irrégularité', tone: 'critical', count: Math.max(0, s.performed - s.withoutIrregularity) },
  ];
  return <StatusDistribution title="Contrôles mystère auprès des agents" subtitle="résultats agrégés, sans donnée personnelle" unitLabel="contrôles" items={items} emptyText="Aucun contrôle réalisé" />;
}
