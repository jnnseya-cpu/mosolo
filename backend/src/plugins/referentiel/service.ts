/**
 * Référentiel des recettes (Cahier ch. 7, § 6.2, § 6.3) : lignes § 7.1 / 7.2 / 7.3 et ancien IPM, inventaire de
 * référence § 7.4 (attributs inconnus = « non renseigné », jamais inventés), recettes administratives § 7.5 rattachées
 * à une démarche, un acte ou une prestation, registre des codes STABLES et NON RÉUTILISABLES, espaces de recettes
 * (provincial ; communal distinct prévu, non activé), et base de référence consommable par le § 38.1.
 *
 * Aucun taux ni montant : la liquidation reste l'affaire d'une règle ACTIVE du registre (quatre visas).
 */
import {
  activableInProvincialScope, ADMINISTRATIVE_REVENUES, COMPETENCE_LABEL, INVENTORY_ATTRIBUTES, NON_RENSEIGNE, REVENUE_REFERENCE,
  type InventoryKey, type RevenueLine,
} from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { badRequest, conflict, notFound } from '../../core/errors.js';
import { authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { InMemoryRepository } from '../../core/repository.js';
import { VERTICALS } from '../verticales/catalogue.js';

const { always } = GRANTS;
const READERS = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R11', 'R13', 'R14', 'R15', 'R16', 'R17', 'R18', 'R22', 'R23'] as const;

export function registerReferentielPolicies(): void {
  definePolicy('referentiel:read', Object.fromEntries(READERS.map((r) => [r, always])));
  definePolicy('referentiel:inventory.write', { R05: always, R06: always, R07: always, R13: always, R14: always });
  // Réservation d'un code par le juriste rédacteur ou vérificateur ; retrait par le vérificateur ou l'autorité de publication.
  definePolicy('referentiel:code.reserve', { R13: always, R14: always });
  definePolicy('referentiel:code.retire', { R14: always, R16: always });
}

export const CODE_FORMAT = /^[A-Z0-9][A-Z0-9-]{2,39}$/;

export interface RevenueCode {
  id: string;
  code: string;
  label: string;
  origin: 'REFERENTIEL' | 'RESERVATION';
  status: 'ACTIF' | 'RETIRE';
  reservedBy: string;
  reservedAt: string;
  retirement?: { by: string; at: string; motif: string };
}

export interface InventoryValue { value: string; source: string; by: string; at: string }
export interface InventoryRecord {
  id: string;
  code: string;
  attributes: Partial<Record<InventoryKey, InventoryValue>>;
  history: { key: InventoryKey; previous: string; value: string; source: string; by: string; at: string }[];
}

export class ReferentielService {
  /** Registre des codes : un code retiré reste enregistré pour toujours (non réutilisable). */
  readonly codes = new InMemoryRepository<RevenueCode>();
  readonly inventory = new InMemoryRepository<InventoryRecord>();

  constructor(private readonly ctx: AppContext) {
    const at = ctx.clock.now().toISOString();
    for (const l of [...REVENUE_REFERENCE, ...ADMINISTRATIVE_REVENUES]) {
      if (!this.codes.get(l.code)) this.codes.insert({ id: l.code, code: l.code, label: l.label, origin: 'REFERENTIEL', status: 'ACTIF', reservedBy: 'referentiel-cahier-ch7', reservedAt: at });
    }
  }

  line(code: string): RevenueLine {
    const l = REVENUE_REFERENCE.find((x) => x.code === code);
    if (!l) throw notFound('REVENUE_LINE_NOT_FOUND', `Ligne de recette inconnue : ${code}`);
    return l;
  }

  /** Attributs § 7.4 d'une ligne : chaque attribut non documenté vaut « non renseigné ». */
  inventoryOf(code: string) {
    const rec = this.inventory.get(code);
    return INVENTORY_ATTRIBUTES.map((a) => {
      const v = rec?.attributes[a.key];
      return { key: a.key, label: a.label, expected: a.expected, value: v?.value ?? NON_RENSEIGNE, renseigne: !!v, source: v?.source ?? null, updatedAt: v?.at ?? null };
    });
  }

  publicLine(l: RevenueLine) {
    const act = activableInProvincialScope(l);
    return {
      ...l, competenceLabel: COMPETENCE_LABEL[l.competence], codeStatus: this.codes.get(l.code)?.status ?? 'ACTIF',
      activation: act.ok ? { activable: true, reasons: [] } : { activable: false, reasons: act.reasons },
      rates: 'Aucun taux au référentiel : le montant résulte d’une règle ACTIVE du registre (quatre visas).',
    };
  }

  lines(user: User) {
    authorize(user, 'referentiel:read');
    return REVENUE_REFERENCE.map((l) => ({ ...this.publicLine(l), inventory: this.inventoryOf(l.code) }));
  }

  updateInventory(user: User, code: string, input: { key: InventoryKey; value: string; source: string }) {
    authorize(user, 'referentiel:inventory.write');
    this.line(code);
    if (!INVENTORY_ATTRIBUTES.some((a) => a.key === input.key)) throw badRequest('UNKNOWN_ATTRIBUTE', `Attribut d’inventaire inconnu : ${input.key}`);
    const value = input.value.trim();
    if (!value || value.toLowerCase() === NON_RENSEIGNE) throw badRequest('VALUE_REQUIRED', 'Valeur documentée requise (une valeur inconnue reste « non renseigné »).');
    const at = this.ctx.clock.now().toISOString();
    const rec = this.inventory.get(code) ?? this.inventory.insert({ id: code, code, attributes: {}, history: [] });
    const previous = rec.attributes[input.key]?.value ?? NON_RENSEIGNE;
    const saved = this.inventory.update({
      ...rec, attributes: { ...rec.attributes, [input.key]: { value, source: input.source.trim(), by: user.id, at } },
      history: [...rec.history, { key: input.key, previous, value, source: input.source.trim(), by: user.id, at }],
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'referentiel.inventory.updated', resourceType: 'revenue_line', resourceId: code, details: { key: input.key, previous, value, source: input.source.trim() } });
    return { code, inventory: this.inventoryOf(code), history: saved.history };
  }

  /**
   * Base de référence (§ 38.1) : alimentée par l'inventaire § 7.4 ; les réalisations des exercices antérieurs, certifiées
   * par l'auditeur, restent « non renseigné » tant qu'elles ne sont pas versées. Consommable par le pilotage.
   */
  baseline(user: User) {
    authorize(user, 'referentiel:read');
    const items = REVENUE_REFERENCE.filter((l) => l.provincialScope).map((l) => {
      const inv = this.inventoryOf(l.code);
      const filled = inv.filter((a) => a.renseigne).length;
      return {
        code: l.code, section: l.section, label: l.label, competence: l.competence, revenueCategory: l.revenueCategory, status: l.status,
        attributes: Object.fromEntries(inv.map((a) => [a.key, a.value])) as Record<InventoryKey, string>,
        completeness: { filled, total: inv.length },
        realisationsPriorYears: NON_RENSEIGNE,
        readyForBaseline: filled === inv.length,
      };
    });
    return {
      generatedAt: this.ctx.clock.now().toISOString(), source: 'Référentiel des recettes (§ 7.4)', consumer: '§ 38.1 — base de référence',
      items, ready: items.filter((i) => i.readyForBaseline).length, total: items.length,
      notice: 'Aucune valeur n’est estimée : un attribut inconnu reste « non renseigné ». Les anciennes références et les taux non confirmés restent désactivés jusqu’à validation.',
    };
  }

  administrative() {
    return ADMINISTRATIVE_REVENUES.map((a) => {
      let resolved = true;
      if (a.linkedTo.kind === 'DEMARCHE') {
        const [slug, proc] = a.linkedTo.ref.split(':');
        resolved = !!VERTICALS.find((v) => v.slug === slug)?.procedures.some((p) => p.code === proc);
      }
      return { ...a, codeStatus: this.codes.get(a.code)?.status ?? 'ACTIF', linkResolved: resolved };
    });
  }

  spaces() {
    const of = (space: string) => REVENUE_REFERENCE.filter((l) => l.space === space).map((l) => ({ code: l.code, label: l.label, competence: l.competence, provincialScope: l.provincialScope }));
    return [
      { id: 'PROVINCIAL', label: 'Espace des recettes provinciales', active: true, lines: of('PROVINCIAL'), note: 'Périmètre de MOSOLO.' },
      {
        id: 'COMMUNAL', label: 'Espace des recettes communales (distinct)', active: false, lines: of('COMMUNAL'),
        note: 'Prévu pour l’accueil ultérieur des recettes des communes et chefferies : le Kinois garde un compte unique, chaque administration ne voit que ses propres recettes. Non activé.',
      },
    ];
  }

  // ------------------------------------------------------------------ registre des codes (stables, non réutilisables)

  listCodes(user: User) {
    authorize(user, 'referentiel:read');
    return this.codes.all().sort((a, b) => a.code.localeCompare(b.code));
  }

  reserveCode(user: User, input: { code: string; label: string }): RevenueCode {
    authorize(user, 'referentiel:code.reserve');
    const code = input.code.trim().toUpperCase();
    if (!CODE_FORMAT.test(code)) throw badRequest('INVALID_REVENUE_CODE', 'Code : 3 à 40 caractères, lettres majuscules, chiffres et tirets.');
    const existing = this.codes.get(code);
    if (existing?.status === 'RETIRE') {
      this.ctx.audit.append({ actor: actorOf(user), action: 'referentiel.code.reuse_refused', resourceType: 'revenue_code', resourceId: code, outcome: 'DENIED', details: { retiredAt: existing.retirement?.at ?? null } });
      throw conflict('CODE_RETIRED_NOT_REUSABLE', `Le code ${code} a été retiré le ${existing.retirement?.at.slice(0, 10) ?? '?'} : un code de recette n’est jamais réutilisé.`);
    }
    if (existing) throw conflict('CODE_ALREADY_ASSIGNED', `Le code ${code} est déjà attribué (${existing.label}).`);
    if (this.ctx.rules.rules.findOne((r) => r.code === code)) throw conflict('CODE_ALREADY_ASSIGNED', `Le code ${code} est déjà porté par une règle du registre.`);
    const entry = this.codes.insert({ id: code, code, label: input.label.trim(), origin: 'RESERVATION', status: 'ACTIF', reservedBy: user.id, reservedAt: this.ctx.clock.now().toISOString() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'referentiel.code.reserved', resourceType: 'revenue_code', resourceId: code, details: { label: entry.label } });
    return entry;
  }

  retireCode(user: User, code: string, motif: string): RevenueCode {
    authorize(user, 'referentiel:code.retire');
    const entry = this.codes.get(code.trim().toUpperCase());
    if (!entry) throw notFound('REVENUE_CODE_NOT_FOUND', `Code inconnu : ${code}`);
    if (entry.status === 'RETIRE') throw conflict('CODE_ALREADY_RETIRED', `Le code ${entry.code} est déjà retiré.`);
    const active = this.ctx.rules.rules.findOne((r) => r.code === entry.code && r.status === 'ACTIVE');
    if (active) throw conflict('CODE_IN_USE_BY_ACTIVE_RULE', `Le code ${entry.code} porte une règle ACTIVE (v${active.version}) : abrogez-la d’abord.`);
    const saved = this.codes.update({ ...entry, status: 'RETIRE', retirement: { by: user.id, at: this.ctx.clock.now().toISOString(), motif: motif.trim() } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'referentiel.code.retired', resourceType: 'revenue_code', resourceId: entry.code, details: { motif: motif.trim() } });
    return saved;
  }
}
