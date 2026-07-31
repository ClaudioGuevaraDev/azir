import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppBridge } from '@shared/bridge';
import type { WorkspaceInfo } from '@shared/ipc/contracts';
import type { Result } from '@shared/ipc/result';
import type { Action } from '../actions';
import { createEffectRunner } from './effectRunner';
import { resetRequestIds } from './requestIds';

/**
 * The effect runner is the renderer's only door to the outside, so it is tested
 * against a fake `AppBridge` rather than against Electron. That fake is the same
 * interface the preload implements, which is what makes the substitution honest.
 */

const info: WorkspaceInfo = { sessionId: 1, root: '/work/repo', name: 'repo' };

interface Fake {
  readonly bridge: AppBridge;
  readonly pickFolder: ReturnType<typeof vi.fn>;
  readonly open: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
}

const fakeBridge = (): Fake => {
  const pickFolder = vi.fn<() => Promise<Result<string | null>>>();
  const open = vi.fn<() => Promise<Result<WorkspaceInfo>>>();
  const close = vi.fn<() => Promise<Result<{ closed: boolean }>>>();

  return {
    pickFolder,
    open,
    close,
    bridge: {
      app: { ping: vi.fn() },
      workspace: {
        pickFolder,
        open,
        close,
      },
    } as unknown as AppBridge,
  };
};

/** Lets the runner's internal promise chain settle. */
const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  resetRequestIds();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('workspace/pickFolder', () => {
  it('dispatches pathChosen with a freshly minted request id', async () => {
    const fake = fakeBridge();
    fake.pickFolder.mockResolvedValue({ ok: true, value: '/work/repo' });
    const dispatched: Action[] = [];

    createEffectRunner(fake.bridge)({ type: 'workspace/pickFolder' }, (action) => {
      dispatched.push(action);
    });
    await flush();

    expect(dispatched).toEqual([
      { type: 'workspace/pathChosen', path: '/work/repo', requestId: 'r1' },
    ]);
  });

  it('dispatches pickCancelled when the user dismisses the dialog', async () => {
    const fake = fakeBridge();
    fake.pickFolder.mockResolvedValue({ ok: true, value: null });
    const dispatched: Action[] = [];

    createEffectRunner(fake.bridge)({ type: 'workspace/pickFolder' }, (action) => {
      dispatched.push(action);
    });
    await flush();

    expect(dispatched).toEqual([{ type: 'workspace/pickCancelled' }]);
  });

  it('turns a bridge error into pickFailed rather than throwing', async () => {
    const fake = fakeBridge();
    fake.pickFolder.mockResolvedValue({
      ok: false,
      error: { code: 'internal', message: 'dialog unavailable' },
    });
    const dispatched: Action[] = [];

    createEffectRunner(fake.bridge)({ type: 'workspace/pickFolder' }, (action) => {
      dispatched.push(action);
    });
    await flush();

    expect(dispatched[0]).toMatchObject({ type: 'workspace/pickFailed' });
  });
});

describe('workspace/open', () => {
  it('carries the request id from the effect onto the resulting action', async () => {
    const fake = fakeBridge();
    fake.open.mockResolvedValue({ ok: true, value: info });
    const dispatched: Action[] = [];

    createEffectRunner(fake.bridge)(
      { type: 'workspace/open', path: '/work/repo', requestId: 'r42' },
      (action) => {
        dispatched.push(action);
      },
    );
    await flush();

    // Without this, the reducer's staleness gate has nothing to compare.
    expect(dispatched).toEqual([{ type: 'workspace/opened', requestId: 'r42', info }]);
  });

  it('carries the request id onto a failure too', async () => {
    const fake = fakeBridge();
    fake.open.mockResolvedValue({
      ok: false,
      error: { code: 'not-found', message: 'missing' },
    });
    const dispatched: Action[] = [];

    createEffectRunner(fake.bridge)(
      { type: 'workspace/open', path: '/nope', requestId: 'r42' },
      (action) => {
        dispatched.push(action);
      },
    );
    await flush();

    expect(dispatched[0]).toMatchObject({ type: 'workspace/openFailed', requestId: 'r42' });
  });

  it('sends only the path, never a session the renderer invented', async () => {
    const fake = fakeBridge();
    fake.open.mockResolvedValue({ ok: true, value: info });

    createEffectRunner(fake.bridge)(
      { type: 'workspace/open', path: '/work/repo', requestId: 'r1' },
      () => {},
    );
    await flush();

    expect(fake.open).toHaveBeenCalledWith({ path: '/work/repo' });
  });
});

describe('workspace/close', () => {
  it('confirms the close', async () => {
    const fake = fakeBridge();
    fake.close.mockResolvedValue({ ok: true, value: { closed: true } });
    const dispatched: Action[] = [];

    createEffectRunner(fake.bridge)({ type: 'workspace/close', sessionId: 5 }, (action) => {
      dispatched.push(action);
    });
    await flush();

    expect(dispatched).toEqual([{ type: 'workspace/closed', sessionId: 5 }]);
  });

  it('raises a notice instead of blocking when teardown fails', async () => {
    const fake = fakeBridge();
    fake.close.mockResolvedValue({
      ok: false,
      error: { code: 'internal', message: 'pty refused to die', detail: 'EPERM' },
    });
    const dispatched: Action[] = [];

    createEffectRunner(fake.bridge)({ type: 'workspace/close', sessionId: 5 }, (action) => {
      dispatched.push(action);
    });
    await flush();

    // The workspace is already gone from the renderer's point of view; the user
    // must not be trapped in it because main had trouble cleaning up.
    expect(dispatched[0]).toMatchObject({
      type: 'notice/raised',
      severity: 'warning',
      detail: 'EPERM',
    });
  });
});

describe('failure containment', () => {
  it('converts a rejected bridge call into a notice, not an unhandled rejection', async () => {
    const fake = fakeBridge();
    fake.pickFolder.mockRejectedValue(new Error('ipc channel closed'));
    const dispatched: Action[] = [];

    createEffectRunner(fake.bridge)({ type: 'workspace/pickFolder' }, (action) => {
      dispatched.push(action);
    });
    await flush();

    expect(dispatched[0]).toMatchObject({
      type: 'notice/raised',
      severity: 'error',
      detail: 'ipc channel closed',
    });
  });

  it('returns synchronously, so the store is never made to await an effect', () => {
    const fake = fakeBridge();
    fake.pickFolder.mockResolvedValue({ ok: true, value: null });

    const returned = createEffectRunner(fake.bridge)({ type: 'workspace/pickFolder' }, () => {});

    expect(returned).toBeUndefined();
  });
});
