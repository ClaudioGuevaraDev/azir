import type { Effect } from '../effects';
import {
  initialRepositoryState,
  pathStillExists,
  toFileNode,
  type DirectoryChildren,
  type RepositoryState,
} from '../repository';
import { changed, idle, withEffects, type Reduction, type SliceReducer } from './combine';

/**
 * The repository tree.
 *
 * The spec's rules for this slice and where each one lives:
 *
 *  - *"Directories load lazily"* — expanding emits a `listDirectory` effect; nothing
 *    is walked until it is opened. A tree that eagerly scanned a monorepo would
 *    block the first paint, which the startup sequence forbids.
 *  - *"Loading state is explicit"* — `DirectoryChildren` distinguishes never-opened,
 *    opening, open and unreadable, so the UI never shows an empty folder for a
 *    folder it simply has not read.
 *  - *"Visual row indexes are never identities"* — selection is a path.
 *  - *"Selection survives refresh when the selected path still exists"* — checked
 *    against the reloaded children, and only discarded when the path is known to be
 *    gone rather than merely unloaded.
 *  - *"Projection is rebuilt in one place"* — nothing here builds rows; that is
 *    `selectRepositoryRows`.
 */

const setDirectory = (
  state: RepositoryState,
  path: string,
  children: DirectoryChildren,
): RepositoryState['directories'] => ({ ...state.directories, [path]: children });

const withoutPending = (
  pending: RepositoryState['pending'],
  path: string,
): RepositoryState['pending'] => {
  if (pending[path] === undefined) {
    return pending;
  }
  const next = { ...pending };
  delete next[path];
  return next;
};

/**
 * A response is accepted only when it answers the load that is currently in flight
 * for that directory. Two rapid expands, or an expand racing a watcher-triggered
 * refresh, would otherwise let the slower answer overwrite the newer one.
 */
const isCurrent = (state: RepositoryState, path: string, requestId: string): boolean =>
  state.pending[path] === requestId;

