import { describe, expect, it, vi } from 'vitest';
import { createTerminalRegistry, type OutputSink } from './registry';

const sink = (): OutputSink & { readonly received: string[] } => {
  const received: string[] = [];
  return {
    received,
    write: (data) => {
      received.push(data);
    },
  };
};

describe('routing', () => {
  it('delivers to the registered sink', () => {
    const registry = createTerminalRegistry();
    const p1 = sink();
    registry.register('p1', p1);

    registry.write('p1', 'hello');

    expect(p1.received).toEqual(['hello']);
  });

  it('keeps panes independent', () => {
    const registry = createTerminalRegistry();
    const p1 = sink();
    const p2 = sink();
    registry.register('p1', p1);
    registry.register('p2', p2);

    registry.write('p1', 'one');
    registry.write('p2', 'two');

    expect(p1.received).toEqual(['one']);
    expect(p2.received).toEqual(['two']);
  });

  it('ignores an empty write', () => {
    const registry = createTerminalRegistry();
    const p1 = sink();
    registry.register('p1', p1);

    registry.write('p1', '');

    expect(p1.received).toEqual([]);
  });
});

describe('buffering before mount', () => {
  it('replays in order once a sink attaches', () => {
    // The real ordering problem: the reducer adds the pane, main starts the shell
    // and its banner arrives, and only then does React mount the element. Dropping
    // those bytes would lose the banner and the first prompt.
    const registry = createTerminalRegistry();

    registry.write('p1', 'banner\r\n');
    registry.write('p1', 'PS> ');

    const p1 = sink();
    registry.register('p1', p1);

    expect(p1.received).toEqual(['banner\r\nPS> ']);
  });

  it('does not replay twice', () => {
    const registry = createTerminalRegistry();
    registry.write('p1', 'early');

    const first = sink();
    registry.register('p1', first);
    registry.unregister('p1');
    const second = sink();
    registry.register('p1', second);

    expect(first.received).toEqual(['early']);
    expect(second.received).toEqual([]);
  });

  it('bounds the buffer so a runaway process cannot exhaust the heap', () => {
    const registry = createTerminalRegistry();

    for (let index = 0; index < 1000; index += 1) {
      registry.write('p1', 'x'.repeat(1024));
    }

    // Oldest bytes go first, the same way a scrollback behaves.
    expect(registry.pendingChars('p1')).toBeLessThanOrEqual(256 * 1024 + 1024);
  });

  it('reports nothing pending for an unknown pane', () => {
    const registry = createTerminalRegistry();

    expect(registry.pendingChars('ghost')).toBe(0);
  });
});

describe('unregister', () => {
  it('keeps buffering, because a pane that unmounts may remount', () => {
    const registry = createTerminalRegistry();
    const first = sink();
    registry.register('p1', first);

    registry.unregister('p1');
    registry.write('p1', 'while detached');

    const second = sink();
    registry.register('p1', second);

    expect(first.received).toEqual([]);
    expect(second.received).toEqual(['while detached']);
  });
});

describe('forget', () => {
  it('discards the sink and the buffer', () => {
    const registry = createTerminalRegistry();
    registry.write('p1', 'pending');

    registry.forget('p1');
    const p1 = sink();
    registry.register('p1', p1);

    expect(p1.received).toEqual([]);
    expect(registry.pendingChars('p1')).toBe(0);
  });

  it('stops delivering to a forgotten pane', () => {
    const registry = createTerminalRegistry();
    const p1 = sink();
    registry.register('p1', p1);

    registry.forget('p1');
    registry.write('p1', 'after');

    expect(p1.received).toEqual([]);
  });

  it('forgetAll clears everything', () => {
    const registry = createTerminalRegistry();
    registry.register('p1', sink());
    registry.write('p2', 'buffered');

    registry.forgetAll();

    expect(registry.pendingChars('p2')).toBe(0);
  });
});

describe('throughput', () => {
  it('does not allocate per chunk beyond the sink call', () => {
    // Not a benchmark — an assertion that the hot path is a map lookup and a call,
    // with no queueing, coalescing or state involved once a sink is attached.
    const registry = createTerminalRegistry();
    const write = vi.fn();
    registry.register('p1', { write });

    for (let index = 0; index < 10_000; index += 1) {
      registry.write('p1', 'chunk');
    }

    expect(write).toHaveBeenCalledTimes(10_000);
    expect(registry.pendingChars('p1')).toBe(0);
  });
});
