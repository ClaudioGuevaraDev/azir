import { describe, expect, it } from 'vitest';
import {
  applyEdit,
  clampCaret,
  graphemeCount,
  graphemes,
  joinForTransport,
  offsetOfColumn,
  type Caret,
} from './document';

/**
 * The grapheme cases are the point of this module, so they come first. Each of these is a
 * single visible character made of several code units, and each is a way to corrupt a file by
 * treating a string index as a character index.
 */
const FAMILY = '👨‍👩‍👧'; // ZWJ sequence: 8 code units, 1 grapheme
const FLAG = '🇦🇷'; // two regional indicators: 4 code units, 1 grapheme
const SMILE = '😀'; // surrogate pair: 2 code units, 1 grapheme
const ACCENT = 'é'; // e + combining acute: 2 code units, 1 grapheme

const caret = (line: number, column: number): Caret => ({ line, column });

describe('grapheme segmentation', () => {
  it.each([
    [FAMILY, 1, 8],
    [FLAG, 1, 4],
    [SMILE, 1, 2],
    [ACCENT, 1, 2],
    ['abc', 3, 3],
    ['', 0, 0],
  ])('treats %s as one visible unit per grapheme', (text, expectedGraphemes, expectedCodeUnits) => {
    expect(graphemeCount(text)).toBe(expectedGraphemes);
    // The whole reason this module exists: the two numbers differ.
    expect(text.length).toBe(expectedCodeUnits);
  });

  it('splits mixed content correctly', () => {
    expect(graphemes(`a${SMILE}b${ACCENT}`)).toEqual(['a', SMILE, 'b', ACCENT]);
  });
});

describe('offsetOfColumn', () => {
  it('converts a grapheme column to a code-unit offset', () => {
    expect(offsetOfColumn(`${SMILE}x`, 0)).toBe(0);
    expect(offsetOfColumn(`${SMILE}x`, 1)).toBe(2);
    expect(offsetOfColumn(`${SMILE}x`, 2)).toBe(3);
  });

  it('clamps rather than throwing, because a caret can outlive its line', () => {
    expect(offsetOfColumn('abc', -5)).toBe(0);
    expect(offsetOfColumn('abc', 99)).toBe(3);
  });
});

describe('insertion', () => {
  it('inserts at the caret and advances it', () => {
    const result = applyEdit(['hello'], caret(0, 5), { kind: 'insert', text: '!' });

    expect(result.lines).toEqual(['hello!']);
    expect(result.caret).toEqual(caret(0, 6));
    expect(result.modified).toBe(true);
  });

  it('inserts in the middle', () => {
    const result = applyEdit(['hello'], caret(0, 2), { kind: 'insert', text: 'XY' });

    expect(result.lines).toEqual(['heXYllo']);
    expect(result.caret).toEqual(caret(0, 4));
  });

  it('advances the caret by graphemes, not code units', () => {
    // Advancing by `text.length` would put the caret two positions past where the user sees
    // it, and every later edit would land in the wrong place.
    const result = applyEdit([''], caret(0, 0), { kind: 'insert', text: FAMILY });

    expect(result.caret).toEqual(caret(0, 1));
    expect(result.lines[0]).toBe(FAMILY);
  });

  it('inserts after a multi-code-unit grapheme without splitting it', () => {
    const result = applyEdit([`${SMILE}`], caret(0, 1), { kind: 'insert', text: 'x' });

    expect(result.lines).toEqual([`${SMILE}x`]);
  });

  it('inserts before one without splitting it', () => {
    const result = applyEdit([`${SMILE}`], caret(0, 0), { kind: 'insert', text: 'x' });

    expect(result.lines).toEqual([`x${SMILE}`]);
  });

  it('splits multi-line inserted text, so a paste behaves like typing', () => {
    const result = applyEdit(['ac'], caret(0, 1), { kind: 'insert', text: 'X\nY\nZ' });

    expect(result.lines).toEqual(['aX', 'Y', 'Zc']);
    expect(result.caret).toEqual(caret(2, 1));
  });

  it('does nothing for empty text', () => {
    const lines = ['hello'];
    const result = applyEdit(lines, caret(0, 2), { kind: 'insert', text: '' });

    expect(result.lines).toBe(lines);
    expect(result.modified).toBe(false);
  });
});

describe('newline', () => {
  it('splits the line at the caret', () => {
    const result = applyEdit(['hello world'], caret(0, 5), { kind: 'newline' });

    expect(result.lines).toEqual(['hello', ' world']);
    expect(result.caret).toEqual(caret(1, 0));
  });

  it('splits at a grapheme boundary', () => {
    const result = applyEdit([`a${FAMILY}b`], caret(0, 2), { kind: 'newline' });

    expect(result.lines).toEqual([`a${FAMILY}`, 'b']);
  });

  it('appends an empty line at the end of a line', () => {
    const result = applyEdit(['a', 'b'], caret(0, 1), { kind: 'newline' });

    expect(result.lines).toEqual(['a', '', 'b']);
  });
});

