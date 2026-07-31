import type {
  DirectoryEntry,
  GitStatusResponse,
  TerminalPaneId,
  WorkspaceInfo,
  WorkspaceSessionId,
} from '@shared/ipc/contracts';
import type { AppError } from '@shared/ipc/result';
import type { RepositoryView } from './repository';
import { nextRequestId } from './runtime/requestIds';
import type { RequestId, Severity } from './state';

/**
 * Actions describe user intent or completed external work.
 *
 * They carry facts, never callbacks — an action holding a function cannot be
 * logged, replayed or compared, and it lets a component smuggle behaviour past the
 * reducer.
 *
 * Note what is *absent*: there is no `terminal/output`. docs/architecture.md lists
 * one, but dispatching an action per PTY chunk contradicts its own performance
 * rules 1–2 and its statement that xterm.js is the terminal's presentation buffer.
 * Terminal bytes travel a side channel instead; see
 * src/renderer/terminal/registry.ts. The action is not left in the union unused,
 * because an unused-but-documented action gets used. `terminal/activity` is its
 * replacement: one throttled bit, not a byte stream.
 *
 * Keystrokes and resizes are likewise absent, for the same reason — they are
 * continuous, carry no application state, and go straight from the controller to
 * the bridge.
 */
export type Action =
  // ---- workspace
  | { readonly type: 'workspace/openRequested' }
  | { readonly type: 'workspace/pickCancelled' }
  | { readonly type: 'workspace/pickFailed'; readonly error: AppError }
  | { readonly type: 'workspace/pathChosen'; readonly path: string; readonly requestId: RequestId }
  | {
      readonly type: 'workspace/opened';
      readonly requestId: RequestId;
      readonly info: WorkspaceInfo;
    }
  | {
      readonly type: 'workspace/openFailed';
      readonly requestId: RequestId;
      readonly error: AppError;
    }
  | { readonly type: 'workspace/closeRequested' }
  | { readonly type: 'workspace/closed'; readonly sessionId: WorkspaceSessionId }
  // ---- repository
  | {
      readonly type: 'repository/directoryRequested';
      readonly sessionId: WorkspaceSessionId;
      readonly path: string;
      readonly requestId: RequestId;
    }
  | {
      readonly type: 'repository/directoryLoaded';
      readonly sessionId: WorkspaceSessionId;
      readonly path: string;
      readonly requestId: RequestId;
      readonly entries: readonly DirectoryEntry[];
    }
  | {
      readonly type: 'repository/directoryFailed';
      readonly sessionId: WorkspaceSessionId;
      readonly path: string;
      readonly requestId: RequestId;
      readonly error: AppError;
    }
  | {
      readonly type: 'repository/toggled';
      readonly sessionId: WorkspaceSessionId;
      readonly path: string;
      readonly requestId: RequestId;
    }
  | { readonly type: 'repository/collapsed'; readonly path: string }
  | { readonly type: 'repository/selected'; readonly path: string }
  | { readonly type: 'repository/viewChanged'; readonly view: RepositoryView }
  | {
      readonly type: 'git/refreshRequested';
      readonly sessionId: WorkspaceSessionId;
      readonly requestId: RequestId;
    }
  | {
      readonly type: 'git/refreshed';
      readonly sessionId: WorkspaceSessionId;
      readonly requestId: RequestId;
      readonly snapshot: GitStatusResponse;
    }
  | {
      readonly type: 'git/refreshFailed';
      readonly sessionId: WorkspaceSessionId;
      readonly requestId: RequestId;
      readonly error: AppError;
    }
  // ---- terminals
  | { readonly type: 'terminal/createRequested'; readonly sessionId: WorkspaceSessionId }
  | {
      readonly type: 'terminal/created';
      readonly sessionId: WorkspaceSessionId;
      readonly paneId: TerminalPaneId;
      readonly shellPath: string;
      readonly cwd: string;
    }
  | {
      readonly type: 'terminal/createFailed';
      readonly sessionId: WorkspaceSessionId;
      readonly paneId: TerminalPaneId;
      readonly error: AppError;
    }
  | {
      readonly type: 'terminal/exited';
      readonly sessionId: WorkspaceSessionId;
      readonly paneId: TerminalPaneId;
      readonly exitCode: number | null;
    }
  | {
      readonly type: 'terminal/closeRequested';
      readonly sessionId: WorkspaceSessionId;
      readonly paneId: TerminalPaneId;
    }
  | { readonly type: 'terminal/activated'; readonly paneId: TerminalPaneId }
  /** One throttled bit meaning "this hidden pane produced output". */
  | {
      readonly type: 'terminal/activity';
      readonly sessionId: WorkspaceSessionId;
      readonly paneId: TerminalPaneId;
    }
  // ---- notices
  | {
      readonly type: 'notice/raised';
      readonly severity: Severity;
      readonly message: string;
      readonly detail?: string;
    }
  | { readonly type: 'notice/dismissed'; readonly id: string };

/**
 * Action creators exist only where an id has to be minted. Everything else is
 * constructed inline at the dispatch site, which keeps the wiring readable.
 *
 * `nextRequestId` may be called here and in runtime/*, never under reducer/.
 */
export const pathChosen = (path: string): Action => ({
  type: 'workspace/pathChosen',
  path,
  requestId: nextRequestId(),
});

export const directoryToggled = (sessionId: WorkspaceSessionId, path: string): Action => ({
  type: 'repository/toggled',
  sessionId,
  path,
  requestId: nextRequestId(),
});

export const directoryRequested = (sessionId: WorkspaceSessionId, path: string): Action => ({
  type: 'repository/directoryRequested',
  sessionId,
  path,
  requestId: nextRequestId(),
});

export const gitRefreshRequested = (sessionId: WorkspaceSessionId): Action => ({
  type: 'git/refreshRequested',
  sessionId,
  requestId: nextRequestId(),
});
