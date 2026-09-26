/**
 * Fournisseur d'identité local compatible OIDC (ch. 31, § 12.1) — remplace, hors démonstration, l'en-tête `x-demo-user`.
 *
 *  - Contribuable (R30) : téléphone → code à usage unique (6 chiffres, 5 min, 5 essais, empreinte seule conservée),
 *    envoyé par l'événement `auth.otp_code` (SMS / SVI ; bac à sable tant que le fournisseur n'est pas raccordé).
 *  - Compte de travail (R01–R29, R31–R37) : identifiant + mot de passe (scrypt) → TOTP (RFC 6238). MFA pour TOUT compte
 *    de travail ; pour les rôles sensibles, la clé d'accès (passkey / FIDO2) reste exigée par le document maître et est
 *    [À RACCORDER] : le jeton porte `passkey_required: true` et le niveau `acr` MFA, jamais le niveau PHR.
 *  - Jeton d'accès JWT EdDSA (15 min) lié à une session serveur (révocable, expiration absolue, appareil partagé = 30 min).
 *  - Verrouillage temporaire après 5 échecs (15 min) : mesure de sécurité automatique, sans effet sur les droits ni
 *    sur le dossier fiscal ; journalisée, notifiée à l'intéressé.
 */
import { randomUUID } from 'node:crypto';
import type { RoleCode } from '@mosolo/shared';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../../context.js';
import { ACR, isDemoMode, type AcrValue, type AuthContext, type User } from '../../core/auth.js';
import { ApiError, badRequest, forbidden, notFound, unauthorized } from '../../core/errors.js';
import { InMemoryRepository } from '../../core/repository.js';
import { userRecipient } from '../../modules/identity/recipients.js';
import {
  JwtSigner, base32Encode, hashPassword, otpauthUri, randomDigits, sha256b64u, totp, verifyPassword, verifyTotp,
  type JwtClaims, type PasswordHash,
} from './tokens.js';
import { createHash } from 'node:crypto';

export const ISSUER_DEFAULT = 'urn:mosolo:idp:local';
export const AUDIENCE = 'mosolo-api';
export const ACCESS_TOKEN_TTL_S = 15 * 60;
export const OTP_TTL_S = 5 * 60;
export const MAX_CODE_ATTEMPTS = 5;
export const MAX_PASSWORD_FAILURES = 5;
export const LOCK_MS = 15 * 60_000;
const SESSION_TTL_MS = { agent: 8 * 3_600_000, sensitive: 4 * 3_600_000, taxpayer: 12 * 3_600_000, shared: 30 * 60_000 };

/** Rôles sensibles (DM 28 § 31 : Trésor, coffre, juristes publicateurs, administrateurs, direction). */
export const SENSITIVE_ROLES: RoleCode[] = ['R01', 'R02', 'R05', 'R06', 'R13', 'R14', 'R15', 'R16', 'R17', 'R19', 'R21', 'R26', 'R27', 'R28'];

/** Mot de passe de DÉMONSTRATION des comptes de travail fictifs (jamais en production : MOSOLO_DEMO_MODE=false). */
export const DEMO_PASSWORD = 'Mosolo-Demo-2026';

export interface Credential {
  /** = identifiant de l'utilisateur de l'annuaire. */
  id: string;
  login: string;
  passwordHash?: PasswordHash;
  /** Secret TOTP en Base32. [À RACCORDER] chiffrement par le coffre de secrets (KMS/HSM). */
  totpSecret?: string;
  lastTotpStep?: number;
  failedAttempts: number;
  lockedUntil?: string;
  demo: boolean;
  createdAt: string;
}

export type ChallengeMethod = 'totp' | 'sms-otp';
export interface Challenge {
  id: string;
  /** Absent : téléphone inconnu (réponse identique, anti-énumération ; aucun code ne sera accepté). */
  userId?: string;
  method: ChallengeMethod;
  codeHash?: string;
  salt: string;
  createdAt: string;
  expiresAt: string;
  attempts: number;
  status: 'EN_ATTENTE' | 'UTILISE' | 'EXPIRE' | 'EPUISE';
  ip: string;
}

export interface Session {
  id: string;
  userId: string;
  acr: AcrValue;
  amr: string[];
  createdAt: string;
  expiresAt: string;
  sharedDevice: boolean;
  lastSeenAt: string;
  ip: string;
  userAgent: string;
  revokedAt?: string;
  revokedBy?: string;
  revokeReason?: string;
}

