import { describe, expect, it } from 'vitest';
import { createOutputPump } from './outputPump';

/**
 * Driven by a fake clock rather than real timers, so the assertions are about the
 * batching rules and not about how fast the machine happens to be.
 */
const fakeClock = () => {
  let nextHandle = 1;
  const pending = new Map<number, () => void>();

  return {
    schedule: (callback: () => void): number => {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, callback);
      return handle;
    },
    cancel: (handle: number): void => {
      pending.delete(handle);
    },
    /** Runs everything currently scheduled. */
    tick: (): void => {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) {
        callback();
      }
    },
    scheduledCount: (): number => pending.size,
  };
};

const pumpWith = (options: { maxBufferedChars?: number } = {}) => {
  const emitted: string[] = [];
  const clock = fakeClock();
  const pump = createOutputPump((data) => emitted.push(data), {
    schedule: clock.schedule as unknown as typeof setTimeout,
    cancel: clock.cancel as unknown as typeof clearTimeout,
    ...options,
  });
  return { pump, emitted, clock };
};

describe('batching', () => {
  it('coalesces several pushes into one emission', () => {
    const { pump, emitted, clock } = pumpWith();

    pump.push('a');
    pump.push('b');
    pump.push('c');

    // Nothing yet: the whole point is not to cross IPC three times.
    expect(emitted).toEqual([]);

    clock.tick();

    expect(emitted).toEqual(['abc']);
  });

  it('schedules only one flush per batch', () => {
    const { pump, clock } = pumpWith();

    pump.push('a');
    pump.push('b');

    expect(clock.scheduledCount()).toBe(1);
  });

  it('starts a fresh batch after flushing', () => {
    const { pump, emitted, clock } = pumpWith();

    pump.push('first');
    clock.tick();
    pump.push('second');
    clock.tick();

    expect(emitted).toEqual(['first', 'second']);
  });

  it('does nothing on a tick with nothing buffered', () => {
    const { pump, emitted, clock } = pumpWith();

    clock.tick();
    pump.flush();

    expect(emitted).toEqual([]);
  });

  it('ignores an empty push rather than scheduling a flush for it', () => {
    const { pump, clock } = pumpWith();

    pump.push('');

    expect(clock.scheduledCount()).toBe(0);
  });
});

describe('flood handling', () => {
  it('flushes immediately once the size threshold is crossed', () => {
    // Without this, a build log accumulates in main's heap for the whole interval
    // instead of moving on.
    const { pump, emitted } = pumpWith({ maxBufferedChars: 10 });

    pump.push('12345');
    expect(emitted).toEqual([]);

    pump.push('67890');

    expect(emitted).toEqual(['1234567890']);
  });

  it('cancels the pending timer when it flushes early', () => {
    const { pump, emitted, clock } = pumpWith({ maxBufferedChars: 4 });

    pump.push('ab');
    pump.push('cd');
    clock.tick();

    // One emission, not two — the size-triggered flush must clear the timer.
    expect(emitted).toEqual(['abcd']);
  });

  it('handles a single push larger than the threshold', () => {
    const { pump, emitted } = pumpWith({ maxBufferedChars: 4 });

    pump.push('a very long chunk');

    expect(emitted).toEqual(['a very long chunk']);
  });
});

describe('flush', () => {
  it('emits on demand without waiting for the timer', () => {
    const { pump, emitted } = pumpWith();

    pump.push('now');
    pump.flush();

    expect(emitted).toEqual(['now']);
  });
});

describe('dispose', () => {
  it('flushes first, so the last line of output is not lost', () => {
    // Usually the exit status the user is waiting for.
    const { pump, emitted } = pumpWith();

    pump.push('done: exit 0');
    pump.dispose();

    expect(emitted).toEqual(['done: exit 0']);
  });

  it('ignores pushes afterwards', () => {
    const { pump, emitted, clock } = pumpWith();

    pump.dispose();
    pump.push('too late');
    clock.tick();

    expect(emitted).toEqual([]);
  });

  it('is idempotent', () => {
    const { pump, emitted } = pumpWith();

    pump.push('x');
    pump.dispose();
    pump.dispose();

    expect(emitted).toEqual(['x']);
  });
});
