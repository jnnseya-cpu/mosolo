/**
 * Registre juridique et moteur de règles (§ 6.12) :
 * cycle BROUILLON → REVUE_JURIDIQUE → REVUE_FINANCIERE → APPROUVEE → PUBLIEE → ACTIVE (date d'effet),
 * quatre approbations par quatre personnes distinctes, liste noire des instruments abrogés.
 * Compléments (§ 6.2, § 6.3, module 26) : suspension motivée (autorité, motif), abrogation datée par un instrument
 * abrogatoire (aucune liquidation après la date), historique des versions, blocage de la rétroactivité non autorisée
 * (une nouvelle version dont la date d'effet précède sa publication exige un acte l'autorisant).
 * Suspension et levée : quatre yeux (proposition puis approbation par une personne distincte) ; une levée rapide
 * (≤ SHORT_SUSPENSION_DAYS) et toute décision prise pendant la suspension ouvrent une alerte d'examen humain.
 */
import {
  acteRequisBloque, REQUIRED_APPROVALS, SAMPLE_RULES, type Approval, type LegalTestCase, type LegalTestRun, type LegalInstrumentStatus, type RoleCode, type RuleSheet, type RuleStatus,
} from '@mosolo/shared';
import type { AuditLog } from '../../core/audit.js';
import type { User, UserDirectory } from '../../core/auth.js';
import type { Clock } from '../../core/clock.js';
import { kinshasaDate } from '../../core/clock.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { InMemoryRepository } from '../../core/repository.js';
import type { CommunicationService } from '../communications/service.js';
import { userRecipient } from '../identity/recipients.js';
import { evaluateFormula, formulaIdentifiers, FormulaError, parseFormula } from './formula.js';
import { LegalTestBench, type SampleSimulation } from './legal-tests.js';
import { INSTRUMENTS_COMPLEMENTAIRES } from './textes.js';

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
  /** Quatre yeux : auteur de la proposition de suspension et approbateur distinct (celui qui l'a rendue effective). */
  proposedBy?: string;
  approvedBy?: string;
  /** Quatre yeux sur la levée : proposition puis approbation par une autre personne. */
  liftProposedBy?: string;
  liftApprovedBy?: string;
}

/**
 * Demande de suspension ou de levée en attente d'approbation (séparation des tâches) : une seule personne ne peut
 * jamais, seule, ouvrir ni refermer une fenêtre pendant laquelle un barème ne produit plus d'obligations.
 */
export interface SuspensionChangeRequest {
  kind: 'SUSPENSION' | 'LEVEE';
  reason: string;
  authority?: string;
  instrumentRef?: string;
  proposedBy: string;
  proposedAt: string;
}

/** Destinataire des alertes (service d'alertes du socle) — branché après construction. */
export interface RuleAlertSink {
  raise(input: { type: string; severity: 'MEDIUM' | 'HIGH' | 'CRITICAL'; source: string; detail: string; context?: Record<string, unknown>; notifyRoles?: RoleCode[] }): unknown;
}

/** Décision relevée dans le journal d'audit pendant une suspension (pénalité non émise, décision « sans montant »…). */
export interface DecisionDuringSuspension {
  auditId: string;
  at: string;
  action: string;
  actorId: string;
  resourceType: string;
  resourceId: string | null;
}

/** Levée « rapide » : une suspension levée en moins de N jours ouvre une alerte (fenêtre possiblement opportuniste). */
export const SHORT_SUSPENSION_DAYS = 7;

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
  /** Proposition de suspension ou de levée en attente d'une seconde personne. */
  pendingSuspensionChange?: SuspensionChangeRequest;
  /** Suspensions antérieures levées. */
  pastSuspensions?: RuleSuspension[];
  abrogation?: RuleAbrogation;
  retroactivity?: RetroactivityAuthorization;
  /** Version qui a remplacé celle-ci (à l'activation de la nouvelle version). */
  supersededBy?: string;
  history?: RuleHistoryEntry[];
  /** Cas de tests juridiques de la version (§ 11.2, § 44) et exécutions conservées (ajout seul). */
  legalTestCases?: LegalTestCase[];
  legalTestRuns?: LegalTestRun[];
  /** Simulations sur échantillon réel jointes à la version (contrôle fiscal, § 6.2). */
  sampleSimulations?: SampleSimulation[];
  /** Avertissements de citation (ex. texte abrogé cité avec une date d'effet postérieure : publication impossible). */
  citationWarnings?: string[];
}

