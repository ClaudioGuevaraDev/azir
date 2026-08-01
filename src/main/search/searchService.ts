import type {
  ContentSearchResponse,
  SearchIndexDeltaEvent,
  SearchIndexEvent,
  WorkspaceSessionId,
} from '@shared/ipc/contracts';
import { isIgnoredPath } from '@shared/constants/ignore';
import { ok, type Result } from '@shared/ipc/result';
import { searchContent, type ContentSearchOptions } from './contentSearch';
import { buildPathIndex, type BuildPathIndexOptions } from './pathIndex';

/**
 * Owns the workspace's path index and runs content searches against it.
 *
 * Three obligations from docs/architecture.md shape this module:
 *
 *  1. "Path search operates on an in-memory path index and should respond on every keystroke
 *     without IPC." So the index is built once and *pushed* to the renderer, which does the
 *     per-keystroke filtering itself. This service keeps its own copy only because content
 *     search needs a file list.
 *  2. "Latest query wins." A newer search for the same session abandons the older one rather
 *     than racing it. Superseding here as well as in the reducer matters for a reason the
 *     reducer cannot help with: dropping a stale *result* still leaves the work that produced it
 *     burning the main process.
 *  3. "A slow repository search must never delay terminal input." Both the walk and the search
 *     yield to the event loop at a fixed interval.
 */

export interface SearchService {
  /** Starts building the index for a session. Returns immediately; the event arrives later. */
  start(sessionId: WorkspaceSessionId, root: string): void;
  /** Applies one raw watcher event, so the index tracks what an agent is doing. */
  noteChange(sessionId: WorkspaceSessionId, kind: RawChangeKind, relativePosix: string): void;
  content(
    sessionId: WorkspaceSessionId,
    root: string,
    query: string,
    requestId: string,
  ): Promise<Result<ContentSearchResponse>>;
  /** Synchronous and idempotent, so it can run from a session dispose listener. */
  stop(sessionId: WorkspaceSessionId): void;
  stopAll(): void;
}

export type RawChangeKind = 'add' | 'unlink';

export interface SearchServiceOptions {
  readonly emitIndex: (event: SearchIndexEvent) => void;
  readonly emitDelta: (event: SearchIndexDeltaEvent) => void;
  /**
   * How long deltas accumulate before being sent.
   *
   * An agent writing a hundred files should produce one message, not a hundred. The same
   * reasoning as the watcher's batcher, at a smaller scale — and deliberately not the batcher
   * itself, whose output shape carries consequences rather than the adds and removes wanted here.
   */
  readonly deltaDebounceMs?: number;
  readonly setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimer?: (handle: NodeJS.Timeout) => void;
  readonly indexOptions?: BuildPathIndexOptions;
  readonly searchOptions?: Pick<
    ContentSearchOptions,
    'maxMatches' | 'maxFiles' | 'maxFileBytes' | 'yieldEvery' | 'readFileText' | 'yieldToEventLoop'
  >;
  readonly buildIndex?: typeof buildPathIndex;
  readonly runSearch?: typeof searchContent;
}

interface SessionState {
  readonly sessionId: WorkspaceSessionId;
  readonly root: string;
  paths: Set<string>;
  truncated: boolean;
  indexed: boolean;
  /** Bumped on stop, so a walk in flight for a disposed session abandons itself. */
  generation: number;
  pendingAdded: Set<string>;
  pendingRemoved: Set<string>;
  deltaTimer: NodeJS.Timeout | undefined;
  /** The most recent search's id. Anything older sees a different value and stops. */
  currentRequestId: string | null;
}

const DEFAULT_DELTA_DEBOUNCE_MS = 250;