describe('backspace', () => {
  it('removes the grapheme before the caret', () => {
    const result = applyEdit(['abc'], caret(0, 2), { kind: 'backspace' });

    expect(result.lines).toEqual(['ac']);
    expect(result.caret).toEqual(caret(0, 1));
  });

  it.each([
    [FAMILY, 'family emoji'],
    [FLAG, 'flag'],
    [SMILE, 'surrogate pair'],
    [ACCENT, 'combining accent'],
  ])('removes a whole %s in one step (%s)', (grapheme) => {
    // Deleting one code unit here would leave a lone surrogate or an orphan combining mark in
    // the file — corruption the user cannot see and did not ask for.
    const result = applyEdit([`x${grapheme}y`], caret(0, 2), { kind: 'backspace' });

    expect(result.lines).toEqual(['xy']);
    expect(result.caret).toEqual(caret(0, 1));
  });

  it('joins with the previous line at column zero', () => {
    const result = applyEdit(['ab', 'cd'], caret(1, 0), { kind: 'backspace' });

    expect(result.lines).toEqual(['abcd']);
    expect(result.caret).toEqual(caret(0, 2));
  });

  it('does nothing at the very start of the document', () => {
    const lines = ['abc'];
    const result = applyEdit(lines, caret(0, 0), { kind: 'backspace' });

    expect(result.lines).toBe(lines);
    expect(result.modified).toBe(false);
  });
});

describe('delete', () => {
  it('removes the grapheme after the caret and leaves it put', () => {
    const result = applyEdit(['abc'], caret(0, 1), { kind: 'delete' });

    expect(result.lines).toEqual(['ac']);
    expect(result.caret).toEqual(caret(0, 1));
  });

  it('removes a whole multi-code-unit grapheme', () => {
    const result = applyEdit([`x${FAMILY}y`], caret(0, 1), { kind: 'delete' });

    expect(result.lines).toEqual(['xy']);
  });

  it('joins the next line at the end of a line', () => {
    const result = applyEdit(['ab', 'cd'], caret(0, 2), { kind: 'delete' });

    expect(result.lines).toEqual(['abcd']);
    expect(result.caret).toEqual(caret(0, 2));
  });

  it('does nothing at the very end of the document', () => {
    const lines = ['abc'];
    const result = applyEdit(lines, caret(0, 3), { kind: 'delete' });

    expect(result.lines).toBe(lines);
    expect(result.modified).toBe(false);
  });
});

describe('caret movement', () => {
  const lines = ['hello', `a${FAMILY}b`, ''];

  it('never reports a modification', () => {
    // The caller uses this to decide whether to mark the tab dirty; moving the caret must not.
    for (const to of ['left', 'right', 'up', 'down', 'lineStart', 'lineEnd'] as const) {
      expect(applyEdit(lines, caret(1, 1), { kind: 'move', to }).modified).toBe(false);
    }
  });

  it('steps over a multi-code-unit grapheme in one move', () => {
    const right = applyEdit(lines, caret(1, 1), { kind: 'move', to: 'right' });

    expect(right.caret).toEqual(caret(1, 2));
  });

  it('wraps left to the end of the previous line', () => {
    // Left-arrow and backspace have to agree about where the caret is.
    const result = applyEdit(lines, caret(1, 0), { kind: 'move', to: 'left' });

    expect(result.caret).toEqual(caret(0, 5));
  });

  it('wraps right to the start of the next line', () => {
    const result = applyEdit(lines, caret(0, 5), { kind: 'move', to: 'right' });

    expect(result.caret).toEqual(caret(1, 0));
  });

  it('stops at the document boundaries instead of going out of range', () => {
    expect(applyEdit(lines, caret(0, 0), { kind: 'move', to: 'left' }).caret).toEqual(caret(0, 0));
    expect(applyEdit(lines, caret(2, 0), { kind: 'move', to: 'right' }).caret).toEqual(caret(2, 0));
  });

  it('clamps the column when moving onto a shorter line', () => {
    const result = applyEdit(lines, caret(0, 5), { kind: 'move', to: 'down' });

    expect(result.caret).toEqual(caret(1, 3));
  });

  it('goes to the line start and end', () => {
    expect(applyEdit(lines, caret(1, 2), { kind: 'move', to: 'lineStart' }).caret).toEqual(
      caret(1, 0),
    );
    expect(applyEdit(lines, caret(1, 0), { kind: 'move', to: 'lineEnd' }).caret).toEqual(
      caret(1, 3),
    );
  });

  it('goes to the document start and end', () => {
    expect(applyEdit(lines, caret(1, 2), { kind: 'move', to: 'documentStart' }).caret).toEqual(
      caret(0, 0),
    );
    expect(applyEdit(lines, caret(0, 0), { kind: 'move', to: 'documentEnd' }).caret).toEqual(
      caret(2, 0),
    );
  });

  it('moves to column zero when already on the first line', () => {
    expect(applyEdit(lines, caret(0, 3), { kind: 'move', to: 'up' }).caret).toEqual(caret(0, 0));
  });

  it('moves to the end when already on the last line', () => {
    expect(applyEdit(['abc'], caret(0, 1), { kind: 'move', to: 'down' }).caret).toEqual(
      caret(0, 3),
    );
  });
});

describe('clampCaret', () => {
  it('brings an out-of-range caret inside the document', () => {
    // The watcher can replace a file underneath an open caret; landing at the end of a line is
    // the recovery that keeps the panel usable.
    expect(clampCaret(['ab', 'cd'], caret(9, 9))).toEqual(caret(1, 2));
    expect(clampCaret(['ab'], caret(-1, -1))).toEqual(caret(0, 0));
  });

  it('handles an empty document', () => {
    expect(clampCaret([], caret(3, 3))).toEqual(caret(0, 0));
  });
});

describe('joinForTransport', () => {
  it('always uses LF, leaving the real line ending to the main process', () => {
    // One implementation of the rule, in the process that owns the bytes. Two would drift.
    expect(joinForTransport(['a', 'b', ''])).toBe('a\nb\n');
  });

  it('round-trips an edit', () => {
    const lines = ['first', 'second', 'third', ''];

    const edited = applyEdit(lines, caret(1, 6), { kind: 'insert', text: '!' });

    expect(joinForTransport(edited.lines)).toBe('first\nsecond!\nthird\n');
  });
});
