/**
 * Risques résiduels « organisationnels », traités aussi loin que le logiciel le permet :
 *  - collusion sous quatre yeux : détection sur le journal d'audit (alertes seulement) et rotation obligatoire
 *    facultative (désactivée par défaut) ;
 *  - registre des seuils anti-fraude : valeurs, sources, statut et circuit de confirmation à deux personnes ;
 *  - santé des clés : empreintes, âge, avertissements, sans jamais révéler un secret.
 * Le système propose, un humain décide : aucune sanction automatique, aucun seuil présenté comme définitif.
 */
import { runScheduledJob } from '../../../core/jobs.js';
import type { AppContext } from '../../../context.js';
import type { User } from '../../../core/auth.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../../core/errors.js';
import { kinshasaDate } from '../../../core/clock.js';
import { hasAnyGrant } from '../../../core/policy.js';
import { assertDistinctPerson, authorize } from '../../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../../core/repository.js';
import { CIRCUITS, reconstruct } from './circuits.js';
import { keyHealth } from './cles.js';
import { analyse, pairApprovalsInWindow, type CollusionParams, type Finding } from './collusion.js';
import { ALL_PARAMETERS, type ParamDefinition, type ParamValue } from './parametres.js';
import { isModulable, MODULABLES_PAR_ENTITE, STATUT_MODULABLE, type EntityOverride } from './parametres-entites.js';

export const STATUS_LABELS = {
  PAR_DEFAUT: 'PAR_DEFAUT — à confirmer par le maître d’ouvrage',
  MODIFIE_A_CONFIRMER: 'Modifié à deux personnes — acte à confirmer par le maître d’ouvrage',
  CONFIRME: 'CONFIRME',
} as const;
export type ParamStatus = keyof typeof STATUS_LABELS;

/** État enregistré d'un paramètre (valeur du registre, confirmation). Absent ⇒ valeur par défaut. */
export interface ParamState {
  id: string;
  value?: ParamValue;
  status: ParamStatus;
  confirmation?: { acte: string; proposedBy: string; approvedBy: string; at: string; requestId: string; value: ParamValue };
  history: { at: string; by: string; action: string; value: ParamValue; acte?: string; requestId: string }[];
}

export interface ChangeRequest {
  id: string;
  parameterId: string;
  kind: 'CONFIRMATION' | 'MODIFICATION';
  /** Valeur en vigueur au dépôt (une confirmation porte sur CETTE valeur). */
  currentValue: ParamValue;
  proposedValue: ParamValue;
  acte?: string;
  motif: string;
  status: 'PROPOSEE' | 'APPROUVEE' | 'REJETEE';
  proposedBy: string;
  proposedAt: string;
  decision?: { by: string; at: string; motif: string };
  /** Surcharge par entité (27/09/2026) : entité visée et date d'effet ; absent ⇒ valeur globale (circuit historique). */
  entity?: string;
  effectiveFrom?: string;
  /** Retour à la valeur héritée (retrait de la surcharge de l'entité). */
  removal?: boolean;
}

/** Vue minimale du module « acces » (arborescence des entités), lue à la demande (aucun cycle d'import). */
interface EntityTree { entities: { get(id: string): { id: string; parentId: string | null } | undefined }; subtree(root: string): Set<string> }

export class GouvernanceService {
  readonly states = new InMemoryRepository<ParamState>();
  readonly requests = new InMemoryRepository<ChangeRequest>();
  /** Surcharges par entité approuvées à deux personnes (27/09/2026). */
  readonly overrides = new InMemoryRepository<EntityOverride>();
  private readonly ids = new IdGenerator();

  constructor(readonly ctx: AppContext) {}

  private now(): string {
    return this.ctx.clock.now().toISOString();
  }

  private actor(u: User) {
    return { kind: 'user' as const, id: u.id, roles: u.roles };
  }

  /* ================================================================ */
  /* Registre des seuils                                               */
  /* ================================================================ */

  private definition(id: string): ParamDefinition {
    const d = ALL_PARAMETERS.find((p) => p.id === id);
    if (!d) throw notFound('PARAMETER_NOT_FOUND', `Paramètre inconnu du registre : ${id}`);
    return d;
  }

  /** Valeur en vigueur : celle du registre pour ses propres paramètres, celle du code sinon. */
  value(id: string): ParamValue {
    const d = this.definition(id);
    const s = this.states.get(id);
    return d.owner === 'REGISTRE' && s?.value !== undefined ? s.value : d.value;
  }

