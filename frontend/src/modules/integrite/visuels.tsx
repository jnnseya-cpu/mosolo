/**
 * Intégrité — visuels (trousse de visualisation, 27/09/2026). Chaque bloc est dérivé des données que l'écran charge
 * déjà (mêmes routes, mêmes droits) : aucune donnée supplémentaire n'est lue, aucun chiffre n'est inventé ; les seuils
 * affichés sont ceux servis par le registre (« par défaut — à confirmer » tant qu'aucun acte ne les fixe).
 * Les tableaux, formulaires et boutons existants restent en place sous ces visuels.
 */
import type { Tone } from '../../components/StatusBadge';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { countBy } from '../../lib/aggregate';
import {
  BarChartViz, ChartGrid, fmtNombre, GaugeMeter, HeatGrid, KpiGrid, KpiTile, ProgressMeter, StackedBarViz,
} from '../../components/viz';
import { ActiviteParJour, Barres, barresDe, Etats, etatsDe, nombreDe, Parts, partsDe, serieParJour } from '../plateforme/visuels';
import '../plateforme/visuels.css';
import { CATEGORY_LABELS, CHANNEL_LABELS, SEVERITY_LABELS, SEVERITY_TONE, STATUS } from './shared';

const SEV_ORDRE = ['CRITIQUE', 'ELEVEE', 'MOYENNE', 'FAIBLE'];
const SEVERITES = Object.fromEntries(SEV_ORDRE.map((k) => [k, { label: SEVERITY_LABELS[k]!, tone: SEVERITY_TONE[k]! }]));
const SIGNAL_ORDRE = ['RECU', 'QUALIFIE', 'TRANSMIS', 'CLOS'];
const ALERTE_ORDRE = ['A_EXAMINER', 'EN_EXAMEN', 'CLOTURE_PROPOSEE', 'CLASSEE', 'DOSSIER_OUVERT'];
const DOSSIER_ORDRE = ['OUVERT', 'EN_INSTRUCTION', 'CONCLUSIONS_DEPOSEES', 'DECIDE'];

// ————————————————————————— Console d'enquête —————————————————————————

interface ConsoleInd {
  signalements: { total: number; ouverts: number; enRetard: number; delaiMoyenJours: number | null; partConfirmee: string | null; parCategorie?: Record<string, number>; parCanal?: Record<string, number> };
  alertes: { ouvertes: number; classees: number; versDossier: number };
  dossiers: { ouverts: number; decides: number; delaiInstructionMoyenJours: number | null };
  incidents?: { ouverts: number; horsDelai: number; parGravite: Record<string, number> };
}
interface ReportLite { status: string; receivedAt: string; commune?: string; category: string; channel: string; overdue: boolean; demo?: boolean }
interface AlertLite { status: string; severity: string; raisedAt: string; ruleLabel: string }
interface CaseLite { status: string; openedAt: string }

