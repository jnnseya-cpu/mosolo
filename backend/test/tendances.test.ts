/**
 * Veille des tendances (Trend Intelligence, 10/11/2026) — scénarios de conformité de la spécification v2.3 (§ 21)
 * transposés sur les circuits de MOSOLO : idempotence des observations, isolement des installations, calcul exact,
 * brief versionné et approuvé par une personne distincte, actions générées sans clé nouvelle, approbation liée au
 * contenu exact, file d'exécution, conflit de révision, reprise après panne, gel, retour arrière, mesure, neutralité.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DAY_MS, ManualClock } from '../src/core/clock.js';
import { growthBriefV1 } from '../src/plugins/tendances/contrat.js';
import type { TendancesService } from '../src/plugins/tendances/service.js';
import { confiance, decider, scoreOpportunite } from '../src/plugins/tendances/scoring.js';

const INST = 'kinshasa-mosolo';
const PROPOSANT = 'u-dg-dgipk';
const APPROBATEUR = 'u-dircab';

async function env(iso = '2026-11-10T09:00:00.000Z') {
  const clock = new ManualClock(iso);
  const app = buildApp({ clock, seed: true, secrets: { auditHmacKey: 'k', providerSecrets: {}, commsProviderKeys: {} } });
  await app.ready();
  const svc = app.ctx.ext.tendances as TendancesService;
  const req = (method: string, url: string, user?: string, body?: unknown, headers: Record<string, string> = {}) => app.inject({
    method: method as 'GET', url,
    headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { app, svc, clock, req };
}

/** Du calcul au brief approuvé, puis génération (sans clé d'IA : modèle déterministe). */
async function jusquAuxActions(e: Awaited<ReturnType<typeof env>>, sujet = 'vignette-automobile') {
  const ops = (await e.req('GET', `/v1/tendances/installations/${INST}/opportunites`, PROPOSANT)).json();
  const op = ops.items.find((o: { sujet: string }) => o.sujet === sujet);
  const brief = (await e.req('POST', `/v1/tendances/installations/${INST}/opportunites/${op.id}/brief`, PROPOSANT)).json();
  const ok = await e.req('POST', `/v1/tendances/installations/${INST}/briefs/${brief.id}/approbation`, APPROBATEUR, undefined, { 'if-match': String(brief.version) });
  expect(ok.statusCode, ok.body).toBe(200);
  const gen = await e.req('POST', `/v1/tendances/installations/${INST}/briefs/${brief.id}/generation`, PROPOSANT);
  expect(gen.statusCode, gen.body).toBe(201);
  return { op, brief, gen: gen.json() };
}

describe('Veille des tendances — calcul', () => {
  it('TI-03 : 80/95/85/90/80 donnent 86,25 et 90/80/70/90 donnent 83,5 ; brief à revoir, aucun arrondi avant la décision', () => {
    const s = scoreOpportunite({ demande: 80, adequation: 95, intention: 85, moment: 90, preparation: 80 });
    const c = confiance({ qualite: 90, corroboration: 80, couverture: 70, fraicheur: 90 }, 2);
    expect(s).toBeCloseTo(86.25, 10);
    expect(c).toBeCloseTo(83.5, 10);
    const seuils = { archiveScore: 60, archiveConfiance: 55, brief: 75, automatique: 85 };
    expect(decider(s, c, [], seuils)).toBe('BRIEF');
    expect(decider(s, c, [], seuils, true)).toBe('BRIEF'); // confiance < 85 : pas d'automatique
    expect(confiance({ qualite: 100, corroboration: 100, couverture: 100, fraicheur: 100 }, 1)).toBe(69); // une seule famille : plafond
    expect(decider(74.999, 90, [], seuils)).toBe('SURVEILLER');
  });

  it('démonstration : vignette (3 familles) et stationnement (paiements + article du blog) éligibles ; publicité (stable, une famille) en surveillance', async () => {
    const { req } = await env();
    const r = (await req('GET', `/v1/tendances/installations/${INST}/opportunites`, 'u-gouverneur')).json();
    const v = r.items.find((o: { sujet: string }) => o.sujet === 'vignette-automobile');
    const s = r.items.find((o: { sujet: string }) => o.sujet === 'publicite');
    expect(v.statut).toBe('ELIGIBLE');
    expect(v.familles).toHaveLength(3);
    expect(r.items.find((o: { sujet: string }) => o.sujet === 'stationnement').statut).toBe('ELIGIBLE');
    expect(s.statut).toBe('SURVEILLEE');
    expect(s.blocages.join(' ')).toMatch(/SOUS_LE_SEUIL/);
    expect(r.parametres.statut).toMatch(/à confirmer/);
    expect((await req('GET', `/v1/tendances/installations/${INST}/opportunites`, 'u-contribuable')).statusCode).toBe(403);
  });
});

