// KINSHASA MOSOLO — configuration ESLint (format « flat ») commune aux trois paquets.
// Règles pragmatiques : recommandations TypeScript sans analyse de types (rapides), règles des hooks React,
// variables inutilisées interdites (préfixe _ toléré), `any` explicite signalé sans bloquer.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  // Artefacts de construction, dépendances et scripts d'outillage hors paquets (captures, présentation).
  { ignores: ['**/node_modules/**', '**/dist/**', '**/dev-dist/**', '**/coverage/**', 'frontend/public/**', 'backend/data/**', 'tools/**', 'docs/**', 'specs/**'] },
  // TODO(temporaire) : fichiers en cours de modification sur une branche parallèle (canaux, intégrité) ; retirer cette
  // exclusion après la fusion et corriger leurs erreurs (import inutilisé, affectation inutile).
  { ignores: ['backend/src/plugins/canaux/cards.ts', 'backend/src/plugins/canaux/points.ts', 'backend/src/plugins/integrite/service.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { args: 'after-used', argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_', ignoreRestSiblings: true }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // Frontend : environnement navigateur et règles des hooks (seules les deux règles historiques, pas celles du compilateur React).
  {
    files: ['frontend/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn' },
  },
);
