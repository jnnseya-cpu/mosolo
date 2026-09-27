/** Routes HTTP du module « acces » (préfixe /v1/acces). Toute décision d'accès passe par `authorize`. */
import { LANGUAGE_CODES, ROLES, type RoleCode } from '@mosolo/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { isDemoMode, requireUser } from '../../core/auth.js';
import { conflict, notFound } from '../../core/errors.js';
import { isoDateString, parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import {
  ACCESS_LEVELS, CHANNELS, CONSULTATION_PURPOSES, ENTITY_KIND_LABELS, ENTITY_KINDS, LEGAL_FORMS, LEVEL_INFO, LEVEL_RIGHTS, MANDATE_ACTIONS,
  PROOF_MECHANISMS, PROOF_TYPES, ROLE_LEVEL, SENSITIVE_ROLES, TAXABLE_FACTS, VALIDITY_MODELS,
} from './model.js';
import { ACCES } from './policy.js';
import type { AccesService } from './service.js';

const roleCode = z.enum(Object.keys(ROLES) as [RoleCode, ...RoleCode[]]);
const phone = z.string().regex(/^\+?[0-9 -]{9,20}$/, 'numéro de téléphone invalide');
const motif = z.string().trim().min(5, 'motif obligatoire').max(500);
const language = z.enum(LANGUAGE_CODES as [string, ...string[]]);
const code6 = z.string().regex(/^\d{6}$/, 'code à 6 chiffres attendu');
const idDocument = z.object({
  type: z.string().trim().min(2).max(40), number: z.string().trim().min(3).max(40),
  // Date de naissance portée par la pièce : détection des comptes multiples d'une même personne (nom + date).
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date AAAA-MM-JJ').optional(),
}).strict();

const entitySchema = z.object({
  id: z.string().regex(/^[A-Z0-9-]{2,32}$/, 'code d’entité en majuscules (A-Z, 0-9, -)'),
  name: z.string().trim().min(3).max(160),
  shortName: z.string().trim().min(2).max(40),
  kind: z.enum(ENTITY_KINDS),
  parentId: z.string().nullable(),
  decisionRef: z.string().trim().min(3, 'référence de la décision écrite du Comité de pilotage requise').max(200),
}).strict();

const moduleSchema = z.object({
  code: z.string().regex(/^[A-Z0-9-]{3,40}$/),
  label: z.string().trim().min(3).max(160),
  revenueScope: z.string().regex(/^[A-Z0-9_]{3,40}$/),
  responsibleEntity: z.string().min(2),
  moduleManagerId: z.string().optional(),
  beneficiaryAliases: z.array(z.string().min(3)).max(5).default([]),
  objectTypes: z.array(z.string().min(2)).max(20).default([]),
  ruleCodes: z.array(z.string().min(2)).max(30).default([]),
  credentialTypes: z.array(z.string().min(2)).max(20).default([]),
  validityModel: z.enum(VALIDITY_MODELS).default('SANS_TITRE'),
  proofMechanisms: z.array(z.enum(PROOF_MECHANISMS)).max(10).default([]),
  usageRules: z.string().max(500).default(''),
  channels: z.array(z.enum(CHANNELS)).max(10).default([]),
  fieldWorkflows: z.array(z.string()).max(20).default([]),
  dashboards: z.array(z.string()).max(20).default([]),
  dependencies: z.array(z.string()).max(20).default([]),
  sharedReadWith: z.array(z.string()).max(20).default([]),
  actReferences: z.array(z.string()).max(20).default([]),
}).strict();

const invitationSchema = z.object({
  fullName: z.string().trim().min(3).max(120),
  phone,
  email: z.string().email().optional(),
  entity: z.string().min(2),
  accessLevel: z.enum(ACCESS_LEVELS),
  roles: z.array(roleCode).min(1).max(4),
  scope: z.object({
    territory: z.array(z.string()).max(24).optional(),
    modules: z.array(z.string()).max(20).optional(),
    validUntil: isoDateString.optional(),
  }).strict().optional(),
  canInvite: z.boolean().optional(),
  motif,
}).strict();

const acceptSchema = z.object({
  token: z.string().min(16).max(128),
  phone,
  code: code6,
  identityDocument: idDocument,
  photoTaken: z.literal(true, { errorMap: () => ({ message: 'photographie requise' }) }),
  mfaMethod: z.enum(['PASSKEY', 'TOTP', 'SMS']),
  deviceId: z.string().min(3).max(60).optional(),
}).strict();

// Aucun champ de secret, de niveau ni de périmètre : l'opérateur ne peut ni les définir ni les modifier (§ 12A.7).
const assistedSchema = z.object({
  identityDocument: idDocument,
  photoTaken: z.literal(true, { errorMap: () => ({ message: 'photographie requise' }) }),
  otpCode: code6.optional(),
  witness: z.object({ fullName: z.string().trim().min(3).max(120), idNumber: z.string().max(40).optional() }).strict().optional(),
  gps: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).strict(),
  operatorDeviceId: z.string().min(3).max(60),
  personDeviceId: z.string().min(3).max(60).optional(),
}).strict();

