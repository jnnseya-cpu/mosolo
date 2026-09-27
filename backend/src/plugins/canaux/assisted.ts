/**
 * Paiement NUMÉRIQUE assisté par l'agent de terrain (décision du maître d'ouvrage) :
 * - l'agent ne reçoit JAMAIS d'espèces ; les espèces se paient uniquement dans un point agréé ou au guichet bancaire ;
 * - l'agent peut en revanche faire payer sur place par les canaux numériques du circuit commun : il émet (ou ré-affiche)
 *   la référence officielle AU NOM DU SEUL TITULAIRE ; l'usager paie depuis SON téléphone (monnaie mobile, USSD, QR)
 *   ou par carte ; l'argent va directement au compte public ; la confirmation signée du prestataire produit la quittance ;
 * - le montant est le solde de l'obligation (jamais saisi) ; aucune donnée de paiement de l'usager n'est demandée ;
 * - l'agent doit être sur place (position GPS précise, près de l'objet s'il est fixe) et dans son secteur ;
 * - chaque référence assistée est journalisée avec l'agent, la position et le canal.
 * Aucun circuit parallèle : c'est le même ordre de paiement que dans l'application, l'USSD ou au guichet.
 */
import { z } from 'zod';
import { Money } from '@mosolo/shared';
import type { User } from '../../core/auth.js';
import { ApiError, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { authorize, evaluate } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import type { AppContext } from '../../context.js';
import { orderView, type PaymentOrder } from '../../modules/payments/service.js';
import { CONNECTOR_IDS } from '../../modules/payments/connectors/types.js';
import { distanceM } from '../terrain/geo.js';
import { holderPrincipal } from './points.js';

/** Canaux numériques que l'agent peut proposer. Les espèces (point agréé) en sont exclues par construction. */
export const ASSIST_CHANNELS = ['MOBILE_MONEY', 'USSD', 'QR', 'CARD'] as const;
export type AssistChannel = (typeof ASSIST_CHANNELS)[number];
export const ASSIST_MAX_ACCURACY_M = 100;
/** Distance maximale entre l'agent et un objet fixe (bien, commerce, étal, chantier, support). */
export const ASSIST_ON_SITE_M = 300;
const PAYABLE = ['EMISE', 'EXIGIBLE', 'EN_RETARD', 'PARTIELLEMENT_PAYEE'];
const MOBILE_CATEGORIES = new Set(['VEHICULE']);

export const assistOrderSchema = z.object({
  obligationId: z.string().min(1).max(80),
  channel: z.string().min(1).max(40),
  provider: z.enum(CONNECTOR_IDS).optional(),
  lat: z.number().min(-5.2).max(-3.9),
  lon: z.number().min(15).max(16.6),
  accuracyM: z.number().positive().max(100_000),
}).strict();
export type AssistOrderInput = z.infer<typeof assistOrderSchema>;

export interface AssistedPayment {
  id: string; orderId: string; paymentReference: string; obligationId: string; taxpayerId: string; agentId: string;
  channel: AssistChannel; provider: string | null; at: string; lat: number; lon: number; accuracyM: number; distanceToObjectM: number | null; reused: boolean;
}

export const CASH_GUIDANCE = 'Espèces : jamais à l’agent. L’usager paie en espèces uniquement dans un point de paiement agréé ou au guichet bancaire MOSOLO, avec la même référence (liste : « Où payer ? »).';

export class AssistedPaymentService {
  readonly records = new InMemoryRepository<AssistedPayment>();
  private readonly ids = new IdGenerator();
  constructor(private readonly ctx: AppContext) {}

  private obligation(id: string) {
    const ob = this.ctx.assessment.obligations.get(id);
    if (!ob) throw notFound('OBLIGATION_NOT_FOUND', `Obligation inconnue : ${id}`);
    return ob;
  }
  private communeOf(ob: { attribution?: { commune: string | null }; objectId: string }): string | null {
    return ob.attribution?.commune ?? this.ctx.objects.objects.get(ob.objectId)?.commune ?? null;
  }
  private allowed(user: User, commune: string | null) {
    return evaluate(user, 'canaux:payment.assist', { communes: commune ? [commune] : user.territory ?? [] });
  }

  /** Ce que l'usager peut payer maintenant : obligations payables d'un objet, ou liste d'obligations (pénalités). */
  payables(user: User, q: { objectId?: string; obligationIds?: string[] }) {
    authorize(user, 'canaux:payment.assist', { communes: user.territory ?? [] });
    const obs = q.objectId
      ? this.ctx.assessment.obligations.find((o) => o.objectId === q.objectId)
      : (q.obligationIds ?? []).map((id) => this.ctx.assessment.obligations.get(id)).filter((o): o is NonNullable<typeof o> => !!o);
    const items = obs
      .filter((o) => PAYABLE.includes(o.status) && this.allowed(user, this.communeOf(o)))
      // Un paiement confirmé couvrant le solde (rapprochement en cours) : plus rien à payer.
      .filter((o) => { const left = Money.fromJSON(o.amount).subtract(this.ctx.payments.paidOn(o.id)); return !left.isZero() && !left.isNegative(); })
      .map((o) => {
        const paid = this.ctx.payments.paidOn(o.id);
        const active = this.ctx.payments.byObligation(o.id).find((p) => p.status === 'INITIE' && Date.parse(p.expiresAt) > this.ctx.clock.now().getTime());
        return {
          obligationId: o.id, label: o.label, status: o.status, dueDate: o.dueDate, amount: o.amount, paid: paid.toJSON(),
          activeReference: active ? { paymentReference: active.paymentReference, expiresAt: active.expiresAt, channel: active.channel } : null,
        };
      })
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    return { items, channels: ASSIST_CHANNELS, cash: CASH_GUIDANCE, notice: 'Le montant est le solde de l’obligation : il ne se saisit pas et ne se négocie pas. L’usager paie depuis son téléphone ou par carte, vers le compte public.' };
  }

  /** Émet (ou ré-affiche) la référence au nom du titulaire, pour un canal numérique, agent sur place. */
  async issue(user: User, input: AssistOrderInput): Promise<{ order: ReturnType<typeof orderView>; record: AssistedPayment; guidance: string[] }> {
    if (!(ASSIST_CHANNELS as readonly string[]).includes(input.channel)) {
      throw unprocessable('CASH_NOT_ALLOWED_FOR_AGENT', `Canal « ${input.channel} » refusé : un agent ne fait payer que par canal numérique (monnaie mobile, USSD, QR, carte). ${CASH_GUIDANCE}`, { allowed: ASSIST_CHANNELS });
    }
    const channel = input.channel as AssistChannel;
    const ob = this.obligation(input.obligationId);
    const commune = this.communeOf(ob);
    if (!this.allowed(user, commune)) throw forbidden('OUT_OF_TERRITORY', 'Obligation hors de votre secteur ou rôle non habilité à assister un paiement.');
    if (!PAYABLE.includes(ob.status)) throw unprocessable('OBLIGATION_NOT_PAYABLE', 'Cette obligation n’est pas payable (déjà soldée, annulée ou contestée).');
    if (input.accuracyM > ASSIST_MAX_ACCURACY_M) throw unprocessable('GPS_TOO_IMPRECISE', `Position trop imprécise (± ${Math.round(input.accuracyM)} m) : ${ASSIST_MAX_ACCURACY_M} m au plus.`);
    const obj = this.ctx.objects.objects.get(ob.objectId);
    let dist: number | null = null;
    if (obj && !MOBILE_CATEGORIES.has(obj.category) && Number.isFinite(obj.lat) && Number.isFinite(obj.lon)) {
      dist = distanceM({ lat: input.lat, lon: input.lon }, obj);
      if (dist > ASSIST_ON_SITE_M + input.accuracyM) throw unprocessable('NOT_ON_SITE', `Vous êtes à ${dist} m du bien : un paiement assisté se fait sur place (${ASSIST_ON_SITE_M} m au plus).`, { distanceM: dist });
    }
    // Ordre du circuit commun, au nom du seul titulaire (aucune donnée de paiement de l'usager, aucun compte de l'agent).
    const principal = holderPrincipal(ob.taxpayerId, `agent-${channel}`);
    const orderChannel = channel === 'CARD' ? 'CARD' : channel;
    let order: PaymentOrder;
    let reused = false;
    try {
      order = input.provider && (channel === 'MOBILE_MONEY' || channel === 'QR')
        ? await this.ctx.payments.createOrderWithProvider(principal, ob.id, { channel: orderChannel, provider: input.provider })
        : this.ctx.payments.createOrder(principal, ob.id, { channel: orderChannel });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ACTIVE_PAYMENT_REFERENCE_EXISTS') {
        const existing = this.ctx.payments.byReference(String(e.extensions.paymentReference ?? ''));
        if (!existing) throw e;
        order = existing; reused = true;
      } else throw e;
    }
    const record: AssistedPayment = {
      id: this.ids.next('PAS'), orderId: order.id, paymentReference: order.paymentReference, obligationId: ob.id, taxpayerId: ob.taxpayerId, agentId: user.id,
      channel, provider: input.provider ?? null, at: this.ctx.clock.now().toISOString(), lat: input.lat, lon: input.lon, accuracyM: Math.round(input.accuracyM), distanceToObjectM: dist, reused,
    };
    this.records.insert(record);
    this.ctx.audit.append({
      actor: { kind: 'user', id: user.id, roles: user.roles }, action: 'payment.assisted.reference', resourceType: 'payment_order', resourceId: order.id,
      details: { paymentReference: order.paymentReference, obligationId: ob.id, channel, provider: input.provider ?? null, reused, lat: input.lat, lon: input.lon, accuracyM: record.accuracyM, distanceToObjectM: dist, commune },
    });
    const ref = order.paymentReference;
    const guidance = [
      channel === 'MOBILE_MONEY' ? `L’usager paie depuis SON téléphone (monnaie mobile) vers le compte public, avec la référence ${ref}.`
        : channel === 'USSD' ? `L’usager compose le code USSD officiel de MOSOLO sur SON téléphone et saisit la référence ${ref.replace(/-/g, '')}.`
          : channel === 'QR' ? 'L’usager scanne le QR avec SON application de paiement ; le montant et le compte public sont déjà renseignés.'
            : `Paiement par carte de l’usager, sur un terminal agréé ou dans l’application, avec la référence ${ref}.`,
      'Montant fixé : le solde de l’obligation. Il ne se négocie pas.',
      'Vous ne touchez ni argent, ni téléphone, ni carte, ni code secret de l’usager.',
      'La quittance arrive à l’usager (SMS, application) dès la confirmation du prestataire ; vous pouvez suivre l’état ici.',
      CASH_GUIDANCE,
    ];
    return { order: orderView(order), record, guidance };
  }

  /** État d'une référence que l'agent a assistée (pour rassurer l'usager sur place). */
  status(user: User, reference: string) {
    const rec = this.records.find((r) => r.paymentReference === reference && r.agentId === user.id).at(-1);
    if (!rec) throw notFound('ASSISTED_REFERENCE_NOT_FOUND', 'Référence non assistée par vous.');
    const order = this.ctx.payments.byReference(reference);
    if (!order) throw notFound('PAYMENT_REFERENCE_NOT_FOUND', 'Référence inconnue.');
    const paid = ['CONFIRME', 'REGLE', 'RAPPROCHE'].includes(order.status);
    return { paymentReference: reference, status: order.status, paid, expiresAt: order.expiresAt, amount: order.amount, confirmedAt: order.confirmedAt ?? null };
  }
}
