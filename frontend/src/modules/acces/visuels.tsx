/**
 * Accès et entités — visuels (trousse de visualisation, 27/09/2026). Dérivés des listes et indicateurs que chaque
 * écran charge déjà, dans le périmètre de la personne qui consulte (aucun droit élargi, aucun chiffre inventé).
 */
import type { Tone } from '../../components/StatusBadge';
import { countBy } from '../../lib/aggregate';
import { ChartGrid, fmtNombre, GaugeMeter, KpiGrid, KpiTile, ProgressMeter, TimelineStrip } from '../../components/viz';
import { ActiviteParJour, Barres, barresDe, Etats, etatsDe, Parts, serieParJour } from '../plateforme/visuels';
import '../plateforme/visuels.css';
import { FACT_LABEL, MANDATE_ACTION_LABEL, MODULE_STEP_LABEL, MODULE_STEPS, PROOF_LABEL, PURPOSE_LABEL, REASON_LABEL, STATUS, type Arbitration, type Consultation, type EntityRow, type InvitationRow, type Mandate } from './common';

const ETATS_MODULES = [...MODULE_STEPS, 'SUSPENDU', 'RETIRE', 'BLOQUE_ARBITRAGE'];
const ETIQ_MODULES = Object.fromEntries(ETATS_MODULES.map((k) => [k, { label: MODULE_STEP_LABEL[k] ? `${MODULE_STEP_LABEL[k]}${k === 'ACTIF' ? '' : ' — en cours'}` : STATUS[k]?.label ?? k, tone: STATUS[k]?.tone ?? 'neutral' }]));

// ————————————————————————— Indicateurs 72 et 74 —————————————————————————

export function Indicateurs72Visuels({ m }: { m: { modules: { total: number; actifs: number; parStatut: Record<string, number> }; arbitrages: { ouverts: number; instruits: number; decides: number } } }) {
  const items = ETATS_MODULES.map((k) => ({ key: k, ...ETIQ_MODULES[k]!, count: m.modules.parStatut[k] ?? 0 }))
    .concat(Object.entries(m.modules.parStatut).filter(([k]) => !ETATS_MODULES.includes(k)).map(([k, n]) => ({ key: k, label: STATUS[k]?.label ?? k, tone: STATUS[k]?.tone ?? 'neutral', count: n })));
  return (
    <ChartGrid min={280} label="Modules et arbitrages — graphiques">
      <Etats title="Fiches de module par étape du circuit" unitLabel="fiches" items={items} note="Fiche → programme → juridique → recette → comité → actif (maker-checker)." />
      <ProgressMeter label="Modules activés" value={m.modules.total ? (100 * m.modules.actifs) / m.modules.total : null} unit="%" format={(v) => fmtNombre(v, 0)} reason="Aucune fiche de module." />
      <Etats title="Arbitrages entre entités" unitLabel="dossiers" emptyText="Aucun arbitrage"
        items={[{ key: 'OUVERT', ...STATUS.OUVERT!, count: m.arbitrages.ouverts }, { key: 'INSTRUIT', ...STATUS.INSTRUIT!, count: m.arbitrages.instruits }, { key: 'DECIDE', ...STATUS.DECIDE!, count: m.arbitrages.decides }]} />
    </ChartGrid>
  );
}

