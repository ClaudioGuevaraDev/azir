import type {
  DiffTarget,
  DirectoryEntry,
  FileDiff,
  FsChangeBatch,
  GitStatusResponse,
  ReadFileResponse,
  SettingsSnapshot,
  ShellKind,
  TerminalPaneId,
  WorkspaceInfo,
  WorkspaceSessionId,
} from '@shared/ipc/contracts';
import type { AppError } from '@shared/ipc/result';
import type { Arrangement, Panel } from '@shared/models/layout';
import type { Overlay } from './chrome';
import type { EditOperation } from './document';
import type { RepositoryView } from './repository';
import { nextRequestId } from './runtime/requestIds';
import type { RequestId, Severity } from './state';
import type { ViewerMode } from './viewer';

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
  /**
   * A coalesced batch of workspace changes.
   *
   * Carries pre-minted request ids because the response to it is a set of reloads, and
   * the reducer cannot mint ids — see runtime/eventPump.ts.
   */
  | {
      readonly type: 'fs/changed';
      readonly sessionId: WorkspaceSessionId;
      readonly batch: FsChangeBatch;
      readonly gitRequestId: RequestId;
      /** One id per directory the reducer might reload, keyed by path. */
      readonly directoryRequestIds: Readonly<Record<string, RequestId>>;
      /** For reloading the active viewer tab, of which there is at most one. */
      readonly viewerContentRequestId: RequestId;
      readonly viewerDiffRequestId: RequestId;
    }
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
  // ---- viewer
  | {
      readonly type: 'viewer/openRequested';
      readonly sessionId: WorkspaceSessionId;
      readonly path: string;
      readonly requestId: RequestId;
    }
  | {
      readonly type: 'viewer/contentLoaded';
      readonly sessionId: WorkspaceSessionId;
      readonly path: string;
      readonly requestId: RequestId;
      readonly response: ReadFileResponse;
    }
  | {
      readonly type: 'viewer/contentFailed';
      readonly sessionId: WorkspaceSessionId;
      readonly path: string;
      readonly requestId: RequestId;
      readonly error: AppError;
    }
  | {
      readonly type: 'viewer/diffLoaded';
      readonly sessionId: WorkspaceSessionId;
      readonly path: string;
      readonly requestId: RequestId;
      readonly diff: FileDiff;
    }
  | {
      readonly type: 'viewer/diffFailed';
      readonly sessionId: WorkspaceSessionId;
      readonly path: string;
      readonly requestId: RequestId;
      readonly error: AppError;
    }
  | {
      readonly type: 'viewer/activated';
      readonly sessionId: WorkspaceSessionId;
      readonly path: string;
      readonly contentRequestId: RequestId;
      readonly diffRequestId: RequestId;
    }
  | { readonly type: 'viewer/closed'; readonly path: string }
  | {
      readonly type: 'viewer/modeChanged';
      readonly sessionId: WorkspaceSessionId;
      readonly path: string;
      readonly mode: ViewerMode;
      readonly requestId: RequestId;
    }
  | {
      readonly type: 'viewer/diffTargetChanged';
      readonly sessionId: WorkspaceSessionId;
      readonly path: string;
      readonly target: DiffTarget;
      readonly requestId: RequestId;
    }
  | {
      readonly type: 'viewer/edited';
      readonly path: string;
      readonly operation: EditOperation;
    }
  | {
      readonly type: 'viewer/saveRequested';
      readonly sessionId: WorkspaceSessionId;
      readonly path: string;
      readonly requestId: RequestId;
    }
  | {
      readonly type: 'viewer/saved';
      readonly sessionId: WorkspaceSessionId;
      readonly path: string;
      readonly requestId: RequestId;
    }
  | {
      readonly type: 'viewer/saveFailed';
      readonly sessionId: WorkspaceSessionId;
      readonly path: string;
      readonly requestId: RequestId;
      readonly error: AppError;
    }
  /**
   * Asks to close a tab.
   *
   * Carries `dirty` because two slices react to it independently and neither may read the
   * other: the viewer closes a clean tab, and the overlay raises a confirmation for a dirty
   * one. The component already renders the flag, so putting it on the action costs nothing and
   * keeps both readers looking at the same fact.
   */
  | {
      readonly type: 'viewer/closeRequested';
      readonly path: string;
      readonly dirty: boolean;
    }
  /** Reloads a tab whose file moved while it held unsaved edits, discarding them. */
  | {
      readonly type: 'viewer/reloadRequested';
      readonly sessionId: WorkspaceSessionId;
      readonly path: string;
      readonly requestId: RequestId;
    }
  | {
      readonly type: 'viewer/scrolled';
      readonly path: string;
      readonly mode: ViewerMode;
      readonly top: number;
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
  // ---- chrome: geometry, focus, overlays
  | { readonly type: 'layout/resized'; readonly width: number; readonly height: number }
  | { readonly type: 'layout/arrangementChanged'; readonly arrangement: Arrangement }
  | {
      readonly type: 'layout/orderChanged';
      readonly order: readonly [Panel, Panel, Panel];
    }
  | { readonly type: 'focus/changed'; readonly panel: Panel }
  | { readonly type: 'overlay/opened'; readonly overlay: Overlay }
  | { readonly type: 'overlay/closed' }
  /**
   * Main is asking whether it may quit with unsaved work.
   *
   * The paths are attached by the event pump, which reads them from the store — the overlay
   * slice cannot see the viewer slice, and the reducer cannot go looking.
   */
  | { readonly type: 'app/quitRequested'; readonly unsavedPaths: readonly string[] }
  | { readonly type: 'app/quitConfirmed' }
  // ---- settings
  /**
   * Main's validated values, delivered once at startup.
   *
   * Consumed by two slices at once — `settings` and `layout` — which is the reason it is one
   * action carrying the whole snapshot rather than one per group. A single action means the two
   * can never end up applying different halves of the same file.
   */
  | { readonly type: 'settings/loadRequested' }
  | { readonly type: 'settings/loaded'; readonly snapshot: SettingsSnapshot }
  | { readonly type: 'settings/shellChanged'; readonly shell: ShellKind }
  | { readonly type: 'settings/tabWidthChanged'; readonly tabWidth: number }
  | { readonly type: 'settings/codeFontSizeChanged'; readonly codeFontSize: number }
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

export const fileOpenRequested = (sessionId: WorkspaceSessionId, path: string): Action => ({
  type: 'viewer/openRequested',
  sessionId,
  path,
  requestId: nextRequestId(),
});

/**
 * Activating a tab may need to reload both its content and its diff, and the reducer
 * cannot mint ids — so both are minted here whether or not they end up used.
 */
export const tabActivated = (sessionId: WorkspaceSessionId, path: string): Action => ({
  type: 'viewer/activated',
  sessionId,
  path,
  contentRequestId: nextRequestId(),
  diffRequestId: nextRequestId(),
});

export const viewerModeChanged = (
  sessionId: WorkspaceSessionId,
  path: string,
  mode: ViewerMode,
): Action => ({
  type: 'viewer/modeChanged',
  sessionId,
  path,
  mode,
  requestId: nextRequestId(),
});

export const saveRequested = (sessionId: WorkspaceSessionId, path: string): Action => ({
  type: 'viewer/saveRequested',
  sessionId,
  path,
  requestId: nextRequestId(),
});

export const reloadRequested = (sessionId: WorkspaceSessionId, path: string): Action => ({
  type: 'viewer/reloadRequested',
  sessionId,
  path,
  requestId: nextRequestId(),
});

export const diffTargetChanged = (
  sessionId: WorkspaceSessionId,
  path: string,
  target: DiffTarget,
): Action => ({
  type: 'viewer/diffTargetChanged',
  sessionId,
  path,
  target,
  requestId: nextRequestId(),
});
