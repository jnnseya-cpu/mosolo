/**
 * Amorçage HORS DÉMONSTRATION (production) : la plateforme démarre vide ; le fichier JSON désigné par
 * MOSOLO_BOOTSTRAP_FILE déclare le strict nécessaire pour la mettre en service :
 *   - les comptes de travail de l'annuaire (l'annuaire n'est pas encore persisté : relu à chaque démarrage) ;
 *   - les comptes bénéficiaires du coffre (alias → coordonnées bancaires réelles), créés UNIQUEMENT s'ils n'existent
 *     pas encore. Un compte existant n'est JAMAIS modifié par l'amorçage : tout changement passe par la double
 *     validation du coffre (proposition, approbation par une seconde personne, délai de refroidissement).
 *   - l'enrôlement initial (mot de passe + TOTP aléatoires) des comptes marqués `enrol`, écrit une seule fois dans
 *     le fichier MOSOLO_BOOTSTRAP_CREDENTIALS_OUT (création exclusive, droits 0600), à remettre puis détruire.
 * Chaque application est tracée dans la chaîne d'audit (`bootstrap.applied`, `vault.account.bootstrapped`).
 *
 * Contrôle préalable (sans base ni serveur) : `npx tsx src/persistence/bootstrap-cli.ts check amorcage.json`.
 */
import { ROLES, type RoleCode } from '@mosolo/shared';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ConfigurationError, isDemoMode } from '../core/auth.js';

export const BOOTSTRAP_FORMAT = 'mosolo-amorcage/1';

const roleCode = z.string().refine((r) => r in ROLES, { message: 'Rôle inconnu' });

const bootstrapSchema = z.object({
  format: z.literal(BOOTSTRAP_FORMAT),
  users: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/, 'Identifiant : minuscules, chiffres, « . _ - » (3 à 64)'),
    name: z.string().min(2).max(200),
    roles: z.array(roleCode).min(1),
    entity: z.string().min(2).max(64),
    territory: z.array(z.string().min(1)).optional(),
    /** Enrôlement initial (mot de passe + TOTP aléatoires) s'il n'existe encore aucun identifiant pour ce compte. */
    enrol: z.boolean().optional(),
  }).strict()).default([]),
  vaultAccounts: z.array(z.object({
    alias: z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,63}$/, 'Alias : majuscules, chiffres et tirets'),
    entity: z.string().min(2).max(64),
    bankName: z.string().min(2).max(200),
    accountNumber: z.string().min(5).max(64),
    holderName: z.string().min(2).max(200),
    currency: z.enum(['USD', 'CDF']),
  }).strict()).default([]),
}).strict();

export type BootstrapDocument = z.infer<typeof bootstrapSchema>;

export interface BootstrapReport {
  users: string[];
  vaultCreated: string[];
  vaultKept: string[];
  enrolled: string[];
  credentialsFile: string | null;
  warnings: string[];
}

/** Valide un document d'amorçage (structure, rôles connus, doublons, cumuls de rôles incompatibles vérifiés à l'application). */
export function parseBootstrap(raw: unknown): BootstrapDocument {
  const r = bootstrapSchema.safeParse(raw);
  if (!r.success) {
    throw new ConfigurationError(`Fichier d'amorçage invalide : ${r.error.issues.map((i) => `${i.path.join('.') || '(racine)'} — ${i.message}`).join(' ; ')}`);
  }
  const doc = r.data;
  const dupUser = doc.users.map((u) => u.id).find((id, i, a) => a.indexOf(id) !== i);
  if (dupUser) throw new ConfigurationError(`Fichier d'amorçage invalide : utilisateur en double ${dupUser}.`);
  const dupAlias = doc.vaultAccounts.map((a) => a.alias).find((al, i, a) => a.indexOf(al) !== i);
  if (dupAlias) throw new ConfigurationError(`Fichier d'amorçage invalide : alias du coffre en double ${dupAlias}.`);
  if (doc.users.some((u) => u.id.startsWith('u-') && u.name.includes('(démo)'))) {
    throw new ConfigurationError('Fichier d’amorçage invalide : comptes de démonstration interdits.');
  }
  return doc;
}

