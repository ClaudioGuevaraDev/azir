import { isGitStateChange } from '@shared/constants/ignore';
import type { FsChangeBatch, FsEventKind } from '@shared/ipc/contracts';

/**
 * Coalesces raw filesystem events into batches.
 *
 * docs/architecture.md is unambiguous: "The watcher must not send one full refresh for
 * every low-level filesystem event. Events are coalesced by path and flushed in
 * batches." The numbers involved are the reason — an `npm install` produces tens of
 * thousands of events in a few seconds, and a git checkout of a large branch produces
 * thousands. One IPC message and one reducer pass per event would make the window
 * unusable exactly when the user most wants to watch what an agent is doing.
 *
 * Three mechanisms, each covering a case the others do not:
 *
 *  - **Coalescing by path**, so a file written five times in one burst appears once.
 *  - **A trailing debounce**, so a burst is delivered after it settles rather than in
 *    the middle.
 *  - **A ceiling on the wait**, because a continuous writer — a bundler in watch mode,
 *    an install — never goes quiet, and a pure debounce would starve forever.
 *
 * Events are also translated here rather than in the renderer: an add or a delete means
 * the *parent directory* needs rescanning, while a content change means the *file*
 * changed and the directory is untouched. Sending raw events and deciding later would
 * put filesystem semantics in the reducer.
 */

export interface FsEvent {
  readonly kind: FsEventKind;
  /** Workspace-relative POSIX path. */
  readonly path: string;
}

export interface BatcherOptions {
  /** Quiet period before a batch is delivered. */
  readonly quietMs?: number;
  /** Hardest deadline from the first event of a batch, whatever else arrives. */
  readonly maxDelayMs?: number;
  /** Beyond this many distinct paths the batch is marked truncated. */
  readonly maxPaths?: number;
  /** Injected so tests drive a fake clock. */
  readonly schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly cancel?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface Batcher {
  push(event: FsEvent): void;
  /** Delivers whatever is pending. No-op when empty. */
  flush(): void;
  /** Flushes and refuses further input. Idempotent, and synchronous. */
  dispose(): void;
}

/**
 * 60 ms is under the threshold where a change feels delayed, and long enough to
 * absorb the multi-event sequence an editor's atomic save produces (write temp,
 * rename, delete).
 */
const DEFAULT_QUIET_MS = 60;
/** Long enough to batch usefully, short enough that a build's progress stays visible. */
const DEFAULT_MAX_DELAY_MS = 300;
/**
 * Past this, enumerating paths is more expensive than just rescanning what is on
 * screen — and a change set this large is a checkout or an install, not an edit.
 */
const DEFAULT_MAX_PATHS = 500;

const parentOf = (relativePosix: string): string => {
  const index = relativePosix.lastIndexOf('/');
  return index === -1 ? '' : relativePosix.slice(0, index);
};

export const createBatcher = (
  emit: (batch: Omit<FsChangeBatch, 'sessionId'>) => void,
  options: BatcherOptions = {},
): Batcher => {
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;

  let directories = new Set<string>();
  let files = new Set<string>();
  let gitDirty = false;
  let truncated = false;

  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const clearTimers = (): void => {
    if (quietTimer !== undefined) {
      cancel(quietTimer);
      quietTimer = undefined;
    }
    if (ceilingTimer !== undefined) {
      cancel(ceilingTimer);
      ceilingTimer = undefined;
    }
  };

  const flush = (): void => {
    clearTimers();

    if (directories.size === 0 && files.size === 0 && !gitDirty && !truncated) {
      return;
    }

    const batch = {
      directories: [...directories],
      files: [...files],
      gitDirty,
      truncated,
    };

    directories = new Set();
    files = new Set();
    gitDirty = false;
    truncated = false;

    emit(batch);
  };

  return {
    push(event) {
      if (disposed) {
        return;
      }

      if (isGitStateChange(event.path)) {
        // One bit, not a path: `.git` is hidden from the tree, so the only useful
        // consequence is "ask git again".
        gitDirty = true;
      } else if (event.kind === 'change') {
        // Content changed in place. The directory listing is unaffected — rescanning it
        // would be pure waste on every keystroke an agent makes.
        if (directories.size + files.size >= maxPaths) {
          truncated = true;
        } else {
          files.add(event.path);
        }
      } else {
        // An entry appeared or disappeared, so the parent's listing is stale.
        if (directories.size + files.size >= maxPaths) {
          truncated = true;
        } else {
          directories.add(parentOf(event.path));
        }
      }

      // Restarted on every event: the batch is delivered once things settle.
      if (quietTimer !== undefined) {
        cancel(quietTimer);
      }
      quietTimer = schedule(flush, quietMs);

      // Set once per batch and never restarted, so a continuous writer cannot hold the
      // batch open indefinitely.
      ceilingTimer ??= schedule(flush, maxDelayMs);
    },

    flush,

    dispose() {
      if (disposed) {
        return;
      }
      flush();
      clearTimers();
      disposed = true;
    },
  };
};
