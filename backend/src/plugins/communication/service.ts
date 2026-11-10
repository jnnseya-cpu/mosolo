/**
 * Notifications et communication (spécification fonctionnelle, module 39) — construit SUR le service de communication
 * du socle (catalogue des événements, canaux, journal de délivrance), sans circuit parallèle :
 *  - MODÈLES VERSIONNÉS par événement, par recette et par langue : brouillon, activation par une seconde personne,
 *    version précédente archivée ; messages minimaux, sans lien ; modèle d'une mise en demeure ou d'une mesure activable
 *    seulement sur un acte EN VIGUEUR du registre juridique (« mises en demeure seulement si légalement autorisées ») ;
 *  - PRÉFÉRENCES : canal choisi, canaux refusés (sauf avis obligatoires), consentement WhatsApp, langue — journal des
 *    consentements ;
 *  - PREUVE DE REMISE horodatée et conservée : accusés des fournisseurs (signés), accusé de lecture dans l'application ;
 *  - CANAL DE SECOURS : un accusé « échoué » déclenche l'envoi sur le canal suivant ; les canaux épuisés pour un avis
 *    obligatoire ouvrent un AVIS IMPRIMÉ À APPOSER SUR LA PLAQUE de l'objet, dont l'apposition (photo par empreinte,
 *    position GPS au regard de l'objet, heure serveur) vaut preuve ;
 *  - indicateurs : taux de délivrance, délai de délivrance, taux d'ouverture.
 * Les connecteurs réels (agrégateur SMS, SMTP, WhatsApp, opérateur vocal) restent des adaptateurs [À RACCORDER —
 * convention requise] ; le bac à sable journalise sans transmettre.
 */
import { getEvent, type Channel, type LanguageCode } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { canonicalJson, hmacSha256Hex, safeEqualHex, sha256Hex } from '../../core/crypto.js';
import { badRequest, conflict, forbidden, notFound, unauthorized, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { Delivery, Recipient } from '../../modules/communications/service.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import { distanceM } from '../terrain/geo.js';

const { always, ownTaxpayer, mandant } = GRANTS;
definePolicy('communication:read', { R01: always, R02: always, R05: always, R06: always, R07: always, R11: always, R12: always, R13: always, R14: always, R16: always, R20: always, R21: always, R22: always, R23: always });
definePolicy('communication:template.propose', { R06: always, R07: always, R13: always });
definePolicy('communication:template.approve', { R06: always, R16: always, R14: always });
definePolicy('communication:preferences', { R12: always, R30: ownTaxpayer, R31: mandant });
definePolicy('communication:plate.create', { R07: always, R11: always, R20: always });
definePolicy('communication:plate.post', { R10: always, R11: always });

/** Événements juridiquement contraignants : modèle activable seulement sur un acte en vigueur. */
export const LEGAL_EVENTS = ['recovery.formal_notice', 'recovery.enforcement.proposed', 'recovery.enforcement.decided'];
const SUSPICIOUS_LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|ly|io|cd|co|me|app|link)\b)/i;
export const TEMPLATE_MAX_CHARS = 480;
/** Tolérance de position pour l'apposition d'un avis sur la plaque : celle du module terrain (par commune). */
const DEFAULT_POSTING_TOLERANCE_M = 50;

export interface MessageTemplate {
  id: string;
  eventCode: string;
  revenueCategory: string | null;
  lang: LanguageCode;
  version: number;
  text: string;
  status: 'BROUILLON' | 'ACTIF' | 'ARCHIVE' | 'REJETE';
  legalBasis?: { instrumentId: string; article: string };
  proposedBy: string;
  proposedAt: string;
  decision?: { by: string; at: string; approve: boolean; motif: string };
}

export interface OutboxEntry { id: string; deliveryId: string; recipient: Recipient; subject: string; body: string; at: string; eventCode: string; channel: Channel }
export interface DeliveryReceipt { id: string; deliveryId: string; status: 'delivre' | 'lu' | 'echoue'; providerAt: string; receivedAt: string; source: 'FOURNISSEUR' | 'APPLICATION'; fallbackDeliveryIds?: string[] }
export interface PlateNotice {
  id: string;
  objectId: string;
  plate: string | null;
  taxpayerId: string | null;
  eventCode: string;
  text: string;
  verificationCode: string;
  origin: 'ECHEC_CANAUX' | 'MANUEL';
  sourceDeliveryId?: string;
  status: 'A_APPOSER' | 'APPOSE' | 'ANNULE';
  createdBy: string;
  createdAt: string;
  posting?: { by: string; at: string; gps: { lat: number; lon: number; accuracyM: number }; distanceM: number; toleranceM: number; photoSha256: string };
}
export interface ConsentEvent { id: string; taxpayerId: string; by: string; at: string; before: Record<string, unknown>; after: Record<string, unknown> }

