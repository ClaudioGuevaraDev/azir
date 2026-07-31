import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launchAzir, expectPrompt } from './support';

/**
 * Editing and saving, against real files.
 *
 * The document operations are exhaustively unit tested as pure functions and the write queue is
 * tested with a fake writer. What only a real run can show is that a keystroke reaches the
 * buffer, that Ctrl+S lands bytes on disk with the file's own line ending, and that a change
 * arriving underneath unsaved work does not destroy it.
 */

let app: ElectronApplication;
const scratchDirs: string[] = [];

const makeRepo = (files: Record<string, string> = {}): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'azir-edit-'));
  scratchDirs.push(root);
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: root, stdio: 'pipe' });
  writeFileSync(path.join(root, 'notes.txt'), 'alpha\nbravo\ncharlie\n');
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(root, name), content);
  }
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

/** Opens a file and puts the keyboard in the code surface. */
const openFile = async (window: Page, name: string): Promise<void> => {
  await window.getByTestId(`tree-row-${name}`).click();
  await expect(window.getByTestId('code-view')).toBeVisible();
  await window.getByTestId('code-surface').click();
  // Focus has to land before typing: clicking a panel dispatches focus/changed, and typing in
  // the same tick races the re-render.
  await expect(window.getByTestId('status-focus')).toHaveText('viewer');
};

test.beforeEach(async () => {
  app = await launchAzir();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1400, 900);
  });
});