  private num(id: string): number {
    return Number(this.value(id));
  }

  entry(d: ParamDefinition) {
    const s = this.states.get(d.id);
    const status: ParamStatus = s?.status ?? 'PAR_DEFAUT';
    const value = d.owner === 'REGISTRE' && s?.value !== undefined ? s.value : d.value;
    // Une confirmation d'une constante du code ne vaut que pour la valeur confirmée : si le code a changé depuis, retour au défaut.
    const drifted = d.owner === 'CODE' && s?.confirmation !== undefined && s.confirmation.value !== d.value;
    const effective: ParamStatus = drifted ? 'PAR_DEFAUT' : status;
    return {
      id: d.id, label: d.label, category: d.category, value, defaultValue: d.value, unit: d.unit, owner: d.owner, source: d.source,
      ...(d.description ? { description: d.description } : {}), ...(d.min !== undefined ? { min: d.min } : {}), ...(d.max !== undefined ? { max: d.max } : {}),
      status: effective,
      statusLabel: effective === 'CONFIRME' && s?.confirmation ? `CONFIRME (acte ${s.confirmation.acte})` : STATUS_LABELS[effective],
      ...(s?.confirmation && !drifted ? { confirmation: s.confirmation } : {}),
      ...(drifted ? { drift: `Valeur confirmée ${String(s!.confirmation!.value)} ≠ valeur du code ${String(d.value)} : nouvelle confirmation requise.` } : {}),
      pendingRequest: this.requests.findOne((r) => r.parameterId === d.id && !r.entity && r.status === 'PROPOSEE')?.id ?? null,
    };
  }

  register(user: User) {
    authorize(user, 'integrite:thresholds.read');
    const entries = ALL_PARAMETERS.map((d) => this.entry(d));
    return {
      entries,
      summary: {
        total: entries.length,
        parDefaut: entries.filter((e) => e.status === 'PAR_DEFAUT').length,
        confirmes: entries.filter((e) => e.status === 'CONFIRME').length,
        modifiesAConfirmer: entries.filter((e) => e.status === 'MODIFIE_A_CONFIRMER').length,
      },
      requests: this.requests.all().sort((a, b) => b.proposedAt.localeCompare(a.proposedAt)),
      note: 'Registre en lecture seule : les valeurs du code sont importées des modules. Toute confirmation ou modification passe par une proposition motivée puis l’approbation d’une autre personne, journalisées.',
    };
  }

  proposeChange(user: User, input: { parameterId: string; kind: 'CONFIRMATION' | 'MODIFICATION'; proposedValue?: ParamValue; acte?: string; motif: string; entity?: string; effectiveFrom?: string; removal?: boolean }): ChangeRequest {
    if (input.entity) return this.proposeEntityOverride(user, { ...input, entity: input.entity });
    authorize(user, 'integrite:thresholds.propose');
    const d = this.definition(input.parameterId);
    if (this.requests.findOne((r) => r.parameterId === d.id && !r.entity && r.status === 'PROPOSEE')) {
      throw conflict('CHANGE_REQUEST_PENDING', `Une demande attend déjà une décision pour ${d.id}.`);
    }
    const current = this.value(d.id);
    const acte = input.acte?.trim();
    let proposed: ParamValue = current;
    if (input.kind === 'CONFIRMATION') {
      if (!acte) throw badRequest('ACTE_REQUIRED', 'Une confirmation cite l’acte du maître d’ouvrage (référence, date).');
    } else {
      if (d.owner === 'CODE') {
        throw unprocessable('CODE_PARAMETER', `${d.id} est une constante du code (${d.source.file}) : sa modification passe par une livraison logicielle, puis par une confirmation dans ce registre.`);
      }
      if (input.proposedValue === undefined) throw badRequest('VALUE_REQUIRED', 'Valeur proposée requise.');
      if (typeof input.proposedValue !== typeof d.value) throw badRequest('VALUE_TYPE', `Valeur de type ${typeof d.value} attendue.`);
      if (typeof input.proposedValue === 'number') {
        if (!Number.isFinite(input.proposedValue) || (d.min !== undefined && input.proposedValue < d.min) || (d.max !== undefined && input.proposedValue > d.max)) {
          throw unprocessable('VALUE_OUT_OF_RANGE', `Valeur hors des bornes admises (${d.min ?? '−∞'} à ${d.max ?? '+∞'} ${d.unit}).`);
        }
      }
      if (input.proposedValue === current) throw unprocessable('VALUE_UNCHANGED', 'La valeur proposée est la valeur en vigueur : utilisez une confirmation.');
      proposed = input.proposedValue;
    }
    const r = this.requests.insert({
      id: this.ids.next('SEUIL'), parameterId: d.id, kind: input.kind, currentValue: current, proposedValue: proposed,
      ...(acte ? { acte } : {}), motif: input.motif.trim(), status: 'PROPOSEE', proposedBy: user.id, proposedAt: this.now(),
    });
    this.ctx.audit.append({
      actor: this.actor(user), action: 'integrite.threshold.change_proposed', resourceType: 'threshold_change', resourceId: r.id,
      details: { parameterId: d.id, kind: r.kind, currentValue: current, proposedValue: proposed, acte: acte ?? null, motif: r.motif },
    });
    return r;
  }

