/**
 * MOSOLO Advertising — KIN PUB CONTROL (§ 11B ; document maître § H.27.6).
 *
 * « Le contrôleur est un collecteur de preuves, l'autorité décide, la technologie trace. »
 * - Inventaire géolocalisé des dispositifs (type, dimensions, faces, éclairage, photos, exploitant) avec identifiant
 *   unique et jeton de plaque QR ; vérification publique minimale (sans nom de l'exploitant).
 * - Demande d'autorisation en ligne (pièces par empreinte) → instruction (R07) → décision motivée par une personne
 *   distincte → liquidation par la règle du registre (ACTIVE seulement ; sinon « acte requis », aucun montant) →
 *   avis au redevable (obligation expliquée) → paiement par le circuit commun.
 * - Inspection par un inspecteur ACCRÉDITÉ : photos, GPS et heure serveur, lecture optique proposée ; constat en AJOUT
 *   SEUL. Dossier : constat → vérification (R09) → décision (R06/R07) → notification → contestation / recours.
 *   Aucune sanction prononcée par l'application ; aucune pénalité sans barème publié.
 */
import { randomBytes } from 'node:crypto';
import { type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { DAY_MS, kinshasaDate } from '../../core/clock.js';
import { dec, decMul, decToString, divideDecimalStrings } from '../../core/decimal.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, assertNotRelated, authorize, evaluate } from '../../core/policy.js';
import { sha256Hex } from '../../core/crypto.js';
import { CLOCK_SKEW_WARN_SECONDS, lowAccuracy, MAX_PHOTO_BYTES, PHOTO_WINDOW_MINUTES } from '../parking/field.js';
import { sampleForCounterCheck } from '../sanctions/service.js';
import { validityView } from '../../core/validity.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { taxpayerRecipient, userRecipient } from '../../modules/identity/recipients.js';
import { isCommune } from '../../reference/kinshasa.js';
import { actorOf, activeRule, DGTK, latestRule, paymentState, pct, perUnit, sumByCurrency } from '../parking/support.js';
import { estimateCommune, isFixedObject } from '../fiscal/nearby.js';

export const AD_TYPES = ['PANNEAU', 'ENSEIGNE', 'ECRAN_NUMERIQUE', 'BACHE', 'BANDEROLE', 'KAKEMONO', 'CHEVALET', 'AFFICHE_MURALE', 'HABILLAGE_VEHICULE', 'AUTRE'] as const;
/**
 * Emplacement du support (réalité de Kinshasa) : support dédié (panneau, écran, bâche, banderole) ; enseigne ou
 * publicité sur la façade / la porte d'un commerce ; publicité posée DEVANT un commerce (chevalet, kakémono) ; publicité
 * MOBILE sur un véhicule ou un autre objet qui se déplace (identifiée par sa plaque). Tous sont assujettis.
 */
export const PLACEMENTS = ['SUPPORT_DEDIE', 'FACADE_COMMERCE', 'DEVANT_COMMERCE', 'VEHICULE'] as const;
export const VEHICLE_KINDS = ['VOITURE', 'TAXI', 'BUS', 'CAMION', 'MOTO', 'TRICYCLE', 'REMORQUE', 'AUTRE'] as const;
/** Règle de la publicité sur véhicule : distincte de la taxe au m² des supports fixes. Tant qu'aucun acte n'est publié : aucun montant. */
export const AD_MOBILE_TAX_RULE = 'DEMO-PUB-MOBILE';
export type Placement = (typeof PLACEMENTS)[number];
export const LIGHTING = ['NON_ECLAIRE', 'ECLAIRE', 'NUMERIQUE'] as const;
export const FINDINGS = ['CONFORME', 'NON_CONFORME', 'NON_DECLARE', 'RETIRE'] as const;
export const PIECE_KINDS = ['PLAN_SITUATION', 'PHOTO_MONTAGE', 'TITRE_OCCUPATION', 'ACCORD_PROPRIETAIRE', 'STATUTS', 'AUTRE'] as const;
/** Préavis d'échéance des autorisations (paramètre de démonstration). */
export const EXPIRY_NOTICE_DAYS = 30;
export const AD_TAX_RULE = 'DEMO-PUB-SURFACE';

export interface AdDevice {
  id: string;
  reference: string;
  qrToken: string;
  type: (typeof AD_TYPES)[number];
  widthM: string;
  heightM: string;
  /** Surface d'une face (m², 2 décimales). */
  surfaceM2: string;
  faces: number;
  lighting: (typeof LIGHTING)[number];
  commune: string;
  quartier: string;
  address: string;
  localityRank: 1 | 2 | 3 | 4;
  lat: number;
  lon: number;
  photos: string[];
  /** Emplacement : support dédié, façade ou porte d'un commerce, devant un commerce, véhicule (mobile). */
  placement: Placement;
  /** Publicité mobile : plaque du véhicule qui la porte (normalisée) et genre de véhicule. */
  vehiclePlate: string | null;
  vehicleKind: (typeof VEHICLE_KINDS)[number] | null;
  /** Enseigne ou publicité d'un commerce : nom affiché et, s'il est connu, objet fiscal « activité / établissement ». */
  businessName: string | null;
  businessObjectId: string | null;
  ownerTaxpayerId: string | null;
  presumedOperator: string | null;
  origin: 'DECLARATION' | 'RECENSEMENT';
  registration: 'DECLARE' | 'NON_DECLARE' | 'RETIRE';
  currentAuthorizationId: string | null;
  objectId: string | null;
  retiredAt?: string;
  demo: boolean;
  createdBy: string;
  createdAt: string;
}

export interface Piece {
  kind: (typeof PIECE_KINDS)[number];
  name: string;
  sha256: string;
  addedAt: string;
}

export interface AuthorizationRequest {
  id: string;
  reference: string;
  deviceId: string;
  taxpayerId: string;
  periodFrom: string;
  periodTo: string;
  pieces: Piece[];
  status: 'DEPOSEE' | 'COMPLEMENT_DEMANDE' | 'PROPOSEE' | 'ACCORDEE' | 'REFUSEE';
  history: { at: string; by: string; action: string; note: string }[];
  instruction?: { by: string; at: string; proposal: 'ACCORDER' | 'REFUSER'; analysis: string };
  decision?: { by: string; at: string; outcome: 'ACCORDEE' | 'REFUSEE'; reason: string };
  liquidation?: { status: 'EMISE' | 'ACTE_REQUIS'; obligationId: string | null; ruleCode: string | null; note: string };
  /**
   * Liquidation différée (autorisation accordée sous « acte requis », barème devenu ACTIF depuis) : proposée par
   * l'instructeur, approuvée par une personne distincte (quatre yeux) qui liquide en son nom.
   */
  liquidationProposal?: { by: string; at: string; note: string; ruleCode: string; ruleVersion: number };
  expiryNoticeAt?: string;
  expiredNoticeAt?: string;
  submittedBy: string;
  submittedAt: string;
}

export interface Accreditation {
  id: string;
  userId: string;
  name: string;
  communes: string[];
  validFrom: string;
  validUntil: string;
  status: 'ACTIVE' | 'REVOQUEE';
  grantedBy: string;
  grantedAt: string;
  revocation?: { by: string; at: string; reason: string };
}

export interface NewDeviceSpec {
  type: AdDevice['type'];
  widthM: string;
  heightM: string;
  faces: number;
  lighting: AdDevice['lighting'];
  commune: string;
  quartier: string;
  address: string;
  localityRank: 1 | 2 | 3 | 4;
  placement?: Placement;
  vehiclePlate?: string;
  vehicleKind?: (typeof VEHICLE_KINDS)[number];
  businessName?: string;
  businessObjectId?: string;
}

export const normalizeAdPlate = (p: string) => p.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Constat d'inspection : AJOUT SEUL (l'inspecteur ne peut ni le modifier ni le supprimer). */
export interface AdInspection {
  id: string;
  reference: string;
  inspectorId: string;
  deviceId: string;
  finding: (typeof FINDINGS)[number];
  photos: string[];
  lat: number;
  lon: number;
  gpsAccuracyM: number | null;
  /** GPS mesuré, point ajusté à la main (MANUEL) ou position de repli (ZONE). */
  gpsSource?: 'GPS' | 'MANUEL' | 'ZONE';
  observedAt: string;
  qrScanned: string | null;
  ocrText: string | null;
  /** Références repérées dans la lecture optique : PROPOSITION, jamais une conclusion. */
  ocrMatches: string[];
  authorizationValidAtInspection: boolean;
  presumedOperator: string | null;
  observations: string;
  caseId: string | null;
  /** Photos conservées au serveur (JPEG reçu, empreinte vérifiée) ; absentes : seules des empreintes déclarées. */
  serverPhotoIds?: string[];
  /** Preuve faible : aucune photo conservée au serveur, ou position imprécise / ajustée à la main. */
  weakEvidence?: boolean;
}