export class CommunicationExtService {
  readonly templates = new InMemoryRepository<MessageTemplate>();
  readonly outbox = new InMemoryRepository<OutboxEntry>();
  readonly receipts = new InMemoryRepository<DeliveryReceipt>();
  readonly plateNotices = new InMemoryRepository<PlateNotice>();
  readonly consents = new InMemoryRepository<ConsentEvent>();
  private readonly ids = new IdGenerator();
  private readonly receiptKey: string;

  constructor(private readonly ctx: AppContext) {
    // Clé de signature des accusés de remise des fournisseurs (dérivée ; production : clé par fournisseur, convention).
    this.receiptKey = hmacSha256Hex(ctx.secrets.auditHmacKey, 'mosolo:communication:accuses:v1');
    ctx.comms.setTemplateResolver((eventCode, lang, revenueCategory) => {
      const active = (cat: string | null) => this.templates.findOne((t) => t.status === 'ACTIF' && t.eventCode === eventCode && t.lang === lang && t.revenueCategory === cat);
      const t = (revenueCategory ? active(revenueCategory) : undefined) ?? active(null);
      return t ? { id: t.id, version: t.version, text: t.text } : undefined;
    });
    ctx.comms.onSent((d, content, recipient) => {
      if (d.status === 'supprime_par_preference') return;
      this.outbox.insert({ id: d.id, deliveryId: d.id, recipient, subject: content.subject, body: content.body, at: d.at, eventCode: d.eventCode, channel: d.channel });
    });
    ctx.comms.onFailure((d) => this.onChannelsExhausted(d));
  }

  private now() { return this.ctx.clock.now().toISOString(); }

  // ───────────── modèles versionnés ─────────────

  proposeTemplate(u: User, input: { eventCode: string; revenueCategory?: string; lang: LanguageCode; text: string; legalBasis?: { instrumentId: string; article: string } }): MessageTemplate {
    authorize(u, 'communication:template.propose');
    const event = getEvent(input.eventCode);
    if (!event) throw notFound('UNKNOWN_EVENT', `Événement inconnu au catalogue : ${input.eventCode}`);
    const text = input.text.trim();
    if (text.length > TEMPLATE_MAX_CHARS) throw unprocessable('MESSAGE_TOO_LONG', `Message minimal : ${TEMPLATE_MAX_CHARS} caractères au plus.`);
    if (SUSPICIOUS_LINK.test(text)) throw unprocessable('SUSPICIOUS_LINK', 'Aucun lien dans un message : renvoyer vers l’espace MOSOLO ou le code USSD officiel.');
    if (LEGAL_EVENTS.includes(input.eventCode) && !input.legalBasis) throw unprocessable('LEGAL_BASIS_REQUIRED', 'Mise en demeure ou mesure : base légale (acte en vigueur et article) obligatoire.');
    const cat = input.revenueCategory ?? null;
    const prev = this.templates.find((t) => t.eventCode === input.eventCode && t.lang === input.lang && t.revenueCategory === cat).sort((a, b) => b.version - a.version)[0];
    const t = this.templates.insert({
      id: this.ids.next('MOD', 6), eventCode: input.eventCode, revenueCategory: cat, lang: input.lang, version: (prev?.version ?? 0) + 1, text,
      status: 'BROUILLON', ...(input.legalBasis ? { legalBasis: input.legalBasis } : {}), proposedBy: u.id, proposedAt: this.now(),
    });
    this.ctx.audit.append({ actor: actorOf(u), action: 'communication.template.proposed', resourceType: 'message_template', resourceId: t.id, details: { eventCode: t.eventCode, lang: t.lang, revenueCategory: cat, version: t.version, textHash: sha256Hex(text) } });
    return t;
  }

