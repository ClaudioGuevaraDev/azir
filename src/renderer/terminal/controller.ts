import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { TerminalPaneId, WorkspaceSessionId } from '@shared/ipc/contracts';
import type { OutputSink } from './registry';

/**
 * Owns one xterm.js instance and the wiring between it and the bridge.
 *
 * Lives entirely outside React's render tree. React creates and destroys
 * controllers as panes appear and disappear, but every byte, keystroke and resize
 * afterwards flows through here without touching state — that is what keeps a
 * build log from re-rendering the workspace.
 *
 * The instance survives becoming invisible. docs/architecture.md requires that
 * "switching the active pane does not recreate xterm.js or node-pty" and that
 * "hidden panes continue running", so the DOM element is detached and re-attached
 * rather than the terminal being rebuilt.
 */

export interface TerminalTransport {
  write(request: { sessionId: WorkspaceSessionId; paneId: TerminalPaneId; data: string }): void;
  resize(request: {
    sessionId: WorkspaceSessionId;
    paneId: TerminalPaneId;
    cols: number;
    rows: number;
  }): void;
}

export interface TerminalThemeColors {
  readonly background: string;
  readonly foreground: string;
  readonly cursor: string;
  readonly selectionBackground: string;
  readonly black: string;
  readonly red: string;
  readonly green: string;
  readonly yellow: string;
  readonly blue: string;
  readonly magenta: string;
  readonly cyan: string;
  readonly white: string;
  readonly brightBlack: string;
  readonly brightRed: string;
  readonly brightGreen: string;
  readonly brightYellow: string;
  readonly brightBlue: string;
  readonly brightMagenta: string;
  readonly brightCyan: string;
  readonly brightWhite: string;
}

export interface TerminalControllerOptions {
  readonly sessionId: WorkspaceSessionId;
  readonly paneId: TerminalPaneId;
  readonly transport: TerminalTransport;
  readonly theme: TerminalThemeColors;
  readonly fontFamily: string;
  readonly fontSize?: number;
  /** Injected in tests so flushing can be driven without a real frame loop. */
  readonly scheduleFrame?: (callback: () => void) => number;
  readonly cancelFrame?: (handle: number) => void;
}

export interface TerminalController extends OutputSink {
  /** Attaches to a DOM element. Safe to call again after `detach`. */
  attach(element: HTMLElement): void;
  detach(): void;
  /** Recomputes the character grid and tells the PTY, if it changed. */
  fit(): void;
  focus(): void;
  search(query: string): void;
  clearSearch(): void;
  dispose(): void;
}

export const createTerminalController = (
  options: TerminalControllerOptions,
): TerminalController => {
  const scheduleFrame = options.scheduleFrame ?? requestAnimationFrame.bind(globalThis);
  const cancelFrame = options.cancelFrame ?? cancelAnimationFrame.bind(globalThis);

  const terminal = new Terminal({
    fontFamily: options.fontFamily,
    fontSize: options.fontSize ?? 12,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'bar',
    // Deep enough to hold a long build log, bounded so a runaway process cannot
    // exhaust memory.
    scrollback: 5000,
    allowProposedApi: true,
    theme: { ...options.theme },
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  const unicodeAddon = new Unicode11Addon();

  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(unicodeAddon);
  // Grapheme-correct widths, so a prompt containing an emoji or CJK text does not
  // drift out of alignment.
  terminal.unicode.activeVersion = '11';

  terminal.loadAddon(
    new WebLinksAddon((event, uri) => {
      event.preventDefault();
      // Opening happens in main, which validates the protocol before handing it to
      // the OS. The renderer only reports the intent.
      window.open(uri, '_blank', 'noopener,noreferrer');
    }),
  );

  terminal.onData((data) => {
    options.transport.write({ sessionId: options.sessionId, paneId: options.paneId, data });
  });

  // Bracketed paste and other multi-byte sequences arrive here rather than
  // onData; forwarding both is what makes paste work.
  terminal.onBinary((data) => {
    options.transport.write({ sessionId: options.sessionId, paneId: options.paneId, data });
  });

  // ---- Output batching.
  //
  // The main-process pump already coalesces over ~8 ms, but a burst can still
  // deliver several IPC messages within one frame. Writing each straight to xterm
  // forces a reflow per message; batching to the next frame bounds the work to one
  // per paint.
  let queued: string[] = [];
  let frame: number | undefined;
  let disposed = false;

  const flush = (): void => {
    frame = undefined;
    if (queued.length === 0 || disposed) {
      return;
    }
    const payload = queued.join('');
    queued = [];
    terminal.write(payload);
  };

  // ---- Resize deduplication.
  //
  // A ResizeObserver fires continuously during a window drag, but the PTY only
  // cares when the character grid changes. Some shells repaint on every resize, so
  // a redundant one is visible, not just wasteful. Main deduplicates as well; this
  // one also saves the IPC hop.
  let lastCols = 0;
  let lastRows = 0;

  return {
    write(data) {
      if (disposed || data === '') {
        return;
      }
      queued.push(data);
      frame ??= scheduleFrame(flush);
    },

    attach(element) {
      if (disposed) {
        return;
      }
      terminal.open(element);
      // The element usually has no size on the frame it is created, so a fit here
      // would compute a 1x1 grid. The pane's ResizeObserver calls `fit` once layout
      // has settled.
    },

    detach() {
      // xterm has no `close`; the element is removed by React and the instance is
      // kept so scrollback and shell state survive the pane being hidden.
    },

    fit() {
      if (disposed) {
        return;
      }
      try {
        fitAddon.fit();
      } catch {
        // `fit` throws when the element is detached or has zero size, which happens
        // routinely while a pane is animating in or the window is minimised.
        return;
      }

      const { cols, rows } = terminal;
      if (cols === lastCols && rows === lastRows) {
        return;
      }
      if (cols < 1 || rows < 1) {
        return;
      }
      lastCols = cols;
      lastRows = rows;
      options.transport.resize({
        sessionId: options.sessionId,
        paneId: options.paneId,
        cols,
        rows,
      });
    },

    focus() {
      if (!disposed) {
        terminal.focus();
      }
    },

    search(query) {
      if (disposed || query === '') {
        return;
      }
      searchAddon.findNext(query, { incremental: true });
    },

    clearSearch() {
      if (!disposed) {
        searchAddon.clearDecorations();
      }
    },

    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      if (frame !== undefined) {
        cancelFrame(frame);
        frame = undefined;
      }
      queued = [];
      terminal.dispose();
    },
  };
};
