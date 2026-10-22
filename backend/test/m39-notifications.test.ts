/**
 * Module 39 — Notifications et communication : modèles versionnés par recette et par langue (activation à deux
 * personnes, aucun lien, mise en demeure seulement sur acte en vigueur), préférences et consentements, preuves de remise
 * (accusés signés, lecture), canal de secours, avis imprimé apposé sur la plaque, indicateurs.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import type { ChannelProvider } from '../src/modules/communications/providers.js';
import { communicationPlugin, type CommunicationExtService } from '../src/plugins/communication/plugin.js';
import { DEMO, type TestEnv } from './helpers.js';

async function setup(): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, plugins: [communicationPlugin], secrets: { auditHmacKey: 'test-audit-key', providerSecrets: {}, commsProviderKeys: {} } });
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
const ext = (env: TestEnv) => env.app.ctx.ext.communication as CommunicationExtService;
const failing = (channel: ChannelProvider['channel']): ChannelProvider => ({ channel, name: `echec-${channel}`, mode: 'live', send: () => ({ status: 'echoue' }) });
const recipient = (env: TestEnv) => ext(env).recipientOf(DEMO.taxpayerId)!;

describe('Module 39 — notifications et communication', () => {
  it('modèles versionnés par recette et par langue : aucun lien, activation distincte, version précédente archivée, appliqués à l’envoi', async () => {
    const env = await setup();
    expect((await env.req('POST', '/v1/communication/modeles', 'u-dg-dgipk', { eventCode: 'obligation.overdue', lang: 'fr', text: 'Retard : payez sur https://paie-vite.example.com' })).json().code).toBe('SUSPICIOUS_LINK');
    const t1 = (await env.req('POST', '/v1/communication/modeles', 'u-dg-dgipk', { eventCode: 'obligation.overdue', lang: 'fr', text: '{{reference}} est en retard. Payez au compte public officiel.' })).json();
    expect(t1).toMatchObject({ version: 1, status: 'BROUILLON' });
    expect((await env.req('POST', `/v1/communication/modeles/${t1.id}/decision`, 'u-dg-dgipk', { approve: true, motif: 'auto' })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/communication/modeles/${t1.id}/decision`, 'u-autorite-publication', { approve: true, motif: 'Texte vérifié' })).json().status).toBe('ACTIF');
    const sent = env.app.ctx.comms.publish('obligation.overdue', [recipient(env)], { reference: 'OBL-X' });
    expect(sent[0]!.template).toEqual({ id: t1.id, version: 1 });
    // Modèle propre à une recette : préféré au modèle général pour cette recette.
    const tr = (await env.req('POST', '/v1/communication/modeles', 'u-dg-dgipk', { eventCode: 'obligation.overdue', revenueCategory: 'IMPOT_PROVINCIAL', lang: 'fr', text: 'Impôt : {{reference}} en retard.' })).json();
    await env.req('POST', `/v1/communication/modeles/${tr.id}/decision`, 'u-autorite-publication', { approve: true, motif: 'Texte vérifié' });
    expect(env.app.ctx.comms.publish('obligation.overdue', [recipient(env)], { reference: 'OBL-Y' }, { revenueCategory: 'IMPOT_PROVINCIAL' })[0]!.template!.id).toBe(tr.id);
    const t2 = (await env.req('POST', '/v1/communication/modeles', 'u-dg-dgipk', { eventCode: 'obligation.overdue', lang: 'fr', text: '{{reference}} : échéance dépassée.' })).json();
    expect(t2.version).toBe(2);
    await env.req('POST', `/v1/communication/modeles/${t2.id}/decision`, 'u-autorite-publication', { approve: true, motif: 'Nouvelle version' });
    expect(ext(env).templates.get(t1.id)!.status).toBe('ARCHIVE');
    // Mise en demeure : base légale obligatoire, acte en vigueur exigé.
    expect((await env.req('POST', '/v1/communication/modeles', 'u-dg-dgipk', { eventCode: 'recovery.formal_notice', lang: 'fr', text: 'Mise en demeure {{reference}}.' })).json().code).toBe('LEGAL_BASIS_REQUIRED');
    const md = (await env.req('POST', '/v1/communication/modeles', 'u-dg-dgipk', { eventCode: 'recovery.formal_notice', lang: 'fr', text: 'Mise en demeure {{reference}}.', legalBasis: { instrumentId: 'ol-18-003', article: 'Art. 1' } })).json();
    expect((await env.req('POST', `/v1/communication/modeles/${md.id}/decision`, 'u-autorite-publication', { approve: true, motif: 'Acte cité' })).json().code).toBe('LEGAL_BASIS_NOT_IN_FORCE');
  });

  it('préférences : canal choisi, canaux refusés, consentement WhatsApp ; journal ; cloisonnement', async () => {
    const env = await setup();
    expect((await env.req('PUT', `/v1/communication/preferences/${DEMO.taxpayerId}`, 'u-contribuable', { preferredChannel: 'whatsapp' })).json().code).toBe('WHATSAPP_CONSENT_REQUIRED');
    expect((await env.req('PUT', `/v1/communication/preferences/${DEMO.tenantTaxpayerId}`, 'u-contribuable', { preferredChannel: 'sms' })).statusCode).toBe(403);
    const p = (await env.req('PUT', `/v1/communication/preferences/${DEMO.taxpayerId}`, 'u-contribuable', { preferredChannel: 'sms', disabledChannels: ['email'], language: 'ln' })).json();
    expect(p.prefs).toMatchObject({ preferredChannel: 'sms', disabledChannels: ['email'] });
    expect(p.language).toBe('ln');
    expect(p.history).toHaveLength(1);
    // Facultatif : courriel refusé ; obligatoire : envoyé malgré le refus (avis protégeant des droits).
    const optional = env.app.ctx.comms.publish('obligation.due_soon', [recipient(env)], { montant: '10 USD', date: '2026-10-10' });
    expect(optional.find((d) => d.channel === 'email')!.status).toBe('supprime_par_preference');
    const mandatory = env.app.ctx.comms.publish('obligation.overdue', [recipient(env)], { reference: 'OBL-1' });
    expect(mandatory.find((d) => d.channel === 'email')!.status).not.toBe('supprime_par_preference');
  });

  it('accusés signés (preuve de remise horodatée), échec ⇒ canal de secours, lecture dans l’application, indicateurs', async () => {
    const env = await setup();
    const [first] = env.app.ctx.comms.publish('obligation.due_soon', [recipient(env)], { montant: '10 USD', date: '2026-10-10' }, { onlyChannels: ['sms'] });
    const body = { deliveryId: first!.id, status: 'echoue', at: '2026-09-26T09:05:00.000Z' };
    const raw = JSON.stringify(body);
    expect((await env.req('POST', '/v1/communication/accuses', undefined, raw, { 'x-signature': 'a'.repeat(64) })).statusCode).toBe(401);
    const r = await env.req('POST', '/v1/communication/accuses', undefined, raw, { 'x-signature': ext(env).receiptSignature(raw) });
    expect(r.statusCode).toBe(200);
    expect(r.json().fallbackDeliveryIds.length).toBeGreaterThan(0);
    const fb = env.app.ctx.comms.deliveries.get(r.json().fallbackDeliveryIds[0])!;
    expect(fb.fallbackOf).toBe(first!.id);
    expect(fb.channel).not.toBe('sms');
    // Délivrance confirmée du message de secours, puis lecture dans l'application par le destinataire.
    const ok = JSON.stringify({ deliveryId: fb.id, status: 'delivre', at: '2026-09-26T09:07:00.000Z' });
    await env.req('POST', '/v1/communication/accuses', undefined, ok, { 'x-signature': ext(env).receiptSignature(ok) });
    expect((await env.req('POST', `/v1/communication/messages/${fb.id}/lecture`, 'u-locataire')).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/communication/messages/${fb.id}/lecture`, 'u-contribuable')).json().status).toBe('lu');
    const proof = (await env.req('GET', `/v1/communication/envois/${first!.id}/preuve`, 'u-dg-dgipk')).json();
    expect(proof.chain.length).toBeGreaterThanOrEqual(2);
    expect(proof.receipts.map((x: { status: string }) => x.status)).toEqual(expect.arrayContaining(['echoue', 'delivre', 'lu']));
    const ind = (await env.req('GET', '/v1/communication/indicateurs', 'u-dg-dgipk')).json();
    expect(ind.delivrance.statut).toBe('MESURE');
    expect(ind.delai).toMatchObject({ statut: 'MESURE', medianeMinutes: expect.any(Number) });
    expect(ind.ouverture.messages.statut).toBe('MESURE');
    expect(ind.raccordement).toMatch(/À RACCORDER/);
  });

  it('canaux épuisés pour un avis obligatoire : avis imprimé à apposer sur la plaque ; apposition sur place (preuve), vérification publique', async () => {
    const env = await setup();
    for (const ch of ['sms', 'svi', 'courrier', 'email', 'ussd'] as const) env.app.ctx.comms.setProvider(ch, failing(ch));
    const out = env.app.ctx.comms.publish('obligation.overdue', [recipient(env)], { reference: 'OBL-9' });
    expect(out.filter((d) => d.status === 'echoue').length).toBeGreaterThan(1);
    const notices = (await env.req('GET', '/v1/communication/avis-plaque', 'u-controleur')).json();
    expect(notices[0]).toMatchObject({ origin: 'ECHEC_CANAUX', status: 'A_APPOSER', taxpayerId: DEMO.taxpayerId });
    const n = notices[0];
    const obj = env.app.ctx.objects.objects.get(n.objectId)!;
    expect((await env.req('POST', `/v1/communication/avis-plaque/${n.id}/apposition`, 'u-agent-terrain', { gps: { lat: obj.lat + 0.01, lon: obj.lon, accuracyM: 5 }, photoSha256: 'f'.repeat(64) })).json().code).toBe('NOT_AT_OBJECT');
    const posted = (await env.req('POST', `/v1/communication/avis-plaque/${n.id}/apposition`, 'u-agent-terrain', { gps: { lat: obj.lat, lon: obj.lon, accuracyM: 5 }, photoSha256: 'f'.repeat(64) })).json();
    expect(posted.status).toBe('APPOSE');
    expect(posted.posting.distanceM).toBe(0);
    expect((await env.req('GET', `/v1/public/avis-plaque/${n.verificationCode}`)).json()).toMatchObject({ authentique: true, statut: 'APPOSE' });
    expect((await env.req('GET', '/v1/public/avis-plaque/INCONNU00')).json().authentique).toBe(false);
    expect(env.app.ctx.audit.list({ action: 'communication.plate_notice.posted', limit: 5 }).items).toHaveLength(1);
  });
});
