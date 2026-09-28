/**
 * Module 14 — Stationnement public : compléments de la Spécification fonctionnelle, construits sur ParkSmart.
 *
 *  - Sessions par USSD ou SMS (décision du maître d'ouvrage) : démarrer, prolonger, terminer, consulter, par commande
 *    texte. Le numéro appelant (attesté par la passerelle de l'opérateur, signature HMAC v2) doit être le téléphone du
 *    compte unique, et la plaque un véhicule DÉCLARÉ par ce compte ; le paiement suit le circuit commun (référence
 *    Mobile Money ou USSD, jamais d'espèces, jamais d'agent). Passerelle réelle : [À RACCORDER — convention requise]
 *    (code court et numéro SMS attribués par convention avec les opérateurs, J29) ; simulateur authentifié fourni.
 *  - Exemptions : véhicules officiels (décision du maître d'ouvrage) et cas prévus par la règle (exonération inscrite
 *    dans la fiche de la règle tarifaire ACTIVE de la zone). Demande motivée avec pièces (régie), décision d'une AUTRE
 *    personne (autorité), révocable, datée ; un véhicule exempté est VERT au contrôle et aucune session ne lui est vendue.
 *  - Titres actifs d'une plaque : le contrôleur voit TOUS les titres valables (sessions, réservations, titres § 19A,
 *    exemptions), sur l'heure du serveur.
 */