export function Indicateurs74Visuels({ i, c }: {
  i: { envoyees: number; acceptees: number; tauxAcceptationPct: number | null; enAttente: number; expirees: number; refusees: number; revoquees: number; parLien: number; parOperateurAcces: number };
  c: { total: number; actifs: number; revoques: number; suspendus: number; enAttente: number };
}) {
  return (
    <ChartGrid min={280} label="Invitations et comptes — graphiques">
      <Etats title="Invitations par issue" unitLabel="invitations" emptyText="Aucune invitation"
        items={[
          { key: 'FINALISEE', ...STATUS.FINALISEE!, label: 'Acceptée', count: i.acceptees }, { key: 'ENVOYEE', ...STATUS.ENVOYEE!, label: 'En attente', count: i.enAttente },
          { key: 'EXPIREE', ...STATUS.EXPIREE!, count: i.expirees }, { key: 'REFUSEE', ...STATUS.REFUSEE!, count: i.refusees }, { key: 'REVOQUEE', ...STATUS.REVOQUEE!, count: i.revoquees },
        ]} />
      <GaugeMeter title="Taux d’acceptation des invitations" subtitle={`${i.acceptees} sur ${i.envoyees} envoyée(s)`} value={i.tauxAcceptationPct} unit="%" reason="Aucune invitation envoyée." />
      <Parts title="Finalisation : par lien ou par l’opérateur d’accès" centerLabel="finalisées" emptyText="Aucune invitation finalisée"
        slices={[{ key: 'lien', label: 'Par lien personnel', value: i.parLien }, { key: 'op', label: 'Par l’opérateur d’accès', value: i.parOperateurAcces }]} />
      <Etats title="Comptes de travail par état" unitLabel="comptes"
        items={[
          { key: 'ACTIF', ...STATUS.ACTIF!, count: c.actifs }, { key: 'ATTENTE', label: 'En attente', tone: 'warning', count: c.enAttente },
          { key: 'SUSPENDU', ...STATUS.SUSPENDU!, count: c.suspendus }, { key: 'REVOQUE', ...STATUS.REVOQUE!, count: c.revoques },
        ]} />
    </ChartGrid>
  );
}

// ————————————————————————— Entités, invitations —————————————————————————

export function EntitesVisuels({ ents }: { ents: EntityRow[] }) {
  const top = [...ents].sort((a, b) => b.accounts - a.accounts).slice(0, 10);
  return (
    <ChartGrid min={280} className="vz-bloc" label="Entités — graphiques">
      <Barres className="viz-span-2" title="Comptes de travail par entité" subtitle="10 entités les plus dotées" serie="Comptes"
        rows={top.map((e) => ({ key: e.id, label: e.shortName || e.name, values: { n: e.accounts } }))} />
      <Etats title="Entités par état" unitLabel="entités" items={etatsDe(ents, (e) => e.status, STATUS, ['ACTIVE', 'SUSPENDUE'])} />
    </ChartGrid>
  );
}

export function InvitationsVisuels({ items }: { items: InvitationRow[] }) {
  return (
    <ChartGrid min={280} className="vz-bloc" label="Invitations — graphiques">
      <ActiviteParJour className="viz-span-2" title="Invitations envoyées et finalisées"
        series={[{ key: 'env', label: 'Envoyées', items: items.map((x) => ({ at: x.createdAt })) }, { key: 'fin', label: 'Finalisées', items: items.filter((x) => x.finalizedAt).map((x) => ({ at: x.finalizedAt })) }]} />
      <Barres title="Invitations par niveau d’accès" serie="Invitations" rows={barresDe(countBy(items, (x) => x.accessLevelLabel || x.accessLevel))} />
    </ChartGrid>
  );
}

// ————————————————————————— Arbitrages —————————————————————————

/** Comptes par marche du circuit d'arbitrage (chaque marche compte les dossiers qui l'ont atteinte). */
export function circuitArbitrage(items: Arbitration[]) {
  return {
    bloques: items.length,
    avis: items.filter((a) => a.opinion).length,
    decides: items.filter((a) => a.status === 'DECIDE').length,
    rectifications: items.filter((a) => a.decision?.rectificationRequired).length,
  };
}

export function ArbitragesVisuels({ items }: { items: Arbitration[] }) {
  const c = circuitArbitrage(items);
  return (
    <ChartGrid min={280} className="vz-bloc" label="Arbitrages — graphiques">
      <Etats title="Dossiers d’arbitrage par état" unitLabel="dossiers" items={etatsDe(items, (a) => a.status, STATUS, ['OUVERT', 'INSTRUIT', 'DECIDE'])} emptyText="Aucun dossier dans votre périmètre" />
      <Barres title="Avancement dans le circuit" serie="Dossiers"
        rows={[
          { key: 'b', label: 'Seconde revendication bloquée', values: { n: c.bloques } }, { key: 'a', label: 'Avis juridique rendu', values: { n: c.avis } },
          { key: 'd', label: 'Décision motivée', values: { n: c.decides } }, { key: 'r', label: 'Rectification par réclamation', values: { n: c.rectifications } },
        ]} emptyText="Aucun dossier" />
      <Parts title="Objet des litiges" centerLabel="dossiers" emptyText="Aucun dossier"
        slices={countBy(items, (a) => (a.kind === 'FAIT_GENERATEUR' ? FACT_LABEL[a.subject.factCode ?? ''] ?? 'Fait générateur' : 'Compétence de module')).map((r) => ({ key: r.key, label: r.key, value: r.count }))} />
    </ChartGrid>
  );
}

