import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { expectPrompt, launchAzir } from './support';

/**
 * Search, against a real workspace.
 *
 * The matcher, the walk and the content scan are all unit tested. What only a full run can show is
 * that the index actually arrives, that it tracks a file an agent creates while the application is
 * open, and — the claim that matters most and is easiest to break without noticing — that a search
 * over a large repository does not freeze the terminal.
 */

let app: ElectronApplication;
const scratchDirs: string[] = [];

const makeRepo = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'azir-search-'));
  scratchDirs.push(root);
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'pipe' });

  mkdirSync(path.join(root, 'src', 'renderer', 'overlays'), { recursive: true });
  mkdirSync(path.join(root, 'src', 'main'), { recursive: true });
  // Present on disk so its absence from the index proves the filter rather than the directory
  // simply not being there.
  mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });

  writeFileSync(path.join(root, 'README.md'), '# Demo\n\nA needle is hidden below.\n');
  writeFileSync(path.join(root, 'src', 'main', 'index.ts'), 'export const port = 8080;\n');
  writeFileSync(
    path.join(root, 'src', 'renderer', 'overlays', 'OverlayHost.tsx'),
    'export const OverlayHost = () => null;\n',
  );
  writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'const needle = 1;\n');
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

const openSearch = async (window: Page): Promise<void> => {
  await window.keyboard.press('Control+Shift+F');
  await expect(window.getByTestId('overlay')).toHaveAttribute('data-overlay', 'search');
  // The index arrives as an event after the walk, so every path assertion waits for it.
  await expect(window.getByTestId('search-indexing')).toHaveCount(0, { timeout: 20_000 });
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
      // The autostarted shell may still hold it; the OS cleans temp.
    }
  }
});

test('Ctrl+Shift+F opens search and the index reports what it found', async () => {
  const window = await openWorkspace(makeRepo());

  await openSearch(window);

  // Four files, and not the one inside node_modules.
  await expect(window.getByTestId('search-empty')).toContainText('3 files indexed');
});

test('typing finds a file by fragments of its path', async () => {
  const window = await openWorkspace(makeRepo());
  await openSearch(window);

  await window.getByTestId('search-input').fill('ovh');

  // Characters in order, not adjacent: how someone types a path they half remember.
  await expect(
    window.getByTestId('search-result-src/renderer/overlays/OverlayHost.tsx'),
  ).toBeVisible();
});

test('a path result opens the file in the viewer and closes the overlay', async () => {
  const window = await openWorkspace(makeRepo());
  await openSearch(window);
  await window.getByTestId('search-input').fill('mainindex');

  await window.getByTestId('search-result-src/main/index.ts').click();

  await expect(window.getByTestId('overlay')).toHaveCount(0);
  await expect(window.getByTestId('viewer-tab-src/main/index.ts')).toBeVisible();
  await expect(window.getByTestId('code-view')).toContainText('8080');
});

test('nothing inside an ignored directory is ever searchable', async () => {
  const window = await openWorkspace(makeRepo());
  await openSearch(window);

  await window.getByTestId('search-input').fill('pkg');

  // The scanner, the watcher and the index share one ignore list; a file search could offer but
  // the tree refuses to show would be the three of them disagreeing.
  await expect(window.getByTestId('search-no-results')).toBeVisible();
});

test('a file created by an agent becomes searchable without a restart', async () => {
  const root = makeRepo();
  const window = await openWorkspace(root);
  await openSearch(window);
  await window.getByTestId('search-input').fill('appeared');
  await expect(window.getByTestId('search-no-results')).toBeVisible();

  writeFileSync(path.join(root, 'src', 'appeared.ts'), 'export const fresh = true;\n');

  // The whole point of the delta channel: the index tracks what the agent is doing, live.
  await expect(window.getByTestId('search-result-src/appeared.ts')).toBeVisible({
    timeout: 20_000,
  });
});

test('a file deleted by an agent stops being offered', async () => {
  const root = makeRepo();
  const window = await openWorkspace(root);
  await openSearch(window);
  await window.getByTestId('search-input').fill('README');
  await expect(window.getByTestId('search-result-README.md')).toBeVisible();

  rmSync(path.join(root, 'README.md'));

  await expect(window.getByTestId('search-result-README.md')).toHaveCount(0, { timeout: 20_000 });
});

test('content search finds text inside files and opens the match', async () => {
  const window = await openWorkspace(makeRepo());
  await openSearch(window);

  await window.getByTestId('search-mode-content').click();
  await window.getByTestId('search-input').fill('needle');

  const result = window.getByTestId('search-result-README.md:3');
  await expect(result).toBeVisible({ timeout: 20_000 });
  await expect(result).toContainText('A needle is hidden below.');

  await result.click();
  await expect(window.getByTestId('viewer-tab-README.md')).toBeVisible();
});

