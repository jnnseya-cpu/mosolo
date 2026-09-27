/**
 * Départements, modules et types de comptes (27/09/2026, demande du maître d'ouvrage : « tous les types de comptes
 * sont créés ; l'administrateur rattache modules et variables aux départements ») — AJOUTÉ au module « acces » sans en
 * retirer aucun contrôle :
 *
 *  - RÉFÉRENTIEL DES TYPES DE COMPTES : pour chacun des 37 rôles, famille, parcours de création réel, qui peut inviter,
 *    seconde validation, niveau de MFA, natures d'entité (indicatives), décompte vivant des comptes par état ;
 *  - CONTRATS DE PARTENARIAT (R32 à R34) : enregistrés par une personne, approuvés par une personne DISTINCTE ; seule
 *    voie d'invitation d'un rôle partenaire ;
 *  - MODULES FONCTIONNELS RATTACHÉS AUX ENTITÉS : catalogue à codes stables (catalogue-modules.ts) ; rattachement ou
 *    détachement motivé, daté, historisé ; modules porteurs de recettes : circuit EXISTANT des fiches de module
 *    (création de fiche, visas, activation, réattribution approuvée par une personne distincte), jamais contourné ;
 *  - EFFET SUR LE MENU (présentation seulement) : un module rattaché à au moins une entité n'apparaît plus qu'aux
 *    personnes de ces entités (sous-arbre et entités de tutelle), filtré par rôle comme aujourd'hui ; le serveur
 *    continue d'appliquer les droits (ABAC) sur chaque route.
 *
 * L'IA n'intervient dans aucune de ces actions ; aucune sanction automatique.
 */
import { FAMILLE_DU_ROLE, FAMILLES_COMPTES, NATURES_ENTITE_DU_ROLE, PARCOURS_CREATION, PARCOURS_DU_ROLE, ROLES, ROLES_CONTRAT_PARTENAIRE, type RoleCode } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { kinshasaDate } from '../../core/clock.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { catalogueModule, MODULE_CATALOGUE, versionsOf, type CatalogueModule } from './catalogue-modules.js';
import {
  ENTITY_KIND_LABELS, FIELD_ROLES, LEVEL_INFO, LEVEL_RANK, ROLE_LEVEL, SECOND_VALIDATION_ROLES, SENSITIVE_ROLES,
  type AccessLevel, type ModuleConfig, type ModuleLink, type PartnerContract,
} from './model.js';
import { ACCES } from './policy.js';
import type { AccesService } from './service.js';

const ALL_ROLES = Object.keys(ROLES) as RoleCode[];
const PUBLIC_ROLES: RoleCode[] = ['R30', 'R31'];
const SPECIAL_LEVELS: AccessLevel[] = ['AUDIT', 'ADMIN_TECHNIQUE'];
/** Rôles transverses (audit, exploitation, sécurité) : menu jamais restreint par les rattachements d'entités. */
const MENU_EXEMPT: RoleCode[] = ['R22', 'R23', 'R26', 'R27', 'R28'];
const REQUIREMENT_LABELS: Record<string, string> = {
  HORS_BANDE_CABINET: 'Confirmation hors bande par le Cabinet ou le Secrétariat général',
  AUTORITE_AUDIT: 'Validation par l’autorité d’audit',
  SECURITE: 'Seconde validation (responsable sécurité ou direction de l’entité), personne distincte de l’invitant',
  HABILITATION_REGIE: 'Habilitation par la régie sur formation certifiée',
  CONTRAT: 'Contrat de partenariat approuvé par une personne distincte, avant toute invitation',
  ACCREDITATION: 'Accréditation du sous-traitant approuvée par une personne distincte de la régie',
};
const isoDay = /^\d{4}-\d{2}-\d{2}$/;

