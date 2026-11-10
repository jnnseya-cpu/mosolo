import { CURRENCY_CODES, isLanguageCode, REFERENCE_LANGUAGE, type LanguageCode } from '@mosolo/shared';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { auditContext, type AuditRequestContext } from './audit.js';
import { z, type ZodTypeAny } from 'zod';
import { badRequest } from './errors.js';

/** Valide une entrée avec zod ; lève 400 VALIDATION_ERROR (RFC 9457) avec la liste des erreurs. */
export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    throw badRequest('VALIDATION_ERROR', r.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; '), {
      errors: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

const currencyEnum = z.enum(CURRENCY_CODES as [string, ...string[]]);
// Conversion justifiée : z.enum exige un tuple non vide ; le catalogue partagé des devises est un tableau `readonly`.
export const currencySchema = currencyEnum as unknown as z.ZodType<(typeof CURRENCY_CODES)[number]>;

/** MoneyJSON : montant décimal en chaîne (jamais de nombre flottant). */
/**
 * Saisie d'un nombre telle qu'une personne la tape (audit des saisies, 01/10/2026) : virgule décimale française
 * (« 12,5 »), espaces de milliers (« 1 500 », espace insécable compris) acceptés et ramenés à la forme canonique
 * (« 12.5 », « 1500 ») avant contrôle. Une valeur déjà canonique est inchangée.
 */
export const normaliserNombre = (v: unknown): unknown => {
  // Un nombre JSON (flottant) reste refusé : jamais de montant en virgule flottante (règle du socle).
  if (typeof v !== 'string') return v;
  const t = v.trim().replace(/[\s\u00a0\u202f]/g, '');
  return /^-?\d+,\d+$/.test(t) ? t.replace(',', '.') : t;
};

export const moneySchema = z.object({
  amount: z.preprocess(normaliserNombre, z.string().regex(/^\d{1,18}(\.\d{1,6})?$/, 'montant décimal positif attendu, ex. « 150 », « 150,00 » ou « 1 500 »')),
  currency: currencySchema,
}).strict();

export const decimalString = z.preprocess(normaliserNombre, z.string().regex(/^-?\d{1,18}(\.\d{1,18})?$/, 'nombre décimal attendu, ex. « 12,5 »'));
/**
 * Date civile AAAA-MM-JJ RÉELLE (deuxième passe adverse, 27/09/2026) : « 2026-02-30 » était acceptée puis décalée au
 * 2 mars par le moteur de dates, « 2026-13-01 » devenait une date invalide. Le jour doit exister au calendrier.
 */
export function isRealCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}
export const isoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date AAAA-MM-JJ attendue').refine(isRealCalendarDate, 'date inexistante au calendrier');

/** Langue : ?lang= puis Accept-Language ; français par défaut (langue de référence). */
export function requestLang(req: FastifyRequest): LanguageCode {
  const q = (req.query as Record<string, unknown> | undefined)?.lang;
  if (typeof q === 'string' && isLanguageCode(q)) return q;
  const header = req.headers['accept-language'];
  if (typeof header === 'string') {
    for (const part of header.split(',')) {
      const code = part.split(';')[0]!.trim().toLowerCase().split('-')[0]!;
      if (isLanguageCode(code)) return code;
    }
  }
  return REFERENCE_LANGUAGE;
}

export function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/* ------------------------------------------------------------------ */
/* Corrélation des requêtes (§ 30.1 X-Request-Id) et contexte d'audit  */
/* ------------------------------------------------------------------ */

/** Identifiant de corrélation accepté tel quel : 8 à 128 caractères sûrs ; sinon un identifiant est généré. */
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
/** En-têtes d'appareil (terminal enrôlé, empreinte du navigateur) repris dans l'audit (§ 29.1 appareil et session). */
export const DEVICE_ID_HEADER = 'x-mosolo-device-id';
export const DEVICE_FINGERPRINT_HEADER = 'x-mosolo-device-fingerprint';
const DEVICE_RE = /^[A-Za-z0-9._:-]{3,128}$/;

declare module 'fastify' {
  interface FastifyRequest {
    /** Identifiant de corrélation (X-Request-Id reçu ou généré), propagé à chaque enregistrement d'audit. */
    correlationId?: string;
  }
}

export function requestIdOf(value: unknown): string {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && REQUEST_ID_RE.test(v.trim()) ? v.trim() : `req-${randomUUID()}`;
}

/** Appareil déclaré par la requête (jamais une preuve : l'intégrité passe par la signature du terminal). */
export function deviceOf(req: FastifyRequest): { deviceId?: string; deviceFingerprint?: string } {
  const id = header(req, DEVICE_ID_HEADER)?.trim();
  const fp = header(req, DEVICE_FINGERPRINT_HEADER)?.trim();
  return { ...(id && DEVICE_RE.test(id) ? { deviceId: id } : {}), ...(fp && DEVICE_RE.test(fp) ? { deviceFingerprint: fp } : {}) };
}

/**
 * Premier crochet de requête : X-Request-Id accepté (ou généré), renvoyé dans la réponse, et contexte d'audit ouvert
 * pour toute la requête (AsyncLocalStorage) — corrélation, session et appareil de chaque enregistrement.
 */
export function installRequestCorrelation(app: FastifyInstance): void {
  app.addHook('onRequest', (req, reply, done) => {
    const id = requestIdOf(req.headers['x-request-id']);
    req.correlationId = id;
    void reply.header('x-request-id', id);
    const store: AuditRequestContext = {
      correlationId: id,
      resolve: () => ({ ...(req.user?.auth?.sessionId ? { sessionId: req.user.auth.sessionId } : {}), ...deviceOf(req) }),
    };
    auditContext.run(store, done);
  });
}

/** Contexte d'audit de la requête en cours (pour y rattacher une élévation privilégiée active). */
export function currentAuditContext(): AuditRequestContext | undefined {
  return auditContext.getStore();
}
