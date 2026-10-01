/**
 * « Clés et raccordements » (29/09/2026) — console du super-administrateur (R26), validée par une seconde personne
 * (R26 ou responsable sécurité R28), pour DÉFINIR ou FAIRE TOURNER les clés et secrets des services externes, EN PLUS de
 * la configuration par variables d'environnement (qui reste en place et prioritaire).
 *
 * Doctrine :
 *  - ÉCRITURE SEULE : aucune route ne renvoie une valeur, pas même masquée ; seules la présence, la source active et la
 *    version sont affichées ;
 *  - CHIFFREMENT AU REPOS : AES-256-GCM, clé maîtresse MOSOLO_CONFIG_MASTER_KEY (environnement seulement), vecteur aléatoire
 *    par valeur, nom de la variable lié en données authentifiées (un bloc ne peut pas être déplacé vers une autre
 *    variable). Sans clé maîtresse : la console REFUSE toute écriture (hors démonstration, où une clé éphémère, perdue au
 *    redémarrage, est utilisée et signalée) ;
 *  - DEUX PERSONNES : une personne propose, une personne DISTINCTE approuve ; rien ne s'applique avant l'approbation ;
 *    une proposition refusée voit sa valeur chiffrée effacée ;
 *  - AUDIT sans valeur (qui, quand, quelle variable, quelle décision) ;
 *  - RÉSOLUTION : la variable d'environnement PRÉVAUT ; la valeur de la console ne s'applique qu'en son absence, et la
 *    source active est affichée — choix « par défaut — à confirmer par le maître d'ouvrage » ;
 *  - PRISE EN COMPTE SANS REDÉPLOIEMENT : les connecteurs relisent la configuration par le résolveur (empreinte).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { AuditLog } from '../../core/audit.js';
import { isProduction, type User } from '../../core/auth.js';
import type { Clock } from '../../core/clock.js';
import { sha256Hex } from '../../core/crypto.js';
import { ApiError, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { parseEd25519PublicKey } from '../payments/connectors/bitripay.js';
import { CONNECTOR_BASE_VARS, INVENTORY, variable, type FormatRule, type IntegrationVariable } from './inventory.js';

/** Bloc chiffré (jamais la valeur en clair). */
export interface EncryptedBlob {
  alg: 'AES-256-GCM';
  /** Empreinte courte de la clé maîtresse (12 caractères hexadécimaux de SHA-256), pour détecter un changement de clé. */
  keyId: string;
  iv: string;
  tag: string;
  ct: string;
}

export type ProposalKind = 'DEFINIR' | 'RETIRER';
export type ProposalStatus = 'EN_ATTENTE' | 'APPROUVEE' | 'REJETEE' | 'REMPLACEE';

export interface ConfigProposal {
  id: string;
  variable: string;
  kind: ProposalKind;
  status: ProposalStatus;
  motif: string;
  proposedBy: string;
  proposedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionMotif?: string;
  /** Valeur chiffrée en attente ; effacée (null) dès la décision (copiée dans la valeur active si approuvée). */
  blob: EncryptedBlob | null;
}

/** Vue publique d'une proposition (sans valeur ni bloc chiffré). */
export interface ProposalView {
  id: string;
  variable: string;
  kind: ProposalKind;
  status: ProposalStatus;
  motif: string;
  proposedBy: string;
  proposedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionMotif: string | null;
  /** Vrai si une valeur chiffrée est en attente (jamais la valeur). */
  valueHeld: boolean;
}

/** Valeur ACTIVE de la console pour une variable (identifiant = nom de la variable). */
export interface ConsoleValue {
  id: string;
  version: number;
  /** null : valeur retirée par décision à deux personnes (l'historique reste dans les propositions et l'audit). */
  blob: EncryptedBlob | null;
  proposalId: string;
  proposedBy: string;
  approvedBy: string;
  effectiveAt: string;
}

/** Dernière réception d'un webhook entrant (hors prestataires connectés, suivis par le module de paiement). */
export interface InboundDelivery {
  id: string;
  at: string;
  verification: 'VALIDE' | 'REFUSEE' | 'SIMULEE';
  code: string | null;
}

