import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

const r = (...segments: string[]): string => resolve(__dirname, ...segments);

/**
 * Content Security Policy, injected into index.html in place of `%CSP%`.
 *
 * Development and production genuinely need different policies: Vite's dev
 * server injects inline module scripts and opens a WebSocket for HMR, neither
 * of which production should permit. Shipping the dev policy would silently
 * widen the renderer's attack surface, so the two are written out separately
 * and the build picks one.
 *
 * `style-src 'unsafe-inline'` stays in both: xterm.js and React style
 * injection both write inline styles. Inline *styles* cannot execute code, so
 * this is the ordinary tradeoff — inline *scripts* remain blocked in
 * production.
 */
const CSP_PRODUCTION = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const CSP_DEVELOPMENT = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:* http://localhost:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const cspPlugin = (): Plugin => ({
  name: 'azir:csp',
  transformIndexHtml: {
    order: 'pre',
    handler(html, ctx) {
      const csp = ctx.server ? CSP_DEVELOPMENT : CSP_PRODUCTION;
      return html.replace('%CSP%', csp);
    },
  },
});

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': r('src/shared'),
        '@main': r('src/main'),
      },
    },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: r('src/main/index.ts') },
      },
    },
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': r('src/shared'),
      },
    },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: r('src/preload/index.ts') },
      },
    },
  },

  renderer: {
    root: r('src/renderer'),
    plugins: [react(), cspPlugin()],
    resolve: {
      alias: {
        '@shared': r('src/shared'),
        '@renderer': r('src/renderer'),
      },
    },
    build: {
      outDir: r('out/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: { index: r('src/renderer/index.html') },
      },
    },
  },
});
