import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const r = (...segments: string[]): string => resolve(__dirname, ...segments);

const alias = {
  '@shared': r('src/shared'),
  '@main': r('src/main'),
  '@renderer': r('src/renderer'),
};

export default defineConfig({
  test: {
    // Two environments, because the boundary matters in tests too: main and
    // shared code must keep passing without a DOM, and renderer code must keep
    // passing without Node.
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/main/**/*.test.ts', 'src/shared/**/*.test.ts'],
        },
      },
      {
        resolve: { alias },
        test: {
          // Cross-cutting tests that assert on the project itself (lint rules,
          // config invariants) rather than on a single process's code.
          name: 'architecture',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.ts', 'src/renderer/**/*.test.tsx'],
          setupFiles: [r('src/renderer/test/setup.ts')],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/**/__fixtures__/**', 'src/renderer/test/**'],
    },
  },
});