export type ActiveSource = 'ENVIRONNEMENT' | 'CONSOLE' | 'ABSENTE';

/** Groupes dont les valeurs s'appliquent sur la seule décision du super-administrateur (décision du 01/10/2026). */
export const APPROBATION_UNIQUE = new Set<string>(['ia']);
export const APPROBATION_UNIQUE_MOTIF = 'Approbation unique du super-administrateur — clés d’IA (décision du maître d’ouvrage du 01/10/2026).';

export const RESOLUTION_RULE = 'La variable d’environnement prévaut ; la valeur de la console ne s’applique qu’en son absence (par défaut — à confirmer par le maître d’ouvrage).';

const MIN_SECRET_LENGTH = 16; // règle existante des secrets de rappel (context.ts), reprise ici.
const isDemoValue = (v: string) => /^demo-/i.test(v.trim());

/** Contrôle de format ; message sans jamais citer la valeur. */
export function checkFormat(v: IntegrationVariable, value: string, opts: { production: boolean }): string | null {
  const name = v.name;
  if (value !== value.trim() || /[\r\n\t]/.test(value)) return `${name} : espaces ou retours à la ligne en début, en fin ou à l’intérieur refusés.`;
  if (value.length === 0) return `${name} : valeur vide.`;
  if (value.length > 4096) return `${name} : valeur trop longue.`;
  if (v.secret && isDemoValue(value)) return `${name} : valeur de démonstration publique refusée.`;
  const serverKey = (restricted: boolean) => {
      if (/^pk_/.test(value)) return `${name} : clé publiable pk_… refusée — seule une clé secrète sk_… côté serveur est admise (jamais dans le navigateur).`;
      if (!restricted && /^rk_/.test(value)) return `${name} : clé en lecture seule rk_… refusée — une clé secrète sk_… est requise.`;
      const m = (restricted ? /^(?:sk|rk)_(test|live)_([A-Za-z0-9_]+)$/ : /^sk_(test|live)_([A-Za-z0-9_]+)$/).exec(value);
      if (!m) return `${name} : clé attendue au format sk_test_… ou sk_live_…${restricted ? ' (ou clé restreinte rk_test_… / rk_live_…)' : ''} (lettres, chiffres, soulignés).`;
      if (m[2]!.length < MIN_SECRET_LENGTH) return `${name} : clé trop courte (au moins ${MIN_SECRET_LENGTH} caractères après le préfixe).`;
      // En production déclarée, une clé de test est refusée (par défaut — à confirmer par le maître d'ouvrage).
      if (opts.production && m[1] === 'test') return `${name} : clé de test refusée en production (NODE_ENV=production) — clé *_live_… attendue.`;
      return null;
  };
  const rules: Record<FormatRule, () => string | null> = {
    CLE_SECRETE_SK: () => serverKey(false),
    CLE_SECRETE_SK_OU_RK: () => serverKey(true),
    SECRET_WHSEC: () => {
      const m = /^whsec_([A-Za-z0-9_+/=-]+)$/.exec(value);
      if (!m) return `${name} : secret de point de terminaison attendu au format whsec_….`;
      return m[1]!.length < MIN_SECRET_LENGTH ? `${name} : secret trop court (au moins ${MIN_SECRET_LENGTH} caractères après whsec_).` : null;
    },
    SECRET: () => (value.length < MIN_SECRET_LENGTH ? `${name} : secret trop court (au moins ${MIN_SECRET_LENGTH} caractères).` : /\s/.test(value) ? `${name} : espaces refusés.` : null),
    URL_HTTPS: () => {
      try {
        const u = new URL(value);
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
        if (u.protocol === 'https:' || (u.protocol === 'http:' && loopback && !opts.production)) return null;
        return `${name} : adresse https attendue.`;
      } catch {
        return `${name} : URL invalide.`;
      }
    },
    BOOLEEN: () => (/^(true|false|1|0|oui|non|yes|no)$/i.test(value) ? null : `${name} : true ou false attendu.`),
    EXPOSANT_0_2: () => (value === '0' || value === '2' ? null : `${name} : 0 ou 2 attendu.`),
    LISTE_OPERATEURS: () => (/^[a-z][a-z0-9_]{1,30}(,[a-z][a-z0-9_]{1,30})*$/.test(value) ? null : `${name} : liste d’opérateurs séparés par des virgules attendue (ex. orange_cd,mpesa_cd).`),
    ALIAS_COFFRE: () => (/^[A-Z0-9][A-Z0-9-]{2,63}$/.test(value) ? null : `${name} : alias du coffre attendu (majuscules, chiffres, tirets).`),
    COMPTE_CONNECTE: () => (/^acct_[A-Za-z0-9_]{4,64}$/.test(value) ? null : `${name} : identifiant de compte connecté acct_… attendu.`),
    NOM_CHAMP: () => (/^[a-z][a-z0-9_]{1,40}$/.test(value) ? null : `${name} : nom de champ en minuscules attendu (ex. return_url).`),
    CLE_PUBLIQUE_ED25519: () => {
      try {
        parseEd25519PublicKey(value);
        return null;
      } catch {
        return `${name} : clé publique Ed25519 invalide (PEM ou 32 octets en base64 attendus).`;
      }
    },
    TEXTE: () => null,
  };
  return rules[v.format]();
}

