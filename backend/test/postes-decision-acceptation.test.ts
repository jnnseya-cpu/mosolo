/**
 * Critères d'acceptation des postes de décision (Cahier nouvelle version, ch. 42 ; ch. 27). Chaque test porte le texte
 * du critère. Application complète, données de démonstration semées, horloge fixe.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { estRouteFinanciere } from '../src/plugins/postes/model.js';
import type { PostesModule } from '../src/plugins/postes/plugin.js';
import { DEMO } from '../src/seed.js';
import { callbackBody, createOrder, PROVIDER_SECRET, signedCallback, type TestEnv } from './helpers.js';

const MOTIF = 'Motif détaillé et vérifiable de la décision (test)';
/** Profils d'autorité : R01 à R05 et une autre autorité habilitée (consultation, § 27.9). */
const AUTORITES = [
  { role: 'R01', user: 'u-gouverneur' }, { role: 'R02', user: 'u-dircab' }, { role: 'R03', user: 'acces-u-sg' },
  { role: 'R04', user: 'vc-u-ministre-transports' }, { role: 'R05', user: 'u-ministre-finances' }, { role: 'AUTRE', user: 'postes-u-autorite-habilitee' },
];

async function full() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} } });
  await app.ready();
  const req: TestEnv['req'] = (method, url, user, body, headers = {}) => app.inject({
    method: method as 'GET', url,
    headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { payload: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  const env: TestEnv = { app, clock, req };
  const svc = app.ctx.ext.postes as PostesModule;
  return { env, app, clock, req, svc, ctx: app.ctx };
}

/** Tous les objets « chiffre » d'une charge utile (état + comparaison + source). */
function chiffres(v: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(v)) v.forEach((x) => chiffres(x, out));
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.etat === 'string' && 'comparaison' in o && 'source' in o) out.push(o);
    else Object.values(o).forEach((x) => chiffres(x, out));
  }
  return out;
}

