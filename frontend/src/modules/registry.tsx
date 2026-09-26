/**
 * Écrans des modules d'extension (verticales, fonctions transverses). Chaque entrée ajoute une route et,
 * si `nav` est fourni, une entrée de menu visible des rôles indiqués. Libellés en français (langue de référence).
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

export interface ModuleRoute {
  path: string;
  element: LazyExoticComponent<ComponentType>;
  /** Entrée de menu (facultative). */
  nav?: { label: string; short?: string; icon: string; group: 'public' | 'pilotage' | 'operations'; roles: string[] };
}

export const MODULE_ROUTES: ModuleRoute[] = [];

// Évite l'avertissement « import inutilisé » tant qu'aucun module n'est déclaré.
export const lazyModule = lazy;
