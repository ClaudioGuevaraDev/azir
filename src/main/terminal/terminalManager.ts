import { spawn as spawnPty } from 'node-pty';
import type {
  CreateTerminalResponse,
  ShellKind,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalPaneId,
  WorkspaceSessionId,
} from '@shared/ipc/contracts';
import { describeError, err, ok, type Result } from '@shared/ipc/result';
import { createOutputPump, type OutputPump } from './outputPump';
import { resolveShell } from './shellResolver';

/**
 * Owns every pseudo-terminal the application has open.
 *
 * The guarantees, all of which are tested against a fake PTY:
 *
 *  - **Panes are keyed by (session, paneId).** An event or a command naming a pane
 *    that is gone is dropped, not misrouted. Combined with never reusing ids, this
 *    is what stops output from a killed shell appearing in the pane that replaced
 *    it (docs/architecture.md, Terminal identities).
 *  - **Resizes are deduplicated.** A window drag fires a ResizeObserver
 *    continuously, but the PTY only cares when the character grid actually
 *    changes; a redundant `resize` makes some shells redraw.
 *  - **Disposal is synchronous and idempotent.** `before-quit` cannot await, so
 *    killing has to be finished by the time the call returns, and it must survive
 *    being called twice. A leaked PTY is an orphan shell in Task Manager.
 *  - **Shutdown kills the shell by pid instead of calling node-pty's `kill()`**, and
 *    that difference is load-bearing rather than a shortcut. See `beginShutdown`.
 *  - **`createPty` is injected**, so every one of those behaviours is testable
 *    without spawning a real shell.
 */

/** The slice of node-pty's `IPty` this module actually uses. */
export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface CreatePtyOptions {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
}

export type CreatePty = (options: CreatePtyOptions) => PtyProcess;

export interface TerminalEmitter {
  data(event: TerminalDataEvent): void;
  exit(event: TerminalExitEvent): void;
}

export interface TerminalManagerOptions {
  readonly createPty?: CreatePty;
  readonly emitter: TerminalEmitter;
  /** Hard ceiling on concurrent panes; the spec requires "a fixed maximum". */
  readonly maxPanes?: number;
  readonly resolveShellPath?: typeof resolveShell;
  /** Injected so the pump can be driven by a fake clock in tests. */
  readonly createPump?: typeof createOutputPump;
  /**
   * Injected for the same reason as `createPty`: so the shutdown path can be asserted
   * without a real shell to kill. Defaults to `process.kill`.
   */
  readonly killProcess?: (pid: number) => void;
}

export interface CreateTerminalOptions {
  readonly sessionId: WorkspaceSessionId;
  readonly paneId: TerminalPaneId;
  readonly cwd: string;
  readonly shell: ShellKind;
}

export interface TerminalManager {
  create(options: CreateTerminalOptions): Result<CreateTerminalResponse>;
  write(sessionId: WorkspaceSessionId, paneId: TerminalPaneId, data: string): void;
  resize(sessionId: WorkspaceSessionId, paneId: TerminalPaneId, cols: number, rows: number): void;
  kill(sessionId: WorkspaceSessionId, paneId: TerminalPaneId): boolean;
  /** Kills every pane belonging to one session. Used on workspace disposal. */
  killSession(sessionId: WorkspaceSessionId): number;
  /**
   * Switches every later teardown to the shutdown path: kill the shell by pid, and do
   * not call node-pty's `kill()`.
   *
   * The reason is a child process that outlives us. On Windows with ConPTY,
   * node-pty's `kill()` calls `_getConsoleProcessList()`, which does
   * `child_process.fork('conpty_console_list_agent')` with no options — so
   * `silent: false` applies and the child **inherits our stdout and stderr**. It then
   * kills the console process list in a `.then()`, i.e. after `before-quit` has already
   * returned, with a 5-second watchdog living inside the process that is dying.
   *
   * Whoever holds those inherited pipes decides when our stdio closes, and that is not
   * academic: Playwright waits for the spawned process's `close` event, which needs the
   * process gone *and* every pipe shut. A surviving agent means `app.close()` never
   * resolves — observed as an intermittent 60-second `afterEach` timeout in
   * `e2e/viewer.spec.ts`, on whichever test happened to close fastest.
   *
   * Killing by pid takes none of that path. What node-pty's `kill()` would additionally
   * do — release the pseudoconsole handles — buys nothing here, because the process
   * holding them is exiting anyway. That is why this is the shutdown path only: closing
   * one pane while the app keeps running must still go through `kill()`, or handles
   * would leak into a live process.
   *
   * It also fixes a second, quieter bug on the same path. node-pty defers `kill()` until
   * its `_isReady` flips, which happens on the PTY's *first byte*; a shell killed before
   * it printed anything never gets killed at all. A pid does not need the shell to have
   * said something first.
   *
   * Must be called before anything starts tearing panes down. In `main/index.ts` that
   * means before `sessions.closeAll()`, which reaches teardown through the session
   * disposal listener.
   */
  beginShutdown(): void;
  /** Kills everything. Used on shutdown. */
  disposeAll(): void;
  count(): number;
}

