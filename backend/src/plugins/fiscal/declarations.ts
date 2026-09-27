/**
 * Déclarations pré-remplies (module 27, § 13.2, § 16.9) : le contribuable ouvre une déclaration pré-remplie à
 * partir des données connues (objet, baux déclarés, rang de localité), confirme ou corrige, dépose et reçoit un
 * accusé de réception horodaté. La liquidation n'a lieu que par une règle ACTIVE du registre ; sinon le résultat
 * est une simulation NON OPPOSABLE. Toute correction à la baisse d'un élément vérifié ouvre une vérification sans
 * bloquer le dépôt. Aucune double facturation d'un même fait générateur sur une même période.
 */
import { isRuleExecutable, Money, type CurrencyCode, type ProbativeStatus } from '@mosolo/shared';
import type { User } from '../../core/auth.js';
import { canonicalJson, sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, assertNotRelated, authorize } from '../../core/policy.js';
import { recordReductionGranted } from '../../modules/assessment/reductions.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { AssessmentTrace } from '../../modules/assessment/service.js';
import { PAYABLE_STATUSES } from '../../modules/assessment/service.js';
import { taxpayerRecipient, userRecipient } from '../../modules/identity/recipients.js';
import type { FiscalObject, Lease } from '../../modules/objects/service.js';
import type { RuleRecord } from '../../modules/rules/service.js';
import { actorOf, parentIdOf, type FiscalDeps } from './common.js';

export const DECLARATION_KINDS = ['IF', 'IRL'] as const;
export type DeclarationKind = (typeof DECLARATION_KINDS)[number];

export const KIND_LABELS: Record<DeclarationKind, string> = {
  IF: 'Impôt foncier',
  IRL: 'Impôt sur les revenus locatifs',
};

/** Catégories d'objets admises par type de déclaration. */
const KIND_OBJECTS: Record<DeclarationKind, string[]> = {
  IF: ['PARCELLE', 'BATIMENT'],
  IRL: ['UNITE_LOCATIVE', 'BATIMENT', 'PARCELLE'],
};

/** Règles candidates (ordre de préférence) — la première exécutable l'emporte ; sinon simulation non opposable. */
function candidateCodes(kind: DeclarationKind, rank: number): string[] {
  if (kind === 'IRL') return [rank === 1 ? 'IRL-KIN-R1' : 'IRL-KIN-R234'];
  return ['IF-KIN-PP-BATI', 'DEMO-IF-BATI'];
}

const FIELD_LABELS: Record<string, string> = {
  loyers_percus: 'Loyers perçus sur la période',
  retenues_imputees: 'Retenues à la source déjà imputées',
  superficie_m2: 'Superficie (m²)',
};

export interface PrefilledField {
  name: string;
  label: string;
  value: string | null;
  source: string;
  probativeStatus: ProbativeStatus | null;
  editable: boolean;
}

export interface Prefill {
  objectId: string;
  igf: string | null;
  kind: DeclarationKind;
  kindLabel: string;
  period: string;
  rule: { id: string; code: string; version: number; label: string; status: string; executable: boolean; reason?: string; demo: boolean };
  localityRank: number;
  fields: PrefilledField[];
  notice: string;
}

export type LiquidationMode = 'OPPOSABLE' | 'SIMULATION_NON_OPPOSABLE' | 'DEJA_LIQUIDEE' | 'EN_INSTRUCTION' | 'AUCUNE';

export interface Declaration {
  id: string;
  version: number;
  supersedes?: string;
  supersededBy?: string;
  taxpayerId: string;
  objectId: string;
  kind: DeclarationKind;
  period: string;
  ruleId: string;
  ruleCode: string;
  ruleVersion: number;
  prefilled: PrefilledField[];
  inputs: Record<string, string>;
  changes: { field: string; prefilled: string | null; declared: string; source: string; lowered: boolean }[];
  verificationRequired: boolean;
  status: 'DEPOSEE' | 'LIQUIDEE' | 'A_INSTRUIRE' | 'CORRECTION_REJETEE' | 'REMPLACEE';
  acknowledgement: { number: string; receivedAt: string; contentHash: string };
  filedBy: string;
  filedByRole: 'CONTRIBUABLE' | 'MANDATAIRE' | 'GUICHET';
  liquidation: { mode: LiquidationMode; obligationId?: string; trace?: AssessmentTrace; message: string };
  correctionReason?: string;
  instruction?: { decision: 'ACCEPTEE' | 'REJETEE'; reason: string; decidedBy: string; at: string; rectifiedObligationId?: string; approvers?: string[] };
  /** Première validation d'une correction à la baisse soumise aux quatre yeux (en attente de la seconde). */
  firstReview?: { by: string; at: string; reason: string; fromAmount: { amount: string; currency: string }; toAmount: { amount: string; currency: string }; why: string[] };
}

