/**
 * Registre juridique et moteur de règles (§ 6.12) :
 * cycle BROUILLON → REVUE_JURIDIQUE → REVUE_FINANCIERE → APPROUVEE → PUBLIEE → ACTIVE (date d'effet),
 * quatre approbations par quatre personnes distinctes, liste noire des instruments abrogés.
 * Compléments (§ 6.2, § 6.3, module 26) : suspension motivée (autorité, motif), abrogation datée par un instrument
 * abrogatoire (aucune liquidation après la date), historique des versions, blocage de la rétroactivité non autorisée
 * (une nouvelle version dont la date d'effet précède sa publication exige un acte l'autorisant).
 */
import {
  REQUIRED_APPROVALS, SAMPLE_RULES, type Approval, type LegalInstrumentStatus, type RoleCode, type RuleSheet, type RuleStatus,
} from '@mosolo/shared';
import type { AuditLog } from '../../core/audit.js';
import type { User, UserDirectory } from '../../core/auth.js';
import type { Clock } from '../../core/clock.js';
import { isoDate } from '../../core/clock.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { InMemoryRepository } from '../../core/repository.js';
import type { CommunicationService } from '../communications/service.js';
import { userRecipient } from '../identity/recipients.js';
import { evaluateFormula, formulaIdentifiers, FormulaError, parseFormula } from './formula.js';

export interface LegalInstrument {
  id: string;
  title: string;
  status: LegalInstrumentStatus;
  abrogatedOn?: string;
  abrogatedBy?: string;
  officialDocumentHash?: string;
  note?: string;
  demo?: boolean;
}

/** Entrée de l'historique d'une version de règle (ajout seul). */
export interface RuleHistoryEntry {
  at: string;
  action: string;
  by: string;
  status: RuleStatus;
  detail?: string;
}

/** Suspension : décision motivée d'une autorité ; la règle ne produit plus aucune obligation tant qu'elle dure. */
export interface RuleSuspension {
  reason: string;
  authority: string;
  instrumentRef?: string;
  by: string;
  at: string;
  previousStatus: RuleStatus;
  liftedAt?: string;
  liftedBy?: string;
  liftReason?: string;
}

/** Abrogation : date et instrument abrogatoire ; aucune nouvelle liquidation à compter de la date. */
export interface RuleAbrogation {
  date: string;
  instrumentId: string;
  reason: string;
  by: string;
  at: string;
}

/** Acte autorisant expressément une application rétroactive (sinon : publication bloquée). */
export interface RetroactivityAuthorization {
  instrumentId: string;
  article: string;
  justification: string;
}

export interface RuleRecord extends RuleSheet {
  createdBy?: string;
  createdAt: string;
  publishedAt?: string;
  activatedAt?: string;
  /** Fiche modèle de l'Annexe B (shared SAMPLE_RULES). */
  sample?: boolean;
  /** Règle fictive de démonstration (aucune valeur juridique). */
  demo?: boolean;
  suspension?: RuleSuspension;
  /** Suspensions antérieures levées. */
  pastSuspensions?: RuleSuspension[];
  abrogation?: RuleAbrogation;
  retroactivity?: RetroactivityAuthorization;
  /** Version qui a remplacé celle-ci (à l'activation de la nouvelle version). */
  supersededBy?: string;
  history?: RuleHistoryEntry[];
}

export type RuleInput = Omit<RuleSheet, 'id' | 'version' | 'status' | 'approvals' | 'supersedesVersionId'> & {
  changeReason?: string;
  retroactivity?: RetroactivityAuthorization;
};

/** Actions complémentaires du registre (moindre privilège : non déclaré ⇒ refusé). */
definePolicy('rules:suspend', { R16: GRANTS.always });
definePolicy('rules:abrogate', { R16: GRANTS.always });
definePolicy('rules:instrument.abrogate', { R16: GRANTS.always });
definePolicy('rules:recalc.simulate', {
  R13: GRANTS.always, R14: GRANTS.always, R15: GRANTS.always, R16: GRANTS.always,
  R06: GRANTS.always, R07: GRANTS.always, R11: GRANTS.always, R22: GRANTS.always,
});
/** Application d'un recalcul : direction de la régie administrant la recette (même entité). */
definePolicy('rules:recalc.decide', { R06: GRANTS.sameEntity });

