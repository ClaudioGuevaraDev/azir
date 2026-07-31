import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionRegistry, type SessionRegistry } from './sessions';

const rootA = path.resolve(path.sep === '\\' ? 'C:\\work\\alpha' : '/work/alpha');
const rootB = path.resolve(path.sep === '\\' ? 'C:\\work\\beta' : '/work/beta');

const allDirectories = async (): Promise<boolean> => true;

const openOk = async (registry: SessionRegistry, root: string): Promise<number> => {
  const result = await registry.open(root);
  if (!result.ok) {
    throw new Error(`expected open to succeed: ${result.error.code}`);
  }
  return result.value.sessionId;
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('open', () => {
  it('mints a session with a normalised root and a display name', async () => {
    const registry = createSessionRegistry({ statDirectory: allDirectories });

    const result = await registry.open(`${rootA}${path.sep}`);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('unreachable');
    }
    expect(result.value.root).toBe(rootA);
    expect(result.value.name).toBe('alpha');
  });

  it('refuses a path that is not a directory', async () => {
    const registry = createSessionRegistry({ statDirectory: async () => false });

    const result = await registry.open(rootA);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.error.code).toBe('not-a-file');
    expect(registry.current()).toBeUndefined();
  });

  it('turns a stat failure into state rather than throwing', async () => {
    const registry = createSessionRegistry({
      statDirectory: async () => {
        throw new Error('ENOENT');
      },
    });

    const result = await registry.open(rootA);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.error.code).toBe('not-found');
  });

  it('never reuses an id, so a late event for a dead session cannot be accepted', async () => {
    const registry = createSessionRegistry({ statDirectory: allDirectories });

    const first = await openOk(registry, rootA);
    registry.close(first);
    const second = await openOk(registry, rootA);
    registry.close(second);
    const third = await openOk(registry, rootB);

    expect(new Set([first, second, third]).size).toBe(3);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });
});

describe('disposal', () => {
  it('disposes the previous session when a second folder is opened', async () => {
    const registry = createSessionRegistry({ statDirectory: allDirectories });
    const disposed: number[] = [];
    registry.onDispose((session) => {
      disposed.push(session.id);
    });

    const first = await openOk(registry, rootA);
    const second = await openOk(registry, rootB);

    expect(disposed).toEqual([first]);
    expect(registry.current()?.id).toBe(second);
  });

  it('never lets a listener observe two live sessions at once', async () => {
    const registry = createSessionRegistry({ statDirectory: allDirectories });
    const observed: (number | undefined)[] = [];
    registry.onDispose(() => {
      observed.push(registry.current()?.id);
    });

    await openOk(registry, rootA);
    await openOk(registry, rootB);

    // The old session is cleared before listeners run, and the new one is not
    // installed until they finish.
    expect(observed).toEqual([undefined]);
  });

  it('runs every listener even when one throws', async () => {
    const registry = createSessionRegistry({ statDirectory: allDirectories });
    const calls: string[] = [];
    registry.onDispose(() => {
      calls.push('first');
      throw new Error('listener exploded');
    });
    registry.onDispose(() => {
      calls.push('second');
    });

    const id = await openOk(registry, rootA);
    registry.close(id);

    // Cleanup that abandons half the resources is worse than no cleanup, because
    // the leak is invisible.
    expect(calls).toEqual(['first', 'second']);
  });

  it('is idempotent', async () => {
    const registry = createSessionRegistry({ statDirectory: allDirectories });
    const disposed: number[] = [];
    registry.onDispose((session) => {
      disposed.push(session.id);
    });

    const id = await openOk(registry, rootA);

    expect(registry.close(id)).toBe(true);
    expect(registry.close(id)).toBe(false);
    expect(registry.close(9999)).toBe(false);
    registry.closeAll();

    expect(disposed).toEqual([id]);
  });

  it('completes synchronously, which is what shutdown depends on', async () => {
    // Electron does not restart a quit sequence, so `before-quit` cannot await
    // cleanup — it has to be finished by the time the handler returns. If
    // disposal ever became async again, the app would quit with PTYs still alive.
    const registry = createSessionRegistry({ statDirectory: allDirectories });
    const disposed: number[] = [];
    registry.onDispose((session) => {
      disposed.push(session.id);
    });

    const id = await openOk(registry, rootA);
    registry.closeAll();

    // Asserted with no `await` in between.
    expect(disposed).toEqual([id]);
    expect(registry.current()).toBeUndefined();
  });
});

describe('require', () => {
  it('accepts the live session', async () => {
    const registry = createSessionRegistry({ statDirectory: allDirectories });
    const id = await openOk(registry, rootA);

    expect(registry.require(id).ok).toBe(true);
  });

  it.each([
    ['a closed session', true],
    ['an id that never existed', false],
  ])('refuses %s with stale-session', async (_label, closeFirst) => {
    const registry = createSessionRegistry({ statDirectory: allDirectories });
    const id = await openOk(registry, rootA);
    if (closeFirst) {
      registry.close(id);
    }

    const result = registry.require(closeFirst ? id : id + 500);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.error.code).toBe('stale-session');
  });

  it('refuses the previous session after a second folder is opened', async () => {
    const registry = createSessionRegistry({ statDirectory: allDirectories });
    const first = await openOk(registry, rootA);
    await openOk(registry, rootB);

    const result = registry.require(first);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.error.code).toBe('stale-session');
  });
});

describe('resolve', () => {
  it('resolves against the root the registry recorded, not one supplied by a caller', async () => {
    const registry = createSessionRegistry({ statDirectory: allDirectories });
    const id = await openOk(registry, rootA);

    const result = registry.resolve(id, 'src/index.ts');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('unreachable');
    }
    expect(result.value).toBe(path.join(rootA, 'src', 'index.ts'));
  });

  it('applies the path sandbox', async () => {
    const registry = createSessionRegistry({ statDirectory: allDirectories });
    const id = await openOk(registry, rootA);

    const result = registry.resolve(id, '../beta/secret');

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.error.code).toBe('path-outside-workspace');
  });

  it('checks the session before the path, so a dead session leaks no filesystem information', async () => {
    const registry = createSessionRegistry({ statDirectory: allDirectories });
    const id = await openOk(registry, rootA);
    registry.close(id);

    const result = registry.resolve(id, '../../etc/passwd');

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.error.code).toBe('stale-session');
  });
});
