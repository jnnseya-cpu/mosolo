/**
 * Tests du backend : le mode démonstration est désactivé par défaut (sûr en production) ; les tests l'activent
 * EXPLICITEMENT ici. Les tests « hors démonstration » le désactivent localement (MOSOLO_DEMO_MODE=false).
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { MOSOLO_DEMO_MODE: 'true' },
    // Plusieurs tests construisent l'application complète (tous les modules) : sous charge parallèle, un test de
    // quelques secondes peut dépasser le délai par défaut de 5 s sans aucun défaut fonctionnel.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