interface PtySession {
  readonly sessionId: WorkspaceSessionId;
  readonly paneId: TerminalPaneId;
  readonly process: PtyProcess;
  readonly pump: OutputPump;
  readonly cwd: string;
  cols: number;
  rows: number;
  /** Set the moment we decide to kill, so exit handling stays idempotent. */
  closing: boolean;
}

const DEFAULT_MAX_PANES = 8;

/** Matches xterm's own defaults closely enough that the first paint is stable. */
const INITIAL_COLS = 80;
const INITIAL_ROWS = 24;

const keyOf = (sessionId: WorkspaceSessionId, paneId: TerminalPaneId): string =>
  `${sessionId}:${paneId}`;

/**
 * Adapts node-pty's `IPty` to the narrow `PtyProcess` surface above.
 *
 * The narrowing is what makes the manager testable: a fake needs six members, not
 * all of `IPty`. node-pty is imported statically because it ships Node-API
 * prebuilds that load under plain Node as well as Electron, so a unit test
 * importing this module costs nothing beyond the load.
 */
const defaultCreatePty: CreatePty = (options) => {
  const pty = spawnPty(options.file, [...options.args], {
    name: 'xterm-256color',
    cwd: options.cwd,
    cols: options.cols,
    rows: options.rows,
    env: { ...process.env } as Record<string, string>,
    // ConPTY is the modern Windows console API, present on every supported
    // version; the option is ignored on other platforms.
    useConpty: true,
  });

  return {
    pid: pty.pid,
    onData: (listener) => {
      pty.onData(listener);
    },
    onExit: (listener) => {
      pty.onExit(listener);
    },
    write: (data) => {
      pty.write(data);
    },
    resize: (cols, rows) => {
      pty.resize(cols, rows);
    },
    kill: () => {
      pty.kill();
    },
  };
};

