/**
 * Service du moteur de titres (modules 70 — titres et validité, 71 — contrôle des titres).
 *
 * Doctrine appliquée :
 *  - aucun titre sans paiement confirmé : commande → obligation (règle ACTIVE du registre) → ordre de paiement du circuit
 *    commun → rappel prestataire signé → quittance provisoire → titre ACTIF adossé à cette quittance (§ H.11.1) ;
 *  - validité calculée sur l'heure du SERVEUR (AC-TIT-01) ; six statuts affichés couleur + icône + texte (AC-TIT-02) ;
 *  - un contrôle négatif produit un CONSTAT à instruire, jamais une amende ni un montant (AC-TIT-06, ARB-12, RW1) ;
 *  - usage unique consommé une seule fois, y compris entre contrôles hors ligne réconciliés (AC-TIT-03) ;
 *  - suspension, annulation, remplacement : décision d'une personne habilitée, avec motif, tracée ;
 *  - réponse de contrôle minimale : ni nom, ni adresse, ni identifiant de contribuable.
 */
import { Money, type MoneyJSON } from '@mosolo/shared';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { HOUR_MS } from '../../core/clock.js';
import { canonicalJson, checkChar, hmacSha256Hex, randomCode, safeEqualHex, sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound, unauthorized, unprocessable } from '../../core/errors.js';
import { authorize, definePolicy, evaluate, GRANTS, type Resource } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import type { PaymentChannel } from '../../modules/payments/service.js';
import { isCommune } from '../../reference/kinshasa.js';
import {
  KINSHASA_OFFSET_MS, VALIDITY_MODEL_LABELS,
  type Constat, type ControlMethod, type ControlResult, type Credential, type CredentialPlace, type CredentialState, type CredentialSubject,
  type CredentialType, type DisplayStatus, type Issuance, type IssuanceItem, type IssuancePayment, type Revocation, type UsageEvent,
  type UsePlace, type VerificationEvent,
} from './model.js';
import { DYNAMIC_WINDOW_SECONDS, TokenSigner } from './tokens.js';
import { computeWindow, controlResultOf, statusAt, type StatusView } from './validity.js';

// ---------------------------------------------------------------------------------------------------------------
// Politique d'accès (non déclaré ⇒ refusé). Jamais permis à l'IA (garde assertAiMay du socle).
// ---------------------------------------------------------------------------------------------------------------
definePolicy('titres:read.own', { R30: GRANTS.ownTaxpayer, R31: GRANTS.mandant });
definePolicy('titres:purchase', { R30: GRANTS.ownTaxpayer, R31: GRANTS.mandant, R12: GRANTS.always });
definePolicy('titres:control', { R10: GRANTS.inTerritory('full'), R11: GRANTS.always, R35: GRANTS.inTerritory('full') });
definePolicy('titres:decide', { R06: GRANTS.sameEntity, R07: GRANTS.sameEntity });
definePolicy('titres:issue.receipt', { R12: GRANTS.always, R32: GRANTS.always });
definePolicy('titres:read.any', { R06: GRANTS.sameEntity, R07: GRANTS.sameEntity, R22: GRANTS.always, R23: GRANTS.always, R24: GRANTS.always });
definePolicy('titres:indicators', {
  R01: GRANTS.always, R02: GRANTS.always, R05: GRANTS.always, R06: GRANTS.always, R07: GRANTS.always,
  R22: GRANTS.always, R23: GRANTS.always, R36: GRANTS.always,
});

const PAID_STATUSES = ['CONFIRME', 'REGLE', 'RAPPROCHE'];
const MIN = 60_000;

export const placeSchema = z.object({
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  label: z.string().trim().max(120).optional(),
  commune: z.string().trim().max(40).optional(),
}).strict();

export const offlineBatchSchema = z.object({
  batchId: z.string().min(4).max(100),
  deviceId: z.string().min(1).max(100),
  createdAt: z.string().datetime({ offset: true }),
  controls: z.array(z.object({
    opId: z.string().min(1).max(100),
    token: z.string().max(2000).optional(),
    plate: z.string().max(20).optional(),
    controlledAt: z.string().datetime({ offset: true }),
    place: placeSchema,
    offlineResult: z.enum(['VALIDE', 'INVALIDE', 'EXPIRE']),
  }).strict()).max(500),
}).strict();

export interface PurchaseItemInput {
  typeCode: string;
  holderTaxpayerId?: string;
  subject: CredentialSubject;
  place: CredentialPlace;
  requestedStart?: string;
  durationMinutes?: number;
  eventStart?: string;
  eventEnd?: string;
  renewsId?: string;
  autoRenewConsent?: boolean;
}

export interface PurchaseInput {
  payerTaxpayerId: string;
  channel: PaymentChannel;
  items: PurchaseItemInput[];
  groupPayer?: Issuance['groupPayer'];
  context?: string;
}

export interface ControlInput {
  qr?: string;
  plate?: string;
  code?: string;
  place: UsePlace & { commune?: string };
  deviceId?: string;
  module?: string;
}

export interface MinimalControlView {
  controlId: string;
  result: ControlResult;
  status: DisplayStatus | 'INCONNU';
  color: string;
  icon: string;
  signal: string;
  text: string;
  remainingSeconds?: number;
  serverTime: string;
  module?: string;
  typeLabel?: string;
  prefix?: string;
  plate?: string;
  zone?: string;
  alreadyUsed?: { at: string; place: UsePlace };
  /** Un titre valide n'a rien à payer : aucune référence de paiement ni constat ne peut être produit. */
  nothingToPay: boolean;
  constat?: { id: string; notice: string };
  method: ControlMethod;
  offline: false;
}

