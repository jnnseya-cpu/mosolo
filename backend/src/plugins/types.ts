/**
 * Modules d'extension (verticales et fonctions transverses) : chaque module apporte son service, ses routes
 * et ses données de démonstration sans modifier le socle. Il réutilise les services communs (compte unique,
 * registre des règles, liquidation, paiement vers le compte public, quittance, audit, communications) :
 * aucune verticale n'a son propre compte contribuable, ses propres règles ni son propre circuit de paiement (§ 11.3).
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export interface MosoloPlugin<S = unknown> {
  /** Clé du service dans `ctx.ext`. */
  name: string;
  /** Construit le service (appelé après le socle, dans l'ordre de la liste). */
  create(ctx: AppContext): S;
  /** Données de démonstration (après le socle semé) — toujours marquées démonstration / non opposables. */
  seed?(ctx: AppContext, service: S): void;
  /** Routes HTTP du module. */
  routes?(app: FastifyInstance, ctx: AppContext, service: S): void;
}

export function definePlugin<S>(p: MosoloPlugin<S>): MosoloPlugin<S> {
  return p;
}

/** Accès typé au service d'un autre module (erreur explicite s'il n'est pas chargé). */
export function ext<S>(ctx: AppContext, name: string): S {
  const s = ctx.ext[name];
  if (s === undefined) throw new Error(`Module d'extension non chargé : ${name}`);
  return s as S;
}
