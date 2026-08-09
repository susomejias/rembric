import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import importPlugin from 'eslint-plugin-import';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'examples/**',
      'example-design/**',
      'apps/server/scripts/**',
      'apps/plugin/*',
      '!apps/plugin/bin',
      'apps/plugin/*/**',
      '!apps/plugin/bin/**',
      '!apps/plugin/.*-plugin',
      '!apps/plugin/.*-plugin/*.ts',
      // Client test files stay out, as apps/plugin/test/'s do: nothing there
      // ships, and the projectService cannot resolve their vitest types.
      'apps/plugin/.*-plugin/*.test.ts',
      'plugin/**',
      'openspec/**',
      'apps/server/src/dashboard/public/**',
      'apps/landing/public/**',
      '**/*.d.ts',
      '**/*.d.mts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            'eslint.config.js',
            'commitlint.config.js',
            'apps/server/drizzle.config.ts',
            'apps/server/vitest.config.ts',
            'install.test.ts',
            'scripts/*.test.ts',
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      import: importPlugin,
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'import/order': [
        'error',
        {
          'newlines-between': 'always',
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  {
    // Root-level config files use the projectService default project; the
    // type-checked rule set doesn't have full type info for them after the
    // monorepo restructure (tsconfig.json moved to apps/server/). Disable
    // type-checked rules for these files.
    files: ['eslint.config.js', 'commitlint.config.js', 'install.test.ts', 'scripts/*.test.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Per-client plugin entrypoints, matched by shape so a new client is linted
    // the day it lands. Shipped TS that lives outside the TS projectService, so
    // the TS parser runs without type information.
    files: ['apps/plugin/.*-plugin/*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: { projectService: false },
    },
  },
  {
    // Shipped runtime bridges. They live outside the TS projectService, so
    // lint them with recommended (non-type-checked) rules only.
    files: ['apps/plugin/bin/**/*.mjs', 'apps/landing/build.mjs', 'scripts/*.mjs'],
    extends: [js.configs.recommended, tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        process: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
      parserOptions: { projectService: false },
    },
  },
  prettier,
);
