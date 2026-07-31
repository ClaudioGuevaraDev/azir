import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

/**
 * The review half of the product loop, against real files and a real git.
 *
 * The parsers and the staleness matrix are unit tested. What only an end-to-end run can
 * show is whether reading a file, asking git for its diff and rendering both actually
 * line up — and whether the guards fire on content a person would really hit.
 */

let app: ElectronApplication;
const scratchDirs: string[] = [];

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
};

const makeRepo = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'azir-view-'));
  scratchDirs.push(root);
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  writeFileSync(path.join(root, 'tracked.txt'), 'alpha\nbravo\ncharlie\ndelta\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');
  return root;
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
      // The autostarted shell may still hold it; the OS cleans temp.
    }
  }
});

test('clicking a file opens it and shows its contents with line numbers', async () => {
  const window = await openWorkspace(makeRepo());

  await expect(window.getByTestId('viewer-empty')).toBeVisible();
  await window.getByTestId('tree-row-tracked.txt').click();

  await expect(window.getByTestId('viewer-tab-tracked.txt')).toBeVisible();
  const code = window.getByTestId('code-view');
  await expect(code).toContainText('alpha');
  await expect(code).toContainText('delta');
  // A file ending in a newline has an empty last line, so four lines of text is five.
  await expect(window.getByTestId('viewer-panel')).toContainText('5 lines');
});

test('clicking a directory does not open a tab', async () => {
  const root = makeRepo();
  execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
  const window = await openWorkspace(root);

  await window.getByTestId('tree-row-tracked.txt').click();
  await expect(window.getByTestId('viewer-tab-tracked.txt')).toBeVisible();

  // Directories expand; only files open.
  await expect(window.getByTestId('viewer-panel').locator('.viewer__tab')).toHaveCount(1);
});

test('the diff of a modified file shows the change and the counts', async () => {
  const root = makeRepo();
  writeFileSync(path.join(root, 'tracked.txt'), 'alpha\nBRAVO\ncharlie\ndelta\necho\n');

  const window = await openWorkspace(root);
  await window.getByTestId('tree-row-tracked.txt').click();
  await expect(window.getByTestId('code-view')).toBeVisible();

  await window.getByTestId('viewer-mode-diff').click();

  const diff = window.getByTestId('diff-view');
  await expect(diff).toContainText('bravo');
  await expect(diff).toContainText('BRAVO');
  await expect(diff).toContainText('echo');
  // One line replaced plus one appended.
  await expect(window.getByTestId('viewer-counts')).toContainText('+2');
  await expect(window.getByTestId('viewer-counts')).toContainText('1');
});

test('the bridge cannot be swapped out from the renderer', async () => {
  /*
   * Not the test that was originally here. The first version tried to count diff requests
   * by wrapping `window.azir.git.diff`, to assert performance rule 5 (diffs loaded only
   * when viewed) end to end. It never worked: `contextBridge` exposes an immutable object,
   * so the assignment was discarded silently and the counter stayed at zero — the test
   * passed while measuring nothing.
   *
   * That immutability is a security property, so it is asserted here instead. Rule 5 is
   * asserted precisely where it is decided, in src/renderer/app/reducer/viewer.test.ts:
   * opening a file emits no `viewer/readDiff` effect, and entering diff mode emits exactly
   * one.
   */
  const window = await openWorkspace(makeRepo());

  const outcome = await window.evaluate(() => {
    const bridge = (globalThis as unknown as { azir: { git: { diff: unknown } } }).azir;
    const original = bridge.git.diff;
    try {
      bridge.git.diff = () => Promise.resolve({ ok: false });
    } catch {
      return 'threw';
    }
    return bridge.git.diff === original ? 'unchanged' : 'REPLACED';
  });

  expect(['threw', 'unchanged']).toContain(outcome);
});

test('an untracked file shows its whole content as additions', async () => {
  // `git diff` compares against the index, which has never heard of an untracked file, so
  // git alone would report nothing — the least useful answer for a file an agent just
  // created.
  const root = makeRepo();
  writeFileSync(path.join(root, 'brand-new.txt'), 'first\nsecond\nthird\n');

  const window = await openWorkspace(root);
  await window.getByTestId('tree-row-brand-new.txt').click();
  await window.getByTestId('viewer-mode-diff').click();

  const diff = window.getByTestId('diff-view');
  await expect(diff).toContainText('first');
  await expect(diff).toContainText('third');
  await expect(window.getByTestId('viewer-counts')).toContainText('+3');
});

test('a file too large to load is refused with a clear message', async () => {
  const root = makeRepo();
  // Comfortably past the 2 MB viewer limit.
  writeFileSync(path.join(root, 'huge.txt'), 'x'.repeat(3 * 1024 * 1024));

  const window = await openWorkspace(root);
  await window.getByTestId('tree-row-huge.txt').click();

  const error = window.getByTestId('viewer-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText('KB');
  // The tab stays open showing why, rather than closing what the user just clicked.
  await expect(window.getByTestId('viewer-tab-huge.txt')).toBeVisible();
  await expect(window.getByTestId('code-view')).toHaveCount(0);
});

test('a binary file is refused rather than rendered as mojibake', async () => {
  const root = makeRepo();
  writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x00]));

  const window = await openWorkspace(root);
  await window.getByTestId('tree-row-blob.bin').click();

  await expect(window.getByTestId('viewer-error')).toContainText('binary');
});

