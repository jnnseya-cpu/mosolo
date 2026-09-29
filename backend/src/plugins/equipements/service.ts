/**
 * Gestion des équipements terrain (module 58, § 15.4, § 31) — enregistrer, sécuriser et révoquer les terminaux des
 * agents, construit sur le registre des terminaux du socle (ctx.field.devices : clé HMAC, révocation) :
 *  - MDM : enrôlement, politiques versionnées (verrouillage, version minimale du système, chiffrement, expiration des
 *    données hors ligne), effacement à distance — par un ADAPTATEUR : bac à sable intégré (commandes journalisées et
 *    acquittées par le terminal à son prochain signalement) ; outil MDM réel [À RACCORDER — convention requise] ;
 *  - liaison appareil–utilisateur ATTESTÉE : défi aléatoire signé par la clé du terminal pour l'agent affecté ;
 *  - EXPIRATION AUTOMATIQUE des données : chaque signalement reçoit la date de purge des données de référence mises en
 *    cache ; un terminal silencieux au-delà du délai de la politique reçoit une commande de purge (échéancier) ;
 *  - RÉVOCATION EN MASSE : toute révocation de terminal du socle (dont la suspension d'un sous-traitant, qui révoque
 *    d'un coup ses agents et leurs terminaux) déclenche l'effacement à distance ;
 *  - DÉTECTION D'APPAREIL MODIFIÉ : signalement d'intégrité (racine, chargeur déverrouillé, émulateur, débogage,
 *    signature de l'application, version du système) ⇒ QUARANTAINE (synchronisation refusée, aucune donnée effacée),
 *    incident et alerte ; levée décidée par une personne ;
 *  - indicateurs : terminaux actifs ; incidents ; révocations.
 * Suivi des résultats, pas surveillance intrusive : aucune position ni aucun usage personnel n'est collecté.
 *
 * TÉLÉPHONE PERSONNEL (ajout du 29/09/2026 — les agents utilisent leur propre téléphone Android ou iOS avec les
 * applications MOSOLO) : mode par défaut à l'enrôlement. Politique TERRAIN-PERSONNEL au périmètre APPLICATION : profil
 * professionnel Android / inscription utilisateur iOS (User Enrollment) ; exigences limitées au verrouillage d'écran, au
 * chiffrement et à la version minimale du système ; tout effacement (révocation, perte, départ) ne vise QUE les données
 * de l'application MOSOLO, jamais le téléphone ; charte d'usage acceptée par l'agent et journalisée. Le mode
 * « terminal de la Province » (politique TERRAIN-STANDARD, périmètre APPAREIL) reste disponible, inchangé.
 */
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { DAY_MS } from '../../core/clock.js';
import { hmacSha256Hex, randomSecret, safeEqualHex, sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';

/** Politique de terminal — valeurs PAR DÉFAUT, à confirmer par le maître d'ouvrage (registre des seuils). */
export interface DevicePolicy {
  id: string;
  code: string;
  version: number;
  label: string;
  screenLockMinutes: number;
  minOsVersion: number;
  offlineDataTtlDays: number;
  encryptionRequired: boolean;
  sideloadingAllowed: boolean;
  /** Empreintes SHA-256 des signatures des applications officielles admises. */
  approvedAppSignatures: string[];
  /** Périmètre de gestion : APPAREIL (terminal de la Province) ou APPLICATION (téléphone personnel). Défaut : APPAREIL. */
  scope?: 'APPAREIL' | 'APPLICATION';
  status: 'PAR_DEFAUT' | 'CONFIRMEE';
  createdBy: string;
  createdAt: string;
}
export const DEMO_APP_SIGNATURE = sha256Hex('mosolo-terrain-application-officielle-demo');

export interface IntegrityReport {
  osVersion: number;
  appSignatureSha256: string;
  rooted: boolean;
  bootloaderUnlocked: boolean;
  emulator: boolean;
  debuggable: boolean;
  encrypted: boolean;
  oldestCachedDataAt?: string;
  acknowledgedCommands?: string[];
}

export interface DeviceCommand { id: string; kind: 'EFFACEMENT' | 'PURGE_DONNEES' | 'POLITIQUE'; at: string; by: string; motif: string; status: 'EN_ATTENTE' | 'EFFECTUE'; ackAt?: string; mdmRef?: string; /** Effacement : APPLICATION (données MOSOLO seulement) ou APPAREIL (terminal de la Province). */ perimetre?: 'APPLICATION' | 'APPAREIL' }
export interface DeviceIncident { id: string; at: string; kind: 'APPAREIL_MODIFIE' | 'SYNC_EN_QUARANTAINE' | 'PERTE_DECLAREE' | 'SIGNATURE_INVALIDE'; detail: string }
export interface Equipment {
  id: string;
  userId: string;
  policyCode: string;
  policyVersion: number;
  model: string;
  os: string;
  mdm: { adapter: string; ref: string };
  /** Propriété du terminal : PERSONNEL (téléphone de l'agent, défaut) ou PROVINCE. */
  ownership?: 'PERSONNEL' | 'PROVINCE';
  /** Charte d'usage du téléphone personnel acceptée par l'agent. */
  charte?: { version: string; acceptedAt: string };
  enrolledAt: string;
  enrolledBy: string;
  binding: { status: 'A_ATTESTER' | 'ATTESTEE'; challenge?: { nonce: string; expiresAt: string }; attestedAt?: string };
  state: 'ACTIF' | 'QUARANTAINE' | 'DONNEES_EXPIREES' | 'REVOQUE';
  quarantine?: { at: string; reasons: string[]; lifted?: { by: string; at: string; motif: string } };
  lastCheckIn?: string;
  lastReport?: IntegrityReport & { verdict: 'CONFORME' | 'MODIFIE'; reasons: string[] };
  commands: DeviceCommand[];
  incidents: DeviceIncident[];
  revokedAt?: string;
}

/** Adaptateur MDM : bac à sable intégré par défaut ; outil MDM réel à raccorder par convention. */
export interface MdmAdapter {
  readonly name: string;
  readonly external: boolean;
  enroll(deviceId: string, policy: DevicePolicy): string;
  push(deviceId: string, command: 'EFFACEMENT' | 'PURGE_DONNEES' | 'POLITIQUE', perimetre?: 'APPLICATION' | 'APPAREIL'): string;
}
export class SandboxMdmAdapter implements MdmAdapter {
  readonly name = 'MDM bac à sable (intégré)';
  readonly external = false;
  readonly log: { at: number; deviceId: string; op: string }[] = [];
  private n = 0;
  enroll(deviceId: string): string { this.log.push({ at: Date.now(), deviceId, op: 'ENROLEMENT' }); return `sandbox-mdm-${deviceId}`; }
  push(deviceId: string, command: string, perimetre?: string): string { this.n++; this.log.push({ at: Date.now(), deviceId, op: perimetre ? `${command}:${perimetre}` : command }); return `sandbox-cmd-${this.n}`; }
}

/** Charte d'usage du téléphone personnel (version 1) — texte PAR DÉFAUT, à confirmer par le maître d'ouvrage. */
export const CHARTE_TELEPHONE_PERSONNEL = {
  version: '1',
  texte: [
    'Votre téléphone reste le vôtre : la Province ne voit ni vos photos, ni vos messages, ni vos applications, ni votre position en dehors des constats que vous enregistrez.',
    'Seule l’application MOSOLO est gérée (profil professionnel Android ou inscription utilisateur iOS). Exigences : verrouillage d’écran, stockage chiffré, système à jour au minimum demandé.',
    'En cas de perte, de vol, de suspension ou de départ, seules les données de l’application MOSOLO sont effacées à distance ; le reste du téléphone n’est jamais touché.',
    'Les données de travail en cache expirent automatiquement après la durée fixée par la politique si le téléphone ne se connecte plus.',
    'Aucun encaissement d’espèces : l’application ne permet que le paiement numérique vers le compte public.',
  ],
} as const;

export class EquipementService {
  readonly policies = new InMemoryRepository<DevicePolicy>();
  readonly equipments = new InMemoryRepository<Equipment>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, readonly mdm: MdmAdapter = new SandboxMdmAdapter()) {
    const at = ctx.clock.now().toISOString();
    this.policies.insert({
      id: 'TERRAIN-STANDARD@1', code: 'TERRAIN-STANDARD', version: 1, label: 'Terminal d’agent de terrain (politique standard)', screenLockMinutes: 5, minOsVersion: 10,
      offlineDataTtlDays: 7, encryptionRequired: true, sideloadingAllowed: false, approvedAppSignatures: [DEMO_APP_SIGNATURE], status: 'PAR_DEFAUT', createdBy: 'systeme', createdAt: at,
    });
    // Téléphone personnel de l'agent (29/09/2026) : périmètre APPLICATION — valeurs PAR DÉFAUT, à confirmer.
    this.policies.insert({
      id: 'TERRAIN-PERSONNEL@1', code: 'TERRAIN-PERSONNEL', version: 1, label: 'Téléphone personnel de l’agent (application MOSOLO seulement)', screenLockMinutes: 5, minOsVersion: 10,
      offlineDataTtlDays: 7, encryptionRequired: true, sideloadingAllowed: false, approvedAppSignatures: [DEMO_APP_SIGNATURE], scope: 'APPLICATION', status: 'PAR_DEFAUT', createdBy: 'systeme', createdAt: at,
    });
    // Synchronisation refusée depuis un terminal en quarantaine (données conservées, rien n'est effacé).
    ctx.field.syncGuards.push((device) => {
      const e = this.equipments.get(device.id);
      if (e?.state === 'QUARANTAINE') {
        this.addIncident(e, 'SYNC_EN_QUARANTAINE', 'Tentative de synchronisation depuis un terminal en quarantaine.');
        throw forbidden('DEVICE_QUARANTINED', 'Terminal en quarantaine (modification détectée) : synchronisation refusée jusqu’à la levée par la sécurité.');
      }
    });
    // Révocation d'un terminal du socle (y compris en masse, lors de la suspension d'un sous-traitant) : effacement à distance.
    ctx.audit.onAppend((r) => {
      if (r.action !== 'auth.device.revoked' || !r.resourceId) return;
      const e = this.equipments.get(r.resourceId);
      if (e && e.state !== 'REVOQUE') this.markRevoked(e, 'mdm', String(r.details.reason ?? 'Révocation'));
      else if (!e) {
        const d = ctx.field.devices.get(r.resourceId);
        if (d) { const b = this.blank(d.id, d.agentUserId, 'socle', d.enrolledAt); this.equipments.insert({ ...b, state: 'REVOQUE', revokedAt: this.now(), commands: [this.command(d.id, 'EFFACEMENT', 'mdm', String(r.details.reason ?? 'Révocation'), this.perimetre(b))] }); }
      }
    });
  }

  private now() { return this.ctx.clock.now().toISOString(); }

  private policy(code: string) {
    const p = this.policies.find((x) => x.code === code).sort((a, b) => b.version - a.version)[0];
    if (!p) throw notFound('POLICY_NOT_FOUND', `Politique inconnue : ${code}`);
    return p;
  }

  private blank(id: string, userId: string, by: string, enrolledAt?: string): Equipment {
    const p = this.policy('TERRAIN-STANDARD');
    return { id, userId, policyCode: p.code, policyVersion: p.version, model: 'non déclaré', os: 'non déclaré', mdm: { adapter: this.mdm.name, ref: this.mdm.enroll(id, p) }, enrolledAt: enrolledAt ?? this.now(), enrolledBy: by, binding: { status: 'A_ATTESTER' }, state: 'ACTIF', commands: [], incidents: [] };
  }

  private command(deviceId: string, kind: DeviceCommand['kind'], by: string, motif: string, perimetre?: DeviceCommand['perimetre']): DeviceCommand {
    return { id: this.ids.next('CMD'), kind, at: this.now(), by, motif, status: 'EN_ATTENTE', mdmRef: this.mdm.push(deviceId, kind, perimetre), ...(perimetre ? { perimetre } : {}) };
  }

  /**
   * Périmètre d'un effacement : APPAREIL seulement pour un terminal déclaré propriété de la Province ; sinon (téléphone
   * personnel, ou propriété non déclarée) APPLICATION — jamais d'effacement du téléphone d'un agent.
   */
  perimetre(e: Pick<Equipment, 'ownership'>): 'APPLICATION' | 'APPAREIL' {
    return e.ownership === 'PROVINCE' ? 'APPAREIL' : 'APPLICATION';
  }

  private addIncident(e: Equipment, kind: DeviceIncident['kind'], detail: string) {
    const inc = { id: this.ids.next('INC-EQ'), at: this.now(), kind, detail };
    this.equipments.update({ ...this.equipments.get(e.id)!, incidents: [...(this.equipments.get(e.id)?.incidents ?? []), inc] });
    return inc;
  }

  /** Équipement du registre (créé à la volée pour les terminaux enrôlés par d'autres modules). */
  private equipment(id: string): Equipment {
    const e = this.equipments.get(id);
    if (e) return e;
    const d = this.ctx.field.devices.get(id);
    if (!d) throw notFound('DEVICE_NOT_FOUND', `Terminal inconnu : ${id}`);
    return this.equipments.insert({ ...this.blank(d.id, d.agentUserId, 'socle', d.enrolledAt), ...(d.status === 'REVOQUE' ? { state: 'REVOQUE' as const, revokedAt: d.revokedAt ?? this.now() } : {}) });
  }

  enroll(user: User, input: { deviceId: string; userId: string; policyCode?: string; model: string; os: string; ownership?: 'PERSONNEL' | 'PROVINCE' }) {
    authorize(user, 'equipements:manage');
    const agent = this.ctx.users.get(input.userId);
    if (!agent) throw notFound('USER_NOT_FOUND', `Agent inconnu : ${input.userId}`);
    if (!agent.roles.some((r) => ['R09', 'R10', 'R11', 'R12', 'R35'].includes(r))) throw badRequest('NOT_FIELD_AGENT', 'Terminal réservé aux agents de terrain, contrôleurs, superviseurs et guichets.');
    if (this.ctx.field.devices.get(input.deviceId)) throw conflict('DEVICE_EXISTS', 'Identifiant de terminal déjà enrôlé.');
    const ownership = input.ownership ?? 'PERSONNEL';
    const p = this.policy(input.policyCode ?? (ownership === 'PERSONNEL' ? 'TERRAIN-PERSONNEL' : 'TERRAIN-STANDARD'));
    if (ownership === 'PERSONNEL' && (p.scope ?? 'APPAREIL') !== 'APPLICATION') throw badRequest('POLICY_SCOPE_PERSONAL', 'Téléphone personnel : seule une politique au périmètre APPLICATION est admise (jamais de gestion de l’appareil entier).');
    const key = randomSecret(24);
    this.ctx.field.enroll(input.deviceId, agent.id, key);
    const e = this.equipments.insert({ ...this.blank(input.deviceId, agent.id, user.id), policyCode: p.code, policyVersion: p.version, model: input.model, os: input.os, ownership, mdm: { adapter: this.mdm.name, ref: this.mdm.enroll(input.deviceId, p) } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'equipements.device.enrolled', resourceType: 'device', resourceId: e.id, details: { userId: agent.id, policy: `${p.code}@${p.version}`, mdm: this.mdm.name, ownership } });
    return { equipment: e, deviceKeyOnce: key, notice: 'Clé du terminal affichée une seule fois : elle est installée sur le terminal lors de l’enrôlement.', ...(ownership === 'PERSONNEL' ? { charte: CHARTE_TELEPHONE_PERSONNEL } : {}) };
  }

  /** Acceptation de la charte du téléphone personnel par l'agent affecté (journalisée). */
  acceptCharte(user: User, id: string, version: string) {
    const e = this.equipment(id);
    if (user.id !== e.userId) throw forbidden('DEVICE_USER_MISMATCH', 'Seul l’agent affecté accepte la charte de son téléphone.');
    if (version !== CHARTE_TELEPHONE_PERSONNEL.version) throw conflict('CHARTE_VERSION', `Version de charte en vigueur : ${CHARTE_TELEPHONE_PERSONNEL.version}.`);
    const out = this.equipments.update({ ...e, charte: { version, acceptedAt: this.now() } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'equipements.device.charter_accepted', resourceType: 'device', resourceId: id, details: { version } });
    return out;
  }

  /** Défi de liaison appareil–utilisateur (5 minutes). */
  challenge(user: User, id: string) {
    const e = this.equipment(id);
    if (user.id !== e.userId) authorize(user, 'equipements:manage');
    const nonce = randomSecret(16);
    const out = this.equipments.update({ ...e, binding: { ...e.binding, challenge: { nonce, expiresAt: new Date(this.ctx.clock.now().getTime() + 300_000).toISOString() } } });
    return { deviceId: id, userId: out.userId, nonce, expiresAt: out.binding.challenge!.expiresAt, sign: 'HMAC-SHA256(clé du terminal, identifiant du terminal | identifiant de l’agent | défi)' };
  }

  /** Attestation : l'agent affecté présente le défi signé par la clé du terminal. */
  attest(user: User, id: string, input: { nonce: string; signature: string }) {
    const e = this.equipment(id);
    const d = this.ctx.field.devices.get(id);
    if (!d || d.status !== 'ACTIF' || e.state === 'REVOQUE') throw forbidden('DEVICE_REVOKED', 'Terminal révoqué.');
    if (user.id !== e.userId) throw forbidden('DEVICE_USER_MISMATCH', 'Seul l’agent affecté atteste la liaison de son terminal.');
    const c = e.binding.challenge;
    if (!c || c.nonce !== input.nonce || c.expiresAt < this.now()) throw conflict('CHALLENGE_INVALID', 'Défi inconnu ou expiré : demandez un nouveau défi.');
    if (!safeEqualHex(hmacSha256Hex(d.key, `${id}|${user.id}|${input.nonce}`), input.signature.toLowerCase())) {
      this.addIncident(e, 'SIGNATURE_INVALIDE', 'Attestation de liaison : signature invalide.');
      throw unauthorized('INVALID_DEVICE_SIGNATURE', 'Signature du défi invalide.');
    }
    const out = this.equipments.update({ ...this.equipments.get(id)!, binding: { status: 'ATTESTEE', attestedAt: this.now() } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'equipements.device.binding_attested', resourceType: 'device', resourceId: id, details: { userId: user.id } });
    return out;
  }

  /**
   * Signalement du terminal (corps signé par sa clé) : évaluation d'intégrité, commandes en attente, date de purge des
   * données en cache (expiration automatique). Appareil modifié ⇒ quarantaine, incident et alerte (aucun effacement).
   */
  checkIn(user: User, id: string, raw: string, signature: string | undefined, report: IntegrityReport) {
    const e = this.equipment(id);
    const d = this.ctx.field.devices.get(id);
    if (!d || d.status !== 'ACTIF' || e.state === 'REVOQUE') throw forbidden('DEVICE_REVOKED', 'Terminal révoqué : effectuer l’effacement.');
    if (d.agentUserId !== user.id) throw forbidden('DEVICE_USER_MISMATCH', 'Ce terminal n’est pas affecté à cet agent.');
    if (!signature || !safeEqualHex(hmacSha256Hex(d.key, raw), signature.replace(/^sha256=/, '').toLowerCase())) {
      this.addIncident(e, 'SIGNATURE_INVALIDE', 'Signalement non signé par la clé du terminal.');
      throw unauthorized('INVALID_DEVICE_SIGNATURE', 'Signature du signalement invalide.');
    }
    const p = this.policy(e.policyCode);
    const reasons: string[] = [];
    if (report.rooted) reasons.push('Accès racine (terminal « rooté » ou débridé).');
    if (report.bootloaderUnlocked) reasons.push('Chargeur d’amorçage déverrouillé.');
    if (report.emulator) reasons.push('Émulateur détecté.');
    if (report.debuggable) reasons.push('Débogage actif.');
    if (!p.approvedAppSignatures.includes(report.appSignatureSha256.toLowerCase())) reasons.push('Application non officielle (signature inconnue) : application modifiée présumée.');
    if (report.osVersion < p.minOsVersion) reasons.push(`Système ${report.osVersion} inférieur au minimum de la politique (${p.minOsVersion}).`);
    if (p.encryptionRequired && !report.encrypted) reasons.push('Stockage non chiffré.');
    const at = this.now();
    let cur = this.equipments.get(id)!;
    const acked = new Set(report.acknowledgedCommands ?? []);
    const commands = cur.commands.map((c) => (c.status === 'EN_ATTENTE' && acked.has(c.id) ? { ...c, status: 'EFFECTUE' as const, ackAt: at } : c));
    const verdict = reasons.length ? 'MODIFIE' : 'CONFORME';
    let state = cur.state;
    if (verdict === 'MODIFIE' && state !== 'QUARANTAINE') {
      state = 'QUARANTAINE';
      this.ctx.alerts.raise({ type: 'APPAREIL_MODIFIE', severity: 'HIGH', source: 'equipements', detail: `Terminal ${id} : ${reasons.join(' ')}`, context: { deviceId: id, userId: user.id, automaticEffect: 'QUARANTAINE (synchronisation suspendue, aucune donnée effacée)' }, notifyRoles: ['R28', 'R22'] });
      this.ctx.audit.append({ actor: { kind: 'device', id }, action: 'equipements.device.quarantined', resourceType: 'device', resourceId: id, details: { reasons } });
    }
    if (state === 'DONNEES_EXPIREES' && commands.filter((c) => c.kind === 'PURGE_DONNEES').every((c) => c.status === 'EFFECTUE')) state = 'ACTIF';
    cur = this.equipments.update({ ...cur, commands, state, lastCheckIn: at, lastReport: { ...report, verdict, reasons }, ...(verdict === 'MODIFIE' && cur.state !== 'QUARANTAINE' ? { quarantine: { at, reasons } } : {}) });
    if (verdict === 'MODIFIE' && e.state !== 'QUARANTAINE') this.addIncident(cur, 'APPAREIL_MODIFIE', reasons.join(' '));
    const purgeBefore = new Date(this.ctx.clock.now().getTime() - p.offlineDataTtlDays * DAY_MS).toISOString();
    return {
      deviceId: id, verdict, reasons, state: this.equipments.get(id)!.state, serverTime: at,
      policy: { code: p.code, version: p.version, screenLockMinutes: p.screenLockMinutes, offlineDataTtlDays: p.offlineDataTtlDays },
      pendingCommands: this.equipments.get(id)!.commands.filter((c) => c.status === 'EN_ATTENTE').map((c) => ({ id: c.id, kind: c.kind, ...(c.perimetre ? { perimetre: c.perimetre } : {}) })),
      dataExpiry: { purgeBefore, rule: `Données de référence en cache antérieures au ${purgeBefore.slice(0, 10)} à purger (délai de ${p.offlineDataTtlDays} jours de la politique).` },
    };
  }

  wipe(user: User, id: string, motif: string) {
    authorize(user, 'equipements:wipe');
    const e = this.equipment(id);
    const cmd = this.command(id, 'EFFACEMENT', user.id, motif, this.perimetre(e));
    const out = this.equipments.update({ ...e, commands: [...e.commands, cmd] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'equipements.device.wipe_requested', resourceType: 'device', resourceId: id, details: { motif, commandId: cmd.id, perimetre: cmd.perimetre } });
    return out;
  }

  private markRevoked(e: Equipment, by: string, motif: string) {
    const cmd = this.command(e.id, 'EFFACEMENT', by, motif, this.perimetre(e));
    return this.equipments.update({ ...e, state: 'REVOQUE', revokedAt: this.now(), commands: [...e.commands, cmd] });
  }

  revoke(user: User, id: string, motif: string, lost = false) {
    const e = this.equipment(id);
    if (lost) { if (user.id !== e.userId) authorize(user, 'equipements:wipe'); } else authorize(user, 'equipements:wipe');
    const d = this.ctx.field.devices.get(id);
    if (!d || d.status === 'REVOQUE') throw conflict('ALREADY_REVOKED', 'Terminal déjà révoqué.');
    if (lost) this.addIncident(e, 'PERTE_DECLAREE', motif);
    this.ctx.audit.append({ actor: actorOf(user), action: lost ? 'equipements.device.lost_declared' : 'equipements.device.revoke_requested', resourceType: 'device', resourceId: id, details: { motif } });
    this.ctx.field.revoke(id, motif); // l'abonné au journal marque la révocation et programme l'effacement
    return this.equipments.get(id)!;
  }

  /** Levée de quarantaine : décision humaine motivée, après nouvelle attestation (personne distincte de l'agent). */
  lift(user: User, id: string, motif: string) {
    authorize(user, 'equipements:wipe');
    const e = this.equipment(id);
    if (e.state !== 'QUARANTAINE' || !e.quarantine) throw conflict('NOT_QUARANTINED', 'Terminal hors quarantaine.');
    assertDistinctPerson(user.id, [e.userId], 'La levée de quarantaine est décidée par une personne distincte de l’agent.');
    if (e.lastReport?.verdict === 'MODIFIE') throw conflict('STILL_MODIFIED', 'Dernier signalement encore non conforme : remise en état et nouveau signalement conforme requis.');
    const out = this.equipments.update({ ...e, state: 'ACTIF', quarantine: { ...e.quarantine, lifted: { by: user.id, at: this.now(), motif } } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'equipements.device.quarantine_lifted', resourceType: 'device', resourceId: id, details: { motif } });
    return out;
  }

  /** Nouvelle version de politique (sécurité) ; les terminaux reçoivent une commande « POLITIQUE ». */
  publishPolicy(user: User, input: Omit<DevicePolicy, 'id' | 'version' | 'createdBy' | 'createdAt' | 'status'>) {
    authorize(user, 'equipements:policy');
    const prev = this.policies.find((x) => x.code === input.code).sort((a, b) => b.version - a.version)[0];
    const version = (prev?.version ?? 0) + 1;
    const p = this.policies.insert({ ...input, approvedAppSignatures: input.approvedAppSignatures.map((s) => s.toLowerCase()), id: `${input.code}@${version}`, version, status: 'PAR_DEFAUT', createdBy: user.id, createdAt: this.now() });
    for (const e of this.equipments.find((x) => x.policyCode === p.code && x.state !== 'REVOQUE')) this.equipments.update({ ...e, policyVersion: version, commands: [...e.commands, this.command(e.id, 'POLITIQUE', user.id, `Politique ${p.code} v${version}`)] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'equipements.policy.published', resourceType: 'device_policy', resourceId: p.id, details: { offlineDataTtlDays: p.offlineDataTtlDays, minOsVersion: p.minOsVersion } });
    return p;
  }

  /** Échéancier : terminaux silencieux au-delà du délai d'expiration des données ⇒ purge commandée (automatique). */
  expireData() {
    const now = this.ctx.clock.now().getTime();
    const out: string[] = [];
    for (const d of this.ctx.field.devices.find((x) => x.status === 'ACTIF')) {
      const e = this.equipment(d.id);
      if (e.state !== 'ACTIF') continue;
      const p = this.policy(e.policyCode);
      const last = Date.parse(e.lastCheckIn ?? e.enrolledAt);
      if (now - last > p.offlineDataTtlDays * DAY_MS) {
        this.equipments.update({ ...e, state: 'DONNEES_EXPIREES', commands: [...e.commands, this.command(e.id, 'PURGE_DONNEES', 'echeancier', `Aucun signalement depuis plus de ${p.offlineDataTtlDays} jours : données en cache expirées.`)] });
        this.ctx.audit.append({ actor: { kind: 'system', id: 'equipements:echeancier' }, action: 'equipements.device.data_expired', resourceType: 'device', resourceId: e.id, details: { ttlDays: p.offlineDataTtlDays } });
        out.push(e.id);
      }
    }
    return out;
  }

  view(user: User) {
    authorize(user, 'equipements:read');
    for (const d of this.ctx.field.devices.all()) this.equipment(d.id);
    const all = this.equipments.all();
    const since = new Date(this.ctx.clock.now().getTime() - 30 * DAY_MS).toISOString();
    const incidents = all.flatMap((e) => e.incidents.map((i) => ({ ...i, deviceId: e.id })));
    const active = all.filter((e) => e.state === 'ACTIF' && this.ctx.field.devices.get(e.id)?.status === 'ACTIF').length;
    return {
      mdm: { adapter: this.mdm.name, external: this.mdm.external, label: this.mdm.external ? 'Outil MDM raccordé' : 'Outil MDM du fournisseur [À RACCORDER — convention requise] : bac à sable intégré (commandes journalisées, acquittées au signalement du terminal).' },
      policies: this.policies.all(),
      equipments: all.map((e) => ({ ...e, userName: this.ctx.users.get(e.userId)?.name ?? e.userId })),
      incidents: incidents.sort((a, b) => (a.at < b.at ? 1 : -1)),
      rule: 'Suivi des résultats, pas surveillance intrusive : aucune position ni aucun usage personnel collecté.',
      personnel: {
        regle: 'Téléphone personnel (défaut) : seule l’application MOSOLO est gérée ; tout effacement ne vise que ses données, jamais le téléphone.',
        charte: CHARTE_TELEPHONE_PERSONNEL,
        telephonesPersonnels: all.filter((e) => e.ownership !== 'PROVINCE').length,
        terminauxProvince: all.filter((e) => e.ownership === 'PROVINCE').length,
        chartesAcceptees: all.filter((e) => e.ownership !== 'PROVINCE' && e.charte).length,
      },
      indicators: [
        { code: 'TERMINAUX_ACTIFS', label: 'Terminaux actifs', measured: true, value: String(active), unit: 'terminaux', detail: { quarantaine: all.filter((e) => e.state === 'QUARANTAINE').length, donneesExpirees: all.filter((e) => e.state === 'DONNEES_EXPIREES').length, attestes: all.filter((e) => e.binding.status === 'ATTESTEE').length } },
        { code: 'INCIDENTS', label: 'Incidents d’équipement (30 jours)', measured: true, value: String(incidents.filter((i) => i.at >= since).length), unit: 'incidents' },
        { code: 'REVOCATIONS', label: 'Révocations de terminaux', measured: true, value: String(all.filter((e) => e.state === 'REVOQUE').length), unit: 'terminaux' },
      ],
    };
  }
}
