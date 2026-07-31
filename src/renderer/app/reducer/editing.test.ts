import { describe, expect, it } from 'vitest';
import type { FsChangeBatch, ReadFileResponse } from '@shared/ipc/contracts';
import type { Action } from '../actions';
import { initialOverlayState } from '../chrome';
import { findTab, hasUnsavedWork, initialViewerState, type ViewerState } from '../viewer';
import { overlayReducer } from './chrome';
import { viewerReducer } from './viewer';

const response = (path: string, content = 'alpha\nbravo\n'): ReadFileResponse => ({
  path,
  content,
  eol: 'lf',
  hadBom: false,
  byteSize: content.length,
});

const run = (state: ViewerState, ...actions: Action[]): ViewerState =>
  actions.reduce((current, action) => viewerReducer(current, action).state, state);

const open = (path: string, requestId: string): Action => ({
  type: 'viewer/openRequested',
  sessionId: 1,
  path,
  requestId,
});

const loaded = (path: string, requestId: string, content?: string): Action => ({
  type: 'viewer/contentLoaded',
  sessionId: 1,
  path,
  requestId,
  response: response(path, content),
});

const type_ = (path: string, text: string): Action => ({
  type: 'viewer/edited',
  path,
  operation: { kind: 'insert', text },
});

/** One clean tab on `a.ts` with `alpha\nbravo\n`. */
const withTab = (content?: string): ViewerState =>
  run(initialViewerState, open('a.ts', 'r1'), loaded('a.ts', 'r1', content));

const dirtyTab = (): ViewerState => run(withTab(), type_('a.ts', 'X'));

const batch = (overrides: Partial<FsChangeBatch> = {}): Action => ({
  type: 'fs/changed',
  sessionId: 1,
  batch: {
    sessionId: 1,
    directories: [],
    files: [],
    gitDirty: false,
    truncated: false,
    ...overrides,
  },
  gitRequestId: 'rg',
  directoryRequestIds: {},
  viewerContentRequestId: 'rvc',
  viewerDiffRequestId: 'rvd',
});

describe('editing', () => {
  it('applies the operation and marks the tab dirty', () => {
    const state = dirtyTab();
    const tab = findTab(state, 'a.ts');

    expect(tab?.dirty).toBe(true);
    if (tab?.content.status !== 'ready') {
      throw new Error('unreachable');
    }
    expect(tab.content.value.lines[0]).toBe('Xalpha');
  });

  it('tells main about unsaved work on the first edit only', () => {
    // The guard needs to know at the boundary, not on every keystroke.
    const first = viewerReducer(withTab(), type_('a.ts', 'X'));
    expect(first.effects).toEqual([{ type: 'app/setUnsaved', unsaved: true }]);

    const second = viewerReducer(first.state, type_('a.ts', 'Y'));
    expect(second.effects).toEqual([]);
  });

  it('does not mark the tab dirty for a caret move', () => {
    // Otherwise looking at a file would ask the user to save it.
    const result = viewerReducer(withTab(), {
      type: 'viewer/edited',
      path: 'a.ts',
      operation: { kind: 'move', to: 'right' },
    });

    expect(findTab(result.state, 'a.ts')?.dirty).toBe(false);
    expect(findTab(result.state, 'a.ts')?.caret).toEqual({ line: 0, column: 1 });
    expect(result.effects).toEqual([]);
  });

  it('preserves identity when a caret move changes nothing', () => {
    const state = withTab();

    expect(
      viewerReducer(state, {
        type: 'viewer/edited',
        path: 'a.ts',
        operation: { kind: 'move', to: 'left' },
      }).state,
    ).toBe(state);
  });

  it('invalidates a cached diff, which now describes the file on disk', () => {
    const withDiff = run(
      withTab(),
      { type: 'viewer/modeChanged', sessionId: 1, path: 'a.ts', mode: 'diff', requestId: 'rd1' },
      {
        type: 'viewer/diffLoaded',
        sessionId: 1,
        path: 'a.ts',
        requestId: 'rd1',
        diff: { path: 'a.ts', target: 'worktree', binary: false, hunks: [] },
      },
    );

    const result = run(withDiff, type_('a.ts', 'X'));

    expect(findTab(result, 'a.ts')?.diff.status).toBe('idle');
  });

  it('ignores an edit on a tab whose content has not loaded', () => {
    const loading = viewerReducer(initialViewerState, open('a.ts', 'r1')).state;

    expect(viewerReducer(loading, type_('a.ts', 'X')).state).toBe(loading);
  });
});

