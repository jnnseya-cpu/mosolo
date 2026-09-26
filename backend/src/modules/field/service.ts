/**
 * Synchronisation terrain (§ 28.6) : lots signés par la clé HMAC de l'appareil enrôlé ;
 * appareil révoqué ⇒ refus ; deux agents divergents sur un même champ ⇒ les deux constats sont conservés
 * et un dossier de conflit est ouvert (jamais « dernier écrit gagne » sur un champ fiscal).
 * Un constat ne crée jamais de dette.
 */
import { z } from 'zod';
import type { AuditLog } from '../../core/audit.js';
import type { User, UserDirectory } from '../../core/auth.js';
import type { Clock } from '../../core/clock.js';
import { canonicalJson, hmacSha256Hex, safeEqualHex, sha256Hex } from '../../core/crypto.js';
import { ApiError, badRequest, conflict, forbidden, unauthorized } from '../../core/errors.js';
import { authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import type { AlertService } from '../alerts/service.js';
import type { CommunicationService } from '../communications/service.js';
import { userRecipient } from '../identity/recipients.js';
import type { ObjectService } from '../objects/service.js';

export interface Device {
  id: string;
  agentUserId: string;
  key: string;
  status: 'ACTIF' | 'REVOQUE';
  enrolledAt: string;
  revokedAt?: string;
}

export interface Observation {
  id: string;
  objectId: string;
  field: string;
  value: unknown;
  agentId: string;
  deviceId: string;
  batchId: string;
  opId: string;
  observedAt: string;
  receivedAt: string;
  probativeStatus: 'OBSERVE';
}

export interface FieldConflict {
  id: string;
  objectId: string;
  field: string;
  versions: { observationId: string; agentId: string; value: unknown; observedAt: string }[];
  status: 'A_ARBITRER';
  openedAt: string;
}

export const batchSchema = z.object({
  batchId: z.string().min(1).max(100),
  deviceId: z.string().min(1).max(100),
  createdAt: z.string().datetime({ offset: true }),
  operations: z.array(z.object({
    opId: z.string().min(1).max(100),
    objectId: z.string().min(1),
    field: z.string().regex(/^[A-Za-z0-9_.]{1,64}$/),
    value: z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]),
    observedAt: z.string().datetime({ offset: true }),
  })).max(500),
});
export type Batch = z.infer<typeof batchSchema>;

export interface BatchResult {
  batchId: string;
  accepted: string[];
  rejected: { opId: string; reason: string }[];
  conflicts: FieldConflict[];
  revokedDevices: string[];
  replayed?: boolean;
}

