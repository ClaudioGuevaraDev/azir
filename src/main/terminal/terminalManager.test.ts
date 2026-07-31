import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalDataEvent, TerminalExitEvent } from '@shared/ipc/contracts';
import {
  createTerminalManager,
  type CreatePty,
  type CreatePtyOptions,
  type PtyProcess,
  type TerminalManager,
} from './terminalManager';

/**
 * Every guarantee here is tested against a fake PTY. That is not a shortcut: the
 * behaviours that matter — id routing, resize dedupe, idempotent teardown — are
 * about bookkeeping, and a real shell would make them slow and flaky to assert.
 * The real thing is covered by the Playwright suite.
 */

interface FakePty extends PtyProcess {
  emitData(data: string): void;
  emitExit(exitCode: number, signal?: number): void;
  readonly writes: string[];
  readonly resizes: Array<{ cols: number; rows: number }>;
  readonly killed: () => number;
  readonly spawnedWith: CreatePtyOptions;
}

const makeFakePty = (options: CreatePtyOptions, pid = 1234): FakePty => {
  let dataListener: ((data: string) => void) | undefined;
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  const writes: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  let killCount = 0;

  return {
    pid,
    spawnedWith: options,
    writes,
    resizes,
    killed: () => killCount,
    onData: (listener) => {
      dataListener = listener;
    },
    onExit: (listener) => {
      exitListener = listener;
    },
    write: (data) => {
      writes.push(data);
    },
    resize: (cols, rows) => {
      resizes.push({ cols, rows });
    },
    kill: () => {
      killCount += 1;
    },
    emitData: (data) => dataListener?.(data),
    emitExit: (exitCode, signal) =>
      exitListener?.(signal === undefined ? { exitCode } : { exitCode, signal }),
  };
};

interface Harness {
  readonly manager: TerminalManager;
  readonly data: TerminalDataEvent[];
  readonly exits: TerminalExitEvent[];
  readonly ptys: FakePty[];
  readonly flushPumps: () => void;
}

const harness = (overrides: { createPty?: CreatePty; maxPanes?: number } = {}): Harness => {
  const data: TerminalDataEvent[] = [];
  const exits: TerminalExitEvent[] = [];
  const ptys: FakePty[] = [];
  const flushers: Array<() => void> = [];

  const manager = createTerminalManager({
    emitter: {
      data: (event) => data.push(event),
      exit: (event) => exits.push(event),
    },
    createPty:
      overrides.createPty ??
      ((options) => {
        const pty = makeFakePty(options, 1000 + ptys.length);
        ptys.push(pty);
        return pty;
      }),
    resolveShellPath: () => ({ path: '/bin/fake-shell', args: ['-l'] }),
    // A pump that never schedules: emission is synchronous, so assertions do not
    // need a clock. outputPump.test.ts covers the batching itself.
    createPump: (emit) => {
      const pump = {
        push: (chunk: string) => emit(chunk),
        flush: () => {},
        dispose: () => {},
      };
      flushers.push(pump.flush);
      return pump;
    },
    ...(overrides.maxPanes === undefined ? {} : { maxPanes: overrides.maxPanes }),
  });

  return {
    manager,
    data,
    exits,
    ptys,
    flushPumps: () => flushers.forEach((flush) => flush()),
  };
};

