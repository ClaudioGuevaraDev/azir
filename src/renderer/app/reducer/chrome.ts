import {
  initialFocusState,
  initialLayoutState,
  initialOverlayState,
  type FocusState,
  type LayoutState,
  type OverlayState,
} from '../chrome';
import { changed, idle, withEffects, type Reduction, type SliceReducer } from './combine';

/**
 * Geometry.
 *
 * The reducer stores the size and nothing derived from it: the rectangles come from
 * `computeLayout`, which is pure and memoised at the component. Putting rects in state
 * would mean a resize wrote three objects instead of two numbers, on every frame of a
 * window drag.
 */
export const layoutReducer: SliceReducer<LayoutState> = (state, action): Reduction<LayoutState> => {
  switch (action.type) {
    case 'layout/resized': {
      if (state.width === action.width && state.height === action.height) {
        return idle(state);
      }
      return changed({ ...state, width: action.width, height: action.height });
    }

    case 'layout/arrangementChanged': {
      if (state.settings.arrangement === action.arrangement) {
        return idle(state);
      }
      return changed({
        ...state,
        settings: { ...state.settings, arrangement: action.arrangement },
      });
    }

    case 'layout/orderChanged': {
      if (
        state.settings.order[0] === action.order[0] &&
        state.settings.order[1] === action.order[1] &&
        state.settings.order[2] === action.order[2]
      ) {
        return idle(state);
      }
      return changed({ ...state, settings: { ...state.settings, order: action.order } });
    }

    case 'workspace/closed': {
      // Geometry survives closing a workspace: the window did not change size, and the
      // arrangement is a preference rather than workspace state. Only the size is reset,
      // and only because the panel area unmounts.
      if (state === initialLayoutState) {
        return idle(state);
      }
      return changed({ ...state, width: 0, height: 0 });
    }

    default:
      return idle(state);
  }
};

export const focusReducer: SliceReducer<FocusState> = (state, action): Reduction<FocusState> => {
  switch (action.type) {
    case 'focus/changed': {
      if (state.panel === action.panel) {
        return idle(state);
      }
      return changed({ panel: action.panel });
    }

    case 'workspace/closed':
      return state === initialFocusState ? idle(state) : changed(initialFocusState);

    default:
      return idle(state);
  }
};

export const overlayReducer: SliceReducer<OverlayState> = (
  state,
  action,
): Reduction<OverlayState> => {
  switch (action.type) {
    case 'app/quitConfirmed':
      // The effect is emitted here rather than by the viewer, because this slice owns the
      // confirmation the user just answered.
      return withEffects(initialOverlayState, { type: 'app/confirmQuit' });

    case 'overlay/opened': {
      // Opening an overlay while one is already up replaces it rather than stacking. A
      // stack would mean two overlays with a claim on the keyboard.
      if (state.current?.type === action.overlay.type) {
        return idle(state);
      }
      return changed({ current: action.overlay });
    }

    case 'viewer/closeRequested':
      // Only a dirty tab needs asking about. The viewer slice reads the same flag and closes a
      // clean one outright.
      if (!action.dirty) {
        return idle(state);
      }
      return changed({
        current: { type: 'confirm', intent: { kind: 'discardChanges', path: action.path } },
      });

    case 'viewer/reloadRequested':
      // The confirmation has been answered.
      return state.current === null ? idle(state) : changed(initialOverlayState);

    case 'app/quitRequested': {
      if (action.unsavedPaths.length === 0) {
        return idle(state);
      }
      return changed({
        current: {
          type: 'confirm',
          intent: { kind: 'quitWithUnsaved', paths: action.unsavedPaths },
        },
      });
    }

    case 'viewer/closed':
    case 'overlay/closed':
      return state.current === null ? idle(state) : changed(initialOverlayState);

    case 'workspace/closed':
      // "Restore the previous workspace when closed" cuts both ways: an overlay about a
      // workspace that no longer exists has nothing to say.
      return state.current === null ? idle(state) : changed(initialOverlayState);

    default:
      return idle(state);
  }
};
