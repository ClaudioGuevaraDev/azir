import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

/**
 * The product's core loop, end to end and without touching the refresh button:
 *
 *     agent changes files → workspace detects → user sees it
 *
 * Everything asserted here happens because a real chokidar watcher fired, a real batch
 * crossed IPC, and the reducer decided what to reload. No test clicks refresh.
 */

let app: ElectronApplication;
const scratchDirs: string[] = [];

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
};

const makeRepo = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'azir-watch-'));
  scratchDirs.push(root);
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'index.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(root, 'README.md'), '# Demo\n');
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

test('a file created outside the app appears without a refresh', async () => {
  const root = makeRepo();
  const window = await openWorkspace(root);
  await expect(window.getByTestId('tree-row-README.md')).toBeVisible();

  writeFileSync(path.join(root, 'appeared.txt'), 'from an agent\n');

  await expect(window.getByTestId('tree-row-appeared.txt')).toBeVisible({ timeout: 15_000 });
  await expect(window.getByTestId('tree-badge-appeared.txt')).toHaveText('?');
});

test('a deleted file disappears from the tree', async () => {
  const root = makeRepo();
  const window = await openWorkspace(root);
  await expect(window.getByTestId('tree-row-README.md')).toBeVisible();

  rmSync(path.join(root, 'README.md'));

  // It comes back as a virtual node, because git still knows about it — struck through
  // rather than simply gone, which is what makes a deletion reviewable.
  await expect(window.getByTestId('tree-badge-README.md')).toHaveText('D', { timeout: 15_000 });
  await expect(window.getByTestId('tree-row-README.md')).toHaveAttribute('data-virtual', 'true');
});

test('editing a tracked file updates its badge without any .git write', async () => {
  const root = makeRepo();
  const window = await openWorkspace(root);
  await window.getByTestId('tree-row-src').click();
  await expect(window.getByTestId('tree-row-src/index.ts')).toBeVisible();
  await expect(window.getByTestId('git-change-count')).toHaveText('clean');

  writeFileSync(path.join(root, 'src', 'index.ts'), 'export const a = 2;\n');

  // Nothing under .git changed, so waiting for a .git event would leave this wrong
  // until the next commit.
  await expect(window.getByTestId('tree-badge-src/index.ts')).toHaveText('M', {
    timeout: 15_000,
  });
});

test('a change in a directory that has never been opened still shows on its parent', async () => {
  const root = makeRepo();
  const window = await openWorkspace(root);
  await expect(window.getByTestId('tree-row-src')).toBeVisible();

  mkdirSync(path.join(root, 'src', 'buried'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'buried', 'file.ts'), 'hidden\n');

  // `src` is collapsed and `src/buried` has never been read, so the dot comes from
  // git's change list rather than from a directory scan.
  await expect(window.getByTestId('tree-nested-src')).toBeVisible({ timeout: 15_000 });
});

test('a commit made outside the app clears the badges', async () => {
  const root = makeRepo();
  writeFileSync(path.join(root, 'src', 'index.ts'), 'export const a = 3;\n');

  const window = await openWorkspace(root);
  await expect(window.getByTestId('git-change-count')).toHaveText('1 changed', {
    timeout: 15_000,
  });

  // This is what watching .git/HEAD and .git/index is for: the user commits in the
  // integrated terminal and the panel keeps up.
  git(root, 'commit', '-am', 'second');

  await expect(window.getByTestId('git-change-count')).toHaveText('clean', { timeout: 15_000 });
});

test('a branch switch made outside the app updates the branch name', async () => {
  const root = makeRepo();
  const window = await openWorkspace(root);
  await expect(window.getByTestId('git-branch')).toContainText('main');

  git(root, 'checkout', '-b', 'feature/watched');

  await expect(window.getByTestId('git-branch')).toContainText('feature/watched', {
    timeout: 15_000,
  });
});

test('a burst of many files is coalesced rather than applied one by one', async () => {
  const root = makeRepo();
  const window = await openWorkspace(root);
  await expect(window.getByTestId('tree-row-README.md')).toBeVisible();

  mkdirSync(path.join(root, 'generated'), { recursive: true });
  for (let index = 0; index < 400; index += 1) {
    writeFileSync(path.join(root, 'generated', `file-${index}.ts`), `export const n = ${index};\n`);
  }

  // The batcher's job: 400-plus events become a handful of batches. The observable
  // consequence is that the UI stays responsive and still ends up correct.
  await expect(window.getByTestId('tree-row-generated')).toBeVisible({ timeout: 20_000 });
  await window.getByTestId('terminal-add').click();
  await expect(window.getByTestId('terminal-tab-p2')).toBeVisible();
});

test('changes inside node_modules are ignored entirely', async () => {
  const root = makeRepo();
  const window = await openWorkspace(root);
  await expect(window.getByTestId('tree-row-README.md')).toBeVisible();
  await expect(window.getByTestId('git-change-count')).toHaveText('clean');

  mkdirSync(path.join(root, 'node_modules', 'some-package'), { recursive: true });
  for (let index = 0; index < 50; index += 1) {
    writeFileSync(path.join(root, 'node_modules', 'some-package', `f${index}.js`), 'noise\n');
  }

  // Never listed, never watched — the two halves of the shared ignore list agreeing.
  await expect(window.getByTestId('tree-row-node_modules')).toHaveCount(0);
  // Given time to be wrong, and still clean: git ignores it too.
  await window.waitForTimeout(2000);
  await expect(window.getByTestId('git-change-count')).toHaveText('clean');
});

test('the watcher stops when the workspace closes', async () => {
  const root = makeRepo();
  const window = await openWorkspace(root);
  await expect(window.getByTestId('tree-row-README.md')).toBeVisible();

  await window.getByTestId('close-workspace').click();
  await expect(window.getByTestId('welcome')).toBeVisible();

  // A change now has nothing to update, and must not resurrect the panel.
  writeFileSync(path.join(root, 'after-close.txt'), 'ignored\n');
  await window.waitForTimeout(1500);

  await expect(window.getByTestId('welcome')).toBeVisible();
  await expect(window.getByTestId('repository-panel')).toHaveCount(0);
});
