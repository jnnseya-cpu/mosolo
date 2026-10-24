/**
 * Outil d'exploitation — sauvegarde / vérification / restauration de la base (instantané JSONB) :
 *   DATABASE_URL=… MOSOLO_BACKUP_KEY=… npm run db:backup  -w backend -- sauvegarde.json
 *   MOSOLO_BACKUP_KEY=… [MOSOLO_AUDIT_HMAC_KEY=…] npm run db:verify -w backend -- sauvegarde.json
 *   DATABASE_URL=… MOSOLO_BACKUP_KEY=… MOSOLO_AUDIT_HMAC_KEY=… MOSOLO_AUDIT_ANCHOR_PATH=… npm run db:restore -w backend -- sauvegarde.json --confirm [--confirm-rollback] [--operator=nom]
 * La restauration exige `--confirm`, s'exécute serveur arrêté, avec un rôle d'exploitation (membre de `mosolo_restore`,
 * migration 003) distinct du rôle applicatif. Elle compare la sauvegarde à la chaîne en place et à l'ancre externe
 * (MOSOLO_AUDIT_ANCHOR_PATH, obligatoire hors démonstration) : une sauvegarde plus ancienne (retour arrière) exige
 * `--confirm-rollback` ; l'événement `audit.restored` est toujours ajouté et l'ancre réécrite.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isDemoMode } from '../core/auth.js';
import { FileAuditAnchor } from './anchor.js';
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
    const anchorPath = process.env.MOSOLO_AUDIT_ANCHOR_PATH?.trim();
    if (!anchorPath && !isDemoMode()) fail('Restauration : MOSOLO_AUDIT_ANCHOR_PATH obligatoire hors démonstration (détection du retour arrière).');
    const operator = flags.find((f) => f.startsWith('--operator='))?.slice('--operator='.length);
    const store = await openPgStore(process.env.DATABASE_URL ?? fail('DATABASE_URL obligatoire.'));
    try {
      // Bail de l'instance active (migration 004) : une instance encore en service (Cloud Run) est supplantée et
      // n'écrira plus rien ; le prochain démarrage relira la base restaurée.
      await store.acquireLease(`restauration:${operator ?? 'inconnu'}`, new Date())
        .then((g) => console.info(`Bail pris pour la restauration (génération ${g}) : toute instance en service cesse d'écrire.`))
        .catch((e: unknown) => console.warn(`Bail non pris (${e instanceof Error ? e.message : String(e)}) : arrêter l'application avant de restaurer.`));
      const r = await restoreStore(store, doc, key, auditKey, new Date(), {
        ...(anchorPath ? { anchor: new FileAuditAnchor(anchorPath, auditKey) } : {}),
        confirmRollback: flags.includes('--confirm-rollback'),
        ...(operator ? { operator } : {}),
      });
      console.info(`Chaîne d'audit : tête en place ${r.previousHead.seq}, ancrée ${r.anchorHead?.seq ?? '—'}, restaurée ${r.restoredHead.seq} → ${r.newHead.seq} (audit.restored).` + (r.rollback ? ' RETOUR ARRIÈRE confirmé et tracé.' : ''));
    } catch (e) {
      await store.close();
      fail(e instanceof Error ? e.message : String(e));
    }
    await store.close();
    console.info('Restauration terminée. Redémarrez le serveur : l’instantané restauré sera chargé.');
  }
} else {
  fail('Commande attendue : backup | verify | restore');
}
