/**
 * Catalogue des événements de communication (module 39, § 11.4 du document maître).
 * Source : specs/evenements-communication.yaml, généré par tools/gen_evenements.py.
 */
import catalogue from './events/catalogue.json';

export type Channel = 'email' | 'in-app' | 'sms' | 'push' | 'whatsapp' | 'ussd' | 'svi' | 'courrier';
export type Severity = 'info' | 'success' | 'warning' | 'critical';
export type Audience = 'C' | 'G' | 'X';

export interface CommunicationEvent {
  code: string;
  categorie: string;
  libelle: string;
  objet: string;
  gravite: Severity;
  canaux_defaut: Channel[];
  whatsapp_optin: boolean;
  obligatoire: boolean;
  public: Audience[];
}

export interface EventCategory {
  code: string;
  libelle: string;
}

export const EVENT_CATEGORIES: EventCategory[] = catalogue.categories;
export const EVENTS: CommunicationEvent[] = catalogue.evenements as CommunicationEvent[];
export const CHANNELS: Channel[] = ['email', 'in-app', 'sms', 'push', 'whatsapp', 'ussd', 'svi', 'courrier'];

const byCode = new Map(EVENTS.map((e) => [e.code, e]));
export function getEvent(code: string): CommunicationEvent | undefined {
  return byCode.get(code);
}

/** Nombre d'événements diffusés par défaut sur chaque canal (WhatsApp : éligibles sur consentement). */
export function channelCoverage(): Record<Channel, number> {
  const out = Object.fromEntries(CHANNELS.map((c) => [c, 0])) as Record<Channel, number>;
  for (const e of EVENTS) {
    for (const c of e.canaux_defaut) out[c] += 1;
    if (e.whatsapp_optin) out.whatsapp += 1;
  }
  return out;
}

/**
 * Canaux effectifs pour un destinataire.
 * - Avis obligatoire : ignore la désinscription, jamais sur WhatsApp.
 * - Facultatif : respecte les préférences ; WhatsApp seulement si éligible ET consentement.
 */
export function resolveChannels(
  event: CommunicationEvent,
  prefs: { optedOut?: boolean; disabledChannels?: Channel[]; whatsappConsent?: boolean },
): Channel[] {
  if (event.obligatoire) return event.canaux_defaut.filter((c) => c !== 'whatsapp');
  if (prefs.optedOut) return ['in-app'].filter((c) => event.canaux_defaut.includes(c as Channel)) as Channel[];
  const disabled = new Set(prefs.disabledChannels ?? []);
  const chans = event.canaux_defaut.filter((c) => !disabled.has(c));
  if (event.whatsapp_optin && prefs.whatsappConsent && !disabled.has('whatsapp')) chans.push('whatsapp');
  return chans;
}
