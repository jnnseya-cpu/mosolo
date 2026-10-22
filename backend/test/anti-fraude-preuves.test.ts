/**
 * Anti-fraude des preuves (30/09/2026, consigne du maître d'ouvrage : « un code imprimé ne doit pas servir à plusieurs
 * personnes ; tout verrouiller ; punir tous ceux qui sont impliqués ») :
 *  1. plaque réellement lue obligatoire — écart ⇒ rouge, blocage conservatoire, alerte, dossier ;
 *  2. QR animé exigé pour un pass personnel ; aucune copie publiée par la page publique ;
 *  3. pass lié au compte de son titulaire (seul ce compte génère le QR animé) ;
 *  4. copies détectées à chaque scan (déplacement impossible, agents simultanés) ⇒ blocage + dossier ;
 *  5. gilet par son seul numéro refusé ; vignette technique signée, vue sur un autre véhicule ⇒ signalée ;
 *  7. chaîne de la fraude ; instruction (enquêteur) ; décision par une personne distincte ; aucune sanction automatique.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { titresPlugin, type TitresService } from '../src/plugins/titres/plugin.js';
import type { ValidityPolicy } from '../src/plugins/titres/model.js';
import { DEMO } from '../src/seed.js';
import { callbackHeaders } from './helpers.js';

let saved: string | undefined;
beforeEach(() => { saved = process.env.MOSOLO_DEMO_MODE; process.env.MOSOLO_DEMO_MODE = '1'; });
afterEach(() => { if (saved === undefined) delete process.env.MOSOLO_DEMO_MODE; else process.env.MOSOLO_DEMO_MODE = saved; });

const SECRET = 'test-secret-mm-operator-a';
const GOMBE = { commune: 'Gombe', label: 'Boulevard du 30 Juin', lat: -4.3040, lon: 15.3100 };
const LOIN = { commune: 'Gombe', label: 'Loin (test)', lat: -4.3800, lon: 15.6000 };
const PLACE_SERVICE = { commune: 'Gombe', sourceId: 'ZONE-GOM-01', label: 'Zone de test', basis: 'ZONE_SERVICE' as const };
const base: Omit<ValidityPolicy, 'model'> = { toleranceMinutes: 0, amberMinutes: 120, startMode: 'PAIEMENT', extendable: true, refundable: false };

async function titresEnv() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, plugins: [titresPlugin], secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': SECRET }, commsProviderKeys: {} } });
  await app.ready();
  const ctx = app.ctx;
  const t = ctx.ext.titres as TitresService;
  for (const id of ['af-ctl-1', 'af-ctl-2', 'af-ctl-3']) ctx.users.add({ id, name: `Contrôleur ${id} (démo)`, roles: ['R11'], entity: 'DGIPK' });
  const drafter = ctx.users.get('u-juriste-redacteur')!;
  const rule = ctx.rules.create(drafter, {
    code: 'TEST-AF', revenueCategory: 'REDEVANCE_SERVICE', label: 'Test anti-fraude (fictive)', legalInstrumentIds: ['demo-instrument-001'], articles: ['Art. 1 (fictif)'],
    competentAuthority: 'Test', administeringEntity: 'DGIPK', taxableEvent: 'Usage', liableParty: 'Usager', baseDefinition: 'Unités', formula: 'n * t', rateTable: { t: '2' },
    currency: 'USD', rounding: 'HALF_UP', periodicity: 'PONCTUELLE', dueRule: 'À l’achat', exemptions: [], penalties: [], effectiveFrom: '2026-01-01',
    beneficiaryAccountAlias: DEMO.dgipkAlias, appealPath: 'Réclamation', sourceVerification: 'OFFICIEL_CERTIFIE',
  });
  ctx.rules.approve(drafter, rule.id, 'REDACTEUR');
  ctx.rules.approve(ctx.users.get('u-juriste-verificateur')!, rule.id, 'VERIFICATEUR_JURIDIQUE');
  ctx.rules.approve(ctx.users.get('u-validateur-financier')!, rule.id, 'VALIDATEUR_FINANCIER');
  ctx.rules.approve(ctx.users.get('u-autorite-publication')!, rule.id, 'AUTORITE_PUBLICATION');
  const def = (code: string, plateBound: boolean, validity: Partial<ValidityPolicy> & { model: ValidityPolicy['model'] }) => t.defineType({
    code, module: '99', moduleLabel: 'Module de test', label: `Titre ${code}`, prefix: 'TST', entity: 'DGIPK', validity: { ...base, ...validity }, transferable: false, plateBound,
    supports: ['QR_DYNAMIQUE', 'QR_STATIQUE', 'PLAQUE'], pricing: { ruleCode: 'TEST-AF', inputs: { n: '1' } }, legalAct: { ref: 'J21', status: 'DEMONSTRATION', note: 'Test' }, demo: true,
  });
  def('AF-VIGNETTE', true, { model: 'JOURNALIER', dayMode: 'CALENDAIRE' });
  def('AF-PASS', false, { model: 'JOURNALIER', dayMode: 'CALENDAIRE' });
  const req = (method: string, url: string, user: string | null, body?: unknown) => app.inject({ method: method as 'GET', url, headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
  const buy = async (typeCode: string, subject: Record<string, string> = {}) => {
    const iss = t.purchase(ctx.users.get('u-contribuable')!, { payerTaxpayerId: DEMO.taxpayerId, channel: 'MOBILE_MONEY', items: [{ typeCode, holderTaxpayerId: DEMO.taxpayerId, subject, place: PLACE_SERVICE }] });
    const order = ctx.payments.byReference(iss.payments[0]!.paymentReference)!;
    const raw = JSON.stringify({ providerTxnId: `TXN-${randomUUID()}`, paymentReference: order.paymentReference, amount: order.amount, status: 'SUCCESS', completedAt: clock.now().toISOString() });
    await app.inject({ method: 'POST', url: '/v1/providers/mm-operator-a/callbacks', payload: raw, headers: { 'content-type': 'application/json', ...callbackHeaders(SECRET, raw, clock.now()) } });
    t.sync();
    return t.credential(t.issuance(iss.id).items[0]!.credentialId!);
  };
  return { app, ctx, clock, t, req, buy };
}

describe('Anti-fraude des preuves : un code ne sert qu’une personne, un véhicule, un lieu à la fois', () => {
  it('1. plaque lue obligatoire ; écart ⇒ rouge, titre bloqué à titre conservatoire, alerte et dossier', async () => {
    const { req, t, app, buy } = await titresEnv();
    const c = await buy('AF-VIGNETTE', { plate: 'KN-1234-AB' });
    const sans = await req('POST', '/v1/titres/controles', 'af-ctl-1', { qr: c.staticToken, place: GOMBE });
    expect(sans.json().code).toBe('PLAQUE_CONSTATEE_REQUISE');
    const ok = (await req('POST', '/v1/titres/controles', 'af-ctl-1', { qr: c.staticToken, observedPlate: c.subject.plate, place: GOMBE })).json();
    expect(ok.result).toBe('VALIDE');
    const faux = (await req('POST', '/v1/titres/controles', 'af-ctl-1', { qr: c.staticToken, observedPlate: 'KN-0000-ZZ', place: GOMBE })).json();
    expect(faux.result).toBe('INVALIDE');
    expect(faux.text).toMatch(/Plaque différente/);
    expect(faux.fraude).toMatchObject({ kind: 'PLAQUE_DIFFERENTE' });
    expect(t.credentials.get(c.id)!.state).toBe('SUSPENDU');
    expect(app.ctx.alerts.list().some((a: { type: string }) => a.type === 'FRAUDE_PREUVE_PLAQUE_DIFFERENTE')).toBe(true);
    // Le contrôle VALIDE précédent figure dans la chaîne : l'agent qui a laissé passer est identifié.
    const fc = t.fraudCases.get(faux.fraude.caseId)!;
    expect(fc.acceptedBy.map((a) => a.controllerId)).toContain('af-ctl-1');
  });

  it('4. copie : même code en deux lieux trop éloignés, puis trois agents en dix minutes ⇒ blocage immédiat', async () => {
    const { req, t, clock, buy } = await titresEnv();
    const c = await buy('AF-VIGNETTE', { plate: 'KN-1234-AB' });
    const ctl = (user: string, place: typeof GOMBE) => req('POST', '/v1/titres/controles', user, { qr: c.staticToken, observedPlate: c.subject.plate, place }).then((r) => r.json());
    expect((await ctl('af-ctl-1', GOMBE)).result).toBe('VALIDE');
    clock.advance(5 * 60_000);
    const loin = await ctl('af-ctl-2', LOIN); // ~ 33 km en 5 minutes
    expect(loin.result).toBe('INVALIDE');
    expect(loin.fraude.kind).toBe('CLONE_DEPLACEMENT_IMPOSSIBLE');
    expect(t.credentials.get(c.id)!.state).toBe('SUSPENDU');
    // Autre titre : trois agents distincts au même endroit en dix minutes.
    const c2 = await buy('AF-VIGNETTE', { plate: 'KN-5678-CD' });
    const ctl2 = (user: string) => req('POST', '/v1/titres/controles', user, { qr: c2.staticToken, observedPlate: c2.subject.plate, place: GOMBE }).then((r) => r.json());
    await ctl2('af-ctl-1'); await ctl2('af-ctl-2');
    const trois = await ctl2('af-ctl-3');
    expect(trois.fraude?.kind).toBe('CLONE_AGENTS_SIMULTANES');
  });

  it('2-3. pass personnel : QR fixe ou code refusés, QR animé du compte titulaire accepté (et tracé)', async () => {
    const { req, t, app, buy } = await titresEnv();
    const c = await buy('AF-PASS');
    expect(t.isPassPersonnel(c)).toBe(true);
    expect((await req('POST', '/v1/titres/controles', 'af-ctl-1', { code: c.shortCode, place: GOMBE })).json().text).toMatch(/QR animé/);
    expect((await req('POST', '/v1/titres/controles', 'af-ctl-1', { qr: c.staticToken, place: GOMBE })).json().result).toBe('INVALIDE');
    // Seul le compte du titulaire génère le QR animé ; un autre usager, non.
    expect((await req('GET', `/v1/titres/${c.id}/qr`, 'u-locataire')).statusCode).toBe(403);
    const qr = (await req('GET', `/v1/titres/${c.id}/qr`, 'u-contribuable')).json();
    expect((await req('POST', '/v1/titres/controles', 'af-ctl-1', { qr: qr.token, place: GOMBE })).json().result).toBe('VALIDE');
    expect(app.ctx.audit.list({ action: 'titres.qr_dynamique.genere', resourceId: c.id }).total).toBe(1);
  });

  it('7. chaîne de la fraude, instruction par l’enquêteur, décision par une personne distincte ; aucune sanction automatique', async () => {
    const { req, t, buy } = await titresEnv();
    const c = await buy('AF-VIGNETTE', { plate: 'KN-1234-AB' });
    await req('POST', '/v1/titres/controles', 'af-ctl-1', { qr: c.staticToken, observedPlate: c.subject.plate, place: GOMBE });
    const faux = (await req('POST', '/v1/titres/controles', 'af-ctl-2', { qr: c.staticToken, observedPlate: 'KN-0000-ZZ', place: GOMBE })).json();
    const id = faux.fraude.caseId;
    const chain = (await req('GET', `/v1/titres/fraudes/${id}`, 'u-enqueteur')).json();
    expect(chain.titre.numero).toBe(c.number);
    expect(chain.controles.length).toBeGreaterThanOrEqual(2);
    expect(chain.agentsAyantLaissePasser.map((a: { agent: string }) => a.agent)).toContain('af-ctl-1');
    expect(chain.doctrine.join(' ')).toMatch(/Aucune sanction automatique/);
    // Décision avant instruction : refusée ; l'enquêteur ne décide pas ; un agent mis en cause n'instruit pas.
    expect((await req('POST', `/v1/titres/fraudes/${id}/decision`, 'u-auditeur', { outcome: 'FRAUDE_ETABLIE', motif: 'Titre présenté sur un autre véhicule, constaté.' })).json().code).toBe('INSTRUCTION_REQUIRED');
    expect((await req('POST', `/v1/titres/fraudes/${id}/instruction`, 'u-enqueteur')).statusCode).toBe(200);
    const d = await req('POST', `/v1/titres/fraudes/${id}/decision`, 'u-auditeur', { outcome: 'FRAUDE_ETABLIE', motif: 'Titre présenté sur un autre véhicule, constaté par l’agent.', retenirRecettePerdue: true });
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().suite.join(' ')).toMatch(/autorité compétente/);
    expect(t.credentials.get(c.id)!.state).toBe('REVOQUE');
    const list = (await req('GET', '/v1/titres/fraudes', 'u-enqueteur')).json();
    expect(list.agents.find((a: { agent: string }) => a.agent === 'af-ctl-1')).toMatchObject({ etablis: 1 });
  });

  it('5. gilet par son seul numéro refusé ; vignette technique vue sur un autre véhicule ⇒ signalée, dossier', async () => {
    const clock = new ManualClock('2026-09-26T09:00:00.000Z');
    const app = buildApp({ clock, secrets: { auditHmacKey: 'k', providerSecrets: {}, commsProviderKeys: {} } });
    await app.ready();
    const req = (method: string, url: string, user: string, body?: unknown) => app.inject({ method: method as 'GET', url, headers: { 'x-demo-user': user, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
    const rk = app.ctx.ext.rakapay as { drivers: { all(): { vestNumber: string; status: string }[] } };
    const d = rk.drivers.all().find((x) => x.status === 'ACTIF')!;
    const v = (await req('POST', '/v1/rakapay/wewa/controles', 'rk-controleur', { vest: d.vestNumber, place: { commune: 'Kalamu', label: 'Victoire' } })).json();
    expect(v.result).toBe('INVALIDE');
    expect(v.text).toMatch(/seul numéro/);
    const vc = app.ctx.ext['vehicules-controle'] as { ct: { stickers: { find(p: (s: { status: string }) => boolean): { number: string; plate?: string }[] } } };
    const st = vc.ct.stickers.find((s) => s.status === 'ATTRIBUEE')[0]!;
    const scan = (await req('POST', '/v1/vehicules/scan', 'vc-u-controleur-rfck', { saisie: `https://verification.exemple.cd/v/ct/${st.number}`, plaqueLue: 'KN-9999-XX', place: { commune: 'Limete' } })).json();
    expect(scan.fraude?.kind).toBe('VIGNETTE_AUTRE_VEHICULE');
    const pub = (await app.inject({ method: 'GET', url: `/v1/public/vehicules/vignettes/verifier?numero=${encodeURIComponent(st.number)}` })).json();
    expect(JSON.stringify(pub)).toMatch(/SIGNALEE|signalée/);
  });
});
