import type { WorkspaceState } from '../state';
import { idle, withEffects, type Reduction, type SliceReducer } from './combine';

/**
 * The workspace lifecycle.
 *
 * The interesting part is the staleness gate on `workspace/opened` and
 * `workspace/openFailed`: a response is accepted only while the slice is still
 * `opening` *and* the response's request id matches the one in flight. Without
 * that, opening folder A and then folder B quickly enough leaves the app showing
 * A — the exact failure docs/architecture.md calls out for viewer content and
 * search results, arriving here first because this is the first async read.
 */
export const workspaceReducer: SliceReducer<WorkspaceState> = (
  state,
  action,
): Reduction<WorkspaceState> => {
  switch (action.type) {
    case 'workspace/openRequested': {
      // The native picker is modal, so a second request while one is open would
      // be a bug in the UI rather than a race to resolve.
      if (state.status === 'picking' || state.status === 'opening') {
        return idle(state);
      }
      return withEffects({ status: 'picking' }, { type: 'workspace/pickFolder' });
    }

    case 'workspace/pickCancelled': {
      if (state.status !== 'picking') {
        return idle(state);
      }
      // Cancelling returns to nothing-open, not to an error: the user declining a
      // dialog is not a failure.
      return withEffects({ status: 'empty' });
    }

    case 'workspace/pickFailed': {
      if (state.status !== 'picking') {
        return idle(state);
      }
      return withEffects({ status: 'failed', error: action.error });
    }

    case 'workspace/pathChosen': {
      if (state.status !== 'picking') {
        return idle(state);
      }
      return withEffects(
        { status: 'opening', requestId: action.requestId, path: action.path },
        { type: 'workspace/open', path: action.path, requestId: action.requestId },
      );
    }

    case 'workspace/opened': {
      if (state.status !== 'opening' || state.requestId !== action.requestId) {
        return idle(state);
      }
      return withEffects({ status: 'open', info: action.info });
    }

    case 'workspace/openFailed': {
      if (state.status !== 'opening' || state.requestId !== action.requestId) {
        return idle(state);
      }
      return withEffects({ status: 'failed', error: action.error });
    }

    case 'workspace/closeRequested': {
      if (state.status !== 'open') {
        return idle(state);
      }
      return withEffects(
        { status: 'empty' },
        { type: 'workspace/close', sessionId: state.info.sessionId },
      );
    }

    case 'workspace/closed': {
      // Main confirming a close it already performed, or telling us a workspace
      // went away for a reason we did not initiate.
      if (state.status === 'open' && state.info.sessionId !== action.sessionId) {
        return idle(state);
      }
      if (state.status === 'empty') {
        return idle(state);
      }
      return withEffects({ status: 'empty' });
    }

    default:
      return idle(state);
  }
};
