/**
 * Module 18 — Contribution plastique et environnement (Spécification fonctionnelle ; § 8.2 G82-01 ; points J15, J16).
 *
 * Le module est DÉSACTIVÉ tant que la règle n'est pas publiée : aucune déclaration ni aucun reversement n'est accepté,
 * aucune obligation n'est possible sans texte en vigueur (§ 6.2). Restent ouverts, pour l'instruction de l'édit :
 *  - le registre des assujettis potentiels (producteurs, importateurs, distributeurs) — identification sans obligation ;
 *  - les données d'étude d'impact (volumes par catégorie, source) ;
 *  - la simulation de l'impact d'une fiche de règle du registre (brouillon ou « acte requis ») sur ces données,
 *    NON OPPOSABLE : aucun taux n'est porté ici, seuls ceux de la fiche simulée sont appliqués.
 * Activation : la régie désigne la règle du registre (configuration de la fiche 18, avec l'acte) ; le module s'active
 * dès que cette règle est ACTIVE (publiée par le circuit à quatre visas). Reversements : liquidation par la règle ACTIVE
 * sur la déclaration, par une personne habilitée distincte du déclarant.
 */
import type { MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { kinshasaDate } from '../../core/clock.js';
import { dec, decToString } from '../../core/decimal.js';
import { badRequest, conflict, notFound, unprocessable } from '../../core/errors.js';
import { authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { enginePrincipal, paymentState } from '../parking/support.js';
import type { FichesService } from './fiches.js';
import { P } from './policies.js';
import { SECTOR_ENTITY } from './secteurs.js';

export const PLASTIC_ROLES = ['PRODUCTEUR', 'IMPORTATEUR', 'DISTRIBUTEUR'] as const;
/** Catégories de déclaration (libellés descriptifs ; la liste opposable sera celle de l'édit). */
export const PLASTIC_CATEGORIES = {
  emballages_kg: 'Emballages plastiques (kg)', sachets_kg: 'Sachets et films (kg)', bouteilles_kg: 'Bouteilles et flacons (kg)', autres_kg: 'Autres produits plastiques (kg)',
} as const;
type Cat = keyof typeof PLASTIC_CATEGORIES;
const DECIMAL = /^\d{1,12}(\.\d{1,4})?$/;

export interface PlasticLiable { id: string; taxpayerId: string; roles: (typeof PLASTIC_ROLES)[number][]; categories: Cat[]; source: string; motif: string; by: string; at: string }
export interface StudyData { id: string; taxpayerId: string | null; period: string; lines: Partial<Record<Cat, string>>; source: string; fileSha256: string | null; by: string; at: string }
export interface PlasticDeclaration { id: string; taxpayerId: string; objectId: string; period: string; lines: Partial<Record<Cat, string>>; status: 'DEPOSEE' | 'LIQUIDEE'; obligationId?: string; declaredBy: string; declaredAt: string; liquidatedBy?: string }
export interface Simulation { id: string; ruleId: string; ruleCode: string; ruleVersion: number; ruleStatus: string; scenario: string; lines: { taxpayerId: string | null; inputs: Record<string, string>; value: string | null; error?: string }[]; total: string; currency: string; by: string; at: string; nonOpposable: true }

export class PlastiqueService {
  readonly liable = new InMemoryRepository<PlasticLiable>();
  readonly study = new InMemoryAppendOnlyRepository<StudyData>();
  readonly declarations = new InMemoryRepository<PlasticDeclaration>();
  readonly simulations = new InMemoryAppendOnlyRepository<Simulation>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly fiches: FichesService) {}

  private now(): Date { return this.ctx.clock.now(); }

  status() {
    const rs = this.fiches.ruleStatus('18');
    return {
      active: !!rs.active, ruleCode: rs.ruleCode, ruleStatus: rs.status,
      notice: rs.active ? `Module activé : règle ${rs.active.code} v${rs.active.version} ACTIVE.` : 'Module désactivé : aucune règle publiée et ACTIVE (acte requis — J15, J16). Aucune obligation sans texte en vigueur ; étude d’impact et simulation seulement.',
    };
  }

  private assertActive(user: User, action: string) {
    const st = this.status();
    if (!st.active) {
      this.ctx.audit.append({ actor: actorOf(user), action: `verticales.plastic.${action}.refused`, resourceType: 'sector_module', resourceId: '18', outcome: 'DENIED', details: { reason: 'MODULE_DESACTIVE', ruleCode: st.ruleCode } });
      throw unprocessable('MODULE_DESACTIVE', st.notice);
    }
    return this.fiches.ruleStatus('18').active!;
  }

  private checkLines(lines: Record<string, string>): Partial<Record<Cat, string>> {
    const out: Partial<Record<Cat, string>> = {};
    for (const [k, v] of Object.entries(lines)) {
      if (!(k in PLASTIC_CATEGORIES)) throw badRequest('UNKNOWN_CATEGORY', `Catégorie non prévue : ${k}`);
      if (!DECIMAL.test(v)) throw badRequest('INVALID_QUANTITY', `${PLASTIC_CATEGORIES[k as Cat]} : nombre positif attendu.`);
      out[k as Cat] = v;
    }
    if (!Object.keys(out).length) throw badRequest('QUANTITIES_REQUIRED', 'Au moins une catégorie est requise.');
    return out;
  }

  // ---------------------------------------------------------------- registre des assujettis (identification)

  registerLiable(user: User, input: { taxpayerId: string; roles: PlasticLiable['roles']; categories: string[]; source: string; motif: string }) {
    authorize(user, P.plasticStudy, { entity: SECTOR_ENTITY });
    this.ctx.taxpayers.get(input.taxpayerId);
    const cats = input.categories.filter((c): c is Cat => c in PLASTIC_CATEGORIES);
    if (cats.length !== input.categories.length) throw badRequest('UNKNOWN_CATEGORY', 'Catégorie non prévue.');
    if (this.liable.get(input.taxpayerId)) throw conflict('ALREADY_REGISTERED', 'Assujetti déjà identifié.');
    const l = this.liable.insert({ id: input.taxpayerId, taxpayerId: input.taxpayerId, roles: input.roles, categories: cats, source: input.source, motif: input.motif, by: user.id, at: this.now().toISOString() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.plastic.liable.registered', resourceType: 'taxpayer', resourceId: input.taxpayerId, details: { roles: l.roles, categories: l.categories, source: l.source, obligation: 'AUCUNE' } });
    return l;
  }

  // ---------------------------------------------------------------- étude d'impact et simulation

  addStudyData(user: User, input: { taxpayerId?: string; period: string; lines: Record<string, string>; source: string; fileSha256?: string }) {
    authorize(user, P.plasticStudy, { entity: SECTOR_ENTITY });
    if (input.taxpayerId) this.ctx.taxpayers.get(input.taxpayerId);
    if (!/^\d{4}(-(0[1-9]|1[0-2]))?$/.test(input.period)) throw badRequest('INVALID_PERIOD', 'Période AAAA ou AAAA-MM attendue.');
    const d = this.study.append({ id: this.ids.next('ETU-PLA'), taxpayerId: input.taxpayerId ?? null, period: input.period, lines: this.checkLines(input.lines), source: input.source, fileSha256: input.fileSha256 ?? null, by: user.id, at: this.now().toISOString() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.plastic.study.recorded', resourceType: 'study_data', resourceId: d.id, details: { period: d.period, source: d.source } });
    return d;
  }

  /**
   * Simulation d'impact : la fiche de règle choisie (tout statut, y compris brouillon ou ACTE_REQUIS) est appliquée aux
   * données d'étude, ligne par ligne, avec ses propres taux ; résultat NON OPPOSABLE, conservé pour l'instruction.
   */
  simulate(user: User, input: { ruleId: string; scenario: string; period?: string }) {
    authorize(user, P.plasticStudy, { entity: SECTOR_ENTITY });
    const rule = this.ctx.rules.get(input.ruleId);
    const rows = this.study.find((d) => !input.period || d.period.startsWith(input.period));
    if (!rows.length) throw unprocessable('NO_STUDY_DATA', 'Aucune donnée d’étude : simulation impossible (aucune valeur inventée).');
    const req = this.ctx.rules.requiredInputs(rule);
    let total = 0n;
    const lines = rows.map((r) => {
      const inputs = Object.fromEntries(req.filter((k) => r.lines[k as Cat] !== undefined).map((k) => [k, r.lines[k as Cat]!]));
      const missing = req.filter((k) => inputs[k] === undefined);
      if (missing.length) {
        // Catégories absentes de la ligne : valeur nulle pour la simulation (la ligne ne déclare pas ce produit).
        for (const k of missing) if (k in PLASTIC_CATEGORIES) inputs[k] = '0';
      }
      try {
        const ev = this.ctx.rules.evaluate(rule, inputs, 1);
        total += dec(ev.value);
        return { taxpayerId: r.taxpayerId, inputs, value: ev.value };
      } catch (e) {
        return { taxpayerId: r.taxpayerId, inputs, value: null, error: e instanceof Error ? e.message : String(e) };
      }
    });
    const s = this.simulations.append({
      id: this.ids.next('SIM-PLA'), ruleId: rule.id, ruleCode: rule.code, ruleVersion: rule.version, ruleStatus: rule.status, scenario: input.scenario, lines,
      total: decToString(total), currency: rule.currency, by: user.id, at: this.now().toISOString(), nonOpposable: true,
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.plastic.impact.simulated', resourceType: 'simulation', resourceId: s.id, details: { ruleCode: rule.code, ruleVersion: rule.version, lines: lines.length, total: s.total } });
    return s;
  }

  // ---------------------------------------------------------------- déclarations et reversements (module activé seulement)

  declare(user: User, input: { taxpayerId?: string; objectId: string; period: string; lines: Record<string, string> }) {
    const taxpayerId = input.taxpayerId ?? user.taxpayerId;
    if (!taxpayerId) throw badRequest('TAXPAYER_REQUIRED', 'Contribuable concerné requis.');
    authorize(user, P.plasticDeclare, { taxpayerId });
    this.assertActive(user, 'declaration');
    const o = this.ctx.objects.get(input.objectId);
    if (o.taxpayerId !== taxpayerId) throw unprocessable('OBJECT_NOT_OWNED', 'L’objet n’est pas rattaché à ce contribuable.');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) throw badRequest('INVALID_PERIOD', 'Période AAAA-MM attendue.');
    if (this.declarations.findOne((d) => d.taxpayerId === taxpayerId && d.period === input.period && d.objectId === o.id)) throw conflict('DECLARATION_EXISTS', 'Déclaration déjà déposée pour cette période.');
    const d = this.declarations.insert({ id: this.ids.next('DPL'), taxpayerId, objectId: o.id, period: input.period, lines: this.checkLines(input.lines), status: 'DEPOSEE', declaredBy: user.id, declaredAt: this.now().toISOString() });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.plastic.declared', resourceType: 'plastic_declaration', resourceId: d.id, details: { period: d.period, lines: d.lines } });
    return d;
  }

  /** Reversement : liquidation de la déclaration par la règle ACTIVE (personne distincte du déclarant). */
  liquidate(user: User, id: string) {
    authorize(user, P.sectorLiquidate, { entity: SECTOR_ENTITY });
    const rule = this.assertActive(user, 'liquidation');
    const d = this.declarations.get(id);
    if (!d) throw notFound('PLASTIC_DECLARATION_NOT_FOUND', `Déclaration inconnue : ${id}`);
    if (d.status === 'LIQUIDEE') throw conflict('ALREADY_LIQUIDATED', 'Déclaration déjà liquidée : aucune double facturation.');
    if (d.declaredBy === user.id) throw unprocessable('SEPARATION_OF_DUTIES', 'Le déclarant ne liquide pas sa propre déclaration.');
    const req = this.ctx.rules.requiredInputs(rule);
    const inputs = Object.fromEntries(req.map((k) => [k, d.lines[k as Cat] ?? '0']));
    const res = this.ctx.assessment.calculate(enginePrincipal('svc-plastique', 'Liquidation contribution plastique', rule.administeringEntity), { ruleId: rule.id, taxpayerId: d.taxpayerId, objectId: d.objectId, inputs, simulate: false });
    const saved = this.declarations.update({ ...d, status: 'LIQUIDEE', obligationId: res.obligation!.id, liquidatedBy: user.id });
    this.ctx.audit.append({ actor: actorOf(user), action: 'verticales.plastic.liquidated', resourceType: 'plastic_declaration', resourceId: id, details: { obligationId: res.obligation!.id, ruleCode: rule.code, ruleVersion: rule.version } });
    return saved;
  }

  view(user: User) {
    authorize(user, P.plasticRead, { entity: SECTOR_ENTITY });
    return {
      ...this.status(), roles: PLASTIC_ROLES, categories: PLASTIC_CATEGORIES,
      liable: this.liable.all().map((l) => ({ ...l, name: this.ctx.taxpayers.taxpayers.get(l.taxpayerId)?.fullName ?? l.taxpayerId })),
      study: this.study.all().slice(-50).reverse(),
      simulations: this.simulations.all().slice(-20).reverse().map((s) => ({ id: s.id, ruleCode: s.ruleCode, ruleVersion: s.ruleVersion, ruleStatus: s.ruleStatus, scenario: s.scenario, total: s.total, currency: s.currency, lines: s.lines.length, at: s.at, nonOpposable: true })),
      declarations: this.declarations.all().map((d) => ({ ...d, payment: d.obligationId ? paymentState(this.ctx, d.obligationId).state : null })),
      rules: this.ctx.rules.list().filter((r) => r.code === this.fiches.config('18').ruleCode || r.revenueCategory === 'ACTE_REQUIS').map((r) => ({ id: r.id, code: r.code, version: r.version, status: r.status, label: r.label })),
      indicators: this.indicators(),
      serverDate: kinshasaDate(this.now()),
    };
  }

  indicators(): { assujettis: number; simulations: number; declarations: number; reversements: MoneyJSON[] | null } {
    const paid = this.declarations.all().filter((d) => d.obligationId).map((d) => paymentState(this.ctx, d.obligationId)).filter((p) => p.amount).map((p) => p.amount!);
    return { assujettis: this.liable.count(), simulations: this.simulations.count(), declarations: this.declarations.count(), reversements: paid.length ? paid : null };
  }
}
