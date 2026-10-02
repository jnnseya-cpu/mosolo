import { describe, expect, it } from 'vitest';
import { taxpayerRecipient } from '../src/modules/identity/recipients.js';
import { DEMO, setup } from './helpers.js';

describe('Communications', () => {
  it('synthèse : catalogue 255, 23 catégories, 135 avis obligatoires, couverture par canal', async () => {
    const env = await setup();
    const res = await env.req('GET', '/v1/communications/overview', 'u-admin-entite');
    expect(res.statusCode).toBe(200);
    const o = res.json();
    expect(o).toMatchObject({ catalogue: 255, categories: 23, mandatory: 135, channelsTotal: 8, channelsWired: 1 });
    expect(o.coverage.email).toBeGreaterThan(0);
    expect(o.attempted).toBeGreaterThanOrEqual(o.delivered);
    expect(o.recent.length).toBeGreaterThan(0);
    expect(o.recent[0].recipientMasked).toMatch(/\*\*\*/);
    const events = (await env.req('GET', '/v1/communications/events?mandatory=true', 'u-admin-entite')).json();
    expect(events.total).toBe(135);
    expect((await env.req('GET', '/v1/communications/overview', 'u-contribuable')).statusCode).toBe(403);
  });

  it('AC-COM-01 : avis obligatoire délivré malgré la désinscription, jamais sur WhatsApp ; preuve conservée', async () => {
    const env = await setup();
    const tp = env.app.ctx.taxpayers.setPreferences(DEMO.taxpayerId, { optedOut: true, whatsappConsent: true, disabledChannels: ['email', 'sms'] });
    const mandatory = env.app.ctx.comms.publish('assessment.issued', [taxpayerRecipient(tp)]);
    const sent = mandatory.filter((d) => d.status !== 'supprime_par_preference');
    expect(sent.map((d) => d.channel).sort()).toEqual(['courrier', 'email', 'in-app', 'sms', 'ussd']);
    expect(mandatory.some((d) => d.channel === 'whatsapp')).toBe(false);
    expect(sent.every((d) => d.mandatory && d.contentHash.length === 64)).toBe(true);
    // Preuve conservée dans le journal de délivrance.
    const ids = new Set(sent.map((d) => d.id));
    expect(env.app.ctx.comms.deliveries.find((d) => ids.has(d.id))).toHaveLength(sent.length);
    // Un message facultatif, lui, respecte la désinscription.
    const optional = env.app.ctx.comms.publish('lease.expiring', [taxpayerRecipient(tp)]);
    expect(optional.filter((d) => d.status !== 'supprime_par_preference').map((d) => d.channel)).toEqual(['in-app']);
    expect(optional.some((d) => d.status === 'supprime_par_preference' && d.channel === 'email')).toBe(true);
  });

  it('AC-COM-02 : sans clé fournisseur, l’envoi de test est « journalise » (bac à sable)', async () => {
    const env = await setup();
    const res = await env.req('POST', '/v1/communications/test', 'u-admin-entite', { eventCode: 'payment.confirmed', entity: 'DGIPK' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.sandbox).toBe(true);
    const byChannel = Object.fromEntries(body.deliveries.map((d: { channel: string; status: string }) => [d.channel, d.status]));
    expect(byChannel).toEqual({ email: 'journalise', 'in-app': 'delivre', sms: 'journalise', push: 'journalise' });
    expect(body.deliveries.find((d: { channel: string }) => d.channel === 'email').provider).toBe('bac-a-sable-email');
    expect(env.app.ctx.audit.list({ action: 'notification.test_sent' }).total).toBe(1);
  });

  it('avec une clé fournisseur configurée, le canal est raccordé (file sortante)', async () => {
    const env = await setup({ commsProviderKeys: { email: 'cle-test' } });
    const body = (await env.req('POST', '/v1/communications/test', 'u-admin-entite', { eventCode: 'payment.confirmed', entity: 'DGIPK' })).json();
    expect(body.deliveries.find((d: { channel: string }) => d.channel === 'email').status).toBe('en_file');
    expect((await env.req('GET', '/v1/communications/overview', 'u-admin-entite')).json().channelsWired).toBe(2);
  });

  it('aperçu courriel : charte Ville de Kinshasa, bloc entité, mention obligatoire, « la version française fait foi »', async () => {
    const env = await setup();
    const fr = await env.req('GET', '/v1/communications/preview/assessment.issued?entity=DGIPK&lang=fr', 'u-admin-entite');
    expect(fr.statusCode).toBe(200);
    expect(fr.headers['content-type']).toContain('text/html');
    const html = fr.body;
    expect(html).toContain('src="/logo-ville-de-kinshasa.png"');
    expect(html).toContain('alt="Ville de Kinshasa"');
    for (const c of ['#232C6B', '#1E9BD7', '#F7D618', '#D7141A', '#F5F7FB']) expect(html).toContain(c);
    expect(html).toContain('Direction générale des impôts provinciaux de Kinshasa');
    expect(html).toContain('Avis obligatoire');
    expect(html).toContain('/logo-groupe-nseya.png');
    expect(html).toContain('Plateforme KINSHASA MOSOLO — réalisée par Groupe Nseya');
    expect(html).not.toContain('fait foi');
    const ln = await env.req('GET', '/v1/communications/preview/lease.expiring?entity=MINFIN&lang=ln', 'u-admin-entite');
    expect(ln.body).toContain('La version française fait foi.');
    expect(ln.body).toContain('lang="ln"');
    expect(ln.body).toContain('Ministère provincial des Finances');
    expect(ln.body).not.toContain('data-mandatory');
    expect((await env.req('GET', '/v1/communications/preview/inexistant', 'u-admin-entite')).json().code).toBe('UNKNOWN_EVENT');
    expect((await env.req('GET', '/v1/communications/preview/assessment.issued?entity=XYZ', 'u-admin-entite')).json().code).toBe('UNKNOWN_ENTITY');
  });
});
