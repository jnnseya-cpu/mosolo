/**
 * Référentiel des recettes (ch. 7), codes non réutilisables (§ 6.2), IPM (§ 6.3), types de titres « acte requis »
 * (§ 19A.4), verticale Domaine public, modules sectoriels (11, 13, 16, 17/56, 21, 22, 23, 24, 25).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NON_RENSEIGNE, REVENUE_REFERENCE } from '@mosolo/shared';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { referentielPlugin } from '../src/plugins/referentiel/plugin.js';
import { titresPlugin, type TitresService } from '../src/plugins/titres/plugin.js';
import { ACTE_REQUIS_TYPES } from '../src/plugins/titres/catalogue.js';
import { verticalesPlugin, type VerticalesService } from '../src/plugins/verticales/plugin.js';
import { VX_DEMO } from '../src/plugins/verticales/seed.js';
import type { MosoloPlugin } from '../src/plugins/types.js';
import { PROVIDER_SECRET, type TestEnv } from './helpers.js';
import { DEMO } from '../src/seed.js';

async function setup(plugins: MosoloPlugin<unknown>[]): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} }, plugins });
  await app.ready();
  return {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
}

const HASH = 'b'.repeat(64);
const idem = () => ({ 'idempotency-key': randomUUID() });

describe('Référentiel des recettes (Cahier ch. 7)', () => {
  it('4 + 5 + 10 lignes, toutes A_VERIFIER, sans taux ; compétences explicites ; IPM en recette ETD non activée, espace communal distinct', async () => {
    const env = await setup([verticalesPlugin, referentielPlugin]);
    const pub = (await env.req('GET', '/v1/public/referentiel/recettes')).json();
    const count = (s: string) => pub.items.filter((l: { section: string }) => l.section === s).length;
    expect([count('7.1'), count('7.2'), count('7.3')]).toEqual([4, 5, 10]);
    expect(pub.items.every((l: { status: string }) => l.status === 'A_VERIFIER')).toBe(true);
    expect(pub.items.every((l: Record<string, unknown>) => !('rateTable' in l) && !('formula' in l))).toBe(true);
    expect(pub.items.filter((l: { section: string }) => l.section === '7.2').every((l: { competence: string; sharingKey: string }) => l.competence === 'INTERET_COMMUN_CLE' && /non renseignée/.test(l.sharingKey))).toBe(true);
    const ipm = pub.items.find((l: { code: string }) => l.code === 'ETD-IPM');
    expect(ipm).toMatchObject({ revenueCategory: 'RECETTE_ETD', competence: 'ETD', space: 'COMMUNAL', provincialScope: false, activation: { activable: false } });
    expect(pub.spaces.find((s: { id: string }) => s.id === 'COMMUNAL')).toMatchObject({ active: false });
    // Aucune ligne n'est activable tant qu'elle est A_VERIFIER.
    expect(pub.items.some((l: { activation: { activable: boolean } }) => l.activation.activable)).toBe(false);
    // Recettes administratives : chaque ligne est rattachée à une démarche, un acte ou une prestation existants.
    expect(pub.administrative.length).toBeGreaterThan(5);
    expect(pub.administrative.every((a: { linkResolved: boolean; revenueCategory: string }) => a.linkResolved && a.revenueCategory === 'DROIT_ADMINISTRATIF')).toBe(true);
  });

  it('inventaire § 7.4 : « non renseigné » par défaut, jamais inventé ; mise à jour sourcée, tracée ; base de référence § 38.1 consommable', async () => {
    const env = await setup([verticalesPlugin, referentielPlugin]);
    expect((await env.req('GET', '/v1/referentiel/recettes')).statusCode).toBe(401);
    expect((await env.req('GET', '/v1/referentiel/recettes', 'u-contribuable')).statusCode).toBe(403);
    const lines = (await env.req('GET', '/v1/referentiel/recettes', 'u-ministre-finances')).json().items;
    expect(lines).toHaveLength(REVENUE_REFERENCE.length);
    expect(lines[0].inventory.every((a: { value: string }) => a.value === NON_RENSEIGNE)).toBe(true);
    expect((await env.req('POST', '/v1/referentiel/recettes/R71-IF/inventaire', 'u-ministre-finances', { key: 'channel', value: 'non renseigné', source: 'Relevé DGIPK' })).json().code).toBe('VALUE_REQUIRED');
    const up = await env.req('POST', '/v1/referentiel/recettes/R71-IF/inventaire', 'u-ministre-finances', { key: 'administration', value: 'DGIPK', source: 'Organigramme provincial (à certifier)' });
    expect(up.statusCode).toBe(200);
    expect(up.json().inventory.find((a: { key: string }) => a.key === 'administration')).toMatchObject({ value: 'DGIPK', renseigne: true });
    expect((await env.req('POST', '/v1/referentiel/recettes/R71-IF/inventaire', 'u-agent-terrain', { key: 'channel', value: 'Banque', source: 'Relevé bancaire' })).statusCode).toBe(403);
    const base = (await env.req('GET', '/v1/referentiel/base-de-reference', 'u-auditeur')).json();
    expect(base.consumer).toMatch(/38\.1/);
    expect(base.items.find((i: { code: string }) => i.code === 'ETD-IPM')).toBeUndefined();
    const irf = base.items.find((i: { code: string }) => i.code === 'R71-IF');
    expect(irf).toMatchObject({ realisationsPriorYears: NON_RENSEIGNE, readyForBaseline: false, completeness: { filled: 1 } });
    expect(env.app.ctx.audit.list({ limit: 1e6 }).items.some((a) => a.action === 'referentiel.inventory.updated')).toBe(true);
  });

  it('codes de recette stables : un code retiré n’est jamais réutilisé ; un code porté par une règle ACTIVE ne se retire pas', async () => {
    const env = await setup([verticalesPlugin, referentielPlugin]);
    const r = await env.req('POST', '/v1/referentiel/codes', 'u-juriste-redacteur', { code: 'R73-TEST-NOUVEAU', label: 'Recette de test' });
    expect(r.statusCode).toBe(201);
    expect((await env.req('POST', '/v1/referentiel/codes', 'u-juriste-redacteur', { code: 'R73-TEST-NOUVEAU', label: 'Doublon' })).json().code).toBe('CODE_ALREADY_ASSIGNED');
    expect((await env.req('POST', '/v1/referentiel/codes/R73-TEST-NOUVEAU/retrait', 'u-juriste-redacteur', { motif: 'Retrait par le rédacteur' })).statusCode).toBe(403);
    const ret = await env.req('POST', '/v1/referentiel/codes/R73-TEST-NOUVEAU/retrait', 'u-autorite-publication', { motif: 'Recette abandonnée par décision' });
    expect(ret.json().status).toBe('RETIRE');
    const reuse = await env.req('POST', '/v1/referentiel/codes', 'u-juriste-redacteur', { code: 'r73-test-nouveau', label: 'Réemploi' });
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json().code).toBe('CODE_RETIRED_NOT_REUSABLE');
    // Un code du registre des règles (règle fictive ACTIVE de la démo) est déjà attribué et ne se retire pas.
    expect((await env.req('POST', '/v1/referentiel/codes', 'u-juriste-redacteur', { code: 'DEMO-VX-MCH-ETAL', label: 'Réemploi interdit' })).json().code).toBe('CODE_ALREADY_ASSIGNED');
        const svc = env.app.ctx.ext.referentiel as { codes: { insert: (c: unknown) => unknown } };
    svc.codes.insert({ id: 'DEMO-VX-EVT-SPEC', code: 'DEMO-VX-EVT-SPEC', label: 'x', origin: 'RESERVATION', status: 'ACTIF', reservedBy: 't', reservedAt: 't' });
    expect((await env.req('POST', '/v1/referentiel/codes/DEMO-VX-EVT-SPEC/retrait', 'u-autorite-publication', { motif: 'Tentative de retrait' })).json().code).toBe('CODE_IN_USE_BY_ACTIVE_RULE');
  });
});

describe('Catalogue des titres § 19A.4 — types amorcés ACTE_REQUIS', () => {
  it('vignette, TSCR, licences, patente, péage, bon de carrière, embarquement et accostage : visibles, non activables, sans tarif', async () => {
    const env = await setup([titresPlugin]);
    const types = (await env.req('GET', '/v1/titres/types')).json() as { code: string; activable: boolean; legalAct: { status: string }; price: { amount: unknown } }[];
    for (const code of ['VIG-ANNUELLE', 'TSC-ANNUELLE', 'LIC-TAXI', 'LIC-BUS', 'LIC-MOTO', 'PAT-ANNUELLE', 'PEA-PASSAGE', 'PEA-CARNET', 'PEA-ABONNEMENT', 'CAR-BON', 'EMB-CARTE', 'ACC-ACCOSTAGE']) {
      const t = types.find((x) => x.code === code)!;
      expect(t, code).toBeTruthy();
      expect(t).toMatchObject({ activable: false, legalAct: { status: 'ACTE_REQUIS' } });
      expect(t.price.amount).toBeNull();
    }
    expect(ACTE_REQUIS_TYPES.every((t) => !t.pricing)).toBe(true);
    const titres = env.app.ctx.ext.titres as TitresService;
    expect(() => titres.purchase(env.app.ctx.users.get('u-contribuable')!, {
      payerTaxpayerId: DEMO.taxpayerId, channel: 'MOBILE_MONEY', items: [{ typeCode: 'VIG-ANNUELLE', subject: { plate: 'KN-1234-AB' }, place: { commune: 'Gombe', sourceId: 'x', label: 'x', basis: 'ZONE_SERVICE' } }],
    })).toThrow(/Acte requis/);
  });
});

describe('Domaine public (MOSOLO Public Domain) — 17e verticale', () => {
  it('occupation permanente : dépôt, visite conforme, proposition, décision distincte → emprise, certificat sans échéance, plaque d’emprise, plan', async () => {
    const env = await setup([verticalesPlugin]);
    const detail = (await env.req('GET', '/v1/verticales/domaine-public')).json();
    expect(detail).toMatchObject({ name: 'Domaine public (MOSOLO Public Domain)', modules: [19, 20], legal: 'BASE_A_CERTIFIER' });
    const c = (await env.req('POST', '/v1/verticales/domaine-public/cases', 'u-contribuable', {
      type: 'DEMANDE_OCCUPATION_PERMANENTE', details: { usage: 'Kiosque fixe', surface_m2: '6', debut: '2026-10-01', commune: 'Gombe', quartier: 'Commerce' }, documents: [{ label: 'Plan', sha256: HASH }],
    }, idem())).json();
    expect(c.status).toBe('DEPOSE');
    const inst = VX_DEMO.users.instructor;
    await env.req('POST', `/v1/verticales/cases/${c.id}/take`, inst);
    expect((await env.req('POST', `/v1/verticales/cases/${c.id}/propose`, inst, { outcome: 'ACCEPTER', reason: 'Dossier complet et conforme' })).json().code).toBe('CONDITIONS_UNMET');
    await env.req('POST', `/v1/verticales/cases/${c.id}/visits`, VX_DEMO.users.fieldAgent, { date: '2026-09-26', result: 'CONFORME', observations: 'Emprise conforme au plan' });
    expect((await env.req('POST', `/v1/verticales/cases/${c.id}/propose`, inst, { outcome: 'ACCEPTER', reason: 'Dossier complet et conforme' })).statusCode).toBe(200);
    const dec = (await env.req('POST', `/v1/verticales/cases/${c.id}/decide`, VX_DEMO.users.chief, { decision: 'ACCEPTE', reason: 'Occupation compatible avec la voie' })).json();
    expect(dec.certificateCode).toMatch(/^OCP-/);
    const obj = env.app.ctx.objects.get(dec.createdObjectId);
    expect(obj.attributes.objectType).toBe('EMPRISE_PERMANENTE');
    const cert = (await env.req('GET', `/v1/public/verticales/certificates/${dec.certificateCode}`)).json();
    expect(cert).toMatchObject({ authentique: true, validUntil: null, statut: 'A_VENIR' });
    const plate = await env.req('POST', '/v1/verticales/plates', VX_DEMO.users.fieldAgent, { objectId: obj.id });
    expect(plate.json().code).toMatch(/^DPB-GMB-/);
    const plan = (await env.req('GET', '/v1/verticales/domaine-public/emprises', VX_DEMO.users.chief)).json().items;
    expect(plan.find((p: { objectId: string }) => p.objectId === obj.id)).toMatchObject({ objectType: 'EMPRISE_PERMANENTE', authorization: { code: dec.certificateCode } });
    expect((await env.req('GET', '/v1/verticales/domaine-public/emprises', 'u-contribuable')).statusCode).toBe(403);
    // Espace de l'usager : l'emprise relève de la verticale Domaine public.
    const space = (await env.req('GET', '/v1/verticales/domaine-public/space', 'u-contribuable')).json();
    expect(space.objects.map((o: { id: string }) => o.id)).toContain(obj.id);
  });
});

describe('Modules sectoriels « acte requis » (11, 13, 16, 17/56, 21, 22, 23, 24, 25)', () => {
  it('catalogue : chaque module sous ACTE_REQUIS, types de titres non activables, références [EXEMPLE]', async () => {
    const env = await setup([titresPlugin, verticalesPlugin]);
    const items = (await env.req('GET', '/v1/verticales/secteurs')).json().items as { module: string; legal: string; credentialTypes: { activable: boolean }[]; counts: { references: number } }[];
    expect(items.map((m) => m.module)).toEqual(['11', '13', '16', '17', '21', '22', '23', '24', '25', '56']);
    expect(items.every((m) => m.legal === 'ACTE_REQUIS' && m.credentialTypes.every((t) => !t.activable))).toBe(true);
    expect(items.find((m) => m.module === '25')!.counts.references).toBeGreaterThan(0);
  });

  it('boissons et tabac : déclaration mensuelle, données d’accises sous protocole, rapprochement puis décision par une autre personne ; aucun montant', async () => {
    const env = await setup([titresPlugin, verticalesPlugin]);
    const d = await env.req('POST', '/v1/verticales/secteurs/declarations', 'u-contribuable', { kind: 'VOLUMES_BAT', period: '2026-08', lines: { biere_litres: '1000' } });
    expect(d.statusCode).toBe(201);
    const decl = d.json();
    expect(decl.liquidation.status).toBe('ACTE_REQUIS');
    expect((await env.req('POST', '/v1/verticales/secteurs/declarations', 'u-contribuable', { kind: 'VOLUMES_BAT', period: '2026-08', lines: { biere_litres: '900' } })).json().code).toBe('DECLARATION_EXISTS');
    expect((await env.req('POST', '/v1/verticales/secteurs/declarations', 'u-contribuable', { kind: 'VOLUMES_BAT', period: '2026-12', lines: { biere_litres: '1' } })).json().code).toBe('FUTURE_PERIOD');
    // Un agent de terrain ne verse pas de données d'accises ; le partenaire de données, oui.
    expect((await env.req('POST', '/v1/verticales/secteurs/donnees-tierces', VX_DEMO.users.fieldAgent, { module: '17', source: 'ACCISES', taxpayerId: DEMO.taxpayerId, period: '2026-08', lines: { biere_litres: '1200' } })).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/verticales/secteurs/donnees-tierces', VX_DEMO.users.airport, { module: '17', source: 'ACCISES', taxpayerId: DEMO.taxpayerId, period: '2026-08', lines: { biere_litres: '1200' }, fileSha256: HASH })).statusCode).toBe(201);
    const rec = (await env.req('POST', `/v1/verticales/secteurs/declarations/${decl.id}/rapprochement`, VX_DEMO.users.instructor)).json();
    expect(rec.status).toBe('ECART_A_INSTRUIRE');
    expect(rec.reconciliation.bySource.find((s: { source: string }) => s.source === 'ACCISES').gaps.biere_litres).toBe('200');
    expect(rec.reconciliation.proposal).toBe('OUVRIR_CONTRADICTOIRE');
    await env.req('POST', `/v1/verticales/secteurs/declarations/${decl.id}/observations`, 'u-contribuable', { text: 'Pertes en entrepôt justifiées par procès-verbal', documents: [HASH] });
    const decided = (await env.req('POST', `/v1/verticales/secteurs/declarations/${decl.id}/decision`, VX_DEMO.users.chief, { decision: 'OUVRIR_CONTRADICTOIRE', motif: 'Écart à instruire avec le redevable' })).json();
    expect(decided.status).toBe('EN_CONTRADICTOIRE');
    expect(env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId).some((o) => o.label.includes('bière'))).toBe(false);
    // Le déclarant voit sa déclaration ; un autre contribuable non.
    expect((await env.req('GET', `/v1/verticales/secteurs/declarations/${decl.id}`, 'u-contribuable')).statusCode).toBe(200);
    expect((await env.req('GET', `/v1/verticales/secteurs/declarations/${decl.id}`, 'u-locataire')).statusCode).toBe(403);
  });

  it('séparation : la personne qui rapproche ne décide pas (refus journalisé) ; grands redevables désignés avec motif', async () => {
    const env = await setup([titresPlugin, verticalesPlugin]);
    env.app.ctx.users.add({ id: 'vx-controleur-chef', name: 'Contrôleur et chef (démo)', roles: ['R11', 'R07'], entity: 'DGTK' });
    const decl = (await env.req('POST', '/v1/verticales/secteurs/declarations', 'u-contribuable', { kind: 'PFNL', period: '2026-09', lines: { quantite_kg: '50' } })).json();
    const rec = (await env.req('POST', `/v1/verticales/secteurs/declarations/${decl.id}/rapprochement`, 'vx-controleur-chef')).json();
    expect(rec.status).toBe('SANS_DONNEE_TIERCE');
    const same = await env.req('POST', `/v1/verticales/secteurs/declarations/${decl.id}/decision`, 'vx-controleur-chef', { decision: 'VALIDER', motif: 'Validation par la même personne' });
    expect(same.json().code).toBe('SEPARATION_OF_DUTIES');
    expect(env.app.ctx.audit.list({ limit: 1e6 }).items.some((a) => a.action === 'verticales.sector.decision.refused')).toBe(true);
    const g = await env.req('POST', '/v1/verticales/secteurs/grands-redevables', VX_DEMO.users.chief, { taxpayerId: DEMO.taxpayerId, sectors: ['17', '56'], motif: 'Brasserie à fort enjeu (démonstration)' });
    expect(g.statusCode).toBe(201);
    const list = (await env.req('GET', '/v1/verticales/secteurs/grands-redevables', VX_DEMO.users.chief)).json().items;
    expect(list[0]).toMatchObject({ taxpayerId: DEMO.taxpayerId, status: 'SUIVI', declarations: 1 });
  });

  it('carrières : sorties de camions comptées par l’agent (bon de sortie : acte requis, aucun constat), rapprochées de la déclaration', async () => {
    const env = await setup([titresPlugin, verticalesPlugin]);
    const owner = env.app.ctx.users.get('u-contribuable')!;
    const site = env.app.ctx.objects.create(owner, { taxpayerId: DEMO.taxpayerId, category: 'AUTRE', commune: 'Ngaliema', quartier: 'Binza', localityRank: 2, lat: -4.35, lon: 15.24, attributes: { objectType: 'CARRIERE', nom: 'Carrière de test', verticale: 'construction' } });
    const d = (await env.req('POST', '/v1/verticales/secteurs/declarations', 'u-contribuable', { kind: 'SORTIES_CARRIERE', objectId: site.id, period: '2026-09', lines: { camions: '1', volume_m3: '10' } })).json();
    for (const plate of ['KN-1111-AA', 'KN-2222-BB']) {
      const o = await env.req('POST', '/v1/verticales/secteurs/22/releves', VX_DEMO.users.fieldAgent, { source: 'COMPTAGE_SORTIES', objectId: site.id, plate, lines: { camions: '1' } });
      expect(o.statusCode).toBe(201);
      expect(o.json().titleCheck.status).toBe('ACTE_REQUIS');
    }
    expect((await env.req('POST', '/v1/verticales/secteurs/22/releves', VX_DEMO.users.fieldAgent, { source: 'PASSAGE_PEAGE', objectId: site.id, lines: { passages: '1' } })).json().code).toBe('SOURCE_NOT_APPLICABLE');
    expect((await env.req('POST', '/v1/verticales/secteurs/22/releves', 'u-agent-gombe', { source: 'COMPTAGE_SORTIES', objectId: site.id, lines: { camions: '1' } })).statusCode).toBe(403);
    const rec = (await env.req('POST', `/v1/verticales/secteurs/declarations/${d.id}/rapprochement`, VX_DEMO.users.instructor)).json();
    expect(rec.reconciliation.bySource[0]).toMatchObject({ source: 'COMPTAGE_SORTIES', records: 2, observed: { camions: '2' }, gaps: { camions: '1' } });
    expect(rec.status).toBe('ECART_A_INSTRUIRE');
    const pa = await env.req('POST', '/v1/verticales/secteurs/25/releves', VX_DEMO.users.fieldAgent, { source: 'PASSAGE_PEAGE', referenceId: 'AXE-EX-02', plate: 'KN-3333-CC', lines: { passages: '1' } });
    expect(pa.json()).toMatchObject({ commune: 'Nsele', titleCheck: { status: 'ACTE_REQUIS' } });
  });

  it('véhicule contrôlé par plaque : réponse minimale (ni nom ni adresse), types vignette/TSCR/péage non activables ; mutation déclarée', async () => {
    const env = await setup([titresPlugin, verticalesPlugin]);
    const vx = env.app.ctx.ext.verticales as VerticalesService;
    const vehicle = env.app.ctx.objects.objects.find((o) => o.category === 'VEHICULE' && o.taxpayerId === DEMO.taxpayerId)[0]!;
    const plate = String(vehicle.attributes.plaque ?? vehicle.attributes.immatriculation);
    const r = await env.req('GET', `/v1/verticales/vehicules/${encodeURIComponent(plate)}/controle?commune=Gombe`, VX_DEMO.users.fieldAgent);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.registered).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/Mbuyi|TP-DEMO/);
    expect(body.credentialTypes.map((t: { code: string }) => t.code)).toEqual(expect.arrayContaining(['VIG-ANNUELLE', 'TSC-ANNUELLE', 'PEA-PASSAGE']));
    expect(body.credentialTypes.every((t: { activable: boolean }) => !t.activable)).toBe(true);
    expect((await env.req('GET', `/v1/verticales/vehicules/${encodeURIComponent(plate)}/controle?commune=Gombe`, 'u-contribuable')).statusCode).toBe(403);
    const m = await env.req('POST', '/v1/verticales/mobilite/cases', 'u-contribuable', { type: 'DECLARATION_MUTATION', objectId: vehicle.id, details: { nouveauProprietaire: 'Acheteur fictif', dateMutation: '2026-09-20' }, documents: [{ label: 'Acte', sha256: HASH }] }, idem());
    expect(m.statusCode).toBe(201);
    expect((await env.req('GET', `/v1/verticales/vehicules/${encodeURIComponent(plate)}/controle?commune=Gombe`, VX_DEMO.users.fieldAgent)).json().mutationPending).toBe(true);
    expect(vx.secteurs.observations.count()).toBe(0);
  });

  it('spectacles : la déclaration de billetterie en ligne alimente la billetterie de l’événement ; antennes : liquidation annuelle proposée seulement', async () => {
    const env = await setup([titresPlugin, verticalesPlugin]);
    const vx = env.app.ctx.ext.verticales as VerticalesService;
    const ev = env.app.ctx.objects.create(env.app.ctx.users.get('u-contribuable')!, { taxpayerId: DEMO.taxpayerId, category: 'AUTRE', commune: 'Gombe', quartier: 'Commerce', localityRank: 1, lat: -4.3, lon: 15.3, attributes: { objectType: 'EVENEMENT', verticale: 'evenements', nom: 'Concert de test' } });
    {
      const c = await env.req('POST', '/v1/verticales/evenements/cases', 'u-contribuable', { type: 'DECLARATION_BILLETTERIE', objectId: ev.id, details: { billetsVendus: '320' }, documents: [] }, idem());
      expect(c.statusCode, c.body).toBe(201);
      expect(vx.ticketing.findOne((t) => t.eventObjectId === ev.id)?.ticketsSold).toBe(320);
    }
    const a = (await env.req('GET', '/v1/verticales/secteurs/antennes/liquidation-annuelle?exercice=2026', VX_DEMO.users.chief)).json();
    expect(a.rule.status).toBe('ACTE_REQUIS');
    expect(a.operators.length).toBeGreaterThan(0);
    expect(a.notice).toMatch(/jamais automatique/);
  });
});