const DECIMAL = /^\d{1,15}(\.\d{1,6})?$/;

/**
 * Seuil (valeur de conception À VÉRIFIER) au-delà duquel une correction À LA BAISSE d'une déclaration liquidée exige
 * une seconde validation (quatre yeux). Devise sans seuil paramétré ⇒ quatre yeux systématiques.
 */
export const DOWNWARD_CORRECTION_FOUR_EYES_THRESHOLD: Partial<Record<CurrencyCode, string>> = { USD: '100', CDF: '250000' };
const PERIOD_MONTHS: Record<Lease['periodicity'], number> = { MENSUELLE: 1, TRIMESTRIELLE: 3, SEMESTRIELLE: 6, ANNUELLE: 12 };

export class DeclarationService {
  readonly declarations = new InMemoryRepository<Declaration>();
  private readonly ids = new IdGenerator();

  constructor(private readonly d: FiscalDeps) {}

  get(id: string): Declaration {
    const x = this.declarations.get(id);
    if (!x) throw notFound('DECLARATION_NOT_FOUND', `Déclaration inconnue : ${id}`);
    return x;
  }

  private chooseRule(kind: DeclarationKind, rank: number): RuleRecord {
    const all = this.d.ctx.rules.list();
    const now = this.d.ctx.clock.now();
    const byCode = candidateCodes(kind, rank).map((c) => all.filter((r) => r.code === c).sort((a, b) => b.version - a.version));
    for (const versions of byCode) {
      const exec = versions.find((r) => isRuleExecutable(r, now).ok);
      if (exec) return exec;
    }
    // Simulation non opposable : une position du promoteur (A_VERIFIER, Cahier) ne remplace pas la version antérieure.
    const firstVersions = byCode.find((v) => v.length);
    const fallback = firstVersions?.find((r) => !r.promoterPosition) ?? firstVersions?.[0];
    if (!fallback) throw unprocessable('NO_RULE_FOR_DECLARATION', `Aucune fiche de règle au registre pour la déclaration ${kind} : acte requis.`);
    return fallback;
  }

  private checkPeriod(period: string): void {
    if (!/^\d{4}$/.test(period)) throw badRequest('INVALID_PERIOD', 'Période attendue au format AAAA (exercice).');
    const y = this.d.ctx.clock.now().getUTCFullYear();
    if (Number(period) > y + 1 || Number(period) < y - 5) throw badRequest('INVALID_PERIOD', `Exercice ${period} hors de la fenêtre de déclaration.`);
  }

  private holderOf(obj: FiscalObject): string {
    if (!obj.taxpayerId) throw unprocessable('OBJECT_WITHOUT_HOLDER', 'Objet sans redevable rattaché : un rattachement validé est requis avant toute déclaration.');
    return obj.taxpayerId;
  }

  /** Loyers annuels déclarés sur la période (baux où le redevable est bailleur, sur l'objet ou ses sous-objets). */
  private rentsFor(obj: FiscalObject, lessorId: string, period: string, currency: CurrencyCode): { total: Money; leases: string[]; skipped: string[] } {
    const ids = new Set([obj.id, ...this.d.ctx.objects.objects.find((o) => parentIdOf(o) === obj.id).map((o) => o.id)]);
    const leases = this.d.ctx.objects.leases.find((l) => ids.has(l.unitObjectId) && l.lessorId === lessorId);
    let total = Money.zero(currency);
    const used: string[] = [];
    const skipped: string[] = [];
    for (const l of leases) {
      if (l.rent.currency !== currency) { skipped.push(l.id); continue; }
      let months = 0;
      for (let m = 1; m <= 12; m++) {
        const mid = `${period}-${String(m).padStart(2, '0')}-15`;
        if (l.start <= mid && (!l.end || l.end >= mid)) months++;
      }
      if (!months) continue;
      const per = PERIOD_MONTHS[l.periodicity];
      const minor = Money.fromJSON(l.rent).minor * BigInt(months);
      // Arrondi au plus proche (demi vers le haut) en unités mineures — aucun flottant.
      const q = (minor * 2n + BigInt(per)) / (2n * BigInt(per));
      total = total.add(Money.fromMinor(q, currency));
      used.push(l.id);
    }
    return { total, leases: used, skipped };
  }

