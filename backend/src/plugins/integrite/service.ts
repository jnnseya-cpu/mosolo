/**
 * Service du module Intégrité. Chaque méthode d'écriture vérifie elle-même l'habilitation (`authorize`),
 * ce qui applique aussi la garde de l'IA (un agent d'IA ne qualifie, ne clôt ni ne décide rien).
 */
import { Money, ROLES, type CurrencyCode, type RoleCode } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { Principal, User } from '../../core/auth.js';
import { sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { authorize, assertDistinctPerson, evaluate } from '../../core/policy.js';
import { InMemoryRepository } from '../../core/repository.js';
import type { Recipient } from '../../modules/communications/service.js';
import { taxpayerRecipient, userRecipient } from '../../modules/identity/recipients.js';
import { assertNotImplicated, DAY, DELAYS, haversineKm, HOUR, hoursBetween, Kit, normalizeCode } from './common.js';
import {
  REPORT_CATEGORY_LABELS,
  type AccessReviewCampaign, type AlertVariable, type CaseDecision, type CaseEvent, type CaseFinding, type EvidenceRef, type FraudAlert,
  type FraudCase, type Incident, type IncidentCategory, type IncidentStatus, type MysteryCheck, type MysteryFollowUp, type MysteryResult,
  type MysteryTarget, type NotificationTarget, type Observation, type PrivacyRequest, type PrivacyRequestType, type ProcessingRecord,
  type RectifiableField, type Report, type ReportCategory, type ReportChannel, type ReportOutcome, type Severity, type TargetKind,
} from './types.js';

/* ------------------------------------------------------------------ */
/* Entrées                                                             */
/* ------------------------------------------------------------------ */

export interface ReportInput {
  category: ReportCategory;
  description: string;
  commune?: string;
  place?: string;
  occurredOn?: string;
  target?: { kind: TargetKind; reference?: string };
  anonymous: boolean;
  contact?: { name?: string; phone?: string; email?: string };
  evidence?: { sha256: string; label: string }[];
}

/** Paramètres des règles de détection (DÉMONSTRATION, paramétrables par le comité anti-fraude). */
export const DETECTION_PARAMS = {
  demo: true,
  distantVerificationKm: 20,
  distantVerificationWindowMin: 120,
  repeatedVerificationCount: 5,
  repeatedVerificationWindowH: 24,
  splitPaymentCount: 3,
  splitPaymentWindowH: 24,
  multipleReportsCount: 2,
  multipleReportsWindowDays: 90,
  deniedAccessCount: 5,
  deniedAccessWindowH: 24,
  sensitiveConcentrationMin: 3,
  sensitiveConcentrationShare: 0.6,
  sensitiveWindowDays: 30,
  mysteryNonConformityMin: 2,
} as const;

/**
 * Actes sensibles suivis par la détection de concentration (journal d'audit). Clé = action, ou `action:kind` quand
 * l'action est générique et que `details.kind` précise l'opération (ex. opération du Trésor CONTRE_ECRITURE).
 * Toute réduction de recette (remise, exonération, correction, recalcul, réduction accordée) y figure.
 */
export const SENSITIVE_ACTIONS = [
  'ledger.entry.reversed', 'appeal.decided', 'beneficiary.change.proposed', 'rule.approval.refused',
  // Réductions de recettes
  'reduction.granted', 'recovery.remission.granted', 'exemption.granted', 'exemption.legal_visa', 'declaration.correction.accepted',
  'rule.recalculation.applied', 'assessment.base_override',
  // Registre des règles : suspension et levée (proposition comme approbation)
  'rule.suspension.proposed', 'rule.suspended', 'rule.suspension.lift_proposed', 'rule.suspension.lifted',
  // Points de paiement : réintégration après suspension
  'canaux.point.reinstated',
  // Trésor : contre-écriture ; coffre : changement de compte bénéficiaire
  'treasury.operation.proposed:CONTRE_ECRITURE', 'treasury.operation.executed:CONTRE_ECRITURE',
  'beneficiary.change.approved', 'beneficiary.change.effective',
];

/**
 * Actes à fort impact : CHAQUE occurrence ouvre une alerte d'examen (sans effet automatique), en plus de la
 * concentration — une seule occurrence peut suffire à ouvrir une fenêtre de perte de recettes.
 */
export const REVIEW_EACH_ACTIONS = [
  'rule.suspended', 'rule.suspension.lifted', 'assessment.base_override', 'canaux.point.reinstated',
  'treasury.operation.executed:CONTRE_ECRITURE', 'beneficiary.change.effective',
];

/** Clés d'un événement d'audit au sens des listes ci-dessus (action seule, et action:kind si présent). */
export function sensitiveKeysOf(e: { action: string; details: Record<string, unknown> }): string[] {
  const kind = typeof e.details?.kind === 'string' ? e.details.kind : undefined;
  return kind ? [e.action, `${e.action}:${kind}`] : [e.action];
}

function sensitiveKeyOf(e: { action: string; details: Record<string, unknown> }, list: string[]): string | undefined {
  return sensitiveKeysOf(e).reverse().find((k) => list.includes(k));
}

const STATUS_LABEL: Record<Report['status'], string> = {
  RECU: 'Reçu — en attente de qualification',
  QUALIFIE: 'Qualifié',
  TRANSMIS: "Transmis à l'enquêteur anti-fraude",
  CLOS: 'Clos',
};

const OUTCOME_LABEL: Record<ReportOutcome, string> = {
  FONDE: 'Faits établis — suites données par l’autorité compétente',
  NON_FONDE: 'Faits non établis',
  INSUFFISANT: 'Éléments insuffisants pour conclure',
  IRRECEVABLE: 'Signalement hors du champ de la ligne',
};

const PRIVILEGED_ROLES: RoleCode[] = ['R17', 'R19', 'R22', 'R24', 'R25', 'R26', 'R27', 'R28', 'R29'];

function isInternalRole(r: RoleCode): boolean {
  return Number.parseInt(r.slice(1), 10) <= 29;
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export class IntegriteService {
  readonly kit: Kit;
  readonly reports = new InMemoryRepository<Report>();
  readonly observations = new InMemoryRepository<Observation>();
  readonly alerts = new InMemoryRepository<FraudAlert>();
  readonly cases = new InMemoryRepository<FraudCase>();
  readonly mystery = new InMemoryRepository<MysteryCheck>();
  readonly incidents = new InMemoryRepository<Incident>();
  readonly privacyRequests = new InMemoryRepository<PrivacyRequest>();
  /** Registre des traitements : chaque version est conservée (id = `<traitement>@v<n>`). */
  readonly registryVersions = new InMemoryRepository<ProcessingRecord & { recordId: string }>();
  readonly reviews = new InMemoryRepository<AccessReviewCampaign>();
  private readonly exports = new Map<string, Record<string, unknown>>();

  constructor(readonly ctx: AppContext) {
    this.kit = new Kit(ctx);
  }

  private get now(): string {
    return this.kit.now();
  }

  private investigators(): Recipient[] {
    return this.ctx.users.withRole('R24').map(userRecipient);
  }

  /* ================================================================ */
  /* SIGNALEMENTS                                                      */
  /* ================================================================ */

  private reporterRecipient(r: Report): Recipient | null {
    if (r.anonymous || !r.sealedIdentity) return null;
    const id = this.kit.unseal(r.sealedIdentity);
    if (!id.phone && !id.email) return null;
    // Le nom réel n'est jamais transmis au journal des envois : « Signalant protégé ».
    return { id: `signalant:${r.id}`, kind: 'taxpayer', name: 'Signalant protégé', lang: 'fr', prefs: {} };
  }

  /** Enregistre un signalement (web, SMS, SVI, numéro gratuit, guichet). Renvoie le code de suivi UNE seule fois. */
  submit(input: ReportInput, channel: ReportChannel, recordedBy: Principal | 'public', fixedCode?: string) {
    if (!input.anonymous && !input.contact?.phone && !input.contact?.email) {
      throw unprocessable('CONTACT_REQUIRED', 'Sans anonymat, indiquez un téléphone ou une adresse électronique pour recevoir les retours ; sinon, choisissez l’anonymat et conservez votre code de suivi.');
    }
    const now = this.now;
    const id = this.kit.ids.next('SIG');
    const code = fixedCode ?? this.kit.newTrackingCode();
    const implicated: string[] = [];
    if (input.target?.kind === 'AGENT' && input.target.reference && this.ctx.users.get(input.target.reference)) implicated.push(input.target.reference);
    let linkedReceiptId: string | undefined;
    if (input.target?.kind === 'QUITTANCE' && input.target.reference) {
      const ref = input.target.reference.trim();
      linkedReceiptId = this.ctx.receipts.receipts.findOne((x) => x.code === ref || x.number === ref)?.id;
    }
    const report: Report = {
      id,
      reference: id,
      trackingHash: this.kit.trackingHash(code),
      channel,
      category: input.category,
      description: input.description.trim(),
      ...(input.commune ? { commune: input.commune } : {}),
      ...(input.place ? { place: input.place } : {}),
      ...(input.occurredOn ? { occurredOn: input.occurredOn } : {}),
      ...(input.target ? { target: input.target } : {}),
      anonymous: input.anonymous,
      // Anonymat : aucune coordonnée n'est conservée, même si elle a été saisie.
      ...(!input.anonymous && input.contact ? { sealedIdentity: this.kit.seal(Object.fromEntries(Object.entries(input.contact).filter(([, v]) => !!v)) as Record<string, string>) } : {}),
      implicatedUserIds: implicated,
      ...(linkedReceiptId ? { linkedReceiptId } : {}),
      evidence: (input.evidence ?? []).map((e) => ({ id: this.kit.ids.next('PCE'), sha256: e.sha256.toLowerCase(), label: e.label, addedAt: now, addedBy: 'signalant' })),
      status: 'RECU',
      receivedAt: now,
      recordedBy: recordedBy === 'public' ? `public:${channel}` : recordedBy.id,
      qualifyBy: this.kit.plus(DELAYS.reportQualificationHours * HOUR),
      messages: [{ at: now, from: 'LIGNE', text: 'Votre signalement est enregistré. Il sera qualifié puis transmis à un enquêteur. Votre identité est protégée.' }],
      updatedAt: now,
    };
    this.reports.insert(report);
    this.kit.audit(recordedBy, 'integrite.report.received', 'report', id, {
      channel, category: report.category, anonymous: report.anonymous, evidence: report.evidence.length, implicated: implicated.length,
    });
    const rr = this.reporterRecipient(report);
    if (rr) this.ctx.comms.publish('whistleblower.report.received', [rr], { reference: report.reference }, { entity: 'AUDIT' });
    const inv = this.investigators();
    if (['DEMANDE_ESPECES', 'PRELEVEMENT_WEWA', 'SOUS_TRAITANT_ENCAISSE'].includes(report.category)) {
      this.ctx.comms.publish('fraud.cash_request_reported', inv, { reference: report.reference }, { entity: 'AUDIT' });
    } else if (report.category === 'FAUX_AGENT') {
      this.ctx.comms.publish('fraud.fake_agent_reported', inv, { reference: report.reference, lieu: report.commune ?? report.place ?? 'lieu non précisé' }, { entity: 'AUDIT' });
    }
    return {
      reference: report.reference,
      trackingCode: code,
      status: report.status,
      statusLabel: STATUS_LABEL[report.status],
      anonymous: report.anonymous,
      message: 'Conservez ce code de suivi : il est le seul moyen de consulter les suites de votre signalement. Il ne sera plus jamais affiché.',
      reminder: 'Un agent MOSOLO ne demande jamais d’espèces. Tout paiement se fait sur référence, vers un compte public.',
    };
  }

  /** SMS entrant (simulé) : « SIGNAL [ESPECES|FAUX|QUITTANCE|POINT|WEWA] [ANONYME] texte ». */
  fromSms(input: { from: string; text: string }) {
    const words = input.text.trim().split(/\s+/);
    if (words[0]?.toUpperCase() === 'SIGNAL') words.shift();
    const map: Record<string, ReportCategory> = {
      ESPECES: 'DEMANDE_ESPECES', CASH: 'DEMANDE_ESPECES', FAUX: 'FAUX_AGENT', AGENT: 'FAUX_AGENT', QUITTANCE: 'FAUSSE_QUITTANCE',
      POINT: 'POINT_PAIEMENT_IRREGULIER', WEWA: 'PRELEVEMENT_WEWA', SOUSTRAITANT: 'SOUS_TRAITANT_ENCAISSE',
    };
    let category: ReportCategory = 'AUTRE';
    const k = words[0] ? map[words[0].toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')] : undefined;
    if (k) { category = k; words.shift(); }
    let anonymous = false;
    if (words[0]?.toUpperCase() === 'ANONYME') { anonymous = true; words.shift(); }
    const description = words.join(' ').trim();
    if (description.length < 5) throw badRequest('SMS_TOO_SHORT', 'Message trop court : décrivez les faits après le mot-clé (ex. « SIGNAL ESPECES agent au marché de Matete »).');
    const r = this.submit({ category, description, anonymous, ...(anonymous ? {} : { contact: { phone: input.from } }) }, 'SMS', 'public');
    return {
      ...r,
      simulated: true,
      reply: `MOSOLO : signalement ${r.reference} enregistré. Code de suivi : ${r.trackingCode}. Un agent ne demande jamais d'espèces.`,
    };
  }

  /** Serveur vocal interactif (simulé) : touche 1 = catégorie, touche 2 = 1 anonyme / 2 rappel autorisé. */
  fromSvi(input: { callerNumber?: string; digits: string[]; transcript: string; commune?: string }) {
    const menu: Record<string, ReportCategory> = {
      '1': 'DEMANDE_ESPECES', '2': 'FAUX_AGENT', '3': 'FAUSSE_QUITTANCE', '4': 'POINT_PAIEMENT_IRREGULIER', '5': 'PRELEVEMENT_WEWA', '9': 'AUTRE',
    };
    const category = menu[input.digits[0] ?? '9'] ?? 'AUTRE';
    const anonymous = input.digits[1] !== '2' || !input.callerNumber;
    const r = this.submit({
      category, description: input.transcript, anonymous, ...(input.commune ? { commune: input.commune } : {}),
      ...(anonymous ? {} : { contact: { phone: input.callerNumber! } }),
    }, 'SVI', 'public');
    return {
      ...r,
      simulated: true,
      script: `Merci. Votre signalement est enregistré sous la référence ${r.reference.split('').join(' ')}. Notez votre code de suivi : ${r.trackingCode.split('').join(' ')}. Un agent ne demande jamais d'espèces.`,
    };
  }

  private byCode(code: string): Report {
    const n = normalizeCode(code);
    if (!/^[0-9A-Z]{12}$/.test(n)) throw badRequest('INVALID_TRACKING_CODE', 'Code de suivi invalide (12 caractères).');
    const h = this.kit.trackingHash(n);
    const r = this.reports.findOne((x) => x.trackingHash === h);
    if (!r) {
      this.kit.audit('public', 'integrite.report.tracking_failed', 'report', 'inconnu', {}, 'DENIED');
      throw notFound('REPORT_NOT_FOUND', 'Aucun signalement ne correspond à ce code de suivi.');
    }
    return r;
  }

  /** Suivi par le signalant : statut et messages de la ligne ; aucune donnée d'enquête ni de personne. */
  track(code: string) {
    const r = this.byCode(code);
    this.kit.audit('public', 'integrite.report.tracked', 'report', r.id);
    return this.publicView(r);
  }

  private publicView(r: Report) {
    return {
      reference: r.reference,
      category: r.category,
      categoryLabel: REPORT_CATEGORY_LABELS[r.category],
      status: r.status,
      statusLabel: STATUS_LABEL[r.status],
      receivedAt: r.receivedAt,
      updatedAt: r.updatedAt,
      outcome: r.closure ? { code: r.closure.outcome, label: OUTCOME_LABEL[r.closure.outcome], at: r.closure.at } : null,
      messages: r.messages,
      evidenceCount: r.evidence.length,
    };
  }

  /** Complément du signalant (texte et pièces par empreinte), via son code. */
  complement(code: string, input: { text: string; evidence?: { sha256: string; label: string }[] }) {
    const r = this.byCode(code);
    if (r.status === 'CLOS') throw conflict('REPORT_CLOSED', 'Ce signalement est clos : déposez un nouveau signalement si de nouveaux faits surviennent.');
    const now = this.now;
    r.messages.push({ at: now, from: 'SIGNALANT', text: input.text.trim() });
    for (const e of input.evidence ?? []) r.evidence.push({ id: this.kit.ids.next('PCE'), sha256: e.sha256.toLowerCase(), label: e.label, addedAt: now, addedBy: 'signalant' });
    r.updatedAt = now;
    this.reports.update(r);
    this.kit.audit('public', 'integrite.report.complemented', 'report', r.id, { evidence: input.evidence?.length ?? 0 });
    return this.publicView(r);
  }

  /** Vue interne : jamais d'identité, seulement l'existence d'un contact protégé. */
  staffView(r: Report) {
    const { trackingHash: _t, sealedIdentity: _s, ...rest } = r;
    const now = this.now;
    const overdueQualification = r.status === 'RECU' && now > r.qualifyBy;
    const overdueTreatment = !!r.treatBy && r.status !== 'CLOS' && now > r.treatBy;
    return {
      ...rest,
      categoryLabel: REPORT_CATEGORY_LABELS[r.category],
      statusLabel: STATUS_LABEL[r.status],
      reporterContact: r.anonymous ? 'ANONYME' : 'PROTEGE',
      reporterContactLabel: r.anonymous ? 'Signalant anonyme' : 'Coordonnées chiffrées — jamais affichées',
      ageHours: Math.round(hoursBetween(r.receivedAt, r.closure?.at ?? now)),
      overdue: overdueQualification || overdueTreatment,
    };
  }

  private getReport(id: string): Report {
    const r = this.reports.get(id);
    if (!r) throw notFound('REPORT_NOT_FOUND', `Signalement inconnu : ${id}`);
    return r;
  }

  listReports(p: Principal, filter: { status?: string; category?: string } = {}) {
    authorize(p, 'integrite:report.read');
    this.kit.audit(p, 'integrite.report.list_viewed', 'report', '*', filter);
    return this.reports
      .find((r) => !r.implicatedUserIds.includes(p.id))
      .filter((r) => (!filter.status || r.status === filter.status) && (!filter.category || r.category === filter.category))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .map((r) => this.staffView(r));
  }

  getReportFor(p: Principal, id: string) {
    authorize(p, 'integrite:report.read');
    const r = this.getReport(id);
    assertNotImplicated(this.kit, p, r.implicatedUserIds, 'report', id);
    this.kit.audit(p, 'integrite.report.viewed', 'report', id);
    return this.staffView(r);
  }

  intake(p: Principal, input: ReportInput & { channel: 'NUMERO_GRATUIT' | 'GUICHET' }) {
    authorize(p, 'integrite:report.intake');
    const { channel, ...rest } = input;
    return this.submit(rest, channel, p);
  }

  qualify(p: Principal, id: string, input: { category: ReportCategory; severity: Severity; receivable: boolean; note: string; implicatedUserIds?: string[] }) {
    authorize(p, 'integrite:report.qualify');
    const r = this.getReport(id);
    assertNotImplicated(this.kit, p, r.implicatedUserIds, 'report', id);
    if (r.status !== 'RECU') throw conflict('REPORT_ALREADY_QUALIFIED', 'Ce signalement a déjà été qualifié.');
    for (const u of input.implicatedUserIds ?? []) {
      if (!this.ctx.users.get(u)) throw unprocessable('UNKNOWN_USER', `Personne mise en cause inconnue de l'annuaire : ${u}`);
      if (u === p.id) throw forbidden('SEPARATION_OF_DUTIES', 'Vous ne pouvez pas qualifier un signalement vous mettant en cause.');
      if (!r.implicatedUserIds.includes(u)) r.implicatedUserIds.push(u);
    }
    const now = this.now;
    r.qualification = { category: input.category, severity: input.severity, receivable: input.receivable, note: input.note, by: p.id, at: now };
    r.category = input.category;
    if (input.receivable) {
      r.status = 'QUALIFIE';
      r.treatBy = this.kit.plus(DELAYS.reportTreatmentDays[input.severity] * DAY);
      r.messages.push({ at: now, from: 'LIGNE', text: 'Votre signalement a été examiné et retenu. Il est transmis pour instruction.' });
    } else {
      r.status = 'CLOS';
      r.closure = { outcome: 'IRRECEVABLE', reason: input.note, by: p.id, at: now };
      r.messages.push({ at: now, from: 'LIGNE', text: 'Votre signalement ne relève pas de la ligne d’intégrité. Pour une contestation de montant, utilisez la réclamation officielle.' });
    }
    r.updatedAt = now;
    this.reports.update(r);
    this.kit.audit(p, 'integrite.report.qualified', 'report', id, { severity: input.severity, receivable: input.receivable, category: input.category });
    return this.staffView(r);
  }

  assign(p: Principal, id: string, input: { investigatorId: string; note?: string; openCase?: boolean }) {
    authorize(p, 'integrite:report.assign');
    const r = this.getReport(id);
    assertNotImplicated(this.kit, p, r.implicatedUserIds, 'report', id);
    if (r.status !== 'QUALIFIE' && r.status !== 'TRANSMIS') throw conflict('REPORT_NOT_QUALIFIED', 'Un signalement doit être qualifié avant d’être transmis.');
    const inv = this.ctx.users.get(input.investigatorId);
    if (!inv || !inv.roles.includes('R24')) throw unprocessable('NOT_AN_INVESTIGATOR', 'Le destinataire doit être un enquêteur anti-fraude habilité (R24).');
    if (r.implicatedUserIds.includes(inv.id)) throw forbidden('CONFLICT_OF_INTEREST', 'Cet enquêteur est mis en cause par le signalement : affectation impossible.');
    const now = this.now;
    r.status = 'TRANSMIS';
    r.investigatorId = inv.id;
    r.assignedAt = now;
    r.updatedAt = now;
    this.reports.update(r);
    this.kit.audit(p, 'integrite.report.assigned', 'report', id, { investigatorId: inv.id });
    let fraudCase: FraudCase | undefined;
    if (input.openCase) {
      fraudCase = this.openCase(p, {
        title: `${REPORT_CATEGORY_LABELS[r.category]} — ${r.reference}`,
        reason: `Ouverture sur signalement ${r.reference}${input.note ? ` : ${input.note}` : ''}`,
        reportIds: [r.id], investigatorId: inv.id,
      });
    }
    return { report: this.staffView(this.getReport(id)), case: fraudCase ? this.caseView(fraudCase) : null };
  }

  respond(p: Principal, id: string, text: string) {
    authorize(p, 'integrite:report.respond');
    const r = this.getReport(id);
    assertNotImplicated(this.kit, p, r.implicatedUserIds, 'report', id);
    r.messages.push({ at: this.now, from: 'LIGNE', text: text.trim() });
    r.updatedAt = this.now;
    this.reports.update(r);
    this.kit.audit(p, 'integrite.report.reporter_informed', 'report', id);
    return this.staffView(r);
  }

  closeReport(p: Principal, id: string, input: { outcome: Exclude<ReportOutcome, 'IRRECEVABLE'>; reason: string; publicMessage: string }) {
    authorize(p, 'integrite:report.close');
    const r = this.getReport(id);
    assertNotImplicated(this.kit, p, r.implicatedUserIds, 'report', id);
    if (r.status === 'CLOS') throw conflict('REPORT_CLOSED', 'Ce signalement est déjà clos.');
    if (r.status === 'RECU') throw conflict('REPORT_NOT_QUALIFIED', 'Qualifiez le signalement avant de le clore.');
    if (r.caseId) {
      const c = this.cases.get(r.caseId);
      if (c && c.status !== 'DECIDE') throw conflict('CASE_PENDING', `Le dossier d'enquête ${c.id} n'a pas encore fait l'objet d'une décision : clôture impossible.`);
    }
    const now = this.now;
    r.status = 'CLOS';
    r.closure = { outcome: input.outcome, reason: input.reason, by: p.id, at: now };
    r.messages.push({ at: now, from: 'LIGNE', text: input.publicMessage.trim() });
    r.updatedAt = now;
    this.reports.update(r);
    this.kit.audit(p, 'integrite.report.closed', 'report', id, { outcome: input.outcome });
    return this.staffView(r);
  }

  /* ================================================================ */
  /* SIGNAUX ET ALERTES                                                */
  /* ================================================================ */

  ingest(p: Principal | 'system', items: Omit<Observation, 'id'>[]) {
    if (p !== 'system') authorize(p, 'integrite:observation.submit');
    const out = items.map((o) => this.observations.insert({ ...o, id: this.kit.ids.next('OBS') }));
    this.kit.audit(p, 'integrite.observations.ingested', 'observation', out[0]?.id ?? '-', { count: out.length });
    return { ingested: out.length, ids: out.map((o) => o.id) };
  }

  private raiseAlert(input: Omit<FraudAlert, 'id' | 'status' | 'automaticEffect' | 'raisedAt' | 'history'>, by: Principal | 'system'): FraudAlert | null {
    const existing = this.alerts.findOne((a) => a.fingerprint === input.fingerprint && a.status !== 'CLASSEE');
    if (existing) return null;
    const now = this.now;
    const alert = this.alerts.insert({
      ...input, id: this.kit.ids.next('ALF'), status: 'A_EXAMINER', automaticEffect: 'AUCUN', raisedAt: now,
      history: [{ at: now, by: by === 'system' ? 'système' : by.id, action: 'SIGNAL_EMIS' }],
    });
    this.kit.audit(by, 'integrite.alert.raised', 'fraud-alert', alert.id, { rule: alert.ruleCode, severity: alert.severity, automaticEffect: 'AUCUN' });
    this.ctx.comms.publish('fraud.alert.raised', this.investigators(), { reference: alert.id, score: alert.confidence.toLowerCase() }, { entity: 'AUDIT' });
    return alert;
  }

  /** Exécute les règles de détection explicables. Produit des ALERTES à examiner — jamais une sanction. */
  runDetection(p: Principal | 'system') {
    if (p !== 'system') authorize(p, 'integrite:detection.run');
    const P = DETECTION_PARAMS;
    const now = this.ctx.clock.now().getTime();
    const raised: FraudAlert[] = [];
    const push = (a: FraudAlert | null) => { if (a) raised.push(a); };

    // 1. Quittance vérifiée depuis des lieux éloignés dans un court intervalle.
    const verif = this.observations.find((o) => o.type === 'VERIFICATION_QUITTANCE' && !!o.receiptRef);
    const byReceipt = groupBy(verif, (o) => o.receiptRef!);
    for (const [ref, list] of byReceipt) {
      const geo = list.filter((o) => o.lat !== undefined && o.lon !== undefined).sort((a, b) => a.at.localeCompare(b.at));
      for (let i = 1; i < geo.length; i++) {
        const a = geo[i - 1]!; const b = geo[i]!;
        const km = haversineKm({ lat: a.lat!, lon: a.lon! }, { lat: b.lat!, lon: b.lon! });
        const min = hoursBetween(a.at, b.at) * 60;
        if (km >= P.distantVerificationKm && min <= P.distantVerificationWindowMin) {
          push(this.raiseAlert({
            ruleCode: 'QUITTANCE_LIEUX_ELOIGNES', ruleLabel: 'Quittance vérifiée depuis des lieux éloignés',
            fingerprint: `QLE:${ref}`, severity: 'ELEVEE', confidence: 'MOYENNE',
            explanation: `La quittance ${ref} a été vérifiée à ${km.toFixed(1)} km d'intervalle en ${Math.round(min)} minutes : possible duplication (copie ou photocopie) d'une quittance. À vérifier auprès des deux lieux ; ne vaut pas preuve de fraude.`,
            variables: [
              { name: 'Distance', value: `${km.toFixed(1)} km`, source: `${a.id} → ${b.id}` },
              { name: 'Intervalle', value: `${Math.round(min)} min`, source: 'horodatage des vérifications' },
              { name: 'Lieux', value: `${a.commune ?? '?'} → ${b.commune ?? '?'}`, source: 'terminaux de vérification' },
            ],
            subjects: [{ kind: 'QUITTANCE', ref }],
          }, p));
          break;
        }
      }
    }
    // 2. Quittance vérifiée un nombre inhabituel de fois (observations + journal des vérifications publiques).
    const counts = new Map<string, number>();
    for (const o of verif) if (now - new Date(o.at).getTime() <= P.repeatedVerificationWindowH * HOUR) counts.set(o.receiptRef!, (counts.get(o.receiptRef!) ?? 0) + 1);
    for (const e of this.ctx.audit.list({ action: 'receipt.verified', limit: 100_000 }).items) {
      if (e.resourceId && e.details.found && now - new Date(e.at).getTime() <= P.repeatedVerificationWindowH * HOUR) {
        const rec = this.ctx.receipts.receipts.get(e.resourceId);
        const key = rec?.number ?? e.resourceId;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    for (const [ref, n] of counts) {
      if (n >= P.repeatedVerificationCount) {
        push(this.raiseAlert({
          ruleCode: 'QUITTANCE_VERIFICATIONS_REPETEES', ruleLabel: 'Quittance vérifiée de nombreuses fois',
          fingerprint: `QVR:${ref}`, severity: 'MOYENNE', confidence: 'FAIBLE',
          explanation: `La quittance ${ref} a été vérifiée ${n} fois en ${P.repeatedVerificationWindowH} h. Un usage légitime est possible (contrôles successifs) ; une réutilisation frauduleuse aussi.`,
          variables: [{ name: 'Vérifications', value: String(n), source: 'journal des vérifications' }, { name: 'Fenêtre', value: `${P.repeatedVerificationWindowH} h`, source: 'paramètre de démonstration' }],
          subjects: [{ kind: 'QUITTANCE', ref }],
        }, p));
      }
    }
    // 3. Paiements fractionnés sur une même obligation.
    const splits: { key: string; count: number; total: string; source: string; point?: string }[] = [];
    const pointPays = this.observations.find((o) => o.type === 'PAIEMENT_POINT' && !!o.obligationRef);
    for (const [ref, list] of groupBy(pointPays, (o) => `${o.pointRef ?? '?'}|${o.obligationRef}`)) {
      const inWindow = windowMax(list.map((o) => o.at), P.splitPaymentWindowH * HOUR);
      if (inWindow >= P.splitPaymentCount) splits.push({ key: ref, count: inWindow, total: sumMoney(list.map((o) => o.amount)), source: 'flux des points de paiement', point: list[0]?.pointRef });
    }
    for (const [obl, list] of groupBy(this.ctx.payments.orders.all(), (o) => o.obligationId)) {
      const active = list.filter((o) => o.status !== 'ECHOUE');
      const inWindow = windowMax(active.map((o) => o.createdAt), P.splitPaymentWindowH * HOUR);
      if (inWindow >= P.splitPaymentCount) splits.push({ key: `ORD|${obl}`, count: inWindow, total: sumMoney(active.map((o) => o.amount)), source: 'ordres de paiement' });
    }
    for (const s of splits) {
      const obligation = s.key.split('|')[1]!;
      push(this.raiseAlert({
        ruleCode: 'PAIEMENTS_FRACTIONNES', ruleLabel: 'Paiements fractionnés sur une même obligation',
        fingerprint: `PFR:${s.key}`, severity: 'MOYENNE', confidence: 'MOYENNE',
        explanation: `${s.count} paiements en moins de ${P.splitPaymentWindowH} h pour l'obligation ${obligation}${s.point ? ` au point ${s.point}` : ''} (total ${s.total}). Le fractionnement peut contourner un plafond ou masquer un encaissement parallèle ; il peut aussi être légitime.`,
        variables: [
          { name: 'Nombre de paiements', value: String(s.count), source: s.source },
          { name: 'Total', value: s.total, source: s.source },
          { name: 'Fenêtre', value: `${P.splitPaymentWindowH} h`, source: 'paramètre de démonstration' },
        ],
        subjects: [{ kind: 'OBLIGATION', ref: obligation }, ...(s.point ? [{ kind: 'POINT_PAIEMENT', ref: s.point }] : [])],
      }, p));
    }
    // 4. Agent visé par plusieurs signalements.
    const recent = this.reports.find((r) => now - new Date(r.receivedAt).getTime() <= P.multipleReportsWindowDays * DAY
      && !(r.closure && ['NON_FONDE', 'IRRECEVABLE'].includes(r.closure.outcome)));
    const perAgent = new Map<string, string[]>();
    for (const r of recent) for (const u of r.implicatedUserIds) perAgent.set(u, [...(perAgent.get(u) ?? []), r.reference]);
    for (const [u, refs] of perAgent) {
      if (refs.length >= P.multipleReportsCount) {
        push(this.raiseAlert({
          ruleCode: 'AGENT_SIGNALEMENTS_MULTIPLES', ruleLabel: 'Agent visé par plusieurs signalements',
          fingerprint: `ASM:${u}:${refs.length}`, severity: 'ELEVEE', confidence: 'MOYENNE',
          explanation: `${refs.length} signalements distincts en ${P.multipleReportsWindowDays} jours visent la même personne. Un signalement n'est pas une preuve : instruction contradictoire requise.`,
          variables: [{ name: 'Signalements', value: refs.join(', '), source: 'ligne de signalement' }],
          subjects: [{ kind: 'AGENT', ref: u }],
        }, p));
      }
    }
    // 5. Taux anormal de non-conformité aux contrôles mystère.
    const done = this.mystery.find((m) => !!m.result && m.result.outcome !== 'NON_REALISABLE');
    for (const [target, list] of groupBy(done, (m) => `${m.targetKind}:${m.targetRef}`)) {
      const nc = list.filter((m) => m.result!.outcome === 'NON_CONFORME').length;
      if (nc >= P.mysteryNonConformityMin && nc / list.length >= 0.5) {
        push(this.raiseAlert({
          ruleCode: 'TAUX_NON_CONFORMITE', ruleLabel: 'Taux anormal de non-conformité aux contrôles mystère',
          fingerprint: `TNC:${target}:${nc}`, severity: 'ELEVEE', confidence: 'ELEVEE',
          explanation: `${nc} contrôles mystère non conformes sur ${list.length} pour ${target}.`,
          variables: [{ name: 'Non conformes', value: `${nc} / ${list.length}`, source: 'registre des contrôles mystère' }],
          subjects: [{ kind: list[0]!.targetKind, ref: list[0]!.targetRef }],
        }, p));
      }
    }
    // 6. Concentration d'actes sensibles sur une même personne (journal d'audit).
    const recentAudit = this.ctx.audit.list({ limit: 1_000_000 }).items.filter((e) => now - new Date(e.at).getTime() <= P.sensitiveWindowDays * DAY);
    const sensitive = recentAudit.filter((e) => e.actor.kind === 'user' && sensitiveKeyOf(e, SENSITIVE_ACTIONS) !== undefined);
    for (const [action, list] of groupBy(sensitive, (e) => sensitiveKeyOf(e, SENSITIVE_ACTIONS)!)) {
      for (const [actor, mine] of groupBy(list, (e) => e.actor.id)) {
        const share = mine.length / list.length;
        if (mine.length >= P.sensitiveConcentrationMin && share >= P.sensitiveConcentrationShare && new Set(list.map((e) => e.actor.id)).size >= 2) {
          push(this.raiseAlert({
            ruleCode: 'CONCENTRATION_ACTES_SENSIBLES', ruleLabel: 'Concentration anormale d’actes sensibles',
            fingerprint: `CAS:${action}:${actor}:${mine.length}`, severity: 'MOYENNE', confidence: 'FAIBLE',
            explanation: `${actor} réalise ${Math.round(share * 100)} % des actes « ${action} » sur ${P.sensitiveWindowDays} jours (${mine.length} sur ${list.length}).`,
            variables: [{ name: 'Part', value: `${Math.round(share * 100)} %`, source: 'journal d’audit' }, { name: 'Actes', value: `${mine.length} / ${list.length}`, source: 'journal d’audit' }],
            subjects: [{ kind: 'AGENT', ref: actor }],
          }, p));
        }
      }
    }
    // 6 bis. Actes à fort impact : chaque occurrence est proposée à l'examen (suspension/levée de règle, contre-écriture,
    // changement de compte bénéficiaire, réintégration d'un point de paiement, forçage de base de liquidation).
    for (const e of recentAudit) {
      const key = sensitiveKeyOf(e, REVIEW_EACH_ACTIONS);
      if (!key || e.outcome !== 'SUCCESS') continue;
      push(this.raiseAlert({
        ruleCode: 'ACTE_SENSIBLE_A_EXAMINER', ruleLabel: 'Acte sensible à examiner',
        fingerprint: `ASE:${e.id}`, severity: 'MOYENNE', confidence: 'FAIBLE',
        explanation: `Acte « ${key} » réalisé par ${e.actor.id} le ${e.at} sur ${e.resourceType} ${e.resourceId ?? '-'} : acte à fort impact sur les recettes, examen de routine (ne vaut pas soupçon).`,
        variables: [{ name: 'Acte', value: key, source: `journal d’audit ${e.id}` }, { name: 'Ressource', value: `${e.resourceType} ${e.resourceId ?? '-'}`, source: 'journal d’audit' }],
        subjects: [...(e.actor.kind === 'user' ? [{ kind: 'AGENT', ref: e.actor.id }] : []), { kind: 'AUDIT', ref: e.id }],
      }, p));
    }
    // 6 ter. Décisions prises pendant la suspension d'une règle (pénalités ou droits non émis pendant la fenêtre).
    for (const code of new Set(this.ctx.rules.rules.all().filter((r) => r.suspension || r.pastSuspensions?.length).map((r) => r.code))) {
      const decisions = this.ctx.rules.decisionsDuringSuspension(code);
      if (!decisions.length) continue;
      push(this.raiseAlert({
        ruleCode: 'DECISIONS_PENDANT_SUSPENSION', ruleLabel: 'Décisions prises pendant la suspension d’une règle',
        fingerprint: `DPS:${code}:${decisions.length}`, severity: 'ELEVEE', confidence: 'MOYENNE',
        explanation: `${decisions.length} décision(s) prise(s) pendant une suspension de la règle ${code} : pénalités ou droits possiblement non émis. Examen humain requis ; aucune sanction automatique.`,
        variables: [
          { name: 'Décisions', value: decisions.slice(0, 10).map((d) => `${d.action} ${d.resourceId ?? ''}`.trim()).join(', '), source: 'journal d’audit' },
          { name: 'Décideurs', value: [...new Set(decisions.map((d) => d.actorId))].join(', '), source: 'journal d’audit' },
        ],
        subjects: [{ kind: 'REGLE', ref: code }, ...[...new Set(decisions.map((d) => d.actorId))].map((ref) => ({ kind: 'AGENT', ref }))],
      }, p));
    }
    // 7. Tentatives d'accès refusées répétées.
    const denied = this.ctx.audit.list({ action: 'access.denied', limit: 100_000 }).items.filter((e) => e.actor.kind === 'user' && now - new Date(e.at).getTime() <= P.deniedAccessWindowH * HOUR);
    for (const [actor, list] of groupBy(denied, (e) => e.actor.id)) {
      if (list.length >= P.deniedAccessCount) {
        push(this.raiseAlert({
          ruleCode: 'ACCES_REFUSES_REPETES', ruleLabel: 'Tentatives d’accès refusées répétées',
          fingerprint: `ARR:${actor}:${list.length}`, severity: 'MOYENNE', confidence: 'MOYENNE',
          explanation: `${list.length} refus d'accès en ${P.deniedAccessWindowH} h pour ${actor}. Peut signaler une erreur de configuration des rôles ou une tentative de consultation hors périmètre.`,
          variables: [{ name: 'Refus', value: String(list.length), source: 'journal d’audit (access.denied)' }],
          subjects: [{ kind: 'UTILISATEUR', ref: actor }],
        }, p));
      }
    }
    // 8. Alertes techniques du socle (signature de quittance, rappel falsifié, terminal révoqué…).
    for (const a of this.ctx.alerts.list()) {
      push(this.raiseAlert({
        ruleCode: 'ALERTE_TECHNIQUE', ruleLabel: 'Alerte technique du socle',
        fingerprint: `SEC:${a.id}`, severity: a.severity === 'CRITICAL' ? 'CRITIQUE' : a.severity === 'HIGH' ? 'ELEVEE' : 'MOYENNE', confidence: 'ELEVEE',
        explanation: `${a.detail} (source : ${a.source}).`,
        variables: [{ name: 'Type', value: a.type, source: `alerte ${a.id}` }],
        subjects: [{ kind: 'ALERTE_SOCLE', ref: a.id }],
      }, p));
    }
    this.kit.audit(p, 'integrite.detection.run', 'fraud-alert', '*', { raised: raised.length });
    return { raised: raised.length, alerts: raised, params: DETECTION_PARAMS, automaticEffect: 'AUCUN' as const };
  }

  private getAlert(id: string): FraudAlert {
    const a = this.alerts.get(id);
    if (!a) throw notFound('ALERT_NOT_FOUND', `Alerte inconnue : ${id}`);
    return a;
  }

  private alertImplicated(a: FraudAlert): string[] {
    return a.subjects.filter((s) => s.kind === 'AGENT' || s.kind === 'UTILISATEUR').map((s) => s.ref);
  }

  listAlerts(p: Principal, filter: { status?: string } = {}) {
    authorize(p, 'integrite:alert.read');
    return this.alerts
      .find((a) => (!filter.status || a.status === filter.status) && !this.alertImplicated(a).includes(p.id))
      .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt));
  }

  examineAlert(p: Principal, id: string, note?: string) {
    authorize(p, 'integrite:alert.examine');
    const a = this.getAlert(id);
    assertNotImplicated(this.kit, p, this.alertImplicated(a), 'fraud-alert', id);
    if (a.status !== 'A_EXAMINER') throw conflict('ALERT_STATE', `Alerte déjà prise en charge (${a.status}).`);
    a.status = 'EN_EXAMEN';
    a.examinedBy = p.id;
    a.history.push({ at: this.now, by: p.id, action: 'PRISE_EN_CHARGE', ...(note ? { note } : {}) });
    this.alerts.update(a);
    this.kit.audit(p, 'integrite.alert.examined', 'fraud-alert', id);
    return a;
  }

  proposeAlertClosure(p: Principal, id: string, reason: string) {
    authorize(p, 'integrite:alert.examine');
    const a = this.getAlert(id);
    assertNotImplicated(this.kit, p, this.alertImplicated(a), 'fraud-alert', id);
    if (a.status !== 'EN_EXAMEN' && a.status !== 'A_EXAMINER') throw conflict('ALERT_STATE', `Clôture impossible depuis l'état ${a.status}.`);
    a.status = 'CLOTURE_PROPOSEE';
    a.closureProposal = { by: p.id, at: this.now, reason };
    a.history.push({ at: this.now, by: p.id, action: 'CLOTURE_PROPOSEE', note: reason });
    this.alerts.update(a);
    this.kit.audit(p, 'integrite.alert.closure_proposed', 'fraud-alert', id, { reason });
    return a;
  }

  /** Clôture d'alerte par un responsable DISTINCT de l'enquêteur (module 40, § 12.5). */
  validateAlertClosure(p: Principal, id: string, input: { approve: boolean; reason: string }) {
    authorize(p, 'integrite:alert.validate');
    const a = this.getAlert(id);
    assertNotImplicated(this.kit, p, this.alertImplicated(a), 'fraud-alert', id);
    if (a.status !== 'CLOTURE_PROPOSEE' || !a.closureProposal) throw conflict('ALERT_STATE', 'Aucune proposition de clôture en attente.');
    assertDistinctPerson(p.id, [a.closureProposal.by, ...(a.examinedBy ? [a.examinedBy] : [])], 'La clôture doit être validée par un responsable distinct de l’enquêteur qui l’a proposée.');
    const now = this.now;
    if (input.approve) {
      a.status = 'CLASSEE';
      a.closure = { by: p.id, at: now, reason: input.reason };
    } else {
      a.status = 'EN_EXAMEN';
      delete a.closureProposal;
    }
    a.history.push({ at: now, by: p.id, action: input.approve ? 'CLOTURE_VALIDEE' : 'CLOTURE_REFUSEE', note: input.reason });
    this.alerts.update(a);
    this.kit.audit(p, input.approve ? 'integrite.alert.closed' : 'integrite.alert.closure_refused', 'fraud-alert', id, { reason: input.reason });
    return a;
  }

  /* ================================================================ */
  /* DOSSIERS D'ENQUÊTE                                                */
  /* ================================================================ */

  private getCase(id: string): FraudCase {
    const c = this.cases.get(id);
    if (!c) throw notFound('CASE_NOT_FOUND', `Dossier d'enquête inconnu : ${id}`);
    return c;
  }

  caseView(c: FraudCase) {
    const auditTrail = this.ctx.audit.list({ resourceId: c.id, limit: 500 }).items.map((e) => ({ at: e.at, action: e.action, actor: e.actor.id, hash: e.hash }));
    return {
      ...c,
      ageDays: Math.floor(hoursBetween(c.openedAt, c.decision?.at ?? this.now) / 24),
      auditTrail,
      reports: c.reportIds.map((id) => this.reports.get(id)).filter((r): r is Report => !!r).map((r) => ({ id: r.id, reference: r.reference, category: r.category, categoryLabel: REPORT_CATEGORY_LABELS[r.category], status: r.status, receivedAt: r.receivedAt })),
      alerts: c.alertIds.map((id) => this.alerts.get(id)).filter((a): a is FraudAlert => !!a).map((a) => ({ id: a.id, ruleLabel: a.ruleLabel, severity: a.severity, status: a.status })),
    };
  }

  private addEvent(c: FraudCase, by: string, kind: CaseEvent['kind'], text: string) {
    c.timeline.push({ at: this.now, by, kind, text });
    if (!c.contributors.includes(by)) c.contributors.push(by);
  }

  openCase(p: Principal, input: { title: string; reason: string; alertIds?: string[]; reportIds?: string[]; mysteryCheckIds?: string[]; investigatorId?: string }) {
    authorize(p, 'integrite:case.open');
    if (input.reason.trim().length < 10) throw badRequest('REASON_REQUIRED', 'Motif d’ouverture obligatoire (10 caractères au moins).');
    const investigatorId = input.investigatorId ?? p.id;
    const inv = this.ctx.users.get(investigatorId);
    if (!inv || !inv.roles.includes('R24')) throw unprocessable('NOT_AN_INVESTIGATOR', 'Le dossier doit être confié à un enquêteur anti-fraude habilité (R24).');
    const implicated = new Set<string>();
    const alerts = (input.alertIds ?? []).map((id) => this.getAlert(id));
    const reports = (input.reportIds ?? []).map((id) => this.getReport(id));
    for (const a of alerts) for (const u of this.alertImplicated(a)) implicated.add(u);
    for (const r of reports) for (const u of r.implicatedUserIds) implicated.add(u);
    if (implicated.has(inv.id) || implicated.has(p.id)) throw forbidden('CONFLICT_OF_INTEREST', 'Une personne mise en cause ne peut ni ouvrir ni instruire ce dossier.');
    const now = this.now;
    const c: FraudCase = {
      id: this.kit.ids.next('DOS'), title: input.title.trim(), openingReason: input.reason.trim(), openedBy: p.id, openedAt: now,
      investigatorId: inv.id, status: 'OUVERT', alertIds: alerts.map((a) => a.id), reportIds: reports.map((r) => r.id),
      mysteryCheckIds: input.mysteryCheckIds ?? [], implicatedUserIds: [...implicated],
      links: [...alerts.flatMap((a) => a.subjects.map((s) => ({ kind: s.kind, ref: s.ref })))],
      evidence: [], timeline: [], contributors: [],
    };
    // Pièces du signalant reprises par empreinte.
    for (const r of reports) for (const e of r.evidence) c.evidence.push({ ...e, id: this.kit.ids.next('PCE') });
    this.addEvent(c, p.id, 'OUVERTURE', c.openingReason);
    if (inv.id !== p.id && !c.contributors.includes(inv.id)) c.contributors.push(inv.id);
    this.cases.insert(c);
    for (const a of alerts) {
      a.status = 'DOSSIER_OUVERT'; a.caseId = c.id; a.history.push({ at: now, by: p.id, action: 'DOSSIER_OUVERT', note: c.id });
      this.alerts.update(a);
    }
    for (const r of reports) { r.caseId = c.id; r.updatedAt = now; this.reports.update(r); }
    this.kit.audit(p, 'integrite.case.opened', 'fraud-case', c.id, { investigatorId: inv.id, alerts: c.alertIds, reports: c.reportIds });
    this.ctx.comms.publish('fraud.case.opened', [userRecipient(inv)], { reference: c.id }, { entity: 'AUDIT' });
    return c;
  }

  listCases(p: Principal) {
    authorize(p, 'integrite:case.read');
    return this.cases.find((c) => !c.implicatedUserIds.includes(p.id)).sort((a, b) => b.openedAt.localeCompare(a.openedAt)).map((c) => ({
      id: c.id, title: c.title, status: c.status, investigatorId: c.investigatorId, openedAt: c.openedAt,
      ageDays: Math.floor(hoursBetween(c.openedAt, c.decision?.at ?? this.now) / 24), evidence: c.evidence.length,
      finding: c.conclusions?.finding ?? null, decision: c.decision?.decision ?? null,
    }));
  }

  getCaseFor(p: Principal, id: string) {
    authorize(p, 'integrite:case.read');
    const c = this.getCase(id);
    assertNotImplicated(this.kit, p, c.implicatedUserIds, 'fraud-case', id);
    this.kit.audit(p, 'integrite.case.viewed', 'fraud-case', id);
    return this.caseView(c);
  }

  private instructable(p: Principal, id: string): FraudCase {
    authorize(p, 'integrite:case.instruct');
    const c = this.getCase(id);
    assertNotImplicated(this.kit, p, c.implicatedUserIds, 'fraud-case', id);
    if (c.status === 'DECIDE') throw conflict('CASE_DECIDED', 'Dossier décidé : aucune pièce ne peut plus être ajoutée (ouvrir un nouveau dossier lié si nécessaire).');
    if (c.investigatorId !== p.id) throw forbidden('NOT_CASE_INVESTIGATOR', 'Seul l’enquêteur en charge instruit ce dossier.');
    return c;
  }

  addCaseEvidence(p: Principal, id: string, input: { sha256: string; label: string }) {
    const c = this.instructable(p, id);
    if (c.evidence.some((e) => e.sha256 === input.sha256.toLowerCase())) throw conflict('EVIDENCE_DUPLICATE', 'Pièce déjà versée (même empreinte).');
    const e: EvidenceRef = { id: this.kit.ids.next('PCE'), sha256: input.sha256.toLowerCase(), label: input.label, addedAt: this.now, addedBy: p.id };
    c.evidence.push(e);
    if (c.status === 'OUVERT') c.status = 'EN_INSTRUCTION';
    this.addEvent(c, p.id, 'PIECE', `${input.label} (empreinte ${e.sha256.slice(0, 12)}…)`);
    this.cases.update(c);
    this.kit.audit(p, 'integrite.case.evidence_added', 'fraud-case', id, { sha256: e.sha256, label: e.label });
    return this.caseView(c);
  }

  addCaseNote(p: Principal, id: string, input: { kind: 'NOTE' | 'DEMANDE_PIECES'; text: string }) {
    const c = this.instructable(p, id);
    if (c.status === 'OUVERT') c.status = 'EN_INSTRUCTION';
    this.addEvent(c, p.id, input.kind, input.text);
    this.cases.update(c);
    this.kit.audit(p, input.kind === 'NOTE' ? 'integrite.case.note_added' : 'integrite.case.documents_requested', 'fraud-case', id);
    return this.caseView(c);
  }

  addCaseLink(p: Principal, id: string, input: { kind: string; ref: string; note?: string; implicated?: boolean }) {
    const c = this.instructable(p, id);
    if (input.implicated) {
      if (!this.ctx.users.get(input.ref)) throw unprocessable('UNKNOWN_USER', `Personne inconnue de l'annuaire : ${input.ref}`);
      if (input.ref === c.investigatorId) throw forbidden('CONFLICT_OF_INTEREST', 'L’enquêteur ne peut être mis en cause dans son propre dossier : réaffectation requise.');
      if (!c.implicatedUserIds.includes(input.ref)) c.implicatedUserIds.push(input.ref);
    }
    c.links.push({ kind: input.kind, ref: input.ref, ...(input.note ? { note: input.note } : {}) });
    this.addEvent(c, p.id, 'LIEN', `${input.kind} ${input.ref}${input.note ? ` — ${input.note}` : ''}`);
    this.cases.update(c);
    this.kit.audit(p, 'integrite.case.link_added', 'fraud-case', id, { kind: input.kind });
    return this.caseView(c);
  }

  conclude(p: Principal, id: string, input: { finding: CaseFinding; summary: string; recommendation: CaseDecision }) {
    const c = this.instructable(p, id);
    if (c.status === 'CONCLUSIONS_DEPOSEES') throw conflict('CASE_ALREADY_CONCLUDED', 'Conclusions déjà déposées.');
    c.conclusions = { ...input, by: p.id, at: this.now };
    c.status = 'CONCLUSIONS_DEPOSEES';
    this.addEvent(c, p.id, 'CONCLUSIONS', `${input.finding} — proposition : ${input.recommendation}`);
    this.cases.update(c);
    this.kit.audit(p, 'integrite.case.concluded', 'fraud-case', id, { finding: input.finding, recommendation: input.recommendation });
    return this.caseView(c);
  }

  /** Décision humaine motivée, par une personne DISTINCTE de l'enquêteur et de tout contributeur au dossier. */
  decide(p: Principal, id: string, input: { decision: CaseDecision; reason: string }) {
    authorize(p, 'integrite:case.decide');
    const c = this.getCase(id);
    assertNotImplicated(this.kit, p, c.implicatedUserIds, 'fraud-case', id);
    if (c.status !== 'CONCLUSIONS_DEPOSEES') throw conflict('CASE_NOT_CONCLUDED', 'La décision intervient après le dépôt des conclusions de l’enquêteur.');
    assertDistinctPerson(p.id, [c.investigatorId, c.openedBy, ...c.contributors], 'Séparation des tâches : la personne qui décide ne peut pas avoir instruit le dossier.');
    if (input.reason.trim().length < 20) throw badRequest('REASON_REQUIRED', 'Décision motivée obligatoire (20 caractères au moins).');
    const execution: Record<CaseDecision, string> = {
      CLASSEMENT_SANS_SUITE: 'Aucune suite. Le dossier reste consultable par l’audit.',
      SAISINE_AUTORITE_COMPETENTE: 'Transmission du dossier (pièces par empreinte, chronologie, conclusions) à l’autorité compétente, qui seule qualifie et sanctionne.',
      SUSPENSION_CONSERVATOIRE_ACCES: 'Mesure conservatoire d’un ACCÈS TECHNIQUE à exécuter par l’administrateur habilité, pour une durée limitée ; ce n’est pas une sanction.',
      RENVOI_DISCIPLINAIRE: 'Renvoi à l’autorité hiérarchique ; la procédure disciplinaire est contradictoire et distincte de MOSOLO.',
    };
    const now = this.now;
    c.decision = { decision: input.decision, reason: input.reason.trim(), by: p.id, at: now, execution: execution[input.decision], automaticEffect: 'AUCUN' };
    c.status = 'DECIDE';
    c.timeline.push({ at: now, by: p.id, kind: 'DECISION', text: `${input.decision} — ${input.reason.trim()}` });
    this.cases.update(c);
    this.kit.audit(p, 'integrite.case.decided', 'fraud-case', id, { decision: input.decision, automaticEffect: 'AUCUN' });
    const inv = this.ctx.users.get(c.investigatorId);
    if (inv) this.ctx.comms.publish('fraud.case.closed', [userRecipient(inv)], { reference: c.id }, { entity: 'AUDIT' });
    return this.caseView(c);
  }

  /* ================================================================ */
  /* CONTRÔLES MYSTÈRE                                                 */
  /* ================================================================ */

  private getMystery(id: string): MysteryCheck {
    const m = this.mystery.get(id);
    if (!m) throw notFound('MYSTERY_CHECK_NOT_FOUND', `Contrôle mystère inconnu : ${id}`);
    return m;
  }

  planMystery(p: Principal, input: { programme: string; targetKind: MysteryTarget; targetRef: string; commune: string; scenario: string; plannedFor: string; controllerId: string }) {
    authorize(p, 'integrite:mystery.plan');
    const ctl = this.ctx.users.get(input.controllerId);
    if (!ctl || !ctl.roles.some((r) => r === 'R22' || r === 'R24')) throw unprocessable('NOT_A_CONTROLLER', 'Le contrôleur mystère doit être un auditeur interne (R22) ou un enquêteur (R24).');
    if (input.targetRef === ctl.id) throw forbidden('CONFLICT_OF_INTEREST', 'Un contrôleur ne peut être la cible de son propre contrôle.');
    const m = this.mystery.insert({
      id: this.kit.ids.next('CM'), ...input, plannedBy: p.id, plannedAt: this.now, status: 'PLANIFIE',
    });
    this.kit.audit(p, 'integrite.mystery.planned', 'mystery-check', m.id, { targetKind: m.targetKind, plannedFor: m.plannedFor });
    return m;
  }

  listMystery(p: Principal) {
    authorize(p, 'integrite:mystery.read');
    return this.mystery.find((m) => m.targetRef !== p.id).sort((a, b) => b.plannedFor.localeCompare(a.plannedFor));
  }

  recordMystery(p: Principal, id: string, input: { outcome: MysteryResult; cashRequested: boolean; officialAmountShown: boolean | null; receiptIssued: boolean | null; observations: string; evidence?: { sha256: string; label: string }[] }) {
    authorize(p, 'integrite:mystery.record');
    const m = this.getMystery(id);
    if (m.controllerId !== p.id) throw forbidden('NOT_ASSIGNED_CONTROLLER', 'Seul le contrôleur désigné enregistre le résultat.');
    if (m.status !== 'PLANIFIE') throw conflict('MYSTERY_ALREADY_RECORDED', 'Résultat déjà enregistré.');
    if (input.cashRequested && input.outcome === 'CONFORME') throw unprocessable('INCONSISTENT_RESULT', 'Une demande d’espèces rend le contrôle non conforme.');
    const now = this.now;
    m.result = {
      outcome: input.outcome, cashRequested: input.cashRequested, officialAmountShown: input.officialAmountShown, receiptIssued: input.receiptIssued,
      observations: input.observations, by: p.id, at: now,
      evidence: (input.evidence ?? []).map((e) => ({ id: this.kit.ids.next('PCE'), sha256: e.sha256.toLowerCase(), label: e.label, addedAt: now, addedBy: p.id })),
    };
    m.status = 'REALISE';
    this.kit.audit(p, 'integrite.mystery.recorded', 'mystery-check', id, { outcome: input.outcome, cashRequested: input.cashRequested });
    if (input.outcome === 'NON_CONFORME') {
      const a = this.raiseAlert({
        ruleCode: 'CONTROLE_MYSTERE_NON_CONFORME', ruleLabel: 'Contrôle mystère non conforme',
        fingerprint: `CMN:${m.id}`, severity: input.cashRequested ? 'ELEVEE' : 'MOYENNE', confidence: 'ELEVEE',
        explanation: `Contrôle ${m.id} (${m.scenario}) non conforme${input.cashRequested ? ' : demande d’espèces constatée' : ''}. Constat à instruire ; aucune mesure automatique.`,
        variables: [
          { name: 'Espèces demandées', value: input.cashRequested ? 'oui' : 'non', source: `contrôle ${m.id}` },
          { name: 'Montant officiel affiché', value: input.officialAmountShown === null ? 'sans objet' : input.officialAmountShown ? 'oui' : 'non', source: `contrôle ${m.id}` },
        ],
        subjects: [{ kind: m.targetKind, ref: m.targetRef }],
      }, p);
      if (a) m.alertId = a.id;
    }
    this.mystery.update(m);
    return this.getMystery(id);
  }

  followUpMystery(p: Principal, id: string, input: { action: MysteryFollowUp; note: string }) {
    authorize(p, 'integrite:mystery.plan');
    const m = this.getMystery(id);
    if (m.status !== 'REALISE') throw conflict('MYSTERY_NOT_RECORDED', 'Les suites se décident une fois le résultat enregistré.');
    let caseId: string | undefined;
    if (input.action === 'OUVRIR_DOSSIER') {
      const c = this.openCase(p, {
        title: `Contrôle mystère non conforme — ${m.targetKind} ${m.targetRef}`,
        reason: `Suite du contrôle ${m.id} : ${input.note}`,
        mysteryCheckIds: [m.id], ...(m.alertId ? { alertIds: [m.alertId] } : {}),
      });
      caseId = c.id;
    }
    m.followUp = { action: input.action, note: input.note, by: p.id, at: this.now, ...(caseId ? { caseId } : {}) };
    m.status = 'SUITE_DONNEE';
    this.mystery.update(m);
    this.kit.audit(p, 'integrite.mystery.followed_up', 'mystery-check', id, { action: input.action, caseId });
    return m;
  }

  /** Résultats publiés sous forme AGRÉGÉE (aucune cible nominative). */
  mysterySummary() {
    const out = (['AGENT', 'SOUS_TRAITANT', 'POINT_PAIEMENT', 'GUICHET'] as MysteryTarget[]).map((k) => {
      const done = this.mystery.find((m) => m.targetKind === k && !!m.result && m.result.outcome !== 'NON_REALISABLE');
      const ok = done.filter((m) => m.result!.outcome === 'CONFORME').length;
      return { targetKind: k, realises: done.length, conformes: ok, tauxConformite: done.length ? `${Math.round((ok / done.length) * 100)} %` : null };
    });
    return { byTarget: out, planifies: this.mystery.find((m) => m.status === 'PLANIFIE').length, example: this.mystery.all().some((m) => m.demo) };
  }

  /* ================================================================ */
  /* INCIDENTS DE SÉCURITÉ                                             */
  /* ================================================================ */

  private getIncident(id: string): Incident {
    const i = this.incidents.get(id);
    if (!i) throw notFound('INCIDENT_NOT_FOUND', `Incident inconnu : ${id}`);
    return i;
  }

  incidentView(i: Incident) {
    const now = this.now;
    const open = i.status !== 'CLOS';
    return { ...i, overdue: open && now > i.dueAt, escalation: open && now > i.dueAt ? 'Délai dépassé : escalade au comité de sécurité (information, aucune correction automatique).' : null };
  }

  declareIncident(p: Principal, input: { title: string; description: string; category: IncidentCategory; severity: Severity; detectedAt?: string; personalDataImpacted: boolean; affectedTaxpayerIds?: string[]; fromAlertId?: string }) {
    authorize(p, 'integrite:incident.declare');
    if (input.fromAlertId && !this.ctx.alerts.alerts.get(input.fromAlertId)) throw notFound('ALERT_NOT_FOUND', `Alerte du socle inconnue : ${input.fromAlertId}`);
    const now = this.now;
    const i = this.incidents.insert({
      id: this.kit.ids.next('INC'), title: input.title, description: input.description, category: input.category, severity: input.severity,
      declaredBy: p.id, declaredAt: now, detectedAt: input.detectedAt ?? now, dueAt: this.kit.plus(DELAYS.incidentHours[input.severity] * HOUR),
      status: 'DECLARE', personalDataImpacted: input.personalDataImpacted, affectedTaxpayerIds: input.affectedTaxpayerIds ?? [],
      ...(input.fromAlertId ? { fromAlertId: input.fromAlertId } : {}), notifications: [], log: [{ at: now, by: p.id, status: 'DECLARE', note: 'Déclaration' }],
    });
    this.kit.audit(p, 'integrite.incident.declared', 'incident', i.id, { severity: i.severity, category: i.category, personalData: i.personalDataImpacted });
    const rssi = this.ctx.users.withRole('R28').map(userRecipient);
    this.ctx.comms.publish('incident.declared', rssi, { reference: i.id, gravite: i.severity.toLowerCase() }, { entity: 'PLATEFORME' });
    return this.incidentView(i);
  }

  listIncidents(p: Principal) {
    authorize(p, 'integrite:incident.read');
    return this.incidents.all().sort((a, b) => b.declaredAt.localeCompare(a.declaredAt)).map((i) => this.incidentView(i));
  }

  /** Alertes techniques du socle non encore rattachées à un incident. */
  incidentCandidates(p: Principal) {
    authorize(p, 'integrite:incident.read');
    const linked = new Set(this.incidents.all().map((i) => i.fromAlertId).filter(Boolean));
    return this.ctx.alerts.list().filter((a) => !linked.has(a.id));
  }

  assignIncident(p: Principal, id: string, ownerId: string) {
    authorize(p, 'integrite:incident.manage');
    const i = this.getIncident(id);
    const owner = this.ctx.users.get(ownerId);
    if (!owner || !owner.roles.some((r) => ['R26', 'R27', 'R28'].includes(r))) throw unprocessable('INVALID_OWNER', 'Le propriétaire doit relever de la sécurité ou de l’exploitation (R26, R27, R28).');
    i.ownerId = owner.id;
    i.log.push({ at: this.now, by: p.id, status: i.status, note: `Propriétaire : ${owner.name}` });
    this.incidents.update(i);
    this.kit.audit(p, 'integrite.incident.assigned', 'incident', id, { ownerId });
    return this.incidentView(i);
  }

  moveIncident(p: Principal, id: string, input: { status: Exclude<IncidentStatus, 'DECLARE' | 'CLOS'>; note: string }) {
    authorize(p, 'integrite:incident.manage');
    const i = this.getIncident(id);
    const order: IncidentStatus[] = ['DECLARE', 'EN_COURS', 'CONTENU', 'RESOLU', 'CLOS'];
    if (i.status === 'CLOS') throw conflict('INCIDENT_CLOSED', 'Incident clos.');
    if (order.indexOf(input.status) <= order.indexOf(i.status)) throw conflict('INCIDENT_TRANSITION', `Transition ${i.status} → ${input.status} non permise (le cycle avance, il ne recule pas).`);
    if (!i.ownerId) throw conflict('INCIDENT_NO_OWNER', 'Désignez un propriétaire avant de faire avancer l’incident.');
    i.status = input.status;
    i.log.push({ at: this.now, by: p.id, status: input.status, note: input.note });
    this.incidents.update(i);
    this.kit.audit(p, 'integrite.incident.status_changed', 'incident', id, { status: input.status });
    return this.incidentView(i);
  }

  notifyIncident(p: Principal, id: string, input: { target: NotificationTarget; note: string }) {
    authorize(p, input.target === 'PERSONNES_CONCERNEES' ? 'integrite:incident.notify-persons' : 'integrite:incident.notify');
    const i = this.getIncident(id);
    let deliveries = 0;
    if (input.target === 'DPO') {
      deliveries = this.ctx.comms.publish('incident.declared', this.ctx.users.withRole('R25').map(userRecipient), { reference: i.id, gravite: i.severity.toLowerCase() }, { entity: 'PLATEFORME' }).length;
    } else if (input.target === 'PERSONNES_CONCERNEES') {
      if (!i.personalDataImpacted) throw conflict('NO_PERSONAL_DATA', 'Incident sans atteinte déclarée aux données personnelles.');
      const recips = i.affectedTaxpayerIds.map((t) => this.ctx.taxpayers.taxpayers.get(t)).filter((t) => !!t).map((t) => taxpayerRecipient(t!));
      deliveries = this.ctx.comms.publish('privacy.breach_notification', recips, { reference: i.id }, { entity: 'GOUVERNORAT' }).length;
    }
    i.notifications.push({ target: input.target, by: p.id, at: this.now, note: input.note, deliveries });
    this.incidents.update(i);
    this.kit.audit(p, 'integrite.incident.notified', 'incident', id, { target: input.target, deliveries });
    return this.incidentView(i);
  }

  closeIncident(p: Principal, id: string, input: { proofSha256: string; summary: string }) {
    authorize(p, 'integrite:incident.close');
    const i = this.getIncident(id);
    if (i.status !== 'RESOLU') throw conflict('INCIDENT_NOT_RESOLVED', 'Un incident se clôt une fois résolu, preuve à l’appui.');
    if (i.personalDataImpacted && !i.notifications.some((n) => n.target === 'DPO')) {
      throw conflict('DPO_NOT_NOTIFIED', 'Atteinte aux données personnelles : le délégué à la protection des données doit être informé avant la clôture.');
    }
    const now = this.now;
    i.closure = { proofSha256: input.proofSha256.toLowerCase(), summary: input.summary, by: p.id, at: now };
    i.status = 'CLOS';
    i.log.push({ at: now, by: p.id, status: 'CLOS', note: input.summary });
    this.incidents.update(i);
    this.kit.audit(p, 'integrite.incident.closed', 'incident', id, { proof: i.closure.proofSha256 });
    return this.incidentView(i);
  }

  /* ================================================================ */
  /* PROTECTION DES DONNÉES                                            */
  /* ================================================================ */

  private getPrivacy(id: string): PrivacyRequest {
    const r = this.privacyRequests.get(id);
    if (!r) throw notFound('PRIVACY_REQUEST_NOT_FOUND', `Demande inconnue : ${id}`);
    return r;
  }

  private privacyView(r: PrivacyRequest) {
    return { ...r, overdue: (r.status === 'RECUE' || r.status === 'EN_TRAITEMENT') && this.now > r.dueAt, delayNote: DELAYS.note };
  }

  submitPrivacy(p: Principal, input: { taxpayerId: string; type: PrivacyRequestType; details: string; field?: RectifiableField; requestedValue?: string }) {
    authorize(p, 'integrite:privacy.submit', { taxpayerId: input.taxpayerId });
    const t = this.ctx.taxpayers.get(input.taxpayerId);
    if (input.type === 'RECTIFICATION' && (!input.field || !input.requestedValue)) throw badRequest('RECTIFICATION_INCOMPLETE', 'Précisez la donnée à rectifier et la valeur demandée.');
    const r = this.privacyRequests.insert({
      id: this.kit.ids.next('DPD'), taxpayerId: t.id, type: input.type, details: input.details,
      ...(input.field ? { field: input.field } : {}), ...(input.requestedValue ? { requestedValue: input.requestedValue } : {}),
      submittedBy: p.id, submittedAt: this.now, dueAt: this.kit.plus(DELAYS.privacyRequestDays * DAY), status: 'RECUE',
    });
    this.kit.audit(p, 'integrite.privacy.request_received', 'privacy-request', r.id, { type: r.type, taxpayerId: t.id });
    if (r.type === 'ACCES') this.ctx.comms.publish('privacy.access_request.received', [taxpayerRecipient(t)], { reference: r.id }, { entity: 'GOUVERNORAT' });
    return this.privacyView(r);
  }

  listPrivacy(p: Principal) {
    if (evaluate(p, 'integrite:privacy.process')) return this.privacyRequests.all().sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)).map((r) => this.privacyView(r));
    if (p.kind === 'user' && (p.taxpayerId || p.mandants?.length)) {
      const mine = new Set([p.taxpayerId, ...(p.mandants ?? [])].filter(Boolean));
      return this.privacyRequests.find((r) => mine.has(r.taxpayerId)).map((r) => this.privacyView(r));
    }
    throw forbidden('FORBIDDEN', 'Consultation des demandes réservée au délégué à la protection des données et aux personnes concernées.');
  }

  takePrivacy(p: Principal, id: string) {
    authorize(p, 'integrite:privacy.process');
    const r = this.getPrivacy(id);
    if (r.status !== 'RECUE') throw conflict('PRIVACY_STATE', `Demande déjà ${r.status}.`);
    r.status = 'EN_TRAITEMENT'; r.handledBy = p.id;
    this.privacyRequests.update(r);
    this.kit.audit(p, 'integrite.privacy.request_taken', 'privacy-request', id);
    return this.privacyView(r);
  }

  respondPrivacy(p: Principal, id: string, input: { decision: 'ACCEPTEE' | 'REJETEE'; note: string }) {
    authorize(p, 'integrite:privacy.process');
    const r = this.getPrivacy(id);
    if (r.status === 'REPONDUE' || r.status === 'REJETEE') throw conflict('PRIVACY_STATE', 'Demande déjà traitée.');
    const t = this.ctx.taxpayers.get(r.taxpayerId);
    const now = this.now;
    if (input.decision === 'ACCEPTEE' && r.type === 'ACCES') {
      this.exports.set(r.id, this.buildExport(t.id));
      r.exportReady = true;
      this.ctx.comms.publish('privacy.data_export_ready', [taxpayerRecipient(t)], { reference: r.id }, { entity: 'GOUVERNORAT' });
    }
    if (input.decision === 'ACCEPTEE' && r.type === 'RECTIFICATION' && r.field && r.requestedValue) {
      const before = (t as unknown as Record<string, unknown>)[r.field];
      if (r.field === 'language' && !['fr', 'ln', 'sw', 'kg', 'lu', 'en'].includes(r.requestedValue)) throw unprocessable('INVALID_VALUE', 'Langue non prise en charge.');
      const updated = this.ctx.taxpayers.taxpayers.update({ ...t, [r.field]: r.requestedValue });
      this.kit.audit(p, 'integrite.privacy.rectified', 'taxpayer', t.id, { field: r.field, beforeHash: sha256Hex(String(before ?? '')), afterHash: sha256Hex(r.requestedValue) });
      this.ctx.comms.publish('privacy.rectification.done', [taxpayerRecipient(updated)], { reference: r.id }, { entity: 'GOUVERNORAT' });
    }
    r.status = input.decision === 'ACCEPTEE' ? 'REPONDUE' : 'REJETEE';
    r.response = { decision: input.decision, note: input.note, by: p.id, at: now };
    r.handledBy = p.id;
    this.privacyRequests.update(r);
    this.kit.audit(p, 'integrite.privacy.request_answered', 'privacy-request', id, { decision: input.decision });
    return this.privacyView(r);
  }

  private buildExport(taxpayerId: string) {
    const t = this.ctx.taxpayers.get(taxpayerId);
    const objects = this.ctx.objects.byTaxpayer(taxpayerId).map((o) => ({ id: o.id, category: o.category, commune: o.commune }));
    const obligations = this.ctx.assessment.byTaxpayer(taxpayerId).map((o) => ({ id: o.id, status: o.status, amount: o.amount }));
    // Historique des actions concernant la personne, sans données de tiers (identifiants d'agents pseudonymisés).
    const activity = this.ctx.audit.list({ resourceId: taxpayerId, limit: 1000 }).items.map((e) => ({
      at: e.at, action: e.action, actor: e.actor.kind === 'user' ? `agent ${sha256Hex(e.actor.id).slice(0, 8)}` : e.actor.kind,
    }));
    return {
      generatedAt: this.now,
      profile: { id: t.id, iuc: t.iuc, fullName: t.fullName, phone: t.phone, email: t.email ?? null, language: t.language, situation: t.situation, verificationLevel: t.verificationLevel, createdAt: t.createdAt },
      objects, obligations, activity,
      note: 'Extrait établi au titre du droit d’accès. Les données de tiers et les dossiers d’enquête éventuels en sont exclus.',
    };
  }

  getExport(p: Principal, id: string) {
    const r = this.getPrivacy(id);
    const allowed = evaluate(p, 'integrite:privacy.process') || evaluate(p, 'integrite:privacy.own', { taxpayerId: r.taxpayerId });
    if (!allowed) throw forbidden('FORBIDDEN', 'Export réservé à la personne concernée et au délégué à la protection des données.');
    const e = this.exports.get(id);
    if (!e) throw notFound('EXPORT_NOT_READY', 'Aucun export disponible pour cette demande.');
    this.kit.audit(p, 'integrite.privacy.export_downloaded', 'privacy-request', id);
    return e;
  }

  registry(p: Principal) {
    authorize(p, 'integrite:privacy.registry.read');
    const latest = new Map<string, ProcessingRecord & { recordId: string }>();
    for (const v of this.registryVersions.all()) {
      const cur = latest.get(v.recordId);
      if (!cur || v.version > cur.version) latest.set(v.recordId, v);
    }
    return [...latest.values()].map(({ recordId, ...v }) => ({ ...v, id: recordId })).sort((a, b) => a.id.localeCompare(b.id));
  }

  registryHistory(p: Principal, recordId: string) {
    authorize(p, 'integrite:privacy.registry.read');
    return this.registryVersions.find((v) => v.recordId === recordId).sort((a, b) => a.version - b.version);
  }

  /** Crée ou met à jour un traitement : nouvelle version, l'ancienne est conservée. */
  upsertRegistry(p: Principal | 'system', input: Omit<ProcessingRecord, 'id' | 'version' | 'updatedAt' | 'updatedBy'> & { id?: string }) {
    if (p !== 'system') authorize(p, 'integrite:privacy.registry.write');
    const recordId = input.id ?? this.kit.ids.next('TRT', 3);
    const prev = this.registryVersions.find((v) => v.recordId === recordId);
    const version = prev.length + 1;
    const { id: _i, ...body } = input;
    const rec = this.registryVersions.insert({ ...body, id: `${recordId}@v${version}`, recordId, version, updatedAt: this.now, updatedBy: p === 'system' ? 'système' : p.id });
    this.kit.audit(p, 'integrite.privacy.registry_updated', 'processing-record', recordId, { version });
    const { recordId: rid, ...v } = rec;
    return { ...v, id: rid };
  }

  /** Journal des consultations de dossiers individuels (finalité : contrôle du DPO). */
  accessLog(p: Principal, taxpayerId?: string) {
    authorize(p, 'integrite:privacy.accesslog');
    const views = this.ctx.audit.list({ limit: 100_000 }).items.filter((e) =>
      ['taxpayer.viewed', 'obligation.viewed', 'integrite.privacy.export_downloaded', 'access.denied'].includes(e.action) && (!taxpayerId || e.resourceId === taxpayerId));
    return views.slice(-300).reverse().map((e) => ({ at: e.at, action: e.action, actor: e.actor.id, actorKind: e.actor.kind, resourceType: e.resourceType, resourceId: e.resourceId, outcome: e.outcome }));
  }

  /* ================================================================ */
  /* REVUE DES ACCÈS                                                   */
  /* ================================================================ */

  private getReview(id: string): AccessReviewCampaign {
    const c = this.reviews.get(id);
    if (!c) throw notFound('REVIEW_NOT_FOUND', `Campagne de revue inconnue : ${id}`);
    return c;
  }

  private reviewView(c: AccessReviewCampaign, p?: Principal) {
    const decided = c.items.filter((i) => i.decision !== 'A_CONFIRMER').length;
    const items = p && p.kind === 'user' && !evaluate(p, 'integrite:access-review.launch') && !p.roles.includes('R22') && !p.roles.includes('R25')
      ? c.items.filter((i) => i.entity === p.entity)
      : c.items;
    return {
      ...c, items,
      progress: { total: c.items.length, decided, toRemove: c.items.filter((i) => i.decision === 'RETRAIT_A_EXECUTER').length, privileged: c.items.filter((i) => i.privileged).length },
      overdue: c.status === 'OUVERTE' && this.now > c.dueAt,
    };
  }

  launchReview(p: Principal | 'system', label: string) {
    if (p !== 'system') authorize(p, 'integrite:access-review.launch');
    if (this.reviews.findOne((c) => c.status === 'OUVERTE')) throw conflict('REVIEW_ALREADY_OPEN', 'Une campagne de revue est déjà ouverte : clôturez-la d’abord.');
    const now = this.now;
    const id = this.kit.ids.next('REV', 4);
    const items = this.ctx.users.all().flatMap((u) => u.roles.filter(isInternalRole).map((role) => ({
      id: `${id}-${u.id}-${role}`, userId: u.id, userName: u.name, entity: u.entity, role, roleLabel: ROLES[role],
      privileged: PRIVILEGED_ROLES.includes(role), decision: 'A_CONFIRMER' as const,
    })));
    const c = this.reviews.insert({
      id, label, launchedBy: p === 'system' ? 'système' : p.id, launchedAt: now, dueAt: this.kit.plus(DELAYS.accessReviewDays * DAY),
      nextReviewAt: this.kit.plus(DELAYS.accessReviewPeriodDays * DAY), status: 'OUVERTE', items,
    });
    this.kit.audit(p, 'integrite.access_review.launched', 'access-review', id, { items: items.length });
    this.ctx.comms.publish('audit.access_review.due', [...this.ctx.users.withRole('R08'), ...this.ctx.users.withRole('R28')].map(userRecipient), {}, { entity: 'PLATEFORME' });
    return this.reviewView(c);
  }

  listReviews(p: Principal) {
    authorize(p, 'integrite:access-review.read');
    return this.reviews.all().sort((a, b) => b.launchedAt.localeCompare(a.launchedAt)).map((c) => this.reviewView(c, p));
  }

  decideReviewItem(p: Principal, id: string, itemId: string, input: { decision: 'MAINTENU' | 'RETRAIT_A_EXECUTER'; reason: string }) {
    const c = this.getReview(id);
    if (c.status !== 'OUVERTE') throw conflict('REVIEW_CLOSED', 'Campagne clôturée.');
    const item = c.items.find((i) => i.id === itemId);
    if (!item) throw notFound('REVIEW_ITEM_NOT_FOUND', `Ligne de revue inconnue : ${itemId}`);
    authorize(p, 'integrite:access-review.decide', { entity: item.entity });
    assertDistinctPerson(p.id, [item.userId], 'Nul ne confirme ses propres accès : la revue est faite par un responsable distinct.');
    if (input.decision === 'RETRAIT_A_EXECUTER' && input.reason.trim().length < 5) throw badRequest('REASON_REQUIRED', 'Motif obligatoire pour un retrait.');
    item.decision = input.decision;
    item.reason = input.reason;
    item.decidedBy = p.id;
    item.decidedAt = this.now;
    this.reviews.update(c);
    this.kit.audit(p, 'integrite.access_review.decided', 'access-review', id, { userId: item.userId, role: item.role, decision: input.decision });
    return this.reviewView(c, p);
  }

  closeReview(p: Principal, id: string) {
    authorize(p, 'integrite:access-review.close');
    const c = this.getReview(id);
    if (c.status !== 'OUVERTE') throw conflict('REVIEW_CLOSED', 'Campagne déjà clôturée.');
    const pending = c.items.filter((i) => i.decision === 'A_CONFIRMER').length;
    if (pending > 0) throw conflict('REVIEW_INCOMPLETE', `${pending} accès restent à confirmer ou à retirer.`);
    c.status = 'CLOTUREE'; c.closedBy = p.id; c.closedAt = this.now;
    this.reviews.update(c);
    const removals = c.items.filter((i) => i.decision === 'RETRAIT_A_EXECUTER').map((i) => ({ userId: i.userId, role: i.role, reason: i.reason }));
    this.kit.audit(p, 'integrite.access_review.closed', 'access-review', id, { removals: removals.length });
    return { ...this.reviewView(c), removals, execution: 'Les retraits sont exécutés par l’administrateur de l’annuaire (IdP) et attestés ; la campagne en conserve la trace.' };
  }

  /* ================================================================ */
  /* INDICATEURS AGRÉGÉS                                               */
  /* ================================================================ */

  indicators(p: Principal) {
    authorize(p, 'integrite:indicators.read');
    const reports = this.reports.all();
    const closed = reports.filter((r) => r.closure);
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
    const cases = this.cases.all();
    const incidents = this.incidents.all();
    const alerts = this.alerts.all();
    const now = this.now;
    return {
      generatedAt: now,
      signalements: {
        total: reports.length,
        ouverts: reports.filter((r) => r.status !== 'CLOS').length,
        enRetard: reports.filter((r) => this.staffView(r).overdue).length,
        delaiMoyenJours: avg(closed.map((r) => hoursBetween(r.receivedAt, r.closure!.at) / 24)),
        partConfirmee: closed.length ? `${Math.round((closed.filter((r) => r.closure!.outcome === 'FONDE').length / closed.length) * 100)} %` : null,
        parCategorie: Object.fromEntries(Object.keys(REPORT_CATEGORY_LABELS).map((k) => [k, reports.filter((r) => r.category === k).length])),
        parCanal: Object.fromEntries(['WEB', 'SMS', 'SVI', 'NUMERO_GRATUIT', 'GUICHET'].map((k) => [k, reports.filter((r) => r.channel === k).length])),
      },
      alertes: {
        ouvertes: alerts.filter((a) => ['A_EXAMINER', 'EN_EXAMEN', 'CLOTURE_PROPOSEE'].includes(a.status)).length,
        classees: alerts.filter((a) => a.status === 'CLASSEE').length,
        versDossier: alerts.filter((a) => a.status === 'DOSSIER_OUVERT').length,
      },
      dossiers: {
        ouverts: cases.filter((c) => c.status !== 'DECIDE').length,
        decides: cases.filter((c) => c.status === 'DECIDE').length,
        delaiInstructionMoyenJours: avg(cases.filter((c) => c.decision).map((c) => hoursBetween(c.openedAt, c.decision!.at) / 24)),
      },
      controlesMystere: this.mysterySummary(),
      incidents: {
        ouverts: incidents.filter((i) => i.status !== 'CLOS').length,
        horsDelai: incidents.filter((i) => i.status !== 'CLOS' && now > i.dueAt).length,
        parGravite: Object.fromEntries(['CRITIQUE', 'ELEVEE', 'MOYENNE', 'FAIBLE'].map((s) => [s, incidents.filter((i) => i.severity === s).length])),
      },
      donnees: {
        demandesOuvertes: this.privacyRequests.find((r) => r.status === 'RECUE' || r.status === 'EN_TRAITEMENT').length,
        demandesEnRetard: this.privacyRequests.all().filter((r) => this.privacyView(r).overdue).length,
      },
      revueAcces: (() => {
        const open = this.reviews.findOne((c) => c.status === 'OUVERTE');
        return open ? { campagne: open.label, aConfirmer: open.items.filter((i) => i.decision === 'A_CONFIRMER').length, total: open.items.length } : null;
      })(),
      delais: DELAYS.note,
    };
  }

  /** Transparence publique : agrégats seulement (§ 18A.8 « résultats publiés de façon agrégée »). */
  publicSummary() {
    const reports = this.reports.all();
    const closed = reports.filter((r) => r.closure);
    return {
      signalementsRecus: reports.length,
      signalementsClos: closed.length,
      partConfirmee: closed.length ? `${Math.round((closed.filter((r) => r.closure!.outcome === 'FONDE').length / closed.length) * 100)} %` : null,
      controlesMystere: this.mysterySummary(),
      rappel: 'Aucun système ne supprime toute fraude : MOSOLO la rend difficile, rapide à détecter et impossible à effacer.',
      example: reports.some((r) => r.demo) || this.mystery.all().some((m) => m.demo),
    };
  }
}

/* ------------------------------------------------------------------ */

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) {
    const k = key(i);
    m.set(k, [...(m.get(k) ?? []), i]);
  }
  return m;
}

/** Nombre maximal d'événements dans une fenêtre glissante. */
function windowMax(ats: string[], windowMs: number): number {
  const t = ats.map((a) => new Date(a).getTime()).sort((a, b) => a - b);
  let best = 0;
  let j = 0;
  for (let i = 0; i < t.length; i++) {
    while (t[i]! - t[j]! > windowMs) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

/** Somme par devise (Money, jamais de flottant). */
function sumMoney(list: ({ amount: string; currency: string } | undefined)[]): string {
  const by = new Map<string, Money>();
  for (const m of list) {
    if (!m) continue;
    const cur = m.currency as CurrencyCode;
    const v = Money.of(m.amount, cur);
    by.set(cur, by.has(cur) ? by.get(cur)!.add(v) : v);
  }
  return [...by.entries()].map(([c, v]) => `${v.toDecimalString()} ${c}`).join(' + ') || '—';
}
