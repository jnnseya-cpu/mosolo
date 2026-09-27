import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { hmacSha256Hex } from '../src/core/crypto.js';
import { defaultSecrets, providerKeyRingsFromEnv, providerSecretsFromEnv } from '../src/context.js';
import { NonceStore, parseProviderKeyRing, signCallback } from '../src/modules/payments/callback-signing.js';
import { loadReceiptVerificationKeys, receiptKeyId, ReceiptService } from '../src/modules/receipts/service.js';
import { callbackBody, callbackHeaders, createOrder, payDemoObligation, PROVIDER_SECRET, setup, signedCallback } from './helpers.js';

const OLD = 'ancien-secret-mm-operator-a-2025';
const NEW = 'nouveau-secret-mm-operator-a-2026';

async function post(env: Awaited<ReturnType<typeof setup>>, raw: string, headers: Record<string, string>) {
  return env.app.inject({ method: 'POST', url: '/v1/providers/mm-operator-a/callbacks', payload: raw, headers: { 'content-type': 'application/json', ...headers } });
}

describe('Rappels génériques — signature v2 (horodatage et nonce signés)', () => {
  it('nonce ou horodatage réécrits ⇒ signature invalide ; signature du seul corps (ancien schéma) refusée', async () => {
    const env = await setup();
    const order = (await createOrder(env)).json();
    const raw = JSON.stringify(callbackBody(env, order.paymentReference));
    const h = callbackHeaders(PROVIDER_SECRET, raw, env.clock.now());
    const otherNonce = await post(env, raw, { ...h, 'x-nonce': randomUUID() });
    expect(otherNonce.json().code).toBe('INVALID_SIGNATURE');
    const otherTs = await post(env, raw, { ...h, 'x-timestamp': new Date(env.clock.now().getTime() - 1000).toISOString() });
    expect(otherTs.json().code).toBe('INVALID_SIGNATURE');
    const legacy = await post(env, raw, { ...h, 'x-signature': hmacSha256Hex(PROVIDER_SECRET, raw) });
    expect(legacy.json().code).toBe('INVALID_SIGNATURE');
    const badNonce = await post(env, raw, { ...h, 'x-nonce': 'a b' });
    expect(badNonce.json().code).toBe('INVALID_NONCE');
    // Les rejets n'ont pas consommé le nonce : le rappel authentique passe (préfixes v2= / sha256= / nu admis).
    const ok = await post(env, raw, { ...h, 'x-signature': h['x-signature']!.replace(/^v2=/, 'sha256=') });
    expect(ok.json().status).toBe('CONFIRME');
    expect(env.app.ctx.receipts.receipts.count()).toBe(1);
  });

  it('horodatage signé mais périmé (> 5 min) ou futur ⇒ refusé, même signature valide', async () => {
    const env = await setup();
    const order = (await createOrder(env)).json();
    for (const skew of [-6 * 60_000, 6 * 60_000]) {
      const res = await signedCallback(env, callbackBody(env, order.paymentReference), { timestamp: new Date(env.clock.now().getTime() + skew).toISOString() });
      expect(res.json().code).toBe('TIMESTAMP_OUT_OF_WINDOW');
    }
    const inWindow = await signedCallback(env, callbackBody(env, order.paymentReference), { timestamp: new Date(env.clock.now().getTime() - 4 * 60_000).toISOString() });
    expect(inWindow.json().status).toBe('CONFIRME');
  });

  it('rotation : clé courante et ancienne acceptées (trace d’audit pour l’ancienne) ; kid désigné respecté ; kid inconnu refusé', async () => {
    const env = await setup({ providerSecrets: { 'mm-operator-a': NEW }, providerKeyRings: { 'mm-operator-a': [{ kid: 'k2026', secret: NEW }, { kid: 'k2025', secret: OLD }] } });
    const ctx = env.app.ctx;
    const order = (await createOrder(env)).json();
    const raw = JSON.stringify(callbackBody(env, order.paymentReference));
    // kid désigné qui ne correspond pas à la clé employée ⇒ refus ; kid inconnu ⇒ refus.
    expect((await post(env, raw, callbackHeaders(OLD, raw, env.clock.now(), { kid: 'k2026' }))).json().code).toBe('INVALID_SIGNATURE');
    expect((await post(env, raw, callbackHeaders(OLD, raw, env.clock.now(), { kid: 'k1999' }))).json().code).toBe('INVALID_SIGNATURE');
    // Ancienne clé (désignée ou non) acceptée pendant la rotation, avec trace d'audit.
    const old = await post(env, raw, callbackHeaders(OLD, raw, env.clock.now(), { kid: 'k2025' }));
    expect(old.json().status).toBe('CONFIRME');
    expect(ctx.audit.list({ action: 'payment.callback.previous_key_used' }).items[0]?.details).toMatchObject({ keyId: 'k2025', currentKeyId: 'k2026' });
    // Nouvelle clé, sans kid : signature acceptée (même transaction ⇒ rejeu idempotent, aucun double effet).
    const cur = await post(env, raw, callbackHeaders(NEW, raw, env.clock.now()));
    expect(cur.json()).toMatchObject({ status: 'CONFIRME', replayed: true });
    expect(ctx.audit.list({ action: 'payment.callback.previous_key_used' }).total).toBe(1);
    // Secret retiré du trousseau (révocation de l'habilitation) ⇒ plus aucun rappel accepté, même avec l'ancienne clé.
    delete ctx.secrets.providerSecrets['mm-operator-a'];
    const revoked = await post(env, raw, callbackHeaders(OLD, raw, env.clock.now()));
    expect(revoked.statusCode).toBe(404);
  });

  it('trousseau depuis l’environnement : secret seul (kid « default ») ou « kid:secret,… » ; valeurs de démonstration refusées', () => {
    expect(parseProviderKeyRing('0123456789abcdef0123')).toEqual([{ kid: 'default', secret: '0123456789abcdef0123' }]);
    expect(parseProviderKeyRing(`k2:${NEW}, k1:${OLD}`)).toEqual([{ kid: 'k2', secret: NEW }, { kid: 'k1', secret: OLD }]);
    expect(() => parseProviderKeyRing(`k1:${NEW},k1:${OLD}`)).toThrow(/double/);
    expect(() => parseProviderKeyRing(`k1:${NEW},sans-kid`)).toThrow(/illisible/);
    const env = {
      MOSOLO_PROVIDER_SECRET_MM_OPERATOR_A: `k2:${NEW},k1:${OLD}`,
      MOSOLO_PROVIDER_SECRET_BANK_A: 'secret-reel-banque-a-0001',
      MOSOLO_PROVIDER_SECRET_CARD_GATEWAY: 'secret-reel-passerelle-0001',
    } as NodeJS.ProcessEnv;
    expect(providerKeyRingsFromEnv(env, false)['mm-operator-a']).toEqual([{ kid: 'k2', secret: NEW }, { kid: 'k1', secret: OLD }]);
    expect(providerSecretsFromEnv(env, false)['mm-operator-a']).toBe(NEW);
    expect(() => providerKeyRingsFromEnv({ ...env, MOSOLO_PROVIDER_SECRET_MM_OPERATOR_A: `k2:${NEW},k1:demo-secret-mm-operator-a` }, false)).toThrow(/MM_OPERATOR_A invalide/);
    expect(() => providerKeyRingsFromEnv({ ...env, MOSOLO_PROVIDER_SECRET_MM_OPERATOR_A: `k2:${NEW},k1:court` }, false)).toThrow(/MM_OPERATOR_A invalide/);
    const secrets = defaultSecrets({ ...env, MOSOLO_DEMO_MODE: 'true' });
    expect(secrets.providerSecrets['mm-operator-a']).toBe(NEW);
    expect(secrets.providerKeyRings?.['mm-operator-a']?.map((k) => k.kid)).toEqual(['k2', 'k1']);
  });

  it('mémoire anti-rejeu bornée : purge à l’expiration, éviction au plafond', () => {
    const store = new NonceStore(3);
    expect(store.remember('a', 100, 0).fresh).toBe(true);
    expect(store.remember('a', 100, 50).fresh).toBe(false);
    expect(store.remember('a', 300, 150).fresh).toBe(true); // expiré ⇒ ré-admis (l'horodatage périmé est refusé en amont)
    store.remember('b', 1000, 150);
    store.remember('c', 1000, 150);
    expect(store.size).toBe(3);
    const r = store.remember('d', 1000, 200); // plafond : purge des expirés (aucun) puis éviction du plus ancien
    expect(r).toEqual({ fresh: true, evicted: 1 });
    expect(store.size).toBe(3);
    expect(store.remember('d', 1000, 200).fresh).toBe(false);
    expect(store.remember('x', 2000, 1500)).toEqual({ fresh: true, evicted: 0 }); // b, c, d expirés : purgés sans éviction
    expect(store.size).toBe(1);
  });

  it('signCallback : chaîne canonique séparée par des retours à la ligne (pas d’ambiguïté horodatage/nonce)', () => {
    const a = signCallback('s', '2026-09-26T09:00:00.000Z', 'nonce.1234', '{}');
    const b = signCallback('s', '2026-09-26T09:00:00.000Z.nonce', '1234', '{}');
    expect(a).not.toBe(b);
  });
});

