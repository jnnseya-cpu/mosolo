/**
 * Outils partagés de la chaîne véhicule : horloge serveur, journal d'audit, preuves photographiques (même contrôle que
 * la caméra de preuve du stationnement : JPEG, empreinte SHA-256 recalculée, doublon refusé), plaque normalisée.
 */
import { normalizePlate } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf, type AuditOutcome } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { kinshasaDate } from '../../core/clock.js';
import { sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, unprocessable } from '../../core/errors.js';
import { IdGenerator } from '../../core/repository.js';
import { MAX_PHOTO_BYTES } from '../parking/field.js';
import type { PhotoRef } from './model.js';

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

export interface PhotoInput { slot: string; imageBase64: string; sha256: string; lat?: number; lon?: number }

export class VcDeps {
  readonly ids = new IdGenerator();
  /** Empreintes de toutes les photos versées au module (une même image ne sert jamais deux fois). */
  private readonly photoHashes = new Set<string>();

  constructor(readonly ctx: AppContext) {}

  now(): string { return this.ctx.clock.now().toISOString(); }
  today(): string { return kinshasaDate(this.ctx.clock.now()); }
  plate(p: string): string { return normalizePlate(p); }

  audit(user: User | null, action: string, resourceType: string, resourceId: string, details: Record<string, unknown> = {}, outcome: AuditOutcome = 'SUCCESS'): void {
    this.ctx.audit.append({
      actor: user ? actorOf(user) : { kind: 'system', id: 'vehicules-controle' },
      action, resourceType, resourceId, details, outcome,
    });
  }

  /** Contrôle et enregistrement des photos (image non conservée ici : empreinte, taille, horodatage serveur, position). */
  photos(inputs: PhotoInput[], opts: { min: number; max: number; slots?: readonly string[]; distinctSlots?: boolean }): PhotoRef[] {
    if (inputs.length < opts.min) throw unprocessable('PHOTOS_MANQUANTES', `${opts.min} photo(s) au moins sont exigées.`);
    if (inputs.length > opts.max) throw unprocessable('PHOTOS_TROP_NOMBREUSES', `${opts.max} photos au plus.`);
    const seen = new Set<string>();
    const out: PhotoRef[] = [];
    for (const p of inputs) {
      if (opts.slots && !opts.slots.includes(p.slot)) throw badRequest('PHOTO_VUE_INCONNUE', `Vue inconnue : ${p.slot}.`);
      if (opts.distinctSlots && seen.has(p.slot)) throw unprocessable('PHOTO_VUE_EN_DOUBLE', `Vue « ${p.slot} » fournie deux fois.`);
      seen.add(p.slot);
      const buf = Buffer.from(p.imageBase64, 'base64');
      if (buf.length === 0 || buf.length > MAX_PHOTO_BYTES) throw badRequest('PHOTO_SIZE', `Photo vide ou trop lourde (${Math.round(MAX_PHOTO_BYTES / 1000)} Ko au plus).`);
      if (!buf.subarray(0, 3).equals(JPEG_MAGIC)) throw badRequest('PHOTO_FORMAT', 'Photo JPEG attendue.');
      const sha = sha256Hex(buf);
      if (sha !== p.sha256.toLowerCase()) throw unprocessable('PHOTO_HASH_MISMATCH', 'Empreinte SHA-256 différente de l’image reçue : photo altérée en transit.');
      if (this.photoHashes.has(sha) || out.some((o) => o.sha256 === sha)) throw conflict('PHOTO_DUPLICATE', 'Cette photo a déjà été versée (une même image ne peut pas servir deux fois).');
      out.push({ slot: p.slot, sha256: sha, bytes: buf.length, at: this.now(), ...(p.lat !== undefined ? { lat: p.lat } : {}), ...(p.lon !== undefined ? { lon: p.lon } : {}) });
    }
    if (opts.distinctSlots && opts.slots && opts.min >= opts.slots.length) {
      const missing = opts.slots.filter((s) => !seen.has(s));
      if (missing.length) throw unprocessable('PHOTOS_MANQUANTES', `Vues manquantes : ${missing.join(', ')}.`);
    }
    for (const o of out) this.photoHashes.add(o.sha256);
    return out;
  }
}

/** Référence propriétaire masquée (jamais le nom ni le téléphone au contrôle). */
export function maskRef(id: string | undefined): string | null {
  if (!id) return null;
  return `${id.slice(0, 4)}•••${id.slice(-3)}`;
}

/** Jour de Kinshasa + n jours (AAAA-MM-JJ). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