export interface LoginChallengeResponse {
  challengeId: string;
  method: ChallengeMethod;
  expiresAt: string;
  destination?: string;
  /** Mode démonstration uniquement : code affiché pour le parcours de démonstration (jamais en production). */
  demoCode?: string;
}

export interface TokenResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  session: PublicSession;
  user: { id: string; name: string; roles: RoleCode[]; entity: string; taxpayerId?: string };
  acr: AcrValue;
  passkeyRequired: boolean;
}

export type PublicSession = Omit<Session, 'ip' | 'userAgent'> & { current?: boolean; active: boolean };

export interface IdpOptions {
  issuer?: string;
  jwtPrivateKeyPem?: string;
  /** Semer les identifiants de démonstration (défaut : mode démonstration actif ou MOSOLO_DEMO_CREDENTIALS=true). */
  demoCredentials?: boolean;
}

/** Empreinte du mot de passe de démonstration, calculée une fois par processus (scrypt est volontairement coûteux). */
let demoHash: PasswordHash | undefined;

const isInternal = (u: User) => u.roles.some((r) => r !== 'R30');
const isSensitive = (u: User) => u.roles.some((r) => SENSITIVE_ROLES.includes(r));

export function demoTotpSecret(userId: string): string {
  // Secret déterministe de DÉMONSTRATION (connu de tous : sans valeur hors démonstration).
  return base32Encode(createHash('sha256').update(`mosolo-demo-totp:${userId}`).digest().subarray(0, 20));
}

function normalizePhone(p: string): string {
  return p.replace(/[\s.()-]/g, '');
}

function maskPhone(p: string): string {
  return p.length > 6 ? `${p.slice(0, 4)}${'•'.repeat(p.length - 6)}${p.slice(-2)}` : '••••';
}

export class IdentityProviderService {
  readonly credentials = new InMemoryRepository<Credential>();
  readonly challenges = new InMemoryRepository<Challenge>();
  readonly sessions = new InMemoryRepository<Session>();
  readonly signer: JwtSigner;
  readonly issuer: string;
  private readonly demoCredentialsEnabled: boolean;

  constructor(private readonly ctx: AppContext, opts: IdpOptions = {}) {
    this.issuer = opts.issuer ?? ISSUER_DEFAULT;
    this.signer = new JwtSigner(opts.jwtPrivateKeyPem);
    this.demoCredentialsEnabled = opts.demoCredentials ?? (isDemoMode() || process.env.MOSOLO_DEMO_CREDENTIALS === 'true');
  }

  private now(): Date {
    return this.ctx.clock.now();
  }

  // ------------------------------------------------------------------------------------------ Enrôlement (démo)

  /** Identifiants de démonstration pour les comptes de travail fictifs de l'annuaire (mot de passe + TOTP). */
  seedDemo(): void {
    if (!this.demoCredentialsEnabled) return;
    demoHash ??= hashPassword(DEMO_PASSWORD);
    const hash = demoHash;
    for (const u of this.ctx.users.all()) {
      if (!isInternal(u) || this.credentials.get(u.id)) continue;
      this.credentials.insert({
        id: u.id, login: u.id, passwordHash: hash, totpSecret: demoTotpSecret(u.id), failedAttempts: 0, demo: true,
        createdAt: this.now().toISOString(),
      });
    }
  }

  /** Enrôle (ou remplace) un facteur pour un compte de travail — utilisé par l'administration et les tests. */
  enrolWorkAccount(userId: string, password: string, totpSecret?: string): { login: string; totpSecret: string; otpauth: string } {
    const u = this.ctx.users.get(userId);
    if (!u) throw notFound('USER_NOT_FOUND', `Utilisateur inconnu : ${userId}`);
    if (!isInternal(u)) throw badRequest('NOT_A_WORK_ACCOUNT', 'Un contribuable se connecte par téléphone et code à usage unique.');
    if (password.length < 12) throw badRequest('WEAK_PASSWORD', 'Mot de passe de 12 caractères minimum.');
    const secret = totpSecret ?? base32Encode(Buffer.from(randomUUID().replace(/-/g, ''), 'hex'));
    const existing = this.credentials.get(userId);
    const cred: Credential = {
      id: userId, login: userId, passwordHash: hashPassword(password), totpSecret: secret, failedAttempts: 0, demo: false,
      createdAt: existing?.createdAt ?? this.now().toISOString(),
    };
    if (existing) this.credentials.update(cred);
    else this.credentials.insert(cred);
    return { login: userId, totpSecret: secret, otpauth: otpauthUri(secret, userId) };
  }

