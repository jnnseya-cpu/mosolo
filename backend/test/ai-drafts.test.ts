import { AI_FORBIDDEN_ACTIONS } from '@mosolo/shared';
import { describe, expect, it } from 'vitest';
import type { AiActor } from '../src/core/auth.js';
import { assertAiMay, authorize } from '../src/core/policy.js';
import { setup } from './helpers.js';

const FIELDS = ['situation', 'insight', 'risk', 'recommendation', 'nextAction', 'owner', 'deadline', 'confidence'] as const;

describe('Couche d’intelligence', () => {
  it('produit une AIRecommendation complète (8 rubriques + décision + niveau d’autonomie)', async () => {
    const env = await setup();
    const res = await env.req('POST', '/v1/ai/insights', 'u-gouverneur', { context: 'governor' });
    expect(res.statusCode).toBe(201);
    const rec = res.json();
    for (const f of FIELDS) expect(rec[f], f).toBeTruthy();
    expect(rec.sources.length).toBeGreaterThan(0);
    expect(rec.decision).toMatchObject({ bestOption: expect.any(String), alternativeOption: expect.any(String), riskOfInaction: expect.any(String), financialImpact: expect.any(String), operationalImpact: expect.any(String) });
    expect(rec).toMatchObject({ autonomy: 'C_RECOMMANDATION', status: 'EMISE', agent: 'Aide à la décision exécutive', modelVersion: 'regles-deterministes-1.0' });
    expect(rec.owner).not.toMatch(/\bIA\b/);
    for (const ctx of ['treasury', 'rental', 'communications'] as const) {
      const user = ctx === 'treasury' ? 'u-tresor' : ctx === 'rental' ? 'u-dg-dgipk' : 'u-admin-entite';
      const r = await env.req('POST', '/v1/ai/insights', user, { context: ctx });
      expect(r.statusCode, ctx).toBe(201);
      expect(['A_AUTO', 'B_VALIDATION', 'C_RECOMMANDATION']).toContain(r.json().autonomy);
    }
    expect((await env.req('POST', '/v1/ai/insights', 'u-contribuable', { context: 'governor' })).statusCode).toBe(403);
  });

  it('AC-AI-01 : aucun effet tant qu’un humain habilité n’a pas décidé ; la décision est journalisée', async () => {
    const env = await setup();
    const c = env.app.ctx;
    const snapshot = () => ({ obligations: JSON.stringify(c.assessment.obligations.all()), ledger: c.ledger.list().length, orders: c.payments.orders.count(), vault: JSON.stringify(c.vault.view()), rules: JSON.stringify(c.rules.rules.all()) });
    const before = snapshot();
    const rec = (await env.req('POST', '/v1/ai/insights', 'u-gouverneur', { context: 'governor' })).json();
    expect(snapshot()).toEqual(before);
    // Décision par un rôle non habilité refusée.
    expect((await env.req('POST', `/v1/ai/recommendations/${rec.id}/decide`, 'u-tresor', { decision: 'ACCEPTEE', reason: 'Hors périmètre' })).statusCode).toBe(403);
    const decided = await env.req('POST', `/v1/ai/recommendations/${rec.id}/decide`, 'u-gouverneur', { decision: 'ACCEPTEE', reason: 'Priorité stratégique validée' });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({ status: 'ACCEPTEE', decidedBy: 'u-gouverneur', decisionReason: 'Priorité stratégique validée' });
    // Même acceptée, une recommandation de niveau C n'exécute rien.
    expect(snapshot()).toEqual(before);
    const log = c.audit.list({ action: 'ai.recommendation.decided' });
    expect(log.total).toBe(1);
    expect(log.items[0]!.actor.id).toBe('u-gouverneur');
    const twice = await env.req('POST', `/v1/ai/recommendations/${rec.id}/decide`, 'u-gouverneur', { decision: 'REJETEE', reason: 'Changement d’avis' });
    expect(twice.json().code).toBe('ALREADY_DECIDED');
    const list = (await env.req('GET', '/v1/ai/recommendations?status=ACCEPTEE', 'u-gouverneur')).json();
    expect(list.map((r: { id: string }) => r.id)).toContain(rec.id);
  });

  it('garde : un acteur IA ne peut exécuter aucune action interdite ou de niveau C', () => {
    const ai: AiActor = { kind: 'ai', id: 'agent:test', agent: 'test' };
    for (const a of AI_FORBIDDEN_ACTIONS) expect(() => assertAiMay(ai, a)).toThrow(/AI_FORBIDDEN_ACTION|IA|intelligence|d'IA/);
    for (const a of ['payment.create', 'beneficiary.approve', 'assessment.liquidate', 'appeal.decide', 'rule.approve', 'ledger.reverse', 'audit.modify', 'ai.decide'] as const) {
      expect(() => authorize(ai, a)).toThrow();
    }
    expect(() => authorize(ai, 'ai.insight')).not.toThrow();
  });
});

describe('Enregistrement automatique (brouillons)', () => {
  it('AC-SAV-01 : chaque enregistrement crée une version ; historique complet et résumé des changements', async () => {
    const env = await setup();
    const key = 'declaration-bien:OBJ-DEMO-PARCELLE-01';
    const v1 = await env.req('PUT', `/v1/drafts/${key}`, 'u-contribuable', { data: { surface: 120, usage: 'habitation', adresse: { quartier: 'Kingabwa' } } });
    expect(v1.json()).toMatchObject({ version: 1, changeSummary: 'Premier enregistrement : 3 champs saisis' });
    env.clock.advance(5000);
    const v2 = await env.req('PUT', `/v1/drafts/${key}`, 'u-contribuable', { data: { surface: 135, usage: 'commerce', adresse: { quartier: 'Kingabwa' }, photo: 'sha256:abc' } });
    expect(v2.json().version).toBe(2);
    expect(v2.json().changeSummary).toBe('3 champs modifiés : surface (120 → 135), usage (habitation → commerce), photo ajouté');
    const v3 = await env.req('PUT', `/v1/drafts/${key}`, 'u-contribuable', { data: { surface: 135, usage: 'commerce', adresse: { quartier: 'Kingabwa' }, photo: 'sha256:abc' } });
    expect(v3.json().changeSummary).toBe('Aucune modification');
    const latest = (await env.req('GET', `/v1/drafts/${key}`, 'u-contribuable')).json();
    expect(latest).toMatchObject({ version: 3, data: { surface: 135 } });
    const versions = (await env.req('GET', `/v1/drafts/${key}/versions`, 'u-contribuable')).json();
    expect(versions.map((v: { version: number }) => v.version)).toEqual([1, 2, 3]);
    expect(versions[0].data.surface).toBe(120);
    // Un autre utilisateur ne voit pas le brouillon d'autrui.
    expect((await env.req('GET', `/v1/drafts/${key}`, 'u-locataire')).statusCode).toBe(404);
    expect(env.app.ctx.audit.list({ action: 'draft.autosaved' }).total).toBe(3);
  });
});
