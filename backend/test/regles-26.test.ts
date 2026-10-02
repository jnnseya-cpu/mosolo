/**
 * Module 26 — Moteur de règles juridiques et tarifaires (Spécification fonctionnelle) : veille (règles expirantes,
 * conflits de normes), archivage à quatre yeux avec code réservé, refus d'une obligation doublonnant une autre
 * administration, séparation création / validation / publication, indicateurs (règles actives validées, règles
 * expirant, délai d'approbation).
 */
import { describe, expect, it } from 'vitest';
import { publishCertifiedRule, setup } from './helpers.js';

describe('Module 26 — veille et indicateurs du registre des règles', () => {
  it('règles expirantes dans l’horizon, délai d’approbation mesuré, demandes en attente de visa ; accès agents seulement', async () => {
    const env = await setup();
    const a = await publishCertifiedRule(env, { code: 'TEST-VEILLE-EXP', effectiveTo: '2026-10-15', taxableEvent: 'Fait générateur de veille (test)' });
    expect(a.responses[3]!.statusCode).toBe(200);
    env.app.ctx.rules.refresh();
    env.clock.advance(2 * 86_400_000);
    await publishCertifiedRule(env, { code: 'TEST-VEILLE-BROUILLON', taxableEvent: 'Brouillon de veille (test)' }, 1);
    const v = await env.req('GET', '/v1/legal-rules/veille?jours=30', 'u-juriste-verificateur');
    expect(v.statusCode).toBe(200);
    const body = v.json();
    expect(body.horizonDays).toBe(30);
    expect(body.horizonNote).toMatch(/à confirmer/);
    expect(body.expiring.find((e: { code: string }) => e.code === 'TEST-VEILLE-EXP')).toMatchObject({ effectiveTo: '2026-10-15', successor: false });
    expect(body.indicators.activeValidated).toBeGreaterThanOrEqual(1);
    expect(body.indicators.approvalDelayDays.measured).toBe(true);
    expect(body.indicators.pendingApprovals.find((p: { code: string }) => p.code === 'TEST-VEILLE-BROUILLON')).toMatchObject({ nextVisa: 'VERIFICATEUR_JURIDIQUE' });
    // Hors horizon : non listée.
    expect((await env.req('GET', '/v1/legal-rules/veille?jours=5', 'u-juriste-verificateur')).json().expiring.find((e: { code: string }) => e.code === 'TEST-VEILLE-EXP')).toBeUndefined();
    expect((await env.req('GET', '/v1/legal-rules/veille?jours=0', 'u-juriste-verificateur')).json().code).toBe('INVALID_HORIZON');
    expect((await env.req('GET', '/v1/legal-rules/veille', 'u-contribuable')).statusCode).toBe(403);
  });

  it('conflit de normes : une règle en vigueur qui cite un texte abrogé est signalée', async () => {
    const env = await setup();
    const a = await publishCertifiedRule(env, { code: 'TEST-VEILLE-ABRO', taxableEvent: 'Fait générateur cité (test)' });
    expect(a.responses[3]!.statusCode).toBe(200);
    const ab = await env.req('POST', '/v1/legal-instruments/demo-instrument-001/abrogate', 'u-autorite-publication', { date: '2026-09-20', abrogatedBy: 'ol-18-004', reason: 'Abrogation de test (démonstration)' });
    expect(ab.statusCode).toBe(200);
    const conflicts = (await env.req('GET', '/v1/legal-rules/veille', 'u-juriste-redacteur')).json().conflicts;
    expect(conflicts.some((c: { kind: string; detail: string }) => c.kind === 'TEXTE_ABROGE' && c.detail.includes('TEST-VEILLE-ABRO'))).toBe(true);
  });
});