export const createTerminalManager = (options: TerminalManagerOptions): TerminalManager => {
  const createPty = options.createPty ?? defaultCreatePty;
  const createPump = options.createPump ?? createOutputPump;
  const resolve = options.resolveShellPath ?? resolveShell;
  const maxPanes = options.maxPanes ?? DEFAULT_MAX_PANES;
  const killProcess = options.killProcess ?? ((pid: number) => process.kill(pid));
  const { emitter } = options;

  const sessions = new Map<string, PtySession>();

  /** Once true, no teardown calls into node-pty's `kill()` again. See `beginShutdown`. */
  let shuttingDown = false;

  const teardown = (session: PtySession): void => {
    if (session.closing) {
      return;
    }
    session.closing = true;
    sessions.delete(keyOf(session.sessionId, session.paneId));
    // Flush before killing: the last line is usually the one being waited for.
    session.pump.dispose();
    try {
      if (shuttingDown) {
        // A pid of 0 would mean "this process group" to `process.kill`, and a spawn that
        // failed can leave it absent — either way there is nothing of ours to signal.
        if (session.process.pid > 0) {
          killProcess(session.process.pid);
        }
      } else {
        session.process.kill();
      }
    } catch (error) {
      // A shell that already exited throws here. Not an error worth surfacing —
      // the goal was for it to be gone, and it is.
      console.warn(`[terminal] kill(${session.paneId}) failed:`, describeError(error));
    }
  };

  return {
    create({ sessionId, paneId, cwd, shell }) {
      if (sessions.has(keyOf(sessionId, paneId))) {
        return err('invalid-request', 'That terminal pane already exists.');
      }
      if (sessions.size >= maxPanes) {
        return err('pane-limit-reached', `A workspace can hold at most ${maxPanes} terminals.`);
      }

      const resolved = resolve(shell);

      let process_: PtyProcess;
      try {
        process_ = createPty({
          file: resolved.path,
          args: resolved.args,
          cwd,
          cols: INITIAL_COLS,
          rows: INITIAL_ROWS,
        });
      } catch (error) {
        // A missing shell or a denied spawn is an application state, not a crash:
        // the user must still be able to browse files (invariant 13).
        return err('pty-failed', `Could not start ${resolved.path}.`, describeError(error));
      }

      const pump = createPump((data) => {
        emitter.data({ sessionId, paneId, data });
      });

      const session: PtySession = {
        sessionId,
        paneId,
        process: process_,
        pump,
        cwd,
        cols: INITIAL_COLS,
        rows: INITIAL_ROWS,
        closing: false,
      };
      sessions.set(keyOf(sessionId, paneId), session);

      process_.onData((data) => {
        // Guarded so output produced between `kill()` and the OS actually reaping
        // the process is not forwarded to a pane the renderer has already removed.
        if (session.closing) {
          return;
        }
        pump.push(data);
      });

      process_.onExit(({ exitCode, signal }) => {
        const wasClosing = session.closing;
        session.closing = true;
        sessions.delete(keyOf(sessionId, paneId));
        pump.dispose();

        // A pane the user closed already knows it is gone; only report a shell
        // that exited on its own.
        if (!wasClosing) {
          emitter.exit({
            sessionId,
            paneId,
            exitCode,
            ...(signal === undefined ? {} : { signal }),
          });
        }
      });

      return ok({
        paneId,
        shellPath: resolved.path,
        cwd,
        pid: process_.pid,
      });
    },

    write(sessionId, paneId, data) {
      const session = sessions.get(keyOf(sessionId, paneId));
      if (!session || session.closing) {
        return;
      }
      try {
        session.process.write(data);
      } catch (error) {
        console.warn(`[terminal] write(${paneId}) failed:`, describeError(error));
      }
    },

    resize(sessionId, paneId, cols, rows) {
      const session = sessions.get(keyOf(sessionId, paneId));
      if (!session || session.closing) {
        return;
      }
      // The dedupe that performance rule 10 asks for. A ResizeObserver fires
      // continuously during a drag, but the grid only changes at character
      // boundaries, and a redundant resize makes some shells repaint.
      if (session.cols === cols && session.rows === rows) {
        return;
      }
      session.cols = cols;
      session.rows = rows;
      try {
        session.process.resize(cols, rows);
      } catch (error) {
        console.warn(`[terminal] resize(${paneId}) failed:`, describeError(error));
      }
    },

    kill(sessionId, paneId) {
      const session = sessions.get(keyOf(sessionId, paneId));
      if (!session) {
        return false;
      }
      teardown(session);
      return true;
    },

    killSession(sessionId) {
      // Snapshotted because teardown mutates the map.
      const owned = [...sessions.values()].filter((session) => session.sessionId === sessionId);
      for (const session of owned) {
        teardown(session);
      }
      return owned.length;
    },

    beginShutdown() {
      shuttingDown = true;
    },

    disposeAll() {
      for (const session of [...sessions.values()]) {
        teardown(session);
      }
      sessions.clear();
    },

    count() {
      return sessions.size;
    },
  };
};