export class FieldService {
  readonly devices = new InMemoryRepository<Device>();
  readonly observations = new InMemoryAppendOnlyRepository<Observation>();
  readonly conflicts = new InMemoryRepository<FieldConflict>();
  private readonly batches = new Map<string, { fingerprint: string; result: BatchResult }>();
  private readonly ids = new IdGenerator();

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly comms: CommunicationService,
    private readonly alerts: AlertService,
    private readonly users: UserDirectory,
    private readonly objects: ObjectService,
  ) {}

  enroll(id: string, agentUserId: string, key: string): Device {
    return this.devices.insert({ id, agentUserId, key, status: 'ACTIF', enrolledAt: this.clock.now().toISOString() });
  }

  revoke(id: string, reason: string): Device {
    const d = this.devices.get(id);
    if (!d) throw badRequest('UNKNOWN_DEVICE', `Appareil inconnu : ${id}`);
    const updated = this.devices.update({ ...d, status: 'REVOQUE', revokedAt: this.clock.now().toISOString() });
    this.audit.append({ actor: { kind: 'system', id: 'mdm' }, action: 'auth.device.revoked', resourceType: 'device', resourceId: id, details: { reason } });
    const agent = this.users.get(d.agentUserId);
    if (agent) this.comms.publish('auth.device.revoked', [userRecipient(agent)], { reference: id }, { entity: agent.entity });
    return updated;
  }

  sync(user: User, rawBody: string, signature: string | undefined): BatchResult {
    authorize(user, 'field.sync');
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw badRequest('INVALID_JSON', 'Corps JSON invalide.');
    }
    const parsed = batchSchema.safeParse(json);
    if (!parsed.success) throw badRequest('VALIDATION_ERROR', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const batch = parsed.data;
    const device = this.devices.get(batch.deviceId);
    const actor = { kind: 'device' as const, id: batch.deviceId };
    if (!device) throw unauthorized('UNKNOWN_DEVICE', 'Terminal non enrôlé.');
    if (device.status === 'REVOQUE') {
      this.alerts.raise({ type: 'REVOKED_DEVICE_SYNC', severity: 'HIGH', source: 'terrain', detail: `Tentative de synchronisation depuis le terminal révoqué ${device.id}.`, context: { userId: user.id }, actor });
      throw forbidden('DEVICE_REVOKED', 'Terminal révoqué : synchronisation refusée.');
    }
    if (device.agentUserId !== user.id) throw forbidden('DEVICE_USER_MISMATCH', 'Ce terminal n’est pas affecté à cet agent.');
    if (!signature || !safeEqualHex(hmacSha256Hex(device.key, rawBody), signature.replace(/^sha256=/, '').toLowerCase())) {
      this.alerts.raise({ type: 'INVALID_DEVICE_SIGNATURE', severity: 'HIGH', source: 'terrain', detail: `Signature de lot invalide (${device.id}).`, context: { batchId: batch.batchId }, actor });
      throw unauthorized('INVALID_DEVICE_SIGNATURE', 'Signature du lot invalide.');
    }
    const fingerprint = sha256Hex(canonicalJson(batch));
    const previous = this.batches.get(batch.batchId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw conflict('BATCH_ID_REUSED', 'Identifiant de lot déjà utilisé avec un autre contenu.');
      return { ...previous.result, replayed: true };
    }

    const now = this.clock.now().toISOString();
    const result: BatchResult = { batchId: batch.batchId, accepted: [], rejected: [], conflicts: [], revokedDevices: [] };
    for (const op of batch.operations) {
      let obj;
      try {
        obj = this.objects.get(op.objectId);
      } catch (e) {
        if (e instanceof ApiError) {
          result.rejected.push({ opId: op.opId, reason: 'OBJECT_NOT_FOUND' });
          continue;
        }
        throw e;
      }
      if (user.territory && !user.territory.includes(obj.commune)) {
        result.rejected.push({ opId: op.opId, reason: 'OUT_OF_TERRITORY' });
        continue;
      }
      const obs = this.observations.append({
        id: this.ids.next('OBS'), objectId: op.objectId, field: op.field, value: op.value, agentId: user.id, deviceId: device.id,
        batchId: batch.batchId, opId: op.opId, observedAt: op.observedAt, receivedAt: now, probativeStatus: 'OBSERVE',
      });
      result.accepted.push(op.opId);
      const divergent = this.observations.find(
        (o) => o.objectId === op.objectId && o.field === op.field && o.agentId !== user.id && canonicalJson(o.value) !== canonicalJson(op.value),
      );
      if (divergent.length > 0) {
        const existing = this.conflicts.findOne((c) => c.objectId === op.objectId && c.field === op.field && c.status === 'A_ARBITRER');
        const version = (o: Observation) => ({ observationId: o.id, agentId: o.agentId, value: o.value, observedAt: o.observedAt });
        const conflictRecord = existing
          ? this.conflicts.update({ ...existing, versions: [...existing.versions, version(obs)] })
          : this.conflicts.insert({
              id: this.ids.next('CNF'), objectId: op.objectId, field: op.field, versions: [...divergent.map(version), version(obs)], status: 'A_ARBITRER', openedAt: now,
            });
        result.conflicts.push(conflictRecord);
        this.audit.append({ actor, action: 'mission.sync.conflict', resourceType: 'fiscal_object', resourceId: op.objectId, details: { field: op.field, conflictId: conflictRecord.id } });
      } else {
        // Valeur observée non conflictuelle : enregistrée à part des attributs déclarés.
        this.objects.objects.update({ ...obj, observed: { ...obj.observed, [op.field]: op.value } });
      }
    }
    result.revokedDevices = this.devices.find((d) => d.status === 'REVOQUE').map((d) => d.id);
    this.batches.set(batch.batchId, { fingerprint, result });
    this.audit.append({
      actor, action: 'mission.sync.completed', resourceType: 'field_batch', resourceId: batch.batchId,
      details: { agentId: user.id, accepted: result.accepted.length, rejected: result.rejected.length, conflicts: result.conflicts.length },
    });
    const supervisors = this.users.withRole('R09').map(userRecipient);
    if (result.conflicts.length > 0) this.comms.publish('mission.sync.conflict', supervisors, { reference: batch.batchId }, { entity: user.entity });
    this.comms.publish('mission.sync.completed', [userRecipient(user)], { reference: batch.batchId }, { entity: user.entity });
    return result;
  }
}
