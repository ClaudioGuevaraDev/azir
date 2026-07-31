import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

/**
 * Settings, against a real settings file and a real restart.
 *
 * The parser and the store are unit tested, which covers the fallback rules and the write
 * scheduling. What only a full launch can show is the thing the feature actually promises: that a
 * choice made in the overlay is still there the next time the application starts. That claim
 * spans a debounce, an atomic write, a process exit and a fresh load, and every one of those is a
 * place it could quietly fail.
 *
 * These specs launch Electron directly rather than through `launchAzir`, because they need to
 * *keep* a user-data directory across two launches — which is exactly what that helper randomises
 * away.
 */

let app: ElectronApplication | undefined;
const scratchDirs: string[] = [];

const makeUserData = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'azir-settings-'));
  scratchDirs.push(dir);
  return dir;
};

const makeWorkspace = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'azir-set-ws-'));
  scratchDirs.push(root);
  writeFileSync(path.join(root, 'notes.txt'), 'alpha\nbravo\n');
  return root;
};

const launch = async (userDataDir: string): Promise<ElectronApplication> =>
  electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`] });

const settingsFile = (userDataDir: string): string => path.join(userDataDir, 'settings.json');

/**
 * Opens a workspace and then the settings overlay.
 *
 * The workspace is not incidental: overlays and the reserved shortcuts both live inside the
 * workspace shell, so there is no settings overlay on the welcome screen. That is the
 * application's design — docs/architecture.md describes overlays as things drawn over the
 * workspace that "preserve the focused panel underneath" — and not a detour these tests take.
 */
const openSettings = async (running: ElectronApplication, window: Page): Promise<void> => {
  await window.getByTestId('welcome').waitFor();
  await running.evaluate(async ({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, makeWorkspace());
  await window.getByTestId('open-workspace').click();
  await expect(window.getByTestId('workspace-shell')).toBeVisible();

  await window.keyboard.press('Control+Comma');
  await expect(window.getByTestId('overlay')).toHaveAttribute('data-overlay', 'settings');
};

test.afterEach(async () => {
  try {
    await app?.close();
  } catch {
    // Already gone; some tests close it themselves.
  }
  app = undefined;
  for (const dir of scratchDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // The OS cleans temp.
    }
  }
});

test('a setting chosen in the overlay is still set after a restart', async () => {
  const userDataDir = makeUserData();

  app = await launch(userDataDir);
  let window = await app.firstWindow();
  await openSettings(app, window);
  await window.getByTestId('setting-arrangement-rows').click();
  await window.getByTestId('setting-tab-width-8').click();
  await expect(window.getByTestId('setting-tab-width-8')).toHaveAttribute('data-active', 'true');
  // Closed rather than killed, so the pending write goes through `before-quit`.
  await app.close();

  app = await launch(userDataDir);
  window = await app.firstWindow();
  await openSettings(app, window);

  // The whole feature, in two assertions.
  await expect(window.getByTestId('setting-arrangement-rows')).toHaveAttribute(
    'data-active',
    'true',
  );
  await expect(window.getByTestId('setting-tab-width-8')).toHaveAttribute('data-active', 'true');
});

test('a change made moments before quitting is not lost to the debounce', async () => {
  /*
   * The failure this exists for: writes are debounced, quitting is immediate, and the setting the
   * user changed last — the one they most recently cared about — is the one inside the window.
   * `before-quit` flushes synchronously; if it ever stops doing so, this is what notices.
   */
  const userDataDir = makeUserData();

  app = await launch(userDataDir);
  const window = await app.firstWindow();
  await openSettings(app, window);
  await window.getByTestId('setting-font-size-18').click();
  // No wait at all: straight from the click to the quit.
  await app.close();
  app = undefined;

  const written = JSON.parse(readFileSync(settingsFile(userDataDir), 'utf8')) as {
    appearance: { codeFontSize: number };
  };
  expect(written.appearance.codeFontSize).toBe(18);
});

test('a hand-edited settings file is honoured at startup', async () => {
  const userDataDir = makeUserData();
  writeFileSync(
    settingsFile(userDataDir),
    JSON.stringify({ layout: { arrangement: 'columns' }, terminal: { shell: 'cmd' } }),
  );

  app = await launch(userDataDir);
  const window = await app.firstWindow();
  await openSettings(app, window);

  await expect(window.getByTestId('setting-arrangement-columns')).toHaveAttribute(
    'data-active',
    'true',
  );
  await expect(window.getByTestId('setting-shell-cmd')).toHaveAttribute('data-active', 'true');
});

test('a malformed field is reset and named, and the fields beside it survive', async () => {
  const userDataDir = makeUserData();
  writeFileSync(
    settingsFile(userDataDir),
    JSON.stringify({
      layout: { arrangement: 'diagonal' },
      editor: { tabWidth: 8 },
    }),
  );

  app = await launch(userDataDir);
  const window = await app.firstWindow();
  await openSettings(app, window);

  // Reset, because `diagonal` is not an arrangement.
  await expect(window.getByTestId('setting-arrangement-sidebar-and-stack')).toHaveAttribute(
    'data-active',
    'true',
  );
  // Kept, because it is perfectly valid and lives in a different group. This is the per-field
  // fallback the spec asks for, end to end.
  await expect(window.getByTestId('setting-tab-width-8')).toHaveAttribute('data-active', 'true');
  // And the user is told, rather than left wondering why their edit did nothing.
  await expect(window.getByTestId('settings-invalid')).toContainText('layout.arrangement');
});

test('a settings file that is not JSON leaves the application fully usable', async () => {
  const userDataDir = makeUserData();
  // What a crash during a non-atomic write leaves behind.
  writeFileSync(settingsFile(userDataDir), '{ "editor": { "tabWid');

  app = await launch(userDataDir);
  const window = await app.firstWindow();

  // Invariant 13: the spec lists "settings file malformed" as an expected failure. The window
  // opens, the defaults apply, and the user can still work.
  await expect(window.getByTestId('welcome')).toBeVisible();
  await openSettings(app, window);
  await expect(window.getByTestId('settings-invalid')).toBeVisible();
});

test('the shell setting decides which shell a new pane starts', async () => {
  test.skip(process.platform !== 'win32', 'the alternative shell asserted here is Windows-only');

  const userDataDir = makeUserData();
  writeFileSync(settingsFile(userDataDir), JSON.stringify({ terminal: { shell: 'cmd' } }));

  app = await launch(userDataDir);
  const window = await app.firstWindow();
  await window.getByTestId('welcome').waitFor();
  await app.evaluate(async ({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, makeWorkspace());
  await window.getByTestId('open-workspace').click();
  await expect(window.getByTestId('workspace-shell')).toBeVisible();

  // The pane title is the executable main actually started, so this asserts the setting reached
  // `resolveShell` — and it went there without the renderer ever naming a shell, because the
  // create request no longer has that field.
  await expect(window.getByTestId('terminal-tab-p1')).toContainText('cmd', { timeout: 20_000 });
});

test('the code font size setting changes the rendered code', async () => {
  const userDataDir = makeUserData();
  writeFileSync(settingsFile(userDataDir), JSON.stringify({ appearance: { codeFontSize: 20 } }));

  app = await launch(userDataDir);
  const window = await app.firstWindow();
  await window.getByTestId('welcome').waitFor();
  await app.evaluate(async ({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, makeWorkspace());
  await window.getByTestId('open-workspace').click();
  await window.getByTestId('tree-row-notes.txt').click();
  await expect(window.getByTestId('code-view')).toContainText('alpha');

  const measured = await window.evaluate(() => {
    const line = document.querySelector('.code__line');
    const root = getComputedStyle(document.documentElement);
    return {
      fontSize: root.getPropertyValue('--azir-code-font-size').trim(),
      rowHeight: line ? Math.round(line.getBoundingClientRect().height) : 0,
    };
  });

  expect(measured.fontSize).toBe('20px');
  // 20 × 1.5, and the *rendered* row height rather than the variable: the virtualiser positions
  // rows from the same number, so this failing would mean the stylesheet and the windowing
  // arithmetic had drifted apart.
  expect(measured.rowHeight).toBe(30);
});

test('a settings write does not reach into the workspace', async () => {
  const userDataDir = makeUserData();
  const workspace = makeWorkspace();

  app = await launch(userDataDir);
  const window = await app.firstWindow();
  await window.getByTestId('welcome').waitFor();
  await app.evaluate(async ({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, workspace);
  await window.getByTestId('open-workspace').click();
  await expect(window.getByTestId('workspace-shell')).toBeVisible();

  await window.keyboard.press('Control+Comma');
  await window.getByTestId('setting-tab-width-4').click();
  await app.close();
  app = undefined;

  // Preferences about Azir belong in userData, not in the folder under review. Writing them into
  // a repository would put them in someone's diff.
  expect(readFileSync(settingsFile(userDataDir), 'utf8')).toContain('tabWidth');
  expect(() => readFileSync(path.join(workspace, 'settings.json'), 'utf8')).toThrow();
});