/** En-tête visuel de la console : tuiles (courbe 14 jours), états des trois files, canaux, natures, communes, activité. */
export function ConsoleVisuels({ ind, reports, alerts, cases }: { ind: ConsoleInd | null; reports: ReportLite[] | null; alerts: AlertLite[] | null; cases: CaseLite[] | null }) {
  const sR = reports ? serieParJour(reports, (r) => r.receivedAt, 14) : null;
  const sA = alerts ? serieParJour(alerts, (a) => a.raisedAt, 14) : null;
  const sC = cases ? serieParJour(cases, (c) => c.openedAt, 14) : null;
  const exemple = !!reports?.some((r) => r.demo);
  return (
    <div className="vz-bloc" data-testid="console-visuels">
      {ind && (
        <KpiGrid max={4} label="Enquêtes — chiffres clés">
          <KpiTile hero label="Signalements ouverts" value={ind.signalements.ouverts} state={{ label: `${ind.signalements.enRetard} hors délai`, tone: ind.signalements.enRetard > 0 ? 'critical' : 'good' }}
            spark={sR ? { values: sR.values, labels: sR.labels, label: 'Signalements reçus par jour (14 jours)' } : undefined} sub={`${ind.signalements.total} reçu(s) au total`} />
          <KpiTile label="Alertes ouvertes" value={ind.alertes.ouvertes} state={{ label: 'À examiner par une personne', tone: ind.alertes.ouvertes > 0 ? 'warning' : 'good' }}
            spark={sA ? { values: sA.values, labels: sA.labels, label: 'Alertes levées par jour (14 jours)' } : undefined} sub={`${ind.alertes.classees} classée(s) · ${ind.alertes.versDossier} en dossier`} />
          <KpiTile label="Dossiers en cours" value={ind.dossiers.ouverts} state={{ label: `${ind.dossiers.decides} décidé(s)`, tone: 'info' }}
            spark={sC ? { values: sC.values, labels: sC.labels, label: 'Dossiers ouverts par jour (14 jours)' } : undefined} />
          <KpiTile label="Délai moyen de traitement" value={ind.signalements.delaiMoyenJours} unit="j" reason="Aucun signalement clos : délai non mesurable."
            sub={`Part confirmée : ${ind.signalements.partConfirmee ?? 'non mesurée (aucune clôture)'}`} />
        </KpiGrid>
      )}
      <ChartGrid min={300} label="Enquêtes — graphiques">
        {reports && <Etats title="Signalements par état" unitLabel="signalements" example={exemple} items={etatsDe(reports, (r) => r.status, STATUS, SIGNAL_ORDRE)} />}
        {alerts && <Etats title="Alertes par état" unitLabel="alertes" items={etatsDe(alerts, (a) => a.status, STATUS, ALERTE_ORDRE)} note="Aucune alerte n’a d’effet automatique : une personne examine." />}
        {cases && <Etats title="Dossiers d’enquête par état" unitLabel="dossiers" items={etatsDe(cases, (c) => c.status, STATUS, DOSSIER_ORDRE)} />}
        {alerts && <Etats title="Alertes par gravité" unitLabel="alertes" items={etatsDe(alerts, (a) => a.severity, SEVERITES, SEV_ORDRE)} />}
        {ind?.signalements.parCanal && <Parts title="Signalements par canal" centerLabel="signalements" example={exemple} slices={partsDe(ind.signalements.parCanal, CHANNEL_LABELS)} />}
        {ind?.signalements.parCategorie && <Barres title="Signalements par nature" example={exemple} serie="Signalements" rows={Object.entries(ind.signalements.parCategorie).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ key: k, label: CATEGORY_LABELS[k] ?? k, values: { n } }))} />}
        {reports && (
          <HeatGrid className="viz-span-2" title="Signalements par commune" measureLabel="Signalements" example={exemple}
            cells={countBy(reports.filter((r) => r.commune), (r) => r.commune!).map((c) => ({ commune: c.key, value: c.count }))}
            format={(v) => fmtNombre(v, 0)} unmeasuredReason="aucun signalement rattaché à cette commune" />
        )}
        {(reports || alerts) && (
          <ActiviteParJour className="viz-span-2" title="Activité de la ligne d’intégrité" example={exemple}
            series={[
              ...(reports ? [{ key: 'sig', label: 'Signalements reçus', items: reports.map((r) => ({ at: r.receivedAt })) }] : []),
              ...(alerts ? [{ key: 'al', label: 'Alertes levées', items: alerts.map((a) => ({ at: a.raisedAt })) }] : []),
            ]} />
        )}
      </ChartGrid>
    </div>
  );
}

// ————————————————————————— Collusion sous quatre yeux —————————————————————————

interface CollusionLite {
  params: { pairShareMinPct: number; statut: string; rotationMaxPerPair: number; rotationWindowDays: number };
  circuits: { code: string; label: string; decisions: number }[];
  totals: { decisions: number; approvals: number; refusals: number; pairs: number };
  pairs: { proposerId: string; approverId: string; sharePct: number; inRotationWindow: number }[];
  approvers: { approverId: string; approvals: number; refusals: number }[];
  findings: { label: string; severity: 'MEDIUM' | 'HIGH' }[];
}

export function CollusionVisuels({ r }: { r: CollusionLite }) {
  const refusPct = r.totals.decisions > 0 ? (100 * r.totals.refusals) / r.totals.decisions : null;
  const topPairs = [...r.pairs].sort((a, b) => b.sharePct - a.sharePct).slice(0, 8);
  return (
    <div className="vz-bloc" data-testid="collusion-visuels">
      <ChartGrid min={300} label="Collusion — graphiques">
        <Etats title="Signaux à examiner par gravité" unitLabel="signaux"
          items={etatsDe(r.findings, (f) => f.severity, { HIGH: { label: 'Élevée', tone: 'serious' }, MEDIUM: { label: 'Moyenne', tone: 'warning' } }, ['HIGH', 'MEDIUM'])}
          emptyText="Aucun signal sur la période" note="Signaux explicables ; jamais de sanction automatique." />
        <GaugeMeter title="Part des refus" subtitle={`${r.totals.refusals} refus sur ${r.totals.decisions} décision(s) à deux personnes`} value={refusPct} unit="%"
          format={(v) => fmtNombre(v, 1)} reason="Aucune décision à deux personnes sur la période." />
        <BarChartViz className="viz-span-2" title="Valideurs : approbations et refus" orientation="horizontal"
          series={[{ key: 'a', label: 'Approbations' }, { key: 'r', label: 'Refus' }]} format={(v) => fmtNombre(v, 0)}
          rows={r.approvers.slice(0, 10).map((x) => ({ key: x.approverId, label: x.approverId, values: { a: x.approvals, r: x.refusals } }))} />
        <BarChartViz title="Paires : part du proposant" subtitle="8 paires les plus concentrées" orientation="horizontal" series={[{ key: 's', label: 'Part du proposant (%)' }]}
          rows={topPairs.map((p) => ({ key: `${p.proposerId}>${p.approverId}`, label: `${p.proposerId} → ${p.approverId}`, values: { s: p.sharePct } }))}
          reference={{ value: r.params.pairShareMinPct, label: `Seuil du registre (${r.params.statut})` }} format={(v) => `${fmtNombre(v, 0)} %`} />
        <Barres title="Décisions par circuit" serie="Décisions" rows={r.circuits.map((c) => ({ key: c.code, label: c.label, values: { n: c.decisions } }))} />
      </ChartGrid>
    </div>
  );
}

