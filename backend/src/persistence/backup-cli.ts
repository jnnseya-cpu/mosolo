/**
 * Outil d'exploitation — sauvegarde / vérification / restauration de la base (instantané JSONB) :
 *   DATABASE_URL=… MOSOLO_BACKUP_KEY=… npm run db:backup  -w backend -- sauvegarde.json
 *   MOSOLO_BACKUP_KEY=… [MOSOLO_AUDIT_HMAC_KEY=…] npm run db:verify -w backend -- sauvegarde.json
 *   DATABASE_URL=… MOSOLO_BACKUP_KEY=… MOSOLO_AUDIT_HMAC_KEY=… npm run db:restore -w backend -- sauvegarde.json --confirm
 * La restauration exige `--confirm`, s'exécute serveur arrêté, avec un rôle d'exploitation distinct du rôle applicatif.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { backupStore, restoreStore, verifyBackup, type BackupDocument } from './backup.js';
import { openPgStore } from './store.js';

function fail(msg: string): never {
  console.error(`Erreur : ${msg}`);
  process.exit(1);
}

const [cmd, file, ...flags] = process.argv.slice(2);
const key = process.env.MOSOLO_BACKUP_KEY ?? fail('MOSOLO_BACKUP_KEY obligatoire.');
const auditKey = process.env.MOSOLO_AUDIT_HMAC_KEY;
if (!file) fail('Chemin du fichier de sauvegarde attendu.');

if (cmd === 'backup') {
  const store = await openPgStore(process.env.DATABASE_URL ?? fail('DATABASE_URL obligatoire.'));
  await store.migrate();
  const doc = await backupStore(store, key);
  await store.close();
  writeFileSync(file, JSON.stringify(doc, null, 1));
  console.info(`Sauvegarde écrite : ${file} — ${doc.manifest.rows} document(s), ${Object.keys(doc.manifest.repos).length} dépôt(s), SHA-256 ${doc.contentSha256}`);
} else if (cmd === 'verify' || cmd === 'restore') {
  const doc = JSON.parse(readFileSync(file, 'utf8')) as BackupDocument;
  const v = verifyBackup(doc, key, auditKey);
  console.info(`Vérification : ${v.ok ? 'CONFORME' : 'NON CONFORME'} — ${v.rows} document(s), ${v.repos} dépôt(s)` + (v.audit ? `, chaîne d'audit ${v.audit.ok ? 'intègre' : 'rompue'} (${v.audit.length})` : ', chaîne d’audit non vérifiée (MOSOLO_AUDIT_HMAC_KEY absente)'));
  for (const r of v.reasons) console.error(`  - ${r}`);
  if (!v.ok) process.exit(2);
  if (cmd === 'restore') {
    if (!auditKey) fail('Restauration : MOSOLO_AUDIT_HMAC_KEY obligatoire (la chaîne d’audit doit être vérifiée avant toute restauration).');
    if (!flags.includes('--confirm')) fail('Restauration : ajoutez --confirm (opération destructive, serveur arrêté).');
    const store = await openPgStore(process.env.DATABASE_URL ?? fail('DATABASE_URL obligatoire.'));
    await restoreStore(store, doc, key, auditKey);
    await store.close();
    console.info('Restauration terminée. Redémarrez le serveur : l’instantané restauré sera chargé.');
  }
} else {
  fail('Commande attendue : backup | verify | restore');
}
