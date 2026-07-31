import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

/**
 * Layout, focus, overlays and the reserved shortcut set, in a real window.
 *
 * The layout engine is exhaustively unit tested as a pure function; what only a real window
 * can show is that the rectangles reach the DOM, that a resize drives them, and — most
 * importantly — that the shortcut router does not steal keys from the shell.
 */

let app: ElectronApplication;
const scratchDirs: string[] = [];

const makeRepo = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'azir-chrome-'));
  scratchDirs.push(root);
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'pipe' });
  writeFileSync(path.join(root, 'readme.txt'), 'hello\n');
  return root;
};

const resize = async (width: number, height: number): Promise<void> => {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
    },
    { width, height },
  );
};

const openWorkspace = async (directory: string): Promise<Page> => {
  const window = await app.firstWindow();
  await window.getByTestId('welcome').waitFor();
  await app.evaluate(async ({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, directory);
  await window.getByTestId('open-workspace').click();
  await expect(window.getByTestId('workspace-shell')).toBeVisible();
  return window;
};

test.beforeEach(async () => {
  app = await electron.launch({ args: ['.'] });
  await resize(1400, 900);
});

test.afterEach(async () => {
  try {
    await app.close();
  } catch {
    // Already gone.
  }
  for (const dir of scratchDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // The autostarted shell may still hold it.
    }
  }
});

test('all three panels are placed at a comfortable size', async () => {
  const window = await openWorkspace(makeRepo());

  await expect(window.getByTestId('panel-repository')).toBeVisible();
  await expect(window.getByTestId('panel-viewer')).toBeVisible();
  await expect(window.getByTestId('panel-terminal')).toBeVisible();
  await expect(window.getByTestId('workspace-stage')).toHaveAttribute('data-degraded', 'false');
});

test('panels are positioned from the engine rather than by CSS flow', async () => {
  const window = await openWorkspace(makeRepo());
  await expect(window.getByTestId('panel-repository')).toBeVisible();

  const boxes = await window.evaluate(() =>
    ['repository', 'viewer', 'terminal'].map((panel) => {
      const element = document.querySelector(`[data-testid="panel-${panel}"]`);
      const rect = element?.getBoundingClientRect();
      return { panel, x: Math.round(rect?.x ?? -1), y: Math.round(rect?.y ?? -1) };
    }),
  );

  const repository = boxes.find((box) => box.panel === 'repository')!;
  const viewer = boxes.find((box) => box.panel === 'viewer')!;
  const terminal = boxes.find((box) => box.panel === 'terminal')!;

  // The default arrangement: sidebar on the left, viewer and terminal stacked beside it.
  expect(repository.x).toBeLessThan(viewer.x);
  expect(terminal.x).toBe(viewer.x);
  expect(terminal.y).toBeGreaterThan(viewer.y);
});

test('shrinking the window degrades to two panels and then to one', async () => {
  const window = await openWorkspace(makeRepo());
  // Columns need the most width, which makes the thresholds easy to cross.
  await window.getByTestId('open-settings').click();
  await window.getByTestId('setting-arrangement-columns').click();
  await window.getByTestId('overlay-close').click();
  await expect(window.getByTestId('workspace-stage')).toHaveAttribute('data-degraded', 'false');

  await resize(620, 700);
  await expect(window.getByTestId('workspace-stage')).toHaveAttribute('data-degraded', 'true');
  await expect(window.locator('.stage__slot')).toHaveCount(2);

  await resize(400, 700);
  await expect(window.locator('.stage__slot')).toHaveCount(1);

  // ...and back, without an exception anywhere along the way.
  await resize(1400, 900);
  await expect(window.locator('.stage__slot')).toHaveCount(3);
});

test('the focused panel is the one that survives degradation', async () => {
  const window = await openWorkspace(makeRepo());
  await window.getByTestId('open-settings').click();
  await window.getByTestId('setting-arrangement-columns').click();
  await window.getByTestId('overlay-close').click();

  // Focus the repository panel, then shrink past both thresholds.
  await window.keyboard.press('Control+Digit1');
  await expect(window.getByTestId('status-focus')).toHaveText('repository');

  await resize(400, 700);

  await expect(window.getByTestId('panel-repository')).toBeVisible();
  await expect(window.locator('.stage__slot')).toHaveCount(1);
});

test('Ctrl+1/2/3 move focus between panels', async () => {
  const window = await openWorkspace(makeRepo());

  await window.keyboard.press('Control+Digit1');
  await expect(window.getByTestId('status-focus')).toHaveText('repository');

  await window.keyboard.press('Control+Digit2');
  await expect(window.getByTestId('status-focus')).toHaveText('viewer');

  await window.keyboard.press('Control+Digit3');
  await expect(window.getByTestId('status-focus')).toHaveText('terminal');
});

test('the shortcuts follow the slot, not the panel name', async () => {
  const window = await openWorkspace(makeRepo());

  // Put the terminal in slot 1.
  await window.getByTestId('open-settings').click();
  await window.getByTestId('setting-slot-0-terminal').click();
  await window.getByTestId('overlay-close').click();

  await window.keyboard.press('Control+Digit1');

  await expect(window.getByTestId('status-focus')).toHaveText('terminal');
});

test('clicking a panel focuses it', async () => {
  const window = await openWorkspace(makeRepo());
  await expect(window.getByTestId('tree-row-readme.txt')).toBeVisible();

  await window.getByTestId('tree-row-readme.txt').click();

  await expect(window.getByTestId('status-focus')).toHaveText('repository');
});

test('F1 opens the shortcut reference and Escape closes it', async () => {
  const window = await openWorkspace(makeRepo());

  await window.keyboard.press('F1');

  await expect(window.getByTestId('overlay')).toHaveAttribute('data-overlay', 'help');
  // The documentation half of "a small, documented set".
  await expect(window.getByTestId('help-shortcuts')).toContainText('Ctrl+1');
  await expect(window.getByTestId('help-shortcuts')).toContainText('Ctrl+Shift+T');

  await window.keyboard.press('Escape');

  await expect(window.getByTestId('overlay')).toHaveCount(0);
});

test('an open overlay owns the keyboard', async () => {
  const window = await openWorkspace(makeRepo());
  await expect(window.getByTestId('terminal-tab-p1')).toBeVisible();

  await window.keyboard.press('F1');
  await expect(window.getByTestId('overlay')).toBeVisible();

  // Ctrl+Shift+T would normally add a pane; behind a modal it must do nothing.
  await window.keyboard.press('Control+Shift+KeyT');
  await expect(window.getByTestId('terminal-tab-p2')).toHaveCount(0);

  await window.keyboard.press('Escape');
  await window.keyboard.press('Control+Shift+KeyT');

  await expect(window.getByTestId('terminal-tab-p2')).toBeVisible();
});

test('changing the arrangement rearranges the panels', async () => {
  const window = await openWorkspace(makeRepo());

  await window.keyboard.press('Control+Comma');
  await expect(window.getByTestId('overlay')).toHaveAttribute('data-overlay', 'settings');

  await window.getByTestId('setting-arrangement-rows').click();
  await window.getByTestId('overlay-close').click();

  await expect(window.getByTestId('status-arrangement')).toHaveText('rows');

  const boxes = await window.evaluate(() =>
    ['repository', 'viewer', 'terminal'].map((panel) => {
      const rect = document
        .querySelector(`[data-testid="panel-${panel}"]`)
        ?.getBoundingClientRect();
      return { panel, x: Math.round(rect?.x ?? -1), y: Math.round(rect?.y ?? -1) };
    }),
  );

  // Three rows: same x, increasing y.
  expect(new Set(boxes.map((box) => box.x)).size).toBe(1);
  expect(boxes[0]!.y).toBeLessThan(boxes[1]!.y);
  expect(boxes[1]!.y).toBeLessThan(boxes[2]!.y);
});

test('reordering panels swaps them rather than losing one', async () => {
  const window = await openWorkspace(makeRepo());

  await window.getByTestId('open-settings').click();
  await window.getByTestId('setting-slot-0-viewer').click();
  await window.getByTestId('overlay-close').click();

  // All three still present: the order stays a permutation by construction.
  await expect(window.getByTestId('panel-repository')).toBeVisible();
  await expect(window.getByTestId('panel-viewer')).toBeVisible();
  await expect(window.getByTestId('panel-terminal')).toBeVisible();

  const positions = await window.evaluate(() =>
    ['repository', 'viewer'].map((panel) =>
      Math.round(
        document.querySelector(`[data-testid="panel-${panel}"]`)?.getBoundingClientRect().x ?? -1,
      ),
    ),
  );

  expect(positions[1]).toBeLessThan(positions[0]!);
});

test('the shortcut router does not steal keys from the shell', async () => {
  /*
   * The regression guard that matters most in this milestone. A capture-phase keydown
   * listener on `window` sits ahead of xterm's handler, so a router that matched too broadly
   * would silently break the terminal — and it would look like the shell's fault.
   */
  const window = await openWorkspace(makeRepo());
  const pane = window.getByTestId('terminal-pane-p1');
  await expect(pane).toContainText('>', { timeout: 20_000 });

  await pane.click();
  // Waiting for focus to land is not ceremony: clicking a panel now dispatches
  // `focus/changed`, and typing in the same tick races the re-render that follows.
  await expect(window.getByTestId('status-focus')).toHaveText('terminal');

  await window.keyboard.type('echo ROUTER_OK');
  await window.keyboard.press('Enter');
  await expect(pane).toContainText('ROUTER_OK', { timeout: 20_000 });

  // Ctrl+C on a long sleep.
  await window.keyboard.type('Start-Sleep -Seconds 120');
  await window.keyboard.press('Enter');
  await window.waitForTimeout(1500);
  await window.keyboard.press('Control+C');
  await window.keyboard.type('echo AFTER_INTERRUPT');
  await window.keyboard.press('Enter');
  await expect(pane).toContainText('AFTER_INTERRUPT', { timeout: 20_000 });

  // Arrow-up history still reaches the shell.
  await window.keyboard.press('ArrowUp');
  await window.keyboard.press('Enter');
  await expect
    .poll(async () => ((await pane.textContent()) ?? '').split('AFTER_INTERRUPT').length - 1, {
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(3);
});

test('Ctrl+Shift+W closes the active terminal pane', async () => {
  const window = await openWorkspace(makeRepo());
  await expect(window.getByTestId('terminal-tab-p1')).toBeVisible();

  await window.keyboard.press('Control+Shift+KeyT');
  await expect(window.getByTestId('terminal-tab-p2')).toBeVisible();

  await window.keyboard.press('Control+Shift+KeyW');

  await expect(window.getByTestId('terminal-tab-p2')).toHaveCount(0);
  await expect(window.getByTestId('terminal-tab-p1')).toBeVisible();
});