  // ------------------------------------------------------------------------------------------ Connexion

  /** Étape 1, compte de travail : identifiant + mot de passe → défi TOTP. */
  loginWithPassword(login: string, password: string, req: FastifyRequest): LoginChallengeResponse {
    const cred = this.credentials.findOne((c) => c.login === login);
    const user = cred ? this.ctx.users.get(cred.id) : undefined;
    const now = this.now();
    if (cred?.lockedUntil && new Date(cred.lockedUntil) > now) {
      const retryAfter = Math.ceil((new Date(cred.lockedUntil).getTime() - now.getTime()) / 1000);
      this.auditAuth('auth.login.failed', cred.id, 'DENIED', req, { reason: 'LOCKED' });
      throw new ApiError(429, 'LOGIN_TEMPORARILY_LOCKED', `Trop d'échecs : connexion suspendue temporairement (${Math.ceil(retryAfter / 60)} min). Aucune autre conséquence sur le compte.`, { retryAfter });
    }
    if (!cred || !user || !cred.passwordHash || !verifyPassword(password, cred.passwordHash)) {
      if (cred) this.recordFailure(cred, req);
      else this.auditAuth('auth.login.failed', `login:${sha256b64u(login).slice(0, 12)}`, 'FAILURE', req, { reason: 'UNKNOWN_OR_BAD_PASSWORD' });
      throw unauthorized('INVALID_CREDENTIALS', 'Identifiant ou mot de passe incorrect.');
    }
    if (!cred.totpSecret) throw forbidden('MFA_NOT_ENROLLED', 'Second facteur non enrôlé : un compte de travail exige la MFA. Contactez l’administrateur de votre entité.');
    const ch = this.newChallenge('totp', user.id, req);
    this.auditAuth('auth.password.verified', user.id, 'SUCCESS', req, { challengeId: ch.id });
    return { challengeId: ch.id, method: 'totp', expiresAt: ch.expiresAt };
  }

  /** Étape 1, contribuable : téléphone → code par SMS. Réponse identique si le numéro est inconnu (anti-énumération). */
  loginWithPhone(phoneRaw: string, req: FastifyRequest): LoginChallengeResponse {
    const phone = normalizePhone(phoneRaw);
    if (!/^\+?\d{9,15}$/.test(phone)) throw badRequest('INVALID_PHONE', 'Numéro de téléphone invalide (format international attendu, ex. +243…).');
    const tp = this.ctx.taxpayers.taxpayers.findOne((t) => t.phone === phone && t.status !== 'FUSIONNE');
    const user = tp ? this.taxpayerUser(tp.id) : undefined;
    const code = randomDigits(6);
    const ch = this.newChallenge('sms-otp', user?.id, req, code);
    if (tp && user) {
      this.ctx.comms.publish('auth.otp_code', [{ id: tp.id, kind: 'taxpayer', name: tp.fullName, lang: tp.language, prefs: {} }], { code }, { entity: 'PLATEFORME' });
      this.auditAuth('auth.otp.sent', user.id, 'SUCCESS', req, { challengeId: ch.id, channel: 'sms' });
    } else {
      this.auditAuth('auth.otp.unknown_phone', `tel:${sha256b64u(phone).slice(0, 12)}`, 'FAILURE', req, { challengeId: ch.id });
    }
    return {
      challengeId: ch.id, method: 'sms-otp', expiresAt: ch.expiresAt, destination: maskPhone(phone),
      ...(isDemoMode() ? { demoCode: code } : {}),
    };
  }