/** Photo de preuve d'une inspection, versée au serveur avant le constat (image conservée, jamais modifiable). */
export interface AdEvidencePhoto {
  id: string;
  sha256: string;
  mime: 'image/jpeg';
  sizeBytes: number;
  dataBase64: string;
  lat: number;
  lon: number;
  accuracyM: number | null;
  gpsSource: 'GPS' | 'MANUEL' | 'ZONE';
  stampedAt: string;
  receivedAt: string;
  clockSkewSeconds: number;
  agentId: string;
  inspectionId: string | null;
}

export type AdPhotoMeta = Omit<AdEvidencePhoto, 'dataBase64'> & { url: string; clockWarning: boolean; lowAccuracy: boolean };

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/** Preuve faible d'une inspection (même règle pour le vérificateur et la surveillance des agents). */
export function inspectionWeakEvidence(i: AdInspection): boolean {
  if (i.weakEvidence !== undefined) return i.weakEvidence;
  return !i.serverPhotoIds?.length || lowAccuracy(i.gpsSource ?? 'GPS', i.gpsAccuracyM);
}

export interface AdCase {
  id: string;
  reference: string;
  inspectionId: string;
  deviceId: string;
  /** Commune du dossier : celle du support ; pour une publicité mobile, celle où l'inspection a eu lieu. */
  commune: string;
  finding: Exclude<AdInspection['finding'], 'CONFORME'>;
  status: 'CONSTATE' | 'VERIFIE' | 'REJETE_QA' | 'RETENU' | 'CLASSE';
  createdAt: string;
  verification?: { by: string; at: string; outcome: 'CONFIRME' | 'REJETE'; note: string };
  decision?: { by: string; at: string; outcome: 'RETENU' | 'CLASSE'; reason: string; effect: string; obligationId: string | null };
  notifiedAt?: string;
  contests: { id: string; by: string; at: string; grounds: string; stage: 'AVANT_DECISION' | 'APRES_DECISION'; appealId?: string }[];
}

const REF_RE = /PUB-[A-Z]{3}-\d{6}/g;
const AUTH_RE = /AUT-PUB-\d{4}-\d{6}/g;

function round2(v: string): string {
  return divideDecimalStrings(v, '1', 2);
}

