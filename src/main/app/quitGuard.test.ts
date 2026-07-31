import { describe, expect, it, vi } from 'vitest';
import { CHANNELS } from '@shared/ipc/channels';
import { createQuitGuard } from './quitGuard';
import type { RendererChannel } from './rendererChannel';

const setup = () => {
  const sent: Array<{ channel: string }> = [];
  const renderer: RendererChannel = {
    send: (channel) => {
      sent.push({ channel });
    },
    attach: () => {},
    detach: () => {},
  };

  let listener: ((event: { preventDefault(): void }) => void) | undefined;
  const quit = vi.fn();

  const guard = createQuitGuard({
    renderer,
    onBeforeQuit: (fn) => {
      listener = fn;
    },
    quit,
  });
  guard.install();

  const fireBeforeQuit = (): { prevented: boolean } => {
    let prevented = false;
    listener?.({
      preventDefault: () => {
        prevented = true;
      },
    });
    return { prevented };
  };

  return { guard, sent, quit, fireBeforeQuit };
};

const flushImmediate = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('with nothing unsaved', () => {
  it('lets the quit through', () => {
    const { fireBeforeQuit, sent } = setup();

    expect(fireBeforeQuit().prevented).toBe(false);
    expect(sent).toEqual([]);
  });

  it('lets it through after work is saved', () => {
    const { guard, fireBeforeQuit } = setup();
    guard.setUnsaved(true);
    guard.setUnsaved(false);

    expect(fireBeforeQuit().prevented).toBe(false);
  });
});

describe('with unsaved work', () => {
  it('prevents the quit and asks the renderer', () => {
    const { guard, fireBeforeQuit, sent } = setup();
    guard.setUnsaved(true);

    expect(fireBeforeQuit().prevented).toBe(true);
    expect(sent).toEqual([{ channel: CHANNELS.eventQuitRequested }]);
  });

  it('decides synchronously, without awaiting anything', () => {
    /*
     * The whole reason the unsaved flag is *pushed* rather than fetched. M1 measured that
     * Electron does not restart a cancelled quit sequence, so a handler that prevents the quit
     * in order to go and ask a question can never resume it — the process would sit alive with
     * no windows. Reading a boolean is the only thing this handler is allowed to do.
     */
    const { guard, fireBeforeQuit } = setup();
    guard.setUnsaved(true);

    const result = fireBeforeQuit();

    // Asserted with no await in between.
    expect(result.prevented).toBe(true);
  });

  it('quits on a later tick once the user confirms', async () => {
    const { guard, fireBeforeQuit, quit } = setup();
    guard.setUnsaved(true);
    fireBeforeQuit();

    guard.confirm();

    // Deferred so the quit is a fresh cycle rather than a continuation of the cancelled one.
    expect(quit).not.toHaveBeenCalled();
    await flushImmediate();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('lets the second quit through', async () => {
    const { guard, fireBeforeQuit } = setup();
    guard.setUnsaved(true);
    fireBeforeQuit();
    guard.confirm();
    await flushImmediate();

    expect(fireBeforeQuit().prevented).toBe(false);
  });

  it('asks again after new unsaved work appears', async () => {
    // Agreeing to lose one file's changes must not authorise losing a different file's later.
    const { guard, fireBeforeQuit } = setup();
    guard.setUnsaved(true);
    guard.confirm();
    await flushImmediate();

    guard.setUnsaved(true);

    expect(fireBeforeQuit().prevented).toBe(true);
  });

  it('clears the confirmation when the work is saved instead', async () => {
    const { guard, fireBeforeQuit } = setup();
    guard.setUnsaved(true);
    guard.confirm();
    await flushImmediate();

    // A save resets both the flag and the standing permission.
    guard.setUnsaved(false);
    guard.setUnsaved(true);

    expect(fireBeforeQuit().prevented).toBe(true);
  });

  it('asks once per quit attempt rather than accumulating', () => {
    const { guard, fireBeforeQuit, sent } = setup();
    guard.setUnsaved(true);

    fireBeforeQuit();
    fireBeforeQuit();

    expect(sent).toHaveLength(2);
  });
});