describe('Module 26 — refus d’une obligation doublonnant une autre administration', () => {
  it('une règle d’une autre entité sur le même fait générateur ne peut pas être publiée ; la veille signale l’arbitrage', async () => {
    const env = await setup();
    const first = await publishCertifiedRule(env, { code: 'TEST-DOUBLON-A', administeringEntity: 'DGIPK', taxableEvent: 'Exploitation d’un panneau lumineux (test doublon)' });
    expect(first.responses[3]!.statusCode).toBe(200);
    const twin = await publishCertifiedRule(env, { code: 'TEST-DOUBLON-B', administeringEntity: 'DGTK', beneficiaryAccountAlias: 'KIN-DGTK-RECETTES-01', taxableEvent: 'Exploitation d’un PANNEAU lumineux — test doublon' });
    expect(twin.responses[3]!.statusCode).toBe(422);
    expect(twin.responses[3]!.json().code).toBe('DOUBLON_ADMINISTRATION');
    expect(env.app.ctx.audit.list({ limit: 1e6 }).items.some((x) => x.action === 'rule.publication.blocked' && (x.details as { code?: string }).code === 'DOUBLON_ADMINISTRATION')).toBe(true);
    // Même administration : une nouvelle version (même code) reste publiable.
    const same = await publishCertifiedRule(env, { code: 'TEST-DOUBLON-C', administeringEntity: 'DGIPK', taxableEvent: 'Exploitation d’un panneau lumineux (test doublon)' });
    expect(same.responses[3]!.statusCode).toBe(200);
  });
});

describe('Module 26 — cycle de vie : archivage à quatre yeux, code stable, séparation des pouvoirs', () => {
  it('seule une version sans effet s’archive ; demande par un juriste, confirmation par une autre personne ; le code reste réservé', async () => {
    const env = await setup();
    const draft = await publishCertifiedRule(env, { code: 'TEST-ARCHIVE', taxableEvent: 'Archivage (test)' }, 0);
    const id = draft.id;
    expect((await env.req('POST', `/v1/legal-rules/${id}/archive-requests`, 'u-validateur-financier', { motif: 'Projet abandonné' })).json().code).toBe('ARCHIVE_REQUESTER');
    const req = await env.req('POST', `/v1/legal-rules/${id}/archive-requests`, 'u-juriste-redacteur', { motif: 'Projet abandonné (test)' });
    expect(req.statusCode).toBe(201);
    expect((await env.req('POST', `/v1/legal-rules/${id}/archive-requests`, 'u-juriste-redacteur', { motif: 'Doublon de demande' })).json().code).toBe('ARCHIVE_PENDING');
    expect((await env.req('POST', `/v1/legal-rules/archives/${req.json().id}/decide`, 'u-juriste-redacteur', { approve: true, motif: 'Auto-confirmation' })).statusCode).toBe(403);
    const ok = await env.req('POST', `/v1/legal-rules/archives/${req.json().id}/decide`, 'u-juriste-verificateur', { approve: true, motif: 'Archivage confirmé (test)' });
    expect(ok.json().status).toBe('CONFIRMEE');
    expect(env.app.ctx.rules.get(id).status).toBe('ARCHIVEE');
    // Code stable et non réutilisable : une nouvelle fiche du même code est une NOUVELLE version, jamais la v1.
    const next = await publishCertifiedRule(env, { code: 'TEST-ARCHIVE', taxableEvent: 'Archivage (test)' }, 0);
    expect(env.app.ctx.rules.get(next.id).version).toBeGreaterThan(1);
    // Une version ACTIVE ne s'archive pas (elle produit des obligations).
    const live = await publishCertifiedRule(env, { code: 'TEST-ARCHIVE-ACTIVE', taxableEvent: 'Version active (test)' });
    env.app.ctx.rules.refresh();
    expect((await env.req('POST', `/v1/legal-rules/${live.id}/archive-requests`, 'u-juriste-redacteur', { motif: 'Tentative sur version active' })).json().code).toBe('RULE_NOT_ARCHIVABLE');
    const veille = (await env.req('GET', '/v1/legal-rules/veille', 'u-juriste-redacteur')).json();
    expect(veille.indicators.archived).toBe(1);
    expect(veille.archives[0]).toMatchObject({ ruleCode: 'TEST-ARCHIVE', status: 'CONFIRMEE' });
  });

  it('la même personne ne peut ni créer, ni valider, ni publier la même règle', async () => {
    const env = await setup();
    const r = await publishCertifiedRule(env, { code: 'TEST-SEPARATION', taxableEvent: 'Séparation (test)' }, 1);
    const self = await env.req('POST', `/v1/legal-rules/${r.id}/approve`, 'u-juriste-redacteur', { role: 'VERIFICATEUR_JURIDIQUE' });
    expect([403, 409]).toContain(self.statusCode);
    expect(env.app.ctx.rules.get(r.id).status).toBe('REVUE_JURIDIQUE');
  });
});