export const createSearchService = (options: SearchServiceOptions): SearchService => {
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const debounceMs = options.deltaDebounceMs ?? DEFAULT_DELTA_DEBOUNCE_MS;
  const buildIndex = options.buildIndex ?? buildPathIndex;
  const runSearch = options.runSearch ?? searchContent;

  /**
   * One entry, not a map. A workspace at a time is the application's whole model — see
   * `WorkspaceSessionId` — and a map would invite code that pretends otherwise.
   */
  let active: SessionState | undefined;

  const flushDelta = (state: SessionState): void => {
    state.deltaTimer = undefined;
    if (state.pendingAdded.size === 0 && state.pendingRemoved.size === 0) {
      return;
    }
    const event: SearchIndexDeltaEvent = {
      sessionId: state.sessionId,
      added: [...state.pendingAdded],
      removed: [...state.pendingRemoved],
    };
    state.pendingAdded = new Set();
    state.pendingRemoved = new Set();
    options.emitDelta(event);
  };

  const scheduleDelta = (state: SessionState): void => {
    if (state.deltaTimer !== undefined) {
      return;
    }
    state.deltaTimer = setTimer(() => flushDelta(state), debounceMs);
  };

  const teardown = (): void => {
    if (!active) {
      return;
    }
    if (active.deltaTimer !== undefined) {
      clearTimer(active.deltaTimer);
      active.deltaTimer = undefined;
    }
    // Everything in flight polls this: the walk, and any running search.
    active.generation += 1;
    active.currentRequestId = null;
    active = undefined;
  };

  return {
    start(sessionId, root) {
      teardown();

      const state: SessionState = {
        sessionId,
        root,
        paths: new Set(),
        truncated: false,
        indexed: false,
        generation: 0,
        pendingAdded: new Set(),
        pendingRemoved: new Set(),
        deltaTimer: undefined,
        currentRequestId: null,
      };
      active = state;

      const generation = state.generation;
      void (async () => {
        const index = await buildIndex(root, {
          ...options.indexOptions,
          shouldContinue: () => active === state && state.generation === generation,
        });
        if (active !== state || state.generation !== generation) {
          return;
        }
        /*
         * Paths added by the watcher *while the walk was running* are kept. The walk started
         * before them and may have passed their directory already, so dropping them would leave
         * a file an agent created during startup missing from search until the next restart.
         */
        for (const added of index.paths) {
          state.paths.add(added);
        }
        state.truncated = index.truncated;
        state.indexed = true;
        options.emitIndex({
          sessionId,
          paths: [...state.paths],
          truncated: index.truncated,
        });
      })();
    },

    noteChange(sessionId, kind, relativePosix) {
      const state = active;
      if (!state || state.sessionId !== sessionId || relativePosix === '') {
        return;
      }
      if (isIgnoredPath(relativePosix)) {
        return;
      }

      if (kind === 'add') {
        if (state.paths.has(relativePosix)) {
          return;
        }
        state.paths.add(relativePosix);
        state.pendingRemoved.delete(relativePosix);
        // Held back until the walk has finished: the renderer has no index to apply a delta to
        // yet, and everything accumulated here is already in the snapshot that will be sent.
        if (state.indexed) {
          state.pendingAdded.add(relativePosix);
          scheduleDelta(state);
        }
        return;
      }

      if (!state.paths.delete(relativePosix)) {
        return;
      }
      state.pendingAdded.delete(relativePosix);
      if (state.indexed) {
        state.pendingRemoved.add(relativePosix);
        scheduleDelta(state);
      }
    },

    async content(sessionId, root, query, requestId) {
      const state = active;
      if (!state || state.sessionId !== sessionId) {
        // Not an error the user should see: the workspace closed while they were typing.
        return ok<ContentSearchResponse>({
          query,
          requestId,
          matches: [],
          truncated: false,
          filesScanned: 0,
        });
      }

      // Claiming the slot is what supersedes the previous search: its `shouldContinue` compares
      // against this and stops on the next file.
      state.currentRequestId = requestId;
      const generation = state.generation;

      const result = await runSearch({
        ...options.searchOptions,
        root,
        paths: [...state.paths],
        query,
        shouldContinue: () =>
          active === state &&
          state.generation === generation &&
          state.currentRequestId === requestId,
      });

      return ok<ContentSearchResponse>({
        query,
        requestId,
        matches: result.matches,
        truncated: result.truncated,
        filesScanned: result.filesScanned,
      });
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
  };
};
