/** Objets fiscaux (parcelles, bâtiments, unités locatives, activités…) et baux (ch. 16). */
import { Money, type MoneyJSON, type ProbativeStatus } from '@mosolo/shared';
import type { AuditLog } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import type { Clock } from '../../core/clock.js';
import { badRequest, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { isCommune } from '../../reference/kinshasa.js';
import type { CommunicationService } from '../communications/service.js';
import { taxpayerRecipient } from '../identity/recipients.js';
import type { TaxpayerService } from '../identity/service.js';

export const OBJECT_CATEGORIES = ['PARCELLE', 'BATIMENT', 'UNITE_LOCATIVE', 'ACTIVITE', 'VEHICULE', 'PANNEAU', 'AUTRE'] as const;
export type ObjectCategory = (typeof OBJECT_CATEGORIES)[number];

export interface FiscalObject {
  id: string;
  taxpayerId?: string;
  category: ObjectCategory;
  commune: string;
  quartier: string;
  localityRank: 1 | 2 | 3 | 4;
  lat: number;
  lon: number;
  /** Attributs déclarés (jamais écrasés par un constat terrain). */
  attributes: Record<string, unknown>;
  /** Dernières valeurs observées sur le terrain sans conflit, par champ. */
  observed: Record<string, unknown>;
  status: 'PROVISOIRE' | 'VALIDE';
  probativeStatus: ProbativeStatus;
  createdBy: string;
  createdAt: string;
  /** Objet parent dans la hiérarchie parcelle → bâtiment → unité (§ 16.1). */
  parentObjectId?: string;
  /** Avenue ou voie (hiérarchie SIG commune › quartier › avenue › parcelle). */
  avenue?: string;
  /**
   * Identifiant géographique fiscal (§ 17.3) : UUID interne permanent + code territorial lisible,
   * attribués à la validation et jamais réattribués.
   */
  igf?: { uuid: string; code: string; codeVersion: number; assignedAt: string; assignedBy: string };
  validatedBy?: string;
  validatedAt?: string;
}

export const LEASE_PERIODICITIES = ['MENSUELLE', 'TRIMESTRIELLE', 'SEMESTRIELLE', 'ANNUELLE'] as const;

export interface Lease {
  id: string;
  unitObjectId: string;
  lessorId?: string;
  lesseeId?: string;
  rent: MoneyJSON;
  periodicity: (typeof LEASE_PERIODICITIES)[number];
  start: string;
  end?: string;
  declaredBy: string;
  declaredByRole: 'BAILLEUR' | 'LOCATAIRE' | 'MANDATAIRE';
  probativeStatus: ProbativeStatus;
  createdAt: string;
}

export interface CreateObjectInput {
  taxpayerId?: string;
  category: ObjectCategory;
  commune: string;
  quartier: string;
  localityRank: 1 | 2 | 3 | 4;
  lat: number;
  lon: number;
  attributes: Record<string, unknown>;
  parentObjectId?: string;
  avenue?: string;
}

export class ObjectService {
  readonly objects = new InMemoryRepository<FiscalObject>();
  readonly leases = new InMemoryRepository<Lease>();
  private readonly ids = new IdGenerator();

  constructor(
    private readonly clock: Clock,
    private readonly audit: AuditLog,
    private readonly comms: CommunicationService,
    private readonly taxpayers: TaxpayerService,
  ) {}

  create(user: User, input: CreateObjectInput, fixedId?: string): FiscalObject {
    if (!isCommune(input.commune)) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${input.commune}`);
    // Un contribuable ne déclare que pour lui-même.
    const taxpayerId = user.roles.includes('R30') && !input.taxpayerId ? user.taxpayerId : input.taxpayerId;
    authorize(user, 'object.create', { taxpayerId, communes: [input.commune] });
    if (taxpayerId) this.taxpayers.get(taxpayerId);
    if (input.parentObjectId) this.get(input.parentObjectId);
    const isAgent = !user.roles.includes('R30');
    const obj = this.objects.insert({
      id: fixedId ?? this.ids.next('OBJ'),
      ...(taxpayerId ? { taxpayerId } : {}),
      category: input.category,
      commune: input.commune,
      quartier: input.quartier,
      localityRank: input.localityRank,
      lat: input.lat,
      lon: input.lon,
      attributes: input.attributes,
      observed: {},
      status: 'PROVISOIRE',
      probativeStatus: isAgent ? 'OBSERVE' : 'DECLARE',
      createdBy: user.id,
      createdAt: this.clock.now().toISOString(),
      ...(input.parentObjectId ? { parentObjectId: input.parentObjectId } : {}),
      ...(input.avenue ? { avenue: input.avenue } : {}),
    });
    this.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles },
      action: 'object.declared',
      resourceType: 'fiscal_object',
      resourceId: obj.id,
      details: { category: obj.category, commune: obj.commune, probativeStatus: obj.probativeStatus },
    });
    if (taxpayerId) {
      this.comms.publish('object.provisional.created', [taxpayerRecipient(this.taxpayers.get(taxpayerId))], { reference: obj.id }, { entity: 'DGIPK' });
    }
    return obj;
  }

  get(id: string): FiscalObject {
    const o = this.objects.get(id);
    if (!o) throw notFound('OBJECT_NOT_FOUND', `Objet fiscal inconnu : ${id}`);
    return o;
  }

  /**
   * Validation d'un objet par un agent habilité (l'autorisation est vérifiée par l'appelant) :
   * statut VALIDE, statut probant VÉRIFIÉ, identifiant géofiscal figé s'il n'existe pas encore.
   */
  markValidated(id: string, by: User, igf: { uuid: string; code: string; codeVersion: number }): FiscalObject {
    const o = this.get(id);
    const now = this.clock.now().toISOString();
    const updated = this.objects.update({
      ...o,
      status: 'VALIDE',
      probativeStatus: o.probativeStatus === 'CONTESTE' ? 'CONTESTE' : 'VERIFIE',
      igf: o.igf ?? { ...igf, assignedAt: now, assignedBy: by.id },
      validatedBy: by.id,
      validatedAt: now,
    });
    this.audit.append({
      actor: { kind: 'user', id: by.id, roles: by.roles }, action: 'object.validated', resourceType: 'fiscal_object', resourceId: id,
      details: { igf: updated.igf?.code, igfUuid: updated.igf?.uuid, firstAssignment: !o.igf },
    });
    return updated;
  }

  /** Rattache le redevable principal d'un objet provisoire (après validation d'une relation de propriété). */
  setHolder(id: string, taxpayerId: string): FiscalObject {
    const o = this.get(id);
    this.taxpayers.get(taxpayerId);
    return this.objects.update({ ...o, taxpayerId });
  }

  /** Statut probant de l'objet (ex. CONTESTÉ pendant un conflit de revendications). */
  setProbativeStatus(id: string, probativeStatus: ProbativeStatus): FiscalObject {
    const o = this.get(id);
    return this.objects.update({ ...o, probativeStatus });
  }

  byTaxpayer(taxpayerId: string): FiscalObject[] {
    return this.objects.find((o) => o.taxpayerId === taxpayerId);
  }

  declareLease(
    user: User,
    input: { unitObjectId: string; lessorId?: string; lesseeId?: string; rent: MoneyJSON; periodicity: Lease['periodicity']; start: string; end?: string },
    fixedId?: string,
  ): Lease {
    authorize(user, 'lease.declare');
    const unit = this.get(input.unitObjectId);
    if (!['UNITE_LOCATIVE', 'BATIMENT', 'PARCELLE'].includes(unit.category)) {
      throw unprocessable('NOT_A_RENTABLE_UNIT', `L'objet ${unit.id} (${unit.category}) ne peut pas faire l'objet d'un bail.`);
    }
    const rent = Money.fromJSON(input.rent);
    if (rent.isNegative() || rent.isZero()) throw badRequest('INVALID_RENT', 'Le loyer doit être strictement positif.');
    if (input.end && input.end < input.start) throw badRequest('INVALID_PERIOD', 'La date de fin précède la date de début.');

    let { lessorId, lesseeId } = input;
    let declaredByRole: Lease['declaredByRole'];
    if (user.roles.includes('R30')) {
      const self = user.taxpayerId;
      if (!self) throw forbidden('FORBIDDEN', 'Compte contribuable non rattaché.');
      if (lessorId !== self && lesseeId !== self) {
        if (!lessorId) lessorId = self;
        else if (!lesseeId) lesseeId = self;
        else throw forbidden('NOT_A_LEASE_PARTY', 'Seuls le bailleur ou le locataire peuvent déclarer ce bail.');
      }
      declaredByRole = lessorId === self ? 'BAILLEUR' : 'LOCATAIRE';
    } else {
      const m = user.mandants ?? [];
      if (!(lessorId && m.includes(lessorId)) && !(lesseeId && m.includes(lesseeId))) {
        throw forbidden('NOT_A_LEASE_PARTY', 'Le mandataire doit représenter le bailleur ou le locataire.');
      }
      declaredByRole = 'MANDATAIRE';
    }
    if (lessorId) this.taxpayers.get(lessorId);
    if (lesseeId) this.taxpayers.get(lesseeId);

    const lease = this.leases.insert({
      id: fixedId ?? this.ids.next('BAIL'),
      unitObjectId: unit.id,
      ...(lessorId ? { lessorId } : {}),
      ...(lesseeId ? { lesseeId } : {}),
      rent: rent.toJSON(),
      periodicity: input.periodicity,
      start: input.start,
      ...(input.end ? { end: input.end } : {}),
      declaredBy: user.id,
      declaredByRole,
      probativeStatus: 'DECLARE',
      createdAt: this.clock.now().toISOString(),
    });
    this.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles },
      action: 'lease.declared',
      resourceType: 'lease',
      resourceId: lease.id,
      details: { unitObjectId: unit.id, declaredByRole },
    });
    if (declaredByRole === 'LOCATAIRE' && lessorId) {
      this.comms.publish('lease.declared_by_tenant', [taxpayerRecipient(this.taxpayers.get(lessorId))], { reference: lease.id }, { entity: 'DGIPK' });
    }
    return lease;
  }

  leasesOf(taxpayerId: string): Lease[] {
    return this.leases.find((l) => l.lessorId === taxpayerId || l.lesseeId === taxpayerId);
  }
}
