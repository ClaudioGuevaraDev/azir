import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * The renderer must never touch Node or Electron directly (docs/architecture.md
 * rule 4 of "Process model", invariant 4). The type layer already denies it —
 * tsconfig.renderer.json omits `types: ["node"]` — but a bare
 * `import('child_process')` inside a dynamic call or a `require` shim can slip
 * past that. This list is the second, explicit gate, and
 * src/renderer/app/__tests__/boundaries.test.ts asserts it actually fires.
 */
const NODE_BUILTINS = [
  'fs',
  'fs/promises',
  'path',
  'child_process',
  'os',
  'net',
  'http',
  'https',
  'crypto',
  'worker_threads',
  'module',
  'vm',
];

const rendererForbidden = [
  ...NODE_BUILTINS,
  ...NODE_BUILTINS.map((name) => `node:${name}`),
  'electron',
  'node-pty',
  'chokidar',
];

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'release/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },

  // ---- Main process: full Node access, no DOM.
  {
    files: ['src/main/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // ---- Preload: bridges the two. May use electron, must not pull in services.
  {
    files: ['src/preload/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...NODE_BUILTINS.flatMap((name) => [
              {
                name,
                message:
                  'The preload runs with sandbox:true and cannot require Node builtins. Move this to src/main and expose it over IPC.',
              },
              {
                name: `node:${name}`,
                message:
                  'The preload runs with sandbox:true and cannot require Node builtins. Move this to src/main and expose it over IPC.',
              },
            ]),
          ],
          patterns: [
            {
              group: ['@main/*', '../main/*', '**/src/main/**'],
              message:
                'The preload must not import main-process code. Share types through @shared instead.',
            },
          ],
        },
      ],
    },
  },

  // ---- Renderer: browser only. This block is the architectural boundary.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          paths: rendererForbidden.map((name) => ({
            name,
            message:
              'The renderer is untrusted relative to the OS and must not access Node or Electron. Describe the work as an Effect and let the main process perform it.',
          })),
          patterns: [
            {
              group: ['@main/*', '../main/*', '**/src/main/**'],
              message:
                'The renderer must not import main-process code. Go through the preload bridge (@shared/ipc).',
            },
          ],
        },
      ],
    },
  },

  // ---- Shared: types and pure helpers only. No runtime deps beyond zod.
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...rendererForbidden].map((name) => ({
            name,
            message:
              'src/shared is compiled into all three processes, so it must stay free of environment-specific imports. zod is the only permitted runtime dependency.',
          })),
          patterns: [
            {
              group: ['@main/*', '@renderer/*', '**/src/main/**', '**/src/renderer/**'],
              message:
                'src/shared must not depend on any process-specific code — that would invert the dependency direction.',
            },
          ],
        },
      ],
    },
  },

  // ---- Tooling, E2E and architecture tests: Node, and allowed to reach for
  //      Electron and Playwright directly.
  {
    files: ['*.config.ts', '*.config.mjs', 'e2e/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  prettier,
);
