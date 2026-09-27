/**
 * Paramètres du renseignement anti-fraude complémentaire (module 40) — valeurs PAR_DEFAUT, à confirmer par le maître
 * d'ouvrage (registre des seuils, circuit à deux personnes). Aucun ne déclenche d'effet : ils ouvrent un signal à examiner.
 */
import type { ParamDefinition, ParamValue } from '../gouvernance/parametres.js';

const R = (id: string, label: string, value: number, unit: string, bounds: { min: number; max: number }, description?: string): ParamDefinition => ({
  id, label, category: 'Renseignement anti-fraude (module 40)', value, unit, owner: 'REGISTRE',
  source: { file: 'backend/src/plugins/integrite/enquetes/parametres.ts', constant: 'PARAMETRES_ENQUETES', exported: true }, ...bounds, ...(description ? { description } : {}),
});

export const PARAMETRES_ENQUETES: ParamDefinition[] = [
  R('enquete.appareil_min_comptes', 'Réutilisation d’appareil : nombre de comptes de travail distincts sur un même terminal', 2, 'comptes', { min: 2, max: 50 }),
  R('enquete.hors_zone_fenetre_jours', 'Constats hors zone : fenêtre d’analyse', 90, 'jours', { min: 1, max: 365 }),
  R('enquete.hors_zone_min', 'Constats hors zone ou à distance du point enregistré, par agent, dans la fenêtre', 3, 'constats', { min: 1, max: 1000 }),
  R('enquete.annulations_fenetre_jours', 'Annulations et exonérations : fenêtre d’analyse', 30, 'jours', { min: 1, max: 365 }),
  R('enquete.annulations_min', 'Annulations de quittance, exonérations, remises ou réductions accordées par une même personne dans la fenêtre', 5, 'actes', { min: 1, max: 10_000 }),
  R('enquete.quittance_echecs_min', 'Vérifications infructueuses d’un même code de quittance (24 h) : quittance manipulée présumée', 3, 'vérifications', { min: 1, max: 1000 }),
  R('enquete.suspension_max_jours', 'Suspension conservatoire d’un accès technique : durée maximale', 15, 'jours', { min: 1, max: 90 },
    'Mesure conservatoire, non disciplinaire, levée à tout moment par une personne ; au-delà, nouvelle décision motivée.'),
];

export function enqueteParam(ctx: { ext: Record<string, unknown> }, id: string): number {
  const gov = ctx.ext['integrite-gouvernance'] as { value?: (id: string) => ParamValue } | undefined;
  try { const v = gov?.value?.(id); if (typeof v === 'number') return v; } catch { /* défaut ci-dessous */ }
  const d = PARAMETRES_ENQUETES.find((p) => p.id === id);
  if (!d) throw new Error(`Paramètre inconnu : ${id}`);
  return Number(d.value);
}
