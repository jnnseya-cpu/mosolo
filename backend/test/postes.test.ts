/**
 * Postes de décision des autorités (Cahier nouvelle version, ch. 27 ; catalogue n° 41 à 44) : corbeille par rôle et
 * périmètre, seuils de remontée (ancienneté, montant, registre à deux personnes), délégations (limites, expiration,
 * révocation, mention « par délégation de … »), note du lundi, cabinet, secrétariat exécutif, habilitations de
 * consultation, refus d'accès. Application complète (tous les modules), données de démonstration semées.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { CATEGORIES, chiffre, causeEnUnePhrase, estRouteFinanciere, RegleAffichageError, semaineKinshasa } from '../src/plugins/postes/model.js';
import { PARAMETRES_POSTES } from '../src/plugins/postes/parametres.js';
import type { PostesModule } from '../src/plugins/postes/plugin.js';
import { ALL_PARAMETERS } from '../src/plugins/integrite/gouvernance/parametres.js';
import { CIRCUITS } from '../src/plugins/integrite/gouvernance/circuits.js';

const MOTIF = 'Motif détaillé de la décision (test)';

async function full() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
  await app.ready();
  const req = (method: string, url: string, user?: string, body?: unknown) => app.inject({
    method: method as 'GET', url,
    headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  const svc = app.ctx.ext.postes as PostesModule;
  const fiches = async (user: string) => (await req('GET', '/v1/postes/corbeille', user)).json().fiches as { id: string; objet: string; presence: string[]; actions: { code: string; possible: boolean }[]; remontee?: { raisons: string[] }; categorie: { code: string } | null }[];
  const ct = () => `DOSSIER:${svc.dossiers.findOne((d) => d.categorie === 'SUSPENSION_TIERS')!.id}`;
  const assign = () => `DOSSIER:${svc.dossiers.findOne((d) => d.categorie === 'ARBITRAGE_ASSIGNATIONS')!.id}`;
  const finCard = () => `DOSSIER:${svc.dossiers.findOne((d) => d.destinataireRole === 'R05')!.id}`;
  return { app, clock, req, svc, fiches, ct, assign, finCard, ctx: app.ctx };
}
type Env = Awaited<ReturnType<typeof full>>;

const dossierR05 = (montant?: string) => ({
  categorie: 'EXONERATION_DEGREVEMENT', destinataireRole: 'R05', destinataireEntity: 'MINFIN', objet: 'Dégrèvement collectif au-delà du seuil (test)',
  serviceInstructeur: 'DGIPK — contentieux (test)', validationAmont: 'Instruction achevée (test)',
  enjeu: { texte: 'Dégrèvement collectif (test)', etat: 'CONSTATE', ...(montant ? { montant: { amount: montant, currency: 'CDF' } } : {}), nombre: '12 contribuables' },
  echeance: '2026-10-20', consequenceSilence: 'Les avis restent exigibles (test).', fondement: ['Instrument fictif de démonstration — article 1 (test)'],
  position: { recommandation: 'Dégrèvement recommandé (test).', reserves: [] }, siRien: 'Les avis restent exigibles (test).', pieces: [],
  execution: { acte: 'DECISION', libelle: 'Décision de dégrèvement (test)', responsable: { entity: 'DGIPK', role: 'R06', libelle: 'DGIPK' }, delaiJours: 5 },
  individuel: false, entities: ['DGIPK'],
});

describe('Postes de décision — référentiel, catalogue n° 41 à 44, règles d’affichage', () => {
  it('référentiel : dix catégories, budgets d’attention, trois écrans, anciens noms conservés en alias', async () => {
    const env = await full();
    const r = (await env.req('GET', '/v1/postes/referentiel', 'u-gouverneur')).json();
    expect(r.categories).toHaveLength(10);
    expect(r.catalogue.map((c: { numero: number; nom: string; ancienNom: string }) => [c.numero, c.nom, c.ancienNom])).toEqual([
      [41, 'Postes de décision des autorités', 'Centre de commandement exécutif'], [42, 'Poste de travail — régie fiscale', 'Tableau de bord régie fiscale'],
      [43, 'Poste de travail — régie des taxes', 'Tableau de bord régie des taxes'], [44, 'Postes ministériels', 'Tableaux de bord ministériels'],
    ]);
    expect(r.budgets.find((b: { profil: string }) => b.profil === 'GOUVERNEUR')).toMatchObject({ temps: '60 à 90 secondes', support: 'Téléphone' });
    expect(r.troisEcrans.map((e: { code: string }) => e.code)).toEqual(['DECIDER', 'SITUER', 'COMPRENDRE']);
    expect(r.menus.GOUVERNEUR.map((m: { libelle: string }) => m.libelle)).toEqual(['Décisions', 'Recettes', 'Alertes', 'Communes', 'Rechercher']);
    expect(CATEGORIES.every((c) => PARAMETRES_POSTES.some((p) => p.id === c.seuil))).toBe(true);
  });

  it('§ 27.10 : un chiffre sans état, sans comparaison, sans taux ou avec une source trop profonde est refusé ; cause en une phrase', () => {
    const base = { code: 'X', libelle: 'X', valeur: '1', unite: 'CDF', etat: 'ENCAISSE' as const, estimation: false, date: '2026-09-26T09:00:00Z', comparaison: { type: 'OBJECTIF' as const, libelle: 'o', valeur: null, ecart: null, tendance: 'INDISPONIBLE' as const }, source: { libelle: 's', chemin: ['/a'], api: '/x' } };
    expect(chiffre(base).etatLabel).toBe('Encaissé');
    expect(() => chiffre({ ...base, etat: '' as never })).toThrow(RegleAffichageError);
    expect(() => chiffre({ ...base, comparaison: undefined as never })).toThrow(/comparaison/);
    expect(() => chiffre({ ...base, equivalents: { CDF: '1', USD: '0' } })).toThrow(/taux/);
    expect(() => chiffre({ ...base, source: { libelle: 's', chemin: ['/a', '/b', '/c', '/d'], api: '/x' } })).toThrow(/trois niveaux/);
    expect(() => chiffre({ ...base, etat: 'POTENTIEL_ESTIME' })).toThrow(/estimation/);
    expect(() => chiffre({ ...base, etat: 'POTENTIEL_ESTIME', estimation: true })).toThrow(/hypothèses/);
    expect(causeEnUnePhrase('Écart de 3 jours sur le canal mobile. Détail : appeler le +243 810 000 001.')).toBe('Écart de 3 jours sur le canal mobile.');
    expect(causeEnUnePhrase('Contact +243810000001 injoignable')).not.toMatch(/243810000001/);
    expect(semaineKinshasa('2026-09-26')).toEqual({ lundi: '2026-09-21', dimanche: '2026-09-27', code: '2026-S39' });
  });

  it('registre des seuils : paramètres des postes enregistrés PAR_DEFAUT ; circuit des dossiers d’orientation au catalogue des quatre yeux', () => {
    for (const p of PARAMETRES_POSTES) expect(ALL_PARAMETERS.find((x) => x.id === p.id)).toMatchObject({ owner: 'REGISTRE' });
    expect(CIRCUITS.some((c) => c.code === 'POSTES_DOSSIER_ORIENTATION')).toBe(true);
  });
});

describe('Corbeille — agrégation par rôle et par périmètre (lecture seule des modules)', () => {
  it('le Gouverneur, le ministre des Finances, le ministre des Transports et le cabinet voient chacun leur périmètre', async () => {
    const env = await full();
    const gouv = await env.fiches('u-gouverneur');
    expect(gouv.map((f) => f.id)).toEqual(expect.arrayContaining([env.ct(), env.assign()]));
    expect(gouv.find((f) => f.id === env.ct())!.presence).toContain('DECIDEUR');
    // Dossiers incomplet ou à instruire : jamais présentés au Gouverneur (fondement manquant, non transmis).
    expect(gouv.some((f) => /société immobilière|taxe antennes/.test(f.objet))).toBe(false);
    const fin = await env.fiches('u-ministre-finances');
    expect(fin.map((f) => f.id)).toContain(env.finCard());
    expect(fin.map((f) => f.id)).not.toContain(env.ct());
    const transp = await env.fiches('vc-u-ministre-transports');
    const ctT = transp.find((f) => f.id === env.ct())!;
    expect(ctT.presence).toEqual(['NIVEAU_HABITUEL']);
    expect(ctT.actions.find((a) => a.code === 'APPROUVER')!.possible).toBe(false);
    expect(transp.map((f) => f.id)).not.toContain(env.finCard());
    // Fiche d'un autre ministère : introuvable (ABAC), jamais une erreur de droit révélant son existence.
    expect((await env.req('GET', `/v1/postes/fiches/${encodeURIComponent(env.finCard())}`, 'vc-u-ministre-transports')).statusCode).toBe(404);
    const cab = (await env.req('GET', '/v1/postes/vues/instruction', 'u-dircab')).json();
    expect(cab.items.map((i: { etat: string }) => i.etat).sort()).toEqual(['A_INSTRUIRE', 'INCOMPLET', 'INSTRUIT', 'INSTRUIT']);
  });

  it('élément d’un module source (assignations) : décideurs selon la source ; approbation relayée à la route existante, quatre yeux conservés', async () => {
    const env = await full();
    const t = (await env.req('POST', '/v1/pilotage/assignations', 'u-validateur-financier', {
      fiscalYear: '2026', label: 'Assignations 2026 (test)', act: { reference: 'CONTRAT-PERF-2026 (fictif)', title: 'Contrat de performance (fictif)' },
      entries: [{ commune: 'Limete', category: 'IMPOT_PROVINCIAL', amount: { amount: '600.00', currency: 'USD' } }],
    })).json();
    const id = `ASSIGNATIONS:${t.id}`;
    expect((await env.fiches('u-gouverneur')).find((f) => f.id === id)!.presence).toContain('DECIDEUR');
    expect((await env.fiches('u-ministre-finances')).find((f) => f.id === id)!.presence).toContain('DECIDEUR');
    expect((await env.fiches('acces-u-sg')).some((f) => f.id === id)).toBe(false);
    const r = await env.req('POST', `/v1/postes/fiches/${encodeURIComponent(id)}/action`, 'u-gouverneur', { action: 'APPROUVER', motif: MOTIF });
    expect(r.statusCode).toBe(200);
    expect(r.json().routeSource).toBe(`POST /v1/pilotage/assignations/${t.id}/certification`);
    expect(r.json().resultatSource.status).toBe('CERTIFIEE');
    const audit = env.ctx.audit.list({ action: 'postes.fiche.approuvee', limit: 5 }).items;
    expect(audit.at(-1)).toMatchObject({ actor: { id: 'u-gouverneur' }, details: { motif: MOTIF, statutSource: 200 } });
    // Le relais emprunte la route de la source : l'importateur n'est jamais certificateur (poste de travail, pas de corbeille).
    const t2 = (await env.req('POST', '/v1/pilotage/assignations', 'u-ministre-finances', {
      fiscalYear: '2027', label: 'Assignations 2027 (test)', act: { reference: 'CONTRAT-PERF-2027 (fictif)', title: 'Contrat (fictif)' },
      entries: [{ commune: 'Gombe', category: '*', amount: { amount: '100.00', currency: 'USD' } }],
    })).json();
    expect((await env.fiches('u-ministre-finances')).some((f) => f.id === `ASSIGNATIONS:${t2.id}`)).toBe(false);
    expect((await env.req('POST', `/v1/postes/fiches/${encodeURIComponent(`ASSIGNATIONS:${t2.id}`)}/action`, 'u-ministre-finances', { action: 'APPROUVER', motif: MOTIF })).statusCode).toBe(404);
  });

  it('poste de travail séparé : la base de référence importée entre dans la file de l’auditeur, pas dans celle de l’importateur', async () => {
    const env = await full();
    const b = await env.req('POST', '/v1/pilotage/base-reference', 'u-ministre-finances', {
      kind: 'COUTS_CONSTATES', label: 'Coûts 2026-T3 (test)', period: '2026-T3', source: { document: 'Comptabilité (fictif)', reference: 'CPT-T3-TEST' },
      entries: [{ metric: 'COUT_COLLECTE', value: '15.00', currency: 'USD' }],
    });
    expect(b.statusCode).toBe(201);
    const id = `BASE:${b.json().id}`;
    const aud = (await env.req('GET', '/v1/postes/travail', 'u-auditeur')).json();
    expect(aud.famille).toBe('POSTE_DE_TRAVAIL');
    expect(aud.file.map((x: { id: string }) => x.id)).toContain(id);
    expect(aud.postes.map((p: { code: string }) => p.code)).toContain('AUDITEUR');
    const imp = (await env.req('GET', '/v1/postes/travail', 'u-ministre-finances')).json();
    expect(imp.file.map((x: { id: string }) => x.id)).not.toContain(id);
    const dg = (await env.req('GET', '/v1/postes/travail', 'u-dg-dgipk')).json();
    expect(dg.corbeille.lien).toBe('/poste-de-decision');
    expect(dg.postes[0]).toMatchObject({ code: 'DIRECTEUR_REGIE', indicateurDominant: 'Écart à l’assignation et couverture du recensement' });
  });

  it('refus d’accès : agent de terrain, contribuable et auditeur n’ont pas de poste de décision ; aucune action sans le droit', async () => {
    const env = await full();
    for (const u of ['u-agent-terrain', 'u-contribuable', 'u-auditeur']) {
      const r = await env.req('GET', '/v1/postes/accueil', u);
      expect(r.statusCode, u).toBe(403);
    }
    expect((await env.req('GET', '/v1/postes/corbeille', 'u-agent-terrain')).statusCode).toBe(403);
    expect((await env.req('POST', `/v1/postes/fiches/${encodeURIComponent(env.ct())}/action`, 'u-agent-terrain', { action: 'APPROUVER', motif: MOTIF })).statusCode).toBe(403);
    expect((await env.req('POST', '/v1/postes/cabinet/ordre-du-jour', 'u-gouverneur', { ficheId: env.ct(), action: 'MONTER', motif: MOTIF })).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/postes/indicateurs', 'u-ministre-finances')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/postes/travail', 'u-agent-terrain')).statusCode).toBe(200);
    expect((await env.req('GET', '/v1/postes/accueil')).statusCode).toBe(401);
  });
});

describe('Seuils de remontée : ancienneté, montant, registre à deux personnes', () => {
  it('ancienneté : au-delà du seuil, la fiche du ministre des Finances remonte au Gouverneur (lecture et relance) sans quitter le ministre', async () => {
    const env = await full();
    expect((await env.fiches('u-gouverneur')).some((f) => f.id === env.finCard())).toBe(false);
    env.clock.set(new Date('2026-10-04T09:00:00.000Z'));
    const g = (await env.fiches('u-gouverneur')).find((f) => f.id === env.finCard())!;
    expect(g.presence).toEqual(['REMONTEE']);
    expect(g.remontee!.raisons.join(' ')).toMatch(/En attente depuis 8 jours/);
    expect(g.actions.find((a) => a.code === 'APPROUVER')!.possible).toBe(false);
    expect(g.actions.find((a) => a.code === 'COMPLEMENT')!.possible).toBe(true);
    expect((await env.fiches('u-ministre-finances')).find((f) => f.id === env.finCard())!.presence).toContain('DECIDEUR');
  });

  it('montant : un enjeu au-delà du seuil remonte ; relever le seuil exige deux personnes (registre des seuils)', async () => {
    const env = await full();
    const d = await env.req('POST', '/v1/postes/dossiers', 'u-dg-dgipk', dossierR05('60000000.00'));
    expect(d.statusCode).toBe(201);
    const id = `DOSSIER:${d.json().id}`;
    const g = (await env.fiches('u-gouverneur')).find((f) => f.id === id)!;
    expect(g.presence).toEqual(['REMONTEE']);
    expect(g.remontee!.raisons.join(' ')).toMatch(/Enjeu au-delà de 50/);
    const p = await env.req('POST', '/v1/integrite/thresholds/change-requests', 'u-dg-dgipk', { parameterId: 'postes.remontee.montant_n1_cdf', kind: 'MODIFICATION', proposedValue: 100_000_000, motif: 'Revue des seuils de délégation (test)' });
    expect(p.statusCode).toBe(201);
    expect((await env.req('POST', `/v1/integrite/thresholds/change-requests/${p.json().id}/decision`, 'u-dg-dgipk', { approve: true, motif: 'Auto-approbation interdite (test)' })).statusCode).toBe(403);
    expect((await env.fiches('u-gouverneur')).some((f) => f.id === id)).toBe(true);
    expect((await env.req('POST', `/v1/integrite/thresholds/change-requests/${p.json().id}/decision`, 'u-ministre-finances', { approve: true, motif: 'Seuil de délégation relevé (test)' })).statusCode).toBe(200);
    expect((await env.fiches('u-gouverneur')).some((f) => f.id === id)).toBe(false);
    expect((await env.fiches('u-ministre-finances')).find((f) => f.id === id)!.presence).toContain('DECIDEUR');
  });

  it('filtre : une nature de production ne remonte jamais ; une catégorie hors des dix est refusée', async () => {
    const env = await full();
    const r = await env.req('POST', '/v1/postes/dossiers', 'u-dg-dgipk', { ...dossierR05(), nature: 'RELANCE' });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('NE_REMONTE_JAMAIS');
    expect((await env.req('POST', '/v1/postes/dossiers', 'u-dg-dgipk', { ...dossierR05(), categorie: 'LIQUIDATION_COURANTE' })).statusCode).toBe(400);
  });
});

describe('Délégations : personne nommée, rang inférieur, durée, révocation, mention « par délégation de … »', () => {
  it('le Gouverneur délègue la fiche du centre agréé au ministre des Transports, qui décide « par délégation de » ; exécution suivie', async () => {
    const env = await full();
    const d = await env.req('POST', `/v1/postes/fiches/${encodeURIComponent(env.ct())}/action`, 'u-gouverneur', { action: 'DELEGUER', motif: 'Tutelle du ministère des Transports (test)', delegataireId: 'vc-u-ministre-transports', jusquau: '2026-10-06' });
    expect(d.statusCode).toBe(200);
    const f = (await env.fiches('vc-u-ministre-transports')).find((x) => x.id === env.ct())!;
    expect(f.presence).toContain('DELEGATION');
    expect(f.actions.find((a) => a.code === 'APPROUVER')!.possible).toBe(true);
    expect(f.actions.find((a) => a.code === 'DELEGUER')!.possible).toBe(false);
    const a = await env.req('POST', `/v1/postes/fiches/${encodeURIComponent(env.ct())}/action`, 'vc-u-ministre-transports', { action: 'APPROUVER', motif: 'Suspension de 30 jours pour contrôle sur place (test)' });
    expect(a.statusCode).toBe(200);
    const rec = env.ctx.audit.list({ action: 'postes.dossier.approuve', limit: 5 }).items.at(-1)!;
    expect(rec.actor.id).toBe('vc-u-ministre-transports');
    expect(String(rec.details.mention)).toMatch(/^par délégation de Gouverneur de la Ville-Province \(démo\) \(u-gouverneur\)$/);
    const exec = a.json().execution;
    expect(exec).toMatchObject({ etat: 'NON_ENGAGE', responsable: { entity: 'RFCK' }, lien: { type: 'CENTRE_SUSPENSION' } });
    // Exécution constatée à la source : la RFCK suspend le centre par sa route existante.
    const s = await env.req('POST', `/v1/centres-agrees/${exec.lien.centreId}/suspension`, 'vc-u-direction-rfck', { motif: 'Décision motivée de suspension (test)', legalRef: 'Arrêté ministériel du 12 novembre 2025' });
    expect(s.statusCode).toBe(200);
    const se = (await env.req('GET', '/v1/postes/vues/execution', 'acces-u-sg')).json();
    expect(se.actes.find((x: { id: string }) => x.id === exec.id)).toMatchObject({ etat: 'EXECUTE', etatLabel: 'Exécuté' });
  });

  it('limites : rang non inférieur, catégorie au-delà des droits, durée excessive, compte partagé, subdélégation refusés', async () => {
    const env = await full();
    const post = (u: string, b: Record<string, unknown>) => env.req('POST', '/v1/postes/delegations', u, { categorie: 'EXONERATION_DEGREVEMENT', fin: '2026-10-10', motif: MOTIF, perimetre: 'Ministère des Finances (test)', ...b });
    expect((await post('u-ministre-finances', { delegataireId: 'u-gouverneur' })).json().code).toBe('RANG_NON_INFERIEUR');
    expect((await post('u-ministre-finances', { delegataireId: 'u-dg-dgipk', categorie: 'SUSPENSION_TIERS' })).json().code).toBe('AU_DELA_DES_DROITS');
    expect((await post('u-ministre-finances', { delegataireId: 'u-dg-dgipk', fin: '2027-06-01' })).json().code).toBe('DUREE_EXCESSIVE');
    env.ctx.users.add({ id: 'u-poste-partage', name: 'Poste partagé du guichet (test)', roles: ['R12'], entity: 'DGIPK' });
    expect((await post('u-ministre-finances', { delegataireId: 'u-poste-partage' })).json().code).toBe('COMPTE_PARTAGE');
    expect((await post('u-ministre-finances', { delegataireId: 'u-contribuable' })).json().code).toBe('DELEGATAIRE_NON_AGENT');
    const ok = await post('u-ministre-finances', { delegataireId: 'u-dg-dgipk' });
    expect(ok.statusCode).toBe(201);
    // Le délégataire voit la fiche mais ne subdélègue pas.
    const f = (await env.fiches('u-dg-dgipk')).find((x) => x.id === env.finCard());
    expect(f?.presence).toContain('DELEGATION');
    expect((await env.req('POST', '/v1/postes/delegations', 'u-dg-dgipk', { categorie: 'EXONERATION_DEGREVEMENT', delegataireId: 'acces-u-chef-service', fin: '2026-10-05', motif: MOTIF, perimetre: 'x (test)' })).json().code).toBe('AU_DELA_DES_DROITS');
  });

  it('refus de l’auto-approbation : un délégataire ne décide jamais un élément qu’il a demandé', async () => {
    const env = await full();
    // La fiche du ministre des Finances est demandée par la DGIPK ; déléguée à la DGIPK, elle ne peut être décidée par elle.
    expect((await env.req('POST', '/v1/postes/delegations', 'u-ministre-finances', { categorie: 'EXONERATION_DEGREVEMENT', ficheId: env.finCard(), delegataireId: 'u-dg-dgipk', fin: '2026-10-10', motif: MOTIF, perimetre: 'Fiche (test)' })).statusCode).toBe(201);
    const r = await env.req('POST', `/v1/postes/fiches/${encodeURIComponent(env.finCard())}/action`, 'u-dg-dgipk', { action: 'APPROUVER', motif: MOTIF });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe('SEPARATION_OF_DUTIES');
  });

  it('expiration automatique et révocation : la corbeille du délégataire se vide ; journal de l’échéance', async () => {
    const env = await full();
    const d1 = (await env.req('POST', '/v1/postes/delegations', 'u-ministre-finances', { categorie: 'EXONERATION_DEGREVEMENT', delegataireId: 'u-dg-dgipk', fin: '2026-09-28', motif: MOTIF, perimetre: 'Finances (test)' })).json();
    expect(d1.statut).toBe('ACTIVE');
    expect((await env.fiches('u-dg-dgipk')).some((f) => f.presence.includes('DELEGATION'))).toBe(true);
    env.clock.set(new Date('2026-09-28T10:00:00.000Z'));
    expect((await env.fiches('u-dg-dgipk')).some((f) => f.presence.includes('DELEGATION'))).toBe(false);
    expect(env.svc.delegations.get(d1.id)!.statut).toBe('EXPIREE');
    expect(env.ctx.audit.list({ action: 'postes.delegation.expiree', resourceId: d1.id }).total).toBe(1);
    const d2 = (await env.req('POST', '/v1/postes/delegations', 'u-ministre-finances', { categorie: 'EXONERATION_DEGREVEMENT', delegataireId: 'u-dg-dgipk', fin: '2026-10-10', motif: MOTIF, perimetre: 'Finances (test)' })).json();
    expect((await env.req('POST', `/v1/postes/delegations/${d2.id}/revocation`, 'u-dg-dgipk', { motif: MOTIF })).statusCode).toBe(403);
    const rv = await env.req('POST', `/v1/postes/delegations/${d2.id}/revocation`, 'u-ministre-finances', { motif: 'Retour du titulaire (test)' });
    expect(rv.json().statut).toBe('REVOQUEE');
    expect((await env.fiches('u-dg-dgipk')).some((f) => f.presence.includes('DELEGATION'))).toBe(false);
  });
});

describe('Note du lundi : données réelles, reproductible, empreinte, historique', () => {
  it('contenu de la semaine, six états avec source, échéances à sept jours ; même données → même empreinte ; impression journalisée', async () => {
    const env = await full();
    const n = (await env.req('GET', '/v1/postes/notes', 'u-gouverneur')).json();
    expect(n.courante.semaine).toEqual({ lundi: '2026-09-21', dimanche: '2026-09-27', code: '2026-S39' });
    expect(n.courante.produitePar).toBe('production automatique');
    const c = n.courante.contenu;
    expect(c.recettes.map((x: { etat: string }) => x.etat)).toEqual(['POTENTIEL_ESTIME', 'CONSTATE', 'ENCAISSE', 'REGLE', 'RAPPROCHE', 'DISPONIBLE']);
    for (const x of c.recettes) expect(x.source.chemin.length).toBeLessThanOrEqual(3);
    expect(c.echeances7j.map((e: { objet: string }) => e.objet)).toContain('Suspendre l’habilitation d’un centre de contrôle technique agréé');
    expect(c.echeances7j.map((e: { objet: string }) => e.objet)).not.toContain('Arbitrer l’assignation de recettes du deuxième trimestre');
    expect(c.ia).toMatch(/sans IA/);
    const p1 = (await env.req('POST', '/v1/postes/notes/production', 'u-gouverneur')).json();
    expect(p1.sha256).toBe(n.courante.sha256);
    expect(p1.version).toBe(2);
    await env.req('POST', `/v1/postes/fiches/${encodeURIComponent(env.assign())}/action`, 'u-gouverneur', { action: 'REFUSER', motif: 'Écart insuffisamment expliqué (test)' });
    const p2 = (await env.req('POST', '/v1/postes/notes/production', 'u-gouverneur')).json();
    expect(p2.sha256).not.toBe(p1.sha256);
    expect(p2.contenu.decisions.map((d: { geste: string }) => d.geste)).toContain('REFUSER');
    const h = (await env.req('GET', '/v1/postes/notes', 'u-gouverneur')).json().historique;
    expect(h).toHaveLength(3);
    const imp = await env.req('GET', `/v1/postes/notes/${p2.id}/impression`, 'u-gouverneur');
    expect(imp.headers['content-type']).toMatch(/text\/html/);
    expect(imp.body).toContain(p2.sha256);
    expect(env.ctx.audit.list({ action: 'postes.note.exportee', resourceId: p2.id }).total).toBe(1);
    expect((await env.req('GET', `/v1/postes/notes/${p2.id}`, 'u-dircab')).statusCode).toBe(404);
  });
});

describe('Directeur de cabinet, Secrétariat exécutif, autorité habilitée', () => {
  it('cabinet : une fiche sans base légale ne monte pas ; renvoi motivé et tracé ; un dossier différé porte sa date de réexamen', async () => {
    const env = await full();
    const exo = env.svc.dossiers.findOne((d) => d.objet.includes('société immobilière'))!;
    const t = await env.req('POST', `/v1/postes/cabinet/dossiers/${exo.id}/preparation`, 'u-dircab', { action: 'TRANSMETTRE', motif: MOTIF });
    expect(t.json().code).toBe('FONDEMENT_REQUIS');
    expect((await env.req('POST', `/v1/postes/cabinet/dossiers/${exo.id}/preparation`, 'u-dircab', { action: 'RENVOYER', motif: 'Base légale non produite : à renvoyer (test)' })).statusCode).toBe(200);
    expect((await env.req('POST', '/v1/postes/cabinet/ordre-du-jour', 'u-dircab', { ficheId: env.assign(), action: 'DIFFERER', motif: MOTIF })).json().code).toBe('REEXAMEN_REQUIS');
    expect((await env.req('POST', '/v1/postes/cabinet/ordre-du-jour', 'u-dircab', { ficheId: env.assign(), action: 'DIFFERER', motif: 'Attendre la note du Trésor (test)', reexamenLe: '2026-10-02' })).statusCode).toBe(200);
    const g = (await env.req('GET', '/v1/postes/accueil', 'u-gouverneur')).json();
    expect(g.bloc1.fiches.map((f: { id: string }) => f.id)).not.toContain(env.assign());
    expect(g.corbeille.differes).toEqual([{ id: env.assign(), objet: 'Arbitrer l’assignation de recettes du deuxième trimestre', reexamenLe: '2026-10-02' }]);
    const home = (await env.req('GET', '/v1/postes/accueil', 'u-dircab')).json();
    expect(home.trace.map((x: { geste: string }) => x.geste)).toEqual(expect.arrayContaining(['RENVOYER', 'DIFFERER', 'MONTER']));
    expect(home.aTraiter.find((i: { id: string }) => i.id === env.assign()).reexamenLe).toBe('2026-10-02');
  });

  it('secrétariat : seul le service responsable déclare l’état et le blocage ; indicateur d’exécution dans le délai', async () => {
    const env = await full();
    const se = (await env.req('GET', '/v1/postes/accueil', 'acces-u-sg')).json();
    expect(se.question).toBe('Ce qui a été décidé est-il fait ?');
    expect(se.indicateur.principal).toMatchObject({ code: 'EXECUTION_DANS_LE_DELAI', etat: 'RATIO', unite: '%' });
    const arrete = se.actes.find((a: { acteLibelle: string }) => a.acteLibelle.startsWith('Arrêté — paiement fractionné'));
    expect(arrete).toMatchObject({ enRetard: true, joursRetard: 34, blocageLibelle: 'Blocage déclaré : arbitrage de taux' });
    const conv = se.actes.find((a: { acteLibelle: string }) => a.acteLibelle.startsWith('Convention de données — RFCK'));
    expect((await env.req('POST', `/v1/postes/executions/${conv.id}/etat`, 'u-gouverneur', { etat: 'PRODUIT', motif: 'Tentative (test)' })).json().code).toBe('NON_RESPONSABLE');
    const upd = await env.req('POST', `/v1/postes/executions/${conv.id}/etat`, 'vc-u-ministre-transports', { etat: 'PRODUIT', motif: 'Convention signée (test)', preuve: { reference: 'CONV-TEST-01' } });
    expect(upd.statusCode).toBe(200);
    expect((await env.req('POST', `/v1/postes/executions/${conv.id}/relance`, 'u-dircab', { motif: 'Relance nominative du service (test)' })).statusCode).toBe(200);
    const retards = (await env.req('GET', '/v1/postes/vues/retards', 'acces-u-sg')).json();
    expect(retards.regle).toMatch(/déclaré, pas constaté/);
  });

  it('autorité habilitée : agrégats, aucune corbeille, consultations journalisées ; expiration automatique, renouvellement explicite', async () => {
    const env = await full();
    const a = (await env.req('GET', '/v1/postes/accueil', 'postes-u-autorite-habilitee')).json();
    expect(a.profil).toBe('AUTORITE_HABILITEE');
    expect(a.bandeau).toMatch(/Habilitation valable jusqu’au 31\/12\/2027/);
    expect(a.corbeille.taille).toBe(0);
    expect(a.interdits).toHaveLength(3);
    expect((await env.req('GET', '/v1/postes/corbeille', 'postes-u-autorite-habilitee')).statusCode).toBe(403);
    const mh = (await env.req('GET', '/v1/postes/vues/mon-habilitation', 'postes-u-autorite-habilitee')).json();
    expect(mh.consultations.length).toBeGreaterThanOrEqual(1);
    env.clock.set(new Date('2028-01-02T09:00:00.000Z'));
    const exp = await env.req('GET', '/v1/postes/accueil', 'postes-u-autorite-habilitee');
    expect(exp.statusCode).toBe(403);
    expect(exp.json().code).toBe('HABILITATION_EXPIREE');
    const h = env.svc.habilitations.all()[0]!;
    expect((await env.req('POST', `/v1/postes/habilitations/${h.id}/renouvellement`, 'u-dircab', { au: '2028-12-31', motif: 'Renouvellement explicite motivé (test)' })).statusCode).toBe(200);
    expect((await env.req('GET', '/v1/postes/accueil', 'postes-u-autorite-habilitee')).statusCode).toBe(200);
  });

  it('notifications : plafond fixé par l’autorité ; au-delà, une synthèse unique ; jamais de donnée individuelle', async () => {
    const env = await full();
    expect((await env.req('POST', '/v1/postes/notifications/plafond', 'u-ministre-finances', { plafondJournalier: 1 })).statusCode).toBe(200);
    for (let i = 0; i < 3; i++) await env.req('POST', '/v1/postes/dossiers', 'u-dg-dgipk', { ...dossierR05(), echeance: '2026-09-27', objet: `Dégrèvement urgent n° ${i + 1} (test)` });
    await env.req('GET', '/v1/postes/accueil', 'u-ministre-finances');
    const n = (await env.req('GET', '/v1/postes/notifications', 'u-ministre-finances')).json();
    expect(n.plafondJournalier).toBe(1);
    expect(n.items.filter((x: { type: string }) => x.type !== 'SYNTHESE')).toHaveLength(1);
    expect(n.items.filter((x: { type: string }) => x.type === 'SYNTHESE')).toHaveLength(1);
    for (const x of n.items) expect(x.texte).not.toMatch(/Mbuyi|Kalala|\+243/);
  });

  it('les tableaux existants restent disponibles (règle n° 1) et les routes financières ne sont jamais relayées', async () => {
    const env = await full();
    expect((await env.req('GET', '/v1/pilotage/tableaux/gouverneur', 'u-gouverneur')).statusCode).toBe(200);
    expect((await env.req('GET', '/v1/pilotage/tableaux/ministre', 'u-ministre-finances')).statusCode).toBe(200);
    for (const it of env.svc.items()) {
      if (it.approuver) expect(estRouteFinanciere(it.approuver.url), it.id).toBe(false);
      if (it.refuser) expect(estRouteFinanciere(it.refuser.url), it.id).toBe(false);
    }
  });
});

export type { Env };
