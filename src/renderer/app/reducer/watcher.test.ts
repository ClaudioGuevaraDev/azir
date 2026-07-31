import { describe, expect, it } from 'vitest';
import type { FsChangeBatch, WorkspaceInfo } from '@shared/ipc/contracts';
import type { Action } from '../actions';
import { initialRepositoryState, type RepositoryState } from '../repository';
import { repositoryReducer } from './repository';

/**
 * The reducer's response to a watcher batch.
 *
 * docs/architecture.md asks for a *targeted* response rather than a full refresh:
 * refresh git status, rescan affected directories that are already expanded, and
 * invalidate rather than eagerly reload. These tests pin each of those, because the
 * failure mode of getting it wrong is not a broken feature — it is a panel that does
 * thousands of pointless reads during an `npm install`.
 */

const info: WorkspaceInfo = { sessionId: 1, root: '/work/repo', name: 'repo' };

const batch = (overrides: Partial<FsChangeBatch> = {}): FsChangeBatch => ({
  sessionId: 1,
  directories: [],
  files: [],
  gitDirty: false,
  truncated: false,
  ...overrides,
});

const changed = (
  fsBatch: FsChangeBatch,
  directoryRequestIds: Record<string, string> = {},
): Action => ({
  type: 'fs/changed',
  sessionId: 1,
  batch: fsBatch,
  gitRequestId: 'rg',
  directoryRequestIds,
});

const run = (state: RepositoryState, ...actions: Action[]): RepositoryState =>
  actions.reduce((current, action) => repositoryReducer(current, action).state, state);

/** Root and `src` loaded; `src/deep` known about but never opened. */
const loaded = (): RepositoryState =>
  run(
    initialRepositoryState,
    { type: 'workspace/opened', requestId: 'r1', info },
    {
      type: 'repository/directoryLoaded',
      sessionId: 1,
      path: '',
      requestId: 'r1',
      entries: [
        { path: 'src', name: 'src', kind: 'directory' },
        { path: 'README.md', name: 'README.md', kind: 'file' },
      ],
    },
    { type: 'repository/toggled', sessionId: 1, path: 'src', requestId: 'r2' },
    {
      type: 'repository/directoryLoaded',
      sessionId: 1,
      path: 'src',
      requestId: 'r2',
      entries: [{ path: 'src/deep', name: 'deep', kind: 'directory' }],
    },
    {
      type: 'git/refreshed',
      sessionId: 1,
      requestId: 'r1',
      snapshot: {
        branch: {
          head: 'main',
          commit: 'abc',
          upstream: null,
          ahead: 0,
          behind: 0,
          detached: false,
        },
        files: [],
      },
    },
  );

const effectsOf = (state: RepositoryState, action: Action) =>
  repositoryReducer(state, action).effects;

/**
 * Drives git into a failure state through the real transitions.
 *
 * A `git/refreshFailed` only lands while a refresh is actually in flight — the
 * staleness gate drops it otherwise — so the request has to be made first. Skipping
 * that step leaves git in `ready` and makes an assertion pass for the wrong reason.
 */
const withGitFailure = (
  state: RepositoryState,
  code: 'not-a-repository' | 'timed-out',
): RepositoryState =>
  run(
    state,
    { type: 'git/refreshRequested', sessionId: 1, requestId: 'rfail' },
    {
      type: 'git/refreshFailed',
      sessionId: 1,
      requestId: 'rfail',
      error: { code, message: code },
    },
  );

