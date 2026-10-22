/**
 * Point de décision des politiques (PDP) centralisé : RBAC + ABAC simple (entité, territoire, dossier propre)
 * + séparation des tâches + garde de l'IA (§ 12.1, § 12.4, § 23.1).
 * Toute route appelle `authorize` ; aucune décision d'accès n'est prise dans l'interface.
 */
import { agentRattache, AI_FORBIDDEN_ACTIONS, MODULES_VERIFICATION, type ModuleVerification, type RoleCode } from '@mosolo/shared';
import { isDemoMode, type Principal, type User } from './auth.js';
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
  | 'draft.write'
  | 'integration.read' | 'integration.propose' | 'integration.approve';

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
  // « Clés et raccordements » (29/09/2026) : inventaire (noms, présence, source — jamais une valeur) lu par le
  // super-administrateur (R26) et le responsable sécurité (R28) ; proposition par R26 ; approbation par une personne
  // DISTINCTE, R26 ou R28 (règle des deux personnes, contrôlée par le service). Aucun autre droit n'est élargi.
  'integration.read': { R26: always, R28: always },
  'integration.propose': { R26: always },
  'integration.approve': { R26: always, R28: always },
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

/**
 * Groupe Nseya — super-administrateur en LECTURE COMPLÈTE (R38, décision du maître d'ouvrage du 29/09/2026,
 * spécification v1.0 du moteur de répartition, § 4 et § 5) : lecture des tableaux, agrégats, finances, trésor,
 * répartitions, règles et journaux d'audit de TOUTE la plateforme, export et descente à la transaction. Aucune action
 * d'écriture n'est accordée ici (liste fermée d'actions de LECTURE). Les dossiers individuels de contribuables
 * (lecture de la personne, de ses obligations, objets, titres, déclarations…) n'y figurent PAS : ils passent par la
 * consultation motivée existante (motif déclaré et journalisé, critère C42-05).
 */
export const LECTURE_GROUPE_NSEYA_EXACTE: ReadonlySet<string> = new Set([
  'audit.read', 'ledger.read', 'reconciliation.read', 'rule.read', 'dashboard.governor', 'alerts.read', 'provider.read', 'beneficiary.read',
  'tresor:overview', 'tresor:closure.read', 'tresor:operation.read', 'tresor:exception.read', 'tresor:suspense.read', 'tresor:matching.read',
  'tresor:nomenclature.read', 'tresor:points.read', 'tresor:receivables.read', 'tresor:export', 'pilotage:export',
  'recouvrement:yield.read', 'campagnes:read', 'chaine:ruptures.read', 'plateforme:supervision.read', 'appeals:indicators.read',
  'programme:read', 'repartition:read', 'reserve:read', 'legalshares:read', 'referentiel:read', 'referentiel:conformite.read',
  // Accès global (30/09/2026) : écrans de supervision et d'analyse relevés par le parcours de tous les écrans.
  'ai.insight', 'canaux:point.supervise', 'canaux:enrolment.read', 'publicite:inventory', 'fiscal:object.read', 'documents:read',
  'citoyen:activites.read', 'citoyen:cadastre.read', 'citoyen:locatif.read', 'citoyen:transport.lire', 'citoyen:vehicules.read',
]);
const LECTURE_GROUPE_NSEYA_MOTIFS: RegExp[] = [
  /^(pilotage|decision|planification|postes):[\w.-]*read$/,
  /^moteur:[\w.-]*(read|export)$/,
  /:(indicators|indicateurs|indicators\.read|indicateurs\.read|application\.indicateurs)$/,
];
/**
 * Accès global en lecture (30/09/2026, consigne du maître d'ouvrage : « Groupe Nseya, super-administrateur, a un accès
 * total et global ; un “Accès refusé” ne doit jamais apparaître ») : toute action de LECTURE de la plateforme (tableaux
 * de tous les postes, registres, dossiers, cartes, journaux, exports), reconnue à son suffixe. Les actions d'écriture
 * ou de décision restent exclues (le compte ne vérifie, n'approuve, n'active ni ne paie jamais).
 */
const LECTURE_GENERIQUE = /(^|[.:])(read|read\.any|read\.own|list|view|overview|export|dashboard|governor|indicators?|indicateurs|stats?|history|map|search|detail|summary|profile(\.[\w-]+)?|report|journal(\.all)?|objects|lifecycle\.read|plate\.profile)$/;
const ECRITURE_EXCLUE = /(\.|:)(write|manage|assign|close|intake|qualify|respond|triage|committee|data_owner|incident|create|update|delete|approve|decide|pay|activate|sign)(\.|$)/;
/**
 * Lectures de dossiers personnels individuels : HORS de la lecture globale — elles passent par la consultation motivée
 * (motif déclaré et journalisé, critère d'acceptation non négociable C42-05 de la spécification v1.0).
 */
