/**
 * Horodatage de confiance et publication externe de la racine quotidienne du journal (§ 25.1 « racine quotidienne
 * publiée dans un registre indépendant », « horodatage de confiance »).
 *
 *  - Autorité d'horodatage : interface commune ; adaptateur LOCAL par défaut, jeton inspiré de la RFC 3161
 *    (empreinte du message, numéro de série, heure de génération, politique, signature Ed25519 de l'autorité).
 *    Il n'a PAS la valeur d'un horodatage qualifié : l'autorité tierce (RFC 3161, prestataire de confiance) est
 *    [À RACCORDER] — MOSOLO_TSA_MODE=rfc3161 (+ MOSOLO_TSA_URL) la déclare ; tant qu'elle n'est pas raccordée,
 *    chaque tentative échoue explicitement (alerte), jamais de jeton simulé sous son nom.
 *  - Cible de publication : fichier en ajout seul hors base (MOSOLO_AUDIT_ROOT_PUBLISH_PATH, volume ou dépôt tiers
 *    répliqué) ; mémoire par défaut (démonstration, tests).
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson, sha256Hex } from '../../../core/crypto.js';

export const TOKEN_FORMAT = 'mosolo-horodatage/1' as const;

export interface TimestampToken {
  format: typeof TOKEN_FORMAT;
  tsa: string;
  /** Politique d'horodatage (OID ou URN) ; `urn:mosolo:tsa:local` = adaptateur local, non qualifié. */
  policy: string;
  hashAlgorithm: 'sha256';
  /** Empreinte horodatée (hexadécimal). */
  messageImprint: string;
  serialNumber: string;
  genTime: string;
  keyId: string;
  signature: string;
}

export interface TimestampAuthority {
  readonly name: string;
  /** Vrai pour une autorité tierce (qualifiée) ; faux pour l'adaptateur local. */
  readonly external: boolean;
  stamp(imprintHex: string, at: Date): TimestampToken;
  verify(token: TimestampToken, imprintHex: string): boolean;
}

const tokenPayload = (t: Omit<TimestampToken, 'signature'>) => Buffer.from(canonicalJson(t), 'utf8');

/** Autorité LOCALE (clé Ed25519 : MOSOLO_TSA_PRIVATE_KEY en PEM PKCS#8, sinon clé éphémère du processus). */
export class LocalTimestampAuthority implements TimestampAuthority {
  readonly name = 'Horodatage local MOSOLO (non qualifié)';
  readonly external = false;
  private readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly keyId: string;
  private serial = 0;

  constructor(privateKeyPem?: string) {
    if (privateKeyPem) {
      this.privateKey = createPrivateKey(privateKeyPem);
      this.publicKey = createPublicKey(this.privateKey);
    } else {
      const kp = generateKeyPairSync('ed25519');
      this.privateKey = kp.privateKey;
      this.publicKey = kp.publicKey;
    }
    this.keyId = sha256Hex(this.publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16);
  }

  stamp(imprintHex: string, at: Date): TimestampToken {
    const base = {
      format: TOKEN_FORMAT, tsa: this.name, policy: 'urn:mosolo:tsa:local', hashAlgorithm: 'sha256' as const, messageImprint: imprintHex,
      serialNumber: `${Date.now().toString(36)}-${(++this.serial).toString(36)}-${randomUUID().slice(0, 8)}`, genTime: at.toISOString(), keyId: this.keyId,
    };
    return { ...base, signature: sign(null, tokenPayload(base), this.privateKey).toString('base64') };
  }

  verify(token: TimestampToken, imprintHex: string): boolean {
    if (token.format !== TOKEN_FORMAT || token.messageImprint !== imprintHex || token.keyId !== this.keyId) return false;
    const { signature, ...rest } = token;
    try { return verify(null, tokenPayload(rest), this.publicKey, Buffer.from(signature, 'base64')); } catch { return false; }
  }
}

/** Autorité tierce RFC 3161 : [À RACCORDER] — échec explicite tant que le client n'est pas branché. */
export class Rfc3161AuthorityNotWired implements TimestampAuthority {
  readonly external = true;
  constructor(readonly name: string) {}
  stamp(): TimestampToken {
    throw new Error(`Autorité d’horodatage ${this.name} [À RACCORDER] : aucun jeton n’est simulé.`);
  }
  verify(): boolean {
    return false;
  }
}

export function tsaFromEnv(env: NodeJS.ProcessEnv = process.env): TimestampAuthority {
  const mode = (env.MOSOLO_TSA_MODE ?? 'local').trim().toLowerCase();
  if (mode === 'rfc3161') return new Rfc3161AuthorityNotWired(env.MOSOLO_TSA_URL?.trim() || 'RFC 3161 (URL non fournie)');
  return new LocalTimestampAuthority(env.MOSOLO_TSA_PRIVATE_KEY?.replace(/\\n/g, '\n'));
}

/* ------------------------------------------------------------------ */
/* Publication externe                                                 */
/* ------------------------------------------------------------------ */

export interface PublishedRootLine {
  day: string;
  toSeq: number;
  headHash: string;
  merkleRoot: string;
  signature: string;
  timestamp: TimestampToken | null;
  publishedAt: string;
}

export interface PublicationTarget {
  readonly kind: 'FICHIER' | 'MEMOIRE';
  readonly location: string;
  publish(line: PublishedRootLine): string;
  readAll(): PublishedRootLine[];
}

export class MemoryPublicationTarget implements PublicationTarget {
  readonly kind = 'MEMOIRE' as const;
  readonly location = 'memoire';
  private readonly lines: string[] = [];
  publish(line: PublishedRootLine): string {
    this.lines.push(JSON.stringify(line));
    return `memoire#${this.lines.length}`;
  }
  readAll(): PublishedRootLine[] {
    return this.lines.map((l) => JSON.parse(l) as PublishedRootLine);
  }
  /** Tests uniquement : altère une racine publiée. */
  unsafeTamperForTests(i: number, patch: Partial<PublishedRootLine>): void {
    this.lines[i] = JSON.stringify({ ...(JSON.parse(this.lines[i]!) as PublishedRootLine), ...patch });
  }
}

/** Fichier en ajout seul (une ligne JSON par racine) : jamais réécrit. */
export class FilePublicationTarget implements PublicationTarget {
  readonly kind = 'FICHIER' as const;
  constructor(readonly location: string) {
    mkdirSync(dirname(location), { recursive: true });
  }
  publish(line: PublishedRootLine): string {
    appendFileSync(this.location, `${JSON.stringify(line)}\n`, { mode: 0o644 });
    return `${this.location}#${this.readAll().length}`;
  }
  readAll(): PublishedRootLine[] {
    try {
      return readFileSync(this.location, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as PublishedRootLine);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }
}

export function publicationFromEnv(env: NodeJS.ProcessEnv = process.env): PublicationTarget {
  const path = env.MOSOLO_AUDIT_ROOT_PUBLISH_PATH?.trim();
  return path ? new FilePublicationTarget(path) : new MemoryPublicationTarget();
}

/** Racine de Merkle (SHA-256) des empreintes d'enregistrements ; dernier élément dupliqué si le niveau est impair. */
export function merkleRoot(hashes: string[]): string {
  if (!hashes.length) return sha256Hex('');
  let level = hashes.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256Hex(level[i]! + (level[i + 1] ?? level[i]!)));
    level = next;
  }
  return level[0]!;
}