// ————————————————————————— Contrôles mystère —————————————————————————

interface MystereCheck { status: string; targetKind: string; commune: string; plannedFor: string; demo?: boolean; result?: { outcome: string } }
interface MystereSummary { byTarget: { targetKind: string; realises: number; conformes: number; tauxConformite: string | null }[]; planifies: number; example: boolean }
const TARGET_LABELS: Record<string, string> = { AGENT: 'Agent', SOUS_TRAITANT: 'Sous-traitant', POINT_PAIEMENT: 'Point de paiement', GUICHET: 'Guichet' };

export function MystereVisuels({ checks, summary }: { checks: MystereCheck[] | null; summary: MystereSummary | null }) {
  const exemple = !!summary?.example || !!checks?.some((c) => c.demo);
  return (
    <div className="vz-bloc" data-testid="mystere-visuels">
      <ChartGrid min={300} label="Contrôles mystère — graphiques">
        {checks && <Etats title="Contrôles par étape" unitLabel="contrôles" example={exemple} items={etatsDe(checks, (c) => c.status, STATUS, ['PLANIFIE', 'REALISE', 'SUITE_DONNEE'])} />}
        {checks && <Etats title="Résultats constatés" unitLabel="contrôles réalisés" example={exemple} emptyText="Aucun contrôle réalisé"
          items={etatsDe(checks.filter((c) => c.result), (c) => c.result!.outcome, STATUS, ['CONFORME', 'NON_CONFORME', 'NON_REALISABLE'])} />}
        {summary && (
          <BarChartViz className="viz-span-2" title="Réalisés et conformes par cible" orientation="horizontal" example={exemple}
            series={[{ key: 'r', label: 'Réalisés' }, { key: 'c', label: 'Conformes' }]} format={(v) => fmtNombre(v, 0)}
            rows={summary.byTarget.map((t) => ({ key: t.targetKind, label: TARGET_LABELS[t.targetKind] ?? t.targetKind, values: { r: t.realises, c: t.conformes } }))} />
        )}
        {summary && (
          <section className="panel stack-sm" aria-label="Taux de conformité par cible">
            <h3 className="panel-title">Taux de conformité par cible</h3>
            {summary.byTarget.map((t) => (
              <ProgressMeter key={t.targetKind} label={`Conformité — ${TARGET_LABELS[t.targetKind] ?? t.targetKind}`} value={nombreDe(t.tauxConformite)} unit="%"
                reason="Aucun contrôle réalisé sur cette cible." />
            ))}
          </section>
        )}
        {checks && (
          <HeatGrid className="viz-span-2" title="Contrôles par commune" measureLabel="Contrôles" example={exemple}
            cells={countBy(checks, (c) => c.commune).map((c) => ({ commune: c.key, value: c.count }))} format={(v) => fmtNombre(v, 0)} unmeasuredReason="aucun contrôle programmé dans cette commune" />
        )}
      </ChartGrid>
    </div>
  );
}

// ————————————————————————— Détecteurs —————————————————————————

interface DetLite { detectors: { code: string; label: string }[]; signals: { code: string; label: string }[]; schedule: { intervalHours: number; lastRunAt: string | null } }

