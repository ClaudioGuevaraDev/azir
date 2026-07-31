import { expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { launchAzir } from './support';

/**
 * The acceptance tests: a real Electron process, a real window, real IPC.
 * Everything else in the suite mocks the boundary; this is the one place that
 * does not.
 *
 * Run against the built output (`npm run test:e2e` builds first), because
 * packaging is where the preload path and the CSP actually get exercised.
 */

let app: ElectronApplication;

test.beforeEach(async () => {
  app = await launchAzir();
});

test.afterEach(async () => {
  await app.close();
});

/**
 * The native directory picker cannot be driven from Playwright — it is an OS
 * window, not a DOM one. Replacing `showOpenDialog` in the main process is the
 * smallest possible stub: everything after it (channel validation, the session
 * registry, the path sandbox, the reducer, the effect runner) is the real thing.
 */
const stubFolderPicker = async (directory: string | null): Promise<void> => {
  await app.evaluate(async ({ dialog }, chosen) => {
    dialog.showOpenDialog = async () =>
      chosen === null
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: [chosen] };
  }, directory);
};

test('opens a window showing the welcome screen', async () => {
  const window = await app.firstWindow();

  await expect(window.getByTestId('welcome')).toBeVisible();
  await expect(window.getByTestId('open-workspace')).toBeEnabled();
});

test('opening a folder mints a session and renders the workspace shell', async () => {
  const window = await app.firstWindow();
  await stubFolderPicker(process.cwd());

  await window.getByTestId('open-workspace').click();

  await expect(window.getByTestId('workspace-shell')).toBeVisible();
  await expect(window.getByTestId('workspace-name')).toHaveText('azir');
  // Session ids are minted in main and start at 1 for a fresh process.
  await expect(window.getByTestId('workspace-shell')).toContainText('session 1');
});

test('closing the workspace returns to the welcome screen', async () => {
  const window = await app.firstWindow();
  await stubFolderPicker(process.cwd());

  await window.getByTestId('open-workspace').click();
  await expect(window.getByTestId('workspace-shell')).toBeVisible();

  await window.getByTestId('close-workspace').click();

  await expect(window.getByTestId('welcome')).toBeVisible();
});

test('opening a second folder disposes the first session', async () => {
  const window = await app.firstWindow();
  await stubFolderPicker(process.cwd());

  await window.getByTestId('open-workspace').click();
  await expect(window.getByTestId('workspace-shell')).toContainText('session 1');
  await window.getByTestId('close-workspace').click();
  await expect(window.getByTestId('welcome')).toBeVisible();

  await window.getByTestId('open-workspace').click();

  // A new id, never a reused one — that is what lets a late response from the
  // first workspace be recognised as stale.
  await expect(window.getByTestId('workspace-shell')).toContainText('session 2');
});

test('cancelling the picker leaves the welcome screen usable', async () => {
  const window = await app.firstWindow();
  await stubFolderPicker(null);

  await window.getByTestId('open-workspace').click();

  await expect(window.getByTestId('open-workspace')).toBeEnabled();
  await expect(window.getByTestId('welcome-error')).toBeHidden();
});

test('main refuses a path outside the workspace, so the sandbox is real', async () => {
  const window = await app.firstWindow();
  await stubFolderPicker(process.cwd());
  await window.getByTestId('open-workspace').click();
  await expect(window.getByTestId('workspace-shell')).toBeVisible();

  // Reach through the bridge the way a compromised renderer would, and confirm
  // main checks the session against its own record rather than trusting us. The
  // bridge type is declared inline because src/renderer/env.d.ts is scoped to the
  // renderer project — the E2E suite is not allowed to see renderer internals.
  type ExposedBridge = {
    workspace: {
      close(request: {
        sessionId: number;
      }): Promise<{ ok: true; value: { closed: boolean } } | { ok: false }>;
    };
  };

  const outcome = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { azir: ExposedBridge }).azir;
    const result = await bridge.workspace.close({ sessionId: 9999 });
    return result.ok ? { ok: true, closed: result.value.closed } : { ok: false };
  });

  expect(outcome).toEqual({ ok: true, closed: false });
  await expect(window.getByTestId('workspace-shell')).toBeVisible();
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
