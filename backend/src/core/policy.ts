/**
 * Point de décision des politiques (PDP) centralisé : RBAC + ABAC simple (entité, territoire, dossier propre)
 * + séparation des tâches + garde de l'IA (§ 12.1, § 12.4, § 23.1).
 * Toute route appelle `authorize` ; aucune décision d'accès n'est prise dans l'interface.
 */
import { AI_FORBIDDEN_ACTIONS, type RoleCode } from '@mosolo/shared';
import type { Principal, User } from './auth.js';
import { forbidden } from './errors.js';

export type Action =
  | 'taxpayer.read' | 'object.create' | 'lease.declare'
  | 'rule.read' | 'rule.create' | 'rule.approve'
  | 'assessment.simulate' | 'assessment.liquidate'
  | 'obligation.read' | 'obligation.modify'
  | 'payment.create' | 'payment.modify' | 'payment.evidence' | 'provider.read' | 'provider.simulate' | 'provider.readiness'
  | 'settlement.import' | 'reconciliation.read' | 'ledger.read' | 'ledger.reverse'
  | 'beneficiary.read' | 'beneficiary.propose' | 'beneficiary.approve'
  | 'audit.read' | 'audit.modify'
  | 'comms.read' | 'comms.test'
  | 'ai.insight' | 'ai.read' | 'ai.decide'
  | 'dashboard.governor'
  | 'field.sync'
  | 'appeal.submit' | 'appeal.instruct' | 'appeal.decide'
  | 'alerts.read'
  | 'draft.write';

/**
 * Action d'un module d'extension (verticale) : `<module>:<action>`, ex. `parking:session.create`.
 * Déclarée par `definePolicy` ; non déclarée ⇒ refusée (moindre privilège). Jamais permise à l'IA.
 */
export type ExtensionAction = `${string}:${string}`;
export type AnyAction = Action | ExtensionAction;

export interface Resource {
  taxpayerId?: string;
  entity?: string;
  entities?: string[];
  communes?: string[];
  /** Contexte d'une recommandation d'IA */
  context?: string;
}

/** Niveau d'accès accordé : complet ou minimal (données masquées, ex. agent de terrain). */
export type Access = 'full' | 'minimal';
type Grant = (u: User, r: Resource) => Access | false;

const always: Grant = () => 'full';
const minimal: Grant = () => 'minimal';
const ownTaxpayer: Grant = (u, r) => (r.taxpayerId !== undefined && u.taxpayerId === r.taxpayerId ? 'full' : false);
const mandant: Grant = (u, r) => (r.taxpayerId !== undefined && (u.mandants ?? []).includes(r.taxpayerId) ? 'full' : false);
const sameEntity: Grant = (u, r) => {
  const ents = r.entities ?? (r.entity ? [r.entity] : []);
  return ents.includes(u.entity) ? 'full' : false;
};
const inTerritory =
  (access: Access): Grant =>
  (u, r) => {
    if (!u.territory) return access;
    return (r.communes ?? []).some((c) => u.territory!.includes(c)) ? access : false;
  };
const contextIn =
  (...ctx: string[]): Grant =>
  (_u, r) => (r.context !== undefined && ctx.includes(r.context) ? 'full' : false);

/** Briques de décision réutilisables par les modules d'extension. */
export const GRANTS = { always, minimal, ownTaxpayer, mandant, sameEntity, inTerritory, contextIn } as const;
export type { Grant };

/** Rôles d'agents publics (R01 à R29). */
export const PUBLIC_AGENT_ROLES = Array.from({ length: 29 }, (_, i) => `R${String(i + 1).padStart(2, '0')}` as RoleCode);
const allAgents = (g: Grant): Partial<Record<RoleCode, Grant>> => Object.fromEntries(PUBLIC_AGENT_ROLES.map((r) => [r, g]));

