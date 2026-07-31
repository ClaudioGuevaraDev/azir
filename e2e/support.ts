import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

/**
 * Launches Azir with its own user-data directory.
 *
 * The isolation is not hygiene, it is correctness. Azir takes a single-instance lock, and every
 * launch that shares a user-data directory contends for the same one: if a previous test's Electron
 * has not finished exiting, the next one loses the lock, calls `app.quit()` before creating a
 * window, and Playwright waits for a window that will never arrive until the whole test times out.
 * The failure lands on whichever test happened to be next, which is what made it look like flake.
 */
const userDataDirs: string[] = [];

process.on('exit', () => {
  // Best effort, and deliberately at exit rather than per test: Electron writes to this directory
  // right up until the process is gone, so removing it earlier races the app's own shutdown.
  for (const dir of userDataDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // The OS cleans temp.
    }
  }
});

export const launchAzir = async (): Promise<ElectronApplication> => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'azir-userdata-'));
  userDataDirs.push(userDataDir);
  return electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`] });
};

/**
 * Shared helpers for reading the integrated terminal.
 *
 * These exist because of a bug the test suite had for two milestones: waiting for a shell prompt
 * with `expect(pane).toContainText('>')`. A locator's text includes the `<style>` element xterm.js
 * injects into the pane, and that stylesheet contains child selectors — so `'>'` matched the CSS
 * on the very first poll, every time, whether or not a shell had produced a single byte. The
 * assertion passed vacuously, and it hid a real regression in which the terminal came up
 * permanently blank.
 *
 * So terminal text is read from `.xterm-rows`, which holds only rendered cells.
 */

/** The visible contents of a terminal pane, excluding xterm's injected stylesheet. */
export const terminalText = (window: Page, paneId = 'p1'): Promise<string> =>
  window.evaluate((id) => {
    const rows = document.querySelector(`[data-testid="terminal-pane-${id}"] .xterm-rows`);
    return rows?.textContent ?? '';
  }, paneId);

/**
 * Waits for a shell prompt.
 *
 * `PS ` rather than `>`: it is what PowerShell actually prints, and it cannot be confused with
 * markup. The generic fallback covers a POSIX shell, where the suite is not verified but the
 * helper should still be honest about what it is looking for.
 */
export const expectPrompt = async (window: Page, paneId = 'p1'): Promise<void> => {
  await expect
    .poll(() => terminalText(window, paneId), { timeout: 25_000, intervals: [100] })
    .toMatch(/PS .*>|[$#] $/);
};

/** Waits for a marker the test told the shell to print. */
export const expectTerminalText = async (
  window: Page,
  needle: string,
  paneId = 'p1',
): Promise<void> => {
  await expect
    .poll(() => terminalText(window, paneId), { timeout: 25_000, intervals: [100] })
    .toContain(needle);
};
