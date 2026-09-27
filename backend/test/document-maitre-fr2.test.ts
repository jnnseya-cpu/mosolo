/**
 * Document maître FR 2 (nouvelle version, reçue le 27/09/2026), chapitres 1 à 17 et 19 à 30 : exigences construites
 * par-dessus l'existant lors de l'analyse mot à mot (voir docs/document-maitre/couverture-nouvelle-version-ch01-30.md).
 *   - § 17.2 : identifiant au format « KIN-<commune>-<quartier>-<voie>-<n°> », en plus du format territorial existant ;
 *   - § 30 / § 17.3 : cycle de vie de l'objet fiscal (provisoire, actif, suspendu, clos) et résiliation du bail ;
 *   - § 23 / § 13.4 : propriétaire de chaque recours, indicateurs de délai pour la direction de la régie et l'audit ;
 *   - § 30 et § 12 : modèle de données et matrice d'habilitations évalués en direct.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { fiscalPlugin } from '../src/plugins/fiscal/plugin.js';
import type { FiscalService } from '../src/plugins/fiscal/service.js';
import { CAHIER_IGF_PATTERN, cahierQuartierCode, cahierVoieCode, TERRITORIAL_IGF_PATTERN } from '../src/plugins/fiscal/geo.js';
import { DATA_MODEL } from '../src/plugins/referentiel/modele-donnees.js';
import { ROLE_MATRIX } from '../src/plugins/referentiel/matrice-roles.js';
import { recouvrementPlugin, type RecoveryService } from '../src/plugins/recouvrement/plugin.js';
import { DEMO, demoObligationId, publishCertifiedRule, setup, type TestEnv } from './helpers.js';

const DAY = 86_400_000;

async function setupFiscal() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock,
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} },
    plugins: [fiscalPlugin],
  });
  await app.ready();
  const env: TestEnv = {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
  return { ...env, svc: app.ctx.ext['fiscal'] as FiscalService };
}
type FEnv = Awaited<ReturnType<typeof setupFiscal>>;

function census(env: FEnv, extra: Record<string, unknown> = {}, commune = 'Gombe', quartier = 'Gombe') {
  return env.app.ctx.objects.create(env.app.ctx.users.get('u-controleur')!, {
    category: 'PARCELLE', commune, quartier, localityRank: 1, lat: -4.305, lon: 15.31, attributes: { superficie_m2: '400' }, ...extra,
  });
}

describe('§ 17.2 — identifiant géographique fiscal au format du Cahier, en plus du format territorial', () => {
  it('codes de voie et de quartier ; exemple du Cahier reproduit ; objet sans voie formelle', () => {
    expect(cahierQuartierCode('Gombe')).toBe('GOMBE');
    expect(cahierVoieCode('Avenue du Mont Fleury')).toBe('AV-MONT');
    expect(cahierVoieCode('Boulevard du 30 Juin')).toBe('BD-30');
    expect(cahierVoieCode(undefined)).toBe('SV');
    expect('KIN-GOM-GOMBE-AV-MONT-001245').toMatch(CAHIER_IGF_PATTERN);
    expect('KIN-GOM-Q012-P004517').toMatch(TERRITORIAL_IGF_PATTERN);
  });

  it('attribué à la validation, stable, non réattribuable, résolu dans les deux formats ; sous-objets prolongés', async () => {
    const env = await setupFiscal();
    const a = census(env, { avenue: 'Avenue du Mont Fleury' });
    const v = await env.req('POST', `/v1/fiscal/objects/${a.id}/validate`, 'u-fiscal-chef-service');
    expect(v.statusCode).toBe(200);
    const igf = v.json().object.igf;
    expect(igf.code).toMatch(TERRITORIAL_IGF_PATTERN);
    expect(igf.cahierCode).toBe('KIN-GOM-GOMBE-AV-MONT-000001');
    // Deuxième objet de la même voie : numéro séquentiel suivant ; autre voie : autre préfixe.
    const b = census(env, { avenue: 'Av. du Mont Fleury' });
    const vb = (await env.req('POST', `/v1/fiscal/objects/${b.id}/validate`, 'u-fiscal-chef-service')).json();
    expect(vb.object.igf.cahierCode).toBe('KIN-GOM-GOMBE-AV-MONT-000002');
    const c = census(env, {}, 'Limete', 'Kingabwa');
    const vc = (await env.req('POST', `/v1/fiscal/objects/${c.id}/validate`, 'u-fiscal-chef-service')).json();
    expect(vc.object.igf.cahierCode).toMatch(/^KIN-LIM-KINGABWA-SV-\d{6}$/); // numéro suivant ceux des objets de démonstration du quartier
    // Revalidation : ni l'IGF territorial ni l'alias ne changent.
    const again = (await env.req('POST', `/v1/fiscal/objects/${a.id}/validate`, 'u-fiscal-chef-service')).json();
    expect(again.object.igf).toMatchObject({ code: igf.code, cahierCode: igf.cahierCode, uuid: igf.uuid });
    // Résolution dans les deux formats vers le même objet.
    const r1 = (await env.req('GET', `/v1/fiscal/igf/${igf.cahierCode}`, 'u-controleur')).json();
    const r2 = (await env.req('GET', `/v1/fiscal/igf/${igf.code}`, 'u-controleur')).json();
    expect(r1).toMatchObject({ objectId: a.id, matchedFormat: 'CAHIER', formats: { territorial: igf.code, cahier: igf.cahierCode }, reassignable: false });
    expect(r2).toMatchObject({ objectId: a.id, matchedFormat: 'TERRITORIAL' });
    expect((await env.req('GET', '/v1/fiscal/igf/KIN-GOM-GOMBE-AV-XXX-999999', 'u-controleur')).statusCode).toBe(404);
    // Un contribuable sans lien avec l'objet ne résout pas l'identifiant.
    expect((await env.req('GET', `/v1/fiscal/igf/${igf.cahierCode}`, 'u-contribuable')).statusCode).toBe(403);
    // Non réattribuable : le registre refuse de réattribuer un code déjà émis.
    expect(() => env.svc.geo['reserveCahier'](igf.cahierCode, env.app.ctx.objects.get(b.id), 'x', 'y')).toThrow(/jamais réattribué/);
    // Sous-objet (bâtiment) : prolongement des deux codes.
    const bat = env.app.ctx.objects.create(env.app.ctx.users.get('u-controleur')!, {
      category: 'BATIMENT', commune: 'Gombe', quartier: 'Gombe', localityRank: 1, lat: -4.305, lon: 15.31, attributes: {}, parentObjectId: a.id,
    });
    const vbat = (await env.req('POST', `/v1/fiscal/objects/${bat.id}/validate`, 'u-fiscal-chef-service')).json();
    expect(vbat.object.igf.code).toBe(`${igf.code}-B01`);
    expect(vbat.object.igf.cahierCode).toBe(`${igf.cahierCode}-B01`);
    expect(vbat.object.igf.cahierCode).toMatch(CAHIER_IGF_PATTERN);
    // L'objet de démonstration validé au semis porte aussi l'alias.
    expect(env.app.ctx.objects.get(DEMO.parcelId).igf?.cahierCode).toMatch(CAHIER_IGF_PATTERN);
  });
});

describe('§ 30 et § 17.3 — cycle de vie de l’objet fiscal (provisoire, actif, suspendu, clos)', () => {
  it('suspension motivée pour litige de limites : bleu, aucune nouvelle liquidation, levée motivée', async () => {
    const env = await setupFiscal();
    const { id: ruleId } = await publishCertifiedRule(env);
    const provisional = census(env);
    expect((await env.req('GET', `/v1/fiscal/objects/${provisional.id}`, 'u-controleur')).json().lifecycle.state).toBe('PROVISOIRE');
    expect((await env.req('GET', `/v1/fiscal/objects/${DEMO.parcelId}`, 'u-controleur')).json().lifecycle).toMatchObject({ state: 'ACTIF', liquidationAllowed: true });
    // Agent de terrain : pas habilité à suspendre ; motif trop court refusé.
    expect((await env.req('POST', `/v1/fiscal/objects/${DEMO.parcelId}/suspension`, 'u-agent-terrain', { motif: 'LITIGE_LIMITES', reason: 'Litige signalé au service foncier' })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/fiscal/objects/${DEMO.parcelId}/suspension`, 'u-controleur', { motif: 'LITIGE_LIMITES', reason: 'court' })).statusCode).toBe(400);
    const s = await env.req('POST', `/v1/fiscal/objects/${DEMO.parcelId}/suspension`, 'u-controleur', { motif: 'LITIGE_LIMITES', reason: 'Litige de limites signalé ; renvoi au service foncier.' });
    expect(s.statusCode).toBe(200);
    expect(s.json().lifecycle).toMatchObject({ state: 'SUSPENDU', motif: 'LITIGE_LIMITES', liquidationAllowed: false });
    expect(s.json().situation.color).toBe('blue');
    // Aucune nouvelle liquidation ; tentative journalisée ; les obligations déjà émises ne sont pas touchées.
    const before = env.app.ctx.assessment.obligations.find((o) => o.objectId === DEMO.parcelId).map((o) => o.status);
    const liq = await env.req('POST', '/v1/assessments/calculate', 'u-controleur', { ruleId, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: { superficie_m2: '600' }, simulate: false });
    expect(liq.statusCode).toBe(409);
    expect(liq.json().code).toBe('OBJECT_SUSPENDED');
    expect(env.app.ctx.audit.list({ action: 'assessment.liquidation.refused' }).items.some((r) => r.details?.['reason'] === 'OBJECT_SUSPENDED')).toBe(true);
    expect(env.app.ctx.assessment.obligations.find((o) => o.objectId === DEMO.parcelId).map((o) => o.status)).toEqual(before);
    // La simulation reste possible (non opposable).
    expect((await env.req('POST', '/v1/assessments/calculate', 'u-controleur', { ruleId, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: { superficie_m2: '600' }, simulate: true })).statusCode).toBe(200);
    // Levée motivée : actif, statut probant rétabli, liquidation de nouveau possible.
    const r = await env.req('POST', `/v1/fiscal/objects/${DEMO.parcelId}/reactivation`, 'u-fiscal-chef-service', { reason: 'Limites confirmées par le service foncier.' });
    expect(r.json().lifecycle.state).toBe('ACTIF');
    expect(r.json().probativeStatus).toBe('VERIFIE');
    expect((await env.req('POST', '/v1/assessments/calculate', 'u-controleur', { ruleId, taxpayerId: DEMO.taxpayerId, objectId: DEMO.parcelId, inputs: { superficie_m2: '600' }, simulate: false })).statusCode).toBe(201);
    const hist = env.app.ctx.objects.get(DEMO.parcelId).lifecycleHistory!;
    expect(hist.map((h) => `${h.from}>${h.to}`)).toEqual(['ACTIF>SUSPENDU', 'SUSPENDU>ACTIF']);
  });

  it('clôture à quatre yeux : proposée, approuvée par une autre personne ; l’objet et son IGF restent au registre', async () => {
    const env = await setupFiscal();
    // Date d'effet future refusée.
    expect((await env.req('POST', `/v1/fiscal/objects/${DEMO.parcelId}/closure`, 'u-controleur', { motif: 'DEMOLITION', reason: 'Date future non admise ici.', effectiveDate: '2027-01-01' })).statusCode).toBe(400);
    const p = await env.req('POST', `/v1/fiscal/objects/${DEMO.parcelId}/closure`, 'u-controleur', { motif: 'DEMOLITION', reason: 'Bâtiment démoli, constat du 20 septembre.', effectiveDate: '2026-09-20' });
    expect(p.statusCode).toBe(201);
    const closureId = p.json().id as string;
    expect((await env.req('POST', `/v1/fiscal/objects/${DEMO.parcelId}/closure`, 'u-controleur', { motif: 'DEMOLITION', reason: 'Seconde proposition identique.', effectiveDate: '2026-09-20' })).statusCode).toBe(409);
    // Le contrôleur n'approuve pas (rôle) ; la même personne ne peut pas approuver sa proposition.
    expect((await env.req('POST', `/v1/fiscal/object-closures/${closureId}/decision`, 'u-controleur', { approve: true, reason: 'Je valide moi-même.' })).statusCode).toBe(403);
    const list = (await env.req('GET', '/v1/fiscal/object-closures?status=PROPOSEE', 'u-auditeur')).json();
    expect(list.map((c: { id: string }) => c.id)).toContain(closureId);
    const d = await env.req('POST', `/v1/fiscal/object-closures/${closureId}/decision`, 'u-fiscal-chef-service', { approve: true, reason: 'Démolition constatée sur pièces.' });
    expect(d.statusCode).toBe(200);
    expect(d.json().lifecycle).toMatchObject({ state: 'CLOS', liquidationAllowed: false });
    const o = env.app.ctx.objects.get(DEMO.parcelId);
    expect(o.igf?.code).toBeTruthy();
    expect(o.lifecycle?.decidedBy).toEqual(['u-controleur', 'u-fiscal-chef-service']);
    // Quatre yeux : la personne qui propose n'approuve pas sa propre proposition.
    const own = (await env.req('POST', `/v1/fiscal/objects/${DEMO.unitId}/closure`, 'u-fiscal-chef-service', { motif: 'DOUBLON', reason: 'Doublon d’une autre unité recensée.', effectiveDate: '2026-09-25' })).json();
    const self = await env.req('POST', `/v1/fiscal/object-closures/${own.id}/decision`, 'u-fiscal-chef-service', { approve: true, reason: 'Auto-approbation.' });
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe('SEPARATION_OF_DUTIES');
    // Clos : ni suspension ni nouvelle clôture.
    expect((await env.req('POST', `/v1/fiscal/objects/${DEMO.parcelId}/suspension`, 'u-controleur', { motif: 'AUTRE', reason: 'Suspension après clôture.' })).statusCode).toBe(409);
  });

  it('bail : déclaré, vérifié, résilié, contesté — résiliation par une partie, jamais supprimé', async () => {
    const env = await setupFiscal();
    const leases = (await env.req('GET', '/v1/fiscal/leases', 'u-contribuable')).json();
    const demo = leases.find((l: { id: string }) => l.id === DEMO.leaseId);
    expect(['DECLARE', 'VERIFIE', 'OBSERVE']).toContain(demo.state);
    // Un tiers ne résilie pas ; date antérieure au début refusée.
    expect((await env.req('POST', `/v1/fiscal/leases/${DEMO.leaseId}/resiliation`, 'u-controleur', { endDate: '2026-09-30', reason: 'Fin de bail constatée.' })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/fiscal/leases/${DEMO.leaseId}/resiliation`, 'u-contribuable', { endDate: '1990-01-01', reason: 'Fin de bail antérieure.' })).statusCode).toBe(400);
    const r = await env.req('POST', `/v1/fiscal/leases/${DEMO.leaseId}/resiliation`, 'u-contribuable', { endDate: '2026-09-30', reason: 'Départ du locataire.' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ state: 'RESILIE', end: '2026-09-30', termination: { byRole: 'BAILLEUR' } });
    expect((await env.req('POST', `/v1/fiscal/leases/${DEMO.leaseId}/resiliation`, 'u-contribuable', { endDate: '2026-09-30', reason: 'Deuxième fois.' })).statusCode).toBe(409);
    expect(env.app.ctx.objects.leases.get(DEMO.leaseId)).toBeTruthy();
    expect(env.app.ctx.comms.deliveries.find((x) => x.eventCode === 'lease.ended' && x.recipientId === DEMO.tenantTaxpayerId).length).toBeGreaterThan(0);
    expect(env.app.ctx.audit.list({ action: 'lease.terminated' }).total).toBe(1);
  });
});

describe('§ 16.6 — indicateurs de couverture locative par avenue, quartier et commune', () => {
  it('effectifs, occupation, bailleurs et locataires, valeur locative annualisée par devise, obligations ; estimations non inventées', async () => {
    const env = await setupFiscal();
    const r = await env.req('GET', '/v1/fiscal/couverture-locative?niveau=QUARTIER&commune=Limete', 'u-fiscal-chef-service');
    expect(r.statusCode).toBe(200);
    const row = r.json().rows.find((x: { quartier: string }) => x.quartier === 'Kingabwa');
    expect(row.registered.units).toBeGreaterThanOrEqual(1);
    expect(row.leases.active).toBeGreaterThanOrEqual(1);
    expect(row.parties).toMatchObject({ lessors: expect.any(Number), tenants: expect.any(Number) });
    expect(row.parties.lessors).toBeGreaterThanOrEqual(1);
    expect(row.parties.tenants).toBeGreaterThanOrEqual(1);
    // Bail de démonstration : 450 USD par mois ⇒ 5 400 USD par an (au moins), jamais additionné à une autre devise.
    expect(Number(row.declaredRentalValue.USD)).toBeGreaterThanOrEqual(5400);
    expect(row.occupancy.leased).toBeGreaterThanOrEqual(1);
    expect(row.estimated).toMatchObject({ parcels: null, units: null, status: 'NON_MESURE' });
    expect(row.census).toMatchObject({ coverageRate: null, status: 'NON_MESURE' });
    expect(row.legallyTaxableBase.status).toBe('NON_CALCULABLE');
    expect(row.concentrationPct).toBeGreaterThan(0);
    expect(row.obligations.paid + row.obligations.unpaid).toBeGreaterThanOrEqual(1);
    // Niveaux commune et avenue ; niveau inconnu refusé.
    const communes = (await env.req('GET', '/v1/fiscal/couverture-locative?niveau=COMMUNE', 'u-fiscal-chef-service')).json();
    expect(communes.rows.every((x: { quartier: string | null }) => x.quartier === null)).toBe(true);
    const avenues = (await env.req('GET', '/v1/fiscal/couverture-locative?niveau=AVENUE&commune=Limete', 'u-fiscal-chef-service')).json();
    expect(avenues.rows.length).toBeGreaterThan(0);
    expect(avenues.rows[0].avenue).toBeTruthy();
    expect((await env.req('GET', '/v1/fiscal/couverture-locative?niveau=RUE', 'u-fiscal-chef-service')).statusCode).toBe(400);
    // Agent de terrain : effectifs de son secteur, aucun montant ; contribuable refusé ; aucun nom dans la réponse.
    const agent = (await env.req('GET', '/v1/fiscal/couverture-locative?niveau=QUARTIER&commune=Limete', 'u-agent-terrain')).json();
    expect(agent.access).toBe('minimal');
    expect(agent.rows.every((x: { declaredRentalValue: unknown; obligations: { unpaidAmount: unknown } }) => x.declaredRentalValue === null && x.obligations.unpaidAmount === null)).toBe(true);
    expect((await env.req('GET', '/v1/fiscal/couverture-locative?niveau=QUARTIER&commune=Gombe', 'u-agent-terrain')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/fiscal/couverture-locative', 'u-contribuable')).statusCode).toBe(403);
    expect(JSON.stringify(r.json())).not.toMatch(/Mbuyi|Nzuzi|TP-DEMO/);
  });
});

describe('§ 17.1 — couches du cadastre fiscal géospatial', () => {
  it('21 couches du Cahier : effectifs réels, couches sans source déclarées non disponibles, potentiel non mesuré', async () => {
    const env = await setupFiscal();
    const r = await env.req('GET', '/v1/fiscal/couches', 'u-fiscal-chef-service');
    expect(r.statusCode).toBe(200);
    const layers = r.json().layers as { code: string; status: string; count: number | null }[];
    expect(layers).toHaveLength(21);
    const by = Object.fromEntries(layers.map((l) => [l.code, l])) as Record<string, { code: string; status: string; count: number | null }>;
    expect(by.COMMUNES!.count).toBe(24);
    expect(by.PARCELLES!.count).toBeGreaterThan(0);
    expect(by.UNITES!.count).toBeGreaterThan(0);
    expect(by.POTENTIEL).toMatchObject({ status: 'NON_MESURE', count: null });
    expect(by.PORTS!.status).toBe('NON_DISPONIBLE');
    // Modules absents de cette instance : couche déclarée non disponible, jamais simulée.
    expect(by.ZONES_STATIONNEMENT).toMatchObject({ status: 'NON_DISPONIBLE', count: null });
    // Agent de terrain : périmètre de son territoire ; contribuable refusé.
    const agent = (await env.req('GET', '/v1/fiscal/couches', 'u-agent-terrain')).json();
    expect(agent.layers.find((l: { code: string }) => l.code === 'COMMUNES').count).toBe(3);
    expect((await env.req('GET', '/v1/fiscal/couches', 'u-contribuable')).statusCode).toBe(403);
  });
});

describe('§ 23 et § 13.4 — chaque recours a un propriétaire, un délai légal, un état et une décision motivée', () => {
  async function appeal(env: TestEnv) {
    const r = await env.req('POST', '/v1/appeals', 'u-contribuable', { obligationId: demoObligationId(env), grounds: 'Bien non détenu depuis 2025.', type: 'BIEN_NON_DETENU' });
    expect(r.statusCode).toBe(201);
    return r.json();
  }

  it('propriétaire dès le dépôt (service compétent), affectation nominative par la direction, historique', async () => {
    const env = await setup();
    const a = await appeal(env);
    expect(a.owner).toMatchObject({ entity: 'DGIPK' });
    expect(a.owner.userId).toBeUndefined();
    expect(a.deadlines.state).toBe('DANS_LE_DELAI');
    // Seule la direction de la régie (même entité) affecte ; l'agent désigné doit être un agent de contentieux.
    expect((await env.req('POST', `/v1/appeals/${a.id}/assign`, 'u-gouverneur', { assigneeId: 'u-contentieux', reason: 'Affectation.' })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/appeals/${a.id}/assign`, 'u-dg-dgipk', { assigneeId: 'u-controleur', reason: 'Affectation.' })).statusCode).toBe(422);
    const owners = (await env.req('GET', '/v1/appeals/proprietaires', 'u-dg-dgipk')).json();
    expect(owners.map((o: { id: string }) => o.id)).toContain('u-contentieux');
    const as = await env.req('POST', `/v1/appeals/${a.id}/assign`, 'u-dg-dgipk', { assigneeId: 'u-contentieux', reason: 'Affectation par la direction.' });
    expect(as.statusCode).toBe(200);
    expect(as.json().owner).toMatchObject({ entity: 'DGIPK', userId: 'u-contentieux', assignedBy: 'u-dg-dgipk' });
    expect(as.json().history.map((h: { action: string }) => h.action)).toContain('appeal.assigned');
    expect(env.app.ctx.audit.list({ action: 'appeal.assigned' }).total).toBe(1);
  });

  it('non-respect du délai : indicateur au tableau de la direction de la régie et de l’audit interne ; décision motivée', async () => {
    const env = await setup();
    const a = await appeal(env);
    // Sans affectation : l'instructeur devient propriétaire.
    const ind0 = (await env.req('GET', '/v1/appeals/indicateurs', 'u-auditeur')).json();
    expect(ind0).toMatchObject({ open: 1, overdue: 0, unassigned: 1 });
    expect((await env.req('GET', '/v1/appeals/indicateurs', 'u-contribuable')).statusCode).toBe(403);
    env.clock.set(new Date(env.clock.now().getTime() + 61 * DAY).toISOString());
    for (const u of ['u-auditeur', 'u-dg-dgipk']) {
      const ind = (await env.req('GET', '/v1/appeals/indicateurs', u)).json();
      expect(ind.overdue, u).toBe(1);
      expect(ind.overdueItems[0]).toMatchObject({ id: a.id, entity: 'DGIPK', ownerUserId: null });
      expect(ind.overdueItems[0].daysLate).toBeGreaterThan(0);
      expect(JSON.stringify(ind)).not.toContain('Contribuable');
    }
    expect(env.app.ctx.audit.list({ action: 'appeal.sla_breach' }).total).toBe(1);
    const ins = await env.req('POST', `/v1/appeals/${a.id}/instruct`, 'u-contentieux', { proposal: 'REJETEE', analysis: 'Pièces insuffisantes, titre au nom du réclamant.' });
    expect(ins.statusCode).toBe(200);
    expect(env.app.ctx.appeals.get(a.id).owner).toMatchObject({ userId: 'u-contentieux' });
    const dec = await env.req('POST', `/v1/appeals/${a.id}/decide`, 'u-decideur', { decision: 'REJETEE', reason: 'Titre de propriété au nom du réclamant.' });
    expect(dec.statusCode).toBe(200);
    const ind2 = (await env.req('GET', '/v1/appeals/indicateurs', 'u-dg-dgipk')).json();
    expect(ind2).toMatchObject({ open: 0, overdue: 0, decided: 1, decidedLate: 1, decidedWithinDeadlineRate: '0 %' });
    expect((await env.req('POST', `/v1/appeals/${a.id}/assign`, 'u-dg-dgipk', { assigneeId: 'u-contentieux', reason: 'Trop tard.' })).statusCode).toBe(409);
  });
});

describe('§ 15.2 — notification remise sur le terrain : signature recueillie ou refus enregistré', () => {
  it('agent de constat seulement, avis formel seulement, une seule remise, position et empreinte ; refus consigné', async () => {
    const clock = new ManualClock('2026-09-26T09:00:00.000Z');
    const app = buildApp({ clock, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} }, plugins: [recouvrementPlugin] });
    await app.ready();
    const req = (method: string, url: string, user: string, body?: unknown) => app.inject({
      method: method as 'GET', url, headers: { 'x-demo-user': user, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    const svc = app.ctx.ext['recouvrement'] as RecoveryService;
    const caseId = svc.caseFor(app.ctx.assessment.byTaxpayer(DEMO.tenantTaxpayerId)[0]!.id)!.id;
    const motivation = 'Relances restées sans suite, adresse vérifiée';
    const p = (await req('POST', `/v1/recouvrement/dossiers/${caseId}/propositions`, 'u-contentieux', { kind: 'AVIS_FORMEL', motivation })).json();
    const noticeId = (await req('POST', `/v1/recouvrement/propositions/${p.id}/decision`, 'u-decideur', { decision: 'APPROUVEE', motivation: 'Constat vérifié, voie de recours rappelée' })).json().noticeId as string;
    const position = { lat: -4.37, lon: 15.34, accuracyM: 8 };
    // Recenseur (R10) : jamais ; contrôleur : oui. Remise signée sans empreinte refusée.
    expect((await req('POST', `/v1/recouvrement/avis/${noticeId}/remise`, 'u-agent-terrain', { outcome: 'SIGNE', signatureSha256: 'c'.repeat(64), position })).statusCode).toBe(403);
    expect((await req('POST', `/v1/recouvrement/avis/${noticeId}/remise`, 'u-controleur', { outcome: 'SIGNE', position })).statusCode).toBe(400);
    const ok = await req('POST', `/v1/recouvrement/avis/${noticeId}/remise`, 'u-controleur', { outcome: 'SIGNE', signatureSha256: 'c'.repeat(64), position });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().fieldDelivery).toMatchObject({ by: 'u-controleur', outcome: 'SIGNE', legalStatus: 'A_VERIFIER', position });
    expect((await req('POST', `/v1/recouvrement/avis/${noticeId}/remise`, 'u-controleur', { outcome: 'REFUS', refusalNote: 'Refus de signer.', position })).statusCode).toBe(409);
    const proof = (await req('GET', `/v1/recouvrement/avis/${noticeId}/preuve`, 'u-contentieux')).json();
    expect(proof.fieldDelivery.signatureSha256).toBe('c'.repeat(64));
    expect(app.ctx.audit.list({ action: 'recovery.notice.hand_delivered' }).total).toBe(1);
    // Refus consigné sur une mise en demeure ; un simple rappel ne se remet pas en personne.
    clock.set('2026-10-11T09:00:00Z');
    const md = (await req('POST', `/v1/recouvrement/dossiers/${caseId}/propositions`, 'u-contentieux', { kind: 'MISE_EN_DEMEURE', motivation, legalBasis: { instrumentId: 'demo-instrument-001', article: 'Art. 4 (fictif)' } })).json();
    const mdId = (await req('POST', `/v1/recouvrement/propositions/${md.id}/decision`, 'u-decideur', { decision: 'APPROUVEE', motivation: 'Mise en demeure conforme, double validation' })).json().noticeId as string;
    expect((await req('POST', `/v1/recouvrement/avis/${mdId}/remise`, 'u-controleur', { outcome: 'REFUS', position })).statusCode).toBe(400);
    const refused = await req('POST', `/v1/recouvrement/avis/${mdId}/remise`, 'u-controleur', { outcome: 'REFUS', refusalNote: 'Le destinataire refuse de signer ; avis laissé sur place.', witness: 'Chef de quartier', position });
    expect(refused.json().fieldDelivery).toMatchObject({ outcome: 'REFUS', witness: 'Chef de quartier' });
    expect(app.ctx.audit.list({ action: 'recovery.notice.delivery_refused' }).total).toBe(1);
    const other = svc.notices.all().find((n) => n.kind !== 'AVIS_FORMEL' && n.kind !== 'MISE_EN_DEMEURE');
    if (other) expect((await req('POST', `/v1/recouvrement/avis/${other.id}/remise`, 'u-controleur', { outcome: 'SIGNE', signatureSha256: 'd'.repeat(64), position })).json().code).toBe('NOTICE_NOT_DELIVERABLE_BY_AGENT');
  });
});

describe('§ 30 et § 12 — modèle de données et matrice d’habilitations évalués en direct', () => {
  it('chaque état du Cahier a un état de la plateforme ; effectifs par état ; aucun nom', async () => {
    const env = await setup();
    // 29 lignes du tableau du ch. 30, chaque état du Cahier rapproché d'un état réellement porté par le code.
    expect(DATA_MODEL).toHaveLength(29);
    for (const e of DATA_MODEL) {
      for (const m of e.cahierLifecycle ?? []) {
        expect(m.platform.length, `${e.entity} / ${m.cahier}`).toBeGreaterThan(0);
        for (const p of m.platform) expect(e.platformStates.some((s) => p.startsWith(s) || s.startsWith(p.split(' ')[0]!)), `${e.entity} / ${p}`).toBe(true);
      }
    }
    const withLifecycle = DATA_MODEL.filter((e) => e.cahierLifecycle).map((e) => e.code);
    expect(withLifecycle).toEqual(['UTILISATEUR', 'CONTRIBUABLE', 'IDENTITE', 'ADRESSE', 'OBJET_FISCAL', 'BAIL', 'TEXTE_LEGAL', 'OBLIGATION', 'AUDIT']);
    const r = await env.req('GET', '/v1/referentiel/modele-donnees', 'u-auditeur');
    expect(r.statusCode).toBe(404); // module « référentiel » non chargé dans l'environnement du socle
    const full = buildApp({ clock: new ManualClock('2026-09-26T09:00:00.000Z'), secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
    await full.ready();
    const get = (url: string, user: string) => full.inject({ method: 'GET', url, headers: { 'x-demo-user': user } });
    const dm = (await get('/v1/referentiel/modele-donnees', 'u-auditeur')).json();
    const byCode = Object.fromEntries(dm.entities.map((e: { code: string }) => [e.code, e]));
    expect(byCode.OBJET_FISCAL.counts.actif).toBeGreaterThan(0);
    expect(byCode.CONTRIBUABLE.counts.provisoire + (byCode.CONTRIBUABLE.counts['vérifié'] ?? 0)).toBeGreaterThan(0);
    expect(byCode.OBLIGATION.counts).toBeTruthy();
    expect(byCode.UTILISATEUR.counts.actif).toBeGreaterThan(0);
    expect(byCode.AUDIT.counts['ajout seul']).toBe(full.ctx.audit.length);
    expect(byCode.BAIL.counts).toBeTruthy();
    expect(byCode.QUITTANCE.total).toBeGreaterThanOrEqual(0);
    expect(dm.entities.every((e: { retention: string }) => e.retention.includes('à confirmer'))).toBe(true);
    expect(JSON.stringify(dm)).not.toMatch(/\(démo\)/);
    expect((await get('/v1/referentiel/modele-donnees', 'u-contribuable')).statusCode).toBe(403);

    // Matrice : 16 rôles du Cahier, aucun interdit accordé, chaque faculté câblée.
    expect(ROLE_MATRIX).toHaveLength(16);
    const mx = (await get('/v1/referentiel/matrice-habilitations', 'u-auditeur')).json();
    const breaches = mx.rows.flatMap((row: { cahierRole: string; checks: { role: string; allowedOk: boolean; forbiddenBreaches: string[]; structuralBreaches: string[] }[] }) =>
      row.checks.filter((c) => !c.allowedOk || c.forbiddenBreaches.length || c.structuralBreaches.length).map((c) => `${row.cahierRole}/${c.role}: ${JSON.stringify(c)}`));
    expect(breaches).toEqual([]);
    expect(mx.ok).toBe(true);
    expect(mx.transverse.length).toBeGreaterThanOrEqual(7);
  });

  it('la matrice détecte un interdit accordé (contrôle négatif)', async () => {
    const { definePolicy, GRANTS } = await import('../src/core/policy.js');
    const { roleMatrixView } = await import('../src/plugins/referentiel/matrice-roles.js');
    // Déclaration hostile simulée sur une action d'extension, puis rétablissement (non déclarée ⇒ refusée).
    definePolicy('integrite:case.decide', { R06: GRANTS.always, R21: GRANTS.always, R24: GRANTS.always });
    try {
      const v = roleMatrixView();
      const row = v.rows.find((r) => r.cahierRole === 'Enquêteur anti-fraude')!;
      expect(row.ok).toBe(false);
      expect(row.checks[0]!.forbiddenBreaches).toContain('integrite:case.decide');
      expect(v.ok).toBe(false);
    } finally {
      definePolicy('integrite:case.decide', { R06: GRANTS.always, R21: GRANTS.always });
    }
  });
});

