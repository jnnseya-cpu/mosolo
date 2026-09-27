/**
 * Extraction massive de données (§ 12.3 « Extraction massive : demandeur motivé → responsable des données → comité
 * des données — finalité, périmètre, durée, journalisation », § 12.5 « Télécharger massivement des données sans
 * justification : accès limité dans le temps, motif, DLP et alerte », § 31.1 « exports sensibles filigranés, chiffrés
 * et à durée d'expiration »).
 *
 * Harmonisé avec l'export signé historique (POST /v1/socle/exports, une personne habilitée, motif, second facteur) :
 * en deçà du seuil du registre (`socle.export_massif_lignes`), ce circuit reste inchangé (le document porte en plus un
 * filigrane) ; au-delà, il ouvre une demande à TROIS visas de personnes distinctes. Le paquet approuvé est chiffré au
 * repos (AES-256-GCM, clé dérivée de la clé de sauvegarde), filigrané (demandeur, heure, référence) et expire ;
 * il n'est remis qu'au demandeur, rechiffré par une phrase secrète qu'il fournit (scrypt + AES-256-GCM).
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync } from 'node:crypto';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import { ACR, isDemoMode, requireAcr, type User } from '../../core/auth.js';
import { canonicalJson, hmacSha256Hex, sha256Hex } from '../../core/crypto.js';
import { conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { userRecipient } from '../../modules/identity/recipients.js';
import { createBackup, type BackupDocument } from '../../persistence/backup.js';
import type { SnapshotRow } from '../../persistence/store.js';
import { securityNum } from '../integrite/gouvernance/parametres-securite.js';

export type BulkStatus = 'DEMANDEE' | 'VISA_DONNEES' | 'APPROUVEE' | 'REFUSEE' | 'EXPIREE' | 'RETIREE';

export interface Watermark {
  exportId: string;
  requestedBy: string;
  at: string;
  text: string;
}

export interface BulkExportRequest {
  id: string;
  requestedBy: string;
  requesterEntity: string;
  reason: string;
  finalite: string;
  repos: string[];
  rowsAtRequest: number;
  threshold: number;
  status: BulkStatus;
  requestedAt: string;
  dataOwner?: { by: string; at: string; approve: boolean; motif: string };
  committee?: { by: string; at: string; approve: boolean; motif: string };
  approvedAt?: string;
  expiresAt?: string;
  watermark?: Watermark;
  /** Paquet chiffré au repos (supprimé à l'expiration). */
  sealed?: { iv: string; tag: string; ct: string; sha256: string; rows: number };
  downloads: { at: string; by: string }[];
}

export const EXPORT_KEY_DEMO = 'demo-backup-key-NON-PRODUCTION';

export function exportKey(): string | null {
  const envKey = process.env.MOSOLO_BACKUP_KEY;
  if (envKey) return envKey;
  return isDemoMode() ? EXPORT_KEY_DEMO : null;
}

/** Filigrane lié au contenu : signé avec la clé de sauvegarde (un filigrane détaché ou modifié ne vérifie plus). */
export function watermarkFor(doc: BackupDocument, wm: Watermark, key: string) {
  return { watermark: wm, watermarkSignature: hmacSha256Hex(key, canonicalJson({ watermark: wm, contentSha256: doc.contentSha256 })) };
}

export function rowsInScope(rows: SnapshotRow[], repos: string[] | undefined): SnapshotRow[] {
  if (!repos?.length) return rows;
  return rows.filter((r) => repos.some((p) => r.repo === p || r.repo.startsWith(`${p}.`)));
}

