/**
 * Registre juridique et moteur de règles (§ 6.12) :
 * cycle BROUILLON → REVUE_JURIDIQUE → REVUE_FINANCIERE → APPROUVEE → PUBLIEE → ACTIVE (date d'effet),
 * quatre approbations par quatre personnes distinctes, liste noire des instruments abrogés.
 */
import {
  REQUIRED_APPROVALS, SAMPLE_RULES, type Approval, type LegalInstrumentStatus, type RoleCode, type RuleSheet, type RuleStatus,
} from '@mosolo/shared';
import type { AuditLog } from '../../core/audit.js';
import type { User, UserDirectory } from '../../core/auth.js';
import type { Clock } from '../../core/clock.js';
import { isoDate } from '../../core/clock.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
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

export interface RuleRecord extends RuleSheet {
  createdBy?: string;
  createdAt: string;
  publishedAt?: string;
  activatedAt?: string;
  /** Fiche modèle de l'Annexe B (shared SAMPLE_RULES). */
  sample?: boolean;
  /** Règle fictive de démonstration (aucune valeur juridique). */
  demo?: boolean;
}

export type RuleInput = Omit<RuleSheet, 'id' | 'version' | 'status' | 'approvals' | 'supersedesVersionId'> & { changeReason?: string };

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

  /** Passe PUBLIEE → ACTIVE à la date d'effet, ACTIVE → EXPIREE après la date de fin. */
  refresh(): void {
    const now = this.clock.now();
    const today = isoDate(now);
    for (const r of this.rules.all()) {
      if (r.status === 'PUBLIEE' && r.effectiveFrom <= today) {
        this.rules.update({ ...r, status: 'ACTIVE', activatedAt: now.toISOString() });
        this.audit.append({ actor: { kind: 'system', id: 'moteur-regles' }, action: 'rule.activated', resourceType: 'rule', resourceId: r.id, details: { effectiveFrom: r.effectiveFrom } });
        this.comms.publish('rule.activated', this.users.withRole('R16').map(userRecipient), { reference: r.code }, { entity: r.administeringEntity });
      } else if (r.status === 'ACTIVE' && r.effectiveTo && r.effectiveTo < today) {
        this.rules.update({ ...r, status: 'EXPIREE' });
        this.audit.append({ actor: { kind: 'system', id: 'moteur-regles' }, action: 'rule.expired', resourceType: 'rule', resourceId: r.id });
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
    });
    this.audit.append({ actor, action: `rule.approved.${role.toLowerCase()}`, resourceType: 'rule', resourceId: rule.id, details: { status: step.to } });
    const nextRole = REQUIRED_APPROVALS[updated.approvals.length];
    const notify = nextRole ? this.users.withRole(APPROVAL_ROLE[nextRole]) : this.users.withRole('R13');
    this.comms.publish(step.event, notify.map(userRecipient), { reference: rule.code }, { entity: rule.administeringEntity });
    return this.get(id);
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
