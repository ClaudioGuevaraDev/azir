/**
 * Pure document operations for the viewer's limited edit mode.
 *
 * docs/architecture.md is explicit about the trap here: "JavaScript string indexes are
 * UTF-16 code units, so operations must not assume that one index always equals one visible
 * character. Use helpers based on code points or grapheme segmentation where necessary."
 *
 * Code points are not enough either. `é` written as `e` plus a combining acute is two code
 * points and one visible character; a family emoji is five code points joined by zero-width
 * joiners and still one visible character; a flag is two regional indicators. Backspace has
 * to remove the whole thing, and the caret has to move over it in one step — otherwise the
 * user deletes half a character and the file ends up holding a lone surrogate or an orphan
 * combining mark.
 *
 * So the caret's column is a **grapheme** index, and `Intl.Segmenter` does the segmentation.
 * Unlike `Intl.Collator` — deliberately avoided for sorting elsewhere, because its ordering
 * varies by locale — grapheme segmentation follows UAX #29 and is stable across locales, so
 * using it does not make behaviour machine-dependent.
 *
 * The edit surface is intentionally the small one the spec allows: insertion, newline,
 * backspace, delete, caret movement. No undo history, no multi-cursor, no selection.
 */

export interface Caret {
  /** Zero-based line index. */
  readonly line: number;
  /** Zero-based **grapheme** index within the line, not a code-unit offset. */
  readonly column: number;
}

export const originCaret: Caret = { line: 0, column: 0 };

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Splits a line into user-perceived characters. */
export const graphemes = (text: string): string[] =>
  text === '' ? [] : [...segmenter.segment(text)].map((segment) => segment.segment);

export const graphemeCount = (text: string): number => graphemes(text).length;

/**
 * Converts a grapheme column into a code-unit offset, which is what `slice` needs.
 *
 * Clamped rather than throwing: a caret can outlive the line it points into — the watcher
 * can replace the file underneath it — and the recovery that keeps the app usable is to land
 * at the end of the line.
 */
export const offsetOfColumn = (text: string, column: number): number => {
  if (column <= 0) {
    return 0;
  }
  let offset = 0;
  let seen = 0;
  for (const grapheme of graphemes(text)) {
    if (seen >= column) {
      break;
    }
    offset += grapheme.length;
    seen += 1;
  }
  return offset;
};

export type CaretMove =
  'left' | 'right' | 'up' | 'down' | 'lineStart' | 'lineEnd' | 'documentStart' | 'documentEnd';

export type EditOperation =
  | { readonly kind: 'insert'; readonly text: string }
  | { readonly kind: 'newline' }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'delete' }
  | { readonly kind: 'move'; readonly to: CaretMove };

export interface EditResult {
  readonly lines: readonly string[];
  readonly caret: Caret;
  /** False for a pure caret move, so the caller knows not to mark the tab dirty. */
  readonly modified: boolean;
}

/** Brings a caret inside the document, whatever happened to the lines underneath it. */
export const clampCaret = (lines: readonly string[], caret: Caret): Caret => {
  if (lines.length === 0) {
    return originCaret;
  }
  const line = Math.min(Math.max(0, caret.line), lines.length - 1);
  const column = Math.min(Math.max(0, caret.column), graphemeCount(lines[line] ?? ''));
  return { line, column };
};

const moveCaret = (lines: readonly string[], caret: Caret, to: CaretMove): Caret => {
  const current = clampCaret(lines, caret);
  const lineText = lines[current.line] ?? '';

  switch (to) {
    case 'left': {
      if (current.column > 0) {
        return { ...current, column: current.column - 1 };
      }
      // Wrapping to the end of the previous line is what makes left-arrow and backspace
      // agree about where the caret is.
      if (current.line === 0) {
        return current;
      }
      const previous = lines[current.line - 1] ?? '';
      return { line: current.line - 1, column: graphemeCount(previous) };
    }

    case 'right': {
      if (current.column < graphemeCount(lineText)) {
        return { ...current, column: current.column + 1 };
      }
      if (current.line >= lines.length - 1) {
        return current;
      }
      return { line: current.line + 1, column: 0 };
    }

    case 'up':
      return current.line === 0
        ? { ...current, column: 0 }
        : clampCaret(lines, { line: current.line - 1, column: current.column });

    case 'down':
      return current.line >= lines.length - 1
        ? { ...current, column: graphemeCount(lineText) }
        : clampCaret(lines, { line: current.line + 1, column: current.column });

    case 'lineStart':
      return { ...current, column: 0 };

    case 'lineEnd':
      return { ...current, column: graphemeCount(lineText) };

    case 'documentStart':
      return originCaret;

    case 'documentEnd': {
      const last = lines.length - 1;
      return { line: last, column: graphemeCount(lines[last] ?? '') };
    }
  }
};

