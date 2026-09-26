import { CURRENCY_CODES, isLanguageCode, REFERENCE_LANGUAGE, type LanguageCode } from '@mosolo/shared';
import type { FastifyRequest } from 'fastify';
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
export const currencySchema = currencyEnum as unknown as z.ZodType<(typeof CURRENCY_CODES)[number]>;

/** MoneyJSON : montant décimal en chaîne (jamais de nombre flottant). */
export const moneySchema = z.object({
  amount: z.string().regex(/^\d{1,18}(\.\d{1,6})?$/, 'montant décimal positif en chaîne attendu, ex. "150.00"'),
  currency: currencySchema,
}).strict();

export const decimalString = z.string().regex(/^-?\d{1,18}(\.\d{1,18})?$/, 'nombre décimal en chaîne attendu');
export const isoDateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date AAAA-MM-JJ attendue');

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
