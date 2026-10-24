/**
 * Traduction automatique : budget quotidien de caractères facturables (audit du 24/10/2026). La route est publique ;
 * au-delà du budget, les textes restent en français sans erreur et le fournisseur n'est plus appelé. Les textes déjà en
 * cache ne consomment rien.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TraductionService } from '../src/modules/traduction/service.js';

afterEach(() => { delete process.env.MOSOLO_TRADUCTION_PLAFOND_JOUR; });

describe('Traduction — budget quotidien', () => {
  it('au-delà du plafond : textes rendus en français, aucun appel ; le cache reste gratuit', async () => {
    process.env.MOSOLO_TRADUCTION_PLAFOND_JOUR = '10';
    const envoyes: string[] = [];
    const svc = new TraductionService(async (lot) => { envoyes.push(...lot); return lot.map((t) => `[en] ${t}`); });
    expect(await svc.traduire(['Payer', 'Quitus'], 'en')).toEqual(['[en] Payer', 'Quitus']); // 11 > 10 : « Quitus » reste
    expect(envoyes).toEqual(['Payer']);
    expect(await svc.traduire(['Payer', 'Bonjour à tous'], 'en')).toEqual(['[en] Payer', 'Bonjour à tous']);
    expect(envoyes).toEqual(['Payer']);
  });
  it('plafond par défaut : 2 000 000 caractères (à confirmer)', () => {
    expect(new TraductionService(null).plafondJour()).toBe(2_000_000);
  });
});
