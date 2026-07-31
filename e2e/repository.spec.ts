import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

/**
 * The repository panel against a real filesystem.
 *
 * The unit tests cover ordering, ignoring and staleness with a fake `readdir`. What
 * they cannot cover is whether the session path sandbox, the lazy-loading round trip
 * and the virtualised list actually work together over IPC.
 */

let app: ElectronApplication;

const stubFolderPicker = async (directory: string): Promise<void> => {
  await app.evaluate(async ({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, directory);
};

const openWorkspace = async (directory: string): Promise<Page> => {
  const window = await app.firstWindow();
  await window.getByTestId('welcome').waitFor();
  await stubFolderPicker(directory);
  await window.getByTestId('open-workspace').click();
  await expect(window.getByTestId('workspace-shell')).toBeVisible();
  return window;
};

test.beforeEach(async () => {
  app = await electron.launch({ args: ['.'] });
});

test.afterEach(async () => {
  // Tolerant because one test closes the app itself, to release the handle its shell
  // holds on the scratch workspace before deleting it.
  try {
    await app.close();
  } catch {
    // Already gone.
  }
});

test('the tree lists the workspace root with directories first', async () => {
  const window = await openWorkspace(process.cwd());

  await expect(window.getByTestId('repository-panel')).toBeVisible();
  await expect(window.getByTestId('tree-row-src')).toBeVisible();
  await expect(window.getByTestId('tree-row-package.json')).toBeVisible();

  const names = await window.locator('.tree__row .tree__name').allTextContents();
  const firstFile = names.indexOf('package.json');
  const lastDirectory = Math.max(names.indexOf('src'), names.indexOf('e2e'), names.indexOf('docs'));
  expect(lastDirectory).toBeLessThan(firstFile);
});

test('node_modules and .git are absent, because the scanner and watcher share one ignore list', async () => {
  const window = await openWorkspace(process.cwd());
  await expect(window.getByTestId('tree-row-src')).toBeVisible();

  // Both exist on disk in this repo, so their absence is the filter working rather
  // than the directory simply not being there.
  await expect(window.getByTestId('tree-row-node_modules')).toHaveCount(0);
  await expect(window.getByTestId('tree-row-.git')).toHaveCount(0);
});

test('directories load lazily and only when expanded', async () => {
  const window = await openWorkspace(process.cwd());
  await expect(window.getByTestId('tree-row-src')).toBeVisible();

  // Nothing below the root has been read yet.
  await expect(window.getByTestId('tree-row-src/main')).toHaveCount(0);

  await window.getByTestId('tree-row-src').click();

  await expect(window.getByTestId('tree-row-src/main')).toBeVisible();
  await expect(window.getByTestId('tree-row-src/shared')).toBeVisible();
  // Still nothing two levels down.
  await expect(window.getByTestId('tree-row-src/main/ipc')).toHaveCount(0);

  await window.getByTestId('tree-row-src/main').click();
  await expect(window.getByTestId('tree-row-src/main/ipc')).toBeVisible();
});

test('collapsing hides children and reopening needs no reload', async () => {
  const window = await openWorkspace(process.cwd());
  await window.getByTestId('tree-row-src').click();
  await expect(window.getByTestId('tree-row-src/main')).toBeVisible();

  await window.getByTestId('tree-row-src').click();
  await expect(window.getByTestId('tree-row-src/main')).toHaveCount(0);

  await window.getByTestId('tree-row-src').click();
  // Children were kept, so this is immediate rather than a round trip.
  await expect(window.getByTestId('tree-row-src/main')).toBeVisible();
});

test('selection is keyed by path, so it survives a reload that rebuilds every row', async () => {
  const window = await openWorkspace(process.cwd());
  const row = window.getByTestId('tree-row-package.json');
  await expect(row).toBeVisible();

  await row.click();
  await expect(row).toHaveAttribute('data-selected', 'true');

  // A refresh replaces every FileNode and every row object. A selection held as a
  // row index would survive this by accident and break as soon as the listing
  // changed length; a selection held as a path survives it by construction.
  await window.getByTestId('repository-refresh').click();

  await expect(window.getByTestId('tree-row-package.json')).toHaveAttribute(
    'data-selected',
    'true',
  );
});

test('clicking a directory both selects and expands it', async () => {
  const window = await openWorkspace(process.cwd());

  await window.getByTestId('tree-row-src').click();

  await expect(window.getByTestId('tree-row-src')).toHaveAttribute('data-selected', 'true');
  await expect(window.getByTestId('tree-row-src/main')).toBeVisible();
});

test('a refresh picks up a file created outside the app', async () => {
  // The watcher lands in M5; until then the manual refresh is the only path, and the
  // spec requires it to keep working even when the watcher is unavailable.
  //
  // The scratch workspace lives in the OS temp directory, not in the repo: the
  // autostarted shell runs with the workspace as its cwd, so Windows holds a handle
  // on that folder for as long as Azir has it open. Cleanup therefore happens after
  // the app closes, and is best-effort.
  const scratch = mkdtempSync(path.join(tmpdir(), 'azir-e2e-'));
  writeFileSync(path.join(scratch, 'before.txt'), 'before');

  const window = await openWorkspace(scratch);
  await expect(window.getByTestId('tree-row-before.txt')).toBeVisible();

  writeFileSync(path.join(scratch, 'after.txt'), 'after');
  await expect(window.getByTestId('tree-row-after.txt')).toHaveCount(0);

  await window.getByTestId('repository-refresh').click();

  await expect(window.getByTestId('tree-row-after.txt')).toBeVisible();

  await app.close();
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // The OS still holds the directory; the temp dir gets cleaned by the system.
  }
});

test('main refuses to list a path outside the workspace', async () => {
  const window = await openWorkspace(process.cwd());
  await expect(window.getByTestId('tree-row-src')).toBeVisible();

  type ExposedBridge = {
    files: {
      listDirectory(request: {
        sessionId: number;
        path: string;
      }): Promise<{ ok: true } | { ok: false; error: { code: string } }>;
    };
  };

  // Reach through the bridge the way a compromised renderer would.
  const outcomes = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { azir: ExposedBridge }).azir;
    const attempts = ['../', '../../Windows', '/etc/passwd', 'C:\\Windows'];
    const results: Array<string | null> = [];
    for (const attempt of attempts) {
      const result = await bridge.files.listDirectory({ sessionId: 1, path: attempt });
      results.push(result.ok ? null : result.error.code);
    }
    return results;
  });

  expect(outcomes).toEqual([
    'path-outside-workspace',
    'path-outside-workspace',
    'path-outside-workspace',
    'path-outside-workspace',
  ]);
});

test('a listing for a dead session is refused before the path is even considered', async () => {
  const window = await openWorkspace(process.cwd());
  await expect(window.getByTestId('tree-row-src')).toBeVisible();

  type ExposedBridge = {
    files: {
      listDirectory(request: {
        sessionId: number;
        path: string;
      }): Promise<{ ok: true } | { ok: false; error: { code: string } }>;
    };
  };

  const code = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { azir: ExposedBridge }).azir;
    const result = await bridge.files.listDirectory({ sessionId: 9999, path: '' });
    return result.ok ? null : result.error.code;
  });

  expect(code).toBe('stale-session');
});
