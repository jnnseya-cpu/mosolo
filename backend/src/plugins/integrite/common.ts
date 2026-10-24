/** Outils communs du module Intégrité : acteurs, chiffrement de l'identité du signalant, codes de suivi, délais. */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { AppContext } from '../../context.js';
import type { AuditActor } from '../../core/audit.js';
import type { Principal, User } from '../../core/auth.js';
import { hmacSha256Hex, randomCode } from '../../core/crypto.js';
import { forbidden } from '../../core/errors.js';
import { IdGenerator } from '../../core/repository.js';
import type { SealedIdentity, Severity } from './types.js';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/**
 * Délais de traitement de DÉMONSTRATION (paramétrables). Aucun délai légal n'est présumé : les délais opposables
 * (réponse aux demandes des personnes, notification des violations) restent à fixer au regard du Code du numérique.
 */
export const DELAYS = {
  demo: true,
  note: 'Délais de démonstration paramétrables — non fixés par un acte.',
  reportQualificationHours: 48,
  reportTreatmentDays: { CRITIQUE: 7, ELEVEE: 15, MOYENNE: 30, FAIBLE: 45 } as Record<Severity, number>,
  incidentHours: { CRITIQUE: 24, ELEVEE: 72, MOYENNE: 7 * 24, FAIBLE: 30 * 24 } as Record<Severity, number>,
  privacyRequestDays: 30,
  accessReviewDays: 15,
  accessReviewPeriodDays: 90,
} as const;

export class Kit {
  readonly ids = new IdGenerator();
  private readonly identityKey: Buffer;
  private readonly trackingKey: Buffer;

  constructor(readonly ctx: AppContext) {
    // Clés dérivées de la clé serveur (production : clés dédiées en HSM, détenues par la Ville).
    const master = process.env.MOSOLO_INTEGRITE_KEY ?? ctx.secrets.auditHmacKey;
    this.identityKey = Buffer.from(hkdfSync('sha256', master, 'mosolo-integrite', 'identite-signalant', 32));
    this.trackingKey = Buffer.from(hkdfSync('sha256', master, 'mosolo-integrite', 'code-de-suivi', 32));
  }

  now(): string {
    return this.ctx.clock.now().toISOString();
  }

  plus(ms: number, from?: string): string {
    return new Date((from ? new Date(from).getTime() : this.ctx.clock.now().getTime()) + ms).toISOString();
  }

  audit(actor: Principal | 'public' | 'system', action: string, resourceType: string, resourceId: string, details: Record<string, unknown> = {}, outcome: 'SUCCESS' | 'DENIED' = 'SUCCESS') {
    this.ctx.audit.append({ actor: actorOf(actor), action, resourceType, resourceId, details, outcome });
  }

  /** Scelle l'identité du signalant (AES-256-GCM). */
  seal(identity: Record<string, string>): SealedIdentity {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.identityKey, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(identity), 'utf8'), c.final()]);
    return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
  }

  /** Ouverture STRICTEMENT interne (accusés de réception) : jamais exposée par une route. */
  unseal(s: SealedIdentity): Record<string, string> {
    const d = createDecipheriv('aes-256-gcm', this.identityKey, Buffer.from(s.iv, 'base64'));
    d.setAuthTag(Buffer.from(s.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(s.ct, 'base64')), d.final()]).toString('utf8')) as Record<string, string>;
  }

  /** Code de suivi secret (Crockford, 12 caractères, groupés par 4). */
  newTrackingCode(): string {
    const c = randomCode(12);
    return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;
  }

  trackingHash(code: string): string {
    return hmacSha256Hex(this.trackingKey, normalizeCode(code));
  }
}

/** Normalisation Crockford : majuscules, sans séparateurs, I/L → 1, O → 0. */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
}

export function actorOf(p: Principal | 'public' | 'system'): AuditActor {
  if (p === 'public') return { kind: 'public', id: 'ligne-de-signalement' };
  if (p === 'system') return { kind: 'system', id: 'integrite' };
  if (p.kind === 'ai') return { kind: 'ai', id: p.id };
  return { kind: 'user', id: p.id, roles: p.roles };
}

export function principalId(p: Principal): string {
  return p.id;
}

export function isUser(p: Principal): p is User {
  return p.kind === 'user';
}

/** Protection de la personne mise en cause… et du signalant : une personne visée n'accède jamais au dossier. */
export function assertNotImplicated(kit: Kit, p: Principal, implicated: string[], resourceType: string, resourceId: string): void {
  if (implicated.includes(p.id)) {
    kit.audit(p, 'integrite.access.implicated_refused', resourceType, resourceId, {}, 'DENIED');
    throw forbidden('IMPLICATED_PERSON', 'Accès refusé : vous êtes mis en cause dans ce dossier. La procédure vous sera notifiée par l’autorité compétente.');
  }
}

/** Distance orthodromique en kilomètres. */
export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function hoursBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / HOUR;
}
