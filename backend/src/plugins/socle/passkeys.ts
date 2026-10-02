/**
 * Clés d'accès FIDO2 / WebAuthn (§ 31 « authentification résistante au hameçonnage pour tout profil sensible »),
 * par-dessus le fournisseur d'identité local (service.ts) — remplace la réponse 501 historique.
 *
 *  - Enregistrement : depuis une session de travail déjà authentifiée par mot de passe + TOTP (niveau MFA) ;
 *    défi à usage unique (5 min), attestation « none » acceptée (aucune métadonnée de fabricant exigée), vérification
 *    de l'origine et de l'identifiant de partie de confiance, vérification de présence et d'identité de l'utilisateur.
 *  - Connexion : défi → assertion signée → session au niveau PHR (résistant au hameçonnage) ; compteur de signature
 *    contrôlé (régression = clé clonée : refus + alerte).
 *  - Rôles sensibles : avec au moins une clé enregistrée et le paramètre du registre `socle.cle_acces_obligatoire`
 *    actif, la connexion mot de passe + TOTP devient un SECOURS motivé (journalisé, alerté) ; sans clé : période
 *    d'enrôlement, connexion TOTP inchangée.
 * Configuration : MOSOLO_WEBAUTHN_RP_ID (défaut localhost), MOSOLO_WEBAUTHN_ORIGINS (origines admises, séparées par
 * des virgules ; démonstration : origine de la requête si son hôte est l'identifiant de partie de confiance).
 */
import { randomUUID } from 'node:crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { ConfigurationError, isDemoMode, type User } from '../../core/auth.js';
import { conflict, notFound, unauthorized, unprocessable } from '../../core/errors.js';
import { InMemoryRepository } from '../../core/repository.js';
import { userRecipient } from '../../modules/identity/recipients.js';

export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60_000;

export interface PasskeyCredential {
  /** Identifiant de la clé (base64url, fourni par l'authentificateur). */
  id: string;
  userId: string;
  /** Clé publique COSE (base64url) — jamais de secret côté serveur. */
  publicKey: string;
  counter: number;
  transports: string[];
  label: string;
  aaguid: string;
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  revokedBy?: string;
}

export interface WebAuthnChallenge {
  id: string;
  purpose: 'ENREGISTREMENT' | 'CONNEXION';
  userId?: string;
  challenge: string;
  createdAt: string;
  expiresAt: string;
  status: 'EN_ATTENTE' | 'UTILISE' | 'EXPIRE';
}

export interface WebAuthnConfig {
  rpId: string;
  rpName: string;
  origins: string[];
}

export function webauthnFromEnv(env: NodeJS.ProcessEnv = process.env): WebAuthnConfig {
  const rpId = (env.MOSOLO_WEBAUTHN_RP_ID ?? 'localhost').trim();
  const origins = (env.MOSOLO_WEBAUTHN_ORIGINS ?? '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  if (!isDemoMode(env) && env.MOSOLO_WEBAUTHN_RP_ID && !origins.length) {
    throw new ConfigurationError('MOSOLO_WEBAUTHN_ORIGINS requise hors démonstration lorsque MOSOLO_WEBAUTHN_RP_ID est défini.');
  }
  return { rpId, rpName: 'KINSHASA MOSOLO', origins };
}

const b64u = (u: Uint8Array) => Buffer.from(u).toString('base64url');

export class PasskeyService {
  readonly passkeys = new InMemoryRepository<PasskeyCredential>();
  readonly webauthnChallenges = new InMemoryRepository<WebAuthnChallenge>();

  constructor(private readonly ctx: AppContext, readonly config: WebAuthnConfig) {}

  private now(): Date {
    return this.ctx.clock.now();
  }

  /** Origines admises pour cette requête (liste configurée ; démonstration : origine de la requête sur l'hôte du RP). */
  expectedOrigins(req: FastifyRequest): string[] {
    if (this.config.origins.length) return this.config.origins;
    const o = typeof req.headers.origin === 'string' ? req.headers.origin.replace(/\/+$/, '') : '';
    const fallback = [`http://${this.config.rpId}:5173`, `http://${this.config.rpId}:8080`, `https://${this.config.rpId}`];
    if (!isDemoMode()) return fallback;
    try {
      return o && new URL(o).hostname === this.config.rpId ? [o, ...fallback] : fallback;
    } catch { return fallback; }
  }