const IN_FORCE: LegalInstrumentStatus[] = ['EN_VIGUEUR', 'MODIFIE'];

/** Rôle d'habilitation exigé pour chaque type d'approbation. */
export const APPROVAL_ROLE: Record<Approval['role'], RoleCode> = {
  REDACTEUR: 'R13',
  VERIFICATEUR_JURIDIQUE: 'R14',
  VALIDATEUR_FINANCIER: 'R15',
  AUTORITE_PUBLICATION: 'R16',
};

/** Statut attendu avant chaque approbation, et statut obtenu après. */
const FLOW: Record<Approval['role'], { from: RuleStatus; to: RuleStatus; event: string }> = {
  REDACTEUR: { from: 'BROUILLON', to: 'REVUE_JURIDIQUE', event: 'rule.draft.submitted' },
  VERIFICATEUR_JURIDIQUE: { from: 'REVUE_JURIDIQUE', to: 'REVUE_FINANCIERE', event: 'rule.legal_review.done' },
  VALIDATEUR_FINANCIER: { from: 'REVUE_FINANCIERE', to: 'APPROUVEE', event: 'rule.financial_review.done' },
  AUTORITE_PUBLICATION: { from: 'APPROUVEE', to: 'PUBLIEE', event: 'rule.published' },
};

export interface FormulaEvaluation {
  value: string;
  inputs: Record<string, string>;
  rates: Record<string, string>;
}

