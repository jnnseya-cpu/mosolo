/**
 * Moteur de dépendances entre services (§ 8.1, § 8.5, § 10A.3) : un service d'une entité (permis de bâtir, mutation
 * foncière, mutation de véhicule, marché public, autorisation de transport) déclare ses conditions (quitus valide,
 * vignette valide) comme des RÈGLES VERSIONNÉES, visibles du citoyen. Tant que l'acte juridique de la dépendance
 * (point J, ex. J6 pour le quitus) n'est pas certifié au registre et l'activation approuvée par une seconde personne,
 * la dépendance est INFORMATIVE : la condition est affichée et évaluée, elle ne bloque rien (ARB-17). Une fois
 * activée (nouvelle version BLOQUANTE), le service dépendant est bloqué jusqu'à satisfaction.
 */
import type { User } from '../../core/auth.js';
import { conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, evaluate, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { actorOf, type FiscalDeps } from './common.js';
import type { ClearanceService } from './clearances.js';

const { always, ownTaxpayer, mandant } = GRANTS;
definePolicy('fiscal:dependency.check', { R37: always, R06: always, R07: always, R11: always, R12: always, R30: ownTaxpayer, R31: mandant });
definePolicy('fiscal:dependency.propose', { R13: always, R06: always });
definePolicy('fiscal:dependency.approve', { R16: always, R05: always });

export const DEPENDENT_SERVICES = ['PERMIS_DE_BATIR', 'MUTATION_FONCIERE', 'MUTATION_VEHICULE', 'MARCHE_PUBLIC', 'AUTORISATION_TRANSPORT'] as const;
export type DependentService = (typeof DEPENDENT_SERVICES)[number];
export const CONDITION_KINDS = ['QUITUS_VALIDE', 'VIGNETTE_VALIDE'] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

export const SERVICE_LABELS: Record<DependentService, string> = {
  PERMIS_DE_BATIR: 'Permis de bâtir', MUTATION_FONCIERE: 'Mutation foncière', MUTATION_VEHICULE: 'Mutation de véhicule',
  MARCHE_PUBLIC: 'Soumission à un marché public', AUTORISATION_TRANSPORT: 'Autorisation de transport',
};
export const CONDITION_LABELS: Record<ConditionKind, string> = { QUITUS_VALIDE: 'Quitus fiscal valide', VIGNETTE_VALIDE: 'Vignette du véhicule valide' };

/** Démarches des verticales rattachées à un service dépendant (le moteur y ajoute ses conditions). */
export const PROCEDURE_SERVICES: Record<string, DependentService> = {
  'construction:DEMANDE_AUTORISATION_CHANTIER': 'PERMIS_DE_BATIR',
  'mobilite:DEMANDE_AUTORISATION_TRANSPORT': 'AUTORISATION_TRANSPORT',
  // Module 11 : la mutation d'un véhicule est bloquée sans quitus lorsque la règle l'exige (mode BLOQUANT).
  'mobilite:DECLARATION_MUTATION': 'MUTATION_VEHICULE',
  'actifs:MANIFESTATION_INTERET': 'MARCHE_PUBLIC',
};

export interface ServiceDependency {
  id: string;
  code: string;
  version: number;
  service: DependentService;
  serviceEntity: string;
  condition: ConditionKind;
  conditionEntity: string;
  /** Texte montré au citoyen (§ 10A.3 : la condition est visible). */
  citizenText: string;
  /** Acte requis pour l'activation : point J et, une fois certifié, l'instrument du registre. */
  legal: { jPoint: string; instrumentId?: string; article?: string };
  mode: 'INFORMATIF' | 'BLOQUANT';
  status: 'EN_VIGUEUR' | 'REMPLACEE';
  effectiveFrom: string;
  createdAt: string;
  createdBy: string;
  supersedes?: string;
  supersededBy?: string;
  activation?: { proposedBy: string; approvedBy: string; instrumentId: string; article?: string; at: string };
  pendingChange?: { targetMode: 'INFORMATIF' | 'BLOQUANT'; instrumentId: string; article?: string; reason: string; proposedBy: string; at: string };
}

export interface ConditionResult {
  dependencyId: string;
  code: string;
  version: number;
  condition: ConditionKind;
  label: string;
  citizenText: string;
  mode: 'INFORMATIF' | 'BLOQUANT';
  satisfied: boolean;
  detail: string;
  legal: ServiceDependency['legal'];
}

export class DependencyService {
  readonly dependencies = new InMemoryRepository<ServiceDependency>();
  readonly checks = new InMemoryAppendOnlyRepository<{ id: string; at: string; service: DependentService; taxpayerId: string; blocked: boolean; actorId: string }>();
  private readonly ids = new IdGenerator();

  constructor(private readonly d: FiscalDeps, private readonly clearances: ClearanceService) {}

  /** Dépendances de référence (§ 8.1, § 10A.3), en mode INFORMATIF tant que l'acte n'est pas certifié. */
  seed(): void {
    const at = this.d.nowIso();
    const base: [string, DependentService, string, ConditionKind, string, string][] = [
      ['DEP-PERMIS-QUITUS', 'PERMIS_DE_BATIR', 'URBANISME', 'QUITUS_VALIDE', 'DGIPK', 'J6'],
      ['DEP-MUTATION-FONCIERE-QUITUS', 'MUTATION_FONCIERE', 'AFFAIRES_FONCIERES', 'QUITUS_VALIDE', 'DGIPK', 'J6'],
      ['DEP-MUTATION-VEHICULE-QUITUS', 'MUTATION_VEHICULE', 'TRANSPORTS', 'QUITUS_VALIDE', 'DGIPK', 'J6'],
      ['DEP-MARCHE-PUBLIC-QUITUS', 'MARCHE_PUBLIC', 'MARCHES_PUBLICS', 'QUITUS_VALIDE', 'DGIPK', 'J6'],
      ['DEP-TRANSPORT-VIGNETTE', 'AUTORISATION_TRANSPORT', 'TRANSPORTS', 'VIGNETTE_VALIDE', 'DGRK', 'J1'],
    ];
    for (const [code, service, serviceEntity, condition, conditionEntity, jPoint] of base) {
      if (this.dependencies.findOne((x) => x.code === code)) continue;
      this.dependencies.insert({
        id: `${code}-v1`, code, version: 1, service, serviceEntity, condition, conditionEntity,
        citizenText: `${SERVICE_LABELS[service]} : ${CONDITION_LABELS[condition].toLowerCase()} demandé. Tant que l’acte (${jPoint}) n’est pas publié, cette condition est seulement indiquée et ne bloque pas votre démarche.`,
        legal: { jPoint }, mode: 'INFORMATIF', status: 'EN_VIGUEUR', effectiveFrom: at.slice(0, 10), createdAt: at, createdBy: 'systeme',
      });
    }
  }

  current(service?: DependentService): ServiceDependency[] {
    return this.dependencies.find((x) => x.status === 'EN_VIGUEUR' && (!service || x.service === service));
  }

  /** Catalogue public (visible du citoyen) : dépendances en vigueur et historique des versions. */
  publicCatalogue() {
    return DEPENDENT_SERVICES.map((s) => ({
      service: s, label: SERVICE_LABELS[s],
      conditions: this.current(s).map((x) => ({ code: x.code, version: x.version, condition: x.condition, label: CONDITION_LABELS[x.condition], citizenText: x.citizenText, mode: x.mode, legal: x.legal, effectiveFrom: x.effectiveFrom, conditionEntity: x.conditionEntity, serviceEntity: x.serviceEntity })),
      history: this.dependencies.find((x) => x.service === s).sort((a, b) => a.code.localeCompare(b.code) || a.version - b.version).map((x) => ({ code: x.code, version: x.version, mode: x.mode, status: x.status, effectiveFrom: x.effectiveFrom })),
    }));
  }

  private vignetteFor(plate: string | undefined): { ok: boolean; detail: string } {
    if (!plate) return { ok: false, detail: 'Plaque non renseignée : vignette non vérifiable.' };
    const titres = this.d.ctx.ext['titres'] as { types: { all(): { code: string; prefix: string }[] }; credentials: { find(p: (c: { typeCode: string; subject: { plate?: string } }) => boolean): unknown[] }; status(c: unknown): { status: string } } | undefined;
    if (!titres) return { ok: false, detail: 'Module des titres absent : vignette non vérifiable.' };
    const vigTypes = new Set(titres.types.all().filter((t) => t.prefix === 'VIG').map((t) => t.code));
    if (!vigTypes.size) return { ok: false, detail: 'Aucun type de titre « vignette » au catalogue (acte requis).' };
    const norm = (p: string) => p.toUpperCase().replace(/[^0-9A-Z]/g, '');
    const creds = titres.credentials.find((c) => vigTypes.has(c.typeCode) && !!c.subject.plate && norm(c.subject.plate) === norm(plate));
    const valid = creds.some((c) => ['VALIDE', 'BIENTOT_EXPIRE', 'CRITIQUE'].includes(titres.status(c).status));
    return { ok: valid, detail: valid ? 'Vignette valide pour cette plaque.' : 'Aucune vignette valide pour cette plaque.' };
  }

  private evaluateOne(x: ServiceDependency, taxpayerId: string, ctx: { plate?: string }): ConditionResult {
    let satisfied: boolean;
    let detail: string;
    if (x.condition === 'QUITUS_VALIDE') {
      const c = this.clearances.active(taxpayerId);
      const st = c ? this.clearances.statusOf(c) : null;
      satisfied = st === 'VALIDE' || st === 'BIENTOT_EXPIRE';
      detail = satisfied ? `Quitus ${c!.number} valide jusqu’au ${c!.validUntil}.` : 'Aucun quitus fiscal valide : demandez-le depuis votre espace.';
    } else {
      const v = this.vignetteFor(ctx.plate);
      satisfied = v.ok;
      detail = v.detail;
    }
    return { dependencyId: x.id, code: x.code, version: x.version, condition: x.condition, label: CONDITION_LABELS[x.condition], citizenText: x.citizenText, mode: x.mode, satisfied, detail, legal: x.legal };
  }

  /** Évaluation serveur des conditions d'un service pour un contribuable. `blocked` seulement pour une règle BLOQUANTE non satisfaite. */
  evaluate(service: DependentService, taxpayerId: string, ctx: { plate?: string } = {}) {
    this.d.ctx.taxpayers.get(taxpayerId);
    const conditions = this.current(service).map((x) => this.evaluateOne(x, taxpayerId, ctx));
    const blocked = conditions.some((c) => c.mode === 'BLOQUANT' && !c.satisfied);
    return {
      service, serviceLabel: SERVICE_LABELS[service], taxpayerId, blocked, conditions, checkedAt: this.d.nowIso(),
      notice: blocked
        ? 'Démarche bloquée : une condition obligatoire (acte publié) n’est pas remplie.'
        : conditions.some((c) => !c.satisfied) ? 'Condition(s) non remplie(s), à titre INFORMATIF : l’acte n’étant pas publié, la démarche n’est pas bloquée.' : 'Conditions remplies.',
    };
  }

  /** Vérification demandée par un service (ou par le citoyen pour lui-même), journalisée. */
  check(user: User, service: DependentService, taxpayerId: string, ctx: { plate?: string } = {}) {
    authorize(user, 'fiscal:dependency.check', { taxpayerId });
    const r = this.evaluate(service, taxpayerId, ctx);
    this.checks.append({ id: this.ids.next('CHK-DEP', 8), at: r.checkedAt, service, taxpayerId, blocked: r.blocked, actorId: user.id });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'fiscal.dependency.checked', resourceType: 'taxpayer', resourceId: taxpayerId, details: { service, blocked: r.blocked, unmet: r.conditions.filter((c) => !c.satisfied).map((c) => c.code) } });
    return r;
  }

  /** Garde à appeler par un service dépendant : lève 422 si une condition BLOQUANTE n'est pas satisfaite. */
  assertSatisfied(service: DependentService, taxpayerId: string, ctx: { plate?: string } = {}): void {
    const r = this.evaluate(service, taxpayerId, ctx);
    if (r.blocked) throw unprocessable('DEPENDANCE_NON_SATISFAITE', `${SERVICE_LABELS[service]} : ${r.conditions.filter((c) => c.mode === 'BLOQUANT' && !c.satisfied).map((c) => c.label).join(', ')} requis.`, { conditions: r.conditions });
  }

  /** Conditions ajoutées à une démarche de verticale (informatives ⇒ `met` vrai, libellé explicite). */
  conditionsForProcedure(vertical: string, type: string, taxpayerId: string, plate?: string): { code: string; label: string; met: boolean }[] {
    const service = PROCEDURE_SERVICES[`${vertical}:${type}`];
    if (!service) return [];
    return this.evaluate(service, taxpayerId, plate ? { plate } : {}).conditions.map((c) => ({
      code: `DEPENDANCE_${c.condition}`,
      label: c.mode === 'BLOQUANT' ? `${c.label} (condition obligatoire ${c.code} v${c.version}) — ${c.detail}` : `${c.label} — à titre informatif, non bloquant tant que l’acte ${c.legal.jPoint} n’est pas publié — ${c.detail}`,
      met: c.mode === 'INFORMATIF' || c.satisfied,
    }));
  }

  // ——— Activation (acte + quatre yeux) ———

  proposeChange(user: User, code: string, input: { targetMode: 'INFORMATIF' | 'BLOQUANT'; instrumentId: string; article?: string; reason: string }): ServiceDependency {
    authorize(user, 'fiscal:dependency.propose');
    const x = this.current().find((d) => d.code === code);
    if (!x) throw notFound('DEPENDENCY_NOT_FOUND', `Dépendance inconnue : ${code}`);
    if (x.mode === input.targetMode) throw conflict('DEPENDENCY_ALREADY_IN_MODE', `La dépendance est déjà en mode ${x.mode}.`);
    const inst = this.d.ctx.rules.instruments.get(input.instrumentId);
    if (input.targetMode === 'BLOQUANT' && (!inst || !['EN_VIGUEUR', 'MODIFIE'].includes(inst.status))) {
      throw unprocessable('ACTE_REQUIS', `Activation impossible : l’acte ${x.legal.jPoint} doit être certifié en vigueur au registre (${input.instrumentId} : ${inst?.status ?? 'inconnu'}).`);
    }
    if (x.pendingChange) throw conflict('CHANGE_PENDING', 'Une proposition est déjà en attente sur cette dépendance.');
    const out = this.dependencies.update({ ...x, pendingChange: { targetMode: input.targetMode, instrumentId: input.instrumentId, ...(input.article ? { article: input.article } : {}), reason: input.reason, proposedBy: user.id, at: this.d.nowIso() } });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'fiscal.dependency.change_proposed', resourceType: 'service_dependency', resourceId: code, details: { targetMode: input.targetMode, instrumentId: input.instrumentId } });
    return out;
  }

  decideChange(user: User, code: string, input: { approve: boolean; reason: string }): ServiceDependency {
    authorize(user, 'fiscal:dependency.approve');
    const x = this.current().find((d) => d.code === code);
    if (!x?.pendingChange) throw notFound('NO_PENDING_CHANGE', 'Aucune proposition en attente.');
    const p = x.pendingChange;
    assertDistinctPerson(user.id, [p.proposedBy], 'L’activation d’une dépendance est approuvée par une personne distincte de celle qui l’a proposée.');
    const { pendingChange: _p, ...rest } = x;
    if (!input.approve) {
      this.dependencies.update(rest);
      this.d.ctx.audit.append({ actor: actorOf(user), action: 'fiscal.dependency.change_rejected', resourceType: 'service_dependency', resourceId: code, details: { proposedBy: p.proposedBy, reason: input.reason } });
      return this.dependencies.get(x.id)!;
    }
    const inst = this.d.ctx.rules.instruments.get(p.instrumentId);
    if (p.targetMode === 'BLOQUANT' && (!inst || !['EN_VIGUEUR', 'MODIFIE'].includes(inst.status))) throw unprocessable('ACTE_REQUIS', 'L’acte n’est plus certifié en vigueur au registre.');
    const at = this.d.nowIso();
    const next: ServiceDependency = {
      ...rest, id: `${x.code}-v${x.version + 1}`, version: x.version + 1, mode: p.targetMode, status: 'EN_VIGUEUR', effectiveFrom: at.slice(0, 10), createdAt: at, createdBy: user.id, supersedes: x.id,
      legal: { ...x.legal, instrumentId: p.instrumentId, ...(p.article ? { article: p.article } : {}) },
      citizenText: p.targetMode === 'BLOQUANT'
        ? `${SERVICE_LABELS[x.service]} : ${CONDITION_LABELS[x.condition].toLowerCase()} obligatoire (acte ${inst?.title ?? p.instrumentId}${p.article ? `, ${p.article}` : ''}). Votre démarche ne peut aboutir sans cette condition.`
        : x.citizenText,
      activation: { proposedBy: p.proposedBy, approvedBy: user.id, instrumentId: p.instrumentId, ...(p.article ? { article: p.article } : {}), at },
    };
    this.dependencies.update({ ...rest, status: 'REMPLACEE', supersededBy: next.id });
    const out = this.dependencies.insert(next);
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'fiscal.dependency.activated', resourceType: 'service_dependency', resourceId: code, details: { proposedBy: p.proposedBy, mode: p.targetMode, version: next.version, instrumentId: p.instrumentId } });
    return out;
  }

  /** Vue agent (propositions en attente comprises). */
  agentView(user: User) {
    if (!evaluate(user, 'fiscal:dependency.propose') && !evaluate(user, 'fiscal:dependency.approve')) authorize(user, 'fiscal:dependency.check');
    return this.dependencies.all().sort((a, b) => a.code.localeCompare(b.code) || a.version - b.version);
  }
}