/** Matrice d'habilitations (§ 12.4). Ce qui n'est pas listé est refusé (moindre privilège). */
const MATRIX: Record<Action, Partial<Record<RoleCode, Grant>>> = {
  'taxpayer.read': {
    R30: ownTaxpayer, R31: mandant, R06: sameEntity, R07: sameEntity, R11: sameEntity, R20: sameEntity,
    R12: always, R17: always, R22: always, R23: always, R24: always, R10: inTerritory('minimal'),
  },
  'object.create': { R30: ownTaxpayer, R06: always, R07: always, R10: inTerritory('full'), R11: always, R12: always },
  'lease.declare': { R30: always, R31: always },
  'rule.read': allAgents(always),
  'rule.create': { R13: always },
  'rule.approve': { R13: always, R14: always, R15: always, R16: always },
  'assessment.simulate': { R06: always, R07: always, R11: always },
  'assessment.liquidate': { R06: always, R07: always, R11: always },
  'obligation.read': {
    R30: ownTaxpayer, R31: mandant, R06: sameEntity, R07: sameEntity, R11: sameEntity, R20: sameEntity, R21: always,
    R12: always, R17: always, R22: always, R23: always, R24: always, R10: inTerritory('minimal'),
  },
  // Rectification : uniquement par le circuit de réclamation (contre-écriture), jamais par modification directe.
  'obligation.modify': {},
  'payment.create': { R30: ownTaxpayer, R31: mandant, R12: always },
  // Un paiement n'est modifié que par un événement prestataire vérifié : aucun rôle humain.
  'payment.modify': {},
  // Relais de vérification capture/SMS chez le prestataire : pièce de dossier (litige, exception), jamais une quittance.
  'payment.evidence': { R17: always, R18: always, R20: always },
  // Console des prestataires connectés : configuration masquée et journal des webhooks.
  'provider.read': { R17: always, R18: always, R22: always, R26: always, R27: always, R28: always },
  // État de raccordement des prestataires (noms de variables et présence, jamais une valeur secrète) et « Tester la
  // connexion » : Trésor (R17), administration de la plateforme (R26), sécurité (R28).
  'provider.readiness': { R17: always, R26: always, R28: always },
  // Simulation d'une confirmation signée : BAC À SABLE LOCAL et mode démonstration uniquement (jamais en production).
  'provider.simulate': { R17: always, R26: always },
  'settlement.import': { R17: always },
  'reconciliation.read': { R17: always, R18: always, R22: always },
  'ledger.read': { R17: always, R22: always, R23: always },
  'ledger.reverse': { R17: always },
  'beneficiary.read': { R17: always, R19: always, R22: always },
  'beneficiary.propose': { R17: always },
  'beneficiary.approve': { R19: always },
  'audit.read': { R22: always, R23: always },
  // Aucun rôle ne peut modifier ou supprimer un événement d'audit.
  'audit.modify': {},
  'comms.read': allAgents(always),
  'comms.test': allAgents(always),
  'ai.insight': {
    ...allAgents(contextIn('communications')),
    R01: contextIn('governor', 'communications'), R02: contextIn('governor', 'communications'), R05: contextIn('governor', 'communications'),
    R06: contextIn('rental', 'communications'), R07: contextIn('rental', 'communications'), R09: contextIn('rental', 'communications'),
    R11: contextIn('rental', 'communications'), R17: contextIn('treasury', 'communications'), R18: contextIn('treasury', 'communications'),
    R22: always,
  },
  'ai.read': allAgents(always),
  'ai.decide': {
    R01: contextIn('governor'), R02: contextIn('governor'), R05: contextIn('governor'),
    R06: contextIn('rental', 'communications'), R07: contextIn('rental'), R09: contextIn('rental'),
    R17: contextIn('treasury'), R08: contextIn('communications'),
  },
  'dashboard.governor': { R01: always, R02: always, R05: always },
  'field.sync': { R10: always },
  'appeal.submit': { R30: ownTaxpayer, R31: mandant },
  'appeal.instruct': { R20: always },
  'appeal.decide': { R21: always },
  'alerts.read': { R22: always, R24: always, R28: always },
  'draft.write': { ...allAgents(always), R30: always, R31: always },
};

const EXTENSIONS: Record<string, Partial<Record<RoleCode, Grant>>> = {};

/** Déclare la matrice d'une action d'extension (une seule fois ; redéclaration identique tolérée). */
export function definePolicy(action: ExtensionAction, grants: Partial<Record<RoleCode, Grant>>): void {
  EXTENSIONS[action] = grants;
}

/** Tous les rôles d'agents publics (R01 à R29) avec la même décision. */
export const allAgentRoles = allAgents;

function grantsFor(action: AnyAction): Partial<Record<RoleCode, Grant>> {
  return (MATRIX as Record<string, Partial<Record<RoleCode, Grant>>>)[action] ?? EXTENSIONS[action] ?? {};
}

/** Correspondance des actions métier avec les interdits constitutionnels de l'IA (§ 23.1). */
const AI_FORBIDDEN_MAP: Partial<Record<Action, (typeof AI_FORBIDDEN_ACTIONS)[number]>> = {
  'rule.create': 'CREATE_TAX', 'rule.approve': 'CREATE_TAX', 'assessment.liquidate': 'CREATE_TAX',
  'obligation.modify': 'IMPOSE_PENALTY', 'payment.create': 'TRANSFER_MONEY', 'payment.modify': 'TRANSFER_MONEY',
  'ledger.reverse': 'TRANSFER_MONEY', 'settlement.import': 'TRANSFER_MONEY',
  'beneficiary.propose': 'CHANGE_BENEFICIARY', 'beneficiary.approve': 'CHANGE_BENEFICIARY',
  'appeal.decide': 'CLOSE_APPEAL', 'appeal.instruct': 'CLOSE_APPEAL', 'audit.modify': 'DESTROY_AUDIT',
  'ai.decide': 'APPROVE_EXEMPTION',
};