export class PubliciteService {
  readonly devices = new InMemoryRepository<AdDevice>();
  readonly requests = new InMemoryRepository<AuthorizationRequest>();
  readonly inspections = new InMemoryAppendOnlyRepository<AdInspection>();
  readonly cases = new InMemoryRepository<AdCase>();
  readonly accreditations = new InMemoryRepository<Accreditation>();
  /** Photos de preuve des inspections (images conservées au serveur). */
  readonly photos = new InMemoryRepository<AdEvidencePhoto>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext) {}

  private now(): Date {
    return this.ctx.clock.now();
  }
  private today(): string {
    return kinshasaDate(this.now());
  }

  // ---------------------------------------------------------------- Dispositifs

  private computeSurface(widthM: string, heightM: string): string {
    const w = dec(widthM);
    const h = dec(heightM);
    if (w <= 0n || h <= 0n) throw badRequest('INVALID_DIMENSIONS', 'Largeur et hauteur doivent être strictement positives.');
    return round2(decToString(decMul(w, h)));
  }

  private newDevice(user: User, spec: NewDeviceSpec & { lat: number; lon: number; photos: string[] }, owner: string | null, origin: AdDevice['origin'], extra: { presumedOperator?: string | null; demo?: boolean; id?: string } = {}): AdDevice {
    if (!isCommune(spec.commune)) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${spec.commune}`);
    if (spec.faces < 1 || spec.faces > 4) throw badRequest('INVALID_FACES', 'Nombre de faces : 1 à 4.');
    const surfaceM2 = this.computeSurface(spec.widthM, spec.heightM);
    const placement: Placement = spec.placement ?? (spec.type === 'HABILLAGE_VEHICULE' ? 'VEHICULE' : spec.type === 'ENSEIGNE' ? 'FACADE_COMMERCE' : spec.type === 'CHEVALET' ? 'DEVANT_COMMERCE' : 'SUPPORT_DEDIE');
    const plate = spec.vehiclePlate ? normalizeAdPlate(spec.vehiclePlate) : '';
    if (placement === 'VEHICULE' && plate.length < 4) throw badRequest('VEHICLE_PLATE_REQUIRED', 'Publicité mobile : la plaque du véhicule qui la porte est obligatoire.');
    if (spec.placement && (placement === 'FACADE_COMMERCE' || placement === 'DEVANT_COMMERCE') && !spec.businessName?.trim() && !spec.businessObjectId) {
      throw badRequest('BUSINESS_REQUIRED', 'Enseigne ou publicité de commerce : indiquer le commerce (nom affiché ou établissement enregistré).');
    }
    if (spec.businessObjectId && !this.ctx.objects.objects.get(spec.businessObjectId)) throw badRequest('UNKNOWN_BUSINESS', `Établissement inconnu : ${spec.businessObjectId}`);
    const com = spec.commune.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase();
    const device = this.devices.insert({
      id: extra.id ?? this.ids.next('ADV'),
      reference: this.ids.next(`PUB-${com}`),
      qrToken: randomBytes(12).toString('base64url'),
      type: spec.type, widthM: spec.widthM, heightM: spec.heightM, surfaceM2, faces: spec.faces, lighting: spec.lighting,
      commune: spec.commune, quartier: spec.quartier, address: spec.address, localityRank: spec.localityRank, lat: spec.lat, lon: spec.lon,
      photos: spec.photos, placement, vehiclePlate: placement === 'VEHICULE' ? plate : null, vehicleKind: placement === 'VEHICULE' ? spec.vehicleKind ?? 'AUTRE' : null,
      businessName: spec.businessName?.trim() || null, businessObjectId: spec.businessObjectId ?? null, ownerTaxpayerId: owner, presumedOperator: extra.presumedOperator ?? null, origin,
      registration: origin === 'DECLARATION' ? 'DECLARE' : 'NON_DECLARE', currentAuthorizationId: null, objectId: null,
      demo: extra.demo === true, createdBy: user.id, createdAt: this.now().toISOString(),
    });
    if (owner) this.attachObject(user, device.id);
    this.ctx.audit.append({
      actor: actorOf(user), action: origin === 'DECLARATION' ? 'publicite.device.declared' : 'publicite.device.recorded_by_inspection', resourceType: 'ad_device', resourceId: device.id,
      details: { reference: device.reference, type: device.type, placement, vehiclePlate: device.vehiclePlate, businessObjectId: device.businessObjectId, surfaceM2, faces: device.faces, commune: device.commune, owner: owner !== null },
    });
    return this.devices.get(device.id)!;
  }

  /** Objet fiscal PANNEAU du compte unique (fonde l'attribution à la commune du support, § 20.3). */
  private attachObject(user: User, deviceId: string): AdDevice {
    const d = this.getDevice(deviceId);
    if (d.objectId || !d.ownerTaxpayerId) return d;
    const obj = this.ctx.objects.create(user, {
      taxpayerId: d.ownerTaxpayerId, category: 'PANNEAU', commune: d.commune, quartier: d.quartier, localityRank: d.localityRank, lat: d.lat, lon: d.lon,
      attributes: {
        adDeviceId: d.id, reference: d.reference, type: d.type, surface_m2: d.surfaceM2, faces: d.faces, eclairage: d.lighting, placement: d.placement,
        ...(d.vehiclePlate ? { vehiclePlate: d.vehiclePlate } : {}), ...(d.businessObjectId ? { businessObjectId: d.businessObjectId } : {}),
      },
    });
    return this.devices.update({ ...d, objectId: obj.id });
  }

  declareDevice(user: User, input: NewDeviceSpec & { lat: number; lon: number; photos: string[]; taxpayerId?: string }): AdDevice {
    const taxpayerId = input.taxpayerId ?? user.taxpayerId;
    if (!taxpayerId) throw forbidden('NO_TAXPAYER_ACCOUNT', 'Compte contribuable requis (compte unique MOSOLO).');
    authorize(user, 'publicite:device.declare', { taxpayerId });
    return this.newDevice(user, input, taxpayerId, 'DECLARATION');
  }

  getDevice(id: string): AdDevice {
    const d = this.devices.get(id) ?? this.devices.findOne((x) => x.reference === id);
    if (!d) throw notFound('AD_DEVICE_NOT_FOUND', `Dispositif inconnu : ${id}`);
    return d;
  }

  currentAuthorization(d: AdDevice): AuthorizationRequest | null {
    if (!d.currentAuthorizationId) return null;
    return this.requests.get(d.currentAuthorizationId) ?? null;
  }

  /** Situation calculée : autorisation, échéance, situation des droits (croisement autorisation ↔ obligation ↔ paiement). */
  deviceStatus(d: AdDevice) {
    const today = this.today();
    const auth = this.currentAuthorization(d);
    let status: 'AUTORISE' | 'EXPIRE' | 'DECLARE' | 'NON_DECLARE' | 'RETIRE';
    if (d.registration === 'RETIRE') status = 'RETIRE';
    else if (auth && auth.periodFrom <= today && auth.periodTo >= today) status = 'AUTORISE';
    else if (auth && auth.periodTo < today) status = 'EXPIRE';
    else status = d.registration;
    const expiringSoon = status === 'AUTORISE' && auth !== null && auth.periodTo <= kinshasaDate(new Date(this.now().getTime() + EXPIRY_NOTICE_DAYS * DAY_MS));
    let rights: 'A_JOUR' | 'IMPAYE' | 'ACTE_REQUIS' | 'SANS_OBJET' = 'SANS_OBJET';
    if (auth?.liquidation) {
      if (auth.liquidation.status === 'ACTE_REQUIS') rights = 'ACTE_REQUIS';
      else {
        const p = paymentState(this.ctx, auth.liquidation.obligationId ?? undefined).state;
        rights = p === 'PAYE' || p === 'RAPPROCHE' ? 'A_JOUR' : 'IMPAYE';
      }
    }
    const openCase = this.cases.findOne((c) => c.deviceId === d.id && (c.status === 'CONSTATE' || c.status === 'VERIFIE'));
    return {
      status, expiringSoon, rights, authorization: auth ? { id: auth.id, reference: auth.reference, validFrom: auth.periodFrom, validUntil: auth.periodTo, validity: validityView(auth.periodFrom, auth.periodTo, this.now()) } : null,
      openCase: openCase ? { id: openCase.id, reference: openCase.reference, finding: openCase.finding } : null,
      inspections: this.inspections.find((i) => i.deviceId === d.id).length,
    };
  }

  deviceView(d: AdDevice, opts: { withOwner?: boolean } = {}) {
    const { qrToken, ownerTaxpayerId, presumedOperator, ...rest } = d;
    const owner = ownerTaxpayerId && opts.withOwner ? this.ctx.taxpayers.taxpayers.get(ownerTaxpayerId) : undefined;
    return {
      ...rest,
      ...this.deviceStatus(d),
      qrToken,
      ownerIdentified: ownerTaxpayerId !== null,
      ...(opts.withOwner ? { owner: owner ? { taxpayerId: owner.id, name: owner.fullName } : null, presumedOperator } : {}),
    };
  }

  myDevices(user: User) {
    const taxpayerId = user.taxpayerId;
    if (!taxpayerId) throw forbidden('NO_TAXPAYER_ACCOUNT', 'Compte contribuable requis.');
    authorize(user, 'publicite:device.read', { taxpayerId });
    this.tick();
    return this.devices.find((d) => d.ownerTaxpayerId === taxpayerId).map((d) => this.deviceView(d, { withOwner: true }));
  }

  readDevice(user: User, id: string) {
    const d = this.getDevice(id);
    authorize(user, 'publicite:device.read', { taxpayerId: d.ownerTaxpayerId ?? undefined, communes: [d.commune], entity: DGTK });
    const inspections = this.inspections.find((i) => i.deviceId === d.id);
    const cases = this.cases.find((c) => c.deviceId === d.id);
    const requests = this.requests.find((r) => r.deviceId === d.id);
    return { device: this.deviceView(d, { withOwner: true }), requests: requests.map((r) => this.requestView(r)), inspections, cases: cases.map((c) => this.caseView(c)) };
  }

  /** Inventaire et carte (agents habilités). */
  inventory(user: User, filter: { commune?: string; status?: string } = {}) {
    authorize(user, 'publicite:inventory', { entity: DGTK });
    this.tick();
    return this.devices
      .all()
      .filter((d) => !filter.commune || d.commune === filter.commune)
      .map((d) => this.deviceView(d, { withOwner: true }))
      .filter((d) => !filter.status || d.status === filter.status)
      .sort((a, b) => a.reference.localeCompare(b.reference));
  }

  /** Vérification publique par la plaque QR : situation minimale, jamais le nom de l'exploitant. */
  publicCheck(token: string) {
    const d = this.devices.findOne((x) => x.qrToken === token);
    if (!d) throw notFound('AD_PLATE_UNKNOWN', 'Plaque inconnue : un support sans plaque valide est présumé non enregistré.');
    const st = this.deviceStatus(d);
    return {
      reference: d.reference, type: d.type, commune: d.commune, surfaceM2: d.surfaceM2, faces: d.faces,
      status: st.status, authorized: st.status === 'AUTORISE', validFrom: st.authorization?.validFrom ?? null, validUntil: st.authorization?.validUntil ?? null,
      validity: st.authorization && st.status !== 'RETIRE' ? st.authorization.validity : null,
      notice: 'Vérification publique : aucune donnée nominative. Signalement possible auprès de la régie.',
    };
  }

  /** Recherche de l'autorisation correspondante (référence, jeton QR, référence d'autorisation, texte lu par OCR). */
  lookup(user: User, q: string) {
    authorize(user, 'publicite:inventory', { entity: DGTK });
    const text = q.trim().toUpperCase();
    const refs = new Set([...text.matchAll(REF_RE)].map((m) => m[0]));
    const auths = new Set([...text.matchAll(AUTH_RE)].map((m) => m[0]));
    const found = new Map<string, AdDevice>();
    for (const d of this.devices.all()) {
      if (refs.has(d.reference) || d.qrToken === q.trim() || d.reference === text) found.set(d.id, d);
      if (d.vehiclePlate && normalizeAdPlate(text).includes(d.vehiclePlate)) found.set(d.id, d);
    }
    for (const r of this.requests.all()) if (auths.has(r.reference)) found.set(r.deviceId, this.getDevice(r.deviceId));
    return {
      query: q, detected: { deviceReferences: [...refs], authorizationReferences: [...auths] },
      matches: [...found.values()].map((d) => {
        const st = this.deviceStatus(d);
        return { id: d.id, reference: d.reference, type: d.type, placement: d.placement, vehiclePlate: d.vehiclePlate, businessName: d.businessName, commune: d.commune, address: d.address, status: st.status, authorization: st.authorization, rights: st.rights };
      }),
      notice: 'Résultat proposé par recherche automatique : l’inspecteur confirme sur place.',
    };
  }

  // ---------------------------------------------------------------- Autorisations

  submitRequest(user: User, input: { deviceId: string; periodFrom: string; periodTo: string; pieces: Omit<Piece, 'addedAt'>[] }) {
    const d = this.getDevice(input.deviceId);
    if (!d.ownerTaxpayerId) throw unprocessable('DEVICE_OWNER_UNKNOWN', 'Exploitant non identifié : rattachement préalable requis.');
    authorize(user, 'publicite:authorization.request', { taxpayerId: d.ownerTaxpayerId });
    if (d.registration === 'RETIRE') throw unprocessable('DEVICE_RETIRED', 'Dispositif retiré.');
    if (input.periodTo <= input.periodFrom) throw badRequest('INVALID_PERIOD', 'La fin de validité doit suivre le début.');
    if (new Date(input.periodTo).getTime() - new Date(input.periodFrom).getTime() > 366 * DAY_MS) throw badRequest('PERIOD_TOO_LONG', 'Autorisation annuelle : 366 jours au plus.');
    if (input.pieces.length === 0) throw badRequest('PIECES_REQUIRED', 'Au moins une pièce justificative est requise.');
    const open = this.requests.findOne((r) => r.deviceId === d.id && ['DEPOSEE', 'COMPLEMENT_DEMANDE', 'PROPOSEE'].includes(r.status));
    if (open) throw conflict('REQUEST_ALREADY_OPEN', `Une demande est déjà en cours (${open.reference}).`, { requestId: open.id });
    const now = this.now().toISOString();
    const r = this.requests.insert({
      id: this.ids.next('ADR'), reference: this.ids.next(`AUT-PUB-${this.now().getUTCFullYear()}`), deviceId: d.id, taxpayerId: d.ownerTaxpayerId,
      periodFrom: input.periodFrom, periodTo: input.periodTo, pieces: input.pieces.map((p) => ({ ...p, addedAt: now })), status: 'DEPOSEE',
      history: [{ at: now, by: user.id, action: 'DEPOT', note: `${input.pieces.length} pièce(s)` }], submittedBy: user.id, submittedAt: now,
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'publicite.authorization.requested', resourceType: 'ad_authorization', resourceId: r.id, details: { deviceId: d.id, periodFrom: r.periodFrom, periodTo: r.periodTo, pieces: r.pieces.map((p) => p.sha256) } });
    this.ctx.comms.publish('permit.application.received', [taxpayerRecipient(this.ctx.taxpayers.get(d.ownerTaxpayerId))], { reference: r.reference }, { entity: DGTK });
    return this.requestView(r);
  }

  private getRequest(id: string): AuthorizationRequest {
    const r = this.requests.get(id) ?? this.requests.findOne((x) => x.reference === id);
    if (!r) throw notFound('AD_REQUEST_NOT_FOUND', `Demande inconnue : ${id}`);
    return r;
  }

  /** Complément apporté par le demandeur. */
  addPieces(user: User, id: string, input: { pieces: Omit<Piece, 'addedAt'>[]; message: string }) {
    const r = this.getRequest(id);
    authorize(user, 'publicite:authorization.request', { taxpayerId: r.taxpayerId });
    if (r.status !== 'COMPLEMENT_DEMANDE' && r.status !== 'DEPOSEE') throw conflict('REQUEST_NOT_OPEN_FOR_PIECES', `Demande au statut ${r.status}.`);
    const now = this.now().toISOString();
    const updated = this.requests.update({
      ...r, status: 'DEPOSEE', pieces: [...r.pieces, ...input.pieces.map((p) => ({ ...p, addedAt: now }))],
      history: [...r.history, { at: now, by: user.id, action: 'COMPLEMENT_FOURNI', note: input.message }],
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'publicite.authorization.pieces_added', resourceType: 'ad_authorization', resourceId: r.id, details: { pieces: input.pieces.map((p) => p.sha256) } });
    return this.requestView(updated);
  }

  instruct(user: User, id: string, input: { action: 'COMPLEMENT' | 'PROPOSER'; analysis: string; proposal?: 'ACCORDER' | 'REFUSER' }) {
    const r = this.getRequest(id);
    authorize(user, 'publicite:authorization.instruct', { entity: DGTK });
    if (r.status !== 'DEPOSEE') throw conflict('REQUEST_NOT_INSTRUCTABLE', `Instruction impossible au statut ${r.status}.`);
    const now = this.now().toISOString();
    let updated: AuthorizationRequest;
    if (input.action === 'COMPLEMENT') {
      updated = this.requests.update({ ...r, status: 'COMPLEMENT_DEMANDE', history: [...r.history, { at: now, by: user.id, action: 'COMPLEMENT_DEMANDE', note: input.analysis }] });
      this.ctx.comms.publish('appeal.info_requested', [taxpayerRecipient(this.ctx.taxpayers.get(r.taxpayerId))], { reference: r.reference }, { entity: DGTK });
    } else {
      if (!input.proposal) throw badRequest('PROPOSAL_REQUIRED', 'Proposition (ACCORDER ou REFUSER) requise.');
      updated = this.requests.update({
        ...r, status: 'PROPOSEE', instruction: { by: user.id, at: now, proposal: input.proposal, analysis: input.analysis },
        history: [...r.history, { at: now, by: user.id, action: `PROPOSITION_${input.proposal}`, note: input.analysis }],
      });
    }
    this.ctx.audit.append({ actor: actorOf(user), action: `publicite.authorization.${input.action === 'COMPLEMENT' ? 'complement_requested' : 'proposed'}`, resourceType: 'ad_authorization', resourceId: r.id, details: { analysis: input.analysis, proposal: input.proposal ?? null } });
    return this.requestView(updated);
  }

  /** Liquidation par la règle du registre (ACTIVE seulement), au nom de la personne qui décide. */
  private liquidateDevice(user: User, d: AdDevice): NonNullable<AuthorizationRequest['liquidation']> {
    // Publicité mobile : règle propre (jamais la taxe au m² d'un support fixe) ; tant qu'elle n'est pas publiée, aucun montant.
    if (d.placement === 'VEHICULE') {
      const mobile = activeRule(this.ctx, AD_MOBILE_TAX_RULE);
      if (!mobile) return { status: 'ACTE_REQUIS', obligationId: null, ruleCode: AD_MOBILE_TAX_RULE, note: 'Barème de la publicité sur véhicule non publié (acte requis) : aucun montant exigible.' };
      const withObj = this.attachObject(user, d.id);
      const { obligation } = this.ctx.assessment.calculate(user, {
        ruleId: mobile.id, taxpayerId: withObj.ownerTaxpayerId!, objectId: withObj.objectId!,
        inputs: { surface_m2: withObj.surfaceM2, faces: String(withObj.faces) }, simulate: false,
      });
      return { status: 'EMISE', obligationId: obligation!.id, ruleCode: mobile.code, note: `${mobile.label} (v${mobile.version})` };
    }
    const rule = activeRule(this.ctx, AD_TAX_RULE);
    if (!rule) {
      return { status: 'ACTE_REQUIS', obligationId: null, ruleCode: AD_TAX_RULE, note: 'Barème de la taxe non publié (acte requis) : aucun montant exigible.' };
    }
    const withObj = this.attachObject(user, d.id);
    const { obligation } = this.ctx.assessment.calculate(user, {
      ruleId: rule.id, taxpayerId: withObj.ownerTaxpayerId!, objectId: withObj.objectId!,
      inputs: { surface_m2: withObj.surfaceM2, faces: String(withObj.faces), eclaire: withObj.lighting === 'NON_ECLAIRE' ? '0' : '1' }, simulate: false,
    });
    return { status: 'EMISE', obligationId: obligation!.id, ruleCode: rule.code, note: `${rule.label} (v${rule.version})` };
  }

  decideRequest(user: User, id: string, input: { outcome: 'ACCORDEE' | 'REFUSEE'; reason: string }) {
    const r = this.getRequest(id);
    authorize(user, 'publicite:authorization.decide', { entity: DGTK });
    if (r.status !== 'PROPOSEE') throw conflict('REQUEST_NOT_PROPOSED', `Décision impossible au statut ${r.status} (instruction préalable requise).`);
    assertDistinctPerson(user.id, [r.instruction!.by, r.submittedBy], 'L’instructeur ne peut pas décider de la demande qu’il a instruite.');
    const d = this.getDevice(r.deviceId);
    const now = this.now().toISOString();
    let updated: AuthorizationRequest = {
      ...r, status: input.outcome, decision: { by: user.id, at: now, outcome: input.outcome, reason: input.reason },
      history: [...r.history, { at: now, by: user.id, action: `DECISION_${input.outcome}`, note: input.reason }],
    };
    if (input.outcome === 'ACCORDEE') {
      updated = { ...updated, liquidation: this.liquidateDevice(user, d) };
      this.devices.update({ ...this.getDevice(d.id), registration: 'DECLARE', currentAuthorizationId: r.id });
    }
    this.requests.update(updated);
    this.ctx.audit.append({
      actor: actorOf(user), action: input.outcome === 'ACCORDEE' ? 'publicite.authorization.granted' : 'publicite.authorization.refused', resourceType: 'ad_authorization', resourceId: r.id,
      details: { reason: input.reason, liquidation: updated.liquidation ?? null },
    });
    this.ctx.comms.publish(input.outcome === 'ACCORDEE' ? 'permit.issued' : 'permit.refused', [taxpayerRecipient(this.ctx.taxpayers.get(r.taxpayerId))], { reference: r.reference }, { entity: DGTK });
    return this.requestView(updated);
  }

  /** Barème applicable au support (publicité mobile ou taxe au m²) ACTIF ? */
  private taxRuleActive(d: AdDevice): boolean {
    return !!activeRule(this.ctx, d.placement === 'VEHICULE' ? AD_MOBILE_TAX_RULE : AD_TAX_RULE);
  }

  /**
   * File des autorisations accordées sous « acte requis » dont le barème est désormais ACTIF : droits à liquider
   * (proposition de l'instructeur, approbation par une personne distincte).
   */
  pendingLiquidations(user: User) {
    if (!evaluate(user, 'publicite:liquidation.propose', { entity: DGTK })) authorize(user, 'publicite:liquidation.approve', { entity: DGTK });
    return this.requests
      .find((r) => r.status === 'ACCORDEE' && r.liquidation?.status === 'ACTE_REQUIS')
      .filter((r) => { const d = this.devices.get(r.deviceId); return !!d && d.registration !== 'RETIRE' && this.taxRuleActive(d); })
      .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
      .map((r) => this.requestView(r));
  }

  private pendingLiquidation(id: string): { r: AuthorizationRequest; d: AdDevice } {
    const r = this.getRequest(id);
    if (r.status !== 'ACCORDEE' || r.liquidation?.status !== 'ACTE_REQUIS') throw conflict('NOTHING_TO_LIQUIDATE', 'Aucune liquidation en attente d’acte pour cette autorisation.');
    const d = this.getDevice(r.deviceId);
    if (d.registration === 'RETIRE') throw conflict('DEVICE_RETIRED', 'Dispositif retiré : plus aucun droit ne court.');
    if (!this.taxRuleActive(d)) throw unprocessable('RULE_NOT_ACTIVE', 'Barème toujours non publié (acte requis) : aucune liquidation possible.');
    return { r, d };
  }

  /** Proposition de liquidation différée (instructeur, R07). */
  proposeLiquidation(user: User, id: string, note: string) {
    authorize(user, 'publicite:liquidation.propose', { entity: DGTK });
    const { r, d } = this.pendingLiquidation(id);
    assertNotRelated(user, r.taxpayerId, 'Conflit d’intérêts : vous êtes lié au redevable ; la proposition revient à un autre instructeur.');
    const rule = activeRule(this.ctx, d.placement === 'VEHICULE' ? AD_MOBILE_TAX_RULE : AD_TAX_RULE)!;
    const at = this.now().toISOString();
    const updated = this.requests.update({
      ...r, liquidationProposal: { by: user.id, at, note, ruleCode: rule.code, ruleVersion: rule.version },
      history: [...r.history, { at, by: user.id, action: 'LIQUIDATION_PROPOSEE', note }],
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'publicite.liquidation.proposed', resourceType: 'ad_authorization', resourceId: r.id, details: { ruleCode: rule.code, ruleVersion: rule.version, note } });
    return this.requestView(updated);
  }

  /** Approbation (quatre yeux) : personne distincte du proposant ; liquidation par la règle ACTIVE, au nom de l'approbateur. */
  approveLiquidation(user: User, id: string, reason: string) {
    authorize(user, 'publicite:liquidation.approve', { entity: DGTK });
    const { r, d } = this.pendingLiquidation(id);
    if (!r.liquidationProposal) throw conflict('LIQUIDATION_NOT_PROPOSED', 'Proposition de liquidation préalable requise (quatre yeux).');
    assertDistinctPerson(user.id, [r.liquidationProposal.by], 'Proposition et approbation de la liquidation : deux personnes distinctes sont exigées.');
    assertNotRelated(user, r.taxpayerId, 'Conflit d’intérêts : vous êtes lié au redevable ; l’approbation revient à une autre personne habilitée.');
    const liquidation = this.liquidateDevice(user, d);
    const at = this.now().toISOString();
    const updated = this.requests.update({ ...r, liquidation, history: [...r.history, { at, by: user.id, action: 'LIQUIDATION_APPROUVEE', note: reason }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'publicite.liquidation.approved', resourceType: 'ad_authorization', resourceId: r.id, details: { reason, liquidation, proposedBy: r.liquidationProposal.by } });
    if (liquidation.obligationId) this.ctx.comms.publish('permit.issued', [taxpayerRecipient(this.ctx.taxpayers.get(r.taxpayerId))], { reference: r.reference }, { entity: DGTK });
    return this.requestView(updated);
  }

  requestView(r: AuthorizationRequest) {
    const d = this.devices.get(r.deviceId);
    const ob = r.liquidation?.obligationId ? this.ctx.assessment.get(r.liquidation.obligationId) : null;
    return {
      ...r,
      device: d ? { id: d.id, reference: d.reference, type: d.type, commune: d.commune, surfaceM2: d.surfaceM2, faces: d.faces } : null,
      obligation: ob ? noticeOf(ob, paymentState(this.ctx, ob.id).state) : null,
    };
  }

  myRequests(user: User) {
    if (!user.taxpayerId) throw forbidden('NO_TAXPAYER_ACCOUNT', 'Compte contribuable requis.');
    authorize(user, 'publicite:authorization.request', { taxpayerId: user.taxpayerId });
    return this.requests.find((r) => r.taxpayerId === user.taxpayerId).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)).map((r) => this.requestView(r));
  }

  listRequests(user: User) {
    if (!evaluate(user, 'publicite:authorization.instruct', { entity: DGTK })) authorize(user, 'publicite:authorization.decide', { entity: DGTK });
    return this.requests.all().sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)).map((r) => this.requestView(r));
  }

  /** Obligations et avis du redevable (autorisations et régularisations de ses dispositifs). */
  myObligations(user: User) {
    if (!user.taxpayerId) throw forbidden('NO_TAXPAYER_ACCOUNT', 'Compte contribuable requis.');
    authorize(user, 'publicite:device.read', { taxpayerId: user.taxpayerId });
    const mine = new Set(this.devices.find((d) => d.ownerTaxpayerId === user.taxpayerId).map((d) => d.id));
    const out: ReturnType<typeof noticeOf>[] = [];
    for (const r of this.requests.find((x) => mine.has(x.deviceId) && !!x.liquidation?.obligationId)) {
      const ob = this.ctx.assessment.get(r.liquidation!.obligationId!);
      out.push({ ...noticeOf(ob, paymentState(this.ctx, ob.id).state), source: `Autorisation ${r.reference}` });
    }
    for (const c of this.cases.find((x) => mine.has(x.deviceId) && !!x.decision?.obligationId)) {
      const ob = this.ctx.assessment.get(c.decision!.obligationId!);
      out.push({ ...noticeOf(ob, paymentState(this.ctx, ob.id).state), source: `Dossier ${c.reference}` });
    }
    return out;
  }

  // ---------------------------------------------------------------- Accréditations

  grantAccreditation(user: User, input: { userId: string; communes: string[]; validFrom: string; validUntil: string }) {
    authorize(user, 'publicite:accreditation.manage', { entity: DGTK });
    const target = this.ctx.users.get(input.userId);
    if (!target || !target.roles.includes('R11')) throw unprocessable('NOT_AN_INSPECTOR', 'Seul un contrôleur (R11) peut être accrédité.');
    for (const c of input.communes) if (!isCommune(c)) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${c}`);
    if (input.validUntil < input.validFrom) throw badRequest('INVALID_PERIOD', 'Période d’accréditation invalide.');
    const existing = this.accreditations.get(input.userId);
    const acc: Accreditation = {
      id: input.userId, userId: input.userId, name: target.name, communes: input.communes, validFrom: input.validFrom, validUntil: input.validUntil,
      status: 'ACTIVE', grantedBy: user.id, grantedAt: this.now().toISOString(),
    };
    const saved = existing ? this.accreditations.update(acc) : this.accreditations.insert(acc);
    this.ctx.audit.append({ actor: actorOf(user), action: 'publicite.accreditation.granted', resourceType: 'accreditation', resourceId: saved.id, details: { communes: saved.communes, validUntil: saved.validUntil } });
    return saved;
  }

  revokeAccreditation(user: User, userId: string, reason: string) {
    authorize(user, 'publicite:accreditation.manage', { entity: DGTK });
    const a = this.accreditations.get(userId);
    if (!a) throw notFound('ACCREDITATION_NOT_FOUND', `Aucune accréditation pour ${userId}.`);
    const saved = this.accreditations.update({ ...a, status: 'REVOQUEE', revocation: { by: user.id, at: this.now().toISOString(), reason } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'publicite.accreditation.revoked', resourceType: 'accreditation', resourceId: userId, details: { reason } });
    return saved;
  }

  listAccreditations(user: User) {
    authorize(user, 'publicite:inventory', { entity: DGTK });
    return this.accreditations.all().map((a) => ({ ...a, valid: this.accreditationValid(a) }));
  }

  private accreditationValid(a: Accreditation | undefined, commune?: string): boolean {
    if (!a || a.status !== 'ACTIVE') return false;
    const t = this.today();
    return a.validFrom <= t && a.validUntil >= t && (!commune || a.communes.includes(commune));
  }

  /** Badge vérifiable par les exploitants contre les faux contrôleurs (public). */
  publicBadge(userId: string) {
    const a = this.accreditations.get(userId);
    return { badge: userId, name: a?.name ?? null, accredited: this.accreditationValid(a), validFrom: a?.validFrom ?? null, validUntil: a?.validUntil ?? null, validity: a && a.status === 'ACTIVE' ? validityView(a.validFrom, a.validUntil, this.now()) : null, communes: a?.communes ?? [], status: a?.status ?? 'INCONNU' };
  }

  // ---------------------------------------------------------------- Inspections et dossiers de constat

  inspect(user: User, input: {
    deviceId?: string; newDevice?: NewDeviceSpec; finding: AdInspection['finding']; photos: string[]; lat: number; lon: number; gpsAccuracyM?: number; gpsSource?: 'GPS' | 'MANUEL' | 'ZONE';
    qrScanned?: string; ocrText?: string; presumedOperator?: string; observations: string;
  }) {
    let device = input.deviceId ? this.getDevice(input.deviceId) : input.qrScanned ? this.devices.findOne((d) => d.qrToken === input.qrScanned) ?? null : null;
    // Publicité mobile : le véhicule circule dans toute la ville ; l'inspection relève de la commune où se trouve
    // l'inspecteur (position de l'inspection), non de la commune déclarée du support.
    const newType = input.newDevice?.type;
    const mobile = (device?.placement ?? input.newDevice?.placement ?? (newType === 'HABILLAGE_VEHICULE' ? 'VEHICULE' : null)) === 'VEHICULE';
    const commune = mobile ? adCommuneAt(this.ctx, this, { lat: input.lat, lon: input.lon }).commune : device?.commune ?? input.newDevice?.commune ?? '';
    authorize(user, 'publicite:inspection.create', { communes: [commune] });
    const acc = this.accreditations.get(user.id);
    if (!this.accreditationValid(acc, commune)) {
      this.ctx.audit.append({ actor: actorOf(user), action: 'publicite.inspection.refused', resourceType: 'accreditation', resourceId: user.id, outcome: 'DENIED', details: { reason: 'NOT_ACCREDITED', commune } });
      throw forbidden('NOT_ACCREDITED', 'Inspecteur non accrédité (ou accréditation expirée, révoquée ou hors périmètre) : aucun constat possible.');
    }
    if (input.photos.length === 0) throw badRequest('PHOTO_REQUIRED', 'Constat photographique : au moins une photographie (empreinte SHA-256) est exigée.');
    // Photos versées au serveur par l'inspecteur (récentes, non encore jointes) : seules elles font une preuve forte.
    const serverPhotos = this.claimPhotos(user, input.photos);
    if (!device) {
      if (input.finding !== 'NON_DECLARE' || !input.newDevice) {
        throw badRequest('DEVICE_REQUIRED', 'Dispositif inconnu : seul un constat « non déclaré » avec description du support peut l’enregistrer.');
      }
      device = this.newDevice(user, { ...input.newDevice, lat: input.lat, lon: input.lon, photos: input.photos }, null, 'RECENSEMENT', { presumedOperator: input.presumedOperator ?? null });
    }
    const st = this.deviceStatus(device);
    if (input.finding === 'NON_DECLARE' && (st.status === 'AUTORISE' || device.registration === 'DECLARE') && device.origin === 'DECLARATION') {
      throw unprocessable('DEVICE_ALREADY_DECLARED', `Le dispositif ${device.reference} est déclaré (${st.status}) : choisir « non conforme » si l’écart porte sur le support.`);
    }
    const ocr = (input.ocrText ?? '').toUpperCase();
    const ocrMatches = [...new Set([...ocr.matchAll(REF_RE), ...ocr.matchAll(AUTH_RE)].map((m) => m[0]))];
    const now = this.now();
    const inspectionId = this.ids.next('ADI');
    let caseId: string | null = null;
    if (input.finding !== 'CONFORME') {
      caseId = this.ids.next('ADC');
      this.cases.insert({
        id: caseId, reference: this.ids.next(`DOS-PUB-${now.getUTCFullYear()}`), inspectionId, deviceId: device.id, commune: mobile ? commune : device.commune,
        finding: input.finding, status: 'CONSTATE', createdAt: now.toISOString(), contests: [],
      });
    }
    const insp = this.inspections.append({
      id: inspectionId, reference: this.ids.next(`CST-PUB-${now.getUTCFullYear()}`), inspectorId: user.id, deviceId: device.id, finding: input.finding,
      photos: input.photos, lat: input.lat, lon: input.lon, gpsAccuracyM: input.gpsAccuracyM ?? null, gpsSource: input.gpsSource ?? 'GPS', observedAt: now.toISOString(),
      qrScanned: input.qrScanned ?? null, ocrText: input.ocrText ?? null, ocrMatches, authorizationValidAtInspection: st.status === 'AUTORISE',
      presumedOperator: input.presumedOperator ?? null, observations: input.observations, caseId,
      serverPhotoIds: serverPhotos.map((p) => p.id),
      weakEvidence: serverPhotos.length === 0 || lowAccuracy(input.gpsSource ?? 'GPS', input.gpsAccuracyM ?? null),
    });
    for (const p of serverPhotos) this.photos.update({ ...p, inspectionId: insp.id });
    this.ctx.audit.append({
      actor: actorOf(user), action: 'publicite.inspection.recorded', resourceType: 'ad_inspection', resourceId: insp.id,
      details: { deviceId: device.id, finding: insp.finding, photos: insp.photos, serverPhotos: serverPhotos.length, weakEvidence: insp.weakEvidence, lat: insp.lat, lon: insp.lon, caseId },
    });
    return { inspection: insp, device: this.deviceView(this.getDevice(device.id), { withOwner: true }), case: caseId ? this.caseView(this.cases.get(caseId)!) : null };
  }

  // ---------------------------------------------------------------- Photos de preuve (conservées au serveur)

  photoMeta(p: AdEvidencePhoto): AdPhotoMeta {
    const { dataBase64: _omit, ...rest } = p;
    return { ...rest, url: `/v1/publicite/evidence-photos/${p.id}`, clockWarning: p.clockSkewSeconds > CLOCK_SKEW_WARN_SECONDS, lowAccuracy: lowAccuracy(p.gpsSource, p.accuracyM) };
  }

  /**
   * Versement d'une photo par l'inspecteur accrédité, avant le constat : JPEG, empreinte SHA-256 recalculée et
   * comparée, image conservée telle que reçue ; une même image ne sert jamais deux fois. Le constat la cite par son
   * empreinte (champ `photos`).
   */
  uploadPhoto(user: User, input: { imageBase64: string; sha256: string; lat: number; lon: number; accuracyM?: number; gpsSource: 'GPS' | 'MANUEL' | 'ZONE'; stampedAt: string }): AdPhotoMeta {
    authorize(user, 'publicite:inspection.create', { communes: user.territory ?? [] });
    const acc = this.accreditations.get(user.id);
    if (!this.accreditationValid(acc)) throw forbidden('NOT_ACCREDITED', 'Inspecteur non accrédité (ou accréditation expirée ou révoquée).');
    const buf = Buffer.from(input.imageBase64, 'base64');
    if (buf.length === 0 || buf.length > MAX_PHOTO_BYTES) throw badRequest('PHOTO_SIZE', `Photo vide ou trop lourde (${Math.round(MAX_PHOTO_BYTES / 1000)} Ko au plus).`);
    if (!buf.subarray(0, 3).equals(JPEG_MAGIC)) throw badRequest('PHOTO_FORMAT', 'Photo JPEG attendue.');
    const sha = sha256Hex(buf);
    if (sha !== input.sha256.toLowerCase()) throw unprocessable('PHOTO_HASH_MISMATCH', 'Empreinte SHA-256 différente de l’image reçue : photo altérée en transit.');
    if (this.photos.findOne((p) => p.sha256 === sha)) throw conflict('PHOTO_DUPLICATE', 'Cette photo a déjà été versée (une même image ne peut pas servir deux fois).');
    const now = this.now();
    const skew = Math.round(Math.abs(now.getTime() - Date.parse(input.stampedAt)) / 1000);
    const photo = this.photos.insert({
      id: this.ids.next('ADP'), sha256: sha, mime: 'image/jpeg', sizeBytes: buf.length, dataBase64: buf.toString('base64'),
      lat: input.lat, lon: input.lon, accuracyM: input.accuracyM ?? null, gpsSource: input.gpsSource, stampedAt: input.stampedAt, receivedAt: now.toISOString(),
      clockSkewSeconds: Number.isFinite(skew) ? skew : 999_999, agentId: user.id, inspectionId: null,
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'publicite.evidence.photo.received', resourceType: 'ad_evidence_photo', resourceId: photo.id, details: { sha256: sha, bytes: buf.length, gpsSource: input.gpsSource } });
    return this.photoMeta(photo);
  }

  /** Photos du serveur citées par empreinte : même inspecteur, non jointes, versées depuis moins de 30 minutes. */
  private claimPhotos(user: User, hashes: string[]): AdEvidencePhoto[] {
    const now = this.now().getTime();
    const wanted = new Set(hashes.map((h) => h.toLowerCase()));
    return this.photos.find((p) => wanted.has(p.sha256) && p.agentId === user.id && p.inspectionId === null && now - Date.parse(p.receivedAt) <= PHOTO_WINDOW_MINUTES * 60_000);
  }

  /** Lecture d'une photo : son auteur ; une fois jointe, les lecteurs du support (vérificateur, régie, exploitant). */
  readPhoto(user: User, id: string): { mime: string; data: Buffer; sha256: string } {
    const p = this.photos.get(id);
    if (!p) throw notFound('PHOTO_NOT_FOUND', 'Photo inconnue.');
    if (p.agentId !== user.id) {
      const insp = p.inspectionId ? this.inspections.get(p.inspectionId) : undefined;
      const d = insp ? this.devices.get(insp.deviceId) : undefined;
      if (!insp || !d) throw forbidden('FORBIDDEN', 'Photo non encore jointe à une inspection : visible de son auteur seulement.');
      authorize(user, 'publicite:device.read', { taxpayerId: d.ownerTaxpayerId ?? undefined, communes: [d.commune], entity: DGTK });
    }
    this.ctx.audit.append({ actor: actorOf(user), action: 'publicite.evidence.photo.viewed', resourceType: 'ad_evidence_photo', resourceId: id, details: { inspectionId: p.inspectionId } });
    return { mime: p.mime, data: Buffer.from(p.dataBase64, 'base64'), sha256: p.sha256 };
  }

  /** Exploitant (bénéficiaire) du support d'un dossier : contrôle du conflit d'intérêts. */
  private beneficiaryOf(c: AdCase): string | null {
    return this.devices.get(c.deviceId)?.ownerTaxpayerId ?? null;
  }

  private getCase(id: string): AdCase {
    const c = this.cases.get(id) ?? this.cases.findOne((x) => x.reference === id);
    if (!c) throw notFound('AD_CASE_NOT_FOUND', `Dossier inconnu : ${id}`);
    return c;
  }

  verifyCase(user: User, id: string, input: { confirm: boolean; note: string }) {
    const c = this.getCase(id);
    authorize(user, 'publicite:case.verify', { communes: [c.commune] });
    if (c.status !== 'CONSTATE') throw conflict('CASE_NOT_PENDING_VERIFICATION', `Dossier au statut ${c.status}.`);
    const insp = this.inspections.get(c.inspectionId)!;
    assertDistinctPerson(user.id, [insp.inspectorId], 'Le vérificateur doit être distinct de l’inspecteur auteur du constat.');
    assertNotRelated(user, this.beneficiaryOf(c), 'Conflit d’intérêts : vous êtes lié à l’exploitant du support ; la vérification revient à un autre superviseur.');
    const updated = this.cases.update({ ...c, status: input.confirm ? 'VERIFIE' : 'REJETE_QA', verification: { by: user.id, at: this.now().toISOString(), outcome: input.confirm ? 'CONFIRME' : 'REJETE', note: input.note } });
    this.ctx.audit.append({ actor: actorOf(user), action: input.confirm ? 'publicite.case.verified' : 'publicite.case.rejected_qa', resourceType: 'ad_case', resourceId: c.id, details: { note: input.note } });
    if (!input.confirm) {
      const inspector = this.ctx.users.get(insp.inspectorId);
      if (inspector) this.ctx.comms.publish('inspection.qa.rejected', [userRecipient(inspector)], { reference: c.reference }, { entity: DGTK });
    }
    return this.caseView(updated);
  }

  /**
   * Décision motivée de l'autorité (personne distincte de l'inspecteur et du vérificateur). Effets limités :
   * enregistrement au registre, rattachement de l'exploitant, constat de retrait, liquidation des DROITS par la règle
   * ACTIVE si demandée. Aucune pénalité : aucun barème publié (acte requis).
   */
  decideCase(user: User, id: string, input: { outcome: 'RETENU' | 'CLASSE'; reason: string; ownerTaxpayerId?: string; liquidateDues?: boolean }) {
    const c = this.getCase(id);
    authorize(user, 'publicite:case.decide', { entity: DGTK });
    if (c.status !== 'VERIFIE') throw conflict('CASE_NOT_VERIFIED', `Décision impossible : dossier au statut ${c.status} (vérification préalable requise).`);
    const insp = this.inspections.get(c.inspectionId)!;
    assertDistinctPerson(user.id, [insp.inspectorId, c.verification!.by], 'Constat, vérification et décision : trois personnes distinctes sont exigées.');
    assertNotRelated(user, this.beneficiaryOf(c), 'Conflit d’intérêts : vous êtes lié à l’exploitant du support ; la décision revient à une autre personne habilitée.');
    assertNotRelated(user, input.ownerTaxpayerId, 'Conflit d’intérêts : vous êtes lié à l’exploitant à rattacher ; la décision revient à une autre personne habilitée.');
    let d = this.getDevice(c.deviceId);
    const effects: string[] = [];
    let obligationId: string | null = null;
    if (input.outcome === 'RETENU') {
      if (input.ownerTaxpayerId && !d.ownerTaxpayerId) {
        this.ctx.taxpayers.get(input.ownerTaxpayerId);
        d = this.devices.update({ ...d, ownerTaxpayerId: input.ownerTaxpayerId });
        d = this.attachObject(user, d.id);
        effects.push('Exploitant rattaché au dispositif (compte unique).');
      }
      if (c.finding === 'RETIRE') {
        d = this.devices.update({ ...d, registration: 'RETIRE', retiredAt: this.now().toISOString() });
        effects.push('Retrait du support constaté : plus aucun droit ne court.');
      } else if (c.finding === 'NON_DECLARE') {
        effects.push('Support enregistré au registre comme non déclaré ; régularisation par demande d’autorisation.');
      } else {
        effects.push('Mise en conformité demandée à l’exploitant.');
      }
      // Support non déclaré : les droits sont liquidés par défaut dès que le barème applicable est ACTIF et l'exploitant
      // identifié (la personne qui décide peut l'écarter explicitement : liquidateDues = false).
      const liquidate = input.liquidateDues ?? (c.finding === 'NON_DECLARE' && !!d.ownerTaxpayerId && this.taxRuleActive(d));
      if (liquidate && c.finding !== 'RETIRE') {
        if (!d.ownerTaxpayerId) throw unprocessable('DEVICE_OWNER_UNKNOWN', 'Liquidation impossible : exploitant non identifié.');
        const liq = this.liquidateDevice(user, d);
        obligationId = liq.obligationId;
        effects.push(liq.status === 'EMISE' ? `Droits liquidés par la règle ${liq.ruleCode} : obligation ${obligationId}.` : liq.note);
      }
      effects.push('Aucune pénalité : barème des pénalités non publié (acte requis).');
    } else {
      effects.push('Dossier classé sans suite.');
    }
    const now = this.now().toISOString();
    const notify = d.ownerTaxpayerId ? this.ctx.taxpayers.get(d.ownerTaxpayerId) : null;
    const updated = this.cases.update({
      ...c, status: input.outcome, decision: { by: user.id, at: now, outcome: input.outcome, reason: input.reason, effect: effects.join(' '), obligationId },
      ...(notify ? { notifiedAt: now } : {}),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: input.outcome === 'RETENU' ? 'publicite.case.retained' : 'publicite.case.dismissed', resourceType: 'ad_case', resourceId: c.id, details: { reason: input.reason, effects, obligationId } });
    // Contre-vérification aléatoire d'un échantillon de dossiers retenus (superviseur, résultat enregistré).
    if (input.outcome === 'RETENU') sampleForCounterCheck(this.ctx, { module: 'PUBLICITE', caseId: c.id, reference: c.reference, agentId: insp.inspectorId, commune: c.commune, involved: [insp.inspectorId, c.verification!.by, user.id] });
    // Notification : référence, support, nature, preuves, démarches, délais, voies de contestation, paiement officiel.
    if (notify) this.ctx.comms.publish('inspection.report.issued', [taxpayerRecipient(notify)], { reference: c.reference }, { entity: DGTK });
    return this.caseView(updated);
  }

  contestCase(user: User, id: string, grounds: string) {
    const c = this.getCase(id);
    const d = this.getDevice(c.deviceId);
    if (!d.ownerTaxpayerId) throw forbidden('NOT_DEVICE_OWNER', 'Seul l’exploitant identifié peut contester ce dossier.');
    authorize(user, 'publicite:case.contest', { taxpayerId: d.ownerTaxpayerId });
    if (c.status === 'REJETE_QA' || c.status === 'CLASSE') throw conflict('CASE_CLOSED', 'Dossier écarté ou classé.');
    const stage = c.status === 'RETENU' ? 'APRES_DECISION' : 'AVANT_DECISION';
    let appealId: string | undefined;
    if (stage === 'APRES_DECISION' && c.decision?.obligationId) appealId = this.ctx.appeals.submit(user, { obligationId: c.decision.obligationId, grounds }).id;
    const updated = this.cases.update({ ...c, contests: [...c.contests, { id: this.ids.next('ADX'), by: user.id, at: this.now().toISOString(), grounds, stage, ...(appealId ? { appealId } : {}) }] });
    this.ctx.audit.append({ actor: actorOf(user), action: 'publicite.case.contested', resourceType: 'ad_case', resourceId: c.id, details: { stage, appealId: appealId ?? null } });
    return this.caseView(updated);
  }

  caseView(c: AdCase) {
    const insp = this.inspections.get(c.inspectionId);
    const d = this.devices.get(c.deviceId);
    const ob = c.decision?.obligationId ? this.ctx.assessment.get(c.decision.obligationId) : null;
    return {
      ...c,
      inspection: insp ? {
        reference: insp.reference, inspectorId: insp.inspectorId, photos: insp.photos, lat: insp.lat, lon: insp.lon, observedAt: insp.observedAt, observations: insp.observations, ocrMatches: insp.ocrMatches, presumedOperator: insp.presumedOperator,
        // Preuve montrée au vérificateur : photos conservées au serveur, ou seulement des empreintes déclarées (faible).
        serverPhotos: (insp.serverPhotoIds ?? []).map((id) => this.photos.get(id)).filter((p): p is AdEvidencePhoto => !!p).map((p) => this.photoMeta(p)),
        weakEvidence: inspectionWeakEvidence(insp),
      } : null,
      device: d ? { id: d.id, reference: d.reference, type: d.type, commune: d.commune, address: d.address, surfaceM2: d.surfaceM2, faces: d.faces, ownerIdentified: d.ownerTaxpayerId !== null } : null,
      obligation: ob ? noticeOf(ob, paymentState(this.ctx, ob.id).state) : null,
      appealPath: 'Contestation dans MOSOLO (observations avant décision ; réclamation sur l’obligation après décision), délai indiqué dans l’avis.',
    };
  }

  listCases(user: User, status?: string) {
    authorize(user, 'publicite:inventory', { entity: DGTK });
    return this.cases
      .all()
      .filter((c) => (!status || c.status === status) && (evaluate(user, 'publicite:case.verify', { communes: [c.commune] }) || evaluate(user, 'publicite:case.decide', { entity: DGTK }) || evaluate(user, 'publicite:inspection.create', { communes: [c.commune] }) || evaluate(user, 'publicite:indicators', { entity: DGTK })))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((c) => this.caseView(c));
  }

  myCases(user: User) {
    if (!user.taxpayerId) throw forbidden('NO_TAXPAYER_ACCOUNT', 'Compte contribuable requis.');
    authorize(user, 'publicite:case.contest', { taxpayerId: user.taxpayerId });
    const mine = new Set(this.devices.find((d) => d.ownerTaxpayerId === user.taxpayerId).map((d) => d.id));
    // L'exploitant voit ses dossiers dès la vérification (jamais un constat non vérifié).
    return this.cases.find((c) => mine.has(c.deviceId) && c.status !== 'CONSTATE' && c.status !== 'REJETE_QA').map((c) => this.caseView(c));
  }

  inspectionsOf(user: User, inspectorId?: string) {
    authorize(user, 'publicite:inventory', { entity: DGTK });
    const id = user.roles.includes('R11') && !user.roles.some((r) => ['R06', 'R07', 'R09', 'R22'].includes(r)) ? user.id : inspectorId;
    return this.inspections.find((i) => !id || i.inspectorId === id).sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  }

  // ---------------------------------------------------------------- Échéances

  tick(): { expiring: number; expired: number } {
    const today = this.today();
    const horizon = kinshasaDate(new Date(this.now().getTime() + EXPIRY_NOTICE_DAYS * DAY_MS));
    let expiring = 0;
    let expired = 0;
    for (const r of this.requests.find((x) => x.status === 'ACCORDEE')) {
      const tp = this.ctx.taxpayers.get(r.taxpayerId);
      if (r.periodTo < today && !r.expiredNoticeAt) {
        this.requests.update({ ...r, expiredNoticeAt: this.now().toISOString() });
        this.ctx.comms.publish('permit.expired', [taxpayerRecipient(tp)], { reference: r.reference }, { entity: DGTK });
        this.ctx.audit.append({ actor: { kind: 'system', id: 'publicite-echeances' }, action: 'publicite.authorization.expired', resourceType: 'ad_authorization', resourceId: r.id });
        expired += 1;
      } else if (r.periodTo >= today && r.periodTo <= horizon && !r.expiryNoticeAt) {
        this.requests.update({ ...r, expiryNoticeAt: this.now().toISOString() });
        this.ctx.comms.publish('permit.expiring', [taxpayerRecipient(tp)], { reference: r.reference }, { entity: DGTK });
        this.ctx.audit.append({ actor: { kind: 'system', id: 'publicite-echeances' }, action: 'publicite.authorization.expiring_notice', resourceType: 'ad_authorization', resourceId: r.id, details: { validUntil: r.periodTo } });
        expiring += 1;
      }
    }
    return { expiring, expired };
  }

  runReminders(user: User) {
    authorize(user, 'publicite:reminders.run', { entity: DGTK });
    return this.tick();
  }

  // ---------------------------------------------------------------- Indicateurs (agrégats)

  indicators(user: User) {
    authorize(user, 'publicite:indicators', { entity: DGTK });
    this.tick();
    const views = this.devices.all().map((d) => ({ d, st: this.deviceStatus(d) }));
    const count = (s: string) => views.filter((v) => v.st.status === s).length;
    const active = views.filter((v) => v.st.status !== 'RETIRE');
    const obligations: { commune: string; obligationId: string }[] = [];
    for (const r of this.requests.find((x) => !!x.liquidation?.obligationId)) obligations.push({ commune: this.getDevice(r.deviceId).commune, obligationId: r.liquidation!.obligationId! });
    for (const c of this.cases.find((x) => !!x.decision?.obligationId)) obligations.push({ commune: c.commune, obligationId: c.decision!.obligationId! });
    const paid: MoneyJSON[] = [];
    const byCommuneMoney = new Map<string, MoneyJSON[]>();
    let liquidated = 0;
    for (const o of obligations) {
      liquidated += 1;
      const p = paymentState(this.ctx, o.obligationId);
      // Échéances déjà payées comprises (paiement partiel) : recette encaissée au compte public.
      if (p.state === 'PAYE' || p.state === 'RAPPROCHE' || p.state === 'PARTIEL') {
        paid.push(p.amount!);
        byCommuneMoney.set(o.commune, [...(byCommuneMoney.get(o.commune) ?? []), p.amount!]);
      }
    }
    const authorizedSurface = views.filter((v) => v.st.status === 'AUTORISE').reduce((acc, v) => acc + dec(v.d.surfaceM2) * BigInt(v.d.faces), 0n);
    const surfaceStr = round2(decToString(authorizedSurface));
    const inspections = this.inspections.all();
    const cases = this.cases.all();
    const communes = [...new Set(views.map((v) => v.d.commune))].sort();
    const inspectors = [...new Set(inspections.map((i) => i.inspectorId))].map((id) => {
      const mine = inspections.filter((i) => i.inspectorId === id);
      const theirCases = cases.filter((c) => mine.some((i) => i.id === c.inspectionId));
      const verified = theirCases.filter((c) => c.verification).length;
      const confirmed = theirCases.filter((c) => c.verification?.outcome === 'CONFIRME').length;
      return {
        inspectorId: id, name: this.ctx.users.get(id)?.name ?? id, inspections: mine.length,
        withPhotosAndGps: mine.filter((i) => i.photos.length > 0).length,
        casesVerified: verified, casesConfirmed: confirmed, falseReportsRate: pct(verified - confirmed, verified),
        /** Qualité des preuves et exactitude — jamais le nombre de sanctions (§ 11B.4). */
        accuracyRate: pct(confirmed, verified),
      };
    });
    return {
      generatedAt: this.now().toISOString(),
      notice: 'Agrégats seulement. Recettes = paiements confirmés par le prestataire. La règle de liquidation de démonstration est fictive.',
      taxRule: (() => {
        const r = activeRule(this.ctx, AD_TAX_RULE) ?? latestRule(this.ctx, AD_TAX_RULE);
        return r ? { code: r.code, version: r.version, status: r.status, demo: r.demo === true } : { code: AD_TAX_RULE, version: null, status: 'ACTE_REQUIS', demo: false };
      })(),
      totals: {
        devices: views.length, active: active.length,
        authorized: count('AUTORISE'), declaredPending: count('DECLARE'), undeclared: count('NON_DECLARE'), expired: count('EXPIRE'), retired: count('RETIRE'),
        authorizedRate: pct(count('AUTORISE'), active.length),
        expiringSoon: views.filter((v) => v.st.expiringSoon).length,
        regularized: views.filter((v) => v.d.origin === 'RECENSEMENT' && v.st.status === 'AUTORISE').length,
        requestsPending: this.requests.find((r) => ['DEPOSEE', 'COMPLEMENT_DEMANDE', 'PROPOSEE'].includes(r.status)).length,
        inspections: inspections.length, casesOpen: cases.filter((c) => c.status === 'CONSTATE' || c.status === 'VERIFIE').length,
        casesRetained: cases.filter((c) => c.status === 'RETENU').length, casesDismissed: cases.filter((c) => c.status === 'CLASSE' || c.status === 'REJETE_QA').length,
        contested: cases.filter((c) => c.contests.length > 0).length,
        obligations: liquidated, revenue: sumByCurrency(paid), authorizedSurfaceM2: surfaceStr,
        revenuePerM2: dec(surfaceStr) > 0n ? perUnit(sumByCurrency(paid), surfaceStr) : [],
      },
      byFinding: FINDINGS.map((f) => ({ finding: f, count: inspections.filter((i) => i.finding === f).length })),
      byCommune: communes.map((commune) => {
        const vs = views.filter((v) => v.d.commune === commune);
        const act = vs.filter((v) => v.st.status !== 'RETIRE');
        return {
          commune, devices: vs.length, authorized: vs.filter((v) => v.st.status === 'AUTORISE').length, undeclared: vs.filter((v) => v.st.status === 'NON_DECLARE').length,
          authorizedRate: pct(vs.filter((v) => v.st.status === 'AUTORISE').length, act.length), revenue: sumByCurrency(byCommuneMoney.get(commune) ?? []),
        };
      }),
      inspectors,
    };
  }

  /** Points de la carte (agents habilités) : supports, échéances, signalements, interventions. */
  map(user: User) {
    authorize(user, 'publicite:inventory', { entity: DGTK });
    return this.devices.all().map((d) => {
      const st = this.deviceStatus(d);
      return { id: d.id, reference: d.reference, type: d.type, lat: d.lat, lon: d.lon, commune: d.commune, status: st.status, expiringSoon: st.expiringSoon, openCase: st.openCase !== null, inspections: st.inspections };
    });
  }
}

