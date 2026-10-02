/**
 * Critères d'acceptation NON NÉGOCIABLES de la spécification v1.0 du moteur de paiement, de répartition, de commissions
 * et de règlement (§ 29, reçue le 29/09/2026) : un test nommé par critère, titre citant le critère.
 */
import { randomUUID } from 'node:crypto';
import { Money } from '@mosolo/shared';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { accesPlugin } from '../src/plugins/acces/plugin.js';
import { canauxPlugin } from '../src/plugins/canaux/plugin.js';
import { allocateTransaction, defaultBeneficiaries, defaultPool, MODULE_DES_REGLES, sumLines } from '../src/plugins/pilotage/repartition/moteur/model.js';
import { moteurRepartitionPlugin } from '../src/plugins/pilotage/repartition/moteur/plugin.js';
import type { MoteurRepartitionService } from '../src/plugins/pilotage/repartition/moteur/service.js';
import { repartitionPlugin } from '../src/plugins/pilotage/repartition/plugin.js';
import { tresorPlugin } from '../src/plugins/tresor/plugin.js';
import type { MosoloPlugin } from '../src/plugins/types.js';
import { DEMO } from '../src/seed.js';
import { callbackBody, PROVIDER_SECRET, publishCertifiedRule, signedCallback } from './helpers.js';
import { activateKey, activateV1, B, keyRule, money, payAndReconcile, refund, setupMoteur, type MEnv } from './moteur-helpers.js';

/** Obligation supplémentaire (copie de l'obligation de démonstration, 150,00 USD) pour plusieurs transactions. */
function extraObligation(env: MEnv, id: string): string {
  const ob = env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
  env.app.ctx.assessment.obligations.insert({ ...ob, id, status: 'EXIGIBLE' });
  return id;
}

/** Scénario : clé et V1 actives ; paiement électronique attribué à un agent direct, paiement en espèces, agent de sous-traitant. */
async function scenario() {
  const env = await setupMoteur();
  await activateKey(env);
  await activateV1(env);
  env.app.ctx.users.add({ id: 'u-chef-service', name: 'Chef de service (test)', roles: ['R07'], entity: 'DGIPK' });
  env.app.ctx.users.add({ id: 'u-agent-st', name: 'Agent de sous-traitant (test)', roles: ['R10'], entity: 'ST-1' });
  env.app.ctx.users.add({ id: 'u-st-gerant', name: 'Gérant du sous-traitant (test)', roles: ['R35'], entity: 'ST-1' });
  env.app.ctx.users.add({ id: 'u-ministre-transports', name: 'Ministre des Transports (test)', roles: ['R04'], entity: 'MIN-TRANSPORTS' });
  // Registre terrain (sous-traitant ST-1, géré par u-st-gerant) — lecture seule par le moteur.
  const subs = [{ id: 'ST-1', managers: ['u-st-gerant'] }];
  const agents = [{ id: 'u-agent-st', subcontractorId: 'ST-1' }];
  env.app.ctx.ext.terrain = { subcontractors: { find: (p: (s: (typeof subs)[number]) => boolean) => subs.filter(p) }, agents: { find: (p: (a: (typeof agents)[number]) => boolean) => agents.filter(p), get: (id: string) => agents.find((a) => a.id === id) } };
  const o1 = await payAndReconcile(env);
  const o2 = await payAndReconcile(env, 'AGENT_POINT', extraObligation(env, 'OB-TEST-ESPECES'));
  const o3 = await payAndReconcile(env, 'MOBILE_MONEY', extraObligation(env, 'OB-TEST-ST'));
  const attrib = [{ orderId: o1.id, agentId: 'u-agent-terrain' }, { orderId: o3.id, agentId: 'u-agent-st' }];
  env.app.ctx.ext.sanctions = { commissions: { lines: () => attrib.map((x) => ({ source: 'PAIEMENT', state: 'ACQUISE', ...x })) } };
  const s = await env.req('POST', `${B}/synchroniser`, 'u-tresor', {});
  expect(s.json().created).toBe(3);
  return { env, o1, o2, o3 };
}

