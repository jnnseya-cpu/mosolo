import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { ACR, isDemoMode, requireAcr, requireUser } from '../../core/auth.js';
import { ApiError, badRequest, unprocessable } from '../../core/errors.js';
import { parse } from '../../core/http.js';
import { authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { createBackup } from '../../persistence/backup.js';
import { collectRows } from '../../persistence/registry.js';
import type { SocleService } from './plugin.js';
import { ACCESS_TOKEN_TTL_S, AUDIENCE, SENSITIVE_ROLES } from './service.js';

definePolicy('socle:status.read', { R22: GRANTS.always, R26: GRANTS.always, R27: GRANTS.always, R28: GRANTS.always });
definePolicy('socle:session.revoke', { R28: GRANTS.always });
definePolicy('socle:export', { R26: GRANTS.always, R27: GRANTS.always });

const loginSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('password'), login: z.string().min(1).max(120), password: z.string().min(1).max(200) }).strict(),
  z.object({ method: z.literal('phone'), phone: z.string().min(6).max(24) }).strict(),
]);
const otpSchema = z.object({
  challengeId: z.string().min(8).max(80),
  code: z.string().regex(/^\d{6}$/, 'code à 6 chiffres attendu'),
  sharedDevice: z.boolean().optional(),
}).strict();
const revokeSchema = z.object({ reason: z.string().trim().min(5, 'motif obligatoire (5 caractères minimum)').max(300) }).strict();