  active(userId: string): PasskeyCredential[] {
    return this.passkeys.find((p) => p.userId === userId && !p.revokedAt);
  }

  list(user: User) {
    return this.passkeys.find((p) => p.userId === user.id).map(({ publicKey: _pk, ...rest }) => ({ ...rest, active: !rest.revokedAt }));
  }

  private newChallenge(purpose: WebAuthnChallenge['purpose'], challenge: string, userId?: string): WebAuthnChallenge {
    const now = this.now();
    return this.webauthnChallenges.insert({
      id: `WAC-${randomUUID()}`, purpose, ...(userId ? { userId } : {}), challenge, createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + WEBAUTHN_CHALLENGE_TTL_MS).toISOString(), status: 'EN_ATTENTE',
    });
  }

  private consume(id: string, purpose: WebAuthnChallenge['purpose'], userId?: string): WebAuthnChallenge {
    const c = this.webauthnChallenges.get(id);
    if (!c || c.purpose !== purpose || (userId && c.userId !== userId)) throw unauthorized('PASSKEY_CHALLENGE_INVALID', 'Défi de clé d’accès inconnu : recommencez.');
    if (c.status !== 'EN_ATTENTE') throw unauthorized('PASSKEY_CHALLENGE_INVALID', 'Défi de clé d’accès déjà utilisé : recommencez.');
    // Usage unique, même en cas d'échec de vérification.
    this.webauthnChallenges.update({ ...c, status: new Date(c.expiresAt) <= this.now() ? 'EXPIRE' : 'UTILISE' });
    if (new Date(c.expiresAt) <= this.now()) throw unauthorized('PASSKEY_CHALLENGE_EXPIRED', 'Défi expiré : recommencez.');
    return c;
  }

  async registrationOptions(user: User) {
    const options = await generateRegistrationOptions({
      rpName: this.config.rpName, rpID: this.config.rpId, userName: user.id, userDisplayName: user.name,
      userID: new TextEncoder().encode(user.id), attestationType: 'none',
      excludeCredentials: this.active(user.id).map((p) => ({ id: p.id, transports: p.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    });
    const ch = this.newChallenge('ENREGISTREMENT', options.challenge, user.id);
    return { challengeId: ch.id, expiresAt: ch.expiresAt, options };
  }

  async register(user: User, input: { challengeId: string; response: RegistrationResponseJSON; label?: string }, req: FastifyRequest) {
    const ch = this.consume(input.challengeId, 'ENREGISTREMENT', user.id);
    let v;
    try {
      v = await verifyRegistrationResponse({
        response: input.response, expectedChallenge: ch.challenge, expectedOrigin: this.expectedOrigins(req), expectedRPID: this.config.rpId,
        requireUserVerification: true,
      });
    } catch (e) {
      this.audit(user.id, 'auth.passkey.registration_failed', 'FAILURE', { reason: e instanceof Error ? e.message : String(e) });
      throw unprocessable('PASSKEY_REGISTRATION_INVALID', `Enregistrement refusé : ${e instanceof Error ? e.message : 'réponse invalide'}.`);
    }
    if (!v.verified) throw unprocessable('PASSKEY_REGISTRATION_INVALID', 'Enregistrement refusé : attestation non vérifiée.');
    const info = v.registrationInfo;
    if (this.passkeys.get(info.credential.id)) throw conflict('PASSKEY_EXISTS', 'Clé déjà enregistrée.');
    const p = this.passkeys.insert({
      id: info.credential.id, userId: user.id, publicKey: b64u(info.credential.publicKey), counter: info.credential.counter,
      transports: info.credential.transports ?? input.response.response.transports ?? [], label: (input.label ?? 'Clé d’accès').slice(0, 60),
      aaguid: info.aaguid, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp, createdAt: this.now().toISOString(),
    });
    this.audit(user.id, 'auth.passkey.registered', 'SUCCESS', { credentialId: p.id.slice(0, 16), aaguid: p.aaguid, deviceType: p.deviceType });
    this.ctx.comms.publish('auth.passkey.registered', [userRecipient(user)], {}, { entity: user.entity });
    const { publicKey: _pk, ...rest } = p;
    return { ...rest, active: true };
  }

  async authenticationOptions(login?: string) {
    const user = login ? this.ctx.users.get(login) : undefined;
    const allow = user ? this.active(user.id).map((p) => ({ id: p.id, transports: p.transports })) : [];
    const options = await generateAuthenticationOptions({ rpID: this.config.rpId, userVerification: 'required', ...(allow.length ? { allowCredentials: allow } : {}) });
    const ch = this.newChallenge('CONNEXION', options.challenge);
    return { challengeId: ch.id, expiresAt: ch.expiresAt, options };
  }

  /** Vérifie une assertion et renvoie l'utilisateur authentifié (la session est ouverte par le fournisseur d'identité). */
  async authenticate(input: { challengeId: string; response: AuthenticationResponseJSON }, req: FastifyRequest): Promise<{ user: User; credential: PasskeyCredential }> {
    const ch = this.consume(input.challengeId, 'CONNEXION');
    const cred = this.passkeys.get(input.response.id);
    if (!cred || cred.revokedAt) {
      this.audit('inconnu', 'auth.passkey.failed', 'FAILURE', { reason: 'UNKNOWN_CREDENTIAL' });
      throw unauthorized('PASSKEY_INVALID', 'Clé d’accès inconnue ou révoquée.');
    }
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response: input.response, expectedChallenge: ch.challenge, expectedOrigin: this.expectedOrigins(req), expectedRPID: this.config.rpId,
        credential: { id: cred.id, publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')), counter: cred.counter, transports: cred.transports },
        requireUserVerification: true,
      });
    } catch (e) {
      this.audit(cred.userId, 'auth.passkey.failed', 'FAILURE', { reason: e instanceof Error ? e.message : String(e) });
      const cloned = e instanceof Error && /counter/i.test(e.message);
      if (cloned) {
        this.ctx.alerts.raise({ type: 'CLE_ACCES_CLONEE', severity: 'HIGH', source: 'socle:passkeys', detail: `Compteur de signature en régression pour une clé de ${cred.userId} : clé possiblement clonée.`, context: { userId: cred.userId, automaticEffect: 'AUCUN' } });
      }
      throw unauthorized('PASSKEY_INVALID', 'Assertion de clé d’accès invalide.');
    }
    if (!v.verified) throw unauthorized('PASSKEY_INVALID', 'Assertion de clé d’accès non vérifiée.');
    const updated = this.passkeys.update({ ...cred, counter: v.authenticationInfo.newCounter, lastUsedAt: this.now().toISOString() });
    const user = this.ctx.users.get(cred.userId);
    if (!user) throw unauthorized('PASSKEY_INVALID', 'Utilisateur inconnu.');
    return { user, credential: updated };
  }

  revoke(by: User, id: string, reason: string) {
    const p = this.passkeys.get(id);
    if (!p || p.userId !== by.id) throw notFound('PASSKEY_NOT_FOUND', 'Clé d’accès inconnue.');
    if (p.revokedAt) return { ...p, active: false };
    const out = this.passkeys.update({ ...p, revokedAt: this.now().toISOString(), revokedBy: by.id });
    this.audit(by.id, 'auth.passkey.revoked', 'SUCCESS', { credentialId: id.slice(0, 16), reason });
    const { publicKey: _pk, ...rest } = out;
    return { ...rest, active: false };
  }

  private audit(subject: string, action: string, outcome: 'SUCCESS' | 'FAILURE' | 'DENIED', details: Record<string, unknown>) {
    this.ctx.audit.append({ actor: { kind: subject === 'inconnu' ? 'public' : 'user', id: subject }, action, resourceType: 'authentication', resourceId: subject, outcome, details });
  }
}
