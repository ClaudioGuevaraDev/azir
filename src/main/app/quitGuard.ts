import { app } from 'electron';
import { CHANNELS } from '@shared/ipc/channels';
import type { RendererChannel } from './rendererChannel';

/**
 * Stops the application quitting over unsaved work, without ever awaiting inside a quit
 * handler.
 *
 * docs/architecture.md requires that "closing a dirty tab or quitting the application requires
 * confirmation". The obvious implementation — prevent the quit, ask the renderer, quit again
 * when it answers — does not work, and M1 established why by measuring it: Electron does not
 * restart a quit sequence, so an `app.quit()` issued from inside the cancelled one is a no-op
 * and the process sits alive with no windows.
 *
 * So the state is pushed rather than pulled. The renderer tells main whenever its unsaved
 * status changes, `before-quit` reads a boolean and decides synchronously, and the second
 * `app.quit()` arrives later on a fresh IPC message — a new quit cycle, not a re-entrant one.
 */
export interface QuitGuard {
  /** Called from the renderer whenever unsaved work appears or disappears. */
  setUnsaved(unsaved: boolean): void;
  /** Called when the user chose to quit anyway. */
  confirm(): void;
  install(): void;
}

export interface QuitGuardOptions {
  readonly renderer: RendererChannel;
  /** Injected in tests so no real Electron app is touched. */
  readonly onBeforeQuit?: (listener: (event: { preventDefault(): void }) => void) => void;
  readonly quit?: () => void;
}

export const createQuitGuard = (options: QuitGuardOptions): QuitGuard => {
  const onBeforeQuit =
    options.onBeforeQuit ??
    ((listener) => {
      app.on('before-quit', listener);
    });
  const quit = options.quit ?? (() => app.quit());

  let unsaved = false;
  let confirmed = false;

  return {
    setUnsaved(next) {
      // The confirmation is a one-shot permission, and *new* unsaved work voids it: the user
      // agreeing to lose one file's changes must not silently authorise losing another file's
      // changes made afterwards.
      if (next) {
        confirmed = false;
      }
      unsaved = next;
    },

    confirm() {
      confirmed = true;
      unsaved = false;
      // Deferred to the next tick so the quit is a fresh cycle rather than a continuation of
      // the one that was cancelled.
      setImmediate(quit);
    },

    install() {
      onBeforeQuit((event) => {
        if (!unsaved || confirmed) {
          return;
        }
        event.preventDefault();
        options.renderer.send(CHANNELS.eventQuitRequested, undefined);
      });
    },
  };
};