export function DetecteursVisuels({ o }: { o: DetLite }) {
  const par = countBy(o.signals, (s) => s.code);
  const rows = o.detectors.map((d) => ({ key: d.code, label: d.label, values: { n: par.find((p) => p.key === d.code)?.count ?? 0 } }));
  const extra = par.filter((p) => !o.detectors.some((d) => d.code === p.key)).map((p) => ({ key: p.key, label: o.signals.find((s) => s.code === p.key)?.label ?? p.key, values: { n: p.count } }));
  return (
    <div className="vz-bloc" data-testid="detecteurs-visuels">
      <ChartGrid min={300}>
        <Barres className="viz-span-2" title="Signaux par détecteur" serie="Signaux à examiner" rows={[...rows, ...extra]} note="Un signal n’a aucun effet automatique : une personne l’examine." />
        <Parts title="Détecteurs ayant levé un signal" centerLabel="détecteurs"
          slices={[{ key: 'avec', label: 'Avec signal', value: rows.filter((r) => r.values.n > 0).length }, { key: 'sans', label: 'Sans signal', value: rows.filter((r) => r.values.n === 0).length }]} />
      </ChartGrid>
    </div>
  );
}

// ————————————————————————— Protection des données —————————————————————————

const TYPES_DROITS: Record<string, string> = { ACCES: 'Accès et portabilité', RECTIFICATION: 'Rectification', LIMITATION: 'Limitation', EFFACEMENT: 'Effacement' };

export function DemandesVisuels({ items }: { items: { type: string; status: string; submittedAt: string; overdue: boolean }[] }) {
  const retard = items.filter((r) => r.overdue).length;
  return (
    <div className="vz-bloc" data-testid="demandes-visuels">
      <ChartGrid min={280}>
        <Etats title="Demandes par état" unitLabel="demandes" items={etatsDe(items, (r) => r.status, STATUS, ['RECUE', 'EN_TRAITEMENT', 'EN_ATTENTE_SECONDE_VALIDATION', 'REPONDUE', 'REJETEE'])}
          note={retard ? `${retard} demande(s) hors délai.` : 'Aucune demande hors délai.'} />
        <Parts title="Demandes par droit exercé" centerLabel="demandes" slices={countBy(items, (r) => r.type).map((c) => ({ key: c.key, label: TYPES_DROITS[c.key] ?? c.key, value: c.count }))} />
        <ActiviteParJour title="Demandes reçues" series={[{ key: 'd', label: 'Demandes', items: items.map((r) => ({ at: r.submittedAt })) }]} />
      </ChartGrid>
    </div>
  );
}

export function RegistreTraitementsVisuels({ items }: { items: { legalBasis: string; module: string; sensitive: boolean }[] }) {
  return (
    <div className="vz-bloc" data-testid="registre-traitements-visuels">
      <ChartGrid min={280}>
        <Barres title="Traitements par base légale" serie="Traitements" rows={barresDe(countBy(items, (p) => p.legalBasis))} />
        <Parts title="Données sensibles" centerLabel="traitements"
          slices={[{ key: 's', label: 'Avec données sensibles', value: items.filter((p) => p.sensitive).length }, { key: 'n', label: 'Sans donnée sensible', value: items.filter((p) => !p.sensitive).length }]} />
        <Barres title="Traitements par module" serie="Traitements" rows={barresDe(countBy(items, (p) => p.module))} />
      </ChartGrid>
    </div>
  );
}

export function JournalConsultationsVisuels({ items, labels }: { items: { at: string; action: string; outcome: string }[]; labels: Record<string, string> }) {
  return (
    <div className="vz-bloc" data-testid="journal-consultations-visuels">
      <ChartGrid min={280}>
        <Etats title="Issue des consultations" unitLabel="événements"
          items={etatsDe(items, (r) => (r.outcome === 'DENIED' ? 'DENIED' : 'OK'), { OK: { label: 'Autorisé', tone: 'good' }, DENIED: { label: 'Refusé', tone: 'critical' } }, ['OK', 'DENIED'])} />
        <Barres title="Consultations par événement" serie="Événements" rows={barresDe(countBy(items, (r) => r.action), labels)} />
        <ActiviteParJour className="viz-span-2" title="Consultations journalisées" series={[{ key: 'c', label: 'Consultations', items: items.map((r) => ({ at: r.at })) }]} />
      </ChartGrid>
    </div>
  );
}

// ————————————————————————— Incidents de sécurité —————————————————————————

const CAT_INCIDENT: Record<string, string> = {
  ACCES_NON_AUTORISE: 'Accès non autorisé', FUITE_DONNEES: 'Fuite de données', COMPROMISSION_APPAREIL: 'Appareil compromis',
  INDISPONIBILITE: 'Indisponibilité', FRAUDE_TECHNIQUE: 'Fraude technique', INTEGRITE_JOURNAL: 'Intégrité du journal', AUTRE: 'Autre',
};

