/**
 * Module « citoyen » — modules 1 à 12 de la Spécification fonctionnelle : application Android et iOS (4), portail
 * public (5), USSD/SMS (6), relations (7), cadastre (8), locatif (9), patentes (10), véhicules (11), transport (12),
 * et indicateurs réels des douze modules.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { getEvent } from '@mosolo/shared';
import { renderText, smsText, SMS_MAX_CHARS } from '../src/modules/communications/templates.js';
import { chiffreControleMrz, lireMrzTd3, proximiteNoms } from '../src/plugins/citoyen/pieces.js';
import type { CitoyenService } from '../src/plugins/citoyen/service.js';
import { polygonesSeChevauchent } from '../src/plugins/citoyen/cadastre.js';
import { resoudreDefi, solutionValide } from '../src/plugins/citoyen/portail.js';
import type { FiscalService } from '../src/plugins/fiscal/service.js';
import { DEFAULT_PLUGINS } from '../src/plugins/index.js';
import type { VerticalesService } from '../src/plugins/verticales/service.js';
import { DEMO, PROVIDER_SECRET, publishCertifiedRule, type TestEnv } from './helpers.js';

type Env = TestEnv & { svc: CitoyenService; vx: VerticalesService; fiscal: FiscalService };

async function setupCitoyen(): Promise<Env> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, plugins: DEFAULT_PLUGINS, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} } });
  await app.ready();
  const req: TestEnv['req'] = (method, url, user, body, headers = {}) =>
    app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
  return { app, clock, req, svc: app.ctx.ext.citoyen as CitoyenService, vx: app.ctx.ext.verticales as VerticalesService, fiscal: app.ctx.ext.fiscal as FiscalService };
}

const user = (env: Env, id: string) => env.app.ctx.users.get(id)!;

describe('Indicateurs des modules 1 à 12 — calculés sur les données réelles', () => {
  it('douze modules, valeurs réelles ou « non mesuré » avec raison ; réservés au pilotage', async () => {
    const env = await setupCitoyen();
    const r = await env.req('GET', '/v1/citoyen/indicateurs', 'u-auditeur');
    expect(r.statusCode).toBe(200);
    const mods = r.json().modules as { module: number; indicateurs: Record<string, { valeur?: unknown; raison?: string }> }[];
    expect(mods.map((m) => m.module)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const m1 = mods[0]!.indicateurs as Record<string, Record<string, unknown>>;
    expect(m1.comptesActifsParNiveau!.valeur).toBeGreaterThan(0);
    expect(Object.keys(m1.comptesActifsParNiveau!.parNiveau as object)).toEqual(['N0', 'N0A', 'N1', 'N2', 'N3']);
    expect(m1.doublons!.regle).toMatch(/Aucune fusion automatique/);
    // Aucun indicateur sans valeur ni raison.
    for (const m of mods) for (const [k, v] of Object.entries(m.indicateurs)) {
      if (v && typeof v === 'object' && 'valeur' in v && v.valeur === null) expect(v.raison, `${m.module}.${k}`).toBeDefined();
    }
    const m6 = mods[5]!.indicateurs as Record<string, Record<string, unknown>>;
    expect(m6.coutParMessage).toMatchObject({ valeur: null, raison: expect.stringMatching(/À RACCORDER/) });
    // Un contribuable ne voit pas le tableau de pilotage.
    expect((await env.req('GET', '/v1/citoyen/indicateurs', 'u-contribuable')).statusCode).toBe(403);
  });
});

describe('Module 2 et 6 — inscription gratuite par USSD, récapitulatif SMS, enrôlement par canal', () => {
  it('numéro inconnu : option « S’inscrire », nom masqué au journal, compte N0 téléphone vérifié, SMS ≤ 160 sans lien', async () => {
    const env = await setupCitoyen();
    const start = await env.req('POST', '/v1/ussd/sessions', undefined, { msisdn: '+243899000111' });
    expect(start.statusCode).toBe(201);
    expect(start.json().text).toMatch(/10\. S’inscrire/);
    expect(start.json().text.length).toBeLessThanOrEqual(182);
    const id = start.json().sessionId as string;
    const s1 = await env.req('POST', `/v1/ussd/sessions/${id}/input`, undefined, { input: '10' });
    expect(s1.json().text).toMatch(/nom complet/);
    const s2 = await env.req('POST', `/v1/ussd/sessions/${id}/input`, undefined, { input: 'Kabila Mwamba' });
    expect(s2.json().text).toMatch(/Créer votre compte MOSOLO gratuit/);
    const s3 = await env.req('POST', `/v1/ussd/sessions/${id}/input`, undefined, { input: '1' });
    expect(s3.json()).toMatchObject({ end: true });
    expect(s3.json().text).toMatch(/Compte créé/);
    const tp = env.app.ctx.taxpayers.taxpayers.findOne((t) => t.phone === '+243899000111')!;
    expect(tp).toMatchObject({ fullName: 'Kabila Mwamba', verificationLevel: 'N0' });
    expect(tp.phoneVerifiedAt).toBeDefined();
    // Le nom saisi n'apparaît pas dans le journal de session.
    const canaux = env.app.ctx.ext.canaux as { engine: { journal: { all(): { sessionId: string; input: string | null }[] } } };
    expect(canaux.engine.journal.all().filter((j) => j.sessionId === id).map((j) => j.input)).toContain('[nom saisi]');
    expect(JSON.stringify(canaux.engine.journal.all())).not.toContain('Kabila');
    // Récapitulatif par SMS.
    const sms = env.app.ctx.comms.deliveries.all().filter((d) => d.recipientId === tp.id && d.channel === 'sms');
    expect(sms.length).toBeGreaterThan(0);
    // Un numéro déjà inscrit ne voit pas l'option et ne peut pas s'inscrire deux fois.
    const again = await env.req('POST', '/v1/ussd/sessions', undefined, { msisdn: '+243899000111' });
    expect(again.json().text).not.toMatch(/S’inscrire/);
    const refused = await env.req('POST', `/v1/ussd/sessions/${again.json().sessionId}/input`, undefined, { input: '10' });
    expect(refused.json().text).toMatch(/déjà un compte/);
    // Indicateurs : un enrôlement USSD compté.
    const m2 = (await env.req('GET', '/v1/citoyen/indicateurs', 'u-auditeur')).json().modules[1].indicateurs;
    expect(m2.enrolementsParCanal.parCanal.USSD).toBe(1);
  });

  it('SMS : 160 caractères au plus et aucun lien (conçu contre l’hameçonnage)', () => {
    const t = smsText(`Votre avis est prêt — payez vite sur http://mosolo-paiement.xyz/abc ou www.faux.cd ${'x'.repeat(300)}`);
    expect(t.length).toBeLessThanOrEqual(SMS_MAX_CHARS);
    expect(t).not.toMatch(/http|www\.|\.xyz|\.cd/);
  });

  it('inscription web ou application : canal mesuré (en-tête d’installation)', async () => {
    const env = await setupCitoyen();
    const inst = (await env.req('POST', '/v1/public/application/installations', undefined, { plateforme: 'ANDROID', versionApp: '1.0.0', langue: 'fr' })).json();
    const r = await env.req('POST', '/v1/registrations', undefined, { phone: '+243899000222', fullName: 'Tshala Mbuyi', language: 'fr', situation: 'tenant' }, { 'x-mosolo-installation': inst.id });
    expect(r.statusCode).toBe(201);
    await env.req('POST', '/v1/registrations', undefined, { phone: '+243899000223', fullName: 'Ilunga Kasongo', language: 'fr', situation: 'tenant' });
    const m2 = (await env.req('GET', '/v1/citoyen/indicateurs', 'u-auditeur')).json().modules[1].indicateurs;
    expect(m2.enrolementsParCanal.parCanal).toMatchObject({ APPLICATION: 1, WEB: 1 });
  });
});

describe('Module 3 — authentification forte des opérations sensibles du contribuable', () => {
  it('session réelle sans second facteur : désignation de mandataire refusée (401 MFA_REQUIRED) ; démonstration par en-tête inchangée', async () => {
    const env = await setupCitoyen();
    const u = user(env, 'u-contribuable');
    const fakeReq = { user: { ...u, auth: { acr: 'urn:mosolo:acr:pwd', amr: ['pwd'], sessionId: 's' } }, method: 'POST', url: '/v1/acces/mandates' } as never;
    expect(() => env.svc.gardeAuthForte(fakeReq)).toThrow(/second facteur/);
    // Même utilisateur, consultation : pas de step-up.
    expect(() => env.svc.gardeAuthForte({ ...(fakeReq as object), method: 'GET', url: '/v1/acces/mandates' } as never)).not.toThrow();
    // Démonstration (sans contexte d'authentification) : parcours inchangé.
    expect(() => env.svc.gardeAuthForte({ user: u, method: 'POST', url: '/v1/acces/mandates' } as never)).not.toThrow();
  });
});

describe('Module 4 — application Android et iOS : installation, intégrité, transactions, avis', () => {
  it('installation à identifiant aléatoire ; appareil modifié ⇒ fonctions sensibles refusées côté serveur, consultation maintenue', async () => {
    const env = await setupCitoyen();
    const r = await env.req('POST', '/v1/public/application/installations', undefined, { plateforme: 'IOS', versionApp: '1.2.0', langue: 'ln' });
    expect(r.statusCode).toBe(201);
    const inst = r.json();
    expect(inst.id).toMatch(/^APP-[0-9a-f-]{36}$/);
    expect(inst.heureServeur).toBe(env.clock.now().toISOString());
    const ok = await env.req('POST', `/v1/public/application/installations/${inst.id}/integrite`, undefined, { racine: false, jailbreak: false, emulateur: false, debogage: false, source: 'MODULE_NATIF' });
    expect(ok.json().integrite.statut).toBe('CONFORME');
    // Paiement depuis l'application : compté comme transaction mobile.
    const obl = env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId).find((o) => ['EMISE', 'EXIGIBLE', 'EN_RETARD', 'PARTIELLEMENT_PAYEE'].includes(o.status))!;
    const pay = await env.req('POST', `/v1/obligations/${obl.id}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID(), 'x-mosolo-installation': inst.id });
    expect(pay.statusCode).toBe(201);
    // Jailbreak : refus des fonctions sensibles (paiement), alerte de sécurité, audit.
    const ko = await env.req('POST', `/v1/public/application/installations/${inst.id}/integrite`, undefined, { racine: false, jailbreak: true, emulateur: false, debogage: false, source: 'MODULE_NATIF' });
    expect(ko.json().integrite).toMatchObject({ statut: 'COMPROMIS', signaux: ['JAILBREAK'] });
    const refused = await env.req('POST', `/v1/obligations/${obl.id}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID(), 'x-mosolo-installation': inst.id });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('APPAREIL_MODIFIE');
    expect(env.app.ctx.alerts.list().some((a) => a.type === 'APPAREIL_MODIFIE')).toBe(true);
    // La consultation reste ouverte.
    expect((await env.req('GET', `/v1/taxpayers/${DEMO.taxpayerId}`, 'u-contribuable', undefined, { 'x-mosolo-installation': inst.id })).statusCode).toBe(200);
    // Avis et indicateurs.
    expect((await env.req('POST', `/v1/public/application/installations/${inst.id}/avis`, undefined, { note: 4 })).statusCode).toBe(201);
    expect((await env.req('POST', `/v1/public/application/installations/${inst.id}/avis`, undefined, { note: 9 })).statusCode).toBe(400);
    const ind = (await env.req('GET', '/v1/citoyen/application/indicateurs', 'u-auditeur')).json();
    expect(ind.installationsActives).toMatchObject({ valeur: 1, parPlateforme: { IOS: 1 } });
    expect(ind.transactionsMobiles).toMatchObject({ valeur: 2, reussies: 1 });
    expect(ind.tauxEchecPaiement).toMatchObject({ numerateur: 1, denominateur: 2, valeur: '50.0' });
    expect(ind.noteApplication).toMatchObject({ valeur: '4.0', avis: 1 });
    expect(ind.appareilsCompromis).toBe(1);
  });
});

describe('Module 5 — portail public : simulateurs sur règles publiées, information, anti-robots, audience', () => {
  it('IRL : illustration non opposable sur la fiche v2 (22 %, retenue 20 % au 1er rang) ; aucune donnée personnelle', async () => {
    const env = await setupCitoyen();
    const cat = (await env.req('GET', '/v1/public/simulateurs')).json();
    const irl = cat.familles.find((f: { famille: string }) => f.famille === 'IRL');
    const irlCodes = irl.regles.map((r: { code: string; version: number }) => `${r.code}v${r.version}`);
    expect(irlCodes).toEqual(expect.arrayContaining(['IRL-KIN-R1v2', 'IRL-KIN-R234v2']));
    expect(irlCodes).not.toContain('IRL-KIN-R1v1');
    const sim = await env.req('POST', '/v1/public/simulations', undefined, { famille: 'IRL', regle: 'IRL-KIN-R1', rang: 1, entrees: { loyers_percus: '1000', retenues_imputees: '200' } });
    expect(sim.statusCode).toBe(200);
    expect(sim.json()).toMatchObject({ nature: 'ILLUSTRATION_NON_OPPOSABLE', montant: { amount: '20.00', currency: 'USD' }, regle: { code: 'IRL-KIN-R1', version: 2, statut: 'A_VERIFIER' } });
    expect(sim.json().mention).toMatch(/NON OPPOSABLE/);
    // Vignette et patente : aucune règle ⇒ aucun montant inventé.
    const vig = (await env.req('POST', '/v1/public/simulations', undefined, { famille: 'VIGNETTE', entrees: {} })).json();
    expect(vig).toMatchObject({ nature: 'INDISPONIBLE', montant: null });
    expect(vig.motif).toMatch(/Aucune règle publiée/);
    // Aucune donnée personnelle : seules la famille et la règle sont journalisées.
    const rec = env.app.ctx.audit.list({ action: 'portail.simulation.computed', limit: 10 }).items;
    expect(rec.length).toBe(2);
    expect(JSON.stringify(rec)).not.toContain('1000');
  });

  it('information publique, visites anonymes, conversion et vérifications comptées', async () => {
    const env = await setupCitoyen();
    const info = (await env.req('GET', '/v1/public/informations')).json();
    expect(info.guides.length).toBeGreaterThan(10);
    expect(info.calendrier.echeances.some((e: { regle: string; aVerifier: boolean }) => e.regle === 'IRL-KIN-R1' && e.aVerifier)).toBe(true);
    expect(info.pointsDePaiement.route).toBe('/v1/public/payment-points');
    for (const page of ['accueil', 'accueil', 'simulateurs']) expect((await env.req('POST', '/v1/public/visites', undefined, { page })).statusCode).toBe(200);
    expect((await env.req('POST', '/v1/public/visites', undefined, { page: 'inconnue' })).statusCode).toBe(400);
    await env.req('POST', '/v1/registrations', undefined, { phone: '+243899000333', fullName: 'Mujinga Kanku', language: 'fr', situation: 'tenant' });
    const ind = (await env.req('GET', '/v1/citoyen/indicateurs', 'u-auditeur')).json().modules[4].indicateurs;
    expect(ind.visites).toMatchObject({ valeur: 3, parPage: { accueil: 2, simulateurs: 1 } });
    expect(ind.conversionInscription.denominateur).toBe(3);
  });

  it('anti-robots : défi SHA-256 à usage unique exigé du public anonyme (activé), jamais d’un agent authentifié', async () => {
    const env = await setupCitoyen();
    env.svc.portail.antiRobot = true;
    const body = { phone: '+243899000444', fullName: 'Robot Test', language: 'fr', situation: 'tenant' };
    const no = await env.req('POST', '/v1/registrations', undefined, body);
    expect(no.statusCode).toBe(428);
    expect(no.json().code).toBe('DEFI_REQUIS');
    const d = (await env.req('GET', '/v1/public/defi')).json();
    const nonce = resoudreDefi(d.sel, d.difficulte);
    expect(solutionValide(d.sel, nonce, d.difficulte)).toBe(true);
    expect((await env.req('POST', '/v1/registrations', undefined, body, { 'x-mosolo-defi': `${d.id}:${nonce}` })).statusCode).toBe(201);
    // Usage unique.
    const replay = await env.req('POST', '/v1/registrations', undefined, { ...body, phone: '+243899000445' }, { 'x-mosolo-defi': `${d.id}:${nonce}` });
    expect(replay.json().code).toBe('DEFI_DEJA_UTILISE');
    // Guichet authentifié : pas de défi.
    expect((await env.req('POST', '/v1/public/simulations', 'u-guichet', { famille: 'IRL', regle: 'IRL-KIN-R1', entrees: { loyers_percus: '100', retenues_imputees: '0' } })).statusCode).toBe(200);
    expect(d.parametre.statut).toBe('PAR_DEFAUT_A_CONFIRMER');
  });
});

describe('Module 7 — détachement : blocage de mutation sans quitus (règle bloquante) et revue des obligations à la date d’effet', () => {
  it('vente close : obligations échues après la date d’effet mises en revue ; décision humaine motivée', async () => {
    const env = await setupCitoyen();
    const fiscal = env.fiscal;
    const rel = fiscal.relations.relations.find((r) => r.status === 'VALIDEE' && env.app.ctx.assessment.obligations.find((o) => o.objectId === r.objectId && o.taxpayerId === r.taxpayerId && ['EMISE', 'EXIGIBLE', 'EN_RETARD', 'PARTIELLEMENT_PAYEE'].includes(o.status)).length > 0)[0];
    expect(rel).toBeDefined();
    const obl = env.app.ctx.assessment.obligations.find((o) => o.objectId === rel!.objectId && o.taxpayerId === rel!.taxpayerId)[0]!;
    const to = rel!.from > '2020-01-01' ? rel!.from : '2020-01-02';
    const effet = obl.dueDate > to ? (obl.dueDate.slice(0, 10) > to ? to : to) : to;
    const closed = await env.req('POST', `/v1/fiscal/relationships/${rel!.id}/close`, 'u-controleur', { to: effet, reason: 'VENTE', comment: 'Acte de vente présenté' });
    expect(closed.statusCode).toBe(200);
    const revues = (await env.req('GET', '/v1/citoyen/relations/revues?statut=A_REVOIR', 'u-controleur')).json();
    expect(revues.length).toBeGreaterThan(0);
    expect(revues[0]).toMatchObject({ relationId: rel!.id, motifDetachement: 'VENTE', statut: 'A_REVOIR' });
    // Aucune annulation automatique : l'obligation est inchangée.
    expect(env.app.ctx.assessment.get(revues[0].obligationId).status).not.toBe('ANNULEE');
    const dec = await env.req('POST', `/v1/citoyen/relations/revues/${revues[0].id}/decision`, 'u-controleur', { statut: 'A_RECTIFIER', motif: 'Vente antérieure à l’échéance' });
    expect(dec.json()).toMatchObject({ statut: 'A_RECTIFIER', decision: { par: 'u-controleur' } });
    expect((await env.req('POST', `/v1/citoyen/relations/revues/${revues[0].id}/decision`, 'u-controleur', { statut: 'MAINTENUE', motif: 'Deuxième décision' })).statusCode).toBe(409);
    expect((await env.req('GET', '/v1/citoyen/relations/revues', 'u-contribuable')).statusCode).toBe(403);
    const ind = (await env.req('GET', '/v1/citoyen/relations/indicateurs', 'u-auditeur')).json();
    expect(Number(ind.tauxObjetsRattaches.valeur)).toBeGreaterThan(0);
    expect(ind.litigesOuverts.valeur).toBeGreaterThanOrEqual(0);
  });

  it('mutation foncière : garde branchée sur le moteur de dépendances (bloquante seulement si la règle l’exige)', async () => {
    const env = await setupCitoyen();
    const fiscal = env.fiscal;
    let called = 0;
    const spy = fiscal.dependencies.assertSatisfied.bind(fiscal.dependencies);
    fiscal.dependencies.assertSatisfied = ((service: string, tp: string, c: { plate?: string }) => { called++; if (service === 'MUTATION_FONCIERE') throw Object.assign(new Error('bloquée'), { statusCode: 422 }); return spy(service as never, tp, c); }) as typeof fiscal.dependencies.assertSatisfied;
    const rel = fiscal.relations.relations.find((r) => r.status === 'VALIDEE')[0]!;
    const r = await env.req('POST', `/v1/fiscal/relationships/${rel.id}/close`, 'u-controleur', { to: rel.from, reason: 'MUTATION' });
    expect(called).toBe(1);
    expect(r.statusCode).toBe(422);
    expect(fiscal.relations.relations.get(rel.id)!.status).toBe('VALIDEE');
  });
});

describe('Module 8 — cadastre : géométries versionnées, doublons, cas difficiles, couches, chaleur, couverture', () => {
  it('géométrie avec précision et source ; historique spatial ; GPS imprécis ⇒ cas ouvert ; superposition ⇒ revue, jamais fusion', async () => {
    const env = await setupCitoyen();
    const p = DEMO.parcelId;
    const o = env.app.ctx.objects.get(p);
    const sq = (dx: number): [number, number][] => [[o.lon + dx, o.lat], [o.lon + dx + 0.0003, o.lat], [o.lon + dx + 0.0003, o.lat + 0.0003], [o.lon + dx, o.lat + 0.0003]];
    const g = await env.req('POST', `/v1/citoyen/cadastre/objets/${p}/geometries`, 'u-controleur', { type: 'POLYGONE', coordonnees: sq(0), precisionM: 900, source: 'LEVE_GPS_TERRAIN', motif: 'Levé de terrain' });
    expect(g.statusCode).toBe(201);
    expect(g.json().geometrie).toMatchObject({ version: 1, type: 'POLYGONE', precisionM: 900, source: 'LEVE_GPS_TERRAIN' });
    expect((await env.req('POST', `/v1/citoyen/cadastre/objets/${p}/geometries`, 'u-controleur', { type: 'POINT', coordonnees: [[2.35, 48.85]], precisionM: 3, source: 'LEVE_GPS_TERRAIN', motif: 'Hors ville' })).json().code).toBe('HORS_KINSHASA');
    const cas = (await env.req('GET', `/v1/citoyen/cadastre/cas?commune=${encodeURIComponent(o.commune)}`, 'u-controleur')).json();
    expect(cas.some((c: { type: string; objectId: string }) => c.type === 'GPS_IMPRECIS' && c.objectId === p)).toBe(true);
    const h = (await env.req('GET', `/v1/citoyen/cadastre/objets/${p}/historique`, 'u-controleur')).json();
    expect(h.geometries).toHaveLength(1);
    const hier = (await env.req('GET', `/v1/citoyen/cadastre/objets/${DEMO.unitId}/hierarchie`, 'u-controleur')).json();
    expect(hier.ordre).toEqual(['COMMUNE', 'QUARTIER', 'AVENUE', 'PARCELLE', 'BATIMENT', 'ETAGE', 'UNITE', 'ACTIVITE']);
    expect(hier.niveaux[0].niveau).toBe('COMMUNE');
    // Une seconde parcelle au polygone chevauchant ⇒ revue.
    const other = env.app.ctx.objects.objects.find((x) => x.category === 'PARCELLE' && x.id !== p)[0]!;
    await env.req('POST', `/v1/citoyen/cadastre/objets/${other.id}/geometries`, 'u-controleur', { type: 'POLYGONE', coordonnees: sq(0.0001), precisionM: 2, source: 'IMAGERIE_SOUS_LICENCE', motif: 'Imagerie' });
    const sup = (await env.req('GET', '/v1/citoyen/cadastre/superpositions', 'u-controleur')).json();
    const rev = sup.items.find((r: { nature: string; objets: string[] }) => r.nature === 'CHEVAUCHEMENT' && r.objets.includes(p));
    expect(rev).toBeDefined();
    expect(sup.notice).toMatch(/aucune fusion/);
    const d = await env.req('POST', `/v1/citoyen/cadastre/superpositions/${rev.id}/decision`, 'u-controleur', { decision: 'DISTINCTS', motif: 'Limites vérifiées sur place' });
    expect(d.json().statut).toBe('DISTINCTS');
    expect(env.app.ctx.objects.objects.get(other.id)).toBeDefined();
    const ind = (await env.req('GET', '/v1/citoyen/cadastre/indicateurs', 'u-auditeur')).json();
    expect(ind.precisionMoyenne).toMatchObject({ valeur: '451.0', mesures: 2 });
    expect(Number(ind.couvertureGeofiscale.valeur)).toBeGreaterThanOrEqual(0);
  });

  it('cas difficiles (sans adresse, habitat informel, litige de limites) ; le cadastre ne tranche pas les droits réels', async () => {
    const env = await setupCitoyen();
    const hash = 'b'.repeat(64);
    expect((await env.req('POST', '/v1/citoyen/cadastre/cas', 'u-controleur', { type: 'SANS_ADRESSE', commune: 'Limete', note: 'Maison sans numéro' })).json().code).toBe('REPERE_REQUIS');
    const sa = await env.req('POST', '/v1/citoyen/cadastre/cas', 'u-controleur', { type: 'SANS_ADRESSE', commune: 'Limete', repere: 'Derrière l’église', photoFacadeSha256: hash, note: 'Maison sans numéro' });
    expect(sa.statusCode).toBe(201);
    const hi = (await env.req('POST', '/v1/citoyen/cadastre/cas', 'u-controleur', { type: 'HABITAT_INFORMEL', commune: 'Limete', unitesEstimees: 14, note: 'Grappe le long du ravin' })).json();
    expect(hi.grappe.unitesEstimees).toBe(14);
    expect(hi.effetFiscal).toMatch(/Aucun effet fiscal/);
    const other = env.app.ctx.objects.objects.find((x) => x.category === 'PARCELLE' && x.id !== DEMO.parcelId)[0]!;
    const li = (await env.req('POST', '/v1/citoyen/cadastre/cas', 'u-controleur', { type: 'LITIGE_LIMITES', commune: 'Limete', objectId: DEMO.parcelId, objetsVoisins: [other.id], note: 'Mur mitoyen contesté' })).json();
    expect(li.effetFiscal).toMatch(/ne tranche pas les droits réels/);
    expect((await env.req('POST', `/v1/citoyen/cadastre/cas/${sa.json().id}/decision`, 'u-controleur', { statut: 'RENVOYE_SERVICE_FONCIER', motif: 'Essai' })).json().code).toBe('RENVOI_INAPPLICABLE');
    expect((await env.req('POST', `/v1/citoyen/cadastre/cas/${li.id}/decision`, 'u-controleur', { statut: 'RENVOYE_SERVICE_FONCIER', motif: 'Renvoi au cadastre foncier' })).json().statut).toBe('RENVOYE_SERVICE_FONCIER');
  });

  it('couches : sensibles restreintes par rôle ; vue publique agrégée ; chaleur et couverture par zone et catégorie', async () => {
    const env = await setupCitoyen();
    const pub = (await env.req('GET', '/v1/public/cadastre/couches')).json();
    const ant = pub.couches.find((c: { code: string }) => c.code === 'antennes');
    expect(ant).toMatchObject({ sensible: true, restreinte: true, total: null, elements: [] });
    expect(pub.couches.every((c: { elements: unknown[] }) => c.elements.length === 0)).toBe(true);
    const agent = (await env.req('GET', '/v1/citoyen/cadastre/couches', 'u-agent-terrain')).json();
    expect(agent.couches.find((c: { code: string }) => c.code === 'antennes').restreinte).toBe(true);
    const dg = (await env.req('GET', '/v1/citoyen/cadastre/couches', 'u-dg-dgipk')).json();
    expect(dg.couches.find((c: { code: string }) => c.code === 'antennes').restreinte).toBe(false);
    expect(dg.couches.map((c: { code: string }) => c.code)).toEqual(['parcelles', 'batiments', 'etablissements', 'marches', 'stationnement', 'panneaux', 'antennes', 'ports', 'concessions', 'zones-inspection']);
    for (const ind of ['potentiel', 'conformite', 'couverture', 'recettes']) {
      const h = await env.req('GET', `/v1/citoyen/cadastre/chaleur?indicateur=${ind}`, 'u-dg-dgipk');
      expect(h.statusCode).toBe(200);
      expect(h.json().lignes.length).toBe(24);
    }
    const cov = (await env.req('GET', '/v1/citoyen/cadastre/couverture?commune=Limete', 'u-dg-dgipk')).json();
    expect(cov.parZone.length).toBeGreaterThan(0);
    expect(cov.parZone[0].parCategorie[0]).toHaveProperty('taux');
  });

  it('géométrie plane : chevauchement de polygones', () => {
    expect(polygonesSeChevauchent([[0, 0], [2, 0], [2, 2], [0, 2]], [[1, 1], [3, 1], [3, 3], [1, 3]])).toBe(true);
    expect(polygonesSeChevauchent([[0, 0], [1, 0], [1, 1], [0, 1]], [[2, 2], [3, 2], [3, 3], [2, 3]])).toBe(false);
  });
});

describe('Module 9 — retenue et IRL annuel depuis les baux vérifiés ; loyer masqué ; couverture locative', () => {
  it('bail vérifié ⇒ illustration non opposable sur la fiche v2 ; rôle non habilité ⇒ loyer et locataire masqués ; aucune dette', async () => {
    const env = await setupCitoyen();
    const lease = env.app.ctx.objects.leases.get(DEMO.leaseId)!;
    env.app.ctx.objects.leases.update({ ...lease, probativeStatus: 'VERIFIE' });
    const before = env.app.ctx.assessment.obligations.count();
    const r = (await env.req('GET', '/v1/citoyen/locatif/calcul', 'u-controleur')).json();
    const l = r.lignes.find((x: { bail: string }) => x.bail === DEMO.leaseId);
    expect(l.nature).toBe('ILLUSTRATION_NON_OPPOSABLE');
    expect(l.regle).toMatchObject({ version: 2, statut: 'A_VERIFIER' });
    const unit = env.app.ctx.objects.get(DEMO.unitId);
    const annual = Number(l.loyerAnnuel.amount);
    const retenue = unit.localityRank === 1 ? 0.2 : 0.15;
    expect(Number(l.retenue.amount)).toBeCloseTo(annual * retenue, 2);
    expect(Number(l.irlAnnuel.amount)).toBeCloseTo(annual * 0.22 - annual * retenue, 2);
    expect(env.app.ctx.assessment.obligations.count()).toBe(before);
    const masked = (await env.req('GET', `/v1/citoyen/locatif/calcul?commune=${unit.commune}`, 'u-superviseur')).json();
    expect(masked.masque).toBe(true);
    for (const x of masked.lignes) expect(x).toMatchObject({ loyer: null, locataire: null, irlAnnuel: null });
    const cov = (await env.req('GET', '/v1/citoyen/locatif/couverture?niveau=avenue', 'u-controleur')).json();
    expect(cov.niveau).toBe('avenue');
    expect(cov.lignes.length).toBeGreaterThan(0);
    const ind = (await env.req('GET', '/v1/citoyen/locatif/indicateurs', 'u-auditeur')).json();
    expect(ind.bauxEnregistres.verifies).toBeGreaterThanOrEqual(1);
    expect(ind.tauxConformite).toMatchObject({ valeur: null });
  });
});

describe('Module 10 — registre des établissements, obligations par règle, commerces sans patente, recoupement', () => {
  it('registre ; obligations sans règle ACTIVE ⇒ aucune ; détection ⇒ signaux de vérification ; visite seulement en mission', async () => {
    const env = await setupCitoyen();
    const reg = (await env.req('GET', '/v1/citoyen/activites', 'u-controleur')).json();
    expect(reg.lignes.length).toBeGreaterThan(0);
    expect(reg.notice).toMatch(/Existence d’une activité ≠ assujettissement/);
    const e = reg.lignes[0];
    expect(e.patente).toHaveProperty('active', false);
    const ob = (await env.req('GET', `/v1/citoyen/activites/${e.objectId}/obligations?periode=2026`, 'u-controleur')).json();
    expect(ob.conclusion).toMatch(/Aucune règle ACTIVE/);
    // Les établissements visibles doivent être validés pour la détection : on valide celui-ci.
    const obj = env.app.ctx.objects.get(e.objectId);
    env.app.ctx.objects.objects.update({ ...obj, status: 'VALIDE' });
    const det = (await env.req('POST', '/v1/citoyen/activites/detection', 'u-controleur')).json();
    expect(det.crees).toBeGreaterThan(0);
    const sig = det.signaux.find((s: { objectId: string }) => s.objectId === e.objectId);
    expect(sig).toMatchObject({ motif: 'SANS_PATENTE_ACTIVE', statut: 'A_VERIFIER' });
    expect(env.app.ctx.assessment.obligations.find((o) => o.objectId === e.objectId)).toHaveLength(0);
    // Pas de visite sans mission autorisée.
    expect((await env.req('POST', `/v1/citoyen/activites/signaux/${sig.id}/mission`, 'u-controleur', { missionId: 'MIS-INCONNUE' })).json().code).toBe('MISSION_INCONNUE');
    const dec = await env.req('POST', `/v1/citoyen/activites/signaux/${sig.id}/decision`, 'u-controleur', { statut: 'CONFIRME', motif: 'Commerce ouvert constaté' });
    expect(dec.json().suite).toMatch(/aucune sanction automatique/);
    // Le contribuable voit ses établissements seulement.
    const own = (await env.req('GET', '/v1/citoyen/activites', 'u-contribuable')).json();
    expect(own.lignes.every((l: { objectId: string }) => env.app.ctx.objects.get(l.objectId).taxpayerId === DEMO.taxpayerId)).toBe(true);
  });

  it('recoupement : fichier transmis (codes marchands) ⇒ rapprochés, inconnus listés, signaux ; indicateurs', async () => {
    const env = await setupCitoyen();
    const e = env.app.ctx.objects.objects.find((o) => o.category === 'ACTIVITE' && o.attributes['objectType'] === 'ETABLISSEMENT')[0]!;
    const r = await env.req('POST', '/v1/citoyen/activites/recoupements', 'u-controleur', { source: 'CODES_MARCHANDS_MM', lignes: [{ reference: e.id }, { reference: 'MM-999999', nom: 'Bar Inconnu', commune: 'Kalamu' }] });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ lignes: 2, rapproches: 1 });
    expect(r.json().inconnus).toEqual([{ reference: 'MM-999999', nom: 'Bar Inconnu', commune: 'Kalamu' }]);
    expect(r.json().protocole).toMatch(/À RACCORDER/);
    const ind = (await env.req('GET', '/v1/citoyen/indicateurs', 'u-auditeur')).json().modules[9].indicateurs;
    expect(ind.etablissementsRecenses.valeur).toBeGreaterThan(0);
    expect(ind.commercesNonEnregistresDetectes.inconnusRecoupement).toBe(1);
  });
});

describe('Module 11 — référentiel des véhicules, registre des immatriculations, liquidation par catégorie, contrôle', () => {
  it('contrôle par plaque « payée / non régularisée » journalisé ; USSD : même statut minimal ; import et rapprochement', async () => {
    const env = await setupCitoyen();
    const ctl = await env.req('GET', '/v1/citoyen/vehicules/KN-4471-BD/controle', 'u-controleur');
    expect(ctl.statusCode).toBe(200);
    expect(ctl.json()).toMatchObject({ plaque: 'KN4471BD', enregistre: true });
    expect(['PAYEE', 'NON_REGULARISEE']).toContain(ctl.json().vignette.statut);
    expect(ctl.json().notice).toMatch(/Aucune immobilisation/);
    expect(env.app.ctx.audit.list({ action: 'vehicule.plate.consulted', limit: 5 }).total).toBe(1);
    // Référentiel : propriétaire masqué pour un rôle non habilité.
    const ref = (await env.req('GET', '/v1/citoyen/vehicules?plaque=KN-4471-BD', 'u-agent-terrain')).json();
    if (ref.length) expect(ref[0].proprietaire?.id ?? null).toBeNull();
    // USSD : « Vérifier un code » avec la plaque.
    const s = (await env.req('POST', '/v1/ussd/sessions', undefined, { msisdn: '+243899000555' })).json();
    await env.req('POST', `/v1/ussd/sessions/${s.sessionId}/input`, undefined, { input: '3' });
    const v = (await env.req('POST', `/v1/ussd/sessions/${s.sessionId}/input`, undefined, { input: 'KN-4471-BD' })).json();
    expect(v.text).toMatch(/PAYÉE|NON RÉGULARISÉE/);
    expect(v.text).not.toMatch(/Mbuyi/);
    // Import du registre : rapprochés, écarts (revue), inconnus (à enrôler) — rien de créé.
    const before = env.app.ctx.objects.objects.count();
    const imp = await env.req('POST', '/v1/citoyen/vehicules/immatriculations', 'u-controleur', { source: 'Fichier DGI/Transports (démo)', lignes: [{ plaque: 'KN-4471-BD', usage: 'Taxi' }, { plaque: 'KN-0001-AA', categorie: 'VOITURE' }] });
    expect(imp.statusCode).toBe(201);
    expect(imp.json().rapproches).toHaveLength(1);
    expect(imp.json().ecarts[0]).toMatchObject({ champ: 'usage', registre: 'Taxi', statut: 'A_REVOIR' });
    expect(imp.json().inconnus).toEqual([{ plaque: 'KN0001AA', categorie: 'VOITURE' }]);
    expect(env.app.ctx.objects.objects.count()).toBe(before);
    const gap = await env.req('POST', `/v1/citoyen/vehicules/immatriculations/${imp.json().id}/ecarts`, 'u-controleur', { plaque: 'KN-4471-BD', champ: 'usage', retenu: 'MOSOLO_RETENU', motif: 'Carte grise vérifiée' });
    expect(gap.json().statut).toBe('MOSOLO_RETENU');
  });

  it('liquidation par catégorie et exercice : refus sans règle ACTIVE ; règle VIG-<catégorie> ACTIVE ⇒ une obligation par véhicule, sans doublon', async () => {
    const env = await setupCitoyen();
    const veh = env.svc.vehicules.parPlaque('KN-4471-BD')!;
    env.app.ctx.objects.objects.update({ ...veh, attributes: { ...veh.attributes, categorie: 'MINIBUS' } });
    const no = await env.req('POST', '/v1/citoyen/vehicules/liquidations', 'u-controleur', { categorie: 'MINIBUS', exercice: '2026' });
    expect(no.json().code).toBe('REGLE_NON_PUBLIEE');
    const pub = await publishCertifiedRule(env, { code: 'VIG-MINIBUS', label: 'Vignette — minibus (règle de test)', baseDefinition: 'Forfait par véhicule', formula: 'forfait', rateTable: { forfait: '40' } });
    expect(pub.responses.at(-1)!.statusCode).toBeLessThan(300);
    const ok = await env.req('POST', '/v1/citoyen/vehicules/liquidations', 'u-controleur', { categorie: 'MINIBUS', exercice: '2026' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().liquidees).toHaveLength(1);
    const again = await env.req('POST', '/v1/citoyen/vehicules/liquidations', 'u-controleur', { categorie: 'MINIBUS', exercice: '2026' });
    expect(again.json()).toMatchObject({ liquidees: [], dejaLiquidees: ['KN4471BD'] });
    expect((await env.req('POST', '/v1/citoyen/vehicules/liquidations', 'u-agent-terrain', { categorie: 'MINIBUS', exercice: '2026' })).statusCode).toBe(403);
  });

  it('mutation : vérification par le moteur de dépendances journalisée ; indicateur bloquées puis régularisées', async () => {
    const env = await setupCitoyen();
    const r = await env.req('POST', '/v1/citoyen/vehicules/KN-4471-BD/mutation-verification', 'u-controleur');
    expect(r.statusCode).toBe(200);
    expect(r.json().service).toBe('MUTATION_VEHICULE');
    const checks = env.fiscal.dependencies.checks.find((c) => c.service === 'MUTATION_VEHICULE');
    expect(checks).toHaveLength(1);
    // Simulation d'un blocage puis d'une régularisation (checks réels du moteur).
    env.fiscal.dependencies.checks.append({ id: 'CHK-X1', at: '2026-09-26T09:05:00.000Z', service: 'MUTATION_VEHICULE', taxpayerId: 'TP-X', blocked: true, actorId: 'u-controleur' });
    env.fiscal.dependencies.checks.append({ id: 'CHK-X2', at: '2026-09-26T10:05:00.000Z', service: 'MUTATION_VEHICULE', taxpayerId: 'TP-X', blocked: false, actorId: 'u-controleur' });
    const ind = env.svc.vehicules.indicateurs();
    expect(ind.mutationsBloqueesPuisRegularisees).toMatchObject({ bloquees: 1, regularisees: 1, valeur: '100.0' });
    expect(ind.couvertureParc.denominateur).toBeGreaterThan(0);
  });
});

describe('Module 12 — autorisations de transport : règle publiée, zones, horaires, carte conducteur, suspension motivée', () => {
  async function trp(env: Env) {
    const c = env.vx.cases.find((x) => x.vertical === 'mobilite' && x.type === 'DEMANDE_AUTORISATION_TRANSPORT')[0]!;
    env.vx.take(user(env, 'u-controleur'), c.id);
    env.vx.propose(user(env, 'u-controleur'), c.id, { outcome: 'ACCEPTER', reason: 'Dossier complet (test)' });
    const d = env.vx.decide(user(env, 'u-fiscal-chef-service'), c.id, { decision: 'ACCEPTE', reason: 'Conforme (test)' });
    expect(d.certificateCode).toBeDefined();
    return d.certificateCode!;
  }

  it('sans règle ACTIVE : autorisation enregistrée NON OPPOSABLE (grise au contrôle), activation refusée ; avec règle : active', async () => {
    const env = await setupCitoyen();
    const code = await trp(env);
    const a = await env.req('POST', '/v1/citoyen/transport/autorisations', 'u-controleur', { certificatCode: code, categorie: 'MINIBUS', plaque: 'KN-4471-BD', zones: ['Kalamu', 'Kintambo'], corridor: 'Victoire – Kintambo', horaires: { debut: '05:00', fin: '22:00' } });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ statut: 'EN_ATTENTE_REGLE', opposable: false });
    expect((await env.req('POST', '/v1/citoyen/transport/autorisations', 'u-controleur', { certificatCode: code, categorie: 'MINIBUS', plaque: 'KN-4471-BD', zones: [], horaires: { debut: '05:00', fin: '22:00' } })).json().code).toBe('DEJA_ENREGISTREE');
    const ctl = (await env.req('POST', '/v1/citoyen/transport/controles', 'u-controleur', { plaque: 'KN-4471-BD', commune: 'Kalamu' })).json();
    expect(ctl.couleur).toBe('GRIS');
    expect((await env.req('POST', `/v1/citoyen/transport/autorisations/${a.json().id}/activation`, 'u-controleur')).json().code).toBe('REGLE_NON_PUBLIEE');
    await publishCertifiedRule(env, { code: 'LIC-BUS', label: 'Licence bus et minibus (règle de test)', baseDefinition: 'Forfait', formula: 'forfait', rateTable: { forfait: '100' } });
    const act = await env.req('POST', `/v1/citoyen/transport/autorisations/${a.json().id}/activation`, 'u-controleur');
    expect(act.json()).toMatchObject({ statut: 'ACTIVE', opposable: true, regle: { code: 'LIC-BUS' } });
    // Zone et horaire évalués à l'heure du serveur (09:00 UTC = 10:00 Kinshasa).
    expect((await env.req('POST', '/v1/citoyen/transport/controles', 'u-controleur', { plaque: 'KN-4471-BD', commune: 'Kalamu' })).json().couleur).not.toBe('ROUGE');
    const hz = (await env.req('POST', '/v1/citoyen/transport/controles', 'u-controleur', { plaque: 'KN-4471-BD', commune: 'Gombe' })).json();
    expect(hz).toMatchObject({ couleur: 'ROUGE', dansZone: false });
    env.clock.set(new Date('2026-09-26T22:30:00.000Z'));
    expect((await env.req('POST', '/v1/citoyen/transport/controles', 'u-controleur', { plaque: 'KN-4471-BD', commune: 'Kalamu' })).json()).toMatchObject({ couleur: 'ROUGE', dansHoraire: false });
  });

  it('carte conducteur rattachée (QR signé, vérification publique minimale) ; suspension par décision motivée à deux personnes', async () => {
    const env = await setupCitoyen();
    const code = await trp(env);
    await publishCertifiedRule(env, { code: 'LIC-BUS', label: 'Licence bus (test)', baseDefinition: 'Forfait', formula: 'forfait', rateTable: { forfait: '100' } });
    const a = (await env.req('POST', '/v1/citoyen/transport/autorisations', 'u-controleur', { certificatCode: code, categorie: 'BUS', plaque: 'KN-4471-BD', zones: [], horaires: { debut: '00:00', fin: '23:59' } })).json();
    expect(a.statut).toBe('ACTIVE');
    const card = (await env.req('POST', `/v1/citoyen/transport/autorisations/${a.id}/cartes`, 'u-controleur', { conducteurTaxpayerId: DEMO.tenantTaxpayerId, permisRef: 'PC-123456' })).json();
    expect(card.qr).toMatch(/^MOSOLO-CCD\|CCD-/);
    const pubv = (await env.req('GET', `/v1/public/transport/cartes/${card.numero}`)).json();
    expect(pubv).toMatchObject({ authentique: true, valide: true });
    expect(JSON.stringify(pubv)).not.toMatch(/PC-123456|Nzuzi/);
    const byQr = (await env.req('POST', '/v1/citoyen/transport/controles', 'u-controleur', { qr: card.qr, commune: 'Kalamu' })).json();
    expect(byQr.carte).toMatchObject({ numero: card.numero, valide: true });
    expect((await env.req('POST', '/v1/citoyen/transport/controles', 'u-controleur', { qr: card.qr.replace(/\|[^|]+$/, '|faux'), commune: 'Kalamu' })).statusCode).toBe(403);
    // Suspension : proposition motivée puis approbation par une autre personne.
    const p = await env.req('POST', `/v1/citoyen/transport/autorisations/${a.id}/suspension`, 'u-controleur', { action: 'SUSPENDRE', motif: 'Défaut d’assurance constaté', decisionRef: 'DEC-TR-2026-001' });
    expect(p.statusCode).toBe(200);
    expect((await env.req('POST', `/v1/citoyen/transport/autorisations/${a.id}/suspension/decision`, 'u-controleur', { approuver: true, motif: 'Auto-approbation' })).statusCode).toBe(403);
    const ok = await env.req('POST', `/v1/citoyen/transport/autorisations/${a.id}/suspension/decision`, 'u-dg-dgipk', { approuver: true, motif: 'Décision motivée confirmée' });
    expect(ok.json().statut).toBe('SUSPENDUE');
    expect((await env.req('POST', '/v1/citoyen/transport/controles', 'u-controleur', { plaque: 'KN-4471-BD', commune: 'Kalamu' })).json().couleur).toBe('ROUGE');
    const ind = (await env.req('GET', '/v1/citoyen/transport/indicateurs', 'u-auditeur')).json();
    expect(ind.autorisationsActives.suspendues).toBe(1);
    expect(ind.tauxConformiteControles.denominateur).toBeGreaterThan(0);
  });

  it('renouvellement : rappel ambre unique avant l’échéance ; demande de renouvellement depuis l’application', async () => {
    const env = await setupCitoyen();
    const code = await trp(env);
    const a = (await env.req('POST', '/v1/citoyen/transport/autorisations', 'u-controleur', { certificatCode: code, categorie: 'MINIBUS', plaque: 'KN-4471-BD', zones: [], horaires: { debut: '00:00', fin: '23:59' } })).json();
    await publishCertifiedRule(env, { code: 'LIC-BUS', label: 'Licence bus (test)', baseDefinition: 'Forfait', formula: 'forfait', rateTable: { forfait: '100' } });
    await env.req('POST', `/v1/citoyen/transport/autorisations/${a.id}/activation`, 'u-controleur');
    const until = new Date(`${env.svc.transport.get(a.id).validUntil.slice(0, 10)}T12:00:00.000Z`);
    env.clock.set(new Date(until.getTime() - 3 * 86_400_000));
    expect((await env.req('POST', '/v1/citoyen/transport/rappels', 'u-controleur')).json().rappels).toBe(1);
    expect((await env.req('POST', '/v1/citoyen/transport/rappels', 'u-controleur')).json().rappels).toBe(0);
    const ren = await env.req('POST', `/v1/citoyen/transport/autorisations/${a.id}/renouvellement`, 'u-contribuable');
    expect(ren.statusCode).toBe(201);
    expect(ren.json().notice).toMatch(/décision motivée/);
    // Le contribuable voit ses autorisations.
    expect((await env.req('GET', '/v1/citoyen/transport/autorisations', 'u-contribuable')).json().length).toBe(1);
  });
});


describe('Module 1 — journalisation et notification des modifications d’identité ; données masquées selon le rôle', () => {
  it('changement de téléphone : audit avant/après masqué, ancien et nouveau numéros notifiés', async () => {
    const env = await setupCitoyen();
    const before = env.app.ctx.comms.deliveries.count();
    env.app.ctx.taxpayers.changePhone(DEMO.tenantTaxpayerId, '+243899001122', { kind: 'user', id: 'u-guichet', roles: ['R12'] }, 'Récupération au guichet');
    const rec = env.app.ctx.audit.list({ action: 'account.contact.changed', limit: 5 }).items.at(-1)!;
    expect(rec.details).toMatchObject({ channel: 'TELEPHONE', newMasked: expect.not.stringContaining('899001122') });
    const sent = env.app.ctx.comms.deliveries.all().slice(before).filter((d) => d.eventCode === 'account.contact.changed');
    expect(sent.length).toBeGreaterThanOrEqual(2);
  });

  it('dossier consulté par un agent au périmètre minimal : téléphone masqué, consultation journalisée', async () => {
    const env = await setupCitoyen();
    const r = await env.req('GET', `/v1/taxpayers/${DEMO.taxpayerId}`, 'u-agent-terrain');
    if (r.statusCode === 200) {
      expect(r.json().taxpayer.phone).not.toBe('+243810000001');
      expect(env.app.ctx.audit.list({ action: 'taxpayer.viewed', limit: 5 }).total).toBeGreaterThan(0);
    } else expect(r.statusCode).toBe(403);
  });
});

describe('Module 2 — contrôle des pièces : cohérence, MRZ, score de confiance, rapprochements, revue humaine', () => {
  it('chiffres de contrôle OACI 9303 et proximité des noms', () => {
    expect(chiffreControleMrz('L898902C3')).toBe(6);
    const m = lireMrzTd3('L898902C36UTO7408122F1204159ZE184226B<<<<<10')!;
    expect(m).toMatchObject({ numero: 'L898902C3', numeroOk: true, naissanceOk: true, expirationOk: true });
    expect(proximiteNoms('KALALA Mbuyi', 'Mbuyi Kalala')).toBe(1);
  });

  it('pièce cohérente ⇒ score élevé, preuve déclarée au registre ; même pièce sur un autre compte ⇒ cas à risque et rapprochement', async () => {
    const env = await setupCitoyen();
    const hash = 'c'.repeat(64);
    const ok = await env.req('POST', '/v1/citoyen/enrolement/pieces', 'u-guichet', { type: 'CARTE_IDENTITE', numero: 'CD1234567', nomDeclare: 'Mbuyi Kalala', taxpayerId: DEMO.taxpayerId, photoSha256: hash, dateExpiration: '2030-01-01', lectureAuto: { nom: 'KALALA MBUYI', numero: 'CD1234567' } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ statut: 'CONFORME', revueHumaine: false, canal: 'GUICHET' });
    expect(ok.json().score).toBeGreaterThanOrEqual(ok.json().seuil.valeur);
    expect(ok.json().proofId).toBeDefined();
    expect(ok.json().seuil.statut).toBe('PAR_DEFAUT_A_CONFIRMER');
    // Même numéro présenté pour un autre compte : rapprochement proposé, aucune fusion.
    const dup = await env.req('POST', '/v1/citoyen/enrolement/pieces', 'u-guichet', { type: 'CARTE_IDENTITE', numero: 'CD-1234567', nomDeclare: 'Nzuzi Makiese', taxpayerId: DEMO.tenantTaxpayerId, photoSha256: hash, dateExpiration: '2030-01-01' });
    expect(dup.json()).toMatchObject({ statut: 'A_REVOIR', revueHumaine: true });
    expect(dup.json().rapprochements[0]).toMatchObject({ taxpayerId: DEMO.taxpayerId, motifs: ['MEME_PIECE'] });
    expect(env.app.ctx.taxpayers.get(DEMO.tenantTaxpayerId).status).not.toBe('FUSIONNE');
    // Pièce expirée (heure serveur) : score abaissé, revue humaine.
    const exp = (await env.req('POST', '/v1/citoyen/enrolement/pieces', 'u-guichet', { type: 'PASSEPORT', numero: 'L898902C3', nomDeclare: 'Anna Eriksson', lectureAuto: { mrzLigne2: 'L898902C36UTO7408122F1204159ZE184226B<<<<<10' } })).json();
    expect(exp.facteurs.find((f: { code: string }) => f.code === 'expiration').points).toBe(0);
    expect(exp.facteurs.find((f: { code: string }) => f.code === 'mrz').points).toBe(exp.facteurs.find((f: { code: string }) => f.code === 'mrz').max);
    expect(exp.revueHumaine).toBe(true);
    // Revue humaine : liste des cas à risque, décision motivée.
    const rv = (await env.req('GET', '/v1/citoyen/enrolement/pieces/revues', 'u-superviseur')).json();
    expect(rv.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([dup.json().id, exp.id]));
    const d = await env.req('POST', `/v1/citoyen/enrolement/pieces/${exp.id}/decision`, 'u-superviseur', { decision: 'COMPLEMENT_DEMANDE', motif: 'Passeport expiré : pièce valide requise' });
    expect(d.json().statut).toBe('COMPLEMENT_DEMANDE');
    // Un contribuable ne contrôle que ses propres pièces.
    expect((await env.req('POST', '/v1/citoyen/enrolement/pieces', 'u-contribuable', { type: 'NIF', numero: 'A1234567B', nomDeclare: 'Nzuzi Makiese', taxpayerId: DEMO.tenantTaxpayerId })).statusCode).toBe(403);
  });
});

describe('Module 3 — attestation de situation signée, vérification publique minimale', () => {
  it('le contribuable obtient son attestation ; un tiers vérifie l’authenticité sans données détaillées ; aucune donnée de tiers', async () => {
    const env = await setupCitoyen();
    const a = await env.req('POST', '/v1/citoyen/situation/attestations', 'u-contribuable', {});
    expect(a.statusCode).toBe(201);
    const att = a.json();
    expect(att.numero).toMatch(/^ASI-2026-/);
    expect(att.objets.length).toBeGreaterThan(0);
    expect(att.obligations.total).toBeGreaterThan(0);
    expect(att.notice).toMatch(/ce n’est pas un quitus/);
    const v = (await env.req('GET', att.verification)).json();
    expect(v).toMatchObject({ authentique: true, numero: att.numero });
    expect(JSON.stringify(v)).not.toMatch(/Mbuyi|OBJ-DEMO/);
    expect((await env.req('GET', `/v1/public/attestations-situation/${att.numero}?sig=faux`)).json().authentique).toBe(false);
    // Aucune attestation pour autrui.
    expect((await env.req('POST', '/v1/citoyen/situation/attestations', 'u-contribuable', { taxpayerId: DEMO.tenantTaxpayerId })).statusCode).toBe(403);
  });
});

describe('Module 6 — quittance par SMS : numéro et code de vérification, moins de 160 caractères', () => {
  it('le SMS de quittance porte le numéro et le code ; aucun lien', () => {
    const ev = getEvent('receipt.issued_provisional')!;
    const t = smsText(renderText(ev, { reference: 'Q-2026-KIN-000123-X', numero: 'Q-2026-KIN-000123-X', code: 'Q26KIN000123X' }));
    expect(t).toContain('Q-2026-KIN-000123-X');
    expect(t).toContain('Code de vérification Q26KIN000123X');
    expect(t.length).toBeLessThanOrEqual(160);
    expect(t).not.toMatch(/\{\{|http/);
  });
});

describe('Module 11 — mutation de véhicule : condition de quitus sur la démarche (informative puis bloquante)', () => {
  it('la déclaration de mutation porte la condition « quitus valide » du moteur de dépendances', async () => {
    const env = await setupCitoyen();
    const veh = env.svc.vehicules.parPlaque('KN-4471-BD')!;
    const c = env.vx.submitCase(user(env, 'u-contribuable'), 'mobilite', { type: 'DECLARATION_MUTATION', objectId: veh.id, details: { nouveauProprietaire: 'Nzuzi Makiese', dateMutation: '2026-09-20' }, documents: [{ label: 'Acte de cession', sha256: 'd'.repeat(64) }] });
    const conds = env.vx.conditionsFor(env.vx.getCase(c.id));
    const q = conds.find((x) => x.code === 'DEPENDANCE_QUITUS_VALIDE');
    expect(q).toBeDefined();
    expect(q!.label).toMatch(/informatif/);
    expect(q!.met).toBe(true);
    // Règle rendue bloquante (acte publié) : la condition doit être remplie.
    const dep = env.fiscal.dependencies.dependencies.find((d) => d.service === 'MUTATION_VEHICULE' && d.status === 'EN_VIGUEUR')[0]!;
    env.fiscal.dependencies.dependencies.update({ ...dep, mode: 'BLOQUANT' });
    const after = env.vx.conditionsFor(env.vx.getCase(c.id)).find((x) => x.code === 'DEPENDANCE_QUITUS_VALIDE')!;
    expect(after.label).toMatch(/condition obligatoire/);
  });
});
