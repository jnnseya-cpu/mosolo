/**
 * Contrôle préalable d'un fichier d'amorçage hors démonstration (sans base ni serveur) :
 *   npm run bootstrap:check -w backend -- /chemin/amorcage.json
 * Le fichier est ensuite désigné au serveur par MOSOLO_BOOTSTRAP_FILE (appliqué à chaque démarrage, sans jamais
 * écraser un compte du coffre existant) ; voir src/persistence/bootstrap.ts et backend/README.md.
 */
import { hasIncompatibility, ROLES, type RoleCode } from '@mosolo/shared';
import { loadBootstrapFile } from './bootstrap.js';

const [cmd, file] = process.argv.slice(2);
if (cmd !== 'check' || !file) {
  console.error('Usage : bootstrap-cli.ts check <amorcage.json>');
  process.exit(1);
}
try {
  const doc = loadBootstrapFile(file);
  const clashes = doc.users.map((u) => [u.id, hasIncompatibility(u.roles as RoleCode[])] as const).filter(([, c]) => c);
  for (const [id, c] of clashes) console.error(`  - ${id} : cumul interdit ${c![0]} / ${c![1]}`);
  if (clashes.length) process.exit(2);
  console.info(`Amorçage CONFORME : ${doc.users.length} compte(s) de travail, ${doc.vaultAccounts.length} compte(s) du coffre.`);
  for (const u of doc.users) console.info(`  • ${u.id} — ${u.roles.map((r) => `${r} ${ROLES[r as RoleCode]}`).join(', ')}${u.enrol ? ' (enrôlement initial)' : ''}`);
  for (const a of doc.vaultAccounts) console.info(`  • coffre ${a.alias} (${a.entity}, ${a.currency}) — compte …${a.accountNumber.replace(/\s+/g, '').slice(-4)}`);
  const r19 = doc.users.filter((u) => u.roles.includes('R19')).length;
  if (doc.vaultAccounts.length > 0 && r19 < 2) console.warn('  ! Moins de deux gestionnaires du coffre (R19) : la double validation des changements de compte sera impossible.');
} catch (e) {
  console.error(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
