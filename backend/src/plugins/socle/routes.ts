import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { ACR, isDemoMode, requireAcr, requireUser } from '../../core/auth.js';
import { badRequest, unprocessable } from '../../core/errors.js';
import { parse } from '../../core/http.js';
import { authorize, definePolicy, GRANTS, hasAnyGrant } from '../../core/policy.js';
import { rowsInScope, watermarkFor } from './exports.js';
import { mtlsStatus } from './mtls.js';
import { createBackup } from '../../persistence/backup.js';
import { collectRows } from '../../persistence/registry.js';
import type { SnapshotRow } from '../../persistence/store.js';
import type { SocleService } from './plugin.js';
import { ACCESS_TOKEN_TTL_S, AUDIENCE, SENSITIVE_ROLES } from './service.js';

definePolicy('socle:status.read', { R22: GRANTS.always, R26: GRANTS.always, R27: GRANTS.always, R28: GRANTS.always });
definePolicy('socle:session.revoke', { R28: GRANTS.always });
definePolicy('socle:export', { R26: GRANTS.always, R27: GRANTS.always });
// Extraction massive (§ 12.3) : responsable des données = délégué à la protection des données (R25) ; comité des
// données : Cabinet (R02), Secrétariat général (R03), ministre des Finances (R05) — composition à confirmer.
definePolicy('socle:export.data_owner', { R25: GRANTS.always });
definePolicy('socle:export.committee', { R02: GRANTS.always, R03: GRANTS.always, R05: GRANTS.always });

const loginSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('password'), login: z.string().min(1).max(120), password: z.string().min(1).max(200),
    // Secours TOTP d'un rôle sensible détenteur d'une clé d'accès : motif obligatoire (journalisé, alerté).
    fallbackReason: z.string().trim().max(300).optional(),
  }).strict(),
  z.object({ method: z.literal('phone'), phone: z.string().min(6).max(24) }).strict(),
]);
const otpSchema = z.object({
  challengeId: z.string().min(8).max(80),
  code: z.string().regex(/^\d{6}$/, 'code à 6 chiffres attendu'),
  sharedDevice: z.boolean().optional(),
}).strict();
const revokeSchema = z.object({ reason: z.string().trim().min(5, 'motif obligatoire (5 caractères minimum)').max(300) }).strict();

/**
 * Minimisation de l'export HTTP : les secrets d'authentification n'en sortent jamais (empreintes de mot de passe et de
 * PIN, secrets TOTP, clés des terminaux, empreintes de codes et de jetons, boîte d'envoi du bac à sable). Un export
 * permettrait sinon de se connecter à la place de n'importe quel agent. La sauvegarde complète de la base passe par
 * l'outil d'exploitation (backup-cli), serveur arrêté, sous un rôle distinct.
 */
