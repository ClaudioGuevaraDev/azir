import { useCallback, useEffect, useRef } from 'react';
import { graphemeCount, type Caret, type EditOperation } from '../app/document';
import type { Document } from '../app/viewer';
import { VirtualList } from '../ui/VirtualList';

export interface CodeViewProps {
  readonly document: Document;
  readonly caret: Caret;
  /**
   * Whether the viewer is the focused panel.
   *
   * Drives when the surface takes the keyboard. Focusing on *mount* instead — which is what this
   * did first — means clicking a file in the tree steals focus from the tree, because opening a
   * file mounts this component. The tree then cannot be navigated from the keyboard at all.
   */
  readonly focused: boolean;
  readonly initialTop: number;
  readonly onScroll: (top: number) => void;
  readonly onEdit: (operation: EditOperation) => void;
}

/** Must match --azir-code-line-height in tokens.css. */
const LINE_HEIGHT = 18;

/**
 * Keeps an empty line at full row height. An empty span collapses, and the gutter numbers
 * would drift out of alignment with the text beside them. Written as an escape because an
 * invisible character in source is a trap.
 */
const ZERO_WIDTH_SPACE = '​';

interface Line {
  readonly number: number;
  readonly text: string;
  readonly caretColumn: number | null;
}

/**
 * Read-and-edit code, virtualised.
 *
 * No syntax highlighting: docs/architecture.md is explicit that Azir is not an IDE, and
 * highlighting means either a grammar engine per language or a heuristic that misleads. What a
 * supervision tool needs is the file exactly as it is on disk; the diff view carries the colour
 * that means something.
 *
 * Editing is the deliberately small surface the spec allows — insertion, newline, backspace,
 * delete, caret movement — and every keystroke is translated into an `EditOperation` that the
 * reducer applies to an immutable document. Nothing is mutated here, and there is no
 * contenteditable: the DOM is a projection, never the source of truth. That is what keeps the
 * grapheme handling in one pure, tested place instead of scattered across browser edit events.
 */
export const CodeView = ({
  document: doc,
  caret,
  focused,
  initialTop,
  onScroll,
  onEdit,
}: CodeViewProps): React.JSX.Element => {
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Only once the viewer is the focused panel, so Ctrl+2 hands the keyboard to the editor while
    // clicking a file in the tree leaves focus where the user is working.
    if (focused) {
      surfaceRef.current?.focus();
    }
  }, [focused]);

  const lines: readonly Line[] = doc.lines.map((text, index) => ({
    number: index + 1,
    text,
    caretColumn: index === caret.line ? caret.column : null,
  }));

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      /*
       * Ctrl+Home and Ctrl+End are caret motion, not application shortcuts, so they are handled
       * here rather than in the reserved set — the terminal has its own idea of both and must
       * keep it. They are taken before the blanket Ctrl bail-out below, which would otherwise
       * swallow them and leave `documentStart`/`documentEnd` with no caller at all.
       */
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
        const jump =
          event.key === 'Home' ? 'documentStart' : event.key === 'End' ? 'documentEnd' : null;
        if (jump !== null) {
          event.preventDefault();
          onEdit({ kind: 'move', to: jump });
          return;
        }
      }

      // Every other reserved chord is handled by the window-level router and never reaches here;
      // anything else with Ctrl or Meta held is left alone so those keep working.
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      const operation = ((): EditOperation | null => {
        switch (event.key) {
          case 'Enter':
            return { kind: 'newline' };
          case 'Backspace':
            return { kind: 'backspace' };
          case 'Delete':
            return { kind: 'delete' };
          case 'ArrowLeft':
            return { kind: 'move', to: 'left' };
          case 'ArrowRight':
            return { kind: 'move', to: 'right' };
          case 'ArrowUp':
            return { kind: 'move', to: 'up' };
          case 'ArrowDown':
            return { kind: 'move', to: 'down' };
          case 'Home':
            return { kind: 'move', to: 'lineStart' };
          case 'End':
            return { kind: 'move', to: 'lineEnd' };
          case 'Tab':
            return { kind: 'insert', text: '  ' };
          default:
            // A printable key arrives as a single grapheme in `event.key`; every named key is
            // longer than one code point, which is what distinguishes them.
            return [...event.key].length === 1 ? { kind: 'insert', text: event.key } : null;
        }
      })();

      if (!operation) {
        return;
      }
      event.preventDefault();
      onEdit(operation);
    },
    [onEdit],
  );

  const renderRow = useCallback(
    (line: Line) => (
      <div className="code__line" data-current={line.caretColumn !== null}>
        <span className="code__gutter">{line.number}</span>
        <span className="code__text azir-selectable">
          {line.caretColumn === null ? (
            // A zero-width space keeps an empty line the full row height; an empty span would
            // collapse and the gutter numbers would drift out of alignment.
            line.text === '' ? (
              ZERO_WIDTH_SPACE
            ) : (
              line.text
            )
          ) : (
            <CaretLine text={line.text} column={line.caretColumn} />
          )}
        </span>
      </div>
    ),
    [],
  );

  return (
    <div
      className="code__surface"
      ref={surfaceRef}
      tabIndex={0}
      role="textbox"
      aria-multiline="true"
      aria-label="File contents"
      data-testid="code-surface"
      onKeyDown={onKeyDown}
    >
      <VirtualList
        items={lines}
        rowHeight={LINE_HEIGHT}
        className="code"
        testId="code-view"
        initialTop={initialTop}
        onScrollTop={onScroll}
        keyOf={(line) => String(line.number)}
        renderRow={renderRow}
      />
    </div>
  );
};

/**
 * Splits the current line at the caret so a block can be drawn between the halves.
 *
 * The split is by grapheme, using the same helper the edit operations use — slicing by code
 * unit would put the caret inside an emoji and show a lone surrogate.
 */
const CaretLine = ({ text, column }: { text: string; column: number }): React.JSX.Element => {
  const parts = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(
    (segment) => segment.segment,
  );
  const safeColumn = Math.min(column, graphemeCount(text));
  const before = parts.slice(0, safeColumn).join('');
  const after = parts.slice(safeColumn).join('');

  return (
    <>
      {before}
      <span className="code__caret" data-testid="code-caret" />
      {after === '' ? ZERO_WIDTH_SPACE : after}
    </>
  );
};