const orgSchema = z.object({
  raisonSociale: z.string().trim().min(2).max(160),
  forme: z.enum(LEGAL_FORMS),
  rccm: z.string().trim().min(4).max(60).optional(),
  idNat: z.string().trim().min(4).max(60).optional(),
  nif: z.string().trim().min(4).max(40).optional(),
  phone,
  email: z.string().email().optional(),
  language,
  representatives: z.array(z.object({
    fullName: z.string().trim().min(3).max(120),
    fonction: z.string().trim().min(2).max(80),
    phone: phone.optional(),
    habilitation: z.enum(['DIRIGEANT', 'MANDATAIRE_HABILITE']),
  }).strict()).min(1).max(10),
  declarant: z.object({ fullName: z.string().trim().min(3).max(120), fonction: z.string().trim().min(2).max(80) }).strict(),
  // Aucun rôle de travail ne peut être demandé par le parcours public (AC-INV-01) : `.strict()` le rejette.
}).strict();

type P = { Params: { id: string } };

export function registerAccesRoutes(app: FastifyInstance, ctx: AppContext, svc: AccesService): void {
  // Échéances (mandats, accès temporaires, invitations) balayées à chaque requête : la politique commune lit un état à jour.
  app.addHook('onRequest', async () => { svc.sweep(); });

  // ───────── Référentiels, profil d'accès, MFA, bac à sable ─────────
  app.get('/v1/acces/levels', async () => ({
    accessLevels: ACCESS_LEVELS.map((l) => ({ code: l, ...LEVEL_INFO[l] })),
    verificationLevels: LEVEL_RIGHTS,
    roles: Object.entries(ROLES).map(([code, label]) => ({ code, label, level: ROLE_LEVEL[code as RoleCode], sensitive: SENSITIVE_ROLES.includes(code as RoleCode) })),
    entityKinds: ENTITY_KIND_LABELS,
    taxableFacts: TAXABLE_FACTS,
    proofTypes: PROOF_TYPES,
    mandateActions: MANDATE_ACTIONS,
    consultationPurposes: CONSULTATION_PURPOSES,
    legalForms: LEGAL_FORMS,
    sandbox: svc.sandbox,
  }));

  app.get('/v1/acces/me', async (req) => svc.me(requireUser(req)));

  app.post('/v1/acces/mfa/challenge', async (req) => svc.mfaChallenge(requireUser(req)));
  app.post('/v1/acces/mfa/verify', async (req) => {
    const body = parse(z.object({ challengeId: z.string(), code: code6 }).strict(), req.body);
    return svc.mfaVerify(requireUser(req), body.challengeId, body.code);
  });

  // Boîte d'envoi du bac à sable (codes, jetons d'invitation) : démonstration UNIQUEMENT — 404 sinon (service).
  app.get<{ Querystring: { to?: string } }>('/v1/acces/sandbox/outbox', async (req) => {
    if (!isDemoMode()) throw notFound('ROUTE_NOT_FOUND', `Route inconnue : GET ${req.url.split('?')[0]}`);
    const to = parse(z.object({ to: z.string().min(3) }).strict(), req.query).to;
    return { sandbox: true, notice: 'Bac à sable : messages journalisés, jamais envoyés. Désactivé dès qu’un fournisseur SMS est branché.', items: svc.sandboxMessages(to) };
  });

  // ───────── Entités ─────────
  app.get('/v1/acces/entities', async (req) => {
    authorize(requireUser(req), ACCES.entityRead);
    return { items: svc.listEntities() };
  });
  app.post('/v1/acces/entities', async (req, reply) => {
    const user = requireUser(req);
    authorize(user, ACCES.entityManage);
    return reply.code(201).send(svc.createEntity(user, parse(entitySchema, req.body)));
  });
  app.post<P>('/v1/acces/entities/:id/suspend', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.entityManage);
    return svc.suspendEntity(user, req.params.id, parse(z.object({ motif, decisionRef: z.string().trim().min(3) }).strict(), req.body));
  });

  // ───────── Fiches de module ─────────
  app.get('/v1/acces/modules', async (req) => {
    authorize(requireUser(req), ACCES.moduleRead);
    return { items: svc.modules.all() };
  });
  app.get<P>('/v1/acces/modules/:id', async (req) => {
    authorize(requireUser(req), ACCES.moduleRead);
    return svc.module(req.params.id);
  });
  app.post('/v1/acces/modules', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(moduleSchema, req.body);
    authorize(user, ACCES.moduleDraft, { entity: body.responsibleEntity });
    const { moduleManagerId, ...rest } = body;
    return reply.code(201).send(svc.createModule(user, { ...rest, ...(moduleManagerId ? { moduleManagerId } : {}) }));
  });
  app.post<P>('/v1/acces/modules/:id/submit', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.moduleDraft, { entity: svc.module(req.params.id).responsibleEntity });
    return svc.submitModule(user, req.params.id, parse(z.object({ note: z.string().max(500).optional() }).strict(), req.body).note);
  });
  app.post<P>('/v1/acces/modules/:id/visa-programme', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.moduleVisaProgramme);
    return svc.visaProgramme(user, req.params.id, parse(z.object({ note: z.string().max(500).optional() }).strict(), req.body).note);
  });
  app.post<P>('/v1/acces/modules/:id/visa-juridique', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.moduleVisaJuridique);
    const body = parse(z.object({ actReferences: z.array(z.string().trim().min(3)).min(1), note: z.string().max(500).optional() }).strict(), req.body);
    return svc.visaJuridique(user, req.params.id, { actReferences: body.actReferences, ...(body.note ? { note: body.note } : {}) });
  });
  app.post<P>('/v1/acces/modules/:id/recette', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.moduleRecette);
    return svc.recordRecette(user, req.params.id, parse(z.object({ passed: z.boolean(), report: z.string().trim().min(5).max(1000) }).strict(), req.body));
  });
  app.post<P>('/v1/acces/modules/:id/activate', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.moduleActivate);
    const body = parse(z.object({ actReference: z.string().trim().min(3), note: z.string().max(500).optional() }).strict(), req.body);
    return svc.activateModule(user, req.params.id, { actReference: body.actReference, ...(body.note ? { note: body.note } : {}) });
  });
  app.post<P>('/v1/acces/modules/:id/status', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.moduleActivate);
    return svc.changeModuleStatus(user, req.params.id, parse(z.object({ to: z.enum(['SUSPENDU', 'ACTIF', 'RETIRE']), motif }).strict(), req.body));
  });
  app.post<P>('/v1/acces/modules/:id/reattachments', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.moduleReattachPropose);
    return svc.proposeReattachment(user, req.params.id, parse(z.object({
      newEntity: z.string().min(2), beneficiaryAliases: z.array(z.string().min(3)).min(1).max(5), actReference: z.string().trim().min(3), motif,
    }).strict(), req.body));
  });
  app.post<P>('/v1/acces/modules/:id/reattachments/decision', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.moduleReattachApprove);
    const body = parse(z.object({ approve: z.boolean(), note: z.string().max(500).optional() }).strict(), req.body);
    return svc.decideReattachment(user, req.params.id, { approve: body.approve, ...(body.note ? { note: body.note } : {}) });
  });

  // ───────── Revendications et arbitrages ─────────
  const claimSchema = z.object({
    objectId: z.string().min(3), factCode: z.enum(TAXABLE_FACTS), period: z.string().regex(/^\d{4}(-\d{2})?$/, 'période AAAA ou AAAA-MM'),
    ruleCode: z.string().min(2).optional(), basis: z.string().trim().min(5).max(300),
  }).strict();
  app.get('/v1/acces/claims', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.arbitrationRead, { entity: user.entity });
    const all = user.roles.some((r) => ['R01', 'R02', 'R03', 'R05', 'R13', 'R14', 'R22', 'R23'].includes(r));
    return { items: svc.claims.all().filter((c) => all || c.entity === user.entity).reverse() };
  });
  app.post('/v1/acces/claims', async (req, reply) => {
    const user = requireUser(req);
    authorize(user, ACCES.claimCreate);
    const body = parse(claimSchema, req.body);
    const r = svc.claim(user, { objectId: body.objectId, factCode: body.factCode, period: body.period, basis: body.basis, ...(body.ruleCode ? { ruleCode: body.ruleCode } : {}) });
    if (r.blocked) {
      throw conflict('CLAIM_BLOCKED', 'Fait générateur déjà revendiqué par une autre entité : revendication bloquée, dossier d’arbitrage ouvert. Aucune seconde obligation n’est exposée au citoyen.', {
        claimId: r.claim.id, arbitrationId: r.claim.arbitrationId,
      });
    }
    return reply.code(r.existing ? 200 : 201).send(r);
  });
  app.post('/v1/acces/claims/liquidations', async (req, reply) => {
    const user = requireUser(req);
    authorize(user, 'assessment.liquidate');
    const body = parse(z.object({
      ruleId: z.string().min(2), objectId: z.string().min(3), factCode: z.enum(TAXABLE_FACTS), period: z.string().regex(/^\d{4}(-\d{2})?$/),
      inputs: z.record(z.string()).default({}), basis: z.string().trim().min(5).max(300),
    }).strict(), req.body);
    return reply.code(201).send(svc.guardedLiquidation(user, body));
  });
  app.get('/v1/acces/arbitrations', async (req) => ({ items: svc.visibleArbitrations(requireUser(req)).reverse() }));
  app.get<P>('/v1/acces/arbitrations/:id', async (req) => {
    const user = requireUser(req);
    const a = svc.arbitration(req.params.id);
    authorize(user, ACCES.arbitrationRead, { entities: a.claimants.map((c) => c.entity) });
    return { ...a, claims: a.claimants.map((c) => (c.claimId ? svc.claims.get(c.claimId) : undefined)).filter(Boolean) };
  });
  app.post<P>('/v1/acces/arbitrations/:id/opinion', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.arbitrationOpinion);
    const body = parse(z.object({ text: z.string().trim().min(10).max(2000), recommendedEntity: z.string().optional() }).strict(), req.body);
    return svc.arbitrationOpinion(user, req.params.id, { text: body.text, ...(body.recommendedEntity ? { recommendedEntity: body.recommendedEntity } : {}) });
  });
  app.post<P>('/v1/acces/arbitrations/:id/decision', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.arbitrationDecide);
    return svc.decideArbitration(user, req.params.id, parse(z.object({ winnerEntity: z.string().min(2), motif, actReference: z.string().trim().min(3) }).strict(), req.body));
  });

  // ───────── Invitations, comptes, validations, permissions ─────────
  app.get('/v1/acces/invitations', async (req) => {
    const user = requireUser(req);
    // L'opérateur d'accès désigné voit les invitations de son entité pour les finaliser en présence (§ 12A.7).
    authorize(user, svc.isAccessOperator(user) ? ACCES.invitationCreate : ACCES.invitationRead, { entity: user.entity });
    return { items: svc.listInvitations(user) };
  });
  app.post('/v1/acces/invitations', async (req, reply) => {
    const user = requireUser(req);
    authorize(user, ACCES.invitationCreate);
    const body = parse(invitationSchema, req.body);
    const { email, scope, canInvite, ...rest } = body;
    return reply.code(201).send(svc.createInvitation(user, { ...rest, ...(email ? { email } : {}), ...(scope ? { scope } : {}), ...(canInvite !== undefined ? { canInvite } : {}) }));
  });
  app.post<P>('/v1/acces/invitations/:id/revoke', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.invitationCreate);
    return svc.revokeInvitation(user, req.params.id, parse(z.object({ motif }).strict(), req.body).motif);
  });
  // Parcours public de l'invité : consultation du lien puis finalisation (aucun en-tête d'utilisateur requis).
  app.get<{ Querystring: { token?: string } }>('/v1/acces/invitations/lookup', async (req) => {
    return svc.lookupInvitation(parse(z.object({ token: z.string().min(16).max(128) }).strict(), req.query).token);
  });
  app.post('/v1/acces/invitations/accept', async (req, reply) => {
    const body = parse(acceptSchema, req.body);
    const { deviceId, ...rest } = body;
    return reply.code(201).send(svc.acceptInvitation({ ...rest, ...(deviceId ? { deviceId } : {}) }));
  });
  app.post<P>('/v1/acces/invitations/:id/assisted', async (req, reply) => {
    const user = requireUser(req);
    authorize(user, ACCES.invitationCreate);
    const body = parse(assistedSchema, req.body);
    const { otpCode, witness, personDeviceId, ...rest } = body;
    return reply.code(201).send(svc.assistedFinalize(user, req.params.id, {
      ...rest, ...(otpCode ? { otpCode } : {}), ...(witness ? { witness: { fullName: witness.fullName, ...(witness.idNumber ? { idNumber: witness.idNumber } : {}) } } : {}),
      ...(personDeviceId ? { personDeviceId } : {}),
    }));
  });

  app.get<{ Querystring: { entity?: string } }>('/v1/acces/accounts', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.invitationRead, { entity: user.entity });
    return { items: svc.listAccounts(user, req.query.entity) };
  });
  app.post('/v1/acces/accounts/me/secrets', async (req) => {
    return svc.setOwnSecrets(requireUser(req), parse(z.object({ mfaMethod: z.enum(['PASSKEY', 'TOTP', 'SMS']) }).strict(), req.body));
  });
  app.post<P>('/v1/acces/accounts/:id/revoke', async (req) => {
    const user = requireUser(req);
    const acc = svc.ensureAccount(req.params.id);
    authorize(user, ACCES.accountRevoke, { entity: acc?.entity ?? '—' });
    const body = parse(z.object({ motif, successorId: z.string().optional() }).strict(), req.body);
    return svc.revokeAccount(user, req.params.id, { motif: body.motif, ...(body.successorId ? { successorId: body.successorId } : {}) });
  });

  app.get('/v1/acces/validations', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.invitationRead, { entity: user.entity });
    return { items: svc.listValidations(user) };
  });
  // Les validateurs hors bande (Cabinet, SG) et l'autorité d'audit consultent leur file sans être administrateurs d'entité.
  app.get('/v1/acces/validations/mine', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.validationDecide, { entity: user.entity });
    return { items: svc.listValidations(user).filter((v) => v.qualified) };
  });
  app.post<P>('/v1/acces/validations/:id/decision', async (req) => {
    const user = requireUser(req);
    const v = svc.validations.get(req.params.id);
    authorize(user, ACCES.validationDecide, { entity: v?.entity ?? '—' });
    const body = parse(z.object({
      decision: z.enum(['APPROUVEE', 'REJETEE']), note: z.string().max(500).optional(), outOfBandConfirmed: z.boolean().optional(), certificationRef: z.string().min(3).max(80).optional(),
    }).strict(), req.body);
    const { note, outOfBandConfirmed, certificationRef, decision } = body;
    return svc.decideValidation(user, req.params.id, {
      decision, ...(note ? { note } : {}), ...(outOfBandConfirmed !== undefined ? { outOfBandConfirmed } : {}), ...(certificationRef ? { certificationRef } : {}),
    });
  });

  app.get('/v1/acces/grants', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.invitationRead, { entity: user.entity });
    return { items: svc.listGrants(user) };
  });
  app.post('/v1/acces/grants', async (req, reply) => {
    const user = requireUser(req);
    authorize(user, ACCES.grantManage, { entity: user.entity });
    return reply.code(201).send(svc.requestGrant(user, parse(z.object({ userId: z.string().min(2), kind: z.enum(['DROIT_INVITER', 'OPERATEUR_ACCES']), motif }).strict(), req.body)));
  });
  app.post<P>('/v1/acces/grants/:id/revoke', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.grantManage, { entity: user.entity });
    return svc.revokeGrant(user, req.params.id, parse(z.object({ motif }).strict(), req.body).motif);
  });

  app.get<{ Querystring: { entity?: string } }>('/v1/acces/journal', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.journalRead, { entity: req.query.entity ?? user.entity });
    return { items: svc.journal(user, req.query.entity) };
  });

  // ───────── Identité avancée ─────────
  app.post('/v1/acces/organisations', async (req, reply) => {
    const body = parse(orgSchema, req.body);
    const { rccm, idNat, nif, email, representatives, ...rest } = body;
    return reply.code(201).send(svc.registerOrganisation({
      ...rest, language: rest.language as never, ...(rccm ? { rccm } : {}), ...(idNat ? { idNat } : {}), ...(nif ? { nif } : {}), ...(email ? { email } : {}),
      representatives: representatives.map((r) => ({ fullName: r.fullName, fonction: r.fonction, habilitation: r.habilitation, ...(r.phone ? { phone: r.phone } : {}) })),
    }));
  });
  app.post<P>('/v1/acces/identity/:id/otp', async (req, reply) => reply.code(201).send(svc.sendPhoneOtp(req.params.id)));
  app.post<P>('/v1/acces/identity/:id/otp/verify', async (req) => {
    const body = parse(z.object({ challengeId: z.string(), code: code6 }).strict(), req.body);
    return svc.verifyPhoneOtp(req.params.id, body.challengeId, body.code);
  });
  app.get<P>('/v1/acces/identity/:id', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.identityRead, { taxpayerId: req.params.id });
    if (user.taxpayerId !== req.params.id) {
      ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'acces.identity.viewed', resourceType: 'taxpayer', resourceId: req.params.id, details: { entity: user.entity } });
    }
    return svc.identity(req.params.id, user.taxpayerId === req.params.id ? 'self' : 'agent');
  });
  app.post<P>('/v1/acces/identity/:id/proofs', async (req, reply) => {
    const user = requireUser(req);
    authorize(user, ACCES.proofDeclare, { taxpayerId: req.params.id });
    const body = parse(z.object({ type: z.enum(PROOF_TYPES), reference: z.string().trim().min(3).max(80), note: z.string().max(300).optional() }).strict(), req.body);
    return reply.code(201).send(svc.declareProof(user, req.params.id, { type: body.type, reference: body.reference, ...(body.note ? { note: body.note } : {}) }));
  });
  app.get('/v1/acces/identity-proofs', async (req) => {
    authorize(requireUser(req), ACCES.proofReview);
    return { items: svc.pendingProofs() };
  });
  app.post<P>('/v1/acces/identity-proofs/:id/review', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.proofReview);
    return svc.reviewProof(user, req.params.id, parse(z.object({ decision: z.enum(['VALIDEE', 'REJETEE']), note: z.string().trim().min(3).max(300) }).strict(), req.body));
  });
  app.post('/v1/acces/assisted-enrolments', async (req, reply) => {
    const user = requireUser(req);
    authorize(user, ACCES.assistedEnrolment);
    const body = parse(z.object({
      fullName: z.string().trim().min(3).max(120), language, commune: z.string().min(3), phone: phone.optional(),
      consent: z.object({ method: z.enum(['ORAL_ENREGISTRE', 'TEMOIN', 'EMPREINTE']), witnessName: z.string().trim().min(3).optional(), recordingRef: z.string().min(3).optional() }).strict(),
      deviceId: z.string().min(3).optional(),
    }).strict(), req.body);
    const { phone: ph, deviceId, consent, ...rest } = body;
    return reply.code(201).send(svc.assistedEnrolment(user, {
      ...rest, language: rest.language as never, ...(ph ? { phone: ph } : {}), ...(deviceId ? { deviceId } : {}),
      consent: { method: consent.method, ...(consent.witnessName ? { witnessName: consent.witnessName } : {}), ...(consent.recordingRef ? { recordingRef: consent.recordingRef } : {}) },
    }));
  });

  app.get('/v1/acces/duplicates', async (req) => {
    authorize(requireUser(req), ACCES.duplicatesRead);
    return { items: svc.duplicateCandidates(), merges: svc.listMerges() };
  });
  app.post('/v1/acces/merges', async (req, reply) => {
    const user = requireUser(req);
    authorize(user, ACCES.mergePropose);
    const body = parse(z.object({ survivorId: z.string(), absorbedId: z.string(), evidence: z.string().trim().min(10).max(1000), documentRef: z.string().trim().min(3).max(120).optional() }).strict(), req.body);
    return reply.code(201).send(svc.proposeMerge(user, { survivorId: body.survivorId, absorbedId: body.absorbedId, evidence: body.evidence, ...(body.documentRef ? { documentRef: body.documentRef } : {}) }));
  });
  app.post<P>('/v1/acces/merges/:id/verify', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.mergeVerify);
    return svc.verifyMerge(user, req.params.id, parse(z.object({ note: z.string().max(500).optional() }).strict(), req.body).note);
  });
  app.post<P>('/v1/acces/merges/:id/approve', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.mergeApprove);
    return svc.approveMerge(user, req.params.id);
  });
  app.post<P>('/v1/acces/merges/:id/close', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.mergeApprove);
    return svc.closeMerge(user, req.params.id, parse(z.object({ action: z.enum(['REJETER', 'ANNULER']), motif }).strict(), req.body));
  });

  app.get('/v1/acces/consultations', async (req) => {
    const user = requireUser(req);
    if (!user.roles.some((r) => ['R22', 'R23', 'R28'].includes(r))) authorize(user, ACCES.consultationRequest);
    return { items: svc.listConsultations(user) };
  });
  app.post('/v1/acces/consultations', async (req, reply) => {
    const user = requireUser(req);
    authorize(user, ACCES.consultationRequest);
    const body = parse(z.object({ taxpayerId: z.string().min(3), purpose: z.enum(CONSULTATION_PURPOSES), motif: z.string().trim().min(20, 'motif détaillé obligatoire (20 caractères au moins)').max(500) }).strict(), req.body);
    return reply.code(201).send(svc.requestConsultation(user, body));
  });
  app.get<P>('/v1/acces/consultations/:id/dossier', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.consultationRequest);
    return svc.consultationDossier(user, req.params.id);
  });
  app.post<P>('/v1/acces/consultations/:id/review', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.consultationReview);
    return svc.reviewConsultation(user, req.params.id, parse(z.object({ conclusion: z.enum(['JUSTIFIEE', 'INJUSTIFIEE']), note: z.string().trim().min(5).max(500) }).strict(), req.body));
  });

  // ───────── Mandats ─────────
  app.get('/v1/acces/mandates', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.mandateRead);
    return { items: svc.listMandates(user), mandataires: user.roles.includes('R30') ? svc.mandataires() : [] };
  });
  app.post('/v1/acces/mandates', async (req, reply) => {
    const user = requireUser(req);
    authorize(user, ACCES.mandateManage, { taxpayerId: user.taxpayerId ?? '—' });
    const body = parse(z.object({
      mandataireUserId: z.string().min(2), kind: z.enum(['CONFIANCE', 'PROFESSIONNEL']), scope: z.array(z.enum(MANDATE_ACTIONS)).min(1),
      objectIds: z.array(z.string()).max(50).optional(), validFrom: isoDateString.optional(), validTo: isoDateString, proofRef: z.string().max(120).optional(),
    }).strict(), req.body);
    const { objectIds, validFrom, proofRef, ...rest } = body;
    return reply.code(201).send(svc.createMandate(user, { ...rest, ...(objectIds ? { objectIds } : {}), ...(validFrom ? { validFrom } : {}), ...(proofRef ? { proofRef } : {}) }));
  });
  app.post<P>('/v1/acces/mandates/:id/revoke', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.mandateRead);
    return svc.revokeMandate(user, req.params.id, parse(z.object({ motif: z.string().trim().min(3).max(300) }).strict(), req.body).motif);
  });
  app.get<{ Querystring: { taxpayerId?: string; action?: string; objectId?: string } }>('/v1/acces/mandates/check', async (req) => {
    const user = requireUser(req);
    authorize(user, ACCES.mandateCheck);
    const q = parse(z.object({ taxpayerId: z.string(), action: z.enum(MANDATE_ACTIONS), objectId: z.string().optional() }).strict(), req.query);
    return { allowed: svc.mandateAllows(user.id, q.taxpayerId, q.action, q.objectId) };
  });
}
