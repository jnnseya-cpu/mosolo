/**
 * Préparation asynchrone de la persistance avant `buildApp` : sans DATABASE_URL, rien ne change (mémoire seule).
 * Avec DATABASE_URL : migrations, chargement de l'instantané, moteur rendu actif pour le plugin « socle »
 * qui l'attache au contexte après les données de démonstration.
 */
import { createPrivateKey } from 'node:crypto';
import { ConfigurationError, isDemoMode, isProduction } from '../core/auth.js';
import { loadReceiptSigningKey, loadReceiptVerificationKeys } from '../modules/receipts/service.js';
import { FileAuditAnchor } from './anchor.js';
import { openPgStore, type SnapshotStore } from './store.js';
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

const MIN_KEY_LENGTH = 32;

/**
 * Contrôle de démarrage HORS DÉMONSTRATION (les deux points d'entrée) : sans clés de signature stables, les
 * quittances et les clôtures signées au démarrage précédent deviendraient invérifiables (clé éphémère) — refus.
 *   - MOSOLO_RECEIPT_SIGNING_KEY : clé privée Ed25519 PKCS#8 (PEM ou base64 DER), lue par modules/receipts ; anciennes
 *     clés publiques encore acceptées en vérification (rotation) : MOSOLO_RECEIPT_VERIFY_KEYS (facultative, contrôlée ici) ;
 *   - MOSOLO_CLOSURE_SIGNING_KEY : clé de signature des clôtures (lue par le module trésor), distincte de la précédente ;
 *   - avec DATABASE_URL : MOSOLO_AUDIT_HMAC_KEY et MOSOLO_AUDIT_ANCHOR_PATH (ancre externe de la chaîne d'audit).
 */
export function assertBootSecrets(env: NodeJS.ProcessEnv = process.env): void {
  if (isDemoMode(env)) return;
  const missing: string[] = [];
  const receipt = env.MOSOLO_RECEIPT_SIGNING_KEY?.trim();
  const closure = env.MOSOLO_CLOSURE_SIGNING_KEY?.trim();
  if (!receipt) missing.push('MOSOLO_RECEIPT_SIGNING_KEY');
  if (!closure) missing.push('MOSOLO_CLOSURE_SIGNING_KEY');
  if (env.DATABASE_URL?.trim()) {
    if (!env.MOSOLO_AUDIT_HMAC_KEY?.trim()) missing.push('MOSOLO_AUDIT_HMAC_KEY');
    if (!env.MOSOLO_AUDIT_ANCHOR_PATH?.trim()) missing.push('MOSOLO_AUDIT_ANCHOR_PATH');
  }
  // Production (NODE_ENV=production) : jamais de stockage en mémoire — un redémarrage effacerait paiements et quittances.
  if (isProduction(env) && !env.DATABASE_URL?.trim()) missing.push('DATABASE_URL');
  if (missing.length) {
    throw new ConfigurationError(`Démarrage refusé hors mode démonstration : ${missing.join(', ')} obligatoire(s) (clés stables — sinon quittances, clôtures ou chaîne d'audit invérifiables après redémarrage). Voir backend/README.md.`);
  }
  try {
    loadReceiptSigningKey(receipt);
    loadReceiptVerificationKeys(env.MOSOLO_RECEIPT_VERIFY_KEYS);
  } catch (e) {
    throw new ConfigurationError(e instanceof Error ? e.message : String(e));
  }
  if (closure!.length < MIN_KEY_LENGTH) throw new ConfigurationError(`MOSOLO_CLOSURE_SIGNING_KEY trop courte (${MIN_KEY_LENGTH} caractères minimum).`);
  if (closure!.includes('-----BEGIN')) {
    try {
      createPrivateKey(closure!.replace(/\\n/g, '\n'));
    } catch {
      throw new ConfigurationError('MOSOLO_CLOSURE_SIGNING_KEY illisible : clé privée PEM attendue.');
    }
  }
  if (closure === receipt) throw new ConfigurationError('MOSOLO_CLOSURE_SIGNING_KEY doit être distincte de MOSOLO_RECEIPT_SIGNING_KEY (séparation des clés).');
  if (env.MOSOLO_AUDIT_HMAC_KEY && env.MOSOLO_AUDIT_HMAC_KEY.trim().length < MIN_KEY_LENGTH) {
    throw new ConfigurationError(`MOSOLO_AUDIT_HMAC_KEY trop courte (${MIN_KEY_LENGTH} caractères minimum).`);
  }
}

/**
 * `openStore` : ouverture du magasin (défaut : pilote `pg` sur DATABASE_URL) ; injectable pour rejouer le démarrage
 * de production complet sur PostgreSQL simulé (test/deploiement.test.ts).
 */
export async function preparePersistence(
  env: NodeJS.ProcessEnv = process.env,
  log: BootLog = consoleLog,
  openStore: (url: string) => Promise<SnapshotStore> = openPgStore,
): Promise<PersistenceRuntime | undefined> {
  assertBootSecrets(env);
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
  const anchorPath = env.MOSOLO_AUDIT_ANCHOR_PATH?.trim();
  const auditKey = env.MOSOLO_AUDIT_HMAC_KEY?.trim() ? env.MOSOLO_AUDIT_HMAC_KEY : undefined;
  if (!anchorPath || !auditKey) log.warn('Ancre externe de la chaîne d’audit inactive (MOSOLO_AUDIT_ANCHOR_PATH / MOSOLO_AUDIT_HMAC_KEY absentes) : une troncature ou un retour arrière de la base ne serait pas détecté.');
  const store = await openStore(url);
  const runtime = await PersistenceRuntime.open(store, {
    log: (level, msg) => log[level](msg),
    ...(anchorPath && auditKey ? { anchor: new FileAuditAnchor(anchorPath, auditKey) } : {}),
  });
  setActivePersistence(runtime);
  return runtime;
}

/**
 * Point d'entrée SANS persistance (src/server.ts) : réservé à la démonstration et au développement. En production
 * (NODE_ENV=production), refus explicite — utiliser `npm start -w backend` (persistence/server.ts, PostgreSQL).
 */
export function assertMemoryEntryAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (isProduction(env)) {
    throw new ConfigurationError('Démarrage refusé : src/server.ts ne persiste rien (mémoire seule). En production, utilisez `npm start -w backend` (src/persistence/server.ts) avec DATABASE_URL.');
  }
}
