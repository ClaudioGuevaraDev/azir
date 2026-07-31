import {
  defaultLayoutSettings,
  isArrangement,
  isPanel,
  type LayoutSettings,
  type Panel,
} from './layout';

/**
 * User settings, as data shared by both processes.
 *
 * docs/architecture.md: "Settings are loaded by the main process at startup. The renderer
 * receives validated values." So the shape and the validation have to be visible to main
 * (which reads the file) and to the renderer (which holds the live values) — hence `shared`.
 *
 * The spec sketches six groups: appearance, layout, repository, terminal, editor and updates.
 * Three are here. The other three are absent on purpose, per invariant 15 ("no abstraction is
 * added without an actual caller"):
 *
 *  - `updates` — there is no update mechanism to configure. A settings group whose only effect
 *    is to be written to a file is a promise the application does not keep.
 *  - `repository` — the obvious member is "show ignored files", and it cannot be one field.
 *    The scanner and the watcher share a single ignore list precisely so they cannot disagree
 *    about what exists (see shared/constants/ignore.ts), so honouring the setting means
 *    changing both, and pointing a recursive watcher at `node_modules` is a known way to take
 *    the process down. It needs its own design, not a checkbox.
 *  - Everything in `appearance` except the code font size, which is the one that earns its
 *    place in a tool built for reading diffs in a dense window.
 */

/**
 * The shells the user can choose.
 *
 * The single source of truth: `ipc/contracts.ts` builds its zod enum from this array rather than
 * repeating the strings, for the same reason the scanner and the watcher share one ignore list —
 * two lists of the same thing eventually disagree, and here the disagreement would be a shell the
 * settings UI offers and the IPC layer rejects as an invalid payload.
 */
export const SHELL_KINDS = ['default', 'powershell', 'pwsh', 'cmd', 'bash', 'zsh'] as const;

export type ShellKind = (typeof SHELL_KINDS)[number];

export const isShellKind = (value: unknown): value is ShellKind =>
  typeof value === 'string' && (SHELL_KINDS as readonly string[]).includes(value);

export interface TerminalSettings {
  /** `default` means "whatever this platform's convention is"; see main/terminal/shellResolver.ts. */
  readonly shell: ShellKind;
}

export interface EditorSettings {
  /** Spaces inserted by Tab. Azir never inserts a tab character — see the note in CodeView. */
  readonly tabWidth: number;
}

export interface AppearanceSettings {
  /** In CSS pixels. Drives the code font *and* the virtualised row height, which must agree. */
  readonly codeFontSize: number;
}

export interface Settings {
  readonly layout: LayoutSettings;
  readonly terminal: TerminalSettings;
  readonly editor: EditorSettings;
  readonly appearance: AppearanceSettings;
}

export const TAB_WIDTH_RANGE = { min: 1, max: 8 } as const;
export const CODE_FONT_SIZE_RANGE = { min: 10, max: 22 } as const;

export const defaultSettings: Settings = {
  layout: defaultLayoutSettings,
  terminal: { shell: 'default' },
  editor: { tabWidth: 2 },
  appearance: { codeFontSize: 12 },
};

/**
 * The row height that goes with a code font size.
 *
 * Lives here rather than in CSS because the virtualised list needs the number in JavaScript to
 * decide which rows exist at all. A stylesheet and a constant that are supposed to match but are
 * maintained separately will stop matching, and the symptom — rows drifting out of alignment with
 * the gutter as you scroll — looks like a rendering bug rather than a units bug.
 */
export const lineHeightFor = (codeFontSize: number): number => Math.round(codeFontSize * 1.5);

// ------------------------------------------------------------------ parsing

/**
 * The outcome of reading a settings file.
 *
 * `invalidFields` is not decoration. The spec requires that "malformed configuration falls back
 * per field rather than discarding the entire file", and a fallback the user is never told about
 * is indistinguishable from the application ignoring them: they edit a value by hand, it does
 * nothing, and there is no way to find out why.
 */
