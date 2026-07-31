import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Result } from '@shared/ipc/result';

type Invoker = (event: unknown, raw: unknown) => Promise<unknown>;

const registered = new Map<string, Invoker>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, listener: Invoker) => {
      registered.set(channel, listener);
    },
  },
}));

const { handle, handleResult } = await import('./handle');

const invoke = async <T>(channel: string, raw: unknown): Promise<Result<T>> => {
  const listener = registered.get(channel);
  if (!listener) {
    throw new Error(`nothing registered on ${channel}`);
  }
  return (await listener({}, raw)) as Result<T>;
};

const schema = z.object({ name: z.string().min(1) });

beforeEach(() => {
  registered.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('handle', () => {
  it('passes a valid payload through and wraps the return value', async () => {
    handle('t:ok', schema, (request) => `hello ${request.name}`);

    const result = await invoke<string>('t:ok', { name: 'azir' });

    expect(result).toEqual({ ok: true, value: 'hello azir' });
  });

  it('rejects a payload that fails validation without calling the handler', async () => {
    const handler = vi.fn();
    handle('t:invalid', schema, handler);

    const result = await invoke('t:invalid', { name: '' });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.error.code).toBe('invalid-request');
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 'string', 42, [], { other: true }])(
    'rejects the non-conforming payload %o',
    async (raw) => {
      handle('t:shape', schema, () => 'never');

      const result = await invoke('t:shape', raw);

      expect(result.ok).toBe(false);
    },
  );

  it('converts a thrown exception into an error Result rather than rejecting', async () => {
    handle('t:throws', schema, () => {
      throw new Error('handler exploded');
    });

    // The point of the wrapper: this await must not reject.
    const result = await invoke('t:throws', { name: 'azir' });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.error.code).toBe('internal');
    expect(result.error.detail).toContain('handler exploded');
  });

  it('converts a rejected promise the same way', async () => {
    handle('t:rejects', schema, async () => {
      await Promise.resolve();
      throw new Error('async explosion');
    });

    const result = await invoke('t:rejects', { name: 'azir' });

    expect(result.ok).toBe(false);
  });
});

describe('handleResult', () => {
  it('passes an expected failure through untouched', async () => {
    handleResult('t:expected', schema, () => ({
      ok: false as const,
      error: { code: 'git-missing' as const, message: 'git is not installed.' },
    }));

    const result = await invoke('t:expected', { name: 'azir' });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    // Not rewritten to `internal` — the distinction between "this subsystem is
    // unavailable" and "we have a bug" is what the reducer branches on.
    expect(result.error.code).toBe('git-missing');
  });

  it('still catches genuine bugs', async () => {
    handleResult('t:bug', schema, () => {
      throw new Error('unexpected');
    });

    const result = await invoke('t:bug', { name: 'azir' });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.error.code).toBe('internal');
  });

  it('still validates the request', async () => {
    const handler = vi.fn();
    handleResult('t:validate', schema, handler);

    const result = await invoke('t:validate', {});

    expect(result.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
