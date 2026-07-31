/**
 * The reserved shortcut set.
 *
 * docs/architecture.md is unusually specific here, and for good reason: "The terminal
 * should retain most keys — Ctrl+C, Ctrl+D, Ctrl+R, Tab, arrows, function keys used by the
 * shell. The application should reserve only a small, documented set."
 *
 * That constraint rules out almost every bare `Ctrl+letter`, because readline binds most of
 * them: C interrupt, D EOF, R history search, W delete-word, A/E line start and end, K/U
 * kill, L clear, P/N history, B/F cursor, T transpose, Y yank, Z suspend. An application
 * accelerator on any of those would break the shell in a way that looks like the shell's
 * fault.
 *
 * What is left, and what this module uses:
 *
 *  - `Ctrl+digit` — shells do not bind these.
 *  - `Ctrl+Shift+letter` — terminals cannot even encode most of them, so no shell expects
 *    them.
 *  - Function keys other than the ones a shell uses.
 *  - `Escape`, but only while an overlay is open; otherwise it belongs to the terminal,
 *    where it is the start of every escape sequence.
 *
 * Matching is on `event.code` rather than `event.key` so a non-US keyboard layout does not
 * silently lose a binding — `code` is the physical key.
 */

export type Command =
  /**
   * A *slot*, not a panel. Which panel sits in slot 1 is a setting, and this module is not
   * allowed to know it — the same constraint the layout engine works under.
   */
  | { readonly kind: 'focusSlot'; readonly slot: number }
  | { readonly kind: 'saveFile' }
  | { readonly kind: 'openWorkspace' }
  | { readonly kind: 'newTerminal' }
  | { readonly kind: 'closeTerminal' }
  | { readonly kind: 'toggleHelp' }
  | { readonly kind: 'openSettings' }
  | { readonly kind: 'dismissOverlay' };

export interface Binding {
  /** For the help overlay, which is the "documented" half of "small and documented". */
  readonly label: string;
  readonly description: string;
  readonly command: Command;
}

interface Chord {
  readonly code: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
  /** Only matched while an overlay owns the keyboard. */
  readonly overlayOnly?: boolean;
  /**
   * Only matched while this panel has focus.
   *
   * The escape hatch for a chord the application needs but the terminal also uses. Ctrl+S is
   * the case: it is the universally expected save shortcut, and it is also XOFF — with flow
   * control enabled it stops the terminal's output. Reserving it globally would break that;
   * scoping it to the viewer means the terminal keeps it whenever the terminal is where the
   * user is typing.
   */
  readonly panel?: 'repository' | 'viewer' | 'terminal';
}

interface Entry extends Binding {
  readonly chord: Chord;
}

export const BINDINGS: readonly Entry[] = [
  {
    chord: { code: 'Digit1', ctrl: true },
    label: 'Ctrl+1',
    description: 'Focus the first panel',
    command: { kind: 'focusSlot', slot: 0 },
  },
  {
    chord: { code: 'Digit2', ctrl: true },
    label: 'Ctrl+2',
    description: 'Focus the second panel',
    command: { kind: 'focusSlot', slot: 1 },
  },
  {
    chord: { code: 'Digit3', ctrl: true },
    label: 'Ctrl+3',
    description: 'Focus the third panel',
    command: { kind: 'focusSlot', slot: 2 },
  },
  {
    chord: { code: 'KeyS', ctrl: true, panel: 'viewer' },
    label: 'Ctrl+S',
    description: 'Save the file — only while the viewer has focus, since Ctrl+S is XOFF',
    command: { kind: 'saveFile' },
  },
  {
    chord: { code: 'KeyO', ctrl: true, shift: true },
    label: 'Ctrl+Shift+O',
    description: 'Open a workspace folder',
    command: { kind: 'openWorkspace' },
  },
  {
    chord: { code: 'KeyT', ctrl: true, shift: true },
    label: 'Ctrl+Shift+T',
    description: 'New terminal pane',
    command: { kind: 'newTerminal' },
  },
  {
    chord: { code: 'KeyW', ctrl: true, shift: true },
    label: 'Ctrl+Shift+W',
    description: 'Close the active terminal pane',
    command: { kind: 'closeTerminal' },
  },
  {
    chord: { code: 'F1' },
    label: 'F1',
    description: 'Show or hide this help',
    command: { kind: 'toggleHelp' },
  },
  {
    chord: { code: 'Comma', ctrl: true },
    label: 'Ctrl+,',
    description: 'Settings',
    command: { kind: 'openSettings' },
  },
  {
    chord: { code: 'Escape', overlayOnly: true },
    label: 'Escape',
    description: 'Close the overlay',
    command: { kind: 'dismissOverlay' },
  },
];

/** The shape `matchBinding` needs from a keyboard event, so tests need no DOM. */
export interface KeyChord {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

/**
 * Resolves a keystroke to a command, or to nothing — in which case the event must be left
 * alone so it reaches xterm.
 *
 * `overlayOpen` matters in both directions: `Escape` is only ours while an overlay is up,
 * and every other binding is suppressed *while* one is up, because the overlay owns the
 * keyboard.
 */
export const matchBinding = (
  event: KeyChord,
  overlayOpen: boolean,
  focusedPanel?: 'repository' | 'viewer' | 'terminal',
): Command | null => {
  // Meta is the OS's on every platform Azir targets; claiming it would collide with window
  // management and, on macOS, with the standard menu accelerators.
  if (event.metaKey) {
    return null;
  }

  for (const entry of BINDINGS) {
    const { chord } = entry;

    if (chord.overlayOnly === true && !overlayOpen) {
      continue;
    }
    if (chord.overlayOnly !== true && overlayOpen) {
      continue;
    }
    if (chord.panel !== undefined && chord.panel !== focusedPanel) {
      continue;
    }

    if (
      chord.code === event.code &&
      (chord.ctrl ?? false) === event.ctrlKey &&
      (chord.shift ?? false) === event.shiftKey &&
      (chord.alt ?? false) === event.altKey
    ) {
      return entry.command;
    }
  }

  return null;
};

/** For the help overlay. */
export const documentedBindings = (): readonly Binding[] =>
  BINDINGS.map(({ label, description, command }) => ({ label, description, command }));