export interface ParsedSettings {
  readonly settings: Settings;
  /** Dotted paths of every field that was present but unusable, e.g. `editor.tabWidth`. */
  readonly invalidFields: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads settings from parsed JSON, falling back one field at a time.
 *
 * Written out rather than expressed as a zod schema with `.catch()` on every leaf. Two reasons,
 * and they are the whole point of the function: zod's `.catch()` cannot tell "absent" from
 * "present but wrong" — a fresh file with no `editor` key would be reported as an invalid field
 * on every launch — and it gives no way to collect *which* fields fell back without inspecting
 * its error tree and mapping it back to paths. That is more machinery than reading the four
 * groups directly.
 */
export const parseSettings = (raw: unknown): ParsedSettings => {
  const invalid: string[] = [];

  /**
   * `undefined` means the key was absent, which is normal and never an error — an older Azir
   * wrote the file, or the user only set the two things they cared about.
   */
  const field = <T>(
    group: Record<string, unknown> | undefined,
    key: string,
    guard: (value: unknown) => value is T,
    fallback: T,
    path: string,
  ): T => {
    const value = group?.[key];
    if (value === undefined) {
      return fallback;
    }
    if (!guard(value)) {
      invalid.push(path);
      return fallback;
    }
    return value;
  };

  const groupOf = (root: Record<string, unknown> | undefined, key: string): typeof root => {
    const value = root?.[key];
    if (value === undefined) {
      return undefined;
    }
    if (!isRecord(value)) {
      invalid.push(key);
      return undefined;
    }
    return value;
  };

  if (raw !== undefined && !isRecord(raw)) {
    // A file containing `[]` or `"nonsense"` has no fields to fall back *per*, so the whole
    // document is the invalid field. Reported as such rather than silently ignored.
    return { settings: defaultSettings, invalidFields: ['<root>'] };
  }

  const root = raw;
  const layout = groupOf(root, 'layout');
  const terminal = groupOf(root, 'terminal');
  const editor = groupOf(root, 'editor');
  const appearance = groupOf(root, 'appearance');

  const integerIn =
    (min: number, max: number) =>
    (value: unknown): value is number =>
      typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

  return {
    settings: {
      layout: {
        order: field(layout, 'order', isPanelOrder, defaultLayoutSettings.order, 'layout.order'),
        arrangement: field(
          layout,
          'arrangement',
          isArrangement,
          defaultLayoutSettings.arrangement,
          'layout.arrangement',
        ),
      },
      terminal: {
        shell: field(
          terminal,
          'shell',
          isShellKind,
          defaultSettings.terminal.shell,
          'terminal.shell',
        ),
      },
      editor: {
        tabWidth: field(
          editor,
          'tabWidth',
          integerIn(TAB_WIDTH_RANGE.min, TAB_WIDTH_RANGE.max),
          defaultSettings.editor.tabWidth,
          'editor.tabWidth',
        ),
      },
      appearance: {
        codeFontSize: field(
          appearance,
          'codeFontSize',
          integerIn(CODE_FONT_SIZE_RANGE.min, CODE_FONT_SIZE_RANGE.max),
          defaultSettings.appearance.codeFontSize,
          'appearance.codeFontSize',
        ),
      },
    },
    invalidFields: invalid,
  };
};

/**
 * Panel order must be a *permutation* of the three panels, not merely three panel names.
 *
 * `["viewer", "viewer", "terminal"]` type-checks against `[Panel, Panel, Panel]` and would lose
 * the repository panel entirely — the file browser would simply not exist, with no error
 * anywhere. Hand-edited settings files are exactly where that comes from.
 */
const isPanelOrder = (value: unknown): value is readonly [Panel, Panel, Panel] => {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(isPanel)) {
    return false;
  }
  return new Set(value).size === 3;
};
