import type { AppBridge, Unsubscribe } from '@shared/bridge';
import type { TerminalPaneId, WorkspaceSessionId } from '@shared/ipc/contracts';
import type { TerminalRegistry } from '../../terminal/registry';
import { nextRequestId } from './requestIds';
import type { Dispatch } from '../store';

/**
 * Where main-process pushes enter the application.
 *
 * The split here is the whole point, and it is the concrete form of the deviation
 * documented in terminal/registry.ts:
 *
 *  - **`terminal:data` goes to the registry, not the reducer.** Bytes are not
 *    application state. A `tsc --watch` or an `npm install` produces tens of
 *    thousands of chunks; each one entering the reducer would allocate a new
 *    AppState and notify every subscriber.
 *  - **`terminal:exit` goes to the reducer.** It is one discrete, serialisable fact
 *    per pane lifetime, and the pane has to render its exit code.
 *
 * Alongside the byte routing, the pump raises a throttled `terminal/activity` so an
 * inactive pane can show an unread marker. That is the only thing the reducer ever
 * learns about output, and it is at most one action per pane per interval however
 * loud the shell is.
 */

export interface EventPumpOptions {
  readonly bridge: AppBridge;
  readonly registry: TerminalRegistry;
  readonly dispatch: Dispatch;
  /** Which pane is on screen. Read lazily, because it changes constantly. */
  readonly activePaneId: () => TerminalPaneId | null;
  /** Directory paths the tree has loaded, for pre-minting ids on a truncated batch. */
  readonly loadedDirectories: () => readonly string[];
  /** Open tabs with unsaved edits, for the quit confirmation. */
  readonly unsavedPaths: () => readonly string[];
  readonly activityThrottleMs?: number;
  readonly now?: () => number;
}

/**
 * Long enough that a noisy pane costs at most two actions per second, short enough
 * that the marker appears while the user is still looking at the other pane.
 */
const DEFAULT_ACTIVITY_THROTTLE_MS = 500;

export interface EventPump {
  stop(): void;
}

export const startEventPump = (options: EventPumpOptions): EventPump => {
  const throttleMs = options.activityThrottleMs ?? DEFAULT_ACTIVITY_THROTTLE_MS;
  const now = options.now ?? (() => performance.now());

  const lastActivity = new Map<TerminalPaneId, number>();
  const subscriptions: Unsubscribe[] = [];

  const noteActivity = (sessionId: WorkspaceSessionId, paneId: TerminalPaneId): void => {
    if (options.activePaneId() === paneId) {
      return;
    }
    const at = now();
    const previous = lastActivity.get(paneId) ?? -Infinity;
    if (at - previous < throttleMs) {
      return;
    }
    lastActivity.set(paneId, at);
    options.dispatch({ type: 'terminal/activity', sessionId, paneId });
  };

  subscriptions.push(
    options.bridge.terminal.onData((event) => {
      // Straight to the pane's xterm instance. No action, no state, no re-render.
      options.registry.write(event.paneId, event.data);
      noteActivity(event.sessionId, event.paneId);
    }),
  );

  subscriptions.push(
    options.bridge.fs.onChanged((batch) => {
      /*
       * Request ids are pre-minted here, at the dispatch edge.
       *
       * The reducer decides *which* directories to reload — it is the only thing that
       * knows which are loaded — but it cannot mint the ids those reloads need without
       * becoming impure. So one id is minted per candidate path up front and the
       * reducer picks the ones it uses. Minting a few ids that go unused is the price
       * of keeping the reducer deterministic and snapshot-testable.
       */
      const directoryRequestIds: Record<string, string> = {};
      for (const directory of batch.directories) {
        directoryRequestIds[directory] = nextRequestId();
      }
      // A truncated batch makes the reducer reload everything already loaded, so those
      // paths need ids too.
      if (batch.truncated) {
        for (const directory of options.loadedDirectories()) {
          directoryRequestIds[directory] ??= nextRequestId();
        }
      }

      options.dispatch({
        type: 'fs/changed',
        sessionId: batch.sessionId,
        batch,
        gitRequestId: nextRequestId(),
        directoryRequestIds,
        viewerContentRequestId: nextRequestId(),
        viewerDiffRequestId: nextRequestId(),
      });
    }),
  );

  subscriptions.push(
    options.bridge.app.onQuitRequested(() => {
      // The paths are read here because the overlay slice cannot see the viewer slice, and the
      // reducer is not allowed to go looking.
      options.dispatch({ type: 'app/quitRequested', unsavedPaths: options.unsavedPaths() });
    }),
  );

  subscriptions.push(
    options.bridge.terminal.onExit((event) => {
      lastActivity.delete(event.paneId);
      options.dispatch({
        type: 'terminal/exited',
        sessionId: event.sessionId,
        paneId: event.paneId,
        exitCode: event.exitCode,
      });
    }),
  );

  return {
    stop() {
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
      subscriptions.length = 0;
      lastActivity.clear();
    },
  };
};