import { createHash } from 'node:crypto';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { badRequest, conflict, forbidden, notFound, unauthorized, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { validityView } from '../../core/validity.js';
import { kinshasaDate } from '../../core/clock.js';
import { taxpayerRecipient } from '../../modules/identity/recipients.js';
import { CALLBACK_WINDOW_MS } from '../../modules/payments/service.js';
import { isValidNonce, NonceStore, verifyCallbackSignature } from '../../modules/payments/callback-signing.js';
import { statusAt } from '../titres/validity.js';
import { activeRule, paymentState } from './support.js';
import type { ParkingService } from './service.js';
import { PARKSMART_TITLE_MODULE } from './smart.js';

export const EXEMPTION_CATEGORIES = ['VEHICULE_OFFICIEL', 'CAS_PREVU_PAR_LA_REGLE'] as const;
export type ExemptionCategory = (typeof EXEMPTION_CATEGORIES)[number];
export const TEXT_CHANNELS = ['USSD', 'SMS'] as const;
export type TextChannel = (typeof TEXT_CHANNELS)[number];
/** Libellés d'accès : attribués par convention avec les opérateurs (J29) — jamais inventés. */
export const PARKING_TEXT_ACCESS = { ussd: '*[code court À CONFIGURER]# puis « Stationnement »', sms: 'SMS au [numéro court À CONFIGURER]', status: 'À RACCORDER — convention requise' } as const;

export interface ParkingExemption {
  id: string;
  plate: string;
  category: ExemptionCategory;
  /** Administration ou service bénéficiaire (véhicule officiel) ou titulaire (cas de la règle). */
  holder: string;
  /** Cas prévu par la règle : code de la règle tarifaire et libellé exact de l'exonération inscrite dans la fiche. */
  ruleCode: string | null;
  exemptionBasis: string | null;
  /** Zones concernées (vide : toutes les zones). */
  zoneIds: string[];
  validFrom: string;
  validUntil: string;
  documents: string[];
  motif: string;
  status: 'DEMANDEE' | 'ACCORDEE' | 'REFUSEE' | 'REVOQUEE';
  requestedBy: string;
  requestedAt: string;
  decision?: { by: string; at: string; motif: string };
  revocation?: { by: string; at: string; motif: string };
}

export interface TextExchange {
  id: string;
  channel: TextChannel;
  via: 'PASSERELLE' | 'SIMULATEUR';
  msisdnHash: string;
  command: string;
  outcome: 'OK' | 'REFUS';
  reply: string;
  sessionId?: string;
  at: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ParkingComplements {
  readonly exemptions = new InMemoryRepository<ParkingExemption>();
  readonly exchanges = new InMemoryAppendOnlyRepository<TextExchange>();
  private readonly nonces = new NonceStore(10_000);
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext, private readonly svc: ParkingService) {}

  private now(): Date { return this.ctx.clock.now(); }

  // ============================================================================ Exemptions

  requestExemption(user: User, input: { plate: string; category: ExemptionCategory; holder: string; ruleCode?: string; exemptionBasis?: string; zoneIds: string[]; validFrom: string; validUntil: string; documents: string[]; motif: string }) {
    authorize(user, 'parking:exemption.request', { entity: 'DGTK' });
    const plate = this.svc.plate(input.plate);
    if (!DATE.test(input.validFrom) || !DATE.test(input.validUntil) || input.validUntil < input.validFrom) throw badRequest('INVALID_PERIOD', 'Période de validité AAAA-MM-JJ, fin postérieure au début.');
    for (const z of input.zoneIds) this.svc.getZone(z);
    if (!input.documents.length) throw badRequest('DOCUMENTS_REQUIRED', 'Pièce justificative requise (carte grise administrative, ordre de mission, décision).');
    let ruleCode: string | null = null;
    let basis: string | null = null;
    if (input.category === 'CAS_PREVU_PAR_LA_REGLE') {
      // Seule une exonération INSCRITE dans la fiche d'une règle ACTIVE peut fonder une exemption (aucun cas inventé).
      const rule = activeRule(this.ctx, input.ruleCode ?? null);
      if (!rule) throw unprocessable('RULE_NOT_ACTIVE', `Règle ${input.ruleCode ?? '(non précisée)'} non ACTIVE : aucune exemption ne peut s'y adosser.`);
      // La règle invoquée est la grille tarifaire des zones concernées (toutes zones : celle d'au moins une zone).
      const zoneRules = (input.zoneIds.length ? input.zoneIds.map((z) => this.svc.getZone(z)) : this.svc.zones.all()).map((z) => z.tariffRuleCode);
      if (input.zoneIds.length ? zoneRules.some((c) => c !== rule.code) : !zoneRules.includes(rule.code)) {
        throw unprocessable('RULE_NOT_ZONE_TARIFF', `La règle ${rule.code} n'est pas la grille tarifaire des zones concernées.`);
      }
      const match = rule.exemptions.find((e) => e.basis.trim().toLowerCase() === (input.exemptionBasis ?? '').trim().toLowerCase());
      if (!match) throw unprocessable('EXEMPTION_NOT_IN_RULE', `L'exonération invoquée n'est pas prévue par la règle ${rule.code} v${rule.version} (cas prévus : ${rule.exemptions.map((e) => e.basis).join(' ; ') || 'aucun'}).`);
      ruleCode = rule.code; basis = match.basis;
    }
    const dup = this.exemptions.findOne((e) => e.plate === plate && (e.status === 'DEMANDEE' || e.status === 'ACCORDEE') && e.validUntil >= input.validFrom && e.validFrom <= input.validUntil);
    if (dup) throw conflict('EXEMPTION_EXISTS', `Exemption déjà ${dup.status === 'DEMANDEE' ? 'demandée' : 'accordée'} pour ${plate} sur cette période (${dup.id}).`, { exemptionId: dup.id });
    const e = this.exemptions.insert({
      id: this.ids.next('EXS'), plate, category: input.category, holder: input.holder, ruleCode, exemptionBasis: basis, zoneIds: input.zoneIds,
      validFrom: input.validFrom, validUntil: input.validUntil, documents: input.documents, motif: input.motif, status: 'DEMANDEE', requestedBy: user.id, requestedAt: this.now().toISOString(),
    });
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.exemption.requested', resourceType: 'plate', resourceId: plate, details: { exemptionId: e.id, category: e.category, ruleCode, basis, validUntil: e.validUntil } });
    return e;
  }

  decideExemption(user: User, id: string, input: { approve: boolean; motif: string }) {
    authorize(user, 'parking:exemption.decide', { entity: 'DGTK' });
    const e = this.exemptions.get(id);
    if (!e) throw notFound('EXEMPTION_NOT_FOUND', `Exemption inconnue : ${id}`);
    if (e.status !== 'DEMANDEE') throw conflict('EXEMPTION_CLOSED', `Exemption déjà ${e.status.toLowerCase()}.`);
    try {
      assertDistinctPerson(user.id, [e.requestedBy], 'Quatre yeux : l’exemption est accordée par une personne distincte de celle qui l’a demandée.');
    } catch (err) {
      this.ctx.audit.append({ actor: actorOf(user), action: 'parking.exemption.decision_refused', resourceType: 'plate', resourceId: e.plate, outcome: 'DENIED', details: { reason: 'SEPARATION_OF_DUTIES', exemptionId: id } });
      throw err;
    }
    const saved = this.exemptions.update({ ...e, status: input.approve ? 'ACCORDEE' : 'REFUSEE', decision: { by: user.id, at: this.now().toISOString(), motif: input.motif } });
    this.ctx.audit.append({ actor: actorOf(user), action: input.approve ? 'parking.exemption.granted' : 'parking.exemption.refused', resourceType: 'plate', resourceId: e.plate, details: { exemptionId: id, motif: input.motif } });
    return saved;
  }

  revokeExemption(user: User, id: string, motif: string) {
    authorize(user, 'parking:exemption.decide', { entity: 'DGTK' });
    const e = this.exemptions.get(id);
    if (!e) throw notFound('EXEMPTION_NOT_FOUND', `Exemption inconnue : ${id}`);
    if (e.status !== 'ACCORDEE') throw conflict('EXEMPTION_NOT_GRANTED', 'Seule une exemption accordée peut être révoquée.');
    const saved = this.exemptions.update({ ...e, status: 'REVOQUEE', revocation: { by: user.id, at: this.now().toISOString(), motif } });
    this.ctx.audit.append({ actor: actorOf(user), action: 'parking.exemption.revoked', resourceType: 'plate', resourceId: e.plate, details: { exemptionId: id, motif } });
    return saved;
  }

  listExemptions(user: User) {
    authorize(user, 'parking:exemption.read', { entity: 'DGTK' });
    const today = this.today();
    return this.exemptions.all().sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)).map((e) => ({ ...e, inForce: e.status === 'ACCORDEE' && e.validFrom <= today && e.validUntil >= today }));
  }

  /** Jour de référence : heure du serveur, fuseau de Kinshasa. */
  private today(): string {
    return kinshasaDate(this.now());
  }

  /** Exemption en vigueur pour la plaque (et la zone), à l'heure du serveur. */
  exemptionFor(plate: string, zoneId: string | null, now: Date): ParkingExemption | null {
    const day = kinshasaDate(now);
    return this.exemptions.find((e) => e.plate === plate && e.status === 'ACCORDEE' && e.validFrom <= day && e.validUntil >= day && (!zoneId || e.zoneIds.length === 0 || e.zoneIds.includes(zoneId)))[0] ?? null;
  }

  // ============================================================================ Tous les titres actifs d'une plaque

  activeTitles(plate: string, now: Date) {
    const out: { kind: 'SESSION' | 'RESERVATION' | 'TITRE' | 'EXEMPTION'; zone: string | null; reference: string; validFrom: string | null; validUntil: string | null; light: 'VERT' | 'AMBRE'; text: string }[] = [];
    for (const s of this.svc.sessions.find((x) => x.plate === plate)) {
      const d = this.svc.sessionDerived(s, now);
      if (d.status !== 'ACTIVE') continue;
      const z = this.svc.zones.get(s.zoneId);
      out.push({ kind: 'SESSION', zone: z?.code ?? s.zoneId, reference: s.ticketCode ?? s.id, validFrom: d.startAt?.toISOString() ?? null, validUntil: d.paidUntil?.toISOString() ?? null, light: d.light === 'VERT' ? 'VERT' : 'AMBRE', text: d.light === 'VERT' ? 'Session payée' : 'Session bientôt expirée' });
    }
    for (const r of this.svc.reservations.find((x) => x.plate === plate && x.status === 'APPROUVEE')) {
      const pay = paymentState(this.ctx, r.obligationId);
      if ((pay.state === 'PAYE' || pay.state === 'RAPPROCHE') && new Date(r.startAt) <= now && new Date(r.endAt) > now) {
        out.push({ kind: 'RESERVATION', zone: this.svc.zones.get(r.zoneId)?.code ?? r.zoneId, reference: r.id, validFrom: r.startAt, validUntil: r.endAt, light: 'VERT', text: 'Réservation de voirie payée' });
      }
    }
    const t = this.svc.smart.titres;
    if (t) {
      for (const c of t.byPlate(plate, PARKSMART_TITLE_MODULE, now)) {
        const st = statusAt(c, now);
        if (!['VALIDE', 'BIENTOT_EXPIRE', 'CRITIQUE'].includes(st.status)) continue;
        out.push({ kind: 'TITRE', zone: c.place.label, reference: c.number, validFrom: c.validFrom, validUntil: c.validUntil, light: st.status === 'VALIDE' ? 'VERT' : 'AMBRE', text: st.text });
      }
    }
    const today = kinshasaDate(now);
    for (const e of this.exemptions.find((x) => x.plate === plate && x.status === 'ACCORDEE' && x.validFrom <= today && x.validUntil >= today)) {
      out.push({ kind: 'EXEMPTION', zone: e.zoneIds.length ? e.zoneIds.map((z) => this.svc.zones.get(z)?.code ?? z).join(', ') : 'Toutes zones', reference: e.id, validFrom: e.validFrom, validUntil: e.validUntil, light: 'VERT', text: e.category === 'VEHICULE_OFFICIEL' ? 'Exempté — véhicule officiel' : `Exempté — ${e.exemptionBasis ?? 'cas prévu par la règle'}` });
    }
    return out.map((x) => ({ ...x, validity: x.validFrom && x.validUntil && x.kind !== 'EXEMPTION' ? validityView(x.validFrom, x.validUntil, now) : null }));
  }

  // ============================================================================ Sessions par USSD ou SMS

  private hashMsisdn(msisdn: string): string {
    return createHash('sha256').update(`mosolo-parking-canal:${msisdn}`).digest('hex').slice(0, 32);
  }

  /** Passerelle de l'opérateur : message signé (schéma v2 des rappels : horodatage + nonce + corps, fenêtre ±5 min). */
  gateway(operator: string, headers: { signature?: string; nonce?: string; timestamp?: string }, rawBody: string) {
    const secret = this.ctx.secrets.providerSecrets[operator];
    if (!secret) throw notFound('UNKNOWN_OPERATOR', `Passerelle non habilitée : ${operator} (${PARKING_TEXT_ACCESS.status}).`);
    const { signature, nonce, timestamp } = headers;
    if (!signature || !nonce || !timestamp || !isValidNonce(nonce)) throw unauthorized('GATEWAY_HEADERS_MISSING', 'En-têtes x-signature, x-nonce et x-timestamp valides obligatoires.');
    if (!verifyCallbackSignature([{ kid: 'default', secret }], signature, timestamp, nonce, rawBody)) throw unauthorized('INVALID_SIGNATURE', 'Signature de la passerelle invalide.');
    const ts = Date.parse(timestamp);
    const now = this.now().getTime();
    if (Number.isNaN(ts) || Math.abs(now - ts) > CALLBACK_WINDOW_MS) throw unauthorized('TIMESTAMP_OUT_OF_WINDOW', 'Horodatage hors de la fenêtre de ±5 minutes.');
    if (!this.nonces.remember(`${operator}:${nonce}`, ts + CALLBACK_WINDOW_MS + 1000, now).fresh) throw conflict('NONCE_REPLAYED', 'Nonce déjà utilisé : rejeu refusé.');
    let body: { channel?: string; msisdn?: string; text?: string };
    try { body = JSON.parse(rawBody) as typeof body; } catch { throw badRequest('INVALID_JSON', 'Corps JSON invalide.'); }
    if (!body.channel || !(TEXT_CHANNELS as readonly string[]).includes(body.channel) || !body.msisdn || typeof body.text !== 'string') throw badRequest('VALIDATION_ERROR', 'channel (USSD|SMS), msisdn et text requis.');
    return this.handle(body.channel as TextChannel, body.msisdn, body.text, 'PASSERELLE');
  }

  /** Simulateur (démonstration) : le contribuable connecté joue son propre téléphone ; même moteur que la passerelle. */
  simulate(user: User, input: { channel: TextChannel; text: string }) {
    if (!user.taxpayerId) throw forbidden('NO_TAXPAYER_ACCOUNT', 'Compte contribuable requis (compte unique MOSOLO).');
    authorize(user, 'parking:session.create', { taxpayerId: user.taxpayerId });
    const tp = this.ctx.taxpayers.get(user.taxpayerId);
    return this.handle(input.channel, tp.phone, input.text, 'SIMULATEUR');
  }

  /**
   * Commandes (SMS : mots séparés par des espaces ; USSD : champs séparés par « * ») :
   *   STAT <zone> <plaque> <minutes>  | 1*zone*plaque*minutes — démarrer ;
   *   PROL <ticket|plaque> <minutes>  | 2*ticket*minutes      — prolonger ;
   *   FIN <ticket|plaque>             | 3*ticket              — terminer ;
   *   ETAT <plaque>                   | 4*plaque              — consulter.
   */
  handle(channel: TextChannel, msisdnRaw: string, text: string, via: TextExchange['via']) {
    const msisdn = msisdnRaw.replace(/[\s-]/g, '');
    const tp = this.ctx.taxpayers.findByPhone(msisdn); // compte unique (fusion suivie)
    const parts = (channel === 'USSD' ? text.split('*') : text.trim().split(/\s+/)).map((p) => p.trim()).filter(Boolean);
    const verb = ({ '1': 'STAT', '2': 'PROL', '3': 'FIN', '4': 'ETAT' } as Record<string, string>)[parts[0] ?? ''] ?? (parts[0] ?? '').toUpperCase();
    const at = this.now().toISOString();
    const log = (outcome: TextExchange['outcome'], reply: string, sessionId?: string) => {
      const x = this.exchanges.append({ id: this.ids.next('PKTXT'), channel, via, msisdnHash: this.hashMsisdn(msisdn), command: verb || '?', outcome, reply, ...(sessionId ? { sessionId } : {}), at });
      this.ctx.audit.append({ actor: { kind: 'public', id: `canal-${channel.toLowerCase()}` }, action: 'parking.text_channel.handled', resourceType: 'parking_text_exchange', resourceId: x.id, outcome: outcome === 'OK' ? 'SUCCESS' : 'FAILURE', details: { channel, via, command: x.command, sessionId: sessionId ?? null, taxpayerId: tp?.id ?? null } });
      return { reply, outcome, ...(sessionId ? { sessionId } : {}), channel, access: PARKING_TEXT_ACCESS };
    };
    if (!tp) return log('REFUS', 'Numéro non rattaché à un compte MOSOLO. Inscrivez-vous au guichet ou auprès d’un agent.');
    const principal: User = { kind: 'user', id: `canal-${channel.toLowerCase()}:${tp.id}`, name: `Canal ${channel} du titulaire`, roles: ['R30'], entity: 'PUBLIC', taxpayerId: tp.id };
    const payChannel = channel === 'USSD' ? 'USSD' as const : 'MOBILE_MONEY' as const;
    const own = (plateRaw: string) => {
      const plate = this.svc.plate(plateRaw);
      if (!this.svc.vehicles.findOne((v) => v.plate === plate && v.taxpayerId === tp.id)) throw forbidden('PLATE_NOT_DECLARED', `Plaque ${plate} non déclarée sur votre compte : déclarez-la d’abord dans l’application ou au guichet.`);
      return plate;
    };
    const sessionOf = (ref: string) => {
      const r = ref.toUpperCase();
      const mine = this.svc.sessions.find((s) => s.payerTaxpayerId === tp.id && (s.ticketCode?.toUpperCase() === r || s.id.toUpperCase() === r || s.plate === this.svc.plate(ref)));
      const running = mine.filter((s) => ['ACTIVE', 'EN_ATTENTE_PAIEMENT'].includes(this.svc.sessionDerived(s, this.now()).status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!running) throw notFound('PARKING_SESSION_NOT_FOUND', 'Aucune session en cours pour cette référence.');
      return running;
    };
    const order = (obligationId: string) => this.ctx.payments.createOrder(principal, obligationId, { channel: payChannel });
    try {
      if (verb === 'STAT') {
        const [, zoneRef, plateRaw, minutesRaw] = parts;
        if (!zoneRef || !plateRaw || !minutesRaw) return log('REFUS', 'Format : STAT <zone> <plaque> <minutes>.');
        const zone = this.svc.getZone(zoneRef);
        const plate = own(plateRaw);
        if (this.exemptionFor(plate, zone.id, this.now())) return log('REFUS', `${plate} : véhicule exempté dans cette zone — aucune session due.`);
        const res = this.svc.startSession(principal, { zoneId: zone.id, plate, durationMinutes: Number.parseInt(minutesRaw, 10), taxpayerId: tp.id });
        const o = order(res.obligation.id);
        this.ctx.comms.publish('payment.reference.issued', [taxpayerRecipient(tp)], { reference: o.paymentReference }, { entity: 'DGTK' });
        return log('OK', `Session ${res.session.ticketCode} ${zone.code} ${plate} ${minutesRaw} min : ${o.amount.amount} ${o.amount.currency}. Payez la référence ${o.paymentReference} par ${payChannel === 'USSD' ? 'USSD' : 'Mobile Money'}. Validité dès confirmation.`, res.session.id);
      }
      if (verb === 'PROL') {
        const [, ref, minutesRaw] = parts;
        if (!ref || !minutesRaw) return log('REFUS', 'Format : PROL <ticket> <minutes>.');
        const s = sessionOf(ref);
        const res = this.svc.extendSession(principal, s.id, Number.parseInt(minutesRaw, 10));
        const o = order(res.obligation.id);
        return log('OK', `Prolongation ${minutesRaw} min : ${o.amount.amount} ${o.amount.currency}. Payez la référence ${o.paymentReference}.`, s.id);
      }
      if (verb === 'FIN') {
        const [, ref] = parts;
        if (!ref) return log('REFUS', 'Format : FIN <ticket>.');
        const s = sessionOf(ref);
        this.svc.endSession(principal, s.id);
        return log('OK', `Session ${s.ticketCode ?? s.id} terminée. Place libérée.`, s.id);
      }
      if (verb === 'ETAT') {
        const [, plateRaw] = parts;
        if (!plateRaw) return log('REFUS', 'Format : ETAT <plaque>.');
        const plate = own(plateRaw);
        const titles = this.activeTitles(plate, this.now());
        if (!titles.length) return log('OK', `${plate} : aucun titre valide (heure du serveur).`);
        return log('OK', `${plate} : ${titles.map((x) => `${x.text}${x.validUntil ? ` jusqu’à ${x.validUntil.slice(11, 16)} UTC` : ''} (${x.zone ?? ''})`).join(' ; ')}`.slice(0, 300));
      }
      return log('REFUS', 'Commande inconnue. STAT, PROL, FIN ou ETAT (USSD : 1, 2, 3 ou 4).');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return log('REFUS', `Opération impossible : ${msg}`.slice(0, 300));
    }
  }

  channelStats(user: User) {
    authorize(user, 'parking:indicators', { entity: 'DGTK' });
    const all = this.exchanges.all();
    return {
      access: PARKING_TEXT_ACCESS,
      total: all.length, ok: all.filter((x) => x.outcome === 'OK').length,
      byChannel: TEXT_CHANNELS.map((c) => ({ channel: c, count: all.filter((x) => x.channel === c).length, sessions: new Set(all.filter((x) => x.channel === c && x.command === 'STAT' && x.outcome === 'OK').map((x) => x.sessionId)).size })),
      recent: all.slice(-20).reverse().map((x) => ({ id: x.id, channel: x.channel, via: x.via, command: x.command, outcome: x.outcome, at: x.at })),
    };
  }
}