test('the content query is literal text, not a pattern', async () => {
  const window = await openWorkspace(makeRepo());
  await openSearch(window);
  await window.getByTestId('search-mode-content').click();

  await window.getByTestId('search-input').fill('n.edle');

  // A renderer-supplied regular expression would be a denial of service against the process every
  // PTY byte flows through, so the feature is not offered at all.
  await expect(window.getByTestId('search-no-results')).toBeVisible({ timeout: 20_000 });
});

test('a slow content search does not freeze the terminal', async () => {
  /*
   * Invariant 8, end to end: "PTY traffic never waits behind git, search or filesystem scans."
   *
   * The workspace here is deliberately big enough that the scan takes real time. The assertion is
   * not that the search is fast — it is that a command typed *while it runs* still echoes, which
   * is only possible if the scan is yielding the event loop back between files.
   */
  const root = makeRepo();
  const many = path.join(root, 'generated');
  mkdirSync(many, { recursive: true });
  for (let index = 0; index < 3000; index += 1) {
    writeFileSync(path.join(many, `file-${index}.ts`), `export const n${index} = ${index};\n`);
  }

  const window = await openWorkspace(root);
  await expectPrompt(window, 'p1');
  await openSearch(window);
  await window.getByTestId('search-mode-content').click();
  await window.getByTestId('search-input').fill('export');

  // Straight into the terminal without waiting for the search to finish.
  await window.keyboard.press('Escape');
  await window.getByTestId('terminal-pane-p1').click();
  await window.keyboard.type('echo SEARCH_DID_NOT_BLOCK');
  await window.keyboard.press('Enter');

  await expect(window.getByTestId('terminal-pane-p1')).toContainText('SEARCH_DID_NOT_BLOCK', {
    timeout: 25_000,
  });
});

test('a superseded query never overwrites the current answer', async () => {
  const root = makeRepo();
  const many = path.join(root, 'generated');
  mkdirSync(many, { recursive: true });
  for (let index = 0; index < 2000; index += 1) {
    writeFileSync(path.join(many, `file-${index}.ts`), `export const common = ${index};\n`);
  }

  const window = await openWorkspace(root);
  await openSearch(window);
  await window.getByTestId('search-mode-content').click();

  // A broad query that takes a while, immediately replaced by a narrow one.
  await window.getByTestId('search-input').fill('export');
  await window.getByTestId('search-input').fill('8080');

  const results = window.getByTestId('search-results');
  await expect(results).toBeVisible({ timeout: 25_000 });
  await expect(window.getByTestId('search-result-src/main/index.ts:1')).toBeVisible();

  /*
   * Given time for the abandoned search to land if it were going to. The failure this rules out is
   * the visible one: hundreds of `export` matches replacing the single correct answer a moment
   * after it appeared.
   */
  await window.waitForTimeout(3000);
  await expect(results.locator('li')).toHaveCount(1);
});

test('the search overlay says it is indexing rather than reporting no results', async () => {
  const root = makeRepo();
  const many = path.join(root, 'generated');
  mkdirSync(many, { recursive: true });
  for (let index = 0; index < 4000; index += 1) {
    writeFileSync(path.join(many, `file-${index}.ts`), 'x\n');
  }

  const window = await openWorkspace(root);
  // Opened immediately, while the walk is very likely still running.
  await window.keyboard.press('Control+Shift+F');
  await expect(window.getByTestId('overlay')).toHaveAttribute('data-overlay', 'search');

  // "No matches" while the index is still building tells the user their file does not exist.
  // Either state is legitimate here depending on how fast the walk was; what must never appear is
  // an empty-result claim.
  await expect(window.getByTestId('search-no-results')).toHaveCount(0);
  await expect(
    window.getByTestId('search-empty').or(window.getByTestId('search-indexing')),
  ).toBeVisible();
});

test('search survives the workspace being closed and reopened', async () => {
  const root = makeRepo();
  const window = await openWorkspace(root);
  await openSearch(window);
  await window.keyboard.press('Escape');

  await window.getByTestId('close-workspace').click();
  await expect(window.getByTestId('welcome')).toBeVisible();

  await app.evaluate(async ({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
  }, root);
  await window.getByTestId('open-workspace').click();
  await expect(window.getByTestId('workspace-shell')).toBeVisible();

  // A second index for a second session, not the first one's leftovers.
  await openSearch(window);
  await expect(window.getByTestId('search-empty')).toContainText('3 files indexed');
});
