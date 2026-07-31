import { beforeEach, describe, expect, it } from 'vitest';
import type { GitFileStatus, GitStatusResponse, WorkspaceInfo } from '@shared/ipc/contracts';
import type { Action } from '../actions';
import {
  initialRepositoryState,
  resetRepositoryProjectionCache,
  selectRepositoryRows,
  type RepositoryState,
} from '../repository';
import { repositoryReducer } from './repository';

/**
 * Git's half of the repository projection, and the property the spec cares about most
 * here: a git failure must not take the file browser with it.
 */

const info: WorkspaceInfo = { sessionId: 1, root: '/work/repo', name: 'repo' };

const status = (overrides: Partial<GitFileStatus> & { path: string }): GitFileStatus => ({
  staged: null,
  unstaged: 'modified',
  conflicted: false,
  ...overrides,
});

const snapshot = (files: GitFileStatus[]): GitStatusResponse => ({
  branch: {
    head: 'main',
    commit: 'abc123',
    upstream: 'origin/main',
    ahead: 1,
    behind: 0,
    detached: false,
  },
  files,
});

const run = (state: RepositoryState, ...actions: Action[]): RepositoryState =>
  actions.reduce((current, action) => repositoryReducer(current, action).state, state);

/** Root loaded, git refresh in flight under request `r1`. */
const opened = (): RepositoryState =>
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
  );

beforeEach(() => {
  resetRepositoryProjectionCache();
});

describe('refreshing', () => {
  it('stores the snapshot and indexes it by path', () => {
    const result = run(opened(), {
      type: 'git/refreshed',
      sessionId: 1,
      requestId: 'r1',
      snapshot: snapshot([status({ path: 'README.md' })]),
    });

    expect(result.git.status).toBe('ready');
    if (result.git.status !== 'ready') {
      throw new Error('unreachable');
    }
    expect(result.git.branch.head).toBe('main');
    expect(result.git.byPath['README.md']?.unstaged).toBe('modified');
  });

  it('indexes a rename by its destination only', () => {
    // The source of a copy is unchanged, so badging it would claim a file was modified
    // when it was not; the source of a rename no longer exists on disk, so there is no
    // row to badge either way. `originalPath` is carried on the change itself and shown
    // in the destination's tooltip.
    const result = run(opened(), {
      type: 'git/refreshed',
      sessionId: 1,
      requestId: 'r1',
      snapshot: snapshot([
        status({ path: 'new.ts', staged: 'renamed', unstaged: null, originalPath: 'old.ts' }),
      ]),
    });

    if (result.git.status !== 'ready') {
      throw new Error('unreachable');
    }
    expect(result.git.byPath['new.ts']?.originalPath).toBe('old.ts');
    expect(result.git.byPath['old.ts']).toBeUndefined();
  });

  it('keeps the previous snapshot visible while refreshing', () => {
    // Blanking the badges on every watcher tick would make the tree strobe.
    const ready = run(opened(), {
      type: 'git/refreshed',
      sessionId: 1,
      requestId: 'r1',
      snapshot: snapshot([status({ path: 'README.md' })]),
    });

    const refreshing = run(ready, {
      type: 'git/refreshRequested',
      sessionId: 1,
      requestId: 'r2',
    });

    expect(refreshing.git.status).toBe('ready');
    expect(refreshing.gitRequestId).toBe('r2');
  });

  it('emits a status effect on refresh', () => {
    const result = repositoryReducer(opened(), {
      type: 'git/refreshRequested',
      sessionId: 1,
      requestId: 'r2',
    });

    expect(result.effects).toEqual([{ type: 'git/status', sessionId: 1, requestId: 'r2' }]);
  });

  it('drops a superseded snapshot', () => {
    const refreshing = run(opened(), {
      type: 'git/refreshRequested',
      sessionId: 1,
      requestId: 'r2',
    });

    const result = repositoryReducer(refreshing, {
      type: 'git/refreshed',
      sessionId: 1,
      requestId: 'r1',
      snapshot: snapshot([status({ path: 'stale.ts' })]),
    });

    expect(result.state).toBe(refreshing);
  });
});

