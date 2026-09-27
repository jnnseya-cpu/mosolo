/**
 * Registre de conditionnement consulté par les autres modules : un point juridique est-il tranché ? une fonction
 * attend-elle une base légale ? Lecture seule, sans effet : les modules affichent ce qu'ils attendent et gardent
 * leurs propres verrous. Module « juridique » non chargé ⇒ tous les points sont OUVERTS (hypothèse prudente).
 */
import type { PointJuridiqueStatut } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import { FONCTIONS_CONDITIONNEES, POINTS_JURIDIQUES, type FonctionConditionnee } from './points.js';
import type { JuridiqueService } from './service.js';

function service(ctx: AppContext): JuridiqueService | undefined {
  return ctx.ext.juridique as JuridiqueService | undefined;
}

/** Statut d'un point (J1…J30) ; inconnu ou module absent ⇒ OUVERT. */
export function statutPointJuridique(ctx: AppContext, code: string): PointJuridiqueStatut {
  return service(ctx)?.statut(code) ?? 'OUVERT';
}

/** Vrai si le point juridique est tranché (acte enregistré et décision à deux personnes). */
export function pointJuridiqueTranche(ctx: AppContext, code: string): boolean {
  return statutPointJuridique(ctx, code) === 'TRANCHE';
}

/** État d'une fonction conditionnée (message « en attente de base légale » à afficher). */
export function etatFonction(ctx: AppContext, f: FonctionConditionnee): {
  code: FonctionConditionnee; label: string; enAttente: boolean; message: string; points: { code: string; statut: PointJuridiqueStatut; question: string }[];
} {
  const svc = service(ctx);
  if (svc) return svc.fonction(f);
  const def = FONCTIONS_CONDITIONNEES[f];
  const points = def.points.map((c) => ({ code: c, statut: 'OUVERT' as const, question: POINTS_JURIDIQUES.find((p) => p.code === c)?.question ?? c }));
  return { code: f, label: def.label, enAttente: true, points, message: `${def.attente} (${def.points.join(', ')}).` };
}

/**
 * Pour le moteur de recoupement (module « opportunités ») : l'ingestion de données partenaires (énergie, eau,
 * opérateurs) est-elle fondée ? Tant que J13 (et J8) ne sont pas tranchés : non — l'ingestion affiche ce qu'elle attend.
 */
export function recoupementDonneesAutorise(ctx: AppContext): { autorise: boolean; message: string; points: string[] } {
  const e = etatFonction(ctx, 'RECOUPEMENT_DONNEES');
  return { autorise: !e.enAttente, message: e.message, points: e.points.map((p) => p.code) };
}