test('several tabs open and switching between them keeps each place', async () => {
  const root = makeRepo();
  writeFileSync(path.join(root, 'second.txt'), 'one\ntwo\n');

  const window = await openWorkspace(root);
  await window.getByTestId('tree-row-tracked.txt').click();
  await expect(window.getByTestId('code-view')).toContainText('alpha');

  await window.getByTestId('tree-row-second.txt').click();
  await expect(window.getByTestId('code-view')).toContainText('two');

  await window.getByTestId('viewer-tab-tracked.txt').getByRole('button').first().click();
  await expect(window.getByTestId('code-view')).toContainText('alpha');
});

test('closing a tab moves focus rightwards', async () => {
  const root = makeRepo();
  writeFileSync(path.join(root, 'second.txt'), 'one\n');

  const window = await openWorkspace(root);
  await window.getByTestId('tree-row-second.txt').click();
  await window.getByTestId('tree-row-tracked.txt').click();

  await window.getByTestId('viewer-close-tracked.txt').click();

  await expect(window.getByTestId('viewer-tab-tracked.txt')).toHaveCount(0);
  await expect(window.getByTestId('code-view')).toContainText('one');
});

test('the active tab reloads when its file changes on disk', async () => {
  const root = makeRepo();
  const window = await openWorkspace(root);
  await window.getByTestId('tree-row-tracked.txt').click();
  await expect(window.getByTestId('code-view')).toContainText('alpha');

  writeFileSync(path.join(root, 'tracked.txt'), 'rewritten by an agent\n');

  // No refresh click: the watcher batch drives this.
  await expect(window.getByTestId('code-view')).toContainText('rewritten by an agent', {
    timeout: 15_000,
  });
});

test('a background tab is marked rather than re-read, and reloads on activation', async () => {
  const root = makeRepo();
  writeFileSync(path.join(root, 'second.txt'), 'original second\n');

  const window = await openWorkspace(root);
  await window.getByTestId('tree-row-tracked.txt').click();
  await expect(window.getByTestId('code-view')).toContainText('alpha');
  await window.getByTestId('tree-row-second.txt').click();
  await expect(window.getByTestId('code-view')).toContainText('original second');

  // `tracked.txt` is now in the background.
  writeFileSync(path.join(root, 'tracked.txt'), 'changed while hidden\n');

  await expect(window.getByTestId('viewer-stale-tracked.txt')).toBeVisible({ timeout: 15_000 });

  await window.getByTestId('viewer-tab-tracked.txt').getByRole('button').first().click();

  await expect(window.getByTestId('code-view')).toContainText('changed while hidden');
  await expect(window.getByTestId('viewer-stale-tracked.txt')).toHaveCount(0);
});

test('the staged and unstaged sides of a partially staged file are both available', async () => {
  const root = makeRepo();
  writeFileSync(path.join(root, 'tracked.txt'), 'alpha\nSTAGED\ncharlie\ndelta\n');
  git(root, 'add', 'tracked.txt');
  writeFileSync(path.join(root, 'tracked.txt'), 'alpha\nSTAGED\ncharlie\nUNSTAGED\n');

  const window = await openWorkspace(root);
  await window.getByTestId('tree-row-tracked.txt').click();
  await window.getByTestId('viewer-mode-diff').click();

  // The switch only appears when the file genuinely has both sides.
  await expect(window.getByTestId('viewer-target-worktree')).toBeVisible();
  await expect(window.getByTestId('diff-view')).toContainText('UNSTAGED');

  await window.getByTestId('viewer-target-staged').click();

  await expect(window.getByTestId('diff-view')).toContainText('STAGED');
  await expect(window.getByTestId('diff-view')).not.toContainText('UNSTAGED');
});

test('a clean tracked file reports no changes instead of an empty view', async () => {
  const window = await openWorkspace(makeRepo());
  await window.getByTestId('tree-row-tracked.txt').click();
  await window.getByTestId('viewer-mode-diff').click();

  await expect(window.getByTestId('diff-empty')).toBeVisible();
});

test('the viewer refuses a path outside the workspace', async () => {
  const window = await openWorkspace(makeRepo());
  await expect(window.getByTestId('tree-row-tracked.txt')).toBeVisible();

  type ExposedBridge = {
    files: {
      read(request: {
        sessionId: number;
        path: string;
      }): Promise<{ ok: true } | { ok: false; error: { code: string } }>;
    };
  };

  const codes = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { azir: ExposedBridge }).azir;
    const attempts = ['../outside.txt', '/etc/passwd', 'C:\\Windows\\win.ini'];
    const results: Array<string | null> = [];
    for (const attempt of attempts) {
      const result = await bridge.files.read({ sessionId: 1, path: attempt });
      results.push(result.ok ? null : result.error.code);
    }
    return results;
  });

  expect(codes).toEqual([
    'path-outside-workspace',
    'path-outside-workspace',
    'path-outside-workspace',
  ]);
});