describe('failures keep the file browser usable', () => {
  it('treats a missing git binary as permanent for this workspace', () => {
    const result = run(opened(), {
      type: 'git/refreshFailed',
      sessionId: 1,
      requestId: 'r1',
      error: { code: 'git-missing', message: 'git is not installed, or not on PATH.' },
    });

    // `unavailable` rather than `error`, so the UI stops offering a retry it knows
    // will fail.
    expect(result.git.status).toBe('unavailable');
  });

  it('treats a non-repository the same way', () => {
    const result = run(opened(), {
      type: 'git/refreshFailed',
      sessionId: 1,
      requestId: 'r1',
      error: { code: 'not-a-repository', message: 'This folder is not a git repository.' },
    });

    expect(result.git.status).toBe('unavailable');
  });

  it.each(['timed-out', 'internal', 'permission-denied'] as const)(
    'treats %s as transient and retryable',
    (code) => {
      const result = run(opened(), {
        type: 'git/refreshFailed',
        sessionId: 1,
        requestId: 'r1',
        error: { code, message: 'temporary' },
      });

      expect(result.git.status).toBe('error');
    },
  );

  it('leaves the tree fully intact — invariant 13', () => {
    const result = run(opened(), {
      type: 'git/refreshFailed',
      sessionId: 1,
      requestId: 'r1',
      error: { code: 'git-missing', message: 'git is not installed, or not on PATH.' },
    });

    expect(result.directories['']).toMatchObject({ status: 'loaded' });
    expect(selectRepositoryRows(result).map((row) => row.path)).toEqual(['src', 'README.md']);
  });

  it('drops a superseded failure', () => {
    const refreshing = run(opened(), {
      type: 'git/refreshRequested',
      sessionId: 1,
      requestId: 'r2',
    });

    const result = repositoryReducer(refreshing, {
      type: 'git/refreshFailed',
      sessionId: 1,
      requestId: 'r1',
      error: { code: 'timed-out', message: 'stale' },
    });

    expect(result.state).toBe(refreshing);
  });
});

describe('the merged projection', () => {
  const withGit = (files: GitFileStatus[]): RepositoryState =>
    run(opened(), {
      type: 'git/refreshed',
      sessionId: 1,
      requestId: 'r1',
      snapshot: snapshot(files),
    });

  it('attaches a status to the matching row', () => {
    const rows = selectRepositoryRows(withGit([status({ path: 'README.md' })]));

    expect(rows.find((row) => row.path === 'README.md')?.git?.unstaged).toBe('modified');
    expect(rows.find((row) => row.path === 'src')?.git).toBeUndefined();
  });

  it('marks a collapsed directory that hides changes underneath', () => {
    // Otherwise an agent's edit three levels down is invisible until the user happens
    // to expand the right folders, which defeats the point of the tool.
    const rows = selectRepositoryRows(withGit([status({ path: 'src/main/deep/file.ts' })]));

    expect(rows.find((row) => row.path === 'src')?.containsChanges).toBe(true);
  });

  it('does not mark a directory with no changes below it', () => {
    const rows = selectRepositoryRows(withGit([status({ path: 'README.md' })]));

    expect(rows.find((row) => row.path === 'src')?.containsChanges).toBeUndefined();
  });

  it('inserts a virtual node for a file git says was deleted', () => {
    // The whole point of the tool: a file the agent deleted is one of the most
    // important things to see, and a filesystem scan can never report it.
    const rows = selectRepositoryRows(withGit([status({ path: 'gone.ts', unstaged: 'deleted' })]));

    const ghost = rows.find((row) => row.path === 'gone.ts');
    expect(ghost).toMatchObject({ virtual: true, kind: 'file', depth: 0 });
    expect(ghost?.git?.unstaged).toBe('deleted');
  });

  it('appends deletions after the real entries rather than re-sorting', () => {
    const rows = selectRepositoryRows(withGit([status({ path: 'aaa.ts', unstaged: 'deleted' })]));

    // The scanner owns the ordering; duplicating its comparator here is how the two
    // would drift apart. `aaa.ts` sorts first alphabetically but comes last.
    expect(rows.map((row) => row.path)).toEqual(['src', 'README.md', 'aaa.ts']);
  });

  it('does not duplicate a file that is deleted in the index but still on disk', () => {
    // `git rm --cached` leaves the file present while marking it deleted.
    const rows = selectRepositoryRows(
      withGit([status({ path: 'README.md', staged: 'deleted', unstaged: null })]),
    );

    expect(rows.filter((row) => row.path === 'README.md')).toHaveLength(1);
  });

  it('does not add a ghost for a rename source, which would double-count the change', () => {
    const rows = selectRepositoryRows(
      withGit([
        status({ path: 'new.ts', staged: 'renamed', unstaged: null, originalPath: 'old.ts' }),
      ]),
    );

    expect(rows.some((row) => row.path === 'old.ts')).toBe(false);
  });

  it('places a deletion inside the directory it used to live in', () => {
    const state = run(
      run(opened(), {
        type: 'git/refreshed',
        sessionId: 1,
        requestId: 'r1',
        snapshot: snapshot([status({ path: 'src/removed.ts', unstaged: 'deleted' })]),
      }),
      { type: 'repository/toggled', sessionId: 1, path: 'src', requestId: 'r2' },
      {
        type: 'repository/directoryLoaded',
        sessionId: 1,
        path: 'src',
        requestId: 'r2',
        entries: [{ path: 'src/kept.ts', name: 'kept.ts', kind: 'file' }],
      },
    );

    const rows = selectRepositoryRows(state);

    expect(rows.map((row) => `${row.depth}:${row.path}`)).toEqual([
      '0:src',
      '1:src/kept.ts',
      '1:src/removed.ts',
      '0:README.md',
    ]);
  });

  it('recomputes when git changes but not when it does not', () => {
    const before = selectRepositoryRows(withGit([status({ path: 'README.md' })]));
    const same = selectRepositoryRows(withGit([status({ path: 'README.md' })]));

    // Different state objects, so a recompute is expected; the identity guarantee is
    // per-state, which is what React consumes.
    expect(same).not.toBe(before);
    expect(same).toEqual(before);
  });
});

