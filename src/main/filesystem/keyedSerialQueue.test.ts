import { describe, expect, it } from 'vitest';
import { createKeyedSerialQueue } from './keyedSerialQueue';

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

describe('serialisation', () => {
  it('runs one task at a time per key', async () => {
    // Two concurrent writes to the same file can interleave and produce a mixture of both
    // versions — a corrupted file rather than a stale one.
    const queue = createKeyedSerialQueue<string>();
    const first = deferred<string>();
    let concurrent = 0;
    let peak = 0;

    const track = async (gate: Promise<string>): Promise<string> => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      const value = await gate;
      concurrent -= 1;
      return value;
    };

    const a = queue.enqueue('file', () => track(first.promise));
    await tick();
    const b = queue.enqueue('file', () => track(Promise.resolve('second')));

    first.resolve('first');
    await Promise.all([a, b]);

    expect(peak).toBe(1);
  });

  it('runs tasks for different keys in parallel', async () => {
    const queue = createKeyedSerialQueue<string>();
    const gate = deferred<string>();

    const slow = queue.enqueue('slow', () => gate.promise);
    const fast = await queue.enqueue('fast', async () => 'done');

    // A slow write to one file must not delay a save to another.
    expect(fast).toBe('done');
    gate.resolve('eventually');
    await slow;
  });

  it('preserves order for a single key', async () => {
    const queue = createKeyedSerialQueue<number>();
    const order: number[] = [];
    const gate = deferred<number>();

    const first = queue.enqueue('file', async () => {
      const value = await gate.promise;
      order.push(value);
      return value;
    });
    await tick();
    const second = queue.enqueue('file', async () => {
      order.push(2);
      return 2;
    });

    gate.resolve(1);
    await Promise.all([first, second]);

    expect(order).toEqual([1, 2]);
  });
});

describe('coalescing', () => {
  it('a newer task replaces a waiting one', async () => {
    // The older content is already obsolete; writing it and immediately overwriting it is pure
    // I/O for a result nobody will ever see.
    const queue = createKeyedSerialQueue<string>();
    const gate = deferred<string>();
    const ran: string[] = [];

    const inFlight = queue.enqueue('file', () => gate.promise);
    await tick();

    queue.enqueue('file', async () => {
      ran.push('v2');
      return 'v2';
    });
    queue.enqueue('file', async () => {
      ran.push('v3');
      return 'v3';
    });

    gate.resolve('v1');
    await inFlight;
    await tick();
    await tick();

    expect(ran).toEqual(['v3']);
  });

  it('settles every caller whose task was replaced', async () => {
    // The failure this guards is the worst kind: a save that never resolves, leaving the UI
    // showing "saving…" forever with no error to report.
    const queue = createKeyedSerialQueue<string>();
    const gate = deferred<string>();

    const inFlight = queue.enqueue('file', () => gate.promise);
    await tick();

    const superseded = queue.enqueue('file', async () => 'v2');
    const winner = queue.enqueue('file', async () => 'v3');

    gate.resolve('v1');

    expect(await inFlight).toBe('v1');
    // Both settle, and both with the outcome of the task that actually ran.
    expect(await superseded).toBe('v3');
    expect(await winner).toBe('v3');
  });

  it('propagates a failure to every joined caller', async () => {
    const queue = createKeyedSerialQueue<string>();
    const gate = deferred<string>();

    const inFlight = queue.enqueue('file', () => gate.promise);
    await tick();

    const superseded = queue.enqueue('file', async () => 'v2');
    const winner = queue.enqueue('file', async () => {
      throw new Error('disk full');
    });

    gate.resolve('v1');
    await inFlight;

    await expect(superseded).rejects.toThrow('disk full');
    await expect(winner).rejects.toThrow('disk full');
  });
});

describe('failure containment', () => {
  it('keeps draining after a task throws', async () => {
    const queue = createKeyedSerialQueue<string>();

    const failed = queue.enqueue('file', async () => {
      throw new Error('boom');
    });
    await expect(failed).rejects.toThrow('boom');

    // A stuck key would mean one failed write blocks every later save to that file.
    await expect(queue.enqueue('file', async () => 'ok')).resolves.toBe('ok');
  });

  it('releases the key once everything settles', async () => {
    const queue = createKeyedSerialQueue<string>();

    await queue.enqueue('file', async () => 'ok');
    await tick();

    expect(queue.busy('file')).toBe(false);
    expect(queue.size()).toBe(0);
  });
});

describe('busy', () => {
  it('reports a key with work in flight', async () => {
    const queue = createKeyedSerialQueue<string>();
    const gate = deferred<string>();

    const pending = queue.enqueue('file', () => gate.promise);
    await tick();

    expect(queue.busy('file')).toBe(true);
    expect(queue.busy('other')).toBe(false);

    gate.resolve('done');
    await pending;
  });
});
