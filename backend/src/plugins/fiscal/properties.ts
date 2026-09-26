/**
 * Objets fiscaux côté cadastre : validation et attribution de l'IGF, QR par bien (plaque / étiquette NFIU),
 * scan agent (situation, occupation, sans montant) et vérification publique minimale (§ 16.8, § H.9.1).
 * Scan public : UNIQUEMENT « plaque authentique, bien enregistré, commune, quartier » — le statut « payé /
 * non payé » n'est jamais affiché publiquement pour un bien identifiable (ARB-76).
 * La pose d'une plaque n'emporte aucune restriction de location avant l'acte NFIU (ARB-16, J27).
 */
import type { User } from '../../core/auth.js';
import { conflict, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import type { FiscalObject } from '../../modules/objects/service.js';
import { actorOf, CATEGORY_LABELS, formatShortCode, newShortCode, normalizeShortCode, parentIdOf, type FiscalDeps } from './common.js';
import type { RelationService } from './relations.js';
import { coverageOf, occupancyOf, situationOf } from './situation.js';

export type PlateStatus = 'EMISE' | 'POSEE' | 'ENDOMMAGEE' | 'REMPLACEE';

export interface PropertyPlate {
  id: string;
  objectId: string;
  igfUuid: string;
  /** NFIU affiché = code territorial lisible de l'IGF. */
  nfiu: string;
  shortCode: string;
  signature: string;
  status: PlateStatus;
  issuedAt: string;
  issuedBy: string;
  posedAt?: string;
  posedBy?: string;
  gps?: { lat: number; lon: number };
  replacedBy?: string;
  replaces?: string;
}

export interface PlateCheck { id: string; at: string; shortCode: string; result: string; channel: 'PUBLIC' | 'AGENT'; actorId: string }

export class PropertyService {
  readonly plates = new InMemoryRepository<PropertyPlate>();
  readonly checks = new InMemoryAppendOnlyRepository<PlateCheck>();
  private readonly ids = new IdGenerator();

  constructor(private readonly d: FiscalDeps, private readonly relations: RelationService) {}

  parentOf(o: FiscalObject): FiscalObject | undefined {
    const pid = parentIdOf(o);
    return pid ? this.d.ctx.objects.objects.get(pid) : undefined;
  }

  childrenOf(o: FiscalObject): FiscalObject[] {
    return this.d.ctx.objects.objects.find((c) => c.id !== o.id && parentIdOf(c) === o.id);
  }

  /**
   * Validation par un agent habilité (contrôleur, chef de service, direction) : IGF stable généré une seule fois,
   * étiquette QR émise. Une nouvelle validation ne change jamais l'IGF.
   */
  validateObject(user: User, objectId: string): { object: FiscalObject; plate: PropertyPlate } {
    const obj = this.d.ctx.objects.get(objectId);
    authorize(user, 'fiscal:object.validate', { communes: [obj.commune] });
    // Séparation des tâches : celui qui a recensé ou déclaré ne valide pas.
    assertDistinctPerson(user.id, [obj.createdBy], 'L’auteur du recensement ou de la déclaration ne peut pas valider l’objet.');
    const parent = this.parentOf(obj);
    let validated = obj;
    if (!obj.igf) {
      if (!parent) {
        const q = this.d.geo.ensureQuartier(obj.commune, obj.quartier);
        if (obj.avenue) this.d.geo.ensureAvenue(q, obj.avenue);
      }
      const siblings = parent ? this.childrenOf(parent).filter((c) => c.igf && c.category === obj.category).length : 0;
      const igf = this.d.geo.generateIgf(obj, parent, siblings);
      validated = this.d.ctx.objects.markValidated(obj.id, user, igf);
    } else {
      validated = this.d.ctx.objects.markValidated(obj.id, user, obj.igf);
    }
    const plate = this.currentPlate(obj.id) ?? this.issuePlate(user, validated);
    return { object: validated, plate };
  }

  currentPlate(objectId: string): PropertyPlate | undefined {
    return this.plates.findOne((p) => p.objectId === objectId && p.status !== 'REMPLACEE');
  }

  private payload(p: { shortCode: string; igfUuid: string; nfiu: string }) {
    return `plaque|${p.shortCode}|${p.igfUuid}|${p.nfiu}`;
  }

  private issuePlate(user: User, obj: FiscalObject, replaces?: PropertyPlate): PropertyPlate {
    if (!obj.igf) throw unprocessable('OBJECT_NOT_VALIDATED', 'Un QR par bien n’est émis qu’après validation (IGF attribué).');
    const shortCode = newShortCode();
    const base = { shortCode, igfUuid: obj.igf.uuid, nfiu: obj.igf.code };
    const plate = this.plates.insert({
      id: this.ids.next('PLQ'), objectId: obj.id, ...base, signature: this.d.sign(this.payload(base)),
      status: 'EMISE', issuedAt: this.d.nowIso(), issuedBy: user.id, ...(replaces ? { replaces: replaces.id } : {}),
    });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'object.plate.issued', resourceType: 'property_plate', resourceId: plate.id, details: { objectId: obj.id, nfiu: plate.nfiu, replaces: replaces?.id ?? null } });
    if (obj.taxpayerId) {
      this.d.ctx.comms.publish('object.plate.issued', [taxpayerRecipient(this.d.ctx.taxpayers.get(obj.taxpayerId))], { objet: plate.nfiu }, { entity: 'DGIPK' });
    }
    return plate;
  }

  /** Pose de la plaque par un agent (identification administrative, sans effet restrictif avant l'acte J27). */
  posePlate(user: User, objectId: string, input: { gps?: { lat: number; lon: number } }): PropertyPlate {
    const obj = this.d.ctx.objects.get(objectId);
    authorize(user, 'fiscal:plate.pose', { communes: [obj.commune] });
    const plate = this.currentPlate(objectId);
    if (!plate) throw unprocessable('NO_PLATE', 'Aucune étiquette émise : l’objet doit d’abord être validé.');
    if (plate.status === 'POSEE') throw conflict('PLATE_ALREADY_POSED', 'Plaque déjà posée.');
    const updated = this.plates.update({ ...plate, status: 'POSEE', posedAt: this.d.nowIso(), posedBy: user.id, ...(input.gps ? { gps: input.gps } : {}) });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'object.plate.posed', resourceType: 'property_plate', resourceId: plate.id, details: { objectId, gps: input.gps ?? null } });
    return updated;
  }

  /** Remplacement (plaque endommagée ou perdue) : l'ancien QR ne vérifie plus, l'IGF reste identique. */
  replacePlate(user: User, objectId: string, reason: string): PropertyPlate {
    const obj = this.d.ctx.objects.get(objectId);
    authorize(user, 'fiscal:plate.pose', { communes: [obj.commune] });
    const old = this.currentPlate(objectId);
    if (!old) throw unprocessable('NO_PLATE', 'Aucune plaque à remplacer.');
    const fresh = this.issuePlate(user, obj, old);
    this.plates.update({ ...old, status: 'REMPLACEE', replacedBy: fresh.id });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'object.plate.replaced', resourceType: 'property_plate', resourceId: old.id, details: { by: fresh.id, reason } });
    return fresh;
  }

  /** Données du QR par bien : chemin de vérification signé (le frontend y ajoute l'origine). */
  qrOf(plate: PropertyPlate) {
    return {
      plateId: plate.id, nfiu: plate.nfiu, shortCode: formatShortCode(plate.shortCode), status: plate.status,
      verifyPath: `/fiscal/verifier/bien/${plate.shortCode}?s=${plate.signature}`,
    };
  }

  private findByCode(raw: string): PropertyPlate | undefined {
    const code = normalizeShortCode(raw);
    return code ? this.plates.findOne((p) => p.shortCode === code) : undefined;
  }

  /** Vérification publique minimale : aucun nom, aucun montant, aucune situation de paiement (ARB-76). */
  publicCheck(raw: string, signature?: string) {
    const plate = this.findByCode(raw);
    const at = this.d.nowIso();
    let result: 'AUTHENTIQUE' | 'REMPLACEE' | 'SIGNATURE_INVALIDE' | 'INCONNU';
    if (!plate) result = 'INCONNU';
    else if (signature !== undefined && !this.d.verify(this.payload(plate), signature)) result = 'SIGNATURE_INVALIDE';
    else if (plate.status === 'REMPLACEE') result = 'REMPLACEE';
    else result = 'AUTHENTIQUE';
    this.checks.append({ id: this.ids.next('CHK-PLQ', 8), at, shortCode: raw.slice(0, 20), result, channel: 'PUBLIC', actorId: 'public' });
    this.d.ctx.audit.append({ actor: { kind: 'public', id: 'verification-plaque' }, action: 'object.plate.public_check', resourceType: 'property_plate', resourceId: plate?.id ?? 'inconnu', outcome: result === 'AUTHENTIQUE' ? 'SUCCESS' : 'FAILURE', details: { result } });
    if (!plate || result === 'INCONNU' || result === 'SIGNATURE_INVALIDE') {
      return { result, checkedAt: at, message: result === 'INCONNU' ? 'Code inconnu : cette plaque n’est pas reconnue par KINSHASA MOSOLO.' : 'Signature invalide : cette plaque n’est pas authentique. Signalez-la au guichet communal.' };
    }
    const obj = this.d.ctx.objects.get(plate.objectId);
    return {
      result,
      checkedAt: at,
      nfiu: plate.nfiu,
      category: CATEGORY_LABELS[obj.category] ?? obj.category,
      commune: obj.commune,
      quartier: obj.quartier,
      registered: obj.status === 'VALIDE',
      plateStatus: plate.status,
      message: result === 'REMPLACEE'
        ? 'Plaque remplacée : seule la nouvelle plaque de ce bien fait foi.'
        : 'Plaque authentique — bien enregistré au cadastre fiscal de la Ville-Province.',
      notice: 'Vérification publique minimale : aucune donnée personnelle ni situation de paiement n’est affichée (§ 16.8).',
    };
  }

  /** Scan d'un agent habilité : identifiant, localisation, occupation, couleur de situation ; aucun montant. */
  agentScan(user: User, raw: string) {
    const plate = this.findByCode(raw);
    if (!plate) throw notFound('PLATE_NOT_FOUND', 'Plaque inconnue.');
    const obj = this.d.ctx.objects.get(plate.objectId);
    authorize(user, 'fiscal:plate.scan', { communes: [obj.commune] });
    const at = this.d.nowIso();
    this.checks.append({ id: this.ids.next('CHK-PLQ', 8), at, shortCode: plate.shortCode, result: plate.status, channel: 'AGENT', actorId: user.id });
    this.d.ctx.audit.append({ actor: actorOf(user), action: 'object.plate.agent_scan', resourceType: 'fiscal_object', resourceId: obj.id, details: { plateId: plate.id } });
    return {
      nfiu: plate.nfiu, plateStatus: plate.status, objectId: obj.id, category: CATEGORY_LABELS[obj.category] ?? obj.category,
      commune: obj.commune, quartier: obj.quartier, avenue: obj.avenue ?? null, localityRank: obj.localityRank,
      occupancy: occupancyOf(this.d, obj), situation: situationOf(this.d, obj), coverage: coverageOf(this.d, obj, this.relations),
      probativeStatus: obj.probativeStatus, lastObservation: Object.keys(obj.observed).length ? obj.observed : null,
      notice: 'Aucun montant n’est modifiable par l’agent ; aucune négociation, aucune estimation manuelle, aucun encaissement.',
      checkedAt: at,
    };
  }

  /** Arborescence : commune › quartier › avenue › parcelle › bâtiment › unité. */
  tree(obj: FiscalObject) {
    const chain: FiscalObject[] = [];
    let cur: FiscalObject | undefined = obj;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.unshift(cur);
      cur = this.parentOf(cur);
    }
    const root = chain[0]!;
    return {
      geo: this.d.geo.path(root),
      objects: chain.map((o) => ({ id: o.id, category: o.category, label: CATEGORY_LABELS[o.category], igf: o.igf?.code ?? null })),
      children: this.childrenOf(obj).map((o) => ({ id: o.id, category: o.category, label: CATEGORY_LABELS[o.category], igf: o.igf?.code ?? null })),
    };
  }
}
