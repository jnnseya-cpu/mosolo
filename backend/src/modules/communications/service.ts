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
  /** Variables attendues par le texte mais non fournies : texte du catalogue utilisé, marque « — » (à corriger par l'émetteur). */
  missingVariables?: string[];
  /** Contenu secret (code à usage unique…) : jamais conservé en clair après l'envoi (boîte d'envoi, avis apposé). */
  secret?: boolean;
}

/** Masque d'un secret dans les contenus conservés. */
export const SECRET_MASK = '••••••';
/** Variables toujours secrètes ; `code` l'est aussi pour les événements de la catégorie « sécurité » (codes à usage unique). */
const SECRET_VAR_NAMES = new Set(['otp', 'motDePasse', 'password', 'token', 'secret', 'pin']);
const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/**
 * Variables d'un message (deuxième passe adverse, 27/09/2026) : texte simple d'une ligne (aucun caractère de contrôle,
 * donc aucun retour à la ligne injectable dans l'objet d'un courriel ni dans un SMS), 300 caractères au plus, sans
 * accolades de gabarit (aucune injection de variable au second degré).
 */
/**
 * Variables françaises du catalogue dérivées des valeurs RÉELLEMENT transmises par le module (29/09/2026) : plusieurs
 * modules passent `reference`, `amount`, `dueDate` ou `channel` quand le catalogue attend `objet`, `numero`, `montant`,
 * `date` ou `canal`. Rien n'est inventé : une variable sans valeur transmise reste marquée « — » et relevée.
 */
const ALIAS_VARIABLES: Record<string, string[]> = {
  objet: ['reference'], regle: ['reference'], numero: ['reference'], titre: ['reference'], ref_paiement: ['reference'], unite: ['reference'],
  montant: ['amount'], date: ['dueDate', 'validUntil', 'effectiveFrom'], canal: ['channel'],
};
const DATE_ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/;
export function withAliasVars(vars: Record<string, string>): Record<string, string> {
  const out = { ...vars };
  for (const [k, sources] of Object.entries(ALIAS_VARIABLES)) {
    if (out[k]) continue;
    const src = sources.find((s) => vars[s]);
    if (src) out[k] = vars[src]!;
  }
  if (out.date) { const m = DATE_ISO.exec(out.date); if (m) out.date = `${m[3]}/${m[2]}/${m[1]}`; }
  if (out.canal) out.canal = out.canal.replace(/_/g, ' ').toLowerCase();
  return out;
}