const SECRET_FIELDS = ['passwordHash', 'totpSecret', 'codeHash', 'tokenHash'];
const SECRET_FIELDS_BY_REPO: Record<string, string[]> = {
  'field.devices': ['key'],
  'ext.canaux.cards.pins': ['salt', 'hash'],
  'ext.socle.idp.challenges': ['salt'],
  'ext.acces.outbox': ['text'],
  // Paquets d'extraction massive (chiffrés) et défis WebAuthn : jamais recopiés dans un export.
  'ext.socle.bulk.requests': ['sealed'],
  'ext.socle.passkeys.webauthnChallenges': ['challenge'],
  // « Clés et raccordements » (29/09/2026) : valeurs chiffrées de la console, jamais recopiées dans un export.
  'integrations.values': ['blob'],
  'integrations.proposals': ['blob'],
};
export function redactExportRows(rows: SnapshotRow[]): { rows: SnapshotRow[]; redacted: string[] } {
  const redacted = new Set<string>();
  const out = rows.map((r) => {
    if (!r.doc || typeof r.doc !== 'object' || Array.isArray(r.doc)) return r;
    const fields = [...SECRET_FIELDS, ...(SECRET_FIELDS_BY_REPO[r.repo] ?? [])];
    const doc = r.doc as Record<string, unknown>;
    if (!fields.some((f) => f in doc)) return r;
    const copy: Record<string, unknown> = { ...doc };
    for (const f of fields) {
      if (f in copy) {
        delete copy[f];
        redacted.add(`${r.repo}.${f}`);
      }
    }
    return { ...r, doc: copy };
  });
  return { rows: out, redacted: [...redacted].sort() };
}

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
    acr_values_supported: [ACR.OTP, ACR.MFA, ACR.PHR],
    // Conservé pour compatibilité : le niveau PHR (clé d'accès FIDO2) est désormais émis.
    acr_values_planned: [ACR.PHR],
    mosolo_passkey_endpoints: { registration: '/v1/auth/passkeys/registration', authentication: '/v1/auth/passkeys/authentication/options' },
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
    return body.method === 'password' ? idp.loginWithPassword(body.login, body.password, req, body.fallbackReason) : idp.loginWithPhone(body.phone, req);
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
      ...(u.modules ? { modules: u.modules } : {}),
      ...(u.taxpayerId ? { taxpayerId: u.taxpayerId } : {}),
      mode: u.auth ? 'session' : 'demonstration',
      auth: u.auth ?? null,
      passkeyRequired: u.roles.some((r) => SENSITIVE_ROLES.includes(r)),
      // Historique « A_RACCORDER » remplacé : ACTIVE (au moins une clé) ou A_ENREGISTRER.
      passkeyStatus: svc.passkeys.active(u.id).length > 0 ? 'ACTIVE' : 'A_ENREGISTRER',
      passkeys: svc.passkeys.active(u.id).length,
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

  // ---------------------------------------------------------------- Clés d'accès (WebAuthn / FIDO2, § 31)
  app.get('/v1/auth/passkeys', async (req) => {
    const u = requireUser(req);
    return {
      status: 'RACCORDE',
      required: u.roles.some((r) => SENSITIVE_ROLES.includes(r)),
      enforced: idp.passkeyEnforced(u),
      registered: svc.passkeys.list(u),
      rpId: svc.passkeys.config.rpId,
      detail: 'Clés d’accès WebAuthn : attestation « none », vérification de l’origine, de l’identifiant de partie de confiance, de la présence et de l’identité de l’utilisateur, compteur de signature. Rôles sensibles : TOTP en secours motivé.',
    };
  });
  /** Étape 1 de l'enregistrement : session de travail authentifiée au niveau MFA (mot de passe + TOTP) ou PHR. */
  app.post('/v1/auth/passkeys/registration', async (req) => {
    const u = requireUser(req);
    if (!u.roles.some((r) => r !== 'R30')) throw unprocessable('NOT_A_WORK_ACCOUNT', 'Les clés d’accès sont proposées aux comptes de travail.');
    requireAcr(u, ACR.MFA);
    return svc.passkeys.registrationOptions(u);
  });
  app.post('/v1/auth/passkeys/registration/verify', async (req, reply) => {
    const u = requireUser(req);
    requireAcr(u, ACR.MFA);
    const b = parse(z.object({ challengeId: z.string().min(8).max(80), response: z.record(z.unknown()), label: z.string().trim().max(60).optional() }).strict(), req.body);
    return reply.code(201).send(await svc.passkeys.register(u, { challengeId: b.challengeId, response: b.response as never, ...(b.label ? { label: b.label } : {}) }, req));
  });
  app.post('/v1/auth/passkeys/authentication/options', async (req) => {
    const b = parse(z.object({ login: z.string().trim().min(1).max(120).optional() }).strict(), req.body ?? {});
    return svc.passkeys.authenticationOptions(b.login);
  });
  app.post('/v1/auth/passkeys/authentication/verify', async (req) => {
    const b = parse(z.object({ challengeId: z.string().min(8).max(80), response: z.record(z.unknown()) }).strict(), req.body);
    const { user, credential } = await svc.passkeys.authenticate({ challengeId: b.challengeId, response: b.response as never }, req);
    return idp.loginWithPasskey(user, credential.id, req);
  });
  app.post<{ Params: { id: string } }>('/v1/auth/passkeys/:id/revoke', async (req) => {
    const u = requireUser(req);
    requireAcr(u, ACR.MFA);
    return svc.passkeys.revoke(u, req.params.id, parse(revokeSchema, req.body ?? { reason: 'Révocation par l’utilisateur' }).reason);
  });

  // ---------------------------------------------------------------- Démonstration
  app.get('/v1/auth/demo-accounts', async () => idp.demoAccounts());

  // ---------------------------------------------------------------- État du socle et export signé
  app.get('/v1/socle/status', async (req) => {
    const u = requireUser(req);
    authorize(u, 'socle:status.read', {});
    return {
      demoMode: isDemoMode(),
      authentication: { issuer: idp.issuer, bearer: true, demoHeader: isDemoMode(), passkeys: 'RACCORDE', passkeysRegistered: svc.passkeys.passkeys.find((p) => !p.revokedAt).length },
      mtls: mtlsStatus(svc.mtls),
      bulkExports: { threshold: svc.bulk.threshold(), pending: svc.bulk.requests.find((r) => r.status === 'DEMANDEE' || r.status === 'VISA_DONNEES').length },
      rateLimit: svc.rateLimit,
      persistence: svc.persistence?.status() ?? { store: 'memoire', attached: false, detail: 'DATABASE_URL absente : stockage en mémoire.' },
      sessions: { active: idp.sessions.find((s) => !s.revokedAt && new Date(s.expiresAt) > ctx.clock.now()).length },
    };
  });

  /** Export complet signé de l'état (réversibilité, C4-211). Données personnelles : rôles d'exploitation, MFA, audit. */
  app.post('/v1/socle/exports', async (req, reply) => {
    const u = requireUser(req);
    authorize(u, 'socle:export', {});
    requireAcr(u, ACR.MFA);
    const body = (req.body ?? {}) as { reason?: unknown; repos?: unknown; finalite?: unknown };
    if (typeof body.reason !== 'string' || body.reason.trim().length < 5) throw badRequest('REASON_REQUIRED', 'Motif obligatoire pour un export complet (5 caractères minimum).');
    const repos = Array.isArray(body.repos) ? body.repos.filter((r): r is string => typeof r === 'string' && r.length > 0 && r.length < 120).slice(0, 100) : undefined;
    const envKey = process.env.MOSOLO_BACKUP_KEY;
    if (!envKey && !isDemoMode()) throw unprocessable('BACKUP_KEY_MISSING', 'MOSOLO_BACKUP_KEY absente : export signé impossible.');
    const key = envKey ?? 'demo-backup-key-NON-PRODUCTION';
    const { rows: allRows, redacted } = redactExportRows(collectRows(ctx));
    const rows = rowsInScope(allRows, repos);
    // Extraction MASSIVE (au-delà du seuil du registre) : circuit à trois visas, paquet chiffré, filigrané, expirant.
    const threshold = svc.bulk.threshold();
    if (rows.length > threshold) {
      const request = svc.bulk.create(u, { reason: body.reason, ...(typeof body.finalite === 'string' ? { finalite: body.finalite } : {}), ...(repos ? { repos } : {}) }, rows.length);
      return reply.code(202).send({
        status: 'VISAS_REQUIS', rows: rows.length, threshold, request,
        detail: `Extraction massive (${rows.length} lignes > ${threshold}) : visa du responsable des données puis décision du comité des données requis.`,
      });
    }
    ctx.audit.append({
      actor: { kind: 'user', id: u.id, roles: u.roles }, action: 'socle.export.created', resourceType: 'backup', outcome: 'SUCCESS',
      details: { reason: body.reason.trim(), rows: rows.length, threshold, ...(repos ? { repos } : {}) },
    });
    const doc = createBackup(rows, key, { source: svc.persistence ? 'application+postgresql' : 'application', now: ctx.clock.now() });
    // Filigrane (§ 31.1) : demandeur et heure, lié au contenu par signature.
    const wm = svc.bulk.newWatermark(u, `EXP-${doc.contentSha256.slice(0, 12)}`);
    return { ...doc, demoKey: !envKey, redacted, ...watermarkFor(doc, wm, key) };
  });

  // ---------------------------------------------------------------- Extraction massive à trois visas (§ 12.3)
  app.get('/v1/socle/exports/requests', async (req) => {
    const u = requireUser(req);
    if (!hasAnyGrant(u, 'socle:export') && !hasAnyGrant(u, 'socle:export.data_owner') && !hasAnyGrant(u, 'socle:export.committee') && !u.roles.some((r) => ['R22', 'R23', 'R28'].includes(r))) {
      authorize(u, 'socle:export', {});
    }
    return { items: svc.bulk.list(u), threshold: svc.bulk.threshold() };
  });
  app.post('/v1/socle/exports/requests', async (req, reply) => {
    const u = requireUser(req);
    const b = parse(z.object({ reason: z.string().trim().min(5).max(1000), finalite: z.string().trim().min(5).max(1000).optional(), repos: z.array(z.string().min(1).max(120)).max(100).optional() }).strict(), req.body);
    return reply.code(201).send(svc.bulk.create(u, b));
  });
  const decisionSchema = z.object({ approve: z.boolean(), motif: z.string().trim().min(5).max(1000) }).strict();
  app.post<{ Params: { id: string } }>('/v1/socle/exports/requests/:id/data-owner', async (req) => svc.bulk.dataOwnerDecision(requireUser(req), req.params.id, parse(decisionSchema, req.body)));
  app.post<{ Params: { id: string } }>('/v1/socle/exports/requests/:id/committee', async (req) => svc.bulk.committeeDecision(requireUser(req), req.params.id, parse(decisionSchema, req.body)));
  app.post<{ Params: { id: string } }>('/v1/socle/exports/requests/:id/package', async (req) => {
    const b = parse(z.object({ passphrase: z.string().min(12).max(200) }).strict(), req.body);
    return svc.bulk.package(requireUser(req), req.params.id, b.passphrase);
  });
  app.post<{ Params: { id: string } }>('/v1/socle/exports/requests/:id/withdraw', async (req) => svc.bulk.withdraw(requireUser(req), req.params.id));
}
