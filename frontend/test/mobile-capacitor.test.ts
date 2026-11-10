/**
 * Module 4 — enveloppe native Capacitor (Android ET iOS) : configuration contrôlée sans SDK, module natif
 * d'intégrité présent sur les deux plateformes avec le même contrat que le crochet web (`verifierIntegrite`).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const mobile = join(__dirname, '..', '..', 'mobile');
const lire = (f: string) => readFileSync(join(mobile, f), 'utf8');

describe('Enveloppe Capacitor Android et iOS', () => {
  it('configuration : deux cibles, HTTPS seulement, débogage coupé, application web du frontend', () => {
    const cfg = JSON.parse(lire('capacitor.config.json'));
    expect(cfg).toMatchObject({ appId: 'cd.kinshasa.mosolo', webDir: '../frontend/dist', server: { androidScheme: 'https', cleartext: false } });
    expect(cfg.android.webContentsDebuggingEnabled).toBe(false);
    expect(cfg.ios.webContentsDebuggingEnabled).toBe(false);
    const pkg = JSON.parse(lire('package.json'));
    expect(Object.keys(pkg.dependencies)).toEqual(expect.arrayContaining(['@capacitor/android', '@capacitor/ios', '@capacitor/core']));
    expect(pkg.scripts['construire:android']).toMatch(/gradlew/);
    expect(pkg.scripts['construire:ios']).toMatch(/xcodebuild/);
    // Le script de contrôle s'exécute sans SDK.
    expect(execFileSync(process.execPath, [join(mobile, 'scripts', 'verifier-config.mjs')], { encoding: 'utf8' })).toMatch(/Android et iOS/);
  });

  it('module natif « MosoloIntegrite » : même contrat (racine, jailbreak, émulateur, débogage) sur les deux plateformes', () => {
    const java = lire('native/android/MosoloIntegritePlugin.java');
    const swift = lire('native/ios/MosoloIntegritePlugin.swift');
    for (const src of [java, swift]) for (const k of ['racine', 'jailbreak', 'emulateur', 'debogage', 'signatureAlteree']) expect(src).toContain(`"${k}"`);
    expect(java).toContain('@CapacitorPlugin(name = "MosoloIntegrite")');
    expect(java).toMatch(/test-keys/);
    expect(swift).toContain('jsName = "MosoloIntegrite"');
    expect(swift).toMatch(/P_TRACED/);
  });
});