  decideTemplate(u: User, id: string, input: { approve: boolean; motif: string }): MessageTemplate {
    authorize(u, 'communication:template.approve');
    const t = this.templates.get(id);
    if (!t) throw notFound('TEMPLATE_NOT_FOUND', `Modèle inconnu : ${id}`);
    if (t.status !== 'BROUILLON') throw conflict('TEMPLATE_DECIDED', `Modèle au statut ${t.status}.`);
    assertDistinctPerson(u.id, [t.proposedBy], 'Un modèle est activé par une personne distincte de son rédacteur.');
    if (input.approve && LEGAL_EVENTS.includes(t.eventCode)) {
      const inst = t.legalBasis ? this.ctx.rules.instrument(t.legalBasis.instrumentId) : undefined;
      if (!inst || inst.status !== 'EN_VIGUEUR') throw unprocessable('LEGAL_BASIS_NOT_IN_FORCE', 'Mise en demeure seulement si légalement autorisée : l’acte cité n’est pas en vigueur au registre juridique.');
    }
    const at = this.now();
    if (input.approve) {
      for (const old of this.templates.find((x) => x.status === 'ACTIF' && x.eventCode === t.eventCode && x.lang === t.lang && x.revenueCategory === t.revenueCategory)) this.templates.update({ ...old, status: 'ARCHIVE' });
    }
    const out = this.templates.update({ ...t, status: input.approve ? 'ACTIF' : 'REJETE', decision: { by: u.id, at, approve: input.approve, motif: input.motif } });
    this.ctx.audit.append({ actor: actorOf(u), action: input.approve ? 'communication.template.activated' : 'communication.template.rejected', resourceType: 'message_template', resourceId: id, details: { proposedBy: t.proposedBy, version: t.version, motif: input.motif } });
    return out;
  }

  listTemplates(u: User) {
    authorize(u, 'communication:read');
    return this.templates.all().sort((a, b) => a.eventCode.localeCompare(b.eventCode) || a.lang.localeCompare(b.lang) || b.version - a.version);
  }

  // ───────────── préférences et consentements ─────────────

  preferences(u: User, taxpayerId: string) {
    authorize(u, 'communication:preferences', { taxpayerId });
    const tp = this.ctx.taxpayers.taxpayers.get(taxpayerId);
    if (!tp) throw notFound('TAXPAYER_NOT_FOUND', `Contribuable inconnu : ${taxpayerId}`);
    return { taxpayerId, language: tp.language, prefs: tp.prefs, history: this.consents.find((c) => c.taxpayerId === taxpayerId).sort((a, b) => b.at.localeCompare(a.at)) };
  }

  setPreferences(u: User, taxpayerId: string, input: { preferredChannel?: Channel | null; disabledChannels?: Channel[]; whatsappConsent?: boolean; optedOut?: boolean; language?: LanguageCode }) {
    authorize(u, 'communication:preferences', { taxpayerId });
    const tp = this.ctx.taxpayers.taxpayers.get(taxpayerId);
    if (!tp) throw notFound('TAXPAYER_NOT_FOUND', `Contribuable inconnu : ${taxpayerId}`);
    if (input.preferredChannel === 'whatsapp' && !(input.whatsappConsent ?? tp.prefs.whatsappConsent)) throw unprocessable('WHATSAPP_CONSENT_REQUIRED', 'WhatsApp : consentement explicite préalable.');
    if (input.preferredChannel && input.disabledChannels?.includes(input.preferredChannel)) throw badRequest('CONTRADICTORY_PREFERENCES', 'Le canal choisi ne peut pas être refusé.');
    const before = { ...tp.prefs, language: tp.language };
    const prefs = { ...tp.prefs };
    if (input.preferredChannel !== undefined) { if (input.preferredChannel === null) delete prefs.preferredChannel; else prefs.preferredChannel = input.preferredChannel; }
    if (input.disabledChannels) prefs.disabledChannels = input.disabledChannels.filter((c) => c !== 'in-app');
    if (input.whatsappConsent !== undefined) prefs.whatsappConsent = input.whatsappConsent;
    if (input.optedOut !== undefined) prefs.optedOut = input.optedOut;
    const updated = this.ctx.taxpayers.taxpayers.update({ ...tp, prefs, ...(input.language ? { language: input.language } : {}) });
    const ev = this.consents.insert({ id: this.ids.next('CONS', 8), taxpayerId, by: u.id, at: this.now(), before, after: { ...updated.prefs, language: updated.language } });
    this.ctx.audit.append({ actor: actorOf(u), action: 'communication.preferences.updated', resourceType: 'taxpayer', resourceId: taxpayerId, details: { consentId: ev.id, after: ev.after } });
    return this.preferences(u, taxpayerId);
  }