export function IncidentsVisuels({ items, candidates }: { items: { status: string; severity: string; category: string; declaredAt: string; overdue: boolean; personalDataImpacted: boolean; demo?: boolean }[]; candidates: number | null }) {
  const ouverts = items.filter((i) => i.status !== 'RESOLU');
  const s = serieParJour(items, (i) => i.declaredAt, 14);
  const exemple = items.some((i) => i.demo);
  return (
    <div className="vz-bloc" data-testid="incidents-visuels">
      <KpiGrid max={4} label="Incidents — chiffres clés">
        <KpiTile hero label="Incidents ouverts" value={ouverts.length} state={{ label: `${ouverts.filter((i) => i.overdue).length} hors délai`, tone: ouverts.some((i) => i.overdue) ? 'critical' : 'good' }}
          spark={{ values: s.values, labels: s.labels, label: 'Incidents déclarés par jour (14 jours)' }} example={exemple} />
        <KpiTile label="Données personnelles touchées" value={items.filter((i) => i.personalDataImpacted).length} state={{ label: 'Notification au DPO', tone: 'warning' }} />
        <KpiTile label="Résolus" value={items.filter((i) => i.status === 'RESOLU').length} state={{ label: 'Preuve de clôture', tone: 'good' }} />
        <KpiTile label="Alertes candidates" value={candidates} reason="Liste des alertes non chargée." state={{ label: 'À qualifier', tone: 'info' }} />
      </KpiGrid>
      <ChartGrid min={280}>
        <Etats title="Incidents par état" unitLabel="incidents" example={exemple} items={etatsDe(items, (i) => i.status, STATUS, ['DECLARE', 'EN_COURS', 'CONTENU', 'RESOLU'])} />
        <Etats title="Incidents par gravité" unitLabel="incidents" example={exemple} items={etatsDe(items, (i) => i.severity, SEVERITES, SEV_ORDRE)} />
        <Barres title="Incidents par nature" serie="Incidents" example={exemple} rows={barresDe(countBy(items, (i) => i.category), CAT_INCIDENT)} />
      </ChartGrid>
    </div>
  );
}

// ————————————————————————— Registre des seuils —————————————————————————

export function SeuilsVisuels({ reg }: { reg: { entries: { category: string; status: string }[]; summary: { total: number; parDefaut: number; confirmes: number; modifiesAConfirmer: number }; requests: { status: string }[] } }) {
  const statuts: Record<string, { label: string; tone: Tone }> = {
    PAR_DEFAUT: { label: 'Par défaut — à confirmer', tone: 'warning' }, MODIFIE_A_CONFIRMER: { label: 'Modifié — à confirmer', tone: 'info' }, CONFIRME: { label: 'Confirmé par acte', tone: 'good' },
  };
  const parCat = [...new Set(reg.entries.map((e) => e.category))].map((c) => {
    const es = reg.entries.filter((e) => e.category === c);
    return { key: c, label: c, values: { d: es.filter((e) => e.status === 'PAR_DEFAUT').length, m: es.filter((e) => e.status === 'MODIFIE_A_CONFIRMER').length, c: es.filter((e) => e.status === 'CONFIRME').length } };
  });
  return (
    <div className="vz-bloc" data-testid="seuils-visuels">
      <ChartGrid min={280}>
        <ProgressMeter label="Paramètres confirmés par un acte" value={reg.summary.total ? (100 * reg.summary.confirmes) / reg.summary.total : null} unit="%" format={(v) => fmtNombre(v, 0)}
          reason="Aucun paramètre au registre." />
        <Etats title="Paramètres par statut" unitLabel="paramètres" items={etatsDe(reg.entries, (e) => e.status, statuts, ['PAR_DEFAUT', 'MODIFIE_A_CONFIRMER', 'CONFIRME'])} />
        <StackedBarViz className="viz-span-2" title="Statut des paramètres par famille" mode="absolute"
          series={[{ key: 'd', label: 'Par défaut' }, { key: 'm', label: 'Modifié — à confirmer' }, { key: 'c', label: 'Confirmé' }]} rows={parCat} />
        <Etats title="Demandes de confirmation / modification" unitLabel="demandes" emptyText="Aucune demande"
          items={etatsDe(reg.requests, (q) => q.status, { PROPOSEE: { label: 'Proposée', tone: 'warning' }, APPROUVEE: { label: 'Approuvée', tone: 'good' }, REJETEE: { label: 'Rejetée', tone: 'neutral' } }, ['PROPOSEE', 'APPROUVEE', 'REJETEE'])} />
      </ChartGrid>
    </div>
  );
}

// ————————————————————————— Renseignement —————————————————————————

const BANDES: Record<string, { label: string; tone: Tone }> = { ELEVE: { label: 'Score élevé', tone: 'critical' }, MOYEN: { label: 'Score moyen', tone: 'warning' }, FAIBLE: { label: 'Score faible', tone: 'neutral' } };
const SUSP: Record<string, { label: string; tone: Tone }> = {
  PROPOSEE: { label: 'Proposée', tone: 'warning' }, EN_VIGUEUR: { label: 'En vigueur', tone: 'critical' }, LEVEE: { label: 'Levée', tone: 'neutral' }, EXPIREE: { label: 'Échue', tone: 'neutral' }, REFUSEE: { label: 'Refusée', tone: 'neutral' },
};