  decideChange(user: User, id: string, input: { approve: boolean; motif: string }): ChangeRequest {
    authorize(user, 'integrite:thresholds.approve');
    const r = this.requests.get(id);
    if (!r) throw notFound('CHANGE_REQUEST_NOT_FOUND', `Demande inconnue : ${id}`);
    if (r.status !== 'PROPOSEE') throw conflict('CHANGE_REQUEST_ALREADY_DECIDED', `Demande au statut ${r.status}.`);
    assertDistinctPerson(user.id, [r.proposedBy], 'Quatre yeux : la demande est approuvée par une personne distincte de son auteur.');
    if (r.entity && input.approve) return this.applyEntityOverride(user, r, input.motif);
    const at = this.now();
    if (!input.approve) {
      const out = this.requests.update({ ...r, status: 'REJETEE', decision: { by: user.id, at, motif: input.motif.trim() } });
      this.ctx.audit.append({ actor: this.actor(user), action: 'integrite.threshold.change_rejected', resourceType: 'threshold_change', resourceId: id, details: { parameterId: r.parameterId, proposedBy: r.proposedBy, motif: input.motif.trim() } });
      return out;
    }
    const d = this.definition(r.parameterId);
    // La valeur a pu changer entre la proposition et la décision (livraison, autre demande) : la confirmation serait fausse.
    if (this.value(d.id) !== r.currentValue) {
      throw conflict('VALUE_CHANGED', `La valeur de ${d.id} a changé depuis la proposition (${String(r.currentValue)} → ${String(this.value(d.id))}) : nouvelle proposition requise.`);
    }
    const prev = this.states.get(d.id);
    const status: ParamStatus = r.acte ? 'CONFIRME' : 'MODIFIE_A_CONFIRMER';
    const state: ParamState = {
      id: d.id,
      ...(d.owner === 'REGISTRE' ? { value: r.proposedValue } : {}),
      status,
      ...(r.acte ? { confirmation: { acte: r.acte, proposedBy: r.proposedBy, approvedBy: user.id, at, requestId: r.id, value: r.proposedValue } } : {}),
      history: [...(prev?.history ?? []), { at, by: user.id, action: r.kind, value: r.proposedValue, ...(r.acte ? { acte: r.acte } : {}), requestId: r.id }],
    };
    if (prev) this.states.update(state); else this.states.insert(state);
    const out = this.requests.update({ ...r, status: 'APPROUVEE', decision: { by: user.id, at, motif: input.motif.trim() } });
    this.ctx.audit.append({
      actor: this.actor(user), action: 'integrite.threshold.change_approved', resourceType: 'threshold_change', resourceId: id,
      details: { parameterId: d.id, kind: r.kind, proposedBy: r.proposedBy, from: r.currentValue, to: r.proposedValue, acte: r.acte ?? null, status },
    });
    return out;
  }

  /* ================================================================ */
  /* Variables par département (27/09/2026)                            */
  /* ================================================================ */

  private tree(): EntityTree | undefined {
    return this.ctx.ext.acces as EntityTree | undefined;
  }

  private day(): string {
    return kinshasaDate(this.ctx.clock.now());
  }

