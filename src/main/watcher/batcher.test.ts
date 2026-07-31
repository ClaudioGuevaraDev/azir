import { describe, expect, it } from 'vitest';
import type { FsChangeBatch } from '@shared/ipc/contracts';
import { createBatcher, type FsEvent } from './batcher';

type Batch = Omit<FsChangeBatch, 'sessionId'>;

/**
 * A fake clock, so the assertions are about the batching rules rather than about how
 * fast the machine happens to be. Timers are keyed by the delay they were scheduled
 * with, which is what lets a test fire the quiet timer without firing the ceiling.
 */
const fakeClock = () => {
  let nextHandle = 1;
  const pending = new Map<number, { callback: () => void; ms: number }>();

  return {
    schedule: ((callback: () => void, ms: number) => {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, { callback, ms });
      return handle;
    }) as unknown as typeof setTimeout,
    cancel: ((handle: number) => {
      pending.delete(handle);
    }) as unknown as typeof clearTimeout,
    /** Fires every timer scheduled with exactly this delay. */
    fire: (ms: number): void => {
      for (const [handle, entry] of [...pending]) {
        if (entry.ms === ms) {
          pending.delete(handle);
          entry.callback();
        }
      }
    },
    count: (): number => pending.size,
  };
};

const setup = (options: { maxPaths?: number } = {}) => {
  const batches: Batch[] = [];
  const clock = fakeClock();
  const batcher = createBatcher((batch) => batches.push(batch), {
    quietMs: 60,
    maxDelayMs: 300,
    schedule: clock.schedule,
    cancel: clock.cancel,
    ...options,
  });
  return { batcher, batches, clock };
};

const event = (kind: FsEvent['kind'], path: string): FsEvent => ({ kind, path });

describe('translation', () => {
  it('turns an add into a rescan of the parent directory', () => {
    const { batcher, batches, clock } = setup();

    batcher.push(event('add', 'src/app/new.ts'));
    clock.fire(60);

    // The listing changed, so the directory is what needs rereading.
    expect(batches[0]).toMatchObject({ directories: ['src/app'], files: [] });
  });

  it('turns a delete into a rescan of the parent directory', () => {
    const { batcher, batches, clock } = setup();

    batcher.push(event('unlink', 'src/gone.ts'));
    clock.fire(60);

    expect(batches[0]?.directories).toEqual(['src']);
  });

  it('attributes a top-level add to the root', () => {
    const { batcher, batches, clock } = setup();

    batcher.push(event('add', 'README.md'));
    clock.fire(60);

    expect(batches[0]?.directories).toEqual(['']);
  });

  it('turns a content change into a file, not a directory rescan', () => {
    // The listing is unaffected. Rescanning on every keystroke an agent makes would be
    // pure waste.
    const { batcher, batches, clock } = setup();

    batcher.push(event('change', 'src/index.ts'));
    clock.fire(60);

    expect(batches[0]).toMatchObject({ directories: [], files: ['src/index.ts'] });
  });

  it('handles a directory being created or removed', () => {
    const { batcher, batches, clock } = setup();

    batcher.push(event('addDir', 'src/feature'));
    batcher.push(event('unlinkDir', 'src/old'));
    clock.fire(60);

    expect(batches[0]?.directories).toEqual(['src']);
  });
});

describe('git state', () => {
  it.each(['.git/HEAD', '.git/index', '.git/refs/heads/main'])(
    'reduces %s to a single bit',
    (path) => {
      const { batcher, batches, clock } = setup();

      batcher.push(event('change', path));
      clock.fire(60);

      // `.git` is hidden from the tree, so the only useful consequence is "ask git
      // again" — not a path the panel could render.
      expect(batches[0]).toMatchObject({ gitDirty: true, directories: [], files: [] });
    },
  );

  it('sets the bit once however many git writes arrive', () => {
    const { batcher, batches, clock } = setup();

    batcher.push(event('change', '.git/index'));
    batcher.push(event('change', '.git/HEAD'));
    batcher.push(event('add', '.git/refs/heads/feature'));
    clock.fire(60);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.gitDirty).toBe(true);
  });
});

describe('coalescing', () => {
  it('collapses repeated writes to the same file', () => {
    const { batcher, batches, clock } = setup();

    for (let index = 0; index < 50; index += 1) {
      batcher.push(event('change', 'src/index.ts'));
    }
    clock.fire(60);

    expect(batches[0]?.files).toEqual(['src/index.ts']);
  });

  it('collapses many adds in one directory into one rescan', () => {
    const { batcher, batches, clock } = setup();

    for (let index = 0; index < 100; index += 1) {
      batcher.push(event('add', `src/generated/file-${index}.ts`));
    }
    clock.fire(60);

    expect(batches[0]?.directories).toEqual(['src/generated']);
  });

  it('emits nothing when no events arrived', () => {
    const { batches, clock } = setup();

    clock.fire(60);

    expect(batches).toEqual([]);
  });

  it('starts a fresh batch after flushing', () => {
    const { batcher, batches, clock } = setup();

    batcher.push(event('change', 'a.ts'));
    clock.fire(60);
    batcher.push(event('change', 'b.ts'));
    clock.fire(60);

    expect(batches.map((batch) => batch.files)).toEqual([['a.ts'], ['b.ts']]);
  });
});

