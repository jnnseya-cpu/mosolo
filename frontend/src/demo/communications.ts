/** Synthèse de démonstration du module 39 — EXEMPLE, calculée depuis le catalogue partagé. */
import { CHANNELS, EVENTS, EVENT_CATEGORIES, channelCoverage } from '@mosolo/shared';
import type { CommunicationsOverview, Delivery } from '../lib/types';

const cov = channelCoverage();
const SENT: Record<string, number> = { email: 612, 'in-app': 904, sms: 488, push: 131, whatsapp: 22, ussd: 64, svi: 9, courrier: 3 };

export const DEMO_RECENT: Delivery[] = [
  { id: 'd1', eventCode: 'payment.confirmed', channel: 'sms', status: 'envoye', provider: 'Passerelle SMS (bac à sable)', at: '2027-02-10T09:14:02+01:00' },
  { id: 'd2', eventCode: 'payment.confirmed', channel: 'email', status: 'journalise', provider: 'Journal bac à sable', at: '2027-02-10T09:14:02+01:00' },
  { id: 'd3', eventCode: 'receipt.issued_provisional', channel: 'in-app', status: 'delivre', provider: 'MOSOLO', at: '2027-02-10T09:12:40+01:00' },
  { id: 'd4', eventCode: 'assessment.issued', channel: 'courrier', status: 'en_file', provider: 'Imprimerie provinciale', at: '2027-02-10T09:05:11+01:00' },
  { id: 'd5', eventCode: 'payment.failed', channel: 'push', status: 'echoue', provider: 'Service de notification', at: '2027-02-10T08:58:27+01:00' },
  { id: 'd6', eventCode: 'account.registration.received', channel: 'sms', status: 'envoye', provider: 'Passerelle SMS (bac à sable)', at: '2027-02-10T08:51:09+01:00' },
];

export const DEMO_COMMS: CommunicationsOverview = {
  example: true,
  catalogue: { events: EVENTS.length, categories: EVENT_CATEGORIES.length, mandatory: EVENTS.filter((e) => e.obligatoire).length },
  delivered: { delivered: 2168, attempted: 2233 },
  connectedChannels: ['email', 'in-app', 'sms'],
  coverage: CHANNELS.map((c) => ({ channel: c, events: cov[c], sent: SENT[c] ?? 0 })),
  recent: DEMO_RECENT,
};

/** Aperçu local minimal si l'API d'aperçu est injoignable (le rendu officiel est serveur). */
export function localPreviewHtml(eventCode: string, entity: string, lang: string): string {
  const ev = EVENTS.find((e) => e.code === eventCode);
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  return `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8"><style>
  body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#F5F7FB;color:#111}
  .w{max-width:560px;margin:0 auto;background:#fff;border:1px solid #DADFEA}
  .h{background:#232C6B;color:#fff;padding:16px 24px;font-weight:600;letter-spacing:.04em}
  .t{height:3px;background:linear-gradient(90deg,#1E9BD7 0 33%,#F7D618 33% 66%,#D7141A 66%)}
  .b{padding:24px}.m{font-size:12px;color:#4A4F5C;border-top:1px solid #E6E9F0;padding:16px 24px}
  .x{display:inline-block;background:#FFF4D6;color:#5c4400;font-size:11px;padding:2px 8px;border-radius:4px}</style></head>
  <body><div class="w"><div class="h">${esc(entity)} · KINSHASA MOSOLO</div><div class="t"></div><div class="b">
  <span class="x">APERÇU LOCAL — EXEMPLE</span><h2 style="font-size:18px">${esc(ev?.objet ?? eventCode)}</h2>
  <p>${esc(ev?.libelle ?? '')}</p><p>Référence événement : <code>${esc(eventCode)}</code></p></div>
  <div class="m">Message officiel — aucun agent ne vous demandera d’espèces. La version française fait foi.</div></div></body></html>`;
}