describe('Veille des tendances — observations et isolement', () => {
  it('TI-01 : lot rejoué = doublons ; même source et même version avec une autre valeur = 409 ; clé d’idempotence exigée', async () => {
    const { req } = await env();
    const ligne = { sourceId: 'src-import', recordId: 'rec-1', observeLe: '2026-11-09T12:00:00Z', debut: '2026-11-09T00:00:00Z', fin: '2026-11-10T00:00:00Z', texte: 'vignette moto', valeur: 12 };
    const url = `/v1/tendances/installations/${INST}/observations/lot`;
    expect((await req('POST', url, PROPOSANT, { observations: [ligne] })).statusCode).toBe(400);
    const a = (await req('POST', url, PROPOSANT, { observations: [ligne] }, { 'idempotency-key': 'lot-000001' })).json();
    expect(a).toMatchObject({ acceptees: 1, doublons: 0 });
    const b = (await req('POST', url, PROPOSANT, { observations: [ligne] }, { 'idempotency-key': 'lot-000002' })).json();
    expect(b).toMatchObject({ acceptees: 0, doublons: 1 });
    expect((await req('POST', url, PROPOSANT, { observations: [{ ...ligne, valeur: 99 }] }, { 'idempotency-key': 'lot-000003' })).statusCode).toBe(409);
    // Lot atomique : une ligne invalide refuse tout ; source inconnue ; texte personnel refusé.
    const mauvais = await req('POST', url, PROPOSANT, { observations: [{ ...ligne, recordId: 'rec-2' }, { ...ligne, recordId: 'rec-3', sourceId: 'inconnue' }] }, { 'idempotency-key': 'lot-000004' });
    expect(mauvais.statusCode).toBe(422);
    expect(mauvais.json().erreurs[0].index).toBe(1);
    expect((await req('POST', url, PROPOSANT, { observations: [{ ...ligne, recordId: 'rec-4', texte: 'appeler +243 812 345 678' }] }, { 'idempotency-key': 'lot-000005' })).statusCode).toBe(422);
  });

  it('TI-02 / TI-17 : deux installations neutres (spécification § 22) restent séparées ; aucune ne dépend du nom de la plateforme', async () => {
    const { svc, req } = await env();
    const sys = { id: 'test', kind: 'system' as const };
    for (const [id, marche, locale, conversion] of [['fixture-a', 'CA', 'en-CA', 'qualified_trial_started'], ['fixture-b', 'FR', 'fr-FR', 'completed_order']] as const) {
      svc.creerInstallation(sys, { id, slug: id, libelle: id, environnement: 'DEMONSTRATION', acces: id === 'fixture-b' ? ['R06'] : [] });
      svc.enregistrerProfil(sys, id, { marche, locale, fuseau: 'UTC', canaux: ['seo', 'organic_social'], assets: [], claims: [{ id: 'c1', texte: 'Approved claim', source: 'fixture' }], ctas: [{ id: 'cta1', libelle: 'Go', cible: '/x' }], sujets: [{ id: 'topic', libelle: 'Topic', alias: ['onboarding'], adequation: 90, intention: 80, pret: true, classe: 'PERSISTANT', audience: 'a', intentionTexte: 'i', claims: ['c1'], cta: 'cta1', assetId: null }], interdits: [], resultat: { conversion, denominateur: 'eligible_session' }, qualiteFamilles: {} }, { siAucun: true });
    }
    expect(svc.profilActif('fixture-a')!.locale).toBe('en-CA');
    expect(svc.profilActif('fixture-b')!.resultat.conversion).toBe('completed_order');
    // Entité d'une autre installation : introuvable (404), jamais renvoyée.
    const opMosolo = svc.opportunites.all().find((o) => o.installationId === INST)!;
    expect((await req('POST', `/v1/tendances/installations/fixture-a/opportunites/${opMosolo.id}/brief`, PROPOSANT)).statusCode).toBe(404);
    // Installation réservée à un autre rôle : introuvable pour le directeur de cabinet (R02).
    expect((await req('GET', '/v1/tendances/installations/fixture-b/opportunites', APPROBATEUR)).statusCode).toBe(404);
    const etat = (await req('GET', '/v1/tendances', APPROBATEUR)).json();
    expect(etat.installations.map((i: { id: string }) => i.id)).not.toContain('fixture-b');
  });

  it('TI-14 / TI-22 : sujet hors profil ⇒ veto ; source qui exigerait une clé nouvelle ⇒ indisponible, jamais demandée', async () => {
    const { svc, req } = await env();
    const etat = (await req('GET', '/v1/tendances', PROPOSANT)).json();
    const gt = etat.installations[0].sources.find((s: { id: string }) => s.id === 'src-google-trends-api');
    expect(gt.indisponible).toMatch(/aucune clé nouvelle/);
    const ligne = { sourceId: 'src-google-trends-api', recordId: 'x', observeLe: '2026-11-09T12:00:00Z', debut: '2026-11-09T00:00:00Z', fin: '2026-11-10T00:00:00Z', texte: 'vignette', valeur: 5 };
    expect((await req('POST', `/v1/tendances/installations/${INST}/observations/lot`, PROPOSANT, { observations: [ligne] }, { 'idempotency-key': 'lot-gt-0001' })).statusCode).toBe(422);
    // Annonce concurrente aux mots proches mais d'intention étrangère : sujet candidat, veto « hors profil ».
    const sys = { id: 'test', kind: 'system' as const };
    const jour0 = Date.parse('2026-11-10T00:00:00Z');
    const lignes = Array.from({ length: 63 }, (_, k) => ({ sourceId: 'src-import', recordId: `concurrent-${k}`, observeLe: new Date(jour0 - (63 - k) * DAY_MS).toISOString(), debut: new Date(jour0 - (63 - k) * DAY_MS).toISOString(), fin: new Date(jour0 - (62 - k) * DAY_MS).toISOString(), texte: 'Rachat annonce concurrent logiciel', valeur: k >= 56 ? 40 : 3 }));
    svc.deposer(sys, INST, lignes);
    const ops = svc.calculer(sys, INST).items;
    const c = ops.find((o) => o.sujet.startsWith('candidat-'))!;
    expect(c.vetos.join(' ')).toMatch(/HORS_PROFIL/);
    expect(c.statut).not.toBe('ELIGIBLE');
  });
});