export const LECTURE_PERSONNELLE = /^(taxpayer\.read|obligation\.read|citoyen:|titres:read|fiscal:(declaration|clearance|exemption|object)|parking:(plate\.profile|session\.read|violation\.read)|canaux:(card|enrolment|notice)|documents:read|recouvrement:notice|rakapay:(complaint|registry)|biens:)/;
/**
 * Plateforme EN SERVICE (30/09/2026, consigne du maître d'ouvrage : « une fois la plateforme en service, nous ne voyons
 * PAS ce qui est réservé au Gouverneur ni ce que les services voient pour leurs opérations quotidiennes ; seulement ce
 * que nous devons voir ») : hors démonstration, Groupe Nseya ne garde que la lecture de son périmètre — moteur de
 * paiement et de répartition, grand livre, rapprochement, trésor en agrégats, règles, journaux d'audit, supervision de
 * la plateforme. Liste « par défaut — à confirmer par le maître d'ouvrage ».
 */
const LECTURE_GROUPE_NSEYA_PRODUCTION: ReadonlySet<string> = new Set([
  'audit.read', 'ledger.read', 'reconciliation.read', 'rule.read', 'provider.read', 'beneficiary.read',
  'tresor:overview', 'tresor:closure.read', 'tresor:operation.read', 'tresor:exception.read', 'tresor:suspense.read', 'tresor:matching.read',
  'tresor:nomenclature.read', 'tresor:receivables.read', 'tresor:export', 'plateforme:supervision.read',
  'repartition:read', 'reserve:read', 'legalshares:read', 'referentiel:read', 'referentiel:conformite.read', 'programme:read',
]);
export function isLectureGroupeNseya(action: string): boolean {
  // Démonstration (construction et essais) : lecture globale ; en service : périmètre propre seulement.
  if (!isDemoMode()) return LECTURE_GROUPE_NSEYA_PRODUCTION.has(action) || /^moteur:[\w.-]*(read|export)$/.test(action);
  if (LECTURE_GROUPE_NSEYA_EXACTE.has(action) || LECTURE_GROUPE_NSEYA_MOTIFS.some((re) => re.test(action))) return true;
  return LECTURE_GENERIQUE.test(action) && !ECRITURE_EXCLUE.test(action) && !LECTURE_PERSONNELLE.test(action);
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
  // Groupe Nseya (R38) : lecture complète de la plateforme (liste fermée d'actions de lecture), jamais d'écriture.
  if (principal.roles.includes('R38') && isLectureGroupeNseya(action)) return 'full';
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

/**
 * Rémunérations et droits d'autrui (décision du maître d'ouvrage du 29/09/2026) : SEULS le Gouverneur, le directeur de
 * cabinet, le secrétaire exécutif, le ministre des Finances (R01, R02, R03, R05) et Groupe Nseya (R38) voient ce que
 * gagnent les autres (agents, sous-traitants, ministères, départements, Groupe Nseya, Gouvernorat). Tous les autres ne
 * voient que leurs propres gains (ou ceux de leur périmètre : régie, ombrelle de sous-traitant), côté serveur.
 */
export const ROLES_VISION_GAINS_COMPLETE: readonly RoleCode[] = ['R01', 'R02', 'R03', 'R05', 'R38'];

/**
 * Accès aux montants SUR AUTORISATION PRÉALABLE (décision du 29/09/2026) : Trésor, rapprochement, validation
 * financière, contrôle qualité, audit et anti-fraude voient les montants nécessaires à leur travail seulement après
 * l'approbation d'un membre de la direction (R01, R02, R03, R05), sur motif déclaré, pour une durée limitée, chaque
 * utilisation étant journalisée. Portées : moteur de répartition, rapport § 37A, gains et réserve des agents.
 */
export type PorteeMontants = 'MOTEUR' | 'REPARTITION' | 'AGENTS';
type ResolveurAutorisation = (userId: string, portee: PorteeMontants) => string | null;
let resolveurAutorisation: ResolveurAutorisation | null = null;
export function registerAutorisationMontantsResolver(fn: ResolveurAutorisation | null): void {
  resolveurAutorisation = fn;
}
/** Identifiant de l'autorisation active couvrant la portée (et journalise son utilisation), sinon null. */
export function autorisationMontants(user: Pick<User, 'id'>, portee: PorteeMontants): string | null {
  return resolveurAutorisation ? resolveurAutorisation(user.id, portee) : null;
}
export function voitTousLesGains(user: Pick<User, 'roles'> & Partial<Pick<User, 'id'>>, portee?: PorteeMontants): boolean {
  if (user.roles.some((r) => ROLES_VISION_GAINS_COMPLETE.includes(r))) return true;
  return !!(portee && user.id && autorisationMontants({ id: user.id }, portee));
}

/** Le rôle peut-il, en principe, effectuer l'action (quel que soit le périmètre) ? */
export function hasAnyGrant(user: User, action: AnyAction): boolean {
  const g = grantsFor(action);
  if (user.roles.includes('R38') && isLectureGroupeNseya(action)) return true;
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

/**
 * Rattachement des agents de terrain (30/09/2026) : un superviseur, agent ou contrôleur ne contrôle, ne scanne et ne
 * vérifie que dans les modules de son rattachement (shared/modules-agents.ts). Refus motivé sinon.
 */
export function assertModuleAgent(principal: Principal, module: ModuleVerification): void {
  if (principal.kind !== 'user') return;
  if (!agentRattache(principal, module)) {
    throw forbidden('MODULE_NON_RATTACHE', `Vous n’êtes pas rattaché au module « ${MODULES_VERIFICATION[module]} » : contrôle réservé aux agents de ce module.`, { module, modules: principal.modules ?? [] });
  }
}