/** Plaque normalisée : majuscules, sans espaces ni tirets. */
export function normalizePlate(p: string): string {
  return p.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

function kinshasaTime(iso: string): string {
  const d = new Date(new Date(iso).getTime() + KINSHASA_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export class TitresService {
  readonly types = new InMemoryRepository<CredentialType>();
  readonly credentials = new InMemoryRepository<Credential>();
  readonly issuances = new InMemoryRepository<Issuance>();
  readonly controls = new InMemoryAppendOnlyRepository<VerificationEvent>();
  readonly usages = new InMemoryAppendOnlyRepository<UsageEvent>();
  readonly constats = new InMemoryRepository<Constat>();
  readonly revocations = new InMemoryAppendOnlyRepository<Revocation>();
  readonly signer = new TokenSigner();
  private readonly ids = new IdGenerator();
  private readonly offlineBatches = new Map<string, { fingerprint: string; result: unknown }>();
  private readonly devicePackAt = new Map<string, string>();
  /** Période de grâce (J28) par module : les constats y sont marqués « pédagogiques ». */
  readonly gracePeriods = new Map<string, string>();
  /** Écouteurs des modules clients (ex. RakaPay) appelés à chaque émission de titre. */
  private readonly issuedListeners: ((c: Credential) => void)[] = [];

  constructor(private readonly ctx: AppContext) {}

  onIssued(fn: (c: Credential) => void): void {
    this.issuedListeners.push(fn);
  }

  /** Compte technique de liquidation d'un tarif PUBLIÉ (aucune décision : application déterministe d'une règle ACTIVE). */
  private liquidator(entity: string): User {
    return { kind: 'user', id: 'systeme-titres', name: 'Moteur de titres — liquidation d’un tarif publié', roles: ['R11'], entity };
  }

  private actor(user: User) {
    return { kind: 'user' as const, id: user.id, roles: user.roles };
  }

  // ------------------------------------------------------------------ Types de titres (fiche de configuration)

  defineType(input: Omit<CredentialType, 'id' | 'version' | 'createdAt' | 'createdBy'>, by = 'configuration-module'): CredentialType {
    if (!/^[A-Z]{2,4}$/.test(input.prefix)) throw badRequest('INVALID_PREFIX', 'Préfixe de code : 2 à 4 lettres majuscules.');
    const clash = this.types.findOne((t) => t.prefix === input.prefix && t.code !== input.code && t.module !== input.module);
    if (clash) throw conflict('PREFIX_IN_USE', `Préfixe ${input.prefix} déjà utilisé par le type ${clash.code}.`);
    const previous = this.types.find((t) => t.code === input.code).sort((a, b) => b.version - a.version)[0];
    const version = (previous?.version ?? 0) + 1;
    const t = this.types.insert({ ...structuredClone(input), id: `ctype-${input.code.toLowerCase()}-v${version}`, version, createdAt: this.ctx.clock.now().toISOString(), createdBy: by });
    this.ctx.audit.append({ actor: { kind: 'system', id: by }, action: 'titres.type.defined', resourceType: 'credential_type', resourceId: t.id, details: { code: t.code, version, model: t.validity.model, legalAct: t.legalAct } });
    return t;
  }

  type(code: string): CredentialType {
    const t = this.types.find((x) => x.code === code).sort((a, b) => b.version - a.version)[0];
    if (!t) throw notFound('CREDENTIAL_TYPE_NOT_FOUND', `Type de titre inconnu : ${code}`);
    return t;
  }

  private activeRule(ruleCode: string) {
    this.ctx.rules.refresh();
    const versions = this.ctx.rules.rules.find((r) => r.code === ruleCode).sort((a, b) => b.version - a.version);
    return versions.find((r) => r.status === 'ACTIVE') ?? versions[0];
  }

  /** Un type n'est activable qu'avec une référence d'acte (J21) et une règle de tarif ACTIVE du registre. */
  activation(t: CredentialType): { ok: true } | { ok: false; reason: string } {
    if (t.legalAct.status === 'ACTE_REQUIS') return { ok: false, reason: `Acte requis (${t.legalAct.ref}) : type non activable.` };
    if (!t.pricing) return { ok: false, reason: 'Aucune règle de tarif associée.' };
    const rule = this.activeRule(t.pricing.ruleCode);
    if (!rule) return { ok: false, reason: `Règle ${t.pricing.ruleCode} absente du registre.` };
    if (rule.status !== 'ACTIVE') return { ok: false, reason: `Règle ${rule.code} au statut ${rule.status}.` };
    return { ok: true };
  }

  /** Tarif unitaire affiché : calculé par la formule de la règle du registre (jamais saisi). */
  pricePreview(t: CredentialType, quantity = 1): { amount: MoneyJSON | null; ruleCode: string | null; ruleVersion: number | null; demo: boolean; executable: boolean; reason?: string } {
    if (!t.pricing) return { amount: null, ruleCode: null, ruleVersion: null, demo: t.demo, executable: false, reason: 'Aucune règle de tarif.' };
    const rule = this.activeRule(t.pricing.ruleCode);
    const act = this.activation(t);
    if (!rule) return { amount: null, ruleCode: t.pricing.ruleCode, ruleVersion: null, demo: t.demo, executable: false, reason: act.ok ? undefined : act.reason };
    const inputs = Object.fromEntries(Object.entries(t.pricing.inputs).map(([k, v]) => [k, Money.of(v, 'CDF').multiply(String(quantity)).toDecimalString()]));
    try {
      const ev = this.ctx.rules.evaluate(rule, inputs, 3);
      return {
        amount: Money.of(ev.value, rule.currency, rule.rounding).toJSON(), ruleCode: rule.code, ruleVersion: rule.version,
        demo: t.demo || !!(rule as { demo?: boolean }).demo, executable: act.ok, ...(act.ok ? {} : { reason: act.reason }),
      };
    } catch {
      return { amount: null, ruleCode: rule.code, ruleVersion: rule.version, demo: t.demo, executable: false, reason: 'Formule non évaluable.' };
    }
  }

  typeView(t: CredentialType) {
    const act = this.activation(t);
    return {
      code: t.code, version: t.version, module: t.module, moduleLabel: t.moduleLabel, label: t.label, prefix: t.prefix, entity: t.entity,
      validity: { ...t.validity, modelLabel: VALIDITY_MODEL_LABELS[t.validity.model].label, modelRule: VALIDITY_MODEL_LABELS[t.validity.model].rule, timezone: 'Africa/Kinshasa' },
      transferable: t.transferable, plateBound: t.plateBound, supports: t.supports, legalAct: t.legalAct, demo: t.demo,
      activable: act.ok, ...(act.ok ? {} : { notActivableReason: act.reason }), price: this.pricePreview(t),
    };
  }

  // ------------------------------------------------------------------ Commande et paiement (circuit commun)

  /** Objet de rattachement (point de service) du payeur dans la commune du fait générateur. */
  private serviceObject(payerTaxpayerId: string, place: CredentialPlace): string {
    const key = `${place.sourceId}`;
    const existing = this.ctx.objects.objects.findOne((o) => o.taxpayerId === payerTaxpayerId && o.attributes.titresPlaceKey === key);
    if (existing) return existing.id;
    if (!place.commune || !isCommune(place.commune)) throw unprocessable('PLACE_WITHOUT_COMMUNE', 'Le lieu du service doit être rattaché à une commune de Kinshasa (localisation obligatoire).');
    const obj = this.ctx.objects.objects.insert({
      id: this.ids.next('OBJ-TIT'), taxpayerId: payerTaxpayerId, category: 'AUTRE', commune: place.commune, quartier: place.label,
      localityRank: 3, lat: place.lat ?? 0, lon: place.lon ?? 0,
      attributes: { titresPlaceKey: key, nature: 'Point de service d’un titre (station, zone, lieu)', lieu: place.label, basis: place.basis },
      observed: {}, status: 'VALIDE', probativeStatus: 'DECLARE', createdBy: 'systeme-titres', createdAt: this.ctx.clock.now().toISOString(),
    });
    this.ctx.audit.append({ actor: { kind: 'system', id: 'systeme-titres' }, action: 'object.declared', resourceType: 'fiscal_object', resourceId: obj.id, details: { category: 'AUTRE', commune: obj.commune, placeKey: key } });
    return obj.id;
  }

  /** Titre courant ou futur de même type-famille (même module) pour le même sujet lié à la plaque. */
  private latestForSubject(module: string, subject: CredentialSubject): Credential | undefined {
    if (!subject.plate) return undefined;
    const plate = normalizePlate(subject.plate);
    return this.credentials
      .find((c) => c.module === module && c.subject.plate !== undefined && normalizePlate(c.subject.plate) === plate && c.state === 'EMIS')
      .sort((a, b) => b.validUntil.localeCompare(a.validUntil))[0];
  }

  purchase(user: User, input: PurchaseInput): Issuance {
    this.sync();
    if (input.items.length === 0) throw badRequest('NO_ITEMS', 'Aucun titre demandé.');
    if (input.items.length > 200) throw badRequest('TOO_MANY_ITEMS', 'Au plus 200 titres par commande.');
    authorize(user, 'titres:purchase', { taxpayerId: input.payerTaxpayerId });
    this.ctx.taxpayers.get(input.payerTaxpayerId);
    const types = input.items.map((i) => this.type(i.typeCode));
    const ruleCodes = new Set(types.map((t) => t.pricing?.ruleCode ?? ''));
    if (ruleCodes.size !== 1) throw unprocessable('MIXED_PRICING_RULES', 'Une commande groupée ne peut réunir que des titres tarifés par la même règle.');
    for (const t of types) {
      const act = this.activation(t);
      if (!act.ok) {
        this.ctx.audit.append({ actor: this.actor(user), action: 'titres.issuance.refused', resourceType: 'credential_type', resourceId: t.code, outcome: 'DENIED', details: { reason: act.reason } });
        throw unprocessable('CREDENTIAL_TYPE_NOT_ACTIVABLE', act.reason);
      }
    }
    // Un pass lié à une plaque : aucune commande en attente en double pour le même sujet.
    const pending = this.issuances.find((i) => i.status === 'EN_ATTENTE_PAIEMENT' || i.status === 'PARTIELLEMENT_EMISE');
    const seen = new Set<string>();
    input.items.forEach((item, idx) => {
      const t = types[idx]!;
      if (t.plateBound && !item.subject.plate) throw badRequest('PLATE_REQUIRED', `Le type ${t.code} est lié à une plaque.`);
      if (!item.place.commune) throw unprocessable('PLACE_WITHOUT_COMMUNE', 'Localisation obligatoire : commune du lieu de service.');
      if (item.subject.plate) {
        const k = `${t.module}|${normalizePlate(item.subject.plate)}`;
        if (seen.has(k)) throw conflict('DUPLICATE_SUBJECT', `La plaque ${item.subject.plate} figure deux fois dans la commande.`);
        seen.add(k);
        const dup = pending.find((i) => i.items.some((it, j) => !it.credentialId && it.subject.plate && normalizePlate(it.subject.plate) === normalizePlate(item.subject.plate!) && this.type(i.items[j]!.typeCode).module === t.module));
        if (dup) throw conflict('PENDING_PURCHASE_EXISTS', `Une commande en attente de paiement existe déjà pour la plaque ${item.subject.plate}.`, { issuanceId: dup.id });
      }
      if (item.renewsId) {
        const prev = this.credential(item.renewsId);
        if (prev.typeCode.split('-')[0] !== t.code.split('-')[0] && prev.module !== t.module) throw unprocessable('RENEWAL_TYPE_MISMATCH', 'Renouvellement d’un titre d’un autre module.');
        if (prev.subject.plate && item.subject.plate && normalizePlate(prev.subject.plate) !== normalizePlate(item.subject.plate)) {
          throw unprocessable('NOT_TRANSFERABLE', 'Titre non transférable : le renouvellement porte sur la même plaque.');
        }
      }
      if (t.validity.startMode === 'PAIEMENT' && item.requestedStart) throw badRequest('START_NOT_CHOOSABLE', `Le type ${t.code} commence au paiement.`);
    });

    const now = this.ctx.clock.now();
    const issuanceId = this.ids.next('CMD-TIT');
    const items: IssuanceItem[] = input.items.map((i) => ({ ...structuredClone(i) }));
    // Une obligation (et une référence) par commune du fait générateur : la recette reste attribuée au bon lieu (§ 20.3).
    const groups = new Map<string, number[]>();
    items.forEach((it, idx) => {
      const k = it.place.commune!;
      groups.set(k, [...(groups.get(k) ?? []), idx]);
    });
    const payments: IssuancePayment[] = [];
    const created: { obligationId: string; ledgerEntryId?: string }[] = [];
    try {
      for (const [commune, idxs] of groups) {
        const first = items[idxs[0]!]!;
        const firstType = types[idxs[0]!]!;
        const rule = this.activeRule(firstType.pricing!.ruleCode)!;
        const inputs: Record<string, Money> = {};
        for (const i of idxs) {
          for (const [k, v] of Object.entries(types[i]!.pricing!.inputs)) inputs[k] = (inputs[k] ?? Money.of('0', 'CDF')).add(Money.of(v, 'CDF'));
        }
        const objectId = this.serviceObject(input.payerTaxpayerId, first.place);
        const res = this.ctx.assessment.calculate(this.liquidator(rule.administeringEntity), {
          ruleId: rule.id, taxpayerId: input.payerTaxpayerId, objectId, simulate: false,
          inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.toDecimalString()])),
        });
        const obligation = res.obligation!;
        created.push({ obligationId: obligation.id, ...(obligation.ledgerEntryId ? { ledgerEntryId: obligation.ledgerEntryId } : {}) });
        const order = this.ctx.payments.createOrder(user, obligation.id, { channel: input.channel });
        payments.push({
          commune, obligationId: obligation.id, paymentOrderId: order.id, paymentReference: order.paymentReference, amount: order.amount,
          expiresAt: order.expiresAt, status: 'EN_ATTENTE',
        });
        for (const i of idxs) items[i]!.paymentOrderId = order.id;
      }
    } catch (e) {
      for (const c of created) this.cancelObligation(c.obligationId, 'Commande de titre interrompue avant émission de la référence', user.id);
      throw e;
    }
    const issuance = this.issuances.insert({
      id: issuanceId, status: 'EN_ATTENTE_PAIEMENT', payerTaxpayerId: input.payerTaxpayerId, requestedBy: user.id, channel: input.channel,
      ...(input.groupPayer ? { groupPayer: input.groupPayer } : {}), items, payments, createdAt: now.toISOString(), ...(input.context ? { context: input.context } : {}),
    });
    this.ctx.audit.append({
      actor: this.actor(user), action: 'titres.issuance.created', resourceType: 'credential_issuance', resourceId: issuance.id,
      details: { items: items.length, types: [...new Set(items.map((i) => i.typeCode))], references: payments.map((p) => p.paymentReference), groupPayer: input.groupPayer?.id ?? null },
    });
    return issuance;
  }

  /** Annule l'obligation d'une commande non payée (aucun service rendu) : contre-écriture de la créance, tracée. */
  private cancelObligation(obligationId: string, reason: string, by: string): void {
    const o = this.ctx.assessment.obligations.get(obligationId);
    if (!o || o.status === 'ANNULEE') return;
    if (o.ledgerEntryId && !this.ctx.ledger.isReversed(o.ledgerEntryId)) {
      this.ctx.ledger.reverse(o.ledgerEntryId, reason, { kind: 'system', id: 'systeme-titres' });
    }
    this.ctx.assessment.setStatus(obligationId, 'ANNULEE');
    this.ctx.audit.append({ actor: { kind: 'system', id: 'systeme-titres' }, action: 'titres.issuance.obligation_cancelled', resourceType: 'obligation', resourceId: obligationId, details: { reason, requestedBy: by } });
  }

  /** Annulation par l'acheteur d'une commande encore non payée. */
  cancelIssuance(user: User, id: string): Issuance {
    this.sync();
    const iss = this.issuance(id);
    authorize(user, 'titres:purchase', { taxpayerId: iss.payerTaxpayerId });
    if (iss.status !== 'EN_ATTENTE_PAIEMENT') throw conflict('ISSUANCE_NOT_PENDING', `Commande au statut ${iss.status} : annulation impossible.`);
    for (const p of iss.payments) {
      const order = this.ctx.payments.orders.get(p.paymentOrderId);
      if (order && order.status !== 'INITIE') throw conflict('PAYMENT_ALREADY_RECEIVED', 'Un paiement a déjà été reçu : la commande ne peut plus être annulée.');
    }
    for (const p of iss.payments) this.cancelObligation(p.obligationId, 'Commande de titre annulée par l’acheteur avant paiement', user.id);
    const updated = this.issuances.update({ ...iss, status: 'ANNULEE', payments: iss.payments.map((p) => ({ ...p, status: 'EXPIRE' as const })) });
    this.ctx.audit.append({ actor: this.actor(user), action: 'titres.issuance.cancelled', resourceType: 'credential_issuance', resourceId: id });
    return updated;
  }

  issuance(id: string): Issuance {
    const i = this.issuances.get(id);
    if (!i) throw notFound('ISSUANCE_NOT_FOUND', `Commande de titre inconnue : ${id}`);
    return i;
  }

  // ------------------------------------------------------------------ Synchronisation avec le circuit de paiement

  /**
   * Rapproche les commandes et le circuit commun (idempotent, appelé à chaque lecture) :
   * ordre CONFIRME + quittance ⇒ titres émis ; ordre échoué ou référence expirée ⇒ commande close, obligation annulée ;
   * paiement contrepassé ou quittance annulée ⇒ titre révoqué (ARB-22) ; phase ambre ⇒ rappel unique.
   */
  sync(): void {
    const now = this.ctx.clock.now();
    for (const iss of this.issuances.find((i) => i.status === 'EN_ATTENTE_PAIEMENT' || i.status === 'PARTIELLEMENT_EMISE')) {
      let changed = false;
      const payments = iss.payments.map((p) => ({ ...p }));
      const items = iss.items.map((it) => ({ ...it }));
      for (const p of payments) {
        if (p.status !== 'EN_ATTENTE') continue;
        const order = this.ctx.payments.orders.get(p.paymentOrderId);
        if (!order) continue;
        if (PAID_STATUSES.includes(order.status)) {
          const receipt = this.ctx.receipts.byPaymentOrder(order.id);
          if (!receipt) continue;
          p.status = 'PAYE';
          changed = true;
          for (const it of items) {
            if (it.paymentOrderId !== order.id || it.credentialId) continue;
            const c = this.issueCredential(iss, it, order, receipt);
            it.credentialId = c.id;
          }
        } else if (order.status === 'ECHOUE') {
          p.status = 'ECHOUE';
          changed = true;
          this.cancelObligation(p.obligationId, 'Paiement échoué : commande de titre close', 'systeme-titres');
        } else if (order.status === 'INITIE' && new Date(order.expiresAt) < now) {
          p.status = 'EXPIRE';
          changed = true;
          this.cancelObligation(p.obligationId, 'Référence de paiement expirée sans paiement : commande de titre close', 'systeme-titres');
        }
      }
      if (changed) {
        const paid = payments.filter((p) => p.status === 'PAYE').length;
        const open = payments.filter((p) => p.status === 'EN_ATTENTE').length;
        const status: Issuance['status'] = open > 0 ? (paid > 0 ? 'PARTIELLEMENT_EMISE' : 'EN_ATTENTE_PAIEMENT') : paid === payments.length ? 'EMISE' : paid > 0 ? 'PARTIELLEMENT_EMISE' : 'EXPIREE';
        this.issuances.update({ ...iss, payments, items, status });
      }
    }
    for (const c of this.credentials.find((x) => x.state === 'EMIS' || x.state === 'SUSPENDU')) {
      const order = c.paymentOrderId ? this.ctx.payments.orders.get(c.paymentOrderId) : undefined;
      const receipts = c.receiptIds.map((id) => this.ctx.receipts.receipts.get(id));
      if ((order && (order.status === 'CONTREPASSE' || order.status === 'REMBOURSE')) || receipts.some((r) => r && r.status === 'ANNULEE')) {
        this.setState(c, 'REVOQUE', 'Paiement contrepassé ou quittance annulée (ARB-22)', 'systeme-titres');
        continue;
      }
      if (c.state === 'EMIS' && !c.amberNotifiedAt && statusAt(c, now).status === 'BIENTOT_EXPIRE' && c.holderTaxpayerId) {
        this.credentials.update({ ...c, amberNotifiedAt: now.toISOString() });
        const tp = this.ctx.taxpayers.taxpayers.get(c.holderTaxpayerId);
        if (tp) this.ctx.comms.publish('ticket.expiring', [taxpayerRecipient(tp)], { titre: c.number, heure: kinshasaTime(c.validUntil), reference: c.number }, { entity: c.entity });
        this.ctx.audit.append({ actor: { kind: 'system', id: 'systeme-titres' }, action: 'titres.credential.amber_reminder', resourceType: 'credential', resourceId: c.id });
      }
    }
  }

  private newShortCode(prefix: string): string {
    for (;;) {
      const core = randomCode(6);
      const code = `${prefix}${core}${checkChar(core)}`;
      if (!this.credentials.findOne((c) => c.shortCode === code)) return code;
    }
  }

  private issueCredential(
    iss: Issuance, item: IssuanceItem,
    order: { id: string; paymentReference: string; obligationId: string; amount: MoneyJSON },
    receipt: { id: string; number: string },
  ): Credential {
    const t = this.type(item.typeCode);
    const now = this.ctx.clock.now().getTime();
    let start = now;
    if (item.requestedStart) start = Math.max(start, new Date(item.requestedStart).getTime());
    const prev = item.renewsId ? this.credentials.get(item.renewsId) : this.latestForSubject(t.module, item.subject);
    // Renouvellement : continuité, le nouveau titre commence à la fin du précédent s'il est encore valide.
    if (prev && prev.state === 'EMIS') start = Math.max(start, new Date(prev.validUntil).getTime() + 1);
    const w = computeWindow(t.validity, {
      start, ...(item.durationMinutes ? { durationMinutes: item.durationMinutes } : {}),
      ...(item.eventStart ? { eventStart: item.eventStart } : {}), ...(item.eventEnd ? { eventEnd: item.eventEnd } : {}),
    });
    const year = new Date(now).getUTCFullYear();
    const id = this.ids.next('TIT');
    const number = `${t.prefix}-${year}-${id.slice(4)}`;
    const validFrom = new Date(w.from).toISOString();
    const validUntil = new Date(w.until).toISOString();
    const staticToken = this.signer.signStatic({
      v: 1, id, n: number, ty: t.code, px: t.prefix, f: validFrom, u: validUntil, p: item.subject.plate ? normalizePlate(item.subject.plate) : null,
    });
    const nowIso = new Date(now).toISOString();
    const unit = this.pricePreview(t).amount;
    const c = this.credentials.insert({
      id, number, shortCode: this.newShortCode(t.prefix), typeCode: t.code, typeVersion: t.version, module: t.module, entity: t.entity,
      model: t.validity.model,
      ...(item.holderTaxpayerId ? { holderTaxpayerId: item.holderTaxpayerId } : {}),
      payerTaxpayerId: iss.payerTaxpayerId, subject: item.subject, place: item.place,
      attribution: { commune: item.place.commune, basis: item.place.basis, sourceId: item.place.sourceId, attributedAt: nowIso },
      validFrom, validUntil, toleranceMinutes: t.validity.toleranceMinutes, amberMinutes: t.validity.amberMinutes,
      ...(w.uses !== undefined ? { usesTotal: w.uses, usesLeft: w.uses } : {}),
      ...(t.validity.model === 'GLISSANT_CONDITIONNEL' ? { conditionMet: true } : {}),
      ...(t.validity.model === 'ABONNEMENT' ? { autoRenew: { consent: !!item.autoRenewConsent, ...(item.autoRenewConsent ? { consentAt: nowIso } : {}) } } : {}),
      state: 'EMIS', receiptIds: [receipt.id], receiptNumbers: [receipt.number], paymentOrderId: order.id, paymentReference: order.paymentReference,
      obligationId: order.obligationId, issuanceId: iss.id, ...(prev ? { renewsId: prev.id } : {}), ...(unit ? { amount: unit } : {}),
      staticToken, issuedAt: nowIso, demo: t.demo,
    });
    this.ctx.audit.append({
      actor: { kind: 'system', id: 'systeme-titres' }, action: 'titres.credential.issued', resourceType: 'credential', resourceId: c.id,
      details: { number, typeCode: t.code, receipt: receipt.number, paymentReference: order.paymentReference, validFrom, validUntil, commune: c.attribution.commune, basis: c.attribution.basis, renewsId: prev?.id ?? null },
    });
    const recipients = [...new Set([c.holderTaxpayerId, iss.payerTaxpayerId].filter((x): x is string => !!x))]
      .map((tid) => this.ctx.taxpayers.taxpayers.get(tid)).filter((x): x is NonNullable<typeof x> => !!x).map(taxpayerRecipient);
    this.ctx.comms.publish('ticket.purchased', recipients, { titre: number, heure: kinshasaTime(validUntil), reference: number }, { entity: t.entity });
    for (const fn of this.issuedListeners) fn(c);
    return c;
  }

  /**
   * Émission au guichet ou chez un point agréé sur une quittance EXISTANTE (POST /v1/titres) : la quittance doit porter
   * sur la règle de tarif du type, ne jamais avoir servi, et le montant couvrir le tarif d'une unité.
   */
  issueOnReceipt(user: User, input: { typeCode: string; receiptNumber: string; subject: CredentialSubject; place: CredentialPlace; holderTaxpayerId?: string }): Credential {
    authorize(user, 'titres:issue.receipt');
    this.sync();
    const t = this.type(input.typeCode);
    const act = this.activation(t);
    if (!act.ok) throw unprocessable('CREDENTIAL_TYPE_NOT_ACTIVABLE', act.reason);
    const receipt = this.ctx.receipts.receipts.findOne((r) => r.number === input.receiptNumber || r.code === input.receiptNumber);
    if (!receipt) throw notFound('RECEIPT_NOT_FOUND', 'Quittance inconnue.');
    if (receipt.status !== 'PROVISOIRE' && receipt.status !== 'DEFINITIVE') throw unprocessable('RECEIPT_NOT_VALID', `Quittance au statut ${receipt.status}.`);
    if (this.credentials.findOne((c) => c.receiptIds.includes(receipt.id))) throw conflict('RECEIPT_ALREADY_USED', 'Cette quittance adosse déjà un titre.');
    const obligation = this.ctx.assessment.get(receipt.obligationId);
    if (obligation.ruleCode !== t.pricing?.ruleCode) throw unprocessable('RECEIPT_RULE_MISMATCH', 'La quittance ne porte pas sur la règle de tarif de ce type de titre.');
    const unit = this.pricePreview(t).amount;
    if (!unit || Money.fromJSON(receipt.amount).compare(Money.fromJSON(unit)) < 0) throw unprocessable('RECEIPT_AMOUNT_INSUFFICIENT', 'Le montant de la quittance ne couvre pas le tarif du titre.');
    if (t.plateBound && !input.subject.plate) throw badRequest('PLATE_REQUIRED', `Le type ${t.code} est lié à une plaque.`);
    const order = this.ctx.payments.orders.get(receipt.paymentOrderId)!;
    const iss = this.issuances.insert({
      id: this.ids.next('CMD-TIT'), status: 'EMISE', payerTaxpayerId: receipt.taxpayerId, requestedBy: user.id, channel: order.channel,
      items: [{ typeCode: t.code, subject: input.subject, place: input.place, paymentOrderId: order.id, ...(input.holderTaxpayerId ? { holderTaxpayerId: input.holderTaxpayerId } : {}) }],
      payments: [{ commune: input.place.commune, obligationId: obligation.id, paymentOrderId: order.id, paymentReference: order.paymentReference, amount: order.amount, expiresAt: order.expiresAt, status: 'PAYE' }],
      createdAt: this.ctx.clock.now().toISOString(), context: 'EMISSION_SUR_QUITTANCE',
    });
    const c = this.issueCredential(iss, iss.items[0]!, order, receipt);
    this.issuances.update({ ...iss, items: [{ ...iss.items[0]!, credentialId: c.id }] });
    this.ctx.audit.append({ actor: this.actor(user), action: 'titres.credential.issued_on_receipt', resourceType: 'credential', resourceId: c.id, details: { receipt: receipt.number } });
    return c;
  }

  // ------------------------------------------------------------------ Lectures

  credential(id: string): Credential {
    const c = this.credentials.get(id) ?? this.credentials.findOne((x) => x.number === id || x.shortCode === id);
    if (!c) throw notFound('CREDENTIAL_NOT_FOUND', `Titre inconnu : ${id}`);
    return c;
  }

  status(c: Credential): StatusView {
    return statusAt(c, this.ctx.clock.now());
  }

  /** Vue du titulaire (ou d'un agent habilité) : complète, sans le secret dynamique. */
  holderView(c: Credential) {
    const t = this.types.findOne((x) => x.code === c.typeCode && x.version === c.typeVersion);
    return {
      id: c.id, number: c.number, shortCode: c.shortCode, typeCode: c.typeCode, typeLabel: t?.label ?? c.typeCode, prefix: t?.prefix, module: c.module,
      entity: c.entity, model: c.model, modelLabel: VALIDITY_MODEL_LABELS[c.model].label, subject: c.subject, place: c.place, attribution: c.attribution,
      validFrom: c.validFrom, validUntil: c.validUntil, toleranceMinutes: c.toleranceMinutes, amberMinutes: c.amberMinutes,
      usesTotal: c.usesTotal, usesLeft: c.usesLeft, conditionMet: c.conditionMet, autoRenew: c.autoRenew,
      state: c.state, stateReason: c.stateReason, receiptNumbers: c.receiptNumbers, paymentReference: c.paymentReference, amount: c.amount,
      renewsId: c.renewsId, replacesId: c.replacesId, replacedById: c.replacedById, firstUse: c.firstUse, staticToken: c.staticToken,
      issuedAt: c.issuedAt, demo: c.demo, transferable: t?.transferable ?? false, status: this.status(c),
    };
  }

  byHolder(taxpayerId: string): Credential[] {
    return this.credentials.find((c) => c.holderTaxpayerId === taxpayerId || c.payerTaxpayerId === taxpayerId).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  }

  /** Le demandeur peut-il voir ce titre (titulaire, payeur, mandataire, agent habilité de l'entité) ? */
  assertCanRead(user: User, c: Credential): void {
    const own = [c.holderTaxpayerId, c.payerTaxpayerId].some((tid) => tid && evaluate(user, 'titres:read.own', { taxpayerId: tid }));
    if (own) return;
    authorize(user, 'titres:read.any', { entity: c.entity });
  }

  /** QR dynamique (titulaire seulement) : jeton de la fenêtre courante de 30 s. */
  dynamicQr(user: User, id: string) {
    this.sync();
    const c = this.credential(id);
    const holder = c.holderTaxpayerId ?? c.payerTaxpayerId;
    authorize(user, 'titres:read.own', { taxpayerId: holder });
    const now = this.ctx.clock.now();
    const d = this.signer.dynamicFor(c.id, now.getTime());
    return { ...d, windowSeconds: DYNAMIC_WINDOW_SECONDS, number: c.number, prefix: c.number.split('-')[0], validUntil: c.validUntil, status: this.status(c), serverTime: now.toISOString() };
  }

  // ------------------------------------------------------------------ Contrôle en ligne

  private controlResource(user: User, place: ControlInput['place']): Resource {
    if (place.commune !== undefined && !isCommune(place.commune)) throw badRequest('UNKNOWN_COMMUNE', `Commune inconnue : ${place.commune}`);
    if (user.territory && !place.commune) throw badRequest('CONTROL_COMMUNE_REQUIRED', 'Commune du lieu de contrôle requise pour un agent à périmètre territorial.');
    return { communes: place.commune ? [place.commune] : [] };
  }

  /** Résout ce qui est présenté (QR dynamique, QR statique, code court). */
  resolvePresented(presented: string, now: number): { credential?: Credential; method: ControlMethod; failure?: string } {
    const p = presented.trim();
    if (p.startsWith('MD1.')) {
      const r = this.signer.verifyDynamic(p, now);
      if (!r.ok) {
        return {
          method: 'QR_DYNAMIQUE',
          failure: r.reason === 'FENETRE_EXPIREE' ? 'QR dynamique périmé (capture d’écran ou code copié)' : 'QR dynamique non authentique',
        };
      }
      const c = this.credentials.get(r.credentialId);
      return c ? { credential: c, method: 'QR_DYNAMIQUE' } : { method: 'QR_DYNAMIQUE', failure: 'Titre inconnu' };
    }
    if (p.startsWith('MT1.')) {
      const payload = this.signer.verifyStatic(p);
      if (!payload || typeof payload.id !== 'string') return { method: 'QR_STATIQUE', failure: 'QR non authentique (signature invalide)' };
      const c = this.credentials.get(payload.id);
      return c ? { credential: c, method: 'QR_STATIQUE' } : { method: 'QR_STATIQUE', failure: 'Titre inconnu' };
    }
    const c = this.credentials.findOne((x) => x.shortCode === p.toUpperCase() || x.number === p.toUpperCase());
    return c ? { credential: c, method: 'CODE_COURT' } : { method: 'CODE_COURT', failure: 'Aucun titre ne correspond' };
  }

  /** Titres d'une plaque (tous états), les plus favorables d'abord. */
  byPlate(plate: string, module?: string): Credential[] {
    const n = normalizePlate(plate);
    const rank: Record<DisplayStatus, number> = { VALIDE: 0, BIENTOT_EXPIRE: 1, PAS_ENCORE_ACTIF: 2, SUSPENDU: 3, EXPIRE: 4, INVALIDE: 5 };
    const now = this.ctx.clock.now();
    return this.credentials
      .find((c) => !!c.subject.plate && normalizePlate(c.subject.plate) === n && (!module || c.module === module))
      .sort((a, b) => rank[statusAt(a, now).status] - rank[statusAt(b, now).status] || b.validUntil.localeCompare(a.validUntil));
  }

  /** GET /v1/vehicules/{plaque}/titres — contrôleur, journalisé, réponse minimale. */
  listPlate(user: User, plate: string, module?: string, commune?: string) {
    authorize(user, 'titres:control', this.controlResource(user, { ...(commune ? { commune } : {}) }));
    this.sync();
    const items = this.byPlate(plate, module).filter((c) => c.state !== 'REMPLACE');
    this.ctx.audit.append({ actor: this.actor(user), action: 'titres.plate.consulted', resourceType: 'plate', resourceId: normalizePlate(plate), details: { module: module ?? null, found: items.length } });
    return {
      plate: normalizePlate(plate), serverTime: this.ctx.clock.now().toISOString(),
      credentials: items.slice(0, 20).map((c) => {
        const s = this.status(c);
        const t = this.types.findOne((x) => x.code === c.typeCode);
        return { number: c.number, module: c.module, typeLabel: t?.label ?? c.typeCode, prefix: t?.prefix, validFrom: c.validFrom, validUntil: c.validUntil, zone: c.place.label, ...s, result: controlResultOf(s.status) };
      }),
    };
  }

  /**
   * Contrôle d'un titre (déjà résolu ou non) : journal (qui, où, quand, résultat), consommation d'usage,
   * constat si négatif. Utilisé par la route générique et par les modules (gilet wewa…).
   */
  recordControl(user: User, input: {
    credential?: Credential; method: ControlMethod; presented: string; place: ControlInput['place']; deviceId?: string; failure?: string;
    /** Module contrôlé (si aucun titre n'est trouvé, le constat reste rattaché au module). */
    module?: string;
    offline?: { at: string; batchId: string; offlineResult: ControlResult };
  }): { event: VerificationEvent; status?: StatusView; constat?: Constat } {
    const nowIso = this.ctx.clock.now().toISOString();
    const at = input.offline?.at ?? nowIso;
    const atDate = new Date(at);
    let c = input.credential;
    let status: StatusView | undefined;
    let consumed = false;
    let alreadyUsed: VerificationEvent['alreadyUsed'];
    let reason = input.failure;
    if (c) {
      status = statusAt(c, atDate);
      if (c.state === 'CONSOMME' && c.firstUse) alreadyUsed = { at: c.firstUse.at, place: c.firstUse.place };
      if ((c.model === 'USAGE_UNIQUE' || c.model === 'CARNET_USAGES') && controlResultOf(status.status) === 'VALIDE' && (c.usesLeft ?? 0) > 0) {
        const left = (c.usesLeft ?? 1) - 1;
        consumed = true;
        c = this.credentials.update({
          ...c, usesLeft: left,
          ...(left === 0 ? { state: 'CONSOMME' as const, stateAt: at, stateReason: c.model === 'USAGE_UNIQUE' ? 'Usage unique consommé' : 'Carnet épuisé', stateBy: user.id } : {}),
          ...(c.firstUse ? {} : { firstUse: { at, place: input.place, controlId: '' } }),
        });
      }
      if (status.status === 'INVALIDE' && status.invalidReason === 'DEJA_UTILISE') {
        reason = 'Titre à usage unique déjà utilisé';
        this.ctx.alerts.raise({
          type: 'CREDENTIAL_REUSE_ATTEMPT', severity: 'MEDIUM', source: 'titres',
          detail: `Titre à usage unique ${c.number} présenté de nouveau${input.offline ? ' (contrôle hors ligne réconcilié)' : ''}.`,
          context: { credentialId: c.id, firstUse: c.firstUse, at }, actor: { kind: 'user', id: user.id, roles: user.roles },
        });
      } else if (status.status !== 'VALIDE' && status.status !== 'BIENTOT_EXPIRE') {
        reason = reason ?? status.text;
      }
    }
    const result: ControlResult = status ? controlResultOf(status.status) : 'INVALIDE';
    const event = this.controls.append({
      id: this.ids.next('CTL'), ...(c ? { credentialId: c.id, typeCode: c.typeCode, module: c.module } : input.module ? { module: input.module } : {}), method: input.method,
      presented: input.method === 'PLAQUE' ? normalizePlate(input.presented) : sha256Hex(input.presented).slice(0, 16),
      controllerId: user.id, ...(input.deviceId ? { deviceId: input.deviceId } : {}), place: input.place, at, offline: !!input.offline,
      ...(input.offline ? { offlineResult: input.offline.offlineResult, batchId: input.offline.batchId } : {}),
      result, displayStatus: status?.status ?? 'INCONNU', ...(reason ? { reason } : {}), consumedUse: consumed,
      ...(alreadyUsed ? { alreadyUsed } : {}), recordedAt: nowIso,
    });
    if (consumed && c) {
      if (c.firstUse && c.firstUse.controlId === '') c = this.credentials.update({ ...c, firstUse: { ...c.firstUse, controlId: event.id } });
      this.usages.append({ id: this.ids.next('USG'), credentialId: c.id, controlId: event.id, at, place: input.place, ...(input.deviceId ? { deviceId: input.deviceId } : {}), usesLeftAfter: c.usesLeft ?? 0 });
      this.ctx.audit.append({ actor: this.actor(user), action: 'titres.credential.use_consumed', resourceType: 'credential', resourceId: c.id, details: { controlId: event.id, usesLeft: c.usesLeft } });
    }
    let constat: Constat | undefined;
    if (result !== 'VALIDE') {
      const module = c?.module ?? input.module ?? 'inconnu';
      const graceUntil = this.gracePeriods.get(module);
      constat = this.constats.insert({
        id: this.ids.next('CST'), controlId: event.id, ...(c ? { credentialId: c.id } : {}), ...(module !== 'inconnu' ? { module } : {}), entity: c?.entity ?? user.entity,
        presented: event.presented, reason: reason ?? 'Aucun titre valide présenté', controllerId: user.id, place: input.place, at,
        status: 'OUVERT', legalEffect: 'AUCUN_MONTANT', duringGrace: !!graceUntil && at.slice(0, 10) <= graceUntil,
        notice: 'Constat à instruire par une personne habilitée : aucune amende, aucun montant, aucune immobilisation automatique. Pénalité éventuelle uniquement selon le barème de l’acte, par décision motivée et contestable (RW1).',
      });
    }
    this.ctx.audit.append({
      actor: this.actor(user), action: input.offline ? 'titres.control.offline_reconciled' : 'titres.control.recorded', resourceType: 'credential_control', resourceId: event.id,
      outcome: result === 'VALIDE' ? 'SUCCESS' : 'FAILURE',
      details: { credentialId: c?.id ?? null, method: input.method, result, place: input.place, deviceId: input.deviceId ?? null, constatId: constat?.id ?? null, consumedUse: consumed },
    });
    // Statut présenté = état AU MOMENT du contrôle (avant consommation d'un usage).
    return { event, ...(status ? { status } : {}), ...(constat ? { constat } : {}) };
  }

  minimalView(ev: VerificationEvent, status: StatusView | undefined, c: Credential | undefined, constat?: Constat): MinimalControlView {
    const t = c ? this.types.findOne((x) => x.code === c.typeCode) : undefined;
    const shown = status && ev.consumedUse ? { ...status, text: `${status.text} — usage consommé${c?.usesLeft !== undefined && c.usesLeft > 0 ? ` (${c.usesLeft} restant${c.usesLeft > 1 ? 's' : ''})` : ''}` } : status;
    const pres = shown ? { status: shown.status, color: shown.color, icon: shown.icon, signal: shown.signal, text: shown.text, remainingSeconds: shown.remainingSeconds }
      : { status: 'INCONNU' as const, color: 'noir', icon: 'ban', signal: 'DISTINCT', text: `INVALIDE — ${ev.reason ?? 'titre inconnu'}` };
    return {
      controlId: ev.id, result: ev.result, ...pres, serverTime: this.ctx.clock.now().toISOString(),
      ...(c ? { module: c.module, typeLabel: t?.label ?? c.typeCode, prefix: t?.prefix, zone: c.place.label } : {}),
      ...(c?.subject.plate ? { plate: normalizePlate(c.subject.plate) } : {}),
      ...(ev.alreadyUsed ? { alreadyUsed: ev.alreadyUsed } : {}),
      nothingToPay: ev.result === 'VALIDE',
      ...(constat ? { constat: { id: constat.id, notice: constat.notice } } : {}),
      method: ev.method, offline: false,
    };
  }

  /** POST /v1/titres/controles — contrôle en ligne par QR (dynamique ou statique), code court ou plaque. */
  control(user: User, input: ControlInput): MinimalControlView {
    authorize(user, 'titres:control', this.controlResource(user, input.place));
    this.sync();
    const now = this.ctx.clock.now().getTime();
    if (input.plate) {
      const list = this.byPlate(input.plate, input.module).filter((c) => c.state !== 'REMPLACE');
      const best = list[0];
      const r = this.recordControl(user, { ...(best ? { credential: best } : { failure: 'Aucun titre pour cette plaque' }), ...(input.module ? { module: input.module } : {}), method: 'PLAQUE', presented: input.plate, place: input.place, ...(input.deviceId ? { deviceId: input.deviceId } : {}) });
      const view = this.minimalView(r.event, r.status, best ? this.credentials.get(best.id) : undefined, r.constat);
      return { ...view, plate: normalizePlate(input.plate) };
    }
    const presented = input.qr ?? input.code;
    if (!presented) throw badRequest('NOTHING_PRESENTED', 'QR, code court ou plaque requis.');
    const res = this.resolvePresented(presented, now);
    if (res.credential && input.module && res.credential.module !== input.module) {
      // Visuels par module : un titre ne peut pas être présenté pour un autre service.
      const r = this.recordControl(user, { method: res.method, presented, place: input.place, failure: `Titre d’un autre service (${res.credential.number.split('-')[0]})`, ...(input.deviceId ? { deviceId: input.deviceId } : {}) });
      return this.minimalView(r.event, undefined, undefined, r.constat);
    }
    const r = this.recordControl(user, { ...(res.credential ? { credential: res.credential } : {}), method: res.method, presented, place: input.place, ...(res.failure ? { failure: res.failure } : {}), ...(input.deviceId ? { deviceId: input.deviceId } : {}) });
    return this.minimalView(r.event, r.status, res.credential ? this.credentials.get(res.credential.id) : undefined, r.constat);
  }

  // ------------------------------------------------------------------ Contrôle hors ligne

  /** Liste de révocation signée (Ed25519) : titres suspendus, révoqués, annulés, remplacés, consommés. */
  revocationList() {
    const entries = this.credentials
      .find((c) => c.state !== 'EMIS')
      .map((c) => ({ id: c.id, number: c.number, state: c.state, at: c.stateAt ?? c.issuedAt }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const doc = { kind: 'MOSOLO_TITRES_REVOCATIONS', generatedAt: this.ctx.clock.now().toISOString(), entries };
    return { ...doc, signature: this.signer.signDocument(doc), algorithm: 'Ed25519' as const };
  }

  /** Paquet hors ligne du terminal : clé publique, liste de révocation signée, plaques actives (sans donnée personnelle). */
  offlinePack(user: User, deviceId: string | undefined, module?: string) {
    authorize(user, 'titres:control', user.territory ? { communes: user.territory } : {});
    this.sync();
    const device = deviceId ? this.ctx.field.devices.get(deviceId) : undefined;
    if (deviceId && (!device || device.status !== 'ACTIF' || device.agentUserId !== user.id)) throw forbidden('DEVICE_NOT_ALLOWED', 'Terminal non enrôlé, révoqué ou non affecté à ce contrôleur.');
    const now = this.ctx.clock.now();
    if (deviceId) this.devicePackAt.set(deviceId, now.toISOString());
    const plates = this.credentials
      .find((c) => c.state === 'EMIS' && !!c.subject.plate && (!module || c.module === module) && new Date(c.validUntil).getTime() + c.toleranceMinutes * MIN > now.getTime())
      .map((c) => ({ plate: normalizePlate(c.subject.plate!), number: c.number, typeCode: c.typeCode, validFrom: c.validFrom, validUntil: c.validUntil, toleranceMinutes: c.toleranceMinutes, amberMinutes: c.amberMinutes }));
    const platesDoc = { kind: 'MOSOLO_TITRES_PLAQUES', generatedAt: now.toISOString(), plates };
    this.ctx.audit.append({ actor: this.actor(user), action: 'titres.offline_pack.downloaded', resourceType: 'device', resourceId: deviceId ?? 'navigateur', details: { plates: plates.length } });
    return {
      serverTime: now.toISOString(), algorithm: 'Ed25519', publicKeyPem: this.signer.publicKeyPem(),
      revocations: this.revocationList(), plates: { ...platesDoc, signature: this.signer.signDocument(platesDoc) },
      types: this.types.all().map((t) => ({ code: t.code, prefix: t.prefix, label: t.label, module: t.module, amberMinutes: t.validity.amberMinutes, toleranceMinutes: t.validity.toleranceMinutes })),
      notice: 'Résultat hors ligne marqué « vérifié hors ligne » et reconfirmé à la synchronisation. Heure de référence : dernière synchronisation avec le serveur.',
    };
  }

  /**
   * Synchronisation d'un lot de contrôles hors ligne, signé HMAC par le terminal enrôlé (x-device-signature).
   * Chaque contrôle est reconfirmé par le serveur ; un usage unique déjà consommé est détecté (AC-TIT-03).
   */
  syncOffline(user: User, rawBody: string, signature: string | undefined) {
    authorize(user, 'titres:control', user.territory ? { communes: user.territory } : {});
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw badRequest('INVALID_JSON', 'Corps JSON invalide.');
    }
    const parsed = offlineBatchSchema.safeParse(json);
    if (!parsed.success) throw badRequest('VALIDATION_ERROR', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const batch = parsed.data;
    const device = this.ctx.field.devices.get(batch.deviceId);
    if (!device) throw unauthorized('UNKNOWN_DEVICE', 'Terminal non enrôlé.');
    if (device.status !== 'ACTIF') throw forbidden('DEVICE_REVOKED', 'Terminal révoqué : synchronisation refusée.');
    if (device.agentUserId !== user.id) throw forbidden('DEVICE_USER_MISMATCH', 'Ce terminal n’est pas affecté à ce contrôleur.');
    if (!signature || !safeEqualHex(hmacSha256Hex(device.key, rawBody), signature.replace(/^sha256=/, '').toLowerCase())) {
      this.ctx.alerts.raise({ type: 'INVALID_DEVICE_SIGNATURE', severity: 'HIGH', source: 'titres', detail: `Signature de lot de contrôles invalide (${device.id}).`, context: { batchId: batch.batchId }, actor: { kind: 'device', id: device.id } });
      throw unauthorized('INVALID_DEVICE_SIGNATURE', 'Signature du lot invalide.');
    }
    const fingerprint = sha256Hex(canonicalJson(batch));
    const prev = this.offlineBatches.get(batch.batchId);
    if (prev) {
      if (prev.fingerprint !== fingerprint) throw conflict('BATCH_ID_REUSED', 'Identifiant de lot déjà utilisé avec un autre contenu.');
      return { ...(prev.result as object), replayed: true };
    }
    this.sync();
    const now = this.ctx.clock.now();
    const lowerBound = new Date(this.devicePackAt.get(device.id) ?? new Date(now.getTime() - 72 * HOUR_MS).toISOString()).getTime() - 5 * MIN;
    const results: { opId: string; controlId?: string; offlineResult: ControlResult; reconfirmed?: ControlResult; divergent?: boolean; alreadyUsed?: unknown; constatId?: string; rejected?: string }[] = [];
    const ops = [...batch.controls].sort((a, b) => a.controlledAt.localeCompare(b.controlledAt));
    for (const op of ops) {
      const at = new Date(op.controlledAt).getTime();
      if (at > now.getTime() + 2 * MIN || at < lowerBound) {
        results.push({ opId: op.opId, offlineResult: op.offlineResult, rejected: 'HORODATAGE_INCOHERENT' });
        continue;
      }
      let credential: Credential | undefined;
      let method: ControlMethod = 'QR_STATIQUE';
      let failure: string | undefined;
      if (op.plate) {
        method = 'PLAQUE';
        credential = this.byPlate(op.plate).filter((c) => c.state !== 'REMPLACE')[0];
        if (!credential) failure = 'Aucun titre pour cette plaque';
      } else if (op.token) {
        const payload = this.signer.verifyStatic(op.token);
        if (!payload || typeof payload.id !== 'string') failure = 'QR non authentique (signature invalide)';
        else credential = this.credentials.get(payload.id);
        if (!credential && !failure) failure = 'Titre inconnu';
      } else {
        results.push({ opId: op.opId, offlineResult: op.offlineResult, rejected: 'RIEN_PRESENTE' });
        continue;
      }
      const r = this.recordControl(user, {
        ...(credential ? { credential } : {}), method, presented: op.plate ?? op.token ?? '', place: op.place, deviceId: device.id,
        ...(failure ? { failure } : {}), offline: { at: new Date(at).toISOString(), batchId: batch.batchId, offlineResult: op.offlineResult },
      });
      results.push({
        opId: op.opId, controlId: r.event.id, offlineResult: op.offlineResult, reconfirmed: r.event.result, divergent: r.event.result !== op.offlineResult,
        ...(r.event.alreadyUsed ? { alreadyUsed: r.event.alreadyUsed } : {}), ...(r.constat ? { constatId: r.constat.id } : {}),
      });
    }
    const result = {
      batchId: batch.batchId, deviceId: device.id, receivedAt: now.toISOString(), results,
      divergences: results.filter((r) => r.divergent).length, revocations: this.revocationList(),
    };
    this.offlineBatches.set(batch.batchId, { fingerprint, result });
    this.ctx.audit.append({ actor: { kind: 'device', id: device.id }, action: 'titres.offline_batch.synced', resourceType: 'control_batch', resourceId: batch.batchId, details: { controls: results.length, divergences: result.divergences, agentId: user.id } });
    return result;
  }

  // ------------------------------------------------------------------ Décisions humaines (motif obligatoire)

  private setState(c: Credential, state: CredentialState, reason: string, by: string, extra: Partial<Credential> = {}): Credential {
    const at = this.ctx.clock.now().toISOString();
    const updated = this.credentials.update({ ...c, ...extra, state, stateReason: reason, stateBy: by, stateAt: at });
    if (state !== 'EMIS') this.revocations.append({ id: this.ids.next('REV'), credentialId: c.id, state, reason, by, at });
    this.ctx.audit.append({
      actor: by.startsWith('systeme') ? { kind: 'system', id: by } : { kind: 'user', id: by }, action: `titres.credential.${state === 'EMIS' ? 'reinstated' : state.toLowerCase()}`,
      resourceType: 'credential', resourceId: c.id, details: { from: c.state, to: state, reason },
    });
    const holder = c.holderTaxpayerId ? this.ctx.taxpayers.taxpayers.get(c.holderTaxpayerId) : undefined;
    if (holder && state !== 'CONSOMME' && state !== 'EMIS') {
      this.ctx.comms.publish(state === 'SUSPENDU' ? 'credential.suspended' : 'credential.revoked', [taxpayerRecipient(holder)], { reference: c.number, titre: c.number }, { entity: c.entity });
    }
    return updated;
  }

  decide(user: User, id: string, input: { decision: 'SUSPENDRE' | 'LEVER' | 'ANNULER' | 'REMPLACER'; motif: string; subject?: CredentialSubject }) {
    this.sync();
    const c = this.credential(id);
    authorize(user, 'titres:decide', { entity: c.entity });
    const motif = input.motif.trim();
    if (motif.length < 5) throw badRequest('MOTIF_REQUIRED', 'Motif obligatoire (5 caractères au moins).');
    switch (input.decision) {
      case 'SUSPENDRE':
        if (c.state !== 'EMIS') throw conflict('INVALID_CREDENTIAL_STATE', `Titre au statut ${c.state} : suspension impossible.`);
        return { credential: this.setState(c, 'SUSPENDU', motif, user.id) };
      case 'LEVER':
        if (c.state !== 'SUSPENDU') throw conflict('INVALID_CREDENTIAL_STATE', 'Seul un titre suspendu peut être rétabli.');
        return { credential: this.setState(c, 'EMIS', motif, user.id) };
      case 'ANNULER':
        if (c.state === 'ANNULE' || c.state === 'REMPLACE' || c.state === 'REVOQUE') throw conflict('INVALID_CREDENTIAL_STATE', `Titre déjà ${c.state}.`);
        return { credential: this.setState(c, 'ANNULE', motif, user.id), notice: 'Un remboursement éventuel suit la règle du module, par contre-écriture et approbation distincte du Trésor.' };
      case 'REMPLACER': {
        if (c.state !== 'EMIS' && c.state !== 'SUSPENDU') throw conflict('INVALID_CREDENTIAL_STATE', `Titre au statut ${c.state} : remplacement impossible.`);
        if (input.subject?.plate && c.subject.plate && normalizePlate(input.subject.plate) !== normalizePlate(c.subject.plate) && !motif.toLowerCase().includes('plaque')) {
          throw unprocessable('NOT_TRANSFERABLE', 'Titre non transférable : un remplacement ne change pas de plaque, sauf correction motivée de la plaque.');
        }
        const t = this.types.findOne((x) => x.code === c.typeCode && x.version === c.typeVersion) ?? this.type(c.typeCode);
        const newId = this.ids.next('TIT');
        const number = `${t.prefix}-${new Date(c.issuedAt).getUTCFullYear()}-${newId.slice(4)}`;
        const subject = { ...c.subject, ...(input.subject ?? {}) };
        const staticToken = this.signer.signStatic({ v: 1, id: newId, n: number, ty: c.typeCode, px: t.prefix, f: c.validFrom, u: c.validUntil, p: subject.plate ? normalizePlate(subject.plate) : null });
        const replacement = this.credentials.insert({
          ...structuredClone(c), id: newId, number, shortCode: this.newShortCode(t.prefix), subject, staticToken, state: 'EMIS',
          stateReason: undefined, stateBy: undefined, stateAt: undefined, replacesId: c.id, replacedById: undefined, issuedAt: this.ctx.clock.now().toISOString(), amberNotifiedAt: undefined,
        });
        const old = this.setState(c, 'REMPLACE', motif, user.id, { replacedById: newId });
        this.ctx.audit.append({ actor: this.actor(user), action: 'titres.credential.replacement_issued', resourceType: 'credential', resourceId: newId, details: { replaces: c.id, motif } });
        return { credential: old, replacement };
      }
    }
  }

  /** Condition d'un titre glissant conditionnel (appelée par le module propriétaire, tracée). */
  setCondition(id: string, met: boolean, reason: string, by: string): Credential {
    const c = this.credential(id);
    if (c.model !== 'GLISSANT_CONDITIONNEL') throw unprocessable('NOT_CONDITIONAL', 'Titre non conditionnel.');
    const u = this.credentials.update({ ...c, conditionMet: met });
    this.ctx.audit.append({ actor: { kind: 'system', id: by }, action: 'titres.credential.condition_changed', resourceType: 'credential', resourceId: c.id, details: { met, reason } });
    return u;
  }

  /** Abonnement : consentement au renouvellement ou résiliation par le titulaire. */
  setAutoRenew(user: User, id: string, consent: boolean): Credential {
    const c = this.credential(id);
    authorize(user, 'titres:read.own', { taxpayerId: c.holderTaxpayerId ?? c.payerTaxpayerId });
    if (c.model !== 'ABONNEMENT') throw unprocessable('NOT_A_SUBSCRIPTION', 'Seul un abonnement se renouvelle avec consentement.');
    const now = this.ctx.clock.now().toISOString();
    const u = this.credentials.update({ ...c, autoRenew: consent ? { consent: true, consentAt: now } : { consent: false, ...(c.autoRenew?.consentAt ? { consentAt: c.autoRenew.consentAt } : {}), cancelledAt: now } });
    this.ctx.audit.append({ actor: this.actor(user), action: consent ? 'titres.subscription.consented' : 'titres.subscription.cancelled', resourceType: 'credential', resourceId: c.id });
    return u;
  }

  decideConstat(user: User, id: string, input: { outcome: 'CLASSE' | 'TRANSMIS'; motif: string }): Constat {
    const k = this.constats.get(id);
    if (!k) throw notFound('CONSTAT_NOT_FOUND', `Constat inconnu : ${id}`);
    authorize(user, 'titres:decide', { entity: k.entity });
    if (k.controllerId === user.id) throw forbidden('SEPARATION_OF_DUTIES', 'Le contrôleur auteur du constat ne peut pas en décider.');
    if (k.status !== 'OUVERT') throw conflict('CONSTAT_ALREADY_DECIDED', `Constat déjà ${k.status}.`);
    if (input.motif.trim().length < 5) throw badRequest('MOTIF_REQUIRED', 'Motif obligatoire.');
    const decided = this.constats.update({ ...k, status: input.outcome, decision: { by: user.id, at: this.ctx.clock.now().toISOString(), outcome: input.outcome, motif: input.motif.trim() } });
    this.ctx.audit.append({ actor: this.actor(user), action: `titres.constat.${input.outcome.toLowerCase()}`, resourceType: 'constat', resourceId: id, details: { motif: input.motif.trim(), legalEffect: 'AUCUN_MONTANT' } });
    return decided;
  }

  /** Prolongation / renouvellement (nouveau paiement) : même sujet, même lieu, continuité de validité. */
  extend(user: User, id: string, input: { channel: PaymentChannel; durationMinutes?: number }): Issuance {
    this.sync();
    const c = this.credential(id);
    const t = this.type(c.typeCode);
    if (!t.validity.extendable) throw unprocessable('NOT_EXTENDABLE', 'Ce type de titre ne se prolonge pas.');
    if (c.state !== 'EMIS') throw conflict('INVALID_CREDENTIAL_STATE', `Titre au statut ${c.state} : prolongation impossible.`);
    return this.purchase(user, {
      payerTaxpayerId: c.holderTaxpayerId ?? c.payerTaxpayerId, channel: input.channel, context: 'PROLONGATION',
      items: [{
        typeCode: t.code, subject: c.subject, place: c.place, renewsId: c.id,
        ...(c.holderTaxpayerId ? { holderTaxpayerId: c.holderTaxpayerId } : {}), ...(input.durationMinutes ? { durationMinutes: input.durationMinutes } : {}),
      }],
    });
  }

  // ------------------------------------------------------------------ Indicateurs (agrégats)

  indicators(module?: string) {
    this.sync();
    const now = this.ctx.clock.now();
    const creds = this.credentials.find((c) => !module || c.module === module);
    const byStatus: Record<string, number> = {};
    for (const c of creds) {
      const s = statusAt(c, now).status;
      byStatus[s] = (byStatus[s] ?? 0) + 1;
    }
    const ctrls = this.controls.find((e) => !module || e.module === module);
    const active = (byStatus.VALIDE ?? 0) + (byStatus.BIENTOT_EXPIRE ?? 0);
    const red = ctrls.filter((e) => e.result === 'EXPIRE').length;
    const renewals = creds.filter((c) => c.renewsId).length;
    const amberRenewals = creds.filter((c) => {
      if (!c.renewsId) return false;
      const prev = this.credentials.get(c.renewsId);
      return !!prev && new Date(c.issuedAt).getTime() <= new Date(prev.validUntil).getTime();
    }).length;
    const constats = this.constats.find((k) => !module || k.module === module);
    return {
      serverTime: now.toISOString(), module: module ?? 'tous',
      credentials: { total: creds.length, active, byStatus },
      controls: {
        total: ctrls.length, valid: ctrls.filter((e) => e.result === 'VALIDE').length, expired: red, invalid: ctrls.filter((e) => e.result === 'INVALIDE').length,
        offline: ctrls.filter((e) => e.offline).length, redShare: ctrls.length ? (red / ctrls.length).toFixed(4) : '0',
        controlledOverActive: active ? (ctrls.length / active).toFixed(4) : '0',
        reuseAttempts: ctrls.filter((e) => e.displayStatus === 'INVALIDE' && e.alreadyUsed).length,
      },
      renewals: { total: renewals, beforeExpiry: amberRenewals },
      constats: { total: constats.length, open: constats.filter((k) => k.status === 'OUVERT').length, classified: constats.filter((k) => k.status === 'CLASSE').length, transmitted: constats.filter((k) => k.status === 'TRANSMIS').length },
    };
  }
}

