import type { SettingsState } from '../settings';
import { changed, idle, withEffects, type Reduction, type SliceReducer } from './combine';

/**
 * The live settings, and the effects that persist them.
 *
 * Every change follows the path docs/architecture.md draws: UI → action → reducer updates live
 * state → SaveSettings effect → main writes. The reducer never waits for the write and never
 * learns whether it succeeded; the value on screen is authoritative from the moment it changes.
 *
 * Note what is *not* here: a `settings/saved` action. There is nothing for the renderer to do
 * with one — the live value is already correct — and an action that only exists to be ignored is
 * a place for someone to later hang a spinner that can never be right.
 */
export const settingsReducer: SliceReducer<SettingsState> = (
  state,
  action,
): Reduction<SettingsState> => {
  switch (action.type) {
    case 'settings/loadRequested':
      // No `loading` status. Nothing renders differently while the request is in flight — the
      // defaults are already usable — and a flag no one reads is a flag that goes stale.
      return withEffects(state, { type: 'settings/load' });

    case 'settings/loaded': {
      const { settings, invalidFields } = action.snapshot;
      return changed({
        terminal: settings.terminal,
        editor: settings.editor,
        appearance: settings.appearance,
        loaded: true,
        invalidFields,
      });
    }

    case 'settings/shellChanged': {
      if (state.terminal.shell === action.shell) {
        return idle(state);
      }
      const terminal = { shell: action.shell };
      return withEffects(
        { ...state, terminal },
        // The shell of a *future* pane. Panes already running keep the shell they started with,
        // because there is no way to change a live process's executable — see the note in the
        // settings overlay, which says so to the user rather than leaving them to discover it.
        { type: 'settings/save', patch: { terminal } },
      );
    }

    case 'settings/tabWidthChanged': {
      if (state.editor.tabWidth === action.tabWidth) {
        return idle(state);
      }
      const editor = { tabWidth: action.tabWidth };
      return withEffects({ ...state, editor }, { type: 'settings/save', patch: { editor } });
    }

    case 'settings/codeFontSizeChanged': {
      if (state.appearance.codeFontSize === action.codeFontSize) {
        return idle(state);
      }
      const appearance = { codeFontSize: action.codeFontSize };
      return withEffects(
        { ...state, appearance },
        { type: 'settings/save', patch: { appearance } },
      );
    }

    case 'workspace/closed':
      // Settings outlive a workspace. They are preferences about Azir, not about the folder.
      return idle(state);

    default:
      return idle(state);
  }
};
