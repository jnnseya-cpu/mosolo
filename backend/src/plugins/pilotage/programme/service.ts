/**
 * Conduite du programme (Cahier nouvelle version, ch. 35 à 37) : feuille de route par phases et portes de sortie,
 * plans d'action datés, modèle opérationnel (postes, binômes provinciaux, calendriers de transfert) et gouvernance
 * du programme (instances, réunions consignées, retards de réunion).
 * L'outil suit et prouve ; une personne décide : aucune porte n'est franchie automatiquement, la décision est prise
 * par une personne distincte du demandeur (assertDistinctPerson), motivée et rattachée à une réunion consignée du
 * comité de pilotage. Chaque écriture est journalisée.
 */
import { ROLES } from '@mosolo/shared';
import type { AppContext } from '../../../context.js';
import { ACR, requireAcr, type User } from '../../../core/auth.js';
import { kinshasaDay } from '../../../core/clock.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../../core/policy.js';
import { addDays } from '../planification/model.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../../core/repository.js';
import {
  ACTION_STATUS_LABELS, actionDef, BODIES, bodyDef, FUNCTIONS, HORIZONS, horizonDueDate, isOverdue, meetingOverdue, overdueMilestones, PAR_DEFAUT, PHASE_STATE_LABELS,
  phaseDef, PHASES, POSTE_A_POURVOIR, PRINCIPE_EXPLOITATION, RULE_STATUSES_AWAITING, transferComplete,
  type ActionStatus, type Pairing, type PhaseState,
} from './model.js';

interface Proof { reference: string; sha256: string }
interface ProgrammeConfig { id: string; startDate: string; setBy: string; setAt: string; motif: string; history: { at: string; by: string; startDate: string; motif: string }[] }
interface PhaseRecord { id: string; state: PhaseState; startedAt?: string; startedBy?: string; history: { at: string; by: string; state: PhaseState; motif?: string }[] }
interface DeliverableProof { id: string; phase: string; livrable: string; reference: string; sha256: string; note?: string; by: string; at: string }
interface GateRequest {
  id: string; phase: string; requestedBy: string; requestedAt: string; motif: string; proofIds: string[];
  status: 'DEMANDEE' | 'FRANCHIE' | 'REFUSEE';
  decision?: { by: string; at: string; approve: boolean; motif: string; meetingId: string };
}
interface ActionRecord { id: string; owner: string | null; status: ActionStatus; proof: (Proof & { by: string; at: string }) | null; note?: string; history: { at: string; by: string; status: ActionStatus; owner: string | null; note?: string }[] }
interface Post { id: string; functionCode: string; roleLabel: string; holderLabel: string; external: boolean; createdBy: string; createdAt: string; example?: boolean; pairing?: Pairing }
interface Meeting {
  id: string; body: string; date: string; attendees: string[]; agenda: string[]; minutes: Proof; decisions: string[]; ruleVersionIds: string[];
  recordedBy: string; recordedAt: string; example?: boolean;
}

const ROLE_LABELS = new Set<string>(Object.values(ROLES));
const PROGRAMME_ID = 'PROGRAMME';

