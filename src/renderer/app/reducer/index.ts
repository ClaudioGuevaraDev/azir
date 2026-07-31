import type { WorkspaceSessionId } from '@shared/ipc/contracts';
import type { Action } from '../actions';
import { dedupeEffects } from '../effects';
import type { AppState } from '../state';
import { combineSlices, type Reduction } from './combine';
import { noticesReducer } from './notices';
import { repositoryReducer } from './repository';
import { terminalsReducer } from './terminals';
import { viewerReducer } from './viewer';
import { workspaceReducer } from './workspace';

/**
 * The root reducer: the only writer of renderer state (invariant 1).
 *
 * Slice order below fixes effect order. `workspace` comes first because its
 * effects gate the others — a close must be issued before anything a later slice
 * might queue against a workspace that is going away.
 */
const combined = combineSlices<AppState>({
  workspace: workspaceReducer,
  repository: repositoryReducer,
  viewer: viewerReducer,
  terminals: terminalsReducer,
  notices: noticesReducer,
});

/**
 * The session an action belongs to, if any.
 *
 * Only actions derived from main-process work carry one. Pure user intent
 * (`terminal/activated`) does not, because it cannot be stale — it was produced
 * from the state currently on screen.
 */
const sessionOf = (action: Action): WorkspaceSessionId | undefined => {
  switch (action.type) {
    case 'terminal/created':
    case 'terminal/createFailed':
    case 'terminal/exited':
    case 'terminal/activity':
    case 'terminal/createRequested':
    case 'terminal/closeRequested':
    case 'repository/directoryRequested':
    case 'repository/directoryLoaded':
    case 'repository/directoryFailed':
    case 'repository/toggled':
    case 'git/refreshRequested':
    case 'git/refreshed':
    case 'git/refreshFailed':
    case 'fs/changed':
    case 'viewer/openRequested':
    case 'viewer/contentLoaded':
    case 'viewer/contentFailed':
    case 'viewer/diffLoaded':
    case 'viewer/diffFailed':
    case 'viewer/activated':
    case 'viewer/modeChanged':
    case 'viewer/diffTargetChanged':
      return action.sessionId;
    default:
      return undefined;
  }
};

/**
 * The coarse staleness gate.
 *
 * docs/architecture.md's startup sequence requires that disposing a workspace also
 * means "pending requests ignored". Request ids handle that per-request, but they
 * cannot help when a whole workspace has been replaced: an exit event for a PTY
 * that belonged to the previous folder would otherwise be applied to whatever pane
 * list exists now. Dropping anything whose session is not the live one covers every
 * such action at once, including ones added later.
 */
const isStale = (state: AppState, action: Action): boolean => {
  const sessionId = sessionOf(action);
  if (sessionId === undefined) {
    return false;
  }
  return state.workspace.status !== 'open' || state.workspace.info.sessionId !== sessionId;
};

const NO_EFFECTS = Object.freeze([]) as readonly never[];

export const reduce = (state: AppState, action: Action): Reduction<AppState> => {
  if (isStale(state, action)) {
    // State returned by identity, so a stale action notifies nobody.
    return { state, effects: NO_EFFECTS };
  }

  const result = combined(state, action);

  // Deduplication belongs here rather than in the store, so a reducer test observes
  // exactly the effect list the runner will receive.
  if (result.effects.length < 2) {
    return result;
  }
  return { state: result.state, effects: dedupeEffects(result.effects) };
};
