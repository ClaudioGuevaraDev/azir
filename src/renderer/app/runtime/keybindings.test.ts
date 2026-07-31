import { describe, expect, it } from 'vitest';
import { BINDINGS, documentedBindings, matchBinding, type KeyChord } from './keybindings';

const chord = (code: string, modifiers: Partial<KeyChord> = {}): KeyChord => ({
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...modifiers,
});

describe('what the application claims', () => {
  it.each([
    ['Digit1', { ctrlKey: true }, 'focusSlot'],
    ['Digit2', { ctrlKey: true }, 'focusSlot'],
    ['Digit3', { ctrlKey: true }, 'focusSlot'],
    ['KeyO', { ctrlKey: true, shiftKey: true }, 'openWorkspace'],
    ['KeyT', { ctrlKey: true, shiftKey: true }, 'newTerminal'],
    ['KeyW', { ctrlKey: true, shiftKey: true }, 'closeTerminal'],
    ['F1', {}, 'toggleHelp'],
    ['Comma', { ctrlKey: true }, 'openSettings'],
  ] as const)('claims %s', (code, modifiers, kind) => {
    expect(matchBinding(chord(code, modifiers), false)?.kind).toBe(kind);
  });

  it('maps the digits to slots in order, not to named panels', () => {
    // Which panel a slot holds is a setting; this module must not encode it.
    const slots = ['Digit1', 'Digit2', 'Digit3'].map((code) => {
      const command = matchBinding(chord(code, { ctrlKey: true }), false);
      return command?.kind === 'focusSlot' ? command.slot : null;
    });

    expect(slots).toEqual([0, 1, 2]);
  });
});

describe('what the terminal keeps', () => {
  /*
   * This is the important half. readline binds nearly every bare Ctrl+letter, and an
   * application accelerator on one of them breaks the shell in a way that looks like the
   * shell's fault. The list below is those bindings; none of them may match.
   */
  const READLINE_KEYS = [
    ['KeyC', 'interrupt'],
    ['KeyD', 'end of file'],
    ['KeyR', 'reverse history search'],
    ['KeyW', 'delete word backwards'],
    ['KeyA', 'beginning of line'],
    ['KeyE', 'end of line'],
    ['KeyK', 'kill to end of line'],
    ['KeyU', 'kill to start of line'],
    ['KeyL', 'clear screen'],
    ['KeyP', 'previous history'],
    ['KeyN', 'next history'],
    ['KeyB', 'backward char'],
    ['KeyF', 'forward char'],
    ['KeyT', 'transpose'],
    ['KeyY', 'yank'],
    ['KeyZ', 'suspend'],
    ['KeyG', 'abort'],
    ['KeyO', 'operate and get next'],
  ] as const;

  it.each(READLINE_KEYS)('leaves Ctrl+%s alone (%s)', (code) => {
    expect(matchBinding(chord(code, { ctrlKey: true }), false)).toBeNull();
  });

  it.each(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'])(
    'leaves %s alone',
    (code) => {
      expect(matchBinding(chord(code), false)).toBeNull();
    },
  );

  it('leaves Tab alone, which is completion', () => {
    expect(matchBinding(chord('Tab'), false)).toBeNull();
    expect(matchBinding(chord('Tab', { shiftKey: true }), false)).toBeNull();
  });

  it('leaves plain typing alone', () => {
    expect(matchBinding(chord('KeyA'), false)).toBeNull();
    expect(matchBinding(chord('Digit1'), false)).toBeNull();
    expect(matchBinding(chord('Space'), false)).toBeNull();
    expect(matchBinding(chord('Enter'), false)).toBeNull();
  });

  it('leaves the function keys a shell uses alone', () => {
    for (const code of ['F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12']) {
      expect(matchBinding(chord(code), false)).toBeNull();
    }
  });

  it('leaves Escape alone when no overlay is open, since it starts every escape sequence', () => {
    expect(matchBinding(chord('Escape'), false)).toBeNull();
  });

  it('claims nothing with the Meta key, which belongs to the OS', () => {
    expect(matchBinding(chord('Digit1', { ctrlKey: true, metaKey: true }), false)).toBeNull();
    expect(
      matchBinding(chord('KeyT', { ctrlKey: true, shiftKey: true, metaKey: true }), false),
    ).toBeNull();
  });
});

describe('modifier precision', () => {
  it('does not match when an extra modifier is held', () => {
    // Ctrl+Shift+1 is not Ctrl+1; matching loosely would swallow keystrokes the terminal
    // should see.
    expect(matchBinding(chord('Digit1', { ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(matchBinding(chord('F1', { ctrlKey: true }), false)).toBeNull();
    expect(matchBinding(chord('Comma', { ctrlKey: true, altKey: true }), false)).toBeNull();
  });

  it('does not match when a required modifier is missing', () => {
    expect(matchBinding(chord('KeyT', { ctrlKey: true }), false)).toBeNull();
    expect(matchBinding(chord('KeyT', { shiftKey: true }), false)).toBeNull();
    expect(matchBinding(chord('Digit1'), false)).toBeNull();
  });
});

describe('overlay ownership', () => {
  it('gives Escape to the overlay while one is open', () => {
    expect(matchBinding(chord('Escape'), true)?.kind).toBe('dismissOverlay');
  });

  it('suppresses every other binding while an overlay owns the keyboard', () => {
    // "Only one modal overlay should own keyboard input at a time" — including against the
    // application's own shortcuts, or Ctrl+Shift+T would spawn a terminal behind a modal.
    expect(matchBinding(chord('Digit1', { ctrlKey: true }), true)).toBeNull();
    expect(matchBinding(chord('KeyT', { ctrlKey: true, shiftKey: true }), true)).toBeNull();
    expect(matchBinding(chord('F1'), true)).toBeNull();
  });
});

describe('the documented set', () => {
  it('is small', () => {
    // The spec's word is "small". Nine is a set someone can learn; thirty is a manual.
    expect(BINDINGS.length).toBeLessThanOrEqual(12);
  });

  it('is fully documented, because the help overlay is the documentation', () => {
    const documented = documentedBindings();

    expect(documented).toHaveLength(BINDINGS.length);
    for (const binding of documented) {
      expect(binding.label).not.toBe('');
      expect(binding.description).not.toBe('');
    }
  });

  it('has no duplicate chords', () => {
    const labels = BINDINGS.map((binding) => binding.label);

    expect(new Set(labels).size).toBe(labels.length);
  });
});