export class ProgrammeService {
  readonly config = new InMemoryRepository<ProgrammeConfig>();
  readonly phases = new InMemoryRepository<PhaseRecord>();
  readonly proofs = new InMemoryAppendOnlyRepository<DeliverableProof>();
  readonly gates = new InMemoryRepository<GateRequest>();
  readonly actions = new InMemoryRepository<ActionRecord>();
  readonly posts = new InMemoryRepository<Post>();
  readonly meetings = new InMemoryAppendOnlyRepository<Meeting>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext) {}

  private now(): string { return this.ctx.clock.now().toISOString(); }
  private today(): string { return kinshasaDay(this.now()); }
  private gate(user: User, action: string) { authorize(user, `planification:programme.${action}`); }
  private audit(user: User | { kind: 'system'; id: string }, action: string, resourceType: string, resourceId: string, details: Record<string, unknown> = {}) {
    const actor = 'roles' in user ? { kind: 'user' as const, id: user.id, roles: user.roles } : { kind: user.kind, id: user.id };
    this.ctx.audit.append({ actor, action, resourceType, resourceId, details });
  }

  private startDate(): string | null { return this.config.get(PROGRAMME_ID)?.startDate ?? null; }
  private phaseRecord(code: string): PhaseRecord { return this.phases.get(code) ?? { id: code, state: 'A_VENIR', history: [] }; }
  private savePhase(p: PhaseRecord): PhaseRecord { return this.phases.get(p.id) ? this.phases.update(p) : this.phases.insert(p); }
  private actionRecord(code: string): ActionRecord { return this.actions.get(code) ?? { id: code, owner: null, status: 'A_FAIRE', proof: null, history: [] }; }

  // ————————————————————————— § 35.2 date de démarrage —————————————————————————

  /** Date de démarrage du programme, saisie par une personne (aucune date par défaut). Modifiable, avec historique. */
  setStartDate(user: User, input: { startDate: string; motif: string }) {
    this.gate(user, 'write');
    const prev = this.config.get(PROGRAMME_ID);
    const entry = { at: this.now(), by: user.id, startDate: input.startDate, motif: input.motif };
    const rec: ProgrammeConfig = { id: PROGRAMME_ID, startDate: input.startDate, setBy: user.id, setAt: entry.at, motif: input.motif, history: [...(prev?.history ?? []), entry] };
    const out = prev ? this.config.update(rec) : this.config.insert(rec);
    this.audit(user, 'pilotage.programme.start_date_set', 'programme', PROGRAMME_ID, { startDate: input.startDate, previous: prev?.startDate ?? null, motif: input.motif });
    return out;
  }

  // ————————————————————————— § 35.1 phases et portes —————————————————————————

  /** Démarrage d'une phase : garde de séquence — la porte de la phase précédente doit être FRANCHIE. */
  startPhase(user: User, code: string, motif: string) {
    this.gate(user, 'write');
    const def = phaseDef(code);
    if (!def) throw notFound('PHASE_NOT_FOUND', `Phase inconnue : ${code}.`);
    const rec = this.phaseRecord(code);
    if (rec.state !== 'A_VENIR') throw conflict('PHASE_DEJA_DEMARREE', `${def.label} : état ${PHASE_STATE_LABELS[rec.state]}.`);
    if (def.rank > 0) {
      const prev = PHASES[def.rank - 1]!;
      const prevState = this.phaseRecord(prev.code).state;
      if (prevState !== 'FRANCHIE') {
        throw conflict('PHASE_PRECEDENTE_NON_FRANCHIE', `${def.label} ne peut démarrer : la porte de sortie de « ${prev.label} » n’est pas franchie (état : ${PHASE_STATE_LABELS[prevState]}).`, { previous: prev.code, previousState: prevState });
      }
    }
    const at = this.now();
    const out = this.savePhase({ ...rec, state: 'EN_COURS', startedAt: at, startedBy: user.id, history: [...rec.history, { at, by: user.id, state: 'EN_COURS', motif }] });
    this.audit(user, 'pilotage.roadmap.phase_started', 'phase', code, { motif });
    return out;
  }

  /** Preuve d'un livrable : référence du document et empreinte SHA-256, déposées par une personne. */
  addProof(user: User, code: string, input: { livrable: string; reference: string; sha256: string; note?: string }) {
    this.gate(user, 'write');
    const def = phaseDef(code);
    if (!def) throw notFound('PHASE_NOT_FOUND', `Phase inconnue : ${code}.`);
    if (!def.livrables.some((l) => l.code === input.livrable)) throw badRequest('LIVRABLE_INCONNU', `Livrable inconnu pour ${def.label} : ${input.livrable}.`);
    const state = this.phaseRecord(code).state;
    if (state !== 'EN_COURS' && state !== 'REFUSEE') throw conflict('PHASE_NON_OUVERTE', `Preuves déposées sur une phase en cours (ou dont la porte a été refusée) ; état : ${PHASE_STATE_LABELS[state]}.`);
    const p = this.proofs.append({ id: this.ids.next('PRV'), phase: code, livrable: input.livrable, reference: input.reference, sha256: input.sha256, ...(input.note ? { note: input.note } : {}), by: user.id, at: this.now() });
    this.audit(user, 'pilotage.roadmap.proof_recorded', 'phase', code, { proofId: p.id, livrable: p.livrable, reference: p.reference, sha256: p.sha256 });
    return p;
  }

  /** Contrôle du modèle opérationnel à chaque porte : postes externes sans binôme, jalons de transfert en retard. */
  staffingCheck() {
    const today = this.today();
    const external = this.posts.find((p) => p.external);
    const sansBinome = external.filter((p) => !p.pairing).map((p) => ({ postId: p.id, functionCode: p.functionCode, roleLabel: p.roleLabel }));
    const jalonsEnRetard = external.flatMap((p) => overdueMilestones(p.pairing, today).map((m) => ({ postId: p.id, roleLabel: p.roleLabel, milestoneId: m.id, label: m.label, dueDate: m.dueDate })));
    return { ok: sansBinome.length === 0 && jalonsEnRetard.length === 0, sansBinome, jalonsEnRetard };
  }

  /** Demande de porte de sortie : liste des preuves ; refusée si un livrable n'a pas de preuve ou si le transfert n'est pas conforme. */
  requestGate(user: User, code: string, input: { proofIds: string[]; motif: string }) {
    this.gate(user, 'gate.request');
    const def = phaseDef(code);
    if (!def) throw notFound('PHASE_NOT_FOUND', `Phase inconnue : ${code}.`);
    const rec = this.phaseRecord(code);
    if (rec.state !== 'EN_COURS' && rec.state !== 'REFUSEE') throw conflict('PORTE_NON_DEMANDABLE', `${def.label} : état ${PHASE_STATE_LABELS[rec.state]}.`);
    const listed = input.proofIds.map((id) => this.proofs.get(id));
    const foreign = input.proofIds.filter((id, i) => !listed[i] || listed[i]!.phase !== code);
    if (foreign.length) throw badRequest('PREUVE_INCONNUE', `Preuves inconnues ou d’une autre phase : ${foreign.join(', ')}.`, { proofIds: foreign });
    const covered = new Set(listed.map((p) => p!.livrable));
    const missing = def.livrables.filter((l) => !covered.has(l.code));
    if (missing.length) {
      this.audit(user, 'pilotage.roadmap.gate_request_rejected', 'phase', code, { reason: 'LIVRABLES_SANS_PREUVE', missing: missing.map((m) => m.code) });
      throw unprocessable('LIVRABLES_SANS_PREUVE', `Porte refusée : livrables sans preuve — ${missing.map((m) => m.label).join(' ; ')}.`, { missing });
    }
    const staffing = this.staffingCheck();
    if (!staffing.ok) {
      this.audit(user, 'pilotage.roadmap.gate_request_rejected', 'phase', code, { reason: 'TRANSFERT_NON_CONFORME', sansBinome: staffing.sansBinome.map((p) => p.postId), jalonsEnRetard: staffing.jalonsEnRetard.map((m) => m.milestoneId) });
      throw conflict('TRANSFERT_NON_CONFORME',
        `Porte bloquée (principe de montée en autonomie) : ${staffing.sansBinome.length} poste(s) externe(s) sans agent provincial désigné et ${staffing.jalonsEnRetard.length} jalon(s) de transfert en retard. Aucune dérogation : désigner les binômes et régulariser les jalons avant de redemander la porte.`,
        { sansBinome: staffing.sansBinome, jalonsEnRetard: staffing.jalonsEnRetard });
    }
    const at = this.now();
    const g = this.gates.insert({ id: this.ids.next('PORTE'), phase: code, requestedBy: user.id, requestedAt: at, motif: input.motif, proofIds: [...new Set(input.proofIds)], status: 'DEMANDEE' });
    this.savePhase({ ...rec, state: 'PORTE_DEMANDEE', history: [...rec.history, { at, by: user.id, state: 'PORTE_DEMANDEE', motif: input.motif }] });
    this.audit(user, 'pilotage.roadmap.gate_requested', 'phase_gate', g.id, { phase: code, proofIds: g.proofIds, motif: input.motif });
    return g;
  }

  /**
   * Décision du comité de pilotage : personne distincte du demandeur, motivée, rattachée à une réunion consignée du
   * comité de pilotage tenue entre la demande et aujourd'hui. Jamais automatique.
   */
  decideGate(user: User, id: string, input: { approve: boolean; motif: string; meetingId: string }) {
    this.gate(user, 'gate.decide');
    const g = this.gates.get(id);
    if (!g) throw notFound('PORTE_NOT_FOUND', `Demande de porte inconnue : ${id}.`);
    if (g.status !== 'DEMANDEE') throw conflict('ALREADY_DECIDED', `Porte déjà ${g.status === 'FRANCHIE' ? 'franchie' : 'refusée'}.`);
    assertDistinctPerson(user.id, [g.requestedBy], 'La porte de sortie est décidée par une personne distincte de celle qui l’a demandée (comité de pilotage).');
    requireAcr(user, ACR.MFA);
    const m = this.meetings.get(input.meetingId);
    if (!m || m.body !== 'COMITE_PILOTAGE') throw unprocessable('REUNION_COMITE_PILOTAGE_REQUISE', 'La décision doit référencer une réunion consignée du comité de pilotage.');
    if (m.date < kinshasaDay(g.requestedAt)) throw unprocessable('REUNION_ANTERIEURE_A_LA_DEMANDE', `La réunion du ${m.date} précède la demande de porte (${kinshasaDay(g.requestedAt)}).`);
    if (input.approve) {
      const staffing = this.staffingCheck();
      if (!staffing.ok) throw conflict('TRANSFERT_NON_CONFORME', 'Le contrôle du modèle opérationnel n’est plus satisfait : porte non franchissable en l’état.', { sansBinome: staffing.sansBinome, jalonsEnRetard: staffing.jalonsEnRetard });
    }
    const at = this.now();
    const decision = { by: user.id, at, approve: input.approve, motif: input.motif, meetingId: m.id };
    const out = this.gates.update({ ...g, status: input.approve ? 'FRANCHIE' : 'REFUSEE', decision });
    const rec = this.phaseRecord(g.phase);
    const state: PhaseState = input.approve ? 'FRANCHIE' : 'REFUSEE';
    this.savePhase({ ...rec, state, history: [...rec.history, { at, by: user.id, state, motif: input.motif }] });
    this.audit(user, input.approve ? 'pilotage.roadmap.gate_passed' : 'pilotage.roadmap.gate_refused', 'phase_gate', g.id, { phase: g.phase, proposedBy: g.requestedBy, motif: input.motif, meetingId: m.id, meetingDate: m.date });
    return out;
  }

  // ————————————————————————— § 35.2 actions datées —————————————————————————

  updateAction(user: User, code: string, input: { owner?: string; status?: ActionStatus; proof?: Proof; note?: string }) {
    this.gate(user, 'write');
    const def = actionDef(code);
    if (!def) throw notFound('ACTION_NOT_FOUND', `Action inconnue : ${code}.`);
    const rec = this.actionRecord(code);
    const at = this.now();
    const proof = input.proof ? { ...input.proof, by: user.id, at } : rec.proof;
    const status = input.status ?? rec.status;
    if (status === 'REALISEE' && !proof) throw unprocessable('PREUVE_REQUISE', `« ${def.action.label} » : une preuve de réalisation (référence et empreinte SHA-256) est requise.`);
    const owner = input.owner ?? rec.owner;
    const next: ActionRecord = { ...rec, owner, status, proof, ...(input.note ? { note: input.note } : {}), history: [...rec.history, { at, by: user.id, status, owner, ...(input.note ? { note: input.note } : {}) }] };
    const out = this.actions.get(code) ? this.actions.update(next) : this.actions.insert(next);
    this.audit(user, 'pilotage.roadmap.action_updated', 'roadmap_action', code, { horizon: def.horizon.code, status, owner, ...(input.proof ? { proofReference: input.proof.reference, proofSha256: input.proof.sha256 } : {}) });
    return out;
  }

  // ————————————————————————— ch. 36 postes, binômes, transfert —————————————————————————

  createPost(user: User, input: { functionCode: string; roleLabel: string; holderLabel?: string; external?: boolean }) {
    this.gate(user, 'write');
    const f = FUNCTIONS.find((x) => x.code === input.functionCode);
    if (!f) throw badRequest('FONCTION_INCONNUE', `Fonction inconnue : ${input.functionCode}.`);
    const p = this.posts.insert({
      id: this.ids.next('POSTE'), functionCode: f.code, roleLabel: input.roleLabel, holderLabel: input.holderLabel ?? POSTE_A_POURVOIR,
      external: input.external ?? f.externeParDefaut, createdBy: user.id, createdAt: this.now(),
    });
    this.audit(user, 'pilotage.operating_model.post_created', 'programme_post', p.id, { functionCode: p.functionCode, roleLabel: p.roleLabel, external: p.external });
    return p;
  }

  /** Binôme : agent provincial désigné et calendrier de transfert écrit (au moins un jalon daté). */
  designatePair(user: User, id: string, input: { agentLabel: string; agentUserId?: string; motif: string; calendar: { label: string; dueDate: string }[] }) {
    this.gate(user, 'write');
    const p = this.posts.get(id);
    if (!p) throw notFound('POSTE_NOT_FOUND', `Poste inconnu : ${id}.`);
    if (!p.external) throw conflict('POSTE_NON_EXTERNE', 'Le binôme provincial concerne les postes externes.');
    if (input.agentUserId) {
      const u = this.ctx.users.get(input.agentUserId);
      if (!u || !u.roles.some((r) => /^R(0[1-9]|1\d|2\d)$/.test(r))) throw unprocessable('AGENT_PROVINCIAL_REQUIS', 'Le binôme est un agent public provincial (rôles R01 à R29).');
    }
    const calendar = input.calendar.map((m) => ({ id: this.ids.next('JALON'), label: m.label, dueDate: m.dueDate }));
    const pairing: Pairing = { agentLabel: input.agentLabel, ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}), designatedBy: user.id, designatedAt: this.now(), motif: input.motif, calendar };
    const out = this.posts.update({ ...p, pairing });
    this.audit(user, 'pilotage.operating_model.pair_designated', 'programme_post', p.id, { agentLabel: input.agentLabel, milestones: calendar.map((m) => ({ id: m.id, dueDate: m.dueDate })), replaced: !!p.pairing, motif: input.motif });
    return out;
  }

  completeMilestone(user: User, id: string, milestoneId: string, proof: Proof) {
    this.gate(user, 'write');
    const p = this.posts.get(id);
    if (!p?.pairing) throw notFound('BINOME_NOT_FOUND', `Aucun binôme sur le poste ${id}.`);
    const m = p.pairing.calendar.find((x) => x.id === milestoneId);
    if (!m) throw notFound('JALON_NOT_FOUND', `Jalon inconnu : ${milestoneId}.`);
    if (m.done) throw conflict('JALON_DEJA_REALISE', 'Jalon déjà réalisé.');
    const done = { at: this.now(), by: user.id, reference: proof.reference, sha256: proof.sha256 };
    const out = this.posts.update({ ...p, pairing: { ...p.pairing, calendar: p.pairing.calendar.map((x) => (x.id === milestoneId ? { ...x, done } : x)) } });
    this.audit(user, 'pilotage.operating_model.transfer_milestone_done', 'programme_post', p.id, { milestoneId, reference: proof.reference, sha256: proof.sha256, late: m.dueDate < this.today() });
    return out;
  }

  // ————————————————————————— ch. 37 gouvernance —————————————————————————

  /** Réunion consignée : date, participants par rôle, ordre du jour, procès-verbal (référence + SHA-256), décisions. */
  recordMeeting(user: User, input: { body: string; date: string; attendees: string[]; agenda: string[]; minutes: Proof; decisions: string[]; ruleVersionIds?: string[] }) {
    this.gate(user, 'meeting.record');
    const b = bodyDef(input.body);
    if (!b) throw badRequest('INSTANCE_INCONNUE', `Instance inconnue : ${input.body}.`);
    if (!user.roles.some((r) => b.secretariat.includes(r))) {
      throw forbidden('SECRETARIAT_INSTANCE', `Consignation réservée au secrétariat de l’instance « ${b.label} » (${b.secretariat.join(', ')}).`);
    }
    if (input.date > this.today()) throw badRequest('REUNION_FUTURE', 'Une réunion est consignée une fois tenue (date passée ou du jour).');
    const allowed = new Set([...b.composition, ...ROLE_LABELS]);
    const unknown = input.attendees.filter((a) => !allowed.has(a));
    if (unknown.length) throw badRequest('PARTICIPANT_PAR_ROLE', `Participants consignés par rôle seulement (composition de l’instance ou rôles de la plateforme) : ${unknown.join(', ')}.`);
    const ruleVersionIds = [...new Set(input.ruleVersionIds ?? [])];
    if (ruleVersionIds.length && b.code !== 'COMITE_JURIDIQUE_TARIFAIRE') throw badRequest('VERSIONS_HORS_INSTANCE', 'Seul le comité juridique et tarifaire examine les versions de règles.');
    const unknownRules = ruleVersionIds.filter((rid) => !this.ctx.rules.rules.get(rid));
    if (unknownRules.length) throw badRequest('VERSION_REGLE_INCONNUE', `Versions de règles inconnues : ${unknownRules.join(', ')}.`);
    const m = this.meetings.append({
      id: this.ids.next('REUNION'), body: b.code, date: input.date, attendees: input.attendees, agenda: input.agenda, minutes: input.minutes, decisions: input.decisions,
      ruleVersionIds, recordedBy: user.id, recordedAt: this.now(),
    });
    this.audit(user, 'pilotage.governance.meeting_recorded', 'governance_meeting', m.id, { body: b.code, date: m.date, minutesReference: m.minutes.reference, minutesSha256: m.minutes.sha256, decisions: m.decisions.length, ruleVersionIds });
    return m;
  }

  /** Versions de règles en attente de validation et leur rattachement à une réunion du comité juridique et tarifaire. */
  private awaitingRules() {
    const linked = new Map<string, string[]>();
    for (const m of this.meetings.find((x) => x.body === 'COMITE_JURIDIQUE_TARIFAIRE')) for (const r of m.ruleVersionIds) linked.set(r, [...(linked.get(r) ?? []), m.id]);
    return this.ctx.rules.list()
      .filter((r) => (RULE_STATUSES_AWAITING as readonly string[]).includes(r.status))
      .map((r) => ({ id: r.id, code: r.code, version: r.version, label: r.label, status: r.status, meetings: linked.get(r.id) ?? [], linked: linked.has(r.id) }));
  }

  governanceView(user: User) {
    this.gate(user, 'read');
    const today = this.today();
    const all = this.meetings.all().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.recordedAt < b.recordedAt ? 1 : -1));
    const gateByMeeting = new Map<string, { gateId: string; phase: string; approve: boolean }[]>();
    for (const g of this.gates.all()) if (g.decision) gateByMeeting.set(g.decision.meetingId, [...(gateByMeeting.get(g.decision.meetingId) ?? []), { gateId: g.id, phase: g.phase, approve: g.decision.approve }]);
    const rules = this.awaitingRules();
    const bodies = BODIES.map((b) => {
      const mine = all.filter((m) => m.body === b.code);
      const last = mine[0]?.date ?? null;
      const overdue = meetingOverdue(b.delaiJours, last, today);
      const unlinked = b.code === 'COMITE_JURIDIQUE_TARIFAIRE' ? rules.filter((r) => !r.linked) : [];
      return {
        ...b, lastMeetingDate: last, meetingCount: mine.length,
        nextDueDate: b.delaiJours !== null && last ? addDays(last, b.delaiJours) : null,
        overdue, flag: b.delaiJours === null ? (unlinked.length ? `${unlinked.length} version(s) de règle en attente sans réunion du comité` : null) : overdue ? (last ? 'Réunion en retard' : 'Aucune réunion consignée') : null,
        ...(b.code === 'COMITE_JURIDIQUE_TARIFAIRE' ? { versionsEnAttente: rules } : {}),
      };
    });
    return {
      today, delaisNote: `Délais de périodicité (7, 31 et 92 jours) : ${PAR_DEFAUT}.`,
      bodies, meetings: all.map((m) => ({ ...m, gateDecisions: gateByMeeting.get(m.id) ?? [] })),
    };
  }

  // ————————————————————————— vues —————————————————————————

  roadmapView(user: User) {
    this.gate(user, 'read');
    const today = this.today();
    const start = this.startDate();
    const cfg = this.config.get(PROGRAMME_ID) ?? null;
    const phases = PHASES.map((d) => {
      const rec = this.phaseRecord(d.code);
      const proofs = this.proofs.find((p) => p.phase === d.code);
      const gates = this.gates.find((g) => g.phase === d.code).sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
      const prev = d.rank > 0 ? this.phaseRecord(PHASES[d.rank - 1]!.code).state : 'FRANCHIE';
      return {
        ...d, state: rec.state, stateLabel: PHASE_STATE_LABELS[rec.state], startedAt: rec.startedAt ?? null, canStart: rec.state === 'A_VENIR' && prev === 'FRANCHIE',
        livrables: d.livrables.map((l) => ({ ...l, proofs: proofs.filter((p) => p.livrable === l.code) })),
        gates, history: rec.history,
      };
    });
    const horizons = HORIZONS.map((h) => {
      const dueDate = horizonDueDate(h, start);
      const actions = h.actions.map((a) => {
        const r = this.actionRecord(a.code);
        return { ...a, owner: r.owner, status: r.status, statusLabel: ACTION_STATUS_LABELS[r.status], proof: r.proof, note: r.note ?? null, dueDate, overdue: isOverdue(dueDate, today, r.status) };
      });
      return { ...h, dueDate, actions, overdueCount: actions.filter((a) => a.overdue).length, doneCount: actions.filter((a) => a.status === 'REALISEE').length };
    });
    const staffing = this.staffingCheck();
    const overdueActions = horizons.flatMap((h) => h.actions.filter((a) => a.overdue).map((a) => ({ horizon: h.label, code: a.code, label: a.label, dueDate: a.dueDate })));
    return {
      today, programme: { startDate: start, setBy: cfg?.setBy ?? null, setAt: cfg?.setAt ?? null, history: cfg?.history ?? [], note: start ? null : 'Date de démarrage du programme non saisie : les échéances des horizons ne sont pas calculées.' },
      phases, horizons, overdueActions, staffing,
      rule: 'Une porte de sortie est demandée par une personne (preuves listées) et décidée par une autre, membre du comité de pilotage, lors d’une réunion consignée ; jamais automatiquement.',
    };
  }

  operatingModelView(user: User) {
    this.gate(user, 'read');
    const today = this.today();
    const posts = this.posts.all().map((p) => ({
      ...p, transferComplete: transferComplete(p.pairing), overdueMilestones: overdueMilestones(p.pairing, today).map((m) => m.id),
      progress: p.pairing ? { done: p.pairing.calendar.filter((m) => m.done).length, total: p.pairing.calendar.length } : null,
    }));
    const ext = posts.filter((p) => p.external);
    const done = ext.filter((p) => p.transferComplete).length;
    return {
      today, principe: PRINCIPE_EXPLOITATION, effectifsNote: 'Effectifs indicatifs au pilote (texte du Cahier) : non contractuels.',
      functions: FUNCTIONS.map((f) => ({ ...f, posts: posts.filter((p) => p.functionCode === f.code) })),
      autonomy: { externalPosts: ext.length, transferred: done, sharePct: ext.length ? ((done * 1000 / ext.length | 0) / 10).toFixed(1) : null, note: ext.length ? 'Part des postes externes dont le transfert est achevé (tous les jalons réalisés avec preuve).' : 'Aucun poste externe enregistré : indicateur non mesuré.' },
      staffing: this.staffingCheck(),
    };
  }

  // ————————————————————————— démonstration —————————————————————————

  /** Registre des postes de démonstration : libellés de rôles seulement, « Poste à pourvoir », non contractuel. */
  seedDemo(): void {
    if (this.posts.count() > 0) return;
    const demo = { kind: 'system' as const, id: 'seed:programme' };
    const at = this.now();
    const mk = (functionCode: string, roleLabel: string, external: boolean) => this.posts.insert({
      id: this.ids.next('POSTE'), functionCode, roleLabel: `[EXEMPLE] ${roleLabel}`, holderLabel: POSTE_A_POURVOIR, external, createdBy: demo.id, createdAt: at, example: true,
    });
    mk('DIRECTION_PROGRAMME', 'Directeur de programme', false);
    mk('DIRECTION_PROGRAMME', 'Directeur adjoint', false);
    mk('REFERENTIEL_JURIDIQUE', 'Juriste', false);
    mk('REFERENTIEL_JURIDIQUE', 'Tarificateur', false);
    mk('INGENIERIE', 'Architecte (prestataire)', true);
    mk('INGENIERIE', 'Développeur (prestataire)', true);
    mk('INGENIERIE', 'Spécialiste données spatiales (prestataire)', true);
    mk('SECURITE_AUDIT_TECHNIQUE', 'Responsable sécurité', false);
    mk('TRESORERIE_RAPPROCHEMENT', 'Comptable public dédié', false);
    this.ctx.audit.append({ actor: demo, action: 'pilotage.operating_model.demo_seeded', resourceType: 'programme_post', resourceId: 'EXEMPLE', details: { count: this.posts.count(), note: '[EXEMPLE] non contractuel — Poste à pourvoir' } });
  }
}
