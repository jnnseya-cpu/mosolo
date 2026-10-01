/**
 * Fournisseurs d'IA externes (01/10/2026) — Claude, OpenAI, Gemini, FACULTATIFS : sans clé, aucun appel externe et les
 * agents répondent avec leurs règles internes ; avec clé, appel au premier fournisseur, relais au suivant en cas
 * d'échec ; données caviardées ; journal sans contenu ; clés saisies par le super-administrateur seul.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { DEFAULT_PLUGINS } from '../src/plugins/index.js';
import { caviarder, FournisseursIA } from '../src/modules/ia-fournisseurs/service.js';
import type { AgentsRecettesService } from '../src/plugins/agents-recettes/service.js';

async function env() {
  const app = buildApp({ clock: new ManualClock('2026-10-01T09:00:00.000Z'), seed: true, plugins: DEFAULT_PLUGINS, secrets: { auditHmacKey: 'k', providerSecrets: {}, commsProviderKeys: {} } });
  await app.ready();
  const req = (method: string, url: string, user?: string, body?: unknown) => app.inject({
    method: method as 'GET', url, headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { app, req, svc: app.ctx.ext.agentsRecettes as AgentsRecettesService };
}

/** Faux réseau : chaque fournisseur répond selon le scénario ; les corps envoyés sont conservés. */
function fauxReseau(echecs: string[] = []) {
  const envois: { hote: string; corps: string }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const hote = new URL(url).hostname;
    const corps = init?.body ? String(init.body) : input instanceof Request ? await input.text() : '';
    envois.push({ hote, corps });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (echecs.some((e) => hote.includes(e))) return json({ error: { type: 'overloaded_error', message: 'surcharge' } }, 500);
    if (hote === 'api.anthropic.com') return json({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Analyse Claude : priorité aux grands débiteurs.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } });
    if (hote === 'api.openai.com') return json({ choices: [{ message: { content: '{"categorie":"PAIEMENT","resume":"Paiement non pris en compte.","urgence":"MOYENNE"}' } }] });
    return json({ candidates: [{ content: { parts: [{ text: 'Réponse Gemini.' }] } }] });
  }) as typeof fetch;
  return { f, envois };
}

