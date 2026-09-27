/**
 * Billetterie urbaine multi-opérateurs RakaPay (module 76) et pass professionnel des moto-taxis wewa (module 81,
 * extension de RakaPay) — § 11D du Cahier, § H.27.16 et H.27.16.1 du document maître.
 *
 * Le pass wewa est un ticket RakaPay à durée : même moteur de titres (plugin « titres »), mêmes paiements (circuit
 * commun : obligation → référence → confirmation signée → quittance), mêmes contrôles.
 * Doctrine : tarif fixé par l'acte uniquement (règle du registre ; démo = règle FICTIVE publiée) ; un wewa en vert
 * n'a rien à payer et ne peut être sanctionné ; aucune espèce sur la route ; aucune immobilisation algorithmique ;
 * la coopérative n'encaisse pas, ne fixe aucun tarif et ne valide aucun contrôle ; accréditation et suspension
 * d'une coopérative = décision humaine motivée ; enregistrement des motos et conducteurs GRATUIT.
 */
import { Money, UNATTRIBUTED_COMMUNE, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { HOUR_MS } from '../../core/clock.js';
import { randomCode } from '../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { authorize, definePolicy, evaluate, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { userRecipient } from '../../modules/identity/recipients.js';
import { maskPhone } from '../../modules/identity/service.js';
import type { PaymentChannel } from '../../modules/payments/service.js';
import { isCommune } from '../../reference/kinshasa.js';
import { ext } from '../types.js';
import type { Credential, CredentialPlace, CredentialType } from '../titres/model.js';
import { normalizePlate, type ControlInput, type MinimalControlView, type TitresService } from '../titres/service.js';
import { statusAt } from '../titres/validity.js';
import { OperateursRakaPay } from './operateurs.js';
import { BilletterieRakaPay } from './billetterie.js';

definePolicy('rakapay:register', { R10: GRANTS.inTerritory('full'), R09: GRANTS.inTerritory('full'), R07: GRANTS.always, R30: GRANTS.ownTaxpayer });
definePolicy('rakapay:coop.manage', { R30: GRANTS.ownTaxpayer, R07: GRANTS.sameEntity, R06: GRANTS.sameEntity });
definePolicy('rakapay:coop.decide', { R06: GRANTS.sameEntity, R07: GRANTS.sameEntity });
definePolicy('rakapay:registry.read', {
  R06: GRANTS.always, R07: GRANTS.always, R09: GRANTS.inTerritory('full'), R10: GRANTS.inTerritory('minimal'), R11: GRANTS.always,
  R22: GRANTS.always, R24: GRANTS.always,
});
definePolicy('rakapay:complaint.handle', { R24: GRANTS.always, R07: GRANTS.always });
definePolicy('rakapay:complaint.read', { R24: GRANTS.always, R22: GRANTS.always, R07: GRANTS.always, R01: GRANTS.always, R02: GRANTS.always });
definePolicy('rakapay:indicators', {
  R01: GRANTS.always, R02: GRANTS.always, R05: GRANTS.always, R06: GRANTS.always, R07: GRANTS.always,
  R22: GRANTS.always, R23: GRANTS.always, R36: GRANTS.always,
});

export const RAKAPAY_ENTITY = 'DGTK';
export const MODULE_BILLETTERIE = '76';
export const MODULE_WEWA = '81';
export const WEWA_DURATIONS = ['JOUR', 'SEMAINE', 'MOIS'] as const;
export type WewaDuration = (typeof WEWA_DURATIONS)[number];
export const WEWA_TYPE: Record<WewaDuration, string> = { JOUR: 'RKP-WEWA-JOUR', SEMAINE: 'RKP-WEWA-SEMAINE', MOIS: 'RKP-WEWA-MOIS' };
export const WEWA_RULE = 'DEMO-WEWA-PASS';
export const BUS_RULE = 'DEMO-RKP-BUS';

export interface Decision {
  decision: string;
  motif: string;
  by: string;
  at: string;
}

export interface Operator {
  id: string;
  code: string;
  name: string;
  kind: 'PUBLIC' | 'COOPERATIVE' | 'PRIVE';
  entity: string;
  commune: string;
  /** CANDIDAT et REFUSE : circuit d'agrément des opérateurs (operateurs.ts, § 11D.2). */
  status: 'INVITE' | 'ACCREDITE' | 'SUSPENDU' | 'CANDIDAT' | 'REFUSE';
  /** Coopérative : compte unique MOSOLO de la structure (payeur des paiements groupés). */
  taxpayerId?: string;
  stationIds: string[];
  decisions: Decision[];
  demo: boolean;
  createdAt: string;
}

export interface Station {
  id: string;
  code: string;
  name: string;
  commune: string;
  quartier?: string;
  lat: number;
  lon: number;
  kinds: ('WEWA' | 'BUS')[];
  status: 'ACTIVE';
  /** Motos estimées [EXEMPLE] — à établir par le recensement. */
  estimatedMotos?: number;
  demo: boolean;
}

export interface Line {
  id: string;
  code: string;
  name: string;
  operatorId: string;
  stationIds: string[];
}

export interface Product {
  id: string;
  operatorId: string;
  commercialName: string;
  typeCode: string;
  serviceType: 'BUS' | 'WEWA_PASS';
  lineId?: string;
  publicRevenue: boolean;
  status: 'ACTIF' | 'INACTIF';
}

export interface Moto {
  id: string;
  plate: string;
  orderNumber: string;
  make: string;
  ownerTaxpayerId?: string;
  ownerLabel: string;
  commune: string;
  stationId: string;
  cooperativeId?: string;
  status: 'ACTIVE' | 'RETIREE';
  stickerToken: string;
  registeredAt: string;
  registeredBy: string;
  demo: boolean;
}

export interface Driver {
  id: string;
  taxpayerId?: string;
  displayName: string;
  licenceNo: string;
  phone?: string;
  photoRef?: string;
  vestNumber: string;
  vestToken: string;
  cardCode: string;
  currentMotoId?: string;
  cooperativeId?: string;
  status: 'ACTIF' | 'SUSPENDU';
  registeredAt: string;
  registeredBy: string;
  demo: boolean;
}

export interface Assignment {
  id: string;
  driverId: string;
  motoId: string;
  from: string;
  by: string;
}

export interface Complaint {
  id: string;
  anonymous: boolean;
  reporterUserId?: string;
  category: 'PRELEVEMENT_IRREGULIER' | 'DEMANDE_ESPECES' | 'CONTROLE_ABUSIF' | 'AUTRE';
  commune: string;
  stationId?: string;
  occurredAt: string;
  description: string;
  amountDemanded?: MoneyJSON;
  status: 'RECU' | 'QUALIFIE' | 'TRANSMIS' | 'CLOS';
  confirmed?: boolean;
  receivedAt: string;
  closedAt?: string;
  history: Decision[];
}

export interface WewaStatus {
  color: 'VERT' | 'AMBRE' | 'ROUGE';
  text: string;
  nothingToPay: boolean;
  passNumber?: string;
  credentialId?: string;
  validFrom?: string;
  validUntil?: string;
  displayStatus?: string;
  validity?: { band: string; pct: number | null; from: string; until: string };
  serverTime?: string;
}

export class RakaPayService {
  readonly operators = new InMemoryRepository<Operator>();
  readonly stations = new InMemoryRepository<Station>();
  readonly lines = new InMemoryRepository<Line>();
  readonly products = new InMemoryRepository<Product>();
  readonly motos = new InMemoryRepository<Moto>();
  readonly drivers = new InMemoryRepository<Driver>();
  readonly assignments = new InMemoryAppendOnlyRepository<Assignment>();
  readonly complaints = new InMemoryRepository<Complaint>();
  private readonly ids = new IdGenerator();

  /** Multi-opérateurs (§ 11D) : agrément, offres, agents exclusifs, circuit privé séparé, revue des ventes atypiques. */
  readonly operateurs: OperateursRakaPay;
  /** Module 76/81 : limites approuvées, ajustements de l'opérateur, commission instantanée, analyse quotidienne, blocage préventif, période de grâce. */
  readonly billetterie: BilletterieRakaPay;

  constructor(private readonly ctx: AppContext) {
    this.defineTypes();
    this.operateurs = new OperateursRakaPay(ctx, this);
    this.billetterie = new BilletterieRakaPay(ctx, this);
  }

  get titres(): TitresService {
    return ext<TitresService>(this.ctx, 'titres');
  }

  private actor(user: User) {
    return { kind: 'user' as const, id: user.id, roles: user.roles };
  }

  // --------------------------------------------------------------------- Types de titres (fiche de configuration)

  private defineTypes(): void {
    const act = { ref: 'J28', status: 'DEMONSTRATION' as const, note: 'Règle FICTIVE publiée par le circuit pour la démonstration : aucun pass réel ne peut être vendu avant l’acte (J28) fixant base légale, redevable et tarif.' };
    const wewa = (code: string, label: string, validity: CredentialType['validity'], inputs: Record<string, string>) => this.titres.defineType({
      code, module: MODULE_WEWA, moduleLabel: 'Pass moto-taxis (wewa) — RakaPay', label, prefix: 'WEW', entity: RAKAPAY_ENTITY, validity,
      transferable: false, plateBound: true, supports: ['GILET', 'AUTOCOLLANT', 'PLAQUE', 'QR_DYNAMIQUE', 'USSD', 'SMS', 'CARTE'],
      pricing: { ruleCode: WEWA_RULE, inputs }, legalAct: act, demo: true,
    }, 'rakapay');
    const common = { toleranceMinutes: 0, startMode: 'PAIEMENT' as const, extendable: true, refundable: false };
    wewa(WEWA_TYPE.JOUR, 'Pass wewa — jour', { model: 'JOURNALIER', dayMode: 'GLISSANT_24H', amberMinutes: 120, ...common }, { jour: '1', semaine: '0', mois: '0' });
    wewa(WEWA_TYPE.SEMAINE, 'Pass wewa — semaine', { model: 'HEBDOMADAIRE_MENSUEL', periodDays: 7, amberMinutes: 1440, ...common }, { jour: '0', semaine: '1', mois: '0' });
    wewa(WEWA_TYPE.MOIS, 'Pass wewa — mois', { model: 'HEBDOMADAIRE_MENSUEL', periodDays: 30, amberMinutes: 4320, ...common }, { jour: '0', semaine: '0', mois: '1' });
    const bus = (code: string, label: string, validity: CredentialType['validity'], inputs: Record<string, string>) => this.titres.defineType({
      code, module: MODULE_BILLETTERIE, moduleLabel: 'Billetterie urbaine RakaPay', label, prefix: 'RKP', entity: RAKAPAY_ENTITY, validity,
      transferable: false, plateBound: false, supports: ['QR_DYNAMIQUE', 'QR_STATIQUE', 'SMS', 'CODE_COURT'],
      pricing: { ruleCode: BUS_RULE, inputs }, legalAct: { ...act, ref: 'J21 / J25' }, demo: true,
    }, 'rakapay');
    const z = { trajet: '0', j1: '0', j7: '0', j30: '0' };
    bus('RKP-BUS-TRAJET', 'Ticket bus — trajet (usage unique)', { model: 'USAGE_UNIQUE', periodDays: 1, amberMinutes: 60, ...common, extendable: false }, { ...z, trajet: '1' });
    bus('RKP-BUS-1J', 'Accès bus — 1 jour', { model: 'JOURNALIER', dayMode: 'CALENDAIRE', amberMinutes: 120, ...common }, { ...z, j1: '1' });
    bus('RKP-BUS-7J', 'Accès bus — 7 jours', { model: 'HEBDOMADAIRE_MENSUEL', periodDays: 7, amberMinutes: 1440, ...common }, { ...z, j7: '1' });
    bus('RKP-BUS-30J', 'Accès bus — 30 jours', { model: 'HEBDOMADAIRE_MENSUEL', periodDays: 30, amberMinutes: 4320, ...common }, { ...z, j30: '1' });
  }

  // --------------------------------------------------------------------- Référentiels

  station(id: string): Station {
    const s = this.stations.get(id) ?? this.stations.findOne((x) => x.code === id);
    if (!s) throw notFound('STATION_NOT_FOUND', `Station inconnue : ${id}`);
    return s;
  }

  operator(id: string): Operator {
    const o = this.operators.get(id);
    if (!o) throw notFound('OPERATOR_NOT_FOUND', `Opérateur inconnu : ${id}`);
    return o;
  }

  cooperative(id: string): Operator {
    const o = this.operator(id);
    if (o.kind !== 'COOPERATIVE') throw notFound('COOPERATIVE_NOT_FOUND', `Coopérative inconnue : ${id}`);
    return o;
  }

  moto(id: string): Moto {
    const m = this.motos.get(id) ?? this.motos.findOne((x) => normalizePlate(x.plate) === normalizePlate(id));
    if (!m) throw notFound('MOTO_NOT_FOUND', `Moto inconnue : ${id}`);
    return m;
  }

  driver(id: string): Driver {
    const d = this.drivers.get(id);
    if (!d) throw notFound('DRIVER_NOT_FOUND', `Conducteur inconnu : ${id}`);
    return d;
  }

  stationPlace(s: Station): CredentialPlace {
    return { commune: s.commune, sourceId: s.id, label: s.name, basis: 'STATION_DEPART', lat: s.lat, lon: s.lon };
  }

  catalogue() {
    this.titres.sync();
    return this.products.all().filter((p) => p.status === 'ACTIF').map((p) => {
      const t = this.titres.type(p.typeCode);
      const op = this.operators.get(p.operatorId);
      const line = p.lineId ? this.lines.get(p.lineId) : undefined;
      return {
        ...p, operator: op ? { id: op.id, name: op.name, kind: op.kind, status: op.status } : null,
        line: line ? { id: line.id, code: line.code, name: line.name, stations: line.stationIds.map((sid) => this.stations.get(sid)).filter(Boolean).map((s) => ({ id: s!.id, code: s!.code, name: s!.name, commune: s!.commune })) } : null,
        type: this.titres.typeView(t),
      };
    });
  }

  // --------------------------------------------------------------------- Billetterie (module 76)

  buyTicket(user: User, input: { productId: string; departureStationId: string; channel: PaymentChannel }) {
    const p = this.products.get(input.productId);
    if (!p || p.status !== 'ACTIF') throw notFound('PRODUCT_NOT_FOUND', 'Ticket inconnu ou inactif.');
    if (p.serviceType !== 'BUS') throw unprocessable('USE_WEWA_PASS_ROUTE', 'Le pass wewa s’achète depuis l’espace wewa (moto et conducteur).');
    const op = this.operator(p.operatorId);
    if (op.status !== 'ACCREDITE') throw unprocessable('OPERATOR_NOT_ACCREDITED', `Opérateur ${op.name} non accrédité : vente impossible.`);
    // Circuits séparés (AC-TKT-01) : un ticket d'opérateur privé ne passe jamais par le compte public.
    if (op.kind === 'PRIVE' || !p.publicRevenue) throw unprocessable('PRIVATE_OPERATOR_SEPARATE_CIRCUIT', 'Ticket d’un opérateur privé : circuit privé séparé, hors compte public.');
    const station = this.station(input.departureStationId);
    const line = p.lineId ? this.lines.get(p.lineId) : undefined;
    if (line && !line.stationIds.includes(station.id)) throw unprocessable('STATION_NOT_ON_LINE', 'La station de départ n’est pas desservie par cette ligne.');
    if (!user.taxpayerId) throw forbidden('TAXPAYER_ACCOUNT_REQUIRED', 'Achat réservé à un compte contribuable (ou au guichet pour son compte).');
    const iss = this.titres.purchase(user, {
      payerTaxpayerId: user.taxpayerId, channel: input.channel, context: 'BILLETTERIE',
      items: [{ typeCode: p.typeCode, holderTaxpayerId: user.taxpayerId, subject: { label: line ? `${line.code} — ${line.name}` : p.commercialName }, place: this.stationPlace(station) }],
    });
    // Rattachement de la commande à l'opérateur (tableau de l'opérateur, circuit public).
    this.operateurs.productSales.append({ id: iss.id, issuanceId: iss.id, productId: p.id, operatorId: op.id, at: this.ctx.clock.now().toISOString() });
    return iss;
  }

  myTickets(taxpayerId: string) {
    return this.titres.byHolder(taxpayerId).filter((c) => c.module === MODULE_BILLETTERIE).map((c) => this.titres.holderView(c));
  }

  // --------------------------------------------------------------------- Registre wewa (enregistrement gratuit)

  private assertCanRegister(user: User, commune: string, cooperativeId?: string): void {
    if (user.roles.includes('R30')) {
      // Une coopérative inscrit ses membres ; aucun autre contribuable n'inscrit une moto pour autrui.
      const coop = cooperativeId ? this.cooperative(cooperativeId) : undefined;
      if (!coop?.taxpayerId) throw forbidden('FORBIDDEN', 'Seule une coopérative accréditée inscrit des membres.');
      authorize(user, 'rakapay:register', { taxpayerId: coop.taxpayerId });
      if (coop.status !== 'ACCREDITE') throw forbidden('COOPERATIVE_NOT_ACCREDITED', 'Coopérative non accréditée ou suspendue.');
      return;
    }
    authorize(user, 'rakapay:register', { communes: [commune] });
  }

  registerMoto(user: User, input: { plate: string; orderNumber: string; make: string; ownerTaxpayerId?: string; ownerLabel: string; stationId: string; cooperativeId?: string }): Moto {
    const station = this.station(input.stationId);
    this.assertCanRegister(user, station.commune, input.cooperativeId);
    if (!station.kinds.includes('WEWA')) throw unprocessable('NOT_A_WEWA_STATION', 'Station non ouverte aux wewa.');
    const plate = normalizePlate(input.plate);
    if (plate.length < 4) throw badRequest('INVALID_PLATE', 'Plaque invalide.');
    if (this.motos.findOne((m) => normalizePlate(m.plate) === plate && m.status === 'ACTIVE')) throw conflict('PLATE_ALREADY_REGISTERED', `La plaque ${input.plate} est déjà enregistrée.`);
    if (this.motos.findOne((m) => m.orderNumber === input.orderNumber)) throw conflict('ORDER_NUMBER_IN_USE', 'Numéro d’ordre déjà attribué.');
    if (input.ownerTaxpayerId) this.ctx.taxpayers.get(input.ownerTaxpayerId);
    if (input.cooperativeId) this.cooperative(input.cooperativeId);
    const id = this.ids.next('MOTO');
    const moto = this.motos.insert({
      id, plate: input.plate.trim().toUpperCase(), orderNumber: input.orderNumber, make: input.make, ...(input.ownerTaxpayerId ? { ownerTaxpayerId: input.ownerTaxpayerId } : {}),
      ownerLabel: input.ownerLabel, commune: station.commune, stationId: station.id, ...(input.cooperativeId ? { cooperativeId: input.cooperativeId } : {}),
      status: 'ACTIVE', stickerToken: this.titres.signer.signStatic({ k: 'AUTOCOLLANT', m: id, p: plate }),
      registeredAt: this.ctx.clock.now().toISOString(), registeredBy: user.id, demo: false,
    });
    this.ctx.audit.append({ actor: this.actor(user), action: 'rakapay.moto.registered', resourceType: 'motorbike', resourceId: id, details: { plate, station: station.code, commune: station.commune, fee: 'GRATUIT' } });
    return moto;
  }

  registerDriver(user: User, input: { displayName: string; licenceNo: string; phone?: string; taxpayerId?: string; motoId?: string; cooperativeId?: string; photoRef?: string }): Driver {
    const moto = input.motoId ? this.moto(input.motoId) : undefined;
    const commune = moto?.commune ?? (input.cooperativeId ? this.cooperative(input.cooperativeId).commune : '');
    if (!commune) throw badRequest('MOTO_OR_COOPERATIVE_REQUIRED', 'Rattacher le conducteur à une moto ou à une coopérative.');
    this.assertCanRegister(user, commune, input.cooperativeId ?? moto?.cooperativeId);
    if (input.taxpayerId) {
      this.ctx.taxpayers.get(input.taxpayerId);
      if (this.drivers.findOne((d) => d.taxpayerId === input.taxpayerId)) throw conflict('DRIVER_ALREADY_REGISTERED', 'Ce compte est déjà enregistré comme conducteur.');
    }
    if (this.drivers.findOne((d) => d.licenceNo === input.licenceNo)) throw conflict('LICENCE_ALREADY_REGISTERED', 'Permis déjà enregistré.');
    const id = this.ids.next('COND');
    const vestNumber = `W-${commune.slice(0, 3).toUpperCase()}-${String(this.drivers.count() + 1).padStart(4, '0')}`;
    const now = this.ctx.clock.now().toISOString();
    const d = this.drivers.insert({
      id, ...(input.taxpayerId ? { taxpayerId: input.taxpayerId } : {}), displayName: input.displayName, licenceNo: input.licenceNo,
      ...(input.phone ? { phone: input.phone } : {}), ...(input.photoRef ? { photoRef: input.photoRef } : {}), vestNumber,
      vestToken: this.titres.signer.signStatic({ k: 'GILET', d: id, v: vestNumber }), cardCode: `KIN-C-${randomCode(6)}`,
      ...(moto ? { currentMotoId: moto.id } : {}), ...((input.cooperativeId ?? moto?.cooperativeId) ? { cooperativeId: input.cooperativeId ?? moto?.cooperativeId } : {}),
      status: 'ACTIF', registeredAt: now, registeredBy: user.id, demo: false,
    });
    if (moto) this.assignments.append({ id: this.ids.next('AFF'), driverId: id, motoId: moto.id, from: now, by: user.id });
    this.ctx.audit.append({ actor: this.actor(user), action: 'rakapay.driver.registered', resourceType: 'driver', resourceId: id, details: { vestNumber, motoId: moto?.id ?? null, fee: 'GRATUIT' } });
    return d;
  }

  /** Affectation conducteur ↔ moto historisée : le système sait toujours qui conduit quelle moto. */
  assign(user: User, driverId: string, motoId: string): Driver {
    const d = this.driver(driverId);
    const m = this.moto(motoId);
    this.assertCanRegister(user, m.commune, m.cooperativeId ?? d.cooperativeId);
    const holder = this.drivers.findOne((x) => x.currentMotoId === m.id && x.id !== d.id);
    if (holder) this.drivers.update({ ...holder, currentMotoId: undefined });
    const now = this.ctx.clock.now().toISOString();
    const updated = this.drivers.update({ ...d, currentMotoId: m.id });
    this.assignments.append({ id: this.ids.next('AFF'), driverId: d.id, motoId: m.id, from: now, by: user.id });
    this.ctx.audit.append({ actor: this.actor(user), action: 'rakapay.driver.assigned', resourceType: 'driver', resourceId: d.id, details: { motoId: m.id, previousDriver: holder?.id ?? null } });
    return updated;
  }

  // --------------------------------------------------------------------- Pass wewa

  /** Statut vert / ambre / rouge d'une moto à l'heure serveur. Vert = rien à payer. */
  motoStatus(m: Moto): WewaStatus {
    const now = this.ctx.clock.now();
    const list = this.titres.byPlate(m.plate, MODULE_WEWA);
    const best = list[0];
    if (!best) return { color: 'ROUGE', text: 'AUCUN PASS — enregistré, pass à acheter', nothingToPay: false };
    const s = statusAt(best, now);
    const base = { passNumber: best.number, credentialId: best.id, validFrom: best.validFrom, validUntil: best.validUntil, displayStatus: s.status, validity: s.validity, serverTime: s.serverTime };
    if (s.status === 'VALIDE') return { color: 'VERT', text: `EN RÈGLE — ${s.text}`, nothingToPay: true, ...base };
    if (s.status === 'BIENTOT_EXPIRE') return { color: 'AMBRE', text: `EN RÈGLE — ${s.text}`, nothingToPay: true, ...base };
    // Moins de 1 % de validité restante : encore en règle, affiché en rouge (règle 50 % / 1 %).
    if (s.status === 'CRITIQUE') return { color: 'ROUGE', text: `EN RÈGLE — ${s.text}`, nothingToPay: true, ...base };
    return { color: 'ROUGE', text: s.text, nothingToPay: false, ...base };
  }

  private passItem(m: Moto, d: Driver, duration: WewaDuration) {
    if (m.status !== 'ACTIVE') throw unprocessable('MOTO_RETIRED', 'Moto retirée du registre.');
    if (d.status !== 'ACTIF') throw unprocessable('DRIVER_SUSPENDED', 'Conducteur suspendu (décision motivée) : pass indisponible.');
    if (d.currentMotoId !== m.id) throw unprocessable('NOT_TRANSFERABLE', 'Un pass, un conducteur, une moto : ce conducteur ne conduit pas cette moto.');
    const station = this.station(m.stationId);
    return {
      typeCode: WEWA_TYPE[duration], ...(d.taxpayerId ? { holderTaxpayerId: d.taxpayerId } : {}),
      subject: { plate: m.plate, driverId: d.id, motoId: m.id, label: `${m.plate} · gilet ${d.vestNumber}` }, place: this.stationPlace(station),
    };
  }

  /** Achat individuel par le conducteur (téléphone, USSD) ou au guichet pour lui. */
  buyPass(user: User, input: { motoId: string; duration: WewaDuration; channel: PaymentChannel }) {
    const m = this.moto(input.motoId);
    const d = this.drivers.findOne((x) => x.currentMotoId === m.id);
    if (!d) throw unprocessable('NO_DRIVER_ASSIGNED', 'Aucun conducteur affecté à cette moto.');
    if (!d.taxpayerId) throw unprocessable('DRIVER_WITHOUT_ACCOUNT', 'Conducteur sans compte : paiement par sa coopérative ou au guichet.');
    if (user.roles.includes('R30') && user.taxpayerId !== d.taxpayerId) throw forbidden('FORBIDDEN', 'Seul le conducteur de la moto (ou sa coopérative) paie son pass.');
    return this.titres.purchase(user, { payerTaxpayerId: d.taxpayerId, channel: input.channel, context: 'PASS_WEWA', items: [this.passItem(m, d, input.duration)] });
  }

  /** Paiement groupé par la coopérative : une référence par commune, ACTIVATION INDIVIDUELLE de chaque pass. */
  groupPayment(user: User, coopId: string, input: { items: { motoId: string; duration: WewaDuration }[]; channel: PaymentChannel }) {
    const coop = this.cooperative(coopId);
    if (!coop.taxpayerId) throw unprocessable('COOPERATIVE_WITHOUT_ACCOUNT', 'Coopérative sans compte unique MOSOLO.');
    authorize(user, 'rakapay:coop.manage', { taxpayerId: coop.taxpayerId, entity: coop.entity });
    if (!user.roles.includes('R30') || user.taxpayerId !== coop.taxpayerId) throw forbidden('FORBIDDEN', 'Le paiement groupé est initié par le compte de la coopérative.');
    if (coop.status !== 'ACCREDITE') throw forbidden('COOPERATIVE_NOT_ACCREDITED', 'Coopérative suspendue ou non accréditée : paiement groupé impossible.');
    const items = input.items.map((it) => {
      const m = this.moto(it.motoId);
      if (m.cooperativeId !== coop.id) throw unprocessable('NOT_A_MEMBER', `La moto ${m.plate} n'est pas membre de ${coop.name}.`);
      const d = this.drivers.findOne((x) => x.currentMotoId === m.id);
      if (!d) throw unprocessable('NO_DRIVER_ASSIGNED', `Aucun conducteur affecté à la moto ${m.plate}.`);
      return this.passItem(m, d, it.duration);
    });
    return this.titres.purchase(user, {
      payerTaxpayerId: coop.taxpayerId, channel: input.channel, context: 'PAIEMENT_GROUPE', items,
      groupPayer: { kind: 'COOPERATIVE', id: coop.id, label: coop.name },
    });
  }

  /** Espace du conducteur : ses motos, son statut, son pass courant, son historique. */
  myWewa(user: User) {
    this.titres.sync();
    const d = user.taxpayerId ? this.drivers.findOne((x) => x.taxpayerId === user.taxpayerId) : undefined;
    if (!d) return { registered: false as const };
    const m = d.currentMotoId ? this.motos.get(d.currentMotoId) : undefined;
    const st = m ? this.stations.get(m.stationId) : undefined;
    const coop = d.cooperativeId ? this.operators.get(d.cooperativeId) : undefined;
    const passes = this.titres.credentials.find((c) => c.module === MODULE_WEWA && c.subject.driverId === d.id).sort((a, b) => b.validUntil.localeCompare(a.validUntil));
    const status = m ? this.motoStatus(m) : undefined;
    const current = status?.credentialId ? this.titres.credentials.get(status.credentialId) : undefined;
    return {
      registered: true as const,
      driver: { id: d.id, displayName: d.displayName, vestNumber: d.vestNumber, vestToken: d.vestToken, cardCode: d.cardCode, status: d.status },
      moto: m ? { id: m.id, plate: m.plate, orderNumber: m.orderNumber, make: m.make, stickerToken: m.stickerToken } : null,
      station: st ? { id: st.id, code: st.code, name: st.name, commune: st.commune } : null,
      cooperative: coop ? { id: coop.id, name: coop.name, status: coop.status } : null,
      status: status ?? null,
      currentPass: current ? this.titres.holderView(current) : null,
      passes: passes.map((c) => this.titres.holderView(c)),
      prices: WEWA_DURATIONS.map((dur) => ({ duration: dur, ...this.titres.pricePreview(this.titres.type(WEWA_TYPE[dur])) })),
    };
  }

  // --------------------------------------------------------------------- Contrôle protecteur

  /** Contrôle par gilet, autocollant, plaque ou QR du téléphone : statut, conducteur vérifié, rien à payer si vert. */
  control(user: User, input: { vest?: string; sticker?: string; plate?: string; qr?: string; place: ControlInput['place']; deviceId?: string }): MinimalControlView & { driverVerified: boolean | null; wewa: WewaStatus | null } {
    authorize(user, 'titres:control', { communes: input.place.commune ? [input.place.commune] : [] });
    if (user.territory && !input.place.commune) throw badRequest('CONTROL_COMMUNE_REQUIRED', 'Commune du lieu de contrôle requise.');
    this.titres.sync();
    let driver: Driver | undefined;
    let moto: Moto | undefined;
    let presented: string;
    let method: 'QR_STATIQUE' | 'PLAQUE' | 'QR_DYNAMIQUE' = 'QR_STATIQUE';
    if (input.vest) {
      presented = input.vest;
      const p = this.titres.signer.verifyStatic(input.vest);
      driver = p && p.k === 'GILET' && typeof p.d === 'string' ? this.drivers.get(p.d) : this.drivers.findOne((d) => d.vestNumber === input.vest!.trim().toUpperCase());
      moto = driver?.currentMotoId ? this.motos.get(driver.currentMotoId) : undefined;
    } else if (input.sticker) {
      presented = input.sticker;
      const p = this.titres.signer.verifyStatic(input.sticker);
      moto = p && p.k === 'AUTOCOLLANT' && typeof p.m === 'string' ? this.motos.get(p.m) : undefined;
    } else if (input.plate) {
      presented = input.plate;
      method = 'PLAQUE';
      moto = this.motos.findOne((m) => normalizePlate(m.plate) === normalizePlate(input.plate!));
    } else if (input.qr) {
      const view = this.titres.control(user, { qr: input.qr, place: input.place, module: MODULE_WEWA, ...(input.deviceId ? { deviceId: input.deviceId } : {}) });
      const c = view.plate ? this.titres.byPlate(view.plate, MODULE_WEWA)[0] : undefined;
      const m = c?.subject.motoId ? this.motos.get(c.subject.motoId) : undefined;
      const d = m ? this.drivers.findOne((x) => x.currentMotoId === m.id) : undefined;
      return { ...view, driverVerified: c ? !!d && d.status === 'ACTIF' && c.subject.driverId === d.id : null, wewa: m ? this.motoStatus(m) : null };
    } else {
      throw badRequest('NOTHING_PRESENTED', 'Gilet, autocollant, plaque ou QR requis.');
    }
    if (moto && !driver) driver = this.drivers.findOne((d) => d.currentMotoId === moto!.id);
    const best = moto ? this.titres.byPlate(moto.plate, MODULE_WEWA)[0] : undefined;
    const failure = !moto ? (driver ? 'Conducteur sans moto affectée' : 'Gilet, autocollant ou plaque non enregistré') : best ? undefined : 'Aucun pass pour cette moto';
    const r = this.titres.recordControl(user, {
      ...(best ? { credential: best } : {}), module: MODULE_WEWA, method, presented, place: input.place, ...(input.deviceId ? { deviceId: input.deviceId } : {}), ...(failure ? { failure } : {}),
    });
    const view = this.titres.minimalView(r.event, r.status, best ? this.titres.credentials.get(best.id) : undefined, r.constat);
    const driverVerified = driver && moto && best ? driver.status === 'ACTIF' && best.subject.driverId === driver.id && driver.currentMotoId === moto.id : driver ? driver.status === 'ACTIF' : null;
    return { ...view, ...(moto ? { plate: normalizePlate(moto.plate) } : {}), driverVerified, wewa: moto ? this.motoStatus(moto) : null };
  }

  /** Vérification par le passager (public) : conducteur enregistré ? pass vert ? — sans nom ni adresse. */
  passengerCheck(code: string) {
    this.titres.sync();
    const p = this.titres.signer.verifyStatic(code);
    const driver = p && p.k === 'GILET' && typeof p.d === 'string' ? this.drivers.get(p.d) : this.drivers.findOne((d) => d.vestNumber === code.trim().toUpperCase());
    const moto = driver?.currentMotoId ? this.motos.get(driver.currentMotoId) : p && p.k === 'AUTOCOLLANT' && typeof p.m === 'string' ? this.motos.get(p.m) : undefined;
    const verifiedAt = this.ctx.clock.now().toISOString();
    this.ctx.audit.append({ actor: { kind: 'public', id: 'verification-passager' }, action: 'rakapay.passenger.checked', resourceType: 'driver', resourceId: driver?.id ?? moto?.id ?? 'inconnu', details: { found: !!driver || !!moto } });
    if (!driver && !moto) return { registered: false, message: 'Gilet ou autocollant inconnu : conducteur non enregistré. Vous pouvez le signaler.', verifiedAt };
    const status = moto ? this.motoStatus(moto) : null;
    const station = moto ? this.stations.get(moto.stationId) : undefined;
    return {
      registered: true, driverVerified: !!driver && driver.status === 'ACTIF', vestNumber: driver?.vestNumber ?? null,
      pass: status ? { color: status.color, text: status.text, validFrom: status.validFrom ?? null, validUntil: status.validUntil ?? null, validity: status.validity ?? null } : null,
      stationCommune: station?.commune ?? null, verifiedAt,
      message: status?.color === 'ROUGE' ? 'Conducteur enregistré ; pass non valide à cette heure.' : 'Conducteur enregistré ; pass en règle.',
    };
  }

  // --------------------------------------------------------------------- Coopératives

  coopView(user: User, coopId: string) {
    const coop = this.cooperative(coopId);
    authorize(user, 'rakapay:coop.manage', { ...(coop.taxpayerId ? { taxpayerId: coop.taxpayerId } : {}), entity: coop.entity });
    this.titres.sync();
    const motos = this.motos.find((m) => m.cooperativeId === coop.id);
    const members = motos.map((m) => {
      const d = this.drivers.findOne((x) => x.currentMotoId === m.id);
      const s = this.motoStatus(m);
      const st = this.stations.get(m.stationId);
      return {
        motoId: m.id, plate: m.plate, orderNumber: m.orderNumber, station: st ? { id: st.id, name: st.name, commune: st.commune } : null,
        driver: d ? { id: d.id, displayName: d.displayName, vestNumber: d.vestNumber, hasAccount: !!d.taxpayerId } : null, status: s,
      };
    });
    const green = members.filter((m) => m.status.color !== 'ROUGE').length;
    return {
      cooperative: { id: coop.id, code: coop.code, name: coop.name, status: coop.status, commune: coop.commune, decisions: coop.decisions, demo: coop.demo },
      stations: coop.stationIds.map((id) => this.stations.get(id)).filter((s): s is Station => !!s),
      members,
      compliance: { members: members.length, green, red: members.length - green, rate: members.length ? (green / members.length).toFixed(4) : '0' },
      renewalAlerts: members.filter((m) => m.status.color === 'AMBRE').map((m) => ({ plate: m.plate, validUntil: m.status.validUntil })),
      payments: this.titres.issuances.find((i) => i.groupPayer?.id === coop.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      prices: WEWA_DURATIONS.map((dur) => ({ duration: dur, ...this.titres.pricePreview(this.titres.type(WEWA_TYPE[dur])) })),
      limits: 'La coopérative inscrit et suit ses membres et paie en groupe ; elle n’encaisse aucune espèce, ne modifie aucun tarif et ne valide aucun contrôle.',
    };
  }

  /** Accréditation / suspension / réactivation : décision humaine motivée (jamais automatique). */
  decideCoop(user: User, coopId: string, input: { decision: 'ACCREDITER' | 'SUSPENDRE' | 'REACTIVER'; motif: string }): Operator {
    const coop = this.cooperative(coopId);
    authorize(user, 'rakapay:coop.decide', { entity: coop.entity });
    const to = { ACCREDITER: 'ACCREDITE', SUSPENDRE: 'SUSPENDU', REACTIVER: 'ACCREDITE' } as const;
    const allowed = { ACCREDITER: ['INVITE'], SUSPENDRE: ['ACCREDITE'], REACTIVER: ['SUSPENDU'] } as const;
    if (!(allowed[input.decision] as readonly string[]).includes(coop.status)) throw conflict('INVALID_COOPERATIVE_STATE', `Décision ${input.decision} impossible au statut ${coop.status}.`);
    const d: Decision = { decision: input.decision, motif: input.motif.trim(), by: user.id, at: this.ctx.clock.now().toISOString() };
    const updated = this.operators.update({ ...coop, status: to[input.decision], decisions: [...coop.decisions, d] });
    this.ctx.audit.append({ actor: this.actor(user), action: `rakapay.cooperative.${input.decision.toLowerCase()}`, resourceType: 'cooperative', resourceId: coop.id, details: { motif: d.motif, from: coop.status, to: updated.status } });
    if (coop.taxpayerId) {
      const tp = this.ctx.taxpayers.taxpayers.get(coop.taxpayerId);
      if (tp) this.ctx.comms.publish(input.decision === 'SUSPENDRE' ? 'permit.suspended' : 'permit.issued', [{ id: tp.id, kind: 'taxpayer', name: tp.fullName, lang: tp.language, prefs: tp.prefs }], { reference: coop.code }, { entity: coop.entity });
    }
    return updated;
  }

  // --------------------------------------------------------------------- Signalements (prélèvements irréguliers)

  report(user: User | undefined, input: { category: Complaint['category']; commune: string; stationId?: string; occurredAt: string; description: string; amountDemanded?: MoneyJSON; anonymous: boolean }): Complaint {
    if (!isCommune(input.commune)) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${input.commune}`);
    if (input.stationId) this.station(input.stationId);
    const now = this.ctx.clock.now();
    if (new Date(input.occurredAt).getTime() > now.getTime() + 5 * 60_000) throw badRequest('FUTURE_DATE', 'Date du fait dans le futur.');
    const c = this.complaints.insert({
      id: this.ids.next('SIG'), anonymous: input.anonymous || !user, ...(!input.anonymous && user ? { reporterUserId: user.id } : {}),
      category: input.category, commune: input.commune, ...(input.stationId ? { stationId: input.stationId } : {}), occurredAt: input.occurredAt,
      description: input.description, ...(input.amountDemanded ? { amountDemanded: Money.fromJSON(input.amountDemanded).toJSON() } : {}),
      status: 'RECU', receivedAt: now.toISOString(), history: [],
    });
    this.ctx.audit.append({ actor: user && !input.anonymous ? this.actor(user) : { kind: 'public', id: 'signalement' }, action: 'rakapay.complaint.received', resourceType: 'complaint', resourceId: c.id, details: { category: c.category, commune: c.commune, anonymous: c.anonymous } });
    this.ctx.comms.publish('fraud.cash_request_reported', this.ctx.users.withRole('R24').map(userRecipient), { reference: c.id }, { entity: 'AUDIT' });
    return c;
  }

  handleComplaint(user: User, id: string, input: { status: 'QUALIFIE' | 'TRANSMIS' | 'CLOS'; motif: string; confirmed?: boolean }): Complaint {
    authorize(user, 'rakapay:complaint.handle');
    const c = this.complaints.get(id);
    if (!c) throw notFound('COMPLAINT_NOT_FOUND', `Signalement inconnu : ${id}`);
    if (c.status === 'CLOS') throw conflict('COMPLAINT_CLOSED', 'Signalement déjà clos.');
    const now = this.ctx.clock.now().toISOString();
    const updated = this.complaints.update({
      ...c, status: input.status, ...(input.confirmed !== undefined ? { confirmed: input.confirmed } : {}), ...(input.status === 'CLOS' ? { closedAt: now } : {}),
      history: [...c.history, { decision: input.status, motif: input.motif.trim(), by: user.id, at: now }],
    });
    this.ctx.audit.append({ actor: this.actor(user), action: `rakapay.complaint.${input.status.toLowerCase()}`, resourceType: 'complaint', resourceId: id, details: { motif: input.motif.trim(), confirmed: input.confirmed ?? null } });
    return updated;
  }

  // --------------------------------------------------------------------- Indicateurs (agrégats)

  indicators() {
    this.titres.sync();
    const now = this.ctx.clock.now();
    const stations = this.stations.all().filter((s) => s.kinds.includes('WEWA'));
    const motos = this.motos.find((m) => m.status === 'ACTIVE');
    const coverage = stations.map((s) => {
      const ms = motos.filter((m) => m.stationId === s.id);
      const green = ms.filter((m) => this.motoStatus(m).color !== 'ROUGE').length;
      return {
        stationId: s.id, code: s.code, name: s.name, commune: s.commune, registered: ms.length,
        drivers: this.drivers.find((d) => !!d.currentMotoId && ms.some((m) => m.id === d.currentMotoId)).length,
        estimated: s.estimatedMotos ?? null, estimatedIsExample: true, coverageRate: s.estimatedMotos ? (ms.length / s.estimatedMotos).toFixed(4) : null,
        green, complianceNow: ms.length ? (green / ms.length).toFixed(4) : '0',
      };
    });
    const byCommune = new Map<string, { commune: string; registered: number; estimated: number; green: number }>();
    for (const c of coverage) {
      const row = byCommune.get(c.commune) ?? { commune: c.commune, registered: 0, estimated: 0, green: 0 };
      row.registered += c.registered;
      row.estimated += c.estimated ?? 0;
      row.green += c.green;
      byCommune.set(c.commune, row);
    }
    const wewaCtrls = this.titres.controls.find((e) => e.module === MODULE_WEWA);
    const wewaPasses = this.titres.credentials.find((c) => c.module === MODULE_WEWA);
    const channelOf = (c: Credential) => (c.paymentOrderId ? this.ctx.payments.orders.get(c.paymentOrderId)?.channel : undefined) ?? 'INCONNU';
    const byChannel: Record<string, number> = {};
    for (const c of wewaPasses) byChannel[channelOf(c)] = (byChannel[channelOf(c)] ?? 0) + 1;
    const digital = wewaPasses.filter((c) => channelOf(c) !== 'INCONNU').length;
    const grouped = wewaPasses.filter((c) => c.issuanceId && this.titres.issuances.get(c.issuanceId)?.groupPayer).length;
    const closed = this.complaints.find((c) => c.status === 'CLOS');
    const avgHours = closed.length ? (closed.reduce((s, c) => s + (new Date(c.closedAt!).getTime() - new Date(c.receivedAt).getTime()), 0) / closed.length / HOUR_MS).toFixed(1) : null;
    const confirmed = closed.filter((c) => c.confirmed).length;
    // Recette par commune du fait générateur (station de départ / d'attache), paiements confirmés — par devise.
    const revenue = new Map<string, Map<string, Money>>();
    for (const c of this.titres.credentials.find((x) => (x.module === MODULE_WEWA || x.module === MODULE_BILLETTERIE) && !x.replacesId)) {
      const order = c.paymentOrderId ? this.ctx.payments.orders.get(c.paymentOrderId) : undefined;
      if (!order || !['CONFIRME', 'REGLE', 'RAPPROCHE'].includes(order.status)) continue;
      const unit = c.amount;
      if (!unit) continue;
      const commune = c.attribution.commune ?? UNATTRIBUTED_COMMUNE;
      const m = revenue.get(commune) ?? new Map<string, Money>();
      m.set(unit.currency, (m.get(unit.currency) ?? Money.zero(unit.currency)).add(Money.fromJSON(unit)));
      revenue.set(commune, m);
    }
    const tickets = this.titres.indicators(MODULE_BILLETTERIE);
    const wewaInd = this.titres.indicators(MODULE_WEWA);
    return {
      serverTime: now.toISOString(),
      notice: 'Agrégats seulement. Estimations de motos [EXEMPLE] à établir par le recensement ; tarifs issus de règles FICTIVES de démonstration.',
      coverage: { registeredMotos: motos.length, registeredDrivers: this.drivers.count(), byStation: coverage, byCommune: [...byCommune.values()] },
      compliance: {
        controlled: wewaCtrls.length, green: wewaCtrls.filter((e) => e.result === 'VALIDE').length,
        rate: wewaCtrls.length ? (wewaCtrls.filter((e) => e.result === 'VALIDE').length / wewaCtrls.length).toFixed(4) : '0',
        constats: wewaInd.constats,
      },
      digitalPayment: { passesIssued: wewaPasses.length, paidDigitally: digital, rate: wewaPasses.length ? (digital / wewaPasses.length).toFixed(4) : '0', target: '1.0000', byChannel, groupPaid: grouped, cashOnRoad: 0 },
      complaints: {
        total: this.complaints.count(), open: this.complaints.find((c) => c.status !== 'CLOS').length, closed: closed.length,
        averageHandlingHours: avgHours, confirmedShare: closed.length ? (confirmed / closed.length).toFixed(4) : null,
        byCommune: [...this.complaints.all().reduce((m, c) => m.set(c.commune, (m.get(c.commune) ?? 0) + 1), new Map<string, number>())].map(([commune, count]) => ({ commune, count })),
        // Module 81 : plaintes de prélèvements irréguliers (prélèvement ou demande d'espèces sur la route), confirmées ou non.
        irregularLevies: this.complaints.find((c) => c.category === 'PRELEVEMENT_IRREGULIER' || c.category === 'DEMANDE_ESPECES').length,
        irregularLeviesConfirmed: closed.filter((c) => c.confirmed && (c.category === 'PRELEVEMENT_IRREGULIER' || c.category === 'DEMANDE_ESPECES')).length,
      },
      tickets: {
        sold: tickets.credentials.total, active: tickets.credentials.active, controls: tickets.controls.total, reuseAttempts: tickets.controls.reuseAttempts,
        // Module 76 : pénalités retenues (pourcentage réglementaire) et pénalités contestées.
        penaltiesRetained: tickets.constats.retained, penaltiesContested: tickets.constats.contested,
      },
      revenueByCommune: [...revenue.entries()].map(([commune, m]) => ({ commune, basis: 'STATION_DEPART', amounts: [...m.values()].map((x) => x.toJSON()) })),
      titres: { wewa: wewaInd, billetterie: tickets },
    };
  }

  /** Registre (agents habilités) : motos et conducteurs, sans téléphone complet. */
  registry(user: User, commune?: string) {
    authorize(user, 'rakapay:registry.read', { communes: commune ? [commune] : user.territory ?? [] });
    const access = evaluate(user, 'rakapay:registry.read', { communes: commune ? [commune] : user.territory ?? [] });
    const motos = this.motos.find((m) => (!commune || m.commune === commune) && (!user.territory || user.territory.includes(m.commune)));
    return motos.map((m) => {
      const d = this.drivers.findOne((x) => x.currentMotoId === m.id);
      return {
        id: m.id, plate: m.plate, orderNumber: m.orderNumber, make: m.make, commune: m.commune, stationId: m.stationId, cooperativeId: m.cooperativeId ?? null,
        status: this.motoStatus(m),
        driver: d ? (access === 'full' ? { id: d.id, displayName: d.displayName, vestNumber: d.vestNumber, phone: d.phone ? maskPhone(d.phone) : null } : { id: d.id, vestNumber: d.vestNumber }) : null,
      };
    });
  }
}
