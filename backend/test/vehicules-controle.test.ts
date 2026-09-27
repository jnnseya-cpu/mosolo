import { randomUUID } from 'node:crypto';
import { normalizePlate } from '@mosolo/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { sha256Hex } from '../src/core/crypto.js';
import { evaluate } from '../src/core/policy.js';
import { accesPlugin } from '../src/plugins/acces/plugin.js';
import { fiscalPlugin } from '../src/plugins/fiscal/plugin.js';
import { CIRCUITS } from '../src/plugins/integrite/gouvernance/circuits.js';
import { ALL_PARAMETERS } from '../src/plugins/integrite/gouvernance/parametres.js';
import { titresPlugin } from '../src/plugins/titres/plugin.js';
import type { TitresService } from '../src/plugins/titres/service.js';
import { CT_POINTS, REVENUE_LINES } from '../src/plugins/vehicules-controle/model.js';
import { vehiculesControlePlugin } from '../src/plugins/vehicules-controle/plugin.js';
import { demoJpeg, VC_DEMO } from '../src/plugins/vehicules-controle/seed.js';
import type { VehiculesControleService } from '../src/plugins/vehicules-controle/service.js';
import { callbackBody, DEMO, PROVIDER_SECRET, publishCertifiedRule, signedCallback, type TestEnv } from './helpers.js';

const U = VC_DEMO.users;

async function setupVc(): Promise<TestEnv & { svc: VehiculesControleService }> {
  const clock = new ManualClock('2026-09-27T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} },
    plugins: [accesPlugin, fiscalPlugin, titresPlugin, vehiculesControlePlugin],
  });
  await app.ready();
  return {
    app, clock, svc: app.ctx.ext['vehicules-controle'] as VehiculesControleService,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
}

const allOk = () => Object.fromEntries(CT_POINTS.map((k) => [k, { conforme: true }]));
const iso = (env: TestEnv, minutesAgo: number) => new Date(env.clock.now().getTime() - minutesAgo * 60_000).toISOString();
const pv = (env: TestEnv, plate: string, extra: Record<string, unknown> = {}) => ({
  centreId: VC_DEMO.centres.ct1, plate, category: 'PARTICULIER', inspecteur: 'INSP-T-01', startedAt: iso(env, 40), endedAt: iso(env, 5), points: allOk(), result: 'FAVORABLE', echeance: '2027-03-01', ...extra,
});
let photoSeq = 0;
const photos = (slots: string[]) => slots.map((slot) => ({ slot, ...demoJpeg(`test-${++photoSeq}-${slot}`) }));
const FIVE = ['AVANT', 'ARRIERE', 'GAUCHE', 'DROITE', 'INTERIEUR'];

