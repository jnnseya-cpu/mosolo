/**
 * Authentification de DÉMONSTRATION : l'utilisateur est désigné par l'en-tête `x-demo-user`.
 * En production : OIDC + clés d'accès (passkeys), jeton court portant rôles, entité et niveau d'authentification (ch. 31).
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
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
    rawBody?: string;
  }
}

export function resolveDemoUser(req: FastifyRequest, directory: UserDirectory): User | undefined {
  const header = req.headers['x-demo-user'];
  const id = Array.isArray(header) ? header[0] : header;
  if (!id) return undefined;
  const user = directory.get(id);
  if (!user) throw unauthorized('UNKNOWN_DEMO_USER', `Utilisateur de démonstration inconnu : ${id}`);
  return user;
}

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw unauthorized('AUTH_REQUIRED', 'Authentification requise (démo : en-tête x-demo-user).');
  return req.user;
}