export const applyEdit = (
  lines: readonly string[],
  caret: Caret,
  operation: EditOperation,
): EditResult => {
  const at = clampCaret(lines, caret);
  const lineText = lines[at.line] ?? '';
  const offset = offsetOfColumn(lineText, at.column);

  switch (operation.kind) {
    case 'move':
      return { lines, caret: moveCaret(lines, at, operation.to), modified: false };

    case 'insert': {
      if (operation.text === '') {
        return { lines, caret: at, modified: false };
      }
      // Newlines inside inserted text are handled by splitting, so a paste of several lines
      // behaves like typing them.
      const parts = operation.text.split('\n');
      const head = lineText.slice(0, offset);
      const tail = lineText.slice(offset);

      if (parts.length === 1) {
        const inserted = parts[0] ?? '';
        const next = [...lines];
        next[at.line] = head + inserted + tail;
        return {
          lines: next,
          caret: { line: at.line, column: at.column + graphemeCount(inserted) },
          modified: true,
        };
      }

      const first = parts[0] ?? '';
      const last = parts[parts.length - 1] ?? '';
      const middle = parts.slice(1, -1);
      const next = [
        ...lines.slice(0, at.line),
        head + first,
        ...middle,
        last + tail,
        ...lines.slice(at.line + 1),
      ];
      return {
        lines: next,
        caret: { line: at.line + parts.length - 1, column: graphemeCount(last) },
        modified: true,
      };
    }

    case 'newline': {
      const next = [
        ...lines.slice(0, at.line),
        lineText.slice(0, offset),
        lineText.slice(offset),
        ...lines.slice(at.line + 1),
      ];
      return { lines: next, caret: { line: at.line + 1, column: 0 }, modified: true };
    }

    case 'backspace': {
      if (at.column > 0) {
        // One *grapheme* back, which for a joined emoji is several code units.
        const start = offsetOfColumn(lineText, at.column - 1);
        const next = [...lines];
        next[at.line] = lineText.slice(0, start) + lineText.slice(offset);
        return { lines: next, caret: { line: at.line, column: at.column - 1 }, modified: true };
      }

      if (at.line === 0) {
        return { lines, caret: at, modified: false };
      }

      // Joining with the previous line.
      const previous = lines[at.line - 1] ?? '';
      const next = [
        ...lines.slice(0, at.line - 1),
        previous + lineText,
        ...lines.slice(at.line + 1),
      ];
      return {
        lines: next,
        caret: { line: at.line - 1, column: graphemeCount(previous) },
        modified: true,
      };
    }

    case 'delete': {
      if (at.column < graphemeCount(lineText)) {
        const end = offsetOfColumn(lineText, at.column + 1);
        const next = [...lines];
        next[at.line] = lineText.slice(0, offset) + lineText.slice(end);
        return { lines: next, caret: at, modified: true };
      }

      if (at.line >= lines.length - 1) {
        return { lines, caret: at, modified: false };
      }

      const following = lines[at.line + 1] ?? '';
      const next = [...lines.slice(0, at.line), lineText + following, ...lines.slice(at.line + 2)];
      return { lines: next, caret: at, modified: true };
    }
  }
};

/**
 * Joins the document for transport, always with LF.
 *
 * The file's real line ending and byte-order mark travel alongside as data and are applied in
 * the main process, which owns the bytes. Doing it in both places would be two
 * implementations of one rule, and they would drift.
 */
export const joinForTransport = (lines: readonly string[]): string => lines.join('\n');
