/**
 * ESLint flat config (task `P1-REPO-03`).
 *
 * Layers, in order — later layers win:
 * 1. global ignores and the JS baseline (`@eslint/js` recommended);
 * 2. TypeScript for every `.ts` (type-checked, via the project service);
 * 3. Vue SFCs (non-type-checked until `vue-tsc` lands in `P1-WEB-01` — see the note below);
 * 4. Node context for scripts, browser context for the SPA;
 * 5. project rules that encode the engineering laws (`docs/10-laws.md`);
 * 6. `eslint-config-prettier` last, so formatting is owned by Prettier alone.
 *
 * The `.vue` exemption from type-aware rules is deliberate: type-aware linting needs a TS project
 * that includes the SFC, and `apps/web/tsconfig.json` does not include `.vue` yet (plain `tsc` would
 * ignore them, so it waits for `vue-tsc`). Syntax, correctness and Vue-specific rules still apply.
 *
 * @module eslint.config
 */

import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import pluginVue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import vueParser from 'vue-eslint-parser';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      'data/**',
      'backups/**',
      // Generated or vendored content that we never author by hand:
      'bun.lock',
      'docs/**',
    ],
  },

  js.configs.recommended,

  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // The project service lets each file resolve its own tsconfig, so `scripts/` (root project)
        // and the workspaces can coexist without a hand-maintained `project` array.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `docs/09-development.md` §9: no floating promises, no silent casts on untrusted data.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // ENG-2: no `any` in public surfaces. Allow it only when explicitly annotated with a reason.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // L9: secrets must never be logged; this catches the obvious interpolation mistakes.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'no-implicit-coercion': 'error',
      'prefer-const': 'error',
      'object-shorthand': ['error', 'always'],
    },
  },

  ...pluginVue.configs['flat/recommended'].map((config) => ({
    ...config,
    files: ['**/*.vue'],
  })),

  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        // Inside `<script lang="ts">`, delegate to the TypeScript parser.
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      'vue/multi-word-component-names': 'error',
      'vue/no-v-html': 'error', // D-13: no unsafe HTML rendering, ever
      'vue/component-api-style': ['error', ['script-setup']],
      'vue/define-emits-declaration': ['error', 'type-based'],
      'vue/define-props-declaration': ['error', 'type-based'],
      'vue/no-unused-refs': 'error',
      'vue/require-explicit-emits': 'error',
      'vue/no-template-shadow': 'error',
    },
  },

  {
    files: ['scripts/**/*.ts', 'apps/api/src/**/*.ts', '**/*.config.{js,ts}'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // CLI entry points and the API logger exist to print; the rule above stays for library code.
      'no-console': 'off',
    },
  },

  {
    files: ['apps/web/src/**/*.{ts,vue}'],
    languageOptions: { globals: { ...globals.browser } },
  },

  {
    // Config files and scripts are tooling, not shipped code.
    files: ['**/*.config.{js,ts}', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  eslintConfigPrettier,
);
