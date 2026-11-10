/**
 * Rôles PostgreSQL d'exploitation (migration 003, backend/db/README.md « Rôles PostgreSQL »), appliqués par la tâche
 * de migration (`npm run db:migrate -w backend`) et JAMAIS par le serveur :
 *   - rôle APPLICATIF (MOSOLO_DB_APP_ROLE, mot de passe MOSOLO_DB_APP_PASSWORD) : créé s'il n'existe pas, mot de passe
 *     (re)posé, droits minimaux — SELECT, INSERT sur `append_only_journal` ; SELECT, INSERT, UPDATE sur
 *     `repository_snapshot` et `instance_lease` ; SELECT sur `schema_migrations` ; UPDATE, DELETE, TRUNCATE du journal
 *     retirés ;
 *   - rôle de RESTAURATION (MOSOLO_DB_RESTORE_ROLE, facultatif) : reçoit `mosolo_restore` (jamais le rôle applicatif).
 * Toutes les instructions sont rejouables (idempotentes) ; aucune ne supprime quoi que ce soit.
 */
import { ConfigurationError } from '../core/auth.js';

export interface DbRolesConfig {
  appRole?: string;
  appPassword?: string;
  restoreRole?: string;
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const MIN_PASSWORD = 16;

export function dbRolesFromEnv(env: NodeJS.ProcessEnv = process.env): DbRolesConfig {
  const appRole = env.MOSOLO_DB_APP_ROLE?.trim();
  const appPassword = env.MOSOLO_DB_APP_PASSWORD?.trim();
  const restoreRole = env.MOSOLO_DB_RESTORE_ROLE?.trim();
  return { ...(appRole ? { appRole } : {}), ...(appPassword ? { appPassword } : {}), ...(restoreRole ? { restoreRole } : {}) };
}

const literal = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** Instructions SQL (dans l'ordre) ; lève ConfigurationError sur un nom de rôle ou un mot de passe invalide. */
export function roleStatements(cfg: DbRolesConfig): string[] {
  const out: string[] = [];
  if (cfg.appRole) {
    const r = cfg.appRole;
    if (!IDENT.test(r)) throw new ConfigurationError(`MOSOLO_DB_APP_ROLE invalide (${r}) : minuscules, chiffres et « _ », 63 caractères au plus.`);
    if (r === cfg.restoreRole) throw new ConfigurationError('MOSOLO_DB_RESTORE_ROLE doit être distinct du rôle applicatif (mosolo_restore jamais accordé au rôle applicatif).');
    if (!cfg.appPassword || cfg.appPassword.length < MIN_PASSWORD) {
      throw new ConfigurationError(`MOSOLO_DB_APP_PASSWORD obligatoire avec MOSOLO_DB_APP_ROLE (${MIN_PASSWORD} caractères minimum).`);
    }
    out.push(
      `DO $mosolo$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(r)}) THEN CREATE ROLE ${r} LOGIN; END IF; END $mosolo$`,
      `ALTER ROLE ${r} WITH LOGIN PASSWORD ${literal(cfg.appPassword)}`,
      `DO $mosolo$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${r}', current_database()); END $mosolo$`,
      `GRANT USAGE ON SCHEMA public TO ${r}`,
      `GRANT SELECT ON schema_migrations TO ${r}`,
      `GRANT SELECT, INSERT, UPDATE ON repository_snapshot TO ${r}`,
      `GRANT SELECT, INSERT ON append_only_journal TO ${r}`,
      // Bail de l'instance active (migration 004) : prise au démarrage, relu à chaque lot.
      `GRANT SELECT, INSERT, UPDATE ON instance_lease TO ${r}`,
      `REVOKE DELETE, TRUNCATE ON repository_snapshot FROM ${r}`,
      `REVOKE UPDATE, DELETE, TRUNCATE ON append_only_journal FROM ${r}`,
    );
  }
  if (cfg.restoreRole) {
    const r = cfg.restoreRole;
    if (!IDENT.test(r)) throw new ConfigurationError(`MOSOLO_DB_RESTORE_ROLE invalide (${r}).`);
    out.push(`DO $mosolo$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mosolo_restore') THEN GRANT mosolo_restore TO ${r}; ELSE RAISE NOTICE 'Rôle mosolo_restore absent : à créer par l''administrateur de la base.'; END IF; END $mosolo$`);
  }
  return out;
}

/** Texte journalisable d'une instruction : le mot de passe n'apparaît jamais. */
export function redactStatement(sql: string): string {
  return sql.replace(/PASSWORD\s+'(?:[^']|'')*'/gi, "PASSWORD '***'");
}
