/**
 * Indicateurs de couverture locative (Document maître FR 2, nouvelle version, § 16.6) : « par avenue, quartier et
 * commune : nombre estimé de parcelles et d'unités ; nombre enregistré ; parts occupées par le propriétaire et louées ;
 * nombre de bailleurs et de locataires identifiés ; valeur locative déclarée ; base légalement imposable ; obligations
 * payées et impayées ; concentration géographique de l'activité locative ; taux de couverture du recensement ».
 *
 * Construit sur les données réelles du registre (objets, baux, obligations) :
 *  - aucune estimation inventée : le nombre ESTIMÉ et le taux de couverture qui en dépend sont « non mesurés » tant
 *    qu'aucun modèle de potentiel certifié n'existe (même doctrine que l'indicateur TAUX_RECENSEMENT) ;
 *  - montants par devise, jamais additionnés entre devises ; loyers annualisés selon la périodicité déclarée ;
 *  - la base LÉGALEMENT imposable (revenus locatifs effectivement encaissés, § 16.2) ne se calcule que sur une règle IRL
 *    ACTIVE : à défaut, seule la valeur locative des baux VÉRIFIÉS est présentée, étiquetée comme telle ;
 *  - agrégats sans nom ; l'agent de terrain (accès minimal) reçoit les effectifs sans aucun montant.
 */
import { Money, type MoneyJSON } from '@mosolo/shared';
import type { User } from '../../core/auth.js';
import { badRequest } from '../../core/errors.js';
import { authorize, evaluate } from '../../core/policy.js';
import { PAYABLE_STATUSES } from '../../modules/assessment/service.js';
import { leaseStateOf, type FiscalObject, type Lease } from '../../modules/objects/service.js';
import type { FiscalDeps } from './common.js';
import { occupancyOf } from './situation.js';

export type CoverageLevel = 'COMMUNE' | 'QUARTIER' | 'AVENUE';

const ANNUAL_FACTOR: Record<Lease['periodicity'], number> = { MENSUELLE: 12, TRIMESTRIELLE: 4, SEMESTRIELLE: 2, ANNUELLE: 1 };

type Amounts = Record<string, string>;
const addTo = (acc: Amounts, m: MoneyJSON) => {
  acc[m.currency] = Money.fromJSON({ amount: acc[m.currency] ?? '0', currency: m.currency }).add(Money.fromJSON(m)).toDecimalString();
};

export interface RentalCoverageRow {
  level: CoverageLevel;
  commune: string;
  quartier: string | null;
  avenue: string | null;
  estimated: { parcels: null; units: null; status: 'NON_MESURE'; note: string };
  registered: { parcels: number; buildings: number; units: number; validated: number };
  occupancy: { ownerOccupied: number; leased: number; vacant: number; undeclared: number; ownerOccupiedPct: number | null; leasedPct: number | null };
  parties: { lessors: number; tenants: number };
  leases: { active: number; verified: number; terminated: number; contested: number };
  declaredRentalValue: Amounts | null;
  verifiedRentalValue: Amounts | null;
  legallyTaxableBase: { status: 'NON_CALCULABLE'; note: string };
  obligations: { paid: number; unpaid: number; overdue: number; paidAmount: Amounts | null; unpaidAmount: Amounts | null };
  /** Part de l'activité locative (baux actifs) du périmètre demandé portée par cette zone. */
  concentrationPct: number | null;
  census: { coverageRate: null; status: 'NON_MESURE'; validationRate: number | null };
}

const keyOf = (o: FiscalObject, level: CoverageLevel) =>
  level === 'COMMUNE' ? o.commune : level === 'QUARTIER' ? `${o.commune}|${o.quartier}` : `${o.commune}|${o.quartier}|${o.avenue ?? '(sans voie formelle)'}`;

export class RentalCoverageService {
  constructor(private readonly d: FiscalDeps) {}

  /** Racine foncière d'un objet (parcelle) pour hériter de la localisation et de l'avenue. */
  private root(o: FiscalObject): FiscalObject {
    let cur = o;
    for (let i = 0; i < 5 && cur.parentObjectId; i++) {
      const p = this.d.ctx.objects.objects.get(cur.parentObjectId);
      if (!p) break;
      cur = p;
    }
    return cur;
  }