describe('Critères d’acceptation des postes de décision (ch. 42)', () => {
  it('« Une autorité ouvrant la plateforme sans formation identifie en moins de quatre-vingt-dix secondes ce qui attend sa décision et ce qui ne va pas dans son périmètre. »', async () => {
    const { req } = await full();
    for (const a of AUTORITES) {
      const t0 = performance.now();
      // Aucune saisie : ni filtre, ni période, ni commune dans la requête.
      const r = await req('GET', '/v1/postes/accueil', a.user);
      const ms = performance.now() - t0;
      expect(r.statusCode, a.user).toBe(200);
      const b = r.json();
      expect(b.zeroSaisie, a.user).toBe(true);
      expect(b.exercice).toBe('2026');
      // Ce qui attend sa décision (en-tête chiffré) et ce qui ne va pas (alertes ou exceptions) sont présents d'emblée.
      expect(typeof b.entete.enAttente, a.user).toBe('number');
      expect(b.entete.libelle, a.user).toMatch(/dossier|corbeille/);
      const cequinevapas = b.bloc3 ?? b.mesExceptions ?? b.alertes ?? b.actes ?? b.aTraiter ?? b.decidePasExecute;
      expect(Array.isArray(cequinevapas) || Array.isArray(cequinevapas?.alertes), a.user).toBe(true);
      expect(b.budget, a.user).toBeTruthy();
      expect(b.budget.maxSecondes).toBeLessThanOrEqual(900);
      // Budget de réponse de l'API très inférieur au budget d'attention (le rendu reste dans les 90 s visées).
      expect(ms, `${a.user} ${ms} ms`).toBeLessThan(2000);
    }
    const g = (await req('GET', '/v1/postes/accueil', 'u-gouverneur')).json();
    expect(g.bloc1.fiches.length).toBeGreaterThan(0);
    expect(g.bloc1.fiches.length).toBeLessThanOrEqual(3);
    expect(g.bloc2.chiffres).toHaveLength(4);
    expect(g.bloc3.alertes.length).toBeLessThanOrEqual(3);
    expect(g.menu.map((m: { libelle: string }) => m.libelle)).toEqual(['Décisions', 'Recettes', 'Alertes', 'Communes', 'Rechercher']);
    expect(g.reperes.map((x: { valeur: string }) => x.valeur)).toEqual(['90 s', '3', 'Lundi']);
  });

  it('« Aucun écran d’accueil d’un poste de décision n’affiche de donnée fiscale individuelle, y compris celui du Gouverneur. »', async () => {
    const { req, ctx } = await full();
    const tp = ctx.taxpayers.taxpayers.all();
    const individualAmounts = ctx.assessment.obligations.all().map((o) => o.amount.amount);
    for (const a of AUTORITES) {
      const r = await req('GET', '/v1/postes/accueil', a.user);
      const raw = r.body;
      for (const t of tp) {
        expect(raw, `${a.user} : nom`).not.toContain(t.fullName);
        expect(raw, `${a.user} : téléphone`).not.toContain(t.phone);
        expect(raw, `${a.user} : identifiant fiscal`).not.toContain(t.id);
      }
      expect(raw).not.toMatch(/\+243\d{9}/);
      const b = r.json();
      for (const f of [...(b.bloc1?.fiches ?? []), ...(b.fiches ?? []), ...(b.mesDecisions?.fiches ?? [])]) {
        if (!f.individuel) continue;
        // Montant individuel jamais exact sur un écran d'accueil : tranche seulement ; pièces nominatives masquées.
        for (const c of f.enjeu.chiffres) expect(c.valeur, f.id).toBeNull();
        expect(f.pieces.items, f.id).toEqual([]);
      }
      // Aucun montant d'une obligation individuelle n'apparaît en tant qu'enjeu de fiche.
      for (const c of chiffres(b).filter((x) => x.code === 'ENJEU')) expect(individualAmounts).not.toContain(c.valeur);
    }
    // Le dossier nominatif n'est ouvert qu'avec une finalité déclarée, enregistrée et journalisée.
    const fin = (await req('GET', '/v1/postes/corbeille', 'u-ministre-finances')).json().fiches.find((f: { individuel: boolean }) => f.individuel);
    expect((await req('GET', `/v1/postes/fiches/${encodeURIComponent(fin.id)}`, 'u-ministre-finances')).json().code).toBe('FINALITE_REQUISE');
    const ok = await req('GET', `/v1/postes/fiches/${encodeURIComponent(fin.id)}?finalite=${encodeURIComponent('Décision sur la demande d’exonération (test)')}`, 'u-ministre-finances');
    expect(ok.statusCode).toBe(200);
    expect(ctx.audit.list({ action: 'postes.fiche.consultation_nominative', resourceId: fin.id }).total).toBe(1);
  });

  it('« Aucun poste de décision ne permet de modifier une dette, un paiement, une quittance ou un compte bénéficiaire : test négatif obligatoire pour chaque profil d’autorité. »', async () => {
    const { env, req, app, ctx } = await full();
    // Une quittance réelle (paiement confirmé du contribuable de démonstration) pour le test sur la quittance.
    const order = (await createOrder(env)).json();
    await signedCallback(env, callbackBody(env, order.paymentReference));
    const receipt = ctx.receipts.receipts.all()[0]!;
    const obligation = ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    const entry = ctx.ledger.list()[0];
    const attempts: [string, string, unknown][] = [
      ['dette — liquidation', '/v1/assessments/calculate', { ruleId: 'x', taxpayerId: DEMO.taxpayerId, objectId: 'x', inputs: {} }],
      ['dette — remise', '/v1/recouvrement/remises/REM-X/decision', { granted: true, motivation: MOTIF }],
      ['dette — non-valeur', '/v1/recouvrement/non-valeurs/NV-X/decision', { decision: 'ADMISE', motivation: MOTIF }],
      ['dette/paiement — contre-écriture', `/v1/ledger/entries/${entry?.id ?? 'LE-1'}/reversals`, { reason: MOTIF }],
      ['paiement — ordre', `/v1/obligations/${obligation.id}/payment-orders`, { channel: 'MOBILE_MONEY' }],
      ['paiement — opération du Trésor', '/v1/tresor/operations', { kind: 'REMBOURSEMENT', motif: MOTIF }],
      ['quittance — duplicata', `/v1/receipts/${receipt.number}/duplicates`, {}],
      ['compte bénéficiaire — proposition', '/v1/beneficiary-accounts/change-requests', { alias: DEMO.dgipkAlias, bankName: 'Banque', accountNumber: 'CD00 1', holderName: 'X', reason: MOTIF }],
      ['compte bénéficiaire — approbation', '/v1/beneficiary-accounts/change-requests/BCR-X/approve', { outOfBandVerified: true }],
      ['compte bénéficiaire — veto', '/v1/beneficiary-accounts/change-requests/BCR-X/veto', { motif: MOTIF }],
    ];
    for (const a of AUTORITES) {
      for (const [label, url, body] of attempts) {
        const r = await req('POST', url, a.user, body, { 'idempotency-key': `${a.user}-${label}` });
        expect([400, 403, 404, 422], `${a.user} ${label} → ${r.statusCode} ${r.body.slice(0, 120)}`).toContain(r.statusCode);
        expect(r.statusCode, `${a.user} ${label}`).not.toBeLessThan(400);
      }
    }
    // L'API des postes n'expose aucune route de cette nature, et ne relaie jamais vers une route financière.
    const routes = app.printRoutes({ commonPrefix: false }).split('\n').filter((l) => l.includes('/v1/postes'));
    expect(routes.length).toBeGreaterThan(10);
    for (const l of routes) expect(l).not.toMatch(/obligation|payment|paiement|receipt|quittance|beneficiar|ledger|dette/i);
    const svc = ctx.ext.postes as PostesModule;
    for (const it of svc.items()) for (const f of [it.approuver, it.refuser]) if (f) expect(estRouteFinanciere(f.url), it.id).toBe(false);
    // Un changement de compte bénéficiaire en attente n'est jamais approuvable depuis une corbeille.
    await req('POST', '/v1/beneficiary-accounts/change-requests', 'u-tresor', { alias: DEMO.dgipkAlias, bankName: 'Banque (test)', accountNumber: 'CD00 0000 0000 0000 0000 9999', holderName: 'DGIPK (test)', reason: 'Changement de banque décidé (test)' });
    const coffre = svc.items().find((i) => i.source === 'COFFRE');
    expect(coffre).toBeTruthy();
    expect(coffre!.approuver).toBeUndefined();
    expect(coffre!.fondement).toEqual([]);
  });

  it('« Tout montant affiché sur un poste de décision porte son état, sa date et, le cas échéant, son taux de conversion, y compris après export. »', async () => {
    const { req } = await full();
    for (const a of AUTORITES) {
      const b = (await req('GET', '/v1/postes/accueil', a.user)).json();
      const cs = chiffres(b);
      expect(cs.length, a.user).toBeGreaterThan(0);
      for (const c of cs) {
        expect(c.etat, `${a.user} ${String(c.code)}`).toBeTruthy();
        expect(c.etatLabel).toBeTruthy();
        expect(String(c.date)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(c.comparaison).toBeTruthy();
        if (c.equivalents) expect(c.taux, `${a.user} ${String(c.code)} : taux`).toMatchObject({ devise: 'USD', cdfParUnite: expect.any(String), date: expect.any(String) });
        expect((c.source as { chemin: string[] }).chemin.length).toBeLessThanOrEqual(3);
      }
    }
    // Export CSV : état, estimation, date et taux conservés sur chaque ligne.
    const csv = await req('GET', '/v1/postes/accueil/export?format=csv', 'u-gouverneur');
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const [head, ...lines] = csv.body.split('\n');
    const cols = head!.split(';');
    expect(cols).toEqual(expect.arrayContaining(['etat', 'estimation', 'date_production', 'taux', 'equivalent_USD']));
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) {
      const v = l.split(';');
      expect(v[cols.indexOf('etat')], l).toBeTruthy();
      expect(v[cols.indexOf('date_production')], l).toMatch(/^\d{4}-\d{2}-\d{2}/);
      if (v[cols.indexOf('equivalent_USD')]) expect(v[cols.indexOf('taux')], l).toMatch(/1 USD = \d+ CDF/);
    }
    // Une estimation reste visuellement distincte dans l'export (vue « Recettes » : potentiel estimé).
    const rec = (await req('GET', '/v1/postes/accueil/export?format=csv&vue=recettes', 'u-gouverneur')).body.split('\n');
    expect(rec.find((l) => l.startsWith('POTENTIEL;'))).toMatch(/;ESTIMATION;/);
    expect(rec.find((l) => l.startsWith('RAPPROCHE;'))).toMatch(/;CONSTATÉ;/);
    // Export imprimable (HTML/PDF par impression) : mêmes mentions.
    const html = await req('GET', '/v1/postes/accueil/export?format=html&vue=recettes', 'u-gouverneur');
    expect(html.body).toContain('Encaissé');
    expect(html.body).toContain('1 USD = ');
    expect(html.body).toContain('class="estimation"');
    // Note du lundi imprimée : état, date et taux sur chaque chiffre, empreinte.
    const note = (await req('GET', '/v1/postes/notes', 'u-gouverneur')).json().courante;
    const imp = await req('GET', `/v1/postes/notes/${note.id}/impression`, 'u-gouverneur');
    expect(imp.body).toContain('Rapproché');
    expect(imp.body).toContain(note.sha256);
  });

  it('« Toute décision prise, refusée, déléguée ou différée depuis une corbeille est motivée et enregistrée au journal d’audit avec son auteur. »', async () => {
    const { req, ctx, svc } = await full();
    const id = (cat: string, dest = 'R01') => `DOSSIER:${svc.dossiers.findOne((d) => d.categorie === cat && d.destinataireRole === dest)!.id}`;
    const act = (user: string, fiche: string, body: Record<string, unknown>) => req('POST', `/v1/postes/fiches/${encodeURIComponent(fiche)}/action`, user, body);
    const last = (action: string) => ctx.audit.list({ action, limit: 1_000 }).items.at(-1)!;
    // Motif manquant ou trop court : refusé, pour chacune des issues.
    for (const action of ['APPROUVER', 'REFUSER', 'DELEGUER', 'COMPLEMENT']) {
      const r = await act('u-gouverneur', id('SUSPENSION_TIERS'), { action });
      expect(r.statusCode, action).toBe(400);
      expect(r.json().code).toBe('MOTIF_OBLIGATOIRE');
      expect((await act('u-gouverneur', id('SUSPENSION_TIERS'), { action, motif: 'court' })).statusCode).toBe(400);
    }
    expect((await req('POST', '/v1/postes/cabinet/ordre-du-jour', 'u-dircab', { ficheId: id('ARBITRAGE_ASSIGNATIONS'), action: 'DIFFERER', reexamenLe: '2026-10-01' })).statusCode).toBe(400);
    // Décision prise (approuvée).
    expect((await act('u-gouverneur', id('SUSPENSION_TIERS'), { action: 'APPROUVER', motif: MOTIF })).statusCode).toBe(200);
    expect(last('postes.dossier.approuve')).toMatchObject({ actor: { kind: 'user', id: 'u-gouverneur' }, details: { motif: MOTIF } });
    // Décision refusée.
    expect((await act('u-gouverneur', id('ARBITRAGE_ASSIGNATIONS'), { action: 'REFUSER', motif: MOTIF })).statusCode).toBe(200);
    expect(last('postes.dossier.refuse')).toMatchObject({ actor: { id: 'u-gouverneur' }, details: { motif: MOTIF } });
    // Décision déléguée.
    expect((await act('u-ministre-finances', id('EXONERATION_DEGREVEMENT', 'R05'), { action: 'DELEGUER', motif: MOTIF, delegataireId: 'acces-u-chef-service', jusquau: '2026-10-06' })).statusCode).toBe(200);
    expect(last('postes.delegation.creee')).toMatchObject({ actor: { id: 'u-ministre-finances' }, details: { motif: MOTIF, delegataireId: 'acces-u-chef-service' } });
    // Décision différée (ordre du jour du Gouverneur, par le cabinet) et complément demandé.
    const d2 = await req('POST', '/v1/postes/dossiers', 'u-ministre-finances', {
      categorie: 'AFFECTATION_FONDS', destinataireRole: 'R01', objet: 'Retenir un scénario d’emploi des fonds (test)', serviceInstructeur: 'Finances (test)', validationAmont: null,
      enjeu: { texte: 'Fonds disponibles (test)', etat: 'DISPONIBLE' }, echeance: '2026-10-15', consequenceSilence: 'Fonds non affectés (test).', fondement: ['Budget provincial voté (fictif, test)'],
      position: { recommandation: 'Scénario A recommandé (test).', reserves: [] }, siRien: 'Fonds non affectés (test).', pieces: [],
      execution: { acte: 'NOTE', libelle: 'Note d’affectation (test)', responsable: { entity: 'MINFIN', role: 'R05', libelle: 'Finances' }, delaiJours: 5 }, individuel: false, entities: ['MINFIN'],
    });
    await req('POST', `/v1/postes/cabinet/dossiers/${d2.json().id}/preparation`, 'u-dircab', { action: 'TRANSMETTRE', motif: 'Dossier instruit, prêt pour le Gouverneur (test)' });
    expect((await req('POST', '/v1/postes/cabinet/ordre-du-jour', 'u-dircab', { ficheId: `DOSSIER:${d2.json().id}`, action: 'DIFFERER', motif: MOTIF, reexamenLe: '2026-10-01' })).statusCode).toBe(200);
    expect(last('postes.ordre.differer')).toMatchObject({ actor: { id: 'u-dircab' }, details: { motif: MOTIF, reexamenLe: '2026-10-01' } });
    const fin = id('EXONERATION_DEGREVEMENT', 'R05');
    expect((await act('u-ministre-finances', fin, { action: 'COMPLEMENT', motif: MOTIF })).statusCode).toBe(200);
    expect(last('postes.fiche.complement_demande')).toMatchObject({ actor: { id: 'u-ministre-finances' }, details: { motif: MOTIF } });
    // Historique consultable par l'autorité (menu « Décisions ») : chaque geste avec son motif.
    const h = (await req('GET', '/v1/postes/corbeille', 'u-gouverneur')).json().historique;
    expect(h.map((g: { geste: string; motif: string }) => [g.geste, g.motif])).toEqual(expect.arrayContaining([['APPROUVER', MOTIF], ['REFUSER', MOTIF]]));
  });
});