describe('Quittances — rotation de la clé de signature', () => {
  it('nouvelle clé signe (keyId) ; quittances de l’ancienne clé vérifiables tant qu’elle figure au trousseau', async () => {
    const old = generateKeyPairSync('ed25519');
    const env = await setup({ receiptSigningKey: old.privateKey });
    const { callback } = await payDemoObligation(env);
    const receipt = env.app.ctx.receipts.receipts.findOne((r) => r.number === callback.receiptNumber)!;
    expect(receipt.keyId).toBe(receiptKeyId(old.publicKey));
    const ctx = env.app.ctx;
    const next = generateKeyPairSync('ed25519');
    const rotated = new ReceiptService(ctx.clock, ctx.audit, ctx.alerts, next.privateKey, [old.publicKey]);
    expect(rotated.keyId).not.toBe(receipt.keyId);
    expect(rotated.verifySignature(receipt)).toBe(true);
    // Quittance antérieure à la rotation (sans keyId) : chaque clé du trousseau est essayée.
    const { keyId: _k, ...legacy } = receipt;
    expect(rotated.verifySignature(legacy)).toBe(true);
    expect(rotated.verificationKeys().map((k) => k.current)).toEqual([true, false]);
    // Ancienne clé retirée du trousseau ⇒ invérifiable ; keyId falsifié ⇒ invalide.
    const dropped = new ReceiptService(ctx.clock, ctx.audit, ctx.alerts, next.privateKey);
    expect(dropped.verifySignature(receipt)).toBe(false);
    expect(rotated.verifySignature({ ...receipt, keyId: rotated.keyId })).toBe(false);
  });

  it('MOSOLO_RECEIPT_VERIFY_KEYS : SPKI PEM (\\n littéraux), base64 DER ou clé privée ; clé non Ed25519 refusée', () => {
    const a = generateKeyPairSync('ed25519');
    const b = generateKeyPairSync('ed25519');
    const pemA = a.publicKey.export({ type: 'spki', format: 'pem' }).toString().replace(/\n/g, '\\n');
    const pemBPriv = b.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const derA = a.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    expect(loadReceiptVerificationKeys(`${pemA};${pemBPriv}`).map(receiptKeyId)).toEqual([receiptKeyId(a.publicKey), receiptKeyId(b.publicKey)]);
    expect(loadReceiptVerificationKeys(`${derA}; ${derA}`)).toHaveLength(2);
    expect(loadReceiptVerificationKeys(undefined)).toEqual([]);
    expect(() => loadReceiptVerificationKeys('pas-une-cle')).toThrow(/MOSOLO_RECEIPT_VERIFY_KEYS/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() => loadReceiptVerificationKeys(rsa)).toThrow(/Ed25519/);
    const app = buildApp({ clock: new ManualClock(), plugins: [], secrets: { ...defaultSecrets({ MOSOLO_DEMO_MODE: 'true', MOSOLO_RECEIPT_VERIFY_KEYS: pemA } as NodeJS.ProcessEnv) } });
    expect(app.ctx.receipts.verificationKeys().map((k) => k.keyId)).toContain(receiptKeyId(a.publicKey));
  });
});
