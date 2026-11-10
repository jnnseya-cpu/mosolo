/**
 * Option de ligne de commande `--demo` des points d'entrée : active EXPLICITEMENT le mode démonstration
 * (MOSOLO_DEMO_MODE=true) pour le développement local, sans dépendre de la syntaxe d'environnement du shell.
 * Sans effet si MOSOLO_DEMO_MODE est déjà défini ; refusé en production par `assertSafeDeployment` au démarrage.
 */
export function enableDemoFromArgv(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!argv.includes('--demo')) return false;
  env.MOSOLO_DEMO_MODE ??= 'true';
  return true;
}
