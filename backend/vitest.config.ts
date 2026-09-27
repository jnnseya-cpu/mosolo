/**
 * Tests du backend : le mode démonstration est désactivé par défaut (sûr en production) ; les tests l'activent
 * EXPLICITEMENT ici. Les tests « hors démonstration » le désactivent localement (MOSOLO_DEMO_MODE=false).
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { MOSOLO_DEMO_MODE: 'true' },
    // Chaque test construit l'application complète (tous les modules semés) : sur une machine chargée (CI partagée,
    // plusieurs suites en parallèle), 5 s par défaut provoquaient des échecs intermittents sans défaut fonctionnel.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