export function sanitizeVars(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    const clean = [...String(v ?? '')].filter((c) => { const cp = c.codePointAt(0)!; return cp > 0x1f && !(cp >= 0x7f && cp <= 0x9f) && !(cp >= 0x202a && cp <= 0x202e) && !(cp >= 0x2066 && cp <= 0x2069); })
      .join('').replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
    out[k] = clean.length > 300 ? `${clean.slice(0, 299)}…` : clean;
  }
  return out;
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
    vars = sanitizeVars(withAliasVars(vars));
    // Secrets (code à usage unique…) : envoyés au destinataire, jamais conservés en clair (voir `secret`).
    const secrets = Object.entries(vars).filter(([k, v]) => v && v !== SECRET_MASK && v.length >= 3 && (SECRET_VAR_NAMES.has(k) || (k === 'code' && event.categorie === 'securite'))).map(([, v]) => v);
    const redact = (t: string) => secrets.reduce((acc, x) => acc.split(x).join(SECRET_MASK), t);
    for (const r of recipients) {
      const resolved = resolveChannels(event, r.prefs);
      // Canal choisi par la personne : ajouté en tête s'il n'est ni désactivé, ni WhatsApp sans consentement ou pour un avis obligatoire.
      const pref = r.prefs.preferredChannel;
      if (pref && !resolved.includes(pref) && !(r.prefs.disabledChannels ?? []).includes(pref)
        && !(pref === 'whatsapp' && (event.obligatoire || !r.prefs.whatsappConsent)) && !(r.prefs.optedOut && !event.obligatoire)) resolved.unshift(pref);
      const channels = opts.onlyChannels ? resolved.filter((c) => opts.onlyChannels!.includes(c)) : resolved;
      const suppressed = event.canaux_defaut.filter((c) => !resolved.includes(c) && (!opts.onlyChannels || opts.onlyChannels.includes(c)));
      const found = this.templateResolver?.(eventCode, r.lang, opts.revenueCategory);
      // Variable manquante : jamais de « {{variable}} » brut envoyé ; le modèle versionné est écarté au profit du texte du
      // catalogue, les manques sont marqués « — » et relevés sur la ligne de délivrance.
      const missing = new Set<string>();
      const unresolved = (t: string) => { for (const m of t.matchAll(PLACEHOLDER)) missing.add(m[1]!); return t.replace(PLACEHOLDER, '—'); };
      const filledTemplate = found ? fillPlaceholders(found.text, vars) : '';
      const template = found && !/\{\{\w+\}\}/.test(filledTemplate) ? found : undefined;
      if (found && !template) for (const m of filledTemplate.matchAll(PLACEHOLDER)) missing.add(m[1]!);
      const body = unresolved(template ? `${filledTemplate} — Détail : espace MOSOLO ou code USSD officiel.` : renderText(event, vars));
      const subject = unresolved(fillPlaceholders(event.objet, vars));
      // Empreinte calculée sur le contenu MASQUÉ : un code à 6 chiffres ne se retrouve pas par essais sur l'empreinte.
      const contentHash = sha256Hex(`${event.objet}\n${redact(body)}`);
      const meta: Partial<Delivery> = {
        ...(template ? { template: { id: template.id, version: template.version } } : {}), ...(opts.revenueCategory ? { revenueCategory: opts.revenueCategory } : {}),
        ...(missing.size ? { missingVariables: [...missing].sort() } : {}), ...(secrets.length ? { secret: true } : {}),
      };
      const kept = secrets.length ? { subject: redact(subject), body: redact(body) } : undefined;
      const tried = new Set<Channel>();
      for (const channel of channels) {
        tried.add(channel);
        const attachments = channel === 'email' && opts.attachments?.length ? opts.attachments : undefined;
        const d = this.sendOne(event, r, channel, { subject, body, entity, contentHash, attachments, meta, kept });
        out.push(d);
        if (d.status === 'echoue') out.push(...this.fallback(event, r, d, tried, { subject, body, entity, contentHash, meta, kept }));
      }
      for (const channel of suppressed) {
        out.push(this.log(event, r, channel, 'supprime_par_preference', 'aucun', 'aucun', entity, contentHash, undefined, meta));
      }
    }
    return out;
  }

  private sendOne(
    event: CommunicationEvent, r: Recipient, channel: Channel,
    m: { subject: string; body: string; entity: string; contentHash: string; attachments?: MessageAttachment[] | undefined; meta: Partial<Delivery>; fallbackOf?: string; kept?: { subject: string; body: string } | undefined },
  ): Delivery {
    const provider = this.providers.get(channel)!;
    let status: DeliveryStatus;
    try {
      status = provider.send({
        channel, recipientId: r.id, eventCode: event.code, subject: m.subject, body: channel === 'sms' ? smsText(m.body) : m.body, entity: m.entity, lang: r.lang, mandatory: event.obligatoire,
        ...(m.attachments ? { attachments: m.attachments } : {}),
      }).status;
    } catch {
      status = 'echoue';
    }
    const d = this.log(event, r, channel, status, provider.name, provider.mode, m.entity, m.contentHash, m.attachments, { ...m.meta, ...(m.fallbackOf ? { fallbackOf: m.fallbackOf } : {}) });
    for (const fn of this.sentListeners) {
      // Les abonnés (boîte d'envoi, preuve de remise) ne reçoivent que le contenu conservable (secret masqué).
      try { fn(d, m.kept ?? { subject: m.subject, body: m.body }, r); } catch { /* un abonné ne bloque jamais l'envoi */ }
    }
    return d;
  }

  /** Envoi de secours après un échec : premier canal admissible de FALLBACK_ORDER, jamais un canal déjà essayé. */
  private fallback(
    event: CommunicationEvent, r: Recipient, failed: Delivery, tried: Set<Channel>,
    m: { subject: string; body: string; entity: string; contentHash: string; meta: Partial<Delivery>; kept?: { subject: string; body: string } | undefined },
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
      ...(meta.missingVariables ? { missingVariables: meta.missingVariables } : {}),
      ...(meta.secret ? { secret: true } : {}),
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