export type RuleInput = Omit<RuleSheet, 'id' | 'version' | 'status' | 'approvals' | 'supersedesVersionId'> & {
  changeReason?: string;
  retroactivity?: RetroactivityAuthorization;
};

/** Actions complémentaires du registre (moindre privilège : non déclaré ⇒ refusé). */
/** Proposition de suspension / levée : autorité de publication ou juriste vérificateur. */
definePolicy('rules:suspend', { R14: GRANTS.always, R16: GRANTS.always });
/** Approbation (seconde personne, distincte de l'auteur de la proposition) : autorité de publication ou validateur financier. */
definePolicy('rules:suspend.approve', { R15: GRANTS.always, R16: GRANTS.always });
definePolicy('rules:abrogate', { R16: GRANTS.always });
definePolicy('rules:instrument.abrogate', { R16: GRANTS.always });
definePolicy('rules:recalc.simulate', {
  R13: GRANTS.always, R14: GRANTS.always, R15: GRANTS.always, R16: GRANTS.always,
  R06: GRANTS.always, R07: GRANTS.always, R11: GRANTS.always, R22: GRANTS.always,
});
/** Application d'un recalcul : direction de la régie administrant la recette (même entité). */
definePolicy('rules:recalc.decide', { R06: GRANTS.sameEntity });

const IN_FORCE: LegalInstrumentStatus[] = ['EN_VIGUEUR', 'MODIFIE'];

