import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchAzir, expectPrompt } from './support';

/**
 * The terminal against a real shell.
 *
 * Everything in src/main/terminal is unit tested with a fake PTY, which covers the
 * bookkeeping but proves nothing about ConPTY, the Node-API prebuilt binary, or
 * whether keystrokes actually reach a shell. That is what this file is for.
 */

let app: ElectronApplication;
const scratchDirs: string[] = [];

/**
 * A small throwaway workspace.
 *
 * Not the azir repository, even though these tests do not read the tree: opening a workspace starts
 * a filesystem watcher, and the live repo contains `release/` — an unpacked Electron distribution —
 * plus `test-results/`, which Playwright writes to while the suite runs. Nine such watchers per run
 * was enough churn to take the worker down.
 */
const makeWorkspace = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'azir-term-'));
  scratchDirs.push(root);
  writeFileSync(path.join(root, 'readme.txt'), 'hello\n');
  return root;
};

const stubFolderPicker = async (directory: string): Promise<void> => {
  await app.evaluate(async ({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, directory);
};

const openWorkspace = async (): Promise<Page> => {
  const window = await app.firstWindow();
  await window.getByTestId('welcome').waitFor();
  await stubFolderPicker(makeWorkspace());
  await window.getByTestId('open-workspace').click();
  await expect(window.getByTestId('workspace-shell')).toBeVisible();
  return window;
};

/** PIDs of the shell Azir starts by default on this platform. */
const shellPids = (): Set<string> => {
  if (process.platform !== 'win32') {
    return new Set();
  }
  const output = execFileSync(
    'tasklist',
    ['/FI', 'IMAGENAME eq powershell.exe', '/NH', '/FO', 'CSV'],
    {
      encoding: 'utf8',
    },
  );
  const pids = new Set<string>();
  for (const line of output.split('\n')) {
    const match = /^"powershell\.exe","(\d+)"/.exec(line.trim());
    if (match?.[1] !== undefined) {
      pids.add(match[1]);
    }
  }
  return pids;
};

test.beforeEach(async () => {
  app = await launchAzir();
});

test.afterEach(async () => {
  try {
    await app.close();
  } catch {
    // Already gone; one test closes the app itself.
  }
  for (const dir of scratchDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // The autostarted shell may still hold it; the OS cleans temp.
    }
  }
});

test('a workspace autostarts one terminal', async () => {
  const window = await openWorkspace();

  await expect(window.getByTestId('terminal-panel')).toBeVisible();
  await expect(window.getByTestId('terminal-tab-p1')).toBeVisible();
  // The reducer marks it `starting`; main answering with the resolved shell is what
  // moves it to `running`.
  await expect(window.getByTestId('terminal-tab-p1')).toHaveAttribute('data-lifecycle', 'running');
});

test('the shell echoes a command typed into the pane', async () => {
  const window = await openWorkspace();
  const pane = window.getByTestId('terminal-pane-p1');
  await expect(pane).toBeVisible();

  // Wait for the prompt, so the command is not typed into a shell that is still
  // starting up and would swallow it.
  await expectPrompt(window, 'p1');

  await pane.click();
  await window.keyboard.type('echo AZIR_E2E_OK');
  await window.keyboard.press('Enter');

  // Proves the whole path: xterm onData → bridge → ipcMain → node-pty → ConPTY →
  // shell → back through the output pump → the registry side channel → xterm.
  await expect(pane).toContainText('AZIR_E2E_OK', { timeout: 20_000 });
});

test('a second pane runs concurrently and hidden panes stay alive', async () => {
  const window = await openWorkspace();
  const first = window.getByTestId('terminal-pane-p1');
  await expectPrompt(window, 'p1');

  await first.click();
  await window.keyboard.type('echo FIRST_PANE');
  await window.keyboard.press('Enter');
  await expect(first).toContainText('FIRST_PANE', { timeout: 20_000 });

  await window.getByTestId('terminal-add').click();
  const second = window.getByTestId('terminal-pane-p2');
  await expect(second).toBeVisible();
  await expectPrompt(window, 'p2');

  // The first pane is now hidden, not unmounted — its scrollback must survive.
  await expect(first).toBeHidden();

  await window.getByTestId('terminal-tab-p1').getByRole('button').first().click();
  await expect(first).toBeVisible();
  await expect(first).toContainText('FIRST_PANE');
});

test('closing a pane removes it and leaves the other running', async () => {
  const window = await openWorkspace();
  await expectPrompt(window, 'p1');

  await window.getByTestId('terminal-add').click();
  await expectPrompt(window, 'p2');

  await window.getByTestId('terminal-close-p2').click();

  await expect(window.getByTestId('terminal-tab-p2')).toBeHidden();
  await expect(window.getByTestId('terminal-tab-p1')).toBeVisible();
  await expect(window.getByTestId('terminal-pane-p1')).toBeVisible();
});

test('closing the workspace tears the terminals down', async () => {
  const window = await openWorkspace();
  await expectPrompt(window, 'p1');

  await window.getByTestId('close-workspace').click();

  await expect(window.getByTestId('welcome')).toBeVisible();
  await expect(window.getByTestId('terminal-panel')).toBeHidden();
});

test('a noisy command does not freeze the UI', async () => {
  const window = await openWorkspace();
  const pane = window.getByTestId('terminal-pane-p1');
  await expectPrompt(window, 'p1');

  await pane.click();
  // Thousands of lines through the output pump and the side channel.
  await window.keyboard.type('1..3000 | ForEach-Object { "line $_" }');
  await window.keyboard.press('Enter');

  await expect(pane).toContainText('line 3000', { timeout: 40_000 });

  // The chrome is still interactive, which is the actual claim behind performance
  // rules 1–2.
  await window.getByTestId('terminal-add').click();
  await expect(window.getByTestId('terminal-tab-p2')).toBeVisible();
});

test('Ctrl+C reaches the shell instead of being swallowed as an app shortcut', async () => {
  // docs/architecture.md reserves only a small documented set of shortcuts and
  // requires the terminal to keep Ctrl+C, Ctrl+D, Ctrl+R, Tab and the arrows. An
  // application accelerator that ate Ctrl+C would make the terminal unusable for
  // supervising anything long-running, which is the whole point of the tool.
  const window = await openWorkspace();
  const pane = window.getByTestId('terminal-pane-p1');
  await expectPrompt(window, 'p1');

  await pane.click();
  await window.keyboard.type('Start-Sleep -Seconds 120');
  await window.keyboard.press('Enter');
  // Give the shell time to actually start sleeping, so the interrupt has a target.
  await window.waitForTimeout(1500);

  await window.keyboard.press('Control+C');

  await window.keyboard.type('echo AFTER_INTERRUPT');
  await window.keyboard.press('Enter');

  // This is the whole assertion, and it is load-bearing: a shell still sleeping
  // would not run the next command for another two minutes, so the 20s budget can
  // only be met if the interrupt actually reached it. (Checking that "Start-Sleep"
  // appears on screen would prove nothing — it is there because we typed it.)
  await expect(pane).toContainText('AFTER_INTERRUPT', { timeout: 20_000 });
});

test('arrow-up recalls the previous command from shell history', async () => {
  const window = await openWorkspace();
  const pane = window.getByTestId('terminal-pane-p1');
  await expectPrompt(window, 'p1');

  await pane.click();
  await window.keyboard.type('echo HISTORY_MARKER');
  await window.keyboard.press('Enter');
  await expect(pane).toContainText('HISTORY_MARKER', { timeout: 20_000 });

  // The shell owns history, not Azir — so this passing means the arrow key was
  // translated to an escape sequence and forwarded rather than intercepted.
  await window.keyboard.press('ArrowUp');
  await window.keyboard.press('Enter');

  await expect
    .poll(
      async () => {
        const text = (await pane.textContent()) ?? '';
        return text.split('HISTORY_MARKER').length - 1;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(3);
});

test('quitting leaves no orphan shells', async () => {
  test.skip(process.platform !== 'win32', 'process enumeration is implemented for Windows only');

  const before = shellPids();

  const window = await openWorkspace();
  await expectPrompt(window, 'p1');
  await window.getByTestId('terminal-add').click();
  await expectPrompt(window, 'p2');

  await app.close();

  // An orphan PTY is invisible until someone opens Task Manager, which is exactly
  // why it is asserted rather than assumed.
  await expect
    .poll(() => [...shellPids()].filter((pid) => !before.has(pid)).length, { timeout: 15_000 })
    .toBe(0);

  // Re-opened so the shared afterEach has something to close.
  app = await launchAzir();
});