export function RenseignementVisuels({ scores, susp, trans }: { scores: { score: number; band: string; ruleLabel: string }[]; susp: { status: string }[]; trans: { transmittedAt: string; acknowledgement?: unknown }[] }) {
  const tranches = [0, 20, 40, 60, 80].map((b) => ({ key: `${b}`, label: `${b}–${b === 80 ? 100 : b + 19}`, values: { n: scores.filter((s) => s.score >= b && (b === 80 ? s.score <= 100 : s.score < b + 20)).length } }));
  return (
    <div className="vz-bloc" data-testid="renseignement-visuels">
      <ChartGrid min={280}>
        <Etats title="Alertes notées par bande de score" unitLabel="alertes" items={etatsDe(scores, (s) => s.band, BANDES, ['ELEVE', 'MOYEN', 'FAIBLE'])}
          note="Score explicable : aide à prioriser, jamais une décision." emptyText="Aucune alerte notée (ou rôle sans accès aux scores)" />
        <BarChartViz title="Distribution des scores" subtitle="sur 100" series={[{ key: 'n', label: 'Alertes' }]} rows={tranches} format={(v) => fmtNombre(v, 0)} emptyText="Aucun score" />
        <Etats title="Suspensions conservatoires" unitLabel="suspensions" items={etatsDe(susp, (s) => s.status, SUSP, ['PROPOSEE', 'EN_VIGUEUR', 'LEVEE', 'EXPIREE', 'REFUSEE'])} emptyText="Aucune suspension" />
        <Parts title="Transmissions aux autorités" centerLabel="transmissions" emptyText="Aucune transmission"
          slices={[{ key: 'a', label: 'Accusé de réception reçu', value: trans.filter((t) => t.acknowledgement).length }, { key: 'n', label: 'Sans accusé', value: trans.filter((t) => !t.acknowledgement).length }]} />
      </ChartGrid>
    </div>
  );
}

// ————————————————————————— Revue des accès —————————————————————————

export function RevueVisuels({ camp }: { camp: { items: { decision: string; roleLabel: string; privileged: boolean }[]; progress: { total: number; decided: number } } }) {
  const parRole = [...new Set(camp.items.map((i) => i.roleLabel))].map((r) => {
    const it = camp.items.filter((i) => i.roleLabel === r);
    return { key: r, label: r, values: { a: it.filter((i) => i.decision === 'A_CONFIRMER').length, m: it.filter((i) => i.decision === 'MAINTENU').length, x: it.filter((i) => i.decision === 'RETRAIT_A_EXECUTER' || i.decision === 'RETIRE').length } };
  }).sort((a, b) => (b.values.a + b.values.m + b.values.x) - (a.values.a + a.values.m + a.values.x)).slice(0, 10);
  return (
    <div className="vz-bloc" data-testid="revue-visuels">
      <ChartGrid min={280}>
        <GaugeMeter title="Avancement de la campagne" subtitle={`${camp.progress.decided} accès revus sur ${camp.progress.total}`} value={camp.progress.total ? (100 * camp.progress.decided) / camp.progress.total : null}
          unit="%" format={(v) => fmtNombre(v, 0)} reason="Campagne sans accès à revoir." />
        <Etats title="Décisions de revue" unitLabel="accès" items={etatsDe(camp.items, (i) => i.decision, STATUS, ['A_CONFIRMER', 'MAINTENU', 'RETRAIT_A_EXECUTER'])} />
        <StackedBarViz className="viz-span-2" title="Décisions par rôle" subtitle="10 rôles les plus représentés" mode="absolute"
          series={[{ key: 'a', label: 'À confirmer' }, { key: 'm', label: 'Maintenu' }, { key: 'x', label: 'Retrait' }]} rows={parRole} />
      </ChartGrid>
    </div>
  );
}

// ————————————————————————— Santé des clés —————————————————————————

