/**
 * Règlement en trésorerie — dépôt d'un FICHIER de relevé (banque ou opérateur) avec totaux de contrôle déclarés
 * (spécification fonctionnelle, module 29 : « Import des relevés — banques et opérateurs » ; « Contrôler l'intégrité des
 * relevés » ; « Double validation des imports »).
 *
 * Même circuit que l'import par l'API (`POST /v1/settlements/statements`) : le fichier est lu strictement, son empreinte
 * SHA-256 et ses totaux de contrôle (nombre de lignes, total par devise, période) sont vérifiés, puis il devient une
 * PROPOSITION d'import du Trésor (TreasuryService.proposeImport) ; une seconde personne habilitée, distincte, le valide
 * (`POST /v1/settlements/statements/:statementId/validation`). Aucun circuit parallèle : une seule file d'imports.
 */
import { AmountPrecisionError, CURRENCY_CODES, Money, type CurrencyCode } from '@mosolo/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { requireUser, type User } from '../../core/auth.js';
import { sha256Hex } from '../../core/crypto.js';
import { unprocessable } from '../../core/errors.js';
import { isoDateString, moneySchema, parse } from '../../core/http.js';
import { authorize } from '../../core/policy.js';
import type { StatementLine } from '../../modules/treasury/service.js';
import { definePlugin } from '../types.js';

/** Colonnes attendues d'une ligne du fichier : compte ; montant ; devise ; date de valeur ; référence [; contrepartie]. */
export const STATEMENT_FILE_COLUMNS = ['compte', 'montant', 'devise', 'date_valeur', 'reference', 'contrepartie (facultatif)'] as const;

/** Lecture stricte du fichier (séparateur « ; » ou tabulation, sinon « , ») ; une ligne illisible est une erreur d'intégrité. */
export function parseStatementFile(content: string): { lines: StatementLine[]; errors: string[] } {
  const lines: StatementLine[] = [];
  const errors: string[] = [];
  const rows = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  rows.forEach((row, i) => {
    const cells = (/[;\t]/.test(row) ? row.split(/[;\t]/) : row.split(',')).map((c) => c.trim());
    if (i === 0 && /^compte$/i.test(cells[0] ?? '')) return; // ligne d'en-tête
    const [accountAlias, amount, currency, valueDate, paymentReference, counterparty] = cells;
    if (!accountAlias || !amount || !currency || !valueDate || !paymentReference) {
      errors.push(`Ligne ${i + 1} : ${STATEMENT_FILE_COLUMNS.slice(0, 5).join(' ; ')} attendus.`);
      return;
    }
    if (!(CURRENCY_CODES as readonly string[]).includes(currency)) { errors.push(`Ligne ${i + 1} : devise inconnue « ${currency} ».`); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(valueDate)) { errors.push(`Ligne ${i + 1} : date de valeur AAAA-MM-JJ attendue.`); return; }
    try {
      Money.parseStrict({ amount, currency: currency as CurrencyCode });
    } catch (e) {
      errors.push(`Ligne ${i + 1} : montant ${e instanceof AmountPrecisionError ? 'trop précis pour la devise' : 'invalide'} (« ${amount} »).`);
      return;
    }
    lines.push({ accountAlias, amount: { amount, currency: currency as CurrencyCode }, valueDate, paymentReference, ...(counterparty && counterparty.length >= 8 ? { counterparty } : {}) });
  });
  return { lines, errors };
}

export class StatementDepositService {
  constructor(private readonly ctx: AppContext) {}

  /** Dépôt d'un fichier : lecture, empreinte, totaux de contrôle, puis proposition d'import (aucune écriture). */
  deposit(user: User, input: {
    statementId: string; source: 'BANQUE' | 'OPERATEUR'; institution: string; periodFrom: string; periodTo: string;
    fileName: string; fileContent: string; declared: { lines: number; totals: { amount: string; currency: CurrencyCode }[] };
  }) {
    authorize(user, 'tresorerie:releve.proposer');
    if (input.periodTo < input.periodFrom) throw unprocessable('PERIODE_INVALIDE', 'Fin de période antérieure au début.');
    const { lines, errors } = parseStatementFile(input.fileContent);
    return this.ctx.treasury.proposeImport(user, {
      statementId: input.statementId, lines,
      source: {
        kind: input.source, institution: input.institution.trim(), fileName: input.fileName.trim(), fileSha256: sha256Hex(Buffer.from(input.fileContent, 'utf8')),
        period: { from: input.periodFrom, to: input.periodTo }, declared: input.declared, ...(errors.length ? { readErrors: errors } : {}),
      },
    });
  }

  /**
   * Indicateurs du module 29 : délai de règlement (confirmation → règlement, médiane en heures, sur données réelles) et
   * fonds en attente (compte d'attente ouvert, par devise) ; imports en attente de seconde validation.
   */
  indicators(user: User) {
    authorize(user, 'reconciliation.read');
    const settled = this.ctx.payments.orders.find((o) => !!o.confirmedAt && !!o.settledAt);
    const hours = settled.map((o) => (Date.parse(o.settledAt!) - Date.parse(o.confirmedAt!)) / 3_600_000).sort((a, b) => a - b);
    const imports = this.ctx.treasury.imports.all();
    return {
      delaiReglement: hours.length
        ? { statut: 'MESURE' as const, medianeHeures: Math.round(hours[Math.floor(hours.length / 2)]! * 10) / 10, paiements: hours.length }
        : { statut: 'NON_MESURE' as const, motif: 'Aucun paiement confirmé puis réglé sur relevé validé.' },
      imports: {
        enAttente: imports.filter((i) => i.status === 'EN_ATTENTE_VALIDATION').length, valides: imports.filter((i) => i.status === 'VALIDE').length,
        rejetes: imports.filter((i) => i.status === 'REJETE').length, integriteKo: imports.filter((i) => i.status === 'INTEGRITE_KO').length,
      },
    };
  }
}

const depositSchema = z.object({
  statementId: z.string().trim().min(1).max(100),
  source: z.enum(['BANQUE', 'OPERATEUR']),
  institution: z.string().trim().min(2).max(120),
  periodFrom: isoDateString,
  periodTo: isoDateString,
  fileName: z.string().trim().min(1).max(200),
  fileContent: z.string().min(1).max(2_000_000),
  declared: z.object({ lines: z.number().int().min(0).max(100_000), totals: z.array(moneySchema).max(10) }).strict(),
}).strict();

export function registerStatementDepositRoutes(app: FastifyInstance, svc: StatementDepositService): void {
  // Dépôt d'un fichier de relevé : proposition d'import (202) avec contrôle d'intégrité ; validation par une autre personne.
  app.post('/v1/tresor/releves/depots', async (req, reply) => {
    const r = svc.deposit(requireUser(req), parse(depositSchema, req.body));
    if (r.replayed) return reply.code(200).send(r.result);
    return reply.code(202).send({ ...r.pending, lines: r.pending.lines.length });
  });
  app.get('/v1/tresor/releves/indicateurs', async (req) => svc.indicators(requireUser(req)));
}

/** Module d'extension « tresorReleves » : dépôt de fichiers de relevés (module 29), dans la file commune des imports. */
export const tresorRelevesPlugin = definePlugin<StatementDepositService>({
  name: 'tresorReleves',
  create: (ctx) => new StatementDepositService(ctx),
  routes: (app, _ctx, svc) => registerStatementDepositRoutes(app, svc),
});