const createOk = (h: Harness, sessionId: number, paneId: string): void => {
  const result = h.manager.create({ sessionId, paneId, cwd: '/work/repo', shell: 'default' });
  if (!result.ok) {
    throw new Error(`expected create to succeed: ${result.error.code}`);
  }
};

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('create', () => {
  it('spawns the resolved shell in the cwd it was given', () => {
    const h = harness();

    const result = h.manager.create({
      sessionId: 1,
      paneId: 'p1',
      cwd: '/work/repo',
      shell: 'default',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('unreachable');
    }
    expect(result.value).toMatchObject({
      paneId: 'p1',
      shellPath: '/bin/fake-shell',
      cwd: '/work/repo',
    });
    expect(h.ptys[0]?.spawnedWith).toMatchObject({
      file: '/bin/fake-shell',
      args: ['-l'],
      cwd: '/work/repo',
    });
  });

  it('refuses a duplicate pane id', () => {
    const h = harness();
    createOk(h, 1, 'p1');

    const result = h.manager.create({
      sessionId: 1,
      paneId: 'p1',
      cwd: '/work/repo',
      shell: 'default',
    });

    expect(result.ok).toBe(false);
    expect(h.ptys).toHaveLength(1);
  });

  it('allows the same pane id in a different session, since panes are keyed by both', () => {
    const h = harness();
    createOk(h, 1, 'p1');

    const result = h.manager.create({
      sessionId: 2,
      paneId: 'p1',
      cwd: '/work/other',
      shell: 'default',
    });

    expect(result.ok).toBe(true);
    expect(h.manager.count()).toBe(2);
  });

  it('enforces the pane ceiling', () => {
    const h = harness({ maxPanes: 2 });
    createOk(h, 1, 'p1');
    createOk(h, 1, 'p2');

    const result = h.manager.create({
      sessionId: 1,
      paneId: 'p3',
      cwd: '/work/repo',
      shell: 'default',
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.error.code).toBe('pane-limit-reached');
  });

  it('turns a spawn failure into state, so the rest of the app stays usable', () => {
    const h = harness({
      createPty: () => {
        throw new Error('ENOENT: no such shell');
      },
    });

    const result = h.manager.create({
      sessionId: 1,
      paneId: 'p1',
      cwd: '/work/repo',
      shell: 'default',
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.error.code).toBe('pty-failed');
    expect(result.error.detail).toContain('ENOENT');
    // Nothing was registered, so the ceiling is not consumed by a failed attempt.
    expect(h.manager.count()).toBe(0);
  });
});

describe('data routing', () => {
  it('tags output with the session and pane it came from', () => {
    const h = harness();
    createOk(h, 7, 'p1');

    h.ptys[0]?.emitData('hello');

    expect(h.data).toEqual([{ sessionId: 7, paneId: 'p1', data: 'hello' }]);
  });

  it("keeps two panes' output separate", () => {
    const h = harness();
    createOk(h, 1, 'p1');
    createOk(h, 1, 'p2');

    h.ptys[0]?.emitData('from-one');
    h.ptys[1]?.emitData('from-two');

    expect(h.data.map((event) => `${event.paneId}:${event.data}`)).toEqual([
      'p1:from-one',
      'p2:from-two',
    ]);
  });

  it('drops output produced after a kill', () => {
    // A shell can emit between kill() and the OS reaping it. Forwarding that would
    // deliver bytes to a pane the renderer has already removed.
    const h = harness();
    createOk(h, 1, 'p1');
    h.manager.kill(1, 'p1');

    h.ptys[0]?.emitData('too late');

    expect(h.data).toEqual([]);
  });
});

describe('write', () => {
  it('forwards keystrokes to the right pty', () => {
    const h = harness();
    createOk(h, 1, 'p1');
    createOk(h, 1, 'p2');

    h.manager.write(1, 'p2', 'ls\r');

    expect(h.ptys[0]?.writes).toEqual([]);
    expect(h.ptys[1]?.writes).toEqual(['ls\r']);
  });

  it.each([
    ['an unknown pane', 1, 'nope'],
    ['a pane in another session', 99, 'p1'],
  ])('silently drops a write for %s', (_label, sessionId, paneId) => {
    const h = harness();
    createOk(h, 1, 'p1');

    expect(() => h.manager.write(sessionId, paneId, 'x')).not.toThrow();
    expect(h.ptys[0]?.writes).toEqual([]);
  });

  it('survives a pty that throws on write', () => {
    const h = harness({
      createPty: (options) => {
        const pty = makeFakePty(options);
        return {
          ...pty,
          write: () => {
            throw new Error('EPIPE');
          },
        };
      },
    });
    createOk(h, 1, 'p1');

    expect(() => h.manager.write(1, 'p1', 'x')).not.toThrow();
  });
});

describe('resize', () => {
  it('forwards a genuine change', () => {
    const h = harness();
    createOk(h, 1, 'p1');

    h.manager.resize(1, 'p1', 120, 40);

    expect(h.ptys[0]?.resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it('deduplicates a repeated size', () => {
    // Performance rule 10. A ResizeObserver fires continuously during a drag while
    // the character grid stays the same, and some shells repaint on every resize.
    const h = harness();
    createOk(h, 1, 'p1');

    h.manager.resize(1, 'p1', 120, 40);
    h.manager.resize(1, 'p1', 120, 40);
    h.manager.resize(1, 'p1', 120, 40);

    expect(h.ptys[0]?.resizes).toHaveLength(1);
  });

  it('forwards again once a dimension actually changes', () => {
    const h = harness();
    createOk(h, 1, 'p1');

    h.manager.resize(1, 'p1', 120, 40);
    h.manager.resize(1, 'p1', 120, 41);
    h.manager.resize(1, 'p1', 121, 41);

    expect(h.ptys[0]?.resizes).toEqual([
      { cols: 120, rows: 40 },
      { cols: 120, rows: 41 },
      { cols: 121, rows: 41 },
    ]);
  });

  it('does not treat the initial 80x24 as a change to be re-sent', () => {
    const h = harness();
    createOk(h, 1, 'p1');

    h.manager.resize(1, 'p1', 80, 24);

    expect(h.ptys[0]?.resizes).toEqual([]);
  });

  it('drops a resize for an unknown pane', () => {
    const h = harness();

    expect(() => h.manager.resize(1, 'ghost', 80, 24)).not.toThrow();
  });
});

describe('exit', () => {
  it('reports a shell that exited on its own', () => {
    const h = harness();
    createOk(h, 3, 'p1');

    h.ptys[0]?.emitExit(0);

    expect(h.exits).toEqual([{ sessionId: 3, paneId: 'p1', exitCode: 0 }]);
    expect(h.manager.count()).toBe(0);
  });

  it('includes the signal when there was one', () => {
    const h = harness();
    createOk(h, 1, 'p1');

    h.ptys[0]?.emitExit(1, 9);

    expect(h.exits[0]).toMatchObject({ exitCode: 1, signal: 9 });
  });

  it('stays silent for a pane the user closed, which already knows', () => {
    const h = harness();
    createOk(h, 1, 'p1');

    h.manager.kill(1, 'p1');
    h.ptys[0]?.emitExit(0);

    expect(h.exits).toEqual([]);
  });
});

describe('teardown', () => {
  it('kills the pane and forgets it', () => {
    const h = harness();
    createOk(h, 1, 'p1');

    expect(h.manager.kill(1, 'p1')).toBe(true);

    expect(h.ptys[0]?.killed()).toBe(1);
    expect(h.manager.count()).toBe(0);
  });

  it('is idempotent — a second kill neither throws nor kills twice', () => {
    const h = harness();
    createOk(h, 1, 'p1');

    h.manager.kill(1, 'p1');

    expect(h.manager.kill(1, 'p1')).toBe(false);
    expect(h.ptys[0]?.killed()).toBe(1);
  });

  it('refuses to kill a pane belonging to another session', () => {
    const h = harness();
    createOk(h, 1, 'p1');

    expect(h.manager.kill(2, 'p1')).toBe(false);
    expect(h.ptys[0]?.killed()).toBe(0);
  });

  it("killSession kills only that session's panes", () => {
    const h = harness();
    createOk(h, 1, 'p1');
    createOk(h, 1, 'p2');
    createOk(h, 2, 'p3');

    expect(h.manager.killSession(1)).toBe(2);

    expect(h.ptys[0]?.killed()).toBe(1);
    expect(h.ptys[1]?.killed()).toBe(1);
    expect(h.ptys[2]?.killed()).toBe(0);
    expect(h.manager.count()).toBe(1);
  });

  it('disposeAll leaves nothing behind, and can be called twice', () => {
    // The observable failure of getting this wrong is an orphan shell in Task
    // Manager, which nobody notices until they go looking.
    const h = harness();
    createOk(h, 1, 'p1');
    createOk(h, 2, 'p2');

    h.manager.disposeAll();
    h.manager.disposeAll();

    expect(h.manager.count()).toBe(0);
    expect(h.ptys.map((pty) => pty.killed())).toEqual([1, 1]);
  });

  it('survives a pty whose kill throws, and still forgets it', () => {
    // node-pty throws when the process already exited. The goal was for it to be
    // gone, and it is.
    const h = harness({
      createPty: (options) => ({
        ...makeFakePty(options),
        kill: () => {
          throw new Error('process already exited');
        },
      }),
    });
    createOk(h, 1, 'p1');

    expect(() => h.manager.kill(1, 'p1')).not.toThrow();
    expect(h.manager.count()).toBe(0);
  });
});