  // ───────────── preuve de remise, canal de secours ─────────────

  receiptSignature(body: string): string { return hmacSha256Hex(this.receiptKey, body); }

  /** Accusé d'un fournisseur (signé) : délivré, lu ou échoué ; un échec déclenche le canal de secours. */
  providerReceipt(rawBody: string, signature: string | undefined, input: { deliveryId: string; status: 'delivre' | 'lu' | 'echoue'; at: string }): DeliveryReceipt {
    if (!signature || !/^[0-9a-f]{64}$/.test(signature) || !safeEqualHex(this.receiptSignature(rawBody), signature)) throw unauthorized('INVALID_RECEIPT_SIGNATURE', 'Accusé de remise non signé ou signature invalide.');
    return this.recordReceipt(input.deliveryId, input.status, input.at, 'FOURNISSEUR');
  }

  /** Accusé de lecture dans l'application, par le destinataire lui-même. */
  readReceipt(u: User, deliveryId: string): DeliveryReceipt {
    const d = this.delivery(deliveryId);
    if (d.recipientId !== u.id && d.recipientId !== u.taxpayerId) throw forbidden('NOT_RECIPIENT', 'Accusé de lecture par le seul destinataire.');
    return this.recordReceipt(deliveryId, 'lu', this.now(), 'APPLICATION');
  }

  private delivery(id: string): Delivery {
    const d = this.ctx.comms.deliveries.get(id);
    if (!d) throw notFound('DELIVERY_NOT_FOUND', `Envoi inconnu : ${id}`);
    return d;
  }

  private recordReceipt(deliveryId: string, status: DeliveryReceipt['status'], providerAt: string, source: DeliveryReceipt['source']): DeliveryReceipt {
    const d = this.delivery(deliveryId);
    const dup = this.receipts.findOne((r) => r.deliveryId === deliveryId && r.status === status);
    if (dup) return dup;
    let fallbackDeliveryIds: string[] | undefined;
    if (status === 'echoue') {
      const ob = this.outbox.get(deliveryId);
      // Message secret (code à usage unique) : jamais renvoyé depuis la boîte d'envoi (contenu masqué) ; la personne
      // demande un nouveau code.
      if (ob && !d.secret) fallbackDeliveryIds = this.ctx.comms.retryOnFallback(d, ob.recipient, { subject: ob.subject, body: ob.body }).map((x) => x.id);
    }
    const r = this.receipts.insert({ id: this.ids.next('ACC', 8), deliveryId, status, providerAt, receivedAt: this.now(), source, ...(fallbackDeliveryIds ? { fallbackDeliveryIds } : {}) });
    this.ctx.audit.append({ actor: { kind: 'system', id: 'communication' }, action: `communication.receipt.${status}`, resourceType: 'delivery', resourceId: deliveryId, details: { receiptId: r.id, source, channel: d.channel, fallback: fallbackDeliveryIds ?? [] } });
    return r;
  }

  /** Preuve de remise d'un envoi : journal de délivrance, accusés, envois de secours, avis apposé. */
  proof(u: User, deliveryId: string) {
    authorize(u, 'communication:read');
    const d = this.delivery(deliveryId);
    const chain = this.ctx.comms.deliveries.find((x) => x.eventCode === d.eventCode && x.recipientId === d.recipientId && x.contentHash === d.contentHash);
    return {
      delivery: d, chain, receipts: this.receipts.find((r) => chain.some((c) => c.id === r.deliveryId)),
      plateNotices: this.plateNotices.find((p) => chain.some((c) => c.id === p.sourceDeliveryId)),
      contentHash: d.contentHash,
    };
  }

  /** Canaux épuisés pour un avis obligatoire à un contribuable : avis imprimé à apposer sur la plaque de son objet. */
  private onChannelsExhausted(d: Delivery): void {
    const event = getEvent(d.eventCode);
    if (!event?.obligatoire || d.recipientKind !== 'taxpayer') return;
    // Jamais d'avis apposé pour un message secret (code à usage unique) : il serait lisible par tous sur la plaque.
    if (d.secret) return;
    const obj = this.ctx.objects.objects.find((o) => o.taxpayerId === d.recipientId)[0];
    if (!obj) return;
    if (this.plateNotices.findOne((p) => p.sourceDeliveryId === d.id)) return;
    const ob = this.outbox.get(d.id);
    this.createPlateNotice('systeme', { objectId: obj.id, eventCode: d.eventCode, text: ob?.body ?? event.objet, origin: 'ECHEC_CANAUX', sourceDeliveryId: d.id });
  }