  report(user: User, input: { level: CoverageLevel; commune?: string; quartier?: string }): { asOf: string; level: CoverageLevel; access: 'full' | 'minimal'; rows: RentalCoverageRow[]; notice: string } {
    if (!['COMMUNE', 'QUARTIER', 'AVENUE'].includes(input.level)) throw badRequest('INVALID_LEVEL', 'Niveau attendu : COMMUNE, QUARTIER ou AVENUE.');
    authorize(user, 'fiscal:census.read', input.commune ? { communes: [input.commune] } : {});
    const access = evaluate(user, 'fiscal:census.read', input.commune ? { communes: [input.commune] } : { communes: user.territory ?? [] }) === 'full' ? 'full' : 'minimal';
    const today = this.d.today();
    const inScope = (o: FiscalObject) => (!input.commune || o.commune === input.commune) && (!input.quartier || o.quartier.toLowerCase() === input.quartier.toLowerCase())
      && (!user.territory || user.territory.includes(o.commune));
    const objects = this.d.ctx.objects.objects.all().filter(inScope);
    const located = (o: FiscalObject) => {
      const r = this.root(o);
      return { ...o, avenue: o.avenue ?? r.avenue } as FiscalObject;
    };
    const groups = new Map<string, FiscalObject[]>();
    for (const o of objects) {
      const lo = located(o);
      const k = keyOf(lo, input.level);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(lo);
    }
    const leasesAll = this.d.ctx.objects.leases.all();
    const activeLease = (l: Lease) => l.start <= today && (!l.end || l.end >= today) && !l.termination;
    const totalActive = leasesAll.filter((l) => activeLease(l) && objects.some((o) => o.id === l.unitObjectId)).length;
    const irlActive = this.d.ctx.rules.rules.all().some((r) => r.status === 'ACTIVE' && /IRL|LOCATI/i.test(`${r.code} ${r.label}`));

    const rows: RentalCoverageRow[] = [...groups.entries()].map(([k, objs]): RentalCoverageRow => {
      const [commune, quartier, avenue] = k.split('|');
      const ids = new Set(objs.map((o) => o.id));
      const units = objs.filter((o) => o.category === 'UNITE_LOCATIVE');
      const rentable = objs.filter((o) => ['UNITE_LOCATIVE', 'BATIMENT', 'PARCELLE'].includes(o.category));
      const occ = { ownerOccupied: 0, leased: 0, vacant: 0, undeclared: 0 };
      for (const o of (units.length ? units : rentable)) {
        const c = occupancyOf(this.d, o).code;
        if (c === 'MIS_EN_BAIL') occ.leased++; else if (c === 'OCCUPE_PAR_LE_PROPRIETAIRE') occ.ownerOccupied++; else if (c === 'VACANT') occ.vacant++; else occ.undeclared++;
      }
      const base = units.length || rentable.length;
      const leases = leasesAll.filter((l) => ids.has(l.unitObjectId));
      const active = leases.filter(activeLease);
      const declared: Amounts = {};
      const verified: Amounts = {};
      for (const l of active) {
        const annual = Money.fromJSON(l.rent).multiply(String(ANNUAL_FACTOR[l.periodicity])).toJSON();
        addTo(declared, annual);
        if (leaseStateOf(l) === 'VERIFIE') addTo(verified, annual);
      }
      const obligations = this.d.ctx.assessment.obligations.find((o) => ids.has(o.objectId) && o.status !== 'ANNULEE' && !o.supersededBy);
      const paid = obligations.filter((o) => o.status === 'SOLDEE');
      const unpaid = obligations.filter((o) => PAYABLE_STATUSES.includes(o.status));
      const paidAmount: Amounts = {};
      const unpaidAmount: Amounts = {};
      for (const o of paid) addTo(paidAmount, o.amount);
      for (const o of unpaid) addTo(unpaidAmount, o.amount);
      const pct = (n: number, dnm: number) => (dnm ? Math.round((n * 1000) / dnm) / 10 : null);
      return {
        level: input.level, commune: commune!, quartier: input.level === 'COMMUNE' ? null : quartier!, avenue: input.level === 'AVENUE' ? avenue! : null,
        estimated: { parcels: null, units: null, status: 'NON_MESURE', note: 'Aucun modèle de potentiel certifié : le nombre estimé n’est pas inventé.' },
        registered: {
          parcels: objs.filter((o) => o.category === 'PARCELLE').length, buildings: objs.filter((o) => o.category === 'BATIMENT').length, units: units.length,
          validated: objs.filter((o) => o.status === 'VALIDE').length,
        },
        occupancy: { ...occ, ownerOccupiedPct: pct(occ.ownerOccupied, base), leasedPct: pct(occ.leased, base) },
        parties: {
          lessors: new Set(active.map((l) => l.lessorId).filter(Boolean)).size,
          tenants: new Set(active.map((l) => l.lesseeId).filter(Boolean)).size,
        },
        leases: {
          active: active.length, verified: active.filter((l) => leaseStateOf(l) === 'VERIFIE').length,
          terminated: leases.filter((l) => leaseStateOf(l) === 'RESILIE').length, contested: leases.filter((l) => leaseStateOf(l) === 'CONTESTE').length,
        },
        declaredRentalValue: access === 'full' ? declared : null,
        verifiedRentalValue: access === 'full' ? verified : null,
        legallyTaxableBase: {
          status: 'NON_CALCULABLE',
          note: irlActive
            ? 'Base légale (revenus locatifs effectivement encaissés, § 16.2) : issue des déclarations IRL liquidées sur la règle ACTIVE — voir les obligations.'
            : 'Aucune règle IRL ACTIVE : la base légalement imposable n’est pas calculée ; seule la valeur locative des baux vérifiés est présentée.',
        },
        obligations: {
          paid: paid.length, unpaid: unpaid.length, overdue: unpaid.filter((o) => o.status === 'EN_RETARD' || this.d.ctx.assessment.isPastDue(o, today)).length,
          paidAmount: access === 'full' ? paidAmount : null, unpaidAmount: access === 'full' ? unpaidAmount : null,
        },
        concentrationPct: pct(active.length, totalActive),
        census: { coverageRate: null, status: 'NON_MESURE', validationRate: pct(objs.filter((o) => o.status === 'VALIDE').length, objs.length) },
      };
    }).sort((a, b) => (b.concentrationPct ?? 0) - (a.concentrationPct ?? 0) || `${a.commune}${a.quartier}${a.avenue}`.localeCompare(`${b.commune}${b.quartier}${b.avenue}`));
    return {
      asOf: today, level: input.level, access, rows,
      notice: 'Agrégats sans donnée nominative. Montants annualisés par devise, jamais additionnés entre devises. Estimations et taux de couverture non mesurés sans modèle de potentiel certifié.',
    };
  }
}