describe('Veille des tendances — brief, actions, exécution', () => {
  it('brief : schéma fermé respecté ; auteur ≠ approbateur ; If-Match exigé ; brief effectif résolu puis 204 hors portée', async () => {
    const e = await env();
    const ops = (await e.req('GET', `/v1/tendances/installations/${INST}/opportunites`, PROPOSANT)).json();
    const op = ops.items.find((o: { sujet: string }) => o.sujet === 'vignette-automobile');
    const brief = (await e.req('POST', `/v1/tendances/installations/${INST}/opportunites/${op.id}/brief`, PROPOSANT)).json();
    expect(growthBriefV1.safeParse(brief.contenu).success).toBe(true);
    expect(growthBriefV1.safeParse({ ...brief.contenu, extra: 1 }).success).toBe(false);
    const url = `/v1/tendances/installations/${INST}/briefs/${brief.id}/approbation`;
    expect((await e.req('POST', url, APPROBATEUR)).statusCode).toBe(428);
    expect((await e.req('POST', url, PROPOSANT, undefined, { 'if-match': '1' })).statusCode).toBe(403); // le proposant n'est pas approbateur
    expect((await e.req('POST', url, APPROBATEUR, undefined, { 'if-match': '1' })).statusCode).toBe(200);
    const eff = `/v1/tendances/installations/${INST}/brief-effectif?marche=CD&locale=fr-CD&sujet=vignette-automobile`;
    const r = await e.req('GET', `${eff}&canal=seo`, PROPOSANT);
    expect(r.statusCode).toBe(200);
    expect(r.json().mentions.length).toBe(2);
    expect((await e.req('GET', `${eff}&canal=paid`, PROPOSANT)).statusCode).toBe(204);
    // Opportunité non éligible : aucun brief.
    const stat = ops.items.find((o: { sujet: string }) => o.sujet === 'publicite');
    expect((await e.req('POST', `/v1/tendances/installations/${INST}/opportunites/${stat.id}/brief`, PROPOSANT)).statusCode).toBe(422);
  });

  it('TI-10 / TI-19 / TI-21 : sans clé d’IA, actions SEO et marketing du même brief (modèle déterministe signalé) ; approbation ⇒ page publique modifiée, reçu, mesure, retour arrière', async () => {
    const e = await env();
    const { gen } = await jusquAuxActions(e);
    expect(gen.generation.route).toBe('DETERMINISTE');
    expect(gen.generation.degrade).toBe(true);
    const types = gen.items.map((a: { type: string }) => a.type).sort();
    expect(types).toEqual(['organic_social_draft', 'owned_content_patch', 'seo_metadata_patch']);
    const seo = gen.items.find((a: { type: string }) => a.type === 'seo_metadata_patch');
    expect(new Set(gen.items.map((a: { briefId: string }) => a.briefId)).size).toBe(1); // un seul brief partagé
    // Auteur ≠ approbateur ; aucune écriture avant approbation.
    expect((await e.req('GET', '/v1/public/tendances/pages/vignette-automobile')).json().titre).toBe('Vignette automobile — Kinshasa');
    expect((await e.req('POST', `/v1/tendances/installations/${INST}/actions/${seo.id}/approbation`, PROPOSANT)).statusCode).toBe(403);
    const ok = (await e.req('POST', `/v1/tendances/installations/${INST}/actions/${seo.id}/approbation`, APPROBATEUR)).json();
    expect(ok.action.statut).toBe('APPLIQUEE');
    expect(ok.action.recu.revision).toBe(2);
    const page = (await e.req('GET', '/v1/public/tendances/pages/vignette-automobile')).json();
    expect(page.titre).toBe(seo.champs.titre);
    expect(page.revision).toBe(2);
    // Mesure propre : agrégats, aucun identifiant ; avant / après, observationnel.
    for (let i = 0; i < 3; i++) await e.req('POST', '/v1/public/tendances/pages/vignette-automobile/evenements', undefined, { evenement: 'VISITE' });
    await e.req('POST', '/v1/public/tendances/pages/vignette-automobile/evenements', undefined, { evenement: 'CTA' });
    const m = (await e.req('GET', `/v1/tendances/installations/${INST}/actions/${seo.id}/mesure`, PROPOSANT)).json();
    expect(m.methode).toBe('OBSERVATIONNELLE');
    expect(m.apres).toMatchObject({ visites: 3, cta: 1 });
    expect(m.recommandation).toBe('DONNEES_INSUFFISANTES');
    // Retour arrière : la révision précédente est restaurée (nouvelle révision, historique conservé).
    const rb = (await e.req('POST', `/v1/tendances/installations/${INST}/actions/${seo.id}/retour`, APPROBATEUR, { motif: 'Essai terminé, retour à la version précédente' })).json();
    expect(rb.statut).toBe('RETABLIE');
    const apres = (await e.req('GET', '/v1/public/tendances/pages/vignette-automobile')).json();
    expect(apres.titre).toBe('Vignette automobile — Kinshasa');
    expect(apres.revision).toBe(3);
    const actions = e.app.ctx.audit.unsafeRawStorageForTamperTests().map((r) => r.action).filter((a) => a.startsWith('tendances.'));
    for (const etape of ['tendances.brief.cree', 'tendances.brief.approuve', 'tendances.actions.generees', 'tendances.action.approuvee', 'tendances.action.appliquee', 'tendances.action.retablie']) expect(actions).toContain(etape);
  });

  it('TI-08 : page modifiée après la génération ⇒ conflit, rien n’est écrasé ; TI-05 : brief révoqué ⇒ l’action en file est refusée', async () => {
    const e = await env();
    const { gen, brief } = await jusquAuxActions(e);
    const seo = gen.items.find((a: { type: string }) => a.type === 'seo_metadata_patch');
    const contenu = gen.items.find((a: { type: string }) => a.type === 'owned_content_patch');
    // Un éditeur change la page (nouvelle révision) : l'action approuvée sur l'ancienne révision part en conflit.
    const page = e.svc.pages.get('page-vignette')!;
    e.svc.adaptateur.appliquer(page.id, page.revisionActive!, { titre: 'Titre de l’éditeur' }, 'edition-manuelle');
    const r = (await e.req('POST', `/v1/tendances/installations/${INST}/actions/${seo.id}/approbation`, APPROBATEUR)).json();
    expect(r.action.statut).toBe('CONFLIT');
    expect(r.action.erreur.code).toBe('TARGET_REVISION_CONFLICT');
    expect((await e.req('GET', '/v1/public/tendances/pages/vignette-automobile')).json().titre).toBe('Titre de l’éditeur');
    // Gel : l'action approuvée reste en file ; le brief est révoqué ; au dégel, l'exécuteur la refuse.
    await e.req('POST', `/v1/tendances/installations/${INST}/gel`, 'u-rssi', { actif: true, motif: 'Incident en cours sur le portail' });
    expect((await e.req('POST', `/v1/tendances/installations/${INST}/briefs/${brief.id}/generation`, PROPOSANT)).statusCode).toBe(409);
    const q = (await e.req('POST', `/v1/tendances/installations/${INST}/actions/${contenu.id}/approbation`, APPROBATEUR)).json();
    expect(q.action.statut).toBe('EN_FILE');
    await e.req('POST', `/v1/tendances/installations/${INST}/briefs/${brief.id}/revocation`, APPROBATEUR, { motif: 'Campagne suspendue par le cabinet' });
    await e.req('POST', `/v1/tendances/installations/${INST}/gel`, 'u-rssi', { actif: false, motif: 'Incident clos, reprise normale' });
    const t = (await e.req('POST', '/v1/tendances/travaux', 'integrite-u-ingenieur')).json();
    expect(t.items[0]).toMatchObject({ statut: 'ECHEC', code: 'BRIEF_EXPIRE' });
    // Brief révoqué : plus de brief effectif (l'agent revient à son comportement de base).
    expect((await e.req('GET', `/v1/tendances/installations/${INST}/brief-effectif?marche=CD&locale=fr-CD&sujet=vignette-automobile&canal=seo`, PROPOSANT)).statusCode).toBe(204);
  });

  it('TI-05 (expiration) : brief expiré ⇒ brief effectif 204 et approbation d’action refusée', async () => {
    const e = await env();
    const { gen } = await jusquAuxActions(e);
    e.clock.advance(8 * DAY_MS);
    expect((await e.req('GET', `/v1/tendances/installations/${INST}/brief-effectif?marche=CD&locale=fr-CD&sujet=vignette-automobile&canal=seo`, PROPOSANT)).statusCode).toBe(204);
    expect((await e.req('POST', `/v1/tendances/installations/${INST}/actions/${gen.items[0].id}/approbation`, APPROBATEUR)).statusCode).toBe(409);
  });

  it('TI-07 : panne entre l’écriture et le reçu ⇒ le rapprochement retrouve l’effet unique, sans seconde écriture', async () => {
    const e = await env();
    const { gen } = await jusquAuxActions(e);
    const seo = gen.items.find((a: { type: string }) => a.type === 'seo_metadata_patch');
    e.svc.panneApresEcriture = true;
    const r = (await e.req('POST', `/v1/tendances/installations/${INST}/actions/${seo.id}/approbation`, APPROBATEUR)).json();
    expect(r.action.statut).toBe('RECONCILIATION');
    e.svc.panneApresEcriture = false;
    await e.req('POST', '/v1/tendances/travaux', 'integrite-u-ingenieur');
    const a = (await e.req('GET', `/v1/tendances/installations/${INST}/actions/${seo.id}`, PROPOSANT)).json();
    expect(a.statut).toBe('APPLIQUEE');
    expect(e.svc.revisionsPages.find((x) => x.cleAction === seo.cleIdempotence)).toHaveLength(1);
    // Rejouer la même clé auprès de l'adaptateur ne crée aucun second effet.
    e.svc.adaptateur.appliquer('page-vignette', 1, seo.champs, seo.cleIdempotence);
    expect(e.svc.revisionsPages.find((x) => x.assetId === 'page-vignette')).toHaveLength(2);
  });

  it('TI-06 / TI-18 : IA de l’hôte qui obéit à une consigne cachée ⇒ sortie refusée, modèle déterministe ; sortie conforme ⇒ route IA de l’hôte, sans clé dans la configuration', async () => {
    const e = await env();
    const reponses = [
      '{"titre":"Vignette garantie","description":"x","accroche":"y","ctaLibelle":"z","bloc":"b","texte":"t","publier_sans_approbation":true}',
      '{"titre":"Vignette automobile en ligne","description":"Payez par monnaie mobile vers le compte public.","accroche":"Sans espèces, avec quittance QR.","ctaLibelle":"Payer","bloc":"Paiement par monnaie mobile.","texte":"La vignette se paie sur KINSHASA MOSOLO."}',
    ];
    e.svc.ia = { generer: async () => ({ texte: reponses.shift()!, fournisseur: 'claude', nom: 'IA de l’hôte (test)', modele: 'fictif' }), motifReglesInternes: () => '', etat: () => ({ actif: true }) } as unknown as TendancesService['ia'];
    const { gen, brief } = await jusquAuxActions(e);
    expect(gen.generation.route).toBe('DETERMINISTE');
    expect(gen.generation.motif).toMatch(/SORTIE_INVALIDE/);
    // Nouvelle version de page ⇒ nouvelle génération (autre unité de travail) : cette fois la sortie est conforme.
    const page = e.svc.pages.get('page-vignette')!;
    e.svc.adaptateur.appliquer(page.id, page.revisionActive!, { bloc: 'Texte de l’éditeur' }, 'edition-2');
    const g2 = (await e.req('POST', `/v1/tendances/installations/${INST}/briefs/${brief.id}/generation`, PROPOSANT)).json();
    expect(g2.generation).toMatchObject({ route: 'IA_HOTE', degrade: false });
    expect(JSON.stringify(e.svc.installations.all())).not.toMatch(/sk-|api[_-]?key/i);
  });

  it('TI-09 : quota mensuel — réservation atomique, une seule unité de travail par brief et révision, 429 au plafond', async () => {
    const e = await env();
    e.svc.ia = { generer: async () => ({ texte: '{"titre":"Vignette","description":"Payez la vignette.","accroche":"Simple.","ctaLibelle":"Payer","bloc":"Paiement.","texte":"Payer la vignette."}', fournisseur: 'claude', nom: 'h', modele: 'm' }), motifReglesInternes: () => '', etat: () => ({ actif: true }) } as unknown as TendancesService['ia'];
    const inst = e.svc.installations.get(INST)!;
    e.svc.installations.update({ ...inst, quotaMensuel: 1 });
    const { brief } = await jusquAuxActions(e);
    const r1 = await e.req('POST', `/v1/tendances/installations/${INST}/briefs/${brief.id}/generation`, PROPOSANT);
    expect(r1.statusCode).toBe(201); // même unité de travail : réutilisée, jamais facturée deux fois
    expect(e.svc.usages.find((u) => u.statut === 'REGLE')).toHaveLength(1);
    const page = e.svc.pages.get('page-vignette')!;
    e.svc.adaptateur.appliquer(page.id, page.revisionActive!, { bloc: 'Autre texte' }, 'edition-3');
    const r2 = await e.req('POST', `/v1/tendances/installations/${INST}/briefs/${brief.id}/generation`, PROPOSANT);
    expect(r2.statusCode).toBe(429);
    expect(r2.json().code).toBe('QUOTA_ATTEINT');
  });

  it('TI-16 : brouillon social approuvé puis exporté (publication manuelle consignée) ; jamais d’envoi automatique', async () => {
    const e = await env();
    const { gen } = await jusquAuxActions(e);
    const social = gen.items.find((a: { type: string }) => a.type === 'organic_social_draft');
    const envois = e.app.ctx.comms.deliveries.count();
    expect((await e.req('POST', `/v1/tendances/installations/${INST}/actions/${social.id}/export`, PROPOSANT, { destination: 'Page Facebook de la Ville' })).statusCode).toBe(409);
    const ok = (await e.req('POST', `/v1/tendances/installations/${INST}/actions/${social.id}/approbation`, APPROBATEUR)).json();
    expect(ok.action.statut).toBe('APPROUVEE');
    const ex = (await e.req('POST', `/v1/tendances/installations/${INST}/actions/${social.id}/export`, PROPOSANT, { destination: 'Page Facebook de la Ville' })).json();
    expect(ex.statut).toBe('EXPORTEE');
    expect(e.app.ctx.comms.deliveries.count()).toBe(envois);
  });

  it('collecte propre : agrégats de la plateforme par jour complet (paiements, doléances, pages), sans donnée personnelle ; rejouée sans doublon', async () => {
    const e = await env();
    const r1 = (await e.req('POST', `/v1/tendances/installations/${INST}/collecte`, PROPOSANT)).json();
    const r2 = (await e.req('POST', `/v1/tendances/installations/${INST}/collecte`, PROPOSANT)).json();
    expect(r2.acceptees).toBe(0);
    expect(r1.examinees).toBe(r2.examinees);
    expect(JSON.stringify(e.svc.observations.all())).not.toMatch(/\+243|@/);
  });
});

