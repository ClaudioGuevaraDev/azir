import type { WebContents } from 'electron';

/**
 * Main → renderer pushes.
 *
 * Injected into services rather than reached for globally, so nothing in
 * `src/main` broadcasts to whatever windows happen to exist. v1 has one window,
 * but keeping `send` a bound per-window function means adding a second window
 * later costs a registry map rather than a rewrite of every service
 * (docs/architecture.md lists "application windows" plural while `AppState` models
 * one).
 *
 * Sending before a window is attached, or after it is destroyed, is a no-op:
 * services are started and stopped independently of the window's lifetime, and a
 * PTY that outranks its window by a few milliseconds must not throw.
 */
export interface RendererChannel {
  send(channel: string, payload: unknown): void;
  attach(contents: WebContents): void;
  detach(): void;
}

export const createRendererChannel = (): RendererChannel => {
  let target: WebContents | undefined;

  return {
    send(channel, payload) {
      if (!target || target.isDestroyed()) {
        return;
      }
      target.send(channel, payload);
    },

    attach(contents) {
      target = contents;
      contents.once('destroyed', () => {
        if (target === contents) {
          target = undefined;
        }
      });
    },

    detach() {
      target = undefined;
    },
  };
};
