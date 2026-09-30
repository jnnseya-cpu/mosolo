/**
 * « À faire » de l'usager (30/09/2026) : tout ce qui le concerne en un seul endroit, avec une action par ligne, sans
 * aucun lien vers un écran de travail des agents ; mêmes droits que le compte unique.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { lienUsager } from '../src/modules/identity/a-faire.js';
import { DEMO } from '../src/seed.js';
import { PROVIDER_SECRET, type TestEnv } from './helpers.js';

async function fullApp() {
  const clock = new ManualClock('2026-09-30T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': PROVIDER_SECRET }, commsProviderKeys: {} } });
  await app.ready();
  const env: TestEnv = {
    app, clock,
    req: (method, url, user, body, headers = {}) => app.inject({
      method: method as 'GET', url,
      headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    }),
  };
  return env;
}
/** Écrans de travail des agents : jamais proposés à un usager. */
const ECRANS_AGENTS = /^\/(recouvrement|acces\/identite|chaine|verticales|communication|verifier|preuve|documents$|canaux|terrain|citoyen\/pieces|autour-de-moi)/;

describe('« À faire » de l’usager', () => {
  it('trois groupes, action sur chaque ligne à faire, urgences en tête, aucun lien vers un écran d’agent', async () => {
    const env = await fullApp();
    const r = await env.req('GET', '/v1/moi/a-faire', 'u-contribuable');
    expect(r.statusCode).toBe(200);
    const d = r.json();
    expect(d.aFaire.length).toBeGreaterThan(0);
    expect(d.aFaire.every((l: { action: unknown }) => !!l.action)).toBe(true);
    // Paiement direct : chaque obligation à payer porte son identifiant (ouvre le paiement dans l'espace).
    expect(d.aFaire.some((l: { action: { libelle: string; obligationId?: string } }) => l.action.libelle === 'Payer' && !!l.action.obligationId)).toBe(true);
    // Tri : « en retard » avant « bientôt » avant le reste.
    const rang = { EN_RETARD: 0, BIENTOT: 1, NORMALE: 2 } as Record<string, number>;
    const rangs = d.aFaire.map((l: { urgence: string }) => rang[l.urgence]);
    expect([...rangs].sort((a: number, b: number) => a - b)).toEqual(rangs);
    for (const l of [...d.aFaire, ...d.enVerification, ...d.aJour]) {
      if (l.action) expect(l.action.lien, `${l.libelle} → ${l.action.lien}`).not.toMatch(ECRANS_AGENTS);
    }
    // Ce que l'administration vérifie : rien à faire pour l'usager (quittance provisoire, bien enregistré à vérifier).
    expect(d.enVerification.length).toBeGreaterThan(0);
    // Le compte unique renvoie aussi l'usager vers SES écrans (plus de lien vers le recouvrement ou la chaîne des agents).
    const cu = (await env.req('GET', '/v1/compte-unique/me', 'u-contribuable')).json();
    for (const s of cu.sections) {
      expect(s.lien, s.module).not.toMatch(ECRANS_AGENTS);
      for (const e of s.elements) if (e.lien) expect(e.lien, `${s.module} ${e.id}`).not.toMatch(ECRANS_AGENTS);
    }
  });

  it('mêmes droits que le compte unique : titulaire, mandataire dans son mandat ; agent et tiers refusés', async () => {
    const env = await fullApp();
    expect((await env.req('GET', '/v1/moi/a-faire', 'u-controleur')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/moi/a-faire', 'u-mandataire')).json().code).toBe('TAXPAYER_REQUIRED');
    expect((await env.req('GET', `/v1/moi/a-faire?taxpayerId=${DEMO.taxpayerId}`, 'u-mandataire')).statusCode).toBe(200);
    expect((await env.req('GET', `/v1/moi/a-faire?taxpayerId=${DEMO.taxpayerId}`, 'u-locataire')).statusCode).toBe(403);
    expect((await env.req('GET', '/v1/moi/a-faire')).statusCode).toBe(401);
  });

  it('liens de l’usager : écrans des agents remplacés par ceux de l’usager', () => {
    expect(lienUsager('/recouvrement')).toBe('/mes-arrieres');
    expect(lienUsager('/acces/identite')).toBe('/mon-espace/profils');
    expect(lienUsager('/chaine/OBJ-1')).toBe('/fiscal/biens');
    expect(lienUsager('/verifier/Q1')).toBe('/espace#sec-rc');
    expect(lienUsager('/verticales/secteurs')).toBe('/services');
    expect(lienUsager('/stationnement')).toBe('/stationnement');
  });
});
