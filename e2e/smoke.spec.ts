import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';

/**
 * The M0 acceptance test: a real Electron process, a real window, a real IPC
 * round trip. Everything else in the test suite mocks the boundary; this is the
 * one place that does not.
 *
 * Run against the built output (`npm run test:e2e` builds first), because
 * packaging is where the preload path and the CSP actually get exercised.
 */

let app: ElectronApplication;

test.beforeEach(async () => {
  app = await electron.launch({ args: ['.'] });
});

test.afterEach(async () => {
  await app.close();
});

test('opens a window whose typed bridge round-trips', async () => {
  const window = await app.firstWindow();

  const status = window.getByTestId('bridge-status');
  await expect(status).toHaveAttribute('data-state', 'ready');

  // The nonce check lives in App.tsx: reaching 'ready' means the value the
  // renderer minted came back from the main process unchanged.
  await expect(status).toContainText(process.platform);
});

test('exactly one window is opened', async () => {
  await app.firstWindow();

  const count = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

  expect(count).toBe(1);
});

test('the document carries a Content Security Policy', async () => {
  const window = await app.firstWindow();

  const csp = await window.evaluate(
    () =>
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute('content') ?? '',
  );

  // The placeholder must have been substituted by the azir:csp plugin, and the
  // policy must at minimum deny by default and forbid plugin content.
  expect(csp).not.toContain('%CSP%');
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("object-src 'none'");
});

/**
 * The declarative security settings are asserted in
 * src/main/windows/mainWindow.test.ts. This asserts the *effect* of them, which
 * is the part that would still be broken if a future Electron changed how a
 * preference behaves.
 */
test('the renderer has no route to Node', async () => {
  const window = await app.firstWindow();

  const exposure = await window.evaluate(() => ({
    require: typeof (globalThis as Record<string, unknown>)['require'],
    process: typeof (globalThis as Record<string, unknown>)['process'],
    module: typeof (globalThis as Record<string, unknown>)['module'],
    // The one thing that should be there.
    azir: typeof (globalThis as Record<string, unknown>)['azir'],
  }));

  expect(exposure.require).toBe('undefined');
  expect(exposure.process).toBe('undefined');
  expect(exposure.module).toBe('undefined');
  expect(exposure.azir).toBe('object');
});