  /** Étape 2 : code (TOTP ou SMS) → session + jeton d'accès. */
  verifyCode(challengeId: string, code: string, opts: { sharedDevice?: boolean }, req: FastifyRequest): TokenResponse {
    const ch = this.challenges.get(challengeId);
    const now = this.now();
    if (!ch) throw unauthorized('CHALLENGE_INVALID', 'Défi de connexion inconnu ou expiré : recommencez.');
    if (ch.status !== 'EN_ATTENTE') throw unauthorized('CHALLENGE_INVALID', 'Défi de connexion déjà utilisé ou clos : recommencez.');
    if (new Date(ch.expiresAt) <= now) {
      this.challenges.update({ ...ch, status: 'EXPIRE' });
      throw unauthorized('CHALLENGE_EXPIRED', 'Code expiré : demandez un nouveau code.');
    }
    const attempts = ch.attempts + 1;
    const user = ch.userId ? this.ctx.users.get(ch.userId) : undefined;
    let ok = false;
    let totpStepUsed: number | null = null;
    if (user && ch.method === 'sms-otp') ok = ch.codeHash === sha256b64u(`${ch.salt}:${code}`);
    if (user && ch.method === 'totp') {
      const cred = this.credentials.get(user.id);
      totpStepUsed = cred?.totpSecret ? verifyTotp(cred.totpSecret, code, now) : null;
      // Anti-rejeu : un pas TOTP déjà consommé est refusé.
      ok = totpStepUsed !== null && (cred?.lastTotpStep === undefined || totpStepUsed > cred.lastTotpStep);
    }
    if (!ok) {
      const exhausted = attempts >= MAX_CODE_ATTEMPTS;
      this.challenges.update({ ...ch, attempts, status: exhausted ? 'EPUISE' : 'EN_ATTENTE' });
      if (user && ch.method === 'totp') {
        const cred = this.credentials.get(user.id);
        if (cred) this.recordFailure(cred, req);
      }
      this.auditAuth('auth.login.failed', user?.id ?? 'inconnu', 'FAILURE', req, { reason: 'BAD_CODE', method: ch.method, attempts });
      throw unauthorized(exhausted ? 'CHALLENGE_EXHAUSTED' : 'INVALID_CODE', exhausted ? 'Nombre maximal d’essais atteint : recommencez la connexion.' : 'Code incorrect.');
    }
    this.challenges.update({ ...ch, attempts, status: 'UTILISE' });
    if (ch.method === 'totp') {
      const cred = this.credentials.get(user!.id)!;
      this.credentials.update({ ...cred, lastTotpStep: totpStepUsed!, failedAttempts: 0, lockedUntil: undefined });
    }
    const acr: AcrValue = ch.method === 'totp' ? ACR.MFA : ACR.OTP;
    const amr = ch.method === 'totp' ? ['pwd', 'otp', 'mfa'] : ['sms', 'otp'];
    return this.openSession(user!, acr, amr, opts.sharedDevice === true, req);
  }

