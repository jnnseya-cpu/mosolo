/**
 * Rattachement des agents de terrain aux modules (30/09/2026, consigne du maître d'ouvrage : « un agent de terrain n'est
 * rattaché qu'aux modules qu'il peut vérifier ») : superviseur (R09), agent de terrain (R10) et contrôleur (R11) ne
 * contrôlent, ne scannent et ne vérifient que dans les modules de leur rattachement — contrôle fait par le SERVEUR ; le
 * menu masque les écrans de contrôle des autres modules. Un compte sans rattachement déclaré garde son comportement
 * antérieur (périmètre de rôle et de territoire) : à rattacher par l'administrateur de l'entité.
 */
export const MODULES_VERIFICATION = {
  STATIONNEMENT: 'Stationnement',
  TITRES: 'Titres, tickets et pass',
  VEHICULES: 'Chaîne véhicule (contrôle technique, fourrière)',
  PUBLICITE: 'Publicité et enseignes',
  FONCIER: 'Foncier, locatif et patentes',
  VERTICALES: 'Services de la Ville (verticales)',
  RAKAPAY: 'Transport (RakaPay)',
  TERRAIN: 'Missions de terrain (recensement, inspection)',
} as const;
export type ModuleVerification = keyof typeof MODULES_VERIFICATION;
export const MODULE_VERIFICATION_CODES = Object.keys(MODULES_VERIFICATION) as ModuleVerification[];

/** Rôles de terrain soumis au rattachement. */
export const ROLES_AGENTS_TERRAIN = ['R09', 'R10', 'R11'] as const;

/** Écrans de contrôle par module (menu : masqués pour un agent non rattaché). */
export const ECRANS_CONTROLE_PAR_MODULE: Record<string, ModuleVerification> = {
  '/stationnement/controle': 'STATIONNEMENT',
  '/titres/controle': 'TITRES',
  '/vehicules/scan': 'VEHICULES',
  '/vehicules/fourrieres': 'VEHICULES',
  '/publicite/inspection': 'PUBLICITE',
  '/fiscal/biens': 'FONCIER',
  '/fiscal/recensement': 'FONCIER',
  '/verticales/console': 'VERTICALES',
  '/verticales/secteurs': 'VERTICALES',
  '/verticales/fiches': 'VERTICALES',
  '/terrain/inspection': 'TERRAIN',
};

/** Vrai si l'agent peut agir dans ce module (compte sans rattachement déclaré : comportement antérieur). */
export function agentRattache(user: { roles: readonly string[]; modules?: readonly string[] }, module: ModuleVerification): boolean {
  const agentSeul = user.roles.length > 0 && user.roles.every((r) => (ROLES_AGENTS_TERRAIN as readonly string[]).includes(r));
  if (!agentSeul || !user.modules) return true;
  return user.modules.includes(module);
}