describe('rescanning', () => {
  it('reloads a directory that is loaded', () => {
    const effects = effectsOf(loaded(), changed(batch({ directories: ['src'] }), { src: 'rd' }));

    expect(effects).toContainEqual({
      type: 'repository/listDirectory',
      sessionId: 1,
      path: 'src',
      requestId: 'rd',
    });
  });

  it('does not reload a directory the user has never opened', () => {
    // `src/deep` exists in the tree as a row but has never been read. Reloading it
    // would do filesystem work to update something invisible — and during an install
    // that is thousands of directories.
    const effects = effectsOf(
      loaded(),
      changed(batch({ directories: ['src/deep'] }), { 'src/deep': 'rd' }),
    );

    expect(effects.filter((effect) => effect.type === 'repository/listDirectory')).toEqual([]);
  });

  it('does not reload a directory outside the tree entirely', () => {
    const effects = effectsOf(
      loaded(),
      changed(batch({ directories: ['node_modules/pkg'] }), { 'node_modules/pkg': 'rd' }),
    );

    expect(effects.filter((effect) => effect.type === 'repository/listDirectory')).toEqual([]);
  });

  it('does not reload for a content change, which leaves the listing intact', () => {
    const effects = effectsOf(loaded(), changed(batch({ files: ['src/index.ts'] })));

    expect(effects.filter((effect) => effect.type === 'repository/listDirectory')).toEqual([]);
  });

  it('records the reload as pending, so a superseded answer can be dropped', () => {
    const result = run(loaded(), changed(batch({ directories: ['src'] }), { src: 'rd' }));

    expect(result.pending['src']).toBe('rd');
  });

  it('does not retry a directory that failed to load', () => {
    // Otherwise a permission error would be retried on every save, forever.
    const failed = run(
      loaded(),
      { type: 'repository/directoryRequested', sessionId: 1, path: 'src', requestId: 'r5' },
      {
        type: 'repository/directoryFailed',
        sessionId: 1,
        path: 'src',
        requestId: 'r5',
        error: { code: 'permission-denied', message: 'nope' },
      },
    );

    const effects = effectsOf(failed, changed(batch({ directories: ['src'] }), { src: 'rd' }));

    expect(effects.filter((effect) => effect.type === 'repository/listDirectory')).toEqual([]);
  });

  it('skips a directory with no pre-minted id rather than inventing one', () => {
    // The reducer must stay pure, so it cannot mint. A missing id means no reload.
    const effects = effectsOf(loaded(), changed(batch({ directories: ['src'] }), {}));

    expect(effects.filter((effect) => effect.type === 'repository/listDirectory')).toEqual([]);
  });
});

describe('git refresh', () => {
  it('refreshes on a .git write', () => {
    const effects = effectsOf(loaded(), changed(batch({ gitDirty: true })));

    expect(effects).toContainEqual({ type: 'git/status', sessionId: 1, requestId: 'rg' });
  });

  it('refreshes on an ordinary file edit too', () => {
    // Editing a tracked file changes its status without touching `.git`, so waiting for
    // a `.git` write would leave the badges wrong until the next commit.
    const effects = effectsOf(loaded(), changed(batch({ files: ['src/index.ts'] })));

    expect(effects).toContainEqual({ type: 'git/status', sessionId: 1, requestId: 'rg' });
  });

  it('refreshes on a directory change', () => {
    const effects = effectsOf(loaded(), changed(batch({ directories: ['src'] }), { src: 'rd' }));

    expect(effects).toContainEqual({ type: 'git/status', sessionId: 1, requestId: 'rg' });
  });

  it('does not refresh when git is permanently unavailable', () => {
    // Asking again every time a file is saved, in a folder that is not a repository,
    // would spawn a git process per keystroke for an answer that cannot change.
    const noGit = withGitFailure(loaded(), 'not-a-repository');
    expect(noGit.git.status).toBe('unavailable');

    const effects = effectsOf(noGit, changed(batch({ files: ['a.ts'] })));

    expect(effects).toEqual([]);
  });

  it('does refresh after a transient failure', () => {
    const transient = withGitFailure(loaded(), 'timed-out');
    expect(transient.git.status).toBe('error');

    const effects = effectsOf(transient, changed(batch({ files: ['a.ts'] })));

    expect(effects).toContainEqual({ type: 'git/status', sessionId: 1, requestId: 'rg' });
  });

  it('tracks the in-flight git request for staleness', () => {
    const result = run(loaded(), changed(batch({ gitDirty: true })));

    expect(result.gitRequestId).toBe('rg');
  });
});

describe('truncated batches', () => {
  it('reloads everything already loaded rather than a path list it knows is short', () => {
    const effects = effectsOf(
      loaded(),
      changed(batch({ truncated: true }), { '': 'ra', src: 'rb' }),
    );

    const reloaded = effects
      .filter((effect) => effect.type === 'repository/listDirectory')
      .map((effect) => (effect.type === 'repository/listDirectory' ? effect.path : ''));

    expect(new Set(reloaded)).toEqual(new Set(['', 'src']));
  });

  it('still does not reload directories that were never opened', () => {
    const effects = effectsOf(
      loaded(),
      changed(batch({ truncated: true }), { '': 'ra', src: 'rb', 'src/deep': 'rc' }),
    );

    const reloaded = effects
      .filter((effect) => effect.type === 'repository/listDirectory')
      .map((effect) => (effect.type === 'repository/listDirectory' ? effect.path : ''));

    expect(reloaded).not.toContain('src/deep');
  });

  it('refreshes git', () => {
    const effects = effectsOf(loaded(), changed(batch({ truncated: true })));

    expect(effects).toContainEqual({ type: 'git/status', sessionId: 1, requestId: 'rg' });
  });
});

describe('an empty batch', () => {
  it('changes nothing and requests nothing', () => {
    const state = loaded();

    const result = repositoryReducer(state, changed(batch()));

    expect(result.state).toBe(state);
    expect(result.effects).toEqual([]);
  });
});