/** Lecture de la clé maîtresse (32 octets, hexadécimal ou base64) ; `null` si absente, erreur si mal formée. */
export function parseMasterKey(raw: string | undefined): Buffer | null {
  const v = raw?.trim();
  if (!v) return null;
  if (/^[0-9a-fA-F]{64}$/.test(v)) return Buffer.from(v, 'hex');
  const b = Buffer.from(v, 'base64');
  if (b.length === 32) return b;
  throw new ApiError(500, 'CONFIG_MASTER_KEY_INVALID', 'MOSOLO_CONFIG_MASTER_KEY invalide : 32 octets attendus (64 caractères hexadécimaux ou base64).');
}

export interface IntegrationConfigOptions {
  /** Environnement des connecteurs de paiement (injectable en test) ; défaut : process.env. */
  connectorEnv?: Record<string, string | undefined>;
  /** Environnement du processus (autres variables). */
  processEnv?: Record<string, string | undefined>;
  demo: boolean;
}

export class IntegrationConfigService {
  readonly proposals = new InMemoryRepository<ConfigProposal>();
  readonly values = new InMemoryRepository<ConsoleValue>();
  /** Dernière réception par webhook entrant (SMS, SVI, WhatsApp, rappels génériques). */
  readonly inbound = new InMemoryRepository<InboundDelivery>();
  private readonly ids = new IdGenerator();
  private readonly masterKey: Buffer | null;
  readonly masterKeyState: 'PRESENTE' | 'EPHEMERE_DEMO' | 'ABSENTE';
  private readonly keyId: string | null;
  private cache: { fp: string; values: Map<string, string> } | null = null;
  /** Abonnés aux changements approuvés (canaux de communication…). */
  private readonly listeners: (() => void)[] = [];