  private openSession(user: User, acr: AcrValue, amr: string[], sharedDevice: boolean, req: FastifyRequest): TokenResponse {
    const now = this.now();
    const ttl = sharedDevice ? SESSION_TTL_MS.shared : !isInternal(user) ? SESSION_TTL_MS.taxpayer : isSensitive(user) ? SESSION_TTL_MS.sensitive : SESSION_TTL_MS.agent;
    const session: Session = {
      id: `SES-${randomUUID()}`, userId: user.id, acr, amr, createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl).toISOString(), sharedDevice, lastSeenAt: now.toISOString(),
      ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200),
    };
    this.sessions.insert(session);
    this.auditAuth('auth.login.success', user.id, 'SUCCESS', req, { sessionId: session.id, acr, amr, sharedDevice });
    return this.issueToken(user, session);
  }

  private issueToken(user: User, session: Session): TokenResponse {
    const now = this.now();
    const iat = Math.floor(now.getTime() / 1000);
    const exp = Math.min(iat + ACCESS_TOKEN_TTL_S, Math.floor(new Date(session.expiresAt).getTime() / 1000));
    const passkeyRequired = isSensitive(user);
    const claims: JwtClaims = {
      iss: this.issuer, aud: AUDIENCE, sub: user.id, sid: session.id, jti: randomUUID(), iat, exp,
      auth_time: Math.floor(new Date(session.createdAt).getTime() / 1000), acr: session.acr, amr: session.amr,
      name: user.name, roles: user.roles, entity: user.entity,
      ...(user.territory ? { territory: user.territory } : {}),
      ...(user.taxpayerId ? { taxpayer_id: user.taxpayerId } : {}),
      ...(passkeyRequired ? { passkey_required: true } : {}),
    };
    return {
      accessToken: this.signer.sign(claims), tokenType: 'Bearer', expiresIn: exp - iat, session: this.publicSession(session),
      user: { id: user.id, name: user.name, roles: user.roles, entity: user.entity, ...(user.taxpayerId ? { taxpayerId: user.taxpayerId } : {}) },
      acr: session.acr, passkeyRequired,
    };
  }

  /** Vérificateur enregistré auprès de l'annuaire (core/auth.ts) : signature, émetteur, audience, expiration, session. */
  verifyAccessToken(token: string): User {
    const claims = this.signer.verify(token);
    if (!claims || claims.iss !== this.issuer || claims.aud !== AUDIENCE || typeof claims.sub !== 'string' || typeof claims.sid !== 'string') {
      throw unauthorized('TOKEN_INVALID', 'Jeton de session invalide.');
    }
    const nowS = Math.floor(this.now().getTime() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp <= nowS) throw unauthorized('TOKEN_EXPIRED', 'Jeton de session expiré : reconnectez-vous ou renouvelez la session.');
    const session = this.sessions.get(claims.sid);
    if (!session || session.userId !== claims.sub) throw unauthorized('SESSION_UNKNOWN', 'Session inconnue.');
    if (session.revokedAt) throw unauthorized('SESSION_REVOKED', 'Session révoquée : reconnectez-vous.');
    if (new Date(session.expiresAt).getTime() <= this.now().getTime()) throw unauthorized('SESSION_EXPIRED', 'Session expirée : reconnectez-vous.');
    const tpId = typeof claims.taxpayer_id === 'string' ? claims.taxpayer_id : undefined;
    const user = this.ctx.users.get(claims.sub) ?? (tpId && claims.sub === `u-tp-${tpId}` ? this.taxpayerUser(tpId) : undefined);
    if (!user) throw unauthorized('TOKEN_INVALID', 'Utilisateur inconnu.');
    const auth: AuthContext = {
      method: 'bearer', sessionId: session.id, acr: session.acr, amr: session.amr, authTime: session.createdAt,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
    };
    return { ...user, auth };
  }

  /** Renouvelle le jeton d'accès d'une session active (hors appareil partagé : reconnexion exigée). */
  refresh(user: User): TokenResponse {
    const s = this.requireOwnSession(user);
    if (s.sharedDevice) throw forbidden('SHARED_DEVICE_NO_REFRESH', 'Appareil partagé : la session n’est pas prolongée, reconnectez-vous.');
    this.sessions.update({ ...s, lastSeenAt: this.now().toISOString() });
    return this.issueToken(user, s);
  }

  logout(user: User, req: FastifyRequest): PublicSession {
    const s = this.requireOwnSession(user);
    return this.revoke(s.id, user, 'Déconnexion', req);
  }

  revoke(sessionId: string, by: User, reason: string, req: FastifyRequest): PublicSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw notFound('SESSION_NOT_FOUND', `Session inconnue : ${sessionId}`);
    if (s.revokedAt) return this.publicSession(s);
    const revoked: Session = { ...s, revokedAt: this.now().toISOString(), revokedBy: by.id, revokeReason: reason };
    this.sessions.update(revoked);
    this.auditAuth('auth.session.revoked', by.id, 'SUCCESS', req, { sessionId, owner: s.userId, reason });
    if (by.id !== s.userId) {
      const owner = this.ctx.users.get(s.userId);
      if (owner) this.ctx.comms.publish('auth.device.revoked', [userRecipient(owner)], {}, { entity: owner.entity });
    }
    return this.publicSession(revoked);
  }

  sessionsOf(userId: string, currentSid?: string): PublicSession[] {
    return this.sessions.find((s) => s.userId === userId).map((s) => ({ ...this.publicSession(s), current: s.id === currentSid }));
  }

  publicSession(s: Session): PublicSession {
    const { ip: _ip, userAgent: _ua, ...rest } = s;
    return { ...rest, active: !s.revokedAt && new Date(s.expiresAt) > this.now() };
  }

  private requireOwnSession(user: User): Session {
    if (!user.auth) throw unauthorized('BEARER_REQUIRED', 'Cette opération exige un jeton de session (Authorization: Bearer).');
    const s = this.sessions.get(user.auth.sessionId);
    if (!s) throw unauthorized('SESSION_UNKNOWN', 'Session inconnue.');
    return s;
  }

  /**
   * Compte d'accès du contribuable (R30) : celui de l'annuaire s'il existe, sinon créé à la volée pour un contribuable
   * inscrit (POST /v1/registrations) — identifiant `u-tp-<id>`, entité PUBLIC, périmètre : son seul dossier.
   */
  taxpayerUser(taxpayerId: string): User | undefined {
    const existing = this.ctx.users.all().find((u) => u.taxpayerId === taxpayerId && u.roles.includes('R30'));
    if (existing) return existing;
    const tp = this.ctx.taxpayers.taxpayers.get(taxpayerId);
    if (!tp || tp.status === 'FUSIONNE') return undefined;
    return this.ctx.users.add({ id: `u-tp-${tp.id}`, name: tp.fullName, roles: ['R30'], entity: 'PUBLIC', taxpayerId: tp.id, lang: tp.language });
  }

  // ------------------------------------------------------------------------------------------ Démonstration

  /** Comptes de démonstration (mode démo uniquement) : secret TOTP et code courant pour le parcours de démonstration. */
  demoAccounts() {
    if (!isDemoMode()) throw notFound('ROUTE_NOT_FOUND', 'Indisponible hors mode démonstration.');
    const now = this.now();
    const agents = this.credentials.find((c) => c.demo).map((c) => {
      const u = this.ctx.users.get(c.id)!;
      return {
        login: c.login, name: u.name, roles: u.roles, entity: u.entity, sensitive: isSensitive(u),
        totpSecret: c.totpSecret!, otpauth: otpauthUri(c.totpSecret!, c.login), currentCode: totp(c.totpSecret!, now),
      };
    });
    const taxpayers = this.ctx.users.all().filter((u) => u.roles.includes('R30') && u.taxpayerId).flatMap((u) => {
      const tp = this.ctx.taxpayers.taxpayers.get(u.taxpayerId!);
      return tp ? [{ userId: u.id, name: u.name, phone: tp.phone }] : [];
    });
    return { demo: true, password: DEMO_PASSWORD, agents, taxpayers, notice: 'Identifiants FICTIFS de démonstration — désactivés lorsque MOSOLO_DEMO_MODE=false.' };
  }

  // ------------------------------------------------------------------------------------------ Interne

  private newChallenge(method: ChallengeMethod, userId: string | undefined, req: FastifyRequest, code?: string): Challenge {
    const now = this.now();
    const salt = randomUUID();
    const ch: Challenge = {
      id: `CHL-${randomUUID()}`, ...(userId ? { userId } : {}), method,
      ...(code ? { codeHash: sha256b64u(`${salt}:${code}`) } : {}), salt,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + OTP_TTL_S * 1000).toISOString(),
      attempts: 0, status: 'EN_ATTENTE', ip: req.ip,
    };
    this.challenges.insert(ch);
    return ch;
  }

  private recordFailure(cred: Credential, req: FastifyRequest): void {
    const failed = cred.failedAttempts + 1;
    const lock = failed >= MAX_PASSWORD_FAILURES;
    this.credentials.update({
      ...cred, failedAttempts: lock ? 0 : failed,
      ...(lock ? { lockedUntil: new Date(this.now().getTime() + LOCK_MS).toISOString() } : {}),
    });
    this.auditAuth('auth.login.failed', cred.id, 'FAILURE', req, { failedAttempts: failed, locked: lock });
    if (lock) {
      const u = this.ctx.users.get(cred.id);
      if (u) this.ctx.comms.publish('auth.login.suspicious', [userRecipient(u)], {}, { entity: u.entity });
      this.auditAuth('auth.login.locked', cred.id, 'DENIED', req, { lockedMinutes: LOCK_MS / 60_000 });
    }
  }

  private auditAuth(action: string, subject: string, outcome: 'SUCCESS' | 'DENIED' | 'FAILURE', req: FastifyRequest, details: Record<string, unknown>): void {
    this.ctx.audit.append({
      actor: { kind: subject.includes(':') || subject === 'inconnu' ? 'public' : 'user', id: subject },
      action, resourceType: 'authentication', resourceId: subject, outcome,
      details: { ...details, ip: req.ip },
    });
  }
}