export class DepartementsService {
  readonly links = new InMemoryRepository<ModuleLink>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly svc: AccesService) {}

  private now(): string { return this.ctx.clock.now().toISOString(); }
  private today(): string { return kinshasaDate(this.ctx.clock.now()); }

  private audit(user: User, action: string, resourceType: string, resourceId: string, details: Record<string, unknown>, outcome?: 'DENIED') {
    this.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: `acces.${action}`, resourceType, resourceId, details, ...(outcome ? { outcome } : {}) });
  }

  private isPlatformAdmin(user: User): boolean { return user.roles.includes('R26'); }

  /** Ascendants d'une entité (elle comprise). */
  ancestors(id: string): string[] {
    const out: string[] = [];
    let cur: string | null | undefined = id;
    let guard = 0;
    while (cur && guard++ < 20) {
      out.push(cur);
      cur = this.svc.entities.get(cur)?.parentId;
    }
    return out;
  }

  /** Périmètre d'administration : tout pour R26 (et la supervision en lecture) ; sous-arbre de son entité pour R08. */
  private assertManages(user: User, entity: string, write: boolean): void {
    this.svc.entity(entity);
    if (this.isPlatformAdmin(user)) return;
    if (!write && user.roles.some((r) => ['R22', 'R23', 'R28'].includes(r))) return;
    if (user.roles.includes('R08') && this.svc.subtree(user.entity).has(entity)) return;
    this.audit(user, 'departement.refused', 'entity', entity, { entity, reason: 'OUT_OF_PERIMETER' }, 'DENIED');
    throw forbidden('OUT_OF_PERIMETER', 'Hors de votre périmètre : un administrateur d’entité n’agit que dans son entité et ses sous-entités.');
  }

  // ═════════════════════════════ Types de comptes ═════════════════════════════

  private inviters(role: RoleCode): RoleCode[] {
    if (PUBLIC_ROLES.includes(role)) return [];
    const lt = ROLE_LEVEL[role]!;
    const out = new Set<RoleCode>(['R26']);
    if (SPECIAL_LEVELS.includes(lt)) return [...out];
    for (const r of ALL_ROLES) {
      const lx = ROLE_LEVEL[r];
      if (!lx || SPECIAL_LEVELS.includes(lx) || LEVEL_RANK[lx] < LEVEL_RANK.SUPERVISEUR || LEVEL_RANK[lt] > LEVEL_RANK[lx]) continue;
      if (lx === 'SUPERVISEUR' && lt !== 'AGENT_TERRAIN') continue;
      if (lx === 'RESPONSABLE_MODULE' && !['SUPERVISEUR', 'AGENT_TERRAIN', 'OPERATEUR', 'CONSULTATION'].includes(lt)) continue;
      out.add(r);
    }
    return [...out].sort();
  }

  private requirement(role: RoleCode): string | null {
    if (role === 'R01') return 'HORS_BANDE_CABINET';
    if (ROLE_LEVEL[role] === 'AUDIT') return 'AUTORITE_AUDIT';
    if (SENSITIVE_ROLES.includes(role) || SECOND_VALIDATION_ROLES.includes(role)) return 'SECURITE';
    if (role === 'R35') return 'ACCREDITATION';
    if (FIELD_ROLES.includes(role)) return 'HABILITATION_REGIE';
    if (ROLES_CONTRAT_PARTENAIRE.includes(role)) return 'CONTRAT';
    return null;
  }

  private mfaLabel(role: RoleCode): { code: string; label: string } {
    if (PUBLIC_ROLES.includes(role)) return { code: 'OTP_SMS', label: 'Code à usage unique par SMS (compte public)' };
    if (SENSITIVE_ROLES.includes(role)) return { code: 'CLE_ACCES', label: 'Clé d’accès résistante à l’hameçonnage (FIDO2), exigée' };
    return { code: 'TOTP_OU_SMS', label: 'Second facteur (application TOTP, ou SMS), exigé à chaque session de travail' };
  }

  /** Comptes visibles par la personne (périmètre de l'administration des accès) — états par rôle. */
  private accountRows(user: User): { role: RoleCode; status: string; entity: string }[] {
    const rows: { role: RoleCode; status: string; entity: string }[] = [];
    for (const a of this.svc.listAccounts(user)) for (const r of a.roles as RoleCode[]) rows.push({ role: r, status: a.status, entity: a.entity });
    const scope = this.svc.visibleScope(user);
    if (!scope) {
      for (const r of PUBLIC_ROLES) for (const u of this.ctx.users.withRole(r)) rows.push({ role: r, status: 'ACTIF', entity: u.entity });
    }
    return rows;
  }

  typesDeComptes(user: User) {
    authorize(user, ACCES.accountTypesRead);
    const rows = this.accountRows(user);
    const demo = this.ctx.demoData === true;
    const types = ALL_ROLES.map((role) => {
      const mine = rows.filter((x) => x.role === role);
      const byStatus: Record<string, number> = {};
      for (const x of mine) byStatus[x.status] = (byStatus[x.status] ?? 0) + 1;
      const req = this.requirement(role);
      const level = ROLE_LEVEL[role];
      const exemples = demo ? this.ctx.users.withRole(role).slice(0, 3).map((u) => ({ id: u.id, name: u.name, tag: '[EXEMPLE]' })) : [];
      return {
        code: role, label: ROLES[role], family: FAMILLE_DU_ROLE[role], familyLabel: FAMILLES_COMPTES[FAMILLE_DU_ROLE[role]],
        creationPath: PARCOURS_DU_ROLE[role], creationPathLabel: PARCOURS_CREATION[PARCOURS_DU_ROLE[role]],
        invitableBy: this.inviters(role).map((r) => ({ code: r, label: ROLES[r] })),
        inviteNote: PUBLIC_ROLES.includes(role) ? 'Jamais par invitation : inscription publique.'
          : role === 'R35' ? 'Invitation du sous-traitant par la régie (R06, R07), accréditation à deux personnes ; invitation directe possible au niveau « agent de terrain ».'
            : ROLES_CONTRAT_PARTENAIRE.includes(role) ? 'Invitation dans l’entité partenaire seulement sous contrat de partenariat actif.'
              : 'Droit d’inviter explicite ; pas d’élévation au-delà du niveau de l’invitant ; R26 sans pouvoir fiscal.',
        level, levelLabel: level ? LEVEL_INFO[level].label : 'Compte public',
        sensitive: SENSITIVE_ROLES.includes(role),
        secondValidation: req ? { code: req, label: REQUIREMENT_LABELS[req]! } : null,
        mfa: this.mfaLabel(role),
        entityKinds: NATURES_ENTITE_DU_ROLE[role].map((k) => ({ code: k, label: k === 'PUBLIC' ? 'Compte public (hors entité)' : ENTITY_KIND_LABELS[k as keyof typeof ENTITY_KIND_LABELS] ?? k })),
        entityKindsStatus: 'Indicatif — par défaut, à confirmer par le maître d’ouvrage',
        count: mine.length, byStatus, exemples,
      };
    });
    return {
      types,
      families: Object.entries(FAMILLES_COMPTES).map(([code, label]) => ({ code, label, count: types.filter((t) => t.family === code).reduce((n, t) => n + t.count, 0) })),
      total: rows.length,
      scope: this.svc.visibleScope(user) ? 'SOUS_ARBRE' : 'TOUT',
      note: 'Décomptes vivants (comptes de travail et comptes publics) dans votre périmètre ; un compte peut porter plusieurs rôles.',
    };
  }

  // ═════════════════════════════ Contrats de partenariat (R32 à R34) ═════════════════════════════

  listContracts(user: User) {
    authorize(user, ACCES.partnerContractRead);
    const scope = this.svc.visibleScope(user);
    return this.svc.partnerContracts.all().filter((c) => !scope || scope.has(c.entity)).reverse();
  }

  proposeContract(user: User, input: { entity: string; reference: string; roles: RoleCode[]; object: string; validFrom?: string; validTo?: string }) {
    authorize(user, ACCES.partnerContractPropose);
    this.svc.requireMfa(user);
    const ent = this.svc.entity(input.entity);
    if (ent.status !== 'ACTIVE') throw unprocessable('ENTITY_SUSPENDED', 'Entité suspendue.');
    const roles = [...new Set(input.roles)];
    if (!roles.length || roles.some((r) => !ROLES_CONTRAT_PARTENAIRE.includes(r))) throw badRequest('ROLES_INVALID', 'Un contrat de partenariat couvre les rôles R32, R33 ou R34 uniquement.');
    const validFrom = input.validFrom ?? this.today();
    if (input.validTo && input.validTo <= validFrom) throw unprocessable('BAD_PERIOD', 'La fin du contrat suit son début.');
    if (this.svc.partnerContracts.findOne((c) => c.entity === input.entity && c.status === 'PROPOSE')) throw conflict('CONTRACT_PENDING', 'Un contrat attend déjà sa seconde validation pour cette entité.');
    const c: PartnerContract = this.svc.partnerContracts.insert({
      id: this.ids.next('CTP', 4), entity: input.entity, reference: input.reference.trim(), roles, object: input.object.trim(), validFrom,
      ...(input.validTo ? { validTo: input.validTo } : {}), status: 'PROPOSE', proposedBy: user.id, proposedAt: this.now(),
      history: [{ at: this.now(), by: user.id, action: 'PROPOSE' }],
    });
    this.audit(user, 'partner_contract.proposed', 'partner_contract', c.id, { entity: c.entity, reference: c.reference, roles });
    return c;
  }

  decideContract(user: User, id: string, input: { approve: boolean; note: string }) {
    authorize(user, ACCES.partnerContractApprove);
    const c = this.svc.partnerContracts.get(id);
    if (!c) throw notFound('CONTRACT_NOT_FOUND', `Contrat inconnu : ${id}`);
    if (c.status !== 'PROPOSE') throw conflict('CONTRACT_DECIDED', `Contrat au statut ${c.status}.`);
    assertDistinctPerson(user.id, [c.proposedBy], 'Le contrat de partenariat est approuvé par une personne distincte de celle qui l’a enregistré.');
    this.svc.requireMfa(user);
    const at = this.now();
    const out = this.svc.partnerContracts.update({
      ...c, status: input.approve ? 'ACTIF' : 'REJETE', decidedBy: user.id, decidedAt: at, decisionNote: input.note,
      history: [...c.history, { at, by: user.id, action: input.approve ? 'APPROUVE' : 'REJETE', note: input.note }],
    });
    this.audit(user, input.approve ? 'partner_contract.approved' : 'partner_contract.rejected', 'partner_contract', id, { entity: c.entity, proposedBy: c.proposedBy });
    return out;
  }

  // ═════════════════════════════ Catalogue et rattachements ═════════════════════════════

  private fichesFor(m: CatalogueModule): ModuleConfig[] {
    return m.revenueScope ? this.svc.modules.find((x) => x.revenueScope === m.revenueScope && x.status !== 'RETIRE') : [];
  }

  private effective(l: ModuleLink, day = this.today()): boolean {
    return l.status === 'ACTIF' && l.from <= day && (!l.to || l.to > day);
  }

  /** Rattachements en vigueur : liens directs (modules sans recette) + fiches de module ACTIVES (modules porteurs). */
  effectiveAttachments(): { moduleCode: string; entity: string; source: 'LIEN' | 'FICHE'; linkId?: string; moduleConfigId?: string; sharedRead?: boolean }[] {
    const out: { moduleCode: string; entity: string; source: 'LIEN' | 'FICHE'; linkId?: string; moduleConfigId?: string; sharedRead?: boolean }[] = [];
    const day = this.today();
    for (const l of this.links.all()) if (!l.revenue && this.effective(l, day)) out.push({ moduleCode: l.moduleCode, entity: l.entity, source: 'LIEN', linkId: l.id });
    for (const m of MODULE_CATALOGUE) {
      if (!m.revenue) continue;
      for (const f of this.fichesFor(m).filter((x) => x.status === 'ACTIF')) {
        out.push({ moduleCode: m.code, entity: f.responsibleEntity, source: 'FICHE', moduleConfigId: f.id });
        for (const e of f.sharedReadWith) if (this.svc.entities.get(e)) out.push({ moduleCode: m.code, entity: e, source: 'FICHE', moduleConfigId: f.id, sharedRead: true });
      }
    }
    return out;
  }

  catalogue(user: User) {
    authorize(user, ACCES.departementsRead);
    const att = this.effectiveAttachments();
    const scope = this.svc.visibleScope(user);
    return MODULE_CATALOGUE.map((m) => ({
      ...m, versions: versionsOf(m),
      fiches: this.fichesFor(m).map((f) => ({ id: f.id, code: f.code, label: f.label, status: f.status, responsibleEntity: f.responsibleEntity })),
      attachedTo: [...new Set(att.filter((a) => a.moduleCode === m.code && (!scope || scope.has(a.entity))).map((a) => a.entity))],
      rule: m.revenue ? 'Porteur de recettes : circuit des fiches de module (acte, visas, seconde validation par une personne distincte).' : m.linkable ? 'Sans recette : rattachement par une personne habilitée, motivé, daté, journalisé.' : 'Administration transverse : non rattachable.',
    }));
  }

  /** Rattachement d'un module fonctionnel à une entité (R26 partout ; R08 dans son sous-arbre). */
  attach(user: User, input: { moduleCode: string; entity: string; motif: string; from?: string; to?: string; actReference?: string; beneficiaryAliases?: string[] }) {
    authorize(user, ACCES.departementsLink);
    const m = catalogueModule(input.moduleCode);
    if (!m) throw notFound('MODULE_UNKNOWN', `Module inconnu du catalogue : ${input.moduleCode}`);
    if (!m.linkable) throw unprocessable('MODULE_NOT_LINKABLE', `${m.code} (${m.label}) est un module d’administration transverse : il n’est jamais restreint à une entité.`);
    this.assertManages(user, input.entity, true);
    const ent = this.svc.entity(input.entity);
    if (ent.status !== 'ACTIVE') throw unprocessable('ENTITY_SUSPENDED', 'Entité suspendue : aucun rattachement.');
    const from = input.from ?? this.today();
    if (!isoDay.test(from) || (input.to && (!isoDay.test(input.to) || input.to <= from))) throw badRequest('BAD_PERIOD', 'Dates AAAA-MM-JJ ; la date de fin suit la date d’effet.');
    this.svc.requireMfa(user);
    if (m.revenue) return this.attachRevenue(user, m, { ...input, from });
    const open = this.links.findOne((l) => l.moduleCode === m.code && l.entity === input.entity && l.status === 'ACTIF' && (!l.to || l.to > this.today()));
    if (open) throw conflict('ALREADY_ATTACHED', `${m.code} est déjà rattaché à ${input.entity} (lien ${open.id}).`);
    const at = this.now();
    const link = this.links.insert({
      id: this.ids.next('LNK', 5), moduleCode: m.code, entity: input.entity, revenue: false, action: 'RATTACHEMENT', status: 'ACTIF', from,
      ...(input.to ? { to: input.to } : {}), motif: input.motif, ...(input.actReference ? { actReference: input.actReference } : {}), circuit: 'DIRECT',
      createdBy: user.id, createdAt: at, history: [{ at, by: user.id, action: 'RATTACHE', note: input.motif }],
    });
    this.audit(user, 'departement.module_attached', 'module_link', link.id, { entity: input.entity, moduleCode: m.code, from, to: input.to ?? null, motif: input.motif });
    return { link, effect: from <= this.today() ? 'EN_VIGUEUR' : 'PROGRAMME' };
  }

  /** Module porteur de recettes : délégation au circuit EXISTANT des fiches de module (aucun doublon de circuit). */
  private attachRevenue(user: User, m: CatalogueModule, input: { moduleCode: string; entity: string; motif: string; from: string; to?: string; actReference?: string; beneficiaryAliases?: string[] }) {
    if (!input.actReference?.trim()) throw badRequest('ACT_REFERENCE_REQUIRED', 'Module porteur de recettes : la référence de l’acte (arrêté, décision) est obligatoire.');
    const fiches = this.fichesFor(m);
    const active = fiches.find((f) => f.status === 'ACTIF');
    const at = this.now();
    const base = {
      id: this.ids.next('LNK', 5), moduleCode: m.code, entity: input.entity, revenue: true, action: 'RATTACHEMENT' as const, status: 'EN_ATTENTE' as const,
      from: input.from, ...(input.to ? { to: input.to } : {}), motif: input.motif, actReference: input.actReference, createdBy: user.id, createdAt: at,
    };
    if (active) {
      if (active.responsibleEntity === input.entity) throw conflict('ALREADY_ATTACHED', `La compétence ${m.revenueScope} est déjà rattachée à ${input.entity} (fiche ${active.code}).`);
      // Réattribution : proposition (R26 seul, circuit existant), décision par le Gouverneur ou le Cabinet, personne distincte.
      authorize(user, ACCES.moduleReattachPropose);
      this.svc.proposeReattachment(user, active.id, {
        newEntity: input.entity, beneficiaryAliases: input.beneficiaryAliases?.length ? input.beneficiaryAliases : active.beneficiaryAliases, actReference: input.actReference!, motif: input.motif,
      });
      const link = this.links.insert({ ...base, moduleConfigId: active.id, circuit: 'REATTRIBUTION', history: [{ at, by: user.id, action: 'REATTRIBUTION_PROPOSEE', note: `Fiche ${active.code} — décision : POST /v1/acces/modules/${active.id}/reattachments/decision` }] });
      this.audit(user, 'departement.module_attach_requested', 'module_link', link.id, { entity: input.entity, moduleCode: m.code, circuit: 'REATTRIBUTION', moduleConfigId: active.id, actReference: input.actReference });
      return { link, effect: 'SECONDE_VALIDATION_REQUISE', circuit: 'REATTRIBUTION', moduleConfigId: active.id };
    }
    if (fiches.length) throw conflict('MODULE_CIRCUIT_EN_COURS', `Une fiche du domaine ${m.revenueScope} est déjà en cours de circuit (${fiches.map((f) => `${f.code} : ${f.status}`).join(', ')}).`);
    authorize(user, ACCES.moduleDraft, { entity: input.entity });
    const code = `${m.code}-${input.entity}`.toUpperCase().replace(/[^A-Z0-9-]/g, '-').slice(0, 40);
    const r = this.svc.createModule(user, {
      code, label: `${m.label} — ${this.svc.entity(input.entity).shortName}`, revenueScope: m.revenueScope!, responsibleEntity: input.entity,
      beneficiaryAliases: input.beneficiaryAliases ?? [], objectTypes: [], ruleCodes: [], credentialTypes: [], validityModel: 'SANS_TITRE', proofMechanisms: [],
      usageRules: '', channels: [], fieldWorkflows: [], dashboards: [], dependencies: [], sharedReadWith: [], actReferences: [input.actReference!],
    });
    const link = this.links.insert({ ...base, moduleConfigId: r.module.id, circuit: 'FICHE', history: [{ at, by: user.id, action: 'FICHE_CREEE', note: `Fiche ${r.module.code} en brouillon : visas programme et juridique, recette, activation par le comité (personne distincte).` }] });
    this.audit(user, 'departement.module_attach_requested', 'module_link', link.id, { entity: input.entity, moduleCode: m.code, circuit: 'FICHE', moduleConfigId: r.module.id, actReference: input.actReference });
    return { link, effect: r.blocked ? 'BLOQUE_ARBITRAGE' : 'CIRCUIT_DE_LA_FICHE', circuit: 'FICHE', moduleConfigId: r.module.id };
  }

  /** Détachement : immédiat et journalisé (sans recette) ; retrait proposé puis décidé par une autre personne (recettes). */
  detach(user: User, input: { moduleCode: string; entity: string; motif: string; to?: string }) {
    authorize(user, ACCES.departementsLink);
    const m = catalogueModule(input.moduleCode);
    if (!m) throw notFound('MODULE_UNKNOWN', `Module inconnu du catalogue : ${input.moduleCode}`);
    this.assertManages(user, input.entity, true);
    const to = input.to ?? this.today();
    if (!isoDay.test(to)) throw badRequest('BAD_PERIOD', 'Date AAAA-MM-JJ attendue.');
    this.svc.requireMfa(user);
    const at = this.now();
    if (m.revenue) {
      const f = this.fichesFor(m).find((x) => x.status === 'ACTIF' && x.responsibleEntity === input.entity);
      if (!f) throw conflict('NOT_ATTACHED', `Aucune fiche active du domaine ${m.revenueScope} n’est rattachée à ${input.entity}.`);
      if (this.links.findOne((l) => l.moduleConfigId === f.id && l.circuit === 'RETRAIT' && l.status === 'EN_ATTENTE')) throw conflict('WITHDRAWAL_PENDING', 'Un retrait attend déjà sa décision.');
      const link = this.links.insert({
        id: this.ids.next('LNK', 5), moduleCode: m.code, entity: input.entity, revenue: true, action: 'DETACHEMENT', status: 'EN_ATTENTE', from: to, motif: input.motif,
        moduleConfigId: f.id, circuit: 'RETRAIT', createdBy: user.id, createdAt: at, history: [{ at, by: user.id, action: 'RETRAIT_PROPOSE', note: input.motif }],
      });
      this.audit(user, 'departement.module_detach_requested', 'module_link', link.id, { entity: input.entity, moduleCode: m.code, moduleConfigId: f.id });
      return { link, effect: 'SECONDE_VALIDATION_REQUISE' };
    }
    const open = this.links.findOne((l) => l.moduleCode === m.code && l.entity === input.entity && l.status === 'ACTIF' && (!l.to || l.to > this.today()));
    if (!open) throw conflict('NOT_ATTACHED', `${m.code} n’est pas rattaché directement à ${input.entity} (un rattachement hérité se détache à l’entité qui le porte).`);
    const link = this.links.update({ ...open, status: to <= this.today() ? 'DETACHE' : 'ACTIF', to, history: [...open.history, { at, by: user.id, action: 'DETACHE', note: input.motif }] });
    this.audit(user, 'departement.module_detached', 'module_link', open.id, { entity: input.entity, moduleCode: m.code, to, motif: input.motif });
    return { link, effect: to <= this.today() ? 'EN_VIGUEUR' : 'PROGRAMME' };
  }

  /** Décision sur un retrait de module porteur de recettes : personne distincte, habilitée à changer l'état d'une fiche. */
  decide(user: User, id: string, input: { approve: boolean; note: string }) {
    authorize(user, ACCES.moduleActivate);
    const l = this.links.get(id);
    if (!l) throw notFound('LINK_NOT_FOUND', `Lien inconnu : ${id}`);
    if (l.circuit !== 'RETRAIT' || l.status !== 'EN_ATTENTE') throw conflict('LINK_NOT_PENDING', 'Seul un retrait de module porteur de recettes en attente se décide ici (réattribution : circuit des fiches).');
    assertDistinctPerson(user.id, [l.createdBy], 'Le retrait d’un module porteur de recettes est décidé par une personne distincte de celle qui l’a proposé.');
    this.svc.requireMfa(user);
    const at = this.now();
    if (input.approve) this.svc.changeModuleStatus(user, l.moduleConfigId!, { to: 'RETIRE', motif: `Retrait décidé (lien ${l.id}) : ${input.note}` });
    const out = this.links.update({ ...l, status: input.approve ? 'DETACHE' : 'REFUSE', decidedBy: user.id, decidedAt: at, history: [...l.history, { at, by: user.id, action: input.approve ? 'RETRAIT_APPROUVE' : 'RETRAIT_REFUSE', note: input.note }] });
    this.audit(user, input.approve ? 'departement.module_detached' : 'departement.module_detach_refused', 'module_link', id, { entity: l.entity, moduleCode: l.moduleCode, moduleConfigId: l.moduleConfigId });
    return out;
  }

  /** Synchronise l'état des demandes portées par le circuit des fiches (réattribution, fiche) — lecture seule du circuit. */
  private linkView(l: ModuleLink) {
    let status = l.status;
    if (l.revenue && l.status === 'EN_ATTENTE' && l.moduleConfigId && l.circuit !== 'RETRAIT') {
      const f = this.svc.modules.get(l.moduleConfigId);
      if (f?.status === 'ACTIF' && f.responsibleEntity === l.entity) status = 'ACTIF';
      else if (f && l.circuit === 'REATTRIBUTION' && !f.pendingReattachment && f.responsibleEntity !== l.entity) status = 'REFUSE';
      else if (f?.status === 'RETIRE') status = 'CLOS';
    }
    const m = catalogueModule(l.moduleCode);
    return { ...l, status, moduleLabel: m?.label ?? l.moduleCode, effectiveNow: !l.revenue ? this.effective(l) : status === 'ACTIF' };
  }

  history(user: User, filter: { entity?: string; moduleCode?: string }) {
    authorize(user, ACCES.departementsRead);
    if (filter.entity) this.assertManages(user, filter.entity, false);
    const scope = this.readScope(user);
    return this.links.all()
      .filter((l) => (!scope || scope.has(l.entity)) && (!filter.entity || l.entity === filter.entity) && (!filter.moduleCode || l.moduleCode === filter.moduleCode))
      .reverse().map((l) => this.linkView(l));
  }

  private readScope(user: User): Set<string> | null {
    if (this.isPlatformAdmin(user) || user.roles.some((r) => ['R22', 'R23', 'R28'].includes(r))) return null;
    return this.svc.subtree(user.entity);
  }

  // ═════════════════════════════ Menu (présentation) ═════════════════════════════

  /**
   * Écrans masqués pour une personne : ceux dont TOUS les modules sont rattachés à des entités hors de sa lignée
   * (entité, sous-entités, entités de tutelle). Aucun effet pour les comptes publics, les rôles transverses et les
   * personnes dont l'entité n'est pas un espace d'entité. Le serveur continue d'appliquer les droits sur chaque route.
   */
  menuFor(user: User) {
    const exempt = user.roles.length === 0 || user.roles.every((r) => PUBLIC_ROLES.includes(r) || ROLES_CONTRAT_PARTENAIRE.includes(r))
      || user.roles.some((r) => MENU_EXEMPT.includes(r)) || !this.svc.entities.get(user.entity);
    const att = this.effectiveAttachments();
    const governed = new Set(att.map((a) => a.moduleCode));
    const lineage = new Set([...this.ancestors(user.entity), ...(this.svc.entities.get(user.entity) ? this.svc.subtree(user.entity) : [])]);
    const reachable = new Set(att.filter((a) => lineage.has(a.entity)).map((a) => a.moduleCode));
    const byPath = new Map<string, CatalogueModule[]>();
    for (const m of MODULE_CATALOGUE) for (const p of m.screens) byPath.set(p, [...(byPath.get(p) ?? []), m]);
    const hidden = exempt ? [] : [...byPath].filter(([, ms]) => ms.every((m) => governed.has(m.code) && !reachable.has(m.code))).map(([p]) => p).sort();
    return {
      userId: user.id, entity: user.entity, exempt,
      attachedModules: MODULE_CATALOGUE.filter((m) => reachable.has(m.code)).map((m) => ({ code: m.code, label: m.label, screens: m.screens })),
      hiddenPaths: hidden,
      note: 'Présentation seulement : les droits restent appliqués par le serveur sur chaque route (ABAC).',
    };
  }

  // ═════════════════════════════ Vue par entité ═════════════════════════════

  tree(user: User) {
    authorize(user, ACCES.departementsRead);
    const scope = this.readScope(user);
    const att = this.effectiveAttachments();
    const accounts = this.svc.listAccounts(user);
    return this.svc.entities.all().filter((e) => !scope || scope.has(e.id)).map((e) => ({
      id: e.id, name: e.name, shortName: e.shortName, kind: e.kind, kindLabel: ENTITY_KIND_LABELS[e.kind], parentId: e.parentId, status: e.status, demo: !!e.demo,
      modules: [...new Set(att.filter((a) => a.entity === e.id).map((a) => a.moduleCode))].length,
      accounts: accounts.filter((a) => a.entity === e.id && a.status === 'ACTIF').length,
      pendingLinks: this.links.find((l) => l.entity === e.id && this.linkView(l).status === 'EN_ATTENTE').length,
    }));
  }

  entityView(user: User, entity: string) {
    authorize(user, ACCES.departementsRead);
    this.assertManages(user, entity, false);
    const e = this.svc.entity(entity);
    const lineage = this.ancestors(entity);
    const att = this.effectiveAttachments();
    const modules = MODULE_CATALOGUE.map((m) => {
      const own = att.filter((a) => a.moduleCode === m.code && a.entity === entity);
      const inherited = att.filter((a) => a.moduleCode === m.code && a.entity !== entity && lineage.includes(a.entity));
      return {
        code: m.code, label: m.label, kind: m.kind, revenue: m.revenue, revenueScope: m.revenueScope ?? null, linkable: m.linkable, screens: m.screens,
        attached: own.length > 0, inheritedFrom: inherited.map((a) => a.entity), source: own[0]?.source ?? inherited[0]?.source ?? null,
        sharedRead: own.some((a) => a.sharedRead),
        pending: this.links.find((l) => l.moduleCode === m.code && l.entity === entity).map((l) => this.linkView(l)).filter((l) => l.status === 'EN_ATTENTE').map((l) => ({ id: l.id, circuit: l.circuit, action: l.action })),
      };
    });
    const accounts = this.svc.listAccounts(user, entity);
    const byRole = new Map<string, Record<string, number>>();
    for (const a of accounts) for (const r of a.roles) { const s = byRole.get(r) ?? {}; s[a.status] = (s[a.status] ?? 0) + 1; byRole.set(r, s); }
    const gov = this.ctx.ext['integrite-gouvernance'] as { effectifs?: (u: User, entity: string) => unknown } | undefined;
    const variables = (() => { try { return gov?.effectifs ? gov.effectifs(user, entity) : null; } catch { return null; } })();
    return {
      entity: { id: e.id, name: e.name, shortName: e.shortName, kind: e.kind, kindLabel: ENTITY_KIND_LABELS[e.kind], parentId: e.parentId, status: e.status, lineage },
      modules,
      history: this.links.find((l) => l.entity === entity).reverse().map((l) => this.linkView(l)),
      accountsByType: [...byRole].map(([role, byStatus]) => ({
        role, label: ROLES[role as RoleCode], family: FAMILLE_DU_ROLE[role as RoleCode], familyLabel: FAMILLES_COMPTES[FAMILLE_DU_ROLE[role as RoleCode]],
        byStatus, total: Object.values(byStatus).reduce((a, b) => a + b, 0),
      })).sort((a, b) => a.role.localeCompare(b.role)),
      users: accounts.map((a) => ({ id: a.id, fullName: a.fullName, roles: a.roles, status: a.status })),
      contracts: this.svc.partnerContracts.find((c) => c.entity === entity),
      variables,
    };
  }
}