const lineAmounts = (svc: MoteurRepartitionService, orderId: string) => Object.fromEntries(svc.allocations.get(`AL-${orderId}`)!.lines.map((l) => [l.beneficiary, l.amount.amount]));

describe('§ 29 — critères d’acceptation non négociables (spécification v1.0)', () => {
  it('« référence unique immuable par paiement »', async () => {
    const { env, o1, o2, o3 } = await scenario();
    const refs = [o1, o2, o3].map((o) => o.paymentReference);
    expect(new Set(refs).size).toBe(3);
    for (const o of [o1, o2, o3]) expect(env.svc.allocations.get(`AL-${o.id}`)!.paymentReference).toBe(o.paymentReference);
    // Répartitions et écritures en ajout seul : aucune méthode de modification ni de suppression.
    for (const repo of [env.svc.allocations, env.svc.contrepassations, env.svc.ecritures] as object[]) {
      expect('update' in repo).toBe(false);
      expect('delete' in repo).toBe(false);
    }
  });

  it('« module d’origine identifié »', async () => {
    const { env, o1 } = await scenario();
    expect(env.svc.allocations.get(`AL-${o1.id}`)).toMatchObject({ ruleCode: 'DEMO-IF-BATI', module: 'V-propriete', moduleLabel: expect.stringMatching(/Propriété/) });
  });

  it('« chaque module résolu vers son ministère / département »', async () => {
    const env = await setupMoteur();
    for (const m of new Set(MODULE_DES_REGLES.map((x) => x.module))) {
      const code = `TEST-${m.replace(/^V-/, '').toUpperCase()}`;
      const own = env.svc.owner(m === 'V-propriete' ? 'X-IF-X' : m === 'V-locatif' ? 'X-IRL-X' : ({ M11: 'VIGNETTE', M76: 'RKP', M14: 'STAT', M12: 'TRANSP', M13: 'EMBARQ', M62: 'AVIA', M25: 'PEAGE', M24: 'PORT', M15: 'PUB', M16: 'ANTENNE', M17: 'BOISSON', M18: 'PLAST', M19: 'ASSAIN', M20: 'MARCHE', M21: 'SPECT', M22: 'CARRIERE', M23: 'FOREST', M10: 'PATENTE' } as Record<string, string>)[m] ?? code);
      expect(own.module, m).toBe(m);
      expect(own.entity, m).not.toBe('A_RATTACHER');
      expect(['FICHE_ACTIVE', 'TUTELLE_PAR_DEFAUT']).toContain(own.basis);
    }
  });

  it('« chaque transaction rapprochée éligible = 100 % »', async () => {
    const { env } = await scenario();
    // Un paiement confirmé mais non rapproché n'entre jamais dans la répartition.
    const ob = extraObligation(env, 'OB-TEST-NONRAPPROCHE');
    const order = (await env.req('POST', `/v1/obligations/${ob}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).json();
    await signedCallback(env, callbackBody(env, order.paymentReference));
    await env.req('POST', `${B}/synchroniser`, 'u-tresor', {});
    expect(env.svc.allocations.all().filter((a) => !a.demo)).toHaveLength(3);
    for (const a of env.svc.allocations.all().filter((a) => !a.demo)) expect(sumLines(a.lines, 'USD').equals(Money.fromJSON(a.base)), a.id).toBe(true);
  });

  it('« 100 $ agent direct = 70 / 10 / 10 / 10 »', () => {
    const lines = allocateTransaction(Money.of('100.00', 'USD'), { beneficiaries: defaultBeneficiaries(), pool: defaultPool() }, { entity: 'DGIPK', entityLabel: 'DGIPK', entityType: 'DEPARTEMENT', pool: { agentId: 'A', agentType: 'DIRECT_DEPARTMENT', subcontractorId: null, module: 'V-propriete' } });
    expect(lines.map((l) => [l.beneficiaryType, l.amount.amount])).toEqual([['GROUPE_NSEYA', '10.00'], ['DEPARTEMENT', '10.00'], ['AGENT', '10.00'], ['GOUVERNORAT', '70.00']]);
  });

  it('« 100 $ agent de sous-traitant = 70 / 10 / 10 / 7 / 3 »', async () => {
    const lines = allocateTransaction(Money.of('100.00', 'USD'), { beneficiaries: defaultBeneficiaries(), pool: defaultPool() }, { entity: 'DGIPK', entityLabel: 'DGIPK', entityType: 'DEPARTEMENT', pool: { agentId: 'A', agentType: 'SUBCONTRACTOR_AGENT', subcontractorId: 'ST', module: 'V-propriete' } });
    expect(lines.map((l) => [l.beneficiaryType, l.amount.amount])).toEqual([['GROUPE_NSEYA', '10.00'], ['DEPARTEMENT', '10.00'], ['AGENT', '7.00'], ['SOUS_TRAITANT', '3.00'], ['GOUVERNORAT', '70.00']]);
    // Même règle dans le moteur (150 $ : 105 / 15 / 15 / 10,50 / 4,50).
    const { env, o3 } = await scenario();
    expect(lineAmounts(env.svc, o3.id)).toEqual({ GROUPE_NSEYA: '15.00', 'ENTITE:DGIPK': '15.00', 'AGENT:u-agent-st': '10.50', 'SOUS_TRAITANT:ST-1': '4.50', GOUVERNORAT: '105.00' });
  });

  it('« visibilité plateforme pour Groupe Nseya, Gouverneur, directeur de cabinet, secrétaire exécutif, ministre des Finances »', async () => {
    const { env } = await scenario();
    for (const u of ['u-superadmin', 'u-gouverneur', 'u-dircab', 'acces-u-sg', 'u-ministre-finances']) {
      const r = await env.req('GET', `${B}/tableau/executif`, u);
      expect(r.statusCode, u).toBe(200);
      expect(r.json().parDevise[0].cartes[0].montant, u).toEqual(money('450.00'));
    }
    // Groupe Nseya (R38) : lecture de toute la plateforme (journaux d'audit, Trésor, répartition), jamais d'écriture.
    for (const url of ['/v1/audit/events?limit=5', '/v1/pilotage/repartition', '/v1/tresor/operations']) expect((await env.req('GET', url, 'u-superadmin')).statusCode, url).toBe(200);
    expect((await env.req('POST', '/v1/pilotage/repartition/automatisation/executer', 'u-superadmin', {})).statusCode).toBe(403);
    expect((await env.req('POST', `${B}/regles/KIN-DEFAULT-V1/activation`, 'u-superadmin', { approve: true, motif: 'Tentative d’activation (test).' })).statusCode).toBe(403);
    // Un ministre ordinaire n'a pas la vue d'ensemble.
    expect((await env.req('GET', `${B}/tableau/executif`, 'u-ministre-transports')).statusCode).toBe(403);
  });

  it('« un ministère ne voit pas un autre ministère sauf autorisation distincte »', async () => {
    const { env } = await scenario();
    const own = (await env.req('GET', `${B}/tableau/entite`, 'u-dg-dgipk')).json();
    expect(own.parDevise[0].droit.droit).toEqual(money('45.00'));
    const other = (await env.req('GET', `${B}/tableau/entite`, 'u-ministre-transports')).json();
    expect(other.parDevise).toEqual([]);
    expect((await env.req('GET', `${B}/tableau/entite?entity=DGIPK`, 'u-ministre-transports')).json().code).toBe('HORS_PERIMETRE');
    expect((await env.req('GET', `${B}/expliquer?beneficiaire=ENTITE:DGIPK`, 'u-ministre-transports')).json().code).toBe('HORS_PERIMETRE');
    expect((await env.req('GET', '/api/finance/ministry/DGIPK', 'u-ministre-transports')).statusCode).toBe(403);
    // Le ministre des Finances (tutelle de la DGIPK) voit son périmètre ; l'exécutif peut ouvrir un périmètre désigné.
    expect((await env.req('GET', `${B}/tableau/entite?entity=DGIPK`, 'u-gouverneur')).json().parDevise[0].droit.droit).toEqual(money('45.00'));
  });

  it('« un agent ne voit pas le compte privé d’un autre »', async () => {
    const { env, o3 } = await scenario();
    const mine = (await env.req('GET', `${B}/tableau/agent`, 'u-agent-terrain')).json();
    expect(mine.parDevise[0].droit).toEqual(money('15.00'));
    expect((await env.req('GET', `${B}/expliquer?beneficiaire=AGENT:u-agent-st`, 'u-agent-terrain')).statusCode).toBe(403);
    expect((await env.req('GET', '/api/finance/agent/u-agent-st', 'u-agent-terrain')).statusCode).toBe(403);
    expect((await env.req('GET', `${B}/transactions/AL-${o3.id}`, 'u-agent-terrain')).statusCode).toBe(403);
    const other = (await env.req('GET', `${B}/tableau/agent`, 'u-agent-st')).json();
    expect(other.parDevise[0].droit).toEqual(money('10.50'));
    expect(JSON.stringify(other)).not.toContain('u-agent-terrain');
  });

  it('« un sous-traitant descend vers ses agents »', async () => {
    const { env, o3 } = await scenario();
    const st = (await env.req('GET', `${B}/tableau/sous-traitant`, 'u-st-gerant')).json();
    expect(st.parRecette[0]).toMatchObject({ recetteGeneree: money('150.00'), agents: { droit: money('10.50') }, monDroit: { droit: money('4.50') } });
    expect(st.parRecette[0].parAgent).toEqual([{ agentId: 'u-agent-st', transactions: 1, recette: money('150.00'), agent: money('10.50'), sousTraitant: money('4.50') }]);
    const tx = (await env.req('GET', `${B}/transactions?beneficiaire=AGENT:u-agent-st`, 'u-st-gerant')).json();
    expect(tx.items).toHaveLength(1);
    expect((await env.req('GET', `${B}/transactions/AL-${o3.id}`, 'u-st-gerant')).statusCode).toBe(200);
    expect((await env.req('GET', `${B}/expliquer?beneficiaire=AGENT:u-agent-terrain`, 'u-st-gerant')).statusCode).toBe(403);
  });

  it('« Groupe Nseya descend ville → ministère → module → agent → transaction »', async () => {
    const { env, o1 } = await scenario();
    const ns = (await env.req('GET', `${B}/tableau/groupe-nseya`, 'u-superadmin')).json();
    const ville = ns.controleVille[0];
    expect(ville.groupes[0]).toMatchObject({ code: 'TOTAL', montant: money('450.00') });
    expect(ville.parEntite.map((e: { key: string }) => e.key)).toEqual(['DGIPK']);
    expect(ville.parModule.map((e: { key: string }) => e.key)).toEqual(['V-propriete']);
    expect(ville.parAgent.map((e: { key: string }) => e.key)).toEqual(['u-agent-st', 'u-agent-terrain']);
    const txs = (await env.req('GET', `${B}/transactions?agent=u-agent-terrain&entity=DGIPK&module=V-propriete`, 'u-superadmin')).json();
    expect(txs.donneesPersonnelles).toBe('PSEUDONYMISEES');
    const detail = (await env.req('GET', `${B}/transactions/${txs.items[0].allocationId}`, 'u-superadmin')).json();
    expect(detail.repartition).toMatchObject({ complete: true, egalRecette: true });
    // Aucune donnée personnelle sans motif déclaré ; avec motif : visible et journalisée (C42-05).
    const raw = JSON.stringify([ns, txs, detail]);
    for (const s of [DEMO.taxpayerId, o1.paymentReference, 'Mbuyi', 'Kalala', 'taxpayerId']) expect(raw).not.toContain(s);
    const withMotif = (await env.req('GET', `${B}/transactions/${txs.items[0].allocationId}`, 'u-superadmin', undefined, { 'x-motif-consultation': encodeURIComponent('Contrôle d’un écart de règlement (test)') })).json();
    expect(withMotif.transaction.taxpayerId).toBe(DEMO.taxpayerId);
    expect(env.app.ctx.audit.list({ action: 'moteur.donnees_personnelles.consultees' }).items.at(-1)).toMatchObject({ actor: { id: 'u-superadmin' }, details: { motif: 'Contrôle d’un écart de règlement (test)', motifDeclare: true } });
    // Le dossier individuel passe par la consultation motivée existante.
    // (hors périmètre : bris de glace à authentification forte, motif et journal — jamais un accès silencieux).
    const c = await env.req('POST', '/v1/acces/consultations', 'u-superadmin', { taxpayerId: DEMO.taxpayerId, purpose: 'CONTROLE', motif: 'Contrôle financier de la ville (test)' });
    expect(c.statusCode, c.body).not.toBe(403);
    expect(c.json().code).toBe('MFA_REQUIRED');
    // Lecture directe d'un dossier de contribuable sans consultation : refusée.
    expect((await env.req('GET', `/v1/taxpayers/${DEMO.taxpayerId}`, 'u-superadmin')).statusCode).toBe(403);
  });

  it('« espèces et électronique par le même moteur »', async () => {
    const { env, o1, o2 } = await scenario();
    const e = env.svc.allocations.get(`AL-${o1.id}`)!; const c = env.svc.allocations.get(`AL-${o2.id}`)!;
    expect([e.methode, c.methode]).toEqual(['ELECTRONIQUE', 'ESPECES']);
    expect(e.versionId).toBe(c.versionId);
    expect(lineAmounts(env.svc, o2.id)).toMatchObject({ GROUPE_NSEYA: '15.00', GOUVERNORAT: '105.00' });
    const x = (await env.req('GET', `${B}/expliquer?beneficiaire=GROUPE_NSEYA`, 'u-ministre-finances')).json().parDevise[0];
    expect(x).toMatchObject({ droitCalcule: money('45.00'), electronique: money('30.00'), especes: money('15.00') });
  });

  it('« pourcentages ≠ 100 % refusés »', async () => {
    const env = await setupMoteur();
    const bs = defaultBeneficiaries().map((b) => (b.code === 'GROUPE_NSEYA' ? { ...b, pct: '10.001' } : b));
    const p = (await env.req('POST', `${B}/regles`, 'u-validateur-financier', { label: 'Total 100,001 % (test)', beneficiaries: bs, effectiveFrom: '2026-11-01', legalBasis: 'Test du total', motif: 'Proposition au total erroné (test).' })).json();
    expect(p.sum).toBe('100.001');
    expect((await env.req('POST', `${B}/regles/${p.id}/verification`, 'u-juriste-verificateur', { approve: true, motif: 'Vérification du total (test).' })).json().code).toBe('SOMME_DIFFERENTE_DE_100');
  });

  it('« tout changement de taux crée une version »', async () => {
    const env = await setupMoteur();
    const before = env.svc.versions.get('KIN-DEFAULT-V1');
    const p = await env.req('POST', `${B}/regles`, 'u-ministre-finances', { label: 'Taux modifié (test)', beneficiaries: defaultBeneficiaries().map((b) => (b.code === 'GROUPE_NSEYA' ? { ...b, pct: '9' } : b.code === 'GOUVERNEMENT_PROVINCIAL' ? { ...b, pct: '71' } : b)), effectiveFrom: '2026-12-01', legalBasis: 'Avenant fictif', motif: 'Changement de taux (test).' });
    expect(p.json()).toMatchObject({ id: 'KIN-DEFAULT-V2', version: 2 });
    expect(env.svc.versions.get('KIN-DEFAULT-V1')).toEqual(before);
    // Aucune route ne modifie une version existante.
    for (const m of ['PUT', 'PATCH', 'DELETE']) expect((await env.req(m, `${B}/regles/KIN-DEFAULT-V1`, 'u-ministre-finances', {})).statusCode).toBe(404);
  });

  it('« l’historique garde sa version »', async () => {
    const { env, o1 } = await scenario();
    const before = env.svc.allocations.get(`AL-${o1.id}`)!;
    env.clock.set('2026-11-15T09:00:00.000Z');
    await publishCertifiedRule(env, keyRule({ part_groupe_nseya: '8', part_tutelle: '10', part_agents: '10', part_gouvernement: '72' }, '2026-12-01'));
    const v2 = (await env.req('POST', `${B}/regles`, 'u-superadmin', { label: 'V2 à 8 % (test)', beneficiaries: defaultBeneficiaries().map((b) => (b.code === 'GROUPE_NSEYA' ? { ...b, pct: '8' } : b.code === 'GOUVERNEMENT_PROVINCIAL' ? { ...b, pct: '72' } : b)), effectiveFrom: '2026-12-01', legalBasis: 'Avenant fictif', motif: 'Changement de taux (test).' })).json();
    for (const [s, u] of [['verification', 'u-juriste-verificateur'], ['approbation', 'u-dircab'], ['activation', 'u-gouverneur']] as const) expect((await env.req('POST', `${B}/regles/${v2.id}/${s}`, u, { approve: true, motif: 'Décision motivée du circuit (test).' })).statusCode).toBe(200);
    await env.req('POST', `${B}/synchroniser`, 'u-tresor', {});
    expect(env.svc.allocations.get(`AL-${o1.id}`)).toEqual(before);
    expect(before.versionId).toBe('KIN-DEFAULT-V1');
  });

  it('« remboursement = contrepassation »', async () => {
    const { env, o1 } = await scenario();
    refund(env, o1.id);
    await env.req('POST', `${B}/synchroniser`, 'u-tresor', {});
    const cp = env.svc.contrepassations.get(`CP-${o1.id}`)!;
    expect(cp.lines.map((l) => [l.beneficiary, l.amount.amount])).toEqual([['GROUPE_NSEYA', '-15.00'], ['ENTITE:DGIPK', '-15.00'], ['AGENT:u-agent-terrain', '-15.00'], ['GOUVERNORAT', '-105.00']]);
    const tx = (await env.req('GET', `${B}/transactions?beneficiaire=GROUPE_NSEYA`, 'u-ministre-finances')).json();
    expect(tx.items.find((i: { allocationId: string }) => i.allocationId === `AL-${o1.id}`)).toMatchObject({ contrepasse: true, montant: money('-15.00'), montantInitial: money('15.00'), etat: 'CONTREPASSE' });
    expect(env.svc.ecritures.find((e) => e.orderId === o1.id).map((e) => e.type)).toEqual(['CONSTAT', 'CONTREPASSATION']);
  });

  it('« aucune écriture passée supprimable »', async () => {
    const { env } = await scenario();
    const n = env.svc.ecritures.count();
    for (const m of ['DELETE', 'PUT', 'PATCH']) {
      for (const url of [`${B}/transactions/AL-x`, `${B}/droits`, `${B}/demandes/DRG-000001`, '/api/entitlements/AL-x']) expect((await env.req(m, url, 'u-superadmin', {})).statusCode).toBe(404);
    }
    expect(env.svc.ecritures.count()).toBe(n);
    expect(env.svc.verifyChain()).toMatchObject({ valid: true });
  });

  it('« chaque chiffre de tableau expliqué par les écritures »', async () => {
    const { env } = await scenario();
    const dash = (await env.req('GET', `${B}/tableau/executif`, 'u-gouverneur')).json().parDevise[0];
    expect(dash.controle.egal).toBe(true);
    const balances = (await env.req('GET', `${B}/droits`, 'u-gouverneur')).json().reel;
    for (const g of dash.groupes as { code: string; droit: { amount: string }; expliquer: string }[]) {
      const x = (await env.req('GET', `${B}/expliquer?${g.expliquer}`, 'u-gouverneur')).json().parDevise[0] ?? { droitCalcule: money('0.00'), controle: { egalAuDroit: true, electroniquePlusEspeces: true } };
      expect(x.droitCalcule, g.code).toEqual(g.droit);
      expect(x.controle).toMatchObject({ egalAuDroit: true, electroniquePlusEspeces: true });
      const t = (await env.req('GET', `${B}/transactions?${g.expliquer}&limit=500`, 'u-gouverneur')).json();
      const sum = t.items.reduce((m: Money, i: { montant: { amount: string; currency: 'USD' } }) => m.add(Money.fromJSON(i.montant)), Money.zero('USD'));
      expect(sum.toJSON(), g.code).toEqual(g.droit);
    }
    // Les soldes du sous-grand-livre (écritures) égalent les droits affichés.
    const nseya = balances.find((b: { beneficiary: string }) => b.beneficiary === 'GROUPE_NSEYA');
    expect(nseya.constate).toEqual(dash.groupes.find((g: { code: string }) => g.code === 'GROUPE_NSEYA').droit);
  });

  it('« règlement jamais supérieur au restant »', async () => {
    const { env } = await scenario();
    const over = await env.req('POST', `${B}/demandes`, 'u-superadmin', { beneficiary: 'GROUPE_NSEYA', currency: 'USD', amount: '15.01', motif: 'Demande supérieure au restant (test).' });
    expect(over.json().code).toBe('REGLEMENT_SUPERIEUR_AU_RESTANT');
    const d = (await env.req('POST', `${B}/demandes`, 'u-superadmin', { beneficiary: 'GROUPE_NSEYA', currency: 'USD', amount: '10.00', motif: 'Demande partielle (test).' })).json();
    expect(d.amount).toEqual(money('10.00'));
    await env.req('POST', `${B}/demandes/${d.id}/soumission`, 'u-superadmin', { motif: 'Soumission de la demande (test).' });
    // Une seconde demande ne peut pas dépasser le reste (15 − 10 déjà engagés).
    expect((await env.req('POST', `${B}/demandes`, 'u-superadmin', { beneficiary: 'GROUPE_NSEYA', currency: 'USD', amount: '5.01', motif: 'Seconde demande excessive (test).' })).json().code).toBe('REGLEMENT_SUPERIEUR_AU_RESTANT');
    expect((await env.req('POST', `${B}/demandes`, 'u-superadmin', { beneficiary: 'GROUPE_NSEYA', currency: 'USD', amount: '5.00', motif: 'Seconde demande au restant exact (test).' })).statusCode).toBe(201);
  });

  it('« rappels prestataire en double sans recette en double »', async () => {
    const env = await setupMoteur();
    const ob = env.app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;
    const order = (await env.req('POST', `/v1/obligations/${ob}/payment-orders`, 'u-contribuable', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': randomUUID() })).json();
    const body = callbackBody(env, order.paymentReference);
    await signedCallback(env, body);
    await signedCallback(env, body);
    await signedCallback(env, { ...body });
    const { postStatement } = await import('./helpers.js');
    await postStatement(env, 'u-tresor', { statementId: 'REL-DOUBLE-1', lines: [{ accountAlias: DEMO.dgipkAlias, amount: money('150.00'), valueDate: '2026-10-02', paymentReference: order.paymentReference }] });
    await env.req('POST', `${B}/synchroniser`, 'u-tresor', {});
    await env.req('POST', `${B}/synchroniser`, 'u-tresor', {});
    expect(env.svc.allocations.all().filter((a) => !a.demo)).toHaveLength(1);
    expect(env.svc.allocations.all().filter((a) => !a.demo)[0]!.base).toEqual(money('150.00'));
  });

  it('« références d’espèces en double sans encaissement en double »', async () => {
    const app = buildApp({ clock: new ManualClock('2026-10-02T09:00:00.000Z'), secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} }, plugins: [accesPlugin, canauxPlugin, tresorPlugin, repartitionPlugin, moteurRepartitionPlugin] as MosoloPlugin<unknown>[] });
    await app.ready();
    const req = (m: string, url: string, u: string, body?: unknown) => app.inject({ method: m as 'POST', url, headers: { 'x-demo-user': u, 'content-type': 'application/json', 'idempotency-key': randomUUID() }, payload: JSON.stringify(body ?? {}) });
    const ob = app.ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;
    const order = (await req('POST', `/v1/obligations/${ob}/payment-orders`, 'u-contribuable', { channel: 'AGENT_POINT' })).json();
    const first = await req('POST', '/v1/payment-points/PA-LIMETE-MM01/collections', 'canaux-op-limete', { paymentReference: order.paymentReference });
    expect(first.statusCode, first.body).toBe(201);
    const again = await req('POST', '/api/cash/collections', 'canaux-op-limete', { pointId: 'PA-LIMETE-MM01', reference: order.paymentReference });
    expect(again.statusCode).toBe(400);
    const twice = await req('POST', '/v1/payment-points/PA-LIMETE-MM01/collections', 'canaux-op-limete', { paymentReference: order.paymentReference });
    expect(twice.statusCode).toBe(409);
    expect(app.ctx.receipts.receipts.find((x) => x.paymentReference === order.paymentReference)).toHaveLength(1);
    const canaux = app.ctx.ext.canaux as { points: { collections: { find(p: (c: { paymentReference: string }) => boolean): unknown[] } } };
    expect(canaux.points.collections.find((c) => c.paymentReference === order.paymentReference)).toHaveLength(1);
  });

  it('« arithmétique décimale »', () => {
    const v = { beneficiaries: defaultBeneficiaries(), pool: defaultPool() };
    const ctx = { entity: 'DGIPK', entityLabel: 'DGIPK', entityType: 'DEPARTEMENT' as const, pool: { agentId: 'A', agentType: 'SUBCONTRACTOR_AGENT' as const, subcontractorId: 'ST', module: 'M' } };
    for (const [amount, cur] of [['0.07', 'USD'], ['33.33', 'USD'], ['1234.57', 'USD'], ['999999999999.99', 'CDF'], ['0.01', 'CDF']] as const) {
      const base = Money.of(amount, cur);
      const lines = allocateTransaction(base, v, ctx);
      expect(sumLines(lines, cur).equals(base), amount).toBe(true);
      for (const l of lines) expect(l.amount.amount).toMatch(/^-?\d+\.\d{2}$/);
    }
    expect(allocateTransaction(Money.of('33.33', 'USD'), v, ctx).map((l) => l.amount.amount)).toEqual(['3.33', '3.33', '2.33', '1.00', '23.34']);
  });

  it('« chaque action financière privilégiée auditée »', async () => {
    const { env } = await scenario();
    const d = (await env.req('POST', `${B}/demandes`, 'u-superadmin', { beneficiary: 'GROUPE_NSEYA', currency: 'USD', motif: 'Demande de règlement des espèces (test).' })).json();
    await env.req('POST', `${B}/demandes/${d.id}/soumission`, 'u-superadmin', { motif: 'Soumission de la demande (test).' });
    await env.req('POST', `${B}/couts`, 'u-superadmin', { provider: 'Hébergeur (test)', category: 'HEBERGEMENT', period: '2026-10', quantity: '1', unitCost: '1000.00', currency: 'USD', fundedBy: 'GROUPE_NSEYA', motif: 'Facture d’hébergement d’octobre (test).' });
    await env.req('GET', `${B}/export?beneficiaire=GROUPE_NSEYA`, 'u-superadmin');
    const actions = new Set(env.app.ctx.audit.list({ limit: 1e6 }).items.map((e) => e.action));
    for (const a of ['moteur.regle.verifiee', 'moteur.regle.approuvee', 'moteur.regle.activee', 'moteur.droits.synchronises', 'moteur.reglement.brouillon', 'moteur.reglement.demande', 'moteur.couts.propose', 'moteur.export.financier', 'moteur.compte_reglement.propose', 'repartition.key.activated']) {
      expect(actions.has(a), a).toBe(true);
    }
  });
});
