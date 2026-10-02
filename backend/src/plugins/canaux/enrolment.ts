/**
 * Enrôlement assisté (module 63, § 13A, § H.7) : à domicile, sur site ou au guichet MOSOLO, hors ligne.
 *
 * - Lots signés par la clé HMAC du terminal enrôlé et affecté à l'agent (même contrôle que la synchronisation terrain).
 * - Impossible de terminer sans lecture du résumé ET consentement (voix enregistrée ou témoin identifié ; empreinte
 *   seulement si J18 certifié — ARB-24) ; toute tentative refusée est journalisée.
 * - Zone et horaire de l'agent contrôlés ; horodatage, GPS et terminal conservés ; consentement lié à la mission.
 * - Compte N0-A + carte MOSOLO ; aucun paiement demandé ni reçu par l'agent (attestation obligatoire, AC-INC-02).
 * - Doublon possible ⇒ dossier « à revoir », décision d'un superviseur (jamais de fusion automatique).
 */
import { isLanguageCode, type LanguageCode } from '@mosolo/shared';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { canonicalJson, hmacSha256Hex, safeEqualHex, sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { userRecipient } from '../../modules/identity/recipients.js';
import { maskPhone } from '../../modules/identity/service.js';
import { isCommune } from '../../reference/kinshasa.js';
import type { CardRegistry } from './cards.js';
import {
  CONSENT_METHODS, DECLARED_OBJECT_TYPES, ENROLMENT_HOURS, FINGERPRINT_CONSENT_CERTIFIED, kinshasaHour, type AssistedEnrolment,
} from './model.js';

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/** Consentement volontairement permissif au niveau du schéma : les manques sont refusés ET journalisés par enregistrement. */
export const enrolmentRecordSchema = z.object({
  localId: z.string().min(4).max(100),
  channel: z.enum(['DOMICILE', 'SITE', 'GUICHET_MOSOLO']),
  missionId: z.string().min(1).max(100),
  capturedAt: z.string().datetime({ offset: true }),
  gps: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(10_000) }),
  commune: z.string().min(1).max(60),
  quartier: z.string().min(1).max(80),
  landmark: z.string().min(3).max(300),
  person: z.object({
    fullName: z.string().trim().min(2).max(120),
    sex: z.enum(['F', 'M']).optional(),
    birthYear: z.number().int().min(1900).max(2026).optional(),
    language: z.string().refine(isLanguageCode, 'langue inconnue'),
    photoSha256: hex64.optional(),
    phone: z.string().regex(/^\+?\d{9,15}$/).optional(),
    proxyPhone: z.string().regex(/^\+?\d{9,15}$/).optional(),
  }),
  declaredObjects: z.array(z.object({ type: z.enum(DECLARED_OBJECT_TYPES), description: z.string().min(2).max(200) })).max(10).default([]),
  consent: z.object({
    method: z.enum(CONSENT_METHODS).optional(),
    summaryLanguage: z.string().optional(),
    summaryAudioVersion: z.string().max(60).optional(),
    summaryReadAt: z.string().datetime({ offset: true }).optional(),
    givenAt: z.string().datetime({ offset: true }).optional(),
    voiceRecordingSha256: hex64.optional(),
    witness: z.object({ name: z.string().trim().min(2).max(120), relation: z.string().trim().min(2).max(60), idRef: z.string().max(60).optional() }).optional(),
  }).default({}),
  noPaymentAttested: z.boolean(),
});
export type EnrolmentRecord = z.infer<typeof enrolmentRecordSchema>;

export const enrolmentBatchSchema = z.object({
  batchId: z.string().min(4).max(100),
  deviceId: z.string().min(1).max(100),
  createdAt: z.string().datetime({ offset: true }),
  records: z.array(enrolmentRecordSchema).min(1).max(200),
});

export interface RecordResult {
  localId: string;
  outcome: 'CREE' | 'A_REVOIR' | 'REJETE';
  reason?: string;
  detail?: string;
  enrolmentId?: string;
  taxpayerId?: string;
  iuc?: string;
  cardNumber?: string;
  replayed?: boolean;
}

function normName(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
}

export class EnrolmentService {
  readonly enrolments = new InMemoryRepository<AssistedEnrolment>();
  private readonly batches = new Map<string, { fingerprint: string; results: RecordResult[] }>();
  private readonly byLocalId = new Map<string, RecordResult>();
  private readonly ids = new IdGenerator();
  rejectedAttempts = 0;

  constructor(private readonly ctx: AppContext, private readonly cards: CardRegistry) {}

