/**
 * Départements, modules et variables (27/09/2026, § 12A) — rattachement de modules fonctionnels et de variables aux
 * entités : historique, seconde validation des modules porteurs de recettes (circuit existant des fiches), périmètre
 * de l'administrateur d'entité (R08, son sous-arbre), menu reflétant les rattachements, cloisonnement des données par
 * entité, résolution des variables (entité → parente → globale), refus des surcharges non modulables et des variables
 * de barème juridique (registre des règles, quatre visas).
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { securityNum } from '../src/plugins/integrite/gouvernance/parametres-securite.js';
import type { AccesService } from '../src/plugins/acces/service.js';
import type { TestEnv } from './helpers.js';

async function fullApp(): Promise<TestEnv & { mfa: (u: string) => Promise<void> }> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} } });
  await app.ready();
  const req: TestEnv['req'] = (method, url, user, body, headers = {}) => app.inject({
    method: method as 'GET', url,
    headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  const done = new Set<string>();
  const mfa = async (user: string) => {
    if (done.has(user)) return;
    const c = await req('POST', '/v1/acces/mfa/challenge', user);
    const msgs = (await req('GET', `/v1/acces/sandbox/outbox?to=${encodeURIComponent(`app:${user}`)}`)).json().items as { text: string }[];
    const code = /(\d{6})/.exec(msgs[0]!.text)![1]!;
    expect((await req('POST', '/v1/acces/mfa/verify', user, { challengeId: c.json().challengeId, code })).statusCode).toBe(200);
    done.add(user);
  };
  return { app, clock, req, mfa };
}

const ADMIN_LIMETE = 'acces-u-admin-limete';
const hidden = async (env: TestEnv, user: string) => (await env.req('GET', '/v1/acces/menu-rattachements', user)).json().hiddenPaths as string[];

describe('Catalogue des modules rattachables', () => {
  it('codes stables : 81 modules de la spécification et les verticales ; recettes, écrans, versions, fiches liées', async () => {
    const env = await fullApp();
    const cat = (await env.req('GET', '/v1/acces/catalogue-modules', 'u-superadmin')).json().items as { code: string; kind: string; revenue: boolean; versions: string[]; fiches: { code: string }[]; linkable: boolean }[];
    expect(cat.filter((m) => m.kind === 'MODULE').map((m) => m.code)).toEqual(Array.from({ length: 81 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`));
    expect(cat.filter((m) => m.kind === 'VERTICALE').length).toBeGreaterThanOrEqual(16);
    expect(cat.find((m) => m.code === 'M79')!.fiches.map((f) => f.code)).toContain('IF-DEMO');
    expect(cat.find((m) => m.code === 'M38')!.revenue).toBe(false);
    expect(cat.find((m) => m.code === 'M14')!.revenue).toBe(true);
    expect(cat.find((m) => m.code === 'M74')!.linkable).toBe(false);
    expect(cat.find((m) => m.code === 'M29')!.versions).toContain('V1.0');
    expect((await env.req('GET', '/v1/acces/catalogue-modules', 'u-contribuable')).statusCode).toBe(403);
  });
});

describe('Rattachement d’un module sans recette : une personne, motif, dates, historique complet', () => {
  it('rattache puis détache avec historique et journal ; doublon refusé ; module transverse non rattachable', async () => {
    const env = await fullApp();
    await env.mfa('u-superadmin');
    const body = { moduleCode: 'M38', motif: 'Gestion documentaire ouverte à la commune (test)', from: '2026-09-26', to: '2027-09-26' };
    const a = await env.req('POST', '/v1/acces/departements/COMMUNE-LIMETE/modules', 'u-superadmin', body);
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json()).toMatchObject({ effect: 'EN_VIGUEUR', link: { status: 'ACTIF', revenue: false, circuit: 'DIRECT' } });
    expect((await env.req('POST', '/v1/acces/departements/COMMUNE-LIMETE/modules', 'u-superadmin', body)).json().code).toBe('ALREADY_ATTACHED');
    expect((await env.req('POST', '/v1/acces/departements/COMMUNE-LIMETE/modules', 'u-superadmin', { ...body, moduleCode: 'M74' })).json().code).toBe('MODULE_NOT_LINKABLE');
    expect((await env.req('POST', '/v1/acces/departements/COMMUNE-LIMETE/modules', 'u-superadmin', { ...body, motif: '' })).statusCode).toBe(400);
    const d = await env.req('POST', '/v1/acces/departements/COMMUNE-LIMETE/modules/M38/detachement', 'u-superadmin', { motif: 'Fin de l’ouverture (test)' });
    expect(d.json().link.status).toBe('DETACHE');
    const hist = (await env.req('GET', '/v1/acces/departements/liens?entity=COMMUNE-LIMETE&module=M38', 'u-superadmin')).json().items;
    expect(hist).toHaveLength(1);
    expect(hist[0].history.map((h: { action: string }) => h.action)).toEqual(['RATTACHE', 'DETACHE']);
    expect(env.app.ctx.audit.list({ action: 'acces.departement.module_attached' }).total).toBe(1);
    expect(env.app.ctx.audit.list({ action: 'acces.departement.module_detached' }).total).toBe(1);
    expect((await env.req('POST', '/v1/acces/departements/COMMUNE-LIMETE/modules/M38/detachement', 'u-superadmin', { motif: 'Encore (test)' })).json().code).toBe('NOT_ATTACHED');
  });

  it('second facteur exigé ; rôle non habilité refusé', async () => {
    const env = await fullApp();
    const body = { moduleCode: 'M38', motif: 'Essai sans second facteur (test)' };
    expect((await env.req('POST', '/v1/acces/departements/COMMUNE-LIMETE/modules', 'u-superadmin', body)).json().code).toBe('MFA_REQUIRED');
    expect((await env.req('POST', '/v1/acces/departements/COMMUNE-LIMETE/modules', 'u-controleur', body)).statusCode).toBe(403);
  });
});

describe('Module porteur de recettes : circuit EXISTANT des fiches, seconde validation par une personne distincte', () => {
  it('réattribution d’une compétence active : proposée par R26, refusée à l’auteur, décidée par le Gouverneur ; retrait à deux personnes', async () => {
    const env = await fullApp();
    await env.mfa('u-superadmin');
    const noAct = await env.req('POST', '/v1/acces/departements/DGTK/modules', 'u-superadmin', { moduleCode: 'M79', motif: 'Transfert de la plaque NFIU (test)' });
    expect(noAct.json().code).toBe('ACT_REFERENCE_REQUIRED');
    const a = await env.req('POST', '/v1/acces/departements/DGTK/modules', 'u-superadmin', { moduleCode: 'M79', motif: 'Transfert de la plaque NFIU (test)', actReference: 'Arrêté FICTIF n° TEST-79' });
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json()).toMatchObject({ effect: 'SECONDE_VALIDATION_REQUISE', circuit: 'REATTRIBUTION', moduleConfigId: 'MOD-DEMO-IF' });
    const acces = env.app.ctx.ext.acces as AccesService;
    expect(acces.module('MOD-DEMO-IF').responsibleEntity).toBe('DGIPK');
    // Aucun effet tant que la seconde validation n'est pas donnée.
    let view = (await env.req('GET', '/v1/acces/departements/DGTK', 'u-superadmin')).json();
    expect(view.modules.find((m: { code: string }) => m.code === 'M79')).toMatchObject({ attached: false, pending: [{ circuit: 'REATTRIBUTION' }] });
    // L'auteur ne décide pas (le circuit existant réserve la décision au Gouverneur ou au Cabinet).
    expect((await env.req('POST', '/v1/acces/modules/MOD-DEMO-IF/reattachments/decision', 'u-superadmin', { approve: true })).statusCode).toBe(403);
    await env.mfa('u-gouverneur');
    expect((await env.req('POST', '/v1/acces/modules/MOD-DEMO-IF/reattachments/decision', 'u-gouverneur', { approve: true, note: 'Acte vérifié (test)' })).statusCode).toBe(200);
    view = (await env.req('GET', '/v1/acces/departements/DGTK', 'u-superadmin')).json();
    expect(view.modules.find((m: { code: string }) => m.code === 'M79')).toMatchObject({ attached: true, source: 'FICHE' });
    expect(view.history[0]).toMatchObject({ moduleCode: 'M79', status: 'ACTIF' });
    // Retrait : proposé par R26, décidé par une personne distincte habilitée à changer l'état d'une fiche.
    const w = await env.req('POST', '/v1/acces/departements/DGTK/modules/M79/detachement', 'u-superadmin', { motif: 'Retrait de la compétence (test)' });
    expect(w.json()).toMatchObject({ effect: 'SECONDE_VALIDATION_REQUISE', link: { circuit: 'RETRAIT', status: 'EN_ATTENTE' } });
    expect(acces.module('MOD-DEMO-IF').status).toBe('ACTIF');
    expect((await env.req('POST', `/v1/acces/departements/liens/${w.json().link.id}/decision`, 'u-superadmin', { approve: true, note: 'Auto-décision (test)' })).statusCode).toBe(403);
    const dec = await env.req('POST', `/v1/acces/departements/liens/${w.json().link.id}/decision`, 'u-gouverneur', { approve: true, note: 'Retrait décidé (test)' });
    expect(dec.json().status).toBe('DETACHE');
    expect(acces.module('MOD-DEMO-IF').status).toBe('RETIRE');
  });

  it('domaine sans fiche : une fiche en brouillon est créée et suit le circuit (visas, recette, comité) ; R08 ne réattribue pas', async () => {
    const env = await fullApp();
    await env.mfa('u-superadmin');
    const a = await env.req('POST', '/v1/acces/departements/MIN-TRANSPORTS/modules', 'u-superadmin', { moduleCode: 'M16', motif: 'Antennes : compétence du ministère (test)', actReference: 'Arrêté FICTIF n° TEST-16' });
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json()).toMatchObject({ circuit: 'FICHE', effect: 'CIRCUIT_DE_LA_FICHE' });
    const acces = env.app.ctx.ext.acces as AccesService;
    expect(acces.module(a.json().moduleConfigId)).toMatchObject({ status: 'BROUILLON', revenueScope: 'ANTENNES_TELECOM', responsibleEntity: 'MIN-TRANSPORTS' });
    const menu = (await env.req('GET', '/v1/acces/departements/MIN-TRANSPORTS', 'u-superadmin')).json();
    expect(menu.modules.find((m: { code: string }) => m.code === 'M16')).toMatchObject({ attached: false });
    // Administrateur d'entité : la réattribution d'une compétence active reste réservée au circuit de l'administration de la plateforme.
    await env.mfa('u-admin-entite');
    const r08 = await env.req('POST', '/v1/acces/departements/DGIPK/modules', 'u-admin-entite', { moduleCode: 'M14', motif: 'Stationnement (test)', actReference: 'Arrêté FICTIF' });
    expect([403, 409]).toContain(r08.statusCode);
  });
});

describe('Périmètre de l’administrateur d’entité (R08) et cloisonnement des données par entité', () => {
  it('R08 agit dans son sous-arbre seulement ; ne lit ni les liens, ni les comptes, ni les variables d’une autre entité', async () => {
    const env = await fullApp();
    await env.mfa(ADMIN_LIMETE);
    const body = { moduleCode: 'M38', motif: 'Gestion documentaire communale (test)' };
    expect((await env.req('POST', '/v1/acces/departements/COMMUNE-LIMETE/modules', ADMIN_LIMETE, body)).statusCode).toBe(201);
    const out = await env.req('POST', '/v1/acces/departements/DGIPK/modules', ADMIN_LIMETE, body);
    expect(out.json().code).toBe('OUT_OF_PERIMETER');
    expect((await env.req('GET', '/v1/acces/departements/DGIPK', ADMIN_LIMETE)).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/acces/departements/liens?entity=DGIPK', ADMIN_LIMETE)).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/parametres/effectifs?entity=DGIPK', ADMIN_LIMETE)).statusCode).toBe(403);
    const tree = (await env.req('GET', '/v1/acces/departements', ADMIN_LIMETE)).json().items as { id: string }[];
    expect(tree.map((e) => e.id)).toEqual(['COMMUNE-LIMETE']);
    const liens = (await env.req('GET', '/v1/acces/departements/liens', ADMIN_LIMETE)).json().items as { entity: string }[];
    expect(liens.length).toBeGreaterThan(0);
    expect(liens.every((l) => l.entity === 'COMMUNE-LIMETE')).toBe(true);
    // Données d'entité : comptes et journal limités à la commune ; décomptes du référentiel dans le sous-arbre.
    const accounts = (await env.req('GET', '/v1/acces/accounts', ADMIN_LIMETE)).json().items as { entity: string }[];
    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts.every((a) => a.entity === 'COMMUNE-LIMETE')).toBe(true);
    expect((await env.req('GET', '/v1/acces/accounts?entity=DGIPK', ADMIN_LIMETE)).json().items).toEqual([]);
    const types = (await env.req('GET', '/v1/acces/types-de-comptes', ADMIN_LIMETE)).json();
    expect(types.scope).toBe('SOUS_ARBRE');
    expect(types.total).toBe(accounts.reduce((n, a) => n + (a as unknown as { roles: string[] }).roles.length, 0));
    const view = (await env.req('GET', '/v1/acces/departements/COMMUNE-LIMETE', ADMIN_LIMETE)).json();
    expect(view.users.every((u: { id: string }) => accounts.some((a) => (a as unknown as { id: string }).id === u.id))).toBe(true);
    const journal = (await env.req('GET', '/v1/acces/journal', ADMIN_LIMETE)).json().items as { entity: string }[];
    expect(journal.every((j) => j.entity === 'COMMUNE-LIMETE')).toBe(true);
  });
});

describe('Menu reflétant les rattachements (présentation ; le serveur garde les droits)', () => {
  it('un module rattaché à une commune n’apparaît plus qu’à sa lignée ; le détachement le rend à tous ; rôles transverses non concernés', async () => {
    const env = await fullApp();
    expect(await hidden(env, 'u-controleur')).not.toContain('/documents');
    await env.mfa(ADMIN_LIMETE);
    expect((await env.req('POST', '/v1/acces/departements/COMMUNE-LIMETE/modules', ADMIN_LIMETE, { moduleCode: 'M38', motif: 'Gestion documentaire communale (test)' })).statusCode).toBe(201);
    expect(await hidden(env, 'u-controleur')).toContain('/documents');
    const limete = (await env.req('GET', '/v1/acces/menu-rattachements', 'acces-u-controleur-limete')).json();
    expect(limete.hiddenPaths).not.toContain('/documents');
    expect(limete.attachedModules.map((m: { code: string }) => m.code)).toContain('M38');
    expect(await hidden(env, 'u-gouverneur')).not.toContain('/documents');
    // Décisions du maître d'ouvrage : R01 à R03 voient toujours tous les modules (27/09/2026) ; les ministres (R04, R05)
    // ne voient que ceux de leur ministère et des départements de sa tutelle (28/09/2026).
    for (const u of ['u-gouverneur', 'u-dircab', env.app.ctx.users.all().find((x) => x.roles.includes('R03'))!.id]) {
      expect((await env.req('GET', '/v1/acces/menu-rattachements', u)).json()).toMatchObject({ exempt: true, hiddenPaths: [] });
    }
    const minFin = (await env.req('GET', '/v1/acces/menu-rattachements', 'u-ministre-finances')).json();
    expect(minFin).toMatchObject({ exempt: false, perimetre: 'MINISTERE_ET_DEPARTEMENTS' });
    expect(minFin.hiddenPaths).toContain('/documents'); // rattaché à Limete : hors du périmètre du ministère des Finances
    const minTr = (await env.req('GET', '/v1/acces/menu-rattachements', 'u-ministre-transports')).json();
    expect(minTr.hiddenPaths).toContain('/documents');
    // Sans rattachement explicite : tutelle ministérielle par défaut (à confirmer) — stationnement aux Transports, trésor aux Finances.
    const codes = (r: { attachedModules: { code: string }[] }) => r.attachedModules.map((m) => m.code);
    expect(codes(minTr)).toContain('M14');
    expect(codes(minTr)).not.toContain('M29');
    expect(codes(minFin)).toContain('M29');
    expect(codes(minFin)).not.toContain('M14');
    expect(await hidden(env, 'u-auditeur')).toEqual([]);
    expect(await hidden(env, 'u-contribuable')).toEqual([]);
    // Les droits restent ceux du serveur : la route n'est ni ouverte ni fermée par le rattachement.
    const before = (await env.req('GET', '/v1/documents', 'u-controleur')).statusCode;
    expect((await env.req('GET', '/v1/documents', 'u-controleur')).statusCode).toBe(before);
    expect((await env.req('POST', '/v1/acces/departements/COMMUNE-LIMETE/modules/M38/detachement', ADMIN_LIMETE, { motif: 'Fin (test)' })).statusCode).toBe(200);
    expect(await hidden(env, 'u-controleur')).not.toContain('/documents');
  });

  it('rattachement programmé : sans effet avant sa date d’effet', async () => {
    const env = await fullApp();
    await env.mfa('u-superadmin');
    const r = await env.req('POST', '/v1/acces/departements/COMMUNE-LIMETE/modules', 'u-superadmin', { moduleCode: 'M38', motif: 'Ouverture programmée (test)', from: '2026-10-01' });
    expect(r.json().effect).toBe('PROGRAMME');
    expect(await hidden(env, 'u-controleur')).not.toContain('/documents');
    env.clock.advance(6 * 86_400_000);
    expect(await hidden(env, 'u-controleur')).toContain('/documents');
  });
});

describe('Variables par département : résolution entité → parente → globale, circuit à deux personnes', () => {
  it('surcharge d’un ministère héritée par sa régie, surcharge propre de la régie, valeur globale ailleurs ; consommateurs branchés', async () => {
    const env = await fullApp();
    const eff = async (entity: string, id: string) => ((await env.req('GET', `/v1/parametres/effectifs?entity=${entity}&modulables=1`, 'u-superadmin')).json().items as { id: string; value: number; provenance: string; sourceEntity: string | null; pending: unknown[] }[]).find((i) => i.id === id)!;
    const P = 'postes.notifications.plafond_defaut';
    expect(await eff('DGIPK', P)).toMatchObject({ value: 5, provenance: 'GLOBAL' });
    const p1 = await env.req('POST', '/v1/parametres/surcharges', 'u-superadmin', { parameterId: P, entity: 'MINFIN', value: 3, motif: 'Autorités des Finances : trois notifications par jour (test)' });
    expect(p1.statusCode, p1.body).toBe(201);
    expect((await eff('MINFIN', P)).pending).toHaveLength(1);
    expect(await eff('MINFIN', P)).toMatchObject({ value: 5, provenance: 'GLOBAL' });
    // Quatre yeux : l'auteur ne décide pas ; un approbateur du registre (sécurité) décide.
    expect((await env.req('POST', `/v1/integrite/thresholds/change-requests/${p1.json().id}/decision`, 'u-superadmin', { approve: true, motif: 'Auto-approbation interdite (test)' })).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/integrite/thresholds/change-requests/${p1.json().id}/decision`, 'u-rssi', { approve: true, motif: 'Surcharge vérifiée (test)' })).statusCode).toBe(200);
    expect(await eff('MINFIN', P)).toMatchObject({ value: 3, provenance: 'ENTITE', sourceEntity: 'MINFIN' });
    expect(await eff('DGIPK', P)).toMatchObject({ value: 3, provenance: 'ENTITE_PARENTE', sourceEntity: 'MINFIN' });
    expect(await eff('COMMUNE-LIMETE', P)).toMatchObject({ value: 5, provenance: 'GLOBAL' });
    // L'administrateur de la DGIPK propose une valeur propre à sa régie, approuvée par une autre personne (direction).
    const p2 = await env.req('POST', '/v1/parametres/surcharges', 'u-admin-entite', { parameterId: P, entity: 'DGIPK', value: 8, motif: 'Régie : huit notifications par jour (test)', effectiveFrom: '2026-09-26' });
    expect(p2.statusCode, p2.body).toBe(201);
    expect((await env.req('POST', `/v1/integrite/thresholds/change-requests/${p2.json().id}/decision`, 'u-dg-dgipk', { approve: true, motif: 'Valeur de la régie approuvée (test)' })).statusCode).toBe(200);
    expect(await eff('DGIPK', P)).toMatchObject({ value: 8, provenance: 'ENTITE' });
    expect(await eff('MINFIN', P)).toMatchObject({ value: 3 });
    // Consommateur branché (postes : plafond de notifications par autorité) : deux entités, deux valeurs.
    const postes = env.app.ctx.ext.postes as { plafond(userId: string): number };
    expect(postes.plafond('u-dg-dgipk')).toBe(8);
    expect(postes.plafond('u-ministre-finances')).toBe(3);
    expect(postes.plafond('u-gouverneur')).toBe(5);
    // Registre global inchangé ; la valeur globale reste la référence des entités sans surcharge.
    const reg = (await env.req('GET', '/v1/integrite/thresholds', 'u-rssi')).json().entries.find((e: { id: string }) => e.id === P);
    expect(reg).toMatchObject({ value: 5, pendingRequest: null });
  });

  it('date d’effet future : appliquée seulement à compter de cette date ; consommateur de sécurité (DLP) par entité', async () => {
    const env = await fullApp();
    const P = 'dlp.lectures_max';
    const p = await env.req('POST', '/v1/parametres/surcharges', 'u-superadmin', { parameterId: P, entity: 'COMMUNE-LIMETE', value: 50, effectiveFrom: '2026-10-01', motif: 'Commune pilote : seuil DLP abaissé (test)' });
    expect(p.statusCode, p.body).toBe(201);
    expect((await env.req('POST', `/v1/integrite/thresholds/change-requests/${p.json().id}/decision`, 'u-rssi', { approve: true, motif: 'Approuvé (test)' })).statusCode).toBe(200);
    expect(securityNum(env.app.ctx, P, 'COMMUNE-LIMETE')).toBe(200);
    const programmed = ((await env.req('GET', '/v1/parametres/effectifs?entity=COMMUNE-LIMETE&modulables=1', 'u-superadmin')).json().items as { id: string; programmed: unknown[] }[]).find((i) => i.id === P)!;
    expect(programmed.programmed).toHaveLength(1);
    env.clock.advance(6 * 86_400_000);
    expect(securityNum(env.app.ctx, P, 'COMMUNE-LIMETE')).toBe(50);
    expect(securityNum(env.app.ctx, P, 'DGIPK')).toBe(200);
    expect(securityNum(env.app.ctx, P)).toBe(200);
  });

  it('refus : paramètre non modulable, constante du code, variable d’un barème juridique, entité hors périmètre', async () => {
    const env = await fullApp();
    const post = (body: Record<string, unknown>, user = 'u-superadmin') => env.req('POST', '/v1/parametres/surcharges', user, { entity: 'DGIPK', motif: 'Tentative de surcharge (test)', ...body });
    expect((await post({ parameterId: 'collusion.fenetre_jours', value: 30 })).json().code).toBe('PARAMETER_NOT_MODULABLE');
    expect((await post({ parameterId: 'canaux.assist_sur_place_m', value: 10 })).json().code).toBe('PARAMETER_NOT_MODULABLE');
    expect((await post({ parameterId: 'regle:DEMO-IF-BATI:tarif_m2', value: 1 })).json().code).toBe('LEGAL_RULE_VARIABLE');
    const rule = env.app.ctx.rules.list().find((r) => Object.keys(r.rateTable).length > 0)!;
    const key = Object.keys(rule.rateTable)[0]!;
    expect((await post({ parameterId: `${rule.code}:${key}`, value: 1 })).json().code).toBe('LEGAL_RULE_VARIABLE');
    expect((await post({ parameterId: 'postes.notifications.plafond_defaut', value: 1000 })).json().code).toBe('VALUE_OUT_OF_RANGE');
    expect((await post({ parameterId: 'postes.notifications.plafond_defaut', value: 4 }, ADMIN_LIMETE)).json().code).toBe('OUT_OF_PERIMETER');
    expect((await post({ parameterId: 'postes.notifications.plafond_defaut', value: 4 }, 'u-controleur')).statusCode).toBe(403);
    expect(env.app.ctx.audit.list({ action: 'integrite.threshold.entity_override_refused' }).total).toBeGreaterThanOrEqual(4);
  });
});
