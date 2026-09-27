/**
 * Motif de consultation d'un dossier individuel (Document maître FR 2, ch. 42 : « Toute consultation d'un dossier
 * individuel est journalisée avec acteur, motif et horodatage »). L'acteur et l'horodatage sont portés par chaque
 * enregistrement d'audit ; le motif est celui déclaré par l'en-tête `x-motif-consultation` (texte, encodage URL
 * toléré) ou, à défaut, la finalité du rôle dans son périmètre — jamais un refus silencieux ni une donnée inventée.
 * La consultation motivée hors périmètre (« bris de glace », module accès) reste inchangée.
 */
import type { User } from './auth.js';

export const MOTIF_HEADER = 'x-motif-consultation';

export function motifConsultation(headers: Record<string, string | string[] | undefined>, user: User, titulaire: boolean): { motif: string; motifDeclare: boolean } {
  const raw = headers[MOTIF_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value === 'string' && value.trim()) {
    let text = value.trim();
    try { text = decodeURIComponent(text); } catch { /* texte brut conservé */ }
    return { motif: text.slice(0, 300), motifDeclare: true };
  }
  if (titulaire) return { motif: 'Consultation par le titulaire du dossier (ou son mandataire)', motifDeclare: false };
  return { motif: `Finalité du rôle (${user.roles.join(', ')}) dans son périmètre — aucun motif particulier déclaré`, motifDeclare: false };
}
