/**
 * Adaptateurs de canaux (§ 11.4). Un fournisseur par canal, derrière une interface commune.
 * - `in-app` : canal interne de référence, toujours raccordé (boîte de réception du compte).
 * - autres canaux : si aucune clé fournisseur n'est configurée (variable d'environnement),
 *   l'envoi est enregistré « journalise » (bac à sable) sans être transmis — le parcours reste testable.
 * - clé configurée : le message est placé en file pour le connecteur sortant (« en_file ») ;
 *   les connecteurs réels (SMTP, agrégateur SMS, etc.) ne font pas partie de ce socle.
 */
import type { Channel, LanguageCode } from '@mosolo/shared';

export type DeliveryStatus = 'en_file' | 'envoye' | 'delivre' | 'lu' | 'echoue' | 'journalise' | 'supprime_par_preference';
export type ProviderMode = 'internal' | 'live' | 'sandbox';

export interface OutboundMessage {
  channel: Channel;
  recipientId: string;
  eventCode: string;
  subject: string;
  body: string;
  entity: string;
  lang: LanguageCode;
  mandatory: boolean;
  /** Pièces jointes (courriel uniquement) : ex. quittance PDF signée (§ 18A.4). */
  attachments?: MessageAttachment[];
}

export interface MessageAttachment {
  name: string;
  contentType: string;
  sha256: string;
  size: number;
  /** Contenu transmis au connecteur sortant (jamais journalisé). */
  content?: Buffer;
}

export interface SendResult {
  status: DeliveryStatus;
  providerMessageId?: string;
}

export interface ChannelProvider {
  readonly channel: Channel;
  readonly name: string;
  readonly mode: ProviderMode;
  send(message: OutboundMessage): SendResult;
}

export class SandboxProvider implements ChannelProvider {
  readonly mode = 'sandbox' as const;
  readonly name: string;
  constructor(readonly channel: Channel) {
    this.name = `bac-a-sable-${channel}`;
  }
  send(): SendResult {
    return { status: 'journalise' };
  }
}

export interface InboxMessage {
  eventCode: string;
  subject: string;
  body: string;
  entity: string;
  mandatory: boolean;
  at: string;
}

export class InAppProvider implements ChannelProvider {
  readonly channel = 'in-app' as const;
  readonly name = 'mosolo-in-app';
  readonly mode = 'internal' as const;
  private readonly inboxes = new Map<string, InboxMessage[]>();
  private seq = 0;
  constructor(private readonly now: () => Date) {}
  send(m: OutboundMessage): SendResult {
    const box = this.inboxes.get(m.recipientId) ?? [];
    box.push({ eventCode: m.eventCode, subject: m.subject, body: m.body, entity: m.entity, mandatory: m.mandatory, at: this.now().toISOString() });
    this.inboxes.set(m.recipientId, box);
    return { status: 'delivre', providerMessageId: `INAPP-${++this.seq}` };
  }
  inbox(recipientId: string): InboxMessage[] {
    return [...(this.inboxes.get(recipientId) ?? [])];
  }
}

/** Fournisseur externe configuré : file sortante vers le connecteur (hors socle). */
export class QueuedExternalProvider implements ChannelProvider {
  readonly mode = 'live' as const;
  readonly name: string;
  readonly queue: OutboundMessage[] = [];
  constructor(readonly channel: Channel, providerName: string) {
    this.name = providerName;
  }
  send(m: OutboundMessage): SendResult {
    this.queue.push(m);
    return { status: 'en_file', providerMessageId: `${this.channel.toUpperCase()}-${this.queue.length}` };
  }
}

/** Variables d'environnement lues pour les clés fournisseurs, par canal. */
export const PROVIDER_ENV_KEYS: Record<Exclude<Channel, 'in-app'>, string> = {
  email: 'MOSOLO_EMAIL_PROVIDER_KEY',
  sms: 'MOSOLO_SMS_PROVIDER_KEY',
  push: 'MOSOLO_PUSH_PROVIDER_KEY',
  whatsapp: 'MOSOLO_WHATSAPP_PROVIDER_KEY',
  ussd: 'MOSOLO_USSD_PROVIDER_KEY',
  svi: 'MOSOLO_SVI_PROVIDER_KEY',
  courrier: 'MOSOLO_COURRIER_PROVIDER_KEY',
};