describe('saving', () => {
  it("sends the buffer with the file's own line ending and BOM", () => {
    const crlf = run(
      initialViewerState,
      open('a.ts', 'r1'),
      {
        type: 'viewer/contentLoaded',
        sessionId: 1,
        path: 'a.ts',
        requestId: 'r1',
        response: { path: 'a.ts', content: 'one\ntwo\n', eol: 'crlf', hadBom: true, byteSize: 8 },
      },
      type_('a.ts', 'X'),
    );

    const result = viewerReducer(crlf, {
      type: 'viewer/saveRequested',
      sessionId: 1,
      path: 'a.ts',
      requestId: 'rs',
    });

    // The content travels LF-joined; main applies the real ending. Losing eol or hadBom here
    // would turn a one-line edit into a whole-file diff.
    expect(result.effects).toEqual([
      {
        type: 'viewer/writeFile',
        sessionId: 1,
        path: 'a.ts',
        content: 'Xone\ntwo\n',
        eol: 'crlf',
        hadBom: true,
        requestId: 'rs',
      },
    ]);
  });

  it('ignores a save for a clean tab', () => {
    const state = withTab();

    const result = viewerReducer(state, {
      type: 'viewer/saveRequested',
      sessionId: 1,
      path: 'a.ts',
      requestId: 'rs',
    });

    expect(result.state).toBe(state);
    expect(result.effects).toEqual([]);
  });

  it('clears dirty and releases the quit guard on success', () => {
    const saving = run(dirtyTab(), {
      type: 'viewer/saveRequested',
      sessionId: 1,
      path: 'a.ts',
      requestId: 'rs',
    });

    const result = viewerReducer(saving, {
      type: 'viewer/saved',
      sessionId: 1,
      path: 'a.ts',
      requestId: 'rs',
    });

    expect(findTab(result.state, 'a.ts')?.dirty).toBe(false);
    expect(result.effects).toEqual([{ type: 'app/setUnsaved', unsaved: false }]);
  });

  it('keeps the guard held while another tab is still dirty', () => {
    const two = run(dirtyTab(), open('b.ts', 'r2'), loaded('b.ts', 'r2'), type_('b.ts', 'Y'), {
      type: 'viewer/saveRequested',
      sessionId: 1,
      path: 'a.ts',
      requestId: 'rs',
    });

    const result = viewerReducer(two, {
      type: 'viewer/saved',
      sessionId: 1,
      path: 'a.ts',
      requestId: 'rs',
    });

    expect(result.effects).toEqual([]);
    expect(hasUnsavedWork(result.state)).toBe(true);
  });

  it('stays dirty when the write fails', () => {
    // A failed write means the edits are only in memory — exactly when the user must not be
    // told they are safe.
    const saving = run(dirtyTab(), {
      type: 'viewer/saveRequested',
      sessionId: 1,
      path: 'a.ts',
      requestId: 'rs',
    });

    const result = viewerReducer(saving, {
      type: 'viewer/saveFailed',
      sessionId: 1,
      path: 'a.ts',
      requestId: 'rs',
      error: { code: 'permission-denied', message: 'read only' },
    });

    const tab = findTab(result.state, 'a.ts');
    expect(tab?.dirty).toBe(true);
    expect(tab?.save).toMatchObject({ status: 'failed' });
    expect(result.effects).toEqual([]);
  });

  it('drops a save response whose request was superseded', () => {
    const saving = run(dirtyTab(), {
      type: 'viewer/saveRequested',
      sessionId: 1,
      path: 'a.ts',
      requestId: 'rs1',
    });
    const resaved = run(saving, {
      type: 'viewer/saveRequested',
      sessionId: 1,
      path: 'a.ts',
      requestId: 'rs2',
    });

    const result = viewerReducer(resaved, {
      type: 'viewer/saved',
      sessionId: 1,
      path: 'a.ts',
      requestId: 'rs1',
    });

    // Accepting the older answer would report the newer edits as saved when they are not.
    expect(result.state).toBe(resaved);
    expect(findTab(resaved, 'a.ts')?.dirty).toBe(true);
  });
});