export const repositoryReducer: SliceReducer<RepositoryState> = (
  state,
  action,
): Reduction<RepositoryState> => {
  switch (action.type) {
    case 'workspace/opened': {
      // The root and git status are both requested up front, and independently: the
      // spec requires that a missing git binary not disable the file browser, so
      // neither waits for the other.
      return withEffects(
        {
          ...initialRepositoryState,
          directories: { '': { status: 'loading' } },
          pending: { '': action.requestId },
          git: { status: 'loading' },
          gitRequestId: action.requestId,
        },
        {
          type: 'repository/listDirectory',
          sessionId: action.info.sessionId,
          path: '',
          requestId: action.requestId,
        },
        {
          type: 'git/status',
          sessionId: action.info.sessionId,
          requestId: action.requestId,
        },
      );
    }

    case 'workspace/closed': {
      if (state === initialRepositoryState) {
        return idle(state);
      }
      return changed(initialRepositoryState);
    }

    case 'repository/directoryRequested': {
      // Used for an explicit refresh of an already-open directory. The current
      // children stay visible; only `pending` changes, so the panel does not blank.
      const existing = state.directories[action.path];
      const directories =
        existing?.status === 'loaded'
          ? state.directories
          : setDirectory(state, action.path, { status: 'loading' });

      return withEffects(
        { ...state, directories, pending: { ...state.pending, [action.path]: action.requestId } },
        {
          type: 'repository/listDirectory',
          sessionId: action.sessionId,
          path: action.path,
          requestId: action.requestId,
        },
      );
    }

    case 'repository/toggled': {
      if (state.expanded[action.path] === true) {
        const expanded = { ...state.expanded };
        delete expanded[action.path];
        // Children are kept, not discarded: reopening a folder should be instant, and
        // the watcher keeps them fresh. Only `expanded` changes.
        return changed({ ...state, expanded });
      }

      const expanded = { ...state.expanded, [action.path]: true as const };
      const existing = state.directories[action.path];

      // Already read once — reopen without a round trip.
      if (existing?.status === 'loaded') {
        return changed({ ...state, expanded });
      }

      return withEffects(
        {
          ...state,
          expanded,
          directories: setDirectory(state, action.path, { status: 'loading' }),
          pending: { ...state.pending, [action.path]: action.requestId },
        },
        {
          type: 'repository/listDirectory',
          sessionId: action.sessionId,
          path: action.path,
          requestId: action.requestId,
        },
      );
    }

    case 'repository/collapsed': {
      if (state.expanded[action.path] !== true) {
        return idle(state);
      }
      const expanded = { ...state.expanded };
      delete expanded[action.path];
      return changed({ ...state, expanded });
    }

    case 'repository/directoryLoaded': {
      if (!isCurrent(state, action.path, action.requestId)) {
        return idle(state);
      }

      const next: RepositoryState = {
        ...state,
        directories: setDirectory(state, action.path, {
          status: 'loaded',
          children: action.entries.map(toFileNode),
        }),
        pending: withoutPending(state.pending, action.path),
      };

      // Selection survives a refresh, but only while the selected path is still
      // there. Dropping it unconditionally would lose the user's place on every
      // watcher tick; keeping it unconditionally would leave a highlight on a file
      // that no longer exists.
      if (next.selectedPath !== null && !pathStillExists(next, next.selectedPath)) {
        return changed({ ...next, selectedPath: null });
      }

      return changed(next);
    }

    case 'repository/directoryFailed': {
      if (!isCurrent(state, action.path, action.requestId)) {
        return idle(state);
      }
      // An unreadable directory becomes a visible failed row rather than taking the
      // panel down. The rest of the tree is unaffected.
      return changed({
        ...state,
        directories: setDirectory(state, action.path, {
          status: 'failed',
          error: action.error,
        }),
        pending: withoutPending(state.pending, action.path),
      });
    }

    case 'repository/selected': {
      if (state.selectedPath === action.path) {
        return idle(state);
      }
      return changed({ ...state, selectedPath: action.path });
    }

    case 'repository/viewChanged': {
      if (state.view === action.view) {
        return idle(state);
      }
      return changed({ ...state, view: action.view });
    }

    case 'fs/changed': {
      /*
       * The targeted response the spec asks for, rather than a full refresh.
       *
       * What that means concretely, and why each rule is worth having:
       *
       *  - **Only directories that are already loaded are rescanned.** Reloading one
       *    the user has never opened would do filesystem work to update something
       *    invisible — and during an `npm install` that is thousands of directories.
       *  - **A content change rescans nothing.** The listing is unchanged; only the
       *    file's bytes moved, which matters to the viewer (M6) and not to the tree.
       *  - **Git is refreshed whenever anything changed at all**, not only on a `.git`
       *    write: editing a tracked file changes its status without touching `.git`.
       *  - **A truncated batch refreshes what is loaded** instead of trying to apply a
       *    path list it knows is incomplete.
       */
      const { batch } = action;

      const candidates = batch.truncated
        ? Object.keys(state.directories)
        : batch.directories.filter((path) => state.directories[path] !== undefined);

      // Loaded, not merely known: a directory left in `failed` or `loading` has nothing
      // worth reconciling, and re-requesting a failed one on every save would retry a
      // permission error in a loop.
      const reloadable = candidates.filter((path) => state.directories[path]?.status === 'loaded');

      const effects: Effect[] = [];
      const pending: Record<string, string> = { ...state.pending };

      for (const path of reloadable) {
        const requestId = action.directoryRequestIds[path];
        if (requestId === undefined) {
          continue;
        }
        pending[path] = requestId;
        effects.push({
          type: 'repository/listDirectory',
          sessionId: action.sessionId,
          path,
          requestId,
        });
      }

      const gitWorthRefreshing =
        state.git.status !== 'unavailable' &&
        (batch.gitDirty ||
          batch.truncated ||
          batch.directories.length > 0 ||
          batch.files.length > 0);

      if (gitWorthRefreshing) {
        effects.push({
          type: 'git/status',
          sessionId: action.sessionId,
          requestId: action.gitRequestId,
        });
      }

      if (effects.length === 0) {
        return idle(state);
      }

      return withEffects(
        {
          ...state,
          pending,
          gitRequestId: gitWorthRefreshing ? action.gitRequestId : state.gitRequestId,
        },
        ...effects,
      );
    }

    case 'git/refreshRequested': {
      // The previous snapshot stays visible while refreshing. Blanking the badges on
      // every watcher tick would make the tree strobe once M5 lands.
      return withEffects(
        {
          ...state,
          git: state.git.status === 'ready' ? state.git : { status: 'loading' },
          gitRequestId: action.requestId,
        },
        { type: 'git/status', sessionId: action.sessionId, requestId: action.requestId },
      );
    }

    case 'git/refreshed': {
      if (state.gitRequestId !== action.requestId) {
        return idle(state);
      }

      // Indexed by destination path only. A rename or copy reports one change whose
      // `originalPath` names the source: for a rename the source is gone from disk so
      // there is no row to badge, and for a copy the source is *unchanged* — badging
      // it would tell the user a file was modified when it was not.
      const byPath: Record<string, (typeof action.snapshot.files)[number]> = {};
      for (const file of action.snapshot.files) {
        byPath[file.path] = file;
      }

      return changed({
        ...state,
        gitRequestId: null,
        git: {
          status: 'ready',
          branch: action.snapshot.branch,
          byPath,
          changed: action.snapshot.files,
        },
      });
    }

    case 'git/refreshFailed': {
      if (state.gitRequestId !== action.requestId) {
        return idle(state);
      }

      // `git-missing` and `not-a-repository` are permanent for this workspace, so the
      // UI stops offering a retry it knows will fail. Everything else — a timeout, a
      // held index.lock — is transient and stays retryable.
      const permanent =
        action.error.code === 'git-missing' || action.error.code === 'not-a-repository';

      return changed({
        ...state,
        gitRequestId: null,
        git: permanent
          ? { status: 'unavailable', error: action.error }
          : { status: 'error', error: action.error },
      });
    }

    default:
      return idle(state);
  }
};
