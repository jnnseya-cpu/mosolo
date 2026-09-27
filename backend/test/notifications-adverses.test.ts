/**
 * Deuxième passe adverse (27/09/2026), phase « notifications » : codes à usage unique jamais conservés en clair
 * (boîte d'envoi, empreinte, avis apposé), variables manquantes ou malveillantes, nouvelles tentatives sans doublon,
 * bon destinataire, refus et consentement respectés sauf avis obligatoires.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { sha256Hex } from '../src/core/crypto.js';
import type { ChannelProvider } from '../src/modules/communications/providers.js';
import { SECRET_MASK } from '../src/modules/communications/service.js';
import { communicationPlugin, type CommunicationExtService } from '../src/plugins/communication/plugin.js';
import { DEMO } from '../src/seed.js';
import type { TestEnv } from './helpers.js';

async function setup(plugins = [communicationPlugin]): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, plugins, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
  await app.ready();
  return {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    }),
  };
}
const ext = (e: TestEnv) => e.app.ctx.ext.communication as CommunicationExtService;
const failing = (channel: ChannelProvider['channel']): ChannelProvider => ({ channel, name: `echec-${channel}`, mode: 'live', send: () => ({ status: 'echoue' }) });
const capture = (channel: ChannelProvider['channel'], sent: { subject: string; body: string }[]): ChannelProvider => ({ channel, name: `capture-${channel}`, mode: 'live', send: (m) => { sent.push({ subject: m.subject, body: m.body }); return { status: 'envoye' }; } });

describe('Codes à usage unique : envoyés au destinataire, jamais conservés en clair', () => {
  it('le fournisseur reçoit le code ; boîte d’envoi, empreinte et journal ne le contiennent pas', async () => {
    const e = await setup();
    const sent: { subject: string; body: string }[] = [];
    e.app.ctx.comms.setProvider('sms', capture('sms', sent));
    const r = ext(e).recipientOf(DEMO.taxpayerId)!;
    const [d] = e.app.ctx.comms.publish('auth.otp_code', [r], { code: '482913' }, { onlyChannels: ['sms'] });
    expect(sent[0]!.body).toContain('482913');
    expect(d!.secret).toBe(true);
    const ob = ext(e).outbox.get(d!.id)!;
    expect(JSON.stringify(ob)).not.toContain('482913');
    expect(ob.subject).toContain(SECRET_MASK);
    // L'empreinte ne permet pas de retrouver le code par essais (calculée sur le contenu masqué).
    const brute = Array.from({ length: 1000 }, (_, i) => `482${String(i).padStart(3, '0')}`)
      .some((c) => sha256Hex(`Votre code MOSOLO : {{code}}\n${sent[0]!.body.replace('482913', c)}`) === d!.contentHash);
    expect(brute).toBe(false);
    expect(JSON.stringify(e.app.ctx.comms.deliveries.all())).not.toContain('482913');
    expect(JSON.stringify(e.app.ctx.audit.list({ limit: 10_000 }).items)).not.toContain('482913');
  });

  it('avis obligatoire secret, tous canaux en échec : aucun avis apposé sur la plaque, aucune relance depuis la boîte d’envoi', async () => {
    const e = await setup();
    for (const c of ['sms', 'svi', 'email', 'in-app', 'push', 'ussd', 'courrier'] as const) e.app.ctx.comms.setProvider(c, failing(c));
    const r = ext(e).recipientOf(DEMO.taxpayerId)!;
    const before = ext(e).plateNotices.count();
    const ds = e.app.ctx.comms.publish('auth.otp_code', [r], { code: '771204' });
    expect(ds.every((d) => d.status === 'echoue')).toBe(true);
    expect(ext(e).plateNotices.count()).toBe(before);
    expect(JSON.stringify(ext(e).plateNotices.all())).not.toContain('771204');
  });
});

describe('Variables manquantes ou malveillantes', () => {
  it('variable manquante : jamais « {{variable}} » envoyé ; manque relevé sur la ligne de délivrance', async () => {
    const e = await setup();
    const sent: { subject: string; body: string }[] = [];
    e.app.ctx.comms.setProvider('sms', capture('sms', sent));
    const r = ext(e).recipientOf(DEMO.taxpayerId)!;
    const [d] = e.app.ctx.comms.publish('auth.otp_code', [r], {}, { onlyChannels: ['sms'] });
    expect(sent[0]!.subject).not.toMatch(/\{\{|\}\}/);
    expect(sent[0]!.body).not.toMatch(/\{\{|\}\}/);
    expect(d!.missingVariables).toEqual(['code']);
    // Modèle versionné exigeant une variable absente : écarté au profit du texte du catalogue.
    const t = (await e.req('POST', '/v1/communication/modeles', 'u-dg-dgipk', { eventCode: 'obligation.overdue', lang: 'fr', text: '{{reference}} en retard depuis le {{date}}.' })).json();
    await e.req('POST', `/v1/communication/modeles/${t.id}/decision`, 'u-autorite-publication', { approve: true, motif: 'Texte vérifié' });
    const [d2] = e.app.ctx.comms.publish('obligation.overdue', [r], { reference: 'OBL-9' }, { onlyChannels: ['sms'] });
    expect(d2!.template).toBeUndefined();
    expect(d2!.missingVariables).toEqual(['date']);
    expect(sent.at(-1)!.body).not.toMatch(/\{\{/);
  });

  it('contenu malveillant : aucun retour à la ligne (injection d’en-tête), aucune variable au second degré, aucun lien par SMS, longueur bornée', async () => {
    const e = await setup();
    const sms: { subject: string; body: string }[] = [];
    const mail: { subject: string; body: string }[] = [];
    e.app.ctx.comms.setProvider('sms', capture('sms', sms));
    e.app.ctx.comms.setProvider('email', capture('email', mail));
    const r = ext(e).recipientOf(DEMO.taxpayerId)!;
    e.app.ctx.comms.publish('obligation.overdue', [r], { reference: 'PR-1\r\nBcc: victime@exemple.cd\r\n{{code}} payez sur https://paie-vite.example.com <script>alert(1)</script>' + 'x'.repeat(1000) }, { onlyChannels: ['sms', 'email'] });
    for (const m of [...sms, ...mail]) {
      expect(m.subject).not.toMatch(/[\r\n]/);
      expect(m.body).not.toMatch(/[\r\n]/);
      expect(m.body).not.toMatch(/\{\{|\}\}/);
      expect(m.body.length).toBeLessThan(700);
    }
    expect(sms[0]!.body).not.toMatch(/https?:|paie-vite/);
  });
});

describe('Nouvelles tentatives, bon destinataire, refus', () => {
  it('accusé « échoué » rejoué : un seul envoi de secours, jamais deux fois le même canal', async () => {
    const e = await setup();
    const r = ext(e).recipientOf(DEMO.taxpayerId)!;
    const [first] = e.app.ctx.comms.publish('obligation.due_soon', [r], { montant: '10 USD', date: '2026-10-10' }, { onlyChannels: ['sms'] });
    const raw = JSON.stringify({ deliveryId: first!.id, status: 'echoue', at: '2026-09-26T09:05:00.000Z' });
    const send = () => e.req('POST', '/v1/communication/accuses', undefined, raw, { 'x-signature': ext(e).receiptSignature(raw) });
    const [a, b] = await Promise.all([send(), send()]);
    expect(a.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);
    const chain = e.app.ctx.comms.deliveries.all().filter((d) => d.recipientId === r.id && d.contentHash === first!.contentHash);
    expect(chain.filter((d) => d.fallbackOf === first!.id)).toHaveLength(1);
    const channels = chain.map((d) => d.channel);
    expect(new Set(channels).size).toBe(channels.length);
  });

  it('bon destinataire : l’avis de paiement va au contribuable de l’ordre, jamais à l’agent qui l’a initié ni à un autre', async () => {
    const e = await setup([]);
    const ob = e.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    const order = (await e.req('POST', `/v1/obligations/${ob.id}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).json();
    const ds = e.app.ctx.comms.deliveries.all().filter((d) => d.eventCode === 'payment.reference.issued');
    expect(ds.length).toBeGreaterThan(0);
    expect(ds.every((d) => d.recipientId === ob.taxpayerId)).toBe(true);
    expect(order.paymentReference).toBeTruthy();
  });

  it('refus global (opt-out) : facultatif supprimé sur tous les canaux externes (boîte de l’application seule, par conception) ; obligatoire envoyé ; WhatsApp jamais sans consentement', async () => {
    const e = await setup();
    const r = { ...ext(e).recipientOf(DEMO.taxpayerId)!, prefs: { optedOut: true, whatsappConsent: false } };
    const optional = e.app.ctx.comms.publish('obligation.due_soon', [r], { montant: '10 USD', date: '2026-10-10' });
    expect(optional.length).toBeGreaterThan(0);
    expect(optional.filter((d) => d.channel !== 'in-app').every((d) => d.status === 'supprime_par_preference')).toBe(true);
    const mandatory = e.app.ctx.comms.publish('obligation.overdue', [r], { reference: 'OBL-1' });
    expect(mandatory.some((d) => d.status !== 'supprime_par_preference')).toBe(true);
    expect(mandatory.some((d) => d.channel === 'whatsapp' && d.status !== 'supprime_par_preference')).toBe(false);
  });
});
