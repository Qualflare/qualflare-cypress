// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'test/integration/fixtures/**',
      // A standalone example project with its own package.json/dependency
      // resolution (imports '@qualflare/cypress' by its published name, not
      // a relative path) — not part of this repo's own TS project graph.
      'examples/**',
      'coverage/**',
      // Scratch state from an unrelated editor/session-memory tool, not part
      // of this package's source.
      '.remember/**',
      // Plain JS, not part of the TS project graph — no type-aware linting
      // needed for the flat config file itself.
      'eslint.config.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        // A dedicated tsconfig for linting: tsconfig.json's own `include`
        // deliberately covers only `src` (the published package), but
        // ESLint also needs to type-check test/*.ts and the root-level
        // *.config.ts files.
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  // Isomorphic boundary: the browser-side entry, browser/**, and shared/** must
  // never pull in Node-only modules (undici, node:fs, node:crypto, node:child_process,
  // ci-info) or the plugin/http code that depends on them — the browser entry gets
  // bundled into the spec/support code by Cypress's own preprocessor and must stay
  // Node-free. This is the primary enforcement mechanism for that boundary (tsconfig
  // deliberately keeps Node ambient types available everywhere for developer
  // convenience, so this ESLint rule — not the type checker — is what actually
  // catches a violation).
  {
    files: ['src/index.ts', 'src/browser/**/*.ts', 'src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/plugin/**', '**/plugin', '**/http/**', '**/http'],
              message:
                'Browser-side/shared code must not import from src/plugin/** or src/http/** — those pull in Node-only dependencies and must stay out of the Cypress spec/support bundle.',
            },
          ],
          paths: [
            {
              name: 'undici',
              message: 'undici is Node-only — do not import it from browser-side/shared code.',
            },
            {
              name: 'ci-info',
              message: 'ci-info is Node-only — do not import it from browser-side/shared code.',
            },
            {
              name: 'node:fs',
              message: 'node:fs is Node-only — do not import it from browser-side/shared code.',
            },
            {
              name: 'node:crypto',
              message: 'node:crypto is Node-only — do not import it from browser-side/shared code.',
            },
            {
              name: 'node:child_process',
              message:
                'node:child_process is Node-only — do not import it from browser-side/shared code.',
            },
          ],
        },
      ],
    },
  },
);
