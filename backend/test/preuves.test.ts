import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import type { PreuvesModule } from '../src/plugins/preuves/plugin.js';
import { maskPlate } from '../src/plugins/preuves/service.js';

/** Application complète : tous les modules chargés et semés (codes de démonstration réels). */
async function full() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
  await app.ready();
  const ext = app.ctx.ext as Record<string, any>;
  const get = (url: string) => app.inject({ method: 'GET', url });
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, payload: body as object, headers });
  return { app, ext, clock, get, post, preuves: ext.preuves as PreuvesModule };
}

afterEach(() => {
  delete process.env.WHATSAPP_APP_SECRET;
  delete process.env.SMS_GATEWAY_SECRET;
  delete process.env.MOSOLO_DEMO_MODE;
});

describe('Preuves — résolveur universel (tout code, tout canal, heure serveur)', () => {
  it('reconnaît titres, certificats, plaques d’étal, badges, supports publicitaires et quittances ; inconnu sinon', async () => {
    const { ext, get } = await full();
    const codes: [string, string][] = [];
    const cred = ext.titres.credentials.all()[0];
    if (cred) codes.push([cred.shortCode, cred.module === '81' ? 'PASS_WEWA' : 'TITRE']);
    codes.push([ext.verticales.certificates.all()[0].code, 'CERTIFICAT']);
    const stall = ext.verticales.plates.all().find((p: { kind: string }) => p.kind === 'ETAL');
    if (stall) codes.push([stall.code, 'PLAQUE_ETAL']);
    codes.push([ext.terrain.badges.all()[0].shortCode, 'BADGE_AGENT']);
    codes.push([ext.publicite.devices.all()[0].qrToken, 'SUPPORT_PUBLICITAIRE']);
    const ticket = ext.parking.sessions.all().find((x: { ticketCode?: string }) => x.ticketCode);
    expect(ticket).toBeDefined();
    codes.push([ticket.ticketCode, 'TICKET_STATIONNEMENT']);
    if (cred) codes.push([cred.staticToken, cred.module === '81' ? 'PASS_WEWA' : 'TITRE']);
    for (const [code, kind] of codes) {
      const r = (await get(`/v1/public/preuves?c=${encodeURIComponent(code)}`)).json();
      expect(r.kind, code).toBe(kind);
      expect(r.found).toBe(true);
      expect(r.advice).toMatch(/espèces/);
      // Jamais de nom de contribuable ni d'adresse dans la réponse publique.
      expect(JSON.stringify(r)).not.toMatch(/Mbuyi|Kalala/);
    }
    const unknown = (await get('/v1/public/preuves/ZZZZ-0000')).json();
    expect(unknown).toMatchObject({ found: false, kind: 'INCONNU', state: 'INCONNU' });
  });

  it('un titre porte la validité 50 % / 1 % calculée à l’heure du serveur', async () => {
    const { ext, clock, get } = await full();
    const c = ext.titres.credentials.all().find((x: { state: string }) => x.state === 'EMIS');
    expect(c).toBeDefined();
    clock.set(c.validFrom);
    const start = (await get(`/v1/public/preuves/${c.shortCode}`)).json();
    expect(start.validity).toMatchObject({ band: 'VERT', pct: 100 });
    const total = Date.parse(c.validUntil) - Date.parse(c.validFrom);
    clock.set(new Date(Date.parse(c.validFrom) + total * 0.6).toISOString());
    expect((await get(`/v1/public/preuves/${c.shortCode}`)).json().validity.band).toBe('AMBRE');
    clock.set(new Date(Date.parse(c.validFrom) + total * 0.98).toISOString());
    expect((await get(`/v1/public/preuves/${c.shortCode}`)).json().validity.band).toBe('AMBRE'); // 2 % restant
    clock.set(new Date(Date.parse(c.validFrom) + total * 0.995).toISOString());
    const red = (await get(`/v1/public/preuves/${c.shortCode}`)).json();
    expect(red).toMatchObject({ state: 'VALIDE', validity: { band: 'ROUGE' } });
    clock.set(new Date(Date.parse(c.validUntil) + 86_400_000).toISOString());
    expect((await get(`/v1/public/preuves/${c.shortCode}`)).json()).toMatchObject({ state: 'EXPIRE', validity: { band: 'EXPIRE' } });
  });

  it('chaque réponse porte l’heure du serveur (en-tête exposé) pour caler les comptes à rebours', async () => {
    const { get } = await full();
    const r = await get('/health');
    expect(r.headers['x-mosolo-server-time']).toBe('2026-09-26T09:00:00.000Z');
  });

  it('masque la plaque d’un véhicule', () => {
    expect(maskPlate('KN-M 20417')).toBe('KN-M ••417');
  });
});

