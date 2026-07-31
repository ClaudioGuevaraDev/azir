import type { Action } from '../actions';
import { dedupeEffects } from '../effects';
import type { AppState } from '../state';
import { combineSlices, type Reduction } from './combine';
import { noticesReducer } from './notices';
import { workspaceReducer } from './workspace';

/**
 * The root reducer: the only writer of renderer state (invariant 1).
 *
 * Slice order below fixes effect order. `workspace` comes first because its
 * effects are the ones that matter for correctness — a close must be issued
 * before anything that a later slice might queue against the workspace being
 * gone.
 */
const combined = combineSlices<AppState>({
  workspace: workspaceReducer,
  notices: noticesReducer,
});

export const reduce = (state: AppState, action: Action): Reduction<AppState> => {
  const result = combined(state, action);

  // Deduplication belongs here rather than in the store, so that a reducer test
  // observes exactly the effect list the runner will receive.
  if (result.effects.length < 2) {
    return result;
  }
  return { state: result.state, effects: dedupeEffects(result.effects) };
};