describe('the changes view', () => {
  it('lists git changes as flat rows', () => {
    const state = run(
      opened(),
      {
        type: 'git/refreshed',
        sessionId: 1,
        requestId: 'r1',
        snapshot: snapshot([
          status({ path: 'src/deep/a.ts' }),
          status({ path: 'b.ts', unstaged: 'untracked' }),
        ]),
      },
      { type: 'repository/viewChanged', view: 'changes' },
    );

    const rows = selectRepositoryRows(state);

    // Full paths, depth zero, and files the tree has never read.
    expect(rows.map((row) => row.path)).toEqual(['src/deep/a.ts', 'b.ts']);
    expect(rows.every((row) => row.depth === 0)).toBe(true);
  });

  it('includes a deleted file, which the filesystem no longer has', () => {
    const state = run(
      opened(),
      {
        type: 'git/refreshed',
        sessionId: 1,
        requestId: 'r1',
        snapshot: snapshot([status({ path: 'gone.ts', unstaged: 'deleted' })]),
      },
      { type: 'repository/viewChanged', view: 'changes' },
    );

    const rows = selectRepositoryRows(state);

    expect(rows[0]).toMatchObject({ path: 'gone.ts', virtual: true });
  });

  it('is empty when git is unavailable rather than showing a stale tree', () => {
    const state = run(
      opened(),
      {
        type: 'git/refreshFailed',
        sessionId: 1,
        requestId: 'r1',
        error: { code: 'git-missing', message: 'no git' },
      },
      { type: 'repository/viewChanged', view: 'changes' },
    );

    expect(selectRepositoryRows(state)).toEqual([]);
  });

  it('switching views recomputes the projection', () => {
    const ready = run(opened(), {
      type: 'git/refreshed',
      sessionId: 1,
      requestId: 'r1',
      snapshot: snapshot([status({ path: 'src/deep/a.ts' })]),
    });

    const treeRows = selectRepositoryRows(ready);
    const changesRows = selectRepositoryRows(
      run(ready, { type: 'repository/viewChanged', view: 'changes' }),
    );

    expect(treeRows.map((row) => row.path)).toEqual(['src', 'README.md']);
    expect(changesRows.map((row) => row.path)).toEqual(['src/deep/a.ts']);
  });
});

describe('workspace disposal', () => {
  it('discards the git snapshot with everything else', () => {
    const ready = run(opened(), {
      type: 'git/refreshed',
      sessionId: 1,
      requestId: 'r1',
      snapshot: snapshot([status({ path: 'README.md' })]),
    });

    const result = repositoryReducer(ready, { type: 'workspace/closed', sessionId: 1 });

    expect(result.state).toBe(initialRepositoryState);
  });
});
