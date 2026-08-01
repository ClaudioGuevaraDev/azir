import { initialSearchState, type SearchState } from '../search';
import { changed, idle, withEffects, type Reduction, type SliceReducer } from './combine';

/**
 * Search state.
 *
 * The only subtle thing here is what *does not* happen: typing does not emit an effect in path
 * mode. docs/architecture.md requires path search to answer "on every keystroke without IPC", and
 * the way that is enforced is structural — the reducer has no effect to emit, because the index
 * is already in state and the matcher runs at render time. If a `search/queryChanged` in path mode
 * ever grows an effect, the requirement has been broken.
 *
 * In content mode the opposite applies, and the request id is what makes "latest query wins"
 * true: a result whose id is not the one currently in flight is dropped rather than rendered.
 */
export const searchReducer: SliceReducer<SearchState> = (state, action): Reduction<SearchState> => {
  switch (action.type) {
    case 'workspace/opened':
      // The index belongs to the workspace, and main starts walking as part of opening it.
      return changed({ ...initialSearchState, index: { status: 'building' } });

    case 'workspace/closed':
      return state === initialSearchState ? idle(state) : changed(initialSearchState);

    case 'search/indexReady':
      return changed({
        ...state,
        index: { status: 'ready', paths: action.paths, truncated: action.truncated },
      });

    case 'search/indexChanged': {
      if (state.index.status !== 'ready') {
        // Nothing to apply a delta to. Main holds these back until the walk has finished, so
        // this is the workspace having closed underneath rather than an ordering bug.
        return idle(state);
      }
      const removed = new Set(action.removed);
      const kept = state.index.paths.filter((path) => !removed.has(path));
      const existing = new Set(kept);
      const added = action.added.filter((path) => !existing.has(path));
      if (added.length === 0 && kept.length === state.index.paths.length) {
        return idle(state);
      }
      return changed({
        ...state,
        index: { ...state.index, paths: [...kept, ...added] },
      });
    }

    case 'search/modeChanged': {
      if (state.mode === action.mode) {
        return idle(state);
      }
      const next: SearchState = {
        ...state,
        mode: action.mode,
        // Results from the other mode are not results for this one; keeping them on screen while
        // the label above says something else is the wrong kind of "fast".
        content: { status: 'idle' },
        contentRequestId: null,
      };
      if (action.mode !== 'content' || state.query.trim() === '') {
        return changed(next);
      }
      // Switching to content with a query already typed runs it, rather than making the user
      // retype what is in the box in front of them.
      return withEffects(
        { ...next, content: { status: 'searching' }, contentRequestId: action.requestId },
        {
          type: 'search/content',
          sessionId: action.sessionId,
          query: state.query,
          requestId: action.requestId,
        },
      );
    }

    case 'search/queryChanged': {
      if (state.query === action.query) {
        return idle(state);
      }
      if (state.mode === 'path') {
        // No effect. The whole point: the index is in state and the matcher is pure.
        return changed({ ...state, query: action.query });
      }
      if (action.query.trim() === '') {
        return changed({
          ...state,
          query: action.query,
          content: { status: 'idle' },
          contentRequestId: null,
        });
      }
      return withEffects(
        {
          ...state,
          query: action.query,
          content: { status: 'searching' },
          // Claiming the slot is what retires the previous request: its result will arrive with
          // an id that no longer matches and be dropped.
          contentRequestId: action.requestId,
        },
        {
          type: 'search/content',
          sessionId: action.sessionId,
          query: action.query,
          requestId: action.requestId,
        },
      );
    }

    case 'search/contentLoaded': {
      if (state.contentRequestId !== action.requestId) {
        // "The reducer drops results for a query that is no longer current." Identity returned,
        // so a superseded answer does not even cause a re-render.
        return idle(state);
      }
      return changed({
        ...state,
        content: {
          status: 'ready',
          matches: action.response.matches,
          truncated: action.response.truncated,
          filesScanned: action.response.filesScanned,
        },
        contentRequestId: null,
      });
    }

    case 'search/contentFailed': {
      if (state.contentRequestId !== action.requestId) {
        return idle(state);
      }
      return changed({
        ...state,
        content: { status: 'error', error: action.error },
        contentRequestId: null,
      });
    }

    case 'overlay/closed':
      // The query is kept. Reopening search to refine what you just typed is the common case,
      // and the index — the expensive part — is not touched either way.
      return idle(state);

    default:
      return idle(state);
  }
};