/** Actions de niveau A (sans effet juridique ni financier) permises à un agent d'IA. */
const AI_ALLOWED: Action[] = ['ai.insight', 'draft.write'];

/**
 * Garde de l'IA : lève une erreur si un acteur IA tente une action de niveau C ou interdite.
 * Accepte aussi directement un code de `AI_FORBIDDEN_ACTIONS`.
 */
export function assertAiMay(actor: Principal, action: AnyAction | (typeof AI_FORBIDDEN_ACTIONS)[number]): void {
  if (actor.kind !== 'ai') return;
  const forbiddenCode = (AI_FORBIDDEN_ACTIONS as readonly string[]).includes(action)
    ? action
    : AI_FORBIDDEN_MAP[action as Action];
  if (forbiddenCode || !AI_ALLOWED.includes(action as Action)) {
    throw forbidden(
      'AI_FORBIDDEN_ACTION',
      `Un agent d'IA ne peut pas exécuter l'action « ${action} »${forbiddenCode ? ` (${forbiddenCode})` : ''} : recommandation seulement, décision humaine obligatoire.`,
    );
  }
}

/** Évalue une décision d'accès sans lever d'erreur. */
export function evaluate(principal: Principal, action: AnyAction, resource: Resource = {}): Access | false {
  if (principal.kind === 'ai') {
    try {
      assertAiMay(principal, action);
      return 'full';
    } catch {
      return false;
    }
  }
  const grants = grantsFor(action);
  let best: Access | false = false;
  for (const role of principal.roles) {
    const g = grants[role];
    if (!g) continue;
    const a = g(principal, resource);
    if (a === 'full') return 'full';
    if (a === 'minimal') best = 'minimal';
  }
  return best;
}

/** Le rôle peut-il, en principe, effectuer l'action (quel que soit le périmètre) ? */
export function hasAnyGrant(user: User, action: AnyAction): boolean {
  const g = grantsFor(action);
  return user.roles.some((r) => g[r] !== undefined);
}

/** Autorise ou lève 403 FORBIDDEN. Retourne le niveau d'accès (complet ou minimal). */
export function authorize(principal: Principal, action: AnyAction, resource: Resource = {}): Access {
  if (principal.kind === 'ai') {
    assertAiMay(principal, action);
    return 'full';
  }
  const access = evaluate(principal, action, resource);
  if (!access) {
    throw forbidden('FORBIDDEN', `Action « ${action} » non autorisée pour les rôles ${principal.roles.join(', ')} dans ce périmètre.`, {
      action,
    });
  }
  return access;
}

/**
 * Résolution compte → personne physique (empreinte de la pièce d'identité), fournie par le module d'accès.
 * Sans résolveur ou sans empreinte connue, chaque compte vaut une personne (comportement historique).
 */
type PersonResolver = (userId: string) => string | undefined;
let personResolver: PersonResolver = () => undefined;
export function registerPersonResolver(fn: PersonResolver): void {
  personResolver = fn;
}
/**
 * Séparation des tâches sur un même dossier : la PERSONNE (et non seulement le compte) ne doit pas déjà être
 * intervenue. Deux comptes d'une même personne (autre téléphone, même pièce d'identité) sont une seule personne.
 */
export function assertDistinctPerson(userId: string, previous: string[], detail: string): void {
  if (previous.includes(userId)) throw forbidden('SEPARATION_OF_DUTIES', detail);
  const me = personResolver(userId);
  if (me && previous.some((p) => !!p && personResolver(p) === me)) throw forbidden('SEPARATION_OF_DUTIES', detail, { samePerson: true });
}

/**
 * Conflit d'intérêts : un agent ne vérifie, ne décide ni n'accorde rien qui profite à un contribuable auquel il est lié
 * (son propre compte, contribuables déclarés ou rattachés). La source des liens est fournie par le module d'accès.
 */
type RelatedResolver = (user: User) => Set<string>;
let relatedResolver: RelatedResolver = (u) => new Set(u.taxpayerId ? [u.taxpayerId] : []);
export function registerRelatedTaxpayersResolver(fn: RelatedResolver): void {
  relatedResolver = fn;
}
export function assertNotRelated(user: User, taxpayerId: string | null | undefined, detail: string): void {
  if (!taxpayerId) return;
  if (relatedResolver(user).has(taxpayerId)) throw forbidden('CONFLICT_OF_INTEREST', detail);
}
