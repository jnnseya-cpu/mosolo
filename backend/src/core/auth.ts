/**
 * Authentification (ch. 31) :
 *  - jeton de session signé `Authorization: Bearer <jwt>` émis par le fournisseur d'identité local compatible OIDC
 *    (plugin « socle », backend/src/plugins/socle) ; vérifié par le vérificateur enregistré pour l'annuaire ;
 *  - en-tête de DÉMONSTRATION `x-demo-user`, accepté UNIQUEMENT si MOSOLO_DEMO_MODE vaut explicitement « true »
 *    (défaut : démo DÉSACTIVÉE) et jamais lorsque NODE_ENV=production (démarrage refusé, voir `assertSafeDeployment`).
 * Cible de production : IdP OIDC souverain (Keycloak) + clés d'accès (passkeys) pour les rôles sensibles.
 */
import { hasIncompatibility, ROLES, type LanguageCode, type RoleCode } from '@mosolo/shared';
import type { FastifyRequest } from 'fastify';
import { forbidden, unauthorized } from './errors.js';

export interface User {
  kind: 'user';
  id: string;
  name: string;
  roles: RoleCode[];
  entity: string;
  /** Communes du périmètre (ABAC territoire) ; absent = toute la province. */
  territory?: string[];
  /** Pour un contribuable (R30) : son identifiant de contribuable. */
  taxpayerId?: string;
  /** Pour un mandataire (R31) : contribuables mandants. */
  mandants?: string[];
  email?: string;
  phone?: string;
  lang?: LanguageCode;
  /** Contexte d'authentification (présent si la requête porte un jeton de session ; absent en mode démo par en-tête). */
  auth?: AuthContext;
}

/** Niveaux d'authentification (`acr`) — du plus faible au plus fort. */
export const ACR = {
  /** Mot de passe seul (non émis : un facteur ne suffit jamais pour un compte de travail). */
  PWD: 'urn:mosolo:acr:pwd',
  /** Code à usage unique envoyé au téléphone (contribuables). */
  OTP: 'urn:mosolo:acr:otp',
  /** Mot de passe + TOTP (comptes de travail). */
  MFA: 'urn:mosolo:acr:mfa',
  /** Clé d'accès / FIDO2 résistante au hameçonnage — [À RACCORDER] (aucun jeton de ce niveau n'est émis aujourd'hui). */
  PHR: 'urn:mosolo:acr:phr',
} as const;
export type AcrValue = (typeof ACR)[keyof typeof ACR];
const ACR_RANK: Record<string, number> = { [ACR.PWD]: 1, [ACR.OTP]: 2, [ACR.MFA]: 3, [ACR.PHR]: 4 };

export interface AuthContext {
  method: 'bearer';
  sessionId: string;
  acr: AcrValue;
  amr: string[];
  /** Instant d'authentification (ISO). */
  authTime: string;
  expiresAt: string;
}

/** Principal « agent d'IA » : n'a aucun droit d'écriture sur les domaines financiers ou juridiques. */
export interface AiActor {
  kind: 'ai';
  id: string;
  agent: string;
}

export type Principal = User | AiActor;

export class UserDirectory {
  private readonly users = new Map<string, User>();

  /** Ajoute un utilisateur ; refuse tout cumul de rôles incompatibles (§ 12.5). */
  add(user: Omit<User, 'kind'>): User {
    for (const r of user.roles) if (!(r in ROLES)) throw new Error(`Rôle inconnu : ${r}`);
    const clash = hasIncompatibility(user.roles);
    if (clash) {
      throw forbidden('ROLE_INCOMPATIBILITY', `Cumul interdit des rôles ${clash[0]} (${ROLES[clash[0]]}) et ${clash[1]} (${ROLES[clash[1]]}).`, { roles: clash });
    }
    if (this.users.has(user.id)) throw new Error(`Utilisateur déjà présent : ${user.id}`);
    const u: User = { kind: 'user', ...user };
    this.users.set(u.id, u);
    return u;
  }

  get(id: string): User | undefined {
    return this.users.get(id);
  }

  all(): User[] {
    return [...this.users.values()];
  }

  withRole(role: RoleCode): User[] {
    return this.all().filter((u) => u.roles.includes(role));
  }

  /** Remplace les rôles d'un compte (rôles connus, sans cumul incompatible § 12.5). Le journal est tenu par l'appelant. */
  setRoles(id: string, roles: RoleCode[]): User {
    const u = this.users.get(id);
    if (!u) throw new Error(`Utilisateur inconnu : ${id}`);
    for (const r of roles) if (!(r in ROLES)) throw new Error(`Rôle inconnu : ${r}`);
    const clash = hasIncompatibility(roles);
    if (clash) throw forbidden('ROLE_INCOMPATIBILITY', `Cumul interdit des rôles ${clash[0]} (${ROLES[clash[0]]}) et ${clash[1]} (${ROLES[clash[1]]}).`, { roles: clash });
    // Modification en place : les sessions et requêtes en cours voient immédiatement le nouvel état.
    (u as { roles: RoleCode[] }).roles = [...roles];
    return u;
  }

