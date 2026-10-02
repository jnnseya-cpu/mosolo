/**
 * Saisie des clés dans « Clés et raccordements » (02/10/2026) : copier-coller réel — espaces de fin retirés, clé
 * publique Ed25519 admise sous toutes ses formes usuelles, et un prestataire incomplet ne bloque pas l'autre.
 */
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { DEFAULT_PLUGINS } from '../src/plugins/index.js';
import { parseEd25519PublicKey } from '../src/modules/payments/connectors/bitripay.js';

async function env() {
  const app = buildApp({ clock: new ManualClock('2026-10-02T09:00:00.000Z'), seed: true, plugins: DEFAULT_PLUGINS, secrets: { auditHmacKey: 'k', providerSecrets: {}, commsProviderKeys: {} } });
  await app.ready();
  const definir = (name: string, value: string) => app.inject({
    method: 'POST', url: `/v1/integrations/keys/${name}/proposals`, headers: { 'x-demo-user': 'u-superadmin', 'content-type': 'application/json' },
    payload: JSON.stringify({ kind: 'DEFINIR', value, motif: 'Raccordement (test)' }),
  });
  return { app, definir };
}

describe('Clés et raccordements — copier-coller', () => {
  const pem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const der = Buffer.from(pem.replace(/-----[A-Z ]+-----|\s/g, ''), 'base64');

  it('clé Ed25519 : PEM sur plusieurs lignes, PEM aplati, DER base64, 32 octets base64 et hexadécimal', () => {
    for (const v of [pem, pem.replace(/\n/g, ''), pem.replace(/\n/g, ' '), der.toString('base64'), der.subarray(12).toString('base64'), der.subarray(12).toString('base64url'), der.subarray(12).toString('hex')]) {
      expect(() => parseEd25519PublicKey(v)).not.toThrow();
    }
    expect(() => parseEd25519PublicKey('pas-une-cle')).toThrow();
  });

  it('espaces et retour à la ligne de fin retirés ; espace intérieur toujours refusé', async () => {
    const { definir } = await env();
    expect((await definir('ANTHROPIC_API_KEY', 'sk-ant-api03-abcdefABCDEF0123456789\n')).statusCode).toBe(201);
    expect((await definir('OPENAI_API_KEY', '  sk-proj-abcdefABCDEF0123456789 ')).statusCode).toBe(201);
    expect((await definir('OPENAI_API_KEY', 'sk-proj-abcdef ABCDEF0123456789')).statusCode).toBe(422);
    expect((await definir('BITRIPAY_ED25519_PUBLIC_KEY', pem)).statusCode).toBe(201);
    expect((await definir('BITRIPAY_ED25519_PUBLIC_KEY', pem.replace(/\n/g, ''))).statusCode).toBe(201);
  });

  it('BitriPay incomplet (sans clé Ed25519) ne bloque pas KODA ; message sans valeur', async () => {
    const { app, definir } = await env();
    await definir('MOSOLO_PUBLIC_URL', 'https://mosolo.example.cd');
    await definir('BITRIPAY_API_KEY', 'sk_test_abcdefABCDEF0123456789');
    await definir('BITRIPAY_WEBHOOK_SECRET', 'whsec_abcdefABCDEF0123456789');
    await definir('KODA_WEBHOOK_SECRET', 'secret-koda-0123456789abcdef');
    const r = await definir('KODA_API_KEY', 'sk_test_abcdefABCDEF0123456789');
    expect(r.statusCode).toBe(201);
    expect(r.json().configurationWarning).toMatch(/Ed25519/);
    expect(r.json().configurationWarning).not.toMatch(/abcdef/);
    expect(app.ctx.connectors.get('koda')?.mode).not.toBe('SANDBOX_LOCAL');
    // La clé Ed25519 complète BitriPay : plus aucun avertissement.
    const ok = await definir('BITRIPAY_ED25519_PUBLIC_KEY', pem);
    expect(ok.json().configurationWarning).toBeNull();
    expect(app.ctx.connectors.get('bitripay')?.mode).not.toBe('SANDBOX_LOCAL');
  });
});
