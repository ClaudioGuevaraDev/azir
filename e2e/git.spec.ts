import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchAzir } from './support';

/**
 * Git against real repositories.
 *
 * The parser is unit tested against captured `--porcelain=v2 -z` fixtures, which
 * covers the format. What it cannot cover is whether the flags Azir passes actually
 * produce that format on the installed git, and whether the failure paths behave when
 * the folder genuinely is not a repository.
 */

let app: ElectronApplication;
const scratchDirs: string[] = [];

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
};

/** A repository with one commit, created fresh so the assertions are exact. */
const makeRepo = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'azir-git-'));
  scratchDirs.push(root);
  git(root, 'init', '--initial-branch=main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  writeFileSync(path.join(root, 'committed.txt'), 'original\n');
  writeFileSync(path.join(root, 'renamed-from.txt'), 'x'.repeat(200));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');
  return root;
};

const makePlainFolder = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'azir-plain-'));
  scratchDirs.push(root);
  writeFileSync(path.join(root, 'notes.txt'), 'not a repository');
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
  app = await launchAzir();
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
      // The autostarted shell may still hold the directory; the OS cleans temp.
    }
  }
});

test('shows the branch and a clean repository as clean', async () => {
  const window = await openWorkspace(makeRepo());

  await expect(window.getByTestId('git-branch')).toContainText('main');
  await expect(window.getByTestId('git-change-count')).toHaveText('clean');
});

test('badges a modified, an untracked and a deleted file', async () => {
  const root = makeRepo();
  writeFileSync(path.join(root, 'committed.txt'), 'edited\n');
  writeFileSync(path.join(root, 'brand-new.txt'), 'new\n');
  rmSync(path.join(root, 'renamed-from.txt'));

  const window = await openWorkspace(root);

  await expect(window.getByTestId('tree-badge-committed.txt')).toHaveText('M');
  await expect(window.getByTestId('tree-badge-brand-new.txt')).toHaveText('?');
  await expect(window.getByTestId('tree-badge-renamed-from.txt')).toHaveText('D');
  await expect(window.getByTestId('git-change-count')).toHaveText('3 changed');
});

test('reports a staged rename with both paths', async () => {
  const root = makeRepo();
  git(root, 'mv', 'renamed-from.txt', 'renamed-to.txt');

  const window = await openWorkspace(root);

  // The badge on the new path proves the record's embedded NUL was parsed, and the
  // tooltip proves the source path survived it.
  const badge = window.getByTestId('tree-badge-renamed-to.txt');
  await expect(badge).toHaveText('R');
  await expect(window.getByTestId('tree-row-renamed-to.txt')).toHaveAttribute(
    'title',
    /renamed from renamed-from\.txt/,
  );
});

test('marks a collapsed directory that hides changes underneath', async () => {
  const root = makeRepo();
  const nested = path.join(root, 'deep', 'nested');
  mkdirSync(nested, { recursive: true });
  writeFileSync(path.join(nested, 'file.txt'), 'hidden change\n');

  const window = await openWorkspace(root);

  // Without this the change is invisible until the user expands two folders.
  await expect(window.getByTestId('tree-nested-deep')).toBeVisible();
});

test('the changes view lists full paths, including files the tree never read', async () => {
  const root = makeRepo();
  mkdirSync(path.join(root, 'deep'), { recursive: true });
  writeFileSync(path.join(root, 'deep', 'buried.txt'), 'change\n');

  const window = await openWorkspace(root);
  await window.getByTestId('repository-view-changes').click();

  await expect(window.getByTestId('tree-row-deep/buried.txt')).toBeVisible();
  // The tree has not read `deep/`, so this row exists only because git reported it.
  await expect(window.getByTestId('tree-badge-deep/buried.txt')).toHaveText('?');
});

test('a folder that is not a repository leaves the file browser fully usable', async () => {
  const window = await openWorkspace(makePlainFolder());

  // Invariant 13: the git panel says why, and everything else still works.
  await expect(window.getByTestId('git-unavailable')).toBeVisible();
  await expect(window.getByTestId('tree-row-notes.txt')).toBeVisible();
  await expect(window.getByTestId('terminal-panel')).toBeVisible();
});

test('a repository with no commits shows every file as untracked', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'azir-empty-'));
  scratchDirs.push(root);
  git(root, 'init', '--initial-branch=main');
  writeFileSync(path.join(root, 'first.txt'), 'nothing committed yet\n');

  const window = await openWorkspace(root);

  // A fresh repository is a normal thing to supervise, not an error.
  await expect(window.getByTestId('tree-badge-first.txt')).toHaveText('?');
});

test('refresh picks up a commit made in the integrated terminal', async () => {
  const root = makeRepo();
  writeFileSync(path.join(root, 'committed.txt'), 'edited\n');

  const window = await openWorkspace(root);
  await expect(window.getByTestId('tree-badge-committed.txt')).toHaveText('M');

  // Committed from outside, the way the user would from the terminal panel. The
  // watcher lands in M5; for now the refresh button is the path.
  git(root, 'commit', '-am', 'second');

  await window.getByTestId('repository-refresh').click();

  await expect(window.getByTestId('git-change-count')).toHaveText('clean');
});
