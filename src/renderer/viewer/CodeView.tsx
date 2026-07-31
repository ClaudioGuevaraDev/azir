import { useCallback } from 'react';
import type { Document } from '../app/viewer';
import { VirtualList } from '../ui/VirtualList';

export interface CodeViewProps {
  readonly document: Document;
  readonly initialTop: number;
  readonly onScroll: (top: number) => void;
}

/** Must match --azir-code-line-height in tokens.css. */
const LINE_HEIGHT = 18;

interface Line {
  readonly number: number;
  readonly text: string;
}

/**
 * Read-only code, virtualised.
 *
 * No syntax highlighting: docs/architecture.md is explicit that Azir is not an IDE, and
 * highlighting means either a grammar engine per language or a heuristic that is wrong
 * often enough to mislead. What a supervision tool needs is to show the file exactly as
 * it is on disk. The diff view carries the colour that matters — what changed.
 */
export const CodeView = ({ document, initialTop, onScroll }: CodeViewProps): React.JSX.Element => {
  const lines: readonly Line[] = document.lines.map((text, index) => ({
    number: index + 1,
    text,
  }));

  const renderRow = useCallback(
    (line: Line) => (
      <div className="code__line">
        <span className="code__gutter">{line.number}</span>
        {/*
          A zero-width space keeps an empty line the full row height; an empty span
          would collapse and the gutter numbers would drift out of alignment.
        */}
        <span className="code__text azir-selectable">{line.text === '' ? '​' : line.text}</span>
      </div>
    ),
    [],
  );

  return (
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
  );
};
