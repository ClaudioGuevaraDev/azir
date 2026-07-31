import type {
  GitFileStatus,
  TerminalPaneId,
  WorkspaceInfo,
  WorkspaceSessionId,
} from '@shared/ipc/contracts';
import type { AppError } from '@shared/ipc/result';
import { activeTab, initialViewerState, type ViewerState, type ViewerTab } from './viewer';
import {
  initialRepositoryState,
  selectRepositoryRows,
  type GitState,
  type RepositoryRow,
  type RepositoryState,
  type RepositoryView,
} from './repository';

/**
 * Renderer state.
 *
 * docs/architecture.md sketches the full `AppState` with nine slices. Slices are
 * added as their milestone lands rather than up front, per invariant 15 ("no
 * abstraction is added without an actual caller") — an empty slice reducer is an
 * abstraction with no caller, and it invites code that pretends the feature exists.
 *
 * Everything here is serialisable. Long-lived system handles (PTYs, watchers, file
 * descriptors) belong to the main process; the renderer keeps identities and
 * snapshots only. Note in particular that no terminal *output* appears anywhere
 * below — the xterm.js instance is the presentation buffer.
 */

/**
 * Correlates a response with the request that asked for it, so a response that has
 * been superseded can be recognised and dropped.
 *
 * Minted at the dispatch edge — see runtime/requestIds.ts. The reducer only ever
 * *compares* these, because minting one would make the reducer impure and break
 * snapshot tests (invariant 2).
 */
export type RequestId = string;

export type Severity = 'info' | 'warning' | 'error';

export interface Notice {
  readonly id: string;
  readonly severity: Severity;
  readonly message: string;
  readonly detail?: string;
}

/**
 * The workspace lifecycle. `picking` and `opening` are distinct because they fail
 * differently and because only `opening` can be superseded — the native folder
 * picker is modal, so there is never more than one in flight.
 */
export type WorkspaceState =
  | { readonly status: 'empty' }
  | { readonly status: 'picking' }
  | { readonly status: 'opening'; readonly requestId: RequestId; readonly path: string }
  | { readonly status: 'open'; readonly info: WorkspaceInfo }
  | { readonly status: 'failed'; readonly error: AppError };

export interface NoticesState {
  readonly items: readonly Notice[];
  /**
   * Minted inside the reducer rather than at the edge. Unlike a request id this is
   * legitimate: it is a pure function of prior state, so the reducer stays
   * deterministic and snapshot-testable.
   */
  readonly nextId: number;
}

export type TerminalLifecycle = 'starting' | 'running' | 'exited' | 'failed';

export interface TerminalPaneState {
  readonly id: TerminalPaneId;
  readonly title: string;
  readonly lifecycle: TerminalLifecycle;
  readonly cwd: string;
  readonly exitCode: number | null;
  /**
   * Set when a hidden pane produces output, cleared when it is activated. This is
   * the *only* thing the reducer learns about terminal output, and the controller
   * raises it at most once every 500 ms — see terminal/registry.ts.
   */
  readonly hasUnreadOutput: boolean;
  readonly error?: AppError;
}

export interface TerminalsState {
  readonly panes: readonly TerminalPaneState[];
  readonly activePaneId: TerminalPaneId | null;
  /**
   * Monotonic across the whole application run, deliberately not reset when a
   * workspace closes. Minting a pane id inside the reducer is pure — unlike a
   * request id — and never reusing one is what stops late PTY output from being
   * delivered to a new pane in the same visual slot.
   */
  readonly nextPaneSeq: number;
}

export interface AppState {
  readonly workspace: WorkspaceState;
  readonly repository: RepositoryState;
  readonly viewer: ViewerState;
  readonly terminals: TerminalsState;
  readonly notices: NoticesState;
}

export const initialState: AppState = {
  workspace: { status: 'empty' },
  repository: initialRepositoryState,
  viewer: initialViewerState,
  terminals: { panes: [], activePaneId: null, nextPaneSeq: 1 },
  notices: { items: [], nextId: 1 },
};

// ---------------------------------------------------------------- selectors

/**
 * Selectors are module-level constants because `useAppState` uses the selector's
 * identity as a memoisation key — an inline arrow would allocate a new one on every
 * render. They must also return a stable reference: a selector that builds a new
 * object would report a change on every read.
 */
export const selectWorkspace = (state: AppState): WorkspaceState => state.workspace;

export const selectNotices = (state: AppState): readonly Notice[] => state.notices.items;

export const selectSessionId = (state: AppState): WorkspaceSessionId | null =>
  state.workspace.status === 'open' ? state.workspace.info.sessionId : null;

export const selectIsBusy = (state: AppState): boolean =>
  state.workspace.status === 'picking' || state.workspace.status === 'opening';

export const selectPanes = (state: AppState): readonly TerminalPaneState[] => state.terminals.panes;

export const selectActivePaneId = (state: AppState): TerminalPaneId | null =>
  state.terminals.activePaneId;

export const selectRows = (state: AppState): readonly RepositoryRow[] =>
  selectRepositoryRows(state.repository);

export const selectSelectedPath = (state: AppState): string | null => state.repository.selectedPath;

export const selectRepositoryView = (state: AppState): RepositoryView => state.repository.view;

export const selectGit = (state: AppState): GitState => state.repository.git;

export const selectViewerTabs = (state: AppState): readonly ViewerTab[] => state.viewer.tabs;

export const selectActiveTab = (state: AppState): ViewerTab | undefined => activeTab(state.viewer);

/**
 * Git's view of the active tab's path, so the viewer can tell an untracked file from a
 * modified one without asking git again.
 */
export const selectActiveTabGitStatus = (state: AppState): GitFileStatus | undefined => {
  const tab = activeTab(state.viewer);
  if (!tab || state.repository.git.status !== 'ready') {
    return undefined;
  }
  return state.repository.git.byPath[tab.path];
};
