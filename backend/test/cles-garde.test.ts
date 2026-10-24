/**
 * Garde-fous de la console « Clés et raccordements » (audit de sécurité du 24/10/2026) : adresse d'API limitée au
 * domaine du prestataire (sinon la clé partirait vers un tiers), contrôles de signature jamais désactivés depuis la
 * console, plafond d'IA entier, et démonstration publique verrouillée dès que des clés réelles viennent de
 * l'environnement (n'importe quel visiteur peut s'y présenter comme super-administrateur).
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { DEFAULT_PLUGINS } from '../src/plugins/index.js';
import { gardeConsole } from '../src/modules/integrations/service.js';
import { variable } from '../src/modules/integrations/inventory.js';

async function env() {
  const app = buildApp({ clock: new ManualClock('2026-10-24T09:00:00.000Z'), seed: true, plugins: DEFAULT_PLUGINS, secrets: { auditHmacKey: 'k', providerSecrets: {}, commsProviderKeys: {} } });
  await app.ready();
  return (name: string, value: string) => app.inject({
    method: 'POST', url: `/v1/integrations/keys/${name}/proposals`, headers: { 'x-demo-user': 'u-superadmin', 'content-type': 'application/json' },
    payload: JSON.stringify({ kind: 'DEFINIR', value, motif: 'Essai de garde-fou' }),
  });
}
const v = (n: string) => variable(n)!;
const ctx = (cles: Record<string, string> = {}, demo = false) => ({ demo, production: false, env: (n: string) => cles[n] });

describe('Console des clés — garde-fous', () => {
  it('adresse d’API : domaine du prestataire seulement', async () => {
    const definir = await env();
    expect((await definir('BITRIPAY_BASE_URL', 'https://evil.example/v1')).statusCode).toBe(403);
    expect((await definir('BITRIPAY_BASE_URL', 'https://bitripay.com.evil.example/v1')).statusCode).toBe(403);
    expect((await definir('KODA_BASE_URL', 'https://attaquant.cd/v1')).statusCode).toBe(403);
    expect((await definir('BITRIPAY_BASE_URL', 'https://sandbox.bitripay.com/v1')).statusCode).toBe(201);
    expect((await definir('KODA_BASE_URL', 'https://kodajnn.com/v1')).statusCode).toBe(201);
  });

  it('contrôles de signature jamais désactivés depuis la console ; plafond d’IA entier', async () => {
    const definir = await env();
    for (const n of ['BITRIPAY_HMAC_REQUIRED', 'BITRIPAY_ED25519_REQUIRED', 'BITRIPAY_RESOLUTION_CHECK']) {
      const r = await definir(n, 'false');
      expect(r.statusCode).toBe(403);
      expect(r.json().code).toBe('CONSOLE_GUARD');
      expect((await definir(n, 'true')).statusCode).toBe(201);
    }
    expect((await definir('MOSOLO_IA_PLAFOND_JOUR', '1e9')).statusCode).toBe(403);
    expect((await definir('MOSOLO_IA_PLAFOND_JOUR', '100')).statusCode).toBe(201);
  });

  it('démonstration publique avec une clé réelle dans l’environnement : paiement, adresse publique et IA verrouillés', () => {
    const reel = { BITRIPAY_API_KEY: 'sk_test_0123456789abcdef' };
    expect(gardeConsole(v('BITRIPAY_BASE_URL'), 'DEFINIR', 'https://api.bitripay.com/v1', ctx(reel, true))).toMatch(/démonstration publique/);
    expect(gardeConsole(v('MOSOLO_PUBLIC_URL'), 'DEFINIR', 'https://exemple.cd', ctx(reel, true))).toMatch(/démonstration publique/);
    expect(gardeConsole(v('MOSOLO_IA_PLAFOND_JOUR'), 'RETIRER', undefined, ctx(reel, true))).toMatch(/démonstration publique/);
    // Sans clé réelle dans l'environnement, ou hors démonstration : la console reste utilisable.
    expect(gardeConsole(v('MOSOLO_PUBLIC_URL'), 'DEFINIR', 'https://exemple.cd', ctx({}, true))).toBeNull();
    expect(gardeConsole(v('MOSOLO_PUBLIC_URL'), 'DEFINIR', 'https://exemple.cd', ctx(reel, false))).toBeNull();
  });
});