// ————————————————————————— Consultation motivée —————————————————————————

export function ConsultationsVisuels({ items }: { items: Consultation[] }) {
  const revue = (c: Consultation) => (c.review ? (c.review.conclusion === 'JUSTIFIEE' ? 'J' : 'I') : c.mode === 'BRIS_DE_GLACE' ? 'A' : 'P');
  return (
    <ChartGrid min={280} className="vz-bloc" label="Consultations — graphiques">
      <Parts title="Consultations par mode" centerLabel="consultations" emptyText="Aucune consultation"
        slices={[{ key: 'p', label: 'Dans le périmètre', value: items.filter((c) => c.mode === 'PERIMETRE').length }, { key: 'b', label: 'Bris de glace', value: items.filter((c) => c.mode === 'BRIS_DE_GLACE').length }]} />
      <Etats title="Revue des consultations" unitLabel="consultations" emptyText="Aucune consultation"
        items={etatsDe(items, revue, { A: { label: 'Bris de glace à revoir', tone: 'warning' }, J: { label: 'Justifiée', tone: 'good' }, I: { label: 'Injustifiée', tone: 'critical' }, P: { label: 'Périmètre (journalisée)', tone: 'info' } }, ['A', 'J', 'I', 'P'])} />
      <Barres title="Consultations par finalité" serie="Consultations" rows={barresDe(countBy(items, (c) => c.purpose), PURPOSE_LABEL)} emptyText="Aucune consultation" />
      <ActiviteParJour title="Consultations accordées" series={[{ key: 'c', label: 'Consultations', items: items.map((c) => ({ at: c.grantedAt })) }]} />
    </ChartGrid>
  );
}

// ————————————————————————— Délégations —————————————————————————

const DELEG: Record<string, { label: string; tone: Tone }> = {
  PROPOSEE: { label: 'Proposée', tone: 'warning' }, ACTIVE: { label: 'Active', tone: 'good' }, TERMINEE: { label: 'Terminée', tone: 'neutral' }, REFUSEE: { label: 'Refusée', tone: 'neutral' }, EXPIREE: { label: 'Échue', tone: 'neutral' },
};
export const DELEGATION_STATUS = DELEG;
const DETECT: Record<string, string> = { CONFLIT_INTERETS: 'Conflit d’intérêts', COMPTE_PARTAGE: 'Compte partagé', PRIVILEGE_EXCESSIF: 'Privilège excessif' };

export function DelegationsVisuels({ delegations, detections }: { delegations: { status: string }[]; detections: { kind: string; severity: string }[] }) {
  return (
    <ChartGrid min={280} className="vz-bloc" label="Délégations — graphiques">
      <Etats title="Délégations par état" unitLabel="délégations" items={etatsDe(delegations, (d) => d.status, DELEG, ['PROPOSEE', 'ACTIVE', 'TERMINEE'])} emptyText="Aucune délégation" />
      <Barres title="Détections à examiner" serie="Détections" rows={barresDe(countBy(detections, (d) => d.kind), DETECT)} emptyText="Aucune détection" note="Aucune sanction automatique." />
    </ChartGrid>
  );
}

// ————————————————————————— Élévations juste-à-temps —————————————————————————

export function ElevationsVisuels({ items, statuts }: { items: { status: string; roleLabel: string; actions: number; requestedAt: string }[]; statuts: Record<string, readonly [string, Tone]> }) {
  const actives = items.filter((e) => e.status === 'ACTIVE').length;
  const s = serieParJour(items, (e) => e.requestedAt, 14);
  return (
    <div className="vz-bloc">
      <KpiGrid max={4} label="Élévations — chiffres clés">
        <KpiTile hero label="Élévations actives" value={actives} state={{ label: actives ? 'Session enregistrée' : 'Aucune session ouverte', tone: actives ? 'serious' : 'good' }}
          spark={{ values: s.values, labels: s.labels, label: 'Demandes par jour (14 jours)' }} />
        <KpiTile label="Demandes en attente" value={items.filter((e) => e.status === 'DEMANDEE').length} state={{ label: 'Décision du responsable sécurité', tone: 'warning' }} />
        <KpiTile label="Actions enregistrées" value={items.reduce((n, e) => n + e.actions, 0)} sub="toutes sessions confondues" />
        <KpiTile label="Élévations au total" value={items.length} />
      </KpiGrid>
      <ChartGrid min={280} label="Élévations — graphiques">
        <Etats title="Élévations par état" unitLabel="élévations" items={etatsDe(items, (e) => e.status, statuts, ['DEMANDEE', 'ACTIVE', 'EXPIREE', 'TERMINEE', 'REVOQUEE', 'REFUSEE'])} emptyText="Aucune élévation" />
        <Barres title="Élévations par rôle temporaire" serie="Élévations" rows={barresDe(countBy(items, (e) => e.roleLabel))} emptyText="Aucune élévation" />
      </ChartGrid>
    </div>
  );
}