  constructor(private readonly clock: Clock, private readonly audit: AuditLog, private readonly opts: IntegrationConfigOptions) {
    const env = opts.processEnv ?? process.env;
    const key = parseMasterKey(env.MOSOLO_CONFIG_MASTER_KEY);
    if (key) {
      this.masterKey = key;
      this.masterKeyState = 'PRESENTE';
    } else if (opts.demo) {
      // Démonstration : clé éphémère (valeurs illisibles après redémarrage — signalé dans la console).
      this.masterKey = randomBytes(32);
      this.masterKeyState = 'EPHEMERE_DEMO';
    } else {
      this.masterKey = null;
      this.masterKeyState = 'ABSENTE';
    }
    this.keyId = this.masterKey ? sha256Hex(this.masterKey).slice(0, 12) : null;
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  /** Applique les effets vivants (après une approbation ou une restauration de la persistance). */
  applyLiveEffects(): void {
    for (const fn of this.listeners) fn();
  }

  private baseEnv(name: string): string | undefined {
    const env = CONNECTOR_BASE_VARS.has(name) ? this.opts.connectorEnv ?? this.opts.processEnv ?? process.env : this.opts.processEnv ?? process.env;
    const v = env[name];
    return v === undefined || v === '' ? undefined : v;
  }

  // ------------------------------------------------------------------ chiffrement
  private encrypt(name: string, value: string): EncryptedBlob {
    if (!this.masterKey || !this.keyId) throw this.noMasterKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    cipher.setAAD(Buffer.from(`mosolo-config:${name}`, 'utf8'));
    const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return { alg: 'AES-256-GCM', keyId: this.keyId, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
  }

  private decrypt(name: string, blob: EncryptedBlob): string | undefined {
    if (!this.masterKey || blob.keyId !== this.keyId) return undefined;
    try {
      const d = createDecipheriv('aes-256-gcm', this.masterKey, Buffer.from(blob.iv, 'base64'));
      d.setAAD(Buffer.from(`mosolo-config:${name}`, 'utf8'));
      d.setAuthTag(Buffer.from(blob.tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
    } catch {
      return undefined;
    }
  }

  private noMasterKey(): ApiError {
    return conflict('CONFIG_MASTER_KEY_ABSENT',
      'Écriture refusée : MOSOLO_CONFIG_MASTER_KEY est absente — aucune valeur ne peut être chiffrée au repos. Renseignez la clé maîtresse (32 octets) dans l’environnement, ou configurez la variable directement dans l’environnement.');
  }

  // ------------------------------------------------------------------ résolution
  /** Empreinte des valeurs actives de la console (changement ⇒ reconstruction des connecteurs). */
  fingerprint(names?: ReadonlySet<string>): string {
    return this.values.all().filter((v) => !names || names.has(v.id)).map((v) => `${v.id}:${v.version}:${v.blob ? 1 : 0}`).sort().join('|');
  }

  private consoleValues(): Map<string, string> {
    const fp = this.fingerprint();
    if (this.cache?.fp === fp) return this.cache.values;
    const values = new Map<string, string>();
    for (const v of this.values.all()) {
      if (!v.blob) continue;
      const plain = this.decrypt(v.id, v.blob);
      if (plain !== undefined) values.set(v.id, plain);
    }
    this.cache = { fp, values };
    return values;
  }

  /** Source active d'une variable : environnement (prioritaire), console, ou absente. */
  sourceOf(name: string): ActiveSource {
    if (this.baseEnv(name) !== undefined) return 'ENVIRONNEMENT';
    const meta = variable(name);
    if (meta && meta.effect !== 'ENVIRONNEMENT_SEUL' && this.consoleValues().has(name)) return 'CONSOLE';
    return 'ABSENTE';
  }

  /** Valeur résolue (usage INTERNE au serveur uniquement : jamais renvoyée par une route). */
  value(name: string): string | undefined {
    const env = this.baseEnv(name);
    if (env !== undefined) return env;
    const meta = variable(name);
    if (!meta || meta.effect === 'ENVIRONNEMENT_SEUL') return undefined;
    return this.consoleValues().get(name);
  }

  /** Environnement résolu des connecteurs de paiement : base + valeurs de la console pour les variables absentes. */
  connectorEnv(): Record<string, string | undefined> {
    const base = { ...(this.opts.connectorEnv ?? this.opts.processEnv ?? process.env) };
    for (const [name, v] of this.consoleValues()) {
      if (CONNECTOR_BASE_VARS.has(name) && (base[name] === undefined || base[name] === '')) base[name] = v;
    }
    return base;
  }

  // ------------------------------------------------------------------ circuit à deux personnes
  propose(user: User, name: string, input: { kind: ProposalKind; value?: string; motif: string }): ProposalView {
    authorize(user, 'integration.propose');
    const meta = variable(name);
    if (!meta) throw notFound('UNKNOWN_VARIABLE', `Variable inconnue de l’inventaire : ${name}`);
    if (meta.effect === 'ENVIRONNEMENT_SEUL') {
      throw conflict('ENVIRONMENT_ONLY', `${name} ne peut être définie que dans l’environnement (lue au démarrage ou clé interne du socle).`);
    }
    if (!this.masterKey) throw this.noMasterKey();
    let blob: EncryptedBlob | null = null;
    if (input.kind === 'DEFINIR') {
      if (typeof input.value !== 'string') throw unprocessable('VALUE_REQUIRED', `${name} : valeur requise.`);
      const problem = checkFormat(meta, input.value, { production: isProduction(this.opts.processEnv ?? process.env) });
      if (problem) {
        this.audit.append({
          actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'integration.config.refused', resourceType: 'integration_variable', resourceId: name,
          outcome: 'FAILURE', details: { variable: name, reason: 'FORMAT', rule: meta.format },
        });
        throw unprocessable('INVALID_VALUE_FORMAT', problem, { variable: name, rule: meta.format });
      }
      blob = this.encrypt(name, input.value);
    } else if (!this.values.get(name)?.blob) {
      throw conflict('NOTHING_TO_REMOVE', `${name} : aucune valeur de la console à retirer.`);
    }
    // Une seule proposition en attente par variable : la précédente est remplacée (sa valeur chiffrée est effacée).
    const now = this.clock.now().toISOString();
    for (const p of this.proposals.find((x) => x.variable === name && x.status === 'EN_ATTENTE')) {
      this.proposals.update({ ...p, status: 'REMPLACEE', blob: null, decidedAt: now, decidedBy: user.id, decisionMotif: 'Remplacée par une nouvelle proposition.' });
    }
    const proposal = this.proposals.insert({
      id: this.ids.next('CFGP'), variable: name, kind: input.kind, status: 'EN_ATTENTE', motif: input.motif,
      proposedBy: user.id, proposedAt: now, blob,
    });
    this.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'integration.config.proposed', resourceType: 'integration_variable', resourceId: name,
      details: { proposalId: proposal.id, variable: name, kind: input.kind, secret: meta.secret, note: 'Valeur jamais journalisée.' },
    });
    // Décision du maître d'ouvrage (01/10/2026) : les clés des fournisseurs d'IA (groupe « ia ») sont appliquées sur la
    // seule décision du super-administrateur, sans seconde personne. Les autres groupes (paiement, SMS…) gardent la règle
    // des deux personnes.
    if (APPROBATION_UNIQUE.has(meta.group)) return this.appliquer(user, proposal, APPROBATION_UNIQUE_MOTIF).proposal;
    return this.proposalView(proposal);
  }

  approve(user: User, proposalId: string, motif?: string): { proposal: ProposalView; effective: boolean; activeSource: ActiveSource } {
    authorize(user, 'integration.approve');
    const p = this.proposals.get(proposalId);
    if (!p) throw notFound('PROPOSAL_NOT_FOUND', 'Proposition inconnue.');
    if (p.status !== 'EN_ATTENTE') throw conflict('PROPOSAL_NOT_PENDING', `Proposition déjà ${p.status.toLowerCase()}.`);
    if (p.proposedBy === user.id) {
      this.audit.append({
        actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'integration.config.refused', resourceType: 'integration_variable', resourceId: p.variable,
        outcome: 'DENIED', details: { proposalId: p.id, reason: 'MEME_PERSONNE' },
      });
      throw forbidden('SAME_PERSON', 'Règle des deux personnes : la personne qui a proposé ne peut pas approuver sa propre proposition.');
    }
    if (!this.masterKey) throw this.noMasterKey();
    return this.appliquer(user, p, motif);
  }

  /** Rend effective une proposition (approbation par une seconde personne, ou approbation unique du groupe « ia »). */
  private appliquer(user: User, p: ConfigProposal, motif?: string): { proposal: ProposalView; effective: boolean; activeSource: ActiveSource } {
    const now = this.clock.now().toISOString();
    const prev = this.values.get(p.variable);
    const next = {
      id: p.variable, version: (prev?.version ?? 0) + 1, blob: p.kind === 'DEFINIR' ? p.blob : null,
      proposalId: p.id, proposedBy: p.proposedBy, approvedBy: user.id, effectiveAt: now,
    };
    if (prev) this.values.update(next);
    else this.values.insert(next);
    const decided = this.proposals.update({ ...p, status: 'APPROUVEE', blob: null, decidedBy: user.id, decidedAt: now, ...(motif ? { decisionMotif: motif } : {}) });
    const activeSource = this.sourceOf(p.variable);
    this.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'integration.config.approved', resourceType: 'integration_variable', resourceId: p.variable,
      details: { proposalId: p.id, variable: p.variable, kind: p.kind, version: next.version, proposedBy: p.proposedBy, approbationUnique: p.proposedBy === user.id, activeSource, note: 'Valeur jamais journalisée.' },
    });
    this.applyLiveEffects();
    return { proposal: this.proposalView(decided), effective: activeSource === 'CONSOLE' || (p.kind === 'RETIRER' && activeSource !== 'ENVIRONNEMENT'), activeSource };
  }