export function ClesVisuels({ keys }: { keys: { purpose: string; configured: boolean; ageDays?: number; warnings: { severity: string }[] }[] }) {
  const etatCle = (k: (typeof keys)[number]) => (!k.configured ? 'ABSENTE' : k.warnings.some((w) => w.severity === 'CRITIQUE') ? 'CRITIQUE' : k.warnings.some((w) => w.severity === 'ATTENTION') ? 'ATTENTION' : 'SAINE');
  return (
    <div className="vz-bloc" data-testid="cles-visuels">
      <ChartGrid min={280}>
        <Etats title="Clés par état" unitLabel="clés" items={etatsDe(keys, etatCle, {
          SAINE: { label: 'Saine', tone: 'good' }, ATTENTION: { label: 'À surveiller', tone: 'warning' }, CRITIQUE: { label: 'Critique', tone: 'critical' }, ABSENTE: { label: 'Non configurée', tone: 'neutral' },
        }, ['SAINE', 'ATTENTION', 'CRITIQUE', 'ABSENTE'])} />
        <Barres title="Âge des clés (jours)" serie="Jours depuis la mise en place" rows={keys.map((k) => ({ key: k.purpose, label: k.purpose, values: { n: k.ageDays ?? null } }))}
          note="Âge non mesuré lorsque la date de mise en place n’est pas connue." />
      </ChartGrid>
    </div>
  );
}

// ————————————————————————— Scellement du journal —————————————————————————

export function ScellementVisuels({ s }: { s: { chain: { length: number }; worm: { lastSeq: number }; roots: { day: string; count: number; publication: unknown; timestamp: unknown }[]; checks: { at: string; ok: boolean }[] } }) {
  const roots = [...s.roots].sort((a, b) => a.day.localeCompare(b.day)).slice(-30);
  return (
    <div className="vz-bloc" data-testid="scellement-visuels">
      <ChartGrid min={280}>
        <GaugeMeter title="Journal copié en stockage non réinscriptible" subtitle={`${fmtNombre(s.worm.lastSeq, 0)} enregistrement(s) sur ${fmtNombre(s.chain.length, 0)}`}
          value={s.chain.length ? Math.min(100, (100 * s.worm.lastSeq) / s.chain.length) : null} unit="%" format={(v) => fmtNombre(v, 1)} reason="Journal vide." />
        <Etats title="Contrôles d’intégrité" unitLabel="contrôles" emptyText="Aucun contrôle exécuté"
          items={etatsDe(s.checks, (c) => (c.ok ? 'OK' : 'KO'), { OK: { label: 'Intègre', tone: 'good' }, KO: { label: 'Divergence', tone: 'critical' } }, ['OK', 'KO'])} />
        <BarChartViz className="viz-span-2" title="Enregistrements scellés par racine quotidienne" subtitle="30 dernières racines" series={[{ key: 'n', label: 'Enregistrements' }]}
          rows={roots.map((r) => ({ key: r.day, label: r.day, values: { n: r.count } }))} format={(v) => fmtNombre(v, 0)} emptyText="Aucune racine scellée" />
        <Etats title="Racines horodatées et publiées" unitLabel="racines" emptyText="Aucune racine"
          items={etatsDe(s.roots, (r) => (r.publication ? 'PUB' : r.timestamp ? 'HOR' : 'NON'), {
            PUB: { label: 'Publiée', tone: 'good' }, HOR: { label: 'Horodatée, non publiée', tone: 'warning' }, NON: { label: 'Ni horodatée ni publiée', tone: 'serious' },
          }, ['PUB', 'HOR', 'NON'])} />
      </ChartGrid>
    </div>
  );
}

// ————————————————————————— Signalement public —————————————————————————

interface PublicSummary { signalementsRecus: number; signalementsClos: number; partConfirmee: string | null; controlesMystere: MystereSummary; example?: boolean }

/** Chiffres publics de la ligne d'intégrité (route publique, sans donnée personnelle). */
export function SignalementPublicVisuels() {
  const q = useApi(() => api<PublicSummary>('/v1/public/integrite/summary'), []);
  const d = q.data;
  const realises = d?.controlesMystere.byTarget.reduce((n, t) => n + t.realises, 0) ?? 0;
  const conformes = d?.controlesMystere.byTarget.reduce((n, t) => n + t.conformes, 0) ?? 0;
  return (
    <div className="vz-bloc" data-testid="signalement-public-visuels">
      <KpiGrid max={4} label="La ligne d’intégrité en chiffres">
        <KpiTile label="Signalements reçus" value={d?.signalementsRecus ?? null} loading={q.loading && !d} error={q.error ?? undefined} example={d?.example} />
        <KpiTile label="Signalements clos" value={d?.signalementsClos ?? null} loading={q.loading && !d} example={d?.example} />
        <KpiTile label="Part des faits confirmés" value={d ? nombreDe(d.partConfirmee) : null} unit="%" loading={q.loading && !d} reason="Aucun signalement clos : non mesurée." />
        <KpiTile label="Contrôles mystère réalisés" value={d ? realises : null} loading={q.loading && !d} sub={d ? `${conformes} conforme(s) · ${d.controlesMystere.planifies} planifié(s)` : undefined} example={d?.controlesMystere.example} />
      </KpiGrid>
    </div>
  );
}

// ————————————————————————— Surveillance technique —————————————————————————