describe('a dirty tab and a change on disk', () => {
  it('is never silently reloaded', () => {
    // The spec is unambiguous, and the situation is exactly what this application exists to
    // supervise: an agent rewriting a file the user is editing.
    const result = viewerReducer(dirtyTab(), batch({ files: ['a.ts'] }));
    const tab = findTab(result.state, 'a.ts');

    expect(tab?.changedOnDisk).toBe(true);
    expect(tab?.dirty).toBe(true);
    expect(tab?.content.status).toBe('ready');
    if (tab?.content.status !== 'ready') {
      throw new Error('unreachable');
    }
    expect(tab.content.value.lines[0]).toBe('Xalpha');
    // No read was requested.
    expect(result.effects).toEqual([]);
  });

  it('is not reloaded on activation either', () => {
    const conflicted = run(
      dirtyTab(),
      open('b.ts', 'r2'),
      loaded('b.ts', 'r2'),
      batch({ files: ['a.ts'] }),
    );

    const result = viewerReducer(conflicted, {
      type: 'viewer/activated',
      sessionId: 1,
      path: 'a.ts',
      contentRequestId: 'rc',
      diffRequestId: 'rd',
    });

    expect(result.effects.filter((effect) => effect.type === 'viewer/readFile')).toEqual([]);
    expect(findTab(result.state, 'a.ts')?.dirty).toBe(true);
  });

  it('is marked once, however many batches arrive', () => {
    const once = viewerReducer(dirtyTab(), batch({ files: ['a.ts'] })).state;

    expect(viewerReducer(once, batch({ files: ['a.ts'] })).state).toBe(once);
  });

  it('reloads only when the user explicitly asks, discarding the edits', () => {
    const conflicted = viewerReducer(dirtyTab(), batch({ files: ['a.ts'] })).state;

    const result = viewerReducer(conflicted, {
      type: 'viewer/reloadRequested',
      sessionId: 1,
      path: 'a.ts',
      requestId: 'rr',
    });

    const tab = findTab(result.state, 'a.ts');
    expect(tab?.dirty).toBe(false);
    expect(tab?.changedOnDisk).toBe(false);
    expect(result.effects).toContainEqual({
      type: 'viewer/readFile',
      sessionId: 1,
      path: 'a.ts',
      requestId: 'rr',
    });
    // ...and the guard is released, since nothing is unsaved any more.
    expect(result.effects).toContainEqual({ type: 'app/setUnsaved', unsaved: false });
  });

  it('clears the conflict when the file is saved', () => {
    // After a save the buffer and the disk agree, so the watcher event this write produces is
    // not news.
    const conflicted = viewerReducer(dirtyTab(), batch({ files: ['a.ts'] })).state;
    const saved = run(
      conflicted,
      { type: 'viewer/saveRequested', sessionId: 1, path: 'a.ts', requestId: 'rs' },
      { type: 'viewer/saved', sessionId: 1, path: 'a.ts', requestId: 'rs' },
    );

    expect(findTab(saved, 'a.ts')?.changedOnDisk).toBe(false);
  });
});

describe('closing a dirty tab', () => {
  it('closes a clean tab outright', () => {
    const result = viewerReducer(withTab(), {
      type: 'viewer/closeRequested',
      path: 'a.ts',
      dirty: false,
    });

    expect(result.state.tabs).toEqual([]);
  });

  it('does not close a dirty one', () => {
    const state = dirtyTab();

    const result = viewerReducer(state, {
      type: 'viewer/closeRequested',
      path: 'a.ts',
      dirty: true,
    });

    expect(result.state).toBe(state);
  });

  it('raises a confirmation for a dirty one, from the overlay slice', () => {
    // Two slices reacting independently to one action, neither reading the other.
    const result = overlayReducer(initialOverlayState, {
      type: 'viewer/closeRequested',
      path: 'a.ts',
      dirty: true,
    });

    expect(result.state.current).toEqual({
      type: 'confirm',
      intent: { kind: 'discardChanges', path: 'a.ts' },
    });
  });

  it('raises nothing for a clean one', () => {
    expect(
      overlayReducer(initialOverlayState, {
        type: 'viewer/closeRequested',
        path: 'a.ts',
        dirty: false,
      }).state,
    ).toBe(initialOverlayState);
  });

  it('releases the guard when the last dirty tab closes', () => {
    const result = viewerReducer(dirtyTab(), { type: 'viewer/closed', path: 'a.ts' });

    expect(result.effects).toEqual([{ type: 'app/setUnsaved', unsaved: false }]);
  });

  it('does not release the guard when a clean tab closes', () => {
    const result = viewerReducer(withTab(), { type: 'viewer/closed', path: 'a.ts' });

    expect(result.effects).toEqual([]);
  });
});

describe('quitting with unsaved work', () => {
  it('raises a confirmation naming the files', () => {
    const result = overlayReducer(initialOverlayState, {
      type: 'app/quitRequested',
      unsavedPaths: ['a.ts', 'b.ts'],
    });

    // "You have unsaved changes" with no list is not enough information to answer.
    expect(result.state.current).toEqual({
      type: 'confirm',
      intent: { kind: 'quitWithUnsaved', paths: ['a.ts', 'b.ts'] },
    });
  });

  it('raises nothing when nothing is unsaved', () => {
    expect(
      overlayReducer(initialOverlayState, { type: 'app/quitRequested', unsavedPaths: [] }).state,
    ).toBe(initialOverlayState);
  });

  it('tells main to proceed when the user confirms', () => {
    const asked = overlayReducer(initialOverlayState, {
      type: 'app/quitRequested',
      unsavedPaths: ['a.ts'],
    }).state;

    const result = overlayReducer(asked, { type: 'app/quitConfirmed' });

    expect(result.state.current).toBeNull();
    expect(result.effects).toEqual([{ type: 'app/confirmQuit' }]);
  });

  it('just closes the overlay when the user declines', () => {
    const asked = overlayReducer(initialOverlayState, {
      type: 'app/quitRequested',
      unsavedPaths: ['a.ts'],
    }).state;

    const result = overlayReducer(asked, { type: 'overlay/closed' });

    expect(result.state.current).toBeNull();
    expect(result.effects).toEqual([]);
  });
});
