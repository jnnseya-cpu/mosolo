// Contrôle de la configuration Capacitor (module 4) sans SDK : cibles Android ET iOS, HTTPS seulement, débogage
// désactivé, application web construite par le paquet frontend, module natif d'intégrité présent.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(racine, 'capacitor.config.json'), 'utf8'));
const erreurs = [];
if (cfg.webDir !== '../frontend/dist') erreurs.push('webDir doit pointer vers ../frontend/dist');
if (!cfg.android || !cfg.ios) erreurs.push('les deux cibles Android et iOS sont requises');
if (cfg.server?.cleartext !== false || cfg.server?.androidScheme !== 'https') erreurs.push('HTTPS seulement (cleartext interdit)');
if (cfg.android?.webContentsDebuggingEnabled || cfg.ios?.webContentsDebuggingEnabled) erreurs.push('débogage du WebView interdit en production');
for (const f of ['native/android/MosoloIntegritePlugin.java', 'native/ios/MosoloIntegritePlugin.swift']) if (!existsSync(join(racine, f))) erreurs.push(`fichier manquant : ${f}`);
if (erreurs.length) {
  console.error(`Configuration mobile invalide :\n- ${erreurs.join('\n- ')}`);
  process.exit(1);
}
console.log(`Configuration mobile valide : ${cfg.appId} (Android et iOS).`);
