import type { Notice, NoticesState } from '../state';
import { changed, idle, type Reduction, type SliceReducer } from './combine';

/**
 * User-visible messages about things that went wrong outside the renderer.
 *
 * docs/architecture.md requires that a failing subsystem leaves the app usable:
 * a missing git binary must not disable the file browser. Notices are how such a
 * failure becomes visible without taking a panel down with it.
 *
 * Bounded on purpose. A watcher storm or a failing agent loop can produce
 * failures faster than anyone can dismiss them, and an unbounded array would grow
 * without limit while pushing the useful message off screen.
 */
const MAX_NOTICES = 24;

export const noticesReducer: SliceReducer<NoticesState> = (
  state,
  action,
): Reduction<NoticesState> => {
  switch (action.type) {
    case 'notice/raised': {
      const notice: Notice =
        action.detail === undefined
          ? { id: `n${state.nextId}`, severity: action.severity, message: action.message }
          : {
              id: `n${state.nextId}`,
              severity: action.severity,
              message: action.message,
              detail: action.detail,
            };

      // Newest first, oldest dropped: the most recent failure is the one the user
      // is reacting to.
      const items = [notice, ...state.items].slice(0, MAX_NOTICES);

      return changed({ items, nextId: state.nextId + 1 });
    }

    case 'notice/dismissed': {
      const items = state.items.filter((notice) => notice.id !== action.id);
      if (items.length === state.items.length) {
        return idle(state);
      }
      return changed({ ...state, items });
    }

    case 'workspace/closed': {
      // Notices are scoped to the workspace they describe; carrying "cannot read
      // src/index.ts" into a different folder would be nonsense.
      if (state.items.length === 0) {
        return idle(state);
      }
      return changed({ ...state, items: [] });
    }

    default:
      return idle(state);
  }
};
