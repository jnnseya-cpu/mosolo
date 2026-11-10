import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { PartnerApiService } from '../src/plugins/plateforme/partenaires.js';
import type { PlateformeService } from '../src/plugins/plateforme/plugin.js';
import { loggerOptions, scrubUrl } from '../src/plugins/plateforme/supervision.js';
import { sha256Hex } from '../src/core/crypto.js';
import { callbackBody, callbackHeaders } from './helpers.js';
import { DEMO } from '../src/seed.js';

const FP = 'ab'.repeat(32);

async function full(opts: { mtls?: boolean } = {}) {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  if (opts.mtls) {
    process.env.MOSOLO_MTLS_MODE = 'proxy';
    process.env.MOSOLO_MTLS_ALLOWLIST = `${FP}=banque-a`;
    process.env.MOSOLO_MTLS_PATHS = '/v1/aucun-chemin-protege/';
  }
  const app = buildApp({ clock, secrets: { auditHmacKey: 'k', providerSecrets: { 'bank-a': 'secret-bank-a-0123456789', 'mm-operator-a': 's' }, commsProviderKeys: {} } });
  await app.ready();
  if (opts.mtls) { delete process.env.MOSOLO_MTLS_MODE; delete process.env.MOSOLO_MTLS_ALLOWLIST; delete process.env.MOSOLO_MTLS_PATHS; }
  const req = (method: string, url: string, user?: string, body?: unknown, headers: Record<string, string> = {}) => app.inject({
    method: method as 'GET', url,
    headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { app, clock, req, ctx: app.ctx, svc: app.ctx.ext.plateforme as PlateformeService };
}

const contractBody = (code: string, scopes: string[], extra: Record<string, unknown> = {}) => ({
  code, partnerName: 'Opérateur de test (fictif)', partnerKind: 'OPERATEUR', object: 'Statut des paiements confirmés par l’opérateur (test).', scopes,
  dataCategories: ['Référence', 'Statut'], protocol: { reference: 'PROTO-TEST-1', sha256: sha256Hex('protocole'), signedAt: '2026-09-01' },
  consentRequired: false, validFrom: '2026-09-01', validTo: '2027-09-01', ...extra,
});

describe('Module 52 — intégration et API partenaires', () => {
  it('registre des interfaces : protocole signé approuvé par une seconde personne ; client OAuth2 ; portées limitées à l’objet contracté', async () => {
    const { req, svc } = await full();
    const c = await req('POST', '/v1/plateforme/partenaires/contrats', 'u-superadmin', contractBody('ITF-TEST-1', ['quittances:verifier', 'statistiques:agregees']));
    expect(c.statusCode).toBe(201);
    // Aucun client sans contrat ACTIF.
    expect((await req('POST', '/v1/plateforme/partenaires/clients', 'u-superadmin', { contractId: c.json().id, label: 'Client test' })).statusCode).toBe(409);
    // Le même agent ne s'approuve pas ; le délégué à la sécurité approuve.
    expect((await req('POST', `/v1/plateforme/partenaires/contrats/${c.json().id}/decision`, 'u-superadmin', { approve: true, motif: 'Auto-approbation interdite' })).statusCode).toBe(403);
    expect((await req('POST', `/v1/plateforme/partenaires/contrats/${c.json().id}/decision`, 'u-rssi', { approve: true, motif: 'Protocole signé vérifié' })).json().status).toBe('ACTIF');
    const k = (await req('POST', '/v1/plateforme/partenaires/clients', 'u-superadmin', { contractId: c.json().id, label: 'Client test' })).json();
    expect(k.clientSecret).toBeTruthy();
    expect(JSON.stringify(svc.partenaires.clients.get(k.client.id))).not.toContain(k.clientSecret);
    // Portée hors objet contracté : refus « invalid_scope », journalisé.
    const bad = await req('POST', '/v1/oauth/token', undefined, { grant_type: 'client_credentials', client_id: k.client.id, client_secret: k.clientSecret, scope: 'paiements:statut' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('invalid_scope');
    expect((await req('POST', '/v1/oauth/token', undefined, { grant_type: 'client_credentials', client_id: k.client.id, client_secret: 'faux' })).statusCode).toBe(401);
    const tok = (await req('POST', '/v1/oauth/token', undefined, { grant_type: 'client_credentials', client_id: k.client.id, client_secret: k.clientSecret, scope: 'quittances:verifier' })).json();
    expect(tok.token_type).toBe('Bearer');
    const auth = { authorization: `Bearer ${tok.access_token}` };
    // Portée absente du jeton : 403 ; hors du contrat : 403 hors objet.
    expect((await req('GET', '/v1/partenaires/api/v1/statistiques', undefined, undefined, auth)).statusCode).toBe(403);
    const outside = await req('GET', '/v1/partenaires/api/v1/paiements/REF-1', undefined, undefined, auth);
    expect(outside.statusCode).toBe(403);
    expect(outside.json().code).toBe('OUT_OF_CONTRACTED_OBJECT');
    expect((await req('GET', '/v1/partenaires/api/v1/quittances/INCONNUE', undefined, undefined, auth)).statusCode).toBe(404);
    // Sans jeton : 401 ; jeton partenaire non pris pour une personne.
    expect((await req('GET', '/v1/partenaires/api/v1/quittances/X', undefined)).statusCode).toBe(401);
    expect((await req('GET', '/v1/plateforme/partenaires', undefined, undefined, auth)).statusCode).toBe(401);
    // Journal de chaque appel et indicateurs.
    const v = (await req('GET', '/v1/plateforme/partenaires', 'u-rssi')).json();
    const outcomes = v.calls.map((x: { outcome: string }) => x.outcome);
    expect(outcomes).toEqual(expect.arrayContaining(['HORS_OBJET', 'PORTEE_INSUFFISANTE', 'NON_AUTHENTIFIE', 'INTROUVABLE', 'OK']));
    expect(v.indicators.map((i: { code: string }) => i.code)).toEqual(['APPELS', 'ERREURS', 'DISPONIBILITE_PARTENAIRES']);
    expect(v.clients[0].outOfObject).toBeGreaterThan(0);
    // Révocation : jetons invalidés.
    await req('POST', `/v1/plateforme/partenaires/clients/${k.client.id}/revocation`, 'u-rssi', { motif: 'Fin de la convention de test' });
    expect((await req('GET', '/v1/partenaires/api/v1/quittances/X', undefined, undefined, auth)).statusCode).toBe(401);
  });

  it('quotas : au-delà de la limite par minute, 429 journalisé', async () => {
    const { req, clock } = await full();
    const c = (await req('POST', '/v1/plateforme/partenaires/contrats', 'u-superadmin', contractBody('ITF-TEST-Q', ['quittances:verifier']))).json();
    await req('POST', `/v1/plateforme/partenaires/contrats/${c.id}/decision`, 'u-rssi', { approve: true, motif: 'Protocole signé vérifié' });
    const k = (await req('POST', '/v1/plateforme/partenaires/clients', 'u-superadmin', { contractId: c.id, label: 'Quota', quota: { perMinute: 2, perDay: 100 } })).json();
    const tok = (await req('POST', '/v1/oauth/token', undefined, { grant_type: 'client_credentials', client_id: k.client.id, client_secret: k.clientSecret })).json();
    const auth = { authorization: `Bearer ${tok.access_token}` };
    await req('GET', '/v1/partenaires/api/v1/quittances/A', undefined, undefined, auth);
    await req('GET', '/v1/partenaires/api/v1/quittances/B', undefined, undefined, auth);
    expect((await req('GET', '/v1/partenaires/api/v1/quittances/C', undefined, undefined, auth)).statusCode).toBe(429);
    clock.advance(61_000);
    expect((await req('GET', '/v1/partenaires/api/v1/quittances/D', undefined, undefined, auth)).statusCode).toBe(404);
  });

  it('liaison TLS mutuel facultative (socle/mtls.ts) : jeton délivré et utilisé seulement avec le certificat enregistré', async () => {
    const { req } = await full({ mtls: true });
    const c = (await req('POST', '/v1/plateforme/partenaires/contrats', 'u-superadmin', contractBody('ITF-TEST-M', ['quittances:verifier']))).json();
    await req('POST', `/v1/plateforme/partenaires/contrats/${c.id}/decision`, 'u-rssi', { approve: true, motif: 'Protocole signé vérifié' });
    const k = (await req('POST', '/v1/plateforme/partenaires/clients', 'u-superadmin', { contractId: c.id, label: 'Lié mTLS', certFingerprint: FP })).json();
    const body = { grant_type: 'client_credentials', client_id: k.client.id, client_secret: k.clientSecret };
    expect((await req('POST', '/v1/oauth/token', undefined, body)).statusCode).toBe(403);
    const tok = (await req('POST', '/v1/oauth/token', undefined, body, { 'x-client-cert-sha256': FP })).json();
    expect(tok.access_token).toBeTruthy();
    const auth = { authorization: `Bearer ${tok.access_token}` };
    expect((await req('GET', '/v1/partenaires/api/v1/quittances/X', undefined, undefined, auth)).statusCode).toBe(403);
    expect((await req('GET', '/v1/partenaires/api/v1/quittances/X', undefined, undefined, { ...auth, 'x-client-cert-sha256': FP })).statusCode).toBe(404);
  });

  it('événements signés : paiement confirmé livré au partenaire du prestataire contracté, signature vérifiable', async () => {
    const { req, svc, clock, app } = await full();
    const c = (await req('POST', '/v1/plateforme/partenaires/contrats', 'u-superadmin', contractBody('ITF-TEST-E', ['evenements:paiements', 'paiements:statut'], { providerId: 'mm-operator-a' }))).json();
    await req('POST', `/v1/plateforme/partenaires/contrats/${c.id}/decision`, 'u-rssi', { approve: true, motif: 'Protocole signé vérifié' });
    const k = (await req('POST', '/v1/plateforme/partenaires/clients', 'u-superadmin', { contractId: c.id, label: 'Événements' })).json();
    const tok = (await req('POST', '/v1/oauth/token', undefined, { grant_type: 'client_credentials', client_id: k.client.id, client_secret: k.clientSecret })).json();
    const auth = { authorization: `Bearer ${tok.access_token}` };
    const sub = await req('POST', '/v1/partenaires/api/v1/abonnements', undefined, { url: 'https://partenaire.example/rappels', events: ['paiement.confirme'] }, auth);
    expect(sub.statusCode).toBe(201);
    const received: { body: string; headers: Record<string, string> }[] = [];
    svc.partenaires.transport = async (_url, body, headers) => { received.push({ body, headers }); return { status: 200 }; };
    // Paiement réel confirmé par le prestataire mm-operator-a.
    const ob = app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    const order = (await req('POST', `/v1/obligations/${ob.id}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': 'cle-evenement-0001' })).json();
    const cb = callbackBody({ app, clock, req } as never, order.paymentReference, order.amount);
    const raw = JSON.stringify(cb);
    const r = await app.inject({ method: 'POST', url: '/v1/providers/mm-operator-a/callbacks', headers: { 'content-type': 'application/json', ...callbackHeaders('s', raw, clock.now()) }, payload: raw });
    expect(r.statusCode, JSON.stringify(order) + r.body).toBeLessThan(300);
    await new Promise((res) => setTimeout(res, 10));
    expect(received).toHaveLength(1);
    const h = received[0]!.headers;
    expect(h['x-mosolo-event']).toBe('paiement.confirme');
    expect(h['x-mosolo-signature']).toBe(PartnerApiService.sign(sub.json().signingSecret, h['x-mosolo-timestamp']!, received[0]!.body));
    expect(received[0]!.body).not.toContain(DEMO.taxpayerId);
    // Statut par référence : ordre du prestataire contracté.
    const st = await req('GET', `/v1/partenaires/api/v1/paiements/${order.paymentReference}`, undefined, undefined, auth);
    expect(st.statusCode).toBe(200);
    expect(st.json().status).toBe('CONFIRME');
    const v = (await req('GET', '/v1/plateforme/partenaires', 'u-superadmin')).json();
    expect(v.indicators.find((i: { code: string }) => i.code === 'DISPONIBILITE_PARTENAIRES').value).toBe('100.0');
  });

  it('contrat de démonstration semé en attente d’approbation ; lecture réservée', async () => {
    const { req } = await full();
    const v = (await req('GET', '/v1/plateforme/partenaires', 'u-superadmin')).json();
    expect(v.contracts.some((c: { code: string; status: string }) => c.code === 'ITF-DEMO-BANQUE-A' && c.status === 'PROPOSE')).toBe(true);
    expect((await req('GET', '/v1/plateforme/partenaires', 'u-contribuable')).statusCode).toBe(403);
  });
});

describe('Module 53 — administration de la plateforme', () => {
  it('promotion ordonnée, validation du comité de contrôle des changements, retour arrière approuvé, configuration non financière', async () => {
    const { req } = await full();
    const ask = (body: Record<string, unknown>) => req('POST', '/v1/plateforme/changements', 'integrite-u-ingenieur', { motif: 'Mise à jour planifiée du service', rollbackPlan: 'Redéployer la version précédente', ...body });
    // Pas de production avant la pré-production.
    expect((await ask({ kind: 'DEPLOIEMENT', environment: 'PRE_PRODUCTION', version: '1.0.0' })).statusCode).toBe(422);
    const run = async (body: Record<string, unknown>) => {
      const c = (await ask(body)).json();
      expect((await req('POST', `/v1/plateforme/changements/${c.id}/execution`, 'integrite-u-ingenieur', { result: 'SUCCES', report: 'Sans validation' })).statusCode).toBe(409);
      expect((await req('POST', `/v1/plateforme/changements/${c.id}/avis`, 'integrite-u-ingenieur', { approve: true, motif: 'Je valide ma propre demande' })).statusCode).toBe(403);
      await req('POST', `/v1/plateforme/changements/${c.id}/avis`, 'u-rssi', { approve: true, motif: 'Risque sécurité évalué' });
      expect((await req('POST', `/v1/plateforme/changements/${c.id}/avis`, 'u-rssi', { approve: true, motif: 'Deuxième avis du même membre' })).statusCode).toBe(403);
      const ok = await req('POST', `/v1/plateforme/changements/${c.id}/avis`, 'u-superadmin', { approve: true, motif: 'Comité : changement approuvé' });
      expect(ok.json().status).toBe('APPROUVEE');
      return (await req('POST', `/v1/plateforme/changements/${c.id}/execution`, 'integrite-u-ingenieur', { result: 'SUCCES', report: 'Déploiement réussi' })).json();
    };
    for (const env of ['RECETTE', 'PRE_PRODUCTION', 'PRODUCTION']) await run({ kind: 'DEPLOIEMENT', environment: env, version: '1.0.0' });
    for (const env of ['RECETTE', 'PRE_PRODUCTION', 'PRODUCTION']) await run({ kind: 'DEPLOIEMENT', environment: env, version: '1.1.0' });
    const rb = await run({ kind: 'RETOUR_ARRIERE', environment: 'PRODUCTION', version: '1.0.0' });
    expect(rb.status).toBe('EXECUTEE');
    expect(rb.execution.previousVersion).toBe('1.1.0');
    const v = (await req('GET', '/v1/plateforme/administration', 'u-rssi')).json();
    expect(v.environments.find((e: { id: string }) => e.id === 'PRODUCTION').version).toBe('1.0.0');
    expect(v.indicators.find((i: { code: string }) => i.code === 'DEPLOIEMENTS_REUSSIS').value).toBe('100.0');
    // Configuration financière refusée ; technique acceptée.
    expect((await ask({ kind: 'CONFIGURATION', environment: 'PRODUCTION', config: { key: 'taux_patente', value: '5' } })).statusCode).toBe(403);
    expect((await ask({ kind: 'CONFIGURATION', environment: 'PRODUCTION', config: { key: 'pool.connexions_max', value: '40' } })).statusCode).toBe(201);
  });

  it('aucune lecture métier libre ni modification financière pour les administrateurs techniques', async () => {
    const { req, ctx } = await full();
    // Administrateur technique R26 seul (u-superadmin porte aussi R38 — Groupe Nseya — depuis le 29/09/2026).
    ctx.users.add({ id: 'test-admin-technique', name: 'Administrateur technique (test, R26 seul)', roles: ['R26'], entity: 'PLATEFORME' });
    for (const u of ['integrite-u-ingenieur', 'test-admin-technique']) {
      expect((await req('GET', '/v1/decision/commandement', u)).statusCode, u).toBe(403);
      expect((await req('GET', `/v1/taxpayers/${DEMO.taxpayerId}`, u)).statusCode, u).toBe(403);
      expect((await req('POST', '/v1/ledger/entries/ENT-1/reversals', u, { reason: 'Correction par l’exploitation' })).statusCode, u).toBe(403);
    }
  });

  it('incidents post-déploiement : incident déclaré dans la fenêtre suivant un déploiement en production', async () => {
    const { req, svc, ctx } = await full();
    const u = ctx.users.get('u-superadmin')!;
    for (const env of ['RECETTE', 'PRE_PRODUCTION', 'PRODUCTION'] as const) {
      const c = svc.admin.request(ctx.users.get('integrite-u-ingenieur')!, { kind: 'DEPLOIEMENT', environment: env, version: '2.0.0', motif: 'Déploiement de test', rollbackPlan: 'Revenir à la version précédente' });
      svc.admin.review(u, c.id, { approve: true, motif: 'Avis favorable du comité' });
      svc.admin.review(ctx.users.get('u-rssi')!, c.id, { approve: true, motif: 'Avis favorable du comité' });
      svc.admin.execute(u, c.id, { result: 'SUCCES', report: 'Réussi' });
    }
    await req('POST', '/v1/plateforme/incidents', 'u-rssi', { title: 'Lenteurs après déploiement', service: 'API paiements', severity: 'S3' });
    const v = (await req('GET', '/v1/plateforme/administration', 'u-rssi')).json();
    expect(v.indicators.find((i: { code: string }) => i.code === 'INCIDENTS_POST_DEPLOIEMENT').value).toBe('1');
  });
});

describe('Module 55 — supervision et santé du système', () => {
  it('métriques au format texte Prometheus, gabarits de route sans identifiant', async () => {
    const { req } = await full();
    await req('GET', `/v1/taxpayers/${DEMO.taxpayerId}`, 'u-contribuable');
    const m = await req('GET', '/v1/plateforme/metrics', 'integrite-u-ingenieur');
    expect(m.statusCode).toBe(200);
    expect(m.headers['content-type']).toContain('text/plain');
    expect(m.body).toContain('# TYPE mosolo_http_requests_total counter');
    expect(m.body).toContain('mosolo_http_request_duration_ms_bucket');
    expect(m.body).toContain('route="/v1/taxpayers/:id"');
    expect(m.body).not.toContain(DEMO.taxpayerId);
    expect((await req('GET', '/v1/plateforme/metrics', 'u-contribuable')).statusCode).toBe(403);
    expect((await req('GET', '/v1/plateforme/metrics')).statusCode).toBe(401);
  });

  it('alertes disponibilité / latence contre la cible de 99,9 % ; aucune alerte sous le minimum de requêtes', async () => {
    const { svc, ctx } = await full();
    for (let i = 0; i < 30; i++) svc.supervision.record('GET', '/v1/x', i < 2 ? 503 : 200, i < 5 ? 3000 : 20);
    const out = svc.supervision.evaluateAlerts();
    expect(out.map((a) => a.code)).toEqual(expect.arrayContaining(['DISPONIBILITE', 'LATENCE', 'ERREURS']));
    expect(ctx.alerts.alerts.all().some((a) => a.type === 'SUPERVISION_DISPONIBILITE')).toBe(true);
    // Idempotent dans la fenêtre.
    expect(svc.supervision.evaluateAlerts().every((a) => !a.raised)).toBe(true);
  });

  it('incident : astreinte notifiée, rétablissement, clôture par une autre personne avec revue post-incident ; délai contre le RTO', async () => {
    const { req, clock } = await full();
    await req('POST', '/v1/plateforme/astreintes', 'u-superadmin', { userId: 'integrite-u-ingenieur', level: 'PRINCIPAL', from: '2026-09-26T00:00:00Z', to: '2026-09-27T00:00:00Z' });
    const d = (await req('POST', '/v1/plateforme/incidents', 'u-rssi', { title: 'Paiements indisponibles', service: 'API paiements', severity: 'S1' })).json();
    expect(d.notified).toEqual(['integrite-u-ingenieur']);
    const id = d.incident.id;
    await req('POST', `/v1/plateforme/incidents/${id}/etapes`, 'integrite-u-ingenieur', { step: 'PRISE_EN_CHARGE', note: 'Astreinte mobilisée' });
    clock.advanceHours(5);
    await req('POST', `/v1/plateforme/incidents/${id}/etapes`, 'integrite-u-ingenieur', { step: 'RETABLI', note: 'Basculement sur le site secondaire' });
    expect((await req('POST', `/v1/plateforme/incidents/${id}/etapes`, 'integrite-u-ingenieur', { step: 'CLOS', note: 'Clôture', rootCause: 'Saturation de la base', postMortemSha256: 'c'.repeat(64) })).statusCode).toBe(403);
    expect((await req('POST', `/v1/plateforme/incidents/${id}/etapes`, 'u-rssi', { step: 'CLOS', note: 'Clôture', rootCause: 'Saturation de la base', postMortemSha256: 'c'.repeat(64) })).json().status).toBe('CLOS');
    const v = (await req('GET', '/v1/plateforme/supervision', 'u-rssi')).json();
    const ttr = v.indicators.find((i: { code: string }) => i.code === 'DELAI_RETABLISSEMENT');
    expect(ttr.value).toBe('5.00');
    expect(ttr.target).toBe(4);
    expect(ttr.meetsTarget).toBe(false);
    expect(v.targets.availabilityPct).toBe('99.9');
    expect(v.indicators.find((i: { code: string }) => i.code === 'DISPONIBILITE').measured).toBe(true);
  });

  it('journaux sans secrets ni données personnelles inutiles', () => {
    expect(scrubUrl('/v1/taxpayers/x?phone=+243810000001&token=abc')).toBe('/v1/taxpayers/x?phone=[expurgé]&token=[expurgé]');
    expect(scrubUrl('/v1/contact/+243810000001/jean@exemple.cd')).toBe('/v1/contact/[numéro]/[courriel]');
    const o = loggerOptions() as { redact: { paths: string[] } };
    expect(o.redact.paths).toEqual(expect.arrayContaining(['req.headers.authorization', 'req.headers["x-demo-user"]']));
  });
});
