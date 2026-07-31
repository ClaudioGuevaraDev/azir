import type { WorkspaceInfo, WorkspaceSessionId } from '@shared/ipc/contracts';
import type { AppError } from '@shared/ipc/result';

/**
 * Renderer state.
 *
 * docs/architecture.md sketches the full `AppState` with nine slices. Slices are
 * added as their milestone lands rather than up front, per invariant 15 ("no
 * abstraction is added without an actual caller") — an empty slice reducer is an
 * abstraction with no caller, and it invites code that pretends the feature
 * exists.
 *
 * Everything here is serialisable. Long-lived system handles (PTYs, watchers,
 * file descriptors) belong to the main process; the renderer keeps identities and
 * snapshots only.
 */

/**
 * Correlates a response with the request that asked for it, so a response that
 * has been superseded can be recognised and dropped.
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
   * Minted inside the reducer rather than at the edge. Unlike a request id this
   * is legitimate: it is a pure function of prior state, so the reducer stays
   * deterministic and snapshot-testable.
   */
  readonly nextId: number;
}

export interface AppState {
  readonly workspace: WorkspaceState;
  readonly notices: NoticesState;
}

export const initialState: AppState = {
  workspace: { status: 'empty' },
  notices: { items: [], nextId: 1 },
};

// ---------------------------------------------------------------- selectors

/**
 * Selectors are module-level constants because `useAppState` uses the selector's
 * identity as a memoisation key — an inline arrow would allocate a new one on
 * every render.
 */
export const selectWorkspace = (state: AppState): WorkspaceState => state.workspace;

export const selectNotices = (state: AppState): readonly Notice[] => state.notices.items;

export const selectSessionId = (state: AppState): WorkspaceSessionId | null =>
  state.workspace.status === 'open' ? state.workspace.info.sessionId : null;

export const selectIsBusy = (state: AppState): boolean =>
  state.workspace.status === 'picking' || state.workspace.status === 'opening';