describe('Fournisseurs d’IA externes', () => {
  it('sans clé : aucun appel externe ; analyse et question répondent par les règles internes', async () => {
    const { req, svc } = await env();
    const { f, envois } = fauxReseau();
    svc.ia = new FournisseursIA(() => undefined, (svc as unknown as { ctx: { audit: never } }).ctx.audit, (svc as unknown as { ctx: { clock: never } }).ctx.clock, f);
    expect((await req('GET', '/v1/agents-recettes/ia', 'u-gouverneur')).json().mode).toBe('REGLES_INTERNES');
    await req('POST', '/v1/agents-recettes/PRIORITE_ARRIERES/lancer', 'u-ministre-finances');
    const a = (await req('POST', '/v1/agents-recettes/PRIORITE_ARRIERES/analyse', 'u-ministre-finances')).json();
    expect(a.mode).toBe('REGLES_INTERNES');
    expect(a.texte).toMatch(/Clés et raccordements/);
    expect((await req('POST', '/v1/agents-recettes/question', 'u-ministre-finances', { question: 'Où concentrer les efforts ce mois-ci ?' })).json().mode).toBe('REGLES_INTERNES');
    expect(envois).toHaveLength(0);
  });

  it('avec clés : Claude d’abord ; en cas d’échec, OpenAI prend le relais ; journal sans contenu ; état sans clé', async () => {
    const { app, req, svc } = await env();
    const cles: Record<string, string> = { ANTHROPIC_API_KEY: 'sk-ant-test-0123456789abcdef', OPENAI_API_KEY: 'sk-test-0123456789abcdef', GEMINI_API_KEY: 'AIza-test-0123456789' };
    const r1 = fauxReseau();
    svc.ia = new FournisseursIA((n) => cles[n], app.ctx.audit, app.ctx.clock, r1.f);
    await req('POST', '/v1/agents-recettes/PRIORITE_ARRIERES/lancer', 'u-ministre-finances');
    const a = (await req('POST', '/v1/agents-recettes/PRIORITE_ARRIERES/analyse', 'u-ministre-finances')).json();
    expect(a).toMatchObject({ mode: 'FOURNISSEUR_EXTERNE', fournisseur: 'Claude (Anthropic)', modele: 'claude-opus-5-5' });
    expect(r1.envois[0]!.hote).toBe('api.anthropic.com');
    const etat = JSON.stringify((await req('GET', '/v1/agents-recettes/ia', 'u-gouverneur')).json());
    expect(etat).not.toMatch(/sk-ant|sk-test|AIza/);

    const r2 = fauxReseau(['anthropic']);
    svc.ia = new FournisseursIA((n) => cles[n], app.ctx.audit, app.ctx.clock, r2.f);
    const b = (await req('POST', '/v1/agents-recettes/question', 'u-ministre-finances', { question: 'Quelles communes surveiller ?' })).json();
    expect(b.fournisseur).toBe('OpenAI');
    const journal = app.ctx.audit.list({ action: 'ia.fournisseur.appel' }).items;
    expect(journal.some((e) => (e.details as { resultat: string }).resultat === 'ECHEC')).toBe(true);
    expect(JSON.stringify(journal)).not.toMatch(/Quelles communes surveiller/); // aucun contenu journalisé
    expect((await req('POST', '/v1/agents-recettes/question', 'u-agent-terrain', { question: 'Question non autorisée' })).statusCode).toBe(403);
  });

  it('doléances : suggestion de tri seulement si autorisée ; texte caviardé ; affichée aux personnes qui traitent', async () => {
    const { app, req, svc } = await env();
    const cles: Record<string, string> = { OPENAI_API_KEY: 'sk-test-0123456789abcdef', MOSOLO_IA_ORDRE: 'openai' };
    const r = fauxReseau();
    svc.ia = new FournisseursIA((n) => cles[n], app.ctx.audit, app.ctx.clock, r.f);
    await req('POST', '/v1/doleances', 'u-contribuable', { commune: 'Gombe', categorie: 'AUTRE', texte: 'Payé par M-Pesa au +243 812 345 678, rien reçu, écrivez à jean@exemple.cd' });
    await svc.attendreAnalyses();
    expect(r.envois).toHaveLength(0); // non autorisé par défaut (protection des données)
    cles.MOSOLO_IA_DOLEANCES = 'true';
    const d = (await req('POST', '/v1/doleances', 'u-contribuable', { commune: 'Gombe', categorie: 'AUTRE', texte: 'Payé par M-Pesa au +243 812 345 678, rien reçu, écrivez à jean@exemple.cd' })).json();
    await svc.attendreAnalyses();
    expect(r.envois).toHaveLength(1);
    expect(r.envois[0]!.corps).not.toMatch(/812 345 678|jean@exemple/);
    const liste = (await req('GET', '/v1/agents-recettes/doleances', 'u-auditeur')).json();
    expect(liste.items.find((x: { id: string }) => x.id === d.id).analyseIa).toMatchObject({ categorieSuggeree: 'PAIEMENT', urgence: 'MOYENNE', fournisseur: 'OpenAI' });
  });

  it('caviardage et clés : téléphones, courriels, identifiants masqués ; seul le super-administrateur saisit une clé d’IA, appliquée sans seconde personne ; paiement : deux personnes', async () => {
    expect(caviarder('Appeler +243 99 123 4567 ou a.b@c.cd, IUC KIN-2026-000123')).toBe('Appeler [numéro] ou [courriel], IUC [identifiant]');
    const { req } = await env();
    const corps = { kind: 'DEFINIR', value: 'sk-ant-api03-0123456789abcdefghij', motif: 'Raccordement de Claude pour les agents' };
    expect((await req('POST', '/v1/integrations/keys/ANTHROPIC_API_KEY/proposals', 'u-gouverneur', corps)).statusCode).toBe(403);
    expect((await req('POST', '/v1/integrations/keys/ANTHROPIC_API_KEY/proposals', 'u-ministre-finances', corps)).statusCode).toBe(403);
    const p = await req('POST', '/v1/integrations/keys/ANTHROPIC_API_KEY/proposals', 'u-superadmin', corps);
    expect(p.statusCode, p.body).toBe(201);
    expect(p.body).not.toMatch(/sk-ant-api03/);
    // Décision du 01/10/2026 : clé d'IA appliquée sur la seule décision du super-administrateur.
    expect(p.json().status).toBe('APPROUVEE');
    expect((await req('GET', '/v1/agents-recettes/ia', 'u-gouverneur')).json().fournisseurs.find((f: { id: string }) => f.id === 'claude').cleConfiguree).toBe(true);
    // Les clés de paiement gardent la règle des deux personnes.
    const pay = await req('POST', '/v1/integrations/keys/KODA_WEBHOOK_SECRET/proposals', 'u-superadmin', { kind: 'DEFINIR', value: 'secret-koda-0123456789abcdef', motif: 'Raccordement KODA (test)' });
    expect(pay.json().status).toBe('EN_ATTENTE');
  });
});
