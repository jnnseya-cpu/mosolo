/**
 * Préparation asynchrone de la persistance avant `buildApp` : sans DATABASE_URL, rien ne change (mémoire seule).
 * Avec DATABASE_URL : migrations, chargement de l'instantané, moteur rendu actif pour le plugin « socle »
 * qui l'attache au contexte après les données de démonstration.
 */
import { ConfigurationError, isDemoMode } from '../core/auth.js';
import { openPgStore } from './store.js';
import { PersistenceRuntime, setActivePersistence } from './runtime.js';

export interface BootLog {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const consoleLog: BootLog = {
  info: (m) => console.info(`[persistance] ${m}`),
  warn: (m) => console.warn(`[persistance] ${m}`),
  error: (m) => console.error(`[persistance] ${m}`),
};

export async function preparePersistence(env: NodeJS.ProcessEnv = process.env, log: BootLog = consoleLog): Promise<PersistenceRuntime | undefined> {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    log.info('DATABASE_URL absente : stockage en mémoire (démonstration).');
    setActivePersistence(undefined);
    return undefined;
  }
  if (!env.MOSOLO_AUDIT_HMAC_KEY) {
    // Clé aléatoire à chaque démarrage : la chaîne restaurée ne serait jamais vérifiable (une altération passerait inaperçue).
    if (!isDemoMode(env)) throw new ConfigurationError('MOSOLO_AUDIT_HMAC_KEY obligatoire avec DATABASE_URL hors mode démonstration : sans elle, la chaîne d’audit persistée ne peut pas être vérifiée.');
    log.warn('MOSOLO_AUDIT_HMAC_KEY absente : la clé du journal d’audit change à chaque démarrage et la chaîne restaurée ne pourra pas être vérifiée.');
  }
  if (!env.MOSOLO_RECEIPT_SIGNING_KEY?.trim()) {
    log.warn('MOSOLO_RECEIPT_SIGNING_KEY absente : la clé de signature des quittances change à chaque démarrage ; les quittances restaurées apparaîtront comme suspectes (signature invalide) à la vérification publique.');
  }
  const store = await openPgStore(url);
  const runtime = await PersistenceRuntime.open(store, { log: (level, msg) => log[level](msg) });
  setActivePersistence(runtime);
  return runtime;
}