test.afterEach(async () => {
  /*
   * Teardown has to cope with the feature under test. Several of these tests deliberately end
   * with unsaved work, and the quit guard then refuses to let the app close — correctly, since
   * that is exactly what it is for. So the guard is released through the real bridge, the same
   * call a successful save makes, and the app then closes normally.
   *
   * Force-killing instead does not work: the killed process holds the single-instance lock long
   * enough that the next test's launch quits itself immediately, and every later test fails with
   * no window.
   */
  // `windows()` rather than `firstWindow()`: the latter *waits* for a window, so on a test that
  // already closed the app it blocks until an internal timeout and adds thirty seconds to the
  // run for nothing.
  const [window] = app.windows();
  if (window) {
    try {
      await window.evaluate(() => {
        (
          globalThis as unknown as { azir: { app: { setUnsaved(value: boolean): void } } }
        ).azir.app.setUnsaved(false);
      });
    } catch {
      // The window went away between the check and the call.
    }
  }

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

test('typing marks the tab dirty and shows the caret', async () => {
  const window = await openWorkspace(makeRepo());
  await openFile(window, 'notes.txt');

  await expect(window.getByTestId('code-caret')).toBeVisible();
  await window.keyboard.type('X');

  await expect(window.getByTestId('viewer-dirty-notes.txt')).toBeVisible();
  await expect(window.getByTestId('code-view')).toContainText('Xalpha');
  await expect(window.getByTestId('viewer-save')).toBeVisible();
});

test('Ctrl+S writes the file to disk', async () => {
  const root = makeRepo();
  const window = await openWorkspace(root);
  await openFile(window, 'notes.txt');

  await window.keyboard.type('EDITED ');
  await window.keyboard.press('Control+KeyS');

  await expect(window.getByTestId('viewer-dirty-notes.txt')).toHaveCount(0);

  await expect
    .poll(() => readFileSync(path.join(root, 'notes.txt'), 'utf8'), { timeout: 10_000 })
    .toBe('EDITED alpha\nbravo\ncharlie\n');
});

test('a CRLF file is saved with CRLF, so one edit is not a whole-file diff', async () => {
  const root = makeRepo({ 'crlf.txt': 'one\r\ntwo\r\nthree\r\n' });
  const window = await openWorkspace(root);
  await openFile(window, 'crlf.txt');

  await window.keyboard.type('X');
  await window.keyboard.press('Control+KeyS');

  await expect
    .poll(() => readFileSync(path.join(root, 'crlf.txt'), 'utf8'), { timeout: 10_000 })
    .toBe('Xone\r\ntwo\r\nthree\r\n');
});

test('a byte-order mark survives a save', async () => {
  const root = makeRepo({ 'bom.txt': '\uFEFFhello\n' });
  const window = await openWorkspace(root);
  await openFile(window, 'bom.txt');

  await window.keyboard.type('X');
  await window.keyboard.press('Control+KeyS');

  await expect
    .poll(() => readFileSync(path.join(root, 'bom.txt'), 'utf8'), { timeout: 10_000 })
    .toBe('\uFEFFXhello\n');
});

test('backspace removes a whole emoji rather than half of one', async () => {
  // A family emoji is eight code units and one visible character. Deleting one unit would leave
  // a lone surrogate in the file — corruption the user cannot see and did not ask for.
  const root = makeRepo({ 'emoji.txt': 'a\u{1F468}\u200D\u{1F469}\u200D\u{1F467}b\n' });
  const window = await openWorkspace(root);
  await openFile(window, 'emoji.txt');

  // Caret starts at 0,0: move right twice to sit just after the emoji.
  await window.keyboard.press('ArrowRight');
  await window.keyboard.press('ArrowRight');
  await window.keyboard.press('Backspace');
  await window.keyboard.press('Control+KeyS');

  await expect
    .poll(() => readFileSync(path.join(root, 'emoji.txt'), 'utf8'), { timeout: 10_000 })
    .toBe('ab\n');
});

test('Enter splits the line and the file reflects it', async () => {
  const root = makeRepo();
  const window = await openWorkspace(root);
  await openFile(window, 'notes.txt');

  await window.keyboard.press('End');
  await window.keyboard.press('Enter');
  await window.keyboard.type('inserted');
  await window.keyboard.press('Control+KeyS');

  await expect
    .poll(() => readFileSync(path.join(root, 'notes.txt'), 'utf8'), { timeout: 10_000 })
    .toBe('alpha\ninserted\nbravo\ncharlie\n');
});

test('Ctrl+S is left to the terminal when the terminal has focus', async () => {
  // Ctrl+S is XOFF. Reserving it globally would stop the terminal's output; scoping it to the
  // viewer means the shell keeps it whenever the shell is where the user is typing.
  const window = await openWorkspace(makeRepo());
  await openFile(window, 'notes.txt');
  await window.keyboard.type('X');
  await expect(window.getByTestId('viewer-dirty-notes.txt')).toBeVisible();

  const pane = window.getByTestId('terminal-pane-p1');
  await expectPrompt(window, 'p1');
  await pane.click();
  await expect(window.getByTestId('status-focus')).toHaveText('terminal');

  await window.keyboard.press('Control+KeyS');

  // Not saved: the chord went to the shell, not to the viewer.
  await expect(window.getByTestId('viewer-dirty-notes.txt')).toBeVisible();
});

test('closing a dirty tab asks before discarding', async () => {
  const window = await openWorkspace(makeRepo());
  await openFile(window, 'notes.txt');
  await window.keyboard.type('X');

  await window.getByTestId('viewer-close-notes.txt').click();

  await expect(window.getByTestId('overlay')).toHaveAttribute('data-overlay', 'confirm');
  await expect(window.getByTestId('confirm-body')).toContainText('notes.txt');

  // Declining keeps the tab and the edits.
  await window.getByTestId('confirm-cancel').click();
  await expect(window.getByTestId('viewer-tab-notes.txt')).toBeVisible();
  await expect(window.getByTestId('code-view')).toContainText('Xalpha');

  await window.getByTestId('viewer-close-notes.txt').click();
  await window.getByTestId('confirm-accept').click();

  await expect(window.getByTestId('viewer-tab-notes.txt')).toHaveCount(0);
});

test('closing a clean tab does not ask', async () => {
  const window = await openWorkspace(makeRepo());
  await openFile(window, 'notes.txt');

  await window.getByTestId('viewer-close-notes.txt').click();

  await expect(window.getByTestId('overlay')).toHaveCount(0);
  await expect(window.getByTestId('viewer-tab-notes.txt')).toHaveCount(0);
});

test('a dirty tab is never silently reloaded when the file changes on disk', async () => {
  /*
   * The situation this application exists to supervise: an agent rewriting a file the user is
   * editing. The spec is unambiguous that the edits must survive and the user must be told.
   */
  const root = makeRepo();
  const window = await openWorkspace(root);
  await openFile(window, 'notes.txt');
  await window.keyboard.type('MINE ');
  await expect(window.getByTestId('code-view')).toContainText('MINE alpha');

  writeFileSync(path.join(root, 'notes.txt'), 'rewritten by an agent\n');

  await expect(window.getByTestId('viewer-conflict')).toBeVisible({ timeout: 15_000 });
  // The buffer is untouched.
  await expect(window.getByTestId('code-view')).toContainText('MINE alpha');
  await expect(window.getByTestId('code-view')).not.toContainText('rewritten by an agent');
  await expect(window.getByTestId('viewer-dirty-notes.txt')).toHaveAttribute(
    'data-conflict',
    'true',
  );
});

test('the user can choose to discard their edits and take what is on disk', async () => {
  const root = makeRepo();
  const window = await openWorkspace(root);
  await openFile(window, 'notes.txt');
  await window.keyboard.type('MINE ');

  writeFileSync(path.join(root, 'notes.txt'), 'rewritten by an agent\n');
  await expect(window.getByTestId('viewer-conflict')).toBeVisible({ timeout: 15_000 });

  await window.getByTestId('viewer-discard-mine').click();
  await expect(window.getByTestId('overlay')).toHaveAttribute('data-overlay', 'confirm');
  await window.getByTestId('confirm-accept').click();

  await expect(window.getByTestId('code-view')).toContainText('rewritten by an agent');
  await expect(window.getByTestId('viewer-dirty-notes.txt')).toHaveCount(0);
  await expect(window.getByTestId('viewer-conflict')).toHaveCount(0);
});

test('saving after a conflict keeps the buffer and clears the warning', async () => {
  const root = makeRepo();
  const window = await openWorkspace(root);
  await openFile(window, 'notes.txt');
  await window.keyboard.type('MINE ');

  writeFileSync(path.join(root, 'notes.txt'), 'rewritten by an agent\n');
  await expect(window.getByTestId('viewer-conflict')).toBeVisible({ timeout: 15_000 });

  await window.getByTestId('code-surface').click();
  await window.keyboard.press('Control+KeyS');

  await expect(window.getByTestId('viewer-conflict')).toHaveCount(0);
  await expect
    .poll(() => readFileSync(path.join(root, 'notes.txt'), 'utf8'), { timeout: 10_000 })
    .toBe('MINE alpha\nbravo\ncharlie\n');
});

test('quitting with unsaved work asks first', async () => {
  const window = await openWorkspace(makeRepo());
  await openFile(window, 'notes.txt');
  await window.keyboard.type('X');
  await expect(window.getByTestId('viewer-dirty-notes.txt')).toBeVisible();

  // Triggering a quit the way the window close button does.
  await app.evaluate(({ app: electronApp }) => {
    electronApp.quit();
  });

  await expect(window.getByTestId('overlay')).toHaveAttribute('data-overlay', 'confirm');
  await expect(window.getByTestId('confirm-body')).toContainText('notes.txt');

  // Declining leaves the app running.
  await window.getByTestId('confirm-cancel').click();
  await expect(window.getByTestId('workspace-shell')).toBeVisible();
});

test('quitting with everything saved does not ask', async () => {
  const window = await openWorkspace(makeRepo());
  await openFile(window, 'notes.txt');
  await window.keyboard.type('X');
  await window.keyboard.press('Control+KeyS');
  await expect(window.getByTestId('viewer-dirty-notes.txt')).toHaveCount(0);

  // The window closes rather than a dialog appearing; `close()` resolving is the assertion.
  await app.close();
});

test('Ctrl+End and Ctrl+Home jump to the ends of the document', async () => {
  /*
   * These two moves existed in the document module before anything called them, which is the
   * failure this test exists to prevent: the editor's key handler bails out on any Ctrl chord so
   * the reserved-shortcut router can have it, and that silently swallowed both. Typing after
   * Ctrl+End landed the text at the *start* of the file — the opposite of what was asked.
   */
  const window = await openWorkspace(makeRepo());
  await openFile(window, 'notes.txt');

  await window.keyboard.press('Control+End');
  await window.keyboard.type('!');
  // The file ends in a newline, so the last line is empty and the mark lands alone on it.
  await expect(window.getByTestId('code-view')).toContainText('charlie');
  await expect(window.getByTestId('code-view')).not.toContainText('!alpha');

  await window.keyboard.press('Control+Home');
  await window.keyboard.type('#');

  await expect(window.getByTestId('code-view')).toContainText('#alpha');
});

test('the edit surface refuses a path outside the workspace on write, too', async () => {
  const window = await openWorkspace(makeRepo());
  await expect(window.getByTestId('tree-row-notes.txt')).toBeVisible();

  type ExposedBridge = {
    files: {
      write(request: {
        sessionId: number;
        path: string;
        content: string;
        eol: string;
        hadBom: boolean;
      }): Promise<{ ok: true } | { ok: false; error: { code: string } }>;
    };
  };

  const codes = await window.evaluate(async () => {
    const bridge = (globalThis as unknown as { azir: ExposedBridge }).azir;
    const attempts = ['../escaped.txt', 'C:\\Windows\\hosts'];
    const results: Array<string | null> = [];
    for (const attempt of attempts) {
      const result = await bridge.files.write({
        sessionId: 1,
        path: attempt,
        content: 'pwned',
        eol: 'lf',
        hadBom: false,
      });
      results.push(result.ok ? null : result.error.code);
    }
    return results;
  });

  expect(codes).toEqual(['path-outside-workspace', 'path-outside-workspace']);
});