const ATTEST: Record<string, { label: string; tone: Tone }> = {
  NON_ATTESTE: { label: 'Non attesté', tone: 'neutral' }, CONFORME: { label: 'Conforme', tone: 'good' }, NON_CONFORME: { label: 'Non conforme', tone: 'critical' }, INCONNU: { label: 'Inconnu', tone: 'warning' },
};

export function SurveillanceVisuels({ devices, gps, ceilings }: {
  devices: { items: { multiAccounts: boolean; kind: string; attestation: { status: string } }[] } | null;
  gps: { items: { userId: string; speedKmh: number }[]; maxKmh: number } | null;
  ceilings: { day: string; channels: { channel: string; today: number; alertPerDay: number; maxPerDay: number }[] } | null;
}) {
  return (
    <div className="vz-bloc" data-testid="surveillance-visuels">
      <ChartGrid min={280}>
        {devices && <Etats title="Appareils par attestation" unitLabel="appareils" items={etatsDe(devices.items, (d) => d.attestation.status, ATTEST, ['CONFORME', 'NON_ATTESTE', 'INCONNU', 'NON_CONFORME'])} />}
        {devices && <Parts title="Appareils partagés entre comptes" centerLabel="appareils"
          slices={[{ key: 'm', label: 'Plusieurs comptes', value: devices.items.filter((d) => d.multiAccounts).length }, { key: 'u', label: 'Un seul compte', value: devices.items.filter((d) => !d.multiAccounts).length }]} />}
        {gps && <BarChartViz title="Déplacements implausibles (vitesse)" orientation="horizontal" series={[{ key: 'v', label: 'Vitesse (km/h)' }]}
          rows={gps.items.slice(0, 10).map((g, i) => ({ key: `${g.userId}-${i}`, label: g.userId, values: { v: g.speedKmh } }))}
          reference={{ value: gps.maxKmh, label: `Seuil ${gps.maxKmh} km/h (par défaut — à confirmer)` }} format={(v) => `${fmtNombre(v, 0)} km/h`} emptyText="Aucun déplacement implausible" />}
        {ceilings && <BarChartViz className="viz-span-2" title={`Références de paiement du ${ceilings.day} par canal`} orientation="horizontal"
          series={[{ key: 't', label: 'Références du jour' }, { key: 'a', label: 'Seuil d’alerte' }, { key: 'm', label: 'Plafond' }]} format={(v) => fmtNombre(v, 0)}
          rows={ceilings.channels.map((c) => ({ key: c.channel, label: c.channel, values: { t: c.today, a: c.alertPerDay > 0 ? c.alertPerDay : null, m: c.maxPerDay > 0 ? c.maxPerDay : null } }))}
          note="Seuil ou plafond « non fixé » : aucune barre (non mesuré), jamais zéro." />}
      </ChartGrid>
    </div>
  );
}

/** Indicateurs du renseignement en tuiles (le texte d'origine reste affiché dessous). */
export function RenseignementTuiles({ ind }: { ind: {
  alertes: { ouvertes: number; resolues: number }; delaiInstruction: { statut: string; medianeJours?: number; motif?: string };
  deperditionEvitee: { statut: string; montants?: Record<string, string>; motif?: string };
  suspensions: { enVigueur: number; proposees: number }; transmissions: { total: number; accusees: number }; signalementsCitoyens: number;
} }) {
  const dep = ind.deperditionEvitee.statut === 'MESURE' ? Object.entries(ind.deperditionEvitee.montants ?? {}).map(([c, v]) => `${v} ${c}`).join(' + ') : null;
  return (
    <KpiGrid max={4} label="Renseignement — chiffres clés">
      <KpiTile hero label="Alertes ouvertes" value={ind.alertes.ouvertes} state={{ label: `${ind.alertes.resolues} résolue(s)`, tone: 'info' }} sub={`${ind.signalementsCitoyens} signalement(s) citoyen(s)`} />
      <KpiTile label="Délai d’instruction (médiane)" value={ind.delaiInstruction.statut === 'MESURE' ? ind.delaiInstruction.medianeJours ?? null : null} unit="j" reason={ind.delaiInstruction.motif ?? 'Non mesuré.'} />
      <KpiTile label="Déperdition évitée" value={dep} reason={ind.deperditionEvitee.motif ?? 'Non mesurée.'} sub="devise par devise, jamais additionnées" />
      <KpiTile label="Suspensions en vigueur" value={ind.suspensions.enVigueur} state={{ label: `${ind.suspensions.proposees} proposée(s)`, tone: ind.suspensions.proposees ? 'warning' : 'neutral' }}
        sub={`Transmissions : ${ind.transmissions.total} (${ind.transmissions.accusees} accusée(s))`} />
    </KpiGrid>
  );
}
