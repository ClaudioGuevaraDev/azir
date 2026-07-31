import { describe, expect, it } from 'vitest';
import type { DirectoryEntry, WorkspaceInfo } from '@shared/ipc/contracts';
import type { Action } from '../actions';
import { initialRepositoryState, type RepositoryState } from '../repository';
import { repositoryReducer } from './repository';

const info: WorkspaceInfo = { sessionId: 1, root: '/work/repo', name: 'repo' };

const entry = (path: string, kind: DirectoryEntry['kind'] = 'file'): DirectoryEntry => ({
  path,
  name: path.split('/').pop() ?? path,
  kind,
});

const run = (state: RepositoryState, ...actions: Action[]): RepositoryState =>
  actions.reduce((current, action) => repositoryReducer(current, action).state, state);

/** Root loaded with `src/` and `package.json`. */
const withRoot = (): RepositoryState =>
  run(
    initialRepositoryState,
    { type: 'workspace/opened', requestId: 'r1', info },
    {
      type: 'repository/directoryLoaded',
      sessionId: 1,
      path: '',
      requestId: 'r1',
      entries: [entry('src', 'directory'), entry('package.json')],
    },
  );

describe('opening a workspace', () => {
  it('loads the root and git status, and nothing below the root', () => {
    const result = repositoryReducer(initialRepositoryState, {
      type: 'workspace/opened',
      requestId: 'r1',
      info,
    });

    expect(result.state.directories['']).toEqual({ status: 'loading' });
    // Requested independently: the spec requires that a missing git binary not
    // disable the file browser, so neither waits for the other.
    expect(result.effects).toEqual([
      { type: 'repository/listDirectory', sessionId: 1, path: '', requestId: 'r1' },
      { type: 'git/status', sessionId: 1, requestId: 'r1' },
    ]);
  });

  it('discards the previous workspace entirely', () => {
    const previous = run(withRoot(), { type: 'repository/selected', path: 'package.json' });

    const result = repositoryReducer(previous, {
      type: 'workspace/opened',
      requestId: 'r9',
      info: { ...info, sessionId: 2 },
    });

    expect(result.state.selectedPath).toBeNull();
    expect(Object.keys(result.state.directories)).toEqual(['']);
  });

  it('resets to the initial state when the workspace closes', () => {
    const result = repositoryReducer(withRoot(), { type: 'workspace/closed', sessionId: 1 });

    expect(result.state).toBe(initialRepositoryState);
  });

  it('preserves identity when closing an already-empty repository', () => {
    const result = repositoryReducer(initialRepositoryState, {
      type: 'workspace/closed',
      sessionId: 1,
    });

    expect(result.state).toBe(initialRepositoryState);
  });
});

describe('lazy loading', () => {
  it('expanding an unread directory requests it', () => {
    const result = repositoryReducer(withRoot(), {
      type: 'repository/toggled',
      sessionId: 1,
      path: 'src',
      requestId: 'r2',
    });

    expect(result.state.expanded['src']).toBe(true);
    expect(result.state.directories['src']).toEqual({ status: 'loading' });
    expect(result.effects).toEqual([
      { type: 'repository/listDirectory', sessionId: 1, path: 'src', requestId: 'r2' },
    ]);
  });

  it('reopening a directory costs no round trip', () => {
    const opened = run(
      withRoot(),
      { type: 'repository/toggled', sessionId: 1, path: 'src', requestId: 'r2' },
      {
        type: 'repository/directoryLoaded',
        sessionId: 1,
        path: 'src',
        requestId: 'r2',
        entries: [entry('src/index.ts')],
      },
      { type: 'repository/toggled', sessionId: 1, path: 'src', requestId: 'r3' },
    );

    const result = repositoryReducer(opened, {
      type: 'repository/toggled',
      sessionId: 1,
      path: 'src',
      requestId: 'r4',
    });

    expect(result.effects).toEqual([]);
    expect(result.state.expanded['src']).toBe(true);
  });

  it('collapsing keeps the children, so reopening is instant', () => {
    const opened = run(
      withRoot(),
      { type: 'repository/toggled', sessionId: 1, path: 'src', requestId: 'r2' },
      {
        type: 'repository/directoryLoaded',
        sessionId: 1,
        path: 'src',
        requestId: 'r2',
        entries: [entry('src/index.ts')],
      },
    );

    const collapsed = repositoryReducer(opened, {
      type: 'repository/toggled',
      sessionId: 1,
      path: 'src',
      requestId: 'r3',
    });

    expect(collapsed.state.expanded['src']).toBeUndefined();
    expect(collapsed.state.directories['src']).toEqual({
      status: 'loaded',
      children: [{ path: 'src/index.ts', name: 'index.ts', kind: 'file' }],
    });
  });

  it('ignores a collapse of something already collapsed', () => {
    const state = withRoot();

    expect(repositoryReducer(state, { type: 'repository/collapsed', path: 'src' }).state).toBe(
      state,
    );
  });
});

describe('refresh', () => {
  it('keeps the current children visible while reloading', () => {
    // Blanking to a spinner on every watcher tick would make the panel flicker
    // constantly once M5 lands.
    const opened = run(withRoot(), {
      type: 'repository/directoryRequested',
      sessionId: 1,
      path: '',
      requestId: 'r5',
    });

    expect(opened.directories['']?.status).toBe('loaded');
    expect(opened.pending['']).toBe('r5');
  });

  it('shows a spinner when refreshing something never read', () => {
    const result = repositoryReducer(withRoot(), {
      type: 'repository/directoryRequested',
      sessionId: 1,
      path: 'src',
      requestId: 'r5',
    });

    expect(result.state.directories['src']).toEqual({ status: 'loading' });
  });
});

