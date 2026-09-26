/** Outils partagés du module fiscal (objets, relations, déclarations, exonérations, quitus). */
import { isoDate } from '../../core/clock.js';
import type { User } from '../../core/auth.js';
import { badRequest } from '../../core/errors.js';
import { checkChar, hmacSha256Hex, randomCode, safeEqualHex } from '../../core/crypto.js';
import type { AppContext } from '../../context.js';
import type { FiscalObject } from '../../modules/objects/service.js';
import type { GeoRegistry } from './geo.js';

export interface FiscalDeps {
  ctx: AppContext;
  geo: GeoRegistry;
  /** Signature HMAC tronquée des jetons QR (plaques, quitus, attestations). */
  sign(payload: string): string;
  verify(payload: string, signature: string): boolean;
  today(): string;
  nowIso(): string;
}

export function makeDeps(ctx: AppContext, geo: GeoRegistry): FiscalDeps {
  // Clé dérivée, propre au module (séparation des usages) ; en production : clé dédiée en HSM.
  const key = hmacSha256Hex(ctx.secrets.auditHmacKey, 'mosolo:fiscal:qr:v1');
  const sign = (payload: string) => hmacSha256Hex(key, payload).slice(0, 24);
  return {
    ctx,
    geo,
    sign,
    verify: (payload, signature) => safeEqualHex(sign(payload), signature.toLowerCase()),
    today: () => isoDate(ctx.clock.now()),
    nowIso: () => ctx.clock.now().toISOString(),
  };
}

export const actorOf = (u: User) => ({ kind: 'user' as const, id: u.id, roles: u.roles });

/** Code court lisible (base 32 de Crockford) + caractère de contrôle, présenté `ABCD-EFGH-K`. */
export function newShortCode(): string {
  const core = randomCode(8);
  return `${core}${checkChar(core)}`;
}

export function formatShortCode(c: string): string {
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
}

/** Normalise un code saisi (tirets, espaces, minuscules) ; `null` si le caractère de contrôle est faux. */
export function normalizeShortCode(raw: string): string | null {
  const c = raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!/^[0-9A-HJKMNP-TV-Z]{9}$/.test(c)) return null;
  return checkChar(c.slice(0, 8)) === c[8] ? c : null;
}

/** Pourcentage décimal en chaîne (« 50 », « 33.33 ») → centièmes de pour cent (entier). */
export function pctToBasis(s: string, field = 'quote-part'): number {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) throw badRequest('INVALID_PERCENT', `${field} : pourcentage décimal attendu (ex. « 50 » ou « 33.33 »).`);
  const [i, f = ''] = s.split('.');
  const v = Number(i) * 100 + Number(f.padEnd(2, '0'));
  if (v <= 0 || v > 10000) throw badRequest('INVALID_PERCENT', `${field} : valeur attendue entre 0 (exclu) et 100.`);
  return v;
}

export const basisToPct = (b: number) => `${Math.floor(b / 100)}${b % 100 ? `.${String(b % 100).padStart(2, '0')}` : ''}`;

/** Parent hiérarchique d'un objet (champ typé, ou attribut hérité `parcelleId` / `batimentId`). */
export function parentIdOf(o: FiscalObject): string | undefined {
  if (o.parentObjectId) return o.parentObjectId;
  const a = o.attributes;
  const v = a['batimentId'] ?? a['parcelleId'];
  return typeof v === 'string' ? v : undefined;
}

export const CATEGORY_LABELS: Record<string, string> = {
  PARCELLE: 'Parcelle', BATIMENT: 'Bâtiment', UNITE_LOCATIVE: 'Unité locative', ACTIVITE: 'Activité / établissement',
  VEHICULE: 'Véhicule', PANNEAU: 'Support publicitaire', AUTRE: 'Autre objet',
};

/** Masque un identifiant contribuable pour une vérification publique (ex. KIN-••••••••-7). */
export function maskIuc(iuc: string): string {
  const parts = iuc.split('-');
  if (parts.length === 3) return `${parts[0]}-${'•'.repeat(4)}${parts[1]!.slice(-2)}-${parts[2]}`;
  return `${iuc.slice(0, 3)}•••`;
}

/** Ajoute des jours à une date AAAA-MM-JJ. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