describe('Veille des tendances — contrat Growth Brief v1 (fixtures de la spécification)', () => {
  it('la fixture positive du § 6 est acceptée ; chaque fixture négative est refusée (objet fermé, marché, preuves, canal, version)', async () => {
    const { readFileSync } = await import('node:fs');
    const dir = new URL('../../trend-intelligence/contracts/fixtures/', import.meta.url);
    const pos = JSON.parse(readFileSync(new URL('growth-brief.positive.json', dir), 'utf-8'));
    const negs = JSON.parse(readFileSync(new URL('growth-brief.negative.json', dir), 'utf-8')) as unknown[];
    expect(growthBriefV1.safeParse(pos).success).toBe(true);
    expect(negs.length).toBeGreaterThanOrEqual(7);
    for (const n of negs) expect(growthBriefV1.safeParse(n).success).toBe(false);
    const yaml = readFileSync(new URL('../growth-brief.v1.schema.yaml', dir), 'utf-8');
    for (const champ of Object.keys(pos)) expect(yaml).toContain(`  - ${champ}`); // mêmes champs obligatoires que le schéma publié
  });
});

describe('Veille des tendances — intégrée à toute la plateforme (pas un produit à part)', () => {
  it('l’article EXISTANT du blog « Stationnement intelligent » suit la révision approuvée, puis revient à l’original au retour arrière', async () => {
    const e = await env();
    const avant = (await e.req('GET', '/v1/public/tendances/pages/stationnement-intelligent')).json();
    expect(avant).toMatchObject({ surface: 'BLOG', titre: 'Stationnement intelligent (ParkSmart)' });
    const { gen } = await jusquAuxActions(e, 'stationnement');
    const seo = gen.items.find((a: { type: string }) => a.type === 'seo_metadata_patch');
    expect(seo.cibleId).toBe('blog-stationnement-intelligent');
    await e.req('POST', `/v1/tendances/installations/${INST}/actions/${seo.id}/approbation`, APPROBATEUR);
    expect((await e.req('GET', '/v1/public/tendances/pages/stationnement-intelligent')).json().titre).toBe(seo.champs.titre);
    await e.req('POST', `/v1/tendances/installations/${INST}/actions/${seo.id}/retour`, APPROBATEUR, { motif: 'Retour à l’article d’origine du blog' });
    expect((await e.req('GET', '/v1/public/tendances/pages/stationnement-intelligent')).json().titre).toBe('Stationnement intelligent (ParkSmart)');
  });

  it('les rappels de l’agent existant « Rappels personnalisés » sont alignés sur le brief approuvé — en métadonnée interne, sans rien d’affiché', async () => {
    const e = await env();
    const { brief } = await jusquAuxActions(e);
    // Échéance de la vignette de démonstration ramenée dans la fenêtre des rappels (7 jours) pour ce scénario.
    const vignette = e.app.ctx.assessment.obligations.all().find((o) => /vignette/i.test(o.label))!;
    e.app.ctx.assessment.obligations.update({ ...vignette, dueDate: '2026-11-13' });
    const lot = (await e.req('POST', '/v1/agents-recettes/RAPPELS/lancer', 'u-ministre-finances')).json();
    const alignes = lot.items.filter((p: { alignement?: { briefId: string } }) => p.alignement?.briefId === brief.briefId);
    expect(alignes.length).toBeGreaterThan(0);
    expect(lot.items.some((p: { detail: string; titre: string }) => /brief|tendance/i.test(`${p.detail} ${p.titre}`))).toBe(false);
    await e.req('POST', `/v1/tendances/installations/${INST}/briefs/${brief.id}/revocation`, APPROBATEUR, { motif: 'Fin de la campagne vignette' });
    const lot2 = (await e.req('POST', '/v1/agents-recettes/RAPPELS/lancer', 'u-ministre-finances')).json();
    expect(lot2.items.some((p: { alignement?: unknown }) => p.alignement)).toBe(false);
  });

  it('invisible : l’agent « Veille des tendances » n’apparaît pas dans le catalogue des Agents IA de recettes (code conservé, aucun accès par son nom)', async () => {
    const e = await env();
    const cat = (await e.req('GET', '/v1/agents-recettes', 'u-gouverneur')).json();
    expect(cat.agents.some((a: { code: string }) => a.code === 'TENDANCES')).toBe(false);
    expect((await e.req('GET', '/v1/agents-recettes/TENDANCES', 'u-gouverneur')).statusCode).toBe(404);
  });
});

