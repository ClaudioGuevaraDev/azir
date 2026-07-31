import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// React Testing Library only auto-registers its cleanup when Vitest runs with
// globals enabled. We run without them (explicit imports keep the boundary between
// test and source obvious), so unmounting has to be wired up by hand — otherwise
// every render leaks into the next test's document and queries that expect one
// match start finding several.
afterEach(() => {
  cleanup();
});

/*
 * Browser APIs jsdom does not implement, which xterm.js requires.
 *
 * These are gaps in the test environment, not shims for missing behaviour in the
 * application: Electron's renderer is Chromium and has all of them. Nothing here
 * is asserted against — the terminal's real rendering is covered by the Playwright
 * suite, which runs against an actual browser engine.
 */

if (typeof window.matchMedia !== 'function') {
  // xterm reads device-pixel-ratio changes through this to keep the canvas crisp.
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

if (typeof globalThis.ResizeObserver !== 'function') {
  // Reports zero observations, which is correct for jsdom: nothing has a layout.
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}