export function registerSocleRoutes(app: FastifyInstance, ctx: AppContext, svc: SocleService): void {
  const idp = svc.idp;

  // ---------------------------------------------------------------- Découverte OIDC minimale + clés publiques
  app.get('/.well-known/openid-configuration', async () => ({
    issuer: idp.issuer,
    jwks_uri: '/.well-known/jwks.json',
    userinfo_endpoint: '/v1/auth/me',
    end_session_endpoint: '/v1/auth/logout',
    // Flux direct de première partie (application MOSOLO) ; « authorization code + PKCE » : [À RACCORDER] via l'IdP souverain.
    authorization_endpoint: null,
    token_endpoint: null,
    mosolo_login_endpoint: '/v1/auth/login',
    mosolo_code_endpoint: '/v1/auth/otp',
    mosolo_refresh_endpoint: '/v1/auth/refresh',
    response_types_supported: [],
    grant_types_supported: [],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['EdDSA'],
    token_endpoint_auth_methods_supported: ['none'],
    acr_values_supported: [ACR.OTP, ACR.MFA],
    acr_values_planned: [ACR.PHR],
    amr_values_supported: ['pwd', 'otp', 'mfa', 'sms'],
    claims_supported: ['sub', 'sid', 'name', 'roles', 'entity', 'territory', 'taxpayer_id', 'acr', 'amr', 'auth_time', 'passkey_required'],
    audience: AUDIENCE,
    access_token_ttl_seconds: ACCESS_TOKEN_TTL_S,
    mosolo_conformance: 'Minimale : fournisseur local compatible OIDC (jetons EdDSA, JWKS, userinfo). Cible : IdP souverain OIDC (Keycloak) avec clés d’accès WebAuthn — [À RACCORDER].',
    mosolo_demo_mode: isDemoMode(),
  }));

  app.get('/.well-known/jwks.json', async () => idp.signer.jwks());

  // ---------------------------------------------------------------- Connexion
  app.post('/v1/auth/login', async (req) => {
    const body = parse(loginSchema, req.body);
    return body.method === 'password' ? idp.loginWithPassword(body.login, body.password, req) : idp.loginWithPhone(body.phone, req);
  });

  app.post('/v1/auth/otp', async (req) => {
    const body = parse(otpSchema, req.body);
    return idp.verifyCode(body.challengeId, body.code, { sharedDevice: body.sharedDevice }, req);
  });

  app.post('/v1/auth/refresh', async (req) => idp.refresh(requireUser(req)));

  app.post('/v1/auth/logout', async (req) => ({ revoked: true, session: idp.logout(requireUser(req), req) }));

  /** Userinfo : profil minimal de l'utilisateur courant et contexte d'authentification. */
  app.get('/v1/auth/me', async (req) => {
    const u = requireUser(req);
    return {
      sub: u.id, name: u.name, roles: u.roles, entity: u.entity,
      ...(u.territory ? { territory: u.territory } : {}),
      ...(u.taxpayerId ? { taxpayerId: u.taxpayerId } : {}),
      mode: u.auth ? 'session' : 'demonstration',
      auth: u.auth ?? null,
      passkeyRequired: u.roles.some((r) => SENSITIVE_ROLES.includes(r)),
      passkeyStatus: 'A_RACCORDER',
    };
  });

  app.get('/v1/auth/sessions', async (req) => {
    const u = requireUser(req);
    return { items: idp.sessionsOf(u.id, u.auth?.sessionId) };
  });

  /** Révocation : sa propre session, ou toute session par le responsable sécurité (R28) avec motif. */
  app.post('/v1/auth/sessions/:id/revoke', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    const body = parse(revokeSchema, req.body ?? { reason: 'Révocation par l’utilisateur' });
    const target = idp.sessions.get(id);
    if (!target || target.userId !== u.id) {
      authorize(u, 'socle:session.revoke', {});
      requireAcr(u, ACR.MFA);
    }
    return idp.revoke(id, u, body.reason, req);
  });

  // ---------------------------------------------------------------- Clés d'accès (WebAuthn) — [À RACCORDER]
  app.get('/v1/auth/passkeys', async (req) => {
    const u = requireUser(req);
    return {
      status: 'A_RACCORDER',
      required: u.roles.some((r) => SENSITIVE_ROLES.includes(r)),
      registered: [],
      detail: 'Enregistrement WebAuthn non raccordé : il sera fourni par l’IdP souverain (vérification d’attestation, compteur de signature, liaison appareil). Aucune clé n’est simulée.',
    };
  });
  app.post('/v1/auth/passkeys/registration', async (req) => {
    requireUser(req);
    throw new ApiError(501, 'PASSKEY_NOT_WIRED', 'Enregistrement de clé d’accès (WebAuthn) [À RACCORDER] : non disponible dans ce socle ; aucune clé n’est simulée.');
  });

  // ---------------------------------------------------------------- Démonstration
  app.get('/v1/auth/demo-accounts', async () => idp.demoAccounts());

  // ---------------------------------------------------------------- État du socle et export signé
  app.get('/v1/socle/status', async (req) => {
    const u = requireUser(req);
    authorize(u, 'socle:status.read', {});
    return {
      demoMode: isDemoMode(),
      authentication: { issuer: idp.issuer, bearer: true, demoHeader: isDemoMode(), passkeys: 'A_RACCORDER' },
      rateLimit: svc.rateLimit,
      persistence: svc.persistence?.status() ?? { store: 'memoire', attached: false, detail: 'DATABASE_URL absente : stockage en mémoire.' },
      sessions: { active: idp.sessions.find((s) => !s.revokedAt && new Date(s.expiresAt) > ctx.clock.now()).length },
    };
  });

  /** Export complet signé de l'état (réversibilité, C4-211). Données personnelles : rôles d'exploitation, MFA, audit. */
  app.post('/v1/socle/exports', async (req) => {
    const u = requireUser(req);
    authorize(u, 'socle:export', {});
    requireAcr(u, ACR.MFA);
    const body = (req.body ?? {}) as { reason?: unknown };
    if (typeof body.reason !== 'string' || body.reason.trim().length < 5) throw badRequest('REASON_REQUIRED', 'Motif obligatoire pour un export complet (5 caractères minimum).');
    const envKey = process.env.MOSOLO_BACKUP_KEY;
    if (!envKey && !isDemoMode()) throw unprocessable('BACKUP_KEY_MISSING', 'MOSOLO_BACKUP_KEY absente : export signé impossible.');
    const key = envKey ?? 'demo-backup-key-NON-PRODUCTION';
    ctx.audit.append({
      actor: { kind: 'user', id: u.id, roles: u.roles }, action: 'socle.export.created', resourceType: 'backup', outcome: 'SUCCESS',
      details: { reason: body.reason.trim() },
    });
    const doc = createBackup(collectRows(ctx), key, { source: svc.persistence ? 'application+postgresql' : 'application', now: ctx.clock.now() });
    return { ...doc, demoKey: !envKey };
  });
}