  /** Contribuables pour lesquels un mandataire agit (mandats actifs). */
  setMandants(id: string, taxpayerIds: string[]): User {
    const u = this.users.get(id);
    if (!u) throw new Error(`Utilisateur inconnu : ${id}`);
    u.mandants = [...taxpayerIds];
    return u;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
    rawBody?: string;
  }
}

/** Vérifie un jeton porteur et retourne l'utilisateur authentifié (lève 401 si invalide, expiré ou révoqué). */
export type BearerVerifier = (token: string, req: FastifyRequest) => User;
const bearerVerifiers = new WeakMap<UserDirectory, BearerVerifier>();

/** Enregistré par le fournisseur d'identité (plugin « socle ») pour l'annuaire de l'application. */
export function registerBearerVerifier(directory: UserDirectory, verifier: BearerVerifier): void {
  bearerVerifiers.set(directory, verifier);
}

const TRUTHY = ['1', 'true', 'oui', 'yes'];
const truthy = (v: string | undefined): boolean => TRUTHY.includes((v ?? '').trim().toLowerCase());
const isProduction = (env: NodeJS.ProcessEnv): boolean => (env.NODE_ENV ?? '').trim().toLowerCase() === 'production';

/**
 * Mode démonstration : actif UNIQUEMENT si MOSOLO_DEMO_MODE vaut explicitement « true » (sûr par défaut), et jamais
 * lorsque NODE_ENV=production. Les scripts locaux (`npm run dev`), les tests (vitest.config.ts) et la CI l'activent
 * explicitement.
 */
export function isDemoMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthy(env.MOSOLO_DEMO_MODE) && !isProduction(env);
}

/** Erreur de configuration : le serveur refuse de démarrer plutôt que de fonctionner avec un réglage dangereux. */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * Contrôle de démarrage : en production (NODE_ENV=production), le mode démonstration et les identifiants de
 * démonstration (mot de passe connu, secrets TOTP dérivés de l'identifiant) sont refusés explicitement.
 */
export function assertSafeDeployment(env: NodeJS.ProcessEnv = process.env): void {
  if (!isProduction(env)) return;
  if (truthy(env.MOSOLO_DEMO_MODE)) {
    throw new ConfigurationError('MOSOLO_DEMO_MODE=true est interdit lorsque NODE_ENV=production : l’en-tête x-demo-user permettrait d’usurper n’importe quel compte.');
  }
  if (truthy(env.MOSOLO_DEMO_CREDENTIALS)) {
    throw new ConfigurationError('MOSOLO_DEMO_CREDENTIALS=true est interdit lorsque NODE_ENV=production : mot de passe et secrets TOTP de démonstration publics.');
  }
}

/** Le contexte d'authentification atteint-il le niveau demandé ? (Faux sans jeton de session.) */
export function hasAcr(user: User, minimum: AcrValue): boolean {
  return !!user.auth && (ACR_RANK[user.auth.acr] ?? 0) >= (ACR_RANK[minimum] ?? 99);
}

/**
 * Exige un niveau d'authentification minimal (« step-up »). En mode démonstration par en-tête (aucun contexte
 * d'authentification), la vérification est levée pour ne pas bloquer les parcours de démonstration.
 */
export function requireAcr(user: User, minimum: AcrValue): void {
  if (!user.auth) {
    if (isDemoMode()) return;
    throw unauthorized('AUTH_REQUIRED', 'Authentification requise.');
  }
  if ((ACR_RANK[user.auth.acr] ?? 0) < (ACR_RANK[minimum] ?? 99)) {
    throw forbidden('MFA_REQUIRED', 'Cette action exige une authentification renforcée (niveau supérieur).', { acr: user.auth.acr, required: minimum });
  }
}

export function resolveDemoUser(req: FastifyRequest, directory: UserDirectory): User | undefined {
  const authz = req.headers.authorization;
  const verifier = bearerVerifiers.get(directory);
  // Sans fournisseur d'identité chargé, l'en-tête Authorization est ignoré (comportement historique).
  if (verifier && typeof authz === 'string' && authz.trim() !== '') {
    const m = /^Bearer\s+(\S+)$/i.exec(authz.trim());
    if (!m) throw unauthorized('INVALID_AUTHORIZATION', 'En-tête Authorization invalide (attendu : Bearer <jeton>).');
    return verifier(m[1]!, req);
  }
  const header = req.headers['x-demo-user'];
  const id = Array.isArray(header) ? header[0] : header;
  if (!id) return undefined;
  if (!isDemoMode()) throw unauthorized('DEMO_AUTH_DISABLED', 'Authentification de démonstration désactivée : utilisez un jeton de session (Authorization: Bearer).');
  const user = directory.get(id);
  if (!user) throw unauthorized('UNKNOWN_DEMO_USER', `Utilisateur de démonstration inconnu : ${id}`);
  return user;
}

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw unauthorized('AUTH_REQUIRED', isDemoMode() ? 'Authentification requise (jeton de session, ou en-tête de démonstration x-demo-user).' : 'Authentification requise (jeton de session).');
  return req.user;
}
