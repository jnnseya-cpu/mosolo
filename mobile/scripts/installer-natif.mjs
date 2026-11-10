// Copie le module natif « MosoloIntegrite » dans le projet Android ou iOS généré par `cap add` (module 4).
// Usage : node scripts/installer-natif.mjs android|ios
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const cible = process.argv[2];

if (cible === 'android') {
  const dest = join(racine, 'android/app/src/main/java/cd/kinshasa/mosolo');
  mkdirSync(dest, { recursive: true });
  copyFileSync(join(racine, 'native/android/MosoloIntegritePlugin.java'), join(dest, 'MosoloIntegritePlugin.java'));
  // Enregistrement du module dans MainActivity (Capacitor 6).
  const main = join(dest, 'MainActivity.java');
  if (existsSync(main)) {
    let src = readFileSync(main, 'utf8');
    if (!src.includes('MosoloIntegritePlugin')) {
      src = src.replace(/public class MainActivity extends BridgeActivity \{\s*\}/, [
        'public class MainActivity extends BridgeActivity {',
        '    @Override',
        '    public void onCreate(android.os.Bundle savedInstanceState) {',
        '        registerPlugin(MosoloIntegritePlugin.class);',
        '        super.onCreate(savedInstanceState);',
        '    }',
        '}',
      ].join('\n'));
      writeFileSync(main, src);
    }
  }
  console.log('Module natif Android installé.');
} else if (cible === 'ios') {
  const dest = join(racine, 'ios/App/App');
  mkdirSync(dest, { recursive: true });
  copyFileSync(join(racine, 'native/ios/MosoloIntegritePlugin.swift'), join(dest, 'MosoloIntegritePlugin.swift'));
  console.log('Module natif iOS copié : ajoutez MosoloIntegritePlugin.swift à la cible « App » dans Xcode (Capacitor 6 : CAPBridgedPlugin).');
} else {
  console.error('Usage : node scripts/installer-natif.mjs android|ios');
  process.exit(1);
}