describe('Veille des tendances — fonctionnement automatique et invisible (opt-in du directeur de cabinet)', () => {
  it('opt-in réservé au directeur de cabinet, motivé et journalisé ; sans opt-in : collecte et calcul seulement, aucune modification', async () => {
    const e = await env();
    expect((await e.req('POST', `/v1/tendances/installations/${INST}/automatique`, PROPOSANT, { actif: false, motif: 'Suspension demandée par la régie' })).statusCode).toBe(403);
    const off = (await e.req('POST', `/v1/tendances/installations/${INST}/automatique`, APPROBATEUR, { actif: false, motif: 'Suspension pour revue du cabinet' })).json();
    expect(off.optInAutomatique).toBe(false);
    const avant = (await e.req('GET', '/v1/public/tendances/pages/vignette-automobile')).json().titre;
    const bilan = await e.svc.cycleAutomatique(INST);
    expect(bilan[0]!.appliquees).toEqual([]);
    expect((await e.req('GET', '/v1/public/tendances/pages/vignette-automobile')).json().titre).toBe(avant);
    expect(e.svc.briefs.count()).toBe(0);
  });

  it('avec l’opt-in : la vignette (score et confiance ≥ 85) est mise à jour en arrière-plan ; le stationnement (confiance < 85) ne l’est pas ; au brief expiré, retour automatique', async () => {
    const e = await env();
    expect(e.svc.installations.get(INST)!.automatisation?.demo).toBe(true); // opt-in de démonstration, signalé
    const bilan = await e.svc.cycleAutomatique(INST);
    expect(bilan[0]!.appliquees.length).toBe(2); // SEO (titre, description) et marketing (accroche, appel)
    const page = (await e.req('GET', '/v1/public/tendances/pages/vignette-automobile')).json();
    expect(page.revision).toBe(3);
    expect(page.titre).not.toBe('Vignette automobile — Kinshasa');
    const auto = e.svc.actions.find((a) => !!a.automatique);
    expect(auto.every((a) => a.approbation!.by.startsWith('politique-automatique:u-dircab'))).toBe(true);
    expect(auto.every((a) => a.type === 'seo_metadata_patch' || a.type === 'owned_content_patch')).toBe(true);
    expect((await e.req('GET', '/v1/public/tendances/pages/stationnement-intelligent')).json().revision).toBe(1);
    // Rejouer le cycle ne crée aucun doublon.
    expect((await e.svc.cycleAutomatique(INST))[0]!.appliquees).toEqual([]);
    // Brief expiré : chaque modification automatique revient au contenu précédent, sans intervention.
    e.clock.advance(8 * DAY_MS);
    const b2 = await e.svc.cycleAutomatique(INST);
    expect(b2[0]!.retablies.length).toBe(2);
    expect((await e.req('GET', '/v1/public/tendances/pages/vignette-automobile')).json().titre).toBe('Vignette automobile — Kinshasa');
  });

  it('gel : le cycle automatique ne modifie rien ; la politique automatique n’approuve jamais un brouillon à envoyer', async () => {
    const e = await env();
    await e.req('POST', `/v1/tendances/installations/${INST}/gel`, 'u-rssi', { actif: true, motif: 'Incident sur le portail public' });
    expect((await e.svc.cycleAutomatique(INST))[0]!.appliquees).toEqual([]);
    await e.req('POST', `/v1/tendances/installations/${INST}/gel`, 'u-rssi', { actif: false, motif: 'Incident clos, reprise normale' });
    await e.svc.cycleAutomatique(INST);
    const social = e.svc.actions.find((a) => a.type === 'organic_social_draft');
    expect(social.every((a) => a.statut === 'PROPOSEE' && !a.automatique)).toBe(true);
  });
});