/** Libellé de fait générateur normalisé (casse, accents, ponctuation) pour la détection des doublons d'administration. */
export function normalizeTaxableEvent(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Règle en vigueur (PUBLIEE ou ACTIVE) d'une AUTRE administration, d'un autre code, sur le même fait générateur
 * (libellé normalisé identique ; nature identique si les deux sont renseignées), sur une période qui chevauche.
 */
export function sameTaxableEventElsewhere(rule: Pick<RuleRecord, 'id' | 'code' | 'administeringEntity' | 'taxableEvent' | 'taxableEventKind' | 'revenueCategory' | 'effectiveFrom' | 'effectiveTo'>, all: RuleRecord[]): RuleRecord | undefined {
  if (rule.revenueCategory === 'PENALITE') return undefined;
  const ev = normalizeTaxableEvent(rule.taxableEvent);
  const end = (r: { effectiveTo?: string }) => r.effectiveTo ?? '9999-12-31';
  return all.find((o) => o.id !== rule.id && o.code !== rule.code && ['PUBLIEE', 'ACTIVE'].includes(o.status) && o.administeringEntity !== rule.administeringEntity
    && o.revenueCategory !== 'PENALITE' && normalizeTaxableEvent(o.taxableEvent) === ev && (!o.taxableEventKind || !rule.taxableEventKind || o.taxableEventKind === rule.taxableEventKind)
    && o.effectiveFrom <= end(rule) && rule.effectiveFrom <= end(o));
}

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
  /** Cas de tests juridiques et simulation sur échantillon (porte de publication). */
  readonly tests: LegalTestBench;

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly comms: CommunicationService,
    private readonly users: UserDirectory,
    private readonly aliasExists: (alias: string) => boolean,
    private alerts?: RuleAlertSink,
  ) {
    this.tests = new LegalTestBench(this, clock, audit);
  }

  /** Branche le service d'alertes du socle (le registre est construit avant certains services). */
  attachAlerts(alerts: RuleAlertSink): void {
    this.alerts = alerts;
  }

  seedSamples(): void {
    for (const r of SAMPLE_RULES) this.rules.insert({ ...structuredClone(r), createdAt: this.clock.now().toISOString(), sample: true });
  }

  /**
   * Complète le registre avec les textes du tableau du § 6.1 qui manquent (statut A_VERIFIER) ; n'écrase jamais un
   * instrument existant. L'OL 13/001 reçoit, si elle n'en a pas, la note de son abrogation.
   */
  seedLegalTexts(): void {
    for (const i of INSTRUMENTS_COMPLEMENTAIRES) if (!this.instruments.get(i.id)) this.instruments.insert(structuredClone(i));
    const ol13 = this.instruments.get('ol-13-001');
    if (ol13 && !ol13.note) {
      this.instruments.update({ ...ol13, note: 'ABROGÉE par l’OL 18/004 du 13 mars 2018 (abrogation confirmée par la loi n° 18/014 selon KIN RECETTES — à vérifier) : aucune règle ne peut la citer comme texte en vigueur.' });
    }
  }

  /** Textes abrogés cités par une règle avec une date d'effet postérieure à l'abrogation (cités « comme en vigueur »). */
  abrogatedCitations(rule: Pick<RuleSheet, 'legalInstrumentIds' | 'effectiveFrom'>): LegalInstrument[] {
    return rule.legalInstrumentIds
      .map((id) => this.instruments.get(id))
      .filter((i): i is LegalInstrument => !!i && i.status === 'ABROGE' && (!i.abrogatedOn || rule.effectiveFrom >= i.abrogatedOn));
  }

  /** Activation impossible (§ 6.3 : ACTE_REQUIS ; texte abrogé cité comme en vigueur). */
  private activationBlocked(r: RuleRecord): boolean {
    return acteRequisBloque(r) || this.abrogatedCitations(r).length > 0;
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
    const today = kinshasaDate(now);
    const system = { kind: 'system' as const, id: 'moteur-regles' };
    for (const snap of this.rules.all()) {
      const r = this.rules.get(snap.id)!;
      if ((r.status === 'ACTIVE' || r.status === 'PUBLIEE') && r.abrogation && r.abrogation.date <= today) {
        this.rules.update({ ...r, status: 'ABROGEE', history: this.withHistory(r, 'rule.abrogated.effective', 'moteur-regles', 'ABROGEE', `Abrogation effective le ${r.abrogation.date} (${r.abrogation.instrumentId})`) });
        this.audit.append({ actor: system, action: 'rule.abrogated.effective', resourceType: 'rule', resourceId: r.id, details: { date: r.abrogation.date, instrumentId: r.abrogation.instrumentId } });
      } else if (r.status === 'PUBLIEE' && r.effectiveFrom <= today && !this.activationBlocked(r)) {
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
    const citationWarnings = this.abrogatedCitations(input).map((i) => `Texte abrogé cité : ${i.id} (${i.title}), abrogé le ${i.abrogatedOn ?? '?'}${i.abrogatedBy ? ` par ${i.abrogatedBy}` : ''} — publication impossible tant qu’il est cité comme en vigueur.`);
    if (acteRequisBloque(input)) citationWarnings.push('Catégorie ACTE_REQUIS : fiche simulable, jamais publiable ni activable (§ 6.3).');
    const rule = this.rules.insert({
      ...structuredClone(input),
      id: `rule-${input.code.toLowerCase()}-v${version}`,
      version,
      status: 'BROUILLON',
      approvals: [],
      ...(previous ? { supersedesVersionId: previous.id } : {}),
      createdBy: user.id,
      createdAt: this.clock.now().toISOString(),
      ...(citationWarnings.length ? { citationWarnings } : {}),
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
    // § 6.3 / § 6.11 : recette nécessitant un acte nouveau — simulable, jamais publiable ni activable.
    if (acteRequisBloque(rule)) {
      return { code: 'ACTE_REQUIS_NON_ACTIVABLE', detail: `${rule.code} v${rule.version} relève de la catégorie ACTE_REQUIS : un acte nouveau est requis ; créer une nouvelle version dans la catégorie fixée par cet acte.` };
    }
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
    const today = kinshasaDate(this.clock.now());
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
    // Module 26 : aucune obligation doublonnant une autre administration — une règle en vigueur d'une AUTRE entité qui
    // porte sur le même fait générateur (même libellé normalisé et même nature) sur une période qui chevauche bloque la
    // publication (arbitrage requis au registre des arbitrages ; les pénalités ne sont pas concernées).
    const twin = sameTaxableEventElsewhere(rule, this.rules.all());
    if (twin) {
      return { code: 'DOUBLON_ADMINISTRATION', detail: `Même fait générateur (« ${rule.taxableEvent} ») déjà porté par ${twin.administeringEntity} (${twin.code} v${twin.version}, ${twin.status}) : aucune obligation en double — arbitrage requis avant publication.` };
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
      // Contrôle fiscal (§ 6.2, § 11.2, § 44) : cas de tests juridiques exécutés (résultat conservé) et échantillon joint.
      const blocker: { code: string; detail: string; instrumentId?: string } | null = this.publicationBlockers(rule) ?? this.tests.gate(rule, user);
      if (blocker) {
        this.audit.append({ actor, action: 'rule.publication.blocked', resourceType: 'rule', resourceId: rule.id, outcome: 'DENIED', details: blocker });
        throw unprocessable(blocker.code, blocker.detail, blocker.instrumentId ? { instrumentId: blocker.instrumentId } : {});
      }
    }
    const now = this.clock.now().toISOString();
    const step = FLOW[role];
    const updated = this.rules.update({
      ...(this.rules.get(rule.id) ?? rule), // relu : la porte de publication a pu conserver une exécution des cas
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

  /**
   * Proposition de suspension motivée (autorité et motif obligatoires). Aucun effet tant qu'une SECONDE personne
   * habilitée (distincte de l'auteur) ne l'a pas approuvée : `decideSuspensionChange`.
   */
  suspend(user: User, id: string, input: { reason: string; authority: string; instrumentRef?: string }): RuleRecord {
    authorize(user, 'rules:suspend');
    const rule = this.get(id);
    if (rule.status !== 'ACTIVE' && rule.status !== 'PUBLIEE') {
      throw conflict('INVALID_RULE_STATE', `Seule une règle PUBLIEE ou ACTIVE peut être suspendue (statut ${rule.status}).`);
    }
    if (input.instrumentRef && !this.instruments.get(input.instrumentRef)) {
      throw unprocessable('UNKNOWN_LEGAL_INSTRUMENT', `Instrument inconnu du registre : ${input.instrumentRef}`);
    }
    return this.proposeChange(user, rule, {
      kind: 'SUSPENSION', reason: input.reason, authority: input.authority, ...(input.instrumentRef ? { instrumentRef: input.instrumentRef } : {}),
    });
  }

  /** Proposition de levée motivée : effective seulement après approbation par une seconde personne. */
  liftSuspension(user: User, id: string, input: { reason: string }): RuleRecord {
    authorize(user, 'rules:suspend');
    const rule = this.get(id);
    if (rule.status !== 'SUSPENDUE' || !rule.suspension) throw conflict('RULE_NOT_SUSPENDED', `La règle ${rule.code} v${rule.version} n'est pas suspendue.`);
    return this.proposeChange(user, rule, { kind: 'LEVEE', reason: input.reason });
  }

  private proposeChange(user: User, rule: RuleRecord, change: Omit<SuspensionChangeRequest, 'proposedBy' | 'proposedAt'>): RuleRecord {
    if (rule.pendingSuspensionChange) {
      throw conflict('SUSPENSION_CHANGE_PENDING', `Une proposition de ${rule.pendingSuspensionChange.kind === 'SUSPENSION' ? 'suspension' : 'levée'} attend déjà une approbation.`);
    }
    const pending: SuspensionChangeRequest = { ...change, proposedBy: user.id, proposedAt: this.clock.now().toISOString() };
    const action = change.kind === 'SUSPENSION' ? 'rule.suspension.proposed' : 'rule.suspension.lift_proposed';
    this.rules.update({
      ...rule, pendingSuspensionChange: pending,
      history: this.withHistory(rule, action, user.id, rule.status, `${change.authority ? `${change.authority} — ` : ''}${change.reason}`),
    });
    this.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action, resourceType: 'rule', resourceId: rule.id,
      details: { code: rule.code, reason: change.reason, authority: change.authority ?? null, instrumentRef: change.instrumentRef ?? null },
    });
    const notify = [...this.users.withRole('R16'), ...this.users.withRole('R15')].filter((u) => u.id !== user.id);
    this.comms.publish('approval.requested', notify.map(userRecipient), { reference: rule.code }, { entity: rule.administeringEntity });
    return this.get(rule.id);
  }

  /**
   * Décision sur une proposition de suspension ou de levée : par une personne DISTINCTE de l'auteur (quatre yeux).
   * Approuvée : la suspension (ou la levée) prend effet ; rejetée : la proposition est close sans effet.
   */
  decideSuspensionChange(user: User, id: string, input: { approve: boolean; reason: string }): RuleRecord {
    authorize(user, 'rules:suspend.approve');
    const rule = this.get(id);
    const pending = rule.pendingSuspensionChange;
    if (!pending) throw conflict('NO_PENDING_SUSPENSION_CHANGE', `Aucune proposition de suspension ou de levée en attente pour ${rule.code} v${rule.version}.`);
    const actor = { kind: 'user' as const, id: user.id, roles: user.roles };
    try {
      assertDistinctPerson(user.id, [pending.proposedBy], 'La suspension ou la levée d’une règle exige deux personnes distinctes : l’auteur de la proposition ne peut pas l’approuver.');
    } catch (e) {
      this.audit.append({ actor, action: 'rule.suspension.approval_refused', resourceType: 'rule', resourceId: id, outcome: 'DENIED', details: { kind: pending.kind, reason: 'SEPARATION_OF_DUTIES' } });
      throw e;
    }
    const { pendingSuspensionChange: _p, ...base } = rule;
    if (!input.approve) {
      this.rules.update({ ...base, history: this.withHistory(rule, 'rule.suspension.change_rejected', user.id, rule.status, input.reason) });
      this.audit.append({ actor, action: 'rule.suspension.change_rejected', resourceType: 'rule', resourceId: id, details: { kind: pending.kind, proposedBy: pending.proposedBy, reason: input.reason } });
      return this.get(id);
    }
    const now = this.clock.now().toISOString();
    if (pending.kind === 'SUSPENSION') {
      if (rule.status !== 'ACTIVE' && rule.status !== 'PUBLIEE') {
        throw conflict('INVALID_RULE_STATE', `Seule une règle PUBLIEE ou ACTIVE peut être suspendue (statut ${rule.status}).`);
      }
      const suspension: RuleSuspension = {
        reason: pending.reason, authority: pending.authority ?? '', by: pending.proposedBy, at: now, previousStatus: rule.status,
        proposedBy: pending.proposedBy, approvedBy: user.id, ...(pending.instrumentRef ? { instrumentRef: pending.instrumentRef } : {}),
      };
      this.rules.update({
        ...base, status: 'SUSPENDUE', suspension,
        history: this.withHistory(rule, 'rule.suspended', user.id, 'SUSPENDUE', `${pending.authority ?? ''} — ${pending.reason} (proposée par ${pending.proposedBy})`),
      });
      this.audit.append({
        actor, action: 'rule.suspended', resourceType: 'rule', resourceId: id,
        details: { code: rule.code, reason: pending.reason, authority: pending.authority ?? null, instrumentRef: pending.instrumentRef ?? null, previousStatus: rule.status, proposedBy: pending.proposedBy, approvedBy: user.id },
      });
      const notify = [...this.users.withRole('R13'), ...this.users.withRole('R16'), ...this.users.withRole('R06')];
      this.comms.publish('rule.suspended', notify.map(userRecipient), { reference: rule.code }, { entity: rule.administeringEntity });
      return this.get(id);
    }
    if (rule.status !== 'SUSPENDUE' || !rule.suspension) throw conflict('RULE_NOT_SUSPENDED', `La règle ${rule.code} v${rule.version} n'est pas suspendue.`);
    const lifted: RuleSuspension = {
      ...rule.suspension, liftedAt: now, liftedBy: user.id, liftReason: pending.reason, liftProposedBy: pending.proposedBy, liftApprovedBy: user.id,
    };
    const { suspension: _s, ...rest } = base;
    this.rules.update({
      ...rest, status: lifted.previousStatus, pastSuspensions: [...(rule.pastSuspensions ?? []), lifted],
      history: this.withHistory(rule, 'rule.suspension.lifted', user.id, lifted.previousStatus, `${pending.reason} (proposée par ${pending.proposedBy})`),
    });
    this.audit.append({
      actor, action: 'rule.suspension.lifted', resourceType: 'rule', resourceId: id,
      details: { code: rule.code, reason: pending.reason, restoredStatus: lifted.previousStatus, suspendedAt: lifted.at, proposedBy: pending.proposedBy, approvedBy: user.id },
    });
    this.alertOnLift(rule, lifted);
    return this.get(id);
  }

  /** Alertes à la levée : suspension brève (« fenêtre » ouverte puis refermée) et décisions prises pendant la suspension. */
  private alertOnLift(rule: RuleRecord, s: RuleSuspension): void {
    if (!this.alerts || !s.liftedAt) return;
    const days = (new Date(s.liftedAt).getTime() - new Date(s.at).getTime()) / 86_400_000;
    const context = {
      ruleId: rule.id, ruleCode: rule.code, suspendedAt: s.at, liftedAt: s.liftedAt,
      suspendedBy: [s.proposedBy ?? s.by, s.approvedBy].filter(Boolean), liftedBy: [s.liftProposedBy, s.liftApprovedBy].filter(Boolean),
    };
    if (days <= SHORT_SUSPENSION_DAYS) {
      this.alerts.raise({
        type: 'RULE_SUSPENSION_SHORT', severity: 'HIGH', source: 'moteur-regles', notifyRoles: ['R22'],
        detail: `Règle ${rule.code} v${rule.version} suspendue puis rétablie en ${days.toFixed(1)} jour(s) (seuil ${SHORT_SUSPENSION_DAYS} j) : examen humain des décisions prises pendant la fenêtre.`,
        context,
      });
    }
    const decisions = this.decisionsDuringSuspension(rule.code, s);
    if (decisions.length) {
      this.alerts.raise({
        type: 'RULE_DECISIONS_DURING_SUSPENSION', severity: 'HIGH', source: 'moteur-regles', notifyRoles: ['R22'],
        detail: `${decisions.length} décision(s) prise(s) pendant la suspension de ${rule.code} (du ${s.at} au ${s.liftedAt}) : pénalités ou droits possiblement non émis — examen humain, aucune sanction automatique.`,
        context: { ...context, decisions: decisions.slice(0, 50) },
      });
    }
  }

  /** Toutes les suspensions EFFECTIVES (en cours et levées) d'un code de recette, toutes versions confondues. */
  suspensionsOf(ruleCode: string): RuleSuspension[] {
    const out: RuleSuspension[] = [];
    for (const r of this.rules.find((x) => x.code === ruleCode)) {
      out.push(...(r.pastSuspensions ?? []));
      if (r.suspension) out.push(r.suspension);
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  /**
   * Vrai si le code de recette a été suspendu à un moment quelconque de l'intervalle [from, to] (ISO).
   * Destiné aux autres modules (ex. décision de pénalité « sans montant » prise pendant une suspension).
   */
  wasSuspendedBetween(ruleCode: string, from: string, to: string): boolean {
    return this.suspensionsOf(ruleCode).some((s) => s.at <= to && (s.liftedAt ?? '9999') >= from);
  }

  /**
   * Décisions relevées dans le journal d'audit pendant une suspension : actes de décision (« decided », « decision »)
   * dont le détail cite la règle ou constate l'absence de barème (« sans pénalité », « acte requis »).
   * Écoute passive du journal : les modules n'ont rien à émettre de plus.
   */
  decisionsDuringSuspension(ruleCode: string, s?: RuleSuspension): DecisionDuringSuspension[] {
    const windows = s ? [s] : this.suspensionsOf(ruleCode);
    if (!windows.length) return [];
    const ids = [...new Set(this.rules.find((x) => x.code === ruleCode).map((x) => x.id))];
    const now = this.clock.now().toISOString();
    const out: DecisionDuringSuspension[] = [];
    for (const e of this.audit.list({ limit: 1_000_000 }).items) {
      if (e.actor.kind !== 'user' || !/(decided|decision|\.decide)/i.test(e.action)) continue;
      if (!windows.some((w) => e.at >= w.at && e.at <= (w.liftedAt ?? now))) continue;
      const text = JSON.stringify(e.details);
      const cites = text.includes(ruleCode) || ids.some((id) => text.includes(id)) || /sans pénalité|barème non publié|acte requis/i.test(text);
      if (!cites) continue;
      out.push({ auditId: e.id, at: e.at, action: e.action, actorId: e.actor.id, resourceType: e.resourceType, resourceId: e.resourceId });
    }
    return out;
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
    const today = kinshasaDate(this.clock.now());
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
   * Évalue la formule d'une règle. Résolution des identifiants : la table de taux CERTIFIÉE prime toujours —
   * taux exact, puis taux suffixé par le rang de localité (`forfait:<rang>`) ; seuls les identifiants qui ne sont
   * pas des taux (voir `requiredInputs`) sont lus dans les entrées. Toute entrée étrangère à la formule est refusée
   * (INPUT_NOT_ALLOWED) : une requête ne peut jamais substituer un taux ni glisser une valeur non prévue.
   */
  evaluate(rule: RuleSheet, inputs: Record<string, string>, localityRank: number): FormulaEvaluation {
    try {
      this.assertInputsAllowed(rule, inputs);
      const ast = parseFormula(rule.formula);
      const usedInputs: Record<string, string> = {};
      const usedRates: Record<string, string> = {};
      const value = evaluateFormula(ast, (name) => {
        if (Object.hasOwn(rule.rateTable, name)) return (usedRates[name] = rule.rateTable[name]!);
        const ranked = `${name}:${localityRank}`;
        if (Object.hasOwn(rule.rateTable, ranked)) return (usedRates[ranked] = rule.rateTable[ranked]!);
        if (isRateName(rule, name)) {
          throw new FormulaError('FORMULA_UNKNOWN_IDENTIFIER', `Taux « ${name} » non défini pour le rang ${localityRank} dans la table certifiée.`);
        }
        if (Object.hasOwn(inputs, name)) return (usedInputs[name] = inputs[name]!);
        throw new FormulaError('FORMULA_UNKNOWN_IDENTIFIER', `Valeur manquante pour « ${name} » (entrée ou taux, rang ${localityRank}).`);
      });
      return { value, inputs: usedInputs, rates: usedRates };
    } catch (e) {
      if (e instanceof FormulaError) throw unprocessable(e.code, e.message);
      throw e;
    }
  }

  /** Entrées de la formule que la requête doit fournir (tout identifiant qui n'est pas un taux de la table). */
  requiredInputs(rule: RuleSheet): string[] {
    return [...formulaIdentifiers(parseFormula(rule.formula))].filter((n) => !isRateName(rule, n));
  }

  /** Refuse (400 INPUT_NOT_ALLOWED) toute entrée qui n'est pas une entrée requise de la formule (taux compris). */
  assertInputsAllowed(rule: RuleSheet, inputs: Record<string, string>): void {
    const allowed = new Set(this.requiredInputs(rule));
    const refused = Object.keys(inputs).filter((k) => !allowed.has(k));
    if (refused.length) {
      throw badRequest('INPUT_NOT_ALLOWED', `Entrée(s) non prévue(s) par la règle ${rule.code} v${rule.version} : ${refused.join(', ')}. Les taux viennent de la table certifiée, jamais de la requête.`, { refused, allowed: [...allowed] });
    }
  }

  /** Ne garde que les entrées requises par `rule` (recalcul d'une ancienne trace par une nouvelle version). */
  pickRequiredInputs(rule: RuleSheet, inputs: Record<string, string>): Record<string, string> {
    const allowed = new Set(this.requiredInputs(rule));
    return Object.fromEntries(Object.entries(inputs).filter(([k]) => allowed.has(k)));
  }
}

/** Identifiant fourni par la table de taux (exact ou décliné par rang `nom:<rang>`). */
function isRateName(rule: RuleSheet, name: string): boolean {
  return Object.hasOwn(rule.rateTable, name) || Object.keys(rule.rateTable).some((k) => k.startsWith(`${name}:`));
}