describe('stale responses', () => {
  it('drops a response whose request has been superseded', () => {
    // Expand, then refresh before the first answer arrives. The stale one must not
    // overwrite the newer request's slot.
    const state = run(withRoot(), {
      type: 'repository/toggled',
      sessionId: 1,
      path: 'src',
      requestId: 'r2',
    });
    const refreshed = run(state, {
      type: 'repository/directoryRequested',
      sessionId: 1,
      path: 'src',
      requestId: 'r3',
    });

    const result = repositoryReducer(refreshed, {
      type: 'repository/directoryLoaded',
      sessionId: 1,
      path: 'src',
      requestId: 'r2',
      entries: [entry('src/stale.ts')],
    });

    expect(result.state).toBe(refreshed);
  });

  it('accepts the response that matches', () => {
    const state = run(withRoot(), {
      type: 'repository/toggled',
      sessionId: 1,
      path: 'src',
      requestId: 'r2',
    });

    const result = repositoryReducer(state, {
      type: 'repository/directoryLoaded',
      sessionId: 1,
      path: 'src',
      requestId: 'r2',
      entries: [entry('src/index.ts')],
    });

    expect(result.state.directories['src']).toMatchObject({ status: 'loaded' });
    expect(result.state.pending['src']).toBeUndefined();
  });

  it('drops a superseded failure, so an old error cannot mask a live load', () => {
    const state = run(withRoot(), {
      type: 'repository/toggled',
      sessionId: 1,
      path: 'src',
      requestId: 'r2',
    });
    const refreshed = run(state, {
      type: 'repository/directoryRequested',
      sessionId: 1,
      path: 'src',
      requestId: 'r3',
    });

    const result = repositoryReducer(refreshed, {
      type: 'repository/directoryFailed',
      sessionId: 1,
      path: 'src',
      requestId: 'r2',
      error: { code: 'permission-denied', message: 'nope' },
    });

    expect(result.state).toBe(refreshed);
  });

  it('ignores a response for a directory with nothing in flight', () => {
    const state = withRoot();

    const result = repositoryReducer(state, {
      type: 'repository/directoryLoaded',
      sessionId: 1,
      path: 'never-requested',
      requestId: 'rX',
      entries: [],
    });

    expect(result.state).toBe(state);
  });
});

describe('failures', () => {
  it('records the error as a state on that directory only', () => {
    const state = run(withRoot(), {
      type: 'repository/toggled',
      sessionId: 1,
      path: 'src',
      requestId: 'r2',
    });

    const result = repositoryReducer(state, {
      type: 'repository/directoryFailed',
      sessionId: 1,
      path: 'src',
      requestId: 'r2',
      error: { code: 'permission-denied', message: 'That folder could not be read.' },
    });

    expect(result.state.directories['src']).toMatchObject({ status: 'failed' });
    // The rest of the tree is untouched, which is invariant 13 at slice level.
    expect(result.state.directories['']).toMatchObject({ status: 'loaded' });
  });
});

describe('selection', () => {
  it('is a path, never a row index', () => {
    const result = repositoryReducer(withRoot(), {
      type: 'repository/selected',
      path: 'package.json',
    });

    expect(result.state.selectedPath).toBe('package.json');
  });

  it('preserves identity when reselecting the same path', () => {
    const selected = run(withRoot(), { type: 'repository/selected', path: 'package.json' });

    expect(
      repositoryReducer(selected, { type: 'repository/selected', path: 'package.json' }).state,
    ).toBe(selected);
  });

  it('survives a refresh that still contains the selected path', () => {
    const selected = run(
      withRoot(),
      { type: 'repository/selected', path: 'package.json' },
      { type: 'repository/directoryRequested', sessionId: 1, path: '', requestId: 'r5' },
    );

    const result = repositoryReducer(selected, {
      type: 'repository/directoryLoaded',
      sessionId: 1,
      path: '',
      requestId: 'r5',
      entries: [entry('src', 'directory'), entry('package.json')],
    });

    expect(result.state.selectedPath).toBe('package.json');
  });

  it('is cleared by a refresh that removed the selected path', () => {
    const selected = run(
      withRoot(),
      { type: 'repository/selected', path: 'package.json' },
      { type: 'repository/directoryRequested', sessionId: 1, path: '', requestId: 'r5' },
    );

    const result = repositoryReducer(selected, {
      type: 'repository/directoryLoaded',
      sessionId: 1,
      path: '',
      requestId: 'r5',
      entries: [entry('src', 'directory')],
    });

    // Leaving the highlight on a deleted file would be worse than losing the place.
    expect(result.state.selectedPath).toBeNull();
  });

  it('is not cleared when an unrelated directory is refreshed', () => {
    const selected = run(
      withRoot(),
      { type: 'repository/selected', path: 'src/deep/file.ts' },
      { type: 'repository/toggled', sessionId: 1, path: 'src', requestId: 'r6' },
    );

    const result = repositoryReducer(selected, {
      type: 'repository/directoryLoaded',
      sessionId: 1,
      path: 'src',
      requestId: 'r6',
      entries: [entry('src/deep', 'directory')],
    });

    // `src/deep` has not been read, so `src/deep/file.ts` is unknown, not gone.
    expect(result.state.selectedPath).toBe('src/deep/file.ts');
  });
});

describe('view', () => {
  it('switches between the tree and changes projections', () => {
    const result = repositoryReducer(withRoot(), {
      type: 'repository/viewChanged',
      view: 'changes',
    });

    expect(result.state.view).toBe('changes');
  });

  it('preserves identity when the view is unchanged', () => {
    const state = withRoot();

    expect(repositoryReducer(state, { type: 'repository/viewChanged', view: 'tree' }).state).toBe(
      state,
    );
  });
});
