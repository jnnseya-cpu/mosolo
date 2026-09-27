/**
 * Environnement (MOSOLO Environment, modules 18 et 19 — Spécification fonctionnelle, Partie V) :
 * registre des assujettis → simulation d'impact → activation après édit → déclarations et reversements.
 *
 * Règle propre : « désactivé tant qu'aucun édit n'est publié ». La contribution n'est liquidable que lorsqu'une règle
 * ACTIVE porte la clé du registre VX-ENV-PLASTIQUE (quatre visas, texte en vigueur = l'édit). Avant cela :
 *  - le registre des metteurs en marché et leurs tonnages déclarés sont tenus (données réelles des démarches) ;
 *  - la simulation d'impact repose sur une HYPOTHÈSE saisie, datée et sourcée par l'utilisateur (aucun taux par défaut),
 *    appliquée aux tonnages déclarés ; elle n'a AUCUN effet (ni obligation, ni avis) et est journalisée.
 */
import { Money, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { dec, decToString } from '../../core/decimal.js';
import { badRequest, unprocessable } from '../../core/errors.js';
import { authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository } from '../../core/repository.js';
import { ruleCodeFor, type VerticalesService } from './service.js';

const { always, sameEntity } = GRANTS;
const ENV_ENTITY = 'DGTK';
export const PE = { read: 'verticales:environnement.read', simulate: 'verticales:environnement.simulate' } as const;

export function registerEnvironnementPolicies(): void {
  definePolicy(PE.read, { R01: always, R02: always, R05: always, R06: sameEntity, R07: sameEntity, R11: sameEntity, R22: always, R23: always });
  definePolicy(PE.simulate, { R05: always, R06: sameEntity, R07: sameEntity, R11: sameEntity, R23: always });
}

export interface ImpactSimulation {
  id: string;
  hypothesis: { label: string; valuePerTonne: MoneyJSON; source: string; date: string };
  registrants: number;
  declaredTonnes: string;
  estimate: MoneyJSON;
  rows: { objectId: string; raisonSociale: string; tonnes: string | null; estimate: MoneyJSON | null }[];
  ruleStatus: string;
  effect: 'AUCUN';
  by: string;
  at: string;
}

export class EnvironnementService {
  readonly simulations = new InMemoryAppendOnlyRepository<ImpactSimulation>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly vx: VerticalesService) {}

  /** Dernier tonnage déclaré (démarche DECLARATION_TONNAGE non refusée), sinon tonnage annuel déclaré à l'inscription. */
  declaredTonnage(objectId: string): { tonnes: string; periode: string | null; caseId: string | null } | null {
    const decl = this.vx.cases.find((c) => c.vertical === 'environnement' && c.type === 'DECLARATION_TONNAGE' && c.objectId === objectId && c.status !== 'REFUSE')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
    if (decl?.details.tonnage_t) return { tonnes: decl.details.tonnage_t, periode: decl.details.periode ?? null, caseId: decl.id };
    const o = this.ctx.objects.objects.get(objectId);
    const t = o?.attributes.tonnage_annuel_t;
    return typeof t === 'string' && t ? { tonnes: t, periode: null, caseId: null } : null;
  }

  registry(user: User) {
    authorize(user, PE.read, { entity: ENV_ENTITY });
    const code = ruleCodeFor('environnement')!;
    const active = this.vx.activeRuleFor('environnement');
    const items = this.ctx.objects.objects.find((o) => o.attributes.objectType === 'METTEUR_EN_MARCHE').map((o) => {
      const t = this.declaredTonnage(o.id);
      return {
        objectId: o.id, raisonSociale: String(o.attributes.raisonSociale ?? o.attributes.nom ?? 'Metteur en marché'), categorie: String(o.attributes.categorie ?? '') || null,
        commune: o.commune, probativeStatus: o.probativeStatus, taxpayerId: o.taxpayerId ?? null, tonnage: t,
        obligations: this.ctx.assessment.obligations.find((ob) => ob.objectId === o.id && ob.status !== 'ANNULEE').length,
      };
    });
    return {
      rule: active ? { code: active.code, version: active.version, status: 'ACTIVE', demo: active.demo === true } : { code, status: this.vx.ruleByCode(code)?.status ?? 'ACTE_REQUIS' },
      activated: !!active,
      items,
      notice: active
        ? 'Édit publié : la contribution se liquide sur les tonnages déclarés, par une personne habilitée.'
        : 'Désactivé tant qu’aucun édit n’est publié (J15, J16) : registre seulement, aucun montant.',
    };
  }

  simulate(user: User, input: { label: string; valuePerTonne: MoneyJSON; source: string; date: string }): ImpactSimulation {
    authorize(user, PE.simulate, { entity: ENV_ENTITY });
    if (!input.source.trim() || !input.label.trim()) throw badRequest('HYPOTHESIS_REQUIRED', 'Une simulation repose sur une hypothèse explicite, datée et sourcée : aucune valeur par défaut.');
    const v = Money.fromJSON(input.valuePerTonne);
    if (v.isZero() || v.isNegative()) throw unprocessable('INVALID_HYPOTHESIS', 'Valeur par tonne strictement positive attendue.');
    const reg = this.registry(user);
    let total = Money.zero(input.valuePerTonne.currency);
    let tonnes = 0n;
    const rows = reg.items.map((r) => {
      if (!r.tonnage) return { objectId: r.objectId, raisonSociale: r.raisonSociale, tonnes: null, estimate: null };
      const est = v.multiply(r.tonnage.tonnes);
      total = total.add(est);
      tonnes += dec(r.tonnage.tonnes);
      return { objectId: r.objectId, raisonSociale: r.raisonSociale, tonnes: r.tonnage.tonnes, estimate: est.toJSON() };
    });
    const sim = this.simulations.append({
      id: this.ids.next('ENVSIM'), hypothesis: { label: input.label.trim(), valuePerTonne: input.valuePerTonne, source: input.source.trim(), date: input.date },
      registrants: rows.length, declaredTonnes: decToString(tonnes), estimate: total.toJSON(), rows, ruleStatus: reg.rule.status, effect: 'AUCUN', by: user.id, at: this.ctx.clock.now().toISOString(),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'environnement.impact.simulated', resourceType: 'environment_simulation', resourceId: sim.id, details: { registrants: sim.registrants, hypothesis: sim.hypothesis.label, effect: 'AUCUN' } });
    return sim;
  }
}