  reject(user: User, proposalId: string, motif: string): ProposalView {
    authorize(user, 'integration.approve');
    const p = this.proposals.get(proposalId);
    if (!p) throw notFound('PROPOSAL_NOT_FOUND', 'Proposition inconnue.');
    if (p.status !== 'EN_ATTENTE') throw conflict('PROPOSAL_NOT_PENDING', `Proposition déjà ${p.status.toLowerCase()}.`);
    const decided = this.proposals.update({ ...p, status: 'REJETEE', blob: null, decidedBy: user.id, decidedAt: this.clock.now().toISOString(), decisionMotif: motif });
    this.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'integration.config.rejected', resourceType: 'integration_variable', resourceId: p.variable,
      details: { proposalId: p.id, variable: p.variable, kind: p.kind, proposedBy: p.proposedBy },
    });
    return this.proposalView(decided);
  }

  /** Vue d'une proposition : JAMAIS la valeur, ni le bloc chiffré. */
  proposalView(p: ConfigProposal): ProposalView {
    return {
      id: p.id, variable: p.variable, kind: p.kind, status: p.status, motif: p.motif, proposedBy: p.proposedBy, proposedAt: p.proposedAt,
      decidedBy: p.decidedBy ?? null, decidedAt: p.decidedAt ?? null, decisionMotif: p.decisionMotif ?? null, valueHeld: !!p.blob,
    };
  }

  listProposals(user: User) {
    authorize(user, 'integration.read');
    return this.proposals.all().slice().reverse().map((p) => this.proposalView(p));
  }

  /** Inventaire : noms, rôle, source active, présence, version — JAMAIS une valeur (même masquée). */
  inventory(user: User) {
    authorize(user, 'integration.read');
    const consoleVals = this.consoleValues();
    return INVENTORY.map((v) => {
      const cv = this.values.get(v.name);
      const pending = this.proposals.findOne((p) => p.variable === v.name && p.status === 'EN_ATTENTE');
      const envPresent = this.baseEnv(v.name) !== undefined;
      const consolePresent = !!cv?.blob;
      return {
        name: v.name, group: v.group, purpose: v.purpose, secret: v.secret, required: v.required, effect: v.effect, format: v.format,
        proposedName: !!v.proposedName, readBy: v.readBy, settable: v.effect !== 'ENVIRONNEMENT_SEUL',
        envPresent, consolePresent,
        /** Valeur de la console présente mais illisible (clé maîtresse changée ou éphémère perdue). */
        consoleUnreadable: consolePresent && !consoleVals.has(v.name),
        activeSource: this.sourceOf(v.name),
        consoleVersion: cv?.version ?? null, consoleEffectiveAt: cv?.effectiveAt ?? null, consoleApprovedBy: cv?.approvedBy ?? null, consoleProposedBy: cv?.proposedBy ?? null,
        pending: pending ? { id: pending.id, kind: pending.kind, proposedBy: pending.proposedBy, proposedAt: pending.proposedAt } : null,
      };
    });
  }

  /** Réception d'un webhook entrant (journal de la dernière réception ; jamais le corps ni la signature). */
  recordInbound(id: string, verification: InboundDelivery['verification'], code: string | null = null): void {
    const rec = { id, at: this.clock.now().toISOString(), verification, code };
    if (this.inbound.get(id)) this.inbound.update(rec);
    else this.inbound.insert(rec);
  }
}
