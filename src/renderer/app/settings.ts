import {
  defaultSettings,
  type AppearanceSettings,
  type EditorSettings,
  type TerminalSettings,
} from '@shared/models/settings';

/**
 * The live settings the workspace uses.
 *
 * docs/architecture.md: "The live settings used by the workspace belong to renderer state.
 * Persisted settings are only the startup source." So this slice is authoritative from the moment
 * it loads, and the file is never read again.
 *
 * `layout` is deliberately not here. It already lives in the layout slice, which is the thing that
 * consumes it, and moving it would mean the layout reducer reading another slice's state —
 * something `combineSlices` does not allow, and for good reason. The cost is that a full `Settings`
 * document is assembled nowhere in the renderer; the benefit is that nothing has to be, because
 * what crosses IPC is a patch of whole groups and main owns the merge.
 */
export interface SettingsState {
  readonly terminal: TerminalSettings;
  readonly editor: EditorSettings;
  readonly appearance: AppearanceSettings;
  /**
   * False until main's values arrive.
   *
   * Distinguishes "the user's shell is the default" from "we have not been told yet", which
   * matters because the first terminal is created as soon as a workspace opens: starting it with
   * the wrong shell and then noticing is not recoverable — the shell is already running.
   */
  readonly loaded: boolean;
  /** Fields the settings file had but could not be used. Surfaced once, as a notice. */
  readonly invalidFields: readonly string[];
}

export const initialSettingsState: SettingsState = {
  terminal: defaultSettings.terminal,
  editor: defaultSettings.editor,
  appearance: defaultSettings.appearance,
  loaded: false,
  invalidFields: [],
};

/** The string Tab inserts. Azir never inserts a tab character — see the note in CodeView. */
export const indentFor = (editor: EditorSettings): string => ' '.repeat(editor.tabWidth);
