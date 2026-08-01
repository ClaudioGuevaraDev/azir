import { beforeEach, describe, expect, it } from 'vitest';
import type { SearchIndexDeltaEvent, SearchIndexEvent } from '@shared/ipc/contracts';
import { createSearchService, type SearchService } from './searchService';
import type { ContentSearchResult } from './contentSearch';
import type { PathIndex } from './pathIndex';

/**
 * The service that owns the index.
 *
 * The unit-testable claims here are all about *timing*: what happens to a file created while the
 * walk is still running, what happens to a search that a newer keystroke has superseded, and what
 * happens to work in flight when the workspace closes underneath it. Each is a race, and each
 * fails in a way that looks like something else — a file missing from search, results flickering
 * between two queries, a closed workspace still burning CPU.
 */

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Harness {
  readonly service: SearchService;
  readonly indexEvents: SearchIndexEvent[];
  readonly deltaEvents: SearchIndexDeltaEvent[];
  /**
   * Resolves the oldest walk that has not been resolved yet.
   *
   * A queue rather than a single resolver, because one of the tests below starts two workspaces
   * and then finishes the *first* one's walk. With a single resolver the second `start` would
   * overwrite it, `finishWalk` would resolve the live walk instead of the abandoned one, and the
   * test would pass or fail for reasons unrelated to what it claims to check.
   */
  finishWalk(index: PathIndex): void;
  fireTimers(): void;
  readonly searches: Array<{ query: string; paths: readonly string[] }>;
  /**
   * One entry per search started, in order, each being that search's own `shouldContinue`.
   *
   * Recorded per search rather than exposed as "the current one", so a test can hold the *first*
   * search's predicate and watch it turn false when a second search supersedes it. Reading a
   * "current" accessor after the second call would just read the second one's, and the assertion
   * would pass without measuring anything.
   */
  readonly continuePredicates: Array<() => boolean>;
}

let harness: Harness;

const build = (
  searchResult: ContentSearchResult = { matches: [], truncated: false, filesScanned: 0 },
): Harness => {
  const indexEvents: SearchIndexEvent[] = [];
  const deltaEvents: SearchIndexDeltaEvent[] = [];
  const searches: Array<{ query: string; paths: readonly string[] }> = [];
  const continuePredicates: Array<() => boolean> = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;

  const pendingWalks: Array<(index: PathIndex) => void> = [];

  const service = createSearchService({
    emitIndex: (event) => indexEvents.push(event),
    emitDelta: (event) => deltaEvents.push(event),
    setTimer: (callback) => {
      const handle = nextTimer;
      nextTimer += 1;
      timers.set(handle, callback);
      return handle as unknown as NodeJS.Timeout;
    },
    clearTimer: (handle) => {
      timers.delete(handle as unknown as number);
    },
    buildIndex: () =>
      new Promise<PathIndex>((resolve) => {
        pendingWalks.push(resolve);
      }),
    runSearch: (options) => {
      searches.push({ query: options.query, paths: options.paths });
      continuePredicates.push(options.shouldContinue ?? (() => true));
      return Promise.resolve(searchResult);
    },
  });

  return {
    service,
    indexEvents,
    deltaEvents,
    searches,
    continuePredicates,
    finishWalk: (index) => pendingWalks.shift()?.(index),
    fireTimers: () => {
      const due = [...timers.values()];
      timers.clear();
      for (const callback of due) {
        callback();
      }
    },
  };
};

beforeEach(() => {
  harness = build();
});

describe('indexing', () => {
  it('emits the index when the walk finishes', async () => {
    harness.service.start(1, '/w');

    harness.finishWalk({ paths: ['a.ts', 'b.ts'], truncated: false });
    await flush();

    expect(harness.indexEvents).toEqual([
      { sessionId: 1, paths: ['a.ts', 'b.ts'], truncated: false },
    ]);
  });

  it('carries the truncated flag through', async () => {
    harness.service.start(1, '/w');

    harness.finishWalk({ paths: ['a.ts'], truncated: true });
    await flush();

    expect(harness.indexEvents[0]?.truncated).toBe(true);
  });

  it('keeps a file created while the walk was still running', async () => {
    /*
     * The race worth having a test for. The walk started before the file existed and may already
     * have passed its directory, so an implementation that simply assigns the walk's result would
     * lose it — and it would stay lost until the next restart, with nothing to suggest why.
     */
    harness.service.start(1, '/w');
    harness.service.noteChange(1, 'add', 'created-during-walk.ts');

    harness.finishWalk({ paths: ['a.ts'], truncated: false });
    await flush();

    expect(harness.indexEvents[0]?.paths).toEqual(
      expect.arrayContaining(['a.ts', 'created-during-walk.ts']),
    );
  });

  it('sends no delta for a change that arrived before the index did', async () => {
    harness.service.start(1, '/w');
    harness.service.noteChange(1, 'add', 'early.ts');
    harness.fireTimers();

    // The renderer has no index to apply a delta to yet, and the path is already in the snapshot
    // it is about to receive. Sending one anyway would be a message about nothing.
    expect(harness.deltaEvents).toEqual([]);
  });

  it("drops the walk's result when the workspace closed underneath it", async () => {
    harness.service.start(1, '/w');
    harness.service.stop(1);

    harness.finishWalk({ paths: ['a.ts'], truncated: false });
    await flush();

    expect(harness.indexEvents).toEqual([]);
  });

  it("drops the walk's result when a second workspace opened", async () => {
    harness.service.start(1, '/one');
    harness.service.start(2, '/two');

    harness.finishWalk({ paths: ['from-the-first.ts'], truncated: false });
    await flush();

    // The first walk's promise is still pending and will resolve eventually. Its answer belongs
    // to a workspace that no longer exists.
    expect(harness.indexEvents).toEqual([]);
  });
});

