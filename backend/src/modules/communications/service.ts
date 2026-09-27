/**
 * Moteur d'événements de communication (module 39, § 11.4) :
 * publish(événement, destinataires, variables) → diffusion multi-canal selon `resolveChannels` (shared),
 * une ligne de délivrance par événement × canal × destinataire.
 */
import {
  CHANNELS, EVENT_CATEGORIES, EVENTS, channelCoverage, getEvent, resolveChannels,
  type Channel, type CommunicationEvent, type LanguageCode,
} from '@mosolo/shared';
import type { Clock } from '../../core/clock.js';
import { sha256Hex } from '../../core/crypto.js';
import { notFound } from '../../core/errors.js';
import { IdGenerator, InMemoryAppendOnlyRepository } from '../../core/repository.js';
import {
  InAppProvider, PROVIDER_ENV_KEYS, QueuedExternalProvider, SandboxProvider,
  type ChannelProvider, type DeliveryStatus, type MessageAttachment, type ProviderMode,
} from './providers.js';
import { fillPlaceholders, renderText, smsText } from './templates.js';

export interface RecipientPrefs {
  optedOut?: boolean;
  disabledChannels?: Channel[];
  whatsappConsent?: boolean;
}

export interface Recipient {
  id: string;
  kind: 'taxpayer' | 'user';
  name: string;
  lang: LanguageCode;
  prefs: RecipientPrefs;
}

export interface Delivery {
  id: string;
  at: string;
  eventCode: string;
  category: string;
  channel: Channel;
  recipientId: string;
  recipientKind: Recipient['kind'];
  recipientMasked: string;
  status: DeliveryStatus;
  provider: string;
  providerMode: ProviderMode | 'aucun';
  mandatory: boolean;
  entity: string;
  lang: LanguageCode;
  attempts: number;
  contentHash: string;
  /** Pièces jointes transmises (courriel) : nom, empreinte, taille — jamais le contenu. */
  attachments?: { name: string; sha256: string; size: number }[];
}

export function maskName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.map((p) => (p[0] ?? '') + '***').join(' ');
}

export class CommunicationService {
  readonly deliveries = new InMemoryAppendOnlyRepository<Delivery>();
  readonly inApp: InAppProvider;
  private readonly providers = new Map<Channel, ChannelProvider>();
  private readonly ids = new IdGenerator();

  constructor(
    private readonly clock: Clock,
    providerKeys: Partial<Record<Channel, string>>,
  ) {
    this.inApp = new InAppProvider(() => clock.now());
    for (const channel of CHANNELS) {
      if (channel === 'in-app') this.providers.set(channel, this.inApp);
      else if (providerKeys[channel]) this.providers.set(channel, new QueuedExternalProvider(channel, `connecteur-${channel}`));
      else this.providers.set(channel, new SandboxProvider(channel));
    }
  }

  /** Clés fournisseurs lues dans l'environnement (absentes ⇒ bac à sable). */
  static providerKeysFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<Record<Channel, string>> {
    const out: Partial<Record<Channel, string>> = {};
    for (const [channel, key] of Object.entries(PROVIDER_ENV_KEYS)) {
      const v = env[key];
      if (v) out[channel as Channel] = v;
    }
    return out;
  }

  event(code: string): CommunicationEvent {
    const e = getEvent(code);
    if (!e) throw notFound('UNKNOWN_EVENT', `Événement inconnu au catalogue : ${code}`);
    return e;
  }

  publish(eventCode: string, recipients: Recipient[], vars: Record<string, string> = {}, opts: { entity?: string; attachments?: MessageAttachment[] } = {}): Delivery[] {
    const event = this.event(eventCode);
    const entity = opts.entity ?? 'GOUVERNORAT';
    const out: Delivery[] = [];
    for (const r of recipients) {
      const channels = resolveChannels(event, r.prefs);
      const suppressed = event.canaux_defaut.filter((c) => !channels.includes(c));
      const body = renderText(event, vars);
      const contentHash = sha256Hex(`${event.objet}\n${body}`);
      for (const channel of channels) {
        const provider = this.providers.get(channel)!;
        const attachments = channel === 'email' && opts.attachments?.length ? opts.attachments : undefined;
        const res = provider.send({
          channel, recipientId: r.id, eventCode, subject: fillPlaceholders(event.objet, vars), body: channel === 'sms' ? smsText(body) : body, entity, lang: r.lang, mandatory: event.obligatoire,
          ...(attachments ? { attachments } : {}),
        });
        const d = this.log(event, r, channel, res.status, provider.name, provider.mode, entity, contentHash, attachments);
        out.push(d);
      }
      for (const channel of suppressed) {
        out.push(this.log(event, r, channel, 'supprime_par_preference', 'aucun', 'aucun', entity, contentHash));
      }
    }
    return out;
  }

  private log(
    event: CommunicationEvent, r: Recipient, channel: Channel, status: DeliveryStatus,
    provider: string, providerMode: Delivery['providerMode'], entity: string, contentHash: string, attachments?: MessageAttachment[],
  ): Delivery {
    return this.deliveries.append({
      id: this.ids.next('DLV', 8),
      at: this.clock.now().toISOString(),
      eventCode: event.code,
      category: event.categorie,
      channel,
      recipientId: r.id,
      recipientKind: r.kind,
      recipientMasked: maskName(r.name),
      status,
      provider,
      providerMode,
      mandatory: event.obligatoire,
      entity,
      lang: r.lang,
      attempts: status === 'supprime_par_preference' ? 0 : 1,
      contentHash,
      ...(attachments ? { attachments: attachments.map((a) => ({ name: a.name, sha256: a.sha256, size: a.size })) } : {}),
    });
  }

  channelStatus() {
    const coverage = channelCoverage();
    const all = this.deliveries.all();
    return CHANNELS.map((channel) => {
      const p = this.providers.get(channel)!;
      return {
        channel,
        provider: p.name,
        mode: p.mode,
        wired: p.mode !== 'sandbox',
        defaultEvents: coverage[channel],
        sent: all.filter((d) => d.channel === channel && d.status !== 'supprime_par_preference').length,
      };
    });
  }

  overview() {
    const all = this.deliveries.all();
    const attempted = all.filter((d) => d.status !== 'supprime_par_preference');
    const delivered = attempted.filter((d) => d.status === 'delivre' || d.status === 'lu' || d.status === 'envoye');
    const channels = this.channelStatus();
    return {
      catalogue: EVENTS.length,
      categories: EVENT_CATEGORIES.length,
      mandatory: EVENTS.filter((e) => e.obligatoire).length,
      delivered: delivered.length,
      attempted: attempted.length,
      sandboxLogged: attempted.filter((d) => d.status === 'journalise').length,
      suppressedByPreference: all.length - attempted.length,
      channelsWired: channels.filter((c) => c.wired).length,
      channelsTotal: CHANNELS.length,
      coverage: channelCoverage(),
      channels,
      recent: all.slice(-20).reverse(),
    };
  }

  catalogue(filter: { category?: string; mandatory?: boolean } = {}) {
    let events = EVENTS;
    if (filter.category) events = events.filter((e) => e.categorie === filter.category);
    if (filter.mandatory !== undefined) events = events.filter((e) => e.obligatoire === filter.mandatory);
    return { total: events.length, categories: EVENT_CATEGORIES, events };
  }
}