  /** Réception d'un lot signé (hors ligne ou guichet) : x-device-signature = HMAC-SHA256(clé du terminal, corps brut). */
  syncBatch(user: User, rawBody: string, signature: string | undefined): { batchId: string; results: RecordResult[]; replayed: boolean } {
    authorize(user, 'canaux:enrolment.create');
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw badRequest('INVALID_JSON', 'Corps JSON invalide.');
    }
    const parsed = enrolmentBatchSchema.safeParse(json);
    if (!parsed.success) throw badRequest('VALIDATION_ERROR', parsed.error.issues.map((i) => `${i.path.join('.')} : ${i.message}`).join(' ; '));
    const batch = parsed.data;
    const device = this.ctx.field.devices.get(batch.deviceId);
    const actor = { kind: 'device' as const, id: batch.deviceId };
    if (!device) throw unauthorized('UNKNOWN_DEVICE', 'Terminal non enrôlé : enrôlement assisté refusé.');
    if (device.status === 'REVOQUE') {
      this.ctx.alerts.raise({ type: 'REVOKED_DEVICE_ENROLMENT', severity: 'HIGH', source: 'canaux:enrolement', detail: `Lot d'enrôlement depuis le terminal révoqué ${device.id}.`, context: { userId: user.id }, actor });
      throw forbidden('DEVICE_REVOKED', 'Terminal révoqué : enrôlement refusé.');
    }
    if (device.agentUserId !== user.id) throw forbidden('DEVICE_USER_MISMATCH', 'Ce terminal n’est pas affecté à cet agent.');
    if (!signature || !safeEqualHex(hmacSha256Hex(device.key, rawBody), signature.replace(/^sha256=/, '').toLowerCase())) {
      this.ctx.alerts.raise({ type: 'INVALID_DEVICE_SIGNATURE', severity: 'HIGH', source: 'canaux:enrolement', detail: `Signature de lot d'enrôlement invalide (${device.id}).`, context: { batchId: batch.batchId }, actor });
      throw unauthorized('INVALID_DEVICE_SIGNATURE', 'Signature du lot invalide.');
    }
    const fingerprint = sha256Hex(canonicalJson(batch));
    const previous = this.batches.get(batch.batchId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw conflict('BATCH_ID_REUSED', 'Identifiant de lot déjà utilisé avec un autre contenu.');
      return { batchId: batch.batchId, results: previous.results.map((r) => ({ ...r, replayed: true })), replayed: true };
    }
    const results = batch.records.map((r) => {
      const done = this.byLocalId.get(`${user.id}:${r.localId}`);
      if (done) return { ...done, replayed: true };
      const res = this.processRecord(user, device.id, batch.batchId, r);
      if (res.outcome !== 'REJETE') this.byLocalId.set(`${user.id}:${r.localId}`, res);
      return res;
    });
    this.batches.set(batch.batchId, { fingerprint, results });
    this.ctx.audit.append({
      actor, action: 'canaux.enrolment.batch_synced', resourceType: 'enrolment_batch', resourceId: batch.batchId,
      details: { agentId: user.id, records: results.length, created: results.filter((r) => r.outcome === 'CREE').length, rejected: results.filter((r) => r.outcome === 'REJETE').length },
    });
    return { batchId: batch.batchId, results, replayed: false };
  }

  private reject(user: User, deviceId: string, r: EnrolmentRecord, reason: string, detail: string): RecordResult {
    this.rejectedAttempts += 1;
    this.ctx.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'canaux.enrolment.attempt_rejected', resourceType: 'assisted_enrolment', resourceId: r.localId,
      outcome: 'DENIED', details: { reason, deviceId, missionId: r.missionId, commune: r.commune, capturedAt: r.capturedAt },
    });
    return { localId: r.localId, outcome: 'REJETE', reason, detail };
  }

  /** Contrôles métier d'un enregistrement ; renvoie un refus journalisé ou crée le dossier. */
  processRecord(user: User, deviceId: string, batchId: string, r: EnrolmentRecord, opts: { fixedCardNumber?: string } = {}): RecordResult {
    const now = this.ctx.clock.now();
    const captured = new Date(r.capturedAt);
    if (!isCommune(r.commune)) return this.reject(user, deviceId, r, 'UNKNOWN_COMMUNE', `Commune inconnue : ${r.commune}`);
    if (user.territory && !user.territory.includes(r.commune)) return this.reject(user, deviceId, r, 'OUT_OF_TERRITORY', `Commune ${r.commune} hors de la zone de l'agent.`);
    const hour = kinshasaHour(captured);
    if (hour < ENROLMENT_HOURS.from || hour >= ENROLMENT_HOURS.to) {
      return this.reject(user, deviceId, r, 'OUT_OF_HOURS', `Enrôlement hors de la plage horaire autorisée (${ENROLMENT_HOURS.from} h – ${ENROLMENT_HOURS.to} h, heure de Kinshasa).`);
    }
    if (captured.getTime() > now.getTime() + 5 * 60_000) return this.reject(user, deviceId, r, 'CAPTURED_IN_FUTURE', 'Horodatage de saisie postérieur à l’heure serveur.');
    if (now.getTime() - captured.getTime() > 30 * 24 * 3_600_000) return this.reject(user, deviceId, r, 'RECORD_TOO_OLD', 'Saisie de plus de 30 jours : nouvel enrôlement requis.');
    if (r.noPaymentAttested !== true) {
      return this.reject(user, deviceId, r, 'NO_PAYMENT_ATTESTATION_MISSING', "L'agent doit attester qu'aucun paiement n'a été demandé ni reçu.");
    }
    const c = r.consent;
    if (!c.summaryReadAt || !c.summaryAudioVersion || !c.summaryLanguage) {
      return this.reject(user, deviceId, r, 'SUMMARY_NOT_READ', 'Lecture du résumé (audio validé, dans la langue choisie) non attestée : enrôlement impossible.');
    }
    if (!c.method || !c.givenAt) return this.reject(user, deviceId, r, 'CONSENT_REQUIRED', 'Consentement non recueilli : enrôlement impossible.');
    if (new Date(c.summaryReadAt) > new Date(c.givenAt)) return this.reject(user, deviceId, r, 'CONSENT_BEFORE_SUMMARY', 'Le consentement doit suivre la lecture du résumé.');
    if (c.method === 'EMPREINTE' && !FINGERPRINT_CONSENT_CERTIFIED) {
      return this.reject(user, deviceId, r, 'CONSENT_METHOD_NOT_CERTIFIED', "Empreinte comme marque de consentement non ouverte tant que J18 n'est pas certifié (ARB-24) : voix ou témoin.");
    }
    if (c.method === 'VOIX' && !c.voiceRecordingSha256) return this.reject(user, deviceId, r, 'VOICE_RECORDING_MISSING', 'Consentement vocal sans empreinte de l’enregistrement.');
    if (c.method === 'TEMOIN' && !c.witness) return this.reject(user, deviceId, r, 'WITNESS_MISSING', 'Consentement devant témoin sans témoin identifié.');
    if (c.witness && normName(c.witness.name) === normName(r.person.fullName)) return this.reject(user, deviceId, r, 'WITNESS_IS_PERSON', 'Le témoin doit être une autre personne.');

    // Doublons possibles : même nom normalisé (et année si connue) ou même téléphone ; jamais de fusion automatique.
    const key = normName(r.person.fullName);
    const candidates: { taxpayerId: string; reason: string }[] = [];
    for (const t of this.ctx.taxpayers.taxpayers.all()) {
      if (r.person.phone && t.phone === r.person.phone.replace(/[\s-]/g, '')) candidates.push({ taxpayerId: t.id, reason: 'MEME_TELEPHONE' });
      else if (normName(t.fullName) === key) candidates.push({ taxpayerId: t.id, reason: 'MEME_NOM' });
    }
    const id = this.ids.next('ENR');
    const enrolment: AssistedEnrolment = {
      id, localId: r.localId, batchId, channel: r.channel, agentId: user.id, deviceId, missionId: r.missionId, capturedAt: r.capturedAt,
      receivedAt: now.toISOString(), gps: r.gps, commune: r.commune, quartier: r.quartier, landmark: r.landmark,
      person: {
        fullName: r.person.fullName, ...(r.person.sex ? { sex: r.person.sex } : {}), ...(r.person.birthYear ? { birthYear: r.person.birthYear } : {}),
        language: r.person.language as LanguageCode, ...(r.person.photoSha256 ? { photoSha256: r.person.photoSha256 } : {}), hasPhone: !!r.person.phone,
      },
      ...(r.person.proxyPhone ? { proxyPhoneMasked: maskPhone(r.person.proxyPhone) } : {}),
      declaredObjects: r.declaredObjects,
      consent: {
        method: c.method, summaryLanguage: c.summaryLanguage as LanguageCode, summaryAudioVersion: c.summaryAudioVersion, summaryReadAt: c.summaryReadAt,
        givenAt: c.givenAt, ...(c.voiceRecordingSha256 ? { voiceRecordingSha256: c.voiceRecordingSha256 } : {}),
        ...(c.witness ? { witness: { name: c.witness.name, relation: c.witness.relation, ...(c.witness.idRef ? { idRef: c.witness.idRef } : {}) } } : {}),
        missionId: r.missionId,
      },
      noPaymentAttested: true, status: candidates.length ? 'A_REVOIR' : 'CREE', duplicateCandidates: candidates, pinSet: false,
    };
    this.enrolments.insert(enrolment);
    this.ctx.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'canaux.enrolment.consent_recorded', resourceType: 'assisted_enrolment', resourceId: id,
      details: { missionId: r.missionId, method: c.method, summaryAudioVersion: c.summaryAudioVersion, summaryReadAt: c.summaryReadAt, givenAt: c.givenAt, deviceId, recordedAt: now.toISOString() },
    });
    if (candidates.length) {
      this.ctx.audit.append({ actor: { kind: 'system', id: 'canaux:enrolement' }, action: 'canaux.enrolment.duplicate_suspected', resourceType: 'assisted_enrolment', resourceId: id, details: { candidates: candidates.length } });
      this.ctx.comms.publish('account.duplicate_suspected', this.ctx.users.withRole('R09').map(userRecipient), { reference: id }, { entity: user.entity });
      return { localId: r.localId, outcome: 'A_REVOIR', enrolmentId: id, detail: 'Doublon possible : décision d’un superviseur requise avant création du compte.' };
    }
    const created = this.createAccount(enrolment, r.person.phone, user.id, opts.fixedCardNumber);
    return { localId: r.localId, outcome: 'CREE', enrolmentId: id, taxpayerId: created.taxpayerId, iuc: created.iuc, cardNumber: created.cardNumber };
  }

  /** Compte N0-A + carte MOSOLO. Sans téléphone : identifiant technique non joignable (aucun SMS ne part). */
  private createAccount(e: AssistedEnrolment, phone: string | undefined, by: string, fixedCardNumber?: string) {
    const tp = this.ctx.taxpayers.register(
      { phone: phone ?? `SANS-TELEPHONE-${e.id}`, fullName: e.person.fullName, language: e.person.language, situation: 'other' },
    );
    this.ctx.taxpayers.taxpayers.update({ ...tp, verificationLevel: 'N0A' });
    const card = this.cards.issue({ taxpayerId: tp.id, commune: e.commune, ...(e.person.photoSha256 ? { photoSha256: e.person.photoSha256 } : {}), enrolmentId: e.id, issuedBy: by, ...(fixedCardNumber ? { fixedNumber: fixedCardNumber } : {}) });
    this.enrolments.update({ ...this.enrolments.get(e.id)!, status: 'CREE', taxpayerId: tp.id, iuc: tp.iuc, cardNumber: card.number });
    this.ctx.audit.append({
      actor: { kind: 'user', id: by }, action: 'canaux.enrolment.created', resourceType: 'taxpayer', resourceId: tp.id,
      details: { enrolmentId: e.id, level: 'N0A', missionId: e.missionId, channel: e.channel, commune: e.commune, cardSuffix: card.number.slice(-4), paymentRequested: false },
    });
    return { taxpayerId: tp.id, iuc: tp.iuc, cardNumber: card.number };
  }

  /** Décision humaine sur un doublon possible (superviseur distinct de l'agent). */
  review(user: User, id: string, decision: 'DISTINCT' | 'DOUBLON', motif: string) {
    authorize(user, 'canaux:enrolment.review');
    const e = this.get(id);
    if (e.status !== 'A_REVOIR') throw conflict('ENROLMENT_NOT_UNDER_REVIEW', 'Dossier non soumis à revue.');
    assertDistinctPerson(user.id, [e.agentId], "L'agent ayant réalisé l'enrôlement ne peut pas trancher le doublon.");
    const review = { decision, motif, by: user.id, at: this.ctx.clock.now().toISOString() };
    this.enrolments.update({ ...e, review, status: decision === 'DOUBLON' ? 'DOUBLON_CONFIRME' : 'A_REVOIR' });
    this.ctx.audit.append({ actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'canaux.enrolment.reviewed', resourceType: 'assisted_enrolment', resourceId: id, details: { decision, motif } });
    if (decision === 'DISTINCT') this.createAccount(this.get(id), undefined, user.id);
    return this.view(this.get(id));
  }

  get(id: string): AssistedEnrolment {
    const e = this.enrolments.get(id);
    if (!e) throw notFound('ENROLMENT_NOT_FOUND', `Dossier d'enrôlement inconnu : ${id}`);
    return e;
  }

  list(user: User) {
    authorize(user, 'canaux:enrolment.read');
    const mine = user.roles.includes('R10') || user.roles.includes('R12');
    const supervisor = user.roles.some((r) => ['R09', 'R22', 'R25'].includes(r));
    return this.enrolments
      .find((e) => supervisor || (mine && e.agentId === user.id))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .map((e) => this.view(e));
  }

  /** Vue de dossier : le téléphone d'un proche reste masqué, l'empreinte vocale n'est qu'un condensat. */
  view(e: AssistedEnrolment) {
    return { ...e, cardNumberFormatted: e.cardNumber ? `${e.cardNumber.slice(0, 4)} ${e.cardNumber.slice(4, 8)} ${e.cardNumber.slice(8)}` : null };
  }
}