describe('the quiet period', () => {
  it('restarts on every event, so a burst is delivered once it settles', () => {
    const { batcher, batches, clock } = setup();

    batcher.push(event('change', 'a.ts'));
    batcher.push(event('change', 'b.ts'));
    batcher.push(event('change', 'c.ts'));

    expect(batches).toEqual([]);

    clock.fire(60);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.files).toHaveLength(3);
  });
});

describe('the ceiling', () => {
  it('flushes a continuous stream that never goes quiet', () => {
    // A bundler in watch mode or an `npm install` never stops writing. A pure debounce
    // would starve forever and the panel would look frozen exactly when the user most
    // wants to see progress.
    const { batcher, batches, clock } = setup();

    batcher.push(event('change', 'a.ts'));
    // Simulating the stream: every new event pushes the quiet timer out again.
    for (let index = 0; index < 20; index += 1) {
      batcher.push(event('change', `file-${index}.ts`));
    }

    expect(batches).toEqual([]);

    clock.fire(300);

    expect(batches).toHaveLength(1);
  });

  it('is not restarted by later events', () => {
    const { batcher, clock } = setup();

    batcher.push(event('change', 'a.ts'));
    const afterFirst = clock.count();
    batcher.push(event('change', 'b.ts'));

    // Two timers either way — quiet plus ceiling — and the ceiling is the same one.
    expect(clock.count()).toBe(afterFirst);
  });

  it('is set again for the next batch', () => {
    const { batcher, batches, clock } = setup();

    batcher.push(event('change', 'a.ts'));
    clock.fire(300);
    batcher.push(event('change', 'b.ts'));
    clock.fire(300);

    expect(batches).toHaveLength(2);
  });

  it('cancels the quiet timer when it fires, so a batch is not delivered twice', () => {
    const { batcher, batches, clock } = setup();

    batcher.push(event('change', 'a.ts'));
    clock.fire(300);
    clock.fire(60);

    expect(batches).toHaveLength(1);
  });
});

describe('overflow', () => {
  it('marks the batch truncated past its path budget', () => {
    const { batcher, batches, clock } = setup({ maxPaths: 5 });

    for (let index = 0; index < 50; index += 1) {
      batcher.push(event('add', `dir-${index}/file.ts`));
    }
    clock.fire(60);

    // A change set this large is a checkout or an install, and enumerating it costs
    // more than rescanning what is on screen.
    expect(batches[0]?.truncated).toBe(true);
    expect(batches[0]?.directories.length).toBeLessThanOrEqual(5);
  });

  it('still reports git as dirty when overflowing', () => {
    const { batcher, batches, clock } = setup({ maxPaths: 2 });

    batcher.push(event('add', 'a/x.ts'));
    batcher.push(event('add', 'b/x.ts'));
    batcher.push(event('add', 'c/x.ts'));
    batcher.push(event('change', '.git/index'));
    clock.fire(60);

    expect(batches[0]).toMatchObject({ truncated: true, gitDirty: true });
  });

  it('clears the flag for the next batch', () => {
    const { batcher, batches, clock } = setup({ maxPaths: 1 });

    batcher.push(event('add', 'a/x.ts'));
    batcher.push(event('add', 'b/x.ts'));
    clock.fire(60);
    batcher.push(event('change', 'small.ts'));
    clock.fire(60);

    expect(batches[0]?.truncated).toBe(true);
    expect(batches[1]?.truncated).toBe(false);
  });
});

describe('dispose', () => {
  it('flushes what is pending, so the last change is not lost', () => {
    const { batcher, batches } = setup();

    batcher.push(event('change', 'a.ts'));
    batcher.dispose();

    expect(batches).toHaveLength(1);
  });

  it('is synchronous, which is what session disposal requires', () => {
    const { batcher, batches } = setup();

    batcher.push(event('change', 'a.ts'));
    batcher.dispose();

    // Asserted with no await in between.
    expect(batches[0]?.files).toEqual(['a.ts']);
  });

  it('ignores events afterwards', () => {
    const { batcher, batches, clock } = setup();

    batcher.dispose();
    batcher.push(event('change', 'a.ts'));
    clock.fire(60);

    expect(batches).toEqual([]);
  });

  it('is idempotent', () => {
    const { batcher, batches } = setup();

    batcher.push(event('change', 'a.ts'));
    batcher.dispose();
    batcher.dispose();

    expect(batches).toHaveLength(1);
  });

  it('leaves no timers behind', () => {
    const { batcher, clock } = setup();

    batcher.push(event('change', 'a.ts'));
    batcher.dispose();

    expect(clock.count()).toBe(0);
  });
});
