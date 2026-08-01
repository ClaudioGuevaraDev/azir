import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { shouldWatchPath } from '@shared/constants/ignore';
import type { FsChangeBatch, FsEventKind, WorkspaceSessionId } from '@shared/ipc/contracts';
import { describeError } from '@shared/ipc/result';
import { createBatcher, type Batcher, type BatcherOptions } from './batcher';

/**
 * Owns the filesystem watcher for the active workspace.
 *
 * This is the module that makes the product's core loop work: an agent changes files,
 * and the workspace notices without being asked.
 *
 * Two things it deliberately does not do:
 *
 *  - **It does not fail loudly.** The spec requires that "a watcher failure must not
 *    disable manual refresh". A watcher can fail for reasons entirely outside the
 *    app's control — a network share, an inotify limit, a directory deleted while
 *    being watched — and when it does the panel must degrade to the refresh button
 *    rather than break.
 *  - **It does not watch `.git` wholesale.** Only the handful of paths that mean the
 *    repository state moved; see `shouldWatchPath`.
 */

export interface WatcherService {
  /** Replaces any existing watcher. Failure is reported, not thrown. */
  start(sessionId: WorkspaceSessionId, root: string): void;
  /** Synchronous and idempotent, so it can run from a session dispose listener. */
  stop(sessionId: WorkspaceSessionId): void;
  stopAll(): void;
  watching(): WorkspaceSessionId | null;
}

export interface WatcherServiceOptions {
  readonly emit: (batch: FsChangeBatch) => void;
  /**
   * Every raw event, before batching.
   *
   * The batch deliberately carries *consequences* — which directories are stale, which files
   * changed — and that is the right shape for the repository panel. It is the wrong shape for
   * the search index, which needs to know that a path came into existence or stopped existing.
   * Rather than widen the batch for one consumer, the raw stream is offered alongside it.
   */
  readonly onRawEvent?: (
    sessionId: WorkspaceSessionId,
    kind: FsEventKind,
    relativePosix: string,
  ) => void;
  /** Reported so the UI can fall back to manual refresh rather than looking stale. */
  readonly onFailure?: (sessionId: WorkspaceSessionId, detail: string) => void;
  readonly batcher?: BatcherOptions;
  /** Injected in tests so no real watcher is created. */
  readonly createWatcher?: typeof watch;
}

interface ActiveWatcher {
  readonly sessionId: WorkspaceSessionId;
  readonly root: string;
  readonly watcher: FSWatcher;
  readonly batcher: Batcher;
}

const EVENT_KINDS: readonly FsEventKind[] = ['add', 'change', 'unlink', 'addDir', 'unlinkDir'];

export const createWatcherService = (options: WatcherServiceOptions): WatcherService => {
  const createWatcher = options.createWatcher ?? watch;
  let active: ActiveWatcher | undefined;

  const teardown = (): void => {
    if (!active) {
      return;
    }
    const previous = active;
    active = undefined;

    previous.batcher.dispose();
    // Not awaited: session disposal has to be synchronous (see
    // SessionDisposeListener), and a late event cannot be misapplied because the
    // batch carries a session id the reducer checks.
    void previous.watcher.close().catch(() => {
      // Closing a watcher whose root has been deleted throws on some platforms.
    });
  };

  return {
    start(sessionId, root) {
      teardown();

      const batcher = createBatcher((batch) => {
        options.emit({ sessionId, ...batch });
      }, options.batcher ?? {});

      let watcher: FSWatcher;
      try {
        watcher = createWatcher(root, {
          // The initial scan is the repository panel's job; replaying it here would
          // emit one event per file in the workspace at startup.
          ignoreInitial: true,
          // Symlinked directories are not followed: a link back into the tree would
          // make the watcher walk in circles.
          followSymlinks: false,
          // Waits for a file to stop growing before reporting it, which is what turns
          // a large write into one event instead of a stream of partial ones.
          awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
          // Editors write a temp file and rename it; without this the sequence looks
          // like a delete followed by an unrelated add.
          atomic: true,
          ignored: (absolutePath) => {
            const relative = path.relative(root, absolutePath);
            if (relative === '' || relative.startsWith('..')) {
              return false;
            }
            return !shouldWatchPath(relative.split(path.sep).join('/'));
          },
        });
      } catch (error) {
        batcher.dispose();
        options.onFailure?.(sessionId, describeError(error));
        return;
      }

      for (const kind of EVENT_KINDS) {
        watcher.on(kind, (absolutePath: string) => {
          const relative = path.relative(root, absolutePath).split(path.sep).join('/');
          if (relative === '' || relative.startsWith('..')) {
            return;
          }
          options.onRawEvent?.(sessionId, kind, relative);
          batcher.push({ kind, path: relative });
        });
      }

      watcher.on('error', (error) => {
        // Reported rather than rethrown, and the watcher is left in place: chokidar
        // recovers from many transient errors, and tearing down here would silently
        // stop updates for the rest of the session.
        options.onFailure?.(sessionId, describeError(error));
      });

      active = { sessionId, root, watcher, batcher };
    },

    stop(sessionId) {
      if (active?.sessionId !== sessionId) {
        return;
      }
      teardown();
    },

    stopAll() {
      teardown();
    },

    watching() {
      return active?.sessionId ?? null;
    },
  };
};