/** Avis au redevable : obligation expliquée (base, formule, taux, échéance, voie de recours) et état de paiement. */
/**
 * Commune où se trouve une position, estimée sur les seuls lieux FIXES (supports non mobiles, objets fiscaux hors
 * véhicules et hors publicités portées par un véhicule) : sert à l'« Autour de moi » et aux inspections mobiles.
 */
export function adCommuneAt(ctx: AppContext, svc: PubliciteService, here: { lat: number; lon: number }) {
  const fixed = svc.devices.all().filter((d) => d.placement !== 'VEHICULE' && d.registration !== 'RETIRE');
  return estimateCommune([...fixed, ...ctx.objects.objects.all().filter(isFixedObject)], here);
}

export function noticeOf(ob: { id: string; label: string; amount: MoneyJSON; dueDate: string; status: string; ruleCode: string; ruleVersion: number; attribution: { commune: string | null }; explanation: { base: Record<string, string>; formula: string; rates: Record<string, string>; appealPath: string; legalBasis: { title: string }[] } }, payment: string) {
  return {
    obligationId: ob.id, label: ob.label, amount: ob.amount, dueDate: ob.dueDate, status: ob.status, ruleCode: ob.ruleCode, ruleVersion: ob.ruleVersion,
    commune: ob.attribution.commune, base: ob.explanation.base, formula: ob.explanation.formula, rates: ob.explanation.rates,
    appealPath: ob.explanation.appealPath, legalBasis: ob.explanation.legalBasis.map((l) => l.title), payment, source: '',
  };
}