export class RuleService {
  readonly rules = new InMemoryRepository<RuleRecord>();
  readonly instruments = new InMemoryRepository<LegalInstrument>();

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly comms: CommunicationService,
    private readonly users: UserDirectory,
    private readonly aliasExists: (alias: string) => boolean,
  ) {}

  seedSamples(): void {
    for (const r of SAMPLE_RULES) this.rules.insert({ ...structuredClone(r), createdAt: this.clock.now().toISOString(), sample: true });
  }

  instrument(id: string): LegalInstrument | undefined {
    return this.instruments.get(id);
  }

  private withHistory(r: RuleRecord, action: string, by: string, status: RuleStatus, detail?: string): RuleHistoryEntry[] {
    return [...(r.history ?? []), { at: this.clock.now().toISOString(), action, by, status, ...(detail ? { detail } : {}) }];
  }

  /**
   * Passe PUBLIEE → ACTIVE à la date d'effet (la version antérieure ACTIVE du même code est alors remplacée),
   * ACTIVE → EXPIREE après la date de fin, ACTIVE/PUBLIEE → ABROGEE à la date d'abrogation.
   * Une règle SUSPENDUE n'évolue pas tant que la suspension n'est pas levée.
   */
  refresh(): void {
    const now = this.clock.now();
    const today = isoDate(now);
    const system = { kind: 'system' as const, id: 'moteur-regles' };
    for (const snap of this.rules.all()) {
      const r = this.rules.get(snap.id)!;
      if ((r.status === 'ACTIVE' || r.status === 'PUBLIEE') && r.abrogation && r.abrogation.date <= today) {
        this.rules.update({ ...r, status: 'ABROGEE', history: this.withHistory(r, 'rule.abrogated.effective', 'moteur-regles', 'ABROGEE', `Abrogation effective le ${r.abrogation.date} (${r.abrogation.instrumentId})`) });
        this.audit.append({ actor: system, action: 'rule.abrogated.effective', resourceType: 'rule', resourceId: r.id, details: { date: r.abrogation.date, instrumentId: r.abrogation.instrumentId } });
      } else if (r.status === 'PUBLIEE' && r.effectiveFrom <= today) {
        this.rules.update({ ...r, status: 'ACTIVE', activatedAt: now.toISOString(), history: this.withHistory(r, 'rule.activated', 'moteur-regles', 'ACTIVE', `Date d'effet ${r.effectiveFrom}`) });
        this.audit.append({ actor: system, action: 'rule.activated', resourceType: 'rule', resourceId: r.id, details: { effectiveFrom: r.effectiveFrom } });
        this.comms.publish('rule.activated', this.users.withRole('R16').map(userRecipient), { reference: r.code }, { entity: r.administeringEntity });
        // La version antérieure encore ACTIVE cesse de produire des obligations (jamais de suppression).
        for (const prev of this.rules.find((x) => x.code === r.code && x.version < r.version && x.status === 'ACTIVE')) {
          this.rules.update({ ...prev, status: 'EXPIREE', supersededBy: r.id, history: this.withHistory(prev, 'rule.superseded', 'moteur-regles', 'EXPIREE', `Remplacée par la version ${r.version} (${r.id})`) });
          this.audit.append({ actor: system, action: 'rule.superseded', resourceType: 'rule', resourceId: prev.id, details: { supersededBy: r.id } });
        }
      } else if (r.status === 'ACTIVE' && r.effectiveTo && r.effectiveTo < today) {
        this.rules.update({ ...r, status: 'EXPIREE', history: this.withHistory(r, 'rule.expired', 'moteur-regles', 'EXPIREE', `Date de fin ${r.effectiveTo}`) });
        this.audit.append({ actor: system, action: 'rule.expired', resourceType: 'rule', resourceId: r.id });
      }
    }
  }

  list(): RuleRecord[] {
    this.refresh();
    return this.rules.all();
  }

  get(id: string): RuleRecord {
    this.refresh();
    const r = this.rules.get(id);
    if (!r) throw notFound('RULE_NOT_FOUND', `Règle inconnue : ${id}`);
    return r;
  }

  create(user: User, input: RuleInput): RuleRecord {
    authorize(user, 'rule.create');
    try {
      parseFormula(input.formula);
    } catch (e) {
      if (e instanceof FormulaError) throw badRequest('INVALID_FORMULA', e.message, { formulaError: e.code });
      throw e;
    }
    for (const id of input.legalInstrumentIds) {
      if (!this.instruments.get(id)) throw unprocessable('UNKNOWN_LEGAL_INSTRUMENT', `Instrument juridique inconnu du registre : ${id}`);
    }
    if (input.retroactivity && !this.instruments.get(input.retroactivity.instrumentId)) {
      throw unprocessable('UNKNOWN_LEGAL_INSTRUMENT', `Instrument autorisant la rétroactivité inconnu du registre : ${input.retroactivity.instrumentId}`);
    }
    if (!this.aliasExists(input.beneficiaryAccountAlias)) {
      throw unprocessable('UNKNOWN_BENEFICIARY_ALIAS', `Alias de compte bénéficiaire inconnu du coffre : ${input.beneficiaryAccountAlias}`);
    }
    const previous = this.rules.find((r) => r.code === input.code).sort((a, b) => b.version - a.version)[0];
    const version = (previous?.version ?? 0) + 1;
    const rule = this.rules.insert({
      ...structuredClone(input),
      id: `rule-${input.code.toLowerCase()}-v${version}`,
      version,
      status: 'BROUILLON',
      approvals: [],
      ...(previous ? { supersedesVersionId: previous.id } : {}),
      createdBy: user.id,
      createdAt: this.clock.now().toISOString(),
      history: [{
        at: this.clock.now().toISOString(), action: 'rule.created', by: user.id, status: 'BROUILLON',
        ...(previous ? { detail: `Nouvelle version ${version} de ${input.code} (remplace ${previous.id})${input.changeReason ? ` — ${input.changeReason}` : ''}` } : {}),
      }],
    });
    this.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles },
      action: 'rule.created',
      resourceType: 'rule',
      resourceId: rule.id,
      details: { code: rule.code, version, legalInstrumentIds: rule.legalInstrumentIds },
    });
    return rule;
  }

  /** Contrôles bloquants de publication (§ 6.3, § 6.12). */
  private publicationBlockers(rule: RuleRecord): { code: string; detail: string; instrumentId?: string } | null {
    for (const id of rule.legalInstrumentIds) {
      const inst = this.instruments.get(id);
      if (!inst) return { code: 'UNKNOWN_LEGAL_INSTRUMENT', detail: `Instrument inconnu : ${id}`, instrumentId: id };
      if (inst.status === 'ABROGE' && (!inst.abrogatedOn || rule.effectiveFrom >= inst.abrogatedOn)) {
        return {
          code: 'ABROGATED_INSTRUMENT',
          detail: `La règle cite l'instrument ${id} (${inst.title}), abrogé le ${inst.abrogatedOn ?? '?'}${inst.abrogatedBy ? ` par ${inst.abrogatedBy}` : ''}, avec une date d'effet postérieure (${rule.effectiveFrom}).`,
          instrumentId: id,
        };
      }
      if (inst.status !== 'EN_VIGUEUR' && inst.status !== 'MODIFIE' && inst.status !== 'ABROGE') {
        return { code: 'INSTRUMENT_NOT_IN_FORCE', detail: `L'instrument ${id} n'est pas certifié en vigueur (statut ${inst.status}).`, instrumentId: id };
      }
    }
    // Blocage de la rétroactivité non autorisée : une nouvelle version dont la date d'effet précède la publication
    // doit citer l'acte (instrument en vigueur + article) qui autorise expressément cette rétroactivité.
    const today = isoDate(this.clock.now());
    if (rule.supersedesVersionId && rule.effectiveFrom < today) {
      const ra = rule.retroactivity;
      if (!ra) {
        return {
          code: 'RETROACTIVITY_NOT_AUTHORIZED',
          detail: `Nouvelle version avec une date d'effet (${rule.effectiveFrom}) antérieure à la publication (${today}) : un acte autorisant la rétroactivité est requis.`,
        };
      }
      const inst = this.instruments.get(ra.instrumentId);
      if (!inst || !IN_FORCE.includes(inst.status)) {
        return { code: 'RETROACTIVITY_INSTRUMENT_NOT_IN_FORCE', detail: `L'instrument autorisant la rétroactivité (${ra.instrumentId}) n'est pas certifié en vigueur.`, instrumentId: ra.instrumentId };
      }
    }
    if (rule.sourceVerification !== 'OFFICIEL_CERTIFIE') {
      return { code: 'SOURCE_NOT_CERTIFIED', detail: `Source non certifiée (${rule.sourceVerification}) : OFFICIEL_CERTIFIE requis pour publier.` };
    }
    return null;
  }

  approve(user: User, id: string, role: Approval['role']): RuleRecord {
    const rule = this.get(id);
    const actor = { kind: 'user' as const, id: user.id, roles: user.roles };
    authorize(user, 'rule.approve');

    if (rule.status === 'A_VERIFIER') {
      throw conflict('RULE_REQUIRES_VERIFICATION', 'Fiche modèle au statut A_VERIFIER : créer une nouvelle version fondée sur un texte certifié.');
    }
    const expected = REQUIRED_APPROVALS[rule.approvals.length];
    if (!expected || FLOW[expected].from !== rule.status) {
      throw conflict('INVALID_RULE_STATE', `Aucune approbation attendue au statut ${rule.status}.`);
    }
    if (role !== expected) {
      throw conflict('APPROVAL_OUT_OF_ORDER', `Approbation « ${expected} » attendue avant « ${role} ».`);
    }
    // Séparation des tâches : quatre personnes distinctes ; le rédacteur est l'auteur de la fiche.
    const previous = rule.approvals.map((a) => a.userId);
    if (role === 'REDACTEUR') {
      if (rule.createdBy && rule.createdBy !== user.id) throw forbidden('NOT_RULE_AUTHOR', 'Le visa de rédaction appartient à l’auteur de la fiche.');
    } else {
      try {
        assertDistinctPerson(user.id, rule.createdBy ? [...previous, rule.createdBy] : previous, 'Une même personne ne peut pas rédiger, viser et publier une même règle : quatre personnes distinctes sont exigées.');
      } catch (e) {
        this.audit.append({ actor, action: 'rule.approval.refused', resourceType: 'rule', resourceId: rule.id, outcome: 'DENIED', details: { role, reason: 'SEPARATION_OF_DUTIES' } });
        throw e;
      }
    }
    const required = APPROVAL_ROLE[role];
    if (!user.roles.includes(required)) {
      throw forbidden('FORBIDDEN', `Le visa « ${role} » exige le rôle ${required}.`);
    }
    if (role === 'AUTORITE_PUBLICATION') {
      const blocker = this.publicationBlockers(rule);
      if (blocker) {
        this.audit.append({ actor, action: 'rule.publication.blocked', resourceType: 'rule', resourceId: rule.id, outcome: 'DENIED', details: blocker });
        throw unprocessable(blocker.code, blocker.detail, blocker.instrumentId ? { instrumentId: blocker.instrumentId } : {});
      }
    }
    const now = this.clock.now().toISOString();
    const step = FLOW[role];
    const updated = this.rules.update({
      ...rule,
      approvals: [...rule.approvals, { role, userId: user.id, at: now }],
      status: step.to,
      ...(step.to === 'PUBLIEE' ? { publishedAt: now } : {}),
      history: this.withHistory(rule, `rule.approved.${role.toLowerCase()}`, user.id, step.to),
    });
    this.audit.append({ actor, action: `rule.approved.${role.toLowerCase()}`, resourceType: 'rule', resourceId: rule.id, details: { status: step.to } });
    const nextRole = REQUIRED_APPROVALS[updated.approvals.length];
    const notify = nextRole ? this.users.withRole(APPROVAL_ROLE[nextRole]) : this.users.withRole('R13');
    this.comms.publish(step.event, notify.map(userRecipient), { reference: rule.code }, { entity: rule.administeringEntity });
    return this.get(id);
  }

  /** Suspension motivée (autorité et motif obligatoires) : la règle cesse immédiatement de produire des obligations. */
  suspend(user: User, id: string, input: { reason: string; authority: string; instrumentRef?: string }): RuleRecord {
    authorize(user, 'rules:suspend');
    const rule = this.get(id);
    if (rule.status !== 'ACTIVE' && rule.status !== 'PUBLIEE') {
      throw conflict('INVALID_RULE_STATE', `Seule une règle PUBLIEE ou ACTIVE peut être suspendue (statut ${rule.status}).`);
    }
    if (input.instrumentRef && !this.instruments.get(input.instrumentRef)) {
      throw unprocessable('UNKNOWN_LEGAL_INSTRUMENT', `Instrument inconnu du registre : ${input.instrumentRef}`);
    }
    const now = this.clock.now().toISOString();
    const suspension: RuleSuspension = {
      reason: input.reason, authority: input.authority, by: user.id, at: now, previousStatus: rule.status,
      ...(input.instrumentRef ? { instrumentRef: input.instrumentRef } : {}),
    };
    const updated = this.rules.update({
      ...rule, status: 'SUSPENDUE', suspension,
      history: this.withHistory(rule, 'rule.suspended', user.id, 'SUSPENDUE', `${input.authority} — ${input.reason}`),
    });
    this.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'rule.suspended', resourceType: 'rule', resourceId: id, details: { reason: input.reason, authority: input.authority, instrumentRef: input.instrumentRef ?? null, previousStatus: rule.status } });
    const notify = [...this.users.withRole('R13'), ...this.users.withRole('R16'), ...this.users.withRole('R06')];
    this.comms.publish('rule.suspended', notify.map(userRecipient), { reference: rule.code }, { entity: rule.administeringEntity });
    return updated;
  }

  /** Levée motivée de la suspension : la règle retrouve son statut antérieur (puis le cycle normal reprend). */
  liftSuspension(user: User, id: string, input: { reason: string }): RuleRecord {
    authorize(user, 'rules:suspend');
    const rule = this.get(id);
    if (rule.status !== 'SUSPENDUE' || !rule.suspension) throw conflict('RULE_NOT_SUSPENDED', `La règle ${rule.code} v${rule.version} n'est pas suspendue.`);
    const now = this.clock.now().toISOString();
    const lifted: RuleSuspension = { ...rule.suspension, liftedAt: now, liftedBy: user.id, liftReason: input.reason };
    const { suspension: _s, ...rest } = rule;
    const updated = this.rules.update({
      ...rest, status: lifted.previousStatus, pastSuspensions: [...(rule.pastSuspensions ?? []), lifted],
      history: this.withHistory(rule, 'rule.suspension.lifted', user.id, lifted.previousStatus, input.reason),
    });
    this.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'rule.suspension.lifted', resourceType: 'rule', resourceId: id, details: { reason: input.reason, restoredStatus: lifted.previousStatus } });
    return this.get(updated.id);
  }

  /**
   * Abrogation datée par un instrument abrogatoire en vigueur : à compter de la date, la règle est ABROGEE et
   * ne produit plus aucune obligation. Les obligations déjà émises ne sont jamais supprimées.
   */
  abrogate(user: User, id: string, input: { date: string; instrumentId: string; reason: string }): RuleRecord {
    authorize(user, 'rules:abrogate');
    const rule = this.get(id);
    if (!['APPROUVEE', 'PUBLIEE', 'ACTIVE', 'SUSPENDUE'].includes(rule.status)) {
      throw conflict('INVALID_RULE_STATE', `Règle au statut ${rule.status} : abrogation sans objet.`);
    }
    if (rule.abrogation) throw conflict('RULE_ALREADY_ABROGATED', `Abrogation déjà enregistrée au ${rule.abrogation.date}.`);
    const inst = this.instruments.get(input.instrumentId);
    if (!inst) throw unprocessable('UNKNOWN_LEGAL_INSTRUMENT', `Instrument abrogatoire inconnu du registre : ${input.instrumentId}`);
    if (!IN_FORCE.includes(inst.status)) {
      throw unprocessable('INSTRUMENT_NOT_IN_FORCE', `L'instrument abrogatoire ${input.instrumentId} n'est pas certifié en vigueur (statut ${inst.status}).`, { instrumentId: input.instrumentId });
    }
    if (input.date < rule.effectiveFrom) {
      throw unprocessable('ABROGATION_BEFORE_EFFECT', `La date d'abrogation (${input.date}) précède la date d'effet de la règle (${rule.effectiveFrom}).`);
    }
    const now = this.clock.now().toISOString();
    const today = isoDate(this.clock.now());
    const immediate = input.date <= today;
    const abrogation: RuleAbrogation = { date: input.date, instrumentId: input.instrumentId, reason: input.reason, by: user.id, at: now };
    const status: RuleStatus = immediate ? 'ABROGEE' : rule.status;
    this.rules.update({
      ...rule, status, abrogation,
      history: this.withHistory(rule, immediate ? 'rule.abrogated' : 'rule.abrogation.scheduled', user.id, status, `Abrogation au ${input.date} par ${input.instrumentId} — ${input.reason}`),
    });
    this.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'rule.abrogated', resourceType: 'rule', resourceId: id, details: { date: input.date, instrumentId: input.instrumentId, reason: input.reason, immediate } });
    const notify = [...this.users.withRole('R13'), ...this.users.withRole('R06')];
    this.comms.publish('rule.abrogated', notify.map(userRecipient), { reference: rule.code, date: input.date }, { entity: rule.administeringEntity });
    return this.get(id);
  }

  /**
   * Abrogation d'un instrument du registre : il rejoint la liste noire (aucune nouvelle règle ne peut le citer
   * après la date). Les règles qui le citent sont signalées pour décision : aucune abrogation automatique.
   */
  abrogateInstrument(user: User, id: string, input: { date: string; abrogatedBy: string; reason: string }): { instrument: LegalInstrument; rulesToReview: { id: string; code: string; version: number; status: RuleStatus }[] } {
    authorize(user, 'rules:instrument.abrogate');
    const inst = this.instruments.get(id);
    if (!inst) throw notFound('LEGAL_INSTRUMENT_NOT_FOUND', `Instrument inconnu : ${id}`);
    if (inst.status === 'ABROGE') throw conflict('INSTRUMENT_ALREADY_ABROGATED', `Instrument déjà abrogé le ${inst.abrogatedOn ?? '?'}.`);
    const by = this.instruments.get(input.abrogatedBy);
    if (!by || !IN_FORCE.includes(by.status)) {
      throw unprocessable('INSTRUMENT_NOT_IN_FORCE', `L'instrument abrogatoire ${input.abrogatedBy} doit figurer au registre et être en vigueur.`, { instrumentId: input.abrogatedBy });
    }
    const updated = this.instruments.update({ ...inst, status: 'ABROGE', abrogatedOn: input.date, abrogatedBy: input.abrogatedBy, note: input.reason });
    this.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'legal_instrument.abrogated', resourceType: 'legal_instrument', resourceId: id, details: { date: input.date, abrogatedBy: input.abrogatedBy, reason: input.reason } });
    const rulesToReview = this.list()
      .filter((r) => r.legalInstrumentIds.includes(id) && ['APPROUVEE', 'PUBLIEE', 'ACTIVE', 'SUSPENDUE'].includes(r.status))
      .map((r) => ({ id: r.id, code: r.code, version: r.version, status: r.status }));
    if (rulesToReview.length) {
      this.comms.publish('rule.conflict.detected', this.users.withRole('R16').map(userRecipient), { reference: id }, { entity: 'MINFIN' });
    }
    return { instrument: updated, rulesToReview };
  }

  /** Historique des versions d'un code de recette (ordre croissant), chacune avec son propre journal. */
  versions(id: string): RuleRecord[] {
    const rule = this.get(id);
    return this.rules.find((r) => r.code === rule.code).sort((a, b) => a.version - b.version);
  }

  /**
   * Évalue la formule d'une règle. Résolution des identifiants :
   * entrée fournie → table de taux → table de taux suffixée par le rang de localité (`forfait:<rang>`).
   */
  evaluate(rule: RuleSheet, inputs: Record<string, string>, localityRank: number): FormulaEvaluation {
    try {
      const ast = parseFormula(rule.formula);
      const usedInputs: Record<string, string> = {};
      const usedRates: Record<string, string> = {};
      const value = evaluateFormula(ast, (name) => {
        if (Object.hasOwn(inputs, name)) return (usedInputs[name] = inputs[name]!);
        if (Object.hasOwn(rule.rateTable, name)) return (usedRates[name] = rule.rateTable[name]!);
        const ranked = `${name}:${localityRank}`;
        if (Object.hasOwn(rule.rateTable, ranked)) return (usedRates[ranked] = rule.rateTable[ranked]!);
        throw new FormulaError('FORMULA_UNKNOWN_IDENTIFIER', `Valeur manquante pour « ${name} » (entrée ou taux, rang ${localityRank}).`);
      });
      return { value, inputs: usedInputs, rates: usedRates };
    } catch (e) {
      if (e instanceof FormulaError) throw unprocessable(e.code, e.message);
      throw e;
    }
  }

  requiredInputs(rule: RuleSheet): string[] {
    return [...formulaIdentifiers(parseFormula(rule.formula))].filter(
      (n) => !Object.hasOwn(rule.rateTable, n) && !Object.keys(rule.rateTable).some((k) => k.startsWith(`${n}:`)),
    );
  }
}
