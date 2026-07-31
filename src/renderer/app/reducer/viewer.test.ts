import { describe, expect, it } from 'vitest';
import type { FileDiff, FsChangeBatch, ReadFileResponse } from '@shared/ipc/contracts';
import type { Action } from '../actions';
import { findTab, initialViewerState, MAX_TABS, type ViewerState } from '../viewer';
import { viewerReducer } from './viewer';

const response = (path: string, content = 'line one\nline two\n'): ReadFileResponse => ({
  path,
  content,
  eol: 'lf',
  hadBom: false,
  byteSize: content.length,
});

const emptyDiff = (path: string): FileDiff => ({
  path,
  target: 'worktree',
  binary: false,
  hunks: [],
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

/** One tab open on `a.ts`, content loaded. */
const withTab = (): ViewerState =>
  run(initialViewerState, open('a.ts', 'r1'), loaded('a.ts', 'r1'));

describe('opening', () => {
  it('adds a tab, activates it and requests the content', () => {
    const result = viewerReducer(initialViewerState, open('a.ts', 'r1'));

    expect(result.state.tabs.map((tab) => tab.path)).toEqual(['a.ts']);
    expect(result.state.activePath).toBe('a.ts');
    expect(result.effects).toEqual([
      { type: 'viewer/readFile', sessionId: 1, path: 'a.ts', requestId: 'r1' },
    ]);
  });

  it('splits the content into lines, keeping the trailing empty one', () => {
    // A file ending in a newline does have an empty last line; dropping it would make the
    // line count disagree with every other tool.
    const state = withTab();
    const tab = findTab(state, 'a.ts');

    expect(tab?.content.status).toBe('ready');
    if (tab?.content.status !== 'ready') {
      throw new Error('unreachable');
    }
    expect(tab.content.value.lines).toEqual(['line one', 'line two', '']);
  });

  it('strips CR so a CRLF file does not show a stray character per line', () => {
    const state = run(
      initialViewerState,
      open('a.ts', 'r1'),
      loaded('a.ts', 'r1', 'one\r\ntwo\r\n'),
    );
    const tab = findTab(state, 'a.ts');

    if (tab?.content.status !== 'ready') {
      throw new Error('unreachable');
    }
    expect(tab.content.value.lines).toEqual(['one', 'two', '']);
  });

  it('does not open a duplicate tab for a file already open', () => {
    const state = run(withTab(), open('b.ts', 'r2'), loaded('b.ts', 'r2'));

    const result = viewerReducer(state, open('a.ts', 'r3'));

    expect(result.state.tabs).toHaveLength(2);
    expect(result.state.activePath).toBe('a.ts');
    expect(result.effects).toEqual([]);
  });

  it('does nothing when the active tab is reopened', () => {
    const state = withTab();

    expect(viewerReducer(state, open('a.ts', 'r9')).state).toBe(state);
  });

  it('reloads a stale tab when it is reopened', () => {
    // Order matters: `a.ts` has to be in the *background* when the batch arrives,
    // otherwise it is reloaded on the spot and never becomes stale at all.
    const backgrounded = run(withTab(), open('b.ts', 'r2'), loaded('b.ts', 'r2'), {
      type: 'fs/changed',
      sessionId: 1,
      batch: { sessionId: 1, directories: [], files: ['a.ts'], gitDirty: false, truncated: false },
      gitRequestId: 'rg',
      directoryRequestIds: {},
      viewerContentRequestId: 'rvc',
      viewerDiffRequestId: 'rvd',
    });
    expect(findTab(backgrounded, 'a.ts')?.stale).toBe(true);

    const result = viewerReducer(backgrounded, open('a.ts', 'r4'));

    expect(findTab(result.state, 'a.ts')?.stale).toBe(false);
    expect(result.effects).toContainEqual({
      type: 'viewer/readFile',
      sessionId: 1,
      path: 'a.ts',
      requestId: 'r4',
    });
  });

  it('evicts the oldest tab at the ceiling', () => {
    let state = initialViewerState;
    for (let index = 0; index < MAX_TABS; index += 1) {
      state = run(state, open(`f${index}.ts`, `r${index}`));
    }

    const result = viewerReducer(state, open('overflow.ts', 'rX'));

    expect(result.state.tabs).toHaveLength(MAX_TABS);
    expect(result.state.tabs[0]?.path).toBe('f1.ts');
    expect(result.state.tabs[MAX_TABS - 1]?.path).toBe('overflow.ts');
  });
});

describe('stale response rejection', () => {
  it('drops a content response whose request was superseded', () => {
    // Click a file, then a watcher reload starts before the first read answers. The
    // slower answer must not win.
    const superseded = run(withTab(), {
      type: 'viewer/activated',
      sessionId: 1,
      path: 'a.ts',
      contentRequestId: 'r5',
      diffRequestId: 'r6',
    });

    // Nothing in flight after that (the tab was not stale), so an old id is stale.
    const result = viewerReducer(superseded, loaded('a.ts', 'r1', 'stale content'));

    expect(result.state).toBe(superseded);
  });

  it('accepts the response that matches', () => {
    const opened = viewerReducer(initialViewerState, open('a.ts', 'r1')).state;

    const result = viewerReducer(opened, loaded('a.ts', 'r1'));

    expect(findTab(result.state, 'a.ts')?.content.status).toBe('ready');
  });

  it('drops a response for a tab that has been closed, rather than resurrecting it', () => {
    const opened = viewerReducer(initialViewerState, open('a.ts', 'r1')).state;
    const closed = run(opened, { type: 'viewer/closed', path: 'a.ts' });

    const result = viewerReducer(closed, loaded('a.ts', 'r1'));

    expect(result.state.tabs).toEqual([]);
  });

  it('drops a superseded failure, so an old error cannot mask live content', () => {
    const state = withTab();

    const result = viewerReducer(state, {
      type: 'viewer/contentFailed',
      sessionId: 1,
      path: 'a.ts',
      requestId: 'r1',
      error: { code: 'not-found', message: 'gone' },
    });

    // `r1` was already answered, so `contentRequestId` is null and this is stale.
    expect(result.state).toBe(state);
  });

  it('drops a diff response for the wrong request', () => {
    const inDiff = run(withTab(), {
      type: 'viewer/modeChanged',
      sessionId: 1,
      path: 'a.ts',
      mode: 'diff',
      requestId: 'rd1',
    });

    const result = viewerReducer(inDiff, {
      type: 'viewer/diffLoaded',
      sessionId: 1,
      path: 'a.ts',
      requestId: 'rd-other',
      diff: emptyDiff('a.ts'),
    });

    expect(result.state).toBe(inDiff);
  });

  it('drops a diff response for a tab that never asked for one', () => {
    const state = withTab();

    const result = viewerReducer(state, {
      type: 'viewer/diffLoaded',
      sessionId: 1,
      path: 'a.ts',
      requestId: 'rd1',
      diff: emptyDiff('a.ts'),
    });

    expect(result.state).toBe(state);
  });

  it('drops a response for a path with no tab at all', () => {
    const state = withTab();

    expect(viewerReducer(state, loaded('never-opened.ts', 'rX')).state).toBe(state);
  });
});

describe('failures stay visible', () => {
  it('keeps the tab open showing why a file could not be read', () => {
    const opened = viewerReducer(initialViewerState, open('huge.bin', 'r1')).state;

    const result = viewerReducer(opened, {
      type: 'viewer/contentFailed',
      sessionId: 1,
      path: 'huge.bin',
      requestId: 'r1',
      error: { code: 'too-large', message: 'That file is 4096 KB…' },
    });

    // Closing the tab the user just clicked would hide the reason.
    expect(result.state.tabs).toHaveLength(1);
    expect(findTab(result.state, 'huge.bin')?.content).toMatchObject({ status: 'error' });
  });
});

describe('diff on demand', () => {
  it('does not request a diff when a file is opened', () => {
    // Performance rule 5: diffs are loaded only when viewed.
    const result = viewerReducer(initialViewerState, open('a.ts', 'r1'));

    expect(result.effects.some((effect) => effect.type === 'viewer/readDiff')).toBe(false);
  });

  it('requests it the first time diff mode is entered', () => {
    const result = viewerReducer(withTab(), {
      type: 'viewer/modeChanged',
      sessionId: 1,
      path: 'a.ts',
      mode: 'diff',
      requestId: 'rd1',
    });

    expect(result.effects).toEqual([
      { type: 'viewer/readDiff', sessionId: 1, path: 'a.ts', target: 'worktree', requestId: 'rd1' },
    ]);
  });

  it('does not request it again on a second visit', () => {
    const withDiff = run(
      withTab(),
      { type: 'viewer/modeChanged', sessionId: 1, path: 'a.ts', mode: 'diff', requestId: 'rd1' },
      {
        type: 'viewer/diffLoaded',
        sessionId: 1,
        path: 'a.ts',
        requestId: 'rd1',
        diff: emptyDiff('a.ts'),
      },
      { type: 'viewer/modeChanged', sessionId: 1, path: 'a.ts', mode: 'code', requestId: 'rd2' },
    );

    const result = viewerReducer(withDiff, {
      type: 'viewer/modeChanged',
      sessionId: 1,
      path: 'a.ts',
      mode: 'diff',
      requestId: 'rd3',
    });

    expect(result.effects).toEqual([]);
  });

  it('ignores a mode change to the mode already showing', () => {
    const state = withTab();

    expect(
      viewerReducer(state, {
        type: 'viewer/modeChanged',
        sessionId: 1,
        path: 'a.ts',
        mode: 'code',
        requestId: 'rd1',
      }).state,
    ).toBe(state);
  });

  it('refetches when the diff target changes', () => {
    const inDiff = run(withTab(), {
      type: 'viewer/modeChanged',
      sessionId: 1,
      path: 'a.ts',
      mode: 'diff',
      requestId: 'rd1',
    });

    const result = viewerReducer(inDiff, {
      type: 'viewer/diffTargetChanged',
      sessionId: 1,
      path: 'a.ts',
      target: 'staged',
      requestId: 'rd2',
    });

    expect(result.effects).toEqual([
      { type: 'viewer/readDiff', sessionId: 1, path: 'a.ts', target: 'staged', requestId: 'rd2' },
    ]);
    // The old diff's scroll position means nothing against different content.
    expect(findTab(result.state, 'a.ts')?.diffTop).toBe(0);
  });
});

describe('viewports', () => {
  it('keeps a separate scroll offset per mode', () => {
    // The two have unrelated line counts; one shared offset would land somewhere
    // arbitrary when switching.
    const scrolled = run(
      withTab(),
      { type: 'viewer/scrolled', path: 'a.ts', mode: 'code', top: 420 },
      { type: 'viewer/scrolled', path: 'a.ts', mode: 'diff', top: 90 },
    );

    expect(findTab(scrolled, 'a.ts')).toMatchObject({ codeTop: 420, diffTop: 90 });
  });

  it('survives switching modes and back', () => {
    const state = run(
      withTab(),
      { type: 'viewer/scrolled', path: 'a.ts', mode: 'code', top: 420 },
      { type: 'viewer/modeChanged', sessionId: 1, path: 'a.ts', mode: 'diff', requestId: 'rd1' },
      { type: 'viewer/modeChanged', sessionId: 1, path: 'a.ts', mode: 'code', requestId: 'rd2' },
    );

    expect(findTab(state, 'a.ts')?.codeTop).toBe(420);
  });

  it('preserves identity when the offset did not move', () => {
    const state = withTab();

    expect(
      viewerReducer(state, { type: 'viewer/scrolled', path: 'a.ts', mode: 'code', top: 0 }).state,
    ).toBe(state);
  });
});

describe('closing', () => {
  it('moves focus rightwards', () => {
    const three = run(
      initialViewerState,
      open('a.ts', 'r1'),
      open('b.ts', 'r2'),
      open('c.ts', 'r3'),
      {
        type: 'viewer/activated',
        sessionId: 1,
        path: 'b.ts',
        contentRequestId: 'x',
        diffRequestId: 'y',
      },
    );

    const result = viewerReducer(three, { type: 'viewer/closed', path: 'b.ts' });

    expect(result.state.activePath).toBe('c.ts');
  });

  it('falls back leftwards when the last tab is closed', () => {
    const two = run(initialViewerState, open('a.ts', 'r1'), open('b.ts', 'r2'));

    const result = viewerReducer(two, { type: 'viewer/closed', path: 'b.ts' });

    expect(result.state.activePath).toBe('a.ts');
  });

  it('clears the active path when nothing is left', () => {
    const result = viewerReducer(withTab(), { type: 'viewer/closed', path: 'a.ts' });

    expect(result.state).toEqual({ tabs: [], activePath: null });
  });

  it('leaves focus alone when closing an inactive tab', () => {
    const two = run(initialViewerState, open('a.ts', 'r1'), open('b.ts', 'r2'));

    const result = viewerReducer(two, { type: 'viewer/closed', path: 'a.ts' });

    expect(result.state.activePath).toBe('b.ts');
  });

  it('ignores closing a tab that is not open', () => {
    const state = withTab();

    expect(viewerReducer(state, { type: 'viewer/closed', path: 'nope.ts' }).state).toBe(state);
  });
});

describe('reacting to the watcher', () => {
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

  it('reloads the active tab immediately', () => {
    const result = viewerReducer(withTab(), batch({ files: ['a.ts'] }));

    expect(result.effects).toContainEqual({
      type: 'viewer/readFile',
      sessionId: 1,
      path: 'a.ts',
      requestId: 'rvc',
    });
    expect(findTab(result.state, 'a.ts')?.content.status).toBe('loading');
  });

  it('only marks a background tab, rather than re-reading it', () => {
    // Rule 6. During a checkout this is the difference between reading one file and
    // reading all of them.
    const two = run(withTab(), open('b.ts', 'r2'), loaded('b.ts', 'r2'));

    const result = viewerReducer(two, batch({ files: ['a.ts'] }));

    expect(findTab(result.state, 'a.ts')?.stale).toBe(true);
    expect(findTab(result.state, 'a.ts')?.content.status).toBe('ready');
    expect(result.effects).toEqual([]);
  });

  it('re-reads a stale background tab when it is activated', () => {
    const two = run(
      withTab(),
      open('b.ts', 'r2'),
      loaded('b.ts', 'r2'),
      batch({ files: ['a.ts'] }),
    );

    const result = viewerReducer(two, {
      type: 'viewer/activated',
      sessionId: 1,
      path: 'a.ts',
      contentRequestId: 'rc',
      diffRequestId: 'rd',
    });

    expect(result.effects).toContainEqual({
      type: 'viewer/readFile',
      sessionId: 1,
      path: 'a.ts',
      requestId: 'rc',
    });
    expect(findTab(result.state, 'a.ts')?.stale).toBe(false);
  });

  it('refetches the diff too when the active tab is showing one', () => {
    const inDiff = run(
      withTab(),
      { type: 'viewer/modeChanged', sessionId: 1, path: 'a.ts', mode: 'diff', requestId: 'rd1' },
      {
        type: 'viewer/diffLoaded',
        sessionId: 1,
        path: 'a.ts',
        requestId: 'rd1',
        diff: emptyDiff('a.ts'),
      },
    );

    const result = viewerReducer(inDiff, batch({ files: ['a.ts'] }));

    expect(result.effects).toContainEqual({
      type: 'viewer/readDiff',
      sessionId: 1,
      path: 'a.ts',
      target: 'worktree',
      requestId: 'rvd',
    });
  });

  it('discards a cached diff for a changed tab showing code', () => {
    // Keeping it would show a diff of the previous contents next time the user switched.
    const withCachedDiff = run(
      withTab(),
      { type: 'viewer/modeChanged', sessionId: 1, path: 'a.ts', mode: 'diff', requestId: 'rd1' },
      {
        type: 'viewer/diffLoaded',
        sessionId: 1,
        path: 'a.ts',
        requestId: 'rd1',
        diff: emptyDiff('a.ts'),
      },
      { type: 'viewer/modeChanged', sessionId: 1, path: 'a.ts', mode: 'code', requestId: 'rd2' },
    );

    const result = viewerReducer(withCachedDiff, batch({ files: ['a.ts'] }));

    expect(findTab(result.state, 'a.ts')?.diff.status).toBe('idle');
  });

  it('ignores a batch that touched no open file', () => {
    const state = withTab();

    expect(viewerReducer(state, batch({ files: ['elsewhere.ts'] })).state).toBe(state);
  });

  it('treats every tab as suspect when the batch was truncated', () => {
    const two = run(withTab(), open('b.ts', 'r2'), loaded('b.ts', 'r2'));

    const result = viewerReducer(two, batch({ truncated: true }));

    expect(findTab(result.state, 'a.ts')?.stale).toBe(true);
    expect(findTab(result.state, 'b.ts')?.content.status).toBe('loading');
  });

  it('does not re-mark a tab that is already stale', () => {
    const two = run(
      withTab(),
      open('b.ts', 'r2'),
      loaded('b.ts', 'r2'),
      batch({ files: ['a.ts'] }),
    );

    expect(viewerReducer(two, batch({ files: ['a.ts'] })).state).toBe(two);
  });
});

describe('workspace disposal', () => {
  it('closes every tab', () => {
    const result = viewerReducer(withTab(), { type: 'workspace/closed', sessionId: 1 });

    expect(result.state).toBe(initialViewerState);
  });

  it('preserves identity when nothing was open', () => {
    expect(
      viewerReducer(initialViewerState, { type: 'workspace/closed', sessionId: 1 }).state,
    ).toBe(initialViewerState);
  });
});
