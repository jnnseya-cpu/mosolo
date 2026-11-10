/**
 * Tâche de migration (exploitation, avant le démarrage d'une nouvelle version) — rejouable sans effet :
 *   DATABASE_URL=… npm run db:migrate -w backend                 # applique les migrations en attente (verrou consultatif)
 *   DATABASE_URL=… npm run db:migrate -w backend -- --check      # liste les migrations en attente, n'applique rien (code 3 s'il en reste)
 * Avec MOSOLO_DB_APP_ROLE + MOSOLO_DB_APP_PASSWORD (et MOSOLO_DB_RESTORE_ROLE) : rôles et droits minimaux posés après
 * les migrations (voir db-roles.ts). DATABASE_URL désigne ici le rôle de MIGRATION (propriétaire des tables), jamais
 * le rôle applicatif. Le serveur applique aussi les migrations au démarrage : cette tâche les rend explicites et
 * permet de refuser un rôle applicatif sans droit CREATE.
 */
import { dbRolesFromEnv, redactStatement, roleStatements } from './db-roles.js';
import { openPgStore } from './store.js';

function fail(msg: string, code = 1): never {
  console.error(`Erreur : ${msg}`);
  process.exit(code);
}

const flags = process.argv.slice(2);
const url = process.env.DATABASE_URL?.trim() || fail('DATABASE_URL obligatoire (rôle de migration).');
let statements: string[] = [];
try {
  statements = roleStatements(dbRolesFromEnv());
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

const store = await openPgStore(url);
try {
  if (flags.includes('--check')) {
    const pending = await store.pendingMigrations();
    console.info(pending.length ? `Migrations en attente : ${pending.join(', ')}` : 'Aucune migration en attente.');
    await store.close();
    process.exit(pending.length ? 3 : 0);
  }
  const applied = await store.migrate();
  console.info(applied.length ? `Migrations appliquées : ${applied.join(', ')}` : 'Aucune migration en attente (base à jour).');
  for (const sql of statements) {
    await store.exec(sql);
    console.info(`Droits : ${redactStatement(sql)}`);
  }
  const left = await store.pendingMigrations();
  if (left.length) fail(`migrations encore en attente après exécution : ${left.join(', ')}`, 2);
  console.info('Base à jour.');
} catch (e) {
  await store.close().catch(() => undefined);
  fail(e instanceof Error ? e.message : String(e), 2);
}
await store.close();