describe('deltas', () => {
  const started = async (): Promise<void> => {
    harness.service.start(1, '/w');
    harness.finishWalk({ paths: ['a.ts'], truncated: false });
    await flush();
  };

  it('reports an added file', async () => {
    await started();

    harness.service.noteChange(1, 'add', 'new.ts');
    harness.fireTimers();

    expect(harness.deltaEvents).toEqual([{ sessionId: 1, added: ['new.ts'], removed: [] }]);
  });

  it('reports a removed file', async () => {
    await started();

    harness.service.noteChange(1, 'unlink', 'a.ts');
    harness.fireTimers();

    expect(harness.deltaEvents).toEqual([{ sessionId: 1, added: [], removed: ['a.ts'] }]);
  });

  it('coalesces a burst into one message', async () => {
    await started();

    for (let index = 0; index < 100; index += 1) {
      harness.service.noteChange(1, 'add', `generated/f${index}.ts`);
    }
    harness.fireTimers();

    // An agent scaffolding a feature folder produces one message, not a hundred.
    expect(harness.deltaEvents).toHaveLength(1);
    expect(harness.deltaEvents[0]?.added).toHaveLength(100);
  });

  it('ignores a path inside an ignored directory', async () => {
    await started();

    harness.service.noteChange(1, 'add', 'node_modules/pkg/index.js');
    harness.fireTimers();

    // The same ignore list the scanner and the watcher use. Search must not be able to offer a
    // file the tree refuses to show.
    expect(harness.deltaEvents).toEqual([]);
  });

  it('ignores a repeated add for a path already indexed', async () => {
    await started();

    harness.service.noteChange(1, 'add', 'a.ts');
    harness.fireTimers();

    expect(harness.deltaEvents).toEqual([]);
  });

  it('ignores an unlink for a path that was never indexed', async () => {
    await started();

    harness.service.noteChange(1, 'unlink', 'never-existed.ts');
    harness.fireTimers();

    expect(harness.deltaEvents).toEqual([]);
  });

  it('ignores a change for a session that is not the live one', async () => {
    await started();

    harness.service.noteChange(2, 'add', 'other-workspace.ts');
    harness.fireTimers();

    expect(harness.deltaEvents).toEqual([]);
  });

  it('cancels a pending delta when the workspace closes', async () => {
    await started();
    harness.service.noteChange(1, 'add', 'new.ts');

    harness.service.stop(1);
    harness.fireTimers();

    expect(harness.deltaEvents).toEqual([]);
  });
});

describe('content search', () => {
  const started = async (paths: readonly string[]): Promise<void> => {
    harness.service.start(1, '/w');
    harness.finishWalk({ paths: [...paths], truncated: false });
    await flush();
  };

  it('searches the indexed paths and echoes the query and request id', async () => {
    await started(['a.ts', 'b.ts']);

    const result = await harness.service.content(1, '/w', 'needle', 'r1');

    expect(harness.searches).toEqual([{ query: 'needle', paths: ['a.ts', 'b.ts'] }]);
    expect(result.ok && result.value.query).toBe('needle');
    expect(result.ok && result.value.requestId).toBe('r1');
  });

  it('searches paths the watcher added since the walk', async () => {
    await started(['a.ts']);
    harness.service.noteChange(1, 'add', 'written-by-an-agent.ts');

    await harness.service.content(1, '/w', 'needle', 'r1');

    // The point of the whole delta mechanism: an agent's new file is searchable immediately, not
    // after a restart.
    expect(harness.searches[0]?.paths).toContain('written-by-an-agent.ts');
  });

  it('lets a newer search abandon the one before it', async () => {
    await started(['a.ts']);

    void harness.service.content(1, '/w', 'first', 'r1');
    const first = harness.continuePredicates[0];
    // While it is the only search in flight, it is allowed to keep going.
    expect(first?.()).toBe(true);

    void harness.service.content(1, '/w', 'second', 'r2');

    /*
     * "Latest query wins" has to stop the *work*, not only drop the answer. The first search's
     * own predicate now returns false, so it abandons itself at the next file — without that,
     * every keystroke leaves a full-repository scan running behind it, in the process the
     * terminal shares.
     */
    expect(first?.()).toBe(false);
    expect(harness.continuePredicates[1]?.()).toBe(true);
  });

  it('answers empty rather than failing when the workspace has closed', async () => {
    await started(['a.ts']);
    harness.service.stop(1);

    const result = await harness.service.content(1, '/w', 'needle', 'r1');

    // Not an error the user should see: they closed the folder while typing.
    expect(result.ok && result.value.matches).toEqual([]);
    expect(harness.searches).toEqual([]);
  });
});

describe('teardown', () => {
  it('stops nothing when the session id does not match', async () => {
    harness.service.start(1, '/w');
    harness.finishWalk({ paths: ['a.ts'], truncated: false });
    await flush();

    harness.service.stop(99);
    harness.service.noteChange(1, 'add', 'still-live.ts');
    harness.fireTimers();

    expect(harness.deltaEvents).toHaveLength(1);
  });

  it('is idempotent', () => {
    harness.service.start(1, '/w');

    expect(() => {
      harness.service.stop(1);
      harness.service.stop(1);
      harness.service.stopAll();
    }).not.toThrow();
  });
});
