import { describe, expect, it } from 'vitest';
import { createBoundedScheduler } from './boundedScheduler';

/** A task whose completion the test controls. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('concurrency', () => {
  it('runs no more than the limit at once', async () => {
    const scheduler = createBoundedScheduler({ concurrency: 2 });
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    let started = 0;

    const results = gates.map((gate, index) =>
      scheduler.run(`k${index}`, async () => {
        started += 1;
        return gate.promise;
      }),
    );

    await tick();
    expect(started).toBe(2);
    expect(scheduler.queued()).toBe(1);

    gates[0]?.resolve('a');
    await tick();
    expect(started).toBe(3);

    gates[1]?.resolve('b');
    gates[2]?.resolve('c');
    expect(await Promise.all(results)).toEqual(['a', 'b', 'c']);
  });

  it('keeps draining after a task fails', async () => {
    const scheduler = createBoundedScheduler({ concurrency: 1 });

    const failed = scheduler.run('a', async () => {
      throw new Error('boom');
    });
    const succeeded = scheduler.run('b', async () => 'ok');

    await expect(failed).rejects.toThrow('boom');
    // A stuck slot would mean one bad git invocation freezes every later refresh.
    await expect(succeeded).resolves.toBe('ok');
  });

  it('treats a concurrency below one as one', async () => {
    const scheduler = createBoundedScheduler({ concurrency: 0 });

    await expect(scheduler.run('a', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('coalescing', () => {
  it('joins a request for a key that is still queued', async () => {
    // Performance rule 9: a watcher batch asking for five refreshes must produce one
    // git process, not five.
    const scheduler = createBoundedScheduler({ concurrency: 1 });
    const blocker = deferred<string>();
    void scheduler.run('blocker', async () => blocker.promise);

    let invocations = 0;
    const task = async (): Promise<string> => {
      invocations += 1;
      return 'status';
    };

    const first = scheduler.run('status', task);
    const second = scheduler.run('status', task);
    const third = scheduler.run('status', task);

    expect(second).toBe(first);
    expect(third).toBe(first);

    blocker.resolve('done');
    expect(await first).toBe('status');
    expect(invocations).toBe(1);
  });

  it('does not join a request that has already started', async () => {
    // The running one may have read the tree before the change that prompted the new
    // request, so the new request has to actually run.
    const scheduler = createBoundedScheduler({ concurrency: 2 });
    const gate = deferred<string>();
    let invocations = 0;

    const running = scheduler.run('status', async () => {
      invocations += 1;
      return gate.promise;
    });
    await tick();

    const fresh = scheduler.run('status', async () => {
      invocations += 1;
      return 'second';
    });

    expect(fresh).not.toBe(running);
    gate.resolve('first');
    expect(await running).toBe('first');
    expect(await fresh).toBe('second');
    expect(invocations).toBe(2);
  });

  it('does not coalesce different keys', async () => {
    const scheduler = createBoundedScheduler({ concurrency: 1 });
    const blocker = deferred<string>();
    void scheduler.run('blocker', async () => blocker.promise);

    const a = scheduler.run('status:/repo-a', async () => 'a');
    const b = scheduler.run('status:/repo-b', async () => 'b');

    expect(a).not.toBe(b);
    blocker.resolve('done');
    expect(await Promise.all([a, b])).toEqual(['a', 'b']);
  });

  it('propagates a failure to every joined caller', async () => {
    const scheduler = createBoundedScheduler({ concurrency: 1 });
    const blocker = deferred<string>();
    void scheduler.run('blocker', async () => blocker.promise);

    const task = async (): Promise<string> => {
      throw new Error('git failed');
    };
    const first = scheduler.run('status', task);
    const second = scheduler.run('status', task);

    blocker.resolve('done');

    // A coalesced failure must not be silently swallowed for the second caller.
    await expect(first).rejects.toThrow('git failed');
    await expect(second).rejects.toThrow('git failed');
  });

  it('allows a new request once the previous one finished', async () => {
    const scheduler = createBoundedScheduler({ concurrency: 1 });
    let invocations = 0;
    const task = async (): Promise<number> => {
      invocations += 1;
      return invocations;
    };

    expect(await scheduler.run('status', task)).toBe(1);
    expect(await scheduler.run('status', task)).toBe(2);
  });
});

describe('bookkeeping', () => {
  it('reports queued and running counts', async () => {
    const scheduler = createBoundedScheduler({ concurrency: 1 });
    const gate = deferred<string>();

    const first = scheduler.run('a', async () => gate.promise);
    const second = scheduler.run('b', async () => 'b');
    await tick();

    expect(scheduler.running()).toBe(1);
    expect(scheduler.queued()).toBe(1);

    gate.resolve('a');
    await Promise.all([first, second]);

    expect(scheduler.running()).toBe(0);
    expect(scheduler.queued()).toBe(0);
  });
});