export function loadBootstrapFile(path: string): BootstrapDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ConfigurationError(`MOSOLO_BOOTSTRAP_FILE illisible (${path}) : ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseBootstrap(raw);
}

interface EnrolCapable {
  idp?: {
    credentials: { get(id: string): unknown };
    enrolWorkAccount(userId: string, password: string): { login: string; totpSecret: string; otpauth: string };
  };
}

/**
 * Applique l'amorçage au contexte (après rattachement de la persistance). Refusé en mode démonstration :
 * un amorçage réel et des données fictives ne cohabitent jamais.
 */
export function applyBootstrap(ctx: AppContext, doc: BootstrapDocument, env: NodeJS.ProcessEnv = process.env): BootstrapReport {
  if (isDemoMode(env)) throw new ConfigurationError('Amorçage (MOSOLO_BOOTSTRAP_FILE) refusé en mode démonstration.');
  const report: BootstrapReport = { users: [], vaultCreated: [], vaultKept: [], enrolled: [], credentialsFile: null, warnings: [] };
  const actor = { kind: 'system' as const, id: 'amorcage' };

  for (const u of doc.users) {
    if (ctx.users.get(u.id)) continue;
    // `add` refuse les rôles inconnus et tout cumul de rôles incompatibles (§ 12.5).
    ctx.users.add({ id: u.id, name: u.name, roles: u.roles as RoleCode[], entity: u.entity, ...(u.territory ? { territory: u.territory } : {}) });
    report.users.push(u.id);
  }

  for (const a of doc.vaultAccounts) {
    if (ctx.vault.aliasExists(a.alias)) {
      // Jamais d'écrasement : un changement de coordonnées passe par la double validation du coffre.
      report.vaultKept.push(a.alias);
      continue;
    }
    ctx.vault.seedAccount(a);
    report.vaultCreated.push(a.alias);
    ctx.audit.append({
      actor, action: 'vault.account.bootstrapped', resourceType: 'beneficiary_account', resourceId: a.alias,
      details: { entity: a.entity, currency: a.currency, bankName: a.bankName, accountNumberLast4: a.accountNumber.replace(/\s+/g, '').slice(-4) },
    });
  }

  // Enrôlement initial : uniquement si aucun identifiant n'existe (jamais de réinitialisation silencieuse).
  const socle = ctx.ext.socle as EnrolCapable | undefined;
  const toEnrol = doc.users.filter((u) => u.enrol);
  if (toEnrol.length > 0) {
    const out = env.MOSOLO_BOOTSTRAP_CREDENTIALS_OUT?.trim();
    const pending = socle?.idp ? toEnrol.filter((u) => !socle.idp!.credentials.get(u.id)) : [];
    if (!socle?.idp) report.warnings.push('Enrôlement demandé mais module « socle » absent : aucun identifiant créé.');
    else if (pending.length > 0 && !out) report.warnings.push(`Enrôlement de ${pending.map((u) => u.id).join(', ')} en attente : MOSOLO_BOOTSTRAP_CREDENTIALS_OUT non défini.`);
    else if (pending.length > 0 && out) {
      const issued = pending.map((u) => {
        const password = randomBytes(18).toString('base64url');
        const e = socle.idp!.enrolWorkAccount(u.id, password);
        report.enrolled.push(u.id);
        return { login: e.login, password, totpSecret: e.totpSecret, otpauth: e.otpauth };
      });
      try {
        // Création exclusive : un fichier non détruit après remise bloque tout nouvel enrôlement (pas d'écrasement).
        writeFileSync(out, JSON.stringify({ notice: 'Identifiants initiaux — à remettre en main propre puis DÉTRUIRE ; changer le mot de passe à la première connexion.', issued }, null, 1), { flag: 'wx', mode: 0o600 });
      } catch (e) {
        throw new ConfigurationError(`MOSOLO_BOOTSTRAP_CREDENTIALS_OUT (${out}) : écriture impossible (${e instanceof Error ? e.message : String(e)}). Détruisez le fichier précédent après remise.`);
      }
      report.credentialsFile = out;
    }
  }

  ctx.audit.append({
    actor, action: 'bootstrap.applied', resourceType: 'platform', resourceId: BOOTSTRAP_FORMAT,
    details: {
      users: doc.users.map((u) => ({ id: u.id, roles: u.roles, entity: u.entity })), usersAdded: report.users,
      vaultCreated: report.vaultCreated, vaultKept: report.vaultKept, enrolled: report.enrolled, warnings: report.warnings,
    },
  });
  return report;
}