  /** Lignée d'une entité : elle-même, puis ses entités parentes jusqu'à la racine. */
  lineage(entity: string): string[] {
    const t = this.tree();
    const out: string[] = [];
    let cur: string | null | undefined = entity;
    let guard = 0;
    while (cur && guard++ < 20) {
      out.push(cur);
      cur = t?.entities.get(cur)?.parentId;
    }
    return out;
  }

  private activeOverride(id: string, entity: string): EntityOverride | undefined {
    const o = this.overrides.get(`${id}|${entity}`);
    return o && o.status === 'ACTIVE' && o.effectiveFrom <= this.day() ? o : undefined;
  }

  /** Résolution : entité → entité parente (en remontant) → valeur globale ; seulement pour un paramètre modulable. */
  resolve(id: string, entity: string): { value: ParamValue; provenance: 'ENTITE' | 'ENTITE_PARENTE' | 'GLOBAL'; sourceEntity: string | null } {
    const global = this.value(id);
    if (!isModulable(id)) return { value: global, provenance: 'GLOBAL', sourceEntity: null };
    for (const [i, e] of this.lineage(entity).entries()) {
      const o = this.activeOverride(id, e);
      if (o) return { value: o.value, provenance: i === 0 ? 'ENTITE' : 'ENTITE_PARENTE', sourceEntity: e };
    }
    return { value: global, provenance: 'GLOBAL', sourceEntity: null };
  }

  valueFor(id: string, entity: string): ParamValue {
    return this.resolve(id, entity).value;
  }

  /** Administration de la plateforme (tout), administrateur d'entité (son sous-arbre), habilités du registre (tout). */
  private assertEntityScope(user: User, entity: string, write: boolean): void {
    const t = this.tree();
    if (!t?.entities.get(entity)) throw notFound('ENTITY_NOT_FOUND', `Entité inconnue : ${entity}`);
    if (user.roles.includes('R26')) return;
    if (user.roles.includes('R08') && t.subtree(user.entity).has(entity)) return;
    if (write ? hasAnyGrant(user, 'integrite:thresholds.propose') : hasAnyGrant(user, 'integrite:thresholds.read')) return;
    this.ctx.audit.append({ actor: this.actor(user), action: 'integrite.threshold.entity_scope_refused', resourceType: 'entity', resourceId: entity, outcome: 'DENIED', details: { entity, write } });
    throw forbidden('OUT_OF_PERIMETER', 'Hors de votre périmètre : un administrateur d’entité n’agit que sur son entité et ses sous-entités.');
  }

  /** Variable d'une règle juridique (table de taux) : jamais surchargeable par entité (registre des règles, quatre visas). */
  private isLegalRuleVariable(id: string): boolean {
    if (id.startsWith('regle:') || id.startsWith('rule:')) return true;
    const rules = (this.ctx as unknown as { rules?: { list(): { code: string; rateTable?: Record<string, string> }[] } }).rules?.list() ?? [];
    return rules.some((r) => Object.keys(r.rateTable ?? {}).some((k) => k === id || `${r.code}:${k}` === id || `${r.code}.${k}` === id));
  }

