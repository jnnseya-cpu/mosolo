/**
 * Réclamations (§ 22.2) : dépôt par le contribuable → instruction (R20) → décision par une autorité distincte (R21).
 * Une décision favorable crée une obligation RECTIFICATIVE ; l'originale est conservée (jamais supprimée).
 * Compléments (§ 22, modules 37/36) : contestation typée, délais légaux calculés et décompte serveur, accusé de
 * réception horodaté, pièces jointes par empreinte SHA-256, historique complet, effet suspensif demandé par le
 * contribuable et décidé par l'autorité (jamais d'office), voie de recours suivante indiquée dans la décision,
 * suivi du dépassement du délai de réponse (`appeal.sla_breach`).
 */
import { Money, type MoneyJSON, type ObligationStatus } from '@mosolo/shared';
import type { AuditLog } from '../../core/audit.js';
import type { User, UserDirectory } from '../../core/auth.js';
import { DAY_MS, isoDate, kinshasaDate, type Clock } from '../../core/clock.js';
import { canonicalJson, sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, assertNotRelated, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { recordReductionGranted } from '../assessment/reductions.js';
import { PAYABLE_STATUSES, type AssessmentService } from '../assessment/service.js';
import type { CommunicationService } from '../communications/service.js';
import { taxpayerRecipient, userRecipient } from '../identity/recipients.js';
import type { TaxpayerService } from '../identity/service.js';
import { APPEAL_PROCEDURE, type AppealType } from './procedure.js';

export type AppealDecision = 'ACCEPTEE' | 'PARTIELLEMENT_ACCEPTEE' | 'REJETEE';

/**
 * Contestation sans écrit (§ 13A.6) : dépôt assisté au guichet (l'agent enregistre au nom de la personne, avec son
 * consentement oral enregistré ou devant témoin, après lecture du résumé) ou par le SVI (session authentifiée par code
 * secret, confirmation par touche). Le circuit d'instruction et de décision est inchangé.
 */
definePolicy('appeals:submit.assisted', { R12: GRANTS.always });

export interface AssistedSubmission {
  channel: 'GUICHET' | 'SVI' | 'USSD';
  consent: {
    method: 'ORAL_ENREGISTRE' | 'TEMOIN' | 'CONFIRMATION_CLAVIER';
    /** Résumé lu à la personne avant enregistrement (obligatoire). */
    summaryReadBack: boolean;
    at: string;
    /** Empreinte de l'enregistrement du consentement oral (guichet). */
    evidenceSha256?: string;
    witnessName?: string;
    /** Session SVI authentifiée (code secret) et son journal. */
    sessionId?: string;
  };
}

export interface AppealDocument {
  sha256: string;
  name: string;
  mediaType: string;
  sizeBytes?: number;
  addedBy: string;
  addedAt: string;
}

export interface AppealEvent {
  at: string;
  action: string;
  by: string;
  detail?: string;
}

export type SuspensiveStatus = 'NON_DEMANDE' | 'DEMANDE' | 'ACCORDE' | 'REFUSE';

export interface SuspensiveEffect {
  status: SuspensiveStatus;
  requestedAt?: string;
  requestReason?: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionReason?: string;
}

/** Vue calculée côté serveur (heure serveur) : délais, décompte, dépassement. */
export interface AppealDeadlines {
  notifiedOn: string;
  filingDeadline: string;
  filedLate: boolean;
  decisionDueBy: string;
  daysRemaining: number | null;
  state: 'DANS_LE_DELAI' | 'ECHEANCE_PROCHE' | 'DELAI_DEPASSE' | 'DECIDE_DANS_LE_DELAI' | 'DECIDE_HORS_DELAI';
  basis: typeof APPEAL_PROCEDURE.source;
  status: typeof APPEAL_PROCEDURE.status;
}

export interface Appeal {
  id: string;
  obligationId: string;
  taxpayerId: string;
  grounds: string;
  requestedAmount?: MoneyJSON;
  status: 'DEPOSEE' | 'PROPOSITION' | AppealDecision;
  submittedBy: string;
  submittedAt: string;
  instructorId?: string;
  proposal?: { decision: AppealDecision; analysis: string; proposedAmount?: MoneyJSON; at: string };
  decision?: {
    decision: AppealDecision; reason: string; decidedBy: string; at: string; rectifiedAmount?: MoneyJSON;
    /** Re-liquidation justificative (mêmes règle et version, entrées corrigées) : montant plancher de la décision. */
    reliquidation?: { inputs: Record<string, string>; localityRank: number; result: MoneyJSON };
  };
  rectifyingObligationId?: string;
  previousObligationStatus: string;
  type?: AppealType;
  documents?: AppealDocument[];
  history?: AppealEvent[];
  suspensiveEffect?: SuspensiveEffect;
  acknowledgement?: { number: string; at: string; contentHash: string };
  /** Voie de recours suivante, indiquée avec la décision. */
  nextRemedy?: { hierarchical: string; judicial: string; status: 'A_VERIFIER' };
  slaBreachNotifiedAt?: string;
  /**
   * Affectation dès le dépôt (Document maître FR 2, ch. 42 : « horodaté, affecté et suivi jusqu'à décision motivée ») :
   * file d'instruction de l'entité qui administre l'obligation (agents de contentieux R20) ; l'instructeur nommé est
   * celui qui instruit (instructorId), la décision revient à une autre personne (R21).
   */
  affectation?: { entity: string; file: 'INSTRUCTION_RECOURS'; roles: ['R20']; at: string; basis: string };
  /** Dépôt sans écrit (guichet ou SVI) : canal, agent et preuve du consentement. */
  assisted?: AssistedSubmission & { agentId?: string };
}

export type AppealView = Appeal & { deadlines: AppealDeadlines };

export interface DocumentInput { sha256: string; name: string; mediaType: string; sizeBytes?: number }

/** Arithmétique de dates calendaires (AAAA-MM-JJ → AAAA-MM-JJ) : minuit UTC n'est qu'un support de calcul. */
const addDays = (day: string, days: number) => isoDate(new Date(new Date(`${day.slice(0, 10)}T00:00:00Z`).getTime() + days * DAY_MS));
/** Jour calendaire à Kinshasa d'un horodatage ISO (notification, dépôt, décision). */
const kinDay = (iso: string) => kinshasaDate(new Date(iso));

export class AppealService {
  readonly appeals = new InMemoryRepository<Appeal>();
  private readonly ids = new IdGenerator();

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly comms: CommunicationService,
    private readonly assessment: AssessmentService,
    private readonly taxpayers: TaxpayerService,
  ) {}

  get(id: string): Appeal {
    const a = this.appeals.get(id);
    if (!a) throw notFound('APPEAL_NOT_FOUND', `Réclamation inconnue : ${id}`);
    return a;
  }

  private event(a: Appeal, action: string, by: string, detail?: string): AppealEvent[] {
    return [...(a.history ?? []), { at: this.clock.now().toISOString(), action, by, ...(detail ? { detail } : {}) }];
  }

  /** Délais calculés à l'heure serveur, en jours calendaires de Kinshasa (valeurs de conception À VÉRIFIER, voir procedure.ts). */
  deadlines(a: Appeal): AppealDeadlines {
    const obligation = this.assessment.obligations.get(a.obligationId);
    const notifiedOn = kinDay(obligation?.createdAt ?? a.submittedAt);
    const filingDeadline = addDays(notifiedOn, APPEAL_PROCEDURE.filingDelayDays);
    const decisionDueBy = addDays(kinDay(a.submittedAt), APPEAL_PROCEDURE.decisionDelayDays);
    const today = kinshasaDate(this.clock.now());
    const dayMs = (d: string) => new Date(`${d}T00:00:00Z`).getTime();
    let state: AppealDeadlines['state'];
    let daysRemaining: number | null = null;
    if (a.decision) {
      state = kinDay(a.decision.at) <= decisionDueBy ? 'DECIDE_DANS_LE_DELAI' : 'DECIDE_HORS_DELAI';
    } else {
      daysRemaining = Math.round((dayMs(decisionDueBy) - dayMs(today)) / DAY_MS);
      state = daysRemaining < 0 ? 'DELAI_DEPASSE' : daysRemaining <= APPEAL_PROCEDURE.approachingDays ? 'ECHEANCE_PROCHE' : 'DANS_LE_DELAI';
    }
    return {
      notifiedOn, filingDeadline, filedLate: kinDay(a.submittedAt) > filingDeadline, decisionDueBy, daysRemaining, state,
      basis: APPEAL_PROCEDURE.source, status: APPEAL_PROCEDURE.status,
    };
  }

  view(a: Appeal): AppealView {
    return { ...a, deadlines: this.deadlines(a) };
  }

  /** Liste filtrée (le contrôle d'accès est fait par l'appelant). */
  list(filter: { taxpayerId?: string; taxpayerIds?: string[]; status?: string } = {}): AppealView[] {
    return this.appeals
      .find((a) => (!filter.taxpayerId || a.taxpayerId === filter.taxpayerId) && (!filter.taxpayerIds || filter.taxpayerIds.includes(a.taxpayerId)) && (!filter.status || a.status === filter.status))
      .sort((x, y) => y.submittedAt.localeCompare(x.submittedAt))
      .map((a) => this.view(a));
  }

  /** Réclamation ouverte (non décidée) sur une obligation. */
  openFor(obligationId: string): Appeal | undefined {
    return this.appeals.findOne((a) => a.obligationId === obligationId && (a.status === 'DEPOSEE' || a.status === 'PROPOSITION'));
  }

  private normalizeDocument(user: User, d: DocumentInput): AppealDocument {
    const sha = d.sha256.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha)) throw badRequest('INVALID_DOCUMENT_HASH', 'Empreinte SHA-256 attendue (64 caractères hexadécimaux).');
    return { sha256: sha, name: d.name, mediaType: d.mediaType, ...(d.sizeBytes !== undefined ? { sizeBytes: d.sizeBytes } : {}), addedBy: user.id, addedAt: this.clock.now().toISOString() };
  }

  submit(user: User, input: { obligationId: string; grounds: string; requestedAmount?: MoneyJSON; type?: AppealType; requestSuspensiveEffect?: boolean; suspensiveReason?: string; documents?: DocumentInput[] }, assisted?: AssistedSubmission): AppealView {
    const obligation = this.assessment.get(input.obligationId);
    if (!assisted) authorize(user, 'appeal.submit', { taxpayerId: obligation.taxpayerId });
    else {
      if (!assisted.consent.summaryReadBack) throw unprocessable('CONSENT_REQUIRED', 'Le résumé de la contestation doit être lu à la personne avant l’enregistrement.');
      if (assisted.channel === 'GUICHET') {
        authorize(user, 'appeals:submit.assisted', { taxpayerId: obligation.taxpayerId });
        assertNotRelated(user, obligation.taxpayerId, 'Un agent n’enregistre pas la contestation d’un contribuable auquel il est lié.');
        if (assisted.consent.method === 'ORAL_ENREGISTRE' && !assisted.consent.evidenceSha256) throw unprocessable('CONSENT_REQUIRED', 'Consentement oral : l’empreinte de l’enregistrement est requise.');
        if (assisted.consent.method === 'TEMOIN' && !assisted.consent.witnessName) throw unprocessable('CONSENT_REQUIRED', 'Consentement devant témoin : le nom du témoin est requis.');
        if (assisted.consent.method === 'CONFIRMATION_CLAVIER') throw badRequest('INVALID_CONSENT', 'Mode de consentement réservé au SVI et à l’USSD.');
      } else if (assisted.consent.method !== 'CONFIRMATION_CLAVIER' || !assisted.consent.sessionId) {
        throw forbidden('FORBIDDEN', 'Contestation par SVI ou USSD : session authentifiée requise.');
      }
    }
    if (this.appeals.findOne((a) => a.obligationId === obligation.id && (a.status === 'DEPOSEE' || a.status === 'PROPOSITION'))) {
      throw conflict('APPEAL_ALREADY_OPEN', 'Une réclamation est déjà en cours sur cette obligation.');
    }
    if (!PAYABLE_STATUSES.includes(obligation.status)) {
      throw unprocessable('OBLIGATION_NOT_APPEALABLE', `Obligation au statut ${obligation.status} : réclamation impossible par ce circuit.`);
    }
    if (input.requestedAmount && input.requestedAmount.currency !== obligation.amount.currency) {
      throw badRequest('CURRENCY_MISMATCH', `Montant demandé attendu en ${obligation.amount.currency}.`);
    }
    const now = this.clock.now().toISOString();
    const id = this.ids.next('REC');
    const documents: AppealDocument[] = [];
    for (const d of input.documents ?? []) {
      const doc = this.normalizeDocument(user, d);
      if (!documents.some((x) => x.sha256 === doc.sha256)) documents.push(doc);
    }
    const suspensiveEffect: SuspensiveEffect = input.requestSuspensiveEffect
      ? { status: 'DEMANDE', requestedAt: now, ...(input.suspensiveReason ? { requestReason: input.suspensiveReason } : {}) }
      : { status: 'NON_DEMANDE' };
    // Accusé de réception horodaté : numéro + empreinte du contenu déposé.
    const ackContent = { id, obligationId: obligation.id, grounds: input.grounds, type: input.type ?? 'AUTRE', at: now, documents: documents.map((d) => d.sha256) };
    const appeal = this.appeals.insert({
      id,
      obligationId: obligation.id,
      taxpayerId: obligation.taxpayerId,
      grounds: input.grounds,
      ...(input.requestedAmount ? { requestedAmount: Money.fromJSON(input.requestedAmount).toJSON() } : {}),
      status: 'DEPOSEE',
      submittedBy: user.id,
      submittedAt: now,
      previousObligationStatus: obligation.status,
      type: input.type ?? 'AUTRE',
      documents,
      suspensiveEffect,
      acknowledgement: { number: `AR-${id}`, at: now, contentHash: sha256Hex(canonicalJson(ackContent)) },
      affectation: { entity: obligation.entity, file: 'INSTRUCTION_RECOURS', roles: ['R20'], at: now, basis: `Entité administratrice de l’obligation ${obligation.id} (${obligation.ruleCode} v${obligation.ruleVersion})` },
      ...(assisted ? { assisted: { ...assisted, ...(assisted.channel === 'GUICHET' ? { agentId: user.id } : {}) } } : {}),
      history: [
        { at: now, action: 'appeal.submitted', by: user.id, detail: `Type : ${input.type ?? 'AUTRE'}${documents.length ? ` — ${documents.length} pièce(s)` : ''}${assisted ? ` — sans écrit (${assisted.channel === 'GUICHET' ? 'guichet, consentement ' + (assisted.consent.method === 'TEMOIN' ? 'devant témoin' : 'oral enregistré')   : `${assisted.channel}, confirmation par touche`})` : ''}` },
        ...(input.requestSuspensiveEffect ? [{ at: now, action: 'appeal.suspensive_effect.requested', by: user.id }] : []),
      ],
    });
    this.assessment.setStatus(obligation.id, 'CONTESTEE');
    this.audit.append({ actor: assisted && assisted.channel !== 'GUICHET' ? { kind: 'public', id: user.id } : { kind: 'user', id: user.id, roles: user.roles }, action: 'appeal.submitted', resourceType: 'appeal', resourceId: appeal.id, details: { obligationId: obligation.id, type: appeal.type, affectation: obligation.entity, documents: documents.length, suspensiveEffectRequested: !!input.requestSuspensiveEffect, ...(assisted ? { channel: assisted.channel, consentMethod: assisted.consent.method, sessionId: assisted.consent.sessionId ?? null } : {}) } });
    this.comms.publish('appeal.submitted', [taxpayerRecipient(this.taxpayers.get(obligation.taxpayerId))], { reference: appeal.id }, { entity: 'CONTENTIEUX' });
    return this.view(appeal);
  }

  /** Pièce jointe par empreinte (le fichier lui-même relève du service documentaire) ; dédoublonnée. */
  addDocument(user: User, id: string, input: DocumentInput): AppealView {
    const appeal = this.get(id);
    if (appeal.status !== 'DEPOSEE' && appeal.status !== 'PROPOSITION') throw conflict('APPEAL_CLOSED', 'Réclamation décidée : aucune pièce ne peut être ajoutée.');
    const doc = this.normalizeDocument(user, input);
    if ((appeal.documents ?? []).some((d) => d.sha256 === doc.sha256)) return this.view(appeal);
    const updated = this.appeals.update({ ...appeal, documents: [...(appeal.documents ?? []), doc], history: this.event(appeal, 'appeal.document.added', user.id, `${doc.name} (${doc.sha256.slice(0, 12)}…)`) });
    this.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'appeal.document.added', resourceType: 'appeal', resourceId: id, details: { sha256: doc.sha256, mediaType: doc.mediaType } });
    return this.view(updated);
  }

  /** Demande d'effet suspensif (par le contribuable, après dépôt). */
  requestSuspensiveEffect(user: User, id: string, reason: string): AppealView {
    const appeal = this.get(id);
    if (appeal.status !== 'DEPOSEE' && appeal.status !== 'PROPOSITION') throw conflict('APPEAL_CLOSED', 'Réclamation déjà décidée.');
    const current = appeal.suspensiveEffect?.status ?? 'NON_DEMANDE';
    if (current !== 'NON_DEMANDE') throw conflict('SUSPENSIVE_EFFECT_ALREADY_REQUESTED', `Effet suspensif déjà ${current === 'DEMANDE' ? 'demandé' : 'décidé'}.`);
    const now = this.clock.now().toISOString();
    const updated = this.appeals.update({ ...appeal, suspensiveEffect: { status: 'DEMANDE', requestedAt: now, requestReason: reason }, history: this.event(appeal, 'appeal.suspensive_effect.requested', user.id, reason) });
    this.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'appeal.suspensive_effect.requested', resourceType: 'appeal', resourceId: id, details: {} });
    return this.view(updated);
  }

  /** Décision motivée de l'autorité sur l'effet suspensif (R21). */
  decideSuspensiveEffect(user: User, id: string, input: { granted: boolean; reason: string }): AppealView {
    authorize(user, 'appeal.decide');
    const appeal = this.get(id);
    if (appeal.suspensiveEffect?.status !== 'DEMANDE') throw conflict('SUSPENSIVE_EFFECT_NOT_REQUESTED', 'Aucune demande d’effet suspensif en attente.');
    const now = this.clock.now().toISOString();
    const status: SuspensiveStatus = input.granted ? 'ACCORDE' : 'REFUSE';
    const updated = this.appeals.update({
      ...appeal,
      suspensiveEffect: { ...appeal.suspensiveEffect, status, decidedBy: user.id, decidedAt: now, decisionReason: input.reason },
      history: this.event(appeal, `appeal.suspensive_effect.${input.granted ? 'granted' : 'refused'}`, user.id, input.reason),
    });
    this.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'appeal.suspensive_effect.decided', resourceType: 'appeal', resourceId: id, details: { status, reason: input.reason } });
    this.comms.publish('appeal.info_requested', [taxpayerRecipient(this.taxpayers.get(appeal.taxpayerId))], { reference: appeal.id }, { entity: 'CONTENTIEUX' });
    return this.view(updated);
  }

  /**
   * Suivi des délais de réponse : signale une fois chaque réclamation hors délai (`appeal.sla_breach`)
   * à la direction de la régie (R06) et à l'audit interne (R22). Aucun effet sur le fond du dossier.
   */
  sweepDeadlines(users: UserDirectory): string[] {
    const breached: string[] = [];
    for (const a of this.appeals.all()) {
      if (a.decision || a.slaBreachNotifiedAt) continue;
      const d = this.deadlines(a);
      if (d.state !== 'DELAI_DEPASSE') continue;
      const now = this.clock.now().toISOString();
      this.appeals.update({ ...a, slaBreachNotifiedAt: now, history: this.event(a, 'appeal.sla_breach', 'systeme', `Décision attendue avant le ${d.decisionDueBy}`) });
      this.audit.append({ actor: { kind: 'system', id: 'suivi-delais-recours' }, action: 'appeal.sla_breach', resourceType: 'appeal', resourceId: a.id, details: { decisionDueBy: d.decisionDueBy } });
      const recipients: User[] = [...users.withRole('R06'), ...users.withRole('R22')];
      this.comms.publish('appeal.sla_breach', recipients.map(userRecipient), { reference: a.id }, { entity: 'CONTENTIEUX' });
      breached.push(a.id);
    }
    return breached;
  }

  instruct(user: User, id: string, input: { proposal: AppealDecision; analysis: string; proposedAmount?: MoneyJSON }): Appeal {
    authorize(user, 'appeal.instruct');
    const appeal = this.get(id);
    if (appeal.status !== 'DEPOSEE') throw conflict('INVALID_APPEAL_STATE', `Réclamation au statut ${appeal.status}.`);
    assertNotRelated(user, appeal.taxpayerId, 'Conflit d’intérêts : l’instructeur est lié au contribuable réclamant.');
    if (input.proposedAmount) {
      const ob = this.assessment.get(appeal.obligationId);
      if (input.proposedAmount.currency !== ob.amount.currency) throw badRequest('CURRENCY_MISMATCH', `Montant proposé attendu en ${ob.amount.currency}.`);
      if (Money.fromJSON(input.proposedAmount).isNegative()) throw unprocessable('INVALID_RECTIFIED_AMOUNT', 'Le montant proposé ne peut être négatif.');
    }
    const updated = this.appeals.update({
      ...appeal,
      status: 'PROPOSITION',
      instructorId: user.id,
      history: this.event(appeal, 'appeal.instructed', user.id, `Proposition : ${input.proposal}`),
      proposal: {
        decision: input.proposal, analysis: input.analysis, at: this.clock.now().toISOString(),
        ...(input.proposedAmount ? { proposedAmount: Money.fromJSON(input.proposedAmount).toJSON() } : {}),
      },
    });
    this.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'appeal.instructed', resourceType: 'appeal', resourceId: id, details: { proposal: input.proposal } });
    return updated;
  }

  /**
   * Décision (R21). Une décision favorable est une RÉDUCTION de créance : montant explicite (jamais « absent = 0 »),
   * motif circonstancié, jamais inférieur au montant demandé par le contribuable ni à la proposition de l'instructeur,
   * ni au résultat de la re-liquidation justificative si elle est fournie ; décideur sans lien avec le contribuable.
   */
  decide(user: User, id: string, input: { decision: AppealDecision; reason: string; rectifiedAmount?: MoneyJSON; reliquidationInputs?: Record<string, string> }): Appeal {
    authorize(user, 'appeal.decide');
    const appeal = this.get(id);
    if (appeal.status === 'DEPOSEE') throw conflict('APPEAL_NOT_INSTRUCTED', 'La réclamation doit être instruite avant décision.');
    if (appeal.status !== 'PROPOSITION') throw conflict('INVALID_APPEAL_STATE', `Réclamation déjà décidée (${appeal.status}).`);
    assertDistinctPerson(user.id, appeal.instructorId ? [appeal.instructorId] : [], "L'autorité de décision doit être distincte de l'agent instructeur.");
    const obligation = this.assessment.get(appeal.obligationId);
    // Le décideur est aussi distinct de l'auteur de la liquidation contestée (module 37, contrôle C1).
    if (obligation.createdBy === user.id) throw forbidden('SEPARATION_OF_DUTIES', "L'autorité de décision doit être distincte de l'auteur de la liquidation contestée.");
    assertNotRelated(user, appeal.taxpayerId, 'Conflit d’intérêts : l’autorité de décision est liée au contribuable réclamant.');
    const actor = { kind: 'user' as const, id: user.id, roles: user.roles };
    const now = this.clock.now().toISOString();
    let rectifyingObligationId: string | undefined;
    let rectifiedAmount: MoneyJSON | undefined;
    let decisionReliquidation: NonNullable<Appeal['decision']>['reliquidation'];

    if (input.decision === 'REJETEE') {
      // L'obligation reprend l'état que justifient les paiements (jamais « EMISE » d'office sur une obligation payée).
      const paid = this.assessment.paidAmount(obligation.id);
      const restored: ObligationStatus = paid.compare(Money.fromJSON(obligation.amount)) >= 0 && !paid.isZero() ? 'SOLDEE'
        : !paid.isZero() ? 'PARTIELLEMENT_PAYEE'
          : (appeal.previousObligationStatus as ObligationStatus);
      this.assessment.setStatus(obligation.id, restored === 'CONTESTEE' ? 'EMISE' : restored);
    } else {
      const original = Money.fromJSON(obligation.amount);
      // Montant décidé toujours explicite : une acceptation totale se décide « 0 » en connaissance de cause.
      if (!input.rectifiedAmount) {
        throw badRequest('RECTIFIED_AMOUNT_REQUIRED', input.decision === 'ACCEPTEE'
          ? 'Montant rectifié obligatoire, y compris pour une acceptation totale (saisir 0 explicitement).'
          : 'Montant rectifié obligatoire pour une acceptation partielle.');
      }
      if (input.reason.trim().length < 10) throw badRequest('REASON_REQUIRED', 'Motif circonstancié obligatoire (au moins 10 caractères) pour toute réduction.');
      const amount = Money.fromJSON(input.rectifiedAmount);
      if (amount.currency !== original.currency) throw badRequest('CURRENCY_MISMATCH', `Montant rectifié attendu en ${original.currency}.`);
      if (amount.isNegative() || amount.compare(original) >= 0) {
        throw unprocessable('INVALID_RECTIFIED_AMOUNT', 'Le montant rectifié doit être positif et inférieur au montant initial.');
      }
      // Acceptation totale : exactement ce que demande le contribuable (0 si toute l'obligation est contestée).
      const claimed = appeal.requestedAmount ? Money.fromJSON(appeal.requestedAmount) : Money.zero(original.currency);
      if (input.decision === 'ACCEPTEE' && !amount.equals(claimed)) {
        throw unprocessable('INVALID_RECTIFIED_AMOUNT', `Acceptation totale : montant rectifié égal au montant réclamé (${claimed.toDecimalString()} ${claimed.currency}) ; un autre montant relève d’une acceptation partielle.`);
      }
      if (input.decision === 'PARTIELLEMENT_ACCEPTEE' && amount.isZero()) {
        throw unprocessable('INVALID_RECTIFIED_AMOUNT', 'Acceptation partielle : le montant rectifié doit être strictement positif (0 = acceptation totale).');
      }
      // Jamais plus que ce que le contribuable demande, ni plus que ce que l'instruction propose.
      const floors: { label: string; m: Money }[] = [];
      if (appeal.requestedAmount && appeal.requestedAmount.currency === original.currency) floors.push({ label: 'montant demandé par le contribuable', m: Money.fromJSON(appeal.requestedAmount) });
      if (appeal.proposal?.proposedAmount && appeal.proposal.proposedAmount.currency === original.currency) floors.push({ label: 'proposition de l’instructeur', m: Money.fromJSON(appeal.proposal.proposedAmount) });
      let reliquidation: NonNullable<Appeal['decision']>['reliquidation'];
      if (input.reliquidationInputs) {
        reliquidation = this.assessment.reliquidate(obligation.id, input.reliquidationInputs);
        floors.push({ label: `re-liquidation (règle ${obligation.ruleCode} v${obligation.ruleVersion})`, m: Money.fromJSON(reliquidation.result) });
      }
      for (const f of floors) {
        if (amount.compare(f.m) < 0) {
          throw unprocessable('RECTIFIED_AMOUNT_BELOW_JUSTIFIED', `Montant décidé ${amount.toDecimalString()} inférieur au ${f.label} (${f.m.toDecimalString()} ${f.m.currency}) : réduction non justifiée.`, { floor: f.m.toJSON(), basis: f.label });
        }
      }
      const rectified = this.assessment.rectify(obligation.id, amount.toJSON(), { appealId: appeal.id, reason: input.reason, decidedBy: user, decisionType: 'RECLAMATION', zeroStatus: 'ANNULEE' });
      rectifyingObligationId = rectified.id;
      rectifiedAmount = amount.toJSON();
      decisionReliquidation = reliquidation;
      recordReductionGranted(this.audit, actor, {
        path: 'RECLAMATION', obligationId: obligation.id, fromAmount: obligation.amount, toAmount: amount.toJSON(), deciderId: user.id,
        taxpayerId: appeal.taxpayerId, resultingObligationId: rectified.id, sourceId: appeal.id,
        approvers: [...(appeal.instructorId ? [appeal.instructorId] : []), user.id],
      });
    }
    const updated = this.appeals.update({
      ...appeal,
      status: input.decision,
      decision: { decision: input.decision, reason: input.reason, decidedBy: user.id, at: now, ...(rectifiedAmount ? { rectifiedAmount } : {}), ...(decisionReliquidation ? { reliquidation: decisionReliquidation } : {}) },
      ...(rectifyingObligationId ? { rectifyingObligationId } : {}),
      nextRemedy: { ...APPEAL_PROCEDURE.nextRemedy, status: 'A_VERIFIER' },
      history: this.event(appeal, 'appeal.decided', user.id, `${input.decision} — ${input.reason}`),
    });
    this.audit.append({ actor, action: 'appeal.decided', resourceType: 'appeal', resourceId: id, details: { decision: input.decision, rectifyingObligationId: rectifyingObligationId ?? null } });
    this.comms.publish('appeal.decided', [taxpayerRecipient(this.taxpayers.get(appeal.taxpayerId))], { reference: appeal.id }, { entity: 'CONTENTIEUX' });
    return updated;
  }
}