  createPlateNotice(by: User | 'systeme', input: { objectId: string; eventCode: string; text: string; origin?: PlateNotice['origin']; sourceDeliveryId?: string }): PlateNotice {
    if (by !== 'systeme') authorize(by, 'communication:plate.create');
    const o = this.ctx.objects.objects.get(input.objectId);
    if (!o) throw notFound('OBJECT_NOT_FOUND', `Objet inconnu : ${input.objectId}`);
    if (!getEvent(input.eventCode)) throw notFound('UNKNOWN_EVENT', `Événement inconnu : ${input.eventCode}`);
    if (SUSPICIOUS_LINK.test(input.text)) throw unprocessable('SUSPICIOUS_LINK', 'Aucun lien sur un avis apposé.');
    const fiscal = this.ctx.ext['fiscal'] as { properties?: { currentPlate(id: string): { nfiu: string } | undefined } } | undefined;
    const plate = fiscal?.properties?.currentPlate(o.id)?.nfiu ?? null;
    const id = this.ids.next('AVP', 6);
    const n = this.plateNotices.insert({
      id, objectId: o.id, plate, taxpayerId: o.taxpayerId ?? null, eventCode: input.eventCode, text: input.text.slice(0, TEMPLATE_MAX_CHARS),
      verificationCode: sha256Hex(`${id}|${o.id}|${this.now()}`).slice(0, 10).toUpperCase(), origin: input.origin ?? 'MANUEL',
      ...(input.sourceDeliveryId ? { sourceDeliveryId: input.sourceDeliveryId } : {}), status: 'A_APPOSER', createdBy: by === 'systeme' ? 'systeme' : by.id, createdAt: this.now(),
    });
    this.ctx.audit.append({ actor: by === 'systeme' ? { kind: 'system', id: 'communication' } : actorOf(by), action: 'communication.plate_notice.created', resourceType: 'plate_notice', resourceId: n.id, details: { objectId: o.id, plate, origin: n.origin, sourceDeliveryId: n.sourceDeliveryId ?? null } });
    return n;
  }

  /** Apposition sur la plaque : photo (empreinte), position au regard de l'objet, heure serveur ⇒ preuve de remise. */
  postPlateNotice(u: User, id: string, input: { gps: { lat: number; lon: number; accuracyM: number }; photoSha256: string }): PlateNotice {
    authorize(u, 'communication:plate.post');
    const n = this.plateNotices.get(id);
    if (!n) throw notFound('PLATE_NOTICE_NOT_FOUND', `Avis inconnu : ${id}`);
    if (n.status !== 'A_APPOSER') throw conflict('PLATE_NOTICE_DONE', `Avis au statut ${n.status}.`);
    const o = this.ctx.objects.objects.get(n.objectId)!;
    const terrain = this.ctx.ext['terrain'] as { toleranceFor?(c: string): number } | undefined;
    const tol = terrain?.toleranceFor?.(o.commune) ?? DEFAULT_POSTING_TOLERANCE_M;
    const dist = distanceM(input.gps, { lat: o.lat, lon: o.lon });
    if (dist > tol + input.gps.accuracyM) throw unprocessable('NOT_AT_OBJECT', `Apposition à ${dist} m de l’objet (tolérance ${tol} m) : se rendre sur place.`);
    const out = this.plateNotices.update({ ...n, status: 'APPOSE', posting: { by: u.id, at: this.now(), gps: input.gps, distanceM: dist, toleranceM: tol, photoSha256: input.photoSha256.toLowerCase() } });
    this.ctx.audit.append({ actor: actorOf(u), action: 'communication.plate_notice.posted', resourceType: 'plate_notice', resourceId: id, details: { objectId: n.objectId, distanceM: dist, photoSha256: out.posting!.photoSha256, proof: sha256Hex(canonicalJson(out.posting)) } });
    return out;
  }