  private proposeEntityOverride(user: User, input: { parameterId: string; proposedValue?: ParamValue; acte?: string; motif: string; entity: string; effectiveFrom?: string; removal?: boolean }): ChangeRequest {
    this.assertEntityScope(user, input.entity, true);
    const refuse = (code: string) => this.ctx.audit.append({
      actor: this.actor(user), action: 'integrite.threshold.entity_override_refused', resourceType: 'threshold', resourceId: input.parameterId, outcome: 'DENIED', details: { entity: input.entity, code },
    });
    if (this.isLegalRuleVariable(input.parameterId)) {
      refuse('LEGAL_RULE_VARIABLE');
      throw unprocessable('LEGAL_RULE_VARIABLE', 'Variable d’un barème juridique : elle reste gouvernée par le registre des règles et ses quatre visas ; aucune surcharge par entité.');
    }
    const d = ALL_PARAMETERS.find((p) => p.id === input.parameterId);
    if (!d) throw notFound('PARAMETER_NOT_FOUND', `Paramètre inconnu du registre : ${input.parameterId}`);
    if (!isModulable(d.id) || d.owner !== 'REGISTRE') {
      refuse('PARAMETER_NOT_MODULABLE');
      throw unprocessable('PARAMETER_NOT_MODULABLE', `${d.id} n’est pas déclaré « modulable par entité » : seule la valeur globale du registre s’applique.`);
    }
    if (this.requests.findOne((r) => r.parameterId === d.id && r.entity === input.entity && r.status === 'PROPOSEE')) {
      throw conflict('CHANGE_REQUEST_PENDING', `Une demande attend déjà une décision pour ${d.id} (${input.entity}).`);
    }
    const effectiveFrom = input.effectiveFrom ?? this.day();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) throw badRequest('BAD_DATE', 'Date d’effet AAAA-MM-JJ attendue.');
    const current = this.resolve(d.id, input.entity).value;
    let proposed: ParamValue = current;
    if (input.removal) {
      if (this.overrides.get(`${d.id}|${input.entity}`)?.status !== 'ACTIVE') throw conflict('NO_OVERRIDE', 'Aucune surcharge active pour cette entité.');
    } else {
      if (input.proposedValue === undefined) throw badRequest('VALUE_REQUIRED', 'Valeur proposée requise.');
      if (typeof input.proposedValue !== typeof d.value) throw badRequest('VALUE_TYPE', `Valeur de type ${typeof d.value} attendue.`);
      if (typeof input.proposedValue === 'number' && (!Number.isFinite(input.proposedValue) || (d.min !== undefined && input.proposedValue < d.min) || (d.max !== undefined && input.proposedValue > d.max))) {
        throw unprocessable('VALUE_OUT_OF_RANGE', `Valeur hors des bornes admises (${d.min ?? '−∞'} à ${d.max ?? '+∞'} ${d.unit}).`);
      }
      proposed = input.proposedValue;
    }
    const acte = input.acte?.trim();
    const r = this.requests.insert({
      id: this.ids.next('SEUIL'), parameterId: d.id, kind: 'MODIFICATION', currentValue: current, proposedValue: proposed, ...(acte ? { acte } : {}),
      motif: input.motif.trim(), status: 'PROPOSEE', proposedBy: user.id, proposedAt: this.now(), entity: input.entity, effectiveFrom, ...(input.removal ? { removal: true } : {}),
    });
    this.ctx.audit.append({
      actor: this.actor(user), action: 'integrite.threshold.entity_override_proposed', resourceType: 'threshold_change', resourceId: r.id,
      details: { parameterId: d.id, entity: input.entity, currentValue: current, proposedValue: proposed, effectiveFrom, removal: !!input.removal, acte: acte ?? null, motif: r.motif },
    });
    return r;
  }

  private applyEntityOverride(user: User, r: ChangeRequest, motif: string): ChangeRequest {
    const entity = r.entity!;
    if (this.resolve(r.parameterId, entity).value !== r.currentValue) {
      throw conflict('VALUE_CHANGED', `La valeur de ${r.parameterId} pour ${entity} a changé depuis la proposition : nouvelle proposition requise.`);
    }
    const at = this.now();
    const key = `${r.parameterId}|${entity}`;
    const prev = this.overrides.get(key);
    const step = { at, by: user.id, action: r.removal ? 'RETRAIT' : 'SURCHARGE', value: r.removal ? null : r.proposedValue, effectiveFrom: r.effectiveFrom!, requestId: r.id };
    const o: EntityOverride = r.removal && prev
      ? { ...prev, status: 'RETIREE', history: [...prev.history, step] }
      : {
        id: key, parameterId: r.parameterId, entity, value: r.proposedValue, effectiveFrom: r.effectiveFrom!, status: 'ACTIVE', requestId: r.id,
        proposedBy: r.proposedBy, approvedBy: user.id, ...(r.acte ? { acte: r.acte } : {}), history: [...(prev?.history ?? []), step],
      };
    if (prev) this.overrides.update(o); else this.overrides.insert(o);
    const out = this.requests.update({ ...r, status: 'APPROUVEE', decision: { by: user.id, at, motif: motif.trim() } });
    this.ctx.audit.append({
      actor: this.actor(user), action: 'integrite.threshold.entity_override_approved', resourceType: 'threshold_change', resourceId: r.id,
      details: { parameterId: r.parameterId, entity, proposedBy: r.proposedBy, from: r.currentValue, to: r.proposedValue, effectiveFrom: r.effectiveFrom, removal: !!r.removal },
    });
    return out;
  }

  /** Valeurs en vigueur pour une entité, avec leur provenance (GET /v1/parametres/effectifs?entity=…). */
  effectifs(user: User, entity: string, opts: { modulablesOnly?: boolean } = {}) {
    this.assertEntityScope(user, entity, false);
    const line = this.lineage(entity);
    const today = this.day();
    const items = ALL_PARAMETERS.filter((d) => !opts.modulablesOnly || isModulable(d.id)).map((d) => {
      const res = this.resolve(d.id, entity);
      const programmed = line.map((e) => this.overrides.get(`${d.id}|${e}`)).filter((o): o is EntityOverride => !!o && o.status === 'ACTIVE' && o.effectiveFrom > today);
      return {
        id: d.id, label: d.label, category: d.category, unit: d.unit, owner: d.owner, globalValue: this.value(d.id), value: res.value,
        provenance: res.provenance, sourceEntity: res.sourceEntity, modulable: isModulable(d.id) && d.owner === 'REGISTRE',
        ...(isModulable(d.id) ? { modulableStatus: STATUT_MODULABLE, consumer: MODULABLES_PAR_ENTITE[d.id]!.consommateur } : {}),
        ...(d.min !== undefined ? { min: d.min } : {}), ...(d.max !== undefined ? { max: d.max } : {}),
        override: this.overrides.get(`${d.id}|${entity}`) ?? null,
        programmed: programmed.map((o) => ({ entity: o.entity, value: o.value, effectiveFrom: o.effectiveFrom })),
        pending: this.requests.find((r) => r.parameterId === d.id && r.entity === entity && r.status === 'PROPOSEE'),
      };
    });
    return {
      entity, lineage: line, resolution: 'entité → entité parente → valeur globale du registre', modulableStatus: STATUT_MODULABLE,
      items, note: 'Les variables des barèmes juridiques restent gouvernées par le registre des règles (quatre visas) : aucune surcharge par entité.',
    };
  }

  /** Surcharges et demandes par entité, dans le périmètre de la personne. */
  overridesFor(user: User, entity?: string) {
    if (entity) this.assertEntityScope(user, entity, false);
    const t = this.tree();
    const all = user.roles.includes('R26') || hasAnyGrant(user, 'integrite:thresholds.read');
    const scope = entity ? new Set([entity]) : all ? null : t && user.roles.includes('R08') ? t.subtree(user.entity) : new Set<string>();
    return {
      items: this.overrides.all().filter((o) => !scope || scope.has(o.entity)),
      requests: this.requests.all().filter((r) => r.entity && (!scope || scope.has(r.entity))),
    };
  }

  /* ================================================================ */
  /* Collusion sous quatre yeux                                        */
  /* ================================================================ */

  params(): CollusionParams {
    return {
      windowDays: this.num('collusion.fenetre_jours'),
      pairShareMinPct: this.num('collusion.paire_part_min_pct'),
      pairDecisionsMin: this.num('collusion.paire_decisions_min'),
      fastSeconds: this.num('collusion.validation_rapide_s'),
      fastMinCount: this.num('collusion.validation_rapide_nombre_min'),
      workStartHour: this.num('collusion.heure_debut'),
      workEndHour: this.num('collusion.heure_fin'),
      offHoursMinCount: this.num('collusion.hors_heures_nombre_min'),
      neverRefuseMin: this.num('collusion.jamais_refus_decisions_min'),
      rotationEnforced: this.value('rotation.blocage_actif') === true,
      rotationMaxPerPair: this.num('rotation.max_par_paire'),
      rotationWindowDays: this.num('rotation.fenetre_jours'),
    };
  }

  private records() {
    return this.ctx.audit.list({ limit: Number.MAX_SAFE_INTEGER }).items;
  }

  private compute() {
    const { decisions } = reconstruct(this.records());
    return { all: decisions, ...analyse(decisions, this.params(), this.ctx.clock.now()) };
  }

  /** Vue de la détection. Les constats et paires qui visent la personne qui consulte lui sont masqués. */
  collusion(user: User) {
    authorize(user, 'integrite:collusion.read');
    const p = this.params();
    const r = this.compute();
    const mine = (subjects: string[]) => subjects.includes(user.id);
    const findings = r.findings.filter((f) => !mine(f.subjects));
    const pairs = r.pairs.filter((x) => !mine([x.proposerId, x.approverId]));
    const approvers = r.approvers.filter((x) => x.approverId !== user.id);
    const masked = r.findings.length - findings.length + (r.pairs.length - pairs.length);
    this.ctx.audit.append({ actor: this.actor(user), action: 'integrite.collusion.viewed', resourceType: 'collusion', resourceId: '*', details: { findings: findings.length, masked } });
    const statusOf = (id: string) => this.entry(this.definition(id)).statusLabel;
    return {
      generatedAt: this.now(),
      params: {
        ...p,
        statut: statusOf('collusion.fenetre_jours'),
        rotationStatut: statusOf('rotation.blocage_actif'),
      },
      circuits: CIRCUITS.map((c) => ({
        code: c.code, label: c.label, guarded: !!c.guard,
        decisions: r.decisions.filter((d) => d.circuit === c.code).length,
      })),
      totals: {
        decisions: r.decisions.length,
        approvals: r.decisions.filter((d) => d.outcome === 'APPROUVE').length,
        refusals: r.decisions.filter((d) => d.outcome === 'REFUSE').length,
        pairs: r.pairs.length,
      },
      pairs: pairs.slice(0, 50),
      approvers: approvers.slice(0, 50),
      findings,
      masked,
      rotation: {
        enforced: p.rotationEnforced, maxPerPair: p.rotationMaxPerPair, windowDays: p.rotationWindowDays,
        atLimit: pairs.filter((x) => x.inRotationWindow >= p.rotationMaxPerPair).map((x) => ({ proposerId: x.proposerId, approverId: x.approverId, count: x.inRotationWindow })),
      },
      schedule: {
        intervalHours: this.num('collusion.detection_intervalle_h'), statut: statusOf('collusion.detection_intervalle_h'), active: this.schedulerActive,
        lastRunAt: this.lastScheduledRun() === null ? null : new Date(this.lastScheduledRun()!).toISOString(),
      },
      automaticEffect: 'AUCUN' as const,
      note: 'Signaux à examiner par un humain : ils ne valent ni preuve ni soupçon établi. Aucune sanction automatique.',
    };
  }

  /** Lève les alertes (mécanisme commun des alertes de sécurité → reprises par la détection du module Intégrité). */
  runCollusion(user: User | 'system', trigger: 'MANUELLE' | 'PLANIFIEE' = 'MANUELLE') {
    if (user !== 'system') authorize(user, 'integrite:collusion.run');
    const r = this.compute();
    const raised = r.findings.map((f) => this.raise(f, user)).filter((a) => a !== null);
    this.ctx.audit.append({
      actor: user === 'system' ? { kind: 'system', id: 'integrite:collusion' } : this.actor(user),
      action: 'integrite.collusion.run', resourceType: 'collusion', resourceId: '*', details: { findings: r.findings.length, raised: raised.length, trigger, automaticEffect: 'AUCUN' },
    });
    return { findings: r.findings.length, raised: raised.length, alertIds: raised.map((a) => a!.id), automaticEffect: 'AUCUN' as const };
  }

  /* ---------------- Détection planifiée ---------------- */

  private timer: ReturnType<typeof setInterval> | undefined;
  /** Instant (ms) de la dernière exécution planifiée ; relu au journal d'audit au premier passage (reprise après redémarrage). */
  private lastScheduled: number | null | undefined;

  private lastScheduledRun(): number | null {
    if (this.lastScheduled === undefined) {
      const runs = this.ctx.audit.list({ action: 'integrite.collusion.run', limit: Number.MAX_SAFE_INTEGER }).items.filter((e) => e.details.trigger === 'PLANIFIEE');
      this.lastScheduled = runs.length ? Date.parse(runs[runs.length - 1]!.at) : null;
    }
    return this.lastScheduled;
  }

  /**
   * Passage du planificateur : exécute la détection si l'intervalle du registre (`collusion.detection_intervalle_h`,
   * 0 = désactivée) est écoulé depuis la dernière exécution planifiée. Chaque exécution — ou échec — est journalisée.
   */
  scheduledTick(): { ran: boolean; findings?: number; raised?: number } {
    const hours = this.num('collusion.detection_intervalle_h');
    if (!(hours > 0)) return { ran: false };
    const now = this.ctx.clock.now().getTime();
    const last = this.lastScheduledRun();
    if (last !== null && now - last < hours * 3_600_000) return { ran: false };
    this.lastScheduled = now;
    try {
      const r = this.runCollusion('system', 'PLANIFIEE');
      return { ran: true, findings: r.findings, raised: r.raised };
    } catch (e) {
      this.ctx.audit.append({
        actor: { kind: 'system', id: 'integrite:collusion' }, action: 'integrite.collusion.run_failed', resourceType: 'collusion', resourceId: '*', outcome: 'FAILURE',
        details: { trigger: 'PLANIFIEE', error: e instanceof Error ? e.message : String(e) },
      });
      return { ran: false };
    }
  }

  /** Planificateur léger : vérifie périodiquement (défaut : toutes les 5 minutes) si une exécution est due. */
  startScheduler(tickMs = 300_000): void {
    this.stopScheduler();
    this.timer = setInterval(() => { runScheduledJob(this.ctx, 'integrite.gouvernance-detection', () => { this.scheduledTick(); }); }, tickMs);
    this.timer.unref?.();
  }
  stopScheduler(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  get schedulerActive(): boolean { return this.timer !== undefined; }

  private raise(f: Finding, by: User | 'system') {
    return this.ctx.alerts.raiseOnce(f.fingerprint, {
      type: `COLLUSION_${f.code}`, severity: f.severity, source: 'integrite:collusion', detail: `${f.label} — ${f.explanation}`,
      context: { subjects: f.subjects, variables: f.variables, evidence: f.evidence, automaticEffect: 'AUCUN' },
      ...(by !== 'system' ? { actor: this.actor(by) } : {}), notifyRoles: ['R22'],
    });
  }

  /**
   * Garde de rotation (appelée AVANT la décision d'un circuit à quatre yeux). Plafond non atteint : rien.
   * Plafond atteint : blocage désactivé ⇒ alerte seulement ; activé ⇒ refus motivé (409) et alerte.
   */
  rotationGuard(user: User, circuitCode: string, key: string): void {
    const p = this.params();
    if (p.rotationMaxPerPair <= 0) return;
    const { decisions, pending } = reconstruct(this.records());
    const proposerId = pending.get(`${circuitCode}|${key}`)?.actorId;
    if (!proposerId || proposerId === user.id) return;
    const n = pairApprovalsInWindow(decisions, proposerId, user.id, p.rotationWindowDays, this.ctx.clock.now().getTime());
    if (n < p.rotationMaxPerPair) return;
    const day = this.now().slice(0, 10);
    const detail = `La paire ${proposerId} → ${user.id} a déjà ${n} validation(s) en ${p.rotationWindowDays} jours (plafond ${p.rotationMaxPerPair}) — circuit ${circuitCode}, dossier ${key}.`;
    this.ctx.alerts.raiseOnce(`COL:ROTATION_GARDE:${proposerId}>${user.id}:${day}:${p.rotationEnforced ? 'B' : 'A'}`, {
      type: p.rotationEnforced ? 'COLLUSION_ROTATION_BLOQUEE' : 'COLLUSION_ROTATION_DEPASSEE', severity: 'MEDIUM', source: 'integrite:rotation',
      detail, context: { proposerId, approverId: user.id, circuit: circuitCode, key, count: n, automaticEffect: p.rotationEnforced ? 'VALIDATION_REFUSEE' : 'AUCUN' },
      actor: this.actor(user), notifyRoles: ['R22'],
    });
    if (!p.rotationEnforced) return;
    this.ctx.audit.append({ actor: this.actor(user), action: 'integrite.rotation.blocked', resourceType: 'rotation', resourceId: `${circuitCode}:${key}`, outcome: 'DENIED', details: { proposerId, count: n, max: p.rotationMaxPerPair, windowDays: p.rotationWindowDays } });
    throw conflict('ROTATION_REQUIRED', `Rotation obligatoire : ${detail} Une autre personne habilitée doit décider.`, { proposerId, count: n, max: p.rotationMaxPerPair });
  }

  /* ================================================================ */
  /* Santé des clés                                                    */
  /* ================================================================ */

  keys(user: User, env: NodeJS.ProcessEnv = process.env) {
    authorize(user, 'integrite:keys.read');
    const out = keyHealth(this.ctx, { env, minLength: this.num('cles.longueur_min'), maxAgeDays: this.num('cles.age_max_jours') });
    this.ctx.audit.append({ actor: this.actor(user), action: 'integrite.keys.checked', resourceType: 'key_health', resourceId: '*', details: { critical: out.summary.critical, attention: out.summary.attention } });
    return out;
  }
}