// ————————————————————————— Registre d'identité —————————————————————————

export function IdentiteVisuels({ proofs, candidates, merges }: { proofs: { type: string }[] | null; candidates: { reasons: string[]; nameOnly: boolean; merge?: unknown }[] | null; merges: { status: string }[] | null }) {
  return (
    <ChartGrid min={280} className="vz-bloc" label="Registre d’identité — graphiques">
      {proofs && <Barres title="Pièces à contrôler par nature" serie="Pièces" rows={barresDe(countBy(proofs, (p) => p.type), PROOF_LABEL)} emptyText="Aucune pièce en attente" />}
      {candidates && <Barres title="Doublons probables par motif" serie="Rapprochements" rows={barresDe(countBy(candidates.flatMap((c) => c.reasons.map((r) => ({ r }))), (x) => x.r), REASON_LABEL)} emptyText="Aucun doublon probable" note="Un nom proche ne suffit jamais : aucune fusion automatique." />}
      {merges && <Etats title="Fusions par état" unitLabel="fusions" items={etatsDe(merges, (m) => m.status, STATUS, ['PROPOSEE', 'VERIFIEE', 'EFFECTUEE', 'ANNULEE', 'REJETEE'])} emptyText="Aucune fusion" />}
    </ChartGrid>
  );
}

// ————————————————————————— Mandats —————————————————————————

export function MandatsVisuels({ items }: { items: Mandate[] }) {
  const actions = Object.keys(MANDATE_ACTION_LABEL).map((k) => ({ key: k, label: MANDATE_ACTION_LABEL[k]!, values: { n: items.filter((m) => m.status === 'ACTIF' && m.scope.includes(k)).length } }));
  return (
    <ChartGrid min={280} className="vz-bloc" label="Mandats — graphiques">
      <Etats title="Mandats par état" unitLabel="mandats" items={etatsDe(items, (m) => m.status, STATUS, ['ACTIF', 'EXPIRE', 'REVOQUE'])} emptyText="Aucun mandat" />
      <Barres title="Actions confiées (mandats actifs)" serie="Mandats" rows={actions} emptyText="Aucun mandat actif" />
      <TimelineStrip className="viz-span-2" title="Fin de validité des mandats" categories={['Mandataire de confiance', 'Tiers professionnel']} emptyText="Aucun mandat"
        events={items.map((m) => ({ id: m.id, at: m.validTo, category: m.kind === 'PROFESSIONNEL' ? 'Tiers professionnel' : 'Mandataire de confiance', label: `${m.mandataireName} ← ${m.mandantName}` }))} />
    </ChartGrid>
  );
}

// ————————————————————————— Finalisation d'une invitation —————————————————————————

/** Progression du parcours de finalisation (étapes remplies par la personne invitée, sur cet appareil). */
export function EtapesInvitation({ f }: { f: { phone: string; code: string; docNumber: string; photo: boolean; mfa: string } }) {
  const etapes = [f.phone.replace(/\D/g, '').length >= 9, f.code.length === 6, f.docNumber.trim().length >= 3, f.photo, !!f.mfa];
  const faites = etapes.filter(Boolean).length;
  return (
    <ProgressMeter label="Étapes de finalisation remplies" value={faites} max={etapes.length} unit={`/ ${etapes.length}`} format={(v) => fmtNombre(v, 0)}
      tone={faites === etapes.length ? 'good' : 'info'} toneLabel={faites === etapes.length ? 'Prêt à finaliser' : 'Téléphone, code, pièce, photo, second facteur'} />
  );
}