  listPlateNotices(u: User, filter: { status?: string } = {}) {
    if (!u.roles.some((r) => ['R10', 'R11'].includes(r))) authorize(u, 'communication:read');
    return this.plateNotices.find((p) => !filter.status || p.status === filter.status).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Vérification publique d'un avis apposé (code imprimé) : authenticité, sans donnée personnelle. */
  verifyPlateNotice(code: string) {
    const n = this.plateNotices.findOne((p) => p.verificationCode === code.trim().toUpperCase());
    if (!n) return { authentique: false };
    return { authentique: true, emisLe: n.createdAt.slice(0, 10), statut: n.status, plaque: n.plate, objet: 'Avis officiel de la Ville de Kinshasa — consulter l’espace MOSOLO ou le code USSD officiel ; aucun paiement à un agent.' };
  }

  /** Indicateurs du module 39 : taux de délivrance, délai de délivrance (médiane), taux d'ouverture. */
  indicators() {
    const all = this.ctx.comms.deliveries.all().filter((d) => d.status !== 'supprime_par_preference');
    const sandbox = all.filter((d) => d.status === 'journalise').length;
    const receipts = this.receipts.all();
    const deliveredIds = new Set([...all.filter((d) => d.status === 'delivre' || d.status === 'lu').map((d) => d.id), ...receipts.filter((r) => r.status === 'delivre' || r.status === 'lu').map((r) => r.deliveryId)]);
    const failed = new Set([...all.filter((d) => d.status === 'echoue').map((d) => d.id), ...receipts.filter((r) => r.status === 'echoue').map((r) => r.deliveryId)]);
    const measurable = all.filter((d) => d.status !== 'journalise' && d.status !== 'en_file' || deliveredIds.has(d.id) || failed.has(d.id));
    const delays = receipts.filter((r) => r.status === 'delivre').map((r) => {
      const d = this.ctx.comms.deliveries.get(r.deliveryId);
      return d ? (Date.parse(r.providerAt) - Date.parse(d.at)) / 60_000 : null;
    }).filter((x): x is number => x !== null && x >= 0).sort((a, b) => a - b);
    const recovery = this.ctx.ext['recouvrement'] as { notices?: { all(): { readAt?: string; notification: string }[] } } | undefined;
    const notices = recovery?.notices?.all() ?? [];
    const opened = new Set(receipts.filter((r) => r.status === 'lu').map((r) => r.deliveryId));
    const pct = (n: number, d: number) => (d ? `${Math.round((n * 1000) / d) / 10} %` : null);
    return {
      delivrance: measurable.length ? { statut: 'MESURE' as const, taux: pct(deliveredIds.size, measurable.length), delivres: deliveredIds.size, mesurables: measurable.length, echecs: failed.size }
        : { statut: 'NON_MESURE' as const, motif: 'Aucun envoi sur un canal raccordé ni accusé de remise reçu (bac à sable seulement).' },
      delai: delays.length ? { statut: 'MESURE' as const, medianeMinutes: Math.round(delays[Math.floor(delays.length / 2)]! * 10) / 10, accuses: delays.length } : { statut: 'NON_MESURE' as const, motif: 'Aucun accusé de délivrance horodaté reçu d’un fournisseur.' },
      ouverture: {
        messages: deliveredIds.size ? { statut: 'MESURE' as const, taux: pct([...opened].filter((id) => deliveredIds.has(id)).length, deliveredIds.size) } : { statut: 'NON_MESURE' as const, motif: 'Aucun message délivré.' },
        avisLegaux: notices.length ? { statut: 'MESURE' as const, taux: pct(notices.filter((n) => !!n.readAt).length, notices.filter((n) => n.notification === 'NOTIFIE').length || notices.length), avis: notices.length } : { statut: 'NON_MESURE' as const, motif: 'Aucun avis légal émis.' },
      },
      bacASable: sandbox,
      avisPlaque: { aApposer: this.plateNotices.find((p) => p.status === 'A_APPOSER').length, apposes: this.plateNotices.find((p) => p.status === 'APPOSE').length },
      modeles: { actifs: this.templates.find((t) => t.status === 'ACTIF').length, brouillons: this.templates.find((t) => t.status === 'BROUILLON').length },
      raccordement: '[À RACCORDER — convention requise] agrégateur SMS, SMTP, WhatsApp Business, opérateur vocal : bac à sable journalisé tant qu’aucune convention n’est signée.',
    };
  }

  /** Destinataire contribuable (utilitaire des tests et des écrans guichet). */
  recipientOf(taxpayerId: string): Recipient | undefined {
    const tp = this.ctx.taxpayers.taxpayers.get(taxpayerId);
    return tp ? taxpayerRecipient(tp) : undefined;
  }
}