export class BulkExportService {
  readonly requests = new InMemoryRepository<BulkExportRequest>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly collect: () => SnapshotRow[]) {}

  private now(): string {
    return this.ctx.clock.now().toISOString();
  }

  threshold(): number {
    return securityNum(this.ctx, 'socle.export_massif_lignes');
  }

  newWatermark(user: User, exportId: string): Watermark {
    const at = this.now();
    return { exportId, requestedBy: user.id, at, text: `MOSOLO — extraction ${exportId} — ${user.id} (${user.name}) — ${at} — usage limité à la finalité déclarée` };
  }

  private atRestKey(): Buffer {
    const key = exportKey();
    if (!key) throw unprocessable('BACKUP_KEY_MISSING', 'MOSOLO_BACKUP_KEY absente : export chiffré impossible.');
    return Buffer.from(hkdfSync('sha256', key, 'mosolo-extraction-massive', 'chiffrement-au-repos', 32));
  }

  sweep(): void {
    const now = this.now();
    for (const r of this.requests.find((x) => x.status === 'APPROUVEE' && !!x.expiresAt && x.expiresAt <= now)) {
      const { sealed: _s, ...rest } = r;
      this.requests.update({ ...rest, status: 'EXPIREE' });
      this.ctx.audit.append({ actor: { kind: 'system', id: 'echeancier' }, action: 'socle.export.bulk_expired', resourceType: 'bulk_export', resourceId: r.id, details: { requestedBy: r.requestedBy } });
    }
  }

  view(r: BulkExportRequest) {
    const { sealed, ...rest } = r;
    return { ...rest, packageAvailable: !!sealed && r.status === 'APPROUVEE', packageRows: sealed?.rows ?? null, packageSha256: sealed?.sha256 ?? null };
  }

  list(user: User) {
    this.sweep();
    const oversight = user.roles.some((r) => ['R25', 'R22', 'R23', 'R28', 'R02', 'R03', 'R05'].includes(r));
    return this.requests.all().filter((r) => oversight || r.requestedBy === user.id).reverse().map((r) => this.view(r));
  }

  create(user: User, input: { reason: string; finalite?: string; repos?: string[] }, rowsCount?: number) {
    authorize(user, 'socle:export');
    requireAcr(user, ACR.MFA);
    const rows = rowsCount ?? rowsInScope(this.collect(), input.repos).length;
    const threshold = this.threshold();
    const r = this.requests.insert({
      id: this.ids.next('EXM', 5), requestedBy: user.id, requesterEntity: user.entity, reason: input.reason.trim(), finalite: (input.finalite ?? input.reason).trim(),
      repos: input.repos ?? [], rowsAtRequest: rows, threshold, status: 'DEMANDEE', requestedAt: this.now(), downloads: [],
    });
    this.ctx.audit.append({
      actor: actorOf(user), action: 'socle.export.bulk_requested', resourceType: 'bulk_export', resourceId: r.id,
      details: { reason: r.reason, finalite: r.finalite, repos: r.repos, rows, threshold },
    });
    // Alerte immédiate sur export massif (§ 12.5) : sécurité, audit, protection des données.
    this.ctx.alerts.raiseOnce(`DLP:EXPORT_MASSIF:${r.id}`, {
      type: 'DLP_EXPORT_MASSIF', severity: 'HIGH', source: 'socle:exports', actor: actorOf(user),
      detail: `Demande d’extraction massive ${r.id} par ${user.id} : ${rows} lignes (seuil ${threshold}). Circuit à trois visas engagé.`,
      context: { exportId: r.id, rows, threshold, automaticEffect: 'AUCUN' }, notifyRoles: ['R22', 'R25'],
    });
    return this.view(r);
  }

  /** Visa du responsable des données (délégué à la protection des données, R25). */
  dataOwnerDecision(user: User, id: string, input: { approve: boolean; motif: string }) {
    authorize(user, 'socle:export.data_owner');
    this.sweep();
    const r = this.get(id);
    if (r.status !== 'DEMANDEE') throw conflict('BULK_EXPORT_STATE', `Demande au statut ${r.status}.`);
    assertDistinctPerson(user.id, [r.requestedBy], 'Extraction massive : le responsable des données est distinct du demandeur.');
    requireAcr(user, ACR.MFA);
    const dataOwner = { by: user.id, at: this.now(), approve: input.approve, motif: input.motif.trim() };
    const out = this.requests.update({ ...r, dataOwner, status: input.approve ? 'VISA_DONNEES' : 'REFUSEE' });
    this.ctx.audit.append({
      actor: actorOf(user), action: input.approve ? 'socle.export.bulk_data_owner_signed' : 'socle.export.bulk_refused', resourceType: 'bulk_export', resourceId: id,
      details: { requestedBy: r.requestedBy, step: 'RESPONSABLE_DONNEES', motif: dataOwner.motif },
      approvalChain: [{ by: r.requestedBy, step: 'DEMANDE', at: r.requestedAt }, { by: user.id, step: 'RESPONSABLE_DONNEES', at: dataOwner.at, decision: input.approve ? 'VISA' : 'REFUS' }],
    });
    return this.view(out);
  }

  /** Décision du comité des données : à l'approbation, le paquet est constitué, filigrané, chiffré et daté d'expiration. */
  committeeDecision(user: User, id: string, input: { approve: boolean; motif: string }) {
    authorize(user, 'socle:export.committee');
    this.sweep();
    const r = this.get(id);
    if (r.status !== 'VISA_DONNEES') throw conflict('BULK_EXPORT_STATE', r.status === 'DEMANDEE' ? 'Le visa du responsable des données est requis d’abord.' : `Demande au statut ${r.status}.`);
    assertDistinctPerson(user.id, [r.requestedBy, r.dataOwner!.by], 'Extraction massive : trois personnes distinctes (demandeur, responsable des données, comité).');
    requireAcr(user, ACR.MFA);
    const at = this.now();
    const committee = { by: user.id, at, approve: input.approve, motif: input.motif.trim() };
    const chain = [
      { by: r.requestedBy, step: 'DEMANDE', at: r.requestedAt },
      { by: r.dataOwner!.by, step: 'RESPONSABLE_DONNEES', at: r.dataOwner!.at, decision: 'VISA' },
      { by: user.id, step: 'COMITE_DONNEES', at, decision: input.approve ? 'APPROBATION' : 'REFUS' },
    ];
    if (!input.approve) {
      const out = this.requests.update({ ...r, committee, status: 'REFUSEE' });
      this.ctx.audit.append({ actor: actorOf(user), action: 'socle.export.bulk_refused', resourceType: 'bulk_export', resourceId: id, details: { requestedBy: r.requestedBy, step: 'COMITE_DONNEES', motif: committee.motif }, approvalChain: chain });
      return this.view(out);
    }
    const key = exportKey();
    if (!key) throw unprocessable('BACKUP_KEY_MISSING', 'MOSOLO_BACKUP_KEY absente : export signé impossible.');
    const requester = this.ctx.users.get(r.requestedBy);
    const wm = this.newWatermark(requester ?? ({ id: r.requestedBy, name: r.requestedBy } as User), r.id);
    const rows = rowsInScope(this.collect(), r.repos);
    const doc = createBackup(rows, key, { source: 'extraction-massive', now: this.ctx.clock.now() });
    const plain = Buffer.from(JSON.stringify({ ...doc, ...watermarkFor(doc, wm, key) }), 'utf8');
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.atRestKey(), iv);
    c.setAAD(Buffer.from(r.id));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    const expiresAt = new Date(Date.parse(at) + securityNum(this.ctx, 'socle.export_expiration_h') * 3_600_000).toISOString();
    const out = this.requests.update({
      ...r, committee, status: 'APPROUVEE', approvedAt: at, expiresAt, watermark: wm,
      sealed: { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64'), sha256: sha256Hex(plain), rows: rows.length },
    });
    this.ctx.audit.append({
      actor: actorOf(user), action: 'socle.export.bulk_approved', resourceType: 'bulk_export', resourceId: id,
      details: { requestedBy: r.requestedBy, dataOwner: r.dataOwner!.by, rows: rows.length, expiresAt, motif: committee.motif, packageSha256: out.sealed!.sha256 }, approvalChain: chain,
    });
    if (requester) this.ctx.comms.publish('privacy.data_export_ready', [userRecipient(requester)], {}, { entity: 'PLATEFORME' });
    return this.view(out);
  }

  /** Remise au SEUL demandeur, avant expiration : paquet rechiffré par sa phrase secrète (jamais en clair sur le réseau). */
  package(user: User, id: string, passphrase: string) {
    this.sweep();
    const r = this.get(id);
    if (r.requestedBy !== user.id) {
      this.ctx.audit.append({ actor: actorOf(user), action: 'socle.export.bulk_download_refused', resourceType: 'bulk_export', resourceId: id, outcome: 'DENIED', details: { reason: 'NOT_REQUESTER' } });
      throw forbidden('NOT_REQUESTER', 'Le paquet n’est remis qu’au demandeur.');
    }
    requireAcr(user, ACR.MFA);
    if (r.status === 'EXPIREE') throw conflict('BULK_EXPORT_EXPIRED', 'Paquet expiré : une nouvelle demande est nécessaire.');
    if (r.status !== 'APPROUVEE' || !r.sealed) throw conflict('BULK_EXPORT_STATE', `Demande au statut ${r.status}.`);
    if (passphrase.length < 12) throw unprocessable('WEAK_PASSPHRASE', 'Phrase secrète de 12 caractères minimum.');
    const d = createDecipheriv('aes-256-gcm', this.atRestKey(), Buffer.from(r.sealed.iv, 'base64'));
    d.setAAD(Buffer.from(r.id));
    d.setAuthTag(Buffer.from(r.sealed.tag, 'base64'));
    const plain = Buffer.concat([d.update(Buffer.from(r.sealed.ct, 'base64')), d.final()]);
    const salt = randomBytes(16);
    const k = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', k, iv);
    c.setAAD(Buffer.from(r.id));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    const at = this.now();
    this.requests.update({ ...r, downloads: [...r.downloads, { at, by: user.id }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'socle.export.bulk_downloaded', resourceType: 'bulk_export', resourceId: id, details: { rows: r.sealed.rows, packageSha256: r.sealed.sha256, downloads: r.downloads.length + 1 } });
    return {
      exportId: r.id, watermark: r.watermark, expiresAt: r.expiresAt, rows: r.sealed.rows, sha256: r.sealed.sha256,
      envelope: { alg: 'AES-256-GCM', kdf: { name: 'scrypt', N: 16384, r: 8, p: 1, salt: salt.toString('base64') }, aad: r.id, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ciphertext: ct.toString('base64') },
      notice: 'Paquet chiffré par votre phrase secrète : déchiffrement hors ligne ; filigrane nominatif ; usage limité à la finalité déclarée.',
    };
  }

  withdraw(user: User, id: string) {
    const r = this.get(id);
    if (r.requestedBy !== user.id) throw forbidden('NOT_REQUESTER', 'Seul le demandeur retire sa demande.');
    if (!['DEMANDEE', 'VISA_DONNEES'].includes(r.status)) throw conflict('BULK_EXPORT_STATE', `Demande au statut ${r.status}.`);
    const out = this.requests.update({ ...r, status: 'RETIREE' });
    this.ctx.audit.append({ actor: actorOf(user), action: 'socle.export.bulk_withdrawn', resourceType: 'bulk_export', resourceId: id, details: {} });
    return this.view(out);
  }

  private get(id: string): BulkExportRequest {
    const r = this.requests.get(id);
    if (!r) throw notFound('BULK_EXPORT_NOT_FOUND', `Demande d’extraction inconnue : ${id}`);
    return r;
  }
}