  prefill(user: User, input: { objectId: string; kind: DeclarationKind; period: string }): Prefill {
    const obj = this.d.ctx.objects.get(input.objectId);
    const holder = this.holderOf(obj);
    authorize(user, 'fiscal:declaration.file', { taxpayerId: holder, communes: [obj.commune] });
    this.checkPeriod(input.period);
    if (!KIND_OBJECTS[input.kind].includes(obj.category)) {
      throw unprocessable('KIND_NOT_APPLICABLE', `Déclaration ${input.kind} non applicable à un objet ${obj.category}.`);
    }
    const rule = this.chooseRule(input.kind, obj.localityRank);
    const exec = isRuleExecutable(rule, this.d.ctx.clock.now());
    const objStatus: ProbativeStatus = obj.probativeStatus;
    const fields: PrefilledField[] = this.d.ctx.rules.requiredInputs(rule).map((name) => {
      const label = FIELD_LABELS[name] ?? name;
      if (name === 'loyers_percus') {
        const r = this.rentsFor(obj, holder, input.period, rule.currency);
        return {
          name, label, value: r.total.toDecimalString(),
          source: r.leases.length ? `Baux déclarés : ${r.leases.join(', ')}${r.skipped.length ? ` (autre devise non reprise : ${r.skipped.join(', ')})` : ''}` : 'Aucun bail déclaré pour la période',
          probativeStatus: r.leases.length ? 'DECLARE' : null, editable: true,
        };
      }
      if (name === 'retenues_imputees') return { name, label, value: '0', source: 'Aucune attestation de retenue enregistrée', probativeStatus: null, editable: true };
      const attr = obj.attributes[name];
      if (typeof attr === 'string' && DECIMAL.test(attr)) {
        return { name, label, value: attr, source: `Fiche de l'objet ${obj.igf?.code ?? obj.id}`, probativeStatus: objStatus, editable: true };
      }
      return { name, label, value: null, source: 'À saisir par le contribuable', probativeStatus: null, editable: true };
    });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'declaration.prefilled', resourceType: 'fiscal_object', resourceId: obj.id, details: { kind: input.kind, period: input.period, ruleCode: rule.code } });
    return {
      objectId: obj.id, igf: obj.igf?.code ?? null, kind: input.kind, kindLabel: KIND_LABELS[input.kind], period: input.period,
      rule: {
        id: rule.id, code: rule.code, version: rule.version, label: rule.label, status: rule.status, executable: exec.ok,
        ...(exec.ok ? {} : { reason: exec.reason }), demo: rule.demo === true,
      },
      localityRank: obj.localityRank,
      fields,
      notice: exec.ok
        ? 'Règle ACTIVE du registre : le dépôt produit une obligation expliquée.'
        : `Règle non exécutable (${exec.reason}) : le dépôt est enregistré mais le calcul reste une SIMULATION NON OPPOSABLE, sans obligation.`,
    };
  }

  private existingObligation(obj: FiscalObject, rule: RuleRecord, period: string): string | undefined {
    const byDecl = this.declarations.findOne((x) => x.objectId === obj.id && x.ruleCode === rule.code && x.period === period && !!x.liquidation.obligationId && x.status !== 'REMPLACEE');
    if (byDecl?.liquidation.obligationId) return byDecl.liquidation.obligationId;
    return this.d.ctx.assessment.obligations.findOne((o) => o.objectId === obj.id && o.ruleCode === rule.code && o.status !== 'ANNULEE' && !o.supersededBy && o.createdAt.startsWith(period))?.id;
  }

  file(user: User, input: { objectId: string; kind: DeclarationKind; period: string; inputs: Record<string, string>; attest: boolean }, supersedes?: Declaration, reason?: string): Declaration {
    if (!input.attest) throw badRequest('ATTESTATION_REQUIRED', 'Le déclarant doit attester l’exactitude de sa déclaration.');
    const pre = this.prefill(user, input);
    const obj = this.d.ctx.objects.get(input.objectId);
    const holder = this.holderOf(obj);
    if (!supersedes) {
      const dup = this.declarations.findOne((x) => x.objectId === obj.id && x.kind === input.kind && x.period === input.period && x.status !== 'REMPLACEE' && x.status !== 'CORRECTION_REJETEE' && !x.supersededBy);
      if (dup) throw conflict('DECLARATION_ALREADY_FILED', `Une déclaration ${input.kind} ${input.period} est déjà déposée pour cet objet (${dup.id}) : utilisez une correction.`, { declarationId: dup.id });
    }
    const rule = this.d.ctx.rules.get(pre.rule.id);
    const inputs: Record<string, string> = {};
    const changes: Declaration['changes'] = [];
    for (const f of pre.fields) {
      const v = input.inputs[f.name] ?? f.value;
      if (v === null || v === undefined || !DECIMAL.test(v)) throw badRequest('MISSING_INPUT', `Valeur décimale requise pour « ${f.label} » (${f.name}).`);
      inputs[f.name] = v;
      if (f.value !== null && v !== f.value) {
        const lowered = Number.parseFloat(v) < Number.parseFloat(f.value);
        changes.push({ field: f.name, prefilled: f.value, declared: v, source: f.source, lowered });
      } else if (f.value === null) {
        changes.push({ field: f.name, prefilled: null, declared: v, source: 'Saisie du contribuable', lowered: false });
      }
    }
    // Correction à la baisse d'un élément VÉRIFIÉ : vérification ouverte, sans bloquer le dépôt (§ 13.2-3).
    const verificationRequired = changes.some((c) => c.lowered && pre.fields.find((f) => f.name === c.field)?.probativeStatus === 'VERIFIE');
    const now = this.d.nowIso();
    const id = this.ids.next(`DCL-${input.period}`);
    const ackNumber = this.ids.next(`ACR-${input.period}`);
    const filedByRole: Declaration['filedByRole'] = user.roles.includes('R30') ? 'CONTRIBUABLE' : user.roles.includes('R31') ? 'MANDATAIRE' : 'GUICHET';
    const content = { id, taxpayerId: holder, objectId: obj.id, kind: input.kind, period: input.period, ruleId: rule.id, inputs };
    let decl: Declaration = this.declarations.insert({
      id, version: supersedes ? supersedes.version + 1 : 1, ...(supersedes ? { supersedes: supersedes.id } : {}),
      taxpayerId: holder, objectId: obj.id, kind: input.kind, period: input.period,
      ruleId: rule.id, ruleCode: rule.code, ruleVersion: rule.version,
      prefilled: pre.fields, inputs, changes, verificationRequired,
      status: 'DEPOSEE',
      acknowledgement: { number: ackNumber, receivedAt: now, contentHash: sha256Hex(canonicalJson(content)) },
      filedBy: user.id, filedByRole,
      liquidation: { mode: 'AUCUNE', message: 'En attente de liquidation.' },
      ...(reason ? { correctionReason: reason } : {}),
    });
    this.d.ctx.audit.append({
      actor: actorOf(user), action: supersedes ? 'declaration.corrected' : 'declaration.submitted', resourceType: 'declaration', resourceId: id,
      details: { objectId: obj.id, kind: input.kind, period: input.period, ack: ackNumber, changes: changes.length, verificationRequired, supersedes: supersedes?.id ?? null },
    });
    this.d.ctx.comms.publish('declaration.submitted', [taxpayerRecipient(this.d.ctx.taxpayers.get(holder))], { reference: ackNumber }, { entity: rule.administeringEntity });

    // Correction d'une déclaration déjà liquidée : instruction par un agent (contre-écriture si acceptée).
    if (supersedes?.liquidation.mode === 'OPPOSABLE') {
      decl = this.declarations.update({ ...decl, status: 'A_INSTRUIRE', liquidation: { mode: 'EN_INSTRUCTION', ...(supersedes.liquidation.obligationId ? { obligationId: supersedes.liquidation.obligationId } : {}), message: 'Correction d’une déclaration liquidée : instruction par un contrôleur ; l’obligation initiale reste due sur la partie non contestée.' } });
      return decl;
    }
    if (supersedes) this.declarations.update({ ...this.get(supersedes.id), status: 'REMPLACEE', supersededBy: decl.id });
    return this.liquidate(user, decl, rule, obj);
  }

  private liquidate(user: User, decl: Declaration, rule: RuleRecord, obj: FiscalObject): Declaration {
    const existing = this.existingObligation(obj, rule, decl.period);
    if (existing) {
      return this.declarations.update({ ...decl, liquidation: { mode: 'DEJA_LIQUIDEE', obligationId: existing, message: `Obligation déjà émise pour ce fait générateur et cette période (${existing}) : aucune double facturation.` } });
    }
    const exec = isRuleExecutable(rule, this.d.ctx.clock.now());
    const calc = { ruleId: rule.id, taxpayerId: decl.taxpayerId, objectId: obj.id, inputs: decl.inputs, simulate: !exec.ok };
    const res = this.d.ctx.assessment.liquidateDeclaration(user, calc, decl.id);
    if (res.obligation) {
      return this.declarations.update({ ...decl, status: 'LIQUIDEE', liquidation: { mode: 'OPPOSABLE', obligationId: res.obligation.id, trace: res.trace, message: `Obligation ${res.obligation.id} émise selon la règle ${rule.code} v${rule.version}.` } });
    }
    return this.declarations.update({ ...decl, liquidation: { mode: 'SIMULATION_NON_OPPOSABLE', trace: res.trace, message: `Simulation non opposable : ${exec.ok ? '' : exec.reason}. Aucune obligation n’est créée tant que la règle n’est pas ACTIVE (4 visas).` } });
  }

  correct(user: User, id: string, input: { inputs: Record<string, string>; reason: string; attest: boolean }): Declaration {
    const orig = this.get(id);
    const obj = this.d.ctx.objects.get(orig.objectId);
    authorize(user, 'fiscal:declaration.file', { taxpayerId: orig.taxpayerId, communes: [obj.commune] });
    if (orig.supersededBy || orig.status === 'REMPLACEE') throw conflict('DECLARATION_SUPERSEDED', 'Cette version a déjà été remplacée ; corrigez la dernière version.');
    if (orig.status === 'A_INSTRUIRE') throw conflict('CORRECTION_PENDING', 'Une correction est déjà en instruction.');
    const next = this.file(user, { objectId: orig.objectId, kind: orig.kind, period: orig.period, inputs: { ...orig.inputs, ...input.inputs }, attest: input.attest }, orig, input.reason);
    if (next.status === 'A_INSTRUIRE') this.declarations.update({ ...this.get(orig.id), supersededBy: next.id });
    return this.get(next.id);
  }

  /**
   * Instruction d'une correction sur déclaration liquidée : un contrôleur distinct du déclarant ET du liquidateur de
   * l'obligation initiale, sans lien avec le contribuable, décide ; motif obligatoire. Une correction À LA BAISSE
   * au-delà du seuil, ou abaissant un élément vérifié, exige une seconde validation par un autre contrôleur.
   */
  instruct(user: User, id: string, input: { decision: 'ACCEPTEE' | 'REJETEE'; reason: string }): Declaration {
    const decl = this.get(id);
    const obj = this.d.ctx.objects.get(decl.objectId);
    authorize(user, 'fiscal:declaration.instruct', { communes: [obj.commune] });
    if (decl.status !== 'A_INSTRUIRE') throw conflict('INVALID_DECLARATION_STATE', `Déclaration au statut ${decl.status}.`);
    assertDistinctPerson(user.id, [decl.filedBy], 'Le déclarant ne peut pas instruire sa propre correction.');
    assertNotRelated(user, decl.taxpayerId, 'Conflit d’intérêts : le contrôleur est lié au contribuable déclarant.');
    const now = this.d.nowIso();
    const orig = decl.supersedes ? this.get(decl.supersedes) : undefined;
    if (input.decision === 'REJETEE') {
      const r = this.declarations.update({ ...decl, status: 'CORRECTION_REJETEE', instruction: { decision: 'REJETEE', reason: input.reason, decidedBy: user.id, at: now }, liquidation: { ...decl.liquidation, mode: 'EN_INSTRUCTION', message: `Correction rejetée : ${input.reason}. L’obligation initiale reste due ; voie de réclamation ouverte.` } });
      if (orig) {
        const { supersededBy: _drop, ...rest } = orig;
        this.declarations.update(rest);
      }
      this.d.ctx.audit.append({ actor: actorOf(user), action: 'declaration.correction.rejected', resourceType: 'declaration', resourceId: id, details: { reason: input.reason } });
      return r;
    }
    const obligationId = decl.liquidation.obligationId;
    if (!obligationId) throw unprocessable('NO_OBLIGATION', 'Aucune obligation à rectifier.');
    const ob = this.d.ctx.assessment.get(obligationId);
    // Le liquidateur de l'obligation initiale (et le déposant de la version corrigée) n'instruisent pas la correction.
    assertDistinctPerson(user.id, [ob.createdBy, ...(orig ? [orig.filedBy] : [])], 'L’auteur de la liquidation initiale ne peut pas instruire la correction qui la réduit.');
    if (!PAYABLE_STATUSES.includes(ob.status)) throw unprocessable('OBLIGATION_NOT_RECTIFIABLE', `Obligation au statut ${ob.status} : rectification par ce circuit impossible (remboursement : circuit dédié).`);
    const rule = this.d.ctx.rules.get(ob.ruleId);
    // Recalcul déterministe avec la version de règle figée sur l'obligation.
    const sim = this.d.ctx.assessment.liquidateDeclaration(user, { ruleId: rule.id, taxpayerId: decl.taxpayerId, objectId: obj.id, inputs: decl.inputs, simulate: true }, decl.id);
    const from = Money.fromJSON(ob.amount);
    const to = Money.fromJSON(sim.trace.result);
    const downward = to.compare(from) < 0;
    const why: string[] = [];
    if (downward) {
      const threshold = DOWNWARD_CORRECTION_FOUR_EYES_THRESHOLD[from.currency];
      if (!threshold) why.push(`aucun seuil paramétré en ${from.currency}`);
      else if (from.subtract(to).compare(Money.of(threshold, from.currency)) > 0) why.push(`baisse de ${from.subtract(to).toDecimalString()} ${from.currency} > seuil ${threshold}`);
      if (decl.verificationRequired) why.push('élément vérifié abaissé');
    }
    let approvers = [user.id];
    if (why.length) {
      if (!decl.firstReview) {
        const r = this.declarations.update({ ...decl, firstReview: { by: user.id, at: now, reason: input.reason, fromAmount: ob.amount, toAmount: sim.trace.result, why } });
        this.d.ctx.audit.append({ actor: actorOf(user), action: 'declaration.correction.first_review', resourceType: 'declaration', resourceId: id, details: { reason: input.reason, from: ob.amount, to: sim.trace.result, why } });
        this.d.ctx.comms.publish('approval.requested', [...this.d.ctx.users.withRole('R07'), ...this.d.ctx.users.withRole('R11')].filter((u) => u.id !== user.id).map(userRecipient), { objet: `Seconde validation — correction ${id}` }, { entity: rule.administeringEntity });
        return r;
      }
      assertDistinctPerson(user.id, [decl.firstReview.by], 'Quatre yeux : la seconde validation d’une correction à la baisse est faite par un autre contrôleur.');
      approvers = [decl.firstReview.by, user.id];
    }
    const rectified = this.d.ctx.assessment.rectify(ob.id, sim.trace.result, { appealId: decl.id, reason: `Correction de déclaration acceptée : ${input.reason}`, decidedBy: user, decisionType: 'CORRECTION_DECLARATION' });
    if (orig) this.declarations.update({ ...orig, status: 'REMPLACEE', supersededBy: decl.id });
    const r = this.declarations.update({ ...decl, status: 'LIQUIDEE', instruction: { decision: 'ACCEPTEE', reason: input.reason, decidedBy: user.id, at: now, rectifiedObligationId: rectified.id, approvers }, liquidation: { mode: 'OPPOSABLE', obligationId: rectified.id, trace: sim.trace, message: `Obligation rectificative ${rectified.id} (contre-écriture de ${ob.id}).` } });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'declaration.correction.accepted', resourceType: 'declaration', resourceId: id, details: { reason: input.reason, original: ob.id, rectified: rectified.id, approvers } });
    if (downward) {
      recordReductionGranted(this.d.ctx.audit, actorOf(user), {
        path: 'CORRECTION_DECLARATION', obligationId: ob.id, fromAmount: ob.amount, toAmount: sim.trace.result, deciderId: user.id, taxpayerId: decl.taxpayerId,
        resultingObligationId: rectified.id, sourceId: decl.id, approvers,
      });
    }
    return r;
  }

  list(filter: { taxpayerId?: string; status?: string }): Declaration[] {
    return this.declarations.find((x) => (!filter.taxpayerId || x.taxpayerId === filter.taxpayerId) && (!filter.status || x.status === filter.status));
  }
}
