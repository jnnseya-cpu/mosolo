import type { User } from '../../core/auth.js';
import type { Recipient } from '../communications/service.js';
import type { Taxpayer } from './service.js';

export function userRecipient(u: User): Recipient {
  return { id: u.id, kind: 'user', name: u.name, lang: u.lang ?? 'fr', prefs: {} };
}

export function taxpayerRecipient(t: Taxpayer): Recipient {
  return { id: t.id, kind: 'taxpayer', name: t.fullName, lang: t.language, prefs: t.prefs };
}
