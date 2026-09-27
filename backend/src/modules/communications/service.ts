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
import { fillPlaceholders, renderText } from './templates.js';

export interface RecipientPrefs {
  optedOut?: boolean;
  disabledChannels?: Channel[];
  whatsappConsent?: boolean;
  /** Canal choisi par la personne (module 39 « Préférences — canal choisi ») : ajouté en tête des canaux, jamais WhatsApp pour un avis obligatoire. */
  preferredChannel?: Channel;
}

/**
 * Canal de secours (module 39 « Réessayer sur un canal de secours en cas d'échec ») : ordre des canaux essayés après
 * l'échec d'un envoi, pour le même destinataire et le même message. Un canal désactivé par la personne (sauf avis
 * obligatoire), WhatsApp ou un canal déjà essayé n'est jamais retenu.
 */
export const FALLBACK_ORDER: Record<Channel, Channel[]> = {
  sms: ['svi', 'in-app', 'courrier'],
  email: ['sms', 'in-app', 'courrier'],
  push: ['sms', 'in-app'],
  whatsapp: ['sms', 'in-app'],
  ussd: ['sms', 'svi'],
  svi: ['sms', 'courrier'],
  'in-app': ['sms', 'email'],
  courrier: [],
};

/** Modèle de message versionné actif (registre des modèles, module 39) appliqué à un envoi. */
export interface ResolvedTemplate { id: string; version: number; text: string }
export type TemplateResolver = (eventCode: string, lang: LanguageCode, revenueCategory?: string) => ResolvedTemplate | undefined;

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
  /** Envoi de secours : identifiant de l'envoi échoué qu'il remplace (canal de secours). */
  fallbackOf?: string;
  /** Modèle versionné appliqué (registre des modèles par recette et par langue). */
  template?: { id: string; version: number };
  /** Catégorie de recette du message (choix du modèle). */
  revenueCategory?: string;
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
  private templateResolver: TemplateResolver | undefined;
  private readonly failureListeners: ((d: Delivery) => void)[] = [];
  private readonly sentListeners: ((d: Delivery, content: { subject: string; body: string }, recipient: Recipient) => void)[] = [];

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

  /** Raccordement d'un fournisseur de canal (connecteur réel, ou fournisseur de test) : remplace le bac à sable. */
  setProvider(channel: Channel, provider: ChannelProvider): void {
    this.providers.set(channel, provider);
  }

  /** Registre des modèles versionnés (module d'extension « communication ») : texte actif par événement, recette et langue. */
  setTemplateResolver(fn: TemplateResolver | undefined): void {
    this.templateResolver = fn;
  }

  /** Notification de chaque envoi (preuve de remise, relance sur canal de secours après un accusé « échoué »). */
  onSent(fn: (d: Delivery, content: { subject: string; body: string }, recipient: Recipient) => void): void {
    this.sentListeners.push(fn);
  }

  /** Notification d'un envoi définitivement échoué (après épuisement des canaux de secours). */
  onFailure(fn: (d: Delivery) => void): void {
    this.failureListeners.push(fn);
  }

  event(code: string): CommunicationEvent {
    const e = getEvent(code);
    if (!e) throw notFound('UNKNOWN_EVENT', `Événement inconnu au catalogue : ${code}`);
    return e;
  }

  publish(
    eventCode: string, recipients: Recipient[], vars: Record<string, string> = {},
    opts: { entity?: string; attachments?: MessageAttachment[]; onlyChannels?: Channel[]; revenueCategory?: string } = {},
  ): Delivery[] {
    const event = this.event(eventCode);
    const entity = opts.entity ?? 'GOUVERNORAT';
    const out: Delivery[] = [];
    for (const r of recipients) {
      const resolved = resolveChannels(event, r.prefs);
      // Canal choisi par la personne : ajouté en tête s'il n'est ni désactivé, ni WhatsApp sans consentement ou pour un avis obligatoire.
      const pref = r.prefs.preferredChannel;
      if (pref && !resolved.includes(pref) && !(r.prefs.disabledChannels ?? []).includes(pref)
        && !(pref === 'whatsapp' && (event.obligatoire || !r.prefs.whatsappConsent)) && !(r.prefs.optedOut && !event.obligatoire)) resolved.unshift(pref);
      const channels = opts.onlyChannels ? resolved.filter((c) => opts.onlyChannels!.includes(c)) : resolved;
      const suppressed = event.canaux_defaut.filter((c) => !resolved.includes(c) && (!opts.onlyChannels || opts.onlyChannels.includes(c)));
      const template = this.templateResolver?.(eventCode, r.lang, opts.revenueCategory);
      const body = template ? `${fillPlaceholders(template.text, vars)} — Détail : espace MOSOLO ou code USSD officiel.` : renderText(event, vars);
      const contentHash = sha256Hex(`${event.objet}\n${body}`);
      const meta: Partial<Delivery> = { ...(template ? { template: { id: template.id, version: template.version } } : {}), ...(opts.revenueCategory ? { revenueCategory: opts.revenueCategory } : {}) };
      const subject = fillPlaceholders(event.objet, vars);
      const tried = new Set<Channel>();
      for (const channel of channels) {
        tried.add(channel);
        const attachments = channel === 'email' && opts.attachments?.length ? opts.attachments : undefined;
        const d = this.sendOne(event, r, channel, { subject, body, entity, contentHash, attachments, meta });
        out.push(d);
        if (d.status === 'echoue') out.push(...this.fallback(event, r, d, tried, { subject, body, entity, contentHash, meta }));
      }
      for (const channel of suppressed) {
        out.push(this.log(event, r, channel, 'supprime_par_preference', 'aucun', 'aucun', entity, contentHash, undefined, meta));
      }
    }
    return out;
  }

  private sendOne(
    event: CommunicationEvent, r: Recipient, channel: Channel,
    m: { subject: string; body: string; entity: string; contentHash: string; attachments?: MessageAttachment[] | undefined; meta: Partial<Delivery>; fallbackOf?: string },
  ): Delivery {
    const provider = this.providers.get(channel)!;
    let status: DeliveryStatus;
    try {
      status = provider.send({
        channel, recipientId: r.id, eventCode: event.code, subject: m.subject, body: m.body, entity: m.entity, lang: r.lang, mandatory: event.obligatoire,
        ...(m.attachments ? { attachments: m.attachments } : {}),
      }).status;
    } catch {
      status = 'echoue';
    }
    const d = this.log(event, r, channel, status, provider.name, provider.mode, m.entity, m.contentHash, m.attachments, { ...m.meta, ...(m.fallbackOf ? { fallbackOf: m.fallbackOf } : {}) });
    for (const fn of this.sentListeners) {
      try { fn(d, { subject: m.subject, body: m.body }, r); } catch { /* un abonné ne bloque jamais l'envoi */ }
    }
    return d;
  }

  /** Envoi de secours après un échec : premier canal admissible de FALLBACK_ORDER, jamais un canal déjà essayé. */
  private fallback(
    event: CommunicationEvent, r: Recipient, failed: Delivery, tried: Set<Channel>,
    m: { subject: string; body: string; entity: string; contentHash: string; meta: Partial<Delivery> },
  ): Delivery[] {
    const out: Delivery[] = [];
    let current = failed;
    const disabled = new Set(r.prefs.disabledChannels ?? []);
    while (current.status === 'echoue') {
      const next = FALLBACK_ORDER[current.channel].find((c) => !tried.has(c) && (event.obligatoire || !disabled.has(c)) && c !== 'whatsapp');
      if (!next) {
        for (const fn of this.failureListeners) fn(current);
        break;
      }
      tried.add(next);
      current = this.sendOne(event, r, next, { ...m, fallbackOf: current.id });
      out.push(current);
    }
    return out;
  }

  /**
   * Échec signalé APRÈS l'envoi (accusé de remise « échoué » d'un fournisseur) : envoi de secours sur le canal suivant,
   * même contenu, même destinataire ; les canaux déjà essayés pour ce message ne sont jamais repris.
   */
  retryOnFallback(delivery: Delivery, recipient: Recipient, content: { subject: string; body: string }): Delivery[] {
    const event = this.event(delivery.eventCode);
    const tried = new Set<Channel>(this.deliveries.find((d) => d.eventCode === delivery.eventCode && d.recipientId === delivery.recipientId && d.contentHash === delivery.contentHash).map((d) => d.channel));
    const meta: Partial<Delivery> = { ...(delivery.template ? { template: delivery.template } : {}), ...(delivery.revenueCategory ? { revenueCategory: delivery.revenueCategory } : {}) };
    return this.fallback(event, recipient, { ...delivery, status: 'echoue' }, tried, { ...content, entity: delivery.entity, contentHash: delivery.contentHash, meta });
  }

  private log(
    event: CommunicationEvent, r: Recipient, channel: Channel, status: DeliveryStatus,
    provider: string, providerMode: Delivery['providerMode'], entity: string, contentHash: string, attachments?: MessageAttachment[], meta: Partial<Delivery> = {},
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
      ...(meta.fallbackOf ? { fallbackOf: meta.fallbackOf } : {}),
      ...(meta.template ? { template: meta.template } : {}),
      ...(meta.revenueCategory ? { revenueCategory: meta.revenueCategory } : {}),
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