describe('SMS entrant — téléphone basique, sans Internet', () => {
  it('« V <code> » répond en moins de 320 caractères, sans accents (GSM-7), avec la couleur et le temps restant', async () => {
    const { ext, post } = await full();
    const code = ext.verticales.certificates.all()[0].code;
    const r = (await post('/v1/sms/inbound', { from: '+243810000001', text: `V ${code}` })).json();
    expect(r.simulated).toBe(true);
    expect(r.command).toBe('VERIFIER');
    expect(r.reply).toMatch(/^MOSOLO: /);
    expect(r.reply.length).toBeLessThanOrEqual(320);
    expect(r.reply).toMatch(/^[\x20-\x7E]*$/);
    const help = (await post('/v1/sms/inbound', { from: '+243810000001', text: 'bonjour' })).json();
    expect(help.command).toBe('AIDE');
    const pts = (await post('/v1/sms/inbound', { from: '+243810000001', text: 'POINTS Gombe' })).json();
    expect(pts.reply).toMatch(/Gombe/);
  });

  it('en production, la passerelle SMS exige une signature HMAC du corps', async () => {
    process.env.MOSOLO_DEMO_MODE = 'false';
    const { post } = await full();
    expect((await post('/v1/sms/inbound', { from: '+243810000001', text: 'AIDE' })).statusCode).toBe(403);
    process.env.SMS_GATEWAY_SECRET = 'secret-sms';
    const body = JSON.stringify({ from: '+243810000001', text: 'AIDE' });
    const bad = await post('/v1/sms/inbound', JSON.parse(body), { 'x-mosolo-signature': '00'.repeat(32) });
    expect(bad.statusCode).toBe(403);
    const sig = createHmac('sha256', 'secret-sms').update(body).digest('hex');
    const ok = await post('/v1/sms/inbound', JSON.parse(body), { 'x-mosolo-signature': sig, 'content-type': 'application/json' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().simulated).toBe(false);
  });
});

describe('Assistant WhatsApp — consentement, aucun lien de paiement, aucun montant', () => {
  it('rien n’est servi avant « OUI » ; menu, vérification, comment payer ; STOP retire le consentement', async () => {
    const { ext, post } = await full();
    const from = '+243810000009';
    const say = async (text: string) => (await post('/v1/whatsapp/webhook', { from, text })).json().results[0];
    const first = await say('Bonjour');
    expect(first.consent).toBe(false);
    expect(first.replies.join(' ')).toMatch(/répondez OUI/);
    expect((await say('1')).replies.join(' ')).toMatch(/répondez OUI/); // toujours rien sans consentement
    const ok = await say('OUI');
    expect(ok.consent).toBe(true);
    expect(ok.replies.join('\n')).toMatch(/1\. Vérifier/);
    expect((await say('1')).replies[0]).toMatch(/code imprimé/);
    const code = ext.verticales.certificates.all()[0].code;
    const v = await say(code);
    expect(v.replies[0]).toMatch(/[🟢🟠🔴]/u);
    const how = await say('3');
    const txt = how.replies.join(' ');
    expect(txt).not.toMatch(/https?:\/\//);
    expect(txt).toMatch(/JAMAIS de lien de paiement/);
    // Aucun montant nominatif, même pour une quittance.
    expect(txt).not.toMatch(/USD|CDF|FC\b/);
    const stop = await say('STOP');
    expect(stop.consent).toBe(false);
    expect((await say('1')).replies.join(' ')).toMatch(/répondez OUI/);
    expect(ext.preuves.whatsapp.conversations.get(from).withdrawnAt).toBeDefined();
  });

  it('lingala sur demande ; format officiel de l’API (entry/changes/messages) ; signature exigée si configurée', async () => {
    const { post } = await full();
    const meta = (from: string, body: string) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ from, type: 'text', text: { body } }] } }] }] });
    const r1 = (await post('/v1/whatsapp/webhook', meta('243810000010', 'LINGALA'))).json().results[0];
    expect(r1.lang).toBe('ln');
    expect(r1.replies[0]).toMatch(/Mbote/);
    process.env.WHATSAPP_APP_SECRET = 'app-secret';
    const payload = JSON.stringify(meta('243810000010', 'OUI'));
    expect((await post('/v1/whatsapp/webhook', JSON.parse(payload), { 'x-hub-signature-256': 'sha256=' + '00'.repeat(32) })).statusCode).toBe(403);
    const sig = 'sha256=' + createHmac('sha256', 'app-secret').update(payload).digest('hex');
    const ok = await post('/v1/whatsapp/webhook', JSON.parse(payload), { 'x-hub-signature-256': sig, 'content-type': 'application/json' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().results[0].consent).toBe(true);
  });
});

describe('Pages légères /l — sans JavaScript, faible débit', () => {
  it('pages HTML sans script, < 10 Ko ; résultat coloré avec barre texte ; version imprimable avec QR', async () => {
    const { ext, get, app } = await full();
    for (const url of ['/l', '/l/payer', '/l/points?commune=Gombe', '/l/signaler']) {
      const r = await get(url);
      expect(r.statusCode, url).toBe(200);
      expect(r.headers['content-type']).toMatch(/text\/html/);
      expect(r.body).not.toMatch(/<script/i);
      expect(Buffer.byteLength(r.body)).toBeLessThan(10_000);
    }
    const code = ext.verticales.certificates.all()[0].code;
    const v = await get(`/l/v?c=${encodeURIComponent(code)}`);
    expect(v.body).toMatch(/50 %/);
    expect(v.body).not.toMatch(/<script/i);
    const p = await get(`/l/imprimer?c=${encodeURIComponent(code)}`);
    expect(p.body).toMatch(/<svg/);
    expect(p.body).toMatch(new RegExp(code));
    const rep = await app.inject({ method: 'POST', url: '/l/signaler', payload: 't=Un+agent+demande+des+especes+au+marche', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(rep.statusCode).toBe(200);
    expect(rep.body).toMatch(/Code de suivi/);
  });
});