describe('Chaîne véhicule — référentiel, entité RFCK et numérotation', () => {
  it('modules 82 à 84 avec la note du catalogue du maître d’ouvrage, dix points de l’arrêté, six lignes de recettes', async () => {
    const env = await setupVc();
    const r = (await env.req('GET', '/v1/vehicules/referentiel', U.chef)).json();
    expect(r.modules.map((m: { numero: number }) => m.numero)).toEqual([82, 83, 84]);
    expect(r.modules.map((m: { numeroMaitreOuvrage: number }) => m.numeroMaitreOuvrage)).toEqual([59, 60, 61]);
    expect(r.modules[0].note).toBe('n° 59–61 dans le catalogue du maître d’ouvrage du 27/09/2026');
    expect(r.numerotation.aArbitrer).toMatch(/quitus fiscal/);
    expect(r.points).toHaveLength(10);
    expect(r.revenueLines).toHaveLength(6);
    expect(r.flows).toHaveLength(10);
    expect(r.integrationSteps).toHaveLength(7);
    expect(r.phases2026.every((p: { label: string }) => p.label.includes('[EXEMPLE]'))).toBe(true);
    // Texte A_VERIFIER, entité RFCK (tutelle Transports) et fiches de modules au registre d'accès.
    expect(env.app.ctx.rules.instruments.get('INS-ARRETE-CT-2025-11-12')?.status).toBe('A_VERIFIER');
    const acces = env.app.ctx.ext['acces'] as { entities: { get(id: string): { parentId: string } | undefined }; modules: { get(id: string): { label: string } | undefined } };
    expect(acces.entities.get('RFCK')?.parentId).toBe('MIN-TRANSPORTS');
    expect(acces.modules.get('MOD-VC-83')?.label).toContain('n° 59–61');
    // Fiches de frais A_VERIFIER, sans taux.
    const g = env.app.ctx.rules.list().find((x) => x.code === 'RFCK-FRAIS-GARDIENNAGE')!;
    expect(g.status).toBe('A_VERIFIER');
    expect(g.rateTable).toEqual({});
  });

  it('aucun contact semé ; contacts modifiables par l’administrateur de l’entité seulement', async () => {
    const env = await setupVc();
    expect((await env.req('GET', '/v1/rfck/entite', U.chef)).json().contacts).toMatchObject({ adresse: '', telephone: '', courriel: '' });
    expect((await env.req('POST', '/v1/rfck/entite/contacts', U.chef, { adresse: 'x' })).statusCode).toBe(403);
    const ok = await env.req('POST', '/v1/rfck/entite/contacts', U.admin, { adresse: 'Adresse de test' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().updatedBy).toBe(U.admin);
  });
});

describe('Procès-verbal structuré et vignettes sécurisées', () => {
  it('PV complet transmis par le centre ; point manquant, transmission tardive, autre centre et agent RFCK refusés', async () => {
    const env = await setupVc();
    const ok = await env.req('POST', '/v1/vehicules/controles-techniques', U.centre1, pv(env, 'KN-5555-AB'));
    expect(ok.statusCode).toBe(201);
    expect(Object.keys(ok.json().points)).toHaveLength(10);
    const { PNEUMATIQUES: _p, ...incomplete } = allOk();
    const missing = await env.req('POST', '/v1/vehicules/controles-techniques', U.centre1, pv(env, 'KN-5555-AC', { points: incomplete }));
    expect(missing.statusCode).toBe(422);
    expect(missing.json().code).toBe('PV_INCOMPLET');
    const late = await env.req('POST', '/v1/vehicules/controles-techniques', U.centre1, pv(env, 'KN-5555-AD', { startedAt: iso(env, 300), endedAt: iso(env, 240) }));
    expect(late.json().code).toBe('PV_TRANSMISSION_TARDIVE');
    expect((await env.req('POST', '/v1/vehicules/controles-techniques', U.centre2, pv(env, 'KN-5555-AE'))).json().code).toBe('HORS_CENTRE');
    expect((await env.req('POST', '/v1/vehicules/controles-techniques', U.chef, pv(env, 'KN-5555-AF'))).statusCode).toBe(403);
  });

  it('quota de stock, attribution sur PV favorable, doublon refusé, vérification publique (faux par construction, domaine)', async () => {
    const env = await setupVc();
    expect((await env.req('POST', '/v1/vehicules/vignettes-securisees/lots', U.chef, { centreId: VC_DEMO.centres.ct1, quantity: 1000 })).json().code).toBe('QUOTA_STOCK_DEPASSE');
    const p = (await env.req('POST', '/v1/vehicules/controles-techniques', U.centre1, pv(env, 'KN-6666-AB'))).json();
    const stock = (await env.req('GET', '/v1/vehicules/vignettes-securisees', U.centre1)).json().items.filter((s: { status: string }) => s.status === 'EN_STOCK');
    const num = stock[0].number as string;
    const a = await env.req('POST', `/v1/vehicules/vignettes-securisees/${num}/attribution`, U.centre1, { pvId: p.id });
    expect(a.statusCode).toBe(200);
    expect(a.json().qr).toBe(`https://verification.exemple.cd/v/ct/${num}`);
    const dup = await env.req('POST', `/v1/vehicules/vignettes-securisees/${num}/attribution`, U.centre1, { pvId: p.id });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('VIGNETTE_DEJA_UTILISEE');
    const good = (await env.req('GET', `/v1/public/vehicules/vignettes/${num}`)).json();
    expect(good).toMatchObject({ authentic: true, state: 'A_JOUR' });
    expect(JSON.stringify(good)).not.toContain('KN-6666-AB');
    expect((await env.req('GET', '/v1/public/vehicules/vignettes/VTS-2026-99999990')).json()).toMatchObject({ found: false, state: 'NON_AUTHENTIQUE' });
    const foreign = (await env.req('GET', `/v1/public/vehicules/vignettes/verifier?qr=${encodeURIComponent(`https://verification-exemple.co/v/ct/${num}`)}`)).json();
    expect(foreign.state).toBe('DOMAINE_NON_OFFICIEL');
    expect(env.app.ctx.alerts.list().some((x) => x.type === 'QR_DOMAINE_NON_OFFICIEL')).toBe(true);
  });

  it('centre suspendu par décision motivée : aucun PV ni vignette, propagation à la liste de révocation ; jamais de suspension automatique', async () => {
    const env = await setupVc();
    // L'analytique lève des alertes mais ne suspend rien.
    const an = await env.req('POST', '/v1/centres-agrees/analytique/alertes', U.chef);
    expect(an.statusCode).toBe(200);
    expect(env.svc.centres.get(VC_DEMO.centres.ct1).status).toBe('AGREE');
    expect((await env.req('POST', `/v1/centres-agrees/${VC_DEMO.centres.ct1}/suspension`, U.chef, { motif: 'Tentative', legalRef: 'Réf. test' })).statusCode).toBe(403);
    const s = await env.req('POST', `/v1/centres-agrees/${VC_DEMO.centres.ct1}/suspension`, U.dg, { motif: 'Stock non déclaré constaté', legalRef: 'Convention d’agrément, art. 5 [EXEMPLE]' });
    expect(s.statusCode).toBe(200);
    const refused = await env.req('POST', '/v1/vehicules/controles-techniques', U.centre1, pv(env, 'KN-7777-AB'));
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('CENTRE_SUSPENDU');
    const num = env.svc.ct.stickers.find((x) => x.centreId === VC_DEMO.centres.ct1 && x.status === 'EN_STOCK')[0]!.number;
    expect((await env.req('POST', `/v1/vehicules/vignettes-securisees/${num}/attribution`, U.centre1, { pvId: 'PV-INCONNU' })).json().code).toBe('CENTRE_SUSPENDU');
    const rl = (await env.req('GET', '/v1/vehicules/vignettes-securisees/revocations', U.controleur)).json();
    expect(rl.suspendedCentres.map((c: { id: string }) => c.id)).toContain(VC_DEMO.centres.ct1);
    expect(rl.signature).toBeTruthy();
    expect((await env.req('GET', `/v1/public/centres-agrees/AGR-${VC_DEMO.centres.ct1}`)).json().state).toBe('SUSPENDU');
    expect((await env.req('GET', '/v1/public/centres-agrees/AGR-INCONNU')).json().state).toBe('NON_AGREE');
    // Rétablissement à deux personnes (circuit CENTRE_RETABLISSEMENT).
    await env.req('POST', `/v1/centres-agrees/${VC_DEMO.centres.ct1}/retablissement-demande`, U.chef, { motif: 'Stock régularisé' });
    expect((await env.req('POST', `/v1/centres-agrees/${VC_DEMO.centres.ct1}/retablissement-decision`, U.dg, { approve: true, motif: 'Vérifié' })).json().status).toBe('AGREE');
  });

  it('agrément à deux personnes (circuit CENTRE_AGREMENT) ; diligence non satisfaite ⇒ pas de proposition', async () => {
    const env = await setupVc();
    expect(CIRCUITS.some((c) => c.code === 'CENTRE_AGREMENT')).toBe(true);
    const inv = (await env.req('POST', '/v1/centres-agrees/invitations', U.chef, { kind: 'CONTROLE_TECHNIQUE', name: 'Centre test [EXEMPLE]', commune: 'Kalamu', lat: -4.34, lon: 15.31, categories: ['PARTICULIER'], activities: ['CONTROLE_TECHNIQUE'], declaredHours: { open: '08:00', close: '17:00' } })).json();
    const id = inv.centre.id as string;
    env.app.ctx.users.add({ id: 'vc-u-centre-test', name: 'Centre test', roles: ['R34'], entity: id });
    expect((await env.req('POST', `/v1/centres-agrees/${id}/dossier`, 'vc-u-centre-test', { invitationCode: 'mauvais', legalExistence: 'RCCM', quitusRef: 'Q-01', conflictDeclaration: 'Aucun', linksWithOfficials: 'Aucun' })).json().code).toBe('INVITATION_INVALIDE');
    await env.req('POST', `/v1/centres-agrees/${id}/dossier`, 'vc-u-centre-test', { invitationCode: inv.invitationCode, legalExistence: 'RCCM', quitusRef: 'Q-01', conflictDeclaration: 'Aucun', linksWithOfficials: 'Aucun' });
    await env.req('POST', `/v1/centres-agrees/${id}/diligences`, U.chef, { checks: [{ code: 'QUITUS', label: 'Quitus', ok: false }] });
    expect((await env.req('POST', `/v1/centres-agrees/${id}/proposition`, U.chef, { motif: 'x'.repeat(5), habilitation: { from: '2026-09-01', to: '2027-09-01' }, quotas: { stockVignettes: 10, inspectionsParJour: 10 } })).json().code).toBe('DILIGENCES_NON_SATISFAITES');
    expect((await env.req('POST', `/v1/centres-agrees/${id}/decision`, U.chef, { approve: true, motif: 'moi-même' })).statusCode).toBe(403);
  });
});

describe('Scan unique — vue hiérarchique, deux vignettes distinctes, mode courtoisie, hors ligne', () => {
  it('vignette fiscale payée et contrôle technique défavorable restent deux lignes distinctes (jamais agrégées)', async () => {
    const env = await setupVc();
    const titres = env.app.ctx.ext['titres'] as TitresService;
    const now = env.clock.now().toISOString();
    titres.credentials.insert({
      id: 'CRED-TEST-VIG', number: 'VIG-TEST-0001', shortCode: 'VIGT01', typeCode: 'VIG-ANNUELLE', typeVersion: 1, module: '11', entity: 'DGIPK', model: 'ANNUEL_EXERCICE', payerTaxpayerId: DEMO.taxpayerId,
      subject: { plate: VC_DEMO.plates.echu }, place: { label: 'Kinshasa' }, attribution: { commune: 'Gombe' } as never, validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2026-12-31T22:59:59.000Z',
      toleranceMinutes: 0, amberMinutes: 43200, state: 'EMIS', receiptIds: ['R-1'], receiptNumbers: ['Q-TEST-0001'], staticToken: 'x', issuedAt: now, demo: true,
    } as never);
    const r = await env.req('POST', '/v1/vehicules/scan', U.controleur, { saisie: VC_DEMO.plates.echu, place: { commune: 'Gombe', lat: -4.3, lon: 15.3 } });
    expect(r.statusCode).toBe(200);
    const v = r.json();
    expect(v.vignetteFiscale.state).toBe('PAYEE');
    expect(v.vignetteFiscale.receipt).toBe('Q-TEST-0001');
    expect(v.controleTechnique.state).toBe('DEFAVORABLE');
    expect(v.taxeCirculation.state).toBe('AUCUNE');
    expect(v).not.toHaveProperty('vignettePayee');
    expect(v).not.toHaveProperty('statutVignette');
    expect(v.displayOnly).toBe(true);
    expect(v.sanction).toBe('AUCUNE');
    expect(Object.keys(v)).toEqual(expect.arrayContaining(['identification', 'vignetteFiscale', 'taxeCirculation', 'controleTechnique', 'autorisationTransport', 'fourriere', 'quitus']));
    // Six lignes de recettes, chacune distincte.
    const lines = (await env.req('GET', `/v1/vehicules/${VC_DEMO.plates.echu}/lignes-de-recettes`, U.chef)).json().lines;
    expect(lines.map((l: { code: string }) => l.code)).toEqual(REVENUE_LINES.map((l) => l.code));
    expect(lines.find((l: { code: string }) => l.code === 'VIGNETTE_FISCALE').state).toBe('PAYEE');
    expect(lines.find((l: { code: string }) => l.code === 'REDEVANCE_CT').state).toBe('ACTE_REQUIS');
    // Décision de l'agent enregistrée (identité, position, horodatage).
    const d = await env.req('POST', `/v1/vehicules/scans/${v.scanId}/decision`, U.controleur, { decision: 'INFORMATION_USAGER', motif: 'Contre-visite conseillée', position: { lat: -4.3, lon: 15.3 } });
    expect(d.statusCode).toBe(201);
    expect(d.json()).toMatchObject({ agentId: U.controleur, position: { lat: -4.3 } });
    expect((await env.req('POST', `/v1/vehicules/scans/${v.scanId}/decision`, 'u-controleur', { decision: 'AUCUNE_SUITE', motif: 'autre agent', position: {} })).json().code).toBe('AUTRE_AGENT');
  });

  it('scan par le QR de la vignette technique ; mode courtoisie : aucun constat (scan et moteur de titres)', async () => {
    const env = await setupVc();
    const sticker = env.svc.ct.stickers.find((s) => s.status === 'ATTRIBUEE')[0]!;
    const byQr = (await env.req('POST', '/v1/vehicules/scan', U.controleur, { saisie: `https://verification.exemple.cd/v/ct/${sticker.number}`, place: { commune: 'Limete' } })).json();
    expect(byQr.method).toBe('QR_VIGNETTE_TECHNIQUE');
    expect(byQr.plate).toBe(normalizePlate(VC_DEMO.plates.aJour));
    expect(byQr.controleTechnique.stickerNumber).toBe(sticker.number);
    // Tricycle à Nsele : période de courtoisie [EXEMPLE] semée.
    env.svc.ct.upsertVehicle({ plate: 'KN-3333-TR', category: 'MOTO_3_ROUES', commune: 'Nsele', source: 'REGISTRE_RFCK' });
    const sc = (await env.req('POST', '/v1/vehicules/scan', U.controleur, { saisie: 'KN-3333-TR', place: { commune: 'Nsele' } })).json();
    expect(sc.courtesy).not.toBeNull();
    const refused = await env.req('POST', `/v1/vehicules/scans/${sc.scanId}/decision`, U.controleur, { decision: 'CONSTAT_A_INSTRUIRE', motif: 'Pas de vignette', position: {} });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('MODE_COURTOISIE');
    const titres = env.app.ctx.ext['titres'] as TitresService;
    const ctl = env.app.ctx.users.get('u-controleur')!;
    const inCourtesy = titres.recordControl(ctl, { method: 'PLAQUE', presented: 'KN-3333-TR', place: { commune: 'Nsele' }, module: '11' });
    expect(inCourtesy.constat).toBeUndefined();
    const outside = titres.recordControl(ctl, { method: 'PLAQUE', presented: 'KN-3333-TR', place: { commune: 'Gombe' }, module: '11' });
    expect(outside.constat).toBeDefined();
    expect(outside.constat!.legalEffect).toBe('AUCUN_MONTANT');
  });

  it('paquet hors ligne : empreintes de plaques (aucune plaque en clair), fraîcheur et révocations', async () => {
    const env = await setupVc();
    const p = (await env.req('GET', '/v1/vehicules/hors-ligne/paquet', U.controleur)).json();
    expect(p.generatedAt).toBe(env.clock.now().toISOString());
    expect(p.entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(p.entries)).not.toContain(normalizePlate(VC_DEMO.plates.aJour));
    expect(p.entries.some((e: { plateHash: string }) => e.plateHash === sha256Hex(`plaque|${normalizePlate(VC_DEMO.plates.aJour)}`))).toBe(true);
    expect(p.revocations.signature).toBeTruthy();
  });
});

describe('Fourrière — chaîne en sept étapes', () => {
  const constatBody = (plate: string, extra: Record<string, unknown> = {}) => ({ plate, motifLegal: 'Stationnement gênant', commune: 'Gombe', etat: 'Rayure avant', gps: { lat: -4.3, lon: 15.3, accuracyM: 5 }, photos: photos(['VEHICULE']), ...extra });

  it('dossier incomplet refusé ; aucun enlèvement sans décision ; score et IA ne décident jamais ; priorisation sans effet', async () => {
    const env = await setupVc();
    const { gps: _g, ...noGps } = constatBody('KN-1111-AA');
    const inc = await env.req('POST', '/v1/fourrieres/constats', U.controleur, noGps);
    expect(inc.statusCode).toBe(422);
    expect(inc.json().code).toBe('DOSSIER_INCOMPLET');
    const x = (await env.req('POST', '/v1/fourrieres/constats', U.controleur, constatBody('KN-1111-AA'))).json();
    const entry = { siteId: VC_DEMO.site, photos: photos(FIVE), conditionReport: 'RAS', inventory: [], contradictoire: { kind: 'TEMOIN', ref: 'T-1' } };
    const noDecision = await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/entree`, U.gardien, entry);
    expect(noDecision.statusCode).toBe(403);
    expect(noDecision.json().code).toBe('DECISION_ENLEVEMENT_REQUISE');
    const prio = (await env.req('GET', '/v1/fourrieres/priorisation', U.chef)).json();
    expect(prio.decision).toBe('AUCUNE');
    expect(env.svc.fourriere.dossiers.get(x.id)!.status).toBe('CONSTATE');
    const byScore = await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/decision-enlevement`, U.chef, { motifLegal: 'x'.repeat(5), legalBasis: 'y'.repeat(5), source: { kind: 'DECISION_AUTORITE', ref: 'D-1' }, origine: 'SCORE' });
    expect(byScore.statusCode).toBe(403);
    expect(byScore.json().code).toBe('DECISION_HUMAINE_REQUISE');
    expect((await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/decision-enlevement`, U.controleur, { motifLegal: 'x'.repeat(5), legalBasis: 'y'.repeat(5), source: { kind: 'DECISION_AUTORITE', ref: 'D-1' } })).statusCode).toBe(403);
    expect(evaluate({ kind: 'ai', id: 'agent-ia', roles: [] } as never, 'fourriere:decision')).toBe(false);
    const dec = await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/decision-enlevement`, U.chef, { motifLegal: 'Stationnement gênant', legalBasis: 'Acte de police [À VÉRIFIER]', source: { kind: 'DECISION_AUTORITE', ref: 'D-1' } });
    expect(dec.json().status).toBe('ENLEVEMENT_DECIDE');
    // Inventaire contradictoire : cinq vues distinctes exigées.
    expect((await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/entree`, U.gardien, { ...entry, photos: photos(FIVE.slice(0, 4)) })).json().code).toBe('PHOTOS_MANQUANTES');
    const ok = await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/entree`, U.gardien, { ...entry, photos: photos(FIVE) });
    expect(ok.json().status).toBe('EN_GARDE');
    expect(ok.json().entry.orderNumber).toMatch(/^FRR-EX-01-2026-\d{5}$/);
    // Aucun encaissement sur place.
    const cash = await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/encaissement`, U.gardien, { amount: '10' });
    expect(cash.statusCode).toBe(403);
    expect(cash.json().code).toBe('ESPECES_INTERDITES');
    expect(env.app.ctx.alerts.list().some((a) => a.type === 'FOURRIERE_ESPECES')).toBe(true);
    // Fiches non actives : aucun montant ; la sortie exige une décision motivée de mainlevée.
    const liq = (await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/liquidation`, U.chef)).json();
    expect(liq.liquidation.lines.every((l: { status: string; amount?: unknown }) => l.status !== 'LIQUIDEE' && !l.amount)).toBe(true);
    const exitBody = { photos: photos(['SORTIE']), collector: { pieceType: 'CARTE_ELECTEUR', pieceNumber: 'CE-123456', qualite: 'Propriétaire' } };
    expect((await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/sortie`, U.gardien, exitBody)).json().code).toBe('DECISION_MAINLEVEE_REQUISE');
    await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/mainlevee`, U.dg, { motif: 'Frais non institués (acte requis) — mainlevée motivée' });
    const out = await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/sortie`, U.gardien, { ...exitBody, photos: photos(['SORTIE']) });
    expect(out.json()).toMatchObject({ status: 'SORTI', exit: { basis: 'DECISION_MOTIVEE' } });
    expect(env.svc.fourriere.verifyCustody(x.id).intact).toBe(true);
  });

  it('frais au registre (règle ACTIVE) : sortie techniquement impossible sans quittance appariée ; compteur à deux personnes', async () => {
    const env = await setupVc();
    // Fiche de test certifiée (valeurs fictives de test, jamais un tarif réel).
    const rule = await publishCertifiedRule(env, { code: 'RFCK-FRAIS-GARDIENNAGE', revenueCategory: 'REDEVANCE_SERVICE', label: 'Gardiennage — fiche de TEST [EXEMPLE]', formula: 'jours * tarif_jour', rateTable: { tarif_jour: '5' }, periodicity: 'PONCTUELLE', administeringEntity: 'RFCK', effectiveFrom: '2026-09-27' });
    expect(rule.create.statusCode, rule.create.body).toBe(201);
    expect(rule.responses.at(-1)!.statusCode, rule.responses.at(-1)!.body).toBe(200);
    const plate = VC_DEMO.plates.aJour;
    const x = (await env.req('POST', '/v1/fourrieres/constats', U.controleur, constatBody(plate))).json();
    expect(x.taxpayerId).toBe(DEMO.taxpayerId);
    await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/decision-enlevement`, U.chef, { motifLegal: 'Stationnement gênant', legalBasis: 'Acte de police [À VÉRIFIER]', source: { kind: 'RECOUVREMENT', ref: 'DEC-REC-1' } });
    await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/entree`, U.agentFourriere, { siteId: VC_DEMO.site, photos: photos(FIVE), conditionReport: 'RAS', inventory: [{ label: 'Cric', quantity: 1 }], contradictoire: { kind: 'PROPRIETAIRE_PRESENT', ref: 'Pièce vue' } });
    env.clock.advance(2 * 86_400_000);
    // Écriture contraire : proposée par une personne, validée par une autre.
    const corr = (await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/ecritures-contraires`, U.chef, { field: 'entryAt', to: new Date(env.clock.now().getTime() - 3 * 86_400_000).toISOString(), reason: 'Horodatage d’entrée erroné (panne de terminal)' })).json();
    const cid = corr.corrections[0].id as string;
    expect((await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/ecritures-contraires/${cid}/decision`, U.chef, { approve: true, motif: 'moi' })).statusCode).toBe(403);
    await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/ecritures-contraires/${cid}/decision`, U.dg, { approve: true, motif: 'Pièce justificative vue' });
    const liq = (await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/liquidation`, U.chef)).json();
    const g = liq.liquidation.lines.find((l: { code: string }) => l.code === 'GARDIENNAGE');
    expect(g).toMatchObject({ status: 'LIQUIDEE', inputs: { jours: '3' } });
    expect(g.legalReference).toContain('RFCK-FRAIS-GARDIENNAGE');
    expect(liq.liquidation.lines.find((l: { code: string }) => l.code === 'ENLEVEMENT').status).toBe('ACTE_REQUIS');
    const exitBody = () => ({ photos: photos(['SORTIE']), collector: { pieceType: 'PASSEPORT', pieceNumber: 'OP-0001', qualite: 'Propriétaire' } });
    const noReceipt = await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/sortie`, U.agentFourriere, exitBody());
    expect(noReceipt.statusCode).toBe(409);
    expect(noReceipt.json().code).toBe('QUITTANCE_REQUISE');
    // Quittance d'une AUTRE obligation : refusée.
    const other = env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId).find((o) => o.id !== g.obligationId && o.status === 'EMISE')!;
    const pay = async (obligationId: string) => {
      const order = (await env.req('POST', `/v1/obligations/${obligationId}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).json();
      await signedCallback(env, callbackBody(env, order.paymentReference, order.amount));
      return env.app.ctx.receipts.byTaxpayer(DEMO.taxpayerId).find((r) => r.obligationId === obligationId)!;
    };
    const otherReceipt = await pay(other.id);
    expect((await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/sortie`, U.agentFourriere, { ...exitBody(), receipt: otherReceipt.qrPayload })).json().code).toBe('QUITTANCE_NON_APPARIEE');
    const r = await pay(g.obligationId);
    const forged = await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/sortie`, U.agentFourriere, { ...exitBody(), receipt: `MOSOLO1|${r.code}|signature-falsifiee` });
    expect(forged.json().code).toBe('QUITTANCE_INVALIDE');
    const ok = await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/sortie`, U.agentFourriere, { ...exitBody(), receipt: r.qrPayload });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'SORTI', exit: { basis: 'QUITTANCE_APPARIEE', receiptNumber: r.number } });
    expect(ok.json().exit.collector.pieceHash).toMatch(/^[0-9a-f]{64}$/);
    const ind = (await env.req('GET', '/v1/fourrieres/indicateurs', U.chef)).json();
    expect(ind.sorties).toBe(1);
    expect(ind.recettePayee.length).toBe(1);
    const rec = (await env.req('GET', '/v1/fourrieres/rapprochement', U.chef)).json().sites[0];
    expect(rec).toMatchObject({ exitsOnReceipt: 1, obligationsPaid: 1, balanced: true });
    // L'usager voit son dossier et sa situation fiscale, payable depuis son téléphone.
    const mine = (await env.req('GET', `/v1/fourrieres/dossiers/${x.id}`, 'u-contribuable')).json();
    expect(mine.situationFiscale).toBeDefined();
  });

  it('destination légale : jamais par IA ou score, délai de recours affiché, notification prouvée, double validation hiérarchique', async () => {
    const env = await setupVc();
    const x = env.svc.fourriere.dossiers.find((d) => d.status === 'EN_GARDE')[0]!;
    const body = { kind: 'DESTRUCTION', authorityDecisionRef: 'Décision [EXEMPLE] n° 1', legalBasis: 'Acte [À VÉRIFIER]', motif: 'Véhicule non réclamé', notification: { sentAt: '2026-08-01T09:00:00.000Z', receivedAt: '2026-08-02T09:00:00.000Z', proofSha256: 'a'.repeat(64) }, appealDeadline: '2026-10-15' };
    expect((await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/destination-legale`, U.chef, { ...body, origine: 'IA' })).json().code).toBe('DECISION_HUMAINE_REQUISE');
    const early = await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/destination-legale`, U.chef, body);
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ code: 'DELAI_RECOURS_EN_COURS', daysLeft: 19 });
    expect((await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/destination-legale`, U.chef, { ...body, appealDeadline: '2026-09-01', notification: { ...body.notification, proofSha256: 'x' } })).json().code).toBe('NOTIFICATION_NON_PROUVEE');
    // Alerte de garde longue : aucune destination automatique.
    env.clock.advance(40 * 86_400_000);
    const al = (await env.req('POST', '/v1/fourrieres/alertes/garde', U.chef)).json();
    expect(al.disposalsCreated).toBe(0);
    expect(env.svc.fourriere.dossiers.get(x.id)!.status).toBe('EN_GARDE');
    const p = await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/destination-legale`, U.chef, { ...body, appealDeadline: '2026-09-01' });
    expect(p.json().status).toBe('DESTINATION_PROPOSEE');
    expect(p.json().appealCountdown ?? env.svc.fourriere.view(env.svc.fourriere.dossiers.get(x.id)!).appealCountdown).toBeTruthy();
    expect((await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/destination-legale/validation`, U.ministre, { level: 2, approve: true, motif: 'Conforme' })).json().code).toBe('VALIDATION_1_REQUISE');
    await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/destination-legale/validation`, U.dg, { level: 1, approve: true, motif: 'Conforme' });
    const done = await env.req('POST', `/v1/fourrieres/dossiers/${x.id}/destination-legale/validation`, U.ministre, { level: 2, approve: true, motif: 'Conforme' });
    expect(done.json().status).toBe('DESTINATION_EXECUTEE');
    expect(done.json().disposal.validations).toHaveLength(2);
  });
});

