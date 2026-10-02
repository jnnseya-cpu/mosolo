/**
 * Agents IA de recettes (01/10/2026) : l'IA propose, une personne décide ; aucune donnée personnelle ; aucune charge
 * nouvelle ; grands d'abord ; aider avant de punir ; sources externes validées par deux personnes ; doléances sans
 * représailles ; page publique « Où va votre argent » avec seuil de 5 contribuables ; contrôle d'équité.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { DEFAULT_PLUGINS } from '../src/plugins/index.js';
import { AGENTS_RECETTES } from '../src/plugins/agents-recettes/model.js';

async function env() {
  const app = buildApp({ clock: new ManualClock('2026-10-01T09:00:00.000Z'), seed: true, plugins: DEFAULT_PLUGINS, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
  await app.ready();
  const req = (method: string, url: string, user?: string, body?: unknown) => app.inject({
    method: method as 'GET', url, headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { app, req };
}

describe('Agents IA de recettes', () => {
  it('catalogue : 19 agents en 7 familles, doctrine, paramètres « à confirmer » ; chaque agent calculable se lance sans erreur', async () => {
    const { req } = await env();
    const cat = (await req('GET', '/v1/agents-recettes', 'u-gouverneur')).json();
    expect(cat.agents).toHaveLength(AGENTS_RECETTES.length);
    expect(cat.familles).toHaveLength(7);
    expect(cat.parametres.statut).toMatch(/à confirmer/);
    expect(cat.doctrine.join(' ')).toMatch(/Aucune nouvelle charge sans acte signé/);
    for (const a of AGENTS_RECETTES) {
      const r = await req('POST', `/v1/agents-recettes/${a.code}/lancer`, 'u-ministre-finances');
      if (a.mode === 'EXISTANT' || a.mode === 'SIMULATION') expect(r.statusCode, a.code).toBe(400);
      else expect(r.statusCode, `${a.code}: ${r.body}`).toBe(201);
    }
    expect((await req('GET', '/v1/agents-recettes', 'u-contribuable')).statusCode).toBe(403);
    expect((await req('POST', '/v1/agents-recettes/RAPPELS/lancer', 'u-agent-terrain')).statusCode).toBe(403);
  });

  it('rappels : proposés, puis envoyés seulement sur décision motivée d’une personne ; décision unique et journalisée', async () => {
    const { app, req } = await env();
    const lot = (await req('POST', '/v1/agents-recettes/RAPPELS/lancer', 'u-ministre-finances')).json();
    expect(lot.items.length).toBeGreaterThan(0);
    const p = lot.items[0];
    expect(p.statut).toBe('PROPOSEE');
    expect(JSON.stringify(p)).not.toMatch(/Mbuyi|Kalala|\+243/); // aucune donnée personnelle dans la proposition
    const avant = app.ctx.comms.deliveries.count();
    expect((await req('POST', `/v1/agents-recettes/propositions/${p.id}/decision`, 'u-dg-dgipk', { accepter: true, motif: 'court' })).statusCode).toBe(400);
    const ok = (await req('POST', `/v1/agents-recettes/propositions/${p.id}/decision`, 'u-dg-dgipk', { accepter: true, motif: 'Rappel justifié : échéance dépassée' })).json();
    expect(ok.statut).toBe('ACCEPTEE');
    expect(app.ctx.comms.deliveries.count()).toBeGreaterThan(avant);
    expect((await req('POST', `/v1/agents-recettes/propositions/${p.id}/decision`, 'u-dg-dgipk', { accepter: false, motif: 'Deuxième décision refusée' })).statusCode).toBe(409);
    expect(app.ctx.audit.list({ action: 'agents_recettes.proposition.acceptee' }).items).toHaveLength(1);
  });

  it('découverte croisée : lot importé sans nom, validé par une seconde personne ; ne propose que ce qui manque au registre ; tournée de l’agent sans montant', async () => {
    const { app, req } = await env();
    const o = app.ctx.objects.objects.all().find((x) => x.category === 'BATIMENT')!;
    const lot = { kind: 'SNEL', reference: 'SNEL-EXTRAIT-2026-09 (test)', lignes: [
      { ref: 'C-1', lat: o.lat, lon: o.lon, commune: o.commune }, // déjà au registre
      { ref: 'C-2', lat: -4.3999, lon: 15.2999, commune: 'Limete' }, // absent
    ] };
    expect((await req('POST', '/v1/agents-recettes/sources', 'u-dg-dgipk', { ...lot, lignes: [{ ref: 'X', nom: 'Jean' }] })).statusCode).toBe(400); // pas de nom
    const dep = (await req('POST', '/v1/agents-recettes/sources', 'u-dg-dgipk', lot)).json();
    expect((await req('POST', `/v1/agents-recettes/sources/${dep.id}/validation`, 'u-dg-dgipk', { approuver: true, motif: 'Auto-validation interdite' })).statusCode).toBe(403);
    expect((await req('POST', `/v1/agents-recettes/sources/${dep.id}/validation`, 'u-auditeur', { approuver: true, motif: 'Lot conforme à l’extrait reçu' })).json().statut).toBe('VALIDE');
    const run = (await req('POST', '/v1/agents-recettes/DECOUVERTE_CROISEE/lancer', 'u-ministre-finances')).json();
    const cibles = run.items.map((p: { cible: { id: string } }) => p.cible.id);
    expect(cibles).toContain(`${dep.id}:C-2`);
    expect(cibles).not.toContain(`${dep.id}:C-1`); // déjà au registre : jamais proposé
    const c2 = run.items.find((p: { cible: { id: string } }) => p.cible.id === `${dep.id}:C-2`);
    await req('POST', `/v1/agents-recettes/propositions/${c2.id}/decision`, 'u-dg-dgipk', { accepter: true, motif: 'À vérifier sur le terrain cette semaine' });
    const t = (await req('GET', '/v1/agents-recettes/tournee', 'u-agent-terrain')).json();
    expect(t.arrets.some((a: { motif: string }) => /découvert/.test(a.motif))).toBe(true);
    expect(JSON.stringify(t)).not.toMatch(/"amount"/); // aucun montant pour l'agent de terrain
    expect(t.rappel.join(' ')).toMatch(/Jamais d’espèces/);
    expect((await req('GET', '/v1/agents-recettes/tournee', 'u-gouverneur')).statusCode).toBe(403);
  });

  it('arriérés : les grands d’abord ; légalité, rapprochement et prévision calculés ; simulations sans effet', async () => {
    const { req } = await env();
    const arr = (await req('POST', '/v1/agents-recettes/PRIORITE_ARRIERES/lancer', 'u-ministre-finances')).json().items;
    for (let i = 1; i < arr.length; i++) expect(arr[i].rang).toBe(arr[i - 1].rang + 1);
    const reg = (await req('POST', '/v1/agents-recettes/simulations/regularisation', 'u-ministre-finances', { fenetreJours: 60, remisePenalitesPct: 100, devise: 'CDF' })).json();
    expect(reg.note).toMatch(/Toute remise exige un acte/);
    const rule = (await req('GET', '/v1/legal-rules', 'u-gouverneur')).json().find((r: { status: string }) => r.status === 'ACTIVE');
    const imp = await req('POST', '/v1/agents-recettes/simulations/impact-tarif', 'u-ministre-finances', { ruleCode: rule.code, variationPct: 10 });
    if (imp.statusCode === 200) expect(imp.json().note).toMatch(/quatre visas/);
    else expect(imp.statusCode).toBe(404);
  });

  it('doléances : déposées par l’usager, orientées, jamais traitées par l’agent mis en cause, auteur jamais révélé ; baromètre agrégé', async () => {
    const { req } = await env();
    const d = (await req('POST', '/v1/doleances', 'u-contribuable', { commune: 'Limete', categorie: 'AGENT', texte: 'Agent impoli lors du contrôle de mon commerce', agentId: 'u-agent-terrain' })).json();
    expect(d.service).toMatch(/Intégrité/);
    expect((await req('GET', '/v1/doleances/miennes', 'u-contribuable')).json().items.some((x: { id: string }) => x.id === d.id)).toBe(true);
    expect((await req('POST', '/v1/doleances', 'u-agent-terrain', { commune: 'Limete', categorie: 'AUTRE', texte: 'Un agent ne dépose pas de doléance ici' })).statusCode).toBe(403);
    const liste = (await req('GET', '/v1/agents-recettes/doleances', 'u-auditeur')).json();
    expect(JSON.stringify(liste)).not.toMatch(/u-contribuable/);
    expect((await req('POST', `/v1/agents-recettes/doleances/${d.id}/reponse`, 'u-auditeur', { texte: 'Entretien mené avec l’agent ; excuses présentées.' })).json().statut).toBe('REPONDUE');
    const h = (await req('GET', '/v1/agents-recettes/humeur', 'u-gouverneur')).json();
    expect(h.communes.find((c: { commune: string }) => c.commune === 'Limete').doleances).toBe(3); // 2 fictives de démonstration + 1
    expect(h.note).toMatch(/aucun individu suivi/);
  });

  it('où va votre argent : public, par commune, seuil de 5 contribuables ; équité mesurée', async () => {
    const { req } = await env();
    const r = await req('GET', '/v1/public/ou-va-votre-argent');
    expect(r.statusCode).toBe(200);
    for (const c of r.json().communes) if (!c.publiable) expect(c.recettes).toEqual([]);
    const e = (await req('GET', '/v1/agents-recettes/equite', 'u-gouverneur')).json();
    expect(e.lignes).toHaveLength(24);
    expect(e.statut).toMatch(/à confirmer/);
  });

  it('démonstration : lots [EXEMPLE] validés par deux personnes → découvertes, plaques et écart d’un grand opérateur ; jamais en production', async () => {
    const { req } = await env();
    const run = async (code: string) => (await req('POST', `/v1/agents-recettes/${code}/lancer`, 'u-ministre-finances')).json().items as { titre: string }[];
    const dec = await run('DECOUVERTE_CROISEE');
    expect(dec.some((p) => /Véhicule non enregistré/.test(p.titre))).toBe(true);
    expect(dec.some((p) => /absent du registre/.test(p.titre))).toBe(true);
    expect((await run('GRANDS_CONTRATS')).some((p) => /non déclaré/.test(p.titre))).toBe(true);
    const prod = buildApp({ clock: new ManualClock('2026-10-01T09:00:00.000Z'), seed: false, plugins: DEFAULT_PLUGINS, secrets: { auditHmacKey: 'k', providerSecrets: {}, commsProviderKeys: {} } });
    await prod.ready();
    expect((prod.ctx.ext.agentsRecettes as { sources: { count(): number } }).sources.count()).toBe(0);
  });
});
