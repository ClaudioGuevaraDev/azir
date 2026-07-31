import type { TerminalPaneId } from '@shared/ipc/contracts';

/**
 * The terminal output side channel.
 *
 * This module is the mechanism behind the single largest deviation from
 * docs/architecture.md's action list. The spec includes
 * `{ type: "terminal/output"; paneId; data }`, but dispatching that per PTY chunk
 * contradicts its own performance rules 1–2 ("React does not rerender the entire
 * workspace for every terminal chunk", "Terminal output is delivered directly to
 * the relevant terminal controller") and its own statement that "the xterm.js
 * instance is the terminal's presentation buffer". A build log is tens of
 * thousands of chunks; each one entering the reducer would be a new AppState and a
 * notification.
 *
 * So bytes never become state. They arrive here and are handed to the pane's
 * controller, which owns an xterm.js instance outside React's render tree. What
 * *does* go through the reducer is the discrete, serialisable facts: a pane was
 * created, a pane exited, an inactive pane has unread output.
 *
 * The buffering exists because ordering is not guaranteed: an IPC event can arrive
 * for a pane whose controller has not been constructed yet, since the reducer adds
 * the pane and React mounts it a tick later. Dropping those bytes would silently
 * lose the shell's banner and first prompt.
 */

export interface OutputSink {
  write(data: string): void;
}

export interface TerminalRegistry {
  /** Routes bytes to the pane's sink, buffering if it is not mounted yet. */
  write(paneId: TerminalPaneId, data: string): void;
  /** Attaches a sink and replays anything buffered for it, in order. */
  register(paneId: TerminalPaneId, sink: OutputSink): void;
  /** Detaches without discarding the buffer — used when a pane unmounts. */
  unregister(paneId: TerminalPaneId): void;
  /** Forgets the pane entirely. Used when it is closed or the workspace changes. */
  forget(paneId: TerminalPaneId): void;
  forgetAll(): void;
  /** Test seam. */
  pendingChars(paneId: TerminalPaneId): number;
}

/**
 * A shell can produce more output before mount than anyone will ever read. Capped
 * so a runaway process cannot grow the renderer's heap without bound; the oldest
 * bytes go first, matching how a scrollback behaves.
 */
const MAX_PENDING_CHARS = 256 * 1024;

export const createTerminalRegistry = (): TerminalRegistry => {
  const sinks = new Map<TerminalPaneId, OutputSink>();
  const pending = new Map<TerminalPaneId, string[]>();
  const pendingSize = new Map<TerminalPaneId, number>();

  const trim = (paneId: TerminalPaneId): void => {
    const chunks = pending.get(paneId);
    let size = pendingSize.get(paneId) ?? 0;
    if (!chunks) {
      return;
    }
    while (size > MAX_PENDING_CHARS && chunks.length > 1) {
      const dropped = chunks.shift();
      size -= dropped?.length ?? 0;
    }
    pendingSize.set(paneId, size);
  };

  return {
    write(paneId, data) {
      if (data === '') {
        return;
      }

      const sink = sinks.get(paneId);
      if (sink) {
        sink.write(data);
        return;
      }

      const chunks = pending.get(paneId) ?? [];
      chunks.push(data);
      pending.set(paneId, chunks);
      pendingSize.set(paneId, (pendingSize.get(paneId) ?? 0) + data.length);
      trim(paneId);
    },

    register(paneId, sink) {
      sinks.set(paneId, sink);

      const chunks = pending.get(paneId);
      if (!chunks || chunks.length === 0) {
        return;
      }
      pending.delete(paneId);
      pendingSize.delete(paneId);
      // Joined into one write: xterm parses escape sequences across writes, but a
      // single write is cheaper and keeps the replay atomic.
      sink.write(chunks.join(''));
    },

    unregister(paneId) {
      // The buffer is kept: a pane that unmounts because the layout changed will
      // remount, and its output should still be there.
      sinks.delete(paneId);
    },

    forget(paneId) {
      sinks.delete(paneId);
      pending.delete(paneId);
      pendingSize.delete(paneId);
    },

    forgetAll() {
      sinks.clear();
      pending.clear();
      pendingSize.clear();
    },

    pendingChars(paneId) {
      return pendingSize.get(paneId) ?? 0;
    },
  };
};