describe('Raccordement RFCK, domaine officiel, séquence d’intégration, dépendance « contrôle technique valide »', () => {
  it('flux fermé sans convention ; convention + conformité par une autre personne ⇒ échange bac à sable ; étapes séquentielles', async () => {
    const env = await setupVc();
    const flows = (await env.req('GET', '/v1/rfck/flux', U.chef)).json();
    expect(flows.items.every((f: { statusLabel: string }) => f.statusLabel === 'À RACCORDER — convention requise')).toBe(true);
    expect(flows.connector.mode).toBe('BAC_A_SABLE');
    const closed = await env.req('POST', '/v1/rfck/flux/MOUVEMENTS_FOURRIERE/echanges', U.chef, { direction: 'RECEPTION', payload: [{ a: 1 }] });
    expect(closed.statusCode).toBe(403);
    expect(closed.json().code).toBe('CONVENTION_REQUISE');
    const c = (await env.req('POST', '/v1/rfck/conventions', U.dg, { flow: 'MOUVEMENTS_FOURRIERE', reference: 'Convention test', signedOn: '2026-09-20', signatories: 'RFCK ; Ville', documentSha256: 'b'.repeat(64) })).json();
    await env.req('POST', `/v1/rfck/conventions/${c.id}/conformite`, U.dpo, { conclusion: 'CONFORME', note: 'Minimisation vérifiée' });
    expect((await env.req('POST', '/v1/rfck/flux/MOUVEMENTS_FOURRIERE/echanges', U.chef, { direction: 'RECEPTION', payload: [{ a: 1 }] })).statusCode).toBe(201);
    const steps = (await env.req('GET', '/v1/rfck/integration', U.chef)).json().steps;
    expect(steps).toHaveLength(7);
    expect(steps[0].status).toBe('PRETE_A_VALIDER');
    expect(steps[1].status).toBe('EN_ATTENTE_ETAPE_PRECEDENTE');
    expect((await env.req('POST', '/v1/rfck/integration/CONVENTION/validation', U.dg, { motif: 'Convention signée' })).statusCode).toBe(200);
    expect((await env.req('POST', '/v1/rfck/integration/DOMAINE_OFFICIEL/validation', U.dg, { motif: 'x'.repeat(4) })).json().code).toBe('ETAPE_NON_FRANCHISSABLE');
    // Chiffres publiés : À VÉRIFIER, jamais une base.
    const figs = (await env.req('GET', '/v1/rfck/chiffres-publies', U.chef)).json().items;
    expect(figs.every((f: { status: string }) => f.status === 'A_VERIFIER')).toBe(true);
    // Reprise : contrôle par échantillon par une autre personne.
    const b = (await env.req('POST', '/v1/rfck/reprises', U.chef, { source: 'Registre RFCK (bac à sable)', records: [{ plate: 'KN-0001-RP', category: 'PARTICULIER' }, { plate: 'KN-0002-RP', category: 'ENTREPRISE' }] })).json();
    const ctl = await env.req('POST', `/v1/rfck/reprises/${b.id}/controle`, U.dg, { conforming: b.sample.length, note: 'Échantillon conforme' });
    expect(ctl.json().status).toBe('ACCEPTE');
    expect(env.svc.ct.vehicle('KN-0002-RP')?.category).toBe('ENTREPRISE');
  });

  it('domaine officiel à deux personnes ; ancien domaine en redirection ; domaine ressemblant signalé ; six exigences', async () => {
    const env = await setupVc();
    expect((await env.req('POST', '/v1/rfck/domaine/proposition', 'u-superadmin', { host: 'verifier.kinshasa.example', ownedBy: 'Ville-Province de Kinshasa', proofRef: 'Acte d’enregistrement [EXEMPLE]' })).statusCode).toBe(200);
    expect((await env.req('POST', '/v1/rfck/domaine/validation', 'u-superadmin', { approve: true, motif: 'moi' })).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/rfck/domaine/validation', 'u-dircab', { approve: true, motif: 'Domaine détenu par la Ville' })).json().status).toBe('VALIDE');
    const sticker = env.svc.ct.stickers.find((s) => s.status === 'ATTRIBUEE')[0]!;
    expect((await env.req('GET', `/v1/public/vehicules/vignettes/verifier?qr=${encodeURIComponent(`https://verifier.kinshasa.example/v/ct/${sticker.number}`)}`)).json().authentic).toBe(true);
    const old = `https://verification.exemple.cd/v/ct/${sticker.number}`;
    expect((await env.req('GET', `/v1/public/vehicules/vignettes/verifier?qr=${encodeURIComponent(old)}`)).json().state).toBe('DOMAINE_NON_OFFICIEL');
    await env.req('POST', '/v1/rfck/domaine/anciens', 'u-superadmin', { host: 'verification.exemple.cd', redirectUntil: '2027-03-31', reason: 'Ancien domaine de démonstration' });
    expect((await env.req('GET', `/v1/public/vehicules/vignettes/verifier?qr=${encodeURIComponent(old)}`)).json()).toMatchObject({ authentic: true, domainVerdict: 'ANCIEN_DOMAINE' });
    const w = (await env.req('POST', '/v1/rfck/domaine/surveillance', 'u-rssi', { host: 'verifier-kinshasa.example', evidence: 'Page imitant la vérification' })).json();
    expect((await env.req('POST', `/v1/rfck/domaine/surveillance/${w.id}/suite`, 'u-rssi', { to: 'RETRAIT_DEMANDE', note: 'Demande au registraire' })).json().status).toBe('RETRAIT_DEMANDE');
    const req = (await env.req('GET', '/v1/rfck/domaine/exigences', U.chef)).json().items;
    expect(req).toHaveLength(6);
    expect(req[0].status).toBe('CONFORME');
  });

  it('mutation de véhicule : « contrôle technique valide » est INFORMATIF (ne bloque pas) jusqu’à l’acte', async () => {
    const env = await setupVc();
    const fiscal = env.app.ctx.ext['fiscal'] as { dependencies: { evaluate(s: string, tp: string, c: { plate?: string }): { blocked: boolean; conditions: { condition: string; mode: string; satisfied: boolean }[] } } };
    const ok = fiscal.dependencies.evaluate('MUTATION_VEHICULE', DEMO.taxpayerId, { plate: VC_DEMO.plates.aJour });
    const ct = ok.conditions.find((c) => c.condition === 'CONTROLE_TECHNIQUE_VALIDE')!;
    expect(ct).toMatchObject({ mode: 'INFORMATIF', satisfied: true });
    const ko = fiscal.dependencies.evaluate('MUTATION_VEHICULE', DEMO.taxpayerId, { plate: VC_DEMO.plates.echu });
    expect(ko.conditions.find((c) => c.condition === 'CONTROLE_TECHNIQUE_VALIDE')!.satisfied).toBe(false);
    expect(ko.blocked).toBe(false);
  });

  it('enrôlement au centre : compte unique ouvert, téléphone vérifié par le code reçu par le titulaire', async () => {
    const env = await setupVc();
    env.svc.raccordement.codeGenerator = () => '424242';
    const s = await env.req('POST', `/v1/centres-agrees/${VC_DEMO.centres.ct1}/enrolements`, U.centre1, { phone: '+243 899 000 111', fullName: 'Usager test (fictif)', plate: VC_DEMO.plates.echu });
    expect(s.statusCode).toBe(201);
    expect(JSON.stringify(s.json())).not.toContain('424242');
    expect((await env.req('POST', `/v1/centres-agrees/enrolements/${s.json().id}/code`, U.centre1, { code: '000000' })).json().code).toBe('CODE_INCORRECT');
    const done = (await env.req('POST', `/v1/centres-agrees/enrolements/${s.json().id}/code`, U.centre1, { code: '424242' })).json();
    expect(done.status).toBe('TELEPHONE_VERIFIE');
    expect(env.app.ctx.taxpayers.get(done.taxpayerId).phoneVerifiedAt).toBeTruthy();
    expect(env.svc.ct.vehicle(VC_DEMO.plates.echu)?.taxpayerId).toBe(done.taxpayerId);
  });

  it('indicateurs à l’écran, seuils au registre (par défaut, à confirmer), audit de chaque action', async () => {
    const env = await setupVc();
    const ind = (await env.req('GET', '/v1/vehicules/indicateurs', U.chef)).json();
    expect(ind.controleTechnique).toHaveProperty('ctAJourPct');
    expect(ind.controleTechnique.vignettesEmises).toBeGreaterThan(0);
    expect(ind.fourriere.enFourriere).toBe(1);
    expect(ind.centres.actifs).toBe(3);
    expect(ALL_PARAMETERS.some((p) => p.id === 'vehicules.pv_transmission_max_min')).toBe(true);
    // Couche usager : véhicules du compte, deux vignettes distinctes, situation fiscale payable depuis le téléphone.
    const mine = (await env.req('GET', '/v1/vehicules/mes-vehicules', 'u-contribuable')).json();
    const v = mine.vehicles.find((x: { plate: string }) => x.plate === normalizePlate(VC_DEMO.plates.aJour));
    expect(v.controleTechnique.state).toBe('A_JOUR');
    expect(v.vignetteFiscale.state).toBe('AUCUNE');
    expect(mine.situationFiscale.every((o: { payPath: string }) => o.payPath.startsWith('/v1/obligations/'))).toBe(true);
    expect((await env.req('GET', '/v1/vehicules/mes-vehicules', 'u-locataire')).json().vehicles).toHaveLength(0);
    const actions = env.app.ctx.audit.list({ limit: 10_000 }).items.map((e) => e.action);
    for (const a of ['vc.pv.transmitted', 'vc.sticker.assigned', 'centres.agrement.approved', 'fourriere.entry.recorded', 'vc.courtesy.decided']) expect(actions).toContain(a);
  });
});
