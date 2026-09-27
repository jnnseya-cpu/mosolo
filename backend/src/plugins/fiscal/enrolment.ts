/**
 * Enrôlement par profil (§ 9.3) : parcours courts (19 profils et plus), chacun ne demandant que ce qui sert à ses
 * obligations. Déclarer un rôle OUVRE UNE INSTRUCTION : cela n'établit ni la propriété ni une dette.
 * Sans NIF quand les obligations du profil l'attendent : un identifiant provisoire est attribué et une demande de NIF
 * est suivie en arrière-plan (parcours de régularisation). Une personne dispose, sous une seule connexion, d'un espace
 * personnel et d'espaces d'organisation (mandats actifs) ; le changement d'espace n'élargit jamais les droits.
 * Récupération de compte contrôlée : demande, vérification d'identité au guichet, approbation par une seconde personne.
 */
import { ENROLMENT_PROFILES, ROLE_DECLARATION_NOTICE, type EnrolmentProfile } from '@mosolo/shared';
import type { User } from '../../core/auth.js';
import { randomCode, sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, assertNotRelated, authorize, definePolicy, evaluate, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import { maskPhone } from '../../modules/identity/service.js';
import { isCommune } from '../../reference/kinshasa.js';
import { actorOf, type FiscalDeps } from './common.js';

const { always, ownTaxpayer, mandant } = GRANTS;
definePolicy('enrolement:role.declare', { R30: ownTaxpayer, R31: mandant, R12: always });
definePolicy('enrolement:role.read', { R30: ownTaxpayer, R31: mandant, R06: always, R07: always, R11: always, R12: always, R22: always });
definePolicy('enrolement:role.instruct', { R07: always, R11: always, R12: always });
definePolicy('enrolement:nif.manage', { R12: always, R07: always });
definePolicy('enrolement:recovery.verify', { R12: always });
definePolicy('enrolement:recovery.approve', { R07: always, R06: always });

export interface RoleDeclaration {
  id: string;
  taxpayerId: string;
  profile: string;
  profileLabel: string;
  answers: Record<string, string>;
  channel: 'EN_LIGNE' | 'GUICHET';
  status: 'EN_INSTRUCTION' | 'CONFIRMEE' | 'REJETEE' | 'COMPLEMENT_DEMANDE';
  declaredBy: string;
  declaredAt: string;
  objectId?: string;
  nifRequestId?: string;
  decision?: { by: string; at: string; decision: RoleDeclaration['status']; reason: string };
  notice: string;
}

export interface NifRequest {
  id: string;
  taxpayerId: string;
  provisionalId: string;
  status: 'DEMANDEE' | 'TRANSMISE' | 'ATTRIBUEE' | 'REJETEE';
  origin: string;
  requestedAt: string;
  steps: { at: string; status: NifRequest['status']; by: string; note: string }[];
  regularisation: string[];
}

export interface AccountRecovery {
  id: string;
  taxpayerId: string | null;
  newPhone: string;
  idProofHash: string;
  status: 'DEMANDEE' | 'VERIFIEE' | 'APPROUVEE' | 'REJETEE';
  requestedAt: string;
  verification?: { by: string; at: string; note: string; proofMatched: boolean };
  decision?: { by: string; at: string; approve: boolean; reason: string };
}

const REGULARISATION_STEPS = [
  'Identifiant provisoire MOSOLO attribué : vos démarches ne sont pas bloquées.',
  'Demande de NIF transmise à l’administration compétente (suivi par MOSOLO).',
  'À l’attribution : le NIF est enregistré comme preuve déclarée puis contrôlé (niveau N3 possible).',
  'L’identifiant provisoire reste relié au compte (aucune donnée perdue).',
];

export class EnrolmentService {
  readonly roles = new InMemoryRepository<RoleDeclaration>();
  readonly nifRequests = new InMemoryRepository<NifRequest>();
  readonly recoveries = new InMemoryRepository<AccountRecovery>();
  private readonly ids = new IdGenerator();

  constructor(private readonly d: FiscalDeps) {}

  profiles(): EnrolmentProfile[] {
    return ENROLMENT_PROFILES;
  }

  private profile(code: string): EnrolmentProfile {
    const p = ENROLMENT_PROFILES.find((x) => x.code === code);
    if (!p) throw badRequest('UNKNOWN_PROFILE', `Profil inconnu : ${code}`);
    return p;
  }

  private hasNif(taxpayerId: string): boolean {
    const acces = this.d.ctx.ext['acces'] as { proofs?: { findOne(p: (x: { taxpayerId: string; type: string; status: string }) => boolean): unknown } } | undefined;
    return !!acces?.proofs?.findOne((p) => p.taxpayerId === taxpayerId && p.type === 'NIF' && p.status !== 'REJETEE');
  }

  /** Demande de NIF en arrière-plan : identifiant provisoire + parcours de régularisation (idempotente). */
  ensureNifRequest(taxpayerId: string, by: string, origin: string): NifRequest {
    const open = this.nifRequests.findOne((n) => n.taxpayerId === taxpayerId && (n.status === 'DEMANDEE' || n.status === 'TRANSMISE'));
    if (open) return open;
    const at = this.d.nowIso();
    const core = randomCode(8);
    const n = this.nifRequests.insert({
      id: this.ids.next('DNIF'), taxpayerId, provisionalId: `NIF-PROV-${core}`, status: 'DEMANDEE', origin, requestedAt: at,
      steps: [{ at, status: 'DEMANDEE', by, note: 'Demande ouverte automatiquement (NIF attendu pour les obligations du profil).' }],
      regularisation: REGULARISATION_STEPS,
    });
    this.d.ctx.audit.append({ actor: { kind: 'system', id: 'enrolement' }, action: 'enrolement.nif.requested', resourceType: 'taxpayer', resourceId: taxpayerId, details: { requestId: n.id, provisionalId: n.provisionalId, origin } });
    return n;
  }

  /** Déclaration d'un ou plusieurs rôles : chaque rôle ouvre une instruction ; aucune propriété ni dette n'est établie. */
  declare(user: User, input: { taxpayerId?: string; profile: string; answers: Record<string, string> }): RoleDeclaration {
    const taxpayerId = input.taxpayerId ?? (user.roles.includes('R30') ? user.taxpayerId : undefined);
    if (!taxpayerId) throw badRequest('TAXPAYER_REQUIRED', 'Compte concerné requis.');
    authorize(user, 'enrolement:role.declare', { taxpayerId });
    const tp = this.d.ctx.taxpayers.get(taxpayerId);
    const p = this.profile(input.profile);
    const answers: Record<string, string> = {};
    for (const f of p.fields) {
      const v = (input.answers[f.name] ?? '').trim();
      if (!v) { if (f.required) throw badRequest('MISSING_INPUT', `Champ requis : « ${f.label} ».`); continue; }
      if (f.type === 'commune' && !isCommune(v)) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${v}`);
      if (f.type === 'nombre' && !/^\d{1,9}$/.test(v)) throw badRequest('INVALID_INPUT', `Nombre entier attendu pour « ${f.label} ».`);
      if (f.type === 'oui_non' && !['oui', 'non'].includes(v)) throw badRequest('INVALID_INPUT', `« oui » ou « non » attendu pour « ${f.label} ».`);
      answers[f.name] = v.slice(0, 200);
    }
    const unexpected = Object.keys(input.answers).filter((k) => !p.fields.some((f) => f.name === k));
    if (unexpected.length) throw badRequest('UNEXPECTED_FIELDS', `Ce profil ne demande pas : ${unexpected.join(', ')} (minimisation des données).`);
    if (p.kind !== 'INDIFFERENT' && (tp.kind ?? 'PERSONNE_PHYSIQUE') !== p.kind) {
      throw unprocessable('PROFILE_KIND_MISMATCH', p.kind === 'PERSONNE_MORALE' ? 'Ce profil concerne une organisation : utilisez l’espace de l’organisation.' : 'Ce profil concerne une personne physique.');
    }
    if (this.roles.findOne((r) => r.taxpayerId === taxpayerId && r.profile === p.code && r.status === 'EN_INSTRUCTION')) {
      throw conflict('ROLE_ALREADY_DECLARED', 'Une déclaration de ce rôle est déjà en instruction.');
    }
    let objectId: string | undefined;
    if (answers.objet) {
      const o = this.d.ctx.objects.objects.get(answers.objet) ?? this.d.ctx.objects.objects.findOne((x) => x.igf?.code === answers.objet);
      if (o) objectId = o.id;
    }
    let nifRequestId: string | undefined;
    if (p.nifExpected && !answers.nif && !this.hasNif(taxpayerId)) nifRequestId = this.ensureNifRequest(taxpayerId, user.id, `Profil ${p.label}`).id;
    const r = this.roles.insert({
      id: this.ids.next('ROLE'), taxpayerId, profile: p.code, profileLabel: p.label, answers, channel: user.roles.includes('R12') ? 'GUICHET' : 'EN_LIGNE',
      status: 'EN_INSTRUCTION', declaredBy: user.id, declaredAt: this.d.nowIso(), ...(objectId ? { objectId } : {}), ...(nifRequestId ? { nifRequestId } : {}),
      notice: ROLE_DECLARATION_NOTICE,
    });
    if (answers.nif) {
      const acces = this.d.ctx.ext['acces'] as { declareProof?(u: User, t: string, i: { type: 'NIF'; reference: string; note?: string }): unknown } | undefined;
      try { acces?.declareProof?.(user, taxpayerId, { type: 'NIF', reference: answers.nif, note: `Déclaré au parcours « ${p.label} »` }); } catch { /* preuve déjà en attente : rien à faire */ }
    }
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'enrolement.role.declared', resourceType: 'taxpayer', resourceId: taxpayerId, details: { declarationId: r.id, profile: p.code, channel: r.channel, objectId: objectId ?? null, nifRequest: nifRequestId ?? null } });
    return r;
  }

  instruct(user: User, id: string, input: { decision: 'CONFIRMEE' | 'REJETEE' | 'COMPLEMENT_DEMANDE'; reason: string }): RoleDeclaration {
    authorize(user, 'enrolement:role.instruct');
    const r = this.roles.get(id);
    if (!r) throw notFound('ROLE_DECLARATION_NOT_FOUND', `Déclaration inconnue : ${id}`);
    if (r.status === 'CONFIRMEE' || r.status === 'REJETEE') throw conflict('ROLE_DECLARATION_CLOSED', 'Instruction déjà close.');
    assertDistinctPerson(user.id, [r.declaredBy], 'L’instruction est faite par une personne distincte de celle qui a enregistré la déclaration.');
    assertNotRelated(user, r.taxpayerId, 'Un agent n’instruit pas la déclaration d’un contribuable auquel il est lié.');
    const out = this.roles.update({ ...r, status: input.decision, decision: { by: user.id, at: this.d.nowIso(), decision: input.decision, reason: input.reason } });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'enrolement.role.instructed', resourceType: 'taxpayer', resourceId: r.taxpayerId, details: { declarationId: id, decision: input.decision, reason: input.reason } });
    return out;
  }

  list(user: User, taxpayerId?: string) {
    if (taxpayerId) authorize(user, 'enrolement:role.read', { taxpayerId });
    else authorize(user, 'enrolement:role.instruct');
    return this.roles.all().filter((r) => !taxpayerId || r.taxpayerId === taxpayerId).reverse();
  }

  nifOf(taxpayerId: string) {
    return this.nifRequests.find((n) => n.taxpayerId === taxpayerId);
  }

  updateNif(user: User, id: string, input: { status: 'TRANSMISE' | 'ATTRIBUEE' | 'REJETEE'; nif?: string; note: string }): NifRequest {
    authorize(user, 'enrolement:nif.manage');
    const n = this.nifRequests.get(id);
    if (!n) throw notFound('NIF_REQUEST_NOT_FOUND', `Demande inconnue : ${id}`);
    if (n.status === 'ATTRIBUEE' || n.status === 'REJETEE') throw conflict('NIF_REQUEST_CLOSED', 'Demande déjà close.');
    if (input.status === 'ATTRIBUEE' && !input.nif) throw badRequest('NIF_REQUIRED', 'Le NIF attribué est requis.');
    if (input.status === 'ATTRIBUEE') {
      const acces = this.d.ctx.ext['acces'] as { declareProof?(u: User, t: string, i: { type: 'NIF'; reference: string; note?: string }): unknown } | undefined;
      acces?.declareProof?.(user, n.taxpayerId, { type: 'NIF', reference: input.nif!, note: `NIF attribué (demande ${n.id}, identifiant provisoire ${n.provisionalId})` });
    }
    const out = this.nifRequests.update({ ...n, status: input.status, steps: [...n.steps, { at: this.d.nowIso(), status: input.status, by: user.id, note: input.note }] });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'enrolement.nif.updated', resourceType: 'taxpayer', resourceId: n.taxpayerId, details: { requestId: id, status: input.status } });
    return out;
  }

  /** Espaces sous une seule connexion : personnel + organisations/mandants (mandats actifs). Aucun droit n'est ajouté. */
  spaces(user: User) {
    const acces = this.d.ctx.ext['acces'] as { mandates?: { find(p: (m: { mandataireUserId: string; status: string }) => boolean): { mandantTaxpayerId: string; id: string; scope: string[]; validTo: string }[] } } | undefined;
    const tps = this.d.ctx.taxpayers.taxpayers;
    const personal = user.taxpayerId ? tps.get(user.taxpayerId) : undefined;
    const mandates = acces?.mandates?.find((m) => m.mandataireUserId === user.id && m.status === 'ACTIF') ?? [];
    const ids = new Set([...(user.mandants ?? []), ...mandates.map((m) => m.mandantTaxpayerId)]);
    if (personal) ids.delete(personal.id);
    const spaces = [...ids].map((id) => tps.get(id)).filter((t): t is NonNullable<typeof t> => !!t).map((t) => {
      const m = mandates.find((x) => x.mandantTaxpayerId === t.id);
      return {
        taxpayerId: t.id, iuc: t.iuc, name: t.fullName, kind: t.kind ?? 'PERSONNE_PHYSIQUE',
        type: (t.kind === 'PERSONNE_MORALE' ? 'ORGANISATION' : 'MANDANT') as 'ORGANISATION' | 'MANDANT',
        mandate: m ? { id: m.id, scope: m.scope, validTo: m.validTo } : null,
      };
    });
    return {
      personal: personal ? { taxpayerId: personal.id, iuc: personal.iuc, name: personal.fullName, kind: personal.kind ?? 'PERSONNE_PHYSIQUE', type: 'PERSONNEL' as const } : null,
      spaces,
      notice: 'Changer d’espace n’ajoute aucun droit : chaque action reste contrôlée par le serveur selon le mandat en vigueur.',
    };
  }

  // ——— Récupération de compte contrôlée ———

  /** Demande publique : réponse identique que le compte existe ou non (pas d'énumération) ; le titulaire actuel est alerté. */
  requestRecovery(input: { iuc: string; newPhone: string; idDocumentRef: string }) {
    const tp = this.d.ctx.taxpayers.taxpayers.findOne((t) => t.iuc === input.iuc.trim().toUpperCase());
    const phone = input.newPhone.replace(/[\s-]/g, '');
    const r = this.recoveries.insert({
      id: this.ids.next('RECUP'), taxpayerId: tp?.id ?? null, newPhone: phone, idProofHash: sha256Hex(`PIECE_IDENTITE:${input.idDocumentRef.trim().toUpperCase()}`),
      status: tp ? 'DEMANDEE' : 'REJETEE', requestedAt: this.d.nowIso(),
    });
    this.d.ctx.audit.append({ actor: { kind: 'public', id: 'recuperation-compte' }, action: 'enrolement.recovery.requested', resourceType: 'account_recovery', resourceId: r.id, details: { known: !!tp, newPhoneMasked: maskPhone(phone) } });
    if (tp) this.d.ctx.comms.publish('auth.recovery.requested', [taxpayerRecipient(tp)], {}, { entity: 'GOUVERNORAT' });
    return { reference: r.id, notice: 'Demande enregistrée. Présentez-vous au guichet MOSOLO avec votre pièce d’identité : la récupération est vérifiée par un agent puis approuvée par une seconde personne. Si vous n’êtes pas à l’origine de cette demande, signalez-le.' };
  }

  verifyRecovery(user: User, id: string, input: { note: string }) {
    authorize(user, 'enrolement:recovery.verify');
    const r = this.recoveries.get(id);
    if (!r || !r.taxpayerId) throw notFound('RECOVERY_NOT_FOUND', `Demande inconnue : ${id}`);
    if (r.status !== 'DEMANDEE') throw conflict('RECOVERY_BAD_STATE', `Demande au statut ${r.status}.`);
    assertNotRelated(user, r.taxpayerId, 'Un agent ne traite pas la récupération d’un compte auquel il est lié.');
    const acces = this.d.ctx.ext['acces'] as { proofs?: { findOne(p: (x: { taxpayerId: string; type: string; status: string; referenceHash: string }) => boolean): unknown } } | undefined;
    const proofMatched = !!acces?.proofs?.findOne((p) => p.taxpayerId === r.taxpayerId && p.type === 'PIECE_IDENTITE' && p.status === 'VALIDEE' && p.referenceHash === r.idProofHash);
    if (!proofMatched) {
      this.recoveries.update({ ...r, verification: { by: user.id, at: this.d.nowIso(), note: input.note, proofMatched } });
      this.d.ctx.audit.append({ actor: actorOf(user), action: 'enrolement.recovery.verification_failed', resourceType: 'account_recovery', resourceId: id, outcome: 'DENIED', details: { reason: 'PIECE_NON_CONCORDANTE' } });
      throw unprocessable('IDENTITY_NOT_MATCHED', 'La pièce présentée ne correspond à aucune pièce d’identité validée du compte : récupération impossible par cette voie.');
    }
    const out = this.recoveries.update({ ...r, status: 'VERIFIEE', verification: { by: user.id, at: this.d.nowIso(), note: input.note, proofMatched } });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'enrolement.recovery.verified', resourceType: 'account_recovery', resourceId: id, details: { taxpayerId: r.taxpayerId } });
    return this.recoveryView(out);
  }

  decideRecovery(user: User, id: string, input: { approve: boolean; reason: string }) {
    authorize(user, 'enrolement:recovery.approve');
    const r = this.recoveries.get(id);
    if (!r || !r.taxpayerId) throw notFound('RECOVERY_NOT_FOUND', `Demande inconnue : ${id}`);
    if (r.status !== 'VERIFIEE') throw conflict('RECOVERY_BAD_STATE', 'La vérification d’identité au guichet doit précéder la décision.');
    assertDistinctPerson(user.id, [r.verification!.by], 'La récupération est approuvée par une personne distincte de celle qui a vérifié l’identité.');
    const out = this.recoveries.update({ ...r, status: input.approve ? 'APPROUVEE' : 'REJETEE', decision: { by: user.id, at: this.d.nowIso(), approve: input.approve, reason: input.reason } });
    if (input.approve) {
      this.d.ctx.taxpayers.changePhone(r.taxpayerId, r.newPhone, actorOf(user), `Récupération ${id} : ${input.reason}`);
      this.d.ctx.comms.publish('auth.recovery.completed', [taxpayerRecipient(this.d.ctx.taxpayers.get(r.taxpayerId))], {}, { entity: 'GOUVERNORAT' });
    }
    this.d.ctx.audit.append({ actor: actorOf(user), action: input.approve ? 'enrolement.recovery.approved' : 'enrolement.recovery.rejected', resourceType: 'account_recovery', resourceId: id, details: { verifiedBy: r.verification!.by, reason: input.reason } });
    return this.recoveryView(out);
  }

  recoveryView(r: AccountRecovery) {
    const { newPhone, idProofHash: _h, ...rest } = r;
    return { ...rest, newPhoneMasked: maskPhone(newPhone) };
  }

  pendingRecoveries(user: User) {
    if (!evaluate(user, 'enrolement:recovery.approve')) authorize(user, 'enrolement:recovery.verify');
    return this.recoveries.find((r) => r.status === 'DEMANDEE' || r.status === 'VERIFIEE').map((r) => this.recoveryView(r));
  }
}
